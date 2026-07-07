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

const DATA_DIR = process.env.DATA_DIR || './engine_data';
const PORT     = process.env.PORT     || 3000;

// ─── Données : téléchargement depuis GitHub Releases ──────────────────────────
// Remplace TON_PSEUDO_GITHUB/TON_NOM_DE_DEPOT, ou définis la variable
// d'environnement DATA_RELEASE_URL sur Render pour ne pas toucher au code.
const DATA_RELEASE_URL = process.env.DATA_RELEASE_URL ||
  'https://github.com/TrainNomad/TGVMAX-Backend/releases/download/data-latest/tgvmax-data.tar.gz';

async function downloadDataFromRelease() {
  // Si les données sont déjà présentes en local (dev, ou déjà téléchargées
  // lors d'un précédent démarrage du même conteneur), on ne retélécharge pas.
  const metaFile = path.join(DATA_DIR, 'meta.json');
  if (fs.existsSync(metaFile)) {
    console.log('ℹ️  Données déjà présentes localement, téléchargement ignoré.');
    return;
  }

  console.log('📥 Téléchargement des données TGVmax depuis GitHub Releases...');
  const res = await fetch(DATA_RELEASE_URL, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Échec du téléchargement (${res.status} ${res.statusText}) : ${DATA_RELEASE_URL}`);
  }

  const archivePath = path.join(__dirname, 'tgvmax-data.tar.gz');
  await new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(archivePath);
    res.body.pipe(dest);
    res.body.on('error', reject);
    dest.on('finish', resolve);
    dest.on('error', reject);
  });

  console.log('📦 Extraction de l\'archive...');
  await tar.x({ file: archivePath, cwd: __dirname });
  fs.unlinkSync(archivePath);
  console.log('✅ Données TGVmax prêtes.');
}

// ─── Données en RAM ───────────────────────────────────────────────────────────
let trips         = {};  // trip_id → trip object
let stops         = {};  // stop_id → { name, lat, lon }
let routesByStop  = {};  // stop_id → [trip_ids]
let calendarIndex = {};  // date ISO → [trip_ids]  (dispo uniquement, tel que généré par l'ingest)
let allCalendarIndex = {}; // date ISO → [trip_ids]  (TOUS les trips, construit au chargement)
let meta          = {};
let tripMeta      = {};  // tripNumId → {date, train_no} (metadata légère)

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

// ─── Décompression des données (numéros → strings) ────────────────────────────────
// Les données générées par tgvmax-ingest.js v3 sont "compressées" :
// - stops: {0: {name, lat, lon}, 1: {...}, ...} (indices numériques)
// - trips: {0: {o: 2, d: 5, t_dep: 1234, t_arr: 5678, dispo: 1}, ...}
//
// On les "décompresse" ici pour que le reste du code voie le format normal.
function decompressTripsAndStops(tripsCompressed, stopsDict) {
  // Inverser stops : de {0: {name, ...}} à {"STOP_NAME": {name, ...}}
  const numIdToStopId = {};
  const stopsDecompressed = {};
  
  for (const [numId, stopData] of Object.entries(stopsDict)) {
    const stopId = `NUM_STOP:${numId}`;  // ID unique basé sur le numéro
    numIdToStopId[numId] = stopId;
    stopsDecompressed[stopId] = stopData;
  }

  // Décompresser trips : {o, d, t_dep, t_arr, dispo} → {origin_id, dest_id, dep_time, arr_time, dispo}
  const tripsDecompressed = {};
  for (const [tripNumId, tripCompressed] of Object.entries(tripsCompressed)) {
    const originStopId = numIdToStopId[tripCompressed.o];
    const destStopId = numIdToStopId[tripCompressed.d];
    
    tripsDecompressed[tripNumId] = {
      trip_id:    tripNumId,
      origin_id:  originStopId,
      dest_id:    destStopId,
      dep_time:   tripCompressed.t_dep,
      arr_time:   tripCompressed.t_arr,
      dispo:      tripCompressed.dispo === 1 ? true : false,
      operator:   'TGVMAX',
      train_type: 'TGVMAX'
    };
  }

  return { trips: tripsDecompressed, stops: stopsDecompressed };
}

// ─── Chargement ───────────────────────────────────────────────────────────────

function initEngine() {
  console.log('\n🚄 Chargement moteur TGVmax...');
  const t = Date.now();

  // Charger les fichiers bruts
  const tripsCompressed = loadJSON('trips.json');
  const stopsDict       = loadJSON('stops.json');
  routesByStop          = loadJSON('routes_by_stop.json');
  calendarIndex         = loadJSON('calendar_index.json');
  meta                  = loadJSON('meta.json');
  
  // Charger tripMeta si dispo (nouveau fichier d'optimisation)
  try {
    tripMeta = loadJSON('trip_meta.json');
  } catch (e) {
    // Si fichier absent, c'est OK (anciennes données)
    tripMeta = {};
  }

  // Décompresser trips & stops (numéros → vrais IDs)
  console.log('  Décompression données optimisées...');
  const decompressed = decompressTripsAndStops(tripsCompressed, stopsDict);
  trips = decompressed.trips;
  stops = decompressed.stops;

  // Construire un index date → [trip_ids] pour TOUS les trips (dispo ou non)
  allCalendarIndex = {};
  for (const [tripId, trip] of Object.entries(trips)) {
    // Avec les données décompressées, on peut utiliser trip_meta pour la date
    const tripNum = tripId;  // trip_id est maintenant un numéro
    const dateKey = tripMeta[tripNum] ? tripMeta[tripNum].date : null;
    
    if (!dateKey) continue;
    if (!allCalendarIndex[dateKey]) allCalendarIndex[dateKey] = [];
    allCalendarIndex[dateKey].push(tripId);
  }
  console.log('  Index all-trips : ' + Object.keys(allCalendarIndex).length + ' dates');

  buildStopsIndex();

  const totalTrips = Object.keys(trips).length;
  engineLoadMs   = Date.now() - t;
  engineLoadedAt = new Date().toISOString();
  engineReady    = true;
  console.log('✅ Prêt en ' + engineLoadMs + 'ms — ' + totalTrips.toLocaleString() + ' trajets TGVmax chargés\n');
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
  for (const station of stopsIndex) {
    if ((station.stopIds||[]).includes(stopId)) return station.name;
  }
  return (stops[stopId]?.name) || stopId;
}

function resolveStopCoords(stopId) {
  // Cherche d'abord dans stopsIndex (stations.json) qui a les vraies coords
  for (const station of stopsIndex) {
    if ((station.stopIds||[]).includes(stopId) && station.lat && station.lon) {
      return { lat: station.lat, lon: station.lon };
    }
  }
  // Fallback stops.json brut
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
function jsonResp(res, data, status=200) {
  cors(res);
  res.writeHead(status, { 'Content-Type':'application/json' });
  res.end(JSON.stringify(data));
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

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname, q = parsed.query;

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  // ── Ping keep-alive ──
  if (p === '/eveille') {
    return jsonResp(res, {
      ok:        true,
      ready:     engineReady,
      uptime_s:  Math.floor(process.uptime()),
      loaded_at: engineLoadedAt,
      load_ms:   engineLoadMs,
      message:   engineReady ? '✅ Moteur TGVmax opérationnel' : '⏳ Chargement en cours…',
    });
  }

  // ── Bloquer les API tant que l'engine charge ──
  if (p.startsWith('/api/') && !engineReady) {
    return jsonResp(res, {
      error:   'Serveur en cours de démarrage, réessayez dans quelques secondes.',
      ready:   false,
      load_ms: engineLoadMs,
    }, 503);
  }

  // ── /api/meta ──
  if (p === '/api/meta') {
    if (!engineReady) return jsonResp(res, { warming: true }, 503);
    return jsonResp(res, meta);
  }

  // ── /api/stops ──
  if (p === '/api/stops') {
    const qs = (q.q || '').trim();
    return jsonResp(res, qs ? searchStops(qs, 10) : []);
  }

  // ── /api/cities ──
  if (p === '/api/cities') {
    const qs = (q.q || '').trim();
    if (!qs || qs.length < 2) return jsonResp(res, []);
    return jsonResp(res, searchCities(qs));
  }

  // ── /api/search ──
  if (p === '/api/search') {
    const t0       = Date.now();
    const fromIds  = (q.from  || '').split(',').filter(Boolean);
    const toIds    = (q.to    || '').split(',').filter(Boolean);
    const dateStr  = (q.date  || '').trim();
    const timeStr  = (q.time  || '00:00').trim();
    const limit    = Math.min(parseInt(q.limit || '8'), 50);
    const offset   = parseInt(q.offset || '0');
    const afterDep = parseInt(q.after_dep || '0');

    if (!fromIds.length || !toIds.length) {
      return jsonResp(res, { error: 'Paramètres from et to requis' }, 400);
    }

    const startSec = Math.max(timeToSeconds(timeStr) + offset, afterDep || 0);

    console.log('\n[SEARCH TGVmax]', dateStr || 'sans date', timeStr);
    console.log('  from:', fromIds.join(','), '→ to:', toIds.join(','));

    // Trajets directs
    const directJourneys = searchJourneys(fromIds, toIds, dateStr, startSec, limit);

    // Trajets avec correspondance jusqu'à 5 (seulement si date fournie)
    let transferJourneys = [];
    if (dateStr) {
      const maxLegsParam = Math.min(parseInt(q.max_legs || '6'), 6); // 6 trains = 5 corresp max
      transferJourneys = searchJourneysWithTransfer(fromIds, toIds, dateStr, startSec, {
        maxResults: limit,
        maxLegs:    maxLegsParam,
      });
    }

    // Supprimer les correspondances redondantes :
    // si l'un des legs utilise un train_no qui existe déjà en direct, on l'élimine
    const directTrainNos = new Set(directJourneys.map(j => j.train_no).filter(Boolean));
    const filteredTransfers = transferJourneys.filter(j =>
      !j.legs.some(leg => directTrainNos.has(leg.train_no))
    );

    // Fusionner et trier par heure de départ, directs en priorité en cas d'égalité
    const allJourneys = [...directJourneys, ...filteredTransfers]
      .sort((a, b) => (a.dep_time || 0) - (b.dep_time || 0) || a.transfers - b.transfers)
      .slice(0, limit);

    const lastDep    = allJourneys.length ? Math.max(...allJourneys.map(j => j.dep_time||0)) : startSec;
    const nextOffset = lastDep - timeToSeconds(timeStr);

    console.log(`  Résultats : ${directJourneys.length} directs + ${filteredTransfers.length} correspondances (${transferJourneys.length - filteredTransfers.length} redondantes supprimées) = ${allJourneys.length} total`);

    return jsonResp(res, {
      journeys:      allJourneys,
      computed_ms:   Date.now() - t0,
      next_offset:   nextOffset,
      last_dep_time: lastDep,
    });
  }

  // ── /api/transfer ──
  if (p === '/api/transfer') {
    const t0        = Date.now();
    const fromIds   = (q.from  || '').split(',').filter(Boolean);
    const toIds     = (q.to    || '').split(',').filter(Boolean);
    const viaIds    = q.via ? q.via.split(',').filter(Boolean) : null;
    const dateStr   = (q.date  || '').trim();
    const timeStr   = (q.time  || '00:00').trim();
    const limit     = Math.min(parseInt(q.limit || '10'), 50);
    const minTrans  = parseInt(q.min_transfer || '20') * 60;  // en secondes
    const maxTrans  = parseInt(q.max_transfer || '240') * 60; // en secondes

    if (!fromIds.length || !toIds.length) {
      return jsonResp(res, { error: 'Paramètres from et to requis' }, 400);
    }
    if (!dateStr) {
      return jsonResp(res, { error: 'Paramètre date requis (YYYY-MM-DD)' }, 400);
    }

    const startSec = timeToSeconds(timeStr);
    console.log('\n[TRANSFER TGVmax]', dateStr, timeStr);
    console.log('  from:', fromIds.join(','), '→ to:', toIds.join(','), viaIds ? '| via: ' + viaIds.join(',') : '');

    const journeys = searchJourneysWithTransfer(fromIds, toIds, dateStr, startSec, {
      minTransferSec: minTrans,
      maxTransferSec: maxTrans,
      maxResults:     limit,
      viaIds,
    });

    console.log(`  → ${journeys.length} correspondances | ${Date.now()-t0}ms`);
    return jsonResp(res, { journeys, computed_ms: Date.now()-t0 });
  }

  // ── /api/explore ──
  if (p === '/api/explore') {
    const t0      = Date.now();
    const fromIds = (q.from || '').split(',').filter(Boolean);
    const dateStr = (q.date || '').trim();

    if (!fromIds.length) return jsonResp(res, { error: 'Paramètre from requis' }, 400);

    console.log('\n[EXPLORE TGVmax]', dateStr || 'sans date', '| from:', fromIds.join(','));

    const destinations = exploreDestinations(fromIds, dateStr);

    // Convertir au format attendu par explorermax.js buildDestinations() :
    // inclure dep_str/arr_str à la racine ET dans les legs pour le popup
    const journeys = destinations.map(d => {
      const bestJ = d.journeys?.[0];
      const legs  = bestJ?.legs || [{
        from_id:   d.from_id || '',
        to_id:     d.dest_id,
        from_name: d.from_name || '',
        to_name:   d.dest_name,
        dep_time:  d.dep_time,
        arr_time:  d.arr_time,
        dep_str:   d.dep_str,
        arr_str:   d.arr_str,
        operator:  'TGVMAX',
        train_type:'INOUI',
        duration:  d.duration,
      }];
      return {
        dep_time:    d.dep_time,
        arr_time:    d.arr_time,
        dep_str:     d.dep_str,
        arr_str:     d.arr_str,
        duration:    d.duration,
        transfers:   d.transfers,
        dest_lat:    d.dest_lat,
        dest_lon:    d.dest_lon,
        train_types: ['TGVMAX'],
        legs,
      };
    });

    console.log(`  → ${journeys.length} destinations (${destinations.filter(d=>d.transfers>0).length} avec corresp.) | ${Date.now()-t0}ms`);
    return jsonResp(res, { journeys, computed_ms: Date.now()-t0 });
  }

  // ── /api/debug/trips ──
  if (p === '/api/debug/trips') {
    const stopId  = q.stop  || '';
    const dateISO = q.date  || '';
    const trainNo = q.train || '';

    if (trainNo) {
      const found = Object.values(trips).filter(t => t.train_no === trainNo);
      return jsonResp(res, { train_no: trainNo, trips: found });
    }

    if (stopId) {
      const tripIds = (routesByStop[stopId] || []);
      const filtered = dateISO
        ? tripIds.filter(id => trips[id]?.date === dateISO)
        : tripIds;
      const out = filtered
        .map(id => trips[id])
        .filter(Boolean)
        .sort((a, b) => (a.dep_time||0) - (b.dep_time||0))
        .map(t => ({
          trip_id:  t.trip_id,
          train_no: t.train_no,
          date:     t.date,
          from:     resolveStopName(t.origin_id),
          to:       resolveStopName(t.dest_id),
          dep:      t.dep_str || secondsToHHMM(t.dep_time),
          arr:      t.arr_str || secondsToHHMM(t.arr_time),
          dispo:    t.dispo,
        }));
      return jsonResp(res, { stop: stopId, stop_name: resolveStopName(stopId), date: dateISO||'tous', departures: out });
    }

    return jsonResp(res, { error: 'Param stop= ou train= requis. Ex: /api/debug/trips?stop=TGVMAX:paris&date=2026-03-15' }, 400);
  }

  // ── Fichiers statiques ──
  const staticMap = { '/':'index.html', '/index.html':'index.html', '/trajets.html':'trajets.html' };
  if (staticMap[p]) return serveFile(res, path.join(__dirname, staticMap[p]));

  const assetPath = path.join(__dirname, p);
  if (fs.existsSync(assetPath) && fs.statSync(assetPath).isFile()) return serveFile(res, assetPath);

  res.writeHead(404); res.end('Not found');
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