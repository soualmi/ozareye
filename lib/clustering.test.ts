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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clusterDetections, type Detection, type FireEvent } from './fire-monitor';

function det(overrides: Partial<Detection>): Detection {
  return { latitude: 36.5, longitude: 5.5, acquiredAt: '2026-01-01T00:00:00Z', satellite: 'N20', instrument: 'VIIRS', confidence: 'h', frp: 10, ...overrides };
}

// Regression test for the re-alert bug: an event whose own detections span
// more than CLUSTER_TIME_HOURS (12h) apart used to "shed" its early
// detections on the next poll — the old code anchored the time-window check
// to the event's current (advancing) lastAcquiredAt, so a detection more
// than 12h behind that would fail to match its own event and spawn a
// duplicate with a colliding id (generated from that same detection's own
// lat/lon/time) and no notification history.
test('an event spanning >12h does not fragment when the same static snapshot is reprocessed', () => {
  // A chain of detections at 0h, 6h and 13h: each CONSECUTIVE gap is under
  // 12h (so they correctly cluster into one event via transitive matching),
  // but the event's overall span (0h -> 13h) exceeds CLUSTER_TIME_HOURS —
  // exactly the real-world shape (a fire revisited by three satellites
  // across half a day) that triggered the bug.
  const detections = [
    det({ acquiredAt: '2026-01-01T00:00:00Z', satellite: 'N20', frp: 10 }),
    det({ acquiredAt: '2026-01-01T06:00:00Z', satellite: 'N21', frp: 11 }),
    det({ acquiredAt: '2026-01-01T13:00:00Z', satellite: 'N', frp: 12 }),
  ];

  const firstPass = clusterDetections(detections, []);
  assert.equal(firstPass.length, 1, 'the chain should cluster into one event on the first pass');
  const event = firstPass[0];
  assert.equal(event.detections.length, 3);
  assert.equal(event.firstAcquiredAt, '2026-01-01T00:00:00Z');
  assert.equal(event.lastAcquiredAt, '2026-01-01T13:00:00Z');

  // Simulate what route.ts does after a real Telegram send.
  event.notifiedAt = '2026-01-01T13:05:00Z';
  event.notifiedScore = event.score;
  event.notifiedStatus = event.status;

  // Second poll: identical 24h FIRMS snapshot, reprocessed against the
  // already-notified, already-loaded event (as activeEvents() would return it).
  const secondPass = clusterDetections(detections, [event]);
  assert.equal(secondPass.length, 1, 'must not produce a duplicate/colliding event id');
  assert.equal(secondPass[0].id, event.id);
  assert.equal(secondPass[0].detections.length, 3, 'must not double-count the same detections either');
  assert.equal(secondPass[0].notifiedAt, '2026-01-01T13:05:00Z', 'must not lose notification history');

  // A third poll, same story again — the bug was that this kept recurring.
  const thirdPass = clusterDetections(detections, [secondPass[0]]);
  assert.equal(thirdPass.length, 1);
  assert.equal(thirdPass[0].notifiedAt, '2026-01-01T13:05:00Z');
});

// Defense in depth: if two fragments sharing an id ever do reach
// clusterDetections (e.g. residual state from before this fix, or some other
// edge case), they must merge into one — and the merge must never discard a
// notification just because the other fragment happens to lack one. Losing
// notification history is what causes re-spam; preserving it is the point.
test('merging two same-id fragments keeps notifiedAt from whichever one has it', () => {
  const unnotified: FireEvent = {
    id: 'evt-collision', latitude: 36.5, longitude: 5.5,
    detections: [det({ acquiredAt: '2026-01-01T00:00:00Z', satellite: 'N20' })],
    firstAcquiredAt: '2026-01-01T00:00:00Z', lastAcquiredAt: '2026-01-01T00:00:00Z',
    maxFrp: 10, maxConfidence: 'h', passCount: 1, maxPixelsInSinglePass: 1,
    score: 0, status: 'observation', evidence: [], evidenceShort: [],
  };
  const notified: FireEvent = {
    id: 'evt-collision', latitude: 36.5, longitude: 5.5,
    detections: [det({ acquiredAt: '2026-01-01T13:00:00Z', satellite: 'N21', frp: 20 })],
    firstAcquiredAt: '2026-01-01T13:00:00Z', lastAcquiredAt: '2026-01-01T13:00:00Z',
    maxFrp: 20, maxConfidence: 'h', passCount: 1, maxPixelsInSinglePass: 1,
    score: 91, status: 'urgent', evidence: [], evidenceShort: [],
    notifiedAt: '2026-01-01T13:05:00Z', notifiedScore: 91, notifiedStatus: 'urgent',
  };

  const result = clusterDetections([], [unnotified, notified]);
  assert.equal(result.length, 1, 'same-id fragments must merge into one event');
  assert.equal(result[0].notifiedAt, '2026-01-01T13:05:00Z', 'must keep the notification, not drop it');
  assert.equal(result[0].notifiedScore, 91);
  assert.equal(result[0].notifiedStatus, 'urgent');
  assert.equal(result[0].detections.length, 2, 'must keep the union of both fragments\' detections');
  assert.equal(result[0].firstAcquiredAt, '2026-01-01T00:00:00Z', 'earliest anchor preserved');
  assert.equal(result[0].lastAcquiredAt, '2026-01-01T13:00:00Z', 'latest anchor preserved');
});
