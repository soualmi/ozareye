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

// Wind-fetch-failure counterpart to lib/replay-meteosat-fasttrack.test.ts,
// in its own process/DB for the same reason that file is separate from
// lib/replay-meteosat.test.ts: a fresh scenario needs a fresh database.
// Proves speed still wins when Open-Meteo is down: the fast-tracked alert
// sends anyway (fail-soft, same as every other alert), just without a
// downwind section it has no real data to fill in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const replayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ozareye-replay-meteosat-fasttrack-windfail-test-'));
process.env.ALGERIE_FEUX_DB_PATH = path.join(replayDir, 'replay.db');

const VILLAGE_LAT = 36.72, VILLAGE_LON = 5.08;

const stubPath = path.join(replayDir, 'meteosat-fasttrack-stub.mjs');
fs.writeFileSync(stubPath, `#!/usr/bin/env node
const since = process.argv.find(a => a.startsWith('--since=')).slice('--since='.length);
if (since.startsWith('2026-08-26')) {
  console.log(JSON.stringify({ lat: ${VILLAGE_LAT}, lon: ${VILLAGE_LON}, radius_km: 1.3, frp_or_intensity: null, confidence: null, acquired_at: '2026-08-26T10:00:00Z' }));
  console.log(JSON.stringify({ lat: ${VILLAGE_LAT}, lon: ${VILLAGE_LON}, radius_km: 1.3, frp_or_intensity: null, confidence: null, acquired_at: '2026-08-26T10:10:00Z' }));
}
`);
fs.chmodSync(stubPath, 0o755);
process.env.METEOSAT_PYTHON_BIN = stubPath;

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('firms.modaps.eosdis.nasa.gov')) return new Response('latitude,longitude\n', { status: 200 });
  if (url.includes('overpass-api.de')) return new Response(JSON.stringify({ elements: [] }), { status: 200 });
  // Simulated Open-Meteo outage — every archive call fails.
  if (url.includes('archive-api.open-meteo.com')) throw new TypeError('fetch failed (simulated Open-Meteo outage)');
  throw new Error(`unexpected fetch in replay-meteosat-fasttrack-windfail test: ${url}`);
}) as typeof fetch;

const { runReplay } = await import('./replay');

const sent: string[] = [];
const result = await runReplay({
  from: '2026-08-26', to: '2026-08-26',
  mapKey: 'test-key', box: '4.2,36.1,7.6,37.0',
  landUseDelayMs: 0, weatherDelayMs: 0, weatherRetries: 0,
  withMeteosat: true,
  send: alert => { sent.push(alert.text); },
});

test('Tier 2 fast-track status is independent of weather enrichment succeeding', () => {
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].status, 'corroborated', 'the fast-track already set this before enrichWeather ever ran');
});

test('Tier 2 fast-track alert still sends when the wind fetch fails — omits the downwind section instead of guessing or blocking', () => {
  assert.equal(result.alerts.length, 1, 'speed matters more than a missing wind line here — the alert still fires');
  const text = sent[0];
  assert.match(text, /Signal géostationnaire Meteosat/);
  assert.doesNotMatch(text, /vent \d/, 'no fabricated wind reading');
  assert.match(text, /Pas de village <20km sous le vent/, 'the same honest "not evaluated" fallback every other alert already uses when wind enrichment fails — nothing invented for the fast-track path specifically');
});
