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

// Replay CLI — dry-run of the real pipeline over past FIRMS dates.
//
//   npm run replay -- --from 2026-08-25 --to 2026-08-29 --db data/replay-20260826.db --out replay-out/20260826
//   npm run replay -- 2026-08-26                  (single day, defaults elsewhere)
//
// Sends nothing: alerts are rendered with the real telegramText() and written
// to messages/*.txt. Writes only to --db (never data/signals.db — lib/replay.ts
// refuses) and --out. See lib/replay.test.ts for both guarantees.
import fs from 'node:fs';
import path from 'node:path';
import { bearingDeg } from '../lib/geo';
import { displayName } from '../lib/place-name';
import { preferIpv4 } from '../lib/prefer-ipv4';
// Type-only: erased at compile time, so it does not load lib/fire-monitor (and
// with it lib/database) before ALGERIE_FEUX_DB_PATH is set below.
import type { FireEvent } from '../lib/fire-monitor';
import { cardinalFr } from '../lib/wind';

function loadEnvLocal() {
  const p = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
loadEnvLocal();
preferIpv4();

const FOCUS_WILAYAS = ['Jijel', 'Béjaïa', 'Tizi Ouzou'];
const OUT_OF_BOUNDS = 'Hors frontières / en mer';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const positionalDate = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
const from = arg('from', positionalDate ?? '2026-08-26')!;
const to = arg('to', positionalDate ?? from)!;
const dbPath = arg('db', `data/replay-${from.replace(/-/g, '')}.db`)!;
const outDir = arg('out', `replay-out/${from.replace(/-/g, '')}`)!;
const box = arg('box');
const delayMs = Number(arg('delay', '1200'));
// Rebuilds report.md from an existing events.json without re-fetching anything
// — the report layout is the part most likely to need another pass.
const renderOnly = process.argv.includes('--render-only');
// Re-evaluates land-use for every stored event against the CURRENT
// lookupLandUse() (the local index, once data/industrial-sites.json exists)
// without re-fetching FIRMS or weather — for a replay run that predates the
// index (Overpass was unreachable at the time, so every event was left
// 'unknown' or unevaluated). Updates the replay DB, events.json, then
// re-renders report.md/messages/ exactly like --render-only.
const reevaluateLandUse = process.argv.includes('--reevaluate-landuse');

// Must be set before lib/database resolves its backend — hence the dynamic
// imports below rather than top-level ones.
process.env.ALGERIE_FEUX_DB_PATH = path.resolve(dbPath);

// A replay must start from an empty history, or a re-run would cluster into
// the previous run's leftovers and quietly change the result. --render-only
// and --reevaluate-landuse both read/update the stored events instead of
// replaying, so they must keep the database.
for (const suffix of (renderOnly || reevaluateLandUse) ? [] : ['', '-wal', '-shm', '-journal']) {
  const f = path.resolve(dbPath) + suffix;
  if (fs.existsSync(f)) fs.rmSync(f);
}
fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
fs.mkdirSync(path.join(outDir, 'messages'), { recursive: true });

const { runReplay, CRON_INTERVAL_MIN } = await import('../lib/replay');
const { algiersTime, confidenceLabel, distinctPasses, eventWilaya, lowerStatus, DEFAULT_PROXIMITY_KM } = await import('../lib/fire-monitor');
const { satelliteName } = await import('../lib/satellite-names');
const { getConfig, eventsBetween, saveSignal } = await import('../lib/database');

const mapKey = process.env.FIRMS_MAP_KEY;
if (!mapKey) {
  console.error('FIRMS_MAP_KEY missing. Add it to .env.local (see .env.example) before running the replay.');
  process.exit(1);
}

type EventOut = {
  id: string; wilaya: string | null; wilayaLabel: string;
  latitude: number; longitude: number;
  firstDetectionUtc: string; firstDetectionAlgiers: string;
  lastDetectionUtc: string; lastDetectionAlgiers: string;
  passes: PassRecord[]; passCount: number; maxPixelsInSinglePass: number;
  maxFrpMw: number; maxConfidence: string; score: number; status: FireEvent['status'];
  villagesEvaluated: boolean;
  nearbyVillages: { name: string; rawName?: string; nameAr: string | null; wilaya: string; distanceKm: number }[];
  downwindVillages: { name: string; rawName?: string; nameAr: string | null; wilaya: string; distanceKm: number; bearingFromFireDeg: number; bearingFromFireCardinal: string; relation: string }[];
  windUsed: { api: string; hourUtc: string; speedKph: number; directionFromDeg: number; directionFromCardinal: string; blowsTowardCardinal: string } | null;
  landUse: { context: string; siteName?: string };
  wouldHaveAlerted: boolean;
};

type PassRecord = { satellite: string; satelliteRaw: string; instrument: string; acquiredAtUtc: string; acquiredAtAlgiers: string; pixels: number; maxFrp: number; confidence: string; confidenceLabel: string };

// Per satellite overpass: how many pixels it saw, its strongest FRP and its
// best confidence. distinctPasses() defines what counts as one pass; this only
// aggregates the detections behind each of them.
function passRecords(event: FireEvent): PassRecord[] {
  return distinctPasses(event).map(p => {
    const inPass = event.detections.filter(d => d.satellite === p.satellite && d.acquiredAt === p.acquiredAt);
    const best = inPass.reduce((a, b) => (b.confidence === 'h' ? b : a), inPass[0]);
    return {
      satellite: satelliteName(p.satellite), satelliteRaw: p.satellite, instrument: p.instrument,
      acquiredAtUtc: p.acquiredAt, acquiredAtAlgiers: algiersTime(p.acquiredAt),
      pixels: inPass.length, maxFrp: Math.max(...inPass.map(d => d.frp)),
      confidence: best.confidence, confidenceLabel: confidenceLabel(best.confidence),
    };
  });
}

function windUsed(event: FireEvent) {
  if (event.windKph === undefined || event.windDirectionFromDeg === undefined) return null;
  // enrichWeatherHistorical picks the archived hour of the last pass.
  return {
    api: 'archive-api.open-meteo.com/v1/archive',
    hourUtc: `${event.lastAcquiredAt.slice(0, 13)}:00Z`,
    speedKph: event.windKph,
    directionFromDeg: event.windDirectionFromDeg,
    directionFromCardinal: cardinalFr(event.windDirectionFromDeg),
    blowsTowardCardinal: cardinalFr(event.windDirectionFromDeg + 180),
  };
}

// Set from the region config once the replay database is readable — both
// paths below assign it before anything renders.
let proximityKm = DEFAULT_PROXIMITY_KM;

// Rewrites ONLY the village names on a rendered message's "⚠️ <name> <d>km"
// lines, through the current naming rule. Everything else — the FRP, pass
// count and wind that message was rendered with at its poll — is left byte for
// byte as it was, because that is the evidence; the names are presentation.
function renameMessageVillages(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  const index = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'villages.json'), 'utf8')) as { name: string; name_ar: string | null }[];
  const byRawName = new Map(index.map(v => [v.name, v] as const));
  let changed = 0;
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.txt'))) {
    const full = path.join(dir, file);
    const before = fs.readFileSync(full, 'utf8');
    const after = before.replace(/^⚠️ (.+?) (\d+\.\d+)km /gmu, (_match, token: string, distance: string) => {
      // The old form was biText(name, name_ar): "Latin/<RLI>arabe<PDI>".
      const raw = token.replace(/[\u2066-\u2069]/gu, '').split('/')[0].trim();
      const village = byRawName.get(raw) ?? byRawName.get(token.trim());
      const shown = village ? displayName(village) : displayName({ name: raw, name_ar: null });
      return `⚠️ ${shown} ${distance}km `;
    });
    if (after !== before) { fs.writeFileSync(full, after); changed++; }
  }
  return changed;
}

type RunMeta = {
  box: string; days: string[]; detectionsPerDay: Record<string, number>; landUseCircuitOpen?: boolean;
  /** Set once --reevaluate-landuse has re-scored every event with the local
   *  index — flips the report's caveat from "Overpass was unreachable" to
   *  "measured with the local index" (the 30-day persistent-source guard
   *  caveat is unaffected and always stays). */
  landUseReevaluatedWithLocalIndex?: boolean;
};
const eventsPath = path.join(outDir, 'events.json');
const metaPath = path.join(outDir, 'run-meta.json');

// --render-only rebuilds report.md from the last run's events.json: the report
// layout gets iterated on far more often than the data behind it, and a re-run
// would re-fetch five days of FIRMS to produce identical events.
if (renderOnly) {
  if (!fs.existsSync(eventsPath)) { console.error(`--render-only needs an existing ${eventsPath}`); process.exit(1); }
  proximityKm = (await getConfig()).proximityKm;
  const eventsOut = JSON.parse(fs.readFileSync(eventsPath, 'utf8')) as EventOut[];
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as RunMeta;
  fs.writeFileSync(path.join(outDir, 'report.md'), renderReport(eventsOut, meta));
  const renamed = renameMessageVillages(path.join(outDir, 'messages'));
  console.log(`Re-rendered ${outDir}/report.md from ${eventsOut.length} stored event(s); renamed villages in ${renamed} message file(s).`);
  process.exit(0);
}

// --reevaluate-landuse: the original run at this dbPath predates
// data/industrial-sites.json (Overpass was unreachable, so every event was
// left 'unknown' or unevaluated). Re-scores every stored event with the
// CURRENT lookupLandUse() — the local index, no network — updates the
// replay DB and events.json, then re-renders exactly like --render-only.
// No FIRMS or weather calls: detections/passes/wind are untouched.
if (reevaluateLandUse) {
  if (!fs.existsSync(eventsPath)) { console.error(`--reevaluate-landuse needs an existing ${eventsPath}`); process.exit(1); }
  const { lookupLandUse } = await import('../lib/landuse');
  proximityKm = (await getConfig()).proximityKm;

  const eventsOut = JSON.parse(fs.readFileSync(eventsPath, 'utf8')) as EventOut[];
  const stored = await eventsBetween('2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z', 100_000);
  const storedById = new Map(stored.map(e => [e.id, e] as const));

  let industrial = 0, natural = 0, unknown = 0;
  for (const out of eventsOut) {
    const landUse = await lookupLandUse(out.latitude, out.longitude);
    out.landUse = landUse;
    const full = storedById.get(out.id);
    if (full) {
      const updated = landUse.context === 'industrial'
        ? { ...full, landUse, status: lowerStatus(full.status) }
        : { ...full, landUse };
      await saveSignal(updated);
      out.status = updated.status;
    }
    if (landUse.context === 'industrial') industrial++;
    else if (landUse.context === 'natural') natural++;
    else unknown++;
  }

  fs.writeFileSync(eventsPath, JSON.stringify(eventsOut, null, 2) + '\n');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as RunMeta;
  meta.landUseReevaluatedWithLocalIndex = true;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');

  fs.writeFileSync(path.join(outDir, 'report.md'), renderReport(eventsOut, meta));
  const renamed = renameMessageVillages(path.join(outDir, 'messages'));

  const notesPath = path.join(outDir, 'run-notes.md');
  if (fs.existsSync(notesPath)) {
    fs.appendFileSync(notesPath, [
      '',
      `## Occupation du sol — réévaluation post-hoc (${new Date().toISOString()})`,
      '',
      `Overpass était injoignable pendant le rejeu original (voir plus haut). Réévalué depuis avec l'index local (\`data/industrial-sites.json\`, construit une fois par \`scripts/build-industrial-index.ts\`, sans appel réseau) : **${industrial} événement(s) industriel(s)**, ${natural} naturel(s), ${unknown} encore indéterminé(s) sur ${eventsOut.length}.`,
      `Le garde-fou « source permanente sur 30 jours » (point 5 plus haut) reste non appliqué : cette réévaluation ne change que le marquage par site industriel connu, pas les autres filtres.`,
      '',
    ].join('\n'));
  }

  console.log(`Re-evaluated land-use for ${eventsOut.length} event(s) with the local index: ${industrial} industrial, ${natural} natural, ${unknown} unknown.`);
  console.log(`Re-rendered ${outDir}/report.md; renamed villages in ${renamed} message file(s).`);
  process.exit(0);
}

console.log(`Replay ${from} → ${to} · db ${dbPath} · out ${outDir}`);
const started = new Date();
const result = await runReplay({
  from, to, mapKey, box, landUseDelayMs: delayMs,
  log: msg => console.log(msg),
});
const finished = new Date();
// After runReplay, which is what creates the schema in the fresh replay DB.
proximityKm = (await getConfig()).proximityKm;

// ---------- a) events.json ----------
const eventsOut: EventOut[] = result.events
  .slice()
  .sort((a, b) => a.firstAcquiredAt.localeCompare(b.firstAcquiredAt))
  .map(event => {
    const wilaya = eventWilaya(event);
    const all = event.villages ?? [];
    const passes = passRecords(event);
    return {
      id: event.id,
      wilaya: wilaya ?? null,
      wilayaLabel: wilaya ?? OUT_OF_BOUNDS,
      latitude: event.latitude, longitude: event.longitude,
      firstDetectionUtc: event.firstAcquiredAt,
      firstDetectionAlgiers: algiersTime(event.firstAcquiredAt),
      lastDetectionUtc: event.lastAcquiredAt,
      lastDetectionAlgiers: algiersTime(event.lastAcquiredAt),
      passes,
      passCount: event.passCount,
      maxPixelsInSinglePass: event.maxPixelsInSinglePass,
      maxFrpMw: event.maxFrp,
      maxConfidence: event.maxConfidence,
      score: event.score,
      status: event.status,
      // villages are only computed once wind is known (score >= 55 gate), so
      // null here means "not evaluated", not "none nearby".
      villagesEvaluated: event.villages !== undefined,
      nearbyVillages: all.filter(v => v.distanceKm <= proximityKm).map(v => ({ name: displayName(v), rawName: v.name, nameAr: v.name_ar, wilaya: v.wilaya, distanceKm: Number(v.distanceKm.toFixed(2)) })),
      downwindVillages: all.filter(v => v.relation !== 'upwind' && v.distanceKm > proximityKm).map(v => ({
        name: displayName(v), rawName: v.name, nameAr: v.name_ar, wilaya: v.wilaya,
        distanceKm: Number(v.distanceKm.toFixed(2)),
        bearingFromFireDeg: Number(bearingDeg(event.latitude, event.longitude, v.lat, v.lon).toFixed(1)),
        bearingFromFireCardinal: cardinalFr(bearingDeg(event.latitude, event.longitude, v.lat, v.lon)),
        relation: v.relation,
      })),
      windUsed: windUsed(event),
      landUse: event.landUse ?? { context: 'not-evaluated' },
      wouldHaveAlerted: result.alerts.some(a => a.eventId === event.id),
    };
  });
fs.writeFileSync(eventsPath, JSON.stringify(eventsOut, null, 2) + '\n');
fs.writeFileSync(metaPath, JSON.stringify({ box: result.box, days: result.days, detectionsPerDay: result.detectionsPerDay, landUseCircuitOpen: result.landUseCircuitOpen }, null, 2) + '\n');

// ---------- c) messages/ ----------
const firstAlertPerEvent = new Map<string, typeof result.alerts[number]>();
for (const a of result.alerts) if (!firstAlertPerEvent.has(a.eventId)) firstAlertPerEvent.set(a.eventId, a);
const focusAlerts = [...firstAlertPerEvent.values()]
  .map(a => ({ alert: a, event: eventsOut.find(e => e.id === a.eventId)! }))
  .filter(x => x.event && FOCUS_WILAYAS.includes(x.event.wilaya ?? ''))
  .sort((a, b) => b.event.maxFrpMw - a.event.maxFrpMw)
  .slice(0, 5);

focusAlerts.forEach((x, i) => {
  const name = `${String(i + 1).padStart(2, '0')}-${(x.event.wilaya ?? 'inconnue').replace(/\s+/g, '-')}-frp${Math.round(x.event.maxFrpMw)}.txt`;
  const header = [
    `# NON ENVOYÉ — rendu par replay (${new Date().toISOString().slice(0, 10)})`,
    `# événement ${x.event.id}`,
    `# première détection ${x.event.firstDetectionAlgiers} (Alger) / ${x.event.firstDetectionUtc}`,
    `# message rendu tel qu'il serait parti au passage du cron de ${x.alert.renderedAtIso} —`,
    `#   la première exécution (cadence ${CRON_INTERVAL_MIN} min) ayant vu assez de preuves pour alerter`,
    `# à cet instant : FRP max ${x.alert.maxFrp.toFixed(1)} MW, score ${x.alert.score}, statut ${x.alert.status}`,
    '', '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'messages', name), header + x.alert.text + '\n');
});

// ---------- b) report.md ----------

// events.json written before the French/Latin naming rule existed stores the
// raw OSM name; resolving it here means --render-only fixes an old report
// instead of requiring a full re-fetch.
function shownName(v: { name: string; rawName?: string; nameAr: string | null }): string {
  return displayName({ name: v.rawName ?? v.name, name_ar: v.nameAr });
}

function nearestVillage(e: EventOut): string {
  if (!e.villagesEvaluated) return '—';
  const all = [...e.nearbyVillages, ...e.downwindVillages].sort((a, b) => a.distanceKm - b.distanceKm);
  return all.length ? `${shownName(all[0])} (${all[0].distanceKm} km)` : 'aucun < 20 km';
}

function compactRows(evs: EventOut[]): string[] {
  const rows = ['| Première détection (Alger) | Position | FRP max | Passages | Statut | Village le plus proche |', '|---|---|---:|---:|---|---|'];
  for (const e of evs) {
    rows.push(`| ${e.firstDetectionAlgiers} ${e.firstDetectionUtc.slice(5, 10)} | ${e.latitude.toFixed(3)}, ${e.longitude.toFixed(3)} | ${e.maxFrpMw.toFixed(1)} | ${e.passCount} | ${e.status}${e.wouldHaveAlerted ? ' ⚠️' : ''} | ${nearestVillage(e)} |`);
  }
  return rows;
}

function detailBlock(e: EventOut, landUseReevaluated: boolean): string[] {
  const out: string[] = [];
  out.push(`#### ${e.id}`, '');
  out.push(`- **Première détection** : ${e.firstDetectionAlgiers} (Alger) — ${e.firstDetectionUtc}`);
  out.push(`- Position : ${e.latitude.toFixed(4)}, ${e.longitude.toFixed(4)} · FRP max **${e.maxFrpMw.toFixed(1)} MW** · statut \`${e.status}\` · score ${e.score}${e.wouldHaveAlerted ? ' · **aurait déclenché une alerte**' : ' · sous le seuil d\'alerte'}`);
  out.push(`- Passages (${e.passCount}, ${e.passes.reduce((n, p) => n + p.pixels, 0)} pixel(s) au total) :`);
  for (const p of e.passes) out.push(`  - ${p.acquiredAtAlgiers} (Alger) — ${p.satellite} (${p.instrument}), ${p.pixels} pixel(s), FRP max ${p.maxFrp.toFixed(1)} MW, confiance ${p.confidenceLabel}`);
  if (!e.villagesEvaluated) {
    out.push(`- Villages : **non évalués** (score < 55 : pas d\'enrichissement météo, donc pas de calcul d\'exposition — ce n\'est pas « aucun village »)`);
  } else {
    out.push(`- Villages à moins de ${proximityKm} km : ${e.nearbyVillages.length ? e.nearbyVillages.map(v => `**${shownName(v)}** (${v.distanceKm} km)`).join(', ') : 'aucun'}`);
    out.push(`- Villages sous le vent : ${e.downwindVillages.length ? e.downwindVillages.slice(0, 8).map(v => `${shownName(v)} (${v.distanceKm} km, ${v.bearingFromFireCardinal})`).join(', ') : 'aucun'}${e.downwindVillages.length > 8 ? ` … +${e.downwindVillages.length - 8}` : ''}`);
    if (e.windUsed) out.push(`  - Vent utilisé : ${e.windUsed.speedKph} km/h venant du ${e.windUsed.directionFromCardinal} (${e.windUsed.directionFromDeg}°), soufflant vers le ${e.windUsed.blowsTowardCardinal} — archive Open-Meteo à ${e.windUsed.hourUtc}`);
  }
  const lu = e.landUse as { context: string; siteName?: string };
  const notDetermined = lu.context === 'unknown' || lu.context === 'not-evaluated';
  const landUseLabel = notDetermined
    ? (landUseReevaluated ? 'non déterminée (aucun site connu dans l\'index local à proximité)' : 'non déterminée — Overpass injoignable pendant le rejeu (voir run-notes.md)')
    : lu.context;
  out.push(`- Occupation du sol : ${landUseLabel}${lu.siteName ? ` — ${lu.siteName}` : ''}`);
  out.push('');
  return out;
}

function renderReport(eventsOut: EventOut[], meta: RunMeta): string {
  const byWilaya = new Map<string, EventOut[]>();
  for (const e of eventsOut) {
    const key = e.wilaya ?? OUT_OF_BOUNDS;
    if (!byWilaya.has(key)) byWilaya.set(key, []);
    byWilaya.get(key)!.push(e);
  }
  const others = [...byWilaya.keys()].filter(w => !FOCUS_WILAYAS.includes(w) && w !== OUT_OF_BOUNDS)
    .sort((a, b) => byWilaya.get(b)!.length - byWilaya.get(a)!.length);
  const ordered = [...FOCUS_WILAYAS.filter(w => byWilaya.has(w)), ...others, ...(byWilaya.has(OUT_OF_BOUNDS) ? [OUT_OF_BOUNDS] : [])];

  const alerted = eventsOut.filter(e => e.wouldHaveAlerted).length;
  const lines: string[] = [];
  lines.push(`# Replay OzarEye — incendies du 26 août 2026 (Kabylie / Est algérien)`, '');
  lines.push(`Rejeu à sec du moteur réel (mêmes modules que la production) sur les archives NASA FIRMS du **${from} au ${to}**, jour par jour dans l\'ordre chronologique.`, '');
  lines.push(`> **Aucun message n\'a été envoyé.** Les textes Telegram reproduits dans \`messages/\` sont des rendus hors ligne, jamais transmis. Le rejeu écrit dans sa propre base (\`${dbPath}\`) et n\'ouvre jamais la base de production.`, '');
  const landUseCaveat = meta.landUseReevaluatedWithLocalIndex
    ? '' // measured post-hoc with the local index (data/industrial-sites.json) — see run-notes.md
    : (meta.landUseCircuitOpen ? ' ; Overpass (occupation du sol) était injoignable pendant le run, donc aucun site industriel n\'a pu être identifié' : '');
  const guardsClause = meta.landUseReevaluatedWithLocalIndex
    ? 'Ce filtre aurait'
    : (meta.landUseCircuitOpen ? 'Ces deux filtres auraient' : 'Ce filtre aurait');
  lines.push(`> **Ce que ce rejeu ne prouve pas.** Le garde-fou « source permanente sur 30 jours » n\'a pas d\'historique ici et n\'a donc rien filtré${landUseCaveat}. ${guardsClause} réduit le nombre d\'alertes en conditions réelles. La latence de publication des flux NRT (1 à 3 h) n\'est pas modélisée : les heures ci-dessous sont un plancher optimiste. Voir \`run-notes.md\`.`, '');
  if (meta.landUseReevaluatedWithLocalIndex) {
    lines.push('> **Occupation du sol : réévaluée après coup.** Overpass était injoignable pendant le rejeu original ; la colonne « tag industriel » ci-dessous a été recalculée depuis avec l\'index local (`data/industrial-sites.json`, aucun appel réseau) — voir `run-notes.md`. Le garde-fou « source permanente sur 30 jours », lui, reste non appliqué.', '');
  }
  lines.push('## Chiffres', '');
  lines.push(`| | |`, `|---|---:|`);
  lines.push(`| Détections brutes FIRMS | ${Object.values(meta.detectionsPerDay).reduce((a, b) => a + b, 0)} |`);
  lines.push(`| Événements après regroupement | ${eventsOut.length} |`);
  lines.push(`| Événements qui auraient déclenché une alerte | ${alerted} |`);
  lines.push(`| Événements avec ≥2 passages satellites | ${eventsOut.filter(e => e.passCount >= 2).length} |`);
  lines.push(`| Événements avec exposition villages calculée | ${eventsOut.filter(e => e.villagesEvaluated).length} |`);
  lines.push(`| Emprise | \`${meta.box}\` |`);
  lines.push('');
  lines.push(`Premières détections par jour : ${Object.entries(eventsOut.reduce<Record<string, number>>((acc, e) => { const d = e.firstDetectionUtc.slice(0, 10); acc[d] = (acc[d] ?? 0) + 1; return acc; }, {})).sort().map(([d, n]) => `${d} : ${n}`).join(' · ')}`, '');

  for (const wilaya of ordered) {
    const evs = byWilaya.get(wilaya)!.slice().sort((a, b) => b.maxFrpMw - a.maxFrpMw);
    const focus = FOCUS_WILAYAS.includes(wilaya);
    lines.push(`## ${wilaya} — ${evs.length} événement(s), ${evs.filter(e => e.wouldHaveAlerted).length} avec alerte`, '');
    lines.push(...compactRows(evs), '');
    if (focus) {
      lines.push(`### Détail — les ${Math.min(8, evs.length)} plus intenses`, '');
      for (const e of evs.slice(0, 8)) lines.push(...detailBlock(e, Boolean(meta.landUseReevaluatedWithLocalIndex)));
    }
  }

  lines.push('## Synthèse', '');
  lines.push('| Wilaya | Événements | ≥2 passages | Tag industriel | Hors frontières |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const wilaya of ordered) {
    const evs = byWilaya.get(wilaya)!;
    lines.push(`| ${wilaya} | ${evs.length} | ${evs.filter(e => e.passCount >= 2).length} | ${evs.filter(e => (e.landUse as { context: string }).context === 'industrial').length} | ${wilaya === OUT_OF_BOUNDS ? evs.length : 0} |`);
  }
  lines.push(`| **Total** | **${eventsOut.length}** | **${eventsOut.filter(e => e.passCount >= 2).length}** | **${eventsOut.filter(e => (e.landUse as { context: string }).context === 'industrial').length}** | **${eventsOut.filter(e => e.wilaya === null).length}** |`);
  lines.push('');
  lines.push(meta.landUseReevaluatedWithLocalIndex
    ? `_Colonne « tag industriel » recalculée après coup avec l\'index local (data/industrial-sites.json), sans appel réseau — voir run-notes.md._`
    : `_Colonne « tag industriel » à 0 par indisponibilité d\'Overpass pendant ce rejeu, pas par absence de sites industriels — voir run-notes.md._`, '');
  return lines.join('\n');
}

fs.writeFileSync(path.join(outDir, 'report.md'), renderReport(eventsOut, { box: result.box, days: result.days, detectionsPerDay: result.detectionsPerDay, landUseCircuitOpen: result.landUseCircuitOpen }));

// ---------- d) run-notes.md ----------
const failedSources = result.sources.filter(s => s.rows === 'FAILED');
const notes: string[] = [];
notes.push('# Run notes — replay', '');
notes.push(`- Exécuté le ${started.toISOString()} → ${finished.toISOString()} (${Math.round((finished.getTime() - started.getTime()) / 1000)}s)`);
notes.push(`- Jours rejoués (ordre chronologique) : ${result.days.join(', ')}`);
notes.push(`- Emprise : \`${result.box}\` (bbox de la configuration, identique au live)`);
notes.push(`- Base de données : \`${dbPath}\` — créée vide au début du run. La base de production \`data/signals.db\` n'est jamais ouverte (lib/replay.ts refuse de démarrer si le chemin pointe dessus).`);
notes.push('');
notes.push('## Sources FIRMS', '');
notes.push('| Jour | Source | Lignes |');
notes.push('|---|---|---:|');
for (const s of result.sources) notes.push(`| ${s.day} | ${s.source} | ${s.rows}${s.error ? ` (${s.error.slice(0, 80)})` : ''} |`);
notes.push('');
notes.push('## Différences avec le fonctionnement en direct', '');
notes.push('1. **Vent : API archive, pas prévision.** Le live appelle `api.open-meteo.com/v1/forecast` (conditions courantes) ; le replay appelle `archive-api.open-meteo.com/v1/archive` et prend l\'heure archivée du passage satellite. Les villages sous le vent sont donc calculés avec le vent de l\'heure du passage.');
notes.push(`2. **Cadence simulée.** Chaque journée est rejouée en tranches de ${CRON_INTERVAL_MIN} minutes — la cadence du cron en production — et non en un seul lot : un événement n'est scoré, alerté et rendu qu'avec les passages disponibles à cet instant. L'heure en tête de chaque message est donc l'heure à laquelle il serait réellement parti.`);
notes.push(`3. **Latence de publication NRT non modélisée.** Le rejeu suppose qu'une détection est disponible à l'heure du passage satellite. En réalité les flux VIIRS NRT sont publiés avec un délai (typiquement 1 à 3 h) : **les heures d'alerte de ce rapport sont un plancher optimiste, pas une promesse**. Les archives FIRMS ne contiennent pas d'horodatage de publication permettant de le corriger.`);
notes.push(`4. **Contexte de regroupement.** Le live utilise \`activeEvents(24)\` (24 h avant *maintenant*) ; en replay cela ne renverrait rien pour août, donc le contexte est ancré sur le passage simulé (J-24 h → heure du passage).`);
notes.push('5. **Garde-fou « source permanente » (30 jours) non appliqué.** Il exige plus de 10 jours distincts d\'historique par cellule ; une fenêtre de replay de quelques jours ne peut pas en produire. Il n\'a donc rien supprimé, et surtout : **les torchères, cimenteries et autres sources industrielles permanentes que le live aurait filtrées sont présentes ici**. La détection d\'occupation du sol (Overpass) reste le seul filtre industriel actif dans ce rejeu.');
notes.push('6. **Le seuil météo à 55 points est conservé** : un événement sous ce score n\'est pas enrichi, donc n\'a ni vent ni villages exposés — signalé « non évalués » dans le rapport, ce qui n\'est pas la même chose que « aucun village ».');
notes.push('7. **Aucun envoi.** Le sender Telegram n\'est jamais appelé ; les alertes vont dans un collecteur mémoire puis dans `messages/`. Test : `lib/replay.test.ts` intercepte `fetch` et vérifie zéro appel vers `api.telegram.org`.');
notes.push('');
notes.push('## Météo historique (Open-Meteo archive)', '');
notes.push(`- Appels à \`archive-api.open-meteo.com/v1/archive\` : ${result.weatherLookups} (un par événement et par passage du cron qui le touche, comme en direct), espacés de 200 ms avec 2 tentatives supplémentaires en cas d'échec.`);
notes.push(`- Appels toujours sans vent après tentatives : ${result.weatherFailures}`);
const noWind = eventsOut.filter(e => e.score >= 55 && !e.windUsed).length;
notes.push(`- Événements éligibles (score ≥ 55) restés sans vent, donc sans calcul d'exposition : **${noWind}** sur ${eventsOut.filter(e => e.score >= 55).length}.`);
if (noWind > 0) {
  notes.push(`  - Pour ceux-là le message affiche « Pas de village <20km sous le vent » : c'est le comportement réel du moteur quand Open-Meteo ne répond pas, mais **cela veut dire « non calculé », pas « aucun village »**.`);
}
notes.push('');
notes.push('## Occupation du sol (Overpass)', '');
notes.push(`- Recherches effectuées : ${result.landUseLookups} (délai de ${delayMs} ms entre deux cellules, pour ménager Overpass qui renvoyait des 429 cette semaine)`);
notes.push(`- Recherches en échec (contexte « unknown », comportement dégradé prévu) : ${result.landUseUnknown}`);
if (result.landUseCircuitOpen) {
  notes.push(`- ⚠️ **Overpass injoignable depuis cette machine pendant le run** : après ${result.landUseUnknown} échecs consécutifs, le disjoncteur du replay a coupé les appels et ${result.landUseSkipped} événement(s) n'ont pas été évalués du tout. **Aucun tag industriel n'a donc pu être posé dans ce rejeu** : la colonne « tag industriel » de la synthèse vaut 0 par indisponibilité, pas par absence de sites industriels. \`overpass-api.de\` ne résout qu'en IPv6 depuis cet hôte, qui n'a pas de route IPv6 (\`fetch failed\` au niveau connexion, pas un 429).`);
}
if (failedSources.length) {
  notes.push('', '## Échecs de source', '');
  for (const s of failedSources) notes.push(`- ${s.day} · ${s.source} : ${s.error}`);
}
notes.push('');
fs.writeFileSync(path.join(outDir, 'run-notes.md'), notes.join('\n'));

console.log(`\n${eventsOut.length} event(s), ${result.alerts.length} alert(s) rendered, ${focusAlerts.length} message file(s).`);
console.log(`Wrote ${outDir}/events.json, report.md, run-notes.md, messages/`);
