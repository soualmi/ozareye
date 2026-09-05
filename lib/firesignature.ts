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

// Fire-signature likelihood: "does this detection's first-sighting shape
// (FRP, confidence) resemble a REAL wildfire's, as opposed to a permanent
// heat source or noise?" — a purely advisory, additive signal, never a
// corroboration bypass. It never touches score/status/alerting; it is
// display-only context, same principle as lib/landuse.ts and
// lib/forestcover.ts.
//
// TWO HONEST TIERS, never conflated:
//   'burnscar_confirmed' — data/burnscar-confirmed-reference.json (7 real
//       Algerian fires from the 26-27 August 2026 Kabylie disaster, each
//       independently confirmed by BOTH a satellite thermal detection AND
//       a real Sentinel-2 dNBR optical burn-scar check, via
//       lib/burnscar.ts/scripts/burn-scar-verify.py — the strongest
//       evidentiary tier this project can currently produce).
//   'pattern_global' — data/global-fire-reference.json (built by
//       scripts/build-global-fire-reference.py from NASA FIRMS' own VIIRS
//       ARCHIVE product, standard processing, across 5 well-documented
//       real wildfire catastrophes worldwide: Greece 2023, Portugal 2017,
//       Algeria 2021, California 2018, Australia 2019 — thousands of
//       examples, but confirmed only by a MULTI-DAY PERSISTENCE +
//       ESCALATING-THEN-DECLINING FRP pattern, the same behavioural proxy
//       this project's own 30-day persistent-source guard already uses to
//       reject the OPPOSITE (flat, permanent-source) pattern. This is a
//       real, well-documented wildfire behaviour, not an invented one —
//       but it is NOT the same evidentiary strength as an actual burn-scar
//       confirmation. Say so, every time this is surfaced.
//
// STEP 0 access note (why this is FIRMS-archive-based, not MCD64A1-based):
// NASA's own burned-area product (MCD64A1, real polygon-level "this pixel
// burned, on this date" ground truth) needs either a free NASA Earthdata
// Login account (LP DAAC / earthaccess, ~5min signup, no approval wait) or
// Google Earth Engine (Google account + Earth Engine project
// registration, heavier friction) — neither was set up when this file was
// built. FIRMS' own listed "BA_VIIRS" source was tested live against a
// real catastrophic fire window and confirmed to return ONLY the
// active-fire CSV header via the public area/csv API, never actual
// burned-area rows — not a usable path today, account or not. See
// scripts/build-global-fire-reference.py's own header comment for the
// full access-method record.
import fs from 'node:fs';
import path from 'node:path';

export type FireReferenceTier = 'burnscar_confirmed' | 'pattern_global';

export type FireReferenceExample = {
  region: string;
  lat: number; lon: number;
  tier: FireReferenceTier;
  firstFrpMw: number;
  firstConfidence: string;
  distinctDays: number;
  peakFrpMw: number;
  growthRatio?: number | null;
};

function burnscarPath(): string {
  return process.env.ALGERIE_FEUX_BURNSCAR_REFERENCE_PATH || path.join(process.cwd(), 'data', 'burnscar-confirmed-reference.json');
}
function globalPatternPath(): string {
  return process.env.ALGERIE_FEUX_GLOBAL_FIRE_REFERENCE_PATH || path.join(process.cwd(), 'data', 'global-fire-reference.json');
}

// undefined = not loaded yet; null = load failed (missing/unreadable) — an
// absent reference file means "no comparison possible", never a fabricated
// score. Same fail-soft shape as lib/landuse.ts / lib/forestcover.ts.
let burnscarCache: FireReferenceExample[] | null | undefined;
let globalCache: FireReferenceExample[] | null | undefined;

function loadSet(filePath: string): FireReferenceExample[] | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as FireReferenceExample[];
  } catch {
    return null;
  }
}

function loadBurnscarConfirmed(): FireReferenceExample[] {
  if (burnscarCache === undefined) burnscarCache = loadSet(burnscarPath());
  return burnscarCache ?? [];
}
function loadGlobalPattern(): FireReferenceExample[] {
  if (globalCache === undefined) globalCache = loadSet(globalPatternPath());
  return globalCache ?? [];
}

export type FireReferenceStats = {
  burnscarConfirmedCount: number;
  patternGlobalCount: number;
  totalCount: number;
  regions: string[];
};

export function referenceSetStats(): FireReferenceStats {
  const a = loadBurnscarConfirmed(), b = loadGlobalPattern();
  return {
    burnscarConfirmedCount: a.length,
    patternGlobalCount: b.length,
    totalCount: a.length + b.length,
    regions: [...new Set([...a, ...b].map(e => e.region))],
  };
}

// The exact caveat text shown wherever a score from this module is
// surfaced — one function so the wording can never drift between the
// dashboard and anywhere else that reads it. Deliberately states the REAL
// current sample size, computed from the actual loaded files, not a
// hardcoded number that would silently go stale as the reference set grows.
export function fireLikelihoodCaveat(): string {
  const stats = referenceSetStats();
  if (stats.totalCount === 0) return 'Échantillon de référence indisponible — aucune comparaison de signature possible.';
  return `Comparaison à un échantillon mondial de ${stats.totalCount} feux à pattern confirmé, dont ${stats.burnscarConfirmedCount} vérifié(s) par cicatrice de brûlis (Sentinel-2, dNBR) — un indice de plausibilité, jamais une confirmation, et jamais un substitut à la corroboration multi-capteurs déjà en place.`;
}

// Same confidence-tier mapping as lib/fire-monitor.ts's confidenceRank(),
// duplicated rather than imported: this module must stay independently
// loadable (and testable) without pulling in the whole detection/scoring
// graph, same isolation principle as lib/landuse.ts/lib/forestcover.ts.
function confidenceRank(c: string): number {
  if (c === 'h' || Number(c) >= 80) return 2;
  if (c === 'n' || Number(c) >= 50) return 1;
  return 0;
}

export type FireLikelihoodInput = { firstFrpMw: number; firstConfidence: string };

export type FireLikelihoodResult = {
  score: number; // 0-100, a coarse plausibility indicator, not a probability
  label: 'ressemble à un feu réel confirmé' | 'ressemble à un pattern de feu réel (non vérifié au sol)' | 'atypique ou insuffisant pour comparer';
  matchedTier: FireReferenceTier | 'none';
  matchedRegion?: string;
  caveat: string;
};

// Nearest-neighbour, deliberately simple and explainable (not a black-box
// model): distance in (log10 FRP, confidence-rank) space. log-FRP because
// real fire radiative power spans orders of magnitude (a few MW to
// thousands); confidence-rank because "how sure was the sensor" matters
// as much as the raw number. SIMILARITY_DIST_CLOSE is an empirical choice
// (within about half a log-decade of FRP AND the same confidence tier),
// not a calibrated statistical threshold — this is advisory context, not
// a certified classifier.
const SIMILARITY_DIST_CLOSE = 0.5;

function nearest(set: FireReferenceExample[], input: FireLikelihoodInput): { dist: number; example: FireReferenceExample } | null {
  if (!set.length) return null;
  const logFrpIn = Math.log10(Math.max(input.firstFrpMw, 0.1));
  const rankIn = confidenceRank(input.firstConfidence);
  let best: { dist: number; example: FireReferenceExample } | null = null;
  for (const ex of set) {
    const logFrpEx = Math.log10(Math.max(ex.firstFrpMw, 0.1));
    const rankEx = confidenceRank(ex.firstConfidence);
    const dist = Math.abs(logFrpIn - logFrpEx) + Math.abs(rankIn - rankEx) * 0.5;
    if (!best || dist < best.dist) best = { dist, example: ex };
  }
  return best;
}

// Advisory only — this is NEVER called anywhere near score/status
// computation (lib/fire-monitor.ts's scoreEvent, clusterDetections,
// shouldAlert are all untouched by this module). It exists purely to
// annotate an already-clustered event with "does this look like a real
// fire we've seen before", for display, exactly the way inForest/landUse
// annotate context without ever feeding back into the alert gate.
export function scoreFireLikelihood(input: FireLikelihoodInput): FireLikelihoodResult {
  const burnscar = loadBurnscarConfirmed();
  const global = loadGlobalPattern();
  const caveat = fireLikelihoodCaveat();

  if (burnscar.length === 0 && global.length === 0) {
    return { score: 0, label: 'atypique ou insuffisant pour comparer', matchedTier: 'none', caveat };
  }

  const nearestBurnscar = nearest(burnscar, input);
  const nearestGlobal = nearest(global, input);

  // The burn-scar tier is the stronger evidentiary claim, so a close match
  // there wins even when the global-pattern match is marginally closer —
  // ties should cite the tier that means more, not just the smaller number.
  let matchedTier: FireLikelihoodResult['matchedTier'] = 'none';
  let matchedExample: FireReferenceExample | undefined;
  let bestDist = Infinity;
  if (nearestBurnscar && nearestBurnscar.dist <= SIMILARITY_DIST_CLOSE) {
    matchedTier = 'burnscar_confirmed'; matchedExample = nearestBurnscar.example; bestDist = nearestBurnscar.dist;
  } else if (nearestGlobal && nearestGlobal.dist <= SIMILARITY_DIST_CLOSE) {
    matchedTier = 'pattern_global'; matchedExample = nearestGlobal.example; bestDist = nearestGlobal.dist;
  } else if (nearestGlobal) {
    bestDist = nearestGlobal.dist; // no close match, but still report how far the nearest one was
  }

  const label: FireLikelihoodResult['label'] = matchedTier === 'burnscar_confirmed' ? 'ressemble à un feu réel confirmé'
    : matchedTier === 'pattern_global' ? 'ressemble à un pattern de feu réel (non vérifié au sol)'
    : 'atypique ou insuffisant pour comparer';

  const score = matchedTier === 'none'
    ? Math.max(0, Math.round(40 - bestDist * 20))
    : Math.min(100, Math.max(40, Math.round(100 - bestDist * 60)));

  return { score, label, matchedTier, matchedRegion: matchedExample?.region, caveat };
}

// Test-only: clears the loaded-reference-set cache so a test that changes
// ALGERIE_FEUX_BURNSCAR_REFERENCE_PATH/ALGERIE_FEUX_GLOBAL_FIRE_REFERENCE_PATH
// actually reloads from the new path — same pattern as lib/landuse.ts's
// _clearCacheForTests() / lib/forestcover.ts's _clearForestCacheForTests().
export function _clearFireSignatureCacheForTests() {
  burnscarCache = undefined;
  globalCache = undefined;
}
