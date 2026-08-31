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

// Proves the actual requirement — a timing-out outbound call is caught and
// logged, not fatal — without waiting on a real slow server: global.fetch is
// stubbed to reject exactly the way AbortSignal.timeout() makes a real fetch
// reject (a DOMException named 'TimeoutError'), and each function is
// asserted to still resolve with its documented fail-soft result rather than
// throwing/rejecting.
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { fetchDetections, enrichWeather } from './fire-monitor';

function timeoutError() {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

let originalFetch: typeof fetch;
before(() => { originalFetch = global.fetch; });
after(() => { global.fetch = originalFetch; });

test('fetchDetections: a timed-out source is reported as failed, not thrown — the other sources are unaffected', async () => {
  global.fetch = (async () => { throw timeoutError(); }) as typeof fetch;
  const results = await fetchDetections('fake-key');
  assert.equal(results.length, 3, 'all three FIRMS sources still get a result slot');
  for (const r of results) assert.equal(r.rows, null, 'a timed-out source reports rows:null (the same shape as any other fetch failure), not an exception');
});

test('fetchDetections: one source timing out does not affect a source that succeeds', async () => {
  global.fetch = (async (url: string | URL | Request) => {
    if (String(url).includes('VIIRS_NOAA20_NRT')) throw timeoutError();
    return new Response('latitude,longitude,acq_date,acq_time,satellite,instrument,confidence,frp\n', { status: 200 });
  }) as typeof fetch;
  const results = await fetchDetections('fake-key');
  const failed = results.find(r => r.source === 'VIIRS_NOAA20_NRT');
  const ok = results.filter(r => r.source !== 'VIIRS_NOAA20_NRT');
  assert.equal(failed?.rows, null, 'the timed-out source is null');
  for (const r of ok) assert.notEqual(r.rows, null, 'sources that did not time out still return their (empty but non-null) rows array');
});

test('enrichWeather: a timed-out Open-Meteo call returns the event unenriched, not a rejected promise', async () => {
  global.fetch = (async () => { throw timeoutError(); }) as typeof fetch;
  const event = {
    id: 'evt-timeout-test', latitude: 36.5, longitude: 5.5,
    detections: [], firstAcquiredAt: '2026-01-01T00:00:00Z', lastAcquiredAt: '2026-01-01T00:00:00Z',
    maxFrp: 10, maxConfidence: 'h', passCount: 1, maxPixelsInSinglePass: 1,
    score: 60, status: 'observation' as const, evidence: [], evidenceShort: [],
  };
  const result = await enrichWeather(event);
  assert.equal(result.windKph, undefined, 'no weather data got attached — the timeout was swallowed, not silently faked');
  assert.equal(result.score, 60, 'score is untouched, exactly as the existing catch { return event; } behaves for any other Open-Meteo failure');
});
