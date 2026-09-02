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
  ALERT_SCORE_THRESHOLD, clusterDetections, enrichWeather, eventWilaya, fetchDetections, gridCell, lowerStatus, telegramText,
  DEFAULT_PERSISTENT_SOURCE_WINDOW_DAYS, type Detection, type FireEvent,
} from '@/lib/fire-monitor';
import { lookupLandUse } from '@/lib/landuse';
import { activeEvents, distinctDayCount, getConfig, initDb, isFirstRun, pruneHotspotHistory, recordDetectionDay, saveSignal } from '@/lib/database';
import { bboxToString } from '@/scripts/build-villages';
import { chatIdForWilaya } from '@/lib/wilaya-routing';
import { appendRunLog } from '@/lib/run-log';

const ESCALATION_SCORE_DELTA = 15;
const STATUS_RANK: Record<FireEvent['status'], number> = { observation: 0, corroborated: 1, urgent: 2 };

function shouldAlert(event: FireEvent) {
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
  await initDb();
  // Region + tunables come from the /setup config record, not hardcoded
  // constants — see lib/database.ts getConfig()/updateConfig(). A fresh
  // instance gets the migrated Algeria defaults here until /setup changes them.
  const config = await getConfig();

  const firstRun = await isFirstRun();
  const sourceResults = await fetchDetections(mapKey, { box: bboxToString(config.bbox) });
  const rawDetections = sourceResults.flatMap(r => r.rows ?? []);
  const { kept: detections, suppressed } = await suppressPersistentSources(rawDetections, config.persistentSourceDays);
  const events = clusterDetections(detections, await activeEvents(), config.frpThresholdMw);

  const sourcesLog = sourceResults.map(r => ({ source: r.source, rows: r.rows === null ? 'FAILED' : r.rows.length }));

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
    let event = raw.score >= 55 ? await enrichWeather(raw) : raw;
    event = await applyLandUse(event);
    if (shouldAlert(event)) {
      const wilaya = eventWilaya(event);
      const destination = chatIdForWilaya(wilaya, chatId);
      // Previously unguarded: a network error or hung request here would
      // throw past this whole handler, crashing the run before any LATER
      // event in this loop got saved. Now it fails soft like FIRMS/Open-Meteo
      // already do — logged, event left un-notified (so it naturally retries
      // on the next poll instead of getting silently marked as sent), loop
      // continues.
      try {
        const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: destination, text: telegramText(event, undefined, config.proximityKm), disable_web_page_preview: true }), signal: AbortSignal.timeout(10_000) });
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
