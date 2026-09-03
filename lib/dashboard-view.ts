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
  LABELS, algiersTime, confidenceLabel, distinctPasses, eventWilaya, industrialContextLine, magnitudeLabel, minutesSince, selectExposedVillages,
  type FireEvent,
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

export function toDashboardEvent(event: FireEvent, referenceTime: Date = new Date(), frpThresholdMw?: number, proximityKm?: number) {
  const last = event.detections[event.detections.length - 1];
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
    magnitude: magnitudeLabel(event.maxFrp, event.maxPixelsInSinglePass, frpThresholdMw),
    passes: distinctPasses(event).map(p => ({ ...p, satellite: satelliteName(p.satellite), acquiredAtAlgiers: algiersTime(p.acquiredAt) })),
    evidenceShort: event.evidenceShort,
    selection: selectExposedVillages(event, proximityKm).map(s => ({ ...s, village: withDisplayName(s.village) })),
    disclaimer: LABELS.disclaimer,
    landUseContext: event.landUse?.context,
    landUseSiteName: event.landUse?.siteName,
    industrialNote: event.landUse?.context === 'industrial' ? industrialContextLine(event.landUse.siteName) : undefined,
  };
}
