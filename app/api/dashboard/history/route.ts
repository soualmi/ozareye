import { eventsBetween } from '@/lib/database';
import { isAuthenticated } from '@/lib/dashboard-auth';
import { algiersTime, eventWilaya, selectExposedVillages, telegramText, type FireEvent } from '@/lib/fire-monitor';

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
    telegramText: telegramText(event, new Date(event.lastAcquiredAt)),
  };
}

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return Response.json({ error: 'Non autorisé' }, { status: 401 });
  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!from || !to) return Response.json({ error: 'Paramètres from/to requis' }, { status: 400 });

  const events = await eventsBetween(from, to);
  return Response.json({ events: events.map(toDashboardEvent) });
}
