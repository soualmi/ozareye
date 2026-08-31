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

// Replays the engine over a historical day, printing the exact Telegram
// messages it would have produced. Never sends anything — read-only.
// Usage: npm run replay -- 2026-08-26 [bbox]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { clusterDetections, collectDetections, enrichWeatherHistorical, minutesSince, telegramText, ALERT_SCORE_THRESHOLD, type FireEvent } from '../lib/fire-monitor';

function loadEnvLocal() {
  const p = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
loadEnvLocal();

// west,south,east,north — padded bbox around the wilaya de Béjaïa.
const BEJAIA_BOX = '4.2,36.1,5.6,37.0';
// Matches the deployed cron cadence (README: POST /api/monitor every 20 minutes).
const CRON_INTERVAL_MIN = 20;

async function main() {
  const date = process.argv[2] ?? '2026-08-26';
  const box = process.argv[3] ?? BEJAIA_BOX;
  const mapKey = process.env.FIRMS_MAP_KEY;
  if (!mapKey) {
    console.error('FIRMS_MAP_KEY missing. Add it to .env.local (see .env.example) before running the replay.');
    process.exit(1);
  }

  console.log(`Replaying ${date} over bbox ${box}\n`);
  const detections = await collectDetections(mapKey, { box, date });
  console.log(`\n${detections.length} raw detection(s)\n`);

  const events = clusterDetections(detections, []);
  console.log(`${events.length} fire event(s) after clustering (~2km/12h)\n`);

  const enriched: FireEvent[] = [];
  for (const event of events) enriched.push(event.score >= 55 ? await enrichWeatherHistorical(event) : event);

  const alerted = enriched.filter(e => e.score >= ALERT_SCORE_THRESHOLD).sort((a, b) => a.lastAcquiredAt.localeCompare(b.lastAcquiredAt));
  console.log(`${alerted.length} event(s) would have crossed the alert threshold (score >= ${ALERT_SCORE_THRESHOLD})\n`);

  // ONE reference "now" for the whole replay — the moment the monitor would next
  // have polled after the last detection in the batch — not wall-clock now (which
  // would put every event days in the past) and not each event's own timestamp
  // (which trivially yields a 0min age for all of them).
  const latestDetectionMs = Math.max(...alerted.map(e => new Date(e.lastAcquiredAt).getTime()));
  const referenceTime = new Date(latestDetectionMs + CRON_INTERVAL_MIN * 60_000);
  console.log(`Replay reference time: ${referenceTime.toISOString()} (last detection + ${CRON_INTERVAL_MIN}min cron cycle)\n`);

  console.log('='.repeat(60));
  for (const event of alerted) {
    const ageMin = minutesSince(event.lastAcquiredAt, referenceTime);
    assert.ok(ageMin > 0, `event ${event.id}: age must be > 0 against the replay reference time, got ${ageMin}min`);
    const text = telegramText(event, referenceTime);
    console.log(`\n--- event ${event.id} · score ${event.score} · ${text.length} chars ---\n`);
    console.log(text);
    console.log('\n' + '='.repeat(60));
  }
  if (!alerted.length) console.log('\n(no event reached the alert threshold)');
}

main();
