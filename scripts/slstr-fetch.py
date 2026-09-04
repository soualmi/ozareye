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
# Invoked by lib/slstr.ts (one subprocess per monitor run) to pull new
# Copernicus Sentinel-3 SLSTR Level 2 FRP (Fire Radiative Power) detections —
# a third, independent detection source alongside VIIRS (polar, ~375m,
# FIRMS) and MTG (geostationary, CAP, no real FRP). SLSTR is ALSO polar
# (same orbit family as VIIRS, ~1km resolution), so its value is DETECTION
# SENSITIVITY at its own passage times, not filling the temporal gap Meteosat
# fills — see this feature's commit/PR notes.
#
# Collection EO:EUM:DAT:0417 (SLSTR Level 2 FRP, NRT) is served through the
# same EUMETSAT Data Store as MTG_FIR's EO:EUM:DAT:0801 — same eumdac client,
# same EUMETSAT_CONSUMER_KEY/SECRET already in .env.local, no new credentials.
#
# Real measured cadence over Algeria: 4 products/day (2 from S3A, 2 from S3B)
# — confirmed during this feature's Step 0/1 access test, not the theoretical
# once-per-orbit figure.
#
# A product ships FOUR different fire-detection NetCDF files:
#   FRP_MWIR1km_standard.nc     — "the reference FRP MWIR to be considered by
#                                  default" (the file's own global attributes)
#   FRP_MWIR1km_alternative.nc  — "demonstrational level... precaution only
#                                  by expert users" (the file's own words) —
#                                  a noisier, more sensitive alternate
#                                  algorithm, NOT used here
#   FRP_SWIR500m.nc             — finer-resolution SWIR-only detections,
#                                  often empty (0 fires) in a normal pass
#   FRP_Merged_MWIR1kmStandard_SWIR1km.nc — same fire count as standard, adds
#                                  SWIR cross-reference fields, not needed
# This script parses ONLY FRP_MWIR1km_standard.nc, matching its own
# documented role as the default/reference product.
#
# Each real detection already carries a `classification` bitmask (bit 0 =
# vegetation_fire; other bits = gas flare, volcanic, industrial, solar
# panel...) — filtered here to vegetation_fire only, the same "don't let a
# known non-wildfire heat source read as a fire" philosophy lib/landuse.ts
# already applies downstream. The `fires_MWIR1km_standard` dimension is
# already a sparse per-detection list (7 rows on a real 1200x1500-pixel
# product, not a full raster) — this classification filter narrows further,
# it does not replace a raster-to-points reduction that doesn't exist here.
import argparse
import datetime
import json
import os
import sys

import eumdac
import netCDF4

COLLECTION_ID = 'EO:EUM:DAT:0417'  # SLSTR Level 2 FRP - NRT - Sentinel-3 - Copernicus
FRP_ENTRY_SUFFIX = 'FRP_MWIR1km_standard.nc'
NC_EPOCH = datetime.datetime(2000, 1, 1, tzinfo=datetime.timezone.utc)
CLASSIFICATION_VEGETATION_FIRE_BIT = 1  # flag_masks[0] in the file's own variable attributes
ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env.local')


def load_env_local():
    """Same manual .env.local parser convention as scripts/meteosat-fetch.py
    and scripts/replay.ts — there is no shared loader for standalone scripts
    in this repo (see lib/database.ts / README section 4.3)."""
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
    parser = argparse.ArgumentParser(description='Fetch new Copernicus Sentinel-3 SLSTR Level 2 FRP detections since a timestamp.')
    parser.add_argument('--since', required=True, help='ISO 8601 UTC timestamp; only products sensed strictly after this are fetched')
    parser.add_argument('--bbox', required=True, help='west,south,east,north (degrees)')
    return parser.parse_args()


def parse_since(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))


def parse_bbox(value):
    west, south, east, north = (float(x) for x in value.split(','))
    return west, south, east, north


def find_frp_entry(product):
    for entry in product.entries:
        if entry.endswith(FRP_ENTRY_SUFFIX):
            return entry
    return None


def nc_time_to_iso(microseconds_since_epoch):
    return (NC_EPOCH + datetime.timedelta(microseconds=int(microseconds_since_epoch))).strftime('%Y-%m-%dT%H:%M:%SZ')


def satellite_code(product_name):
    # "S3A_SL_2_FRP____..." / "S3B_SL_2_FRP____..." — the platform is always
    # the product name's first 3 characters, real EUMETSAT naming convention,
    # not guessed.
    return product_name[:3]


def parse_frp_detections(nc_bytes, bbox, satellite):
    # in-memory read (netCDF4's `memory=` mode) — no temp file needed, same
    # "parse the bytes directly" shape as meteosat-fetch.py's CAP XML parse.
    west, south, east, north = bbox
    ds = netCDF4.Dataset('inmemory', mode='r', memory=nc_bytes)
    try:
        n = ds.dimensions['fires_MWIR1km_standard'].size
        if n == 0:
            return []
        lat = ds.variables['latitude'][:]
        lon = ds.variables['longitude'][:]
        frp = ds.variables['FRP_MWIR'][:]
        uncertainty = ds.variables['FRP_MWIR_uncertainty'][:]
        confidence = ds.variables['confidence_MWIR'][:]
        classification = ds.variables['classification'][:]
        time_us = ds.variables['time'][:]

        detections = []
        for i in range(n):
            if not (int(classification[i]) & CLASSIFICATION_VEGETATION_FIRE_BIT):
                continue  # gas flare / volcanic / industrial / solar panel — not a wildfire signal
            lat_i, lon_i = float(lat[i]), float(lon[i])
            if not (west <= lon_i <= east and south <= lat_i <= north):
                continue
            # -1 is this product's own documented "not applicable" sentinel
            # (FRP_MWIR_uncertainty's own long_name: "-1 if only SWIR was
            # detected") — never fabricated as a real MW figure.
            uncertainty_i = float(uncertainty[i])
            detections.append({
                'lat': lat_i, 'lon': lon_i,
                'frp_mw': float(frp[i]),
                'uncertainty_mw': uncertainty_i if uncertainty_i >= 0 else None,
                'confidence': str(int(confidence[i])),
                'acquired_at': nc_time_to_iso(time_us[i]),
                'satellite': satellite,
            })
        return detections
    finally:
        ds.close()


def main():
    args = parse_args()
    since = parse_since(args.since)
    bbox = parse_bbox(args.bbox)

    env = load_env_local()
    key = env.get('EUMETSAT_CONSUMER_KEY')
    secret = env.get('EUMETSAT_CONSUMER_SECRET')
    if not key or not secret:
        print('slstr-fetch: EUMETSAT_CONSUMER_KEY/EUMETSAT_CONSUMER_SECRET missing from .env.local', file=sys.stderr)
        sys.exit(1)

    token = eumdac.AccessToken((key, secret))
    datastore = eumdac.DataStore(token)
    collection = datastore.get_collection(COLLECTION_ID)

    # eumdac's own retry/backoff on 429/5xx applies inside search()/open()
    # already — no extra retry loop here, same as scripts/meteosat-fetch.py.
    # Unlike MTG's full-disk product (bbox search is a no-op there), SLSTR
    # products are real swaths — this bbox search actually narrows which
    # products come back, in addition to the per-detection bbox filter below
    # (a product's swath can extend past the target area).
    results = collection.search(bbox=f'{bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}', dtstart=since)
    products = sorted(results, key=lambda p: p.sensing_start)

    latest_processed = None
    detection_count = 0
    for product in products:
        sensing_start = product.sensing_start.replace(tzinfo=datetime.timezone.utc)
        if sensing_start <= since:
            continue  # search's dtstart can be inclusive at the boundary — never re-emit the same product twice
        entry = find_frp_entry(product)
        if entry is None:
            print(f'slstr-fetch: no {FRP_ENTRY_SUFFIX} entry in product {product}', file=sys.stderr)
            continue
        satellite = satellite_code(str(product))
        with product.open(entry=entry) as f:
            nc_bytes = f.read()
        for det in parse_frp_detections(nc_bytes, bbox, satellite):
            print(json.dumps(det))
            detection_count += 1
        acquired_at = sensing_start.strftime('%Y-%m-%dT%H:%M:%SZ')
        latest_processed = acquired_at

    # A cursor line, distinct from detection lines (no "lat" key) — advances
    # lib/slstr.ts's "since" watermark past every product actually processed,
    # even one with zero vegetation-fire detections inside the bbox, so an
    # empty pass doesn't get re-fetched forever. Same shape as
    # scripts/meteosat-fetch.py's cursor line.
    if latest_processed is not None:
        print(json.dumps({'_cursor': latest_processed}))

    print(f'slstr-fetch: {len(products)} product(s) checked, {detection_count} detection(s) in bbox', file=sys.stderr)


if __name__ == '__main__':
    main()
