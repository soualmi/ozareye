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

import {
  ALERT_SCORE_THRESHOLD, clusterDetections, enrichWeather, eventWilaya, fetchDetections, gridCell, telegramText,
  PERSISTENT_SOURCE_DAY_THRESHOLD, PERSISTENT_SOURCE_WINDOW_DAYS, type Detection, type FireEvent,
} from '@/lib/fire-monitor';
import { activeEvents, distinctDayCount, initDb, isFirstRun, pruneHotspotHistory, recordDetectionDay, saveSignal } from '@/lib/database';
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
// have shown up on more than PERSISTENT_SOURCE_DAY_THRESHOLD distinct days in
// the rolling window — a real wildfire doesn't keep re-igniting the same 1km
// spot for weeks; a gas flare or industrial heat source does.
async function suppressPersistentSources(detections: Detection[]): Promise<{ kept: Detection[]; suppressed: number }> {
  const cutoff = new Date(Date.now() - PERSISTENT_SOURCE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
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
    if (count > PERSISTENT_SOURCE_DAY_THRESHOLD) persistentCells.add(cell);
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

export async function POST(request: Request) {
  if (!process.env.MONITOR_SECRET || request.headers.get('x-monitor-secret') !== process.env.MONITOR_SECRET) return Response.json({ error: 'Non autorisé' }, { status: 401 });
  const mapKey = process.env.FIRMS_MAP_KEY, botToken = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!mapKey || !botToken || !chatId) return Response.json({ error: 'Variables FIRMS/Telegram manquantes' }, { status: 503 });
  await initDb();

  const firstRun = await isFirstRun();
  const sourceResults = await fetchDetections(mapKey);
  const rawDetections = sourceResults.flatMap(r => r.rows ?? []);
  const { kept: detections, suppressed } = await suppressPersistentSources(rawDetections);
  const events = clusterDetections(detections, await activeEvents());

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
    const event = raw.score >= 55 ? await enrichWeather(raw) : raw;
    if (shouldAlert(event)) {
      const wilaya = eventWilaya(event);
      const destination = chatIdForWilaya(wilaya, chatId);
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: destination, text: telegramText(event), disable_web_page_preview: true }) });
      if (response.ok) {
        event.notifiedAt = new Date().toISOString(); event.notifiedScore = event.score; event.notifiedStatus = event.status; sent++;
        const key = wilaya ?? 'inconnue';
        alertsPerWilaya[key] = (alertsPerWilaya[key] ?? 0) + 1;
      }
    }
    await saveSignal(event);
  }
  appendRunLog({ sources: sourcesLog, events: events.length, sent, alertsPerWilaya, suppressed: { persistent_source: suppressed } });
  return Response.json({ ok: true, events: events.length, sent, checkedAt: new Date().toISOString() });
}
