/**
 * build-stations-index.js
 *
 * Génère stations.json à partir des gares TGVmax (engine_data/stops.json).
 * Regroupe par ville, enrichit les coordonnées GPS depuis stations.csv.
 *
 * Chaque entrée :
 *   { id, name, city, country, stopIds[], operators[], lat, lon }
 *
 * L'id est de la forme "FR:paris", "FR:lyon", etc. (stable, utilisable sur une carte)
 *
 * Usage :
 *   node build-stations-index.js
 *   node build-stations-index.js ./engine_data ./stations.json ./stations.csv
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR   = process.argv[2] || './engine_data';
const OUT_FILE   = process.argv[3] || path.join(__dirname, 'stations.json');
const CSV_FILE   = process.argv[4] || path.join(__dirname, 'stations.csv');
const STOPS_FILE = path.join(DATA_DIR, 'stops.json');

// ─── Normalisation ────────────────────────────────────────────────────────────

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toId(cityName) {
  return 'FR:' + normalize(cityName).replace(/\s+/g, '-');
}

function toTitleCase(str) {
  const LOWER = new Set(['de','du','des','et','en','sur','sous','les','la','le']);
  return str.toLowerCase().split(/\s+/).map((w, i) =>
    (i > 0 && LOWER.has(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1)
  ).join(' ');
}

// ─── Chargement du CSV → lookup coordonnées par nom normalisé ─────────────────

function loadCsvCoords(csvPath) {
  if (!fs.existsSync(csvPath)) {
    console.warn('  ⚠️  stations.csv introuvable — coordonnées depuis stops.json uniquement');
    return {};
  }

  const raw    = fs.readFileSync(csvPath, 'utf8');
  const lines  = raw.split('\n');
  const header = lines[0].split(';');
  const idx    = {};
  header.forEach((h, i) => { idx[h.trim()] = i; });

  const lookup = {};  // normalized_name → { lat, lon }

  for (let i = 1; i < lines.length; i++) {
    const cols    = lines[i].split(';');
    const country = (cols[idx['country']] || '').trim();
    if (country !== 'FR') continue;

    const name = (cols[idx['name']] || '').trim();
    const lat  = parseFloat(cols[idx['latitude']])  || 0;
    const lon  = parseFloat(cols[idx['longitude']]) || 0;
    if (!name || !lat) continue;

    const key = normalize(name);
    if (!lookup[key]) lookup[key] = { lat, lon };
  }

  return lookup;
}

/**
 * Cherche les coordonnées dans le CSV pour une ville donnée.
 * Stratégie : exact → préfixe → suffixe → null.
 */
function coordsFromCsv(csvLookup, cityNorm) {
  // Variantes saint ↔ st
  const variants = [cityNorm];
  if (cityNorm.startsWith('saint ')) variants.push('st ' + cityNorm.slice(6));
  if (cityNorm.startsWith('st '))    variants.push('saint ' + cityNorm.slice(3));

  for (const v of variants) {
    // 1. Exact
    if (csvLookup[v]) return csvLookup[v];
    // 2. Le CSV a un nom plus long (ex: "bordeaux st jean" pour "bordeaux")
    for (const [key, val] of Object.entries(csvLookup)) {
      if (key.startsWith(v + ' ') || key.startsWith(v + '-')) return val;
    }
    // 3. La ville commence par le nom CSV (ex: "saint etienne chateaucreux" → "saint etienne")
    for (const [key, val] of Object.entries(csvLookup)) {
      if (v.startsWith(key + ' ') || v.startsWith(key + '-')) return val;
    }
  }
  return null;
}

// ─── Table des villes connues (regroupement TGVmax) ────────────────────────────
// Les villes composées doivent être listées AVANT les villes simples.

const KNOWN_CITIES = [
  'saint pierre des corps','saint jean de luz ciboure','aix en provence tgv',
  'aix en provence','la roche sur yon','saint raphael valescure',
  'saint jean pied de port','saint gervais les bains','clermont ferrand',
  'le puy en velay','chalon sur saone','macon loche','macon ville',
  'bourg en bresse','chambery challes les eaux','saint exupery tgv',
  'lyon saint exupery tgv','angers saint laud','le creusot montceau montchanin',
  'le creusot tgv','vendome villiers','massy tgv','marne la vallee chessy',
  'roissy charles de gaulle','charles de gaulle etoile','le havre','le mans',
  'les arcs draguignan','les aubrais orleans','la rochelle ville',
  'la rochelle','la baule escoublac','la souterraine',
  // Saint-Etienne : le nom court EN PREMIER pour grouper toutes les gares sous la ville
  'saint etienne',
  'saint brieuc','saint malo','saint nazaire','saint omer','saint quentin',
  'saint gilles croix de vie','saint jean de luz','saint pierre','saintes',
  'la teste','la ciotat','la seyne','le teil','les herbiers',
  'les sables d olonne',
  // Grandes villes
  'paris','lyon','marseille','bordeaux','toulouse','nantes','lille',
  'strasbourg','rennes','nice','montpellier','grenoble','toulon','nimes',
  'dijon','reims','rouen','nancy','metz','avignon','perpignan','poitiers',
  'limoges','lorient','brest','caen','mulhouse','vannes','quimper','tours',
  'valence','angouleme','bayonne','pau','tarbes','agen','perigueux','brive',
  'aurillac','rodez','albi','cahors','auch','foix','carcassonne','beziers',
  'narbonne','sete','ales','orange','arles','cannes','antibes','menton',
  'draguignan','hendaye','biarritz','dax','arcachon','libourne','bergerac',
  'cognac','rochefort','niort','cholet','angers','saumur','amboise','chatellerault',
  'laval','blois','vendome','chartres','evreux','carentan','granville',
  'avranches','redon','quimperle','morlaix','guingamp','lannion','lamballe',
  'dinan','fougeres','vitre','alencon','abbeville','amiens','arras','lens',
  'douai','valenciennes','maubeuge','laon','soissons','compiegne','creil',
  'versailles','auxerre','bourges','montargis','mantes','lourdes',
].sort((a, b) => b.length - a.length);

// ─── Extraction du nom de ville depuis le nom TGVmax ──────────────────────────

function extractDisplayCity(rawName) {
  let cleaned = rawName
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/-/g, ' ')
    .trim();

  const normCleaned = normalize(cleaned);

  for (const cityNorm of KNOWN_CITIES) {
    if (normCleaned === cityNorm || normCleaned.startsWith(cityNorm + ' ')) {
      return toTitleCase(cityNorm);
    }
  }

  // Fallback : couper aux qualificatifs de gare
  const QUALIFIERS = new Set(['tgv','ouigo','ville','centre','gare','central','centrale','1','2','3','et']);
  const words = normCleaned.split(' ');
  const cityWords = [];
  for (const w of words) {
    if (QUALIFIERS.has(w)) break;
    if (/^\d+$/.test(w) && cityWords.length > 0) break;
    cityWords.push(w);
  }
  if (!cityWords.length) cityWords.push(words[0]);
  return toTitleCase(cityWords.join(' '));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('\n🔨 Construction stations.json...\n');

if (!fs.existsSync(STOPS_FILE)) {
  console.error('❌ ' + STOPS_FILE + ' introuvable. Lance d\'abord : node tgvmax-ingest.js');
  process.exit(1);
}

const stops     = JSON.parse(fs.readFileSync(STOPS_FILE, 'utf8'));
const csvLookup = loadCsvCoords(CSV_FILE);
console.log('  stops.json  : ' + Object.keys(stops).length + ' arrêts TGVmax');
console.log('  stations.csv: ' + Object.keys(csvLookup).length + ' entrées coordonnées\n');

// ─── Regroupement par ville ───────────────────────────────────────────────────

const cityGroups = new Map();  // cityId → { displayCity, stopIds[], lat, lon }

for (const [stopId, stop] of Object.entries(stops)) {
  const displayCity = extractDisplayCity(stop.name || '');
  const cityId      = toId(displayCity);
  const cityNorm    = normalize(displayCity);

  if (!cityGroups.has(cityId)) {
    // Chercher les coords dans le CSV en priorité
    const csvCoords = coordsFromCsv(csvLookup, cityNorm);
    cityGroups.set(cityId, {
      displayCity,
      cityId,
      stopIds: [stopId],
      lat: csvCoords?.lat || stop.lat || 0,
      lon: csvCoords?.lon || stop.lon || 0,
      fromCsv: !!csvCoords,
    });
  } else {
    const g = cityGroups.get(cityId);
    if (!g.stopIds.includes(stopId)) g.stopIds.push(stopId);
    // Améliorer les coords si on n'en avait pas
    if (!g.lat && stop.lat) { g.lat = stop.lat; g.lon = stop.lon; }
  }
}

// ─── Construction du tableau final ───────────────────────────────────────────

const stations = [];
for (const [, g] of cityGroups) {
  stations.push({
    id:        g.cityId,
    name:      g.displayCity,
    city:      g.displayCity,
    country:   'FR',
    stopIds:   g.stopIds,
    operators: ['TGVMAX'],
    lat:       g.lat,
    lon:       g.lon,
  });
}

// Tri : villes avec le plus de gares en premier, puis alphabétique
stations.sort((a, b) => {
  if (b.stopIds.length !== a.stopIds.length) return b.stopIds.length - a.stopIds.length;
  return a.name.localeCompare(b.name, 'fr');
});

// ─── Écriture ─────────────────────────────────────────────────────────────────

fs.writeFileSync(OUT_FILE, JSON.stringify(stations, null, 2), 'utf8');
const sizeKb = Math.round(fs.statSync(OUT_FILE).size / 1024);

const withCsvCoords = [...cityGroups.values()].filter(g => g.fromCsv).length;
console.log('  ✅ ' + withCsvCoords + '/' + stations.length + ' villes avec coords CSV');
console.log('\n✅ stations.json : ' + stations.length + ' villes — ' + sizeKb + ' KB');

// ─── Diagnostic ───────────────────────────────────────────────────────────────
console.log('\n── Diagnostic villes clés ────────────────────────────────────────');
const CHECK = [
  'Paris','Lyon','Marseille','Bordeaux','Nantes','Toulouse','Lille',
  'Strasbourg','Rennes','Nice','Montpellier','Saint Etienne',
  'Saint Pierre Des Corps','La Rochelle','Le Mans','Le Havre',
  'Aix En Provence','Clermont Ferrand','Angers Saint Laud','Massy Tgv',
];
const byId = new Map(stations.map(s => [s.id, s]));
for (const city of CHECK) {
  const id = toId(city);
  const s  = byId.get(id);
  if (s) {
    const coords = s.lat ? `${s.lat.toFixed(3)}, ${s.lon.toFixed(3)}` : 'sans coords';
    console.log('  ✅ ' + city.padEnd(28) + ' ' + s.stopIds.length + ' stop(s)  ' + coords);
  } else {
    console.log('  ❌ ' + city.padEnd(28) + ' [' + id + ']');
  }
}

const noCoords = stations.filter(s => !s.lat);
if (noCoords.length) {
  console.log('\n  ⚠️  ' + noCoords.length + ' villes sans coordonnées GPS :');
  noCoords.slice(0, 10).forEach(s => console.log('     - ' + s.name + ' (' + s.id + ')'));
}

console.log('\n→ Lancez ensuite : node server.js\n');