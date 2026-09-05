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

// Per-source health tracking + admin Telegram alerting — built after FIRMS
// polling silently failed for 2 days (Aug 31 -> Sep 2, "Invalid MAP_KEY")
// with nobody noticing. Any source, present (the three FIRMS VIIRS feeds) or
// future (Open-Meteo, Overpass land-use, Meteosat), just calls
// recordSourceOutcome(name, outcome) after each attempt — the table and the
// state machine below are keyed on that name string, nothing to refactor to
// add one.
import { algiersTime } from './fire-monitor';
import { getSourceHealth, upsertSourceHealth } from './database';
import { defaultSourceHealth, type SourceHealthRow } from './db/types';

export { defaultSourceHealth };

const FAILURE_THRESHOLD = 3;
const RENOTIFY_INTERVAL_MS = 6 * 3_600_000;

export type SourceOutcome = { success: true } | { success: false; error: string };

export type SourceHealthEvaluation = { row: SourceHealthRow; notify?: { text: string } };

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}min`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h${String(minutes).padStart(2, '0')}`;
}

function incidentMessage(row: SourceHealthRow): string {
  const lastSuccess = row.lastSuccessAt ? algiersTime(row.lastSuccessAt) : 'jamais';
  const error = (row.lastError ?? 'inconnue').slice(0, 200);
  return `⚠️ OzarEye — source ${row.source} en panne depuis ${algiersTime(row.incidentOpenSince!)}\nDernier succès : ${lastSuccess}. Erreur : ${error}.\nLes alertes incendie ne sont plus alimentées par cette source.`;
}

function recoveryMessage(source: string, recoveredAtIso: string, incidentOpenSince: string): string {
  const duration = formatDuration(new Date(recoveredAtIso).getTime() - new Date(incidentOpenSince).getTime());
  return `✅ OzarEye — source ${source} rétablie à ${algiersTime(recoveredAtIso)} (panne de ${duration}).`;
}

// Pure state machine — no DB, no network — so it's directly unit-testable
// against a sequence of outcomes without touching either. `current` is
// undefined on a source's very first-ever recorded outcome.
export function evaluateSourceHealth(source: string, current: SourceHealthRow | undefined, outcome: SourceOutcome, nowIso: string): SourceHealthEvaluation {
  const base = current ?? defaultSourceHealth(source);

  if (outcome.success) {
    if (base.incidentOpenSince) {
      const text = recoveryMessage(source, nowIso, base.incidentOpenSince);
      return { row: { ...base, consecutiveFailures: 0, lastSuccessAt: nowIso, incidentOpenSince: null, lastNotifiedAt: null }, notify: { text } };
    }
    return { row: { ...base, consecutiveFailures: 0, lastSuccessAt: nowIso } };
  }

  const consecutiveFailures = base.consecutiveFailures + 1;
  const next: SourceHealthRow = { ...base, consecutiveFailures, lastFailureAt: nowIso, lastError: outcome.error };
  if (consecutiveFailures < FAILURE_THRESHOLD) return { row: next };

  next.incidentOpenSince = base.incidentOpenSince ?? nowIso;
  const sinceLastNotify = base.lastNotifiedAt ? new Date(nowIso).getTime() - new Date(base.lastNotifiedAt).getTime() : Infinity;
  if (sinceLastNotify >= RENOTIFY_INTERVAL_MS) {
    next.lastNotifiedAt = nowIso;
    return { row: next, notify: { text: incidentMessage(next) } };
  }
  return { row: next };
}

export type AdminNotifier = (text: string) => Promise<void>;

// Return type is wider than AdminNotifier's Promise<void> (TypeScript's
// standard void-return compatibility: a function returning something IS
// assignable where a void-returning callback is expected), so this stays a
// valid `opts.notify ?? defaultAdminNotify` default for recordSourceOutcome
// below while also letting other call sites — e.g. scripts/replay.ts's
// completion/failure notice — read back the sent message's id, instead of
// reimplementing the Telegram POST just to get it.
export async function defaultAdminNotify(text: string): Promise<{ message_id: number } | undefined> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) { console.log(`source-health: admin notify skipped, ADMIN_TELEGRAM_CHAT_ID not configured — would have sent: ${text}`); return undefined; }
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Telegram admin notify HTTP ${response.status}`);
  const data = await response.json() as { result?: { message_id: number } };
  return data.result;
}

// Fail-soft by design: this runs alongside the fire-alert pipeline and must
// never slow or break it. Every failure — DB or Telegram — is caught here and
// only logged; nothing is ever rethrown to the caller.
export async function recordSourceOutcome(source: string, outcome: SourceOutcome, opts: { now?: Date; notify?: AdminNotifier } = {}): Promise<void> {
  const notify = opts.notify ?? defaultAdminNotify;
  const nowIso = (opts.now ?? new Date()).toISOString();
  try {
    const current = await getSourceHealth(source);
    const { row, notify: pending } = evaluateSourceHealth(source, current, outcome, nowIso);
    await upsertSourceHealth(row);
    if (pending) {
      try {
        await notify(pending.text);
      } catch (error) {
        console.log(`source-health: admin notify FAILED for ${source}: ${error instanceof Error ? error.message : error}`);
      }
    }
  } catch (error) {
    console.log(`source-health: recordSourceOutcome FAILED for ${source}: ${error instanceof Error ? error.message : error}`);
  }
}
