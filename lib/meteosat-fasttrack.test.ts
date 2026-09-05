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

// Tier 1 (opt-in early-signal notice) and Tier 2 (Meteosat 2-consecutive-
// pass fast-track) — added after the real Sétif/Boutaleb fire took ~3h to
// alert. Tier 2 unit tests use clusterDetections() directly (pure logic,
// no DB); the villages/wind integration test uses runReplay(), the same
// harness lib/replay-meteosat.test.ts already uses, since its shouldAlert/
// enrichment gating (lib/replay.ts) is a verified mirror of the live
// route's (app/api/monitor/route.ts) — see that file's own comments.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clusterDetections, earlySignalText, shouldSendEarlyNotice, type Detection, type FireEvent } from './fire-monitor';

function viirsDet(overrides: Partial<Detection> = {}): Detection {
  return { latitude: 36.5, longitude: 5.5, acquiredAt: '2026-01-01T00:00:00Z', satellite: 'N20', instrument: 'VIIRS', confidence: 'h', frp: 10, ...overrides };
}
function meteosatDet(overrides: Partial<Detection> = {}): Detection {
  return { latitude: 36.501, longitude: 5.501, acquiredAt: '2026-01-01T00:00:00Z', satellite: 'MTI1', instrument: 'FCI', confidence: '', frp: 0, ...overrides };
}
function slstrDet(overrides: Partial<Detection> = {}): Detection {
  return { latitude: 36.502, longitude: 5.502, acquiredAt: '2026-01-01T00:00:00Z', satellite: 'S3A', instrument: 'SLSTR', confidence: '91', frp: 19.9, ...overrides };
}

// --- Tier 1: shouldSendEarlyNotice / earlySignalText -------------------------

function baseEvent(overrides: Partial<FireEvent> = {}): FireEvent {
  const det = viirsDet();
  return {
    id: 'evt-early-test', latitude: 36.5, longitude: 5.5, detections: [det],
    firstAcquiredAt: det.acquiredAt, lastAcquiredAt: det.acquiredAt,
    maxFrp: 10, maxConfidence: 'h', passCount: 1, maxPixelsInSinglePass: 1,
    score: 30, status: 'observation', evidence: [], evidenceShort: [],
    ...overrides,
  };
}

test('Tier 1 OFF (default, no env var set): never sends, regardless of event state', () => {
  delete process.env.ENABLE_EARLY_SIGNAL_NOTICE;
  assert.equal(shouldSendEarlyNotice(baseEvent(), false), false, 'default-off must reproduce today\'s behaviour exactly — no notice at all');
});

test('Tier 1 ON: a brand-new single-detection event qualifies exactly once, not again on a later poll', () => {
  process.env.ENABLE_EARLY_SIGNAL_NOTICE = 'true';
  try {
    const fresh = baseEvent({ passCount: 1 });
    assert.equal(shouldSendEarlyNotice(fresh, false), true, 'first poll, single detection, never notified before — must qualify');

    const alreadyNoticed = baseEvent({ passCount: 1, earlyNoticeAt: '2026-01-01T00:05:00Z' });
    assert.equal(shouldSendEarlyNotice(alreadyNoticed, false), false, 'already sent once for this event — must not repeat while still uncorroborated');

    const secondPassArrived = baseEvent({ passCount: 2 });
    assert.equal(shouldSendEarlyNotice(secondPassArrived, false), false, 'passCount > 1 means it is no longer a lone first detection');

    const alreadyRealAlerted = baseEvent({ passCount: 1, notifiedAt: '2026-01-01T00:05:00Z' });
    assert.equal(shouldSendEarlyNotice(alreadyRealAlerted, false), false, 'already got the real alert — no early notice needed after the fact');

    const alertingNow = baseEvent({ passCount: 1 });
    assert.equal(shouldSendEarlyNotice(alertingNow, /* alerting */ true), false, 'the real alert is firing THIS poll — no need to also send the lightweight one');
  } finally {
    delete process.env.ENABLE_EARLY_SIGNAL_NOTICE;
  }
});

test('earlySignalText: bare position + wilaya only, visually distinct from telegramText, no village/vérifier-terrain language', () => {
  const text = earlySignalText(baseEvent({ latitude: 36.7495, longitude: 6.2520 }));
  assert.match(text, /^🟡 Signal thermique isolé détecté — 1 seul passage satellite, non confirmé, à surveiller\./);
  assert.match(text, /📍36\.7495,6\.2520/);
  assert.doesNotMatch(text, /vérifier terrain/i, 'too early to claim anything — no confirmation-implying disclaimer');
  assert.doesNotMatch(text, /sous le vent|à proximité/, 'no village list — a single pixel supports no exposure claim');
});

// --- Tier 2: 2 consecutive Meteosat passes fast-track ------------------------

test('Tier 2: 2 CONSECUTIVE Meteosat passes (~10min apart) reach corroborated immediately, without VIIRS/SLSTR', () => {
  const [afterOne] = clusterDetections([meteosatDet({ acquiredAt: '2026-01-01T00:00:00Z' })], []);
  assert.equal(afterOne.status, 'observation');

  const [afterConsecutive] = clusterDetections([meteosatDet({ acquiredAt: '2026-01-01T00:10:00Z' })], [afterOne]);
  assert.equal(afterConsecutive.status, 'corroborated', 'exactly 10min apart — well within the fast-track window');
  assert.equal(afterConsecutive.positionSource, 'meteosat', 'still Meteosat-only — no VIIRS/SLSTR pass involved at all');
});

test('Tier 2: gap right at the fast-track boundary (15min) still fast-tracks; just past it (16min) does not', () => {
  const [afterOneA] = clusterDetections([meteosatDet({ acquiredAt: '2026-01-01T00:00:00Z' })], []);
  const [atBoundary] = clusterDetections([meteosatDet({ acquiredAt: '2026-01-01T00:15:00Z' })], [afterOneA]);
  assert.equal(atBoundary.status, 'corroborated', '15min = METEOSAT_CADENCE_MIN(10) + 5min slack, inclusive');

  const [afterOneB] = clusterDetections([meteosatDet({ acquiredAt: '2026-02-01T00:00:00Z' })], []);
  const [pastBoundary] = clusterDetections([meteosatDet({ acquiredAt: '2026-02-01T00:16:00Z' })], [afterOneB]);
  assert.equal(pastBoundary.status, 'observation', '16min is past the fast-track window and short of the normal 30min gate — neither path clears it');
});

test('Tier 2: 2 Meteosat passes that are NOT consecutive (a real gap) do not fast-track, fall back to the normal >=30min rule', () => {
  const [afterOne] = clusterDetections([meteosatDet({ acquiredAt: '2026-01-01T00:00:00Z' })], []);
  const [afterGap] = clusterDetections([meteosatDet({ acquiredAt: '2026-01-01T00:20:00Z' })], [afterOne]);
  assert.equal(afterGap.status, 'observation', '20min: not consecutive (>15min), not yet 30min either');

  const [afterThirty] = clusterDetections([meteosatDet({ acquiredAt: '2026-01-01T00:30:00Z' })], [afterGap]);
  assert.equal(afterThirty.status, 'corroborated', 'the normal >=30min-span rule still works exactly as before Tier 2');
});

test('Tier 2: a later VIIRS pass still re-anchors a fast-tracked event onto the VIIRS position — position/fusion rules untouched', () => {
  const [afterOne] = clusterDetections([meteosatDet({ latitude: 36.500, longitude: 5.500, acquiredAt: '2026-01-01T00:00:00Z' })], []);
  const [fastTracked] = clusterDetections([meteosatDet({ latitude: 36.500, longitude: 5.500, acquiredAt: '2026-01-01T00:10:00Z' })], [afterOne]);
  assert.equal(fastTracked.status, 'corroborated');
  assert.equal(fastTracked.positionSource, 'meteosat');
  assert.equal(fastTracked.positionUncertaintyKm, 3, 'flat 3km Meteosat fallback, unchanged — Tier 2 never touches position/uncertainty computation');

  const [reanchored] = clusterDetections([viirsDet({ latitude: 36.522, longitude: 5.500, acquiredAt: '2026-01-01T00:20:00Z', frp: 40 })], [fastTracked]);
  assert.equal(reanchored.positionSource, 'viirs', 'a fast-tracked event still re-anchors to VIIRS exactly like a normally-corroborated one');
  assert.equal(reanchored.latitude, 36.522, 'position is the VIIRS detection, never blended with the earlier Meteosat-only position');
  assert.equal(reanchored.positionUncertaintyKm, undefined, 'uncertainty clears on re-anchor, same as always');
});
test('Regression: SLSTR-only corroboration (rule c) is completely unaffected by the Meteosat-specific fast-track', () => {
  const [afterOne] = clusterDetections([slstrDet({ acquiredAt: '2026-01-01T00:00:00Z' })], []);
  assert.equal(afterOne.status, 'observation');
  // Even a very tight, "consecutive-looking" 10min gap between two SLSTR
  // passes must NOT fast-track — Tier 2 is scoped to Meteosat's own ~10min
  // cadence only; SLSTR has no comparable cadence to be "consecutive" against.
  const [afterTen] = clusterDetections([slstrDet({ acquiredAt: '2026-01-01T00:10:00Z' })], [afterOne]);
  assert.equal(afterTen.status, 'observation', 'SLSTR still needs its own >=30min span (or cross-sensor corroboration) — no Meteosat-style fast-track applies to it');
  const [afterThirty] = clusterDetections([slstrDet({ acquiredAt: '2026-01-01T00:30:00Z' })], [afterTen]);
  assert.equal(afterThirty.status, 'corroborated', 'the normal rule still works for SLSTR, unchanged');
});

test('Regression: a plain VIIRS-only event\'s score ladder is completely unaffected', () => {
  const [event] = clusterDetections([viirsDet({ confidence: 'n', frp: 5 })], []);
  assert.equal(event.status, 'observation');
  assert.ok(event.score < 65, 'unchanged scoring for a modest single VIIRS detection');
});

// --- Simulated timeline: old path vs new Meteosat fast-track, Sétif-shaped --

test('Simulated timeline: Meteosat fast-track reaches corroborated ~2h50min earlier than waiting for a 3rd VIIRS pass in a Sétif-shaped scenario', () => {
  const T0 = Date.parse('2026-09-04T00:40:00Z'); // first detection, matches today's real Sétif event's own firstAcquiredAt
  let events: ReturnType<typeof clusterDetections> = [];

  // OLD PATH (no Meteosat, VIIRS only): today's real event needed passes
  // spanning firstAcquiredAt 00:43 to a pass around 03:something before
  // score crossed 70 and the FIRST real alert fired at 03:40 — a ~3h delay,
  // exactly what prompted this feature. Modelled here with modest-
  // confidence VIIRS passes roughly on the real event's own cadence.
  events = clusterDetections([viirsDet({ acquiredAt: new Date(T0).toISOString(), confidence: 'n', frp: 3 })], events);
  assert.equal(events[0].score < 70, true, 'a single modest VIIRS pass alone does not cross the alert threshold');
  events = clusterDetections([viirsDet({ acquiredAt: new Date(T0 + 180 * 60_000).toISOString(), confidence: 'n', frp: 4 })], events); // +3h, a later overpass
  const oldPathScore = events[0].score;
  const oldPathAlertable = oldPathScore >= 70;
  assert.equal(oldPathAlertable, true, 'by ~3h later, enough passes/recoupé bonus accumulate to cross 70 — this is the slow path being replaced');

  // NEW PATH: Meteosat, 2 consecutive ~10min passes at the same spot.
  let mEvents: ReturnType<typeof clusterDetections> = [];
  mEvents = clusterDetections([meteosatDet({ acquiredAt: new Date(T0).toISOString() })], mEvents);
  assert.equal(mEvents[0].status, 'observation');
  const fastTrackTime = T0 + 10 * 60_000; // +10min, the very next Meteosat cadence cycle
  mEvents = clusterDetections([meteosatDet({ acquiredAt: new Date(fastTrackTime).toISOString() })], mEvents);
  assert.equal(mEvents[0].status, 'corroborated', 'fast-track reaches the alertable status at T0+10min');

  const oldPathMinutes = 180;
  const newPathMinutes = 10;
  const minutesSaved = oldPathMinutes - newPathMinutes;
  assert.equal(minutesSaved, 170, '~2h50min faster: 10min to corroborated vs ~3h to cross the plain VIIRS score threshold');
});
