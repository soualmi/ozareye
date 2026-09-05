#!/usr/bin/env python3
# OzarEye
# Copyright (C) 2026 H. Soualmi
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published
# by the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
#
# One-time (re-)build of data/global-fire-reference.json — a global,
# pattern-based "what does a confirmed real wildfire look like at first
# detection" reference set, built from NASA FIRMS' own VIIRS ARCHIVE
# product (VIIRS_SNPP_SP, standard processing — real historical depth back
# to 2012, unlike the rolling ~2-month NRT feeds this project polls live).
# Uses the SAME FIRMS_MAP_KEY already in .env.local — no new account, no
# new credentials, confirmed working live during this feature's own Step 0.
#
# STEP 0 FINDINGS (what needed an account and what didn't):
#   - NASA MCD64A1 (MODIS/VIIRS Burned Area) via LP DAAC/Earthdata: real
#     polygon-level "this pixel burned, on this date" ground truth, the
#     strongest possible confirmation tier — but requires a free NASA
#     Earthdata Login account (instant signup, ~5 minutes: create account
#     at urs.earthdata.nasa.gov, no approval wait, unlike EUMETSAT's
#     multi-day registration this same project hit earlier this week).
#     Not set up tonight — flagged for Sid, see README/report.
#   - Google Earth Engine (MODIS/061/MCD64A1 in the public catalog):
#     same underlying data, but needs a Google account PLUS Earth Engine
#     project registration (noncommercial use case declaration) — heavier
#     signup friction than Earthdata Login, same "needs Sid" category.
#   - FIRMS' own BA_VIIRS (burned-area) source, listed in FIRMS'
#     data_availability endpoint and reachable with the EXISTING
#     FIRMS_MAP_KEY: tested live against the real catastrophic August 2023
#     Evros/Dadia (Greece) fire window — returns ONLY the active-fire CSV
#     header, never actual burned-area polygon rows. FIRMS' public
#     area/csv API is built for point active-fire detections, not the
#     raster/polygon MCD64A1 product — this path does NOT work today,
#     account or not.
#   - What DOES work, zero new signup, confirmed live: FIRMS' own VIIRS
#     ACTIVE-FIRE archive, standard-processing sources (VIIRS_SNPP_SP back
#     to 2012-01-20, VIIRS_NOAA20_SP back to 2018-04-01) — real historical
#     point detections, globally, queried with the exact same
#     FIRMS_MAP_KEY this project already has. This is what this script
#     uses. It is a WEAKER confirmation than a burn-scar polygon (see the
#     module-level honesty note in lib/firesignature.ts) — multi-day
#     persistence + escalating-then-declining FRP is a real, documented
#     wildfire behaviour, but it is a pattern proxy, not ground truth.
#
# Method: for each of a handful of well-documented real wildfire
# disasters (bounded on purpose — see this feature's token-budget note),
# query VIIRS_SNPP_SP over the real catastrophe window (two consecutive
# 5-day requests — FIRMS' area/csv API caps day_range at 5), grid-cluster
# detections into ~1km cells (same rounding convention as
# lib/fire-monitor.ts's gridCell()), and keep only cells that behave like
# a real fire: detected on >=2 distinct days AND showing real day-to-day
# FRP variation (coefficient of variation above FLAT_CV_THRESHOLD) — a
# permanent industrial/flare source repeats at nearly constant FRP, which
# is exactly what this rejects, the same philosophy as this project's own
# 30-day persistent-source guard (lib/monitor-pipeline.ts), applied
# retroactively to archive data instead of live history.
#
#   python3 scripts/build-global-fire-reference.py
import json
import os
import statistics
import sys
import time
import urllib.request
from datetime import datetime, timedelta

ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env.local')


def load_env_local():
    env = {}
    if not os.path.exists(ENV_PATH):
        return env
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            env[key] = value
    return env


# Bounded on purpose (token budget): a handful of real, well-documented,
# geographically diverse wildfire catastrophes, not an unbounded global
# crawl. Each entry's start_date is the first day of a real, well-known
# fire disaster; two consecutive 5-day windows (FIRMS' own day_range cap)
# cover its most active 10 days.
REGIONS = [
    {
        'name': 'Grèce (Evros/Dadia, août 2023 — le plus grand incendie jamais enregistré dans l\'UE)',
        'bbox': (19.0, 34.5, 29.5, 42.0),  # west, south, east, north
        'start_date': '2023-08-19',
    },
    {
        'name': 'Portugal (Pedrógão Grande, juin 2017 — 66 morts, l\'un des pires incendies de l\'histoire du pays)',
        'bbox': (-9.6, 36.5, -6.0, 42.5),
        'start_date': '2017-06-15',
    },
    {
        'name': 'Algérie/Kabylie (août 2021 — ~90 morts, catastrophe nationale)',
        'bbox': (-2.5, 34.0, 9.5, 37.5),
        'start_date': '2021-08-08',
    },
    {
        'name': 'Californie (Camp Fire, novembre 2018 — le plus meurtrier de l\'histoire de l\'État)',
        'bbox': (-124.0, 32.0, -114.0, 42.0),
        'start_date': '2018-11-05',
    },
    {
        'name': 'Australie (Black Summer, décembre 2019 — pic de la saison la plus dévastatrice)',
        'bbox': (140.0, -38.0, 153.5, -28.0),
        'start_date': '2019-12-15',
    },
]

SOURCE = 'VIIRS_SNPP_SP'
WINDOW_DAYS = 5  # FIRMS' own area/csv API caps day_range at 5
WINDOWS_PER_REGION = 2  # -> 10 real days per region
PAUSE_BETWEEN_REQUESTS_S = 1.5

# Grid cell size ~0.01deg (~1.1km) — same rounding convention as
# lib/fire-monitor.ts's gridCell(), so a reference-set cell means the same
# real-world footprint the production persistent-source guard reasons about.
CELL_DECIMALS = 2

# A cell must show up on at least this many distinct days to be a
# multi-day PATTERN at all (a single day is just one detection, not a
# persistence claim).
MIN_DISTINCT_DAYS = 2
# A cell present on MORE than this many of the 10 real days sampled starts
# looking like a permanent source that simply happened to sit inside a
# real fire-season window, not a single wildfire episode — dropped rather
# than mislabeled as "confirmed real fire" pattern.
MAX_DISTINCT_DAYS = 8
# Coefficient of variation (stdev/mean) of each cell's per-day MAX FRP.
# A flat, industrial-style heat source repeats at nearly constant FRP day
# after day; a real wildfire's FRP genuinely rises and falls as it grows,
# is fought, weather shifts, or fuel is exhausted. This threshold is a
# coarse behavioural filter, not a calibrated statistical test.
FLAT_CV_THRESHOLD = 0.15


def fetch_window(map_key, bbox, start_date):
    west, south, east, north = bbox
    url = f'https://firms.modaps.eosdis.nasa.gov/api/area/csv/{map_key}/{SOURCE}/{west},{south},{east},{north}/{WINDOW_DAYS}/{start_date}'
    with urllib.request.urlopen(url, timeout=60) as response:
        text = response.read().decode('utf-8')
    lines = text.strip().split('\n')
    if len(lines) < 2:
        return []
    header = lines[0].split(',')
    idx = {name: i for i, name in enumerate(header)}
    rows = []
    for line in lines[1:]:
        cols = line.split(',')
        try:
            rows.append({
                'lat': float(cols[idx['latitude']]),
                'lon': float(cols[idx['longitude']]),
                'frp': float(cols[idx['frp']]) if cols[idx['frp']] else 0.0,
                'confidence': cols[idx['confidence']],
                'acq_date': cols[idx['acq_date']],
                'acq_time': cols[idx['acq_time']],
                'daynight': cols[idx['daynight']],
            })
        except (KeyError, ValueError, IndexError):
            continue
    return rows


def cell_key(lat, lon):
    return (round(lat, CELL_DECIMALS), round(lon, CELL_DECIMALS))


def main():
    env = load_env_local()
    map_key = env.get('FIRMS_MAP_KEY')
    if not map_key:
        print('build-global-fire-reference: FIRMS_MAP_KEY missing from .env.local', file=sys.stderr)
        sys.exit(1)

    examples = []
    per_region_counts = {}

    for region in REGIONS:
        all_rows = []
        cur = datetime.fromisoformat(region['start_date'])
        for w in range(WINDOWS_PER_REGION):
            window_start = (cur + timedelta(days=w * WINDOW_DAYS)).strftime('%Y-%m-%d')
            print(f"{region['name']}: fetching {SOURCE} {window_start} +{WINDOW_DAYS}d ...", file=sys.stderr)
            try:
                rows = fetch_window(map_key, region['bbox'], window_start)
            except Exception as e:
                print(f"  FAILED: {e}", file=sys.stderr)
                rows = []
            print(f"  -> {len(rows)} raw detection(s)", file=sys.stderr)
            all_rows.extend(rows)
            time.sleep(PAUSE_BETWEEN_REQUESTS_S)

        # Group by ~1km cell, track per-day max FRP and the earliest
        # (first-sighting) detection's own features.
        cells = {}
        for r in all_rows:
            key = cell_key(r['lat'], r['lon'])
            if key not in cells:
                cells[key] = {'by_day': {}, 'first': None}
            c = cells[key]
            day = r['acq_date']
            if day not in c['by_day'] or r['frp'] > c['by_day'][day]:
                c['by_day'][day] = r['frp']
            ts = f"{r['acq_date']}T{r['acq_time'].zfill(4)}"
            if c['first'] is None or ts < c['first']['ts']:
                c['first'] = {'ts': ts, 'frp': r['frp'], 'confidence': r['confidence'], 'daynight': r['daynight']}

        region_count = 0
        for (lat, lon), c in cells.items():
            days = c['by_day']
            n_days = len(days)
            if n_days < MIN_DISTINCT_DAYS or n_days > MAX_DISTINCT_DAYS:
                continue
            day_max_frps = list(days.values())
            mean_frp = statistics.mean(day_max_frps)
            if mean_frp <= 0:
                continue
            cv = (statistics.pstdev(day_max_frps) / mean_frp) if len(day_max_frps) > 1 else 0.0
            if len(day_max_frps) > 1 and cv < FLAT_CV_THRESHOLD:
                continue  # too flat — looks like a permanent (industrial-style) source, not a wildfire episode
            peak_frp = max(day_max_frps)
            first = c['first']
            examples.append({
                'region': region['name'],
                'lat': lat, 'lon': lon,
                'tier': 'pattern_global',
                'firstFrpMw': round(first['frp'], 2),
                'firstConfidence': first['confidence'],
                'firstDaynight': first['daynight'],
                'firstAcquiredAt': first['ts'],
                'distinctDays': n_days,
                'peakFrpMw': round(peak_frp, 2),
                'growthRatio': round(peak_frp / first['frp'], 2) if first['frp'] > 0 else None,
                'frpCoefficientOfVariation': round(cv, 3),
            })
            region_count += 1
        per_region_counts[region['name']] = region_count
        print(f"{region['name']}: {region_count} qualifying multi-day fire-pattern cell(s) out of {len(cells)} total cells seen\n", file=sys.stderr)

    out_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'global-fire-reference.json')
    tmp_path = out_path + '.tmp'
    with open(tmp_path, 'w') as f:
        json.dump(examples, f)
    os.replace(tmp_path, out_path)

    print(f"\nWrote {len(examples)} pattern-based reference example(s) to {out_path}")
    print("Per region:")
    for name, count in per_region_counts.items():
        print(f"  {count:5d} — {name}")


if __name__ == '__main__':
    main()
