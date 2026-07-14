/**
 * server.js — Moteur TGVmax
 *
 * Charge les données TGVmax générées par tgvmax-ingest.js
 * et expose une API REST pour rechercher des trajets.
 *
 * Routes :
 *   GET /eveille                          — ping / état du moteur
 *   GET /api/meta                         — métadonnées de l'ingestion
 *   GET /api/stops?q=paris                — autocomplétion des gares
 *   GET /api/cities?q=par                 — autocomplétion ville (multi-gares)
 *   GET /api/search?from=X&to=Y&date=D    — recherche de trajets directs TGVmax
 *   GET /api/transfer?from=X&to=Y&date=D — recherche avec 1 correspondance
 *   GET /api/explore?from=X&date=D        — toutes les destinations disponibles
 *   GET /api/debug/trips?stop=ID&date=D   — debug : départs d'un stop
 */

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const fetch  = require('node-fetch');
const tar    = require('tar');
const zlib   = require('zlib'); // 💡 À ajouter ou vérifier

const DATA_DIR = process.env.DATA_DIR || './engine_data';
const PORT     = process.env.PORT     || 3000;

// ─── Données : téléchargement depuis GitHub Releases ──────────────────────────
// Remplace TON_PSEUDO_GITHUB/TON_NOM_DE_DEPOT, ou définis la variable
// d'environnement DATA_RELEASE_URL sur Render pour ne pas toucher au code.
const DATA_RELEASE_URL = process.env.DATA_RELEASE_URL ||
  'https://github.com/TrainNomad/TGVMAX-Backend/releases/download/data-latest/tgvmax-data.tar.gz';

function downloadDataFromRelease() {
  return new Promise((resolve, reject) => {
    // Si les données existent déjà localement, pas besoin de retélécharger
    if (fs.existsSync(path.join(DATA_DIR, 'meta.json'))) {
      console.log('✅ Données déjà présentes localement dans :', DATA_DIR);
      return resolve();
    }

    console.log(`📥 Téléchargement des données depuis : ${DATA_RELEASE_URL}`);
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    fetch(DATA_RELEASE_URL)
      .then(response => {
        if (!response.ok) {
          throw new Error(`Erreur HTTP au téléchargement: ${response.status} ${response.statusText}`);
        }
        
        // Décompression à la volée du flux tar.gz dans DATA_DIR
        return new Promise((resExtract, rejExtract) => {
          response.body
            .pipe(zlib.createGunzip())
            .pipe(tar.extract({ cwd: DATA_DIR, strip: 1 }))
            .on('finish', () => {
              console.log('📦 Données extraites avec succès !');
              resExtract();
            })
            .on('error', (err) => {
              rejExtract(err);
            });
        });
      })
      .then(() => resolve())
      .catch(err => {
        console.error('❌ Erreur lors du téléchargement/extraction des données :', err);
        reject(err);
      });
  });
}

// ─── Données en RAM ───────────────────────────────────────────────────────────
let tripsBuffer   = null;     // Stocke le Buffer brut de 12 octets par trajet
let TOTAL_TRIPS   = 0;        // tripsBuffer.length / 12
let stops         = {};       // stop_id → { name, lat, lon }
let calendarIndex = {};       // date ISO → [offset binaire] (trips dispo)
let allCalendarIndex = {};    // date ISO → [offset binaire] (tous les trips)
let meta          = {};
let tripMeta      = {};       // index binaire i → { train_no } (si besoin, ou reconstruit)

let stopsIndex = [];   // pour l'autocomplétion
let cityIndex  = new Map();

const COUNTRY_NAMES = { FR:'France' };

// ─── État du moteur ───────────────────────────────────────────────────────────
let engineReady    = false;
let engineError    = null;
let engineLoadedAt = null;
let engineLoadMs   = null;

function loadJSON(filename) {
  const p = path.join(DATA_DIR, filename);
  if (!fs.existsSync(p)) throw new Error('Fichier manquant : ' + p);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ─── Initialisation du moteur (Version Binaire & Hybride) ─────────────────────

function initEngine() {
  console.log('\n🚄 Chargement moteur TGVmax (Format Binaire)...');
  const t = Date.now();

  try {
    // 1. Chargement des JSON légers de structure
    stops         = loadJSON('stops.json');
    meta          = loadJSON('meta.json');
    
    // Pour mapper les dates et numéros de trains de chaque index binaire
    try {
      tripMeta = loadJSON('trip_meta.json');
    } catch (e) {
      tripMeta = {};
    }

    // 2. Chargement du Buffer binaire principal (trips.bin)
    const binPath = path.join(DATA_DIR, 'trips.bin');
    if (!fs.existsSync(binPath)) {
      throw new Error('Fichier binaire trips.bin manquant : ' + binPath);
    }
    tripsBuffer = fs.readFileSync(binPath);
    TOTAL_TRIPS = tripsBuffer.length / 12;

    // 3. Construction des index temporels (calendarIndex & allCalendarIndex)
    // Au lieu de stocker des milliers d'objets JSON en RAM, on mappe des index de
    // position binaire (offset = i * 12) sur les dates correspondantes.
    allCalendarIndex = {};
    calendarIndex = {};

    for (let i = 0; i < TOTAL_TRIPS; i++) {
      const metaItem = tripMeta[i];
      if (!metaItem) continue;

      const dateKey = metaItem.date; // "2026-07-16"
      if (!dateKey) continue;

      // Lecture du bit de disponibilité à l'offset + 8
      const timeValue = tripsBuffer.readUInt32BE(i * 12 + 8);
      const dispo = (timeValue & 0x80000000) !== 0;

      // Tous les trajets
      if (!allCalendarIndex[dateKey]) allCalendarIndex[dateKey] = [];
      allCalendarIndex[dateKey].push(i);

      // Trajets disponibles uniquement
      if (dispo) {
        if (!calendarIndex[dateKey]) calendarIndex[dateKey] = [];
        calendarIndex[dateKey].push(i);
      }
    }

    // 4. Reconstruction de l'index d'autocomplétion
    buildStopsIndex();

    // 5. Petit check de cohérence (Lecture des 3 premiers trajets en binaire)
    const sampleSize = Math.min(TOTAL_TRIPS, 3);
    for (let i = 0; i < sampleSize; i++) {
      const offset = i * 12;
      const originUic = tripsBuffer.readUInt32BE(offset);
      const destUic   = tripsBuffer.readUInt32BE(offset + 4);
      const timeVal   = tripsBuffer.readUInt32BE(offset + 8);
      
      const dispo     = (timeVal & 0x80000000) !== 0;
      const timestamp = timeVal & 0x7FFFFFFF;
      const timeStr   = new Date(timestamp * 1000).toISOString();

      const origName  = stops[originUic]?.name || `UIC ${originUic}`;
      const destName  = stops[destUic]?.name || `UIC ${destUic}`;

      console.log(`  [CHECK binaire] trip #${i}: ${origName} → ${destName} le ${timeStr} (dispo TGVmax=${dispo})`);
    }

    engineLoadMs   = Date.now() - t;
    engineLoadedAt = new Date().toISOString();
    engineReady    = true;
    console.log(`\n✅ Moteur binaire initialisé avec succès en ${engineLoadMs}ms !`);
    console.log(`📦 Mémoire utilisée : ~${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB RAM`);
    console.log(`🚄 Total trajets actifs : ${TOTAL_TRIPS.toLocaleString()}`);

  } catch (err) {
    console.error('❌ Erreur lors de l\'initialisation du moteur :', err);
    engineReady = false;
    engineError = err.message;
  }
}



// ─── Autocomplétion ───────────────────────────────────────────────────────────

function buildStopsIndex() {
  stopsIndex = [];
  cityIndex  = new Map();

  const stFile = path.join(__dirname, 'stations.json');
  if (fs.existsSync(stFile)) {
    const raw = JSON.parse(fs.readFileSync(stFile, 'utf8'));
    for (const s of raw) {
      const city    = s.city    || s.name;
      const country = s.country || 'FR';
      stopsIndex.push({ name:s.name, city, country, stopIds:s.stopIds||[], operators:s.operators||[], lat:s.lat||0, lon:s.lon||0 });

      const key = city.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'') + ':' + country;
      if (!cityIndex.has(key)) {
        cityIndex.set(key, {
          city, country, countryName: COUNTRY_NAMES[country] || country,
          stopIds: new Set(s.stopIds||[]), ops: new Set(s.operators||[]),
          stations: [], lat: s.lat||0, lon: s.lon||0,
        });
      }
      const ce = cityIndex.get(key);
      for (const sid of (s.stopIds||[])) ce.stopIds.add(sid);
      for (const op  of (s.operators||[])) ce.ops.add(op);
      ce.stations.push({ name:s.name, stopIds:s.stopIds||[] });
    }
    // Garder uniquement les villes avec plusieurs gares
    for (const [key, ce] of cityIndex) {
      if (ce.stations.length < 2) cityIndex.delete(key);
    }
    console.log('  Autocomplétion : ' + stopsIndex.length + ' gares');
    console.log('  Villes multi-gares : ' + cityIndex.size);
    return;
  }

  // Fallback direct depuis stops.json si stations.json absent
  for (const [sid, stop] of Object.entries(stops)) {
    stopsIndex.push({ name:stop.name||sid, city:stop.name||sid, country:'FR',
      stopIds:[sid], operators:['TGVMAX'], lat:stop.lat||0, lon:stop.lon||0 });
  }
  console.log('  Autocomplétion (fallback stops) : ' + stopsIndex.length + ' gares');
}

function searchStops(query, limit=10) {
  const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const results = [];
  for (const e of stopsIndex) {
    const nom  = e.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const city = (e.city||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    if (nom.includes(q) || city.includes(q)) {
      // Priorité : commence par q > contient q
      results.push({ type:'station', _score: nom.startsWith(q) ? 0 : 1, ...e });
      if (results.length >= limit * 3) break;
    }
  }
  results.sort((a, b) => {
    if (a._score !== b._score) return a._score - b._score;
    return (a.name||'').localeCompare(b.name||'','fr');
  });
  return results.slice(0, limit).map(({ _score, ...e }) => e);
}

function searchCities(query) {
  const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const results = [];
  for (const [, ce] of cityIndex) {
    const cn = ce.city.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    if (!cn.startsWith(q) && !cn.includes(q)) continue;
    results.push({
      type:'city', name:ce.city, country:ce.country, countryName:ce.countryName,
      stopIds:[...ce.stopIds], operators:[...ce.ops].sort(),
      stations:ce.stations, lat:ce.lat, lon:ce.lon,
    });
  }
  results.sort((a, b) => {
    const aN = a.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const bN = b.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    return (aN.startsWith(q)?0:1)-(bN.startsWith(q)?0:1) || a.name.localeCompare(b.name,'fr');
  });
  return results;
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────

function secondsToHHMM(s) {
  if (s == null) return '--:--';
  const totalMin = Math.floor(s / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  // Si > 24h, afficher l'heure réelle sans modulo (ex: 25h10 → "01:10 +1j")
  if (h >= 24) {
    return String(h % 24).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ' <span class="overnight-tag">+1j</span>';
  }
  return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
}

function timeToSeconds(t) {
  if (!t || !t.includes(':')) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 3600 + m * 60;
}

function resolveStopName(stopId) {
  // D'abord chercher dans stopsIndex (stations.json avec vrais noms de villes)
  for (const station of stopsIndex) {
    if ((station.stopIds||[]).includes(stopId)) return station.name;
  }
  // Fallback : stops.json (clé = indice numérique string)
  return (stops[stopId]?.name) || stopId;
}

function resolveStopCoords(stopId) {
  // Cherche d'abord dans stopsIndex (stations.json) qui a les vraies coords
  for (const station of stopsIndex) {
    if ((station.stopIds||[]).includes(stopId) && station.lat && station.lon) {
      return { lat: station.lat, lon: station.lon };
    }
  }
  // Fallback stops.json (clé = indice numérique string)
  const s = stops[stopId];
  return { lat: s?.lat || 0, lon: s?.lon || 0 };
}

function cityKeyOfStop(stopId) {
  for (const s of stopsIndex) {
    if ((s.stopIds||[]).includes(stopId)) {
      const city    = s.city || s.name;
      const country = s.country || 'FR';
      return city.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'') + ':' + country;
    }
  }
  return stopId;
}

// ─── Recherche de trajets TGVmax ──────────────────────────────────────────────
//
// La logique est simple : on cherche tous les trips qui :
//  1. Partent de l'un des fromIds
//  2. Arrivent à l'un des toIds
//  3. Sont disponibles à la date demandée
//  4. Partent après startTime
//
// Les trajets TGVmax sont TOUS directs (pas de correspondances).

function getTripsForDate(dateISO, dispoOnly = false) {
  let list;
  if (!dateISO) {
    list = Object.values(trips);
  } else {
    const ids = allCalendarIndex[dateISO] || [];
    list = ids.map(id => trips[id]).filter(Boolean);
  }
  return dispoOnly ? list.filter(t => t.dispo) : list;
}

function searchJourneys(fromIds, toIds, dateISO, startTimeSec, limit=8) {
  const fromSet = new Set(fromIds);
  const toSet   = new Set(toIds);

  const dayTrips = getTripsForDate(dateISO);
  const results  = [];

  for (const trip of dayTrips) {
    if (!fromSet.has(trip.origin_id)) continue;
    if (!toSet.has(trip.dest_id))     continue;
    if (trip.dep_time != null && trip.dep_time < startTimeSec) continue;

    results.push({
      trip_id:       trip.trip_id,
      train_no:      trip.train_no,
      date:          trip.date,
      dep_time:      trip.dep_time,
      arr_time:      trip.arr_time,
      dep_str:       trip.dep_str || secondsToHHMM(trip.dep_time),
      arr_str:       trip.arr_str || secondsToHHMM(trip.arr_time),
      duration:      trip.dep_time != null && trip.arr_time != null
                     ? Math.round((trip.arr_time - trip.dep_time) / 60) : null,
      transfers:     0,
      train_types:   ['INOUI'],
      operator:      'TGVMAX',
      od_happy_card: trip.dispo ? 'oui' : 'non',
      from_id:       trip.origin_id,
      to_id:         trip.dest_id,
      from_name:     resolveStopName(trip.origin_id),
      to_name:       resolveStopName(trip.dest_id),
      legs: [{
        from_id:    trip.origin_id,
        to_id:      trip.dest_id,
        from_name:  resolveStopName(trip.origin_id),
        to_name:    resolveStopName(trip.dest_id),
        dep_time:   trip.dep_time,
        arr_time:   trip.arr_time,
        dep_str:    trip.dep_str || secondsToHHMM(trip.dep_time),
        arr_str:    trip.arr_str || secondsToHHMM(trip.arr_time),
        trip_id:    trip.trip_id,
        train_no:   trip.train_no,
        operator:   'TGVMAX',
        train_type: 'INOUI',
        duration:   trip.dep_time != null && trip.arr_time != null
                    ? Math.round((trip.arr_time - trip.dep_time) / 60) : null,
      }],
    });
  }

  results.sort((a, b) => (a.dep_time || 0) - (b.dep_time || 0));
  return results.slice(0, limit);
}

// ─── Explore : toutes destinations depuis une gare ────────────────────────────

function exploreDestinations(fromIds, dateISO) {
  const fromSet  = new Set(fromIds);
  // dispoOnly=true : on ne prend QUE les trains avec places disponibles TGVmax
  const dayTrips = getTripsForDate(dateISO, true);
  const bestByDest = {};

  // Index des départs par gare — construit UNE fois sur les trips dispo
  const tripsByOrigin = buildTripsByOrigin(dayTrips);

  // ── BFS : leg 1 depuis les origines ──────────────────────────────────────────
  let frontier = [];

  for (const trip of dayTrips) {
    if (!fromSet.has(trip.origin_id))          continue;
    if (trip.dep_time == null || trip.arr_time == null) continue;

    const did = trip.dest_id;
    const leg = makeLegObj(trip, trip.origin_id, did);  // arr_time normalisé dans makeLegObj
    const dur = leg.duration;

    // Garder la destination directe si c'est la plus courte
    if (!bestByDest[did] || dur < bestByDest[did].duration) {
      const coords = resolveStopCoords(did);
      bestByDest[did] = {
        // Champs plats attendus par explorermax.js
        dest_id:   did,
        dest_name: resolveStopName(did),
        dep_str:   leg.dep_str,
        arr_str:   leg.arr_str,
        dep_time:  trip.dep_time,
        arr_time:  trip.arr_time,
        duration:  dur,
        transfers: 0,
        dest_lat:  coords.lat,
        dest_lon:  coords.lon,
        // Tableau journeys pour la compatibilité avec buildDestinations()
        journeys: [{
          dep_str:   leg.dep_str,
          arr_str:   leg.arr_str,
          dep_time:  trip.dep_time,
          arr_time:  trip.arr_time,
          duration:  dur,
          transfers: 0,
          train_types: ['TGVMAX'],
          legs:      [leg],
        }],
      };
    }

    frontier.push({
      currentStop:  did,
      currentArr:   trip.arr_time,
      legs:         [leg],
      visitedStops: new Set([trip.origin_id, did]),
    });
  }

  // ── BFS : correspondances (depth 2..MAX_LEGS) ─────────────────────────────────
  for (let depth = 2; depth <= MAX_LEGS && frontier.length > 0; depth++) {
    // Élaguer pour limiter l'explosion combinatoire
    if (frontier.length > MAX_STATES_PER_ROUND) {
      frontier.sort((a, b) => a.currentArr - b.currentArr);
      frontier = frontier.slice(0, MAX_STATES_PER_ROUND);
    }

    const nextFrontier = [];

    for (const state of frontier) {
      const { currentStop, currentArr, legs, visitedStops } = state;
      const candidates = tripsByOrigin[currentStop] || [];

      for (const trip of candidates) {
        if (trip.dep_time == null || trip.arr_time == null) continue;

        const wait = trip.dep_time - currentArr;
        if (wait < MIN_TRANSFER_SEC_DEFAULT) continue;  // trop court
        if (wait > MAX_TRANSFER_SEC_DEFAULT) continue;  // trop long
        if (visitedStops.has(trip.dest_id))  continue;  // cycle

        // Rejeter si le train de correspondance arrive le lendemain du départ initial
        // (dep_time du leg 1 est dans la journée, arrNorm > 86400 = hors journée)
        const firstDepTime = legs[0]?.dep_time || 0;
        const did = trip.dest_id;
        const leg = makeLegObj(trip, currentStop, did);
        const newLegs  = [...legs, leg];
        const firstLeg = newLegs[0];
        const totalDur = Math.round((leg.arr_time - firstLeg.dep_time) / 60);

        // Mettre à jour si c'est le trajet le plus court vers cette destination
        if (!bestByDest[did] || totalDur < bestByDest[did].duration) {
          const coords = resolveStopCoords(did);
          bestByDest[did] = {
            dest_id:   did,
            dest_name: resolveStopName(did),
            dep_str:   firstLeg.dep_str,
            arr_str:   leg.arr_str,
            dep_time:  firstLeg.dep_time,
            arr_time:  trip.arr_time,
            duration:  totalDur,
            transfers: newLegs.length - 1,
            dest_lat:  coords.lat,
            dest_lon:  coords.lon,
            journeys: [{
              dep_str:   firstLeg.dep_str,
              arr_str:   leg.arr_str,
              dep_time:  firstLeg.dep_time,
              arr_time:  trip.arr_time,
              duration:  totalDur,
              transfers: newLegs.length - 1,
              train_types: newLegs.map(() => 'TGVMAX'),
              legs:      newLegs,
            }],
          };
        }

        if (depth < MAX_LEGS) {
          const newVisited = new Set(visitedStops);
          newVisited.add(did);
          nextFrontier.push({
            currentStop:  did,
            currentArr:   leg.arr_time,   // normalisé
            legs:         newLegs,
            visitedStops: newVisited,
          });
        }
      }
    }

    frontier = nextFrontier;
  }

  // Ne retourner que les destinations avec coordonnées GPS valides
  return Object.values(bestByDest).filter(d => d.dest_lat && d.dest_lon);
}

// ─── Recherche avec correspondances (jusqu'à 5 correspondances = 6 legs) ────────
//
// Algorithme BFS itératif en couches :
//   - Couche 0 : tous les trips partant des fromIds après startTimeSec et dispo
//   - Couche k : pour chaque état (stop_id, arr_time, legs[]), on cherche les trips
//                qui partent de stop_id avec un temps de correspondance valide
//   - On s'arrête quand dest_id ∈ toSet (on a trouvé) ou quand on atteint MAX_LEGS
//   - Élagage : on ne visite pas deux fois le même stop dans le même chemin (cycles),
//               on ne continue pas si arr_time > meilleure arrivée connue à destination
//               + coupe-circuit global pour rester performant

const MIN_TRANSFER_SEC_DEFAULT = 20 * 60; // 20 min minimum
const MAX_TRANSFER_SEC_DEFAULT = 4 * 3600; // 4h max entre deux trains
const MAX_LEGS = 6;          // 6 trains = 5 correspondances
const MAX_STATES_PER_ROUND = 500;  // élagage pour éviter l'explosion combinatoire
const MAX_TOTAL_RESULTS = 200;     // coupe-circuit global

function buildTripsByOrigin(dayTrips) {
  const idx = {};
  for (const trip of dayTrips) {
    if (!idx[trip.origin_id]) idx[trip.origin_id] = [];
    idx[trip.origin_id].push(trip);
  }
  return idx;
}

function makeLegObj(trip, fromId, toId) {
  // Normaliser arr_time : si le train arrive après minuit (arr < dep),
  // ajouter 86400s pour que la chronologie soit cohérente
  const arrNorm = (trip.arr_time != null && trip.dep_time != null && trip.arr_time < trip.dep_time)
    ? trip.arr_time + 86400
    : trip.arr_time;

  const dur = (trip.dep_time != null && arrNorm != null)
    ? Math.round((arrNorm - trip.dep_time) / 60)
    : null;

  return {
    from_id:    fromId,
    to_id:      toId,
    from_name:  resolveStopName(fromId),
    to_name:    resolveStopName(toId),
    dep_time:   trip.dep_time,
    arr_time:   arrNorm,
    dep_str:    trip.dep_str || secondsToHHMM(trip.dep_time),
    arr_str:    secondsToHHMM(arrNorm),   // recalculé avec la valeur normalisée
    trip_id:    trip.trip_id,
    train_no:   trip.train_no,
    operator:   'TGVMAX',
    train_type: 'INOUI',
    duration:   dur,
  };
}

function buildJourneyFromLegs(legs, dateISO) {
  const first = legs[0];
  const last  = legs[legs.length - 1];
  const allDispo = legs.every(l => {
    const t = trips[l.trip_id];
    return t ? t.dispo : true;
  });
  const totalDuration = first.dep_time != null && last.arr_time != null
    ? Math.round((last.arr_time - first.dep_time) / 60) : null;

  return {
    trip_id:      legs.map(l => l.trip_id).join('|'),
    date:         dateISO,
    dep_time:     first.dep_time,
    arr_time:     last.arr_time,
    dep_str:      first.dep_str || secondsToHHMM(first.dep_time),
    arr_str:      last.arr_str  || secondsToHHMM(last.arr_time),
    duration:     totalDuration,
    transfers:    legs.length - 1,
    train_types:  legs.map(() => 'INOUI'),
    operator:     'TGVMAX',
    od_happy_card: allDispo ? 'oui' : 'non',
    from_id:      first.from_id,
    to_id:        last.to_id,
    from_name:    first.from_name,
    to_name:      last.to_name,
    legs,
  };
}

function searchJourneysWithTransfer(fromIds, toIds, dateISO, startTimeSec, options = {}) {
  const {
    minTransferSec = MIN_TRANSFER_SEC_DEFAULT,
    maxTransferSec = MAX_TRANSFER_SEC_DEFAULT,
    maxResults     = 10,
    viaIds         = null,
    maxLegs        = MAX_LEGS,
  } = options;

  const fromSet = new Set(fromIds);
  const toSet   = new Set(toIds);
  const viaSet  = viaIds ? new Set(viaIds) : null;

  const dayTrips      = getTripsForDate(dateISO);
  const tripsByOrigin = buildTripsByOrigin(dayTrips);

  const results = [];
  const seenKeys = new Set();

  // bestArrToSet : meilleure arrivée connue à la destination — élagage
  let bestArrToSet = Infinity;

  // État BFS : { currentStop, currentArr, legs[], visitedStops Set }
  // On initialise avec les trips du leg 1
  let frontier = [];

  for (const trip of dayTrips) {
    if (!fromSet.has(trip.origin_id)) continue;
    if (!trip.dispo)                  continue;
    if (trip.dep_time != null && trip.dep_time < startTimeSec) continue;

    const leg = makeLegObj(trip, trip.origin_id, trip.dest_id);

    // Trajet direct
    if (toSet.has(trip.dest_id)) {
      const key = trip.trip_id;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        const j = buildJourneyFromLegs([leg], dateISO);
        results.push(j);
        if ((trip.arr_time || Infinity) < bestArrToSet) bestArrToSet = trip.arr_time;
      }
      continue;
    }

    // Filtrer par via si spécifié (la gare intermédiaire doit être dans le chemin)
    if (viaSet && !viaSet.has(trip.dest_id)) continue;

    if (trip.arr_time == null) continue;

    frontier.push({
      currentStop:   trip.dest_id,
      currentArr:    trip.arr_time,
      legs:          [leg],
      visitedStops:  new Set([trip.origin_id, trip.dest_id]),
    });
  }

  // BFS couche par couche jusqu'à maxLegs
  for (let depth = 2; depth <= maxLegs && frontier.length > 0; depth++) {
    // Élaguer les états dont l'arrivée dépasse déjà le meilleur résultat
    frontier = frontier.filter(s => s.currentArr < bestArrToSet);

    // Limiter le frontier pour la performance
    if (frontier.length > MAX_STATES_PER_ROUND) {
      frontier.sort((a, b) => a.currentArr - b.currentArr);
      frontier = frontier.slice(0, MAX_STATES_PER_ROUND);
    }

    const nextFrontier = [];

    for (const state of frontier) {
      const { currentStop, currentArr, legs, visitedStops } = state;
      const candidates = tripsByOrigin[currentStop] || [];

      for (const trip of candidates) {
        if (trip.dep_time == null || trip.arr_time == null) continue;

        const transferSec = trip.dep_time - currentArr;
        if (transferSec < minTransferSec) continue;
        if (transferSec > maxTransferSec) continue;

        // Éviter les cycles
        if (visitedStops.has(trip.dest_id)) continue;

        // Élagage : inutile de continuer si on arrive après le meilleur résultat
        const leg = makeLegObj(trip, currentStop, trip.dest_id);
        if (leg.arr_time >= bestArrToSet) continue;
        const newLegs = [...legs, leg];

        // Destination atteinte
        if (toSet.has(trip.dest_id)) {
          const key = newLegs.map(l => l.trip_id).join('|');
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            const j = buildJourneyFromLegs(newLegs, dateISO);
            results.push(j);
            if (leg.arr_time < bestArrToSet) bestArrToSet = leg.arr_time;
          }
          if (results.length >= MAX_TOTAL_RESULTS) break;
          continue;
        }

        // Continuer l'exploration si on n'a pas atteint la profondeur max
        if (depth < maxLegs) {
          const newVisited = new Set(visitedStops);
          newVisited.add(trip.dest_id);
          nextFrontier.push({
            currentStop:  trip.dest_id,
            currentArr:   trip.arr_time,
            legs:         newLegs,
            visitedStops: newVisited,
          });
        }
      }

      if (results.length >= MAX_TOTAL_RESULTS) break;
    }

    frontier = nextFrontier;
    if (results.length >= MAX_TOTAL_RESULTS) break;
  }

  // Supprimer les doublons (même clé de trip_ids)
  const unique = [];
  const finalSeen = new Set();
  for (const j of results) {
    if (!finalSeen.has(j.trip_id)) { finalSeen.add(j.trip_id); unique.push(j); }
  }

  // Trier : d'abord par heure d'arrivée, puis par nombre de correspondances
  unique.sort((a, b) => (a.arr_time || 0) - (b.arr_time || 0) || a.transfers - b.transfers);
  return unique.slice(0, maxResults);
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function jsonResp(res, req, data, code = 200) {
  const jsonString = JSON.stringify(data);
  const buffer = Buffer.from(jsonString, 'utf8');

  const headers = {
    'Content-Type': 'application/json; charset=utf-8', 
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept-Encoding'
  };

  const acceptEncoding = (req && req.headers && req.headers['accept-encoding']) || '';
  
  if (acceptEncoding.includes('br')) {
    zlib.brotliCompress(buffer, (err, compressed) => {
      if (!err) {
        headers['Content-Encoding'] = 'br';
        res.writeHead(code, headers);
        return res.end(compressed);
      }
      fallbackNoCompression(res, buffer, headers, code);
    });
  } else if (acceptEncoding.includes('gzip')) {
    zlib.gzip(buffer, (err, compressed) => {
      if (!err) {
        headers['Content-Encoding'] = 'gzip';
        res.writeHead(code, headers);
        return res.end(compressed);
      }
      fallbackNoCompression(res, buffer, headers, code);
    });
  } else {
    fallbackNoCompression(res, buffer, headers, code);
  }
}

function fallbackNoCompression(res, buffer, headers, code) {
  headers['Content-Length'] = buffer.length;
  res.writeHead(code, headers);
  res.end(buffer);
}
function serveFile(res, fp) {
  if (!fs.existsSync(fp)) { res.writeHead(404); res.end('Not found'); return; }
  const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml' };
  cors(res);
  res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'text/plain' });
  fs.createReadStream(fp).pipe(res);
}
function getBody(req) {
  return new Promise(r => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { r(JSON.parse(b)); } catch { r({}); } });
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const p    = parsedUrl.pathname;
  const q    = parsedUrl.query;
  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept-Encoding',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  // ── Route : /eveille
  if (p === '/eveille' || p === '/ping') {
    return jsonResp(res, req, { status: 'ok', engine_ready: engineReady });
  }

  // ── Route : /api/meta
  if (p === '/api/meta') {
    return jsonResp(res, req, meta || { error: 'No meta available' });
  }

  // ── Route : /api/stops
  if (p === '/api/stops') {
    const queryStr = (q.q || '').trim();
    if (!queryStr) return jsonResp(res, req, []);
    
    const results = searchStops(queryStr, 30);
    return jsonResp(res, req, results);
  }

  // ── Route : /api/cities
  if (p === '/api/cities') {
    const queryStr = (q.q || '').trim();
    if (!queryStr) return jsonResp(res, req, []);

    const results = searchCities(queryStr);
    return jsonResp(res, req, results);
  }

  // ── Route : /api/search
  if (p === '/api/search') {
    const { from, to, date, time } = q;
    if (!from || !to || !date) {
      return jsonResp(res, req, { error: 'Paramètres from, to et date requis.' }, 400);
    }
    const startTimeSec = timeToSeconds(time || '00:00');
    const fromIds = from.split(',');
    const toIds = to.split(',');
    const results = searchJourneys(fromIds, toIds, date, startTimeSec);
    return jsonResp(res, req, { journeys: results });
  }

  // ── Fichiers statiques (Frontend)
  const staticMap = { '/': 'index.html', '/index.html': 'index.html', '/trajets.html': 'trajets.html' };
  if (staticMap[p]) return serveFile(res, path.join(__dirname, staticMap[p]));

  const assetPath = path.join(__dirname, p);
  if (fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) return serveFile(res, assetPath);

  return jsonResp(res, req, { error: 'Not found' }, 404);
});

// ─── Démarrage ────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log('🌐 http://localhost:' + PORT + '  (moteur en cours de chargement…)');
  (async () => {
    try {
      await downloadDataFromRelease();
      initEngine();
    } catch (err) {
      engineError = err.message;
      console.error('❌ Échec chargement moteur :', err);
    }
  })();
});