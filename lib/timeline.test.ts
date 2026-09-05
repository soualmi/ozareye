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

// The full detection timeline (Part C): first pass and last pass each WITH
// their Algiers date, "actif depuis" (first -> last) distinct from "il y a"
// (last -> now), on Telegram and in the dashboard view model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeMinutes, algiersDateTime, formatElapsed, telegramText, timelineLine, type Detection, type FireEvent } from './fire-monitor';
import { toDashboardEvent } from './dashboard-view';

function det(overrides: Partial<Detection> = {}): Detection {
  return { latitude: 36.6804, longitude: 3.1241, acquiredAt: '2026-09-03T01:05:00Z', satellite: 'N20', instrument: 'VIIRS', confidence: 'h', frp: 12, ...overrides };
}
function event(overrides: Partial<FireEvent> = {}): FireEvent {
  return {
    id: 'evt-t', latitude: 36.6804, longitude: 3.1241, detections: [det()],
    firstAcquiredAt: '2026-09-03T01:05:00Z', lastAcquiredAt: '2026-09-03T01:05:00Z',
    maxFrp: 12, maxConfidence: 'h', passCount: 1, maxPixelsInSinglePass: 1,
    score: 50, status: 'observation', evidence: [], evidenceShort: ['1pass'],
    ...overrides,
  };
}

test('algiersDateTime: date AND time in Africa/Algiers (UTC+1), "DD/MM à HH:MM"', () => {
  assert.equal(algiersDateTime('2026-09-05T13:25:00Z'), '05/09 à 14:25');
  assert.equal(algiersDateTime('2026-09-03T01:05:00Z'), '03/09 à 02:05');
});

test('algiersDateTime: across midnight — a 23:30Z pass is the NEXT day in Algiers, and 23:00Z on the last day of a month rolls the month', () => {
  assert.equal(algiersDateTime('2026-09-04T23:30:00Z'), '05/09 à 00:30');
  assert.equal(algiersDateTime('2026-09-30T23:10:00Z'), '01/10 à 00:10');
  assert.equal(algiersDateTime('2026-09-04T22:59:00Z'), '04/09 à 23:59', 'one minute before the Algiers day rolls');
});

test('activeMinutes: first -> last span, 0 for a single pass, day-scale for a multi-day event', () => {
  assert.equal(activeMinutes(event()), 0);
  assert.equal(activeMinutes(event({ firstAcquiredAt: '2026-09-03T01:05:00Z', lastAcquiredAt: '2026-09-05T13:25:00Z' })), 2 * 1440 + 12 * 60 + 20);
});

test('timelineLine: multi-day event renders "Xj Yh", both dates, and "il y a" separately', () => {
  const e = event({ firstAcquiredAt: '2026-09-03T01:05:00Z', lastAcquiredAt: '2026-09-05T13:25:00Z', passCount: 18 });
  const line = timelineLine(e, new Date('2026-09-05T15:40:00Z'));
  assert.equal(line, '1re détection : 03/09 à 02:05 · dernier passage : 05/09 à 14:25 (Alger, il y a 2h 15min) · actif depuis 2j 12h');
  assert.equal(formatElapsed(activeMinutes(e)), '2j 12h', 'the existing helper already carries the day tier — reused, not rebuilt');
});

test('timelineLine: single-day, multi-pass event renders hours only, no "0j"', () => {
  const e = event({ firstAcquiredAt: '2026-09-05T01:05:00Z', lastAcquiredAt: '2026-09-05T13:25:00Z', passCount: 3 });
  const line = timelineLine(e, new Date('2026-09-05T14:00:00Z'));
  assert.equal(line, '1re détection : 05/09 à 02:05 · dernier passage : 05/09 à 14:25 (Alger, il y a 35min) · actif depuis 12h 20min');
  assert.doesNotMatch(line, /0j/);
});

test('timelineLine: single pass says so instead of inventing a span', () => {
  const line = timelineLine(event(), new Date('2026-09-03T02:05:00Z'));
  assert.equal(line, 'Détection : 03/09 à 02:05 (Alger, il y a 1h) · passage unique');
  assert.doesNotMatch(line, /actif depuis/);
});

test('timelineLine: an event spanning midnight shows two different dates', () => {
  const e = event({ firstAcquiredAt: '2026-09-04T22:30:00Z', lastAcquiredAt: '2026-09-05T01:10:00Z', passCount: 2 });
  assert.equal(timelineLine(e, new Date('2026-09-05T02:00:00Z')), '1re détection : 04/09 à 23:30 · dernier passage : 05/09 à 02:10 (Alger, il y a 50min) · actif depuis 2h 40min');
});

test('telegramText: carries the timeline line — dated last pass, "il y a" and "actif depuis" — and no bare undated HH:MM', () => {
  const e = event({ firstAcquiredAt: '2026-09-03T01:05:00Z', lastAcquiredAt: '2026-09-05T13:25:00Z', passCount: 18, evidenceShort: ['18pass'] });
  const text = telegramText(e, new Date('2026-09-05T15:40:00Z'));
  assert.match(text, /🕓 1re détection : 03\/09 à 02:05 · dernier passage : 05\/09 à 14:25 \(Alger, il y a 2h 15min\) · actif depuis 2j 12h/);
  assert.doesNotMatch(text, /· Alger 14:25 \(Alger/, 'the old "HH:MM (Alger, il y a …)" form with no date is gone');
  assert.ok(text.length < 600, `stays within the compact budget (got ${text.length})`);
});

test('toDashboardEvent: exposes first/last with dates and the active span, alongside the legacy time-only field', () => {
  const e = event({ firstAcquiredAt: '2026-09-03T01:05:00Z', lastAcquiredAt: '2026-09-05T13:25:00Z', passCount: 18, detections: [det(), det({ acquiredAt: '2026-09-05T13:25:00Z' })] });
  const d = toDashboardEvent(e, new Date('2026-09-05T15:40:00Z'));
  assert.equal(d.firstDetectedAtIso, '2026-09-03T01:05:00Z');
  assert.equal(d.firstDetectedAtAlgiers, '03/09 à 02:05');
  assert.equal(d.lastDetectedAtAlgiers, '05/09 à 14:25');
  assert.equal(d.activeMinutes, 2 * 1440 + 12 * 60 + 20);
  assert.equal(d.ageMinutes, 135, 'last pass -> now, unchanged');
  assert.equal(d.detectedAtAlgiers, '14:25', 'legacy time-only field still present for existing callers');
  // Midnight: a 23:30Z first pass shows the Algiers date of the 5th.
  const m = toDashboardEvent(event({ firstAcquiredAt: '2026-09-04T23:30:00Z', lastAcquiredAt: '2026-09-05T01:10:00Z' }), new Date('2026-09-05T02:00:00Z'));
  assert.equal(m.firstDetectedAtAlgiers, '05/09 à 00:30');
  assert.equal(m.lastDetectedAtAlgiers, '05/09 à 02:10');
  assert.equal(m.activeMinutes, 100, '23:30Z -> 01:10Z');
});
