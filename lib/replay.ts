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

// Replay mode — re-runs the REAL pipeline (FIRMS fetch → clustering →
// historical weather → land-use → village exposure → message rendering) over
// past dates, day by day in chronological order, so first/lastAcquiredAt and
// passCount build up exactly as they would have live.
//
// Three deliberate differences from app/api/monitor/route.ts, each forced by
// the fact that "now" is not the replay's now — all of them are reported in
// run-notes.md rather than hidden:
//   1. Prior-event context comes from eventsBetween() anchored to the replay
//      day, not activeEvents(), which measures 24h back from wall-clock now
//      and would therefore return nothing for an August replay.
//   2. Weather is Open-Meteo's ARCHIVE API at the hour of the satellite pass
//      (enrichWeatherHistorical), not the forecast API's current conditions.
//   3. The 30-day persistent-source guard is NOT applied: it needs 10+ distinct
//      days of history per cell, which a short replay window cannot have, so
//      running it would suppress nothing while implying it had been considered.
//
// Nothing here sends anything. The only outbound calls are FIRMS, Open-Meteo
// and Overpass; alerts go to the injected `send` callback, whose default just
// records them in memory. See lib/replay.test.ts, which stubs global fetch and
// asserts zero requests ever reach api.telegram.org.
import path from 'node:path';
import {
  ALERT_SCORE_THRESHOLD, clusterDetections, enrichWeatherHistorical, fetchDetections, gridCell, lowerStatus, telegramText,
  type Detection, type FireEvent,
} from './fire-monitor';
import { lookupLandUse } from './landuse';
import { eventsBetween, getConfig, initDb, saveSignal } from './database';
import { bboxToString } from '../scripts/build-villages';

// The deployed cron cadence (README: POST /api/monitor every 20 minutes).
// Replay walks each day in 20-minute buckets rather than feeding the day in one
// batch: an event must only ever be scored, alerted and rendered on the
// evidence available at that poll, which is the whole point of showing what
// OzarEye "would have said" and when.
export const CRON_INTERVAL_MIN = 20;
const BUCKET_MS = CRON_INTERVAL_MIN * 60_000;

// Mirrors app/api/monitor/route.ts's ESCALATION_SCORE_DELTA / STATUS_RANK /
// shouldAlert. Kept as a copy rather than exported from the route module (a
// Next.js route file should export only its HTTP handlers) — if the live rule
// changes, this must change with it.
const ESCALATION_SCORE_DELTA = 15;
const STATUS_RANK: Record<FireEvent['status'], number> = { observation: 0, corroborated: 1, urgent: 2 };

function shouldAlert(event: FireEvent): boolean {
  if (event.score < ALERT_SCORE_THRESHOLD) return false;
  if (!event.notifiedAt) return true;
  const scoreGrew = event.score - (event.notifiedScore ?? 0) >= ESCALATION_SCORE_DELTA;
  const statusEscalated = STATUS_RANK[event.status] > STATUS_RANK[event.notifiedStatus ?? 'observation'];
  return scoreGrew || statusEscalated;
}

export type ReplayAlert = {
  eventId: string;
  day: string;
  renderedAtIso: string;
  score: number;
  status: FireEvent['status'];
  maxFrp: number;
  text: string;
};

export type ReplaySourceLog = { day: string; source: string; rows: number | 'FAILED'; error?: string };

export type ReplayResult = {
  days: string[];
  box: string;
  sources: ReplaySourceLog[];
  events: FireEvent[];
  alerts: ReplayAlert[];
  landUseLookups: number;
  landUseUnknown: number;
  /** True when the Overpass circuit breaker tripped: the endpoint was
   *  unreachable, so land-use was left unevaluated for the rest of the run. */
  landUseCircuitOpen: boolean;
  landUseSkipped: number;
  /** Archive-API calls attempted, and how many still came back without wind
   *  after retries — those events get no exposure computed at all. */
  weatherLookups: number;
  weatherFailures: number;
  detectionsPerDay: Record<string, number>;
};

export type ReplayOptions = {
  from: string;
  to: string;
  mapKey: string;
  box?: string;
  /** Spacing between Overpass lookups — it 429s under load, and replay hits it
   *  far faster than the live 20-minute cron ever does. */
  landUseDelayMs?: number;
  /** Spacing before each Open-Meteo archive call. Live enriches a handful of
   *  events every 20 minutes; a replay fires hundreds in a burst and gets rate
   *  limited, which fails soft as "no wind" — and an event with no wind gets no
   *  exposure computed at all, so the message reads "no village downwind" when
   *  the truth is "not evaluated". Throttling keeps that from swamping the run. */
  weatherDelayMs?: number;
  /** Retries when an archive call comes back without wind. */
  weatherRetries?: number;
  /** Consecutive failed lookups after which Overpass is abandoned for the rest
   *  of the run. Live has no such breaker (it retries every 20 minutes, which
   *  is free); a replay would otherwise spend a 10s timeout per event proving
   *  the same endpoint is still down. */
  landUseFailureLimit?: number;
  /** Where alerts go. The default records them and sends nothing; nothing in
   *  this module ever posts to Telegram. */
  send?: (alert: ReplayAlert) => void | Promise<void>;
  log?: (message: string) => void;
};

// Replay MUST run against its own database file. Called before any DB access:
// an unset or production-pointing ALGERIE_FEUX_DB_PATH aborts the run rather
// than quietly writing replayed August events into live data.
export function assertReplayDb(dbPath = process.env.ALGERIE_FEUX_DB_PATH): string {
  if (!dbPath) throw new Error('replay: ALGERIE_FEUX_DB_PATH must be set to a replay-only database file');
  const resolved = path.resolve(dbPath);
  if (resolved === path.resolve(process.cwd(), 'data', 'signals.db')) {
    throw new Error('replay: refusing to run against the production database (data/signals.db)');
  }
  return resolved;
}

export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Same shape as the route's applyLandUse: industrial context lowers the status,
// everything else is annotation. Failures return 'unknown' and are counted.
async function applyLandUse(event: FireEvent): Promise<FireEvent> {
  const landUse = await lookupLandUse(event.latitude, event.longitude);
  if (landUse.context !== 'industrial') return { ...event, landUse };
  return { ...event, landUse, status: lowerStatus(event.status) };
}

export async function runReplay(options: ReplayOptions): Promise<ReplayResult> {
  assertReplayDb();
  const { from, to, mapKey, landUseDelayMs = 1_200, landUseFailureLimit = 3, weatherDelayMs = 200, weatherRetries = 2 } = options;
  const log = options.log ?? (() => {});
  const alerts: ReplayAlert[] = [];
  const send = options.send ?? (() => {});

  await initDb();
  const config = await getConfig();
  const box = options.box ?? bboxToString(config.bbox);
  const days = eachDay(from, to);
  const sources: ReplaySourceLog[] = [];
  const detectionsPerDay: Record<string, number> = {};
  let weatherLookups = 0, weatherFailures = 0;
  let landUseLookups = 0, landUseUnknown = 0, landUseSkipped = 0, consecutiveLandUseFailures = 0;
  let landUseCircuitOpen = false;
  // lookupLandUse caches per ~1km cell for the process lifetime, so only a
  // first-time cell actually reaches Overpass — and only those need the delay.
  const landUseCells = new Set<string>();

  for (const day of days) {
    const dayStartMs = Date.parse(`${day}T00:00:00Z`);
    const results = await fetchDetections(mapKey, { box, date: day });
    const detections: Detection[] = [];
    for (const r of results) {
      sources.push({ day, source: r.source, rows: r.rows === null ? 'FAILED' : r.rows.length, error: r.error });
      if (r.rows) detections.push(...r.rows);
    }
    detectionsPerDay[day] = detections.length;
    log(`${day}: ${detections.length} detection(s) from ${results.filter(r => r.rows).length}/${results.length} source(s)`);

    // One bucket per simulated cron poll, chronological.
    const buckets = new Map<number, Detection[]>();
    for (const d of detections) {
      const slot = Math.floor(Date.parse(d.acquiredAt) / BUCKET_MS) * BUCKET_MS;
      if (!buckets.has(slot)) buckets.set(slot, []);
      buckets.get(slot)!.push(d);
    }

    for (const slot of [...buckets.keys()].sort((a, b) => a - b)) {
    const bucketDetections = buckets.get(slot)!;
    // The poll that would have seen these detections: the end of their bucket.
    const pollTime = new Date(slot + BUCKET_MS);

    // The live equivalent is activeEvents(24) — 24h back from NOW. Anchored to
    // the poll being simulated instead, so an event first seen on the 26th is
    // still open for clustering when the 27th's passes arrive.
    const prior = await eventsBetween(new Date(slot - 86_400_000).toISOString(), pollTime.toISOString());
    const clustered = clusterDetections(bucketDetections, prior, config.frpThresholdMw);
    // Only events this poll actually touched get re-scored, enriched and saved;
    // the rest are untouched rows already in the replay database.
    const bucketWindow = { start: slot, end: slot + BUCKET_MS };
    const events = clustered.filter(e => e.detections.some(d => {
      const t = Date.parse(d.acquiredAt);
      return t >= bucketWindow.start && t < bucketWindow.end;
    }));

    for (const raw of events) {
      let event = raw;
      if (raw.score >= 55) {
        weatherLookups++;
        for (let attempt = 0; attempt <= weatherRetries; attempt++) {
          if (weatherDelayMs > 0) await sleep(weatherDelayMs);
          event = await enrichWeatherHistorical(raw);
          if (event.windKph !== undefined) break;
          if (attempt < weatherRetries) await sleep(500 * (attempt + 1));
        }
        if (event.windKph === undefined) weatherFailures++;
      }
      const cell = gridCell(raw.latitude, raw.longitude);
      if (landUseCircuitOpen) {
        landUseSkipped++;
      } else if (landUseCells.has(cell)) {
        event = await applyLandUse(event); // cache hit inside lookupLandUse: no network, no delay
      } else {
        landUseCells.add(cell);
        landUseLookups++;
        event = await applyLandUse(event);
        if (event.landUse?.context === 'unknown') {
          landUseUnknown++;
          // Failures aren't cached by lookupLandUse, so drop the cell too —
          // and count towards the breaker.
          landUseCells.delete(cell);
          if (++consecutiveLandUseFailures >= landUseFailureLimit) {
            landUseCircuitOpen = true;
            log(`land-use: ${consecutiveLandUseFailures} consecutive failures — Overpass abandoned for the rest of this run, land use left unevaluated`);
          }
        } else {
          consecutiveLandUseFailures = 0;
        }
        if (landUseDelayMs > 0 && !landUseCircuitOpen) await sleep(landUseDelayMs);
      }

      if (shouldAlert(event)) {
        // "What a reader would have received, when": the poll that saw it.
        const renderedAt = pollTime;
        const alert: ReplayAlert = {
          eventId: event.id, day, renderedAtIso: renderedAt.toISOString(),
          score: event.score, status: event.status, maxFrp: event.maxFrp,
          text: telegramText(event, renderedAt, config.proximityKm),
        };
        alerts.push(alert);
        await send(alert);
        // Mark exactly as the live route does after a successful send, so
        // re-alert suppression/escalation behaves identically across days.
        event.notifiedAt = renderedAt.toISOString();
        event.notifiedScore = event.score;
        event.notifiedStatus = event.status;
      }
      await saveSignal(event);
    }
    }
  }

  const first = days[0], last = days[days.length - 1];
  const events = await eventsBetween(`${first}T00:00:00.000Z`, `${last}T23:59:59.999Z`, 5_000);
  return { days, box, sources, events, alerts, landUseLookups, landUseUnknown, landUseCircuitOpen, landUseSkipped, weatherLookups, weatherFailures, detectionsPerDay };
}
