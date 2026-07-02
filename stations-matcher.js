/**
 * stations-matcher.js
 *
 * Mappe les noms bruts TGVmax (ex: "PARIS-MONTPARNASSE 1 ET 2")
 * vers les vraies gares SNCF du fichier stations.csv.
 *
 * Chaque entrée retournée a la forme :
 *   { id: "FRPMP", name: "Paris Montparnasse", lat, lon }
 *
 * Usage :
 *   const matcher = require('./stations-matcher');
 *   matcher.load('./stations.csv');          // à appeler une fois au démarrage
 *   const station = matcher.match('PARIS-MONTPARNASSE 1 ET 2');
 *   // → { id: 'FRPMP', name: 'Paris Montparnasse', lat: 48.84, lon: 2.32 }
 */

'use strict';

const fs  = require('fs');
const path = require('path');

// ─── Table de surcharges manuelles ────────────────────────────────────────────
//
// Clé : nom normalisé TGVmax (minuscules, sans accents, tirets→espaces)
// Valeur : TVS code SNCF (sans préfixe "FR")
//
// Seules les gares dont le nom TGVmax diffère trop du nom CSV doivent figurer ici.
// Les autres sont résolues automatiquement.

const OVERRIDES = {
  // Paris
  'paris nord':                          'PNO',
  'paris gare du nord':                  'PNO',
  'paris est':                           'PES',
  'paris gare de l est':                 'PES',
  'paris saint lazare':                  'PSL',
  'paris st lazare':                     'PSL',
  'paris bercy':                         'PBY',
  'paris montparnasse 1 et 2':           'PMP',
  'paris montparnasse 2 pasteur':        'PMP',
  'paris montparnasse 3 vaugirard':      'PMP',  // même gare physique
  'paris vaugirard':                     'PMP',
  'paris montparnasse':                  'PMP',
  'paris gare de lyon':                  'PLY',
  'paris austerlitz':                    'PAZ',
  // Marseille
  'marseille saint charles':             'MSC',
  'marseille st charles':                'MSC',
  // Angers
  'angers saint laud':                   'ASL',
  'angers st laud':                      'ASL',
  // Aéroport CDG
  'aeroport cdg2 tgv':                   'RYT',
  'cdg2 tgv':                            'RYT',
  'paris roissy charles de gaulle':      'RYT',
  'roissy charles de gaulle':            'RYT',
  'aeroport charles de gaulle':          'RYT',
  // Lyon
  'lyon saint exupery tgv':              'LYS',
  'lyon st exupery tgv':                 'LYS',
  // Chambéry
  'chambery challes les eaux':           'CRL',
  'chambery':                            'CRL',
  // Clermont
  'clermont ferrand':                    'CFD',
  // Valence
  'valence tgv':                         'VAV',
  'valence ville':                       'VAL',
  // Marne
  'marne la vallee chessy':             'MLV',
  // Massy
  'massy tgv':                           'MPW',
  // Vendôme
  'vendome villiers sur loir':           'VDM',
  'vendome':                             'VDM',
  // Le Creusot
  'le creusot montceau montchanin':      'LCT',
  'le creusot tgv':                      'LCT',
  // Haute-Picardie
  'haute picardie':                      'HPD',
  // Saint-Exupéry
  'st exupery tgv':                      'LYS',
  // Mâcon
  'macon loche tgv':                     'MKN',
  'macon loche':                         'MKN',
  'macon ville':                         'MAO',
  // Bourg
  'bourg en bresse':                     'BGB',
  // Tours
  'saint pierre des corps':              'SPC',
  'st pierre des corps':                 'SPC',
  // Roissy
  'aeroport roissy':                     'RYT',
};

// ─── État interne ─────────────────────────────────────────────────────────────

let _lookup    = null;  // normalized_name → { tvs, name, lat, lon }
let _tvsByCode = null;  // TVS → { name, lat, lon }
let _loaded    = false;

// ─── Normalisation ────────────────────────────────────────────────────────────

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Remplace "st " par "saint " et vice-versa pour enrichir la recherche
function expandSaintSt(str) {
  const variants = [str];
  if (/\bst\b/.test(str)) variants.push(str.replace(/\bst\b/g, 'saint'));
  if (/\bsaint\b/.test(str)) variants.push(str.replace(/\bsaint\b/g, 'st'));
  return variants;
}

// ─── Chargement du CSV ────────────────────────────────────────────────────────

function load(csvPath) {
  if (_loaded) return;

  if (!fs.existsSync(csvPath)) {
    console.warn('[stations-matcher] CSV introuvable : ' + csvPath + ' — fallback slug actif');
    _loaded  = true;
    _lookup  = {};
    _tvsByCode = {};
    return;
  }

  const raw  = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split('\n');
  const header = lines[0].split(';');

  const idx = {};
  for (let i = 0; i < header.length; i++) idx[header[i].trim()] = i;

  const COL = {
    name:       idx['name'],
    lat:        idx['latitude'],
    lon:        idx['longitude'],
    tvs:        idx['sncf_tvs_id'],
    enabled:    idx['sncf_is_enabled'],
    country:    idx['country'],
  };

  _lookup    = {};
  _tvsByCode = {};

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(';');
    if (!cols[COL.tvs] || cols[COL.country] !== 'FR') continue;
    if (cols[COL.enabled] !== 't') continue;

    const tvs  = cols[COL.tvs].trim();
    const name = (cols[COL.name] || '').trim();
    const lat  = parseFloat(cols[COL.lat]) || 0;
    const lon  = parseFloat(cols[COL.lon]) || 0;

    if (!tvs || !name) continue;

    const entry = { tvs, name, lat, lon };

    // Index par nom normalisé (et variantes saint/st)
    const normName = normalize(name);
    for (const variant of expandSaintSt(normName)) {
      if (!_lookup[variant]) _lookup[variant] = entry;
    }

    // Index par code TVS (priorité : premier trouvé)
    if (!_tvsByCode[tvs]) _tvsByCode[tvs] = entry;
  }

  // Intégrer les surcharges manuelles dans le lookup
  for (const [normKey, tvs] of Object.entries(OVERRIDES)) {
    const entry = _tvsByCode[tvs];
    if (entry && !_lookup[normKey]) _lookup[normKey] = entry;
  }

  console.log('[stations-matcher] Chargé — ' +
    Object.keys(_lookup).length + ' entrées, ' +
    Object.keys(_tvsByCode).length + ' gares SNCF');

  _loaded = true;
}

// ─── Correspondance ───────────────────────────────────────────────────────────

/**
 * Cherche la gare SNCF correspondant au nom brut TGVmax.
 *
 * @param  {string} rawName  Ex: "PARIS-MONTPARNASSE 1 ET 2"
 * @returns {{ id: string, name: string, lat: number, lon: number } | null}
 */
function match(rawName) {
  if (!rawName) return null;

  // 1. Nettoyer le nom TGVmax : tirets → espaces, parenthèses supprimées
  const cleaned = rawName
    .replace(/\s*\(.*\)\s*$/g, '')
    .replace(/-/g, ' ')
    .trim();

  const norm = normalize(cleaned);

  // 2. Vérifier les surcharges manuelles en premier
  const overrideTvs = OVERRIDES[norm];
  if (overrideTvs && _tvsByCode && _tvsByCode[overrideTvs]) {
    const e = _tvsByCode[overrideTvs];
    return { id: 'FR' + e.tvs, name: e.name, lat: e.lat, lon: e.lon };
  }

  if (!_lookup) return null;

  // 3. Correspondance exacte
  for (const variant of expandSaintSt(norm)) {
    if (_lookup[variant]) {
      const e = _lookup[variant];
      return { id: 'FR' + e.tvs, name: e.name, lat: e.lat, lon: e.lon };
    }
  }

  // 4. Correspondance en tronquant les suffixes numériques/qualificatifs de gare
  //    Ex: "paris montparnasse 1 et 2" → "paris montparnasse"
  const STOP_WORDS = /\s+(1|2|3|et|i|ii|iii|tgv|ouigo|ville|centre|gare|central)(\s.*)?$/;
  const trimmed = norm.replace(STOP_WORDS, '').trim();
  if (trimmed !== norm) {
    for (const variant of expandSaintSt(trimmed)) {
      if (_lookup[variant]) {
        const e = _lookup[variant];
        return { id: 'FR' + e.tvs, name: e.name, lat: e.lat, lon: e.lon };
      }
    }
  }

  // 5. Correspondance par préfixe (le CSV a parfois des noms plus longs)
  //    Ex: "paris bercy" → "Paris Bercy Bourgogne-Pays d'Auvergne"
  for (const [key, entry] of Object.entries(_lookup)) {
    if (key.startsWith(norm + ' ') || norm.startsWith(key + ' ')) {
      return { id: 'FR' + entry.tvs, name: entry.name, lat: entry.lat, lon: entry.lon };
    }
  }

  // 6. Aucun match → retourner null (l'appelant utilisera un fallback)
  return null;
}

/**
 * Cherche directement par code TVS (sans préfixe FR).
 * @param  {string} tvs  Ex: "PMP"
 */
function getByTvs(tvs) {
  if (!_tvsByCode || !tvs) return null;
  const e = _tvsByCode[tvs];
  if (!e) return null;
  return { id: 'FR' + e.tvs, name: e.name, lat: e.lat, lon: e.lon };
}

/**
 * Retourne toutes les gares FR du CSV (pour build-stations-index).
 */
function getAllStations() {
  if (!_tvsByCode) return [];
  return Object.values(_tvsByCode).map(e => ({
    id:   'FR' + e.tvs,
    name: e.name,
    lat:  e.lat,
    lon:  e.lon,
  }));
}

module.exports = { load, match, getByTvs, getAllStations };