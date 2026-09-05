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

// The dashboard's auto-refresh (lib/live-poll.ts) under fake timers and a
// fake document: fires on schedule, pauses while hidden, catches up once on
// return, and touches nothing but the callback it was given — which is why
// the page's filter state is structurally unaffected by a refresh cycle.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { LIVE_REFRESH_MS, startLivePolling, type VisibilityDoc } from './live-poll';

function fakeDoc(initial: DocumentVisibilityState = 'visible') {
  const listeners = new Set<() => void>();
  const doc: VisibilityDoc & { set(state: DocumentVisibilityState): void; listenerCount(): number } = {
    visibilityState: initial,
    addEventListener: (_t, l) => { listeners.add(l); },
    removeEventListener: (_t, l) => { listeners.delete(l); },
    set(state) { doc.visibilityState = state; for (const l of listeners) l(); },
    listenerCount: () => listeners.size,
  };
  return doc;
}

test('LIVE_REFRESH_MS sits in the 60–90s band the 20-min server cron warrants', () => {
  assert.ok(LIVE_REFRESH_MS >= 60_000 && LIVE_REFRESH_MS <= 90_000, String(LIVE_REFRESH_MS));
});

test('fires the fetch on schedule with fake timers, and not before; stop() ends it', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const run = mock.fn();
    const stop = startLivePolling({ run, intervalMs: 1000, doc: fakeDoc() });
    assert.equal(run.mock.callCount(), 0, 'the page does its own initial load; the poller only schedules');
    mock.timers.tick(999);
    assert.equal(run.mock.callCount(), 0);
    mock.timers.tick(1);
    assert.equal(run.mock.callCount(), 1);
    mock.timers.tick(3000);
    assert.equal(run.mock.callCount(), 4);
    stop();
    mock.timers.tick(10_000);
    assert.equal(run.mock.callCount(), 4, 'nothing after stop()');
  } finally { mock.timers.reset(); }
});

test('Page Visibility: hidden pauses the interval, visible resumes with ONE immediate catch-up, then the normal cadence', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const run = mock.fn();
    const doc = fakeDoc();
    const stop = startLivePolling({ run, intervalMs: 1000, doc });
    mock.timers.tick(1000);
    assert.equal(run.mock.callCount(), 1);
    doc.set('hidden');
    mock.timers.tick(60_000);
    assert.equal(run.mock.callCount(), 1, 'no fetches while hidden');
    doc.set('visible');
    assert.equal(run.mock.callCount(), 2, 'one immediate catch-up on return');
    mock.timers.tick(1000);
    assert.equal(run.mock.callCount(), 3, 'cadence resumes from the moment of return');
    doc.set('visible');
    assert.equal(run.mock.callCount(), 4, 'a redundant visible event still just runs once — no second interval stacked');
    mock.timers.tick(1000);
    assert.equal(run.mock.callCount(), 5, 'exactly one tick per interval, proving no duplicate interval was armed');
    stop();
    assert.equal(doc.listenerCount(), 0, 'listener removed on stop');
  } finally { mock.timers.reset(); }
});

test('started while hidden: nothing is armed until the tab becomes visible', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const run = mock.fn();
    const doc = fakeDoc('hidden');
    const stop = startLivePolling({ run, intervalMs: 1000, doc });
    mock.timers.tick(5000);
    assert.equal(run.mock.callCount(), 0);
    doc.set('visible');
    assert.equal(run.mock.callCount(), 1);
    stop();
  } finally { mock.timers.reset(); }
});

test('a slow in-flight refresh is never overlapped by the next tick', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const run = mock.fn(() => gate);
    const stop = startLivePolling({ run, intervalMs: 1000, doc: fakeDoc() });
    mock.timers.tick(3000);
    assert.equal(run.mock.callCount(), 1, 'ticks 2 and 3 skipped while tick 1 is still pending');
    release();
    await gate;
    await Promise.resolve();
    mock.timers.tick(1000);
    assert.equal(run.mock.callCount(), 2);
    stop();
  } finally { mock.timers.reset(); }
});

test('a refresh cycle changes nothing but what the callback itself changes — filter state survives untouched', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    // Mirrors the page: filters live in their own state, the refresh
    // callback only ever replaces the event data (see loadEvents()).
    const filters = { showWeakSignals: true, showIndustrial: true, hideUnknownWilaya: false, forestOnly: true, wilayaFilter: 'Skikda' };
    const filtersSnapshot = JSON.stringify(filters);
    let data = { events: [] as string[], refreshedAt: 0 };
    const stop = startLivePolling({ run: () => { data = { events: ['evt-1', 'evt-2'], refreshedAt: Date.now() }; }, intervalMs: 1000, doc: fakeDoc() });
    mock.timers.tick(1000);
    assert.deepEqual(data.events, ['evt-1', 'evt-2'], 'event data refreshed');
    assert.equal(JSON.stringify(filters), filtersSnapshot, 'filters byte-identical after the cycle');
    mock.timers.tick(1000);
    assert.equal(JSON.stringify(filters), filtersSnapshot);
    stop();
  } finally { mock.timers.reset(); }
});
