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

// Proves the watchdog's actual contract from the FIRMS incident it was built
// for: 3 consecutive failures (~1h at the 20-min cron) opens exactly one
// incident and sends exactly one admin message; the incident stays open and
// silent for 6h even as failures keep coming; a failure past 6h gets exactly
// one reminder; the next success closes the incident with exactly one
// "rétablie" message and resets the counter; and a source that merely blips
// (2 failures, then recovers) never notifies at all. Every case runs against
// a throwaway SQLite DB via recordSourceOutcome — not just the pure
// evaluateSourceHealth() — so the source_health persistence is exercised too.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ALGERIE_FEUX_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'algerie-feux-source-health-test-')), 'signals.db');

const { initDb, getSourceHealth } = await import('./database');
const { recordSourceOutcome } = await import('./source-health');

await initDb();

function capture() {
  const sent: string[] = [];
  return { sent, notify: async (text: string) => { sent.push(text); } };
}

const HOUR = 3_600_000;

test('3 consecutive failures -> exactly one incident notification', async () => {
  const source = 'test-3fail';
  const { sent, notify } = capture();
  const base = Date.now();
  await recordSourceOutcome(source, { success: false, error: 'boom 1' }, { now: new Date(base), notify });
  await recordSourceOutcome(source, { success: false, error: 'boom 2' }, { now: new Date(base + 20 * 60_000), notify });
  assert.equal(sent.length, 0, 'no notification before the 3rd consecutive failure');
  await recordSourceOutcome(source, { success: false, error: 'boom 3' }, { now: new Date(base + 40 * 60_000), notify });
  assert.equal(sent.length, 1, 'exactly one notification on the 3rd consecutive failure');
  assert.match(sent[0], /^⚠️ OzarEye — source test-3fail en panne depuis/);
  assert.match(sent[0], /Erreur : boom 3\./);

  const row = await getSourceHealth(source);
  assert.equal(row?.consecutiveFailures, 3);
  assert.ok(row?.incidentOpenSince, 'incident must be open after the 3rd failure');
});

test('a 4th failure within 6h of the incident notification sends nothing new', async () => {
  const source = 'test-4th-within-6h';
  const { sent, notify } = capture();
  const base = Date.now();
  for (let i = 0; i < 3; i++) await recordSourceOutcome(source, { success: false, error: `f${i}` }, { now: new Date(base + i * 20 * 60_000), notify });
  assert.equal(sent.length, 1, 'sanity: incident notification fired on the 3rd failure');

  await recordSourceOutcome(source, { success: false, error: 'f4' }, { now: new Date(base + 3 * HOUR), notify });
  assert.equal(sent.length, 1, 'a 4th failure inside the 6h anti-spam window must not re-notify');

  const row = await getSourceHealth(source);
  assert.equal(row?.consecutiveFailures, 4);
});

test('a failure after the incident has been open 6h sends exactly one reminder', async () => {
  const source = 'test-6h-reminder';
  const { sent, notify } = capture();
  const base = Date.now();
  for (let i = 0; i < 3; i++) await recordSourceOutcome(source, { success: false, error: `f${i}` }, { now: new Date(base + i * 20 * 60_000), notify });
  assert.equal(sent.length, 1);

  // lastNotifiedAt was set at the 3rd failure (base + 2*20min); the reminder
  // window is measured from there, not from base.
  await recordSourceOutcome(source, { success: false, error: 'still down' }, { now: new Date(base + 2 * 20 * 60_000 + 6 * HOUR + 60_000), notify });
  assert.equal(sent.length, 2, 'a failure at/after the 6h mark since the last notification must send exactly one reminder');
  assert.match(sent[1], /^⚠️ OzarEye — source test-6h-reminder en panne depuis/);
});

test('a success after an open incident sends one "rétablie" message and resets the failure counter', async () => {
  const source = 'test-recovery';
  const { sent, notify } = capture();
  const base = Date.now();
  for (let i = 0; i < 3; i++) await recordSourceOutcome(source, { success: false, error: `f${i}` }, { now: new Date(base + i * 20 * 60_000), notify });
  assert.equal(sent.length, 1);

  await recordSourceOutcome(source, { success: true }, { now: new Date(base + HOUR), notify });
  assert.equal(sent.length, 2, 'exactly one additional message on recovery');
  assert.match(sent[1], /^✅ OzarEye — source test-recovery rétablie à .+ \(panne de /);

  const row = await getSourceHealth(source);
  assert.equal(row?.consecutiveFailures, 0, 'a success must reset the failure counter');
  assert.equal(row?.incidentOpenSince, null, 'the incident must be closed');
  assert.equal(row?.lastNotifiedAt, null, 'closing an incident clears the notify cooldown, ready for the next one');
});

test('2 failures then a success never notifies at all — a blip is not an incident', async () => {
  const source = 'test-blip';
  const { sent, notify } = capture();
  const base = Date.now();
  await recordSourceOutcome(source, { success: false, error: 'f0' }, { now: new Date(base), notify });
  await recordSourceOutcome(source, { success: false, error: 'f1' }, { now: new Date(base + 20 * 60_000), notify });
  await recordSourceOutcome(source, { success: true }, { now: new Date(base + 40 * 60_000), notify });
  assert.equal(sent.length, 0, 'never reaching the 3-failure threshold must never notify, on failure or on the recovering success');

  const row = await getSourceHealth(source);
  assert.equal(row?.consecutiveFailures, 0);
  assert.equal(row?.incidentOpenSince, null);
});
