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
# Invoked by lib/meteosat.ts (one subprocess per monitor run) to pull new
# EUMETSAT MTG Active Fire Monitoring detections. Collection EO:EUM:DAT:0801
# — the CAP (Common Alerting Protocol) variant, not the netCDF one — because
# it already ships per-detection lat/lon as CAP <circle> entries; the netCDF
# variant is a raw 5568x5568 full-disk grid that would need geostationary
# projection math (pyproj) to get lat/lon at all. The tradeoff: this product
# carries no per-detection FRP or confidence (unlike VIIRS/FIRMS) — both are
# always emitted as null, honestly, rather than invented.
#
# NOTE ON NAMING: this collection is EUMETSAT's successor to the old MSG
# Active Fire Monitoring product (retired) — it runs on Meteosat Third
# Generation (satellite MTI1), not MSG. Every reference in this codebase
# says "MTG", not "MSG", for that reason.
#
# Real measured cadence: one product every 10 minutes (~144/day), not the
# 15 minutes originally assumed — confirmed by counting a full day's worth
# of products during this feature's Step 0/1 access test.
#
# Every product always covers the FULL EARTH DISK — eumdac's own --bbox
# search option filters PRODUCTS by footprint overlap, which is a no-op here
# (every product's footprint is the whole disk). The real bbox filtering
# happens below, per detection, against the circles actually parsed out of
# each product.
import argparse
import datetime
import json
import os
import sys
import xml.etree.ElementTree as ET

import eumdac

COLLECTION_ID = 'EO:EUM:DAT:0801'  # Active Fire Monitoring (CAP) - MTG - 0 degree
CAP_NS = {'cap': 'urn:oasis:names:tc:emergency:cap:1.1'}
ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env.local')


def load_env_local():
    """Same manual .env.local parser convention as scripts/replay.ts —
    there is no shared loader and no automatic env loading for standalone
    scripts in this repo (see lib/database.ts / README section 4.3)."""
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


def parse_args():
    parser = argparse.ArgumentParser(description='Fetch new EUMETSAT MTG Active Fire Monitoring detections since a timestamp.')
    parser.add_argument('--since', required=True, help='ISO 8601 UTC timestamp; only products sensed strictly after this are fetched')
    parser.add_argument('--bbox', required=True, help='west,south,east,north (degrees)')
    return parser.parse_args()


def parse_since(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))


def parse_bbox(value):
    west, south, east, north = (float(x) for x in value.split(','))
    return west, south, east, north


def find_cap_entry(product):
    for entry in product.entries:
        if entry.endswith('.xml') and entry not in ('EOPMetadata.xml', 'manifest.xml'):
            return entry
    return None


def parse_cap_circles(xml_bytes, bbox):
    west, south, east, north = bbox
    root = ET.fromstring(xml_bytes)
    detections = []
    for circle in root.findall('.//cap:circle', CAP_NS):
        text = (circle.text or '').strip()
        if not text:
            continue
        try:
            latlon, _radius = text.split(' ')
            lat_str, lon_str = latlon.split(',')
            lat, lon = float(lat_str), float(lon_str)
        except ValueError:
            continue
        if not (west <= lon <= east and south <= lat <= north):
            continue
        detections.append({'lat': lat, 'lon': lon})
    return detections


def main():
    args = parse_args()
    since = parse_since(args.since)
    bbox = parse_bbox(args.bbox)

    env = load_env_local()
    key = env.get('EUMETSAT_CONSUMER_KEY')
    secret = env.get('EUMETSAT_CONSUMER_SECRET')
    if not key or not secret:
        print('meteosat-fetch: EUMETSAT_CONSUMER_KEY/EUMETSAT_CONSUMER_SECRET missing from .env.local', file=sys.stderr)
        sys.exit(1)

    token = eumdac.AccessToken((key, secret))
    datastore = eumdac.DataStore(token)
    collection = datastore.get_collection(COLLECTION_ID)

    # eumdac's own retry/backoff on 429/5xx applies inside search()/open()
    # already (per eumdac's own docs) — no extra retry loop needed here,
    # matching this feature's "no aggressive retries" requirement.
    results = collection.search(bbox=f'{bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}', dtstart=since)
    products = sorted(results, key=lambda p: p.sensing_start)

    latest_processed = None
    detection_count = 0
    for product in products:
        sensing_start = product.sensing_start.replace(tzinfo=datetime.timezone.utc)
        if sensing_start <= since:
            continue  # search's dtstart can be inclusive at the boundary — never re-emit the same product twice
        entry = find_cap_entry(product)
        if entry is None:
            print(f'meteosat-fetch: no CAP entry in product {product}', file=sys.stderr)
            continue
        with product.open(entry=entry) as f:
            xml_bytes = f.read()
        acquired_at = sensing_start.strftime('%Y-%m-%dT%H:%M:%SZ')
        for det in parse_cap_circles(xml_bytes, bbox):
            print(json.dumps({
                'lat': det['lat'], 'lon': det['lon'],
                'frp_or_intensity': None,  # not carried by this product — see module docstring
                'confidence': None,
                'acquired_at': acquired_at,
            }))
            detection_count += 1
        latest_processed = acquired_at

    # A cursor line, distinct from detection lines (no "lat" key) — advances
    # lib/meteosat.ts's "since" watermark past every product actually
    # processed, even one with zero detections inside the bbox, so an empty
    # frame doesn't get re-fetched forever.
    if latest_processed is not None:
        print(json.dumps({'_cursor': latest_processed}))

    print(f'meteosat-fetch: {len(products)} product(s) checked, {detection_count} detection(s) in bbox', file=sys.stderr)


if __name__ == '__main__':
    main()
