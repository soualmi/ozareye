# Algérie Feux Alerte

Application de surveillance des anomalies thermiques dans la bande nord de l'Algérie
(Béjaïa, Jijel, Tizi Ouzou, Bouira). Elle combine les flux NASA FIRMS (VIIRS
NOAA-20, NOAA-21, Suomi-NPP), la météo Open-Meteo (vent, humidité), un score de
corroboration explicable, un index de 3937 villages, et des alertes Telegram
bilingues (français/arabe) dédupliquées par ÉVÉNEMENT de feu — pas par pixel.

Ce logiciel INFORME les personnes qui détiennent déjà une autorité locale
(comités de village, protection civile, services des forêts). Il n'instruit
jamais les civils à évacuer.

## Ce qui a changé (refonte)

- **Clustering par événement** (`lib/fire-monitor.ts: clusterDetections`) :
  les pixels détectés à ≤2km et ≤12h l'un de l'autre sont fusionnés en un seul
  événement, avec un id stable. Une alerte n'est renvoyée sur un événement déjà
  notifié que si le score progresse d'au moins `ESCALATION_SCORE_DELTA` (15
  points, dans `app/api/monitor/route.ts`) ou si son statut monte d'un cran.
- **Corroboration corrigée** : recoupement = détections d'un satellite
  *différent* OU d'un passage à une heure *différente*. Plusieurs pixels
  adjacents dans le même passage indiquent un feu étendu, pas une confirmation
  — les deux sont scorés séparément et étiquetés honnêtement dans les preuves.
- **Aucun plafond au traitement** (`.slice(0,100)` supprimé) ; le plafond
  d'affichage reste dans `lib/database.ts: latestSignals` (LIMIT 100).
- **Garde-fou premier lancement** : base vide → l'historique de 24h est
  enregistré et marqué "notifié" sans envoyer d'alerte (`isFirstRun` dans
  `app/api/monitor/route.ts`).
- **Sources en échec isolé** : chaque source FIRMS est essayée indépendamment ;
  un échec ne bloque plus les autres, et `source X: FAILED` est distingué de
  `source X: 0 rows` dans les logs (`fetchDetections`).
- **Bbox resserré** sur la bande nord (`ALGERIA_BOX` = `2.5,35.5,7.5,37.3`,
  west,south,east,north) au lieu du pays entier filtré après coup.
- **Direction du vent + villages exposés** (`lib/wind.ts`, `lib/geo.ts`,
  `computeExposedVillages` dans `lib/fire-monitor.ts`) : chaque événement est
  croisé avec les 3937 villages de `data/villages.json` dans un rayon de 20km,
  classés sous le vent / marginal / au vent, avec une estimation grossière de
  temps d'arrivée. **`lib/wind.test.ts` vérifie que la conversion
  direction-d'où-vient → direction-vers-où-souffle n'est jamais inversée** —
  ce test doit passer avant tout le reste.
- **Message Telegram bilingue et compact** (<500 caractères) qui commence par
  les villages exposés, pas les coordonnées ; garde l'heure/âge, capteur, FRP,
  la liste de preuves, la mention NASA FIRMS et le crédit "Weather data by
  Open-Meteo.com" requis par leur licence.
- **Base de données locale** : `lib/database.ts` utilise `better-sqlite3` sur
  `./data/signals.db` au lieu de Cloudflare D1. Mêmes signatures de fonctions
  (`initDb`, `saveSignal`, `markNotified`, `wasNotified`, `latestSignals`), plus
  `activeEvents`/`isFirstRun` pour le clustering inter-exécutions.

## Constantes à régler

Toutes dans `lib/fire-monitor.ts` sauf mention contraire :

- `ALGERIA_BOX` — bbox FIRMS (west,south,east,north). À élargir si la
  couverture doit dépasser la bande nord.
- `CLUSTER_RADIUS_KM` (2) / `CLUSTER_TIME_HOURS` (12) — seuils de fusion en un
  même événement.
- `EXPOSURE_RADIUS_KM` (20) — rayon de recherche des villages exposés.
- `SPREAD_FACTOR` (0.06) — ratio vitesse-du-vent → vitesse-de-propagation
  grossière ; l'ETA produit est une ESTIMATION, jamais une prédiction.
- `ALERT_SCORE_THRESHOLD` (70) et `ESCALATION_SCORE_DELTA` (15, dans
  `app/api/monitor/route.ts`) — seuils d'alerte initiale et de ré-alerte.
- `lib/wind.ts: DOWNWIND_MAX_DEG` (45) / `MARGINAL_MAX_DEG` (75) — bandes
  angulaires sous le vent / marginal / au vent.

## Configuration

Copier `.env.example` vers `.env.local`, puis renseigner :

- `FIRMS_MAP_KEY` : clé gratuite NASA FIRMS ;
- `TELEGRAM_BOT_TOKEN` : token créé avec BotFather ;
- `TELEGRAM_CHAT_ID` : groupe ou canal destinataire ;
- `MONITOR_SECRET` : secret protégeant le déclencheur de collecte.

`.env.local` est ignoré par git — vérifier avant tout commit.

## Lancer le projet

```bash
npm install
npm run dev
```

Le point d'entrée `POST /api/monitor` doit être appelé toutes les **20
minutes** (VIIRS ne fournit que 2 à 4 passages par jour ; interroger toutes les
5 minutes ne sert à rien) avec l'en-tête `x-monitor-secret`, via une tâche cron
système — **pas encore installée**, à faire séparément une fois le rejeu
validé.

## Tester

```bash
npm run test:wind   # test de non-inversion direction du vent — doit passer avant tout
```

## Rejeu historique (Part D2)

Montre les messages Telegram exacts qu'aurait produits le moteur pour une
journée passée, sans rien envoyer :

```bash
npm run replay -- 2026-08-26                    # bbox Béjaïa par défaut
npm run replay -- 2026-08-26 4.2,36.1,5.6,37.0   # bbox personnalisé (west,south,east,north)
```

Nécessite `FIRMS_MAP_KEY` dans `.env.local`. Utilise la météo historique
d'Open-Meteo (`archive-api.open-meteo.com`), pas la météo actuelle.

## Important

Ce logiciel est une aide à la veille. Il ne remplace ni la Protection civile,
ni une confirmation humaine, ni les systèmes officiels d'urgence.
