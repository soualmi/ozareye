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

// Proves referenceSetStats()/scoreFireLikelihood() against the REAL shipped
// reference sets (data/burnscar-confirmed-reference.json, built from 7
// genuinely re-verified Sentinel-2 dNBR checks against real Kabylie fires;
// data/global-fire-reference.json, built by
// scripts/build-global-fire-reference.py from NASA FIRMS' own VIIRS
// archive) plus the missing-file fail-soft case. Same structure as
// lib/landuse.test.ts / lib/forestcover.test.ts's real-local-index tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  _clearFireSignatureCacheForTests, fireLikelihoodCaveat, referenceSetStats, scoreFireLikelihood,
} from './firesignature';

test('referenceSetStats: real counts match the actual shipped reference files', () => {
  _clearFireSignatureCacheForTests();
  const burnscar = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'burnscar-confirmed-reference.json'), 'utf8'));
  const global_ = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'global-fire-reference.json'), 'utf8'));

  const stats = referenceSetStats();
  assert.equal(stats.burnscarConfirmedCount, burnscar.length);
  assert.equal(stats.patternGlobalCount, global_.length);
  assert.equal(stats.totalCount, burnscar.length + global_.length);
  assert.ok(stats.burnscarConfirmedCount >= 6, 'at least the real 6-7 burn-scar-confirmed Kabylie fires');
  assert.ok(stats.patternGlobalCount >= 1000, 'the global pattern set should reach the "1000+" target from real archive data, not a placeholder');
  assert.ok(stats.regions.some(r => r.includes('Algérie')), 'the real Kabylie region must appear');
  assert.ok(stats.regions.some(r => r.includes('Grèce') || r.includes('Australie')), 'at least one global region must appear');
});

test('fireLikelihoodCaveat: states the real current sample size and tier basis, never a hardcoded number', () => {
  _clearFireSignatureCacheForTests();
  const stats = referenceSetStats();
  const caveat = fireLikelihoodCaveat();
  assert.match(caveat, new RegExp(String(stats.totalCount)), 'caveat must cite the actual total, computed from the loaded files');
  assert.match(caveat, new RegExp(String(stats.burnscarConfirmedCount)), 'caveat must cite the actual burn-scar-confirmed count');
  assert.match(caveat, /cicatrice de brûlis/, 'must name the real confirmation method, not overstate it as "confirmé au sol" alone');
  assert.doesNotMatch(caveat, /confirmé au sol(?!.*jamais)/, 'must not read as ground-truth-confirmed for the whole set');
});

test('scoreFireLikelihood: a real burn-scar-confirmed example matches its own tier at high score', () => {
  _clearFireSignatureCacheForTests();
  const burnscar = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'burnscar-confirmed-reference.json'), 'utf8')) as { firstFrpMw: number; firstConfidence: string }[];
  const example = burnscar[0];
  const result = scoreFireLikelihood({ firstFrpMw: example.firstFrpMw, firstConfidence: example.firstConfidence });
  assert.equal(result.matchedTier, 'burnscar_confirmed', 'an exact match to a real burn-scar-confirmed example must cite that tier, not the weaker global one');
  assert.equal(result.label, 'ressemble à un feu réel confirmé');
  assert.ok(result.score >= 90, `exact match should score very high, got ${result.score}`);
  assert.match(result.caveat, /cicatrice de brûlis/);
});

test('scoreFireLikelihood: a plausible global-pattern-shaped input (no burn-scar match) cites the weaker tier honestly', () => {
  _clearFireSignatureCacheForTests();
  // A moderate FRP, moderate confidence first detection — a realistic
  // early-fire shape that should resemble SOME real wildfire in the large
  // global set without being an exact burn-scar-confirmed hit.
  const result = scoreFireLikelihood({ firstFrpMw: 15, firstConfidence: 'n' });
  assert.ok(result.matchedTier === 'pattern_global' || result.matchedTier === 'burnscar_confirmed', `expected a real match given >6000 reference examples, got ${result.matchedTier}`);
  if (result.matchedTier === 'pattern_global') {
    assert.equal(result.label, 'ressemble à un pattern de feu réel (non vérifié au sol)');
  }
});

test('scoreFireLikelihood: a wildly atypical input (near-zero FRP, lowest confidence) does not force a confident match', () => {
  _clearFireSignatureCacheForTests();
  const result = scoreFireLikelihood({ firstFrpMw: 0.01, firstConfidence: 'l' });
  // Not asserting a specific tier (the real reference set may or may not
  // have something this faint) — only that the function never claims
  // certainty (100) for an extreme, unusual input.
  assert.ok(result.score < 100);
});

test('scoreFireLikelihood: missing reference files fail soft to "no comparison possible", never throw', () => {
  const prevBurnscar = process.env.ALGERIE_FEUX_BURNSCAR_REFERENCE_PATH;
  const prevGlobal = process.env.ALGERIE_FEUX_GLOBAL_FIRE_REFERENCE_PATH;
  process.env.ALGERIE_FEUX_BURNSCAR_REFERENCE_PATH = '/nonexistent/burnscar-reference-test.json';
  process.env.ALGERIE_FEUX_GLOBAL_FIRE_REFERENCE_PATH = '/nonexistent/global-fire-reference-test.json';
  _clearFireSignatureCacheForTests();
  try {
    const stats = referenceSetStats();
    assert.equal(stats.totalCount, 0);
    const result = scoreFireLikelihood({ firstFrpMw: 50, firstConfidence: 'h' });
    assert.equal(result.matchedTier, 'none');
    assert.equal(result.score, 0);
    assert.match(result.caveat, /indisponible/);
  } finally {
    if (prevBurnscar === undefined) delete process.env.ALGERIE_FEUX_BURNSCAR_REFERENCE_PATH; else process.env.ALGERIE_FEUX_BURNSCAR_REFERENCE_PATH = prevBurnscar;
    if (prevGlobal === undefined) delete process.env.ALGERIE_FEUX_GLOBAL_FIRE_REFERENCE_PATH; else process.env.ALGERIE_FEUX_GLOBAL_FIRE_REFERENCE_PATH = prevGlobal;
    _clearFireSignatureCacheForTests();
  }
});
