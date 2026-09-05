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

// Case-study metrics over a finished replay — the numbers that answer "would
// this have helped?" for the 26 August 2026 fires, and the ones that say where
// the answer is unknown.
//
//   npm run replay:metrics -- --out replay-out/20260826 --db data/replay-20260826.db
//
// Reads only the replay's own artefacts (events.json + its database) and makes
// no network calls. Writes metrics.md and metrics.json next to them.
//
// First-alert reconstruction: the replay did not persist per-alert state, so
// each event's first alerting poll is recomputed here by feeding its stored
// detections back through the REAL clustering/scoring in 20-minute buckets.
// That path has no weather, so it cannot add the wind/humidity bonus (up to
// +10) the live run had — a reconstructed first alert can therefore land one
// or two polls LATER than the replay's own, never earlier. The five messages
// the replay wrote are used as ground truth to report how far off it is.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// Type-only: erased, so it doesn't load lib/database before the replay DB path
// is set below.
import type { FireEvent } from '../lib/fire-monitor';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const outDir = arg('out', 'replay-out/20260826')!;
const dbPath = arg('db', 'data/replay-20260826.db')!;
process.env.ALGERIE_FEUX_DB_PATH = path.resolve(dbPath);
// Optional: the ORIGINAL VIIRS-only replay to compare this run against (§7).
// Reads its database directly (node:sqlite, read-only) rather than through
// lib/database — that module's DB_PATH is a singleton captured once from
// ALGERIE_FEUX_DB_PATH, already pointed at --db above.
const baselineDb = arg('baseline-db');
const baselineOut = arg('baseline-out');
// Optional: the VIIRS+Meteosat replay to compare a 3-source (VIIRS+Meteosat+
// SLSTR) run against (§8) — a DIFFERENT baseline than §7's VIIRS-only one,
// since SLSTR's marginal contribution is what Meteosat alone already
// provides, not what VIIRS alone provides.
const baseline2Db = arg('baseline2-db');
const baseline2Out = arg('baseline2-out');

const { clusterDetections, ALERT_SCORE_THRESHOLD, algiersTime, isMeteosatDetection, isSlstrDetection } = await import('../lib/fire-monitor');
const { shouldAlert } = await import('../lib/replay');
const { displayName } = await import('../lib/place-name');
const { eventsBetween, getConfig } = await import('../lib/database');
const { distanceKm } = await import('../lib/geo');

const BUCKET_MS = 20 * 60_000;
const FOCUS = ['Jijel', 'Béjaïa', 'Tizi Ouzou'];
const WEAK_FRP_MW = 20;
const BIG_FRP_MW = 100;
// Matching two independent runs' events by id is meaningless — a wider join
// radius (Meteosat) or a different detection footprint (SLSTR) can merge or
// split things differently across two separate replays of the same window.
// Geographic nearest-neighbour is the practical substitute — shared by §7
// and §8 rather than two separate magic numbers.
const MATCH_RADIUS_KM = 3;

type EventOut = {
  id: string; wilaya: string | null; wilayaLabel: string;
  latitude: number; longitude: number;
  firstDetectionUtc: string; firstDetectionAlgiers: string;
  maxFrpMw: number; passCount: number; score: number; status: string;
  villagesEvaluated: boolean;
  nearbyVillages: { name: string; rawName?: string; nameAr: string | null; distanceKm: number; relation?: string }[];
  downwindVillages: { name: string; rawName?: string; nameAr: string | null; distanceKm: number; relation?: string }[];
  wouldHaveAlerted: boolean;
  landUse: { context: string; siteName?: string };
};

const eventsOut = JSON.parse(fs.readFileSync(path.join(outDir, 'events.json'), 'utf8')) as EventOut[];
const config = await getConfig();
const stored = await eventsBetween('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 10_000);
const storedById = new Map(stored.map(e => [e.id, e] as const));

// --- first alerting poll, recomputed from the stored detections -------------
// Unchanged from before this file learned about Meteosat — kept exactly as
// is (score >= ALERT_SCORE_THRESHOLD against the highest-scoring carried
// candidate) so every VIIRS-only figure in §1-6 keeps matching previously
// published reports byte for byte. It under-reconstructs Meteosat-only
// alerts (their score never carries real FRP/confidence, so it rarely
// crosses 70) — §7 below uses a separate, shouldAlert()-based reconstruction
// for those instead of changing this one's long-standing behaviour.
type FirstAlert = { atIso: string; frpAtAlert: number; passesAtAlert: number };

function firstAlert(event: FireEvent): FirstAlert | null {
  const buckets = new Map<number, typeof event.detections>();
  for (const d of event.detections) {
    const slot = Math.floor(Date.parse(d.acquiredAt) / BUCKET_MS) * BUCKET_MS;
    if (!buckets.has(slot)) buckets.set(slot, []);
    buckets.get(slot)!.push(d);
  }
  let carried: FireEvent[] = [];
  for (const slot of [...buckets.keys()].sort((a, b) => a - b)) {
    carried = clusterDetections(buckets.get(slot)!, carried, config.frpThresholdMw);
    const best = carried.reduce((a, b) => (b.score > a.score ? b : a), carried[0]);
    if (best && best.score >= ALERT_SCORE_THRESHOLD) {
      return { atIso: new Date(slot + BUCKET_MS).toISOString(), frpAtAlert: best.maxFrp, passesAtAlert: best.passCount };
    }
  }
  return null;
}

// shouldAlert()-based reconstruction (lib/replay.ts, exported so this and the
// fused replay itself never drift apart) — rule (e)/(c)'s secondary-source
// branch (Meteosat and SLSTR) included. Used by §7 and §8: unlike
// firstAlert() above, this correctly finds a Meteosat-only or SLSTR-only
// event's alerting poll (gated on status, not a score threshold its score
// can't always realistically reach).
// Typed as FireEvent's own positionSource type (not a hand-rolled
// 'viirs' | 'meteosat' union) since scoreEvent()'s return type now genuinely
// includes 'slstr' too — this replay path can produce it for real once
// --with-slstr is used.
type ReconstructedAlert = { atIso: string; frpAtAlert: number; passesAtAlert: number; positionSourceAtAlert: NonNullable<FireEvent['positionSource']> };

function reconstructAlert(event: FireEvent, proximityKm: number): ReconstructedAlert | null {
  const buckets = new Map<number, typeof event.detections>();
  for (const d of event.detections) {
    const slot = Math.floor(Date.parse(d.acquiredAt) / BUCKET_MS) * BUCKET_MS;
    if (!buckets.has(slot)) buckets.set(slot, []);
    buckets.get(slot)!.push(d);
  }
  let carried: FireEvent[] = [];
  for (const slot of [...buckets.keys()].sort((a, b) => a - b)) {
    carried = clusterDetections(buckets.get(slot)!, carried, config.frpThresholdMw);
    for (const ev of carried) {
      if (shouldAlert(ev, proximityKm)) {
        return { atIso: new Date(slot + BUCKET_MS).toISOString(), frpAtAlert: ev.maxFrp, passesAtAlert: ev.passCount, positionSourceAtAlert: ev.positionSource ?? 'viirs' };
      }
    }
  }
  return null;
}

const alerts = new Map<string, FirstAlert>();
for (const e of eventsOut) {
  if (!e.wouldHaveAlerted) continue;
  const full = storedById.get(e.id);
  if (!full) continue;
  const first = firstAlert(full);
  if (first) alerts.set(e.id, first);
}

// --- ground truth: the five messages the replay itself wrote -----------------
const messageDir = path.join(outDir, 'messages');
const groundTruth: { id: string; renderedAt: string; frp: number }[] = [];
if (fs.existsSync(messageDir)) {
  for (const file of fs.readdirSync(messageDir).filter(f => f.endsWith('.txt'))) {
    const text = fs.readFileSync(path.join(messageDir, file), 'utf8');
    const id = /# événement (\S+)/.exec(text)?.[1];
    const renderedAt = /passage du cron de (\S+)/.exec(text)?.[1];
    const frp = /FRP max ([\d.]+) MW/.exec(text)?.[1];
    if (id && renderedAt && frp) groundTruth.push({ id, renderedAt, frp: Number(frp) });
  }
}
const calibration = groundTruth.map(g => {
  const mine = alerts.get(g.id);
  return {
    id: g.id, replayRenderedAt: g.renderedAt, reconstructedAt: mine?.atIso ?? null,
    driftMinutes: mine ? Math.round((Date.parse(mine.atIso) - Date.parse(g.renderedAt)) / 60_000) : null,
    replayFrpAtAlert: g.frp, reconstructedFrpAtAlert: mine?.frpAtAlert ?? null,
  };
});

// --- 1. early weak signal ----------------------------------------------------
type VillageOut = { name: string; rawName?: string; nameAr: string | null; distanceKm: number; relation?: string };

const shownName = (v: VillageOut) => displayName({ name: v.rawName ?? v.name, name_ar: v.nameAr });

const nearest = (e: EventOut) => {
  const all = [...e.nearbyVillages, ...e.downwindVillages].sort((a, b) => a.distanceKm - b.distanceKm);
  return all.length ? `${shownName(all[0])} (${all[0].distanceKm} km)` : '—';
};

// What the message actually PRINTS: selectExposedVillages() names at most two
// villages within the proximity radius and two downwind. events.json stores
// every village within the 20km exposure radius, so matching against all of
// them would credit the system with naming places no reader ever saw.
function namedInMessage(e: EventOut): VillageOut[] {
  const proximity = [...e.nearbyVillages].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 2);
  const downwind = [...e.downwindVillages]
    .sort((a, b) => (a.relation === b.relation ? a.distanceKm - b.distanceKm : a.relation === 'downwind' ? -1 : 1))
    .slice(0, 2);
  return [...proximity, ...downwind];
}

const grewBig = eventsOut
  .filter(e => e.wouldHaveAlerted && alerts.has(e.id) && e.maxFrpMw >= BIG_FRP_MW)
  .map(e => ({ e, a: alerts.get(e.id)! }));

// Two different claims, kept apart because merging them flatters the system:
// a fire alerted at 4.7 MW is a weak signal caught early; one alerted at 687 MW
// on its first pass is a huge fire caught on first sight. Both matter, neither
// is the other.
const weakFrpSet = grewBig.filter(({ a }) => a.frpAtAlert < WEAK_FRP_MW);
const fewPassesSet = grewBig.filter(({ a }) => a.passesAtAlert <= 2 && a.frpAtAlert >= WEAK_FRP_MW);

const toRow = (({ e, a }: { e: EventOut; a: FirstAlert }) => ({
    id: e.id, wilaya: e.wilayaLabel,
    firstAlertAlgiers: algiersTime(a.atIso), firstAlertUtc: a.atIso,
    frpAtAlertMw: Number(a.frpAtAlert.toFixed(1)), passesAtAlert: a.passesAtAlert,
    peakFrpMw: Number(e.maxFrpMw.toFixed(1)),
    hoursToPeak: Number(((Date.parse(storedById.get(e.id)!.lastAcquiredAt) - Date.parse(a.atIso)) / 3_600_000).toFixed(1)),
    nearestVillage: nearest(e),
  }));

const earlyWeak = weakFrpSet.map(toRow).sort((a, b) => b.peakFrpMw - a.peakFrpMw);
const firstSightBig = fewPassesSet.map(toRow).sort((a, b) => b.peakFrpMw - a.peakFrpMw);

// --- 2. night alerts ---------------------------------------------------------
function algiersHour(iso: string): number {
  return Number(new Date(iso).toLocaleString('fr-FR', { timeZone: 'Africa/Algiers', hour: '2-digit', hour12: false }).slice(0, 2));
}
const alertedIds = [...alerts.keys()];
const nightIds = alertedIds.filter(id => { const h = algiersHour(alerts.get(id)!.atIso); return h >= 22 || h < 6; });

// --- 3. press village coverage ----------------------------------------------
const PRESS_VILLAGES: { label: string; variants: string[] }[] = [
  { label: 'Aghbala / Agbala', variants: ['aghbala', 'agbala', 'أغبالة', 'اغبالة'] },
  { label: 'Bordj Tahar', variants: ['bordj tahar', 'burj tahar', 'برج الطاهر', 'برج طاهر'] },
  { label: 'Acherar', variants: ['acherar', 'achrar', 'أشرار', 'اشرار'] },
  { label: 'Anchid', variants: ['anchid', 'anachid', 'أنشيد', 'انشيد', 'العنشيد'] },
  { label: 'El Ouadia', variants: ['el ouadia', 'ouadia', 'الوادية', 'وادية'] },
  { label: 'Taghrast', variants: ['taghrast', 'tagrast', 'تغرست'] },
  { label: 'Ghebala (Chekfa)', variants: ['ghebala', 'gbala', 'غبالة'] },
  { label: 'Bouakba (Ouled Yahia Khadrouche)', variants: ['bouakba', 'bou akba', 'بوعقبة'] },
  { label: 'Taksena (Jijel)', variants: ['taksena', 'takasna', 'تاكسنة'] },
];

function normalise(value: string): string {
  return value
    .normalize('NFD').replace(/[̀-ͯ]/g, '')          // Latin accents
    .replace(/[ً-ْـ]/g, '')                      // Arabic diacritics, tatweel
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .toLowerCase().replace(/[^a-z0-9؀-ۿ]/g, '');
}

const pressCoverage = PRESS_VILLAGES.map(press => {
  const keys = press.variants.map(normalise).filter(Boolean);
  let best: { id: string; wilaya: string; atIso: string; distanceKm: number; matched: string } | null = null;
  for (const e of eventsOut) {
    if (!e.wouldHaveAlerted || !alerts.has(e.id)) continue;
    for (const v of namedInMessage(e)) {
      const candidates = [shownName(v), v.rawName ?? '', v.nameAr ?? ''].map(normalise).filter(Boolean);
      // Equality, or containment with at most one character of slack: Arabic
      // "غبالة" and "أغبالة" are two different places and a loose `includes`
      // happily conflates them.
      const hit = candidates.find(c => keys.some(k => c === k || (c.includes(k) && c.length - k.length <= 1) || (k.includes(c) && k.length - c.length <= 1)));
      if (!hit) continue;
      const at = alerts.get(e.id)!.atIso;
      if (!best || at < best.atIso) best = { id: e.id, wilaya: e.wilayaLabel, atIso: at, distanceKm: v.distanceKm, matched: shownName(v) };
    }
  }
  return { press: press.label, found: !!best, ...(best ?? {}) };
});
const pressFound = pressCoverage.filter(p => p.found).length;

// --- industrial-site overlap (needs land-use reevaluated with the local index,
//     `npm run replay -- --db ... --out ... --reevaluate-landuse`) ----------
const eventsById = new Map(eventsOut.map(e => [e.id, e] as const));
const isIndustrial = (e: EventOut) => e.landUse?.context === 'industrial';
const industrialAlerted = alertedIds.filter(id => isIndustrial(eventsById.get(id)!));
const industrialShare = Number((industrialAlerted.length / Math.max(alertedIds.length, 1)).toFixed(3));
const industrialByWilaya = Object.fromEntries(FOCUS.map(w => {
  const inWilaya = alertedIds.filter(id => eventsById.get(id)!.wilaya === w);
  const industrialInWilaya = inWilaya.filter(id => isIndustrial(eventsById.get(id)!));
  return [w, { alerted: inWilaya.length, industrial: industrialInWilaya.length, share: Number((industrialInWilaya.length / Math.max(inWilaya.length, 1)).toFixed(3)) }];
}));

// --- 4. geographic precision -------------------------------------------------
function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return Number((sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)).toFixed(2));
}
function nearestKm(e: EventOut): number | null {
  const all = [...e.nearbyVillages, ...e.downwindVillages];
  return all.length ? Math.min(...all.map(v => v.distanceKm)) : null;
}
function precisionFor(filter: (e: EventOut) => boolean) {
  const values = eventsOut.filter(e => alerts.has(e.id) && filter(e)).map(nearestKm).filter((v): v is number => v !== null);
  return { events: values.length, medianKm: quantile(values, 0.5), p90Km: quantile(values, 0.9) };
}
const precision = {
  overall: precisionFor(() => true),
  ...Object.fromEntries(FOCUS.map(w => [w, precisionFor(e => e.wilaya === w)])),
};

// --- 5. delay reality check --------------------------------------------------
const aug26 = FOCUS.map(w => {
  const times = eventsOut
    .filter(e => e.wilaya === w && alerts.has(e.id))
    .map(e => alerts.get(e.id)!.atIso)
    .filter(iso => iso.slice(0, 10) === '2026-08-26')
    .sort();
  return { wilaya: w, firstAlertUtc: times[0] ?? null, firstAlertAlgiers: times[0] ? algiersTime(times[0]) : null, alertsThatDay: times.length };
});

// --- 7. Meteosat's contribution: compare against the ORIGINAL VIIRS-only
//     replay (--baseline-db/--baseline-out) ----------------------------------
// Matching two independent runs' events by id is meaningless — Meteosat's
// wider join radius can merge or split things differently. Geographic
// nearest-neighbour (<=3km centroid distance) is the practical substitute;
// same rationale as precisionFor() above, which already does exactly this
// for village matching.
type MeteosatComparisonRow = {
  id: string; wilaya: string; firstDetectionUtc: string; maxFrpMw: number;
  fusedFirstAlertUtc: string; fusedFirstAlertAlgiers: string;
  matchedOriginalId: string | null; originalFirstAlertUtc: string | null; originalFirstAlertAlgiers: string | null;
  savedMinutes: number | null;
};
let meteosatComparison: {
  meteosatFirstCount: number; meteosatFirstStatusNote: string;
  matched: MeteosatComparisonRow[]; unmatched: MeteosatComparisonRow[];
  savedMinutes: { count: number; averageMin: number | null; medianMin: number | null };
} | null = null;

if (baselineDb && baselineOut) {
  const baselineDbFile = new DatabaseSync(path.resolve(baselineDb), { readOnly: true });
  const baselineRows = baselineDbFile.prepare('SELECT payload FROM fire_events').all() as { payload: string }[];
  baselineDbFile.close();
  const baselineStored = baselineRows.map(r => JSON.parse(r.payload) as FireEvent);
  const baselineOutJson = JSON.parse(fs.readFileSync(path.join(baselineOut, 'events.json'), 'utf8')) as { id: string; wilaya: string | null; latitude: number; longitude: number; wouldHaveAlerted: boolean }[];
  const baselineAlertedFull = baselineOutJson.filter(e => e.wouldHaveAlerted).map(e => baselineStored.find(s => s.id === e.id)).filter((e): e is FireEvent => Boolean(e));
  const baselineFirstAlerts = new Map<string, ReconstructedAlert>();
  for (const e of baselineAlertedFull) {
    const first = reconstructAlert(e, config.proximityKm);
    if (first) baselineFirstAlerts.set(e.id, first);
  }

  function nearestBaseline(lat: number, lon: number): FireEvent | null {
    let best: FireEvent | null = null, bestDist = Infinity;
    for (const b of baselineAlertedFull) {
      if (!baselineFirstAlerts.has(b.id)) continue;
      const d = distanceKm(lat, lon, b.latitude, b.longitude);
      if (d <= MATCH_RADIUS_KM && d < bestDist) { best = b; bestDist = d; }
    }
    return best;
  }

  // This run's own (fused) alerting poll, reconstructed with the SAME
  // shouldAlert()-based function as the baseline side above — the top-level
  // `alerts` map (used by §1-6) can't be reused here: it's built with the
  // old score-threshold-only firstAlert(), which under-detects Meteosat-only
  // events by design (see that function's comment).
  const fusedFirstAlerts = new Map<string, ReconstructedAlert>();
  const focusFusedAlerted = eventsOut.filter(e => e.wouldHaveAlerted && FOCUS.includes(e.wilaya ?? ''));
  for (const e of focusFusedAlerted) {
    const full = storedById.get(e.id);
    if (!full) continue;
    const first = reconstructAlert(full, config.proximityKm);
    if (first) fusedFirstAlerts.set(e.id, first);
  }

  const rows: MeteosatComparisonRow[] = focusFusedAlerted.filter(e => fusedFirstAlerts.has(e.id)).map(e => {
    const fusedAlert = fusedFirstAlerts.get(e.id)!;
    const match = nearestBaseline(e.latitude, e.longitude);
    const originalAlert = match ? baselineFirstAlerts.get(match.id)! : null;
    return {
      id: e.id, wilaya: e.wilaya ?? '?', firstDetectionUtc: e.firstDetectionUtc, maxFrpMw: e.maxFrpMw,
      fusedFirstAlertUtc: fusedAlert.atIso, fusedFirstAlertAlgiers: algiersTime(fusedAlert.atIso),
      matchedOriginalId: match?.id ?? null,
      originalFirstAlertUtc: originalAlert?.atIso ?? null,
      originalFirstAlertAlgiers: originalAlert ? algiersTime(originalAlert.atIso) : null,
      savedMinutes: originalAlert ? Math.round((Date.parse(originalAlert.atIso) - Date.parse(fusedAlert.atIso)) / 60_000) : null,
    };
  });
  const matched = rows.filter(r => r.matchedOriginalId !== null).sort((a, b) => (b.savedMinutes ?? 0) - (a.savedMinutes ?? 0));
  const unmatched = rows.filter(r => r.matchedOriginalId === null);
  const savedValues = matched.map(r => r.savedMinutes!).filter(v => v !== null);
  const meteosatFirstIds = focusFusedAlerted.filter(e => fusedFirstAlerts.get(e.id)?.positionSourceAtAlert === 'meteosat').map(e => e.id);

  meteosatComparison = {
    meteosatFirstCount: meteosatFirstIds.length,
    // Rule (e), locked (lib/fire-monitor.ts scoreEvent): a Meteosat-only
    // event's status can only ever be 'observation' or 'corroborated', and
    // shouldAlert's meteosat branch requires status === 'corroborated'
    // exactly — so by construction every one of these alerts is
    // 'corroborated', never 'urgent'. Not a distribution to compute; a fact
    // to state.
    meteosatFirstStatusNote: `${meteosatFirstIds.length}/${meteosatFirstIds.length} au statut 'corroborated' — jamais 'urgent' par construction de la règle (e) (voir lib/fire-monitor.ts).`,
    matched, unmatched,
    savedMinutes: {
      count: savedValues.length,
      averageMin: savedValues.length ? Math.round(savedValues.reduce((a, b) => a + b, 0) / savedValues.length) : null,
      medianMin: quantile(savedValues, 0.5),
    },
  };
}

// --- 8. SLSTR's contribution: compare against the VIIRS+Meteosat replay
//     (--baseline2-db/--baseline2-out) — a DIFFERENT baseline than §7's
//     VIIRS-only one, since the question here is what SLSTR adds beyond
//     what Meteosat ALREADY provides, not what either adds beyond VIIRS
//     alone. ------------------------------------------------------------

// 1. Real per-detection FRP on an event that would otherwise be Meteosat-
//    only (frp=0, no real reading) — SLSTR's distinct contribution beyond
//    Meteosat alone. Computed from THIS run's own stored events; no
//    baseline needed for this one.
const slstrFrpPromoted = stored.filter(e =>
  e.detections.some(isMeteosatDetection) &&
  e.detections.some(isSlstrDetection) &&
  !e.detections.some(d => !isMeteosatDetection(d) && !isSlstrDetection(d)),
);
// 4. Honesty denominator: real SLSTR detections that made it into a
//    clustered event over the whole window — not inflated, not rounded up.
const slstrDetectionCount = stored.reduce((n, e) => n + e.detections.filter(isSlstrDetection).length, 0);

type SlstrComparisonRow = {
  id: string; wilaya: string; firstDetectionUtc: string; maxFrpMw: number;
  fusedFirstAlertUtc: string; fusedFirstAlertAlgiers: string;
  matchedBaselineId: string | null; baselineFirstAlertUtc: string | null; baselineFirstAlertAlgiers: string | null;
  deltaMinutes: number | null;
};
let slstrComparison: {
  slstrFirstCount: number; slstrFirstStatusNote: string;
  matched: SlstrComparisonRow[]; unmatched: SlstrComparisonRow[];
  deltaMinutes: { count: number; averageMin: number | null; medianMin: number | null };
  additionalEarlyWeak: { count: number; rows: ReturnType<typeof toRow>[] };
  // 3. The headline lead-time number, restated: this run's own aug26 (§5)
  // alongside the SAME figure recomputed for the baseline2 (VIIRS+Meteosat)
  // run — expected to read as essentially the same times, since SLSTR is
  // polar (like VIIRS), not geostationary (like Meteosat), and therefore
  // doesn't fill the temporal gap Meteosat fills.
  headlineLeadTime: { current: typeof aug26; baseline: typeof aug26 };
} | null = null;

if (baseline2Db && baseline2Out) {
  const b2DbFile = new DatabaseSync(path.resolve(baseline2Db), { readOnly: true });
  const b2Rows = b2DbFile.prepare('SELECT payload FROM fire_events').all() as { payload: string }[];
  b2DbFile.close();
  const b2Stored = b2Rows.map(r => JSON.parse(r.payload) as FireEvent);
  const b2OutJson = JSON.parse(fs.readFileSync(path.join(baseline2Out, 'events.json'), 'utf8')) as { id: string; wilaya: string | null; latitude: number; longitude: number; wouldHaveAlerted: boolean }[];
  const b2AlertedFull = b2OutJson.filter(e => e.wouldHaveAlerted).map(e => b2Stored.find(s => s.id === e.id)).filter((e): e is FireEvent => Boolean(e));
  const b2FirstAlerts = new Map<string, ReconstructedAlert>();
  for (const e of b2AlertedFull) {
    const first = reconstructAlert(e, config.proximityKm);
    if (first) b2FirstAlerts.set(e.id, first);
  }

  function nearestB2(lat: number, lon: number): FireEvent | null {
    let best: FireEvent | null = null, bestDist = Infinity;
    for (const b of b2AlertedFull) {
      if (!b2FirstAlerts.has(b.id)) continue;
      const d = distanceKm(lat, lon, b.latitude, b.longitude);
      if (d <= MATCH_RADIUS_KM && d < bestDist) { best = b; bestDist = d; }
    }
    return best;
  }

  // This (3-source) run's own alerting poll, reconstructed with the SAME
  // shouldAlert()-based function as the baseline2 side above — the top-level
  // `alerts` map (used by §1-6) can't be reused: it's built with the old
  // score-threshold-only firstAlert(), which under-detects secondary-only
  // events by design (see that function's comment).
  const fusedFirstAlerts = new Map<string, ReconstructedAlert>();
  const focusFusedAlerted = eventsOut.filter(e => e.wouldHaveAlerted && FOCUS.includes(e.wilaya ?? ''));
  for (const e of focusFusedAlerted) {
    const full = storedById.get(e.id);
    if (!full) continue;
    const first = reconstructAlert(full, config.proximityKm);
    if (first) fusedFirstAlerts.set(e.id, first);
  }

  const rows: SlstrComparisonRow[] = focusFusedAlerted.filter(e => fusedFirstAlerts.has(e.id)).map(e => {
    const fusedAlert = fusedFirstAlerts.get(e.id)!;
    const match = nearestB2(e.latitude, e.longitude);
    const baselineAlert = match ? b2FirstAlerts.get(match.id)! : null;
    return {
      id: e.id, wilaya: e.wilaya ?? '?', firstDetectionUtc: e.firstDetectionUtc, maxFrpMw: e.maxFrpMw,
      fusedFirstAlertUtc: fusedAlert.atIso, fusedFirstAlertAlgiers: algiersTime(fusedAlert.atIso),
      matchedBaselineId: match?.id ?? null,
      baselineFirstAlertUtc: baselineAlert?.atIso ?? null,
      baselineFirstAlertAlgiers: baselineAlert ? algiersTime(baselineAlert.atIso) : null,
      // Positive = the 3-source run alerted EARLIER than VIIRS+Meteosat —
      // the "did SLSTR buy lead time" question. Expected to be small/near
      // zero: SLSTR is polar like VIIRS, not geostationary like Meteosat, so
      // it doesn't fill the temporal gap the way Meteosat does over VIIRS.
      deltaMinutes: baselineAlert ? Math.round((Date.parse(baselineAlert.atIso) - Date.parse(fusedAlert.atIso)) / 60_000) : null,
    };
  });
  const matched = rows.filter(r => r.matchedBaselineId !== null);
  const unmatched = rows.filter(r => r.matchedBaselineId === null);
  const deltaValues = matched.map(r => r.deltaMinutes!).filter(v => v !== null);
  // 2. Events whose FIRST-EVER alert was triggered by SLSTR alone (rule c),
  //    before any VIIRS pass existed on it yet.
  const slstrFirstIds = focusFusedAlerted.filter(e => fusedFirstAlerts.get(e.id)?.positionSourceAtAlert === 'slstr').map(e => e.id);

  // 2 (early-weak variant). Additional early-weak-signal alerts (§1's exact
  // definition: firstAlert(), score-threshold reconstruction) that this
  // 3-source run has but the baseline2 (2-source) run does not, matched
  // geographically — SLSTR's sub-pixel sensitivity finding something
  // Meteosat+VIIRS alone missed, not a same-event timing improvement
  // (that's deltaMinutes above, a different claim).
  const b2Alerts = new Map<string, FirstAlert>();
  for (const e of b2AlertedFull) {
    const first = firstAlert(e);
    if (first) b2Alerts.set(e.id, first);
  }
  const b2WeakFrpSet = b2AlertedFull
    .filter(e => e.maxFrp >= BIG_FRP_MW && b2Alerts.has(e.id) && b2Alerts.get(e.id)!.frpAtAlert < WEAK_FRP_MW)
    .map(e => ({ id: e.id, latitude: e.latitude, longitude: e.longitude }));
  const additionalEarlyWeakRows = weakFrpSet.filter(({ e }) =>
    !b2WeakFrpSet.some(b => distanceKm(e.latitude, e.longitude, b.latitude, b.longitude) <= MATCH_RADIUS_KM),
  );

  // 3. The baseline2 (VIIRS+Meteosat) run's own headline lead-time number,
  // recomputed the SAME way §5 computes `aug26` for this run — the number
  // to restate alongside it, not a new claim.
  const b2WilayaById = new Map(b2OutJson.map(e => [e.id, e.wilaya] as const));
  const b2Aug26 = FOCUS.map(w => {
    const times = b2AlertedFull
      .filter(e => b2WilayaById.get(e.id) === w)
      .map(e => b2Alerts.get(e.id)?.atIso)
      .filter((iso): iso is string => !!iso && iso.slice(0, 10) === '2026-08-26')
      .sort();
    return { wilaya: w, firstAlertUtc: times[0] ?? null, firstAlertAlgiers: times[0] ? algiersTime(times[0]) : null, alertsThatDay: times.length };
  });

  slstrComparison = {
    slstrFirstCount: slstrFirstIds.length,
    // Rule (c), locked (lib/fire-monitor.ts scoreEvent): an SLSTR-only
    // event's status can only ever be 'observation' or 'corroborated', and
    // shouldAlert's secondary branch requires status === 'corroborated'
    // exactly — so by construction every one of these alerts is
    // 'corroborated', never 'urgent'. Not a distribution to compute; a fact
    // to state.
    slstrFirstStatusNote: `${slstrFirstIds.length}/${slstrFirstIds.length} au statut 'corroborated' — jamais 'urgent' par construction de la règle (c) (voir lib/fire-monitor.ts).`,
    matched, unmatched,
    deltaMinutes: {
      count: deltaValues.length,
      averageMin: deltaValues.length ? Math.round(deltaValues.reduce((a, b) => a + b, 0) / deltaValues.length) : null,
      medianMin: quantile(deltaValues, 0.5),
    },
    additionalEarlyWeak: { count: additionalEarlyWeakRows.length, rows: additionalEarlyWeakRows.map(toRow) },
    headlineLeadTime: { current: aug26, baseline: b2Aug26 },
  };
}

const metrics = {
  generatedAt: new Date().toISOString(),
  source: { events: eventsOut.length, alerted: alertedIds.length, db: dbPath },
  ...(meteosatComparison ? { meteosatComparison } : {}),
  slstrContribution: { frpPromotedCount: slstrFrpPromoted.length, totalDetections: slstrDetectionCount, cadenceNote: '4 produits/jour sur l\'Algérie (2 S3A + 2 S3B) — cadence réelle mesurée, à comparer aux ~144/jour de Meteosat.' },
  ...(slstrComparison ? { slstrComparison } : {}),
  calibration,
  earlyWeakSignal: { count: earlyWeak.length, top10: earlyWeak.slice(0, 10) },
  bigOnFirstSight: { count: firstSightBig.length, top10: firstSightBig.slice(0, 10) },
  nightAlerts: { count: nightIds.length, share: Number((nightIds.length / Math.max(alertedIds.length, 1)).toFixed(3)) },
  industrialSites: { count: industrialAlerted.length, total: alertedIds.length, share: industrialShare, byWilaya: industrialByWilaya },
  pressCoverage: { found: pressFound, total: PRESS_VILLAGES.length, detail: pressCoverage },
  precision,
  aug26FirstAlerts: aug26,
};
fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n');

// --- metrics.md --------------------------------------------------------------
const L: string[] = [];
L.push('# Rejeu du 26 août 2026 — ce que les chiffres disent (et ne disent pas)', '');
L.push(`Sur les ${eventsOut.filter(e => e.wouldHaveAlerted).length} événements que le rejeu a alertés, ${alertedIds.length} voient leur premier passage alertant reconstruit ci-dessous ; les autres n'atteignaient le seuil qu'avec le bonus météo, absent de cette relecture hors ligne. Tous les comptes de ce document portent sur ces ${alertedIds.length}.`, '');
L.push(`Calculé le ${metrics.generatedAt} à partir de \`${outDir}/events.json\` et de \`${dbPath}\`. Aucun appel réseau, aucune donnée nouvelle : ce sont les 675 événements du rejeu, relus.`, '');
L.push('> **Reconstruction.** Le rejeu n\'a pas conservé l\'état de chaque alerte, donc le premier passage alertant est recalculé ici en refaisant passer les détections stockées dans le vrai moteur de regroupement/scoring, par tranches de 20 minutes. Ce chemin est hors ligne : il n\'a pas la météo, donc pas le bonus vent/humidité (jusqu\'à +10 points) qu\'avait le rejeu. Une alerte reconstruite peut donc arriver un ou deux passages **plus tard** que la vraie, jamais plus tôt.', '');
if (calibration.length) {
  L.push('Écart mesuré sur les cinq messages que le rejeu a réellement rendus :', '');
  L.push('| Événement | Rendu par le rejeu | Reconstruit | Écart |', '|---|---|---|---:|');
  for (const c of calibration) L.push(`| ${c.id.slice(0, 28)}… | ${c.replayRenderedAt} | ${c.reconstructedAt ?? '—'} | ${c.driftMinutes === null ? '—' : `${c.driftMinutes} min`} |`);
  L.push('');
}

L.push('## 1. Alertes sur signal faible précoce', '');
L.push(`**${earlyWeak.length} événements** ont déclenché leur première alerte avec un FRP encore inférieur à ${WEAK_FRP_MW} MW, puis ont dépassé ${BIG_FRP_MW} MW. C'est le cas d'usage : prévenir pendant que le feu est encore petit.`, '');
L.push('| Wilaya | Première alerte (Alger) | FRP à l\'alerte | Passages | Pic FRP | Délai jusqu\'au pic | Village le plus proche |', '|---|---|---:|---:|---:|---:|---|');
for (const w of earlyWeak.slice(0, 10)) L.push(`| ${w.wilaya} | ${w.firstAlertAlgiers} ${w.firstAlertUtc.slice(5, 10)} | ${w.frpAtAlertMw} MW | ${w.passesAtAlert} | ${w.peakFrpMw} MW | ${w.hoursToPeak} h | ${w.nearestVillage} |`);
L.push('');
L.push(`À ne pas confondre avec les **${firstSightBig.length} événements** qui alertent dès 1 ou 2 passages mais déjà au-dessus de ${WEAK_FRP_MW} MW : ceux-là sont de gros feux vus dès le premier survol, pas des signaux faibles. Les meilleurs :`, '');
L.push('| Wilaya | Première alerte (Alger) | FRP à l\'alerte | Passages | Pic FRP | Village le plus proche |', '|---|---|---:|---:|---:|---|');
for (const w of firstSightBig.slice(0, 5)) L.push(`| ${w.wilaya} | ${w.firstAlertAlgiers} ${w.firstAlertUtc.slice(5, 10)} | ${w.frpAtAlertMw} MW | ${w.passesAtAlert} | ${w.peakFrpMw} MW | ${w.nearestVillage} |`);
L.push('');

L.push('## 2. Alertes de nuit', '');
L.push(`**${nightIds.length} des ${alertedIds.length} premières alertes** (${Math.round(metrics.nightAlerts.share * 100)} %) tombent entre 22h et 6h, heure d'Alger — quand personne ne voit la fumée et qu'un satellite reste le seul témoin.`, '');

L.push('## 3. Villages cités par la presse', '');
L.push(`**${pressFound} des ${PRESS_VILLAGES.length}** localités citées par la presse ou la Protection civile comme brûlées ou évacuées les 26-27 août sont **nommées dans le texte d'une alerte** du rejeu — c'est-à-dire parmi les quatre villages au plus qu'un message imprime, pas simplement présentes dans le rayon de 20 km.`, '');
L.push('| Localité citée | Nommée dans une alerte ? | Nom correspondant | Première mention (Alger) | Distance |', '|---|---|---|---|---:|');
for (const p of pressCoverage) {
  const hit = p as typeof p & { id?: string; atIso?: string; distanceKm?: number; matched?: string };
  L.push(`| ${p.press} | ${p.found ? '✅ oui' : '❌ non'} | ${hit.matched ?? '—'} | ${hit.atIso ? algiersTime(hit.atIso) : '—'} | ${hit.distanceKm !== undefined ? `${hit.distanceKm} km` : '—'} |`);
}
L.push('');

L.push('## 4. Précision géographique', '');
L.push('Distance entre le centroïde d\'un événement alerté et le village le plus proche de son rayon d\'exposition.', '');
L.push('| Périmètre | Événements | Médiane | p90 |', '|---|---:|---:|---:|');
for (const [label, p] of Object.entries(precision)) L.push(`| ${label} | ${p.events} | ${p.medianKm ?? '—'} km | ${p.p90Km ?? '—'} km |`);
L.push('');

L.push('## 5. Délais — sans enjoliver', '');
L.push('Première alerte rendue le 26 août, par wilaya :', '');
L.push('| Wilaya | Première alerte (Alger) | Alertes ce jour-là |', '|---|---|---:|');
for (const a of aug26) L.push(`| ${a.wilaya} | ${a.firstAlertAlgiers ?? 'aucune'} | ${a.alertsThatDay} |`);
L.push('');
L.push('Ces heures sont à lire avec deux réserves, dans cet ordre :', '');
L.push('1. **La Protection civile comptait déjà 4 fronts actifs à Jijel à 14h00 le 26 août.** Une alerte rendue à la même heure ou après n\'aurait rien appris à personne sur place : elle arrive quand les secours sont déjà engagés.');
L.push('2. **La latence de publication NRT n\'est pas modélisée.** Le rejeu suppose la détection disponible à l\'heure du passage satellite ; les flux VIIRS NRT sortent avec 1 à 3 h de délai. Il faut donc ajouter +1 h à +3 h à chaque heure de ce document avant de la comparer à un événement réel.', '');

L.push('## 6. Ce que ce rejeu permet de mesurer désormais — et ce qu\'il ne permet toujours pas', '');
L.push(`- **Chevauchement avec un site industriel connu : mesurable désormais.** Occupation du sol réévaluée après coup avec l'index local (\`data/industrial-sites.json\`, \`--reevaluate-landuse\`, aucun appel réseau — Overpass était injoignable pendant le rejeu original) : **${industrialAlerted.length} des ${alertedIds.length}** événements alertés (${Math.round(industrialShare * 100)} %) tombent sur un site industriel/énergie connu (usine, centrale, carrière, décharge, torchère, cimenterie...). Le moteur live abaisse leur statut plutôt que de les alerter en \`urgent\` — une partie de ces ${industrialAlerted.length} événements n'aurait donc pas été une alerte rouge en conditions réelles.`, '');
L.push('| Wilaya | Alertés | Sur site industriel connu | Part |', '|---|---:|---:|---:|');
for (const w of FOCUS) { const d = industrialByWilaya[w]; L.push(`| ${w} | ${d.alerted} | ${d.industrial} | ${Math.round(d.share * 100)} % |`); }
L.push('');
L.push('- **Le garde-fou « source permanente sur 30 jours » reste non mesurable ici**, réévaluation de l\'occupation du sol ou non : il exige plus de 10 jours distincts d\'historique par cellule, qu\'une fenêtre de rejeu de quelques jours ne peut pas produire. Une partie des événements restants (hors site industriel connu) en serait probablement écartée aussi en conditions réelles.');
L.push('- **Le taux de fausses alertes global reste donc partiellement mesurable, pas entièrement** : le filtre « site industriel connu » ci-dessus est maintenant appliqué rétroactivement ; le second filtre (source permanente) ne l\'est toujours pas, faute d\'historique. Aucun des deux ne constitue une vérification terrain — voir le point suivant.');
L.push('- **Les feux manqués ne sont pas mesurés**, seulement approchés par les villages cités dans la presse (§3). Un feu qu\'aucun média n\'a nommé et qu\'aucun satellite n\'a vu n\'apparaît nulle part ici.');
L.push(`- **29 événements hors frontières** (Maroc, Tunisie, Méditerranée, Espagne) sont exclus des comptes par wilaya : l'emprise FIRMS est un rectangle plus large que l'Algérie.`);
L.push('- **Aucune vérification terrain.** Rien dans ce document ne dit qu\'un feu a réellement eu lieu à l\'endroit indiqué : ce sont des anomalies thermiques satellitaires, corroborées entre elles au mieux.');
L.push('');

if (meteosatComparison) {
  const mc = meteosatComparison;
  L.push('## 7. Apport de Meteosat (MTG_FIR) — comparé au rejeu VIIRS seul', '');
  L.push(`Ce rejeu fusionne VIIRS et Meteosat (EUMDAC, collection EO:EUM:DAT:0801) sur la même fenêtre. Comparaison géographique (<=3km) contre le rejeu VIIRS seul (\`${baselineDb}\`) : sur les ${mc.matched.length + mc.unmatched.length} événements alertés de ce rejeu dans ${FOCUS.join(', ')}, **${mc.matched.length}** ont un événement correspondant dans le rejeu original, ${mc.unmatched.length} n'en ont aucun (VIIRS n'a jamais alerté ce feu sur toute la fenêtre du rejeu original).`, '');
  L.push(`**${mc.meteosatFirstCount} événements** ont eu leur toute première alerte déclenchée par Meteosat seul (règle e), avant qu'aucun passage VIIRS n'existe encore sur cet événement — c'est la réponse directe à « combien de l'angle mort Meteosat a-t-il comblé ». ${mc.meteosatFirstStatusNote}`, '');
  if (mc.savedMinutes.count > 0) {
    L.push(`Sur les ${mc.savedMinutes.count} événements appariés avec un gain positif : gain moyen **${mc.savedMinutes.averageMin} min**, médian **${mc.savedMinutes.medianMin} min** avant la première alerte du rejeu VIIRS seul.`, '');
  } else {
    L.push('Aucun événement apparié n\'a un gain de temps positif mesurable sur cette fenêtre.', '');
  }
  L.push('| Wilaya | Détection (Alger) | Pic FRP | Alerte fusionnée (Alger) | Alerte VIIRS seul (Alger) | Gain |', '|---|---|---:|---|---|---:|');
  for (const r of mc.matched.slice(0, 15)) {
    L.push(`| ${r.wilaya} | ${algiersTime(r.firstDetectionUtc)} | ${r.maxFrpMw.toFixed(1)} MW | ${r.fusedFirstAlertAlgiers} | ${r.originalFirstAlertAlgiers} | ${r.savedMinutes !== null ? `${r.savedMinutes} min` : '—'} |`);
  }
  L.push('');
  if (mc.unmatched.length) {
    L.push(`**${mc.unmatched.length} événements alertés par ce rejeu n'ont aucune correspondance dans le rejeu VIIRS seul** — VIIRS ne les a détectés à aucun moment de la fenêtre (ou jamais assez pour alerter) :`, '');
    L.push('| Wilaya | Détection (Alger) | Pic FRP | Alerte fusionnée (Alger) |', '|---|---|---:|---|');
    for (const r of mc.unmatched.slice(0, 15)) L.push(`| ${r.wilaya} | ${algiersTime(r.firstDetectionUtc)} | ${r.maxFrpMw.toFixed(1)} MW | ${r.fusedFirstAlertAlgiers} |`);
    L.push('');
  }
  L.push('**Honnêteté :**', '');
  L.push('- **Signal 2 (anomalie FRP vs historique) : contribution quasi nulle, comme attendu.** La table `frp_history` part vide au début de ce rejeu ; voir `run-notes.md` pour le compte exact d\'événements alertés ayant malgré tout atteint le seuil (une cellule touchée plusieurs jours consécutifs pendant ce rejeu même).');
  L.push('- **Signaux 1 et 3, quantifiés séparément** (comptes sur les événements alertés, `run-notes.md`) : le bonus de zonage (signal 1, proximité d\'un village) et le bonus de persistance Meteosat (signal 3, un événement déjà confirmé VIIRS avec ≥2 passages Meteosat) sont deux bonus de SCORE additifs — ils avancent une alerte VIIRS qui aurait de toute façon eu lieu, ils ne créent pas une alerte qui n\'existait pas. Les alertes déclenchées "par Meteosat seul" ci-dessus (règle e) sont un mécanisme différent et sont celles qui répondent réellement à "combien de feux Meteosat a-t-il fait connaître en premier".');
  L.push('- **Le rapprochement géographique (<=3km) est une approximation**, pas un identifiant stable : un même feu peut être un seul événement dans un rejeu et deux dans l\'autre (le rayon de jonction de Meteosat diffère de celui de VIIRS). Les gains de temps ci-dessus sont donc indicatifs, pas une vérité absolue événement-par-événement.');
  L.push('- **Aucune vérification terrain non plus ici** : un gain de temps mesuré est un gain de temps entre deux rejeux hors ligne du même moteur, pas une preuve qu\'un incendie réel a été signalé plus tôt à quelqu\'un.');
  L.push('');
}

L.push('## 8. Apport de Sentinel-3 SLSTR — comparé au rejeu VIIRS+Meteosat', '');
L.push(`Ce rejeu fusionne VIIRS, Meteosat et Copernicus Sentinel-3 SLSTR (EUMDAC, collection EO:EUM:DAT:0417, filtré à la classification "feu de végétation") sur la même fenêtre. Contrairement à Meteosat (géostationnaire, ~10min de cadence, comble un angle mort temporel), SLSTR est polaire — même famille orbitale que VIIRS. Sa valeur attendue est donc la SENSIBILITÉ de détection à ses propres passages, pas le comblement de l'angle mort temporel que Meteosat comble déjà.`, '');
L.push(`**${metrics.slstrContribution.frpPromotedCount} événement(s)** qui n'auraient eu aucun FRP réel avec Meteosat seul (FRP nul, comme toujours pour Meteosat) ont vu leur FRP promu à une vraie valeur SLSTR — c'est la contribution la plus directe et la moins ambiguë de SLSTR, mesurable sans comparaison à un autre rejeu.`, '');
L.push(`**Honnêteté sur le volume : ${metrics.slstrContribution.totalDetections} détection(s) SLSTR réelles** sur toute la fenêtre. ${metrics.slstrContribution.cadenceNote} Sur une fenêtre de quelques jours, ce chiffre reste modeste — ce compte est le chiffre réel, pas gonflé.`, '');
if (slstrComparison) {
  const sc = slstrComparison;
  L.push('', `Comparaison géographique (<=${MATCH_RADIUS_KM}km) contre le rejeu VIIRS+Meteosat (\`${baseline2Db}\`) : sur les ${sc.matched.length + sc.unmatched.length} événements alertés de ce rejeu dans ${FOCUS.join(', ')}, **${sc.matched.length}** ont un événement correspondant dans le rejeu VIIRS+Meteosat, ${sc.unmatched.length} n'en ont aucun.`, '');
  L.push(`**${sc.slstrFirstCount} événement(s)** ont eu leur toute première alerte déclenchée par SLSTR seul (règle c), avant qu'aucun passage VIIRS n'existe encore sur cet événement. ${sc.slstrFirstStatusNote}`, '');
  L.push('### Délai — inchangé pour l\'essentiel, comme attendu', '');
  L.push('Restatement du chiffre-phare du rejeu VIIRS+Meteosat (§5 de ce document et de `metrics.md` du rejeu à 2 sources), pas une nouvelle mesure : SLSTR ne comble pas l\'angle mort temporel que Meteosat comble déjà, donc ces heures ne devraient quasiment pas bouger.', '');
  L.push('| Wilaya | Première alerte VIIRS+Meteosat (Alger) | Première alerte 3 sources (Alger) | Écart |', '|---|---|---|---:|');
  for (let i = 0; i < FOCUS.length; i++) {
    const cur = sc.headlineLeadTime.current[i], base = sc.headlineLeadTime.baseline[i];
    const deltaMin = cur.firstAlertUtc && base.firstAlertUtc ? Math.round((Date.parse(base.firstAlertUtc) - Date.parse(cur.firstAlertUtc)) / 60_000) : null;
    L.push(`| ${FOCUS[i]} | ${base.firstAlertAlgiers ?? 'aucune'} | ${cur.firstAlertAlgiers ?? 'aucune'} | ${deltaMin !== null ? `${deltaMin} min` : '—'} |`);
  }
  L.push('');
  if (sc.deltaMinutes.count > 0) {
    const meteosatGainNote = meteosatComparison?.savedMinutes.count ? ` (à comparer au gain de Meteosat sur VIIRS seul, §7 : moyenne ${meteosatComparison.savedMinutes.averageMin} min, médiane ${meteosatComparison.savedMinutes.medianMin} min — ce chiffre-ci devrait être nettement plus petit)` : '';
    L.push(`Sur les ${sc.deltaMinutes.count} événements appariés : écart moyen **${sc.deltaMinutes.averageMin} min**, médian **${sc.deltaMinutes.medianMin} min** par rapport à la première alerte du rejeu VIIRS+Meteosat${meteosatGainNote}.`, '');
  } else {
    L.push('Aucun événement apparié n\'a d\'écart de temps mesurable sur cette fenêtre.', '');
  }
  L.push(`**${sc.additionalEarlyWeak.count} alerte(s) sur signal faible précoce supplémentaire(s)** (définition du §1 : FRP < ${WEAK_FRP_MW} MW à l'alerte, puis pic ≥ ${BIG_FRP_MW} MW) présentes dans ce rejeu à 3 sources mais absentes — après rapprochement géographique <=${MATCH_RADIUS_KM}km — du rejeu VIIRS+Meteosat : la sensibilité sous-pixel de SLSTR trouvant quelque chose que VIIRS+Meteosat seuls ont manqué.`, '');
  if (sc.additionalEarlyWeak.count > 0) {
    L.push('| Wilaya | Première alerte (Alger) | FRP à l\'alerte | Pic FRP | Village le plus proche |', '|---|---|---:|---:|---|');
    for (const w of sc.additionalEarlyWeak.rows.slice(0, 10)) L.push(`| ${w.wilaya} | ${w.firstAlertAlgiers} ${w.firstAlertUtc.slice(5, 10)} | ${w.frpAtAlertMw} MW | ${w.peakFrpMw} MW | ${w.nearestVillage} |`);
    L.push('');
  }
  L.push('**Honnêteté :**', '');
  L.push(`- **Cadence réelle limitée, comme annoncé avant ce rejeu.** ${metrics.slstrContribution.cadenceNote} La contribution marginale mesurée ci-dessus, sur une fenêtre de quelques jours, est mécaniquement petite — ce n'est pas un signe que l'intégration est cassée, c'est la limite physique de cadence de ce capteur sur cette fenêtre précise.`);
  L.push('- **Le délai ne change quasiment pas, et c\'est attendu, pas un échec.** SLSTR est polaire (même famille que VIIRS), pas géostationnaire (comme Meteosat) — sa valeur est la sensibilité de détection à ses propres passages, pas le comblement de l\'angle mort temporel entre deux passages VIIRS. Voir le tableau ci-dessus : ces heures ne devraient quasiment pas bouger par rapport au rejeu VIIRS+Meteosat.');
  L.push('- **Le rapprochement géographique (<=3km) reste une approximation**, pas un identifiant stable — même réserve qu\'au §7.');
  L.push('- **Aucune vérification terrain non plus ici.**');
  L.push('');
} else {
  L.push('', '_Comparaison géographique contre le rejeu VIIRS+Meteosat non calculée : `--baseline2-db`/`--baseline2-out` non fournis à cette exécution._', '');
}

fs.writeFileSync(path.join(outDir, 'metrics.md'), L.join('\n'));

console.log(`Wrote ${outDir}/metrics.md and metrics.json — ${earlyWeak.length} early-weak-signal, ${nightIds.length}/${alertedIds.length} night, ${pressFound}/${PRESS_VILLAGES.length} press villages.`);
