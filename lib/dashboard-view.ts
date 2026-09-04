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
  LABELS, algiersTime, confidenceLabel, distinctPasses, eventWilaya, industrialLeadLine, magnitudeLabel, minutesSince, selectExposedVillages,
  type FireEvent, type LandUseContext,
} from './fire-monitor';
import { satelliteName } from './satellite-names';
import { withDisplayName } from './place-name';

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

export function toDashboardEvent(event: FireEvent, referenceTime: Date = new Date(), frpThresholdMw?: number, proximityKm?: number) {
  const last = event.detections[event.detections.length - 1];
  const isIndustrial = event.landUse?.context === 'industrial';
  return {
    id: event.id,
    latitude: event.latitude, longitude: event.longitude,
    wilaya: eventWilaya(event),
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
    evidenceShort: event.evidenceShort,
    selection: selectExposedVillages(event, proximityKm).map(s => ({ ...s, village: withDisplayName(s.village) })),
    disclaimer: LABELS.disclaimer,
    landUseContext: event.landUse?.context,
    landUseSiteName: event.landUse?.siteName,
    title: eventTitle(event.landUse?.context),
    industrialLeadLine: isIndustrial ? industrialLeadLine(event.landUse!.siteName) : undefined,
    positionSource: event.positionSource ?? 'viirs',
    positionUncertaintyKm: event.positionUncertaintyKm,
    geoTracked: event.geoTracked ?? false,
  };
}
