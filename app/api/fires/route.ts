import { initDb, latestSignals } from '@/lib/database';

export async function GET() {
  try { await initDb(); return Response.json({signals: await latestSignals(), updatedAt: new Date().toISOString()}); }
  catch { return Response.json({signals: [], configured: false, message: 'Base de surveillance non configurée'}); }
}
