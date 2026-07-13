/**
 * build-tgvmax.js
 * ───────────────────────────────────────────────────────────────────────────
 * Télécharge le dataset TGVmax (SNCF Open Data) et produit 3 fichiers :
 *
 *  tgvmax_index.json   — index compact { date → { trainNo → ["IATA:IATA"] } }
 *                        uniquement les paires od_happy_card = "OUI"
 *
 *  uic_to_iata.json    — mapping UIC8 → code IATA, construit depuis stations.csv
 *
 *  stations.json       — liste des gares desservies par TGVmax uniquement,
 *                        format compatible server.js
 *
 * Usage :
 *   node build-tgvmax.js                        — tout télécharger (33 j)
 *   node build-tgvmax.js --days 60              — fenêtre de 60 jours
 *   node build-tgvmax.js --out ./engine_data    — dossier de sortie
 *   node build-tgvmax.js --csv ./stations.csv   — CSV Trainline alternatif
 *   node build-tgvmax.js --raw                  — sauvegarde aussi tgvmax_raw.json
 *
 * Dépendances : aucune (Node.js natif uniquement)
 * Source API   : https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/tgvmax/exports/json
 * Source CSV   : https://github.com/trainline-eu/stations  (stations.csv)
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── CLI ──────────────────────────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--out')  { args.out  = process.argv[++i]; continue; }
  if (process.argv[i] === '--csv')  { args.csv  = process.argv[++i]; continue; }
  if (process.argv[i] === '--days') { args.days = parseInt(process.argv[++i]); continue; }
  if (process.argv[i] === '--raw')  { args.raw  = true; continue; }
}

const OUT_DIR  = args.out || '.';
const CSV_FILE = args.csv || path.join(__dirname, 'stations.csv');
const MAX_DAYS = args.days || 33;

const IDX_FILE     = path.join(OUT_DIR, 'tgvmax_index.json');
const UIC_FILE     = path.join(OUT_DIR, 'uic_to_iata.json');
const STATIONS_OUT = path.join(OUT_DIR, 'stations.json');
const RAW_FILE     = path.join(OUT_DIR, 'tgvmax_raw.json');

// ─── Export URL (un seul appel, pas de pagination) ────────────────────────────
// L'API paginée /records échoue en HTTP 400 passé ~10 000 records.
// L'endpoint /exports/json retourne tout le dataset filtré en un seul flux JSON.
const EXPORT_BASE = 'https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/tgvmax/exports/json';

function buildExportUrl(where) {
  const p = new URLSearchParams({
    limit:    '-1',
    timezone: 'Europe/Paris',
  });
  if (where) p.set('where', where);
  return `${EXPORT_BASE}?${p.toString()}`;
}

// ─── HTTP streaming avec retry ────────────────────────────────────────────────
// Le dataset peut faire plusieurs dizaines de MB — on streame pour éviter
// d'exploser la mémoire avant de parser.
function fetchExport(url, attempt = 1) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/json' } }, res => {
      if (res.statusCode === 429 || res.statusCode >= 500) {
        res.resume();
        if (attempt < 5) {
          const delay = attempt * 5000;
          console.log(`  ⚠️  HTTP ${res.statusCode} — retry dans ${delay / 1000}s (tentative ${attempt}/5)`);
          return setTimeout(() => fetchExport(url, attempt + 1).then(resolve).catch(reject), delay);
        }
        return reject(new Error(`HTTP ${res.statusCode} après ${attempt} tentatives`));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      // Streaming + progression
      const chunks = [];
      let received = 0;
      const t0 = Date.now();

      res.on('data', chunk => {
        chunks.push(chunk);
        received += chunk.length;
        const mb      = (received / 1024 / 1024).toFixed(1);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stdout.write(`\r  Reçu : ${mb} MB  (${elapsed}s)   `);
      });

      res.on('end', () => {
        process.stdout.write('\n');
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('JSON invalide — réponse tronquée ? (' + raw.slice(0, 200) + ')'));
        }
      });

      res.on('error', reject);
    });

    req.on('error', err => {
      if (attempt < 5) {
        console.log(`  ⚠️  Erreur réseau — retry (tentative ${attempt}/5)`);
        return setTimeout(() => fetchExport(url, attempt + 1).then(resolve).catch(reject), attempt * 2000);
      }
      reject(err);
    });

    // Timeout généreux : le dataset complet peut prendre plusieurs minutes
    req.setTimeout(300000, () => req.destroy(new Error('timeout (5 min)')));
  });
}

// ─── Construction de l'index TGVmax ──────────────────────────────────────────
function buildTgvmaxIndex(records) {
  const index     = {};  // date → trainNo → ["IATA:IATA"]
  const iataNames = {};  // iata → nom lisible
  let nOui = 0, nNon = 0;

  for (const r of records) {
    const { date, train_no, origine_iata, destination_iata, origine, destination, od_happy_card } = r;
    if (!date || !train_no || !origine_iata || !destination_iata) continue;

    if (origine_iata && origine)         iataNames[origine_iata]     = origine;
    if (destination_iata && destination) iataNames[destination_iata] = destination;

    if (od_happy_card !== 'OUI') { nNon++; continue; }
    nOui++;

    if (!index[date])           index[date]           = {};
    if (!index[date][train_no]) index[date][train_no] = [];
    index[date][train_no].push(`${origine_iata}:${destination_iata}`);
  }

  // Dédupliquer
  for (const trains of Object.values(index))
    for (const tn of Object.keys(trains))
      trains[tn] = [...new Set(trains[tn])];

  const dates = Object.keys(index).sort();
  console.log(`  OUI : ${nOui.toLocaleString()}  NON : ${nNon.toLocaleString()}`);
  if (dates.length) console.log(`  Dates : ${dates[0]} → ${dates[dates.length - 1]}  (${dates.length} jours)`);
  console.log(`  Trains uniques : ${new Set(Object.values(index).flatMap(d => Object.keys(d))).size}`);
  console.log(`  Gares IATA     : ${Object.keys(iataNames).length}`);

  return { index, iataNames };
}

// ─── Parse CSV (séparateur ;) ─────────────────────────────────────────────────
function parseCsv(filePath) {
  const lines   = fs.readFileSync(filePath, 'utf8').split('\n');
  const headers = lines[0].split(';');
  const rows    = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = lines[i].split(';');
    const obj  = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = vals[j] || '';
    rows.push(obj);
  }
  return rows;
}

// ─── Normalisation des noms pour matching ─────────────────────────────────────
function normName(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\(intramuros\)/gi, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function nameVariants(raw) {
  const base = normName(raw);
  const set  = new Set([base]);

  const stripped = base
    .replace(/\b(ville|st jean|saint jean|st charles|saint charles|st pierre|saint pierre|matabiau|part dieu|st lazare|saint lazare|gare du nord|gare de lyon|gare de lest|montparnasse|rive droite|rive gauche|central|centrale|centre)\b/g, '')
    .replace(/\s+/g, ' ').trim();
  if (stripped && stripped !== base) set.add(stripped);

  const words = base.split(' ');
  if (words[0] && words[0].length > 3 && words.length > 1) set.add(words[0]);
  if (words.length > 2) set.add(words.slice(0, 2).join(' '));

  return [...set].filter(Boolean);
}

// ─── Construire mapping UIC8 ↔ IATA depuis le CSV ───────────────────────────
function buildUicToIata(iataNames, csvRows) {
  const nameToUic = new Map();
  for (const row of csvRows) {
    const uic8 = row['uic8_sncf']?.trim();
    if (!uic8 || uic8.length < 7) continue;
    const name = row['name']?.trim();
    if (!name) continue;
    for (const variant of nameVariants(name)) {
      if (!nameToUic.has(variant)) nameToUic.set(variant, uic8);
    }
  }

  const sncfIdToUic = new Map();
  for (const row of csvRows) {
    const uic8   = row['uic8_sncf']?.trim();
    const sncfId = row['sncf_id']?.trim();
    if (uic8 && sncfId) sncfIdToUic.set(sncfId, uic8);
  }

  const uicToIata = {};
  let matched = 0, missed = 0;
  const missedList = [];

  for (const [iata, nom] of Object.entries(iataNames)) {
    let foundUic = null;
    for (const variant of nameVariants(nom)) {
      const u = nameToUic.get(variant);
      if (u) { foundUic = u; break; }
    }
    if (!foundUic) {
      const u = sncfIdToUic.get(iata);
      if (u) foundUic = u;
    }

    if (foundUic) { uicToIata[foundUic] = iata; matched++; }
    else          { missed++; missedList.push(`${iata}(${nom})`); }
  }

  console.log(`  Mapping UIC↔IATA : ${matched} trouvés, ${missed} manquants`);
  if (missedList.length > 0 && missedList.length <= 20) console.log('  Manquants : ' + missedList.join(', '));
  else if (missedList.length > 20) console.log('  Premiers manquants : ' + missedList.slice(0, 10).join(', ') + ' …');

  return uicToIata;
}

// ─── Construire stations.json filtré TGVmax ───────────────────────────────────
function buildStations(iataNames, uicToIata, csvRows) {
  const csvByUic = new Map();
  for (const row of csvRows) {
    const uic8 = row['uic8_sncf']?.trim();
    if (!uic8) continue;
    if (!csvByUic.has(uic8) || row['is_main_station'] === 't') {
      csvByUic.set(uic8, row);
    }
  }

  const stations = [];

  for (const [uic8, iata] of Object.entries(uicToIata)) {
    const row     = csvByUic.get(uic8);
    const nom     = row ? row['name']?.trim() : (iataNames[iata] || iata);
    const lat     = row ? parseFloat(row['latitude'])  || 0 : 0;
    const lon     = row ? parseFloat(row['longitude']) || 0 : 0;
    const country = row ? (row['country']?.trim() || 'FR') : 'FR';
    const sncfId  = row ? (row['sncf_id']?.trim()  || '')  : '';

    const stopIds = [`SNCF:StopArea:OCE${uic8}`];

    stations.push({
      name:     nom,
      city:     extractCity(nom),
      country,
      slug:     slugify(nom),
      uic8,
      sncf_id:  sncfId || null,
      iata,
      lat,
      lon,
      stopIds,
      operators: ['SNCF'],
    });
  }

  stations.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  console.log(`  Stations TGVmax : ${stations.length}`);
  return stations;
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────
function slugify(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const CITY_PREFIXES = [
  'Aix-en-Provence','Angers','Avignon','Bordeaux','Brest','Caen',
  'Clermont-Ferrand','Dijon','Grenoble','Le Havre','Le Mans','Lille',
  'Limoges','Lyon','Marseille','Metz','Montpellier','Nancy','Nantes',
  'Nice','Nimes','Orleans','Paris','Perpignan','Poitiers','Reims',
  'Rennes','Rouen','Saint-Etienne','Strasbourg','Toulon','Toulouse','Tours',
];

function extractCity(name) {
  const normalized = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const prefix of CITY_PREFIXES) {
    const normPrefix = prefix.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (normalized === normPrefix || normalized.startsWith(normPrefix + ' ') || normalized.startsWith(normPrefix + '-')) {
      return name.slice(0, prefix.length);
    }
  }
  return name;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  build-tgvmax.js — TGVmax index + stations filtrées         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  if (!fs.existsSync(CSV_FILE)) {
    console.error(`❌ ${CSV_FILE} introuvable.`);
    console.error('   Télécharge stations.csv depuis :');
    console.error('   https://raw.githubusercontent.com/trainline-eu/stations/master/stations.csv');
    process.exit(1);
  }

  // ── 1. Téléchargement via export URL (un seul appel) ────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const end   = new Date(Date.now() + MAX_DAYS * 86400000).toISOString().slice(0, 10);
  const where = `date >= '${today}' AND date <= '${end}'`;

  console.log(`── 1. Téléchargement TGVmax (${today} → ${end}) ──────────────────────`);
  console.log('  Endpoint : export JSON (un seul appel, pas de pagination)\n');

  const exportUrl = buildExportUrl(where);
  const t0        = Date.now();
  const records   = await fetchExport(exportUrl);

  console.log(`  Records reçus : ${records.length.toLocaleString()}\n`);

  if (records.length === 0) { console.warn('  Aucun record.'); return; }

  if (args.raw) {
    fs.writeFileSync(RAW_FILE, JSON.stringify(records, null, 2));
    console.log(`  ✓ tgvmax_raw.json sauvegardé (${(fs.statSync(RAW_FILE).size / 1024 / 1024).toFixed(1)} MB)\n`);
  }

  // ── 2. Construction de l'index ──────────────────────────────────────────────
  console.log('── 2. Construction index TGVmax ────────────────────────────────────');
  const { index, iataNames } = buildTgvmaxIndex(records);
  console.log('');

  // ── 3. Lecture du CSV ───────────────────────────────────────────────────────
  console.log('── 3. Lecture stations.csv ─────────────────────────────────────────');
  const csvRows = parseCsv(CSV_FILE);
  console.log(`  ${csvRows.length.toLocaleString()} lignes lues\n`);

  // ── 4. Mapping UIC ↔ IATA ──────────────────────────────────────────────────
  console.log('── 4. Mapping UIC↔IATA ─────────────────────────────────────────────');
  const uicToIata = buildUicToIata(iataNames, csvRows);
  console.log('');

  // ── 5. Stations filtrées TGVmax ─────────────────────────────────────────────
  console.log('── 5. Construction stations.json (TGVmax uniquement) ───────────────');
  const stations = buildStations(iataNames, uicToIata, csvRows);
  console.log('');

  // ── 6. Écriture des fichiers ────────────────────────────────────────────────
  console.log('── 6. Écriture ─────────────────────────────────────────────────────');

  const sortedDates = Object.keys(index).sort();
  const totalOui    = Object.values(index).flatMap(d => Object.values(d)).reduce((s, a) => s + a.length, 0);

  const payload = {
    generated_at:   new Date().toISOString(),
    coverage:       { first: sortedDates[0] || today, last: sortedDates[sortedDates.length - 1] || today },
    total_od_happy: totalOui,
    iata_names:     iataNames,
    index,
  };

  fs.writeFileSync(IDX_FILE, JSON.stringify(payload));
  console.log(`  ✓ tgvmax_index.json   ${(fs.statSync(IDX_FILE).size / 1024).toFixed(0)} KB  — ${sortedDates.length} jours, ${totalOui.toLocaleString()} OD pairs`);

  fs.writeFileSync(UIC_FILE, JSON.stringify(uicToIata, null, 2));
  console.log(`  ✓ uic_to_iata.json    ${(fs.statSync(UIC_FILE).size / 1024).toFixed(0)} KB  — ${Object.keys(uicToIata).length} gares`);

  fs.writeFileSync(STATIONS_OUT, JSON.stringify(stations, null, 2));
  console.log(`  ✓ stations.json       ${(fs.statSync(STATIONS_OUT).size / 1024).toFixed(0)} KB  — ${stations.length} gares TGVmax`);

  console.log(`\n✅ Terminé en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('\n  → Lance ensuite : node gtfs_ingest.js');
  console.log('  → Puis          : node server.js');
  console.log('  → Mise à jour   : node build-tgvmax.js  (relancer chaque jour)');
}

main().catch(err => { console.error('\n❌ Erreur :', err.message); process.exit(1); });