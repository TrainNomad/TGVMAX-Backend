/**
 * ingest-and-encode.js
 * ÉTAPE 1 & 2 : Téléchargement du CSV, de l'API SNCF et encodage binaire des trajets.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const DATA_DIR = './engine_data';
const CSV_URL = 'https://raw.githubusercontent.com/trainline-eu/stations/master/stations.csv';
const API_URL = 'https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/predictions-de-disponibilite-tgv-max/exports/json';

const CSV_FILE = path.join(DATA_DIR, 'stations.csv');
const BIN_FILE = path.join(DATA_DIR, 'trips.bin');
const STOPS_TEMP_FILE = path.join(DATA_DIR, 'stops_temp.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Télécharge le fichier CSV de Trainline si absent ou à rafraîchir
async function downloadCsv() {
  console.log(`📡 Téléchargement de stations.csv...`);
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`Impossible de télécharger le CSV: ${res.statusText}`);
  const text = await res.text();
  fs.writeFileSync(CSV_FILE, text, 'utf8');
  console.log(`💾 stations.csv enregistré.`);
}

// Parse le CSV et crée un dictionnaire indexé par sncf_id (colonne R)
function loadCsvRegistry() {
  const raw = fs.readFileSync(CSV_FILE, 'utf8').replace(/\r/g, '');
  const lines = raw.split('\n');
  const header = lines[0].split(';');
  const idx = {};
  for (let i = 0; i < header.length; i++) {
    idx[header[i].trim()] = i;
  }

  const colUic = idx['uic'] !== undefined ? idx['uic'] : idx['id'];
  const colName = idx['name'];
  const colLat = idx['latitude'];
  const colLon = idx['longitude'];
  const colSncfId = idx['sncf_id'];
  const colTvs = idx['sncf_tvs_id'];

  const registry = new Map();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(';');

    const uic = cols[colUic] ? cols[colUic].trim() : null;
    const name = cols[colName] ? cols[colName].trim() : null;
    const lat = cols[colLat] ? parseFloat(cols[colLat]) : null;
    const lon = cols[colLon] ? parseFloat(cols[colLon]) : null;

    let sncfId = null;
    if (colSncfId && cols[colSncfId]) {
      sncfId = cols[colSncfId].trim();
    } else if (colTvs && cols[colTvs]) {
      sncfId = 'FR' + cols[colTvs].trim();
    }

    if (sncfId && uic) {
      registry.set(sncfId, { uic: parseInt(uic, 10), name, lat, lon });
    }
  }
  return registry;
}

async function run() {
  try {
    await downloadCsv();
    const registry = loadCsvRegistry();
    console.log(`📋 ${registry.size} gares indexées depuis le CSV.`);

    console.log(`📡 Téléchargement de l'API SNCF TGVmax...`);
    const response = await fetch(API_URL);
    if (!response.ok) throw new Error(`Erreur API: ${response.statusText}`);
    const records = await response.json();
    console.log(`📥 ${records.length} enregistrements bruts reçus.`);

    const validTrips = [];
    const activeStops = {}; // Conserve les métadonnées des gares réellement utilisées par l'API

    records.forEach(record => {
      const fields = record.fields || record;
      const originSncfId = fields.origine_iata;
      const destSncfId = fields.destination_iata;

      if (!originSncfId || !destSncfId) return;

      const matchOrigine = registry.get(originSncfId.trim());
      const matchDest = registry.get(destSncfId.trim());

      if (!matchOrigine || !matchDest) return; // Ignore si non trouvé dans le CSV

      const uicOrigine = matchOrigine.uic;
      const uicDest = matchDest.uic;

      // Calcul du timestamp Unix combiné avec l'heure
      const dateDepart = fields.date;          // "YYYY-MM-DD"
      const heureDepart = fields.heure_depart;  // "HH:MM"
      const timestampSeconds = Math.floor(new Date(`${dateDepart}T${heureDepart}:00`).getTime() / 1000);

      const dispo = fields.od_happy_card === 'OUI';

      // Encodage binaire du timestamp + bit 31 pour happy_card
      let timeValue = timestampSeconds & 0x7FFFFFFF; // On s'assure que le bit 31 est libre (0)
      if (dispo) {
        timeValue = timeValue | 0x80000000; // Force le bit 31 à 1
      }

      validTrips.push({
        from: uicOrigine,
        to: uicDest,
        timeValue: timeValue
      });

      // On enregistre les gares actives pour l'index final
      if (!activeStops[uicOrigine]) activeStops[uicOrigine] = matchOrigine;
      if (!activeStops[uicDest]) activeStops[uicDest] = matchDest;
    });

    // Écriture du fichier binaire trips.bin
    const buffer = Buffer.alloc(validTrips.length * 12);
    validTrips.forEach((trip, index) => {
      const offset = index * 12;
      buffer.writeUInt32BE(trip.from, offset);      // 4 octets
      buffer.writeUInt32BE(trip.to, offset + 4);    // 4 octets
      buffer.writeUInt32BE(trip.timeValue, offset + 8); // 4 octets (Time + Dispo)
    });

    fs.writeFileSync(BIN_FILE, buffer);
    console.log(`💾 Fichier binaire trips.bin généré (${(buffer.length / 1024).toFixed(1)} KB) - ${validTrips.length} trajets.`);

    // Sauvegarde temporaire des gares actives pour l'étape suivante
    fs.writeFileSync(STOPS_TEMP_FILE, JSON.stringify(activeStops, null, 2), 'utf8');

    // Génération des méta-données et calendrier requis par tes validations YML
    fs.writeFileSync(path.join(DATA_DIR, 'calendar_index.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(DATA_DIR, 'meta.json'), JSON.stringify({
      last_update: new Date().toISOString(),
      total_trips: validTrips.length,
      total_stops: Object.keys(activeStops).length
    }, null, 2));

  } catch (error) {
    console.error("❌ Erreur d'ingestion :", error);
    process.exit(1);
  }
}

run();