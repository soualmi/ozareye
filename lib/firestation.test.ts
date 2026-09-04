// Proves the nearest-fire-station lookup against the real shipped index
// (data/fire-stations.json): a point right on a known station resolves to
// that station at ~0 km, a point far from every station still gets the
// nearest one with a sane (large but finite) distance, and a missing index
// fails soft to null — never throws, never blocks a caller.
import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { _clearCacheForTests, fireStationCount, nearestFireStation, nearestStationLine, type FireStation } from './firestation';

const MISSING_INDEX_PATH = '/nonexistent/fire-stations-test.json';

let originalIndexPath: string | undefined;
before(() => { originalIndexPath = process.env.ALGERIE_FEUX_FIRESTATION_INDEX_PATH; });
after(() => {
  if (originalIndexPath === undefined) delete process.env.ALGERIE_FEUX_FIRESTATION_INDEX_PATH;
  else process.env.ALGERIE_FEUX_FIRESTATION_INDEX_PATH = originalIndexPath;
});
beforeEach(() => { delete process.env.ALGERIE_FEUX_FIRESTATION_INDEX_PATH; _clearCacheForTests(); });

function realIndex(): FireStation[] {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'fire-stations.json'), 'utf8')) as FireStation[];
}

test('index: the shipped data/fire-stations.json loads with a non-trivial station count', () => {
  const count = fireStationCount();
  assert.ok(count > 50, `expected a real national index, got ${count} station(s)`);
  assert.equal(count, realIndex().length);
});

test('nearestFireStation: a point sitting exactly on a known named station resolves to that station at ~0 km', () => {
  const known = realIndex().find(s => s.name);
  assert.ok(known, 'the index must have at least one named station');
  const hit = nearestFireStation(known!.lat, known!.lon);
  assert.ok(hit);
  assert.equal(hit!.osm_id, known!.osm_id);
  assert.equal(hit!.name, known!.name);
  assert.ok(hit!.distanceKm < 0.01, `distance should be ~0, got ${hit!.distanceKm}`);
});

test('nearestFireStation: a point far from every station (deep Sahara, south of the bbox) still returns the nearest one with a sane distance', () => {
  // ~31°N is ~330 km south of the bbox's southern edge (34°N).
  const hit = nearestFireStation(31.0, 3.0);
  assert.ok(hit, 'must still return a station, never null, when the index loads');
  assert.ok(hit!.distanceKm > 100 && hit!.distanceKm < 1000, `expected a large-but-finite distance, got ${hit!.distanceKm}`);
});

test('nearestFireStation: the returned station is the true minimum over the whole index', async () => {
  const { distanceKm } = await import('./geo');
  const lat = 36.5, lon = 5.5;
  const hit = nearestFireStation(lat, lon)!;
  const best = Math.min(...realIndex().map(s => distanceKm(lat, lon, s.lat, s.lon)));
  assert.ok(Math.abs(hit.distanceKm - best) < 1e-9);
});

test('nearestFireStation: phone is either the OSM tag verbatim or null — never an invented number', () => {
  for (const s of realIndex()) {
    assert.ok(s.phone === null || (typeof s.phone === 'string' && s.phone.trim().length > 0), `bad phone on ${s.osm_id}: ${JSON.stringify(s.phone)}`);
  }
});

test('nearestFireStation: missing index → null, no throw', () => {
  process.env.ALGERIE_FEUX_FIRESTATION_INDEX_PATH = MISSING_INDEX_PATH;
  _clearCacheForTests();
  assert.equal(nearestFireStation(36.7, 3.1), null);
  assert.equal(fireStationCount(), 0);
  assert.equal(nearestStationLine(null), undefined);
});

test('nearestStationLine: names the station and the distance to 0.1 km; an unnamed station still gets a line', () => {
  assert.equal(nearestStationLine({ osm_id: 'node/1', name: 'Protection Civile Jijel', lat: 0, lon: 0, phone: null, distanceKm: 4.21 }), 'Caserne la plus proche : Protection Civile Jijel — 4.2 km');
  assert.equal(nearestStationLine({ osm_id: 'node/2', name: null, lat: 0, lon: 0, phone: null, distanceKm: 12 }), 'Caserne la plus proche (sans nom sur OSM) — 12.0 km');
});
