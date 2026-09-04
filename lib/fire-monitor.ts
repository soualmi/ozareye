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

import villagesData from '@/data/villages.json';
import { distanceKm } from './geo';
import { cardinalFr, classifyExposure, type WindRelation } from './wind';
import { isolatedDisplayName, stripTifinagh } from './place-name';
import { wilayaAt } from './wilaya';

// Real point-in-polygon wilaya attribution for a fire centroid — used both for
// message display and for per-wilaya routing (Part C). Replaces the earlier
// nearest-village guess, which was a coin flip near a wilaya border.
export function eventWilaya(event: Pick<FireEvent, 'latitude' | 'longitude'>): string | null {
  return wilayaAt(event.latitude, event.longitude);
}

export type Detection = {
  latitude: number; longitude: number; acquiredAt: string;
  satellite: string; instrument: string; confidence: string; frp: number;
  // Meteosat only — the CAP circle's own reported detection radius (km),
  // when the product provided one. Falls back to
  // METEOSAT_POSITION_UNCERTAINTY_KM below when absent (a malformed/legacy
  // CAP entry) — never fabricated as a real reading.
  radiusKm?: number;
  // VIIRS only — set upstream (app/api/monitor/route.ts, before
  // clusterDetections) when this detection's FRP is significantly above the
  // stored 30-day local baseline for its grid cell/hour-of-day. Computed
  // outside scoreEvent() specifically so scoreEvent() stays synchronous and
  // DB-free — see EARLY_DETECTION_ANOMALY_BOOST below.
  baselineFrpExceeded?: boolean;
};

export type VillageExposure = {
  osm_id: string; name: string; name_ar: string | null; 'name:fr'?: string | null; wilaya: string;
  lat: number; lon: number; // for the dashboard map
  distanceKm: number; relation: WindRelation; etaHours?: number;
};

// Land-use context (lib/landuse.ts, an OSM/Overpass lookup) — tells the
// engine WHAT sits under a detection, so a permanent industrial/energy heat
// source (a steel plant, a gas flare, a quarry, a landfill) isn't presented
// as a probable wildfire. 'unknown' covers both "lookup failed/timed out"
// and "not yet looked up" — either way the event proceeds exactly as it did
// before this feature existed. This complements, not replaces, the 30-day
// persistent-source guard below: this gives context on the FIRST detection,
// the guard catches unnamed recurring sources purely from history over time.
export type LandUseContext = 'industrial' | 'natural' | 'unknown';
export type LandUseInfo = { context: LandUseContext; siteName?: string };

export type FireEvent = {
  id: string;
  latitude: number; longitude: number; // centroid, recomputed as pixels join
  detections: Detection[];
  firstAcquiredAt: string; lastAcquiredAt: string;
  maxFrp: number; maxConfidence: string; passCount: number; maxPixelsInSinglePass: number;
  score: number; status: 'observation' | 'corroborated' | 'urgent';
  evidence: string[]; evidenceShort: string[];
  windKph?: number; windDirectionFromDeg?: number; humidity?: number;
  villages?: VillageExposure[];
  landUse?: LandUseInfo;
  notifiedAt?: string; notifiedScore?: number; notifiedStatus?: FireEvent['status'];
  // Meteosat fusion (see clusterDetections/scoreEvent below) — recomputed
  // from event.detections every poll, exactly like maxFrp/passCount above,
  // never trusted as separately-mutated state. 'viirs' (or absent, for
  // events saved before this feature existed) whenever the event has at
  // least one polar (VIIRS) pass, regardless of how many Meteosat passes
  // also hit it — a Meteosat pixel NEVER moves a VIIRS-anchored position.
  positionSource?: 'viirs' | 'meteosat';
  // ~3km, only set when positionSource is 'meteosat' — the FCI pixel size,
  // not a made-up figure. Undefined (not 0) once VIIRS re-anchors the event,
  // so the dashboard/Telegram "±3km" caveat disappears along with the cap.
  positionUncertaintyKm?: number;
  // True once a VIIRS-anchored event has also been hit by >=1 Meteosat pass —
  // "confirmed fire, now also getting the ~10min geostationary revisit" is a
  // materially different claim from "unconfirmed geostationary-only signal"
  // (positionSource === 'meteosat'), hence the separate flag rather than
  // overloading positionSource for it.
  geoTracked?: boolean;
};

const villages = villagesData as { osm_id: string; name: string; name_ar: string | null; 'name:fr'?: string | null; lat: number; lon: number; place: string; wilaya: string }[];

// Exported so app/api/monitor/route.ts can mark all three as failed if the
// run crashes before they're even polled (lib/source-health.ts watchdog) —
// same list, not a separate one to keep in sync.
export const FIRMS_SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT'];
// Fallback bbox (west,south,east,north) and tunable defaults — used only when
// a caller doesn't pass its own value (tests, the replay script, and as the
// seed values `lib/database.ts` migrates into the config table on first run).
// The live monitor (app/api/monitor/route.ts) always passes its own values,
// read from that config record, not these constants — see lib/database.ts
// getConfig()/updateConfig() and README section 5.
export const DEFAULT_BOX = '-2.5,34.0,9.0,37.3';

// Persistent-source guard: a real wildfire burns out in days; a gas flare or
// industrial heat source fires on the same ~1km cell over and over for months.
// A cell seen on more than this many distinct days within the rolling window
// is flagged a probable permanent source and suppressed (self-learning — no
// hardcoded flare list to maintain).
export const DEFAULT_PERSISTENT_SOURCE_DAY_THRESHOLD = 10;
export const DEFAULT_PERSISTENT_SOURCE_WINDOW_DAYS = 30;

// ~1km resolution (0.01deg is ~1.1km of latitude at these latitudes; longitude
// spacing shrinks moving north, but this is a coarse noise filter, not a survey).
export function gridCell(lat: number, lon: number): string {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

const CLUSTER_RADIUS_KM = 2;
const CLUSTER_TIME_HOURS = 12;
const EXPOSURE_RADIUS_KM = 20;

// Meteosat fusion (lib/meteosat.ts feeds MTG_FIR detections into the same
// clusterDetections() VIIRS already uses — see that function and scoreEvent()
// below for the actual rules). `instrument` is already how every Detection
// distinguishes its sensor (VIIRS's FIRMS rows always carry 'VIIRS'); MTG's
// FCI instrument is the natural, already-present field to key fusion on
// rather than adding a redundant boolean to Detection.
export const MTG_SOURCE = 'MTG_FIR';
const METEOSAT_SATELLITE = 'MTI1';
const METEOSAT_INSTRUMENT = 'FCI';
export function isMeteosatDetection(d: Detection): boolean {
  return d.instrument === METEOSAT_INSTRUMENT;
}
// Fallback only — real detections carry their own CAP-reported radius
// (~1.1-1.9km observed live, close to FCI's ~2km nadir pixel). This flat
// figure is used only when a detection has none (a malformed/legacy CAP
// entry), not as the everyday value.
export const METEOSAT_POSITION_UNCERTAINTY_KM = 3;

// The radius to treat a single Meteosat detection as covering: its own
// CAP-reported value when present, the flat fallback otherwise. Every join/
// uncertainty/widened-proximity computation below goes through this rather
// than the constant directly, so a real per-detection radius always wins.
function meteosatDetectionRadiusKm(det: Detection): number {
  return det.radiusKm && det.radiusKm > 0 ? det.radiusKm : METEOSAT_POSITION_UNCERTAINTY_KM;
}
// Real measured cadence (see the product inspection this feature shipped
// with): every 10 minutes, not the 15 originally assumed. Shown verbatim in
// the "suivi Meteosat" copy below.
export const METEOSAT_CADENCE_MIN = 10;
const METEOSAT_ALERT_MIN_DETECTIONS = 2;
// "~2 consecutive passes, ~30 min apart" — kept as an absolute 30-minute
// span (not "2 cadence cycles", which the real 10min cadence would make too
// permissive at 10-20min) so a Meteosat-only signal must persist across at
// least 3 real revisits before it can ever alert, not just repeat once.
const METEOSAT_ALERT_MIN_SPAN_MIN = 30;

// "Détection précoce" (early detection) — three small, additive score
// boosts, NOT a replacement for clustering or the ALERT_SCORE_THRESHOLD
// gate itself (that stays 70 everywhere it's checked). Originally specified
// as a temperature-slope-across-successive-Meteosat-images signal; adapted
// because MTG's CAP product carries no per-pixel FRP/intensity time series
// to compute a slope from (confirmed during this feature's own Step 1
// product inspection) — these three signals are the closest honest
// equivalent using data that actually exists.

// Signal 1 — Zoning: a fire near people (a village) matters sooner than an
// identical one in open, unpopulated terrain — boosts the INPUT score so it
// crosses the existing threshold sooner; the threshold itself is untouched.
// "forest" was in the original ask but there is no forest/vegetation-cover
// dataset in this codebase to check against (lib/landuse.ts's 'natural'
// context means only "not a known industrial site", not "is forest") — this
// uses the one real proximity dataset that exists, villages.json.
const EARLY_DETECTION_ZONE_RADIUS_KM = 3;
const EARLY_DETECTION_ZONE_BOOST = 8;

// Signal 2 — FRP anomaly vs local history: a detection well above what THIS
// specific ~1km cell/hour normally produces is informative even at a low
// absolute FRP (e.g. a genuine new ignition where nothing has burned
// before) — reuses the same 30-day, per-cell learning the persistent-source
// guard (hotspot_days) already does, just keyed on FRP instead of on
// day-presence (see lib/database.ts recordFrpObservation/frpBaseline,
// added alongside hotspot_days rather than duplicating its table).
// Computed upstream (app/api/monitor/route.ts, the only place with DB
// access) and passed in via Detection.baselineFrpExceeded — scoreEvent()
// itself stays fully synchronous, so every existing test keeps working
// unchanged and this signal is unit-testable without a DB.
const EARLY_DETECTION_ANOMALY_BOOST = 10;
// "Significantly above" = at least this many times the local historical
// average FRP for that cell/hour.
export const EARLY_DETECTION_ANOMALY_MULTIPLIER = 2;
// A single prior reading isn't a "baseline" — require at least this many
// distinct historical days at that cell/hour before comparing against it.
export const EARLY_DETECTION_ANOMALY_MIN_SAMPLES = 3;

// Signal 3 — Meteosat persistence: a VIIRS-confirmed fire ALSO picked up by
// >=2 independent Meteosat passes (a wholly different sensor, ~10min
// cadence) is stronger evidence than either alone. Distinct from the
// existing `geoTracked` flag (>=1 Meteosat pass, a display/UX signal) —
// this specifically requires >=2 and only affects `score`.
const EARLY_DETECTION_METEOSAT_PERSISTENCE_MIN_PASSES = 2;
const EARLY_DETECTION_METEOSAT_PERSISTENCE_BOOST = 8;

// Rule (c), locked: "villages: proximity radius widened by 3km" for a
// Meteosat-positioned event — the position itself carries that much
// uncertainty, so a village just outside the normal proximityKm can still be
// the one actually at risk. Used both for the Meteosat-only alert gate
// (route.ts) and for which villages the message names (telegramText below).
export function effectiveProximityKm(event: Pick<FireEvent, 'positionSource' | 'positionUncertaintyKm'>, proximityKm: number): number {
  return event.positionSource === 'meteosat' ? proximityKm + (event.positionUncertaintyKm ?? METEOSAT_POSITION_UNCERTAINTY_KM) : proximityKm;
}
// A village this close to the fire is always named, regardless of wind
// classification — at this range wind direction can shift, terrain deflects it,
// and embers travel independently of the prevailing flow.
export const DEFAULT_PROXIMITY_KM = 3;
// FRP (MW) at which a detection is scored as an intense, probably-extensive
// signal rather than a modest one — see scoreEvent()/magnitudeLabel() below.
export const DEFAULT_FRP_THRESHOLD_MW = 20;
// Crude spread-rate rule of thumb for Mediterranean scrub/forest: the fire front
// advances at roughly this fraction of the 10m wind speed. This is NOT a fire
// physics model — treat every ETA it produces as a rough estimate, not a forecast.
const SPREAD_FACTOR = 0.06;

export const ALERT_SCORE_THRESHOLD = 70;
// Re-alert an already-notified event only if it grew this much, or crossed a
// status boundary (e.g. corroborated -> urgent) — not on every extra pixel.
const ESCALATION_SCORE_DELTA = 15;

type SourceResult = { source: string; rows: Detection[] | null; error?: string };

// `box` and `date` let the replay script (Part D2) pull a historical day over a
// narrower bbox; live monitoring passes its own configured bbox explicitly —
// DEFAULT_BOX here is only the fallback for callers that don't.
export async function fetchDetections(mapKey: string, opts?: { box?: string; date?: string }): Promise<SourceResult[]> {
  const box = opts?.box ?? DEFAULT_BOX;
  const datePart = opts?.date ? `/${opts.date}` : '';
  return Promise.all(FIRMS_SOURCES.map(async (source): Promise<SourceResult> => {
    try {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/${source}/${box}/1${datePart}`;
      // A hung FIRMS request must not stall the whole run — the catch below
      // already treats any failure from one source as independent of the
      // other two (Promise.all across SOURCES), so a timeout here falls
      // through the exact same "source X: FAILED" path as a network error.
      const response = await fetch(url, { headers: { 'User-Agent': 'OzarEye/1.0' }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).trim().slice(0, 200)}`);
      const rows = parseCsv(await response.text()).map(rowToDetection);
      console.log(`source ${source}: ${rows.length} rows`);
      return { source, rows };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`source ${source}: FAILED (${message})`);
      return { source, rows: null, error: message };
    }
  }));
}

export async function collectDetections(mapKey: string, opts?: { box?: string; date?: string }): Promise<Detection[]> {
  const results = await fetchDetections(mapKey, opts);
  return results.flatMap(r => r.rows ?? []);
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const keys = lines[0].split(',');
  return lines.slice(1).map(line => {
    const values = line.split(',');
    return Object.fromEntries(keys.map((key, index) => [key.trim(), (values[index] ?? '').trim()]));
  });
}

function rowToDetection(row: Record<string, string>): Detection {
  const acquiredAt = `${row.acq_date}T${(row.acq_time || '').padStart(4, '0').slice(0, 2)}:${(row.acq_time || '').padStart(4, '0').slice(2)}:00Z`;
  return {
    latitude: Number(row.latitude), longitude: Number(row.longitude), acquiredAt,
    satellite: row.satellite, instrument: row.instrument, confidence: row.confidence, frp: Number(row.frp || 0),
  };
}

function hoursBetween(aIso: string, bIso: string) {
  return Math.abs(new Date(aIso).getTime() - new Date(bIso).getTime()) / 3_600_000;
}

function average(values: number[]) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function confidenceRank(c: string) {
  if (c === 'h' || Number(c) >= 80) return 2;
  if (c === 'n' || Number(c) >= 50) return 1;
  return 0;
}

function newEventFrom(det: Detection): FireEvent {
  return {
    id: `evt-${det.latitude.toFixed(3)}-${det.longitude.toFixed(3)}-${det.acquiredAt}`,
    latitude: det.latitude, longitude: det.longitude,
    detections: [det],
    firstAcquiredAt: det.acquiredAt, lastAcquiredAt: det.acquiredAt,
    maxFrp: det.frp, maxConfidence: det.confidence, passCount: 1, maxPixelsInSinglePass: 1,
    score: 0, status: 'observation', evidence: [], evidenceShort: [],
  };
}

/**
 * Groups raw pixel detections into fire events (~2km / 12h), merging into
 * existing events (e.g. from a prior poll) rather than creating duplicates.
 * `events` is mutated in place and returned. One event = one fire, so
 * downstream alerting fires once per event, not once per pixel.
 */
function isSameDetection(a: Detection, b: Detection): boolean {
  return a.latitude === b.latitude && a.longitude === b.longitude && a.acquiredAt === b.acquiredAt && a.satellite === b.satellite;
}

// True if `det` is within CLUSTER_TIME_HOURS of at least one detection
// already in `ev` — anchored to the nearest KNOWN detection, not to the
// event's current (advancing) lastAcquiredAt. A fire tracked over many hours
// must keep matching its OWN early detections when the same 24h FIRMS window
// is reprocessed; anchoring to lastAcquiredAt alone lets those early
// detections "fall out" of their own event's window once lastAcquiredAt has
// moved on >12h past them, spawning a duplicate event that — because the id
// is generated from that detection's own lat/lon/time — collides with the
// original event's id and carries no notification history. That collision,
// not score/status oscillation, is what caused fixed events to re-alert.
function withinClusterWindow(ev: FireEvent, det: Detection): boolean {
  return ev.detections.some(d => hoursBetween(d.acquiredAt, det.acquiredAt) <= CLUSTER_TIME_HOURS);
}

// True once `ev` has at least one non-Meteosat (polar/VIIRS) detection —
// the single fact the fusion rules below key everything on. Recomputed from
// detections rather than trusted from a stored flag, same philosophy as
// maxFrp/passCount in scoreEvent().
function eventHasViirs(ev: FireEvent): boolean {
  return ev.detections.some(d => !isMeteosatDetection(d));
}

// Rule (a)/(b)/(d), locked: once an event has any VIIRS pass, its position is
// the average of ONLY its VIIRS detections forever after — a Meteosat pixel
// joining later (rule a) or a Meteosat-only event being re-anchored by a
// first VIIRS pass (rule d) must never move it. An event with no VIIRS pass
// yet keeps averaging all its Meteosat detections (rule b) — the same
// "average everything" behaviour this function replaces, just scoped to
// whichever detections are allowed to count.
function recomputeCentroid(ev: FireEvent): void {
  const anchor = ev.detections.filter(d => !isMeteosatDetection(d));
  const pool = anchor.length > 0 ? anchor : ev.detections;
  ev.latitude = average(pool.map(d => d.latitude));
  ev.longitude = average(pool.map(d => d.longitude));
}

function joinDetection(det: Detection, events: FireEvent[], joinRadiusForEvent: (ev: FireEvent) => number): void {
  let best: FireEvent | null = null, bestDist = Infinity;
  for (const ev of events) {
    const dist = distanceKm(ev.latitude, ev.longitude, det.latitude, det.longitude);
    if (dist <= joinRadiusForEvent(ev) && withinClusterWindow(ev, det) && dist < bestDist) {
      best = ev; bestDist = dist;
    }
  }
  if (best) {
    const isDuplicate = best.detections.some(d => isSameDetection(d, det));
    if (!isDuplicate) {
      const wasMeteosatOnly = !eventHasViirs(best);
      best.detections.push(det);
      recomputeCentroid(best);
      if (wasMeteosatOnly && !isMeteosatDetection(det)) {
        console.log(`event ${best.id}: re-anchored from Meteosat-only to VIIRS position (rule d)`);
      }
      best.firstAcquiredAt = best.detections.reduce((min, d) => d.acquiredAt < min ? d.acquiredAt : min, best.firstAcquiredAt);
      best.lastAcquiredAt = best.detections.reduce((max, d) => d.acquiredAt > max ? d.acquiredAt : max, best.lastAcquiredAt);
    }
  } else {
    events.push(newEventFrom(det));
  }
}

/**
 * Groups raw pixel detections into fire events (~2km / 12h), merging into
 * existing events (e.g. from a prior poll) rather than creating duplicates.
 * `events` is mutated in place and returned. One event = one fire, so
 * downstream alerting fires once per event, not once per pixel.
 *
 * Meteosat fusion (locked rules a-e, see the feature's commit/PR notes):
 * a Meteosat detection always joins at ITS OWN CAP-reported radius
 * (meteosatDetectionRadiusKm — real values run ~1.1-1.9km, not a flat
 * figure), whether the match is VIIRS-anchored (rule a: attaches as a pass,
 * never moves the position) or Meteosat-only (rule b: position is the mean
 * of Meteosat detections). A VIIRS detection joins at the normal 2km radius
 * against a VIIRS-anchored event, but widens to the TARGET Meteosat-only
 * event's own positionUncertaintyKm specifically to catch (and re-anchor,
 * rule d) it — so a wide-footprint Meteosat detection is easier to
 * re-anchor than a tight one, honestly reflecting its real uncertainty.
 * Status capping and the 2-pass/~30min alert gate for Meteosat-only events
 * happen in scoreEvent() below, since that's the pass every event already
 * flows through here.
 */
export function clusterDetections(detections: Detection[], events: FireEvent[], frpThresholdMw = DEFAULT_FRP_THRESHOLD_MW): FireEvent[] {
  for (const det of detections) {
    if (isMeteosatDetection(det)) {
      joinDetection(det, events, () => meteosatDetectionRadiusKm(det));
    } else {
      joinDetection(det, events, ev => eventHasViirs(ev) ? CLUSTER_RADIUS_KM : (ev.positionUncertaintyKm ?? METEOSAT_POSITION_UNCERTAINTY_KM));
    }
  }
  return mergeById(events).map(ev => scoreEvent(ev, frpThresholdMw));
}

// Defense in depth: if two fragments in this pass ever end up sharing an id
// anyway, merge them rather than let both survive to route.ts. Union of
// detections, earliest first-seen / latest last-seen timestamp, and —
// critically — the notification history of whichever fragment has one. A
// merged event must never look un-notified just because one fragment happens
// to be the "new" one; losing that history is exactly what caused the re-spam.
function mergeById(events: FireEvent[]): FireEvent[] {
  const byId = new Map<string, FireEvent>();
  for (const ev of events) {
    const existing = byId.get(ev.id);
    byId.set(ev.id, existing ? mergeEvents(existing, ev) : ev);
  }
  return [...byId.values()];
}

function mergeEvents(a: FireEvent, b: FireEvent): FireEvent {
  const detections = [...a.detections];
  for (const d of b.detections) if (!detections.some(x => isSameDetection(x, d))) detections.push(d);
  const firstAcquiredAt = a.firstAcquiredAt < b.firstAcquiredAt ? a.firstAcquiredAt : b.firstAcquiredAt;
  const lastAcquiredAt = a.lastAcquiredAt > b.lastAcquiredAt ? a.lastAcquiredAt : b.lastAcquiredAt;

  let notifiedAt = a.notifiedAt, notifiedScore = a.notifiedScore, notifiedStatus = a.notifiedStatus;
  if (!notifiedAt || (b.notifiedAt && b.notifiedAt > notifiedAt)) {
    notifiedAt = b.notifiedAt; notifiedScore = b.notifiedScore; notifiedStatus = b.notifiedStatus;
  }

  const merged: FireEvent = { ...a, detections, firstAcquiredAt, lastAcquiredAt, notifiedAt, notifiedScore, notifiedStatus };
  recomputeCentroid(merged); // same VIIRS-anchored-if-present rule as the live join path above
  return merged;
}

/**
 * Corroboration = detections from a DIFFERENT satellite pass (different
 * satellite, or the same satellite at a different overpass time). Multiple
 * adjacent pixels from the SAME single pass mean the fire is big, not that
 * it's confirmed — that's scored separately, honestly labelled as size.
 */
function meteosatDetectionSpanMinutes(dets: Detection[]): number {
  const times = [...new Set(dets.map(d => d.acquiredAt))].map(t => new Date(t).getTime());
  if (times.length < 2) return 0;
  return (Math.max(...times) - Math.min(...times)) / 60_000;
}

// Rule (e), locked: a Meteosat-only event can only ever reach 'corroborated'
// (never 'urgent') once at least METEOSAT_ALERT_MIN_DETECTIONS distinct
// passes have hit the same spot at least METEOSAT_ALERT_MIN_SPAN_MIN apart —
// several circles from the very same 10-minute frame don't count, since
// that's the same single overpass, not a recurring signal.
function meetsMeteosatAlertGate(meteosatDets: Detection[]): boolean {
  const distinctPassTimes = new Set(meteosatDets.map(d => d.acquiredAt)).size;
  return distinctPassTimes >= METEOSAT_ALERT_MIN_DETECTIONS && meteosatDetectionSpanMinutes(meteosatDets) >= METEOSAT_ALERT_MIN_SPAN_MIN;
}

// Villages within `radiusKm` of a point, ignoring wind — used only for the
// Meteosat-only alert gate (rule e), which has no wind/weather enrichment to
// work with (that only runs for score>=55, and a Meteosat-only event's score
// never carries real FRP/confidence). A plain distance check is the correct,
// honest substitute: "is there anyone to warn nearby", not "who's downwind".
export function hasNearbyVillage(point: { latitude: number; longitude: number }, radiusKm: number): boolean {
  return villages.some(v => distanceKm(point.latitude, point.longitude, v.lat, v.lon) <= radiusKm);
}

function scoreEvent(event: FireEvent, frpThresholdMw = DEFAULT_FRP_THRESHOLD_MW): FireEvent {
  const passKeys = new Map<string, number>();
  for (const d of event.detections) {
    const key = `${d.satellite}|${d.acquiredAt}`;
    passKeys.set(key, (passKeys.get(key) ?? 0) + 1);
  }
  const passCount = passKeys.size;
  const maxPixelsInSinglePass = Math.max(...passKeys.values());
  const maxFrp = Math.max(...event.detections.map(d => d.frp));
  const maxConfidence = event.detections.reduce((best, d) => confidenceRank(d.confidence) > confidenceRank(best) ? d.confidence : best, event.detections[0].confidence);

  const meteosatDets = event.detections.filter(isMeteosatDetection);
  const hasViirs = meteosatDets.length < event.detections.length;
  // MTG's CAP product carries no per-detection FRP or confidence (unlike
  // VIIRS) — maxFrp/maxConfidence above naturally stay whatever the VIIRS
  // detections already established (Meteosat rows are frp:0, confidence:''),
  // so nothing here needs to special-case them away.
  const sourceLabel = !hasViirs ? 'EUMETSAT MTG' : meteosatDets.length > 0 ? 'NASA FIRMS + EUMETSAT MTG' : 'NASA FIRMS';

  const evidence: string[] = [`${sourceLabel} · ${event.detections.length} pixel(s) sur ${passCount} passage(s)`];
  const evidenceShort: string[] = [`${passCount}pass`];
  let score = 25;
  if (confidenceRank(maxConfidence) === 2) { score += 25; evidence.push('Confiance satellite élevée'); evidenceShort.push('conf+'); }
  else if (confidenceRank(maxConfidence) === 1) score += 14;
  // Same shape as before (three graduated bands), but the top band's cutoff —
  // the "intense signal" line — is now the configurable frpThresholdMw
  // instead of a hardcoded 20; the two lower bands scale with it so a
  // self-hoster who lowers the threshold for a region with smaller/faster
  // fires gets a correspondingly lower whole ladder, not just the top rung.
  if (maxFrp >= frpThresholdMw) score += 20; else if (maxFrp >= frpThresholdMw * 0.4) score += 12; else if (maxFrp >= frpThresholdMw * 0.15) score += 5;
  if (hasViirs) evidence.push(`Puissance radiative max ${maxFrp.toFixed(1)} MW`);
  if (maxPixelsInSinglePass >= 3) { score += 10; evidence.push(`Feu étendu · ${maxPixelsInSinglePass} pixels dans un même passage (taille, pas confirmation)`); evidenceShort.push(`taille×${maxPixelsInSinglePass}`); }
  if (passCount > 1) { score += 25; evidence.push(`Recoupé par un passage/capteur différent (${passCount} passages distincts)`); evidenceShort.push('recoupé'); }
  if (event.latitude >= 34 && event.latitude <= 37.5) { score += 5; evidence.push('Bande nord à végétation sensible'); }

  // Détection précoce, signal 1 (zoning): boosts the input score, never the
  // ALERT_SCORE_THRESHOLD gate itself.
  if (hasNearbyVillage(event, EARLY_DETECTION_ZONE_RADIUS_KM)) {
    score += EARLY_DETECTION_ZONE_BOOST;
    evidence.push(`Zone habitée à proximité (<${EARLY_DETECTION_ZONE_RADIUS_KM}km)`); evidenceShort.push('zone+');
  }
  // Détection précoce, signal 2 (FRP anomaly vs local history): flagged
  // upstream per-detection (route.ts), read here — any VIIRS detection in
  // this event flagged is enough, same "any pixel proves it" shape as the
  // confidence/FRP bands above.
  if (event.detections.some(d => d.baselineFrpExceeded)) {
    score += EARLY_DETECTION_ANOMALY_BOOST;
    evidence.push(`FRP nettement au-dessus de l'historique local (≥${EARLY_DETECTION_ANOMALY_MULTIPLIER}× la moyenne 30j de cette cellule)`); evidenceShort.push('anomalie');
  }
  // Détection précoce, signal 3 (Meteosat persistence): a VIIRS-confirmed
  // fire ALSO hit by >=2 independent Meteosat passes — distinct from (and
  // additional to) geoTracked below, which only requires >=1.
  const meteosatPassCount = new Set(meteosatDets.map(d => d.acquiredAt)).size;
  if (hasViirs && meteosatPassCount >= EARLY_DETECTION_METEOSAT_PERSISTENCE_MIN_PASSES) {
    score += EARLY_DETECTION_METEOSAT_PERSISTENCE_BOOST;
    evidence.push(`Corroboré par Meteosat (${meteosatPassCount} passages)`); evidenceShort.push('meteosat+');
  }
  score = Math.min(score, 100);

  let status: FireEvent['status'] = score >= 85 ? 'urgent' : score >= 65 ? 'corroborated' : 'observation';
  if (!hasViirs) status = meetsMeteosatAlertGate(meteosatDets) ? 'corroborated' : 'observation';

  // Real per-detection radius (CAP-reported, ~1.1-1.9km observed live) wins
  // over the flat fallback — the largest among this event's Meteosat
  // detections, since the uncertainty a village-proximity check should
  // respect is the worst case actually involved, not the smallest.
  const positionUncertaintyKm = hasViirs ? undefined : Math.max(...meteosatDets.map(meteosatDetectionRadiusKm));

  return {
    ...event, maxFrp, maxConfidence, passCount, maxPixelsInSinglePass, score, evidence, evidenceShort, status,
    positionSource: hasViirs ? 'viirs' : 'meteosat',
    positionUncertaintyKm,
    geoTracked: hasViirs && meteosatDets.length > 0,
  };
}

// Dashboard-only presentational helpers — reuse the exact thresholds/grouping
// scoreEvent already computes above, described in words instead of duplicating
// or inventing new breakpoints. Telegram output (telegramText) is untouched.
export function confidenceLabel(c: string): string {
  const rank = confidenceRank(c);
  return rank === 2 ? 'élevée' : rank === 1 ? 'moyenne' : 'faible';
}

// Same FRP/size breakpoints scoreEvent uses to score the event — in words,
// not a fabricated hectare figure this data can't support. The breakpoints
// themselves never change for an industrial-context event (isIndustrial only
// swaps which STRING the top breakpoint returns) — a known industrial/energy
// site never claims "feu probablement étendu" for what's very likely a
// permanent heat source, not a vegetation fire (see lib/landuse.ts).
export function magnitudeLabel(maxFrp: number, maxPixelsInSinglePass: number, frpThresholdMw = DEFAULT_FRP_THRESHOLD_MW, isIndustrial = false): string {
  if (maxFrp >= frpThresholdMw || maxPixelsInSinglePass >= 3) return isIndustrial ? 'signal intense pour ce site' : 'signal intense, feu probablement étendu';
  if (maxFrp >= frpThresholdMw * 0.4) return 'signal modéré';
  return 'signal faible, foyer localisé';
}

export type PassInfo = { satellite: string; instrument: string; acquiredAt: string };

// Distinct (satellite, overpass time) pairs — the same grouping scoreEvent
// uses for passCount, exposed here for the dashboard's technical details.
export function distinctPasses(event: FireEvent): PassInfo[] {
  const seen = new Map<string, PassInfo>();
  for (const d of event.detections) {
    const key = `${d.satellite}|${d.acquiredAt}`;
    if (!seen.has(key)) seen.set(key, { satellite: d.satellite, instrument: d.instrument, acquiredAt: d.acquiredAt });
  }
  return [...seen.values()].sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt));
}

function applyWeather(event: FireEvent, humidity?: number, windKph?: number, windDirectionFromDeg?: number): FireEvent {
  let score = event.score;
  const evidence = [...event.evidence];
  if (humidity !== undefined && humidity < 30) { score += 5; evidence.push(`Air sec · ${humidity}% HR`); }
  if (windKph !== undefined && windKph >= 25) { score += 5; evidence.push(`Vent soutenu · ${windKph} km/h`); }
  score = Math.min(score, 100);
  const enriched: FireEvent = { ...event, humidity, windKph, windDirectionFromDeg, score, evidence, status: score >= 85 ? 'urgent' : score >= 65 ? 'corroborated' : 'observation' };
  if (windDirectionFromDeg !== undefined) enriched.villages = computeExposedVillages(enriched);
  return enriched;
}

export async function enrichWeather(event: FireEvent): Promise<FireEvent> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${event.latitude}&longitude=${event.longitude}&current=relative_humidity_2m,wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh`;
  try {
    // route.ts calls this once per >=55-score event, sequentially — a hung
    // call here has no other backstop, so it gets its own bound rather than
    // relying on the whole request's platform-level timeout. Same fail-soft
    // shape as any other Open-Meteo error: caught below, event returned
    // un-enriched rather than the run failing.
    const data = await fetch(url, { signal: AbortSignal.timeout(10_000) }).then(r => r.json()) as { current?: { relative_humidity_2m?: number; wind_speed_10m?: number; wind_direction_10m?: number } };
    return applyWeather(event, data.current?.relative_humidity_2m, data.current?.wind_speed_10m, data.current?.wind_direction_10m);
  } catch { return event; }
}

// Historical counterpart of enrichWeather, used only by the replay script (Part
// D2): live monitoring needs current conditions, but replaying a past date needs
// the weather AT that date, not today's — Open-Meteo's archive API instead of
// its forecast API, picking the archived hour nearest the detection time.
export async function enrichWeatherHistorical(event: FireEvent): Promise<FireEvent> {
  const day = event.lastAcquiredAt.slice(0, 10);
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${event.latitude}&longitude=${event.longitude}&start_date=${day}&end_date=${day}&hourly=relative_humidity_2m,wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh&timezone=UTC`;
  try {
    const data = await fetch(url, { signal: AbortSignal.timeout(10_000) }).then(r => r.json()) as { hourly?: { time: string[]; relative_humidity_2m: number[]; wind_speed_10m: number[]; wind_direction_10m: number[] } };
    const hourly = data.hourly;
    if (!hourly || !hourly.time.length) return event;
    const targetHour = `${day}T${event.lastAcquiredAt.slice(11, 13)}:00`;
    let index = hourly.time.indexOf(targetHour);
    if (index === -1) index = hourly.time.reduce((best, t, i) => Math.abs(new Date(t).getTime() - new Date(event.lastAcquiredAt).getTime()) < Math.abs(new Date(hourly.time[best]).getTime() - new Date(event.lastAcquiredAt).getTime()) ? i : best, 0);
    return applyWeather(event, hourly.relative_humidity_2m[index], hourly.wind_speed_10m[index], hourly.wind_direction_10m[index]);
  } catch { return event; }
}

function computeExposedVillages(event: FireEvent): VillageExposure[] {
  const windDirectionFromDeg = event.windDirectionFromDeg!;
  const fire = { lat: event.latitude, lon: event.longitude };
  const results: VillageExposure[] = [];
  for (const v of villages) {
    const distanceKmVal = distanceKm(fire.lat, fire.lon, v.lat, v.lon);
    if (distanceKmVal > EXPOSURE_RADIUS_KM) continue;
    const { relation } = classifyExposure(fire, { lat: v.lat, lon: v.lon }, windDirectionFromDeg);
    const etaHours = relation !== 'upwind' && event.windKph ? distanceKmVal / (event.windKph * SPREAD_FACTOR) : undefined;
    results.push({ osm_id: v.osm_id, name: v.name, name_ar: v.name_ar, 'name:fr': v['name:fr'] ?? null, wilaya: v.wilaya, lat: v.lat, lon: v.lon, distanceKm: distanceKmVal, relation, etaHours });
  }
  const relationRank: Record<WindRelation, number> = { downwind: 0, marginal: 1, upwind: 2 };
  return results.sort((a, b) => relationRank[a.relation] - relationRank[b.relation] || a.distanceKm - b.distanceKm);
}

// Raw minutes between `iso` and the reference time — deliberately NOT clamped to
// zero. A negative result means the caller passed a reference time earlier than
// the detection itself (e.g. a replay using the wrong "now"), and that must show
// up as a visibly wrong number, not get silently floored into a plausible-looking
// "0min" in production.
export function minutesSince(iso: string, referenceTime: Date) {
  return Math.round((referenceTime.getTime() - new Date(iso).getTime()) / 60000);
}

// Exported: the dashboard renders the same Africa/Algiers times as the Telegram
// message, via this same function — no separate reimplementation.
export function algiersTime(iso: string) {
  return new Date(iso).toLocaleString('fr-FR', { timeZone: 'Africa/Algiers', hour: '2-digit', minute: '2-digit' });
}

export { cardinalFr };

// Coarse bucket instead of a decimal hour figure — SPREAD_FACTOR is a rule of
// thumb, not a model, and a number like "~1.8h" reads as more precise than it is.
export function etaBucket(hours: number) {
  return hours < 1 ? '<1h' : hours <= 3 ? '1-3h' : '>3h';
}

// Villages within a viewport bbox — used by the dashboard map to avoid ever
// shipping the full ~9,635-village index to the client. west/south/east/north
// in degrees, same lat/lon convention as everywhere else in this file.
export function villagesInBounds(south: number, west: number, north: number, east: number, limit = 300) {
  const out: typeof villages = [];
  for (const v of villages) {
    if (v.lat < south || v.lat > north || v.lon < west || v.lon > east) continue;
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

export type VillageSelection = { village: VillageExposure; isProximity: boolean };

// The exact "which villages get named" logic the Telegram message uses —
// proximity always wins (max 2), downwind/marginal fills the rest (max 2).
// Exported so the dashboard's detail view shows precisely what the alert did,
// not a reimplementation that could quietly drift from it.
export function selectExposedVillages(event: FireEvent, proximityKm = DEFAULT_PROXIMITY_KM): VillageSelection[] {
  const all = event.villages ?? [];
  const proximity = all.filter(v => v.distanceKm <= proximityKm).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 2);
  const proximityIds = new Set(proximity.map(v => v.osm_id));
  const downwind = all.filter(v => v.relation !== 'upwind' && !proximityIds.has(v.osm_id))
    .sort((a, b) => (a.relation === b.relation ? a.distanceKm - b.distanceKm : a.relation === 'downwind' ? -1 : 1))
    .slice(0, 2);
  return [...proximity.map(village => ({ village, isProximity: true })), ...downwind.map(village => ({ village, isProximity: false }))];
}

// Village names are shown in one script, French/Latin where OSM has it and
// Arabic otherwise — see lib/place-name.ts, which also handles the bidi
// isolation the Arabic fallback needs. biText stays for callers that really do
// want a "Latin/Arabic" pair; village lines no longer do.
const RLI = '⁧', PDI = '⁩';
export function biText(fr: string, ar: string | null | undefined) {
  return ar ? `${fr}/${RLI}${ar}${PDI}` : fr;
}

// French-only system labels (village names are data, not template — they keep
// their Arabic/Kabyle names via biText() above). Exported so a test can assert
// none of these fixed strings contain an Arabic-range codepoint.
export const LABELS = {
  headline: 'ANOMALIE THERMIQUE',
  proximity: 'à proximité',
  downwind: 'sous le vent',
  disclaimer: 'Signal satellite, vérifier terrain',
  noVillage: 'Pas de village <20km sous le vent',
};

// Lowers an event's status one rung when land-use context flags the site as
// a known industrial/energy feature (app/api/monitor/route.ts calls this) —
// the event is still recorded and can still alert, it just never reads as a
// top "urgent" red marker for what is very likely a permanent heat source,
// not a wildfire.
export function lowerStatus(status: FireEvent['status']): FireEvent['status'] {
  return status === 'urgent' ? 'corroborated' : 'observation';
}

// OSM/Overpass site names come back in whatever script the mapper used —
// often Arabic-only for an industrial zone. Same bidi hazard biText() guards
// against for village names: a Latin sentence directly against an Arabic run
// with no explicit isolate can visually reorder at the join in a bidi-aware
// renderer (Telegram, WhatsApp), even though the source text stays correct.
const ARABIC_RANGE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
function isolateIfArabic(name: string) {
  return ARABIC_RANGE.test(name) ? `${RLI}${name}${PDI}` : name;
}

// The one line, in French, that both telegramText() and the dashboard
// (lib/dashboard-view.ts) show verbatim when land-use context flags a known
// industrial/energy site. Kept out of LABELS because it takes the site's OSM
// name as a parameter.
export function industrialContextLine(siteName?: string): string {
  // An OSM site name mixes scripts exactly like a village name does — same
  // rule, same reason (see lib/place-name.ts).
  const cleaned = siteName ? stripTifinagh(siteName) : '';
  const site = cleaned ? ` (${isolateIfArabic(cleaned)})` : '';
  return `Détection sur zone industrielle connue${site} — probablement une source de chaleur permanente, pas un feu. À vérifier.`;
}

// Dashboard-only counterpart to industrialContextLine() above (Telegram keeps
// that wording, unchanged, just repositioned — see telegramText()). This one
// names the plausible peacetime source explicitly and is meant to lead the
// list card/popup/detail views, not trail them — the incident that prompted
// this was a Skikda detail panel still opening with "probablement un feu"
// for an event sitting on the Sonatrach petrochemical zone, with this exact
// context buried below the narrative instead of leading it.
export function industrialLeadLine(siteName?: string): string {
  const cleaned = siteName ? stripTifinagh(siteName) : '';
  const site = cleaned ? isolateIfArabic(cleaned) : 'Site industriel connu';
  return `${site} — probablement une source de chaleur permanente (torchère, four, cheminée), pas un feu de végétation. À vérifier si le signal est inhabituel pour ce site.`;
}

export function telegramText(event: FireEvent, referenceTime = new Date(), proximityKm = DEFAULT_PROXIMITY_KM) {
  const icon = event.status === 'urgent' ? '🔴' : '🟠';
  const shown = selectExposedVillages(event, proximityKm);

  const villageLines = shown.length
    ? shown.map(({ village: v, isProximity }) => {
      const label = isProximity ? LABELS.proximity : LABELS.downwind;
      const eta = !isProximity && v.etaHours !== undefined ? ` ~${etaBucket(v.etaHours)}` : '';
      return `⚠️ ${isolatedDisplayName(v)} ${v.distanceKm.toFixed(1)}km ${label}${eta}`;
    }).join('\n')
    : LABELS.noVillage;

  const ageMin = minutesSince(event.lastAcquiredAt, referenceTime);
  const windBit = event.windKph !== undefined && event.windDirectionFromDeg !== undefined
    ? ` vent ${event.windKph} km/h → ${cardinalFr(event.windDirectionFromDeg + 180)}` : '';
  const wilaya = eventWilaya(event);
  const locationBit = wilaya ? ` · ${wilaya}` : '';
  // Leads the message, right after the title — a known industrial/energy
  // site is the single most important thing a reader needs before anything
  // else (villages, FRP, evidence), not a note trailing behind them.
  const industrialBit = event.landUse?.context === 'industrial' ? `🏭 ${industrialContextLine(event.landUse.siteName)}\n\n` : '';

  // Meteosat fusion (rules a/e, locked wording): a Meteosat-ONLY event has
  // never been corroborated by a polar overpass and its position carries a
  // real ±3km pixel uncertainty — the very first line must say so, before
  // anything else. A VIIRS-anchored event additionally getting Meteosat's
  // ~10min revisit is a different, good-news claim (more frequent watch on
  // an already-confirmed fire), so it gets its own, separate line instead.
  const meteosatOnlyBit = event.positionSource === 'meteosat'
    ? `🛰 Signal géostationnaire Meteosat — position approximative (±${(event.positionUncertaintyKm ?? METEOSAT_POSITION_UNCERTAINTY_KM).toFixed(1)} km), non confirmé par satellite polaire\n\n`
    : '';
  const geoTrackedBit = event.geoTracked ? `🛰 Suivi Meteosat actif (toutes les ${METEOSAT_CADENCE_MIN} min)\n\n` : '';

  const lastIsMeteosat = isMeteosatDetection(event.detections[event.detections.length - 1]);
  const frpBit = lastIsMeteosat ? '' : ` FRP${event.maxFrp.toFixed(1)}MW`;
  const hasMeteosatPass = event.detections.some(isMeteosatDetection);
  const attribution = hasMeteosatPass ? 'NASA FIRMS·Open-Meteo·MTG Active Fire Monitoring — EUMETSAT' : 'NASA FIRMS·Open-Meteo';

  return `${icon} ${LABELS.headline} — À VÉRIFIER\n\n${meteosatOnlyBit}${geoTrackedBit}${industrialBit}${villageLines}\n\n📍${event.latitude.toFixed(4)},${event.longitude.toFixed(4)}${locationBit} ${algiersTime(event.lastAcquiredAt)}Alger(${ageMin}min) ${event.detections[event.detections.length - 1].instrument}${frpBit}\nPreuves: ${event.evidenceShort.join('·')}${windBit}\n\n⚠️${LABELS.disclaimer}\n${attribution}`;
}
