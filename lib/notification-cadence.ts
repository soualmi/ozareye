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

// WHEN to send a Telegram message for an event, and WHICH message — lifted
// out of app/api/monitor/route.ts so the rule is unit-testable. Two regimes:
//
//  * Every non-industrial event: shouldAlert() below, byte-for-byte the rule
//    the route always had (first alert at the score threshold or the
//    secondary gate, then re-alert on a +15 score jump or a status step up).
//
//  * landUseContext === 'industrial': a known industrial/energy site sits on
//    the same ~1km cell every single day, so the "re-alert on growth" rule
//    turned each of them into a drip of near-identical messages while
//    nothing had actually changed. For these, after the first alert, only
//    REAL state changes speak: crossing to 'urgent' (immediately, however
//    long the silence before), a reminder every ~3h while it STAYS urgent
//    (same cooldown shape as lib/source-health.ts's RENOTIFY_INTERVAL_MS),
//    and one de-escalation notice when it drops back out of urgent. Score
//    or passCount growth inside observation/corroborated is silent. This is
//    a notification-cadence rule only — detection, scoring and storage are
//    untouched, the dashboard still shows every update.
//
// Fail-soft, asymmetrically: any error inside the industrial rule falls
// back to the standard rule (which notifies MORE, never less). A bug here
// may cost a duplicate message; it must never silently swallow a genuine
// alert.
import {
  ALERT_SCORE_THRESHOLD, LABELS, effectiveProximityKm, eventWilaya, formatElapsed, hasNearbyVillage, industrialContextLine, minutesSince, telegramText, timelineLine,
  type FireEvent,
} from './fire-monitor';

export const ESCALATION_SCORE_DELTA = 15;
export const STATUS_RANK: Record<FireEvent['status'], number> = { observation: 0, corroborated: 1, urgent: 2 };

// Reminder cadence while an industrial event stays 'urgent' — the same
// "since last notify >= interval" pattern lib/source-health.ts applies to a
// source outage (its RENOTIFY_INTERVAL_MS is 6h; a burning site warrants a
// tighter loop, hence 3h here rather than importing that constant).
export const INDUSTRIAL_URGENT_REMINDER_MS = 3 * 3_600_000;

export type NotificationKind = 'alert' | 'escalation' | 'reminder' | 'deescalation';

// Meteosat/SLSTR fusion, rule (e)/(c), locked and extended to SLSTR: a
// secondary-only event (Meteosat-only, SLSTR-only, or a mix) alerts ONLY
// once it's cleared the secondary alert gate (already enforced by
// scoreEvent() capping status at 'corroborated' only when that gate is met —
// 'observation' otherwise) AND a village sits within the widened proximity
// radius (±3km for Meteosat, ±1km for SLSTR — effectiveProximityKm already
// knows the difference). Status can never exceed 'corroborated' for these
// events, so there is no "escalation" to re-alert on — this fires exactly
// once, when the gate is first met, same one-shot shape as a VIIRS event's
// very first alert.
export function shouldAlert(event: FireEvent, proximityKm: number): boolean {
  if (event.positionSource === 'meteosat' || event.positionSource === 'slstr') {
    if (event.status !== 'corroborated') return false;
    if (!hasNearbyVillage(event, effectiveProximityKm(event, proximityKm))) return false;
    return event.notifiedStatus !== 'corroborated';
  }
  if (event.score < ALERT_SCORE_THRESHOLD) return false;
  if (!event.notifiedAt) return true;
  const scoreGrew = event.score - (event.notifiedScore ?? 0) >= ESCALATION_SCORE_DELTA;
  const statusEscalated = STATUS_RANK[event.status] > STATUS_RANK[event.notifiedStatus ?? 'observation'];
  return scoreGrew || statusEscalated;
}

// The industrial regime, pure and DB-free. `baseAlerting` is shouldAlert()'s
// verdict for the same event, reused unchanged for the very first message so
// the threshold/secondary-gate rules stay the single source of truth for
// "does this deserve an alert at all". Everything after the first message
// keys off the (notifiedStatus -> status) transition alone; notifiedAt is
// only read for the reminder clock.
export function industrialNotificationKind(event: FireEvent, baseAlerting: boolean, now: Date): NotificationKind | null {
  if (!event.notifiedAt) return baseAlerting ? 'alert' : null;
  const prev = STATUS_RANK[event.notifiedStatus ?? 'observation'];
  const cur = STATUS_RANK[event.status];
  const URGENT = STATUS_RANK.urgent;
  if (cur === URGENT && prev < URGENT) return 'escalation';
  if (cur === URGENT && prev === URGENT) {
    const sinceLastNotify = now.getTime() - new Date(event.notifiedAt).getTime();
    if (!Number.isFinite(sinceLastNotify)) throw new Error(`unparseable notifiedAt "${event.notifiedAt}"`);
    return sinceLastNotify >= INDUSTRIAL_URGENT_REMINDER_MS ? 'reminder' : null;
  }
  if (cur < URGENT && prev === URGENT) return 'deescalation';
  return null;
}

export type DecideOptions = {
  now?: Date;
  // Test seam for the fail-soft contract: a decider that throws must still
  // produce the standard rule's verdict, never a silent null.
  industrialDecider?: typeof industrialNotificationKind;
};

export function decideNotification(event: FireEvent, proximityKm: number, opts: DecideOptions = {}): NotificationKind | null {
  const base = shouldAlert(event, proximityKm);
  if (event.landUse?.context !== 'industrial') return base ? 'alert' : null;
  try {
    return (opts.industrialDecider ?? industrialNotificationKind)(event, base, opts.now ?? new Date());
  } catch (error) {
    console.log(`industrial notification cadence FAILED for event ${event.id}, falling back to the standard rule: ${error instanceof Error ? error.message : error}`);
    return base ? 'alert' : null;
  }
}

const STATUS_FR: Record<FireEvent['status'], string> = { observation: 'observation', corroborated: 'corroboré', urgent: 'urgent' };

// One short message, deliberately NOT the full telegramText(): the reader
// already got the full alert when this site went urgent; what they need now
// is the one fact that changed, where, and when it was last seen.
export function deescalationText(event: FireEvent, referenceTime = new Date()): string {
  const wilaya = eventWilaya(event);
  const locationBit = wilaya ? ` · ${wilaya}` : '';
  return `↘️ Désescalade — ${industrialContextLine(event.landUse?.siteName)}\nLe signal est redescendu du niveau urgent à « ${STATUS_FR[event.status]} » (${event.maxFrp.toFixed(1)} MW max).\n\n📍${event.latitude.toFixed(4)},${event.longitude.toFixed(4)}${locationBit}\n🕓 ${timelineLine(event, referenceTime)}\n\n⚠️${LABELS.disclaimer}`;
}

// The message for a given kind. 'alert' is exactly telegramText() as
// always; 'escalation' and 'reminder' are telegramText() with one leading
// line saying WHY this message exists (the reader has already seen this
// site's alert — without that line a reminder is indistinguishable from
// the drip this module removes); 'deescalation' is its own short notice.
export function notificationText(event: FireEvent, kind: NotificationKind, referenceTime = new Date(), proximityKm?: number): string {
  switch (kind) {
    case 'alert':
      return telegramText(event, referenceTime, proximityKm);
    case 'escalation':
      return `⬆️ Escalade — ce site industriel passe au niveau URGENT : signal nettement au-dessus de son niveau habituel.\n\n${telegramText(event, referenceTime, proximityKm)}`;
    case 'reminder': {
      const since = event.notifiedAt ? formatElapsed(minutesSince(event.notifiedAt, referenceTime)) : '?';
      return `🔁 Rappel — site industriel toujours au niveau URGENT (dernière alerte il y a ${since}).\n\n${telegramText(event, referenceTime, proximityKm)}`;
    }
    case 'deescalation':
      return deescalationText(event, referenceTime);
  }
}
