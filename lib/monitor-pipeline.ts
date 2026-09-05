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

// The DB-touching per-run steps between "detections fetched" and
// "events scored", lifted out of app/api/monitor/route.ts so they can be
// tested against a real (temp) database without spinning up the route.
// Behaviour is the route's, with ONE deliberate ordering change, documented
// on prepareDetections() below.
import {
  DEFAULT_PERSISTENT_SOURCE_WINDOW_DAYS, EARLY_DETECTION_ANOMALY_MIN_SAMPLES, EARLY_DETECTION_ANOMALY_MULTIPLIER, gridCell, industrialStatus, isMeteosatDetection,
  type Detection, type FireEvent,
} from './fire-monitor';
import { lookupLandUse } from './landuse';
import { isInForest } from './forestcover';
import { distinctDayCount, frpBaseline, pruneFrpHistory, pruneHotspotHistory, recordDetectionDay, recordFrpObservation } from './database';

function windowCutoffDay(): string {
  return new Date(Date.now() - DEFAULT_PERSISTENT_SOURCE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
}

// Records every detection's (cell, day) and drops detections from cells that
// have shown up on more than persistentSourceDays distinct days in the
// rolling window — a real wildfire doesn't keep re-igniting the same 1km spot
// for weeks; a gas flare or industrial heat source does. persistentSourceDays
// comes from the region config (/setup); the window itself stays fixed.
export async function suppressPersistentSources(detections: Detection[], persistentSourceDays: number): Promise<{ kept: Detection[]; suppressed: number }> {
  const cutoff = windowCutoffDay();
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
export async function annotateFrpAnomaly(detections: Detection[]): Promise<Detection[]> {
  const cutoff = windowCutoffDay();
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

// The two steps above, in the order the run needs them. Signal 2's
// annotation/recording runs FIRST, over EVERY detection, and the
// persistent-source guard second — previously the guard ran first, so a
// detection it dropped never reached frp_history. That starved the baseline
// for exactly the class of location signal 2 is best at (a permanent
// industrial/energy source repeating day after day): once a cell crossed
// the day threshold its history froze, then pruned away. Now such a cell
// keeps learning while still being suppressed from clustering. The
// annotation flag on a suppressed detection is simply discarded with it.
export async function prepareDetections(all: Detection[], persistentSourceDays: number): Promise<{ detections: Detection[]; suppressed: number }> {
  const annotated = await annotateFrpAnomaly(all);
  const { kept, suppressed } = await suppressPersistentSources(annotated, persistentSourceDays);
  return { detections: kept, suppressed };
}

// Land-use context (lib/landuse.ts, a local-index/OSM lookup): tags an event
// when it sits on a known industrial/energy site and lowers its status one
// rung so it never reads as a top "urgent" red alert for what is very likely
// a permanent heat source — but never drops it, since an industrial site can
// genuinely catch fire too. That last clause is now real, not just a
// comment: industrialStatus() (lib/fire-monitor.ts) skips the downgrade when
// signal 2 has flagged this event's FRP as anomalous against THIS cell's own
// history. Runs for every clustered event; lookups are cached per ~1km cell
// and fail soft (context 'unknown', event untouched otherwise).
export async function applyLandUse(event: FireEvent): Promise<FireEvent> {
  const landUse = await lookupLandUse(event.latitude, event.longitude);
  if (landUse.context !== 'industrial') return { ...event, landUse };
  return { ...event, landUse, status: industrialStatus(event) };
}

// Real OSM forest cover (lib/forestcover.ts, a local-index lookup — see
// there): a purely additive context flag, never touches status/score. A
// local index lookup is sub-millisecond, same low cost as applyLandUse
// above, so this runs unconditionally for every clustered event.
export function applyForestCover(event: FireEvent): FireEvent {
  return { ...event, inForest: isInForest(event.latitude, event.longitude) };
}
