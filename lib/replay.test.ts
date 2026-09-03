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

// The two guarantees replay mode has to make, tested against the real engine:
// it never sends a Telegram message, and it never writes to the production
// database. Everything outbound is stubbed, so this test hits no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROD_DB = path.join(process.cwd(), 'data', 'signals.db');
const replayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ozareye-replay-test-'));
const REPLAY_DB = path.join(replayDir, 'replay.db');
process.env.ALGERIE_FEUX_DB_PATH = REPLAY_DB;

const { assertReplayDb, eachDay, runReplay } = await import('./replay');

// Béjaïa hinterland: inside the shipped village index, so exposure and message
// rendering exercise the real data rather than an empty set.
const LAT = 36.72, LON = 5.08;

function firmsCsv(day: string): string {
  const rows = [
    `${LAT},${LON},330.1,0.4,0.4,${day},1342,N20,VIIRS,h,2.0NRT,45.2,D`,
    `${LAT + 0.004},${LON},329.0,0.4,0.4,${day},1342,N20,VIIRS,h,2.0NRT,38.4,D`,
    `${LAT},${LON + 0.004},331.2,0.4,0.4,${day},1342,N20,VIIRS,h,2.0NRT,41.0,D`,
  ];
  return `latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,frp,daynight\n${rows.join('\n')}\n`;
}

const telegramCalls: string[] = [];
const overpassCalls: string[] = [];
const archiveCalls: string[] = [];

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('api.telegram.org')) {
    telegramCalls.push(url);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (url.includes('firms.modaps.eosdis.nasa.gov')) {
    const day = url.split('/').pop()!;
    // Only the first replayed day has a fire; the second is quiet, which also
    // proves an empty day doesn't re-alert the event carried over from day one.
    return new Response(day === '2026-08-26' ? firmsCsv(day) : 'latitude,longitude\n', { status: 200 });
  }
  if (url.includes('archive-api.open-meteo.com')) {
    archiveCalls.push(url);
    const time = Array.from({ length: 24 }, (_, h) => `2026-08-26T${String(h).padStart(2, '0')}:00`);
    return new Response(JSON.stringify({
      hourly: {
        time,
        relative_humidity_2m: time.map(() => 21),
        wind_speed_10m: time.map(() => 34),
        wind_direction_10m: time.map(() => 250),
      },
    }), { status: 200 });
  }
  if (url.includes('overpass-api.de')) {
    overpassCalls.push(url);
    return new Response(JSON.stringify({ elements: [] }), { status: 200 });
  }
  throw new Error(`unexpected fetch in replay test: ${url}`);
}) as typeof fetch;

const prodBefore = fs.existsSync(PROD_DB) ? fs.statSync(PROD_DB) : null;

const sent: string[] = [];
const result = await runReplay({
  from: '2026-08-26', to: '2026-08-27',
  mapKey: 'test-key', box: '4.2,36.1,5.6,37.0',
  landUseDelayMs: 0,
  send: alert => { sent.push(alert.text); },
});

test('replay never sends a Telegram message', () => {
  assert.equal(telegramCalls.length, 0, 'replay must not call api.telegram.org');
  // The assertion above is only meaningful if the run actually produced
  // something the live monitor WOULD have sent.
  assert.ok(result.alerts.length >= 1, 'fixture must produce at least one alert-worthy event');
  assert.equal(sent.length, result.alerts.length, 'every alert goes to the injected sink, not the network');
  assert.match(sent[0], /À VÉRIFIER/);
});

test('replay writes only to its own database, never the production one', () => {
  assert.ok(fs.existsSync(REPLAY_DB), 'replay database must have been created');
  if (prodBefore) {
    const after = fs.statSync(PROD_DB);
    assert.equal(after.mtimeMs, prodBefore.mtimeMs, 'production database mtime must be unchanged');
    assert.equal(after.size, prodBefore.size, 'production database size must be unchanged');
  }
});

test('replay refuses to run against the production database', () => {
  assert.throws(() => assertReplayDb(path.join('data', 'signals.db')), /refusing to run against the production database/);
  const saved = process.env.ALGERIE_FEUX_DB_PATH;
  delete process.env.ALGERIE_FEUX_DB_PATH;
  try {
    assert.throws(() => assertReplayDb(), /ALGERIE_FEUX_DB_PATH must be set/);
  } finally {
    process.env.ALGERIE_FEUX_DB_PATH = saved;
  }
});

test('replay uses the historical archive API, not the forecast API', () => {
  assert.ok(archiveCalls.length >= 1, 'weather must come from archive-api.open-meteo.com');
  assert.ok(archiveCalls.every(u => u.includes('start_date=2026-08-26')), 'archive window must be the replayed day');
});

test('events carry over between replayed days and keep their pass history', () => {
  assert.equal(result.days.length, 2);
  assert.equal(result.events.length, 1, 'the three pixels are one clustered event');
  assert.equal(result.events[0].detections.length, 3);
  assert.equal(result.alerts.length, 1, 'a quiet second day must not re-alert');
});

test('eachDay walks the range inclusively in chronological order', () => {
  assert.deepEqual(eachDay('2026-08-25', '2026-08-29'), ['2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29']);
});
