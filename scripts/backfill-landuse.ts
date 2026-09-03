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

// One-shot backfill: re-evaluates every stored production event that has ANY
// landUseContext — industrial, natural, or unknown — against the current
// local index (lib/landuse.ts). Only events with no landUseContext at all
// ('absent': stored before the land-use feature existed) are left untouched.
//
// Re-evaluating 'natural' events too (not just 'unknown', as the first
// version of this script did) matters now specifically: the very first
// index build only ever got a site's centroid from Overpass (`out center`,
// no bounds), so every way/relation matched within a flat 1000m of its
// centre and nothing else — a detection genuinely inside a large industrial
// zone's footprint, but more than 1000m from that zone's centroid (e.g. the
// Skikda/Sonatrach case that prompted this), came back 'natural', wrongly.
// The rebuilt index (scripts/build-industrial-index.ts) now carries real
// bounds, and lib/landuse.ts matches "inside bounds" as well as "near
// centre" — so some previously-'natural' events are now correctly
// 'industrial'. Previously-'industrial' events are re-evaluated too, purely
// for consistency; the new matching rule is a strict superset of the old
// one, so none should flip away from 'industrial'.
//
// Runs against the real production database (data/signals.db) — no
// ALGERIE_FEUX_DB_PATH override, unlike the replay tooling, which refuses to
// touch it.
//
//   npx tsx scripts/backfill-landuse.ts
import { initDb, eventsBetween, saveSignal } from '../lib/database';
import { lookupLandUse } from '../lib/landuse';
import { lowerStatus, telegramText, type FireEvent, type LandUseContext } from '../lib/fire-monitor';
import { toDashboardEvent } from '../lib/dashboard-view';

type Category = LandUseContext | 'absent';

function categoryOf(context: LandUseContext | undefined): Category {
  return context ?? 'absent';
}

function tally(categories: Category[]): Record<Category, number> {
  const counts: Record<Category, number> = { industrial: 0, natural: 0, unknown: 0, absent: 0 };
  for (const c of categories) counts[c]++;
  return counts;
}

async function main() {
  await initDb();
  // Wide enough to cover every event this instance has ever stored.
  const events = await eventsBetween('2000-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z', 100_000);
  console.log(`Loaded ${events.length} stored event(s).`);

  const before = tally(events.map(e => categoryOf(e.landUse?.context)));

  let reevaluated = 0, becameIndustrialCount = 0, becameNaturalCount = 0, changedCount = 0;
  const after: Category[] = [];
  const updatedById = new Map<string, FireEvent>();
  for (const event of events) {
    const previous = categoryOf(event.landUse?.context);
    if (previous === 'absent') { after.push(previous); continue; }

    reevaluated++;
    const landUse = await lookupLandUse(event.latitude, event.longitude);
    // Only lower status on a genuine transition INTO industrial. An event
    // already 'industrial' had its status lowered the first time it was
    // classified that way — re-applying lowerStatus() on every backfill run
    // would double-downgrade it (urgent -> corroborated -> observation)
    // instead of leaving an already-correct status alone.
    const becameIndustrial = landUse.context === 'industrial' && previous !== 'industrial';
    const updated = becameIndustrial ? { ...event, landUse, status: lowerStatus(event.status) } : { ...event, landUse };
    await saveSignal(updated);
    updatedById.set(event.id, updated);
    const next = categoryOf(landUse.context);
    after.push(next);
    if (next !== previous) {
      changedCount++;
      if (next === 'industrial') becameIndustrialCount++;
      else if (next === 'natural') becameNaturalCount++;
    }
  }

  const afterCounts = tally(after);

  console.log(`\nRe-evaluated ${reevaluated} event(s) with a stored land-use context: ${changedCount} changed (${becameIndustrialCount} -> industrial, ${becameNaturalCount} -> natural).`);
  console.log('\nBefore:');
  for (const [cat, n] of Object.entries(before)) console.log(`  ${cat}: ${n}`);
  console.log('After:');
  for (const [cat, n] of Object.entries(afterCounts)) console.log(`  ${cat}: ${n}`);

  // The Skikda/Sonatrach event (36.8683, 6.9824) that motivated the bounds
  // rework, plus El Hamma from the original incident — confirm both now
  // carry the industrial title/🏭 note.
  const CHECKS: { label: string; lat: number; lon: number }[] = [
    { label: 'Skikda/Sonatrach', lat: 36.8683, lon: 6.9824 },
    { label: 'El Hamma', lat: 36.7490, lon: 3.0825 },
  ];
  for (const check of CHECKS) {
    const near = events.filter(e => Math.hypot(e.latitude - check.lat, e.longitude - check.lon) < 0.05);
    if (near.length === 0) {
      console.log(`\nNo stored event near ${check.label} (${check.lat}, ${check.lon}) to confirm.`);
      continue;
    }
    console.log(`\nEvent(s) near ${check.label} (${near.length}):`);
    for (const e of near) {
      const fresh = updatedById.get(e.id) ?? e;
      const text = telegramText(fresh, new Date());
      const dashboardEvent = toDashboardEvent(fresh, new Date());
      console.log(`  ${e.id}: landUse=${JSON.stringify(fresh.landUse)} status=${fresh.status}`);
      console.log(`    title: ${dashboardEvent.title}`);
      console.log(`    carries 🏭 note (Telegram): ${text.includes('🏭')}`);
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
