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
import { DEFAULT_BOX, DEFAULT_FRP_THRESHOLD_MW, DEFAULT_PROXIMITY_KM, DEFAULT_PERSISTENT_SOURCE_DAY_THRESHOLD } from './fire-monitor';

// Overridable so tests can point at a throwaway file instead of the real,
// possibly-live data/signals.db — set only by test setup, never by the
// running app itself (systemd doesn't set it, so production is unaffected).
const DB_PATH = process.env.ALGERIE_FEUX_DB_PATH || path.join(process.cwd(), 'data', 'signals.db');
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

// Single-row table (id is always 1) holding the one region/tunables record
// this instance runs with — set up via /setup, read by app/api/monitor/route.ts
// on every run instead of the old hardcoded constants. The three secrets
// (FIRMS_MAP_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) deliberately live in
// .env.local, not here — see lib/env-secrets.ts; this table never stores or
// returns them.
const CREATE_CONFIG_TABLE = `CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  country_name TEXT NOT NULL,
  country_iso2 TEXT NOT NULL,
  country_iso3 TEXT NOT NULL,
  bbox_west REAL NOT NULL, bbox_south REAL NOT NULL, bbox_east REAL NOT NULL, bbox_north REAL NOT NULL,
  frp_threshold_mw REAL NOT NULL,
  proximity_km REAL NOT NULL,
  persistent_source_days INTEGER NOT NULL,
  configured INTEGER NOT NULL,
  village_build_status TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

export async function initDb() { db().exec(CREATE_TABLE); db().exec(CREATE_INDEX); db().exec(CREATE_HOTSPOT_TABLE); db().exec(CREATE_CONFIG_TABLE); }

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

// Called by /api/setup/region when the saved bbox/country actually changes.
// Without this, isFirstRun() would still see the old region's rows and stay
// "not first run" — so the new region's first monitor poll would score and
// alert on its own initial backlog instead of seeding silently, exactly the
// blast the first-run guard exists to prevent. Config (this table) is
// untouched; only per-region detection history is cleared.
export async function clearFireHistory() {
  db().exec('DELETE FROM fire_events');
  db().exec('DELETE FROM hotspot_days');
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

// --- Region/tunables config (Part A of the /setup feature) ---------------

export type VillageBuildStatus =
  | { status: 'idle' }
  | { status: 'running'; startedAt: string; step: string }
  | { status: 'success'; startedAt: string; finishedAt: string; villageCount: number; perRegion: Record<string, number>; droppedOutsideBoundary: number; adminBoundariesOk: boolean; adminBoundariesError?: string }
  | { status: 'error'; startedAt: string; finishedAt: string; error: string };

export type EngineConfig = {
  countryName: string;
  countryIso2: string;
  countryIso3: string;
  bbox: { west: number; south: number; east: number; north: number };
  frpThresholdMw: number;
  proximityKm: number;
  persistentSourceDays: number;
  configured: boolean;
  villageBuildStatus: VillageBuildStatus;
};

type ConfigRow = {
  country_name: string; country_iso2: string; country_iso3: string;
  bbox_west: number; bbox_south: number; bbox_east: number; bbox_north: number;
  frp_threshold_mw: number; proximity_km: number; persistent_source_days: number;
  configured: number; village_build_status: string;
};

function rowToConfig(row: ConfigRow): EngineConfig {
  return {
    countryName: row.country_name, countryIso2: row.country_iso2, countryIso3: row.country_iso3,
    bbox: { west: row.bbox_west, south: row.bbox_south, east: row.bbox_east, north: row.bbox_north },
    frpThresholdMw: row.frp_threshold_mw, proximityKm: row.proximity_km, persistentSourceDays: row.persistent_source_days,
    configured: Boolean(row.configured),
    villageBuildStatus: JSON.parse(row.village_build_status) as VillageBuildStatus,
  };
}

// The values this instance already shipped and ran with before /setup
// existed — migrated into the config table verbatim on first read, so the
// existing Algeria deployment keeps working unchanged (see README section 5
// for the equivalents these used to be: DEFAULT_BOX, DEFAULT_PROXIMITY_KM,
// DEFAULT_FRP_THRESHOLD_MW, DEFAULT_PERSISTENT_SOURCE_DAY_THRESHOLD).
function algeriaSeedConfig(): EngineConfig {
  const [west, south, east, north] = DEFAULT_BOX.split(',').map(Number);
  let villageCount = 0;
  try {
    const villagesPath = path.join(process.cwd(), 'data', 'villages.json');
    villageCount = (JSON.parse(fs.readFileSync(villagesPath, 'utf8')) as unknown[]).length;
  } catch { /* shipped data missing — leave count at 0, still not a crash */ }
  const now = new Date().toISOString();
  return {
    countryName: 'Algérie', countryIso2: 'DZ', countryIso3: 'DZA',
    bbox: { west, south, east, north },
    frpThresholdMw: DEFAULT_FRP_THRESHOLD_MW, proximityKm: DEFAULT_PROXIMITY_KM, persistentSourceDays: DEFAULT_PERSISTENT_SOURCE_DAY_THRESHOLD,
    configured: true,
    villageBuildStatus: villageCount > 0
      ? { status: 'success', startedAt: now, finishedAt: now, villageCount, perRegion: {}, droppedOutsideBoundary: 0, adminBoundariesOk: true }
      : { status: 'idle' },
  };
}

function insertConfig(config: EngineConfig) {
  db().prepare(`INSERT INTO config (id, country_name, country_iso2, country_iso3, bbox_west, bbox_south, bbox_east, bbox_north, frp_threshold_mw, proximity_km, persistent_source_days, configured, village_build_status, updated_at)
    VALUES (1, @countryName, @countryIso2, @countryIso3, @west, @south, @east, @north, @frpThresholdMw, @proximityKm, @persistentSourceDays, @configured, @villageBuildStatus, @updatedAt)`)
    .run({
      countryName: config.countryName, countryIso2: config.countryIso2, countryIso3: config.countryIso3,
      west: config.bbox.west, south: config.bbox.south, east: config.bbox.east, north: config.bbox.north,
      frpThresholdMw: config.frpThresholdMw, proximityKm: config.proximityKm, persistentSourceDays: config.persistentSourceDays,
      configured: config.configured ? 1 : 0, villageBuildStatus: JSON.stringify(config.villageBuildStatus),
      updatedAt: new Date().toISOString(),
    });
}

// Reads the single config row, migrating in the Algeria seed on the very
// first call if the table is still empty (a fresh clone, or this instance
// before this feature existed).
export async function getConfig(): Promise<EngineConfig> {
  const row = db().prepare('SELECT * FROM config WHERE id = 1').get() as ConfigRow | undefined;
  if (row) return rowToConfig(row);
  const seed = algeriaSeedConfig();
  insertConfig(seed);
  return seed;
}

export async function updateConfig(patch: Partial<Omit<EngineConfig, 'bbox' | 'villageBuildStatus'>> & { bbox?: Partial<EngineConfig['bbox']>; villageBuildStatus?: VillageBuildStatus }): Promise<EngineConfig> {
  const current = await getConfig();
  const next: EngineConfig = {
    ...current, ...patch,
    bbox: { ...current.bbox, ...patch.bbox },
    villageBuildStatus: patch.villageBuildStatus ?? current.villageBuildStatus,
  };
  db().prepare(`UPDATE config SET country_name=@countryName, country_iso2=@countryIso2, country_iso3=@countryIso3,
    bbox_west=@west, bbox_south=@south, bbox_east=@east, bbox_north=@north,
    frp_threshold_mw=@frpThresholdMw, proximity_km=@proximityKm, persistent_source_days=@persistentSourceDays,
    configured=@configured, village_build_status=@villageBuildStatus, updated_at=@updatedAt WHERE id = 1`)
    .run({
      countryName: next.countryName, countryIso2: next.countryIso2, countryIso3: next.countryIso3,
      west: next.bbox.west, south: next.bbox.south, east: next.bbox.east, north: next.bbox.north,
      frpThresholdMw: next.frpThresholdMw, proximityKm: next.proximityKm, persistentSourceDays: next.persistentSourceDays,
      configured: next.configured ? 1 : 0, villageBuildStatus: JSON.stringify(next.villageBuildStatus),
      updatedAt: new Date().toISOString(),
    });
  return next;
}
