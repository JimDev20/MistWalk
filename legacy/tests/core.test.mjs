import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CELL_SIZE_M,
  WalkGate,
  appendPath,
  cellFromLatLng,
  cellToBounds,
  cellCenter,
  cellCorners,
  cellKey,
  cellsAlongLine,
  createProgress,
  formatArea,
  formatDistance,
  formatDuration,
  haversineMeters,
  interpolatePoints,
  levelFor,
  migrateProgress,
  parseCellKey,
  progressStats,
  projectMeters,
  round5,
  unlockCells,
  unprojectMeters,
} from '../assets/core.js';

test('Web Mercator projection round-trips', () => {
  const points = [
    [14.5547, 121.0244],
    [51.5074, -0.1278],
    [-33.8688, 151.2093],
    [0, 0],
    [85.0, 179.9],
  ];
  for (const [lat, lng] of points) {
    const projected = projectMeters(lat, lng);
    const back = unprojectMeters(projected.x, projected.y);
    assert.ok(Math.abs(back.lat - lat) < 1e-9, `${lat} -> ${back.lat}`);
    assert.ok(Math.abs(back.lng - lng) < 1e-9, `${lng} -> ${back.lng}`);
  }
});

test('cell ids are stable and contain their point', () => {
  const lat = 14.5547;
  const lng = 121.0244;
  const cell = cellFromLatLng(lat, lng);
  assert.equal(cell.key, cellKey(cell.x, cell.y));
  assert.deepEqual(parseCellKey(cell.key), cell);
  const bounds = cellToBounds(cell);
  assert.ok(bounds.south <= lat && lat <= bounds.north);
  assert.ok(bounds.west <= lng && lng <= bounds.east);
  const center = cellCenter(cell);
  assert.ok(haversineMeters(center, { lat, lng }) < CELL_SIZE_M);
  const corners = cellCorners(cell);
  assert.equal(corners.length, 4);
});

test('grid handles negative coordinates', () => {
  const cell = cellFromLatLng(-33.8688, 151.2093);
  assert.ok(cell.x > 0);
  assert.ok(cell.y < 0);
  const parsed = parseCellKey(cell.key);
  assert.ok(parsed);
  assert.equal(parsed.x, cell.x);
  assert.equal(parsed.y, cell.y);
});

test('interpolation fills a walk without overshooting', () => {
  const from = { lat: 14.5547, lng: 121.0244 };
  const to = { lat: 14.5557, lng: 121.0244 };
  const pts = interpolatePoints(from, to, 4);
  assert.ok(pts.length >= 25);
  assert.ok(Math.abs(pts[pts.length - 1].lat - to.lat) < 1e-9);
  let last = from;
  let total = 0;
  for (const p of pts) {
    total += haversineMeters(last, p);
    last = p;
  }
  assert.ok(total > 100 && total < 120, `total ${total}`);
});

test('a straight walk reveals a contiguous corridor', () => {
  const from = { lat: 14.5547, lng: 121.0244 };
  const to = { lat: 14.5567, lng: 121.0244 };
  const cells = cellsAlongLine(from, to, 4);
  assert.ok(cells.length >= 18);
  assert.equal(new Set(cells.map((c) => c.key)).size, cells.length);
});

test('walking at 1.4 m/s is accepted and counted', () => {
  const gate = new WalkGate();
  const t0 = 1_700_000_000_000;
  const first = gate.evaluate({ lat: 14.5547, lng: 121.0244, accuracy: 8, t: t0 });
  assert.equal(first.unlock, true);
  assert.equal(first.reason, 'first-fix');

  const second = gate.evaluate({ lat: 14.5547126, lng: 121.0244, accuracy: 8, t: t0 + 1000 });
  assert.equal(second.unlock, true);
  assert.equal(second.reason, 'walking');
  assert.ok(second.distance > 1.3 && second.distance < 1.5, `distance ${second.distance}`);
});

test('vehicle speed pauses unlocking and requires calm walking to resume', () => {
  const gate = new WalkGate();
  const t0 = 1_700_000_000_000;
  gate.evaluate({ lat: 14.5547, lng: 121.0244, accuracy: 5, t: t0 });

  // ~43 km/h: 12 m in one second.
  const car = gate.evaluate({ lat: 14.554808, lng: 121.0244, accuracy: 5, t: t0 + 1000 });
  assert.equal(car.unlock, false);
  assert.equal(car.vehicle, true);
  assert.equal(car.reason, 'too-fast');

  // Stopped at a light: still locked out.
  const stopped = gate.evaluate({ lat: 14.554808, lng: 121.0244, accuracy: 5, t: t0 + 30_000 });
  assert.equal(stopped.unlock, false);
  assert.equal(stopped.reason, 'vehicle-lockout');

  // Sitting still does not count as walking.
  const sitting = gate.evaluate({ lat: 14.5548082, lng: 121.0244, accuracy: 5, t: t0 + 31_000 });
  assert.equal(sitting.unlock, false);
  assert.equal(sitting.reason, 'vehicle-lockout');

  // Three real walking fixes -> walk resumes.
  const a = gate.evaluate({ lat: 14.554819, lng: 121.0244, accuracy: 5, t: t0 + 32_000 });
  assert.equal(a.unlock, false);
  const b = gate.evaluate({ lat: 14.554830, lng: 121.0244, accuracy: 5, t: t0 + 33_000 });
  assert.equal(b.unlock, false);
  const c = gate.evaluate({ lat: 14.554841, lng: 121.0244, accuracy: 5, t: t0 + 34_000 });
  assert.equal(c.unlock, true);
  assert.equal(c.reason, 'walking');
  // The gate must not bridge back to the pre-car location.
  assert.ok(c.from.lat > 14.5548, `from lat ${c.from.lat}`);
});

test('reanchoring after a pause starts a fresh first fix', () => {
  const gate = new WalkGate();
  const t0 = 1_700_000_000_000;
  gate.evaluate({ lat: 14.5547, lng: 121.0244, accuracy: 5, t: t0 });
  gate.reanchor();
  const res = gate.evaluate({ lat: 14.5600, lng: 121.0244, accuracy: 5, t: t0 + 300_000 });
  assert.equal(res.unlock, true);
  assert.equal(res.reason, 'first-fix');
  assert.equal(res.distance, 0);
});

test('weak GPS does not unlock', () => {
  const gate = new WalkGate();
  const t0 = 1_700_000_000_000;
  const res = gate.evaluate({ lat: 14.5547, lng: 121.0244, accuracy: 120, t: t0 });
  assert.equal(res.unlock, false);
  assert.equal(res.reason, 'weak-gps');
});

test('a resume jump across a long gap is ignored', () => {
  const gate = new WalkGate();
  const t0 = 1_700_000_000_000;
  gate.evaluate({ lat: 14.5547, lng: 121.0244, accuracy: 5, t: t0 });
  const res = gate.evaluate({ lat: 14.6000, lng: 121.0244, accuracy: 5, t: t0 + 300_000 });
  assert.equal(res.unlock, false);
  assert.equal(res.reason, 'resume-jump');
});

test('unlocked cells are permanent and counted once', () => {
  const progress = createProgress();
  const a = cellFromLatLng(14.5547, 121.0244);
  const b = cellFromLatLng(14.5557, 121.0244);
  const first = unlockCells(progress, [a, b], 1_700_000_000_000);
  assert.equal(first.length, 2);
  assert.equal(Object.keys(progress.cells).length, 2);
  assert.equal(progress.stats.unlocks, 2);

  const again = unlockCells(progress, [a], 1_700_000_100_000);
  assert.equal(again.length, 0);
  assert.equal(Object.keys(progress.cells).length, 2);
  assert.equal(progress.cells[a.key].n, 2);

  // A new save never drops old cells.
  const migrated = migrateProgress(JSON.parse(JSON.stringify(progress)));
  assert.equal(Object.keys(migrated.cells).length, 2);
  assert.deepEqual(progressStats(migrated).cellCount, 2);
});

test('path is decimated and capped', () => {
  const progress = createProgress();
  appendPath(progress, { lat: 14.5547, lng: 121.0244 }, 1);
  appendPath(progress, { lat: 14.5547001, lng: 121.0244 }, 2);
  assert.equal(progress.path.length, 1);
  appendPath(progress, { lat: 14.55472, lng: 121.0244 }, 3);
  assert.equal(progress.path.length, 2);
  assert.equal(progress.path[1][0], round5(14.55472));
});

test('levels advance with explored cells', () => {
  assert.equal(levelFor(0).name, 'Mistwalker');
  assert.equal(levelFor(25).name, 'Pathfinder');
  assert.equal(levelFor(4000).name, 'Atlas');
  assert.equal(levelFor(4000).progress, 1);
});

test('formatting is sensible', () => {
  assert.equal(formatDistance(500), '500 m');
  assert.equal(formatDistance(1500), '1.50 km');
  assert.equal(formatDistance(1609.344, 'imperial'), '1.00 mi');
  assert.equal(formatArea(144), '144 m²');
  assert.equal(formatDuration(90_000), '2 min');
});
