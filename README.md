# TGVmax Backend

Moteur de recherche de trajets TGVmax (SNCF Open Data). Les données lourdes
(`engine_data/`, `stations.json`, `stations.csv`) ne sont **jamais** versionnées
dans Git : elles sont reconstruites chaque jour par un workflow GitHub Actions
et publiées comme fichier attaché à une **Release GitHub**. Le serveur les
télécharge au démarrage.

## 1. Créer le dépôt GitHub

```bash
cd tgvmax-backend
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/TrainNomad/TGVMAX-Backend.git
git push -u origin main
```

Aucun token à créer manuellement : le workflow utilise le token automatique
`GITHUB_TOKEN` fourni par GitHub Actions (déjà configuré avec les droits
d'écriture nécessaires dans `.github/workflows/update-tgvmax.yml`).

## 2. Générer la première Release de données

Sur GitHub → onglet **Actions** → workflow **"Update TGVmax Data"** →
**Run workflow** (bouton en haut à droite). Ça prend quelques minutes.
Une fois terminé, va dans l'onglet **Releases** : tu dois voir une release
`data-latest` avec le fichier `tgvmax-data.tar.gz` attaché.

Ensuite, le workflow tourne automatiquement tous les jours à 7h30 UTC
(`cron: '30 7 * * *'`), et tu peux toujours le relancer manuellement.

## 3. server.js est déjà configuré

`DATA_RELEASE_URL` pointe déjà vers :
```
https://github.com/TrainNomad/TGVMAX-Backend/releases/download/data-latest/tgvmax-data.tar.gz
```
Rien à modifier. Si un jour tu changes de dépôt, tu peux soit éditer cette
constante dans `server.js`, soit définir la variable d'environnement
`DATA_RELEASE_URL` sur Render (elle prend le dessus sur la valeur par défaut).

## 4. Déployer sur Render

- Build command : `npm install`
- Start command : `npm start`
- Variables d'environnement à définir :
  - `DATA_RELEASE_URL` → l'URL de l'étape 3 (si tu n'as pas modifié le code)
  - `PORT` → généralement géré automatiquement par Render, pas besoin de le définir

Au premier démarrage, le serveur répond immédiatement sur le port (health-check
Render OK), puis télécharge et extrait l'archive de données en tâche de fond
avant de charger le moteur (`initEngine()`).

## Pipeline de données (résumé)

```
tgvmax-ingest.js  →  engine_data/*.json   (trips, stops, routes, calendar, meta)
build-stations-index.js  →  stations.json (regroupement par ville + coordonnées GPS)
                                            depuis stations.csv (trainline-eu/stations)
```

Ce pipeline est exécuté par `.github/workflows/update-tgvmax.yml`, qui compresse
le résultat dans `tgvmax-data.tar.gz` et le publie sur la release `data-latest`.

## Scripts npm

- `npm run ingest` — télécharge les données SNCF et génère `engine_data/`
- `npm run stations` — génère `stations.json`
- `npm run build` — les deux d'affilée (utilisé par le workflow)
- `npm start` — démarre le serveur (télécharge d'abord les données si absentes)
