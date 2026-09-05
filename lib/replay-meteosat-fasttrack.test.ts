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

// Proves Tier 2's fast-track alert is immediately actionable, not a bare
// position pin: it goes through the SAME enrichWeather+village-selection
// gate as any other corroborated Meteosat event (lib/replay.ts's
// secondaryEligible check, mirrored 1:1 from app/api/monitor/route.ts) —
// no separate simplified path was built for it. Own process/DB, same
// rationale as lib/replay-meteosat.test.ts: each scenario needs its own
// database (lib/db/sqlite.ts's DB path is a singleton captured once at
// module load) — the wind-fetch-failure counterpart to this test lives in
// lib/replay-meteosat-fasttrack-windfail.test.ts for exactly that reason.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const replayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ozareye-replay-meteosat-fasttrack-test-'));
process.env.ALGERIE_FEUX_DB_PATH = path.join(replayDir, 'replay.db');

// Same real village coordinate as lib/replay-meteosat.test.ts (Béjaïa
// hinterland) — deliberately not Constantine's centre (real local
// industrial-site index entry there).
const VILLAGE_LAT = 36.72, VILLAGE_LON = 5.08;

// Two Meteosat passes exactly 10 minutes apart — Tier 2's fast-track shape,
// not the 40-minute-apart shape lib/replay-meteosat.test.ts already covers.
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
  if (url.includes('archive-api.open-meteo.com')) {
    const time = Array.from({ length: 24 }, (_, h) => `2026-08-26T${String(h).padStart(2, '0')}:00`);
    return new Response(JSON.stringify({ hourly: { time, relative_humidity_2m: time.map(() => 30), wind_speed_10m: time.map(() => 15), wind_direction_10m: time.map(() => 200) } }), { status: 200 });
  }
  throw new Error(`unexpected fetch in replay-meteosat-fasttrack test: ${url}`);
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

test('Tier 2 fast-track (2 passes 10min apart) reaches corroborated and alerts, unlike the old 40min-apart shape', () => {
  assert.equal(result.events.length, 1, 'the two 10min-apart passes cluster into one event');
  const event = result.events[0];
  assert.equal(event.positionSource, 'meteosat');
  assert.equal(event.status, 'corroborated', 'Tier 2: 2 passes 10min apart corroborate immediately');
  assert.equal(result.alerts.length, 1, 'a village sits exactly at the event\'s position — the fast-tracked alert must fire');
});

test('Tier 2 fast-track alert names nearby AND downwind villages, using real wind data — not a bare position pin', () => {
  const text = sent[0];
  assert.match(text, /Signal géostationnaire Meteosat/, 'still carries the honest Meteosat-only position caveat');
  assert.match(text, /à proximité/, 'nearby-village line present, from the SAME enrichWeather+selectExposedVillages pipeline as any other alert');
  assert.match(text, /vent \d+(\.\d+)? km\/h/, 'real wind data rendered, not a placeholder');
});
