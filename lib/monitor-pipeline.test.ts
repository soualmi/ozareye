import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EARLY_DETECTION_ANOMALY_MIN_SAMPLES, gridCell, type Detection, type FireEvent } from './fire-monitor';

// Temp DB, same convention as lib/early-detection.test.ts — set BEFORE the
// database module is imported so the live data/signals.db is never touched.
process.env.ALGERIE_FEUX_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'algerie-feux-monitor-pipeline-test-')), 'signals.db');
delete process.env.ALGERIE_FEUX_INDUSTRIAL_INDEX_PATH; // real shipped data/industrial-sites.json
const { initDb, recordDetectionDay, recordFrpObservation, frpBaseline } = await import('./database');
const { prepareDetections, applyLandUse } = await import('./monitor-pipeline');
await initDb();

const PERSISTENT_SOURCE_DAYS = 10;
// Recent days so nothing falls outside the 30-day window/prune cutoff.
function dayAgo(n: number): string { return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10); }
function todayAt(hour: number): string { return `${dayAgo(0)}T${String(hour).padStart(2, '0')}:05:00Z`; }

function viirsDet(overrides: Partial<Detection> = {}): Detection {
  return { latitude: 34.3641642, longitude: 8.6084281, acquiredAt: todayAt(13), satellite: 'N20', instrument: 'VIIRS', confidence: 'h', frp: 10, ...overrides };
}

// --- prepareDetections: annotate BEFORE suppress -----------------------------

test('prepareDetections: a detection on a persistent-source cell is suppressed from clustering but STILL recorded in frp_history', async () => {
  const det = viirsDet({ latitude: 33.10, longitude: 5.10, frp: 42, acquiredAt: todayAt(9) });
  const cell = gridCell(det.latitude, det.longitude);
  // Seed > PERSISTENT_SOURCE_DAYS distinct days for this cell — a flare-like
  // cell the guard is meant to drop.
  for (let i = 1; i <= PERSISTENT_SOURCE_DAYS + 1; i++) await recordDetectionDay(cell, dayAgo(i));
  assert.equal(await frpBaseline(cell, 9, '2020-01-01'), null, 'sanity: no FRP history for this cell yet');

  const { detections, suppressed } = await prepareDetections([det], PERSISTENT_SOURCE_DAYS);
  assert.equal(suppressed, 1);
  assert.equal(detections.length, 0, 'the guard still drops it from clustering — that behaviour is unchanged');

  const learned = await frpBaseline(cell, 9, '2020-01-01');
  assert.deepEqual(learned, { avgFrp: 42, days: 1 }, 'REGRESSION: before the reorder, a suppressed detection never reached frp_history, so a persistent industrial cell could never build the baseline signal 2 needs');
});

test('prepareDetections: a normal (non-persistent) detection is kept and recorded exactly once', async () => {
  const det = viirsDet({ latitude: 33.30, longitude: 5.30, frp: 7, acquiredAt: todayAt(10) });
  const cell = gridCell(det.latitude, det.longitude);
  const { detections, suppressed } = await prepareDetections([det], PERSISTENT_SOURCE_DAYS);
  assert.equal(suppressed, 0);
  assert.equal(detections.length, 1);
  assert.equal(detections[0].baselineFrpExceeded, undefined, 'no history -> no anomaly flag');
  assert.deepEqual(await frpBaseline(cell, 10, '2020-01-01'), { avgFrp: 7, days: 1 });
});

test('prepareDetections: with >= min samples of history, FRP far above the cell\'s own average is flagged, a normal value is not', async () => {
  const lat = 33.50, lon = 5.50, hour = 11;
  const cell = gridCell(lat, lon);
  for (let i = 1; i <= EARLY_DETECTION_ANOMALY_MIN_SAMPLES; i++) await recordFrpObservation(cell, dayAgo(i), hour, 10);

  const normal = viirsDet({ latitude: lat, longitude: lon, frp: 12, acquiredAt: todayAt(hour) });
  const spike = viirsDet({ latitude: lat, longitude: lon, frp: 50, acquiredAt: todayAt(hour) }); // 5x baseline
  const { detections } = await prepareDetections([normal, spike], PERSISTENT_SOURCE_DAYS);
  assert.equal(detections.length, 2);
  assert.equal(detections[0].baselineFrpExceeded, undefined, '12 MW against a 10 MW average is normal for this site');
  assert.equal(detections[1].baselineFrpExceeded, true, '50 MW against a 10 MW average is the anomaly signal 2 exists for');
});

// --- applyLandUse: the conditional industrial cap, end to end ----------------

const BELLARA = { latitude: 36.7495, longitude: 6.2520 }; // industrial in the real local index (lib/landuse.test.ts)
const OFF_SITE = { latitude: 36.8667294, longitude: 7.021440572109936 }; // natural (same test file)

function event(overrides: Partial<FireEvent>): FireEvent {
  const det = viirsDet({ ...BELLARA, frp: 30 });
  return {
    id: 'evt-test', ...BELLARA, detections: [det],
    firstAcquiredAt: det.acquiredAt, lastAcquiredAt: det.acquiredAt,
    maxFrp: 30, maxConfidence: 'h', passCount: 2, maxPixelsInSinglePass: 1,
    score: 91, status: 'urgent', evidence: [], evidenceShort: [],
    ...overrides,
  };
}

test('applyLandUse: industrial site at NORMAL heat (no anomaly flag) is capped one rung, as before', async () => {
  const out = await applyLandUse(event({}));
  assert.equal(out.landUse?.context, 'industrial');
  assert.equal(out.status, 'corroborated', 'urgent -> corroborated: the existing downgrade');
  assert.equal(out.score, 91, 'the numeric score is never touched by the cap');
});

test('applyLandUse: industrial site with NO history yet (flag explicitly false) keeps the flat downgrade', async () => {
  const out = await applyLandUse(event({ detections: [viirsDet({ ...BELLARA, frp: 30, baselineFrpExceeded: false })] }));
  assert.equal(out.landUse?.context, 'industrial');
  assert.equal(out.status, 'corroborated');
});

test('applyLandUse: industrial site whose FRP is anomalous against ITS OWN history is NOT capped — reaches urgent', async () => {
  const out = await applyLandUse(event({ detections: [viirsDet({ ...BELLARA, frp: 150, baselineFrpExceeded: true })], maxFrp: 150 }));
  assert.equal(out.landUse?.context, 'industrial', 'still tagged industrial — the 🏭 context line still leads the message');
  assert.equal(out.status, 'urgent', '"une usine peut aussi brûler": the anomaly overrides the cap');
});

test('applyLandUse: the override only removes the cap, it never RAISES a status', async () => {
  const out = await applyLandUse(event({ score: 70, status: 'corroborated', detections: [viirsDet({ ...BELLARA, frp: 150, baselineFrpExceeded: true })] }));
  assert.equal(out.status, 'corroborated', 'what the raw score justifies, nothing more');
});

test('applyLandUse: a non-industrial event is completely unaffected, flag or no flag', async () => {
  const plain = await applyLandUse(event({ ...OFF_SITE, detections: [viirsDet({ ...OFF_SITE })] }));
  assert.equal(plain.landUse?.context, 'natural');
  assert.equal(plain.status, 'urgent');
  const flagged = await applyLandUse(event({ ...OFF_SITE, detections: [viirsDet({ ...OFF_SITE, baselineFrpExceeded: true })] }));
  assert.equal(flagged.landUse?.context, 'natural');
  assert.equal(flagged.status, 'urgent');
});
