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

// "Détection précoce" — three additive score boosts (lib/fire-monitor.ts),
// adapted from the original per-pixel-temperature-slope idea because MTG's
// CAP product carries no such time series (see this feature's Step 1
// product inspection). Signal 1 (zoning) and 3 (Meteosat persistence) are
// pure and tested directly against clusterDetections()/scoreEvent(). Signal
// 2 (FRP anomaly vs local history) is split: scoreEvent()'s own boost logic
// is pure (tested via the baselineFrpExceeded flag directly), while the DB
// layer that computes that flag (app/api/monitor/route.ts's
// annotateFrpAnomaly, not exported/tested here) is fail-soft by
// construction — recordFrpObservation/frpBaseline (lib/database.ts) are
// tested directly instead, including the "no history yet" case.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clusterDetections, EARLY_DETECTION_ANOMALY_MIN_SAMPLES, EARLY_DETECTION_ANOMALY_MULTIPLIER, type Detection } from './fire-monitor';

process.env.ALGERIE_FEUX_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'algerie-feux-early-detection-test-')), 'signals.db');

const { initDb, recordFrpObservation, frpBaseline } = await import('./database');
await initDb();

// A real village (Constantine city center, data/villages.json) — deterministic "near" fixture.
const NEAR_VILLAGE_LAT = 36.3641642, NEAR_VILLAGE_LON = 6.6084281;
// Confirmed (this feature's verification) >=50km from the nearest real village in data/villages.json.
const FAR_LAT = 34.3641642, FAR_LON = 8.6084281;

function viirsDet(overrides: Partial<Detection> = {}): Detection {
  return { latitude: FAR_LAT, longitude: FAR_LON, acquiredAt: '2026-01-01T00:00:00Z', satellite: 'N20', instrument: 'VIIRS', confidence: 'h', frp: 10, ...overrides };
}
function meteosatDet(overrides: Partial<Detection> = {}): Detection {
  return { latitude: FAR_LAT, longitude: FAR_LON, acquiredAt: '2026-01-01T00:00:00Z', satellite: 'MTI1', instrument: 'FCI', confidence: '', frp: 0, ...overrides };
}

test('signal 1 (zoning): an event near a village scores higher than an identical one far from any village', () => {
  const [near] = clusterDetections([viirsDet({ latitude: NEAR_VILLAGE_LAT, longitude: NEAR_VILLAGE_LON })], []);
  const [far] = clusterDetections([viirsDet({ latitude: FAR_LAT, longitude: FAR_LON })], []);
  assert.ok(near.score > far.score, `near-village score (${near.score}) must exceed far-from-any-village score (${far.score})`);
  assert.ok(near.evidenceShort.includes('zone+'), 'evidence records the zoning boost applied');
  assert.ok(!far.evidenceShort.includes('zone+'), 'no zoning boost far from any village');
});

test('signal 2 (FRP anomaly): a detection flagged above its local baseline scores higher than an identical unflagged one', () => {
  const base = viirsDet({ frp: 8 }); // deliberately low absolute FRP — the point is the boost fires on the ANOMALY, not the absolute value
  const [withoutBoost] = clusterDetections([base], []);
  const [withBoost] = clusterDetections([{ ...base, baselineFrpExceeded: true }], []);
  assert.ok(withBoost.score > withoutBoost.score, `anomaly-flagged score (${withBoost.score}) must exceed unflagged (${withoutBoost.score})`);
  assert.ok(withBoost.evidenceShort.includes('anomalie'));
  assert.ok(!withoutBoost.evidenceShort.includes('anomalie'));
});

test('signal 2: a cell/hour with no recorded history returns null cleanly, never throws', async () => {
  const result = await frpBaseline('never-seen-cell', 12, '2020-01-01');
  assert.equal(result, null, 'missing history -> null, the caller (route.ts) treats this as "skip, no boost, no penalty"');
});

test('signal 2: recordFrpObservation/frpBaseline compute a real average, gated by minimum sample count', async () => {
  const cell = 'test-cell-1';
  await recordFrpObservation(cell, '2026-01-01', 14, 10);
  await recordFrpObservation(cell, '2026-01-02', 14, 20);
  const tooFew = await frpBaseline(cell, 14, '2020-01-01');
  assert.equal(tooFew?.days, 2);
  assert.ok((tooFew?.days ?? 0) < EARLY_DETECTION_ANOMALY_MIN_SAMPLES, 'sanity: below the min-samples gate route.ts enforces before ever applying the boost');

  await recordFrpObservation(cell, '2026-01-03', 14, 15);
  const enough = await frpBaseline(cell, 14, '2020-01-01');
  assert.equal(enough?.days, 3);
  assert.equal(enough?.avgFrp, (10 + 20 + 15) / 3, `a real detection would need FRP >= avg * ${EARLY_DETECTION_ANOMALY_MULTIPLIER} to be flagged`);

  const otherHour = await frpBaseline(cell, 3, '2020-01-01');
  assert.equal(otherHour, null, 'hour-of-day is part of the key — a different hour at the same cell has no history of its own yet');
});

test('signal 3 (Meteosat persistence): a VIIRS event with >=2 Meteosat passes scores higher than one with 0-1', () => {
  const zeroPasses = clusterDetections([viirsDet()], [])[0];

  let onePassEvents = clusterDetections([viirsDet()], []);
  onePassEvents = clusterDetections([meteosatDet({ acquiredAt: '2026-01-01T00:10:00Z' })], onePassEvents);
  const onePass = onePassEvents[0];

  let twoPassEvents = clusterDetections([viirsDet()], []);
  twoPassEvents = clusterDetections([meteosatDet({ acquiredAt: '2026-01-01T00:10:00Z' })], twoPassEvents);
  twoPassEvents = clusterDetections([meteosatDet({ acquiredAt: '2026-01-01T00:40:00Z' })], twoPassEvents);
  const twoPass = twoPassEvents[0];

  assert.equal(onePass.geoTracked, true, 'sanity: geoTracked itself only requires >=1 Meteosat pass');
  assert.ok(!onePass.evidence.some(e => e.includes('Corroboré par Meteosat')), 'the persistence BOOST (distinct from geoTracked) requires >=2 passes, not 1');
  assert.ok(twoPass.evidence.some(e => e.includes('Corroboré par Meteosat (2 passages)')));
  assert.ok(twoPass.score > onePass.score, `2-pass score (${twoPass.score}) must exceed 1-pass (${onePass.score})`);
  assert.ok(onePass.score > zeroPasses.score, 'sanity: the existing generic cross-pass corroboration bonus still applies at 1 pass too');
});
