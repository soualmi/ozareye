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

// Proves the "En direct" tab's actual retention rule: activeEvents(24) keys
// off last_acquired_at, not first-seen or insertion order, so an event whose
// latest satellite pass is >24h old (a stale Sétif-style straggler) drops out
// of the live set even though it's well inside history's wider window.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Detection, FireEvent } from './fire-monitor';

process.env.ALGERIE_FEUX_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'algerie-feux-live-window-test-')), 'signals.db');

const { activeEvents, eventsBetween, initDb, saveSignal } = await import('./database');

await initDb();

function det(overrides: Partial<Detection>): Detection {
  return { latitude: 36.86, longitude: 6.44, acquiredAt: '2026-01-01T00:00:00Z', satellite: 'N20', instrument: 'VIIRS', confidence: 'h', frp: 30, ...overrides };
}

function event(id: string, lastAcquiredAt: string): FireEvent {
  return {
    id, latitude: 36.86, longitude: 6.44,
    detections: [det({ acquiredAt: lastAcquiredAt })],
    firstAcquiredAt: lastAcquiredAt, lastAcquiredAt,
    maxFrp: 30, maxConfidence: 'h', passCount: 1, maxPixelsInSinglePass: 1,
    score: 91, status: 'urgent', evidence: [], evidenceShort: [],
  };
}

const now = Date.now();
const staleId = 'evt-setif-stale-63h';
const freshId = 'evt-fresh-2h';
await saveSignal(event(staleId, new Date(now - 63 * 3_600_000).toISOString()));
await saveSignal(event(freshId, new Date(now - 2 * 3_600_000).toISOString()));

test('activeEvents(24) excludes an event whose last pass is 63h old', async () => {
  const ids = (await activeEvents(24)).map(e => e.id);
  assert.equal(ids.includes(staleId), false, 'a 63h-old last pass must not appear in the live window');
});

test('activeEvents(24) includes an event whose last pass is 2h old', async () => {
  const ids = (await activeEvents(24)).map(e => e.id);
  assert.equal(ids.includes(freshId), true, 'a 2h-old last pass must appear in the live window');
});

test('both events remain reachable via eventsBetween — aging out of live never deletes', async () => {
  const from = new Date(now - 7 * 86_400_000).toISOString();
  const to = new Date(now + 3_600_000).toISOString();
  const ids = (await eventsBetween(from, to)).map(e => e.id);
  assert.equal(ids.includes(staleId), true, 'the stale event must still be reachable via history');
  assert.equal(ids.includes(freshId), true, 'the fresh event must still be reachable via history');
});
