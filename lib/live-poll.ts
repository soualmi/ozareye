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

// The dashboard's "En direct" auto-refresh, framework-free so it's testable
// with fake timers and a fake document: a plain setInterval around the
// page's existing fetch, paused while the tab is hidden (Page Visibility
// API) and resumed — with one immediate catch-up run — when it's visible
// again. No websockets/SSE: the server itself only learns anything new every
// 20 minutes (the monitor cron), so a 60–90s client poll is already finer
// than the data. The poller owns nothing but the timer: it never touches
// the caller's state, which is how a refresh leaves every filter untouched.

export type VisibilityDoc = {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
};

export type LivePollOptions = {
  /** The refresh itself — the page's existing loadEvents(). */
  run: () => void | Promise<void>;
  intervalMs: number;
  /** Defaults to the global document; injectable for tests / SSR. */
  doc?: VisibilityDoc | null;
  /** Injectable timers for tests; defaults to the globals. */
  timers?: { setInterval: typeof globalThis.setInterval; clearInterval: typeof globalThis.clearInterval };
};

export const LIVE_REFRESH_MS = 75_000;

// Returns a stop() — hand it straight back from a useEffect.
export function startLivePolling(opts: LivePollOptions): () => void {
  const timers = opts.timers ?? { setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis) };
  const doc = opts.doc === undefined ? (typeof document === 'undefined' ? null : document) : opts.doc;
  let handle: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let stopped = false;

  // One run at a time: a slow response must not pile up a second request
  // behind it. Only a genuinely async run (a returned promise) holds the
  // in-flight flag — a synchronous callback is finished the moment it
  // returns, and must not be treated as pending until the next microtask.
  function tick() {
    if (inFlight || stopped) return;
    let result: void | Promise<void>;
    try { result = opts.run(); } catch { return; } // the page's own fetch handles/reports its errors
    if (result && typeof (result as Promise<void>).then === 'function') {
      inFlight = true;
      const clear = () => { inFlight = false; };
      (result as Promise<void>).then(clear, clear);
    }
  }

  function arm() {
    if (handle !== null || stopped) return;
    handle = timers.setInterval(tick, opts.intervalMs);
  }
  function disarm() {
    if (handle === null) return;
    timers.clearInterval(handle);
    handle = null;
  }

  const onVisibility = () => {
    if (!doc) return;
    if (doc.visibilityState === 'hidden') disarm();
    else { tick(); arm(); }
  };

  if (!doc || doc.visibilityState !== 'hidden') arm();
  doc?.addEventListener('visibilitychange', onVisibility);

  return () => {
    stopped = true;
    disarm();
    doc?.removeEventListener('visibilitychange', onVisibility);
  };
}
