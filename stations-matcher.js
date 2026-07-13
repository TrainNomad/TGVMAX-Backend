/**
 * stations-matcher.js
 * Mappe strictement les identifiants SNCF de l'API vers les données du CSV de Trainline.
 */

'use strict';

const fs = require('fs');

// Dictionnaire de correspondance : sncf_id -> Données CSV
const _registry = new Map();

/**
 * Charge le fichier stations.csv et remplit le registre.
 * Séparateur : ';'
 */
function load(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Le fichier CSV est introuvable à l'emplacement : ${csvPath}`);
  }

  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split('\n');

  // On ignore la première ligne (en-tête)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Découpage par point-virgule
    const columns = line.split(';');

    const uic = columns[3];       // Colonne D : uic
    const name = columns[1];      // Colonne B : name
    const lat = columns[5];       // Colonne F : latitude
    const lon = columns[6];       // Colonne G : longitude
    const sncfId = columns[17];   // Colonne R : sncf_id

    // On n'enregistre que si la ligne possède un sncf_id et un UIC valides
    if (sncfId && uic) {
      _registry.set(sncfId.trim(), {
        uic: uic.trim(),
        name: name.trim(),
        lat: lat ? parseFloat(lat) : null,
        lon: lon ? parseFloat(lon) : null
      });
    }
  }
  console.log(`[Matcher] ${_registry.size} gares chargées depuis le CSV.`);
}

/**
 * Trouve une gare exclusivement par son sncf_id
 */
function matchBySncfId(sncfId) {
  if (!sncfId) return null;
  return _registry.get(sncfId.trim()) || null;
}

module.exports = {
  load,
  matchBySncfId
};