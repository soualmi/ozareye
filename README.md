# OzarEye

**OzarEye surveille les départs de feu en Algérie depuis l'espace et prévient
les gens qui sont sous le vent.** Toutes les 20 minutes, il relit cinq flux
satellitaires (trois satellites polaires VIIRS via NASA FIRMS, le
géostationnaire Meteosat MTG et Sentinel-3 SLSTR via EUMETSAT), regroupe les
pixels chauds en événements, croise chaque événement avec un index local de
9 635 villages et le vent en temps réel, écarte ce qui tombe sur l'un des
5 337 sites industriels ou énergétiques connus (torchères, cimenteries,
carrières…), nomme la caserne de Protection civile la plus proche, et envoie
un message Telegram en français (avec les noms de villages tels qu'ils sont
dans OpenStreetMap, souvent en arabe) qui dit exactement ce que le satellite a
vu et ce qu'il n'a pas vu. Il ne dit jamais « feu confirmé » :
c'est une anomalie thermique, à vérifier sur le terrain, et chaque message le
répète. Le projet est né des feux du 26 août 2026 à Jijel, Béjaïa et Tizi
Ouzou, tourne en production sur un petit serveur depuis fin août, et son code
est libre (AGPL-3.0) pour que n'importe quelle wilaya, association ou pays
voisin puisse le déployer.

**English TL;DR.** OzarEye is a self-hosted wildfire early-warning tool for
Algeria. It fuses five satellite thermal-anomaly feeds (3× VIIRS from NASA
FIRMS, Meteosat MTG and Sentinel-3 SLSTR from EUMETSAT), clusters detections
into events, crosses them with a local village index and live wind to name
who is downwind, filters known industrial heat sources, looks up the nearest
fire station with real emergency numbers, and sends honest Telegram alerts
that never claim a confirmed fire. In an offline replay of the 26 August 2026
fires, fusing Meteosat brought the first alert forward by a median of two
hours and surfaced 131 events VIIRS alone never alerted on. Open source,
AGPL-3.0.

---

## Démo

Tableau de bord en direct : **<https://ozareye.creatik.pro/dashboard>**

L'accès est protégé par un mot de passe partagé, communiqué sur demande (voir
[Contact](#contact--contribuer)). Le tableau de bord n'est pas public : il
montre des anomalies thermiques non vérifiées, et on ne veut pas qu'une
capture d'écran sortie de son contexte circule comme « carte des incendies ».

---

## Architecture : cinq sources, une règle de fusion

Toutes les valeurs ci-dessous sont celles du code (`lib/fire-monitor.ts`,
`lib/meteosat.ts`, `lib/slstr.ts`, `scripts/*-fetch.py`), pas des fiches
techniques recopiées.

| Source | Satellites | Orbite | Résolution | Cadence réelle mesurée | Ce qu'elle apporte |
|---|---|---|---|---|---|
| **NASA FIRMS VIIRS** (×3) | NOAA-20, NOAA-21, Suomi-NPP | polaire | ~375 m | quelques passages par jour, publiés avec 1 à 3 h de retard | **La position de référence.** FRP et confiance par pixel. |
| **EUMETSAT MTG Active Fire Monitoring** (`MTG_FIR`) | MTI1 / FCI | géostationnaire | ~2 km au nadir ; rayon réel par détection ~1,1–1,9 km (repli ±3 km) | **une image toutes les 10 minutes** (~144/jour) | **La veille continue.** Ni FRP ni confiance dans ce produit CAP : ces champs sont émis à zéro, pas inventés. |
| **Copernicus Sentinel-3 SLSTR L2 FRP** (`SLSTR_FRP`) | S3A, S3B | polaire | ~1 km (grille MWIR) | **4 produits/jour sur l'Algérie** (2 par satellite) | **Une sensibilité indépendante** à ses propres heures de passage, avec un vrai FRP et son incertitude. Filtré sur la classe `vegetation_fire` uniquement. |

Les deux sources EUMETSAT sont lues via EUMDAC (collections `EO:EUM:DAT:0801`
et `EO:EUM:DAT:0417`) par deux scripts Python appelés en sous-processus à
chaque run ; toute défaillance est absorbée (liste vide, incident tracé) et ne
ralentit jamais le chemin VIIRS.

**La règle de fusion, verrouillée et testée :**

- **Une source plus grossière ne déplace jamais une position VIIRS.** Dès
  qu'un événement contient un passage VIIRS, son centroïde n'est calculé que
  sur les pixels VIIRS ; Meteosat et SLSTR s'y rattachent mais ne l'ancrent
  pas. Un événement d'abord vu par Meteosat seul est ré-ancré sur VIIRS au
  premier passage polaire et n'en bouge plus.
- **Un signal sans VIIRS n'alerte qu'avec de la persistance** : au moins
  2 détections étalées sur au moins 30 minutes, et il ne peut atteindre que
  le statut « corroboré », jamais « urgent ». Son message commence par
  « position approximative (±X km), non confirmé par satellite polaire ».
- **Le rayon de proximité aux villages s'élargit** de l'incertitude de
  position quand l'événement n'est ancré que par Meteosat ou SLSTR.
- **Le FRP retenu est le maximum** entre capteurs, jamais une moyenne qui
  diluerait une vraie mesure SLSTR avec un zéro Meteosat.

Autour de ça, le moteur est resté simple et lisible : regroupement des pixels
à ≤ 2 km et ≤ 12 h, score explicable (confiance, FRP, passages multiples,
étendue, sécheresse, vent), seuil d'alerte à 70, garde-fou « source
permanente » (une cellule chaude plus de 10 jours sur 30 est ignorée), et
trois bonus de **détection précoce** additifs : +8 si un village est à moins
de 3 km, +10 si le FRP dépasse d'au moins 2× la moyenne locale des 30 derniers
jours pour cette cellule et cette heure (il faut 3 jours d'historique), +8 par
capteur secondaire qui a revu l'événement au moins deux fois.

**État réel en production au 4 septembre 2026 :** les cinq sources sont
branchées sur le run live, chacune suivie par le watchdog. SLSTR remonte des
détections à chaque run (12 détections SLSTR réparties dans 5 événements
mixtes VIIRS+SLSTR dans la base live). Meteosat est en bonne santé mais
renvoie 0 détection sur la fenêtre live courante : normal par temps calme,
mais cela veut dire que sa contribution en direct n'a pas encore été observée
en conditions réelles, seulement en rejeu (voir plus bas).

---

## Ce qui le distingue d'une simple carte FIRMS

- **Villages × vent.** Chaque événement au-dessus du seuil est croisé avec les
  villages à moins de 20 km (index OSM local, 9 635 entrées pour l'Algérie,
  noms en arabe et en français). Le vent Open-Meteo classe chacun sous le
  vent / marginal / au vent ; un village à moins de 3 km est toujours nommé,
  le vent tourne. Le message imprime au plus quatre villages avec distance,
  direction et une estimation de délai clairement annoncée comme grossière.
- **Filtre des faux positifs industriels.** Un index local de **5 337 sites**
  industriels et énergétiques OSM (avec leur emprise réelle, pas seulement un
  centre) est consulté pour chaque détection, sans appel réseau. Un événement
  qui tombe sur une torchère ou une cimenterie est titré « Anomalie thermique
  — site industriel connu », rétrogradé, et masqué par défaut sur le tableau
  de bord (case à cocher pour le voir). Il n'est jamais supprimé : on
  marque, on ne cache pas.
- **Caserne la plus proche et vrais numéros.** Un index de **411 casernes**
  (`amenity=fire_station` OSM, 177 avec un numéro de téléphone renseigné dans
  OSM) donne « Caserne la plus proche : … — X km » dans le message et sur la
  carte. Le panneau d'urgence affiche les numéros nationaux réels :
  Protection civile 14 / 1021, SAMU 16, Police 17 / 1548, Gendarmerie 1055,
  Direction générale des forêts 1070. Un numéro absent d'OSM n'est jamais
  inventé.
- **Des mots honnêtes, partout.** Titre « ANOMALIE THERMIQUE — À VÉRIFIER »,
  rappel « Signal satellite, vérifier terrain », statut « non confirmé au
  sol » même après plusieurs passages, et une ligne « Preuves : … » en clair
  (« vu par 3 passages satellite · vent 25 km/h → NE »). Les tests du tableau
  de bord vérifient que son résumé ne peut pas dire « feu détecté » ni
  « confirmé au sol » sans négation ; « feu confirmé » n'existe nulle part
  dans les textes.
- **Un tableau de bord qui trie sans mentir.** Signaux faibles et sites
  industriels sont masqués par défaut, réactivables par deux cases
  indépendantes ; liste et carte partagent exactement le même filtre ; les
  événements hors frontières restent visibles. Le filtrage est purement
  d'affichage, la détection et le scoring ne changent pas.
- **Un watchdog qui se méfie de lui-même.** Après deux jours de silence fin
  août (clé FIRMS invalide, personne ne l'a vu), chaque source a désormais un
  suivi de santé : 3 échecs consécutifs ouvrent un incident et préviennent un
  canal Telegram admin, rappel toutes les 6 h, message de rétablissement. En
  plus, le cron ne pingue **healthchecks.io** qu'après un run réussi : si le
  serveur lui-même s'arrête, l'alerte vient de l'extérieur.

---

## Preuves : le rejeu du 26 août 2026

Il n'y a pas encore de vérification terrain ; ce qui suit est un **rejeu hors
ligne** des journées du 25 au 29 août 2026 (feux de Jijel, Béjaïa, Tizi
Ouzou), rejouées par tranches de 20 minutes, la cadence du cron, sans rien
envoyer. Les chiffres viennent de
[`replay-out/20260826-meteosat/metrics.md`](replay-out/20260826-meteosat/metrics.md)
(VIIRS + Meteosat), à lire avec les réserves qu'il énonce lui-même.

**Ce que Meteosat a changé, comparé au même rejeu VIIRS seul :**

| Mesure | Valeur |
|---|---:|
| Événements alertés dans Jijel, Béjaïa, Tizi Ouzou | 782 |
| … dont retrouvés dans le rejeu VIIRS seul (≤ 3 km) | 651 |
| … **jamais alertés par VIIRS seul** sur toute la fenêtre | **131** |
| Première alerte déclenchée par Meteosat seul, avant tout passage VIIRS | 655 (tous au statut « corroboré », jamais « urgent ») |
| Avance de la première alerte sur les 651 événements appariés | **médiane 120 min**, moyenne 190 min |

**Ce que le moteur fait bien, et moins bien :**

- 30 événements ont alerté avec un FRP encore inférieur à 20 MW puis ont
  dépassé 100 MW : c'est le cas d'usage.
- 54 % des premières alertes tombent entre 22 h et 6 h, quand personne ne voit
  la fumée.
- 3 des 9 localités citées par la presse ou la Protection civile comme
  brûlées ou évacuées les 26-27 août sont nommées dans le texte d'une alerte
  (Aghbala, Acherar, Taksena). Les 6 autres ne le sont pas.
- 14 % des événements alertés tombent sur un site industriel connu ; le
  moteur live les rétrograde, le rejeu original ne le faisait pas.
- Le signal « anomalie FRP vs historique » n'a contribué qu'à 2 événements :
  attendu, l'historique de 30 jours part vide dans un rejeu de cinq jours. Sa
  valeur réelle reste à démontrer en production.

**Ce que ce rejeu ne prouve pas :** la latence de publication NRT (1 à 3 h)
n'est pas modélisée, donc chaque heure d'alerte est un plancher optimiste ;
l'appariement à 3 km entre deux rejeux est une approximation ; le garde-fou
« source permanente » ne peut pas s'exercer sur cinq jours ; et rien ici ne
dit qu'un feu réel a été signalé plus tôt à quelqu'un.

**Rejeu à trois sources (VIIRS + Meteosat + SLSTR)** : lancé le 4 septembre
au soir, en cours d'exécution au moment d'écrire ces lignes
(`replay-out/20260826-full/`). Ses métriques ne sont pas encore produites, et
ce README ne les anticipe pas. Sur le run live, SLSTR apporte 4 passages par
jour et un vrai FRP ; sa contribution en avance d'alerte sera vraisemblablement
marginale par rapport à Meteosat, ce sera écrit ici quand ce sera mesuré.

---

## Limites, sans enjoliver

- **Une anomalie thermique n'est pas un feu confirmé.** Torchères, fours,
  toits chauds, reflets : le filtre industriel et le garde-fou 30 jours
  écartent les cas connus, pas les autres. Chaque alerte est un « allez
  voir », jamais un « évacuez ».
- **Plancher de détection.** VIIRS voit un pixel de 375 m ; Meteosat ~2 km ;
  SLSTR ~1 km. Un départ de feu de quelques mètres carrés sous un couvert
  dense peut n'apparaître qu'une fois déjà étendu, ou jamais.
- **Exposition = vent seul.** Le classement sous le vent / au vent est une
  ligne droite à vitesse constante. Ni relief, ni végétation, ni comportement
  du feu, ni changement de vent. Le délai affiché est un ordre de grandeur.
- **Aucune vérification terrain.** Ni dans le rejeu, ni en production. Le
  système n'a aucun lien avec la Protection civile ou une autorité.
- **Latence incompressible.** Les flux VIIRS NRT sortent avec 1 à 3 h de
  retard, le cron tourne toutes les 20 min. Meteosat réduit ce trou mais
  n'alerte seul qu'après 30 min de persistance.
- **Suomi-NPP s'arrête.** NASA et NOAA cessent la diffusion des produits
  Suomi-NPP le **1er novembre 2026** ([avis NASA
  Earthdata](https://www.earthdata.nasa.gov/data/alerts-outages/suomi-npp-data-product-delivery-cease-november-1-2026)).
  OzarEye passera alors à deux satellites VIIRS ; la source disparaîtra du
  watchdog, rien d'autre ne casse.
- **Il ne surveille que s'il tourne.** Pas de rattrapage : un serveur éteint
  pendant une heure ne verra jamais ce qui s'est passé pendant cette heure.

---

## Stack et mise en route

- **Application** : Next.js (App Router) compilée par
  [vinext](https://github.com/cloudflare/vinext) sur Vite, React 19, Leaflet,
  Tailwind 4, TypeScript.
- **Données** : `node:sqlite` par défaut (Node ≥ 22.13, aucun addon natif) ;
  Postgres/Neon si `DATABASE_URL` ou `POSTGRES_URL` est défini.
- **Satellite** : NASA FIRMS (clé gratuite) ; EUMETSAT Data Store via EUMDAC
  (Python 3, `eumdac`, `netCDF4`) pour MTG et SLSTR.
- **Météo** : Open-Meteo (sans clé). **Index locaux** : villages, sites
  industriels et casernes extraits une fois d'OpenStreetMap (Overpass) par
  les scripts `scripts/build-*.ts`, jamais interrogés à chaud.
- **Exploitation** : un service systemd sur `127.0.0.1:8423`, nginx +
  Let's Encrypt devant, un cron `*/20 * * * *` qui appelle `POST /api/monitor`
  puis pingue healthchecks.io, un canal Telegram admin pour le watchdog.

```bash
git clone https://github.com/soualmi/ozareye.git && cd ozareye
npm install
cp .env.example .env.local   # FIRMS_MAP_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
                             # MONITOR_SECRET, DASHBOARD_PASSWORD ; ajouter pour
                             # EUMETSAT et le watchdog : EUMETSAT_CONSUMER_KEY,
                             # EUMETSAT_CONSUMER_SECRET, ADMIN_TELEGRAM_CHAT_ID,
                             # HEALTHCHECKS_PING_URL
pip install eumdac netCDF4
npm test                     # 128 tests (Node >= 22.13 obligatoire pour node:sqlite)
npm run build
node node_modules/vinext/dist/cli.js start --hostname 127.0.0.1 --port 8423
# en production : un service systemd qui lance cette commande, et le cron
# */20 * * * * scripts/run-monitor.sh (qui appelle POST /api/monitor)
```

La configuration régionale (emprise, pays, wilayas) se fait dans l'écran
`/setup`. Le rejeu historique s'obtient avec `npm run replay -- --from
2026-08-25 --to 2026-08-29 --with-meteosat` puis `npm run replay:metrics` ;
il écrit dans sa propre base et refuse de toucher `data/signals.db`. Le
rejeu à trois sources (SLSTR inclus) est en cours de développement et n'est
pas encore dans la branche publiée.

---

## Licence et attributions

Code sous **[GNU AGPL-3.0](LICENSE)** : libre d'utiliser et de modifier, mais
toute version distribuée ou hébergée en réseau doit publier ses sources sous
la même licence.

Les données ne sont pas à nous. Chaque message et chaque fiche du tableau de
bord porte la ligne de crédits correspondant aux sources réellement
utilisées ; les mêmes formulations sont reprises ici :

- **NASA FIRMS** (Fire Information for Resource Management System), courtesy
  of NASA/USGS/USDA Forest Service.
  [firms.modaps.eosdis.nasa.gov](https://firms.modaps.eosdis.nasa.gov/)
- **MTG Active Fire Monitoring — EUMETSAT**, via le [EUMETSAT Data
  Store](https://user.eumetsat.int/data-access/data-store), soumis aux
  [conditions de licence des données
  EUMETSAT](https://user.eumetsat.int/resources/user-guides/data-registration-and-licensing).
- **Copernicus Sentinel-3 SLSTR**, produit Level 2 FRP distribué par EUMETSAT
  pour le programme Copernicus, mêmes conditions.
- **Open-Meteo.com**, utilisé selon ses conditions d'usage non commercial.
  [open-meteo.com](https://open-meteo.com/)
- Villages, sites industriels, casernes, frontières : **© OpenStreetMap
  contributors**, [Open Database License](https://www.openstreetmap.org/copyright).
  Frontières des wilayas : [fr33dz/Algeria-geojson](https://github.com/fr33dz/Algeria-geojson).

---

## Contact & contribuer

Le projet a été présenté à la communauté OpenStreetMap algérienne sur le
[forum communautaire OSM](https://community.openstreetmap.org/) le
3 septembre 2026 : les index de villages, de casernes et de sites industriels
sont directement la qualité d'OSM en Algérie, et chaque `phone=` ajouté sur
une caserne finit dans un message d'alerte.

Contributions bienvenues, en particulier : vérification terrain d'alertes
passées, données de couvert végétal pour dépasser l'exposition « vent seul »,
déploiement dans une autre wilaya ou un pays voisin, relecture des textes en
arabe.

H. Soualmi — [soualmih@gmail.com](mailto:soualmih@gmail.com) — accès au
tableau de bord sur demande.
