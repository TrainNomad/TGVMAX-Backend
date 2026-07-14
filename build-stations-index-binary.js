/**
 * build-stations-index-binary.js
 * ÉTAPE 3 : Génère stations.json indexé par l'UIC pour les gares actives détectées.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = './engine_data';
const STOPS_TEMP_FILE = path.join(DATA_DIR, 'stops_temp.json');
const OUT_FILE = path.join(__dirname, 'stations.json');

console.log('🏁 Début de la construction de stations.json...');

if (!fs.existsSync(STOPS_TEMP_FILE)) {
  console.error("❌ Le fichier temporaire des gares n'existe pas. Lancez d'abord ingest-and-encode.js.");
  process.exit(1);
}

const activeStops = JSON.parse(fs.readFileSync(STOPS_TEMP_FILE, 'utf8'));
const uicKeys = Object.keys(activeStops);

const stationsIndex = {};

uicKeys.forEach(uic => {
  const data = activeStops[uic];
  stationsIndex[uic] = {
    name: data.name,
    lat: data.lat,
    lon: data.lon
  };
});

// Écriture finale de stations.json
fs.writeFileSync(OUT_FILE, JSON.stringify(stationsIndex, null, 2), 'utf8');

// Nettoyage du fichier temporaire
fs.unlinkSync(STOPS_TEMP_FILE);

console.log(`✅ Fichier stations.json généré avec succès (${uicKeys.length} gares uniques enregistrées par UIC).`);