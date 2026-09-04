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

// Public storage API — every route/engine file imports from here, and only
// from here; nothing outside this file (or lib/db/*) knows or cares whether
// data is actually sitting in SQLite or Postgres. Every export below has the
// exact same name and signature it always had — this file just adds one
// layer of indirection to an async call that was already async.
//
// Picks a backend once, at first use, from the environment:
//   - POSTGRES_URL or DATABASE_URL set  -> lib/db/postgres.ts (Vercel deploys;
//     DATABASE_URL is what Vercel's native Neon integration actually injects
//     today, POSTGRES_URL is kept for older/other Postgres providers)
//   - neither set                       -> lib/db/sqlite.ts (VPS/systemd,
//     local dev, every test — today's exact behaviour, completely unchanged)
// The chosen backend module is dynamically imported so the *other* one's
// dependency (node:sqlite vs @neondatabase/serverless) is never even loaded.
import type { FireEvent } from './fire-monitor';
import type { Backend, ConfigPatch, SourceHealthRow } from './db/types';

export type { EngineConfig, VillageBuildStatus, SourceHealthRow } from './db/types';

let backendPromise: Promise<Backend> | null = null;

function loadBackend(): Promise<Backend> {
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  return connectionString
    ? import('./db/postgres').then(m => m.createPostgresBackend(connectionString))
    : import('./db/sqlite').then(m => m.createSqliteBackend());
}

function backend(): Promise<Backend> {
  if (!backendPromise) backendPromise = loadBackend();
  return backendPromise;
}

export async function initDb() { return (await backend()).initDb(); }
export async function saveSignal(event: FireEvent) { return (await backend()).saveSignal(event); }
export async function markNotified(id: string) { return (await backend()).markNotified(id); }
export async function wasNotified(id: string) { return (await backend()).wasNotified(id); }
export async function latestSignals() { return (await backend()).latestSignals(); }
export async function activeEvents(sinceHours?: number) { return (await backend()).activeEvents(sinceHours); }
export async function isFirstRun() { return (await backend()).isFirstRun(); }
export async function clearFireHistory() { return (await backend()).clearFireHistory(); }
export async function recordDetectionDay(cell: string, day: string) { return (await backend()).recordDetectionDay(cell, day); }
export async function distinctDayCount(cell: string, sinceDay: string) { return (await backend()).distinctDayCount(cell, sinceDay); }
export async function pruneHotspotHistory(beforeDay: string) { return (await backend()).pruneHotspotHistory(beforeDay); }
export async function eventsSince(sinceIso: string, limit?: number) { return (await backend()).eventsSince(sinceIso, limit); }
export async function eventsBetween(fromIso: string, toIso: string, limit?: number) { return (await backend()).eventsBetween(fromIso, toIso, limit); }
export async function getConfig() { return (await backend()).getConfig(); }
export async function updateConfig(patch: ConfigPatch) { return (await backend()).updateConfig(patch); }
export async function getSourceHealth(source: string) { return (await backend()).getSourceHealth(source); }
export async function upsertSourceHealth(row: SourceHealthRow) { return (await backend()).upsertSourceHealth(row); }
export async function getIngestState(key: string) { return (await backend()).getIngestState(key); }
export async function setIngestState(key: string, value: string) { return (await backend()).setIngestState(key, value); }
