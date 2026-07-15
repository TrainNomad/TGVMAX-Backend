'use strict';

/**
 * 🚀 ENCODEUR BINAIRE (CORRIGÉ & SÉCURISÉ)
 * Convertit trips.json (produit par tgvmax-ingest.js) → trips.bin + trip_meta.json
 * * Format binaire : 12 octets par trajet
 * - Bytes 0-3   : UIC gare de départ (UInt32BE)
 * - Bytes 4-7   : UIC gare d'arrivée (UInt32BE)
 * - Bytes 8-11  : Timestamp UNIX 31 bits + bit de poids fort = Happy Card
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'engine_data');
const TRIPS_JSON = path.join(DATA_DIR, 'trips.json');
const STOPS_JSON = path.join(DATA_DIR, 'stops.json'); // requis pour obtenir les vrais UIC
const TRIPS_BIN = path.join(DATA_DIR, 'trips.bin');
const TRIP_META = path.join(DATA_DIR, 'trip_meta.json');

function encodeToBinary() {
  console.log('⏳ Début de l\'encodage binaire trips.json → trips.bin...\n');

  // 1. Vérifier que les fichiers requis existent
  if (!fs.existsSync(TRIPS_JSON)) {
    console.error(`❌ Fichier trips.json introuvable : ${TRIPS_JSON}`);
    process.exit(1);
  }
  if (!fs.existsSync(STOPS_JSON)) {
    console.error(`❌ Fichier stops.json introuvable : ${STOPS_JSON}`);
    process.exit(1);
  }

  // 2. Parser trips.json et stops.json
  let trips, stops;
  try {
    trips = JSON.parse(fs.readFileSync(TRIPS_JSON, 'utf8'));
    stops = JSON.parse(fs.readFileSync(STOPS_JSON, 'utf8'));
    console.log(`✅ trips.json parsé : ${Object.keys(trips).length} trajets trouvés`);
    console.log(`✅ stops.json parsé : ${Object.keys(stops).length} gares trouvées\n`);
  } catch (e) {
    console.error(`❌ Erreur parsing des sources: ${e.message}`);
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

  // Récupération de l'ancien index de métadonnées s'il existe pour conserver la date et le numéro de train
  let initialTripMeta = {};
  if (fs.existsSync(TRIP_META)) {
    try {
      initialTripMeta = JSON.parse(fs.readFileSync(TRIP_META, 'utf8'));
    } catch (e) {
      console.warn("⚠️ Impossible de lire l'ancien trip_meta.json, on va tenter d'estimer.");
    }
  }

  for (let i = 0; i < totalTrips; i++) {
    const tripId = tripIds[i];
    const trip = trips[tripId];

    // Résolution des IDs internes de stops vers de vrais codes UIC à l'aide de stops.json
    const originUicRaw = stops[trip.o] ? (stops[trip.o].uic || trip.o) : trip.o;
    const destUicRaw   = stops[trip.d] ? (stops[trip.d].uic || trip.d) : trip.d;

    const originUic = parseInt(originUicRaw, 10) || 0;
    const destUic = parseInt(destUicRaw, 10) || 0;

    // Récupération de la date associée au trajet
    const dateStr = initialTripMeta[tripId] ? initialTripMeta[tripId].date : null;

    // Validation
    if (!originUic || !destUic || !dateStr || trip.t_dep === undefined) {
      skipped++;
      continue;
    }

    // Reconstruire l'heure de départ depuis les secondes (trip.t_dep)
    const depSeconds = trip.t_dep;
    const hours = Math.floor(depSeconds / 3600);
    const minutes = Math.floor((depSeconds % 3600) / 60);

    // Construire le timestamp UNIX
    let timestamp = 0;
    try {
      const [year, month, day] = dateStr.split('-').map(Number);
      const dateObj = new Date(year, month - 1, day, hours, minutes, 0);
      timestamp = Math.floor(dateObj.getTime() / 1000);
    } catch (e) {
      skipped++;
      continue;
    }

    // 💡 FORCE LE TIMESTAMP EN ENTIER NON-SIGNÉ 32-BITS
    let timeValue = (timestamp & 0x7FFFFFFF) >>> 0;

    // Bit 31 = Disponibilité TGVmax (happy card)
    if (trip.dispo === 1 || trip.dispo === true) {
      // 💡 FORCE LE RÉSULTAT DU BITWISE OR EN ENTIER NON-SIGNÉ AVEC >>> 0
      timeValue = (timeValue | 0x80000000) >>> 0;
    }

    // Écrire les 12 octets dans le buffer (Big-Endian)
    const offset = encoded * 12;
    buffer.writeUInt32BE(originUic, offset);           // Bytes 0-3 : Gare Départ
    buffer.writeUInt32BE(destUic, offset + 4);         // Bytes 4-7 : Gare Arrivée
    buffer.writeUInt32BE(timeValue, offset + 8);       // Bytes 8-11: Temps + Dispo

    // Enregistrer les métadonnées pour l'API du serveur
    tripMetadata[encoded] = {
      trip_id: tripId,
      date: dateStr,
      train_no: initialTripMeta[tripId] ? (initialTripMeta[tripId].train_no || '') : ''
    };

    encoded++;
  }

  // 4. Écrire les fichiers binaires et de métadonnées finaux
  console.log(`✅ ${encoded} trajets encodés / ${skipped} ignorés\n`);

  const finalBuffer = buffer.slice(0, encoded * 12);

  fs.writeFileSync(TRIPS_BIN, finalBuffer);
  console.log(`✅ Fichier binaire créé : ${TRIPS_BIN}`);
  console.log(`   Taille : ${(finalBuffer.length / 1024 / 1024).toFixed(2)} Mo (${finalBuffer.length} bytes)`);
  console.log(`   Trajets : ${encoded}\n`);

  fs.writeFileSync(TRIP_META, JSON.stringify(tripMetadata, null, 2), 'utf8');
  console.log(`✅ Métadonnées créées : ${TRIP_META}`);
  console.log(`   Entrées : ${Object.keys(tripMetadata).length}\n`);

  // Nettoyage de l'ancien trips.json pour économiser la mémoire de stockage
  try {
    fs.unlinkSync(TRIPS_JSON);
    console.log('🧹 Ancien fichier trips.json supprimé pour économiser l\'espace.\n');
  } catch (e) {
    console.warn('⚠️ Impossible de supprimer trips.json\n');
  }

  console.log('✨ Encodage binaire terminé avec succès !');
}

// Exécution
encodeToBinary();