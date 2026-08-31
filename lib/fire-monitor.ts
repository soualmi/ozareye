import villagesData from '@/data/villages.json';
import { distanceKm } from './geo';
import { classifyExposure, type WindRelation } from './wind';
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
};

export type VillageExposure = {
  osm_id: string; name: string; name_ar: string | null; wilaya: string;
  lat: number; lon: number; // for the dashboard map
  distanceKm: number; relation: WindRelation; etaHours?: number;
};

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
  notifiedAt?: string; notifiedScore?: number; notifiedStatus?: FireEvent['status'];
};

const villages = villagesData as { osm_id: string; name: string; name_ar: string | null; lat: number; lon: number; place: string; wilaya: string }[];

const SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT'];
// Full northern forest belt: Moroccan border to Tunisian border, southern edge
// around the Saharan Atlas (west,south,east,north). Widen further only with a
// matching widen of the persistent-source guard below — going deeper south
// multiplies the odds of catching gas flares and permanent industrial heat.
const ALGERIA_BOX = '-2.5,34.0,9.0,37.3';

// Persistent-source guard: a real wildfire burns out in days; a gas flare or
// industrial heat source fires on the same ~1km cell over and over for months.
// A cell seen on more than this many distinct days within the rolling window
// is flagged a probable permanent source and suppressed (self-learning — no
// hardcoded flare list to maintain).
export const PERSISTENT_SOURCE_DAY_THRESHOLD = 10;
export const PERSISTENT_SOURCE_WINDOW_DAYS = 30;

// ~1km resolution (0.01deg is ~1.1km of latitude at these latitudes; longitude
// spacing shrinks moving north, but this is a coarse noise filter, not a survey).
export function gridCell(lat: number, lon: number): string {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

const CLUSTER_RADIUS_KM = 2;
const CLUSTER_TIME_HOURS = 12;
const EXPOSURE_RADIUS_KM = 20;
// A village this close to the fire is always named, regardless of wind
// classification — at this range wind direction can shift, terrain deflects it,
// and embers travel independently of the prevailing flow.
const PROXIMITY_KM = 3;
// Crude spread-rate rule of thumb for Mediterranean scrub/forest: the fire front
// advances at roughly this fraction of the 10m wind speed. This is NOT a fire
// physics model — treat every ETA it produces as a rough estimate, not a forecast.
const SPREAD_FACTOR = 0.06;

export const ALERT_SCORE_THRESHOLD = 70;
// Re-alert an already-notified event only if it grew this much, or crossed a
// status boundary (e.g. corroborated -> urgent) — not on every extra pixel.
const ESCALATION_SCORE_DELTA = 15;

type SourceResult = { source: string; rows: Detection[] | null };

// `box` and `date` let the replay script (Part D2) pull a historical day over a
// narrower bbox; live monitoring uses the defaults (ALGERIA_BOX, today).
export async function fetchDetections(mapKey: string, opts?: { box?: string; date?: string }): Promise<SourceResult[]> {
  const box = opts?.box ?? ALGERIA_BOX;
  const datePart = opts?.date ? `/${opts.date}` : '';
  return Promise.all(SOURCES.map(async (source): Promise<SourceResult> => {
    try {
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${mapKey}/${source}/${box}/1${datePart}`;
      const response = await fetch(url, { headers: { 'User-Agent': 'Algerie-Feux-Alerte/1.0' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rows = parseCsv(await response.text()).map(rowToDetection);
      console.log(`source ${source}: ${rows.length} rows`);
      return { source, rows };
    } catch (error) {
      console.log(`source ${source}: FAILED (${error instanceof Error ? error.message : error})`);
      return { source, rows: null };
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
export function clusterDetections(detections: Detection[], events: FireEvent[]): FireEvent[] {
  for (const det of detections) {
    let best: FireEvent | null = null, bestDist = Infinity;
    for (const ev of events) {
      const dist = distanceKm(ev.latitude, ev.longitude, det.latitude, det.longitude);
      if (dist <= CLUSTER_RADIUS_KM && hoursBetween(ev.lastAcquiredAt, det.acquiredAt) <= CLUSTER_TIME_HOURS && dist < bestDist) {
        best = ev; bestDist = dist;
      }
    }
    if (best) {
      const isDuplicate = best.detections.some(d => d.latitude === det.latitude && d.longitude === det.longitude && d.acquiredAt === det.acquiredAt && d.satellite === det.satellite);
      if (!isDuplicate) {
        best.detections.push(det);
        best.latitude = average(best.detections.map(d => d.latitude));
        best.longitude = average(best.detections.map(d => d.longitude));
        best.firstAcquiredAt = best.detections.reduce((min, d) => d.acquiredAt < min ? d.acquiredAt : min, best.firstAcquiredAt);
        best.lastAcquiredAt = best.detections.reduce((max, d) => d.acquiredAt > max ? d.acquiredAt : max, best.lastAcquiredAt);
      }
    } else {
      events.push(newEventFrom(det));
    }
  }
  return events.map(scoreEvent);
}

/**
 * Corroboration = detections from a DIFFERENT satellite pass (different
 * satellite, or the same satellite at a different overpass time). Multiple
 * adjacent pixels from the SAME single pass mean the fire is big, not that
 * it's confirmed — that's scored separately, honestly labelled as size.
 */
function scoreEvent(event: FireEvent): FireEvent {
  const passKeys = new Map<string, number>();
  for (const d of event.detections) {
    const key = `${d.satellite}|${d.acquiredAt}`;
    passKeys.set(key, (passKeys.get(key) ?? 0) + 1);
  }
  const passCount = passKeys.size;
  const maxPixelsInSinglePass = Math.max(...passKeys.values());
  const maxFrp = Math.max(...event.detections.map(d => d.frp));
  const maxConfidence = event.detections.reduce((best, d) => confidenceRank(d.confidence) > confidenceRank(best) ? d.confidence : best, event.detections[0].confidence);

  const evidence: string[] = [`NASA FIRMS · ${event.detections.length} pixel(s) sur ${passCount} passage(s)`];
  const evidenceShort: string[] = [`${passCount}pass`];
  let score = 25;
  if (confidenceRank(maxConfidence) === 2) { score += 25; evidence.push('Confiance satellite élevée'); evidenceShort.push('conf+'); }
  else if (confidenceRank(maxConfidence) === 1) score += 14;
  if (maxFrp >= 20) score += 20; else if (maxFrp >= 8) score += 12; else if (maxFrp >= 3) score += 5;
  evidence.push(`Puissance radiative max ${maxFrp.toFixed(1)} MW`);
  if (maxPixelsInSinglePass >= 3) { score += 10; evidence.push(`Feu étendu · ${maxPixelsInSinglePass} pixels dans un même passage (taille, pas confirmation)`); evidenceShort.push(`taille×${maxPixelsInSinglePass}`); }
  if (passCount > 1) { score += 25; evidence.push(`Recoupé par un passage/capteur différent (${passCount} passages distincts)`); evidenceShort.push('recoupé'); }
  if (event.latitude >= 34 && event.latitude <= 37.5) { score += 5; evidence.push('Bande nord à végétation sensible'); }
  score = Math.min(score, 100);

  return {
    ...event, maxFrp, maxConfidence, passCount, maxPixelsInSinglePass, score, evidence, evidenceShort,
    status: score >= 85 ? 'urgent' : score >= 65 ? 'corroborated' : 'observation',
  };
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
    const data = await fetch(url).then(r => r.json()) as { current?: { relative_humidity_2m?: number; wind_speed_10m?: number; wind_direction_10m?: number } };
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
    const data = await fetch(url).then(r => r.json()) as { hourly?: { time: string[]; relative_humidity_2m: number[]; wind_speed_10m: number[]; wind_direction_10m: number[] } };
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
    results.push({ osm_id: v.osm_id, name: v.name, name_ar: v.name_ar, wilaya: v.wilaya, lat: v.lat, lon: v.lon, distanceKm: distanceKmVal, relation, etaHours });
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

const CARDINALS_FR = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
export function cardinalFr(deg: number) {
  return CARDINALS_FR[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

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
export function selectExposedVillages(event: FireEvent): VillageSelection[] {
  const all = event.villages ?? [];
  const proximity = all.filter(v => v.distanceKm <= PROXIMITY_KM).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 2);
  const proximityIds = new Set(proximity.map(v => v.osm_id));
  const downwind = all.filter(v => v.relation !== 'upwind' && !proximityIds.has(v.osm_id))
    .sort((a, b) => (a.relation === b.relation ? a.distanceKm - b.distanceKm : a.relation === 'downwind' ? -1 : 1))
    .slice(0, 2);
  return [...proximity.map(village => ({ village, isProximity: true })), ...downwind.map(village => ({ village, isProximity: false }))];
}

// Village names still legitimately mix scripts (name + name_ar, or a Kabyle
// name — that's the real place name, untouched). A Latin name directly against
// an Arabic one with only a "/" between them can visually reorder at that
// boundary in a bidi-aware renderer (terminal, WhatsApp) without explicit
// Unicode directional isolates — the source text stays byte-correct, but a
// Latin word next to the join can render scrambled. RLI...PDI isolates the
// Arabic run so it can't leak into its neighbour. System labels are plain
// French now (LABELS below), so this is only needed for village names.
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

export function telegramText(event: FireEvent, referenceTime = new Date()) {
  const icon = event.status === 'urgent' ? '🔴' : '🟠';
  const shown = selectExposedVillages(event);

  const villageLines = shown.length
    ? shown.map(({ village: v, isProximity }) => {
      const label = isProximity ? LABELS.proximity : LABELS.downwind;
      const eta = !isProximity && v.etaHours !== undefined ? ` ~${etaBucket(v.etaHours)}` : '';
      return `⚠️ ${biText(v.name, v.name_ar)} ${v.distanceKm.toFixed(1)}km ${label}${eta}`;
    }).join('\n')
    : LABELS.noVillage;

  const ageMin = minutesSince(event.lastAcquiredAt, referenceTime);
  const windBit = event.windKph !== undefined && event.windDirectionFromDeg !== undefined
    ? ` vent ${event.windKph} km/h → ${cardinalFr(event.windDirectionFromDeg + 180)}` : '';
  const wilaya = eventWilaya(event);
  const locationBit = wilaya ? ` · ${wilaya}` : '';

  return `${icon} ${LABELS.headline} — À VÉRIFIER\n\n${villageLines}\n\n📍${event.latitude.toFixed(4)},${event.longitude.toFixed(4)}${locationBit} ${algiersTime(event.lastAcquiredAt)}Alger(${ageMin}min) ${event.detections[event.detections.length - 1].instrument} FRP${event.maxFrp.toFixed(1)}MW\nPreuves: ${event.evidenceShort.join('·')}${windBit}\n\n⚠️${LABELS.disclaimer}\nNASA FIRMS·Open-Meteo`;
}
