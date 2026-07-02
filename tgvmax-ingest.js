/**
 * tgvmax-ingest.js
 *
 * Télécharge l'intégralité des données TGVmax via l'endpoint d'export JSON
 * de l'API open data SNCF, puis génère les fichiers engine_data/.
 *
 * CHANGEMENT v2 : tous les trajets sont désormais stockés (dispo ET non dispo)
 * avec un champ `dispo: true | false`. Le calendar_index.json ne contient
 * que les trips disponibles (pour la compatibilité), mais allCalendarIndex
 * est reconstruit au démarrage du serveur depuis trips.json.
 *
 * Usage :
 *   node tgvmax-ingest.js
 *   node tgvmax-ingest.js ./operators.json ./engine_data
 *
 * Fichiers générés dans engine_data/ :
 *   trips.json           — TOUS les trajets (dispo + non dispo), indexés par trip_id
 *   stops.json           — gares avec coordonnées
 *   routes_by_stop.json  — stop_id → [trip_ids]  (tous les trips)
 *   calendar_index.json  — date ISO → [trip_ids] (DISPONIBLES uniquement, compat)
 *   meta.json            — métadonnées de l'ingestion
 */

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const matcher = require('./stations-matcher');

const OPS_FILE  = process.argv[2] || './operators.json';
const OUT_DIR   = process.argv[3] || './engine_data';
const CSV_FILE  = process.argv[4] || path.join(__dirname, 'stations.csv');

// URL d'export JSON complet (limit=-1 = pas de limite, retourne tout le dataset)
const EXPORT_URL = 'https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/tgvmax/exports/json?limit=-1&timezone=Europe%2FParis';

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── Téléchargement du fichier JSON export ────────────────────────────────────

function downloadJson(exportUrl) {
  return new Promise((resolve, reject) => {
    console.log('  URL : ' + exportUrl);
    console.log('  Téléchargement en cours...\n');

    let downloaded = 0;

    function doRequest(targetUrl, redirectCount = 0) {
      if (redirectCount > 5) return reject(new Error('Trop de redirections'));

      const mod = targetUrl.startsWith('https') ? https : http;

      mod.get(targetUrl, { headers: { 'Accept': 'application/json' } }, (res) => {

        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          console.log('  Redirection → ' + res.headers.location);
          return doRequest(res.headers.location, redirectCount + 1);
        }

        if (res.statusCode !== 200) {
          return reject(new Error('HTTP ' + res.statusCode + ' pour ' + targetUrl));
        }

        const total  = parseInt(res.headers['content-length'] || '0');
        const chunks = [];

        res.on('data', chunk => {
          chunks.push(chunk);
          downloaded += chunk.length;
          const mb  = (downloaded / 1024 / 1024).toFixed(1);
          const pct = total ? Math.round(downloaded / total * 100) + '%' : mb + ' MB';
          process.stdout.write('\r  Téléchargé : ' + pct + '          ');
        });

        res.on('end', () => {
          process.stdout.write('\n');
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            const data = JSON.parse(raw);
            resolve(Array.isArray(data) ? data : (data.results || data.records || []));
          } catch (e) {
            reject(new Error('Erreur parsing JSON : ' + e.message));
          }
        });

        res.on('error', reject);
      }).on('error', reject);
    }

    doRequest(exportUrl);
  });
}

// ─── Normalisation d'un enregistrement TGVmax ────────────────────────────────

function normalizeRecord(r) {
  const date    = r.date          || r.jour         || '';
  const trainNo = r.train_no      || r.numero_train || r.train       || '';
  const origin  = r.origine       || r.gare_origine || r.orig        || '';
  const dest    = r.destination   || r.gare_dest    || r.dest        || '';
  const dep     = r.heure_depart  || r.depart       || '';
  const arr     = r.heure_arrivee || r.arrivee      || '';
  const dispo   = (r.od_happy_card || r.disponible  || '').toUpperCase();

  const lat_orig = parseFloat(r.lat_orig || r.latitude_origine     || 0) || 0;
  const lon_orig = parseFloat(r.lon_orig || r.longitude_origine    || 0) || 0;
  const lat_dest = parseFloat(r.lat_dest || r.latitude_destination || 0) || 0;
  const lon_dest = parseFloat(r.lon_dest || r.longitude_destination|| 0) || 0;

  return { date, trainNo, origin, dest, dep, arr, dispo, lat_orig, lon_orig, lat_dest, lon_dest };
}

function timeToSeconds(t) {
  if (!t || !t.includes(':')) return null;
  const parts = t.trim().split(':').map(Number);
  return parts[0] * 3600 + parts[1] * 60 + (parts[2] || 0);
}

function slugify(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

// ─── Construction des structures engine_data ──────────────────────────────────
//
// CHANGEMENT v2 : on ne filtre PLUS les non-dispo.
// Tous les trips sont stockés avec dispo: true | false.
// calendar_index reste limité aux dispo pour la compat avec servermax.js.

// ─── Résolution d'une gare TGVmax → ID SNCF canonique ────────────────────────

function resolveStop(rawName, latFallback, lonFallback) {
  // 1. Essayer le matcher CSV
  const found = matcher.match(rawName);
  if (found) return { id: found.id, name: found.name, lat: found.lat, lon: found.lon };

  // 2. Fallback : garder le slug TGVMAX avec le nom brut normalisé
  const id = 'TGVMAX:' + slugify(rawName);
  return { id, name: rawName, lat: latFallback || 0, lon: lonFallback || 0 };
}

function buildEngineData(records) {
  const trips        = {};
  const stops        = {};
  const routesByStop = {};
  const calendarIdx  = {};  // dispo uniquement (compat)

  let skipped       = 0;
  let matchedByCSV  = 0;
  let matchedBySlug = 0;

  // On peut avoir des doublons (même train, même OD, même date) avec dispo OUI et NON.
  // On traite d'abord tous les enregistrements et on résout le conflit à la fin :
  // si au moins un enregistrement dit OUI → dispo = true.
  const tripDispoVotes = {}; // tripId → boolean (true si au moins un OUI)

  for (const raw of records) {
    const r = normalizeRecord(raw);

    if (!r.date || !r.origin || !r.dest || !r.dep || !r.arr) { skipped++; continue; }

    const isDispoOui = r.dispo === 'OUI';

    // Résolution des gares via le matcher CSV
    const orig = resolveStop(r.origin, r.lat_orig, r.lon_orig);
    const dest = resolveStop(r.dest,   r.lat_dest, r.lon_dest);

    const originId = orig.id;
    const destId   = dest.id;

    if (orig.id.startsWith('FR')) matchedByCSV++;  else matchedBySlug++;

    const tripId   = `TGVMAX:${r.date}:${r.trainNo || slugify(r.origin)}:${r.dep.replace(':', '')}:${slugify(r.dest)}`;

    // Gares — on utilise le nom et les coords du CSV si disponible
    if (!stops[originId]) {
      stops[originId] = { name: orig.name, lat: orig.lat, lon: orig.lon };
    } else if (!stops[originId].lat && orig.lat) {
      stops[originId].lat = orig.lat; stops[originId].lon = orig.lon;
    }
    if (!stops[destId]) {
      stops[destId] = { name: dest.name, lat: dest.lat, lon: dest.lon };
    } else if (!stops[destId].lat && dest.lat) {
      stops[destId].lat = dest.lat; stops[destId].lon = dest.lon;
    }

    const depSec = timeToSeconds(r.dep);
    const arrSec = timeToSeconds(r.arr);

    // Trip — on crée l'entrée pour dispo ET non dispo
    if (!trips[tripId]) {
      trips[tripId] = {
        trip_id:    tripId,
        train_no:   r.trainNo,
        date:       r.date,
        origin_id:  originId,
        dest_id:    destId,
        dep_time:   depSec,
        arr_time:   arrSec,
        dep_str:    r.dep,
        arr_str:    r.arr,
        dispo:      isDispoOui,  // sera réajusté si doublon ci-dessous
        operator:   'TGVMAX',
        train_type: 'TGVMAX',
      };
      tripDispoVotes[tripId] = isDispoOui;
    } else {
      // En cas de doublon : si l'un dit OUI, le trip est dispo
      if (isDispoOui) {
        trips[tripId].dispo = true;
        tripDispoVotes[tripId] = true;
      }
    }

    // Index routesByStop (tous les trips, dispo ou non)
    if (!routesByStop[originId]) routesByStop[originId] = new Set();
    if (!routesByStop[destId])   routesByStop[destId]   = new Set();
    routesByStop[originId].add(tripId);
    routesByStop[destId].add(tripId);

    // calendar_index : uniquement les dispo (compat servermax)
    if (isDispoOui) {
      if (!calendarIdx[r.date]) calendarIdx[r.date] = [];
      if (!calendarIdx[r.date].includes(tripId)) calendarIdx[r.date].push(tripId);
    }
  }

  const routesByStopSerial = {};
  for (const [sid, set] of Object.entries(routesByStop)) routesByStopSerial[sid] = [...set];

  const totalTrips   = Object.keys(trips).length;
  const dispoTrips   = Object.values(trips).filter(t => t.dispo).length;
  const nonDispoTrips = totalTrips - dispoTrips;

  console.log(`  Total enregistrements reçus    : ${records.length.toLocaleString()}`);
  console.log(`  Trajets stockés (total)        : ${totalTrips.toLocaleString()}`);
  console.log(`    ✅ Disponibles               : ${dispoTrips.toLocaleString()}`);
  console.log(`    ❌ Non disponibles           : ${nonDispoTrips.toLocaleString()}`);
  console.log(`  Enregistrements incomplets     : ${skipped}`);
  console.log(`  Gares                          : ${Object.keys(stops).length.toLocaleString()}`);
  console.log(`    📍 Résolues via CSV (FR+TVS) : ${matchedByCSV.toLocaleString()}`);
  console.log(`    🔤 Fallback slug TGVMAX       : ${matchedBySlug.toLocaleString()}`);
  console.log(`  Jours couverts                 : ${Object.keys(calendarIdx).length}`);

  return { trips, stops, routesByStop: routesByStopSerial, calendarIndex: calendarIdx };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  TGVmax Ingest v2 — Export JSON SNCF open data       ║');
  console.log('║  Stockage : TOUS les trajets (dispo + non dispo)     ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');
  console.time('Total');

  // Lire l'URL depuis operators.json si présent
  let exportUrl = EXPORT_URL;
  if (fs.existsSync(OPS_FILE)) {
    const ops = JSON.parse(fs.readFileSync(OPS_FILE, 'utf8'));
    const op  = ops.find(o => o.id === 'TGVMAX');
    if (op?.export_url) {
      exportUrl = op.export_url;
    } else if (op?.api_url) {
      exportUrl = op.api_url.replace('/records', '/exports/json') + '?limit=-1&timezone=Europe%2FParis';
    }
  }

  console.log('── Chargement référentiel gares ──────────────────────');
  matcher.load(CSV_FILE);
  console.log('');

  console.log('── Téléchargement ────────────────────────────────────');
  const records = await downloadJson(exportUrl);
  console.log(`  ✓ ${records.length.toLocaleString()} enregistrements reçus\n`);

  if (!records.length) {
    console.error('❌ Aucune donnée reçue. Vérifiez l\'URL ou la connexion réseau.');
    process.exit(1);
  }

  console.log('── Exemple d\'enregistrement ──────────────────────────');
  console.log(JSON.stringify(records[0], null, 2));
  console.log('');

  console.log('── Transformation ────────────────────────────────────');
  const { trips, stops, routesByStop, calendarIndex } = buildEngineData(records);

  console.log('\n── Écriture engine_data/ ─────────────────────────────');

  function writeJSON(filename, data) {
    const p    = path.join(OUT_DIR, filename);
    const json = JSON.stringify(data);
    fs.writeFileSync(p, json);
    const kb = (Buffer.byteLength(json) / 1024).toFixed(1);
    console.log(`  ✓ ${filename.padEnd(28)} ${kb} KB`);
  }

  writeJSON('trips.json',          trips);
  writeJSON('stops.json',          stops);
  writeJSON('routes_by_stop.json', routesByStop);
  writeJSON('calendar_index.json', calendarIndex);

  const sortedDates  = Object.keys(calendarIndex).sort();
  const totalTrips   = Object.keys(trips).length;
  const dispoTrips   = Object.values(trips).filter(t => t.dispo).length;

  const meta = {
    generated_at:    new Date().toISOString(),
    source:          exportUrl,
    operator:        'TGVMAX',
    version:         2,
    total_records:   records.length,
    total_trips:     totalTrips,
    trips_dispo:     dispoTrips,
    trips_non_dispo: totalTrips - dispoTrips,
    total_stops:     Object.keys(stops).length,
    date_range: {
      first: sortedDates[0]                      || null,
      last:  sortedDates[sortedDates.length - 1] || null,
      count: sortedDates.length,
    },
  };
  writeJSON('meta.json', meta);

  console.log('\n══ Résumé ════════════════════════════════════════════');
  console.log(`  Trajets total       : ${totalTrips.toLocaleString()}`);
  console.log(`    ✅ Disponibles    : ${dispoTrips.toLocaleString()}`);
  console.log(`    ❌ Non disponibles: ${(totalTrips - dispoTrips).toLocaleString()}`);
  console.log(`  Gares               : ${meta.total_stops.toLocaleString()}`);
  console.log(`  Dates               : ${meta.date_range.first} → ${meta.date_range.last}`);
  console.timeEnd('Total');
  console.log('\n→ Lancez ensuite : node build-stations-index.js');
  console.log('→ Puis          : node servermax.js\n');
}

main().catch(err => { console.error('\n❌ Erreur :', err.message); process.exit(1); });