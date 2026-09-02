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

// Proves the actual requirements from the Bellara incident: a lookup that
// hits a known industrial site is flagged (with its name, when OSM has one),
// a lookup with no industrial features nearby is not, a failed/timed-out
// Overpass call fails soft (context 'unknown', never throws — same shape as
// fetchDetections/enrichWeather in fire-monitor.ts), and repeat lookups in
// the same ~1km cell never re-query Overpass.
import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import { lookupLandUse, _clearCacheForTests } from './landuse';
import { industrialContextLine, lowerStatus, telegramText, type FireEvent, type Detection } from './fire-monitor';

let originalFetch: typeof fetch;
before(() => { originalFetch = global.fetch; });
after(() => { global.fetch = originalFetch; });
beforeEach(() => { _clearCacheForTests(); });

function overpassResponse(elements: { tags?: Record<string, string> }[]) {
  return new Response(JSON.stringify({ elements }), { status: 200 });
}

test('lookupLandUse: a matching industrial feature with a name is flagged industrial with that name', async () => {
  global.fetch = (async () => overpassResponse([{ tags: { landuse: 'industrial', name: 'Complexe Sidérurgique de Bellara' } }])) as typeof fetch;
  const info = await lookupLandUse(36.86, 6.44);
  assert.equal(info.context, 'industrial');
  assert.equal(info.siteName, 'Complexe Sidérurgique de Bellara');
});

test('lookupLandUse: no matching OSM features nearby -> context natural, no site name', async () => {
  global.fetch = (async () => overpassResponse([])) as typeof fetch;
  const info = await lookupLandUse(35.4, 3.8);
  assert.equal(info.context, 'natural');
  assert.equal(info.siteName, undefined);
});

test('lookupLandUse: Overpass failure fails soft — context "unknown", never throws', async () => {
  global.fetch = (async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as typeof fetch;
  const info = await lookupLandUse(36.7, 3.05);
  assert.equal(info.context, 'unknown');
});

test('lookupLandUse: a non-OK HTTP response also fails soft', async () => {
  global.fetch = (async () => new Response('', { status: 504 })) as typeof fetch;
  const info = await lookupLandUse(36.7, 3.05);
  assert.equal(info.context, 'unknown');
});

test('lookupLandUse: caches a successful lookup per ~1km cell — a second nearby call does not re-query Overpass', async () => {
  let calls = 0;
  global.fetch = (async () => { calls++; return overpassResponse([{ tags: { power: 'plant', name: 'Test Plant' } }]); }) as typeof fetch;
  const first = await lookupLandUse(36.86, 6.44);
  const second = await lookupLandUse(36.8601, 6.4401); // rounds to the same 0.01deg cell as gridCell()
  assert.equal(calls, 1, 'second lookup in the same cell must hit the cache, not Overpass again');
  assert.deepEqual(second, first);
});

test('lookupLandUse: does not cache a failed lookup — the next call retries Overpass', async () => {
  let calls = 0;
  global.fetch = (async () => { calls++; throw new Error('network error'); }) as typeof fetch;
  await lookupLandUse(36.86, 6.44);
  await lookupLandUse(36.86, 6.44);
  assert.equal(calls, 2, 'a failed lookup must not stick — the next poll should retry');
});

function det(overrides: Partial<Detection>): Detection {
  return { latitude: 36.86, longitude: 6.44, acquiredAt: '2026-01-01T00:00:00Z', satellite: 'N20', instrument: 'VIIRS', confidence: 'h', frp: 30, ...overrides };
}

function baseEvent(overrides: Partial<FireEvent>): FireEvent {
  return {
    id: 'evt-bellara', latitude: 36.86, longitude: 6.44,
    detections: [det({})],
    firstAcquiredAt: '2026-01-01T00:00:00Z', lastAcquiredAt: '2026-01-01T00:00:00Z',
    maxFrp: 30, maxConfidence: 'h', passCount: 2, maxPixelsInSinglePass: 1,
    score: 91, status: 'urgent', evidence: [], evidenceShort: ['2pass', 'conf+', 'recoupé'],
    ...overrides,
  };
}

test('lowerStatus: urgent -> corroborated, corroborated -> observation, observation stays observation', () => {
  assert.equal(lowerStatus('urgent'), 'corroborated');
  assert.equal(lowerStatus('corroborated'), 'observation');
  assert.equal(lowerStatus('observation'), 'observation');
});

test('telegramText: an industrial-context event states the context plainly and keeps the existing disclaimer', () => {
  const event = baseEvent({ status: lowerStatus('urgent'), landUse: { context: 'industrial', siteName: 'Complexe Sidérurgique de Bellara' } });
  const text = telegramText(event, new Date('2026-01-01T01:00:00Z'));
  assert.match(text, /Détection sur zone industrielle connue \(Complexe Sidérurgique de Bellara\) — probablement une source de chaleur permanente, pas un feu\. À vérifier\./);
  assert.match(text, /Signal satellite, vérifier terrain/, 'existing disclaimer must still be present');
  assert.equal(text.startsWith('🟠'), true, 'lowered status must not render as the urgent 🔴 icon');
});

test('telegramText: a natural/unknown-context event is untouched — no industrial line added', () => {
  const naturalEvent = baseEvent({ landUse: { context: 'natural' } });
  const unknownEvent = baseEvent({ landUse: { context: 'unknown' } });
  const noLandUseEvent = baseEvent({});
  for (const event of [naturalEvent, unknownEvent, noLandUseEvent]) {
    const text = telegramText(event, new Date('2026-01-01T01:00:00Z'));
    assert.doesNotMatch(text, /zone industrielle connue/);
  }
  assert.equal(telegramText(naturalEvent, new Date('2026-01-01T01:00:00Z')), telegramText(noLandUseEvent, new Date('2026-01-01T01:00:00Z')));
});

test('industrialContextLine: omits the parenthetical when no OSM name is available', () => {
  assert.equal(industrialContextLine(undefined), 'Détection sur zone industrielle connue — probablement une source de chaleur permanente, pas un feu. À vérifier.');
});

test('industrialContextLine: an Arabic-only OSM site name is bidi-isolated, same hazard biText() guards against for village names', () => {
  const line = industrialContextLine('المنطقة الصناعية - لبلارة');
  assert.match(line, /\(⁧المنطقة الصناعية - لبلارة⁩\)/, 'Arabic run must be wrapped in RLI...PDI isolates so it cannot reorder the surrounding French sentence');
});
