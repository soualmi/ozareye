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

// The one contract lib/db/sqlite.ts and lib/db/postgres.ts both implement.
// lib/database.ts (the public module the rest of the app imports from) just
// picks one of the two at startup and delegates every call to it — neither
// the engine nor any route ever imports this file or a backend directly, so
// dialect differences (placeholders, upsert syntax, INSERT OR IGNORE vs
// ON CONFLICT DO NOTHING, ...) stay fully inside each backend module.
import type { FireEvent } from '../fire-monitor';
import { DEFAULT_BOX, DEFAULT_FRP_THRESHOLD_MW, DEFAULT_PROXIMITY_KM, DEFAULT_PERSISTENT_SOURCE_DAY_THRESHOLD } from '../fire-monitor';

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

export type ConfigPatch = Partial<Omit<EngineConfig, 'bbox' | 'villageBuildStatus'>> & {
  bbox?: Partial<EngineConfig['bbox']>;
  villageBuildStatus?: VillageBuildStatus;
};

// One row per named data source (the three FIRMS VIIRS feeds today; nothing
// stops a caller from passing 'open-meteo' or 'overpass-landuse' as `source`
// tomorrow — the table and the watchdog logic in lib/source-health.ts are
// keyed on this string, not on a fixed enum). incidentOpenSince/lastNotifiedAt
// are both null whenever no incident is open — see lib/source-health.ts for
// the state machine that reads and writes this shape.
export type SourceHealthRow = {
  source: string;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  incidentOpenSince: string | null;
  lastNotifiedAt: string | null;
};

export function defaultSourceHealth(source: string): SourceHealthRow {
  return { source, consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, incidentOpenSince: null, lastNotifiedAt: null };
}

// One row per event that has been checked against Sentinel-2 dNBR imagery
// (lib/burnscar.ts / scripts/burn-scar-verify.py). classification carries
// the script's French verdict verbatim; dnbrMean/dates are null when the
// window had no usable scene (too cloudy / not yet acquired) — the row is
// still written so the next run knows a check happened at verifiedAt.
export type BurnScarVerificationRow = {
  eventId: string;
  preDate: string | null;
  postDate: string | null;
  dnbrMean: number | null;
  classification: 'confirmé' | 'probable' | 'non confirmé' | 'indéterminé';
  cloudCoverPre: number | null;
  cloudCoverPost: number | null;
  verifiedAt: string;
};

export interface Backend {
  initDb(): Promise<void>;
  saveSignal(event: FireEvent): Promise<void>;
  markNotified(id: string): Promise<void>;
  wasNotified(id: string): Promise<boolean>;
  latestSignals(): Promise<FireEvent[]>;
  activeEvents(sinceHours?: number): Promise<FireEvent[]>;
  isFirstRun(): Promise<boolean>;
  clearFireHistory(): Promise<void>;
  recordDetectionDay(cell: string, day: string): Promise<void>;
  distinctDayCount(cell: string, sinceDay: string): Promise<number>;
  pruneHotspotHistory(beforeDay: string): Promise<void>;
  // "Détection précoce" signal 2 (lib/fire-monitor.ts) — the local FRP
  // history a real VIIRS detection is compared against. Sibling table to
  // hotspot_days above (same cell key, same 30-day retention/cutoff), keyed
  // additionally by hour-of-day since a cell's normal FRP genuinely varies
  // by time of day (afternoon heat vs. night). One row per (cell, day,
  // hour) holding that hour's max FRP — recordFrpObservation upserts the
  // higher of the existing and new value.
  recordFrpObservation(cell: string, day: string, hour: number, frp: number): Promise<void>;
  // Average max-FRP for (cell, hour) over days >= sinceDay, plus how many
  // distinct days contributed — null when there's no history at all yet
  // (a brand-new cell), letting the caller apply EARLY_DETECTION_ANOMALY_MIN_SAMPLES.
  frpBaseline(cell: string, hour: number, sinceDay: string): Promise<{ avgFrp: number; days: number } | null>;
  pruneFrpHistory(beforeDay: string): Promise<void>;
  eventsSince(sinceIso: string, limit?: number): Promise<FireEvent[]>;
  eventsBetween(fromIso: string, toIso: string, limit?: number): Promise<FireEvent[]>;
  getConfig(): Promise<EngineConfig>;
  updateConfig(patch: ConfigPatch): Promise<EngineConfig>;
  getSourceHealth(source: string): Promise<SourceHealthRow | undefined>;
  upsertSourceHealth(row: SourceHealthRow): Promise<void>;
  // Small free-form cursor store — today just the Meteosat ingest "since"
  // timestamp (lib/meteosat.ts), keyed by an arbitrary string like
  // source_health above, so a second pull-based source tomorrow doesn't need
  // a schema change either.
  getIngestState(key: string): Promise<string | null>;
  setIngestState(key: string, value: string): Promise<void>;
  // Sentinel-2 dNBR burn-scar verification results (scaffold; populated
  // only once real Sentinel-2 access is wired — see lib/burnscar.ts).
  getBurnScarVerification(eventId: string): Promise<BurnScarVerificationRow | undefined>;
  upsertBurnScarVerification(row: BurnScarVerificationRow): Promise<void>;
}

// The values this instance already shipped and ran with before /setup or
// Postgres support existed — both backends migrate this in verbatim on the
// very first getConfig() call against an empty config table, so an existing
// SQLite deployment (or a brand new Postgres one seeded fresh) keeps working
// unchanged. See README section 5 for what these used to be hardcoded as:
// DEFAULT_BOX, DEFAULT_PROXIMITY_KM, DEFAULT_FRP_THRESHOLD_MW,
// DEFAULT_PERSISTENT_SOURCE_DAY_THRESHOLD.
export function algeriaSeedConfig(readVillageCount: () => number): EngineConfig {
  const villageCount = readVillageCount();
  const now = new Date().toISOString();
  const [west, south, east, north] = DEFAULT_BOX.split(',').map(Number);
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
