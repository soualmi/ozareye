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

// The industrial quiet regime (lib/notification-cadence.ts): one alert,
// then silence until a REAL state change — plus proof that Part B's
// history-based cap override composes with it (an anomaly that lifts the
// cap to 'urgent' is exactly the transition that speaks).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INDUSTRIAL_URGENT_REMINDER_MS, decideNotification, deescalationText, notificationText, shouldAlert } from './notification-cadence';
import { industrialStatus, type Detection, type FireEvent } from './fire-monitor';

const T0 = new Date('2026-09-05T10:00:00Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);

function det(overrides: Partial<Detection> = {}): Detection {
  return { latitude: 36.8700, longitude: 6.9840, acquiredAt: '2026-09-05T01:05:00Z', satellite: 'N20', instrument: 'VIIRS', confidence: 'h', frp: 40, ...overrides };
}
function event(overrides: Partial<FireEvent> = {}): FireEvent {
  return {
    id: 'evt-ind', latitude: 36.8700, longitude: 6.9840, detections: [det()],
    firstAcquiredAt: '2026-09-05T01:05:00Z', lastAcquiredAt: '2026-09-05T01:05:00Z',
    maxFrp: 40, maxConfidence: 'h', passCount: 3, maxPixelsInSinglePass: 2,
    score: 80, status: 'corroborated', evidence: [], evidenceShort: ['3pass'],
    landUse: { context: 'industrial', siteName: 'Zone Industrielle Pétrochimique Sonatrach' },
    ...overrides,
  };
}
// What the route does after a successful send.
function markSent(e: FireEvent, at: Date): FireEvent {
  return { ...e, notifiedAt: at.toISOString(), notifiedScore: e.score, notifiedStatus: e.status };
}

// --- Part A -----------------------------------------------------------------

test('A: a new industrial event above the threshold notifies once, then stays silent on 3 same-status polls even as FRP/score/passCount grow', () => {
  let e = event();
  assert.equal(decideNotification(e, 3, { now: T0 }), 'alert', 'first crossing: alert, as today');
  e = markSent(e, T0);
  // Three later polls: score +15 (the old re-alert trigger), passes +5, FRP x3 — all still 'corroborated'.
  const later = [
    { ...e, score: 95, passCount: 5, maxFrp: 90 },
    { ...e, score: 100, passCount: 8, maxFrp: 120 },
    { ...e, score: 100, passCount: 12, maxFrp: 125 },
  ];
  for (const [i, poll] of later.entries()) {
    assert.equal(shouldAlert(poll, 3), true, `sanity: the OLD rule would have re-alerted on poll ${i + 1} (score grew >= 15)`);
    assert.equal(decideNotification(poll, 3, { now: plus((i + 1) * 20 * 60_000) }), null, `poll ${i + 1}: silent`);
  }
});

test('A: observation -> corroborated is NOT a notification for an industrial event (only urgent speaks)', () => {
  const e = markSent(event({ status: 'observation', score: 72 }), T0);
  assert.equal(decideNotification({ ...e, status: 'corroborated', score: 80 }, 3, { now: plus(3_600_000) }), null);
});

test('A: crossing to urgent notifies immediately, even after a long silence and with no score growth', () => {
  const e = markSent(event({ score: 100 }), T0);
  const urgent = { ...e, status: 'urgent' as const, score: 100 };
  assert.equal(decideNotification(urgent, 3, { now: plus(2 * 24 * 3_600_000) }), 'escalation');
  assert.equal(shouldAlert(urgent, 3), true, 'the status step-up is also what the old rule keyed on — no regression');
  assert.match(notificationText(urgent, 'escalation', plus(60_000), 3), /^⬆️ Escalade/);
  assert.match(notificationText(urgent, 'escalation', plus(60_000), 3), /🔴/);
});

test('A: while it STAYS urgent, a reminder only after ~3h — silent before, exactly one at the boundary, clock restarts after each', () => {
  const e = markSent(event({ status: 'urgent', score: 90 }), T0);
  assert.equal(decideNotification(e, 3, { now: plus(20 * 60_000) }), null, '20min: silent');
  assert.equal(decideNotification(e, 3, { now: plus(INDUSTRIAL_URGENT_REMINDER_MS - 60_000) }), null, '2h59: still silent');
  assert.equal(decideNotification(e, 3, { now: plus(INDUSTRIAL_URGENT_REMINDER_MS) }), 'reminder', '3h00: reminder');
  const text = notificationText(e, 'reminder', plus(INDUSTRIAL_URGENT_REMINDER_MS), 3);
  assert.match(text, /^🔁 Rappel/);
  assert.match(text, /il y a 3h/);
  // Sent -> notifiedAt refreshed -> next reminder needs another 3h.
  const after = markSent(e, plus(INDUSTRIAL_URGENT_REMINDER_MS));
  assert.equal(decideNotification(after, 3, { now: plus(INDUSTRIAL_URGENT_REMINDER_MS + 20 * 60_000) }), null);
  assert.equal(decideNotification(after, 3, { now: plus(2 * INDUSTRIAL_URGENT_REMINDER_MS) }), 'reminder');
});

test('A: dropping out of urgent sends exactly one de-escalation notice, then silence resumes', () => {
  const e = markSent(event({ status: 'urgent', score: 90 }), T0);
  const dropped = { ...e, status: 'corroborated' as const, score: 80 };
  assert.equal(decideNotification(dropped, 3, { now: plus(20 * 60_000) }), 'deescalation');
  const text = notificationText(dropped, 'deescalation', plus(20 * 60_000), 3);
  assert.match(text, /^↘️ Désescalade/);
  assert.match(text, /urgent à « corroboré »/);
  assert.match(text, /Sonatrach/);
  assert.doesNotMatch(text, /Preuves :/, 'short notice, not the full alert');
  assert.equal(text, deescalationText(dropped, plus(20 * 60_000)));
  // Sent -> notifiedStatus is now 'corroborated' -> nothing more to say.
  const afterNotice = markSent(dropped, plus(20 * 60_000));
  assert.equal(decideNotification(afterNotice, 3, { now: plus(40 * 60_000) }), null);
  assert.equal(decideNotification({ ...afterNotice, score: 100, passCount: 20 }, 3, { now: plus(24 * 3_600_000) }), null, 'growth inside corroborated stays silent');
  // ...and a later re-escalation speaks again.
  assert.equal(decideNotification({ ...afterNotice, status: 'urgent' }, 3, { now: plus(60 * 60_000) }), 'escalation');
});

test('A: an industrial event below the alert threshold never gets a first message (base rule still gates the first alert)', () => {
  assert.equal(decideNotification(event({ score: 60, status: 'observation' }), 3, { now: T0 }), null);
});

test('A: non-industrial events are completely unaffected — the old rule, verbatim, for every kind of transition', () => {
  const natural = (o: Partial<FireEvent> = {}) => event({ landUse: { context: 'natural' }, ...o });
  const noLandUse = (o: Partial<FireEvent> = {}) => { const e = event(o); delete e.landUse; return e; };
  for (const mk of [natural, noLandUse]) {
    assert.equal(decideNotification(mk(), 3, { now: T0 }), 'alert', 'first alert');
    const sent = markSent(mk(), T0);
    assert.equal(decideNotification(sent, 3, { now: plus(60_000) }), null, 'no change: silent');
    assert.equal(decideNotification({ ...sent, score: 95 }, 3, { now: plus(60_000) }), 'alert', 'score +15: re-alert, as before');
    assert.equal(decideNotification({ ...sent, status: 'urgent' }, 3, { now: plus(60_000) }), 'alert', 'status up: re-alert, as before (never "escalation"/"reminder" wording)');
    const urgentSent = markSent(mk({ status: 'urgent', score: 90 }), T0);
    assert.equal(decideNotification(urgentSent, 3, { now: plus(10 * INDUSTRIAL_URGENT_REMINDER_MS) }), null, 'no 3h reminder for a natural fire');
    assert.equal(decideNotification({ ...urgentSent, status: 'corroborated' }, 3, { now: plus(60_000) }), null, 'no de-escalation notice for a natural fire');
  }
});

test('A: fail-soft — an error inside the industrial rule falls back to the standard verdict (notify), never to silence', () => {
  const thrower = () => { throw new Error('boom'); };
  const fresh = event();
  assert.equal(decideNotification(fresh, 3, { now: T0, industrialDecider: thrower }), 'alert');
  const grown = { ...markSent(event(), T0), score: 100 };
  assert.equal(decideNotification(grown, 3, { now: plus(60_000), industrialDecider: thrower }), 'alert', 'old rule would re-alert on +15 -> it does');
  // A genuinely corrupt field takes the real code path through the same net.
  const corrupt = { ...markSent(event({ status: 'urgent', score: 80 }), T0), notifiedAt: 'not-a-date' };
  assert.equal(decideNotification(corrupt, 3, { now: plus(60_000) }), null, 'old rule: nothing grew -> silent, and no throw escaped');
  assert.equal(decideNotification({ ...corrupt, score: 100 }, 3, { now: plus(60_000) }), 'alert', 'old rule: +20 >= 15 -> alert, not swallowed');
});

// --- Part B composes with Part A ----------------------------------------------

test('B+A: the history-based cap override lifts a capped industrial event to urgent, and that is exactly the transition that notifies', () => {
  // Poll 1: normal heat, no baseline yet -> capped one notch (urgent -> corroborated), first alert sent.
  const raw = event({ status: 'urgent', score: 90, detections: [det({ frp: 40 })] });
  const capped = { ...raw, status: industrialStatus(raw) };
  assert.equal(capped.status, 'corroborated');
  const sent = markSent(capped, T0);
  assert.equal(decideNotification(capped, 3, { now: T0 }), 'alert');
  // Polls 2-3: same site, same normal heat -> still capped, silent.
  assert.equal(decideNotification({ ...sent, score: 100 }, 3, { now: plus(3_600_000) }), null);
  // Poll 4: signal 2 flags this pass as >= 2x the site's OWN 30-day baseline -> cap yields -> 'urgent' stands -> escalation, immediately.
  const anomalous = { ...sent, score: 100, detections: [det({ frp: 40 }), det({ frp: 150, baselineFrpExceeded: true, acquiredAt: '2026-09-05T12:51:00Z' })] };
  const lifted = { ...anomalous, status: industrialStatus({ ...anomalous, status: 'urgent' }) };
  assert.equal(lifted.status, 'urgent', 'the real score stands — une usine peut aussi brûler');
  assert.equal(decideNotification(lifted, 3, { now: plus(2 * 3_600_000) }), 'escalation');
  // Still anomalous next polls -> 3h reminders; back to normal -> one de-escalation.
  const escalated = markSent(lifted, plus(2 * 3_600_000));
  assert.equal(decideNotification(escalated, 3, { now: plus(3 * 3_600_000) }), null);
  assert.equal(decideNotification(escalated, 3, { now: plus(5 * 3_600_000) }), 'reminder');
  const backToNormal = { ...escalated, status: industrialStatus({ ...escalated, status: 'urgent', detections: [det({ frp: 40 })] }) };
  assert.equal(backToNormal.status, 'corroborated');
  assert.equal(decideNotification(backToNormal, 3, { now: plus(6 * 3_600_000) }), 'deescalation');
});
