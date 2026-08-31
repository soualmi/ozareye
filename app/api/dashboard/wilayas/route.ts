import { isAuthenticated } from '@/lib/dashboard-auth';
import { allWilayaNames } from '@/lib/wilaya';

export async function GET(request: Request) {
  if (!isAuthenticated(request)) return Response.json({ error: 'Non autorisé' }, { status: 401 });
  return Response.json({ wilayas: allWilayaNames() });
}
