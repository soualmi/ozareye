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

// runReplay's --with-slstr path (lib/replay.ts): proves SLSTR archives
// actually get fetched per replayed day and fed through the real fusion
// path, including rule (c)'s alert gate — an SLSTR-only event may only
// alert once corroborated (>=2 passes, >=30min apart, OR corroborated by a
// second independent secondary sensor) AND a village sits within the
// widened proximity radius. A separate process (own SLSTR_PYTHON_BIN stub,
// own throwaway DB) rather than adding this to lib/replay.test.ts or
// lib/replay-meteosat.test.ts: each scenario needs its own database, since
// lib/db/sqlite.ts's DB path is a singleton captured once at module load.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const replayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ozareye-replay-slstr-test-'));
process.env.ALGERIE_FEUX_DB_PATH = path.join(replayDir, 'replay.db');

// A real village (Béjaïa hinterland, data/villages.json — also used by
// lib/replay.test.ts / lib/replay-meteosat.test.ts) — placing detections
// exactly there makes hasNearbyVillage() true regardless of wind. Same
// coordinate as the Meteosat replay test, deliberately NOT Constantine's
// exact centre (sits inside a real local industrial-site index entry).
const VILLAGE_LAT = 36.72, VILLAGE_LON = 5.08;

const stubPath = path.join(replayDir, 'slstr-stub.mjs');
fs.writeFileSync(stubPath, `#!/usr/bin/env node
const since = process.argv.find(a => a.startsWith('--since=')).slice('--since='.length);
if (since.startsWith('2026-08-26')) {
  console.log(JSON.stringify({ lat: ${VILLAGE_LAT}, lon: ${VILLAGE_LON}, frp_mw: 19.9, uncertainty_mw: 4.02, confidence: '91', acquired_at: '2026-08-26T10:00:00Z', satellite: 'S3A' }));
  console.log(JSON.stringify({ lat: ${VILLAGE_LAT}, lon: ${VILLAGE_LON}, frp_mw: 107.6, uncertainty_mw: 11.26, confidence: '100', acquired_at: '2026-08-26T10:40:00Z', satellite: 'S3A' }));
}
`);
fs.chmodSync(stubPath, 0o755);
process.env.SLSTR_PYTHON_BIN = stubPath;

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('firms.modaps.eosdis.nasa.gov')) return new Response('latitude,longitude\n', { status: 200 });
  if (url.includes('overpass-api.de')) return new Response(JSON.stringify({ elements: [] }), { status: 200 });
  if (url.includes('archive-api.open-meteo.com')) {
    const time = Array.from({ length: 24 }, (_, h) => `2026-08-26T${String(h).padStart(2, '0')}:00`);
    return new Response(JSON.stringify({ hourly: { time, relative_humidity_2m: time.map(() => 30), wind_speed_10m: time.map(() => 15), wind_direction_10m: time.map(() => 200) } }), { status: 200 });
  }
  throw new Error(`unexpected fetch in replay-slstr test: ${url}`);
}) as typeof fetch;

const { runReplay } = await import('./replay');

const sent: string[] = [];
const result = await runReplay({
  from: '2026-08-26', to: '2026-08-26',
  mapKey: 'test-key', box: '4.2,36.1,7.6,37.0',
  landUseDelayMs: 0, weatherDelayMs: 0, weatherRetries: 0,
  withSlstr: true,
  send: alert => { sent.push(alert.text); },
});

test('--with-slstr fetches the day\'s SLSTR_FRP archive and merges it into sources/', () => {
  const slstr = result.sources.find(s => s.source === 'SLSTR_FRP');
  assert.ok(slstr, 'an SLSTR source row must be recorded for the replayed day');
  assert.equal(slstr!.rows, 2);
  assert.equal(result.slstrDetectionsPerDay?.['2026-08-26'], 2);
});

test('an SLSTR-only event reaching the corroboration gate near a village alerts under rule (c), with its real FRP carried through', () => {
  assert.equal(result.events.length, 1, 'the two passes cluster into one event');
  const event = result.events[0];
  assert.equal(event.positionSource, 'slstr');
  assert.equal(event.status, 'corroborated', '2 passes 40 minutes apart clears the >=2/>=30min gate');
  assert.equal(event.maxFrp, 107.6, 'unlike Meteosat, SLSTR carries a real FRP reading through to the event');
  assert.equal(result.alerts.length, 1, 'a village sits exactly at the event\'s position, so rule (c) must fire');
  assert.match(sent[0], /Signal Sentinel-3 SLSTR/);
  assert.match(sent[0], /puissance détectée \(Sentinel-3\) : 107\.6 MW/, 'the alert text must say the FRP came from SLSTR, not silently show a bare number');
});
