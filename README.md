# OzarEye

## 1. What this is

OzarEye is a self-hosted wildfire alert system built around NASA's FIRMS
satellite thermal-anomaly feed. It polls FIRMS on a schedule, clusters raw
pixel detections into fire events, cross-references each event against a
village index and live wind data to work out who's downwind, and sends a
Telegram alert naming the exposed villages. It also ships a small
password-protected web dashboard for browsing live and historical events on
a map. It's a multi-country tool — the bounding box, village index, and
admin boundaries are all configurable per instance (see the `/setup` screen,
and [section 5](#5-adapting-to-your-region)) — but it ships defaulted to and
worked out on northern Algeria, so that's what the examples below use.

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
- **A free NASA FIRMS map key.** This is the credential the FIRMS satellite
  feed itself requires — the app has no built-in key of its own to share.
  1. Go to [firms.modaps.eosdis.nasa.gov/api/map_key](https://firms.modaps.eosdis.nasa.gov/api/map_key/).
  2. Enter your email address and submit the form.
  3. Your map key appears immediately on that same page (and is emailed to
     you too) — no approval wait, no payment, no account needed.
  4. Copy it — you'll paste it into `FIRMS_MAP_KEY` (via `/setup` in the app,
     or `.env.local` — see section 4.1).

- **A Telegram bot token.** This is what lets the app send messages *as*
  your own bot, so alerts don't come from some shared/anonymous account.
  1. Open Telegram and search for **@BotFather** (Telegram's own official
     bot for creating other bots), then start a chat with it.
  2. Send it the command `/newbot`.
  3. Pick a display name for your bot — anything you like, e.g. "My Fire
     Alerts".
  4. Pick a username for it — must be unique and end in `bot`, e.g.
     `my_fire_alerts_bot`.
  5. BotFather replies with a **token**: a long string that looks like
     `123456789:ABCdefGhIJKlmNoPQRstuVWxyz`. Copy it — you'll paste it into
     `TELEGRAM_BOT_TOKEN`.

- **A Telegram chat/channel id.** This tells the app *where* to send those
  messages — a bot can't message a chat it doesn't know about yet.
  1. Decide where you want alerts to land: a private chat with yourself, a
     group, or a channel.
  2. Add your bot to it — for a channel, add it as an **admin**; for a group
     or a DM, adding it as a member is enough.
  3. Send any message in that chat (even just "hello") so Telegram has
     something to report back to you.
  4. In a browser, visit
     `https://api.telegram.org/bot<TOKEN>/getUpdates`, replacing `<TOKEN>`
     with the real bot token from the previous step.
  5. In the JSON that comes back, find `"chat":{"id":...` — that number
     (often starting with `-100` for groups/channels) is the chat id. Copy
     it — you'll paste it into `TELEGRAM_CHAT_ID`.

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

### 4.2 Build

```bash
npm run build
```

This runs `vinext build` (the app is built on
[vinext](https://github.com/cloudflare/vinext), a Vite-based Next.js-compatible
toolchain) and produces a `dist/` directory. `vite.config.ts` also references a
local `.openai/hosting.json` hosting artifact left over from this project's
original Cloudflare-hosted scaffold (unrelated to your `.env.local`) — it's
git-ignored, and the build creates a harmless local placeholder for it
automatically if it's missing, so there's nothing to do here.
Run the test suite first if you want confidence before deploying — see
section 4.5.

### 4.3 Run it as a systemd service

Create `/etc/systemd/system/algerie-feux.service` (adjust `WorkingDirectory`
and the `node` path to match your install):

```ini
[Unit]
Description=OzarEye - fire monitor web/API server
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

`vinext start` serves the `dist/` output built in step 4.2 — it does not
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

### 4.4 Install the cron trigger

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

### 4.5 Run the tests

```bash
npm run test        # all four suites below
npm run test:wind    # wind direction FROM→TOWARD conversion — get this backwards and every exposure classification inverts silently
npm run test:labels
npm run test:wilaya
npm run test:clustering
```

### 4.6 Try a historical replay before going live

Re-runs the real pipeline over past FIRMS dates and writes down what the
engine would have said — without sending anything — useful to sanity-check
scoring and village selection before you trust it with real alerts:

```bash
npm run replay -- 2026-08-26                                     # one day, default paths
npm run replay -- --from 2026-08-25 --to 2026-08-29 \
  --db data/replay-20260826.db --out replay-out/20260826         # a range
npm run replay -- --out replay-out/20260826 --render-only        # rebuild report.md only
npm run replay -- --db data/replay-20260826.db \
  --out replay-out/20260826 --reevaluate-landuse                 # re-score land-use, no re-fetch
```

`--reevaluate-landuse` re-scores every event already stored at `--db` against
the CURRENT `lookupLandUse()` (the local index, see section 5.4) and
re-renders `report.md`/`messages/` — no FIRMS or weather calls. Useful for a
replay run made before `data/industrial-sites.json` existed, when Overpass
was the only path and may have been unreachable.

Each day is walked in 20-minute buckets, the production cron cadence, so an
event is only ever scored and rendered on the evidence that poll would have
had. Outputs land in `--out`: `events.json`, `report.md` (grouped by wilaya),
`run-notes.md` (what differed from live) and `messages/*.txt` (rendered alert
texts, never sent).

Needs `FIRMS_MAP_KEY` in `.env.local`. Uses Open-Meteo's historical archive
API, not current conditions. Writes only to `--db`, never to
`data/signals.db` — it refuses to start if pointed at it.

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
   **once, offline** from OpenStreetMap — the running app never queries
   OpenStreetMap or Overpass itself at request time. To rebuild it for a new
   region (or refresh Algeria's), run `scripts/build-villages.ts`, which
   queries the public [Overpass API](https://overpass-api.de/) live for
   `place` nodes (city/town/village/hamlet) in a bounding box and attributes
   each one to a region via `lib/wilaya.ts`/`data/wilayas.geojson` — so you
   need step 2 done first:
   ```bash
   npx tsx scripts/build-villages.ts <west,south,east,north> [output-path]
   # e.g. a small test run over just central Béjaïa:
   npx tsx scripts/build-villages.ts 5.03,36.73,5.10,36.79 /tmp/villages-test.json
   ```
   It refuses to write anything if the query returns zero villages inside any
   boundary, to avoid ever shipping a half-built index — try a small bbox
   first (as above) before running it over an entire country, both to sanity
   check the output and because Overpass's public instance rate-limits and
   times out large queries. `scripts/build-village-index.ts` is the older,
   lower-level counterpart: it does the same transform and wilaya attribution
   but reads an already-fetched raw Overpass JSON dump instead of querying
   the network itself — useful if you already have one (e.g. exported from
   [overpass-turbo.eu](https://overpass-turbo.eu/) with a custom query) or
   want to avoid depending on the public Overpass API being up.
   - Re-run the test suite and a replay (section 4.6) against known past fires
     in your area to sanity-check the new index before trusting it live.

4. **The industrial-site index.** `data/industrial-sites.json` is a flat
   array of `{osm_id, type, tag, name, lat, lon, bounds, radius_m}` — `bounds`
   is a way/relation's real footprint (`{minlat,minlon,maxlat,maxlon}`, null
   for a node) and `radius_m` its half-diagonal; a detection inside `bounds`
   counts as a hit however far that is from `lat`/`lon`, not just within 1km
   of the centre. Built **once, offline**, the same way as the village index — `lib/landuse.ts` (which
   tags a detection sitting on a known industrial/energy site: a steel plant,
   a gas flare, a quarry, a landfill, ...) never queries Overpass at request
   time as long as this file exists. To rebuild it (or regenerate it for a
   new region's bbox, from the region's config):
   ```bash
   npm run build-industrial-index
   ```
   It walks the configured bbox in ~1°×1° tiles, one Overpass query per tile
   (retried across the same full-planet mirrors `lib/landuse.ts` uses —
   never a regional extract, see the comment there), with a pause between
   tiles and a progress checkpoint (`data/.industrial-index-progress.json`,
   gitignored) written after every tile, so a killed/crashed run resumes
   instead of starting over. This is a slow, occasional job (tens of minutes
   over the public mirrors) — land use doesn't change, so it's meant to be
   run once and re-run only after a bbox change, not on any schedule.
   `lib/landuse.ts` falls back to a live Overpass lookup (same
   breaker/mirror logic as before) only when this file is missing or
   unreadable — e.g. a fresh clone that hasn't run the build script yet.
   After building the index for the first time on a running instance,
   `npx tsx scripts/backfill-landuse.ts` re-evaluates every stored event
   still sitting at `landUse.context: 'unknown'` (left over from when
   Overpass was the only path) against the new local index — events already
   tagged `industrial`/`natural` are left untouched.

5. **The fire-station index.** `data/fire-stations.json` is a flat array of
   `{osm_id, name, lat, lon, phone}` — every OSM `amenity=fire_station`
   inside the configured bbox, built **once, offline** by
   `scripts/build-firestation-index.ts` exactly the way the industrial index
   is (same tile walk, same full-planet mirrors, same resume checkpoint at
   `data/.firestation-index-progress.json`, gitignored). `lib/firestation.ts`
   answers "nearest caserne to this event" with a plain haversine scan over
   it (a few hundred entries — no grid needed) and feeds the "Caserne la plus
   proche : … — X km" line on the dashboard card/popup/detail and in the
   Telegram message. `phone` is the station's own OSM `phone`/`contact:phone`
   tag or `null` — never inferred; the dashboard's tel: link falls back to
   the national Protection Civile number (`lib/emergency-numbers.ts`, which
   also feeds the always-visible emergency-numbers panel — replace those
   constants for a new country, they are Algeria's). A missing index fails
   soft: no station line anywhere, nothing else affected.
   ```bash
   npm run build-firestation-index
   ```

## 6. The dashboard

A small password-gated web dashboard at `/dashboard` (login at `/login`)
shows live and historical events on a Leaflet map, with per-event detail and
a wilaya filter. It's a read-only view over the same SQLite data the monitor
writes.

The systemd unit in section 4.3 binds it to `--hostname 127.0.0.1` —
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
- **It only monitors while it's actually running.** The 24/7 uptime
  requirement in section 3 isn't a nice-to-have — it's the difference between
  this working and not. A laptop that's asleep, closed, powered off, or an
  instance that's been stopped for any reason, monitors nothing during that
  entire gap, silently, with no error and no warning. There is no catch-up:
  when it comes back, it picks up whatever FIRMS has *now*, not what
  happened while it was off. A fire that starts and is confirmed by
  neighbors while your machine was asleep will never produce an alert,
  before or after the fact. If you can't keep something on 24/7, this tool
  cannot do its one job.
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

**License:** [AGPL-3.0](LICENSE) — free to use and modify, but any distributed
or network-hosted version of this code (including running your own instance
that others interact with) must publish its source under the same license.

## Auteur / Author

H. Soualmi — [soualmih@gmail.com](mailto:soualmih@gmail.com)
