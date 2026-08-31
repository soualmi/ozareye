// Algérie Feux Alerte
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

// Covers Part A (the config store) and the specific claim the /setup feature
// rests on: the engine reads its bbox/tunables from a value passed in
// (ultimately sourced from lib/database.ts's config table), not from a
// hardcoded module constant. ALGERIE_FEUX_DB_PATH points database.ts at a
// throwaway file so this never touches the real, possibly-live data/signals.db —
// must be set before database.ts is first imported, hence the dynamic imports.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Type-only — erased at compile time, so this doesn't trigger fire-monitor.ts's
// module evaluation before ALGERIE_FEUX_DB_PATH is set below.
import type { Detection, FireEvent, VillageExposure } from './fire-monitor';

process.env.ALGERIE_FEUX_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'algerie-feux-config-test-')), 'signals.db');

const { getConfig, updateConfig, initDb } = await import('./database');
const { clusterDetections, selectExposedVillages, DEFAULT_FRP_THRESHOLD_MW, DEFAULT_PROXIMITY_KM, DEFAULT_BOX } = await import('./fire-monitor');

await initDb();

test('getConfig migrates the shipped Algeria defaults on first call, configured:true', async () => {
  const config = await getConfig();
  assert.equal(config.countryName, 'Algérie');
  assert.equal(config.countryIso2, 'DZ');
  assert.equal(config.configured, true, 'the existing instance ships with working data, so migration must not present it as unconfigured');
  const [west, south, east, north] = DEFAULT_BOX.split(',').map(Number);
  assert.deepEqual(config.bbox, { west, south, east, north });
  assert.equal(config.frpThresholdMw, DEFAULT_FRP_THRESHOLD_MW);
  assert.equal(config.proximityKm, DEFAULT_PROXIMITY_KM);
});

test('updateConfig persists a new region/tunables and getConfig reflects it afterwards', async () => {
  const updated = await updateConfig({
    countryName: 'Luxembourg', countryIso2: 'LU', countryIso3: 'LUX',
    bbox: { west: 5.7, south: 49.4, east: 6.5, north: 50.2 },
    frpThresholdMw: 12, proximityKm: 2.5, persistentSourceDays: 6,
  });
  assert.equal(updated.countryName, 'Luxembourg');
  assert.deepEqual(updated.bbox, { west: 5.7, south: 49.4, east: 6.5, north: 50.2 });

  const reread = await getConfig();
  assert.equal(reread.countryName, 'Luxembourg');
  assert.equal(reread.frpThresholdMw, 12);
  assert.equal(reread.proximityKm, 2.5);
  assert.equal(reread.persistentSourceDays, 6);
});

function det(overrides: Partial<Detection>): Detection {
  return { latitude: 49.8, longitude: 6.1, acquiredAt: '2026-01-01T00:00:00Z', satellite: 'N20', instrument: 'VIIRS', confidence: 'h', frp: 10, ...overrides };
}

test('clusterDetections scores the same detection differently when given a different frpThresholdMw — not hardcoded', () => {
  // FRP 10MW: below the DEFAULT threshold's high band (needs >=20) but above
  // its mid band (>=8) — scores the mid bonus (+12) by default.
  const [withDefault] = clusterDetections([det({ frp: 10 })], [], DEFAULT_FRP_THRESHOLD_MW);
  // The same 10MW detection against a LOWERED threshold of 8 now clears the
  // high band outright (10 >= 8) — scores the high bonus (+20) instead.
  const [withLoweredThreshold] = clusterDetections([det({ frp: 10 })], [], 8);

  assert.ok(withLoweredThreshold.score > withDefault.score, `expected a lower configured threshold to score higher for the same 10MW detection (got ${withLoweredThreshold.score} vs default ${withDefault.score})`);
});

function exposedEvent(distanceKm: number, relation: VillageExposure['relation']): FireEvent {
  return {
    id: 'evt-test', latitude: 49.8, longitude: 6.1,
    detections: [det({})], firstAcquiredAt: '2026-01-01T00:00:00Z', lastAcquiredAt: '2026-01-01T00:00:00Z',
    maxFrp: 10, maxConfidence: 'h', passCount: 1, maxPixelsInSinglePass: 1,
    score: 90, status: 'urgent', evidence: [], evidenceShort: [],
    villages: [{ osm_id: 'v1', name: 'Testville', name_ar: null, wilaya: 'Test', lat: 49.81, lon: 6.11, distanceKm, relation }],
  };
}

test('selectExposedVillages includes/excludes a village based on the passed proximityKm — not a hardcoded radius', () => {
  // An UPWIND village never qualifies via the downwind-fill path regardless of
  // threshold — only the proximity path can surface it, so this isolates
  // proximityKm specifically (not relation logic, already covered elsewhere).
  const event = exposedEvent(4, 'upwind');

  const withDefaultProximity = selectExposedVillages(event, DEFAULT_PROXIMITY_KM); // 3km — 4km village excluded
  assert.equal(withDefaultProximity.length, 0, 'a 4km upwind village must not appear under the default 3km proximity radius');

  const withWiderProximity = selectExposedVillages(event, 5); // 5km — 4km village now within radius
  assert.equal(withWiderProximity.length, 1, 'the same 4km upwind village must appear once proximityKm is widened past its distance');
  assert.equal(withWiderProximity[0].isProximity, true);
});
