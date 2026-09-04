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

// runReplay's --with-meteosat path (lib/replay.ts): proves Meteosat archives
// actually get fetched per replayed day and fed through the real fusion path,
// including rule (e)'s alert gate — a Meteosat-only event may only alert once
// corroborated (>=2 passes, >=30min apart) AND a village sits within the
// widened proximity radius. A separate process (own METEOSAT_PYTHON_BIN stub,
// own throwaway DB) rather than adding this to lib/replay.test.ts: that file's
// DB path is captured once at module load by lib/db/sqlite.ts's singleton, so
// a second scenario needs its own process to get its own database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const replayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ozareye-replay-meteosat-test-'));
process.env.ALGERIE_FEUX_DB_PATH = path.join(replayDir, 'replay.db');

// A real village (Béjaïa hinterland, data/villages.json — also used by
// lib/replay.test.ts) — placing detections exactly there makes
// hasNearbyVillage() true regardless of wind, since it's a raw distance
// check, not the wind-dependent exposure list. Deliberately NOT Constantine's
// exact centre: that coordinate sits inside a real local industrial-site
// index entry (Bardo cuivre, data/industrial-sites.json), which would lower
// the event's status one rung and mask what this test is checking.
const VILLAGE_LAT = 36.72, VILLAGE_LON = 5.08;

const stubPath = path.join(replayDir, 'meteosat-stub.mjs');
fs.writeFileSync(stubPath, `#!/usr/bin/env node
const since = process.argv.find(a => a.startsWith('--since=')).slice('--since='.length);
if (since.startsWith('2026-08-26')) {
  console.log(JSON.stringify({ lat: ${VILLAGE_LAT}, lon: ${VILLAGE_LON}, radius_km: 1.3, frp_or_intensity: null, confidence: null, acquired_at: '2026-08-26T10:00:00Z' }));
  console.log(JSON.stringify({ lat: ${VILLAGE_LAT}, lon: ${VILLAGE_LON}, radius_km: 1.3, frp_or_intensity: null, confidence: null, acquired_at: '2026-08-26T10:40:00Z' }));
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
  throw new Error(`unexpected fetch in replay-meteosat test: ${url}`);
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

test('--with-meteosat fetches the day\'s MTG_FIR archive and merges it into sources/', () => {
  const mtg = result.sources.find(s => s.source === 'MTG_FIR');
  assert.ok(mtg, 'a Meteosat source row must be recorded for the replayed day');
  assert.equal(mtg!.rows, 2);
  assert.equal(result.meteosatDetectionsPerDay?.['2026-08-26'], 2);
});

test('a Meteosat-only event reaching the corroboration gate near a village alerts under rule (e)', () => {
  assert.equal(result.events.length, 1, 'the two passes cluster into one event');
  const event = result.events[0];
  assert.equal(event.positionSource, 'meteosat');
  assert.equal(event.status, 'corroborated', '2 passes 40 minutes apart clears the >=2/>=30min gate');
  assert.equal(result.alerts.length, 1, 'a village sits exactly at the event\'s position, so rule (e) must fire');
  assert.match(sent[0], /Signal géostationnaire Meteosat/);
});
