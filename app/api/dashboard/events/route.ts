import { eventsSince } from '@/lib/database';
import { isAuthenticated } from '@/lib/dashboard-auth';
import { algiersTime, eventWilaya, selectExposedVillages, telegramText, type FireEvent } from '@/lib/fire-monitor';

// Read-only: pulls stored events from the DB only. Never calls FIRMS, never
// sends Telegram — that's /api/monitor's job, untouched by this route.
function toDashboardEvent(event: FireEvent) {
  const last = event.detections[event.detections.length - 1];
  return {
    id: event.id,
    latitude: event.latitude, longitude: event.longitude,
    wilaya: eventWilaya(event),
    status: event.status, score: event.score,
    maxFrp: event.maxFrp, instrument: last.instrument, satellite: last.satellite,
    detectedAtIso: event.lastAcquiredAt, detectedAtAlgiers: algiersTime(event.lastAcquiredAt),
    windKph: event.windKph, windDirectionFromDeg: event.windDirectionFromDeg,
    evidenceShort: event.evidenceShort,
    selection: selectExposedVillages(event),
    telegramText: telegramText(event),
  };
}

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return Response.json({ error: 'Non autorisé' }, { status: 401 });
  const url = new URL(request.url);
  const since = url.searchParams.get('since') ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
  const wilaya = url.searchParams.get('wilaya');

  const events = await eventsSince(since);
  const mapped = events.map(toDashboardEvent).filter(e => !wilaya || wilaya === 'all' || e.wilaya === wilaya);
  return Response.json({ events: mapped, updatedAt: new Date().toISOString() });
}
