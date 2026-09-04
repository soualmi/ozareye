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

// Proves the locked SLSTR fusion rules (a-e, same family as Meteosat's,
// adapted — see lib/fire-monitor.ts) that clusterDetections()/scoreEvent()
// implement, plus fetchSlstrPasses()'s (lib/slstr.ts) fail-soft contract.
// FRP/confidence fixture values below (19.9/91, 107.6/100, uncertainty
// 4.02/11.26) are the REAL FRP_MWIR/confidence_MWIR/FRP_MWIR_uncertainty
// readings from a real EO:EUM:DAT:0417 product downloaded and parsed during
// this feature's own Step 1/2 verification
// (S3A_SL_2_FRP____20260904T100509_..._MAR_O_NR_003.SEN3,
// FRP_MWIR1km_standard.nc) — not invented numbers. Lat/lon are synthetic
// (offset from a common test origin, like lib/meteosat.test.ts), since the
// fusion rules being tested are about relative distance/radius, not any one
// real coordinate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clusterDetections, creditsLine, evidenceLine, type Detection } from './fire-monitor';

process.env.ALGERIE_FEUX_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'algerie-feux-slstr-test-')), 'signals.db');

const { initDb } = await import('./database');
const { fetchSlstrPasses } = await import('./slstr');
await initDb();

function viirsDet(overrides: Partial<Detection> = {}): Detection {
  return { latitude: 36.5, longitude: 5.5, acquiredAt: '2026-01-01T00:00:00Z', satellite: 'N20', instrument: 'VIIRS', confidence: 'h', frp: 10, ...overrides };
}
function meteosatDet(overrides: Partial<Detection> = {}): Detection {
  return { latitude: 36.501, longitude: 5.501, acquiredAt: '2026-01-01T00:00:00Z', satellite: 'MTI1', instrument: 'FCI', confidence: '', frp: 0, ...overrides };
}
function slstrDet(overrides: Partial<Detection> = {}): Detection {
  // Real FRP_MWIR/confidence_MWIR/FRP_MWIR_uncertainty from the product's own
  // most intense real detection (lat 35.7161, lon 5.1974 in the real data;
  // shifted here to sit near the shared 36.5/5.5 test origin).
  return { latitude: 36.502, longitude: 5.502, acquiredAt: '2026-01-01T00:00:00Z', satellite: 'S3A', instrument: 'SLSTR', confidence: '100', frp: 107.6, uncertaintyMw: 11.26, ...overrides };
}

test('rule a: an SLSTR detection never moves the position of an event with a VIIRS pass', () => {
  const [event] = clusterDetections([viirsDet()], []);
  const originalLat = event.latitude, originalLon = event.longitude;

  const [updated] = clusterDetections([slstrDet({ acquiredAt: '2026-01-01T00:10:00Z' })], [event]);

  assert.equal(updated.latitude, originalLat, 'latitude must be exactly the VIIRS position, untouched by the SLSTR pixel');
  assert.equal(updated.longitude, originalLon);
  assert.equal(updated.positionSource, 'viirs');
  assert.equal(updated.detections.length, 2, 'the SLSTR pass is still attached as a pass, just never moves the position');
});

test('rule a: FRP is max-not-average when both VIIRS and SLSTR see the same event', () => {
  const [event] = clusterDetections([viirsDet({ frp: 19.9 })], []); // real FRP_MWIR reading (confidence 91)
  assert.equal(event.maxFrp, 19.9);

  const [updated] = clusterDetections([slstrDet({ acquiredAt: '2026-01-01T00:10:00Z', frp: 107.6 })], [event]);
  assert.equal(updated.maxFrp, 107.6, 'the larger real reading wins — never averaged with the smaller one');

  const [updatedReverseOrder] = clusterDetections(
    [viirsDet({ frp: 107.6 }), slstrDet({ latitude: 36.5, longitude: 5.5, acquiredAt: '2026-01-01T00:00:00Z', frp: 19.9 })],
    [],
  );
  assert.equal(updatedReverseOrder.maxFrp, 107.6, 'still the max regardless of which sensor happened to see the higher reading');
});

test('rule b: SLSTR real FRP promotes maxFrp on a Meteosat-only event (Meteosat carries no real FRP)', () => {
  const [event] = clusterDetections([meteosatDet({ latitude: 36.500, longitude: 5.500 })], []);
  assert.equal(event.maxFrp, 0, 'Meteosat-only: no real FRP yet');
  assert.equal(event.positionSource, 'meteosat');

  const [updated] = clusterDetections(
    [slstrDet({ latitude: 36.5005, longitude: 5.5005, acquiredAt: '2026-01-01T00:10:00Z', frp: 19.9 })],
    [event],
  );
  assert.equal(updated.maxFrp, 19.9, 'the first real FRP reading (from SLSTR) promotes maxFrp off the Meteosat placeholder 0');
  assert.equal(updated.positionSource, 'slstr', 'SLSTR wins the position-source label over Meteosat once both non-VIIRS sources are present');
});

test('rule c: a lone SLSTR detection creates a new event capped at observation', () => {
  const [event] = clusterDetections([slstrDet()], []);
  assert.equal(event.positionSource, 'slstr');
  assert.equal(event.positionUncertaintyKm, 1, 'SLSTR fallback uncertainty is ~1km, not Meteosat\'s 3km');
  assert.equal(event.status, 'observation', 'a single SLSTR pass must never read as more than observation');
  assert.equal(event.maxFrp, 107.6, 'unlike Meteosat, an SLSTR-only event DOES carry a real FRP reading');
});

test('[SYNTHETIC FIXTURE] rule d: a later VIIRS pass re-anchors an SLSTR-only event onto the VIIRS position', () => {
  const [event] = clusterDetections([slstrDet({ latitude: 36.500, longitude: 5.500 })], []);
  assert.equal(event.positionSource, 'slstr');
  assert.equal(event.status, 'observation', 'starting state: SLSTR-only, capped (rule c)');

  // ~0.7km away: inside SLSTR's own ~1km join radius, which — unlike
  // Meteosat's 3km fallback — is actually NARROWER than the normal 2km
  // VIIRS-VIIRS radius; a VIIRS detection joining an SLSTR-only event uses
  // the TARGET event's own (smaller) positionUncertaintyKm, honestly
  // reflecting that SLSTR's real footprint is tighter than Meteosat's.
  const [reanchored] = clusterDetections([viirsDet({ latitude: 36.5063, longitude: 5.500, acquiredAt: '2026-01-01T00:10:00Z', frp: 40 })], [event]);

  assert.equal(reanchored.positionSource, 'viirs', 'flips from slstr to viirs');
  assert.equal(reanchored.latitude, 36.5063, 'position is now exactly the VIIRS detection, not a blend with the old SLSTR position');
  assert.equal(reanchored.positionUncertaintyKm, undefined, 'uncertainty is cleared once re-anchored');
  assert.notEqual(reanchored.status, 'observation', 'the status cap is lifted — normal VIIRS scoring applies once re-anchored');
});

test('SLSTR\'s ~1km join radius is narrower than the normal 2km VIIRS-VIIRS radius (unlike Meteosat\'s wider 3km fallback)', () => {
  const [event] = clusterDetections([slstrDet({ latitude: 36.500, longitude: 5.500 })], []);
  assert.equal(event.positionUncertaintyKm, 1);

  // ~1.5km away: would join a normal VIIRS-anchored event (2km radius), but
  // must NOT join this SLSTR-only event, whose own (smaller) radius governs
  // the join instead.
  const after = clusterDetections([viirsDet({ latitude: 36.5135, longitude: 5.500, acquiredAt: '2026-01-01T00:10:00Z' })], [event]);
  assert.equal(after.length, 2, 'a VIIRS detection ~1.5km away must NOT join a 1km-radius SLSTR-only event');
});

test('rule e: an SLSTR-only event needs 2 distinct passes >=30min apart to reach corroborated', () => {
  const [afterOne] = clusterDetections([slstrDet({ acquiredAt: '2026-01-01T00:00:00Z' })], []);
  assert.equal(afterOne.status, 'observation', 'a single pass never qualifies');

  const [afterTooSoon] = clusterDetections([slstrDet({ acquiredAt: '2026-01-01T00:10:00Z' })], [afterOne]);
  assert.equal(afterTooSoon.status, 'observation', 'a pass only 10 minutes later does not meet the ~30min gate');

  const [afterFarEnough] = clusterDetections([slstrDet({ acquiredAt: '2026-01-01T00:30:00Z' })], [afterTooSoon]);
  assert.equal(afterFarEnough.status, 'corroborated', 'two passes >=30min apart clears the gate');
});

test('rule e: cross-sensor corroboration (Meteosat + SLSTR, no VIIRS) clears the gate without the 30min span', () => {
  const [meteosatOnly] = clusterDetections([meteosatDet({ acquiredAt: '2026-01-01T00:00:00Z' })], []);
  assert.equal(meteosatOnly.status, 'observation');

  // Only 5 minutes later — would NOT clear the same-sensor 30min gate, but
  // this is a DIFFERENT independent sensor (SLSTR), a strictly stronger
  // corroboration claim than a same-sensor repeat pass.
  const [corroborated] = clusterDetections([slstrDet({ latitude: 36.5005, longitude: 5.5005, acquiredAt: '2026-01-01T00:05:00Z' })], [meteosatOnly]);
  assert.equal(corroborated.status, 'corroborated', 'two independent secondary sensors on the same spot corroborate immediately, regardless of span');
});

test('rule e: status never exceeds corroborated for an SLSTR-only event, however many passes', () => {
  let events: ReturnType<typeof clusterDetections> = [];
  const times = ['00:00:00', '00:30:00', '01:00:00', '01:30:00', '02:00:00', '02:30:00'];
  for (const t of times) {
    events = clusterDetections([slstrDet({ acquiredAt: `2026-01-01T${t}Z` })], events);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'corroborated', 'many SLSTR-only passes still cap at corroborated, never urgent');
});

test('a detection with no reported radius falls back to the flat 1km SLSTR default', () => {
  const [event] = clusterDetections([slstrDet({ radiusKm: undefined })], []);
  assert.equal(event.positionUncertaintyKm, 1, 'no real radius on the detection -> the documented 1km fallback, not undefined, 0, or Meteosat\'s 3km');
});

test('evidenceLine/creditsLine mention Sentinel-3 SLSTR when the event carries an SLSTR pass', () => {
  const [viirsOnly] = clusterDetections([viirsDet()], []);
  assert.doesNotMatch(creditsLine(viirsOnly), /Sentinel-3/, 'no SLSTR credit for a VIIRS-only event');

  const [fused] = clusterDetections(
    [slstrDet({ acquiredAt: '2026-01-01T00:10:00Z' }), slstrDet({ latitude: 36.503, longitude: 5.503, acquiredAt: '2026-01-01T00:45:00Z' })],
    [viirsOnly],
  );
  assert.match(creditsLine(fused), /Copernicus Sentinel-3 SLSTR/, 'credits line names SLSTR once the event has an SLSTR contribution');
  assert.match(evidenceLine(fused), /Sentinel-3 SLSTR/, 'evidence line documents SLSTR corroboration once >=2 SLSTR passes hit a VIIRS-confirmed event');
});

test('fetchSlstrPasses fails soft: a broken interpreter returns no detections and never throws', async () => {
  const previous = process.env.SLSTR_PYTHON_BIN;
  process.env.SLSTR_PYTHON_BIN = '/nonexistent/python-does-not-exist';
  try {
    const result = await fetchSlstrPasses({ west: -2.5, south: 34, east: 9, north: 37.3 });
    assert.equal(result.ok, false);
    assert.deepEqual(result.detections, [], 'fail-soft: an ingestion failure must return an empty list, never throw, never block VIIRS/Meteosat');
    assert.ok(result.error, 'a failure reason is recorded so the watchdog can act on it');
  } finally {
    if (previous === undefined) delete process.env.SLSTR_PYTHON_BIN; else process.env.SLSTR_PYTHON_BIN = previous;
  }
});
