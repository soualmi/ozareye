// OzarEye
// Copyright (C) 2026 H. Soualmi
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// Scaffold tests for the Sentinel-2 dNBR burn-scar verifier (lib/burnscar.ts
// + scripts/burn-scar-verify.py). The NBR/dNBR math itself is tested in
// scripts/burn-scar-verify.test.py against hand-computed fixtures; that
// suite is run here as a subprocess so `npm test` covers it. Everything
// else here is the fail-soft contract and the storage round-trip — no real
// imagery is touched (every path exercised here fails before any network
// call; the live Planetary Computer fetch is verified by hand, see the
// wiring commit's message).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ALGERIE_FEUX_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'algerie-feux-burnscar-test-')), 'signals.db');

const { initDb, getBurnScarVerification, upsertBurnScarVerification } = await import('./database');
const { verifyBurnScar, isOldEnoughForBurnScar, BURN_SCAR_MIN_AGE_DAYS } = await import('./burnscar');
await initDb();

const SCRIPT = path.join(process.cwd(), 'scripts', 'burn-scar-verify.py');
const PY_TESTS = path.join(process.cwd(), 'scripts', 'burn-scar-verify.test.py');
const event = { id: 'evt-36.500-5.500-2026-08-20T12:00:00Z', latitude: 36.5, longitude: 5.5, firstAcquiredAt: '2026-08-20T12:00:00Z' };

test('python dNBR suite passes (hand-computed NBR/dNBR fixtures, USGS thresholds, scene picker)', () => {
  const result = spawnSync('python3', [PY_TESTS], { encoding: 'utf8' });
  assert.equal(result.status, 0, `python tests failed:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /\d+\/\d+ passed/);
  assert.doesNotMatch(result.stdout, /FAIL/);
});

test('scene windows: pre ends at detection day (exclusive), post is T+3d..T+15d', () => {
  const result = spawnSync('python3', [SCRIPT, `--event-id=${event.id}`, '--windows-only'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim());
  assert.deepEqual(out.pre_window, ['2026-07-21T00:00:00+00:00', '2026-08-20T00:00:00+00:00']);
  assert.deepEqual(out.post_window, ['2026-08-23T00:00:00+00:00', '2026-09-05T00:00:00+00:00']);
  assert.equal(out.roi_radius_m, 750);
});

test('verifyBurnScar fails soft when the python side errors (exit 1): returns null, never throws, stores nothing', async () => {
  // An unparseable date makes scripts/burn-scar-verify.py exit 1 before any
  // network call — exercises the FAILED path without touching Planetary Computer.
  const broken = { ...event, id: 'evt-broken-date', firstAcquiredAt: 'not-a-date' };
  const result = await verifyBurnScar(broken);
  assert.equal(result, null, 'a python failure must map to null');
  assert.equal(await getBurnScarVerification(broken.id), undefined, 'no row is written for a failed check');
});

test('verifyBurnScar fails soft on a broken interpreter: returns null, never throws', async () => {
  const previous = process.env.BURNSCAR_PYTHON_BIN;
  process.env.BURNSCAR_PYTHON_BIN = '/nonexistent/python-does-not-exist';
  try {
    const result = await verifyBurnScar(event);
    assert.equal(result, null);
  } finally {
    if (previous === undefined) delete process.env.BURNSCAR_PYTHON_BIN; else process.env.BURNSCAR_PYTHON_BIN = previous;
  }
});

test('burn_scar_verification round-trip: upsert then read, second upsert replaces', async () => {
  const row = {
    eventId: 'evt-test-1', preDate: '2026-08-18', postDate: '2026-08-23', dnbrMean: 0.7, classification: 'confirmé' as const,
    cloudCoverPre: 0.0002, cloudCoverPost: 16.67, verifiedAt: '2026-09-05T00:00:00Z',
  };
  await upsertBurnScarVerification(row);
  assert.deepEqual(await getBurnScarVerification('evt-test-1'), row);

  const retry = { ...row, postDate: '2026-08-28', dnbrMean: null, classification: 'indéterminé' as const, cloudCoverPost: null, verifiedAt: '2026-09-06T00:00:00Z' };
  await upsertBurnScarVerification(retry);
  assert.deepEqual(await getBurnScarVerification('evt-test-1'), retry, 'a re-check overwrites the previous verdict for the same event');
  assert.equal(await getBurnScarVerification('evt-unknown'), undefined);
});

test('isOldEnoughForBurnScar gates on the T+3d minimum post-fire wait', () => {
  const now = new Date('2026-08-23T12:00:00Z');
  assert.equal(BURN_SCAR_MIN_AGE_DAYS, 3);
  assert.equal(isOldEnoughForBurnScar({ firstAcquiredAt: '2026-08-20T12:00:00Z' }, now), true);
  assert.equal(isOldEnoughForBurnScar({ firstAcquiredAt: '2026-08-20T12:00:01Z' }, now), false);
});
