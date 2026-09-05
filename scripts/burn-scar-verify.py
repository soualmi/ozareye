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
# Sentinel-2 before/after burn-scar verification for one OzarEye event —
# SCAFFOLD, pending real Sentinel-2 access (see fetch_sentinel2_scene below).
#
# Invoked by lib/burnscar.ts (one subprocess per event) exactly like
# scripts/slstr-fetch.py is by lib/slstr.ts: arguments in, one JSON line on
# stdout, non-zero exit + stderr on failure. Unlike SLSTR/Meteosat this is not
# a DETECTION source — it is a post-hoc VERIFICATION source: days after a
# thermal anomaly, does an actual burn scar show up on the ground?
#
# Method: dNBR (differenced Normalized Burn Ratio), the standard optical
# burn-severity index (Key & Benson 2006, FIREMON Landscape Assessment,
# USDA Forest Service RMRS-GTR-164-CD, chapter LA; also the UN-SPIDER
# "Burn Severity Mapping" recommended practice):
#     NBR  = (NIR - SWIR2) / (NIR + SWIR2)
#     dNBR = NBR_pre - NBR_post
# Healthy vegetation is bright in NIR and dark in SWIR2 (high NBR); a burn
# scar is dark in NIR and bright in SWIR2 (low/negative NBR), so dNBR is
# strongly POSITIVE over a fresh burn and ~0 where nothing changed.
#
# Sentinel-2 bands used (L2A, bottom-of-atmosphere reflectance):
#     NIR   = B8A (narrow NIR, 865nm, 20m)  — chosen over B08 (10m) because
#                                             B12 is only 20m; same native
#                                             grid, no resampling step
#     SWIR2 = B12 (2190nm, 20m)
#     SCL   = scene classification layer (20m) — per-pixel cloud/shadow mask
#
# Access method (decided in this feature's Step 1 research, 2026-09-05):
# Microsoft Planetary Computer STAC API + SAS-signed HTTPS COGs. Verified
# live from this VPS with NO account: the STAC search and the SAS token
# endpoint both answer anonymously (Microsoft's own docs: "The STAC API is
# public and can be accessed anonymously. Most data can be downloaded
# anonymously, but will be throttled."). Runtime deps to add when wiring the
# real fetch (none installed tonight, none needed for the math/tests):
#     pip3 install pystac-client planetary-computer rasterio
# Alternatives kept for the record: Copernicus Data Space Ecosystem (STAC
# search is anonymous too, but assets are s3://eodata URIs needing an
# account + S3 keys) and Google Earth Engine (Google account + Cloud project
# + noncommercial registration; heavier signup, but zero local raster stack).
#
# Output (one JSON object on stdout):
#   {event_id, pre_date, post_date, dnbr_mean, classification,
#    cloud_cover_pre, cloud_cover_post, valid_pixel_fraction, roi_radius_m}
# Exit codes: 0 ok, 1 error, 3 NOT_IMPLEMENTED (access not wired yet —
# lib/burnscar.ts treats 3 as "quietly unavailable", not as a source failure).
import argparse
import datetime
import json
import sys

import numpy as np

# --- Matching window --------------------------------------------------------
# Sentinel-2A/B/C combined revisit over Algeria is ~3-5 days (verified: the
# PC catalogue lists 2026-08-18, 08-20, 08-23, 08-28, 09-02 for tile T31SGA).
# "pre" = most recent acceptably clear scene strictly BEFORE first detection.
# "post" = earliest acceptably clear scene from T+3d to T+15d: not same-day
# (smoke/active flames confound NBR; the scar reads cleanly once cooled) and
# not months later (regrowth and seasonal senescence erode the signal).
PRE_LOOKBACK_DAYS = 30
POST_MIN_DAYS = 3
POST_MAX_DAYS = 15
# Scene-level cloud cover ceiling (eo:cloud_cover on the STAC item). Scene
# cover is over the whole ~110km tile — the per-pixel SCL mask inside the ROI
# is what actually decides usability; this just keeps the candidate list short.
DEFAULT_CLOUD_MAX = 40.0
# ROI: a small disc around the event point, not the whole tile. VIIRS pixels
# are ~375m and event positions carry ~1-3km uncertainty for Meteosat/SLSTR-
# anchored events, so 750m radius (~1.5km disc) covers the anomaly footprint
# while keeping the read to ~75x75 pixels at 20m.
DEFAULT_ROI_RADIUS_M = 750
# Fraction of ROI pixels that must survive the SCL cloud/shadow mask on BOTH
# dates for the dNBR mean to be trusted at all.
MIN_VALID_PIXEL_FRACTION = 0.7

# --- dNBR classification ----------------------------------------------------
# USGS / Key & Benson (2006) burn severity thresholds, as reproduced in the
# UN-SPIDER recommended practice (dNBR scaled by 1000 in the original table):
#   < -0.25        enhanced regrowth, high
#   -0.25 .. -0.10 enhanced regrowth, low
#   -0.10 .. +0.10 unburned
#   +0.10 .. +0.27 low severity
#   +0.27 .. +0.44 moderate-low severity
#   +0.44 .. +0.66 moderate-high severity
#   > +0.66        high severity
# OzarEye's three-way verdict maps onto that table rather than inventing
# numbers: "confirmé" starts exactly where USGS's "low severity" starts
# (0.10). The 0.05-0.10 "probable" band requested in the design brief sits
# INSIDE USGS's "unburned" range (-0.10..+0.10) — i.e. within the index's own
# noise floor — so it is deliberately labelled probable, never confirmé, and
# the raw dnbr_mean is always emitted alongside so a reviewer can judge.
DNBR_CONFIRMED = 0.10
DNBR_PROBABLE = 0.05

USGS_SEVERITY_BANDS = (
    (0.66, 'high'),
    (0.44, 'moderate-high'),
    (0.27, 'moderate-low'),
    (0.10, 'low'),
    (-0.10, 'unburned'),
    (-0.25, 'regrowth-low'),
)

# Sentinel-2 L2A SCL class codes (ESA Sen2Cor product definition) that
# invalidate a pixel for NBR: 0 no-data, 1 saturated/defective, 3 cloud
# shadow, 8 cloud medium prob., 9 cloud high prob., 10 thin cirrus, 11 snow.
SCL_INVALID = (0, 1, 3, 8, 9, 10, 11)

# L2A reflectance = DN / 10000, and since processing baseline 04.00
# (2022-01-25) a BOA_ADD_OFFSET of -1000 applies: reflectance = (DN-1000)/10000.
# NBR is a RATIO, so forgetting the offset biases it — the fetch stub must
# apply this using the item's s2:processing_baseline before handing arrays
# to nbr(). Kept here so the constant lives next to the math it protects.
L2A_QUANTIFICATION = 10000.0
L2A_BOA_ADD_OFFSET = -1000
L2A_OFFSET_BASELINE = '04.00'


def nbr(nir, swir2):
    """Normalized Burn Ratio, elementwise on reflectance arrays (0..1 floats).
    Pixels where NIR+SWIR2 == 0 (no-data) become NaN rather than dividing by
    zero — they are dropped by nanmean downstream."""
    nir = np.asarray(nir, dtype=np.float64)
    swir2 = np.asarray(swir2, dtype=np.float64)
    denom = nir + swir2
    with np.errstate(divide='ignore', invalid='ignore'):
        out = (nir - swir2) / denom
    out[denom == 0] = np.nan
    return out


def dnbr(nbr_pre, nbr_post):
    """Differenced NBR: pre minus post. Positive over a fresh burn."""
    return np.asarray(nbr_pre, dtype=np.float64) - np.asarray(nbr_post, dtype=np.float64)


def valid_mask(scl):
    """True where the SCL class is usable for NBR (not cloud/shadow/snow/nodata)."""
    scl = np.asarray(scl)
    return ~np.isin(scl, SCL_INVALID)


def dnbr_mean(nir_pre, swir2_pre, scl_pre, nir_post, swir2_post, scl_post):
    """Mean dNBR over pixels valid on BOTH dates. Returns (mean, valid_fraction);
    mean is None when fewer than MIN_VALID_PIXEL_FRACTION of pixels are usable."""
    mask = valid_mask(scl_pre) & valid_mask(scl_post)
    valid_fraction = float(mask.mean()) if mask.size else 0.0
    if valid_fraction < MIN_VALID_PIXEL_FRACTION:
        return None, valid_fraction
    d = dnbr(nbr(nir_pre, swir2_pre), nbr(nir_post, swir2_post))
    d = np.where(mask, d, np.nan)
    if np.all(np.isnan(d)):
        return None, valid_fraction
    return float(np.nanmean(d)), valid_fraction


def classify(dnbr_value):
    """Three-way OzarEye verdict (French labels, matching the dashboard/Telegram
    vocabulary) — see the threshold comment block above for the USGS mapping."""
    if dnbr_value is None:
        return 'indéterminé'
    if dnbr_value >= DNBR_CONFIRMED:
        return 'confirmé'
    if dnbr_value >= DNBR_PROBABLE:
        return 'probable'
    return 'non confirmé'


def usgs_severity(dnbr_value):
    """USGS/Key & Benson severity label for a dNBR value (informational)."""
    if dnbr_value is None:
        return None
    for floor, label in USGS_SEVERITY_BANDS:
        if dnbr_value >= floor:
            return label
    return 'regrowth-high'


def parse_date(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(datetime.timezone.utc)


def scene_windows(first_detection):
    """(pre_start, pre_end, post_start, post_end) as UTC datetimes.
    pre_end is exclusive: a scene acquired the same day as first detection
    may already show smoke/flames, so 'before' means the previous UTC day or
    earlier."""
    t0 = first_detection.replace(hour=0, minute=0, second=0, microsecond=0)
    pre_start = t0 - datetime.timedelta(days=PRE_LOOKBACK_DAYS)
    pre_end = t0
    post_start = t0 + datetime.timedelta(days=POST_MIN_DAYS)
    post_end = t0 + datetime.timedelta(days=POST_MAX_DAYS + 1)
    return pre_start, pre_end, post_start, post_end


def pick_scenes(candidates, first_detection, cloud_max=DEFAULT_CLOUD_MAX):
    """Choose (pre, post) from a list of {datetime, cloud_cover} dicts — the
    metadata a STAC search returns. Pure function so it is testable without
    any network: pre = latest acceptable scene before T, post = earliest
    acceptable scene in [T+3d, T+15d]. Either may be None."""
    pre_start, pre_end, post_start, post_end = scene_windows(first_detection)
    clear = [c for c in candidates if c.get('cloud_cover') is None or c['cloud_cover'] <= cloud_max]
    pre = [c for c in clear if pre_start <= c['datetime'] < pre_end]
    post = [c for c in clear if post_start <= c['datetime'] < post_end]
    pre_scene = max(pre, key=lambda c: c['datetime']) if pre else None
    post_scene = min(post, key=lambda c: c['datetime']) if post else None
    return pre_scene, post_scene


def parse_event_id(event_id):
    """lib/fire-monitor.ts builds ids as `evt-<lat.3f>-<lon.3f>-<ISO acquiredAt>`;
    the sign of lon may itself be '-', so split from the left on the known
    prefix and take exactly two numeric fields. Returns (lat, lon, datetime)."""
    if not event_id.startswith('evt-'):
        raise ValueError(f'not an OzarEye event id: {event_id}')
    rest = event_id[len('evt-'):]
    parts = rest.split('-')
    # lat is parts[0] (never negative for our regions but handle '-' anyway)
    idx = 0
    lat_str = parts[idx]
    if lat_str == '':
        idx += 1; lat_str = '-' + parts[idx]
    idx += 1
    lon_str = parts[idx]
    if lon_str == '':
        idx += 1; lon_str = '-' + parts[idx]
    idx += 1
    date_str = '-'.join(parts[idx:])
    return float(lat_str), float(lon_str), parse_date(date_str)


def fetch_sentinel2_scene(lat, lon, date, cloud_max, roi_radius_m=DEFAULT_ROI_RADIUS_M, window=None):
    """STUB — real Sentinel-2 access is not wired yet (no account/deps tonight).

    TODO(sentinel-2 access): implement against Microsoft Planetary Computer
    (recommended, Step 1 of this feature; anonymous read access verified from
    this VPS on 2026-09-05):
      1. pystac_client.Client.open('https://planetarycomputer.microsoft.com/api/stac/v1',
             modifier=planetary_computer.sign_inplace)
      2. search(collections=['sentinel-2-l2a'], intersects=Point(lon, lat),
             datetime=f'{window_start}/{window_end}',
             query={'eo:cloud_cover': {'lte': cloud_max}}) -> items
      3. pick_scenes() above chooses pre/post from items' datetime +
         eo:cloud_cover; the item's `s2:processing_baseline` decides whether
         L2A_BOA_ADD_OFFSET applies.
      4. rasterio.open(item.assets['B8A'].href) / ['B12'] / ['SCL'] and read
         ONLY the ROI window: a roi_radius_m disc around (lat, lon) projected
         into the item's UTM EPSG (proj:epsg) — ~75x75 px at 20m, a few
         hundred KB of HTTP range requests per band, never the whole tile.
      5. Return dict(nir=..., swir2=..., scl=..., date=item.datetime,
         cloud_cover=item.properties['eo:cloud_cover']) with nir/swir2 already
         converted to reflectance ((DN + offset) / L2A_QUANTIFICATION).
    Deps: pip3 install pystac-client planetary-computer rasterio
    """
    raise NotImplementedError('Sentinel-2 access not wired yet — see fetch_sentinel2_scene() TODO (Planetary Computer STAC + SAS)')


def verify_event(event_id, lat, lon, first_detection, cloud_max=DEFAULT_CLOUD_MAX, roi_radius_m=DEFAULT_ROI_RADIUS_M):
    pre_start, pre_end, post_start, post_end = scene_windows(first_detection)
    pre = fetch_sentinel2_scene(lat, lon, first_detection, cloud_max, roi_radius_m, window=(pre_start, pre_end))
    post = fetch_sentinel2_scene(lat, lon, first_detection, cloud_max, roi_radius_m, window=(post_start, post_end))
    if pre is None or post is None:
        return result_row(event_id, pre, post, None, 0.0, roi_radius_m)
    mean, valid_fraction = dnbr_mean(pre['nir'], pre['swir2'], pre['scl'], post['nir'], post['swir2'], post['scl'])
    return result_row(event_id, pre, post, mean, valid_fraction, roi_radius_m)


def result_row(event_id, pre, post, mean, valid_fraction, roi_radius_m):
    return {
        'event_id': event_id,
        'pre_date': pre['date'].strftime('%Y-%m-%d') if pre else None,
        'post_date': post['date'].strftime('%Y-%m-%d') if post else None,
        'dnbr_mean': None if mean is None else round(mean, 4),
        'classification': classify(mean),
        'usgs_severity': usgs_severity(mean),
        'cloud_cover_pre': pre.get('cloud_cover') if pre else None,
        'cloud_cover_post': post.get('cloud_cover') if post else None,
        'valid_pixel_fraction': round(valid_fraction, 3),
        'roi_radius_m': roi_radius_m,
    }


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description='Sentinel-2 dNBR burn-scar verification for one OzarEye event (scaffold).')
    parser.add_argument('--event-id', help='OzarEye event id (evt-<lat>-<lon>-<ISO>); lat/lon/date are parsed from it')
    parser.add_argument('--lat', type=float)
    parser.add_argument('--lon', type=float)
    parser.add_argument('--date', help='ISO 8601 first-detection timestamp (UTC)')
    parser.add_argument('--cloud-max', type=float, default=DEFAULT_CLOUD_MAX, help='scene-level eo:cloud_cover ceiling, percent')
    parser.add_argument('--roi-radius-m', type=int, default=DEFAULT_ROI_RADIUS_M)
    parser.add_argument('--windows-only', action='store_true', help='print the computed pre/post search windows as JSON and exit (no fetch)')
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    explicit = args.lat is not None and args.lon is not None and bool(args.date)
    if args.event_id and explicit:
        # lib/burnscar.ts passes both: the id for storage, and the event's
        # CURRENT centroid/firstAcquiredAt (the id only encodes the first
        # detection pixel, and the centroid moves as pixels join).
        lat, lon, first_detection = args.lat, args.lon, parse_date(args.date)
        event_id = args.event_id
    elif args.event_id:
        lat, lon, first_detection = parse_event_id(args.event_id)
        event_id = args.event_id
    elif explicit:
        lat, lon, first_detection = args.lat, args.lon, parse_date(args.date)
        event_id = f'evt-{lat:.3f}-{lon:.3f}-{first_detection.strftime("%Y-%m-%dT%H:%M:%SZ")}'
    else:
        print('need --event-id or all of --lat --lon --date', file=sys.stderr)
        return 1

    if args.windows_only:
        pre_start, pre_end, post_start, post_end = scene_windows(first_detection)
        print(json.dumps({
            'event_id': event_id, 'lat': lat, 'lon': lon,
            'pre_window': [pre_start.isoformat(), pre_end.isoformat()],
            'post_window': [post_start.isoformat(), post_end.isoformat()],
            'cloud_max': args.cloud_max, 'roi_radius_m': args.roi_radius_m,
        }))
        return 0

    try:
        row = verify_event(event_id, lat, lon, first_detection, args.cloud_max, args.roi_radius_m)
    except NotImplementedError as e:
        print(f'NOT_IMPLEMENTED: {e}', file=sys.stderr)
        return 3
    except Exception as e:  # noqa: BLE001 — subprocess boundary, lib/burnscar.ts reads stderr
        print(f'{type(e).__name__}: {e}', file=sys.stderr)
        return 1
    print(json.dumps(row))
    return 0


if __name__ == '__main__':
    sys.exit(main())
