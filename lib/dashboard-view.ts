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

// Shared by /api/dashboard/events and /history — one mapping from a stored
// FireEvent to what the dashboard's narrative detail view needs. Every field
// here is a real stored/derived value; nothing invented (no hectare figures,
// no fabricated trajectories). Telegram's telegramText() is untouched and
// unrelated to this.
import {
  LABELS, algiersTime, confidenceLabel, creditsLine, distinctPasses, eventWilaya, evidenceLine, industrialLeadLine, magnitudeLabel, minutesSince, selectExposedVillages,
  type FireEvent, type LandUseContext,
} from './fire-monitor';
import { satelliteName } from './satellite-names';
import { displayName, withDisplayName } from './place-name';
import { nearestFireStation, nearestStationLine } from './firestation';

// frpThresholdMw/proximityKm default to the engine's own defaults but should
// normally be passed in from the current config (see /api/dashboard/events
// and /history) — so an event's dashboard presentation (magnitude wording,
// which villages are "proximity" vs "downwind") matches the same tunables
// currently configured, not a value frozen at whatever they were when this
// function was written.
// What the satellite evidence actually supports, in words. Repeated passes
// prove the heat source persisted across overpasses — they do NOT prove a
// vegetation fire, and nothing here has been checked on the ground, so the
// line says so explicitly. "Confirmé au sol" is deliberately never emitted:
// this system has no ground-truth input to justify it.
export function sourceStatusLine(passCount: number): string {
  return passCount >= 2
    ? `Signal thermique répété — corroboré par ${passCount} passages satellites, non confirmé au sol`
    : 'Passage satellite unique — non confirmé au sol';
}

// Display hierarchy fix: an industrial-context event must lead with that
// context (title + first line), not bury it below a "probablement un feu"
// framing — see EventDetail/Map/EventList, all of which render these instead
// of a hardcoded string. Colour/status are untouched here: lowerStatus()
// already downgraded them one step upstream (app/api/monitor/route.ts).
export function eventTitle(context?: LandUseContext): string {
  return context === 'industrial' ? 'Anomalie thermique — site industriel connu' : 'Anomalie thermique — probablement un feu';
}

// The list card's "near <feature>" line: the known industrial/energy site
// (when the event carries one) leads instead of the nearest village, since
// that site is the reason the event was already flagged industrial in the
// first place — a village line under it would bury the same context this
// whole fix exists to surface.
export function nearestFeatureLine(context: LandUseContext | undefined, siteName: string | undefined, nearestVillageName: string | undefined): string | undefined {
  if (context === 'industrial') return `🏭 ${siteName ?? 'site industriel connu'}`;
  return nearestVillageName ? `près de ${nearestVillageName}` : undefined;
}

// ONE plain sentence a first-time visitor understands in 3 seconds, shown
// above every technical field. Same tone as sourceStatusLine(): never "feu
// détecté", never "confirmé" — "anomalie thermique probable" for a single
// pass, "signal thermique répété" for 2+, always "non confirmé(e) au sol".
// Location is the nearest village (when the exposure selection has one)
// and/or the wilaya; the closing clause is the nearest caserne's distance
// when the local index resolved one. Every piece is optional and the
// sentence still reads whole when any of them is missing. Industrial events
// don't get one: industrialLeadLine() already plays this role and leads the
// detail/popup/card, so this would only duplicate it.
export function summaryLine(passCount: number, wilaya: string | null, nearestVillageName: string | undefined, stationDistanceKm: number | undefined): string {
  const repeated = passCount >= 2;
  const head = repeated ? 'Signal thermique répété' : 'Anomalie thermique probable';
  const where = nearestVillageName && wilaya ? ` près de ${nearestVillageName} (${wilaya})`
    : nearestVillageName ? ` près de ${nearestVillageName}`
    : wilaya ? ` dans la wilaya de ${wilaya}`
    : '';
  const caveat = repeated ? ', non confirmé au sol' : ', non confirmée au sol';
  const station = stationDistanceKm !== undefined ? ` — caserne la plus proche à ${stationDistanceKm < 1 ? '<1' : Math.round(stationDistanceKm)} km` : '';
  return `${head}${where}${caveat}${station}.`;
}

export function toDashboardEvent(event: FireEvent, referenceTime: Date = new Date(), frpThresholdMw?: number, proximityKm?: number) {
  const last = event.detections[event.detections.length - 1];
  const isIndustrial = event.landUse?.context === 'industrial';
  const selection = selectExposedVillages(event, proximityKm).map(s => ({ ...s, village: withDisplayName(s.village) }));
  // Nearest caserne from the local index (lib/firestation.ts) — null when
  // the index is missing, in which case none of the three fields are sent
  // and every surface simply omits the line. The phone is the station's own
  // OSM tag or null; the client decides the fallback number, not this layer.
  const station = nearestFireStation(event.latitude, event.longitude);
  const wilaya = eventWilaya(event);
  return {
    id: event.id,
    latitude: event.latitude, longitude: event.longitude,
    wilaya,
    status: event.status, score: event.score,
    maxFrp: event.maxFrp, instrument: last.instrument, satellite: satelliteName(last.satellite),
    detectedAtIso: event.lastAcquiredAt, detectedAtAlgiers: algiersTime(event.lastAcquiredAt),
    ageMinutes: minutesSince(event.lastAcquiredAt, referenceTime),
    windKph: event.windKph, windDirectionFromDeg: event.windDirectionFromDeg, humidity: event.humidity,
    passCount: event.passCount, maxPixelsInSinglePass: event.maxPixelsInSinglePass,
    confidenceLabel: confidenceLabel(event.maxConfidence),
    sourceStatusLine: sourceStatusLine(event.passCount),
    magnitude: magnitudeLabel(event.maxFrp, event.maxPixelsInSinglePass, frpThresholdMw, isIndustrial),
    passes: distinctPasses(event).map(p => ({ ...p, satellite: satelliteName(p.satellite), acquiredAtAlgiers: algiersTime(p.acquiredAt) })),
    evidenceLine: evidenceLine(event),
    credits: creditsLine(event),
    selection,
    disclaimer: LABELS.disclaimer,
    landUseContext: event.landUse?.context,
    landUseSiteName: event.landUse?.siteName,
    title: eventTitle(event.landUse?.context),
    industrialLeadLine: isIndustrial ? industrialLeadLine(event.landUse!.siteName) : undefined,
    positionSource: event.positionSource ?? 'viirs',
    positionUncertaintyKm: event.positionUncertaintyKm,
    geoTracked: event.geoTracked ?? false,
    nearestStationLine: nearestStationLine(station),
    nearestStationPhone: station?.phone ?? null,
    nearestStationDistanceKm: station ? Number(station.distanceKm.toFixed(1)) : undefined,
    summaryLine: isIndustrial ? undefined : summaryLine(event.passCount, wilaya, selection[0] ? displayName(selection[0].village) : undefined, station?.distanceKm),
  };
}
