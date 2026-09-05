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
  LABELS, activeMinutes, algiersDateTime, algiersTime, confidenceLabel, creditsLine, distinctPasses, eventWilaya, evidenceLine, industrialLeadLine, magnitudeLabel, minutesSince, selectExposedVillages,
  type FireEvent, type LandUseContext,
} from './fire-monitor';
import { satelliteName } from './satellite-names';
import { displayName, withDisplayName } from './place-name';
import { nearestFireStation, nearestStationLine } from './firestation';
import type { FireLikelihoodResult } from './firesignature';

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

// Advisory fire-signature line (lib/firesignature.ts) — a plain-language
// label plus the plausibility score, never presented alone: the caveat
// (real current sample size, honest tier breakdown) travels with it as a
// separate field (fireLikelihoodCaveat below) so a UI can show both
// together, but neither hardcodes the other's wording.
export function fireLikelihoodLine(fl: FireLikelihoodResult | undefined): string | undefined {
  if (!fl) return undefined;
  const regionBit = fl.matchedRegion ? ` — proche du pattern observé : ${fl.matchedRegion}` : '';
  return `🔬 ${fl.label} (indice ${fl.score}/100)${regionBit}`;
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

// The dashboard's display filters, as one pure function so the list and
// the map are fed the SAME set (page.tsx calls this once and passes the
// result to both) and so the combinations are unit-testable. Every filter
// here is display-only — "marquer, pas masquer": detection, scoring,
// storage and Telegram never see these flags. Hide-rules combine with OR:
// an event is hidden if ANY active filter rejects it, so an industrial
// event that is also 'observation' stays hidden until BOTH opt-in boxes
// are ticked.
export type DisplayFilters = {
  /** Opt IN: 'observation' (single-pass) events are hidden until true. */
  showWeakSignals: boolean;
  /** Opt IN: landUseContext === 'industrial' events are hidden until true. */
  showIndustrial: boolean;
  /** Opt OUT: events with no wilaya (at sea / across a border) hidden when true. */
  hideUnknownWilaya: boolean;
  /** Opt IN, isolate rather than suppress: hides events NOT confirmed as
   *  real OSM forest cover (lib/forestcover.ts) when true. Unlike the other
   *  three filters here, forest context is a POSITIVE/confirmatory signal
   *  (more likely a genuine wildfire, not noise) — this box narrows the view
   *  down to those, it doesn't hide a suspected-false-positive class. Same
   *  OR-combine mechanism as the others, opposite intent. */
  forestOnly: boolean;
};

export const DEFAULT_DISPLAY_FILTERS: DisplayFilters = { showWeakSignals: false, showIndustrial: false, hideUnknownWilaya: false, forestOnly: false };

type Filterable = { status: 'observation' | 'corroborated' | 'urgent'; landUseContext?: LandUseContext; wilaya: string | null; inForest?: boolean };

export function isDisplayed(event: Filterable, f: DisplayFilters): boolean {
  if (!f.showWeakSignals && event.status === 'observation') return false;
  if (!f.showIndustrial && event.landUseContext === 'industrial') return false;
  if (f.hideUnknownWilaya && event.wilaya === null) return false;
  if (f.forestOnly && event.inForest !== true) return false;
  return true;
}

export function applyDisplayFilters<T extends Filterable>(events: T[], f: DisplayFilters): T[] {
  return events.filter(e => isDisplayed(e, f));
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
    // The full detection timeline (same helpers as Telegram's timelineLine):
    // first pass and last pass each WITH their Algiers date — detectedAtAlgiers
    // above is time-only and silently dropped the date, so a three-day-old
    // event's "dernier passage 01:05" read as this morning — plus the
    // first->last span ("actif depuis"), distinct from ageMinutes (last->now).
    firstDetectedAtIso: event.firstAcquiredAt, firstDetectedAtAlgiers: algiersDateTime(event.firstAcquiredAt),
    lastDetectedAtAlgiers: algiersDateTime(event.lastAcquiredAt),
    activeMinutes: activeMinutes(event),
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
    inForest: event.inForest,
    fireLikelihoodLine: fireLikelihoodLine(event.fireLikelihood),
    fireLikelihoodCaveat: event.fireLikelihood?.caveat,
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
