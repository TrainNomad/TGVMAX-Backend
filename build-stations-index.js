/**
 * build-stations-index.js
 * Construit un stations.json unique et dédoublonné basé STRICTEMENT sur le CSV.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const matcher = require('./stations-matcher');

const DATA_DIR   = process.argv[2] || './engine_data';
const OUT_FILE   = process.argv[3] || path.join(__dirname, 'stations.json');
const CSV_FILE   = process.argv[4] || path.join(__dirname, 'stations.csv');
const STOPS_FILE = path.join(DATA_DIR, 'stops.json'); // Fichier contenant les stops extraits de l'API

// 1. Initialiser le matcher avec le CSV
matcher.load(CSV_FILE);

if (!fs.existsSync(STOPS_FILE)) {
  console.error("❌ Le fichier des arrêts de l'API (stops.json) n'existe pas encore. Lancez l'ingestion d'abord.");
  process.exit(1);
}

const apiStops = JSON.parse(fs.readFileSync(STOPS_FILE, 'utf8'));

// Utilisation d'un Map pour garantir l'unicité stricte par code UIC
const uniqueStations = new Map();

Object.keys(apiStops).forEach(sncfId => {
  // apiStops contient les clés correspondant aux origine_iata / destination_iata de la SNCF
  const csvMatch = matcher.matchBySncfId(sncfId);

  if (csvMatch && csvMatch.uic) {
    const uicKey = csvMatch.uic;

    // Si la gare n'est pas encore enregistrée, on l'ajoute (évite les répétitions)
    if (!uniqueStations.has(uicKey)) {
      uniqueStations.set(uicKey, {
        id: uicKey, // L'identifiant bien défini devient l'UIC (colonne D)
        name: csvMatch.name,
        lat: csvMatch.lat,
        lon: csvMatch.lon,
        sncf_id: sncfId // Optionnel : garde une trace du code API d'origine
      });
    }
  } else {
    console.warn(`[Ignore] Aucune correspondance stricte dans le CSV pour le code SNCF: ${sncfId}`);
  }
});

// Conversion du Map en tableau pour l'écriture finale
const stationsResult = Array.from(uniqueStations.values());

fs.writeFileSync(OUT_FILE, JSON.stringify(stationsResult, null, 2), 'utf8');
console.log(`\n✅ stations.json généré avec succès : ${stationsResult.length} gares uniques (Indexées par UIC).`);