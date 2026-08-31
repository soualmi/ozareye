# Algérie Feux Alerte

## 1. What this is

A self-hosted wildfire alert system built around NASA's FIRMS satellite
thermal-anomaly feed. It polls FIRMS on a schedule, clusters raw pixel
detections into fire events, cross-references each event against a village
index and live wind data to work out who's downwind, and sends a Telegram
alert naming the exposed villages. It also ships a small password-protected
web dashboard for browsing live and historical events on a map. This
deployment is configured for northern Algeria; adapting it to another region
takes real work — see [section 5](#5-adapting-to-your-region).

**What it is not, stated plainly:** it detects satellite-observed thermal
anomalies, not confirmed fires. It is not an emergency service and has no
connection to any civil-protection or firefighting authority. It does not
replace human verification, official warning systems, or a phone call to the
people who actually respond to fires. Treat every alert as "go check", never
as "evacuate."

## 2. How it works

- **Detection** — every run, the monitor polls three NASA FIRMS VIIRS
  products (NOAA-20, NOAA-21, Suomi-NPP) for hot pixels inside a bounding box.
  VIIRS is a **polar-orbiting** sensor at **375m** resolution: each satellite
  passes over a given point only a handful of times a day, so there's
  inherent latency — a fire that started between passes won't show up until
  the next one. This is not a live camera feed.
- **Clustering** — nearby pixels (≤2km, ≤12h apart) are merged into a single
  fire *event* with a stable id, so a burning area that lights up a dozen
  pixels doesn't spam a dozen alerts. New detections merge into events already
  tracked from the previous run instead of spawning duplicates.
- **Scoring** — each event gets an explainable score from satellite
  confidence, radiative power (FRP), whether it was seen across multiple
  passes/satellites ("corroboration", vs. just a big single-pass footprint),
  and, once weather is fetched, dryness and wind speed. A persistent-source
  guard also suppresses cells that light up on far more days than a real fire
  ever would (gas flares, industrial heat) without needing a hardcoded list.
- **Villages** — every event above a certain score is cross-referenced
  against a local index of villages (built once from OpenStreetMap, see
  section 5) within a fixed radius.
- **Wind & exposure** — current wind direction and speed come from Open-Meteo
  (no key required). Each nearby village is classified downwind, marginal, or
  upwind of the fire, using the wind direction plus its compass bearing from
  the fire. A village close enough to the fire is always named regardless of
  wind, since wind shifts and embers travel unpredictably at short range.
- **Wilaya boundaries** — a real point-in-polygon lookup against Algeria's
  wilaya (province) boundaries attributes each fire to a wilaya, both for
  display and to route the alert to that wilaya's own Telegram channel if one
  is configured (falling back to a default channel otherwise).
- **Delivery** — the resulting message, naming the exposed villages with
  distance, direction, and a rough time estimate, is sent to Telegram.

## 3. What you need before starting

- **A Linux server that stays on 24/7.** This polls a live feed on a fixed
  schedule via cron. A laptop or desktop that sleeps, suspends, or gets
  rebooted unpredictably **will miss fires** during every gap it's down. Any
  small always-on VPS is enough — this is not compute-heavy.
- **Node.js 22.13 or newer.** The database layer uses `node:sqlite`
  (`lib/database.ts`), Node's built-in SQLite module, specifically to avoid a
  native-addon dependency that doesn't survive bundling. That module only
  became stable, unflagged, in Node 22.13 — earlier 22.x releases won't work.
  Install via [nvm](https://github.com/nvm-sh/nvm) (`nvm install 22`) or your
  distro's Node 22 package if it's new enough; check with `node --version`.
- **A free NASA FIRMS map key.** Request one at
  [firms.modaps.eosdis.nasa.gov/api/map_key](https://firms.modaps.eosdis.nasa.gov/api/map_key/) —
  it's free, instant, and only requires an email address.
- **A Telegram bot token and a destination chat/channel id.** Create a bot via
  [@BotFather](https://t.me/BotFather) on Telegram (`/newbot`, copy the
  token). Then create the channel or group you want alerts sent to, add the
  bot as a member/admin, send any message in it, and read the chat id from
  `https://api.telegram.org/bot<TOKEN>/getUpdates`.
- **Basic comfort with a terminal, systemd, and cron.** The install below
  assumes you can edit a systemd unit file, install a crontab line, and debug
  a service that fails to start. This is not a one-click deploy.

## 4. Install

```bash
git clone https://github.com/soualmi/algerie-feux.git
cd algerie-feux
npm install
```

### 4.1 Configuration

Copy the example env file and fill in real values:

```bash
cp .env.example .env.local
```

`.env.local` is git-ignored — never commit it. It must define:

| Variable | What it is |
|---|---|
| `FIRMS_MAP_KEY` | Your NASA FIRMS map key (section 3) |
| `TELEGRAM_BOT_TOKEN` | Your bot's token from BotFather |
| `TELEGRAM_CHAT_ID` | Default destination chat/channel id |
| `MONITOR_SECRET` | A long random string you choose — protects `POST /api/monitor` from being triggered by anyone but your own cron job |
| `DASHBOARD_PASSWORD` | The shared password for logging into the web dashboard |

Generate a reasonable `MONITOR_SECRET` with e.g. `openssl rand -hex 32`.

### 4.2 A required placeholder file

The build tooling (`vite.config.ts`) still imports `./.openai/hosting.json`,
a leftover from the project's original Cloudflare-hosted scaffold. That file
is git-ignored (it's a local hosting artifact, not app config) — which means
a fresh clone is **missing a file the build needs to even start**. Create a
minimal placeholder before building:

```bash
mkdir -p .openai
cat > .openai/hosting.json <<'EOF'
{
  "project_id": "self-hosted",
  "d1": null,
  "r2": null
}
EOF
```

`d1: null` / `r2: null` correctly disable the unused Cloudflare bindings —
this app doesn't use Cloudflare D1 or R2 at runtime, this file just needs to
exist for the build step to resolve its import.

### 4.3 Build

```bash
npm run build
```

This runs `vinext build` (the app is built on
[vinext](https://github.com/cloudflare/vinext), a Vite-based Next.js-compatible
toolchain) and produces a `dist/` directory.
Run the test suite first if you want confidence before deploying — see
section 4.6.

### 4.4 Run it as a systemd service

Create `/etc/systemd/system/algerie-feux.service` (adjust `WorkingDirectory`
and the `node` path to match your install):

```ini
[Unit]
Description=Algerie Feux Alerte - fire monitor web/API server
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/algerie-feux
ExecStart=/path/to/node22/bin/node /path/to/algerie-feux/node_modules/vinext/dist/cli.js start --hostname 127.0.0.1 --port 8423
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

`vinext start` serves the `dist/` output built in step 4.3 — it does not
rebuild on its own; re-run `npm run build` and restart the service after any
code change. It reads `.env.local` from its working directory the same way
`npm run dev` does.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now algerie-feux
sudo systemctl status algerie-feux
```

The `--hostname 127.0.0.1` binds it to localhost only — see
[section 6](#6-the-dashboard) for why, and how to actually reach it.

### 4.5 Install the cron trigger

The monitor doesn't poll on its own — something has to call
`POST /api/monitor` on a schedule. `scripts/run-monitor.sh` does that, reading
`MONITOR_SECRET` from `.env.local` at call time (never hardcoded):

```bash
#!/bin/bash
set -euo pipefail
cd /path/to/algerie-feux
SECRET=$(grep '^MONITOR_SECRET=' .env.local | cut -d= -f2-)
curl -s -X POST http://127.0.0.1:8423/api/monitor -H "x-monitor-secret: $SECRET" >> /path/to/algerie-feux/cron.log 2>&1
echo "" >> /path/to/algerie-feux/cron.log
```

Make it executable (`chmod +x scripts/run-monitor.sh`) and add it to root's
crontab (`crontab -e`):

```cron
*/20 * * * * /path/to/algerie-feux/scripts/run-monitor.sh
```

Every 20 minutes is deliberate, not arbitrary: VIIRS only gives 2–4 passes a
day, so polling more often than that just re-checks the same data. On the
very first run against an empty database, the monitor seeds its history from
whatever's currently in the feed **without sending any alerts** — that's
expected, not a bug.

### 4.6 Run the tests

```bash
npm run test        # all four suites below
npm run test:wind    # wind direction FROM→TOWARD conversion — get this backwards and every exposure classification inverts silently
npm run test:labels
npm run test:wilaya
npm run test:clustering
```

### 4.7 Try a historical replay before going live

Shows the exact Telegram messages the engine would have produced for a past
day, without sending anything — useful to sanity-check scoring and village
selection before you trust it with real alerts:

```bash
npm run replay -- 2026-08-26                    # default bbox (Béjaïa, Algeria)
npm run replay -- 2026-08-26 4.2,36.1,5.6,37.0   # custom bbox: west,south,east,north
```

Needs `FIRMS_MAP_KEY` in `.env.local`. Uses Open-Meteo's historical archive
API, not current conditions.

## 5. Adapting to your region

This repo ships wired for northern Algeria. Retargeting it to another country
or region is real work across three layers — be honest with yourself about
the effort before starting:

1. **The polling bounding box.** `ALGERIA_BOX` in `lib/fire-monitor.ts` is a
   `west,south,east,north` string in degrees passed straight to the FIRMS API.
   Change it to your area of interest. The FIRMS area API caps how large a
   box you can query in one call — check
   [FIRMS API docs](https://firms.modaps.eosdis.nasa.gov/api/) if you need
   wide coverage. Widening the box also widens the odds of catching permanent
   heat sources (flares, industrial sites) — see `PERSISTENT_SOURCE_DAY_THRESHOLD`
   in the same file if you need to retune that guard.

2. **Administrative boundaries.** `lib/wilaya.ts` loads `data/wilayas.geojson`
   and does point-in-polygon lookups against it for both display and
   per-region Telegram routing. It expects GeoJSON `Polygon`/`MultiPolygon`
   features with a `properties.name` (the current data source is
   [fr33dz/Algeria-geojson](https://github.com/fr33dz/Algeria-geojson)).
   For another country, find or build an equivalent boundary file (province,
   state, department — whatever administrative level you want alerts grouped
   by) with the same shape, and swap it in. The function/variable names in
   `lib/wilaya.ts` still say "wilaya" — that's Algeria-specific naming you may
   want to rename for clarity, but it's cosmetic, not functional.

3. **The village index.** `data/villages.json` (9,635 entries for Algeria) is
   a flat array of `{osm_id, name, name_ar, lat, lon, place, wilaya}`, built
   **once, offline** by `scripts/build-village-index.ts` from a raw
   [Overpass API](https://overpass-turbo.eu/) query result — the running app
   never queries Overpass itself. To rebuild for a new region:
   - Run an Overpass query for `place` nodes (village/town/hamlet) inside
     your target area, e.g. via [overpass-turbo.eu](https://overpass-turbo.eu/):
     ```
     [out:json][timeout:120];
     area["ISO3166-1"="XX"][admin_level=2]->.a;
     node["place"~"^(city|town|village|hamlet)$"](area.a);
     out body;
     ```
     (replace `XX` with your country's ISO code), export the result as raw
     JSON.
   - Run `npx tsx scripts/build-village-index.ts <path-to-overpass-result.json>`.
     It resolves each node's wilaya via `lib/wilaya.ts`/`data/wilayas.geojson`
     — so you need step 2 done first — and refuses to overwrite the existing
     index if the result is empty or malformed, to avoid ever shipping a
     half-built one.
   - Re-run the test suite and a replay (section 4.7) against known past fires
     in your area to sanity-check the new index before trusting it live.

## 6. The dashboard

A small password-gated web dashboard at `/dashboard` (login at `/login`)
shows live and historical events on a Leaflet map, with per-event detail and
a wilaya filter. It's a read-only view over the same SQLite data the monitor
writes.

The systemd unit in section 4.4 binds it to `--hostname 127.0.0.1` —
**localhost only, not reachable from the network.** That's deliberate: there
is no rate limiting on the login endpoint and no TLS, so it is not meant to
be exposed to the public internet as-is. Reach it over SSH port forwarding
instead:

```bash
ssh -L 8423:127.0.0.1:8423 user@your-server
```

then open `http://127.0.0.1:8423/dashboard` in your local browser. The login
password is whatever you set as `DASHBOARD_PASSWORD` in `.env.local` — it's
a single shared password, not per-user accounts.

## 7. Tuning

All in `lib/fire-monitor.ts` unless noted:

- `ALGERIA_BOX` — FIRMS polling bbox (west,south,east,north).
- `CLUSTER_RADIUS_KM` (2) / `CLUSTER_TIME_HOURS` (12) — how close in space/time
  detections must be to merge into one fire event.
- `EXPOSURE_RADIUS_KM` (20) — how far from a fire a village is even considered.
- `PROXIMITY_KM` (3) — inside this radius, a village is always named regardless
  of wind direction.
- `PERSISTENT_SOURCE_DAY_THRESHOLD` (10) / `PERSISTENT_SOURCE_WINDOW_DAYS` (30)
  — a grid cell seen on more than this many distinct days in the rolling
  window is treated as a permanent heat source (flare, industrial site) and
  suppressed.
- `ALERT_SCORE_THRESHOLD` (70) — minimum score to trigger the first alert for
  an event; `ESCALATION_SCORE_DELTA` (15, duplicated in
  `app/api/monitor/route.ts`) — how much the score must grow to re-alert on an
  already-notified event.
- `SPREAD_FACTOR` (0.06) in `lib/fire-monitor.ts` and
  `DOWNWIND_MAX_DEG` (45) / `MARGINAL_MAX_DEG` (75) in `lib/wind.ts` — the
  crude spread-rate and wind-cone assumptions behind the ETA and
  downwind/marginal/upwind classification.

## 8. Limitations & responsibility

Read this before you point it at anything real:

- **Satellite latency is real.** VIIRS passes over a given point only a few
  times a day. A fire can burn for hours before the next pass sees it, and
  minutes-to-tens-of-minutes more before this system's cron cycle picks it up
  and alerts.
- **Polar orbit, not continuous coverage.** There is no "checking constantly"
  — coverage is inherently intermittent by satellite design, not a bug in
  this codebase.
- **Thermal anomalies are not confirmed fires.** Flares, industrial heat, and
  other hot sources can trigger detections; the persistent-source guard
  filters out the most obvious repeat offenders, but it is a heuristic, not
  ground truth. Every alert says "signal satellite, vérifier terrain" for a
  reason — someone still has to look.
- **Wind-based exposure is a possibility, not a prediction.** The
  downwind/ETA logic is a straight-line, constant-wind-speed rule of thumb.
  It does not model terrain, vegetation, fire behavior, or wind shifts over
  time. Treat "sous le vent, ~1-3h" as "worth a look in that direction," never
  as a forecast of where the fire will be.
- **You are responsible for how this is used.** If you deploy this, it is on
  you — not this project — to make clear to anyone receiving alerts that this
  is an unofficial, best-effort satellite-monitoring aid. It must never be
  presented, branded, or relied upon as an official emergency-warning system,
  a replacement for civil protection, or a substitute for calling the people
  who actually respond to fires.

## 9. Credits & license

- Fire detection data: **NASA FIRMS** (Fire Information for Resource
  Management System), courtesy of NASA/USGS/USDA Forest Service.
  [firms.modaps.eosdis.nasa.gov](https://firms.modaps.eosdis.nasa.gov/)
- Weather data: **Open-Meteo.com**, used under its free non-commercial
  license terms. [open-meteo.com](https://open-meteo.com/)
- Village and boundary data: **© OpenStreetMap contributors**, available
  under the [Open Database License](https://www.openstreetmap.org/copyright).

**License:** TODO — no license has been chosen for this repository yet.
Until one is added, all rights are reserved by default and this code is not
licensed for reuse by others.
