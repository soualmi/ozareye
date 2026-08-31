import { eventsBetween } from '@/lib/database';
import { isAuthenticated } from '@/lib/dashboard-auth';
import { toDashboardEvent } from '@/lib/dashboard-view';

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return Response.json({ error: 'Non autorisé' }, { status: 401 });
  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (!from || !to) return Response.json({ error: 'Paramètres from/to requis' }, { status: 400 });

  const events = await eventsBetween(from, to);
  // Historical age is relative to the event's own detection time, not "now" —
  // otherwise a week-old event would show a nonsensical multi-day age.
  return Response.json({ events: events.map(e => toDashboardEvent(e, new Date(e.lastAcquiredAt))) });
}
