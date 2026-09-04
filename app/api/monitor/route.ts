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

import {
  ALERT_SCORE_THRESHOLD, clusterDetections, EARLY_DETECTION_ANOMALY_MIN_SAMPLES, EARLY_DETECTION_ANOMALY_MULTIPLIER, effectiveProximityKm, enrichWeather, eventWilaya, fetchDetections, gridCell, hasNearbyVillage, isMeteosatDetection, lowerStatus, telegramText,
  DEFAULT_PERSISTENT_SOURCE_WINDOW_DAYS, FIRMS_SOURCES, MTG_SOURCE, SLSTR_SOURCE, type Detection, type FireEvent,
} from '@/lib/fire-monitor';
import { fetchMeteosatSlots } from '@/lib/meteosat';
import { fetchSlstrPasses } from '@/lib/slstr';
import { lookupLandUse } from '@/lib/landuse';
import { activeEvents, distinctDayCount, frpBaseline, getConfig, initDb, isFirstRun, pruneFrpHistory, pruneHotspotHistory, recordDetectionDay, recordFrpObservation, saveSignal, type EngineConfig } from '@/lib/database';
import { bboxToString } from '@/scripts/build-villages';
import { chatIdForWilaya } from '@/lib/wilaya-routing';
import { appendRunLog } from '@/lib/run-log';
import { recordSourceOutcome } from '@/lib/source-health';
import { preferIpv4 } from '@/lib/prefer-ipv4';

// Applied once when this route module first loads — the earliest point the
// server runs our own code — so every outbound lookup in the run below
// resolves A records first. See lib/prefer-ipv4.ts.
preferIpv4();

const ESCALATION_SCORE_DELTA = 15;
const STATUS_RANK: Record<FireEvent['status'], number> = { observation: 0, corroborated: 1, urgent: 2 };

// Meteosat/SLSTR fusion, rule (e)/(c), locked and extended to SLSTR: a
// secondary-only event (Meteosat-only, SLSTR-only, or a mix) alerts ONLY
// once it's cleared the secondary alert gate (already enforced by
// scoreEvent() capping status at 'corroborated' only when that gate is met —
// 'observation' otherwise) AND a village sits within the widened proximity
// radius (±3km for Meteosat, ±1km for SLSTR — effectiveProximityKm already
// knows the difference). Status can never exceed 'corroborated' for these
// events, so there is no "escalation" to re-alert on — this fires exactly
// once, when the gate is first met, same one-shot shape as a VIIRS event's
// very first alert.
function shouldAlert(event: FireEvent, proximityKm: number) {
  if (event.positionSource === 'meteosat' || event.positionSource === 'slstr') {
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

// Records every detection's (cell, day) and drops detections from cells that
// have shown up on more than persistentSourceDays distinct days in the
// rolling window — a real wildfire doesn't keep re-igniting the same 1km spot
// for weeks; a gas flare or industrial heat source does. persistentSourceDays
// comes from the region config (/setup); the window itself stays fixed.
async function suppressPersistentSources(detections: Detection[], persistentSourceDays: number): Promise<{ kept: Detection[]; suppressed: number }> {
  const cutoff = new Date(Date.now() - DEFAULT_PERSISTENT_SOURCE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  await pruneHotspotHistory(cutoff);

  const cellDays = new Map<string, Set<string>>();
  for (const det of detections) {
    const cell = gridCell(det.latitude, det.longitude);
    const day = det.acquiredAt.slice(0, 10);
    if (!cellDays.has(cell)) cellDays.set(cell, new Set());
    cellDays.get(cell)!.add(day);
  }
  for (const [cell, days] of cellDays) for (const day of days) await recordDetectionDay(cell, day);

  const persistentCells = new Set<string>();
  for (const cell of cellDays.keys()) {
    const count = await distinctDayCount(cell, cutoff);
    if (count > persistentSourceDays) persistentCells.add(cell);
  }

  const kept: Detection[] = [];
  let suppressed = 0;
  for (const det of detections) {
    const cell = gridCell(det.latitude, det.longitude);
    if (persistentCells.has(cell)) { suppressed++; console.log(`suppressed: persistent source (cell ${cell})`); }
    else kept.push(det);
  }
  return { kept, suppressed };
}

// Détection précoce, signal 2 (lib/fire-monitor.ts's EARLY_DETECTION_ANOMALY_*):
// flags a detection whose FRP is significantly above the stored 30-day
// local (cell, hour-of-day) baseline — reuses hotspot_days' window/cutoff
// shape (see suppressPersistentSources above), on the sibling frp_history
// table (lib/database.ts). The baseline is read BEFORE today's own value is
// recorded, so a detection is never compared against itself. Meteosat
// detections are skipped entirely — they carry no FRP to compare (always
// 0). SLSTR detections are NOT skipped: unlike Meteosat, SLSTR carries a
// real per-detection FRP (see lib/slstr.ts), so it's a legitimate anomaly
// signal too, and isMeteosatDetection() below only ever excludes Meteosat.
// Fail-soft per detection: any DB error just skips that one detection's
// annotation, never blocks or throws.
async function annotateFrpAnomaly(detections: Detection[]): Promise<Detection[]> {
  const cutoff = new Date(Date.now() - DEFAULT_PERSISTENT_SOURCE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  await pruneFrpHistory(cutoff);

  const out: Detection[] = [];
  for (const det of detections) {
    if (isMeteosatDetection(det)) { out.push(det); continue; }
    const cell = gridCell(det.latitude, det.longitude);
    const day = det.acquiredAt.slice(0, 10);
    const hour = new Date(det.acquiredAt).getUTCHours();

    // Two independent fail-soft steps, each pushed/recorded exactly once —
    // a failure in either must never duplicate or drop this detection.
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

// Land-use context (lib/landuse.ts, an OSM/Overpass lookup): tags an event
// when it sits on a known industrial/energy site and lowers its status one
// rung so it never reads as a top "urgent" red alert for what is very likely
// a permanent heat source — but never drops it, since an industrial site can
// genuinely catch fire too. Runs for every clustered event; Overpass calls
// are cached per ~1km cell and fail soft (context 'unknown', event
// untouched otherwise) — see lib/landuse.ts.
async function applyLandUse(event: FireEvent): Promise<FireEvent> {
  const landUse = await lookupLandUse(event.latitude, event.longitude);
  if (landUse.context !== 'industrial') return { ...event, landUse };
  return { ...event, landUse, status: lowerStatus(event.status) };
}

// Two independent credentials, either one sufficient — never removed, only
// added to. The VPS/systemd cron (scripts/run-monitor.sh) sends
// `x-monitor-secret` on a POST, exactly as before. Vercel Cron Jobs always
// call via GET and cannot send a custom header, but automatically attach
// `Authorization: Bearer ${CRON_SECRET}` when CRON_SECRET is set as a
// project env var — Vercel's own documented pattern for securing cron
// routes (vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs).
// Both env vars are optional independently; a request is authorized if it
// presents a value that matches whichever secret is actually configured.
function isAuthorized(request: Request): boolean {
  const monitorSecret = process.env.MONITOR_SECRET;
  if (monitorSecret && request.headers.get('x-monitor-secret') === monitorSecret) return true;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && request.headers.get('authorization') === `Bearer ${cronSecret}`) return true;
  return false;
}

async function runMonitor(request: Request): Promise<Response> {
  if (!isAuthorized(request)) return Response.json({ error: 'Non autorisé' }, { status: 401 });
  const mapKey = process.env.FIRMS_MAP_KEY, botToken = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!mapKey || !botToken || !chatId) return Response.json({ error: 'Variables FIRMS/Telegram manquantes' }, { status: 503 });

  // Everything from here through fetchDetections must succeed before any
  // source actually gets polled. An exception in this stretch (DB down,
  // corrupt config row, ...) is exactly the kind of silent-failure risk the
  // watchdog exists for — see lib/source-health.ts — so it counts as a
  // failure for every FIRMS source, same as an "Invalid MAP_KEY" would.
  let config: EngineConfig, firstRun: boolean;
  try {
    await initDb();
    // Region + tunables come from the /setup config record, not hardcoded
    // constants — see lib/database.ts getConfig()/updateConfig(). A fresh
    // instance gets the migrated Algeria defaults here until /setup changes them.
    config = await getConfig();
    firstRun = await isFirstRun();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`monitor run CRASHED before sources were polled: ${message}`);
    await Promise.all([...FIRMS_SOURCES, MTG_SOURCE, SLSTR_SOURCE].map(source => recordSourceOutcome(source, { success: false, error: `run crashed: ${message}`.slice(0, 200) })));
    return Response.json({ error: 'Erreur interne' }, { status: 500 });
  }

  const sourceResults = await fetchDetections(mapKey, { box: bboxToString(config.bbox) });
  await Promise.all(sourceResults.map(r => recordSourceOutcome(r.source, r.rows === null ? { success: false, error: r.error ?? 'erreur inconnue' } : { success: true })));
  const rawDetections = sourceResults.flatMap(r => r.rows ?? []);

  // Meteosat: independent of, and sequential after, the FIRMS sources —
  // never lets a slow/down EUMETSAT Data Store hold up VIIRS, and its own
  // failure is watchdog-tracked exactly like a FIRMS source's (see
  // lib/meteosat.ts's fail-soft contract).
  const meteosatResult = await fetchMeteosatSlots(config.bbox);
  await recordSourceOutcome(MTG_SOURCE, meteosatResult.ok ? { success: true } : { success: false, error: meteosatResult.error ?? 'erreur inconnue' });

  // SLSTR: same independent, sequential, fail-soft shape as Meteosat above —
  // a slow/down Copernicus Data Store never holds up VIIRS or Meteosat, and
  // its own failure is watchdog-tracked exactly like theirs (see
  // lib/slstr.ts's fail-soft contract).
  const slstrResult = await fetchSlstrPasses(config.bbox);
  await recordSourceOutcome(SLSTR_SOURCE, slstrResult.ok ? { success: true } : { success: false, error: slstrResult.error ?? 'erreur inconnue' });

  const { kept, suppressed } = await suppressPersistentSources([...rawDetections, ...meteosatResult.detections, ...slstrResult.detections], config.persistentSourceDays);
  const detections = await annotateFrpAnomaly(kept);
  const events = clusterDetections(detections, await activeEvents(), config.frpThresholdMw);

  const sourcesLog = [
    ...sourceResults.map(r => ({ source: r.source, rows: r.rows === null ? 'FAILED' : r.rows.length })),
    { source: MTG_SOURCE, rows: meteosatResult.ok ? meteosatResult.detections.length : 'FAILED' },
    { source: SLSTR_SOURCE, rows: slstrResult.ok ? slstrResult.detections.length : 'FAILED' },
  ];

  if (firstRun) {
    for (const event of events) {
      event.notifiedAt = new Date().toISOString(); event.notifiedScore = event.score; event.notifiedStatus = event.status;
      await saveSignal(event);
    }
    console.log(`seeded ${events.length} event(s) from initial backlog — no alerts sent`);
    appendRunLog({ seeded: true, sources: sourcesLog, events: events.length, suppressed: { persistent_source: suppressed }, alertsPerWilaya: {} });
    return Response.json({ ok: true, seeded: true, events: events.length, checkedAt: new Date().toISOString() });
  }

  let sent = 0;
  const alertsPerWilaya: Record<string, number> = {};
  for (const raw of events) {
    // A Meteosat-only event never carries real FRP/confidence, so its raw
    // score alone rarely crosses 55 — but rule (e)'s gate needs real
    // wind/village data to render a coherent message once it clears
    // 'corroborated', same as any VIIRS event that would enrich anyway. An
    // SLSTR-only event CAN carry real FRP/confidence and so can legitimately
    // cross 55 on its own, but is included here too for the same reason:
    // rule (c) caps its status the same way, and enrichment must not depend
    // on whether this particular fire happened to be intense enough.
    const secondaryEligible = (raw.positionSource === 'meteosat' || raw.positionSource === 'slstr') && raw.status === 'corroborated';
    let event = (raw.score >= 55 || secondaryEligible) ? await enrichWeather(raw) : raw;
    event = await applyLandUse(event);
    const proximityKm = effectiveProximityKm(event, config.proximityKm);
    if (shouldAlert(event, config.proximityKm)) {
      const wilaya = eventWilaya(event);
      const destination = chatIdForWilaya(wilaya, chatId);
      // Previously unguarded: a network error or hung request here would
      // throw past this whole handler, crashing the run before any LATER
      // event in this loop got saved. Now it fails soft like FIRMS/Open-Meteo
      // already do — logged, event left un-notified (so it naturally retries
      // on the next poll instead of getting silently marked as sent), loop
      // continues.
      try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: destination, text: telegramText(event, undefined, proximityKm), disable_web_page_preview: true }), signal: AbortSignal.timeout(10_000) });
        if (response.ok) {
          event.notifiedAt = new Date().toISOString(); event.notifiedScore = event.score; event.notifiedStatus = event.status; sent++;
          const key = wilaya ?? 'inconnue';
          alertsPerWilaya[key] = (alertsPerWilaya[key] ?? 0) + 1;
        }
      } catch (error) {
        console.log(`Telegram send FAILED for event ${event.id}: ${error instanceof Error ? error.message : error}`);
      }
    }
    await saveSignal(event);
  }
  appendRunLog({ sources: sourcesLog, events: events.length, sent, alertsPerWilaya, suppressed: { persistent_source: suppressed } });
  return Response.json({ ok: true, events: events.length, sent, checkedAt: new Date().toISOString() });
}

// VPS/systemd cron (scripts/run-monitor.sh) — unchanged.
export async function POST(request: Request) {
  return runMonitor(request);
}

// Vercel Cron Jobs — always invoke via GET (vercel.json's "crons" entry),
// never POST. Same auth, same logic, same response shape as POST.
export async function GET(request: Request) {
  return runMonitor(request);
}
