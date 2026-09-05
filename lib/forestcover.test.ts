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

// Proves isInForest() against the real shipped index (data/forest-areas.json,
// built by scripts/build-forest-index.ts from live OSM landuse=forest /
// natural=wood tags) plus the fail-soft missing-index case. Same structure
// as lib/landuse.test.ts's real-local-index tests (Bellara/El Hamma/Chréa).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isInForest, _clearForestCacheForTests } from './forestcover';

// Real polygon confirmed live against overpass-api.de before this feature's
// index build: way (bounds minlat 36.5318296, minlon 5.4361626, maxlat
// 36.5478111, maxlon 5.4756227), tagged natural=wood, name "Bois de Cèdres" —
// in Kabylie, in the same Jijel/Béjaïa region as the real Aug 26 2026 fires.
// A point well inside its bounds, not just near the centroid.
test('isInForest: a real forest polygon in Kabylie (Bois de Cèdres, near Jijel/Béjaïa) resolves true', () => {
  _clearForestCacheForTests();
  assert.equal(isInForest(36.54, 5.46), true);
});

// Central Algiers was tried first and rejected as a fixture: it genuinely
// sits within ~1-2km of several real named OSM forest patches (Bois du
// petit Atlas, Bois des Arcades — Algiers is a hillside Mediterranean
// capital with real urban woodland), so it correctly resolves true — that
// would have been a false "urban, no forest" assumption baked into a test,
// not a bug. Oran's city centre, verified clear of any matching area in the
// real shipped index before writing this assertion, is the genuinely
// forest-free urban point instead.
test('isInForest: central Oran (urban, no forest cover nearby) resolves false', () => {
  _clearForestCacheForTests();
  assert.equal(isInForest(35.6971, -0.6337), false);
});

test('isInForest: a missing/unreadable index fails soft to false, never throws', () => {
  const previous = process.env.ALGERIE_FEUX_FOREST_INDEX_PATH;
  process.env.ALGERIE_FEUX_FOREST_INDEX_PATH = '/nonexistent/forest-areas-test.json';
  _clearForestCacheForTests();
  try {
    assert.equal(isInForest(36.54, 5.46), false, 'same coordinate that resolves true against the real index must resolve false when the index itself is missing — never fabricated');
  } finally {
    if (previous === undefined) delete process.env.ALGERIE_FEUX_FOREST_INDEX_PATH; else process.env.ALGERIE_FEUX_FOREST_INDEX_PATH = previous;
    _clearForestCacheForTests();
  }
});
