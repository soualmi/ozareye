import { isAuthenticated } from '@/lib/dashboard-auth';

export async function GET(request: Request) {
  return Response.json({ authenticated: isAuthenticated(request) });
}
