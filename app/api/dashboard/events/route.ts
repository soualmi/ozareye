import { eventsSince } from '@/lib/database';
import { isAuthenticated } from '@/lib/dashboard-auth';
import { toDashboardEvent } from '@/lib/dashboard-view';

// Read-only: pulls stored events from the DB only. Never calls FIRMS, never
// sends Telegram — that's /api/monitor's job, untouched by this route.
export async function GET(request: Request) {
  if (!isAuthenticated(request)) return Response.json({ error: 'Non autorisé' }, { status: 401 });
  const url = new URL(request.url);
  const since = url.searchParams.get('since') ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
  const wilaya = url.searchParams.get('wilaya');

  const events = await eventsSince(since);
  const mapped = events.map(e => toDashboardEvent(e)).filter(e => !wilaya || wilaya === 'all' || e.wilaya === wilaya);
  return Response.json({ events: mapped, updatedAt: new Date().toISOString() });
}
