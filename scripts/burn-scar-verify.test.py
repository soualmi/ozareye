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
# Tests for scripts/burn-scar-verify.py's math, window and classification —
# everything that does NOT need real imagery (no network in this suite). Runs standalone
# (`python3 scripts/burn-scar-verify.test.py`) and under pytest
# (`pytest scripts/burn-scar-verify.test.py`); lib/burnscar.test.ts runs the
# standalone form as a subprocess so `npm test` covers it.
#
# [HAND-COMPUTED FIXTURES] The reflectance values below are synthetic but
# the expected NBR/dNBR are worked by hand from the Key & Benson (2006)
# formula NBR = (NIR - SWIR2) / (NIR + SWIR2), dNBR = NBR_pre - NBR_post:
#   healthy pre  : NIR 0.45, SWIR2 0.15 -> (0.30)/(0.60) =  0.50
#   burned post  : NIR 0.20, SWIR2 0.30 -> (-0.10)/(0.50) = -0.20
#   dNBR = 0.50 - (-0.20) = 0.70  -> USGS "high severity" (> 0.66)
# The magnitudes match the textbook picture (healthy vegetation NBR ~+0.3..
# +0.6, fresh burn NBR negative) in the UN-SPIDER burn-severity practice.
import datetime
import importlib.util
import io
import os
import sys
import contextlib

import numpy as np

sys.dont_write_bytecode = True  # keep scripts/__pycache__ out of the repo
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('burn_scar_verify', os.path.join(HERE, 'burn-scar-verify.py'))
bsv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bsv)

UTC = datetime.timezone.utc


def close(a, b, tol=1e-9):
    return abs(a - b) <= tol


def test_nbr_single_pixel_hand_computed():
    assert close(float(bsv.nbr([0.45], [0.15])[0]), 0.5)
    assert close(float(bsv.nbr([0.20], [0.30])[0]), -0.2)


def test_dnbr_textbook_burn_is_0_70():
    pre = bsv.nbr(np.array([[0.45]]), np.array([[0.15]]))
    post = bsv.nbr(np.array([[0.20]]), np.array([[0.30]]))
    d = bsv.dnbr(pre, post)
    assert close(float(d[0, 0]), 0.7)


def test_dnbr_unchanged_scene_is_zero():
    same_nir, same_swir = np.full((3, 3), 0.45), np.full((3, 3), 0.15)
    d = bsv.dnbr(bsv.nbr(same_nir, same_swir), bsv.nbr(same_nir, same_swir))
    assert np.allclose(d, 0.0)


def test_nbr_nodata_pixel_is_nan_not_crash():
    out = bsv.nbr([0.0, 0.45], [0.0, 0.15])
    assert np.isnan(out[0]) and close(float(out[1]), 0.5)


# 2x2 mixed ROI, per-pixel dNBR worked by hand:
#   p1: pre 0.45/0.15 (0.50)  post 0.20/0.30 (-0.20) -> 0.70
#   p2: pre 0.40/0.20 (1/3)   post 0.40/0.20 (1/3)   -> 0.00
#   p3: pre 0.60/0.20 (0.50)  post 0.36/0.24 (0.20)  -> 0.30
#   p4: pre 0.60/0.20 (0.50)  post 0.39/0.21 (0.30)  -> 0.20
#   mean = (0.70 + 0.00 + 0.30 + 0.20) / 4 = 0.30
NIR_PRE = np.array([[0.45, 0.40], [0.60, 0.60]])
SWIR_PRE = np.array([[0.15, 0.20], [0.20, 0.20]])
NIR_POST = np.array([[0.20, 0.40], [0.36, 0.39]])
SWIR_POST = np.array([[0.30, 0.20], [0.24, 0.21]])
SCL_CLEAR = np.full((2, 2), 4)  # 4 = vegetation


def test_dnbr_mean_mixed_roi_is_0_30():
    mean, frac = bsv.dnbr_mean(NIR_PRE, SWIR_PRE, SCL_CLEAR, NIR_POST, SWIR_POST, SCL_CLEAR)
    assert close(mean, 0.30)
    assert close(frac, 1.0)


def test_cloud_pixel_on_either_date_is_excluded_from_mean():
    scl_post = SCL_CLEAR.copy(); scl_post[1, 1] = 9  # cloud high probability on p4
    mean, frac = bsv.dnbr_mean(NIR_PRE, SWIR_PRE, SCL_CLEAR, NIR_POST, SWIR_POST, scl_post)
    assert close(frac, 0.75)
    assert close(mean, (0.70 + 0.00 + 0.30) / 3)  # p4 dropped


def test_too_cloudy_roi_yields_no_mean_and_indetermine():
    scl_pre = SCL_CLEAR.copy(); scl_pre[0, 0] = 3   # cloud shadow
    scl_post = SCL_CLEAR.copy(); scl_post[1, 1] = 10  # cirrus
    mean, frac = bsv.dnbr_mean(NIR_PRE, SWIR_PRE, scl_pre, NIR_POST, SWIR_POST, scl_post)
    assert close(frac, 0.5) and frac < bsv.MIN_VALID_PIXEL_FRACTION
    assert mean is None
    assert bsv.classify(mean) == 'indéterminé'


def test_roi_restricts_mean_and_fraction_denominator():
    # Same 2x2 as above; ROI excludes p2 (dNBR 0.0). Fraction is over ROI
    # pixels only (3/3 = 1.0), never penalised by the excluded corner.
    roi = np.array([[True, False], [True, True]])
    mean, frac = bsv.dnbr_mean(NIR_PRE, SWIR_PRE, SCL_CLEAR, NIR_POST, SWIR_POST, SCL_CLEAR, roi=roi)
    assert close(frac, 1.0)
    assert close(mean, (0.70 + 0.30 + 0.20) / 3)
    scl_post = SCL_CLEAR.copy(); scl_post[1, 1] = 9
    mean, frac = bsv.dnbr_mean(NIR_PRE, SWIR_PRE, SCL_CLEAR, NIR_POST, SWIR_POST, scl_post, roi=roi)
    assert close(frac, 2 / 3) and mean is None, '2 of 3 ROI pixels < 0.7 -> indéterminé'


def test_scl_invalid_classes_match_sen2cor_definition():
    assert bsv.valid_mask([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]).tolist() == [False, False, True, False, True, True, True, True, False, False, False, False]


def test_classification_thresholds_follow_usgs_low_severity_onset():
    assert bsv.classify(0.70) == 'confirmé'
    assert bsv.classify(0.10) == 'confirmé', 'USGS low-severity onset (0.10) is exactly where confirmé starts'
    assert bsv.classify(0.0999) == 'probable'
    assert bsv.classify(0.05) == 'probable'
    assert bsv.classify(0.0499) == 'non confirmé'
    assert bsv.classify(0.0) == 'non confirmé'
    assert bsv.classify(-0.30) == 'non confirmé'
    assert bsv.classify(None) == 'indéterminé'


def test_usgs_severity_bands():
    assert bsv.usgs_severity(0.70) == 'high'
    assert bsv.usgs_severity(0.50) == 'moderate-high'
    assert bsv.usgs_severity(0.30) == 'moderate-low'
    assert bsv.usgs_severity(0.15) == 'low'
    assert bsv.usgs_severity(0.0) == 'unburned'
    assert bsv.usgs_severity(-0.20) == 'regrowth-low'
    assert bsv.usgs_severity(-0.30) == 'regrowth-high'
    assert bsv.usgs_severity(None) is None


T0 = datetime.datetime(2026, 8, 20, 12, 0, tzinfo=UTC)


def test_scene_windows_pre_excludes_detection_day_post_is_t3_to_t15():
    pre_start, pre_end, post_start, post_end = bsv.scene_windows(T0)
    assert pre_start == datetime.datetime(2026, 7, 21, tzinfo=UTC)
    assert pre_end == datetime.datetime(2026, 8, 20, tzinfo=UTC), 'pre_end is the detection day at 00:00, exclusive'
    assert post_start == datetime.datetime(2026, 8, 23, tzinfo=UTC)
    assert post_end == datetime.datetime(2026, 9, 5, tzinfo=UTC), 'T+15 inclusive -> exclusive bound at T+16 00:00'


# The REAL Sentinel-2 L2A acquisitions over tile T31SGA (lat 36.5, lon 5.5)
# returned by the Planetary Computer STAC search run from this VPS on
# 2026-09-05 — dates and eo:cloud_cover verbatim, so the picker is exercised
# against the actual revisit cadence, not an idealised one.
REAL_CATALOGUE = [
    {'datetime': datetime.datetime(2026, 8, 18, 10, 16, tzinfo=UTC), 'cloud_cover': 0.000219},
    {'datetime': datetime.datetime(2026, 8, 20, 10, 17, tzinfo=UTC), 'cloud_cover': 33.879197},
    {'datetime': datetime.datetime(2026, 8, 23, 10, 15, tzinfo=UTC), 'cloud_cover': 16.668113},
    {'datetime': datetime.datetime(2026, 8, 28, 10, 16, tzinfo=UTC), 'cloud_cover': 8.705436},
    {'datetime': datetime.datetime(2026, 9, 2, 10, 15, tzinfo=UTC), 'cloud_cover': 86.738968},
]


def test_pick_scenes_real_cadence_latest_pre_earliest_post():
    pre, post = bsv.pick_scenes(REAL_CATALOGUE, T0)
    assert pre['datetime'].date() == datetime.date(2026, 8, 18), 'same-day 08-20 scene is NOT pre (smoke/flames), latest earlier one is'
    assert post['datetime'].date() == datetime.date(2026, 8, 23), 'earliest scene >= T+3d'


def test_pick_scenes_cloud_ceiling_skips_to_next_clear_post():
    pre, post = bsv.pick_scenes(REAL_CATALOGUE, T0, cloud_max=10)
    assert pre['datetime'].date() == datetime.date(2026, 8, 18)
    assert post['datetime'].date() == datetime.date(2026, 8, 28), '08-23 (16.7%) exceeds 10% -> 08-28 (8.7%)'


def test_pick_scenes_returns_none_when_window_empty():
    late = datetime.datetime(2026, 9, 4, 12, 0, tzinfo=UTC)
    pre, post = bsv.pick_scenes(REAL_CATALOGUE, late)
    assert pre['datetime'].date() == datetime.date(2026, 8, 28), '09-02 is 86.7% cloudy -> skipped'
    assert post is None, 'no scene yet in [T+3d, T+15d] -> caller must retry later'


def test_parse_event_id_matches_fire_monitor_format():
    lat, lon, dt = bsv.parse_event_id('evt-36.500-5.500-2026-08-20T12:00:00Z')
    assert (lat, lon) == (36.5, 5.5) and dt == T0
    lat, lon, dt = bsv.parse_event_id('evt-35.100--1.250-2026-08-20T12:00:00Z')
    assert (lat, lon) == (35.1, -1.25), 'negative longitude (western Algeria/Morocco) survives the dash split'


def test_fetch_requires_explicit_window():
    try:
        bsv.fetch_sentinel2_scene(36.5, 5.5, T0, 40)
    except ValueError as e:
        assert 'window' in str(e)
    else:
        raise AssertionError('a fetch without a (start, end) window must be rejected before any network call')


def test_dn_to_reflectance_applies_boa_offset_from_baseline_04():
    # Baseline >= 04.00: reflectance = (DN - 1000) / 10000
    assert close(float(bsv.dn_to_reflectance([5500], '05.11')[0]), 0.45)
    assert close(float(bsv.dn_to_reflectance([1000], '04.00')[0]), 0.0)
    # Older baselines: reflectance = DN / 10000, no offset
    assert close(float(bsv.dn_to_reflectance([4500], '03.01')[0]), 0.45)
    # DN 0 is no-data on every baseline -> 0.0 (so nbr() yields NaN), never -0.1
    assert float(bsv.dn_to_reflectance([0], '05.11')[0]) == 0.0
    # Values below the offset clip to 0 rather than going negative
    assert float(bsv.dn_to_reflectance([500], '05.11')[0]) == 0.0


def test_disc_mask_keeps_centre_drops_corners():
    m = bsv.disc_mask((5, 5), 2)
    assert m[2, 2] and m[0, 2] and m[2, 0]
    assert not m[0, 0] and not m[4, 4]


def test_main_windows_only_returns_0():
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = bsv.main(['--event-id', 'evt-36.500-5.500-2026-08-20T12:00:00Z', '--windows-only'])
    assert code == 0 and '"post_window": ["2026-08-23T00:00:00+00:00", "2026-09-05T00:00:00+00:00"]' in out.getvalue()


def test_result_row_shape():
    row = bsv.result_row('evt-x', {'date': T0, 'cloud_cover': 1.5}, {'date': T0 + datetime.timedelta(days=5), 'cloud_cover': 8.7}, 0.70, 1.0, 750)
    assert set(row) == {'event_id', 'pre_date', 'post_date', 'dnbr_mean', 'classification', 'usgs_severity', 'cloud_cover_pre', 'cloud_cover_post', 'valid_pixel_fraction', 'roi_radius_m', 'pre_scene', 'post_scene'}
    assert row['pre_date'] == '2026-08-20' and row['post_date'] == '2026-08-25'
    assert row['dnbr_mean'] == 0.7 and row['classification'] == 'confirmé' and row['usgs_severity'] == 'high'


if __name__ == '__main__':
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith('test_') and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn(); print(f'ok   {name}')
        except Exception as e:  # noqa: BLE001
            failed += 1; print(f'FAIL {name}: {type(e).__name__}: {e}')
    print(f'{len(tests) - failed}/{len(tests)} passed')
    sys.exit(1 if failed else 0)
