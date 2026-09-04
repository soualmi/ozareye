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
  ALERT_SCORE_THRESHOLD, clusterDetections, EARLY_DETECTION_ANOMALY_MIN_SAMPLES, EARLY_DETECTION_ANOMALY_MULTIPLIER,
  effectiveProximityKm, enrichWeatherHistorical, fetchDetections, gridCell, hasNearbyVillage, isMeteosatDetection, lowerStatus, telegramText,
  DEFAULT_PERSISTENT_SOURCE_WINDOW_DAYS, MTG_SOURCE, type Detection, type FireEvent,
} from './fire-monitor';
import { fetchMeteosatRange } from './meteosat';
import { lookupLandUse } from './landuse';
import { eventsBetween, frpBaseline, getConfig, initDb, pruneFrpHistory, recordFrpObservation, saveSignal } from './database';
import { bboxToString } from '../scripts/build-villages';

// The deployed cron cadence (README: POST /api/monitor every 20 minutes).
// Replay walks each day in 20-minute buckets rather than feeding the day in one
// batch: an event must only ever be scored, alerted and rendered on the
// evidence available at that poll, which is the whole point of showing what
// OzarEye "would have said" and when.
export const CRON_INTERVAL_MIN = 20;
const BUCKET_MS = CRON_INTERVAL_MIN * 60_000;

// Mirrors app/api/monitor/route.ts's ESCALATION_SCORE_DELTA / STATUS_RANK /
// shouldAlert, meteosat branch (rule e) included. Kept as a copy rather than
// exported from the route module (a Next.js route file should export only
// its HTTP handlers) — if the live rule changes, this must change with it.
// Exported so scripts/replay-metrics.ts reconstructs "would this have
// alerted, and when" with the exact same rule the fused replay itself used,
// instead of a third hand-rolled copy.
const ESCALATION_SCORE_DELTA = 15;
const STATUS_RANK: Record<FireEvent['status'], number> = { observation: 0, corroborated: 1, urgent: 2 };

export function shouldAlert(event: FireEvent, proximityKm: number): boolean {
  if (event.positionSource === 'meteosat') {
    if (event.status !== 'corroborated') return false;
    if (!hasNearbyVillage(event, effectiveProximityKm(event, proximityKm))) return false;
    return event.notifiedStatus !== 'corroborated';
  }
  if (event.score < ALERT_SCORE_THRESHOLD) return false;
  if (!event.notifiedAt) return true;
  const scoreGrew = event.score - (event.notifiedScore ?? 0) >= ESCALATION_SCORE_DELTA;
  const statusEscalated = STATUS_RANK[event.status] > STATUS_RANK[event.notifiedStatus ?? 'observation'];
  return scoreGrew || statusEscalated;
}

// Détection précoce, signal 2 — mirrors app/api/monitor/route.ts's
// annotateFrpAnomaly exactly (same copy-not-export rationale as shouldAlert
// above). Meteosat detections carry no FRP and are skipped, same as live.
async function annotateFrpAnomaly(detections: Detection[]): Promise<Detection[]> {
  const cutoff = new Date(Date.now() - DEFAULT_PERSISTENT_SOURCE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  await pruneFrpHistory(cutoff);

  const out: Detection[] = [];
  for (const det of detections) {
    if (isMeteosatDetection(det)) { out.push(det); continue; }
    const cell = gridCell(det.latitude, det.longitude);
    const day = det.acquiredAt.slice(0, 10);
    const hour = new Date(det.acquiredAt).getUTCHours();

    let annotated = det;
    try {
      const baseline = await frpBaseline(cell, hour, cutoff);
      if (baseline !== null && baseline.days >= EARLY_DETECTION_ANOMALY_MIN_SAMPLES && det.frp >= baseline.avgFrp * EARLY_DETECTION_ANOMALY_MULTIPLIER) {
        annotated = { ...det, baselineFrpExceeded: true };
      }
    } catch (error) {
      console.log(`FRP baseline lookup FAILED for cell ${cell}h${hour}, skipping anomaly annotation: ${error instanceof Error ? error.message : error}`);
    }
    out.push(annotated);

    try {
      await recordFrpObservation(cell, day, hour, det.frp);
    } catch (error) {
      console.log(`FRP observation record FAILED for cell ${cell}h${hour}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return out;
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
  /** Set only when options.withMeteosat is true — Meteosat detections merged
   *  in per day, alongside the VIIRS rows already counted in sources/. */
  meteosatDetectionsPerDay?: Record<string, number>;
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
  /** Off by default so the original VIIRS-only replay command still
   *  reproduces the original run unchanged. When true, fetches MTG_FIR
   *  archives (EUMDAC, collection EO:EUM:DAT:0801) for each replayed day and
   *  feeds them through the SAME clusterDetections()/scoreEvent() path as
   *  VIIRS, in the same 20-minute buckets — exactly like the live monitor,
   *  just walked day by day instead of polled every 20 minutes. */
  withMeteosat?: boolean;
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
  const meteosatDetectionsPerDay: Record<string, number> = {};
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

    if (options.withMeteosat) {
      const dayEndMs = dayStartMs + 86_400_000;
      const meteosatResult = await fetchMeteosatRange(config.bbox, new Date(dayStartMs).toISOString(), new Date(dayEndMs).toISOString());
      sources.push({ day, source: MTG_SOURCE, rows: meteosatResult.ok ? meteosatResult.detections.length : 'FAILED', error: meteosatResult.error });
      meteosatDetectionsPerDay[day] = meteosatResult.detections.length;
      detections.push(...meteosatResult.detections);
      log(`${day}: ${meteosatResult.ok ? `${meteosatResult.detections.length} Meteosat detection(s)` : `Meteosat FAILED (${meteosatResult.error})`}`);
    }

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
    // Signal 2 only under --with-meteosat: annotating every bucket costs a
    // DB round trip per VIIRS detection, and the plain VIIRS-only command
    // must keep reproducing the original run byte for byte. Rules a-e
    // (clusterDetections) and signals 1/3 (scoreEvent) already fire
    // unconditionally either way — they only need Meteosat rows to be present
    // in bucketDetections, not a flag.
    const scoredDetections = options.withMeteosat ? await annotateFrpAnomaly(bucketDetections) : bucketDetections;
    const clustered = clusterDetections(scoredDetections, prior, config.frpThresholdMw);
    // Only events this poll actually touched get re-scored, enriched and saved;
    // the rest are untouched rows already in the replay database.
    const bucketWindow = { start: slot, end: slot + BUCKET_MS };
    const events = clustered.filter(e => e.detections.some(d => {
      const t = Date.parse(d.acquiredAt);
      return t >= bucketWindow.start && t < bucketWindow.end;
    }));

    for (const raw of events) {
      let event = raw;
      // Meteosat-only events rarely cross score 55 on their own (no real FRP/
      // confidence), but rule (e)'s alert gate needs the same wind/village
      // enrichment as any VIIRS event once it clears 'corroborated' — mirrors
      // app/api/monitor/route.ts's meteosatEligible check exactly.
      const meteosatEligible = raw.positionSource === 'meteosat' && raw.status === 'corroborated';
      if (raw.score >= 55 || meteosatEligible) {
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

      if (shouldAlert(event, config.proximityKm)) {
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
  // A fused run can cluster into far more distinct events nationwide than
  // VIIRS alone (Meteosat's whole-disk, 10-minute cadence sees far more
  // persistent heat sources) — a higher ceiling than the original replay's
  // fixed 5,000 costs nothing when the count stays low.
  const events = await eventsBetween(`${first}T00:00:00.000Z`, `${last}T23:59:59.999Z`, options.withMeteosat ? 50_000 : 5_000);
  return {
    days, box, sources, events, alerts, landUseLookups, landUseUnknown, landUseCircuitOpen, landUseSkipped, weatherLookups, weatherFailures, detectionsPerDay,
    ...(options.withMeteosat ? { meteosatDetectionsPerDay } : {}),
  };
}
