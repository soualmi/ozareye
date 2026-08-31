// Shared by /api/dashboard/events and /history — one mapping from a stored
// FireEvent to what the dashboard's narrative detail view needs. Every field
// here is a real stored/derived value; nothing invented (no hectare figures,
// no fabricated trajectories). Telegram's telegramText() is untouched and
// unrelated to this.
import {
  LABELS, algiersTime, confidenceLabel, distinctPasses, eventWilaya, magnitudeLabel, minutesSince, selectExposedVillages,
  type FireEvent,
} from './fire-monitor';

export function toDashboardEvent(event: FireEvent, referenceTime: Date = new Date()) {
  const last = event.detections[event.detections.length - 1];
  return {
    id: event.id,
    latitude: event.latitude, longitude: event.longitude,
    wilaya: eventWilaya(event),
    status: event.status, score: event.score,
    maxFrp: event.maxFrp, instrument: last.instrument, satellite: last.satellite,
    detectedAtIso: event.lastAcquiredAt, detectedAtAlgiers: algiersTime(event.lastAcquiredAt),
    ageMinutes: minutesSince(event.lastAcquiredAt, referenceTime),
    windKph: event.windKph, windDirectionFromDeg: event.windDirectionFromDeg, humidity: event.humidity,
    passCount: event.passCount, maxPixelsInSinglePass: event.maxPixelsInSinglePass,
    confidenceLabel: confidenceLabel(event.maxConfidence),
    magnitude: magnitudeLabel(event.maxFrp, event.maxPixelsInSinglePass),
    passes: distinctPasses(event).map(p => ({ ...p, acquiredAtAlgiers: algiersTime(p.acquiredAt) })),
    evidenceShort: event.evidenceShort,
    selection: selectExposedVillages(event),
    disclaimer: LABELS.disclaimer,
  };
}
