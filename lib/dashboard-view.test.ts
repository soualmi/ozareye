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

// Proves the display-hierarchy fix: an industrial-context event's dashboard
// title and first line under it must lead with that context instead of
// claiming "probablement un feu" — the Skikda/Sonatrach incident that
// prompted this had the 🏭 note correct but buried below the narrative.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventTitle, nearestFeatureLine, summaryLine, toDashboardEvent } from './dashboard-view';
import { magnitudeLabel, type Detection, type FireEvent } from './fire-monitor';

test('eventTitle: industrial context leads with the site, not "probablement un feu"', () => {
  assert.equal(eventTitle('industrial'), 'Anomalie thermique — site industriel connu');
});

test('eventTitle: natural, unknown and absent context all keep the original title', () => {
  assert.equal(eventTitle('natural'), 'Anomalie thermique — probablement un feu');
  assert.equal(eventTitle('unknown'), 'Anomalie thermique — probablement un feu');
  assert.equal(eventTitle(undefined), 'Anomalie thermique — probablement un feu');
});

test('nearestFeatureLine: industrial context shows the site, prefixed 🏭, instead of the nearest village', () => {
  assert.equal(nearestFeatureLine('industrial', 'Zone Industrielle Pétrochimique Sonatrach', 'Ramdane Djamel'), '🏭 Zone Industrielle Pétrochimique Sonatrach');
});

test('nearestFeatureLine: industrial with no OSM site name still leads with 🏭, generic fallback', () => {
  assert.equal(nearestFeatureLine('industrial', undefined, 'Ramdane Djamel'), '🏭 site industriel connu');
});

test('nearestFeatureLine: non-industrial context is unchanged — nearest village, no 🏭', () => {
  assert.equal(nearestFeatureLine('natural', undefined, 'Ramdane Djamel'), 'près de Ramdane Djamel');
  assert.equal(nearestFeatureLine(undefined, undefined, undefined), undefined);
});

test('magnitudeLabel: industrial intense signal drops "feu probablement étendu"', () => {
  assert.equal(magnitudeLabel(50, 1, 20, true), 'signal intense pour ce site');
  assert.doesNotMatch(magnitudeLabel(50, 1, 20, true), /feu/);
});

test('magnitudeLabel: non-industrial intense signal is unchanged', () => {
  assert.equal(magnitudeLabel(50, 1, 20, false), 'signal intense, feu probablement étendu');
  assert.equal(magnitudeLabel(50, 1, 20), 'signal intense, feu probablement étendu');
});

test('magnitudeLabel: moderate/weak breakpoints never mention fire and are untouched by isIndustrial', () => {
  assert.equal(magnitudeLabel(10, 1, 20, true), 'signal modéré');
  assert.equal(magnitudeLabel(10, 1, 20, false), 'signal modéré');
  assert.equal(magnitudeLabel(1, 1, 20, true), 'signal faible, foyer localisé');
});

function det(overrides: Partial<Detection>): Detection {
  return { latitude: 36.8683, longitude: 6.9824, acquiredAt: '2026-09-03T01:22:00Z', satellite: 'N20', instrument: 'VIIRS', confidence: 'h', frp: 30, ...overrides };
}

function baseEvent(overrides: Partial<FireEvent>): FireEvent {
  return {
    id: 'evt-skikda', latitude: 36.8683, longitude: 6.9824,
    detections: [det({})],
    firstAcquiredAt: '2026-09-03T01:00:00Z', lastAcquiredAt: '2026-09-03T01:22:00Z',
    maxFrp: 50, maxConfidence: 'h', passCount: 9, maxPixelsInSinglePass: 3,
    score: 99, status: 'urgent', evidence: [], evidenceShort: ['taille×3', 'recoupé'],
    ...overrides,
  };
}

test('toDashboardEvent: industrial event gets the industrial title, a lead line, and a fire-free magnitude', () => {
  const event = baseEvent({ landUse: { context: 'industrial', siteName: 'Zone Industrielle Pétrochimique Sonatrach' } });
  const dashboardEvent = toDashboardEvent(event, new Date('2026-09-03T02:00:00Z'));
  assert.equal(dashboardEvent.title, 'Anomalie thermique — site industriel connu');
  assert.ok(dashboardEvent.industrialLeadLine, 'expected a lead line for an industrial event');
  assert.match(dashboardEvent.industrialLeadLine!, /Zone Industrielle Pétrochimique Sonatrach/);
  assert.match(dashboardEvent.industrialLeadLine!, /pas un feu de végétation/);
  assert.doesNotMatch(dashboardEvent.magnitude, /feu/, 'industrial magnitude wording must not claim a fire');
});

test('toDashboardEvent: natural event keeps the original title and has no lead line', () => {
  const event = baseEvent({ landUse: { context: 'natural' } });
  const dashboardEvent = toDashboardEvent(event, new Date('2026-09-03T02:00:00Z'));
  assert.equal(dashboardEvent.title, 'Anomalie thermique — probablement un feu');
  assert.equal(dashboardEvent.industrialLeadLine, undefined);
  assert.match(dashboardEvent.magnitude, /feu probablement étendu/);
});

test('toDashboardEvent: an event with no land-use info at all reads exactly like a natural one', () => {
  const event = baseEvent({});
  const dashboardEvent = toDashboardEvent(event, new Date('2026-09-03T02:00:00Z'));
  assert.equal(dashboardEvent.title, 'Anomalie thermique — probablement un feu');
  assert.equal(dashboardEvent.industrialLeadLine, undefined);
});

test('toDashboardEvent: evidenceLine and credits are the same rendering fire-monitor.ts builds for Telegram', () => {
  const event = baseEvent({});
  const dashboardEvent = toDashboardEvent(event, new Date('2026-09-03T02:00:00Z'));
  assert.equal(dashboardEvent.evidenceLine, 'signal étendu sur 3 pixels en un même passage · confirmé par un passage satellite supplémentaire');
  assert.equal(dashboardEvent.credits, 'NASA FIRMS·Open-Meteo', 'no Meteosat pass on this event — credits line is unchanged');
});

test('toDashboardEvent: an otherwise-identical event with a Meteosat pass gets the extra credit', () => {
  const event = baseEvent({ detections: [det({}), det({ satellite: 'MTI1', instrument: 'FCI', confidence: '', frp: 0 })] });
  const dashboardEvent = toDashboardEvent(event, new Date('2026-09-03T02:00:00Z'));
  assert.equal(dashboardEvent.credits, 'NASA FIRMS·Open-Meteo·MTG Active Fire Monitoring — EUMETSAT');
});

// --- One-line plain-language summary (dashboard clarity pass) -------------

test('summaryLine: single pass → "Anomalie thermique probable", village + wilaya, feminine caveat, station distance rounded to whole km', () => {
  assert.equal(summaryLine(1, 'Jijel', 'Taher', 4.21), 'Anomalie thermique probable près de Taher (Jijel), non confirmée au sol — caserne la plus proche à 4 km.');
});

test('summaryLine: 2+ passes → "Signal thermique répété", masculine caveat', () => {
  assert.equal(summaryLine(3, 'Béjaïa', 'Akbou', 12.6), 'Signal thermique répété près de Akbou (Béjaïa), non confirmé au sol — caserne la plus proche à 13 km.');
});

test('summaryLine: no village → wilaya only; no wilaya → village only; neither → still a whole sentence', () => {
  assert.equal(summaryLine(1, 'Skikda', undefined, 2), 'Anomalie thermique probable dans la wilaya de Skikda, non confirmée au sol — caserne la plus proche à 2 km.');
  assert.equal(summaryLine(1, null, 'Collo', 2), 'Anomalie thermique probable près de Collo, non confirmée au sol — caserne la plus proche à 2 km.');
  assert.equal(summaryLine(1, null, undefined, undefined), 'Anomalie thermique probable, non confirmée au sol.');
});

test('summaryLine: under 1 km reads "<1 km"; missing station drops the clause; never says "feu détecté" or "confirmé au sol" without "non"', () => {
  assert.equal(summaryLine(2, 'Alger', 'Bouzaréah', 0.4), 'Signal thermique répété près de Bouzaréah (Alger), non confirmé au sol — caserne la plus proche à <1 km.');
  const noStation = summaryLine(2, 'Alger', 'Bouzaréah', undefined);
  assert.equal(noStation, 'Signal thermique répété près de Bouzaréah (Alger), non confirmé au sol.');
  for (const line of [noStation, summaryLine(1, 'Alger', 'Bouzaréah', 3)]) {
    assert.doesNotMatch(line, /feu détecté/i);
    assert.doesNotMatch(line, /(^|[^n] )confirmée? au sol/);
  }
});

test('toDashboardEvent: natural event carries a summaryLine, an industrial one does not (its lead line already plays that role)', () => {
  const natural = toDashboardEvent(baseEvent({ landUse: { context: 'natural' }, passCount: 1 }));
  assert.ok(natural.summaryLine && natural.summaryLine.startsWith('Anomalie thermique probable'), natural.summaryLine);
  const industrial = toDashboardEvent(baseEvent({ landUse: { context: 'industrial', siteName: 'X' } }));
  assert.equal(industrial.summaryLine, undefined);
  assert.ok(industrial.industrialLeadLine);
});

test('toDashboardEvent: nearest-station fields resolve from the real index and the phone is never invented', () => {
  const ev = toDashboardEvent(baseEvent({}));
  assert.ok(ev.nearestStationLine && /^Caserne la plus proche( : .+| \(sans nom sur OSM\)) — \d+\.\d km$/.test(ev.nearestStationLine), ev.nearestStationLine);
  assert.ok(typeof ev.nearestStationDistanceKm === 'number' && ev.nearestStationDistanceKm >= 0);
  assert.ok(ev.nearestStationPhone === null || typeof ev.nearestStationPhone === 'string');
  assert.match(ev.summaryLine!, /caserne la plus proche à (<1|\d+) km\.$/);
});
