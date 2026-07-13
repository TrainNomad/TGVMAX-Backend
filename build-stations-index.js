'use strict';

const fs   = require('fs');
const path = require('path');
const matcher = require('./stations-matcher');

const DATA_DIR   = process.argv[2] || './engine_data';
const OUT_FILE   = process.argv[3] || path.join(__dirname, 'stations.json');
const CSV_FILE   = process.argv[4] || path.join(__dirname, 'stations.csv');
const STOPS_FILE = path.join(DATA_DIR, 'stops.json');

// 1. Initialisation du matcher qui lit le fichier stations.csv
matcher.load(CSV_FILE);

if (!fs.existsSync(STOPS_FILE)) {
  console.error(`❌ Fichier introuvable : ${STOPS_FILE}. Veuillez lancer l'ingestion d'abord.`);
  process.exit(1);
}

const stops = JSON.parse(fs.readFileSync(STOPS_FILE, 'utf8'));
const stationsMap = new Map();

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

console.log('⏳ Génération du fichier stations.json basé sur les codes IATA...');

// 2. Traitement de chaque gare présente dans le moteur RAPTOR (stops.json)
for (const [stopId, stop] of Object.entries(stops)) {
  const rawName = stop.name; // Ex: "PARIS-MONTPARNASSE 1 ET 2" ou "PARIS GARE DE LYON"
  
  // Utilise votre matcher existant pour trouver l'entrée IATA correspondante dans le CSV
  const matched = matcher.match(rawName);
  
  let finalId, finalName, finalLat, finalLon, finalCity;
  
  if (matched) {
    // Si la gare est trouvée dans le CSV via son IATA (ex: id = "FRPMP")
    // On convertit "FRPMP" en un id propre et lisible "FR:pmp"
    finalId   = 'FR:' + matched.id.replace(/^FR/i, '').toLowerCase(); 
    finalName = matched.name; // Prend le vrai nom propre du CSV (ex: "Paris Montparnasse")
    finalLat  = matched.lat;  // Latitude exacte du CSV
    finalLon  = matched.lon;  // Longitude exacte du CSV
    finalCity = matched.name; // On force la ville à être la gare elle-même pour différencier Paris
  } else {
    // Rétrocompatibilité (Fallback) si une gare RAPTOR n'est pas trouvée dans le CSV
    finalId   = 'FR:' + normalize(rawName).replace(/\s+/g, '-');
    finalName = rawName;
    finalLat  = stop.lat || 0;
    finalLon  = stop.lon || 0;
    finalCity = stop.city || rawName;
  }

  // 3. Regroupement intelligent par code IATA unique
  if (!stationsMap.has(finalId)) {
    stationsMap.set(finalId, {
      id: finalId,               // ex: "FR:ply"
      name: finalName,           // ex: "Paris Gare de Lyon"
      city: finalCity,           // ex: "Paris Gare de Lyon" -> Fini le regroupement global
      country: 'FR',
      stopIds: [stopId],         // On lie l'identifiant court du moteur RAPTOR
      operators: ['TGVMAX'],
      lat: finalLat,
      lon: finalLon
    });
  } else {
    // Si plusieurs entités RAPTOR pointent vers le même code IATA, on fusionne leurs stopIds
    const existing = stationsMap.get(finalId);
    if (!existing.stopIds.includes(stopId)) {
      existing.stopIds.push(stopId);
    }
  }
}

const stations = Array.from(stationsMap.values());

// 4. Écriture finale dans stations.json
fs.writeFileSync(OUT_FILE, JSON.stringify(stations, null, 2), 'utf8');

console.log(`\n✅ stations.json généré avec succès !`);
console.log(`  Total de gares uniques différenciées : ${stations.length}`);