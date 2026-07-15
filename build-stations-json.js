'use strict';

/**
 * 🏢 GÉNÉRATEUR D'INDEX DES GARES
 * Crée stations.json pour le frontend : UIC → {name, lat, lon, sncf_id}
 * 
 * Récupère :
 * 1. Tous les UIC uniques des trajets dans trips.bin
 * 2. Les détails (nom, coordonnées, IATA) depuis stations.csv
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'engine_data');
const CSV_FILE = path.join(__dirname, 'stations.csv');
const TRIPS_BIN = path.join(DATA_DIR, 'trips.bin');
const OUT_FILE = path.join(__dirname, 'stations.json');

/**
 * Parse le CSV stations.csv
 * Format attendu: délimiteur ';'
 * Colonnes: uic, name, sncf_id (IATA), latitude, longitude, ...
 */
function parseStationsCSV(csvPath) {
  console.log('⏳ Parsing stations.csv...');

  if (!fs.existsSync(csvPath)) {
    throw new Error(`stations.csv introuvable: ${csvPath}`);
  }

  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split('\n');
  const headerLine = lines[0];
  const headers = headerLine.split(';');

  // Trouver les indices des colonnes
  const idxUic = headers.indexOf('uic');
  const idxName = headers.indexOf('name');
  const idxLat = headers.indexOf('latitude');
  const idxLon = headers.indexOf('longitude');
  const idxSncfId = headers.indexOf('sncf_id');

  if (idxUic === -1) {
    throw new Error('Colonne "uic" manquante dans le CSV');
  }

  const stationsMap = new Map(); // uic (string) → {name, lat, lon, sncf_id}

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(';');
    const uic = cols[idxUic];
    const name = cols[idxName] || '';
    const lat = parseFloat(cols[idxLat]) || 0;
    const lon = parseFloat(cols[idxLon]) || 0;
    const sncfId = cols[idxSncfId] || '';

    if (uic) {
      stationsMap.set(uic, {
        name,
        lat,
        lon,
        sncf_id: sncfId
      });
    }
  }

  console.log(`✅ ${stationsMap.size} gares chargées du CSV\n`);
  return stationsMap;
}

/**
 * Extrait les UIC uniques du fichier trips.bin
 * Format binaire: 12 bytes par trajet (UIC_DEP + UIC_ARR + TIMESTAMP)
 */
function extractUniqueUicsFromBinary(binPath) {
  console.log('⏳ Extraction des UIC uniques de trips.bin...');

  if (!fs.existsSync(binPath)) {
    throw new Error(`trips.bin introuvable: ${binPath}`);
  }

  const buffer = fs.readFileSync(binPath);
  const tripCount = Math.floor(buffer.length / 12);
  const uicSet = new Set();

  for (let i = 0; i < tripCount; i++) {
    const offset = i * 12;

    // Lire les UIC en Big-Endian (match avec encode-binary.js)
    const uicDep = buffer.readUInt32BE(offset);
    const uicArr = buffer.readUInt32BE(offset + 4);

    uicSet.add(uicDep);
    uicSet.add(uicArr);
  }

  console.log(`✅ ${uicSet.size} UIC uniques trouvés\n`);
  return uicSet;
}

/**
 * Main
 */
function main() {
  try {
    // 1. Parser le CSV
    const stationsMap = parseStationsCSV(CSV_FILE);

    // 2. Extraire les UIC du fichier binaire
    const uicSet = extractUniqueUicsFromBinary(TRIPS_BIN);

    // 3. Construire l'index stations.json
    console.log('⏳ Génération de stations.json...');
    const stationsIndex = {};

    for (const uic of uicSet) {
      const station = stationsMap.get(uic.toString());

      if (station) {
        stationsIndex[uic] = {
          name: station.name,
          lat: station.lat,
          lon: station.lon,
          sncf_id: station.sncf_id
        };
      } else {
        // UIC trouvé dans les trajets mais pas dans le CSV
        // Créer une entrée minimale pour le frontend
        stationsIndex[uic] = {
          name: `Station ${uic}`,
          lat: 0,
          lon: 0,
          sncf_id: ''
        };
      }
    }

    // 4. Écrire le fichier JSON
    fs.writeFileSync(OUT_FILE, JSON.stringify(stationsIndex, null, 2), 'utf8');

    const fileSize = fs.statSync(OUT_FILE).size;
    console.log(`✅ stations.json créé : ${OUT_FILE}`);
    console.log(`   Gares : ${Object.keys(stationsIndex).length}`);
    console.log(`   Taille : ${(fileSize / 1024).toFixed(2)} Ko\n`);

    console.log('✨ Index des gares généré avec succès !');

  } catch (error) {
    console.error(`❌ Erreur: ${error.message}`);
    process.exit(1);
  }
}

main();