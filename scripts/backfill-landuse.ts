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

// One-shot backfill: re-evaluates every stored production event whose
// landUseContext is 'unknown' (the state Overpass being unreachable left
// them in) against the new local index (lib/landuse.ts), now that
// data/industrial-sites.json exists. Events already tagged 'industrial' or
// 'natural' are left exactly as they are — this only fills in what the old
// live Overpass path couldn't answer.
//
// Runs against the real production database (data/signals.db) — no
// ALGERIE_FEUX_DB_PATH override, unlike the replay tooling, which refuses to
// touch it.
//
//   npx tsx scripts/backfill-landuse.ts
import { initDb, eventsBetween, saveSignal } from '../lib/database';
import { lookupLandUse } from '../lib/landuse';
import { lowerStatus, telegramText, type FireEvent, type LandUseContext } from '../lib/fire-monitor';

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

  let reevaluated = 0, changedToIndustrial = 0, changedToNatural = 0;
  const after: Category[] = [];
  const updatedById = new Map<string, FireEvent>();
  for (const event of events) {
    const current = categoryOf(event.landUse?.context);
    if (current !== 'unknown') { after.push(current); continue; }

    reevaluated++;
    const landUse = await lookupLandUse(event.latitude, event.longitude);
    const updated = landUse.context === 'industrial'
      ? { ...event, landUse, status: lowerStatus(event.status) }
      : { ...event, landUse };
    await saveSignal(updated);
    updatedById.set(event.id, updated);
    after.push(categoryOf(landUse.context));
    if (landUse.context === 'industrial') changedToIndustrial++;
    else if (landUse.context === 'natural') changedToNatural++;
  }

  const afterCounts = tally(after);

  console.log(`\nRe-evaluated ${reevaluated} 'unknown' event(s): ${changedToIndustrial} -> industrial, ${changedToNatural} -> natural, ${reevaluated - changedToIndustrial - changedToNatural} still unknown.`);
  console.log('\nBefore:');
  for (const [cat, n] of Object.entries(before)) console.log(`  ${cat}: ${n}`);
  console.log('After:');
  for (const [cat, n] of Object.entries(afterCounts)) console.log(`  ${cat}: ${n}`);

  // El Hamma power plant (Algiers), the event named in the incident that
  // motivated this backfill — confirm it now carries the 🏭 note.
  const ELHAMMA_LAT = 36.7490, ELHAMMA_LON = 3.0825;
  const near = events.filter(e => Math.hypot(e.latitude - ELHAMMA_LAT, e.longitude - ELHAMMA_LON) < 0.05);
  if (near.length === 0) {
    console.log('\nNo stored event near El Hamma (36.7490, 3.0825) to confirm.');
  } else {
    console.log(`\nEvent(s) near El Hamma (${near.length}):`);
    for (const e of near) {
      const fresh = updatedById.get(e.id) ?? e;
      const text = telegramText(fresh, new Date());
      console.log(`  ${e.id}: landUse=${JSON.stringify(fresh.landUse)} status=${fresh.status}`);
      console.log(`    carries 🏭 note: ${text.includes('🏭')}`);
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
