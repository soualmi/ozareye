import { isAuthenticated } from '@/lib/dashboard-auth';
import { villagesInBounds } from '@/lib/fire-monitor';

// Never ships the full ~9,635-village index — only what's in the current
// viewport, and only called by the map past its zoom threshold.
export async function GET(request: Request) {
  if (!isAuthenticated(request)) return Response.json({ error: 'Non autorisé' }, { status: 401 });
  const url = new URL(request.url);
  const bounds = url.searchParams.get('bounds');
  if (!bounds) return Response.json({ error: 'Paramètre bounds requis (south,west,north,east)' }, { status: 400 });
  const [south, west, north, east] = bounds.split(',').map(Number);
  if ([south, west, north, east].some(n => !Number.isFinite(n))) return Response.json({ error: 'bounds invalide' }, { status: 400 });

  return Response.json({ villages: villagesInBounds(south, west, north, east) });
}
