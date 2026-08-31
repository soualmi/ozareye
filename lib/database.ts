// Algérie Feux Alerte
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

// Node's built-in SQLite (stable as of Node 22.13, already this project's
// minimum) instead of a native addon like better-sqlite3 — a compiled .node
// binding doesn't survive being bundled into the app's ESM server chunk
// (its `bindings` loader needs __filename, undefined in that context), while
// a core module needs no bundling special-case at all.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { FireEvent } from './fire-monitor';

const DB_PATH = path.join(process.cwd(), 'data', 'signals.db');
let instance: DatabaseSync | null = null;

function db() {
  if (!instance) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    instance = new DatabaseSync(DB_PATH);
    instance.exec('PRAGMA journal_mode = WAL');
  }
  return instance;
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS fire_events (id TEXT PRIMARY KEY, payload TEXT NOT NULL, score INTEGER NOT NULL, first_acquired_at TEXT NOT NULL, last_acquired_at TEXT NOT NULL, notified_at TEXT)`;
const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS idx_fire_events_last ON fire_events(last_acquired_at DESC)`;
// One row per (~1km cell, calendar day) a detection was seen in — used to spot
// persistent sources (flares, industrial heat) that fire on far more days than
// a real wildfire ever would. See PERSISTENT_SOURCE_DAY_THRESHOLD.
const CREATE_HOTSPOT_TABLE = `CREATE TABLE IF NOT EXISTS hotspot_days (cell TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (cell, day))`;

export async function initDb() { db().exec(CREATE_TABLE); db().exec(CREATE_INDEX); db().exec(CREATE_HOTSPOT_TABLE); }

export async function saveSignal(event: FireEvent) {
  db().prepare(`INSERT INTO fire_events (id,payload,score,first_acquired_at,last_acquired_at,notified_at) VALUES (@id,@payload,@score,@firstAcquiredAt,@lastAcquiredAt,@notifiedAt)
    ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, score=excluded.score, last_acquired_at=excluded.last_acquired_at, notified_at=excluded.notified_at`)
    .run({ id: event.id, payload: JSON.stringify(event), score: event.score, firstAcquiredAt: event.firstAcquiredAt, lastAcquiredAt: event.lastAcquiredAt, notifiedAt: event.notifiedAt ?? null });
}

export async function markNotified(id: string) {
  const now = new Date().toISOString();
  db().prepare('UPDATE fire_events SET notified_at=? WHERE id=?').run(now, id);
  const row = db().prepare('SELECT payload FROM fire_events WHERE id=?').get(id) as { payload: string } | undefined;
  if (row) {
    const event = JSON.parse(row.payload) as FireEvent;
    event.notifiedAt = now; event.notifiedScore = event.score; event.notifiedStatus = event.status;
    db().prepare('UPDATE fire_events SET payload=? WHERE id=?').run(JSON.stringify(event), id);
  }
}

export async function wasNotified(id: string) {
  const row = db().prepare('SELECT notified_at FROM fire_events WHERE id=?').get(id) as { notified_at: string | null } | undefined;
  return Boolean(row?.notified_at);
}

export async function latestSignals() {
  const rows = db().prepare('SELECT payload FROM fire_events ORDER BY last_acquired_at DESC LIMIT 100').all() as { payload: string }[];
  return rows.map(r => JSON.parse(r.payload) as FireEvent);
}

// Events still "active" for clustering purposes — new detections merge into these
// instead of spawning duplicate events for the same fire across polling runs.
export async function activeEvents(sinceHours = 24): Promise<FireEvent[]> {
  const cutoff = new Date(Date.now() - sinceHours * 3_600_000).toISOString();
  const rows = db().prepare('SELECT payload FROM fire_events WHERE last_acquired_at >= ? ORDER BY last_acquired_at DESC').all(cutoff) as { payload: string }[];
  return rows.map(r => JSON.parse(r.payload) as FireEvent);
}

export async function isFirstRun() {
  const row = db().prepare('SELECT COUNT(*) as c FROM fire_events').get() as { c: number };
  return row.c === 0;
}

export async function recordDetectionDay(cell: string, day: string) {
  db().prepare('INSERT OR IGNORE INTO hotspot_days (cell, day) VALUES (?, ?)').run(cell, day);
}

export async function distinctDayCount(cell: string, sinceDay: string): Promise<number> {
  const row = db().prepare('SELECT COUNT(*) as c FROM hotspot_days WHERE cell = ? AND day >= ?').get(cell, sinceDay) as { c: number };
  return row.c;
}

export async function pruneHotspotHistory(beforeDay: string) {
  db().prepare('DELETE FROM hotspot_days WHERE day < ?').run(beforeDay);
}

// Dashboard read-only queries — never called from /api/monitor.
export async function eventsSince(sinceIso: string, limit = 200): Promise<FireEvent[]> {
  const rows = db().prepare('SELECT payload FROM fire_events WHERE last_acquired_at >= ? ORDER BY last_acquired_at DESC LIMIT ?').all(sinceIso, limit) as { payload: string }[];
  return rows.map(r => JSON.parse(r.payload) as FireEvent);
}

export async function eventsBetween(fromIso: string, toIso: string, limit = 500): Promise<FireEvent[]> {
  const rows = db().prepare('SELECT payload FROM fire_events WHERE last_acquired_at >= ? AND last_acquired_at <= ? ORDER BY last_acquired_at DESC LIMIT ?').all(fromIso, toIso, limit) as { payload: string }[];
  return rows.map(r => JSON.parse(r.payload) as FireEvent);
}
