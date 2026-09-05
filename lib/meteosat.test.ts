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

// Proves the locked Meteosat fusion rules (a-e) that clusterDetections()/
// scoreEvent() in lib/fire-monitor.ts implement, plus fetchMeteosatSlots()'s
// (lib/meteosat.ts) fail-soft contract: an ingestion failure there must
// never throw, never block, and never affect the VIIRS-only path.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clusterDetections, type Detection } from './fire-monitor';

process.env.ALGERIE_FEUX_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'algerie-feux-meteosat-test-')), 'signals.db');

const { initDb } = await import('./database');
const { fetchMeteosatSlots } = await import('./meteosat');
await initDb();

function viirsDet(overrides: Partial<Detection> = {}): Detection {
  return { latitude: 36.5, longitude: 5.5, acquiredAt: '2026-01-01T00:00:00Z', satellite: 'N20', instrument: 'VIIRS', confidence: 'h', frp: 10, ...overrides };
}
function meteosatDet(overrides: Partial<Detection> = {}): Detection {
  return { latitude: 36.501, longitude: 5.501, acquiredAt: '2026-01-01T00:00:00Z', satellite: 'MTI1', instrument: 'FCI', confidence: '', frp: 0, ...overrides };
}

test('rule a: a Meteosat detection never moves the position of an event with a VIIRS pass', () => {
  const [event] = clusterDetections([viirsDet()], []);
  const originalLat = event.latitude, originalLon = event.longitude;

  const [updated] = clusterDetections([meteosatDet({ acquiredAt: '2026-01-01T00:10:00Z' })], [event]);

  assert.equal(updated.latitude, originalLat, 'latitude must be exactly the VIIRS position, untouched by the Meteosat pixel');
  assert.equal(updated.longitude, originalLon);
  assert.equal(updated.positionSource, 'viirs');
  assert.equal(updated.geoTracked, true, 'a VIIRS-anchored event with a Meteosat pass must be marked geoTracked');
  assert.equal(updated.detections.length, 2, 'the Meteosat pass is still attached as a pass, just never moves the position');
});

test('rule b: a second Meteosat-only detection averages into the position (still approximate)', () => {
  const [event] = clusterDetections([meteosatDet({ latitude: 36.500, longitude: 5.500, acquiredAt: '2026-01-01T00:00:00Z' })], []);
  assert.equal(event.positionSource, 'meteosat');

  const [updated] = clusterDetections([meteosatDet({ latitude: 36.502, longitude: 5.500, acquiredAt: '2026-01-01T00:10:00Z' })], [event]);
  assert.equal(updated.latitude, (36.500 + 36.502) / 2, 'position is the mean of the two Meteosat detections');
  assert.equal(updated.longitude, 5.500);
  assert.equal(updated.positionSource, 'meteosat', 'still approximate — no VIIRS pass has confirmed it');
});

test('rule c: a lone Meteosat detection creates a new event capped at observation', () => {
  const [event] = clusterDetections([meteosatDet()], []);
  assert.equal(event.positionSource, 'meteosat');
  assert.equal(event.positionUncertaintyKm, 3);
  assert.equal(event.status, 'observation', 'a single Meteosat pass must never read as more than observation');
});

// FORCED FIXTURE — SYNTHETIC, NOT LIVE DATA. This is the one fusion path
// (rule d, re-anchoring) that a real 48h EUMETSAT pull never happened to
// exercise: every real Meteosat-only cluster in that sample either stayed
// Meteosat-only for the whole window, or already had a VIIRS anchor from
// the start (rule a), so no real Meteosat-only event ever got a FRESH
// VIIRS pass inside the same window to re-anchor onto. Rules a/b/c/e are
// separately confirmed against real EUMETSAT data (see this feature's
// verification report) — this test proves the code path exists and is
// correct, not that it has fired in production yet.
test('[SYNTHETIC FIXTURE] rule d: a later VIIRS pass re-anchors a Meteosat-only event onto the VIIRS position', () => {
  const [event] = clusterDetections([meteosatDet({ latitude: 36.500, longitude: 5.500 })], []);
  assert.equal(event.positionSource, 'meteosat');
  assert.equal(event.status, 'observation', 'starting state: Meteosat-only, capped (rule c)');

  // ~2.4km away: inside the widened 3km re-anchor radius (rule d, the
  // fallback uncertainty since this fixture's Meteosat detection carries no
  // real CAP radius), outside the ordinary 2km VIIRS-VIIRS join radius —
  // proving it's the widened radius, not the normal one, that makes this match.
  const [reanchored] = clusterDetections([viirsDet({ latitude: 36.522, longitude: 5.500, acquiredAt: '2026-01-01T00:10:00Z', frp: 40 })], [event]);

  assert.equal(reanchored.positionSource, 'viirs', 'flips from meteosat to viirs');
  assert.equal(reanchored.latitude, 36.522, 'position is now exactly the VIIRS detection, not a blend with the old Meteosat position');
  assert.equal(reanchored.longitude, 5.500);
  assert.equal(reanchored.positionUncertaintyKm, undefined, 'uncertainty is cleared once re-anchored');
  assert.notEqual(reanchored.status, 'observation', 'the status cap is lifted — normal VIIRS scoring applies once re-anchored');
  // Villages/wind themselves are recomputed by app/api/monitor/route.ts's
  // enrichWeather() call (a real Open-Meteo fetch, deliberately not run in
  // this unit test) whenever score>=55 — proving that gate is cleared here
  // is the concrete guarantee that the next step in the real pipeline DOES
  // recompute them against the new (VIIRS) position, not the stale one.
  assert.ok(reanchored.score >= 55, 're-anchoring must push the score past route.ts\'s enrichWeather threshold, so villages/wind get recomputed against the NEW position on this same run');
});

test('rule e: a Meteosat-only event needs 2 distinct passes >=30min apart (or Tier 2\'s 2-consecutive-~10min fast-track) to reach corroborated', () => {
  const [afterOne] = clusterDetections([meteosatDet({ acquiredAt: '2026-01-01T00:00:00Z' })], []);
  assert.equal(afterOne.status, 'observation', 'a single pass never qualifies');

  // A second circle from the SAME product (identical acquiredAt) is the same
  // pass, not a second one.
  const [afterSameFrame] = clusterDetections([meteosatDet({ latitude: 36.5005, longitude: 5.5005, acquiredAt: '2026-01-01T00:00:00Z' })], [afterOne]);
  assert.equal(afterSameFrame.status, 'observation', 'two circles from the same 10-minute frame count as one pass, not two');

  // A second pass 10 minutes later (the real measured cadence) IS a genuine
  // second pass, at exactly the "2 consecutive ~10min cadence cycles" shape
  // Tier 2's fast-track exists for (added after the Sétif/Boutaleb fire's
  // ~3h alert delay) — see lib/meteosat-fasttrack.test.ts for the dedicated
  // coverage; this specific case used to assert 'observation' before Tier 2.
  const [afterConsecutive] = clusterDetections([meteosatDet({ acquiredAt: '2026-01-01T00:10:00Z' })], [afterSameFrame]);
  assert.equal(afterConsecutive.status, 'corroborated', 'Tier 2 fast-track: 2 consecutive ~10min passes corroborate immediately, no 30min wait needed');
});

test('rule e: a gap that is neither consecutive (<=15min) nor >=30min still falls through both gates', () => {
  const [afterOne] = clusterDetections([meteosatDet({ acquiredAt: '2026-01-01T00:00:00Z' })], []);
  const [afterTooSoon] = clusterDetections([meteosatDet({ acquiredAt: '2026-01-01T00:20:00Z' })], [afterOne]);
  assert.equal(afterTooSoon.status, 'observation', 'a 20min gap is too far for the fast-track (>15min) and too soon for the normal gate (<30min)');

  // A pass >=30 minutes after the first still clears the normal (non-fast-track) gate.
  const [afterFarEnough] = clusterDetections([meteosatDet({ acquiredAt: '2026-01-01T00:30:00Z' })], [afterTooSoon]);
  assert.equal(afterFarEnough.status, 'corroborated', 'two passes >=30min apart clears the gate, same as before Tier 2');
});

test('rule e: status never exceeds corroborated for a Meteosat-only event, however many passes', () => {
  let events: ReturnType<typeof clusterDetections> = [];
  const times = ['00:00:00', '00:30:00', '01:00:00', '01:30:00', '02:00:00', '02:30:00'];
  for (const t of times) {
    events = clusterDetections([meteosatDet({ acquiredAt: `2026-01-01T${t}Z`, frp: 0 })], events);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'corroborated', 'many Meteosat-only passes still cap at corroborated, never urgent');
});

test('real per-detection radius flows through end to end (not the flat 3km fallback)', () => {
  // Real CAP-reported radius (~1.1-1.9km observed live), not the fallback.
  const [event] = clusterDetections([meteosatDet({ latitude: 36.500, longitude: 5.500, radiusKm: 1.3 })], []);
  assert.equal(event.positionUncertaintyKm, 1.3, 'positionUncertaintyKm must be the real CAP radius, not the flat 3km fallback');

  // ~2.0km away: outside the real 1.3km radius, but inside the old flat
  // 3km fallback — if the join radius were still hardcoded to 3km, this
  // would wrongly merge into the same event; with the real radius enforced,
  // it must correctly create a SEPARATE event instead.
  const afterFar = clusterDetections([meteosatDet({ latitude: 36.518, longitude: 5.500, acquiredAt: '2026-01-01T00:10:00Z', radiusKm: 1.3 })], [event]);
  assert.equal(afterFar.length, 2, 'a detection ~2km away must NOT join a 1.3km-radius event — the real (smaller) radius is enforced, not the old flat 3km');
  assert.equal(afterFar.find(e => e.id === event.id)!.detections.length, 1, 'the original event is untouched');
});

test('a detection with no CAP radius falls back to the flat 3km default', () => {
  const [event] = clusterDetections([meteosatDet({ radiusKm: undefined })], []);
  assert.equal(event.positionUncertaintyKm, 3, 'no real radius on the detection -> the documented fallback, not undefined or 0');
});

test('fetchMeteosatSlots fails soft: a broken interpreter returns no detections and never throws', async () => {
  const previous = process.env.METEOSAT_PYTHON_BIN;
  process.env.METEOSAT_PYTHON_BIN = '/nonexistent/python-does-not-exist';
  try {
    const result = await fetchMeteosatSlots({ west: -2.5, south: 34, east: 9, north: 37.3 });
    assert.equal(result.ok, false);
    assert.deepEqual(result.detections, [], 'fail-soft: an ingestion failure must return an empty list, never throw, never block VIIRS');
    assert.ok(result.error, 'a failure reason is recorded so the watchdog can act on it');
  } finally {
    if (previous === undefined) delete process.env.METEOSAT_PYTHON_BIN; else process.env.METEOSAT_PYTHON_BIN = previous;
  }
});
