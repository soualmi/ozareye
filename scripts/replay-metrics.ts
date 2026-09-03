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
// Type-only: erased, so it doesn't load lib/database before the replay DB path
// is set below.
import type { FireEvent } from '../lib/fire-monitor';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const outDir = arg('out', 'replay-out/20260826');
const dbPath = arg('db', 'data/replay-20260826.db');
process.env.ALGERIE_FEUX_DB_PATH = path.resolve(dbPath);

const { clusterDetections, ALERT_SCORE_THRESHOLD, algiersTime } = await import('../lib/fire-monitor');
const { displayName } = await import('../lib/place-name');
const { eventsBetween, getConfig } = await import('../lib/database');

const BUCKET_MS = 20 * 60_000;
const FOCUS = ['Jijel', 'Béjaïa', 'Tizi Ouzou'];
const WEAK_FRP_MW = 20;
const BIG_FRP_MW = 100;

type EventOut = {
  id: string; wilaya: string | null; wilayaLabel: string;
  latitude: number; longitude: number;
  firstDetectionUtc: string; firstDetectionAlgiers: string;
  maxFrpMw: number; passCount: number; score: number; status: string;
  villagesEvaluated: boolean;
  nearbyVillages: { name: string; rawName?: string; nameAr: string | null; distanceKm: number; relation?: string }[];
  downwindVillages: { name: string; rawName?: string; nameAr: string | null; distanceKm: number; relation?: string }[];
  wouldHaveAlerted: boolean;
};

const eventsOut = JSON.parse(fs.readFileSync(path.join(outDir, 'events.json'), 'utf8')) as EventOut[];
const config = await getConfig();
const stored = await eventsBetween('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 10_000);
const storedById = new Map(stored.map(e => [e.id, e] as const));

// --- first alerting poll, recomputed from the stored detections -------------
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

const metrics = {
  generatedAt: new Date().toISOString(),
  source: { events: eventsOut.length, alerted: alertedIds.length, db: dbPath },
  calibration,
  earlyWeakSignal: { count: earlyWeak.length, top10: earlyWeak.slice(0, 10) },
  bigOnFirstSight: { count: firstSightBig.length, top10: firstSightBig.slice(0, 10) },
  nightAlerts: { count: nightIds.length, share: Number((nightIds.length / Math.max(alertedIds.length, 1)).toFixed(3)) },
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

L.push('## 6. Ce que ce rejeu ne permet PAS d\'affirmer', '');
L.push('- **Le taux de fausses alertes n\'est pas mesurable ici.** Overpass était injoignable pendant le rejeu, donc aucun site industriel n\'a été identifié, et le garde-fou « source permanente sur 30 jours » n\'avait pas d\'historique : les deux filtres qui écartent les torchères, cimenteries et autres sources de chaleur permanentes étaient inactifs. Une partie des 490 événements alertés en serait presque certainement écartée en conditions réelles.');
L.push('- **Les feux manqués ne sont pas mesurés**, seulement approchés par les villages cités dans la presse (§3). Un feu qu\'aucun média n\'a nommé et qu\'aucun satellite n\'a vu n\'apparaît nulle part ici.');
L.push(`- **29 événements hors frontières** (Maroc, Tunisie, Méditerranée, Espagne) sont exclus des comptes par wilaya : l'emprise FIRMS est un rectangle plus large que l'Algérie.`);
L.push('- **Aucune vérification terrain.** Rien dans ce document ne dit qu\'un feu a réellement eu lieu à l\'endroit indiqué : ce sont des anomalies thermiques satellitaires, corroborées entre elles au mieux.');
L.push('');
fs.writeFileSync(path.join(outDir, 'metrics.md'), L.join('\n'));

console.log(`Wrote ${outDir}/metrics.md and metrics.json — ${earlyWeak.length} early-weak-signal, ${nightIds.length}/${alertedIds.length} night, ${pressFound}/${PRESS_VILLAGES.length} press villages.`);
