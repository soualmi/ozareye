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
// a lookup with no industrial features nearby is not, and — since land-use
// moved to a local index (data/industrial-sites.json, built once offline by
// scripts/build-industrial-index.ts) with Overpass kept only as a fallback —
// a failed/timed-out Overpass call still fails soft (context 'unknown',
// never throws) when that fallback is the one being exercised. Most tests
// here force the fallback open by pointing the index at a file that doesn't
// exist (see MISSING_INDEX_PATH below); a handful at the end use the real
// shipped index instead.
import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import { lookupLandUse, _clearCacheForTests } from './landuse';
import { industrialContextLine, lowerStatus, telegramText, type FireEvent, type Detection } from './fire-monitor';

// Overpass is now only a FALLBACK, reached when the local index
// (data/industrial-sites.json) is absent or unreadable — see lib/landuse.ts.
// Every test below that mocks `fetch` needs that fallback path forced open,
// so beforeEach points the index at a file that doesn't exist. The handful
// of tests proving the real local index (Bellara/El Hamma/Chréa) undo this
// for just their own call.
const MISSING_INDEX_PATH = '/nonexistent/industrial-sites-test.json';

let originalFetch: typeof fetch;
let originalIndexPath: string | undefined;
before(() => { originalFetch = global.fetch; originalIndexPath = process.env.ALGERIE_FEUX_INDUSTRIAL_INDEX_PATH; });
after(() => {
  global.fetch = originalFetch;
  if (originalIndexPath === undefined) delete process.env.ALGERIE_FEUX_INDUSTRIAL_INDEX_PATH;
  else process.env.ALGERIE_FEUX_INDUSTRIAL_INDEX_PATH = originalIndexPath;
});
beforeEach(() => { process.env.ALGERIE_FEUX_INDUSTRIAL_INDEX_PATH = MISSING_INDEX_PATH; _clearCacheForTests(); });

function useRealLocalIndex() {
  delete process.env.ALGERIE_FEUX_INDUSTRIAL_INDEX_PATH;
  _clearCacheForTests();
}

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
  // Two lookups, each walking the primary and both mirrors before giving up.
  assert.equal(calls, 6, 'a failed lookup must not stick — the next poll should retry every endpoint');
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

test('lookupLandUse: a connection-level failure on the primary retries once on the mirror', async () => {
  const tried: string[] = [];
  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    tried.push(new URL(url).host);
    if (url.includes('overpass-api.de')) throw new TypeError('fetch failed');
    return overpassResponse([{ tags: { power: 'plant', name: 'Centrale électrique du Hamma' } }]);
  }) as typeof fetch;

  const info = await lookupLandUse(36.75, 3.08);
  assert.deepEqual(tried, ['overpass-api.de', 'overpass.kumi.systems'], 'primary first, then the first mirror — and it stops as soon as one answers');
  assert.equal(info.context, 'industrial');
  assert.equal(info.siteName, 'Centrale électrique du Hamma');
});

test('lookupLandUse: a 429 or 5xx on the primary also falls through to the mirror', async () => {
  for (const status of [429, 503]) {
    _clearCacheForTests();
    const tried: string[] = [];
    global.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      tried.push(new URL(url).host);
      if (url.includes('overpass-api.de')) return new Response('slow down', { status });
      return overpassResponse([{ tags: { landuse: 'quarry' } }]);
    }) as typeof fetch;

    const info = await lookupLandUse(36.1, 5.2);
    assert.deepEqual(tried, ['overpass-api.de', 'overpass.kumi.systems'], `status ${status} must be retried on a mirror`);
    assert.equal(info.context, 'industrial');
  }
});

test('lookupLandUse: both endpoints down still fails soft, and never queries a third time', async () => {
  const tried: string[] = [];
  global.fetch = (async (input: RequestInfo | URL) => {
    tried.push(new URL(String(input)).host);
    throw new TypeError('fetch failed');
  }) as typeof fetch;

  const info = await lookupLandUse(35.0, 5.0);
  assert.equal(info.context, 'unknown');
  assert.equal(tried.length, 3, 'one attempt per endpoint, no more');
});

test('industrialContextLine: Tifinagh in an OSM site name is stripped like anywhere else', () => {
  const line = industrialContextLine('Bellara ⴱⵍⵍⴰⵔⴰ');
  assert.match(line, /\(Bellara\)/);
  assert.doesNotMatch(line, /[ⴰ-⵿]/u, 'no Tifinagh may reach a reader, site names included');
});

test('lookupLandUse: repeated failures pause lookups instead of holding up every later event', async () => {
  let calls = 0;
  global.fetch = (async () => { calls++; throw new TypeError('fetch failed'); }) as typeof fetch;

  // Two failing lookups walk all three endpoints; the breaker then opens.
  await lookupLandUse(36.0, 5.0);
  await lookupLandUse(36.5, 5.5);
  const afterTwo = calls;
  assert.equal(afterTwo, 6);

  // Every later event in the same run returns immediately, with no request.
  for (let i = 0; i < 5; i++) assert.equal((await lookupLandUse(35 + i * 0.1, 4)).context, 'unknown');
  assert.equal(calls, afterTwo, 'no further network calls while the breaker is open');
});

test('lookupLandUse: a success resets the failure count', async () => {
  global.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  await lookupLandUse(36.0, 5.0);
  global.fetch = (async () => overpassResponse([])) as typeof fetch;
  assert.equal((await lookupLandUse(36.5, 5.5)).context, 'natural');

  global.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  await lookupLandUse(37.0, 6.0);
  // One earlier failure plus this one must not trip the breaker: the success in
  // between cleared the count, so this lookup still reached the network.
  let reached = false;
  global.fetch = (async () => { reached = true; return overpassResponse([{ tags: { landuse: 'quarry' } }]); }) as typeof fetch;
  await lookupLandUse(37.5, 6.5);
  assert.ok(reached, 'the breaker must not be open after an intervening success');
});

// --- local index (the default path) -----------------------------------------
// These four hit the REAL shipped data/industrial-sites.json — no fetch mock,
// no network. They're the actual requirement this rewrite exists for: a
// local, offline lookup that resolves the incidents that motivated it
// (Bellara, the El Hamma plant) without depending on Overpass being up.

test('lookupLandUse: local index — Bellara steel complex is industrial, with a name', async () => {
  useRealLocalIndex();
  const info = await lookupLandUse(36.7495, 6.2520);
  assert.equal(info.context, 'industrial');
  assert.ok(info.siteName, 'expected a site name from the local index');
});

test('lookupLandUse: local index — El Hamma power plant (Algiers) is industrial', async () => {
  useRealLocalIndex();
  const info = await lookupLandUse(36.7490, 3.0825);
  assert.equal(info.context, 'industrial');
});

test('lookupLandUse: local index — Chréa forest (Blida) is natural, no industrial site nearby', async () => {
  useRealLocalIndex();
  const info = await lookupLandUse(36.42, 2.86);
  assert.equal(info.context, 'natural');
});

test('lookupLandUse: a missing index file falls back to Overpass, which still fails soft as "unknown"', async () => {
  // beforeEach already points ALGERIE_FEUX_INDUSTRIAL_INDEX_PATH at a file
  // that doesn't exist — this is the default state for every test above,
  // made explicit here as the thing actually under test.
  global.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  const info = await lookupLandUse(36.0, 5.0);
  assert.equal(info.context, 'unknown');
});
