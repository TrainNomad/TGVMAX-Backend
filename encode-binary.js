'use strict';

/**
 * 🚀 ENCODEUR BINAIRE
 * Convertit trips.json (produit par tgvmax-ingest.js) → trips.bin + trip_meta.json
 * 
 * Format binaire : 12 octets par trajet
 * - Bytes 0-3   : UIC gare de départ (UInt32BE)
 * - Bytes 4-7   : UIC gare d'arrivée (UInt32BE)
 * - Bytes 8-11  : Timestamp UNIX 31 bits + bit de poids fort = Happy Card
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'engine_data');
const TRIPS_JSON = path.join(DATA_DIR, 'trips.json');
const TRIPS_BIN = path.join(DATA_DIR, 'trips.bin');
const TRIP_META = path.join(DATA_DIR, 'trip_meta.json');

function encodeToBinary() {
  console.log('⏳ Début de l\'encodage binaire trips.json → trips.bin...\n');

  // 1. Vérifier que trips.json existe
  if (!fs.existsSync(TRIPS_JSON)) {
    console.error(`❌ Fichier trips.json introuvable : ${TRIPS_JSON}`);
    console.error('   (Avez-vous lancé npm run build/ingest d\'abord ?)');
    process.exit(1);
  }

  // 2. Parser trips.json
  let trips;
  try {
    const rawData = fs.readFileSync(TRIPS_JSON, 'utf8');
    trips = JSON.parse(rawData);
    console.log(`✅ trips.json parsé : ${Object.keys(trips).length} trajets trouvés\n`);
  } catch (e) {
    console.error(`❌ Erreur parsing trips.json: ${e.message}`);
    process.exit(1);
  }

  // 3. Préparer l'encodage
  const tripIds = Object.keys(trips);
  const totalTrips = tripIds.length;
  const buffer = Buffer.alloc(totalTrips * 12);
  const tripMetadata = {};

  console.log('⏳ Encodage en cours...');
  let encoded = 0;
  let skipped = 0;

  for (let i = 0; i < totalTrips; i++) {
    const tripId = tripIds[i];
    const trip = trips[tripId];

    // Extraire les UIC (accepter string ou number)
    const originUic = parseInt(trip.origin_id, 10) || 0;
    const destUic = parseInt(trip.dest_id, 10) || 0;

    // Valider les données
    if (!originUic || !destUic || !trip.date || !trip.time) {
      skipped++;
      continue;
    }

    // Construire le timestamp UNIX
    // trip.date: "2026-07-20", trip.time: "18:05"
    let timestamp = 0;
    try {
      const [year, month, day] = trip.date.split('-').map(Number);
      const [hour, minute] = trip.time.split(':').map(Number);
      const dateObj = new Date(year, month - 1, day, hour, minute, 0);
      timestamp = Math.floor(dateObj.getTime() / 1000);
    } catch (e) {
      skipped++;
      continue;
    }

    // Masquer le bit de poids fort pour le timestamp (31 bits)
    let timeValue = timestamp & 0x7FFFFFFF;

    // Bit 31 = Happy Card (disponibilité)
    // od_happy_card: "OUI" ou "NON" dans les données SNCF
    if (trip.od_happy_card === 'OUI' || trip.od_happy_card === true) {
      timeValue |= 0x80000000;
    }

    // Écrire les 12 octets dans le buffer (Big-Endian pour lisibilité)
    const offset = encoded * 12;
    buffer.writeUInt32BE(originUic, offset);           // Bytes 0-3
    buffer.writeUInt32BE(destUic, offset + 4);         // Bytes 4-7
    buffer.writeUInt32BE(timeValue, offset + 8);       // Bytes 8-11

    // Enregistrer les métadonnées pour les requêtes d'indexation temporelle
    tripMetadata[encoded] = {
      trip_id: tripId,
      date: trip.date,
      train_no: trip.train_no || '',
      entity: trip.entity || '',
      axe: trip.axe || ''
    };

    encoded++;
  }

  // 4. Écrire les fichiers binaires et de métadonnées
  console.log(`✅ ${encoded} trajets encodés / ${skipped} ignorés\n`);

  // Réallouer le buffer à la taille exacte (au cas où)
  const finalBuffer = buffer.slice(0, encoded * 12);

  fs.writeFileSync(TRIPS_BIN, finalBuffer);
  console.log(`✅ Fichier binaire créé : ${TRIPS_BIN}`);
  console.log(`   Taille : ${(finalBuffer.length / 1024 / 1024).toFixed(2)} Mo (${finalBuffer.length} bytes)`);
  console.log(`   Trajets : ${encoded}\n`);

  fs.writeFileSync(TRIP_META, JSON.stringify(tripMetadata, null, 2), 'utf8');
  console.log(`✅ Métadonnées créées : ${TRIP_META}`);
  console.log(`   Entrées : ${Object.keys(tripMetadata).length}\n`);

  // 5. (Optionnel) Nettoyer l'ancien trips.json pour économiser l'espace
  // Décommenter si vous voulez supprimer le JSON après encodage
  /*
  try {
    fs.unlinkSync(TRIPS_JSON);
    console.log('🧹 Ancien fichier trips.json supprimé pour économiser l\'espace.\n');
  } catch (e) {
    console.warn('⚠️  Impossible de supprimer trips.json (fichier verrouillé ?)\n');
  }
  */

  console.log('✨ Encodage binaire terminé avec succès !');
}

// Exécution
encodeToBinary();