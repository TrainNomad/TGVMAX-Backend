/**
 * stations-matcher.js
 *
 * Mappe les identifiants SNCF de l'API (origine_iata / destination_iata)
 * vers les données réelles et géographiques de stations.csv.
 *
 * Chaque entrée retournée a la forme :
 * { uic: "87391003", name: "Paris Montparnasse", lat: 48.84, lon: 2.32 }
 */

'use strict';

const fs = require('fs');

// Registre interne indexé par sncf_id (ex: "FRPMP" -> { uic, name, lat, lon })
let _registry = null;
let _loaded   = false;

/**
 * Charge le fichier stations.csv et remplit l'index par sncf_id
 * @param {string} csvPath
 */
function load(csvPath) {
  if (_loaded) return;

  if (!fs.existsSync(csvPath)) {
    throw new Error(`[stations-matcher] Le fichier CSV est introuvable à l'emplacement : ${csvPath}`);
  }

  const raw = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split('\n');
  
  // Extraction dynamique des index de colonnes via l'en-tête
  const header = lines[0].split(';');
  const idx = {};
  for (let i = 0; i < header.length; i++) {
    idx[header[i].trim()] = i;
  }

  const COL = {
    uic:      idx['uic'],          // Colonne D (UIC final)
    name:     idx['name'],         // Colonne B (Nom propre)
    lat:      idx['latitude'],     // Colonne F (Latitude)
    lon:      idx['longitude'],    // Colonne G (Longitude)
    sncf_id:  idx['sncf_id']       // Colonne R (Correspond à origine_iata/destination_iata)
  };

  _registry = new Map();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const cols = line.split(';');
    
    const sncfId = cols[COL.sncf_id] ? cols[COL.sncf_id].trim() : null;
    const uic    = cols[COL.uic] ? cols[COL.uic].trim() : null;
    const name   = cols[COL.name] ? cols[COL.name].trim() : null;
    const lat    = cols[COL.lat] ? parseFloat(cols[COL.lat]) : null;
    const lon    = cols[COL.lon] ? parseFloat(cols[COL.lon]) : null;

    // On n'enregistre la gare que si elle possède un sncf_id et un UIC valide
    if (sncfId && uic) {
      _registry.set(sncfId, { uic, name, lat, lon });
    }
  }

  console.log(`[stations-matcher] Chargé — ${_registry.size} gares SNCF indexées par sncf_id.`);
  _loaded = true;
}

/**
 * Cherche une gare dans le CSV en utilisant le sncf_id (origine_iata ou destination_iata)
 *
 * @param  {string} sncfId  Ex: "FRPMP"
 * @returns {{ uic: string, name: string, lat: number, lon: number } | null}
 */
function matchBySncfId(sncfId) {
  if (!_loaded) {
    throw new Error("[stations-matcher] Le matcher doit être chargé avec load() avant de faire une recherche.");
  }
  if (!sncfId) return null;
  return _registry.get(sncfId.trim()) || null;
}

module.exports = {
  load,
  matchBySncfId,
  match: matchBySncfId 
};