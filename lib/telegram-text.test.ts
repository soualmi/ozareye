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

// Covers the human-readable rendering pass: elapsedParts()/formatElapsed()
// (the raw-minutes bug — "(1285min)" must never appear), evidenceLine() (the
// "Preuves" line, spelled out in plain French) and creditsLine() (the
// conditional Meteosat attribution) — plus telegramText() end to end.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  creditsLine, elapsedParts, evidenceLine, formatElapsed, telegramText,
  type Detection, type FireEvent,
} from './fire-monitor';

test('elapsedParts: breaks a raw minute count into days/hours/minutes', () => {
  assert.deepEqual(elapsedParts(45), { days: 0, hours: 0, minutes: 45 });
  assert.deepEqual(elapsedParts(90), { days: 0, hours: 1, minutes: 30 });
  assert.deepEqual(elapsedParts(1285), { days: 0, hours: 21, minutes: 25 });
  assert.deepEqual(elapsedParts(1440), { days: 1, hours: 0, minutes: 0 });
  assert.deepEqual(elapsedParts(1500), { days: 1, hours: 1, minutes: 0 });
});

test('formatElapsed: under 60min renders "Xmin", the raw-minutes bug is gone', () => {
  assert.equal(formatElapsed(0), '0min');
  assert.equal(formatElapsed(45), '45min');
});

test('formatElapsed: 1h-24h renders "Xh" or "Xh YYmin" — never the raw "(1285min)" form', () => {
  assert.equal(formatElapsed(120), '2h');
  assert.equal(formatElapsed(1285), '21h 25min');
});

test('formatElapsed: beyond 24h renders "Xj" or "Xj XXh"', () => {
  assert.equal(formatElapsed(1440), '1j');
  assert.equal(formatElapsed(1500), '1j 1h');
  assert.equal(formatElapsed(4321), '3j', 'exact multiple of a day plus 1 leftover minute still reads as "3j" — the hour tier is 0');
  assert.equal(formatElapsed(3 * 1440 + 61), '3j 1h');
});

test('telegramText: the raw "(1285min)" form never appears, even for an event that old', () => {
  const event = baseEvent({ lastAcquiredAt: '2026-01-01T00:00:00Z' });
  const text = telegramText(event, new Date('2026-01-01T21:25:00Z'));
  assert.doesNotMatch(text, /\(1285min\)/);
  assert.match(text, /il y a 21h 25min/);
});

function det(overrides: Partial<Detection>): Detection {
  return { latitude: 36.6804, longitude: 3.1241, acquiredAt: '2026-01-01T00:00:00Z', satellite: 'N20', instrument: 'VIIRS', confidence: 'h', frp: 2.3, ...overrides };
}
function meteosatDet(overrides: Partial<Detection> = {}): Detection {
  return { latitude: 36.6804, longitude: 3.1241, acquiredAt: '2026-01-01T00:00:00Z', satellite: 'MTI1', instrument: 'FCI', confidence: '', frp: 0, ...overrides };
}

function baseEvent(overrides: Partial<FireEvent> = {}): FireEvent {
  return {
    id: 'evt-test', latitude: 36.6804, longitude: 3.1241,
    detections: [det({})],
    firstAcquiredAt: '2026-01-01T00:00:00Z', lastAcquiredAt: '2026-01-01T00:00:00Z',
    maxFrp: 2.3, maxConfidence: 'h', passCount: 1, maxPixelsInSinglePass: 1,
    score: 50, status: 'observation', evidence: [], evidenceShort: ['1pass'],
    ...overrides,
  };
}

test('evidenceLine: a single pass with no boosts reads as a plain clause, no bare tags', () => {
  const event = baseEvent({});
  assert.equal(evidenceLine(event), 'vu par 1 passage satellite');
});

test('evidenceLine: several passes, zone boost only — "zone+" is dropped, "recoupé" is spelled out, wind appended', () => {
  const event = baseEvent({
    passCount: 5, evidenceShort: ['5pass', 'recoupé', 'zone+'],
    windKph: 6.4, windDirectionFromDeg: 30, // wind FROM NE => blows TOWARD SO
  });
  const line = evidenceLine(event);
  assert.equal(line, 'vu par 5 passages satellite · confirmé par un passage satellite supplémentaire · vent 6.4 km/h → SO');
  assert.doesNotMatch(line, /zone\+/);
  assert.doesNotMatch(line, /recoupé$|·recoupé/, 'the raw jargon tag itself must not leak through');
});

test('evidenceLine: several passes with the Meteosat-corroboration boost reads "confirmé par Meteosat"', () => {
  const event = baseEvent({ passCount: 4, evidenceShort: ['4pass', 'recoupé', 'meteosat+'] });
  const line = evidenceLine(event);
  assert.equal(line, 'vu par 4 passages satellite · confirmé par un passage satellite supplémentaire · confirmé par Meteosat');
});

test('evidenceLine: "meteosat+" is never shown for an event that never got that boost', () => {
  const event = baseEvent({ passCount: 2, evidenceShort: ['2pass', 'recoupé'] });
  assert.doesNotMatch(evidenceLine(event), /Meteosat/);
});

test('creditsLine: no Meteosat pass at all — line is unchanged', () => {
  const event = baseEvent({});
  assert.equal(creditsLine(event), 'NASA FIRMS·Open-Meteo');
});

test('creditsLine: an identical event with a Meteosat pass gets the extra credit appended to the same line', () => {
  const withMeteosat = baseEvent({ detections: [det({}), meteosatDet({})] });
  assert.equal(creditsLine(withMeteosat), 'NASA FIRMS·Open-Meteo·MTG Active Fire Monitoring — EUMETSAT');
});

test('telegramText: three real-shape events render a readable Preuves line and credits (see console output)', () => {
  const referenceTime = new Date('2026-01-01T13:44:00Z');

  const singlePass = baseEvent({ id: 'evt-1pass', lastAcquiredAt: '2026-01-01T13:23:00Z' });

  const zoneBoosted = baseEvent({
    id: 'evt-zone', passCount: 5, evidenceShort: ['5pass', 'recoupé', 'zone+'],
    lastAcquiredAt: '2026-01-01T13:23:00Z', windKph: 6.4, windDirectionFromDeg: 30,
  });

  const meteosatCorroborated = baseEvent({
    id: 'evt-meteosat', passCount: 4, evidenceShort: ['4pass', 'recoupé', 'meteosat+'],
    lastAcquiredAt: '2026-01-01T13:23:00Z',
    detections: [det({}), meteosatDet({ acquiredAt: '2026-01-01T00:10:00Z' }), meteosatDet({ acquiredAt: '2026-01-01T00:20:00Z' })],
  });

  for (const event of [singlePass, zoneBoosted, meteosatCorroborated]) {
    const text = telegramText(event, referenceTime);
    assert.doesNotMatch(text, /\(\d+min\)/, 'no raw-minutes form anywhere in the message');
    assert.match(text, /Preuves : /);
    assert.ok(text.length < 500, `message must stay under the ~500 char Telegram budget (got ${text.length})`);
    // eslint-disable-next-line no-console
    console.log(`\n--- ${event.id} (${text.length} chars) ---\n${text}\n`);
  }
});
