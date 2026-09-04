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

// Postgres backend for Vercel deployments, via @neondatabase/serverless.
// @vercel/postgres (the older, once-standard package) is deprecated by
// Vercel itself as of the Neon-powered "Vercel Postgres" transition —
// @neondatabase/serverless is what Vercel's own docs point to now: a
// fetch/HTTP-based driver with no persistent TCP pool to manage, which is
// exactly the shape a serverless function invocation wants (verified against
// npm's registry metadata: @vercel/postgres carries a deprecation notice
// pointing here; @neondatabase/serverless is actively published).
//
// Dialect differences from lib/db/sqlite.ts, all contained here:
//   - $1/$2 placeholders — handled transparently by the sql`...` tagged
//     template, not written out by hand.
//   - INSERT ... ON CONFLICT (id) DO UPDATE SET x = EXCLUDED.x — Postgres's
//     own syntax, which SQLite borrowed; nearly identical to the SQLite
//     version, but this is the ORIGINAL of that syntax, not a port of it.
//   - SQLite's `INSERT OR IGNORE` -> Postgres's `ON CONFLICT (...) DO NOTHING`.
//   - `configured` is a native BOOLEAN column here (SQLite has no boolean
//     type, hence its INTEGER 0/1 + Boolean() there); the driver already
//     hands back a JS boolean for it, no conversion needed.
//   - No PRAGMA/WAL step — irrelevant to Postgres.
//   - Every timestamp/date column stays TEXT (ISO 8601 strings), exactly as
//     in SQLite, specifically so lexicographic string comparison keeps
//     matching chronological order identically on both backends — no
//     TIMESTAMP/timezone conversion surface to diverge on.
import { neon } from '@neondatabase/serverless';
import type { FireEvent } from '../fire-monitor';
import type { Backend, ConfigPatch, EngineConfig, SourceHealthRow, VillageBuildStatus } from './types';
import { algeriaSeedConfig } from './types';
import fs from 'node:fs';
import path from 'node:path';

type ConfigRow = {
  country_name: string; country_iso2: string; country_iso3: string;
  bbox_west: number; bbox_south: number; bbox_east: number; bbox_north: number;
  frp_threshold_mw: number; proximity_km: number; persistent_source_days: number;
  configured: boolean; village_build_status: string;
};

function rowToConfig(row: ConfigRow): EngineConfig {
  return {
    countryName: row.country_name, countryIso2: row.country_iso2, countryIso3: row.country_iso3,
    bbox: { west: row.bbox_west, south: row.bbox_south, east: row.bbox_east, north: row.bbox_north },
    frpThresholdMw: row.frp_threshold_mw, proximityKm: row.proximity_km, persistentSourceDays: row.persistent_source_days,
    configured: row.configured,
    villageBuildStatus: JSON.parse(row.village_build_status) as VillageBuildStatus,
  };
}

function readShippedVillageCount(): number {
  try {
    const villagesPath = path.join(process.cwd(), 'data', 'villages.json');
    return (JSON.parse(fs.readFileSync(villagesPath, 'utf8')) as unknown[]).length;
  } catch { return 0; }
}

type SourceHealthDbRow = {
  source: string; consecutive_failures: number; last_success_at: string | null; last_failure_at: string | null;
  last_error: string | null; incident_open_since: string | null; last_notified_at: string | null;
};

function dbRowToSourceHealth(row: SourceHealthDbRow): SourceHealthRow {
  return {
    source: row.source, consecutiveFailures: row.consecutive_failures,
    lastSuccessAt: row.last_success_at, lastFailureAt: row.last_failure_at, lastError: row.last_error,
    incidentOpenSince: row.incident_open_since, lastNotifiedAt: row.last_notified_at,
  };
}

export function createPostgresBackend(connectionString: string): Backend {
  const sql = neon(connectionString);

  async function insertConfig(config: EngineConfig) {
    await sql`INSERT INTO config (id, country_name, country_iso2, country_iso3, bbox_west, bbox_south, bbox_east, bbox_north, frp_threshold_mw, proximity_km, persistent_source_days, configured, village_build_status, updated_at)
      VALUES (1, ${config.countryName}, ${config.countryIso2}, ${config.countryIso3}, ${config.bbox.west}, ${config.bbox.south}, ${config.bbox.east}, ${config.bbox.north}, ${config.frpThresholdMw}, ${config.proximityKm}, ${config.persistentSourceDays}, ${config.configured}, ${JSON.stringify(config.villageBuildStatus)}, ${new Date().toISOString()})`;
  }

  return {
    async initDb() {
      await sql`CREATE TABLE IF NOT EXISTS fire_events (id TEXT PRIMARY KEY, payload TEXT NOT NULL, score INTEGER NOT NULL, first_acquired_at TEXT NOT NULL, last_acquired_at TEXT NOT NULL, notified_at TEXT)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_fire_events_last ON fire_events(last_acquired_at DESC)`;
      await sql`CREATE TABLE IF NOT EXISTS hotspot_days (cell TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (cell, day))`;
      await sql`CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        country_name TEXT NOT NULL,
        country_iso2 TEXT NOT NULL,
        country_iso3 TEXT NOT NULL,
        bbox_west REAL NOT NULL, bbox_south REAL NOT NULL, bbox_east REAL NOT NULL, bbox_north REAL NOT NULL,
        frp_threshold_mw REAL NOT NULL,
        proximity_km REAL NOT NULL,
        persistent_source_days INTEGER NOT NULL,
        configured BOOLEAN NOT NULL,
        village_build_status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`;
      await sql`CREATE TABLE IF NOT EXISTS source_health (
        source TEXT PRIMARY KEY,
        consecutive_failures INTEGER NOT NULL,
        last_success_at TEXT,
        last_failure_at TEXT,
        last_error TEXT,
        incident_open_since TEXT,
        last_notified_at TEXT
      )`;
      await sql`CREATE TABLE IF NOT EXISTS ingest_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`;
    },

    // The upsert the whole de-dup fix depends on — Postgres's native
    // ON CONFLICT ... DO UPDATE ... EXCLUDED syntax (the one SQLite adopted
    // for its own compatibility, so this reads almost identically to
    // lib/db/sqlite.ts's version, just with $-style params supplied via the
    // template literal instead of named @params).
    async saveSignal(event: FireEvent) {
      await sql`INSERT INTO fire_events (id, payload, score, first_acquired_at, last_acquired_at, notified_at)
        VALUES (${event.id}, ${JSON.stringify(event)}, ${event.score}, ${event.firstAcquiredAt}, ${event.lastAcquiredAt}, ${event.notifiedAt ?? null})
        ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, score = EXCLUDED.score, last_acquired_at = EXCLUDED.last_acquired_at, notified_at = EXCLUDED.notified_at`;
    },

    async markNotified(id: string) {
      const now = new Date().toISOString();
      await sql`UPDATE fire_events SET notified_at = ${now} WHERE id = ${id}`;
      const rows = await sql`SELECT payload FROM fire_events WHERE id = ${id}` as { payload: string }[];
      const row = rows[0];
      if (row) {
        const event = JSON.parse(row.payload) as FireEvent;
        event.notifiedAt = now; event.notifiedScore = event.score; event.notifiedStatus = event.status;
        await sql`UPDATE fire_events SET payload = ${JSON.stringify(event)} WHERE id = ${id}`;
      }
    },

    async wasNotified(id: string) {
      const rows = await sql`SELECT notified_at FROM fire_events WHERE id = ${id}` as { notified_at: string | null }[];
      return Boolean(rows[0]?.notified_at);
    },

    async latestSignals() {
      const rows = await sql`SELECT payload FROM fire_events ORDER BY last_acquired_at DESC LIMIT 100` as { payload: string }[];
      return rows.map(r => JSON.parse(r.payload) as FireEvent);
    },

    async activeEvents(sinceHours = 24) {
      const cutoff = new Date(Date.now() - sinceHours * 3_600_000).toISOString();
      const rows = await sql`SELECT payload FROM fire_events WHERE last_acquired_at >= ${cutoff} ORDER BY last_acquired_at DESC` as { payload: string }[];
      return rows.map(r => JSON.parse(r.payload) as FireEvent);
    },

    async isFirstRun() {
      const rows = await sql`SELECT COUNT(*)::int as c FROM fire_events` as { c: number }[];
      return rows[0].c === 0;
    },

    async clearFireHistory() {
      await sql`DELETE FROM fire_events`;
      await sql`DELETE FROM hotspot_days`;
    },

    // SQLite's `INSERT OR IGNORE` -> Postgres's `ON CONFLICT (...) DO NOTHING`,
    // targeting the same (cell, day) primary key as the conflict.
    async recordDetectionDay(cell: string, day: string) {
      await sql`INSERT INTO hotspot_days (cell, day) VALUES (${cell}, ${day}) ON CONFLICT (cell, day) DO NOTHING`;
    },

    async distinctDayCount(cell: string, sinceDay: string) {
      const rows = await sql`SELECT COUNT(*)::int as c FROM hotspot_days WHERE cell = ${cell} AND day >= ${sinceDay}` as { c: number }[];
      return rows[0].c;
    },

    async pruneHotspotHistory(beforeDay: string) {
      await sql`DELETE FROM hotspot_days WHERE day < ${beforeDay}`;
    },

    async eventsSince(sinceIso: string, limit = 200) {
      const rows = await sql`SELECT payload FROM fire_events WHERE last_acquired_at >= ${sinceIso} ORDER BY last_acquired_at DESC LIMIT ${limit}` as { payload: string }[];
      return rows.map(r => JSON.parse(r.payload) as FireEvent);
    },

    async eventsBetween(fromIso: string, toIso: string, limit = 500) {
      const rows = await sql`SELECT payload FROM fire_events WHERE last_acquired_at >= ${fromIso} AND last_acquired_at <= ${toIso} ORDER BY last_acquired_at DESC LIMIT ${limit}` as { payload: string }[];
      return rows.map(r => JSON.parse(r.payload) as FireEvent);
    },

    // Migrates the Algeria seed in on the very first call if the table is
    // still empty (a fresh Postgres database with no config row yet).
    async getConfig() {
      const rows = await sql`SELECT * FROM config WHERE id = 1` as ConfigRow[];
      if (rows[0]) return rowToConfig(rows[0]);
      const seed = algeriaSeedConfig(readShippedVillageCount);
      await insertConfig(seed);
      return seed;
    },

    async updateConfig(patch: ConfigPatch) {
      const current = await this.getConfig();
      const next: EngineConfig = {
        ...current, ...patch,
        bbox: { ...current.bbox, ...patch.bbox },
        villageBuildStatus: patch.villageBuildStatus ?? current.villageBuildStatus,
      };
      await sql`UPDATE config SET country_name = ${next.countryName}, country_iso2 = ${next.countryIso2}, country_iso3 = ${next.countryIso3},
        bbox_west = ${next.bbox.west}, bbox_south = ${next.bbox.south}, bbox_east = ${next.bbox.east}, bbox_north = ${next.bbox.north},
        frp_threshold_mw = ${next.frpThresholdMw}, proximity_km = ${next.proximityKm}, persistent_source_days = ${next.persistentSourceDays},
        configured = ${next.configured}, village_build_status = ${JSON.stringify(next.villageBuildStatus)}, updated_at = ${new Date().toISOString()}
        WHERE id = 1`;
      return next;
    },

    async getSourceHealth(source: string) {
      const rows = await sql`SELECT * FROM source_health WHERE source = ${source}` as SourceHealthDbRow[];
      return rows[0] ? dbRowToSourceHealth(rows[0]) : undefined;
    },

    async upsertSourceHealth(row: SourceHealthRow) {
      await sql`INSERT INTO source_health (source, consecutive_failures, last_success_at, last_failure_at, last_error, incident_open_since, last_notified_at)
        VALUES (${row.source}, ${row.consecutiveFailures}, ${row.lastSuccessAt}, ${row.lastFailureAt}, ${row.lastError}, ${row.incidentOpenSince}, ${row.lastNotifiedAt})
        ON CONFLICT (source) DO UPDATE SET consecutive_failures = EXCLUDED.consecutive_failures, last_success_at = EXCLUDED.last_success_at,
          last_failure_at = EXCLUDED.last_failure_at, last_error = EXCLUDED.last_error, incident_open_since = EXCLUDED.incident_open_since, last_notified_at = EXCLUDED.last_notified_at`;
    },

    async getIngestState(key: string) {
      const rows = await sql`SELECT value FROM ingest_state WHERE key = ${key}` as { value: string }[];
      return rows[0]?.value ?? null;
    },

    async setIngestState(key: string, value: string) {
      await sql`INSERT INTO ingest_state (key, value, updated_at) VALUES (${key}, ${value}, ${new Date().toISOString()})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
    },
  };
}
