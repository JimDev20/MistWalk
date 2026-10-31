import { describe, expect, it } from 'vitest';
import type { ActiveSession, ArchivedSession } from './types.ts';
import {
	CELL_SIZE_M,
	MAX_NOTE_LENGTH,
	PROGRESS_VERSION,
	WalkGate,
	appendPath,
	appendSessionPoint,
	archiveSession,
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
	groupSessionsByDay,
	haversineMeters,
	interpolatePoints,
	levelFor,
	listCellNotes,
	migrateProgress,
	normalizeFix,
	normalizeNote,
	parseCellKey,
	progressStats,
	projectMeters,
	round5,
	setCellNote,
	unlockCells,
	unprojectMeters
} from './core.ts';

describe('grid and projection', () => {
	it('round-trips Web Mercator coordinates', () => {
		const points = [
			[14.5547, 121.0244],
			[51.5074, -0.1278],
			[-33.8688, 151.2093],
			[0, 0],
			[85.0, 179.9]
		];
		for (const [lat, lng] of points) {
			const projected = projectMeters(lat, lng);
			const back = unprojectMeters(projected.x, projected.y);
			expect(Math.abs(back.lat - lat)).toBeLessThan(1e-9);
			expect(Math.abs(back.lng - lng)).toBeLessThan(1e-9);
		}
	});

	it('creates stable cell ids that contain their point', () => {
		const lat = 14.5547;
		const lng = 121.0244;
		const cell = cellFromLatLng(lat, lng);
		expect(cell.key).toBe(cellKey(cell.x, cell.y));
		expect(parseCellKey(cell.key)).toEqual(cell);
		const bounds = cellToBounds(cell);
		expect(bounds.south).toBeLessThanOrEqual(lat);
		expect(lat).toBeLessThanOrEqual(bounds.north);
		expect(bounds.west).toBeLessThanOrEqual(lng);
		expect(lng).toBeLessThanOrEqual(bounds.east);
		expect(haversineMeters(cellCenter(cell), { lat, lng })).toBeLessThan(CELL_SIZE_M);
		expect(cellCorners(cell)).toHaveLength(4);
	});

	it('handles negative coordinates', () => {
		const cell = cellFromLatLng(-33.8688, 151.2093);
		expect(cell.x).toBeGreaterThan(0);
		expect(cell.y).toBeLessThan(0);
		expect(parseCellKey(cell.key)).toEqual(cell);
	});

	it('interpolates a walk without overshooting', () => {
		const from = { lat: 14.5547, lng: 121.0244 };
		const to = { lat: 14.5557, lng: 121.0244 };
		const points = interpolatePoints(from, to, 4);
		expect(points.length).toBeGreaterThanOrEqual(25);
		expect(Math.abs(points[points.length - 1].lat - to.lat)).toBeLessThan(1e-9);
		let last = from;
		let total = 0;
		for (const point of points) {
			total += haversineMeters(last, point);
			last = point;
		}
		expect(total).toBeGreaterThan(100);
		expect(total).toBeLessThan(120);
	});

	it('reveals a contiguous corridor along a straight walk', () => {
		const from = { lat: 14.5547, lng: 121.0244 };
		const to = { lat: 14.5567, lng: 121.0244 };
		const cells = cellsAlongLine(from, to, 4);
		expect(cells.length).toBeGreaterThanOrEqual(18);
		expect(new Set(cells.map((cell) => cell.key)).size).toBe(cells.length);
	});
});

describe('walking gate', () => {
	it('accepts walking at 1.4 m/s', () => {
		const gate = new WalkGate();
		const t0 = 1_700_000_000_000;
		const first = gate.evaluate({ lat: 14.5547, lng: 121.0244, accuracy: 8, t: t0 });
		expect(first.unlock).toBe(true);
		expect(first.reason).toBe('first-fix');

		const second = gate.evaluate({ lat: 14.5547126, lng: 121.0244, accuracy: 8, t: t0 + 1000 });
		expect(second.unlock).toBe(true);
		expect(second.reason).toBe('walking');
		expect(second.distance).toBeGreaterThan(1.3);
		expect(second.distance).toBeLessThan(1.5);
	});

	it('rejects 6.68 m/s and does not bridge the rejected corridor', () => {
		const gate = new WalkGate();
		const t0 = 1_700_000_000_000;
		const start = { lat: 14.5547, lng: 121.0244 };
		const car = { lat: 14.55476, lng: 121.0244 };
		const afterCar = { lat: 14.554772, lng: 121.0244 };

		expect(gate.evaluate({ ...start, accuracy: 5, t: t0 }).unlock).toBe(true);
		const rejected = gate.evaluate({ ...car, accuracy: 5, t: t0 + 1000 });
		expect(rejected.unlock).toBe(false);
		expect(rejected.reason).toBe('too-fast');
		expect(rejected.vehicle).toBe(false);
		expect(rejected.distance).toBe(0);

		const walking = gate.evaluate({ ...afterCar, accuracy: 5, t: t0 + 2000 });
		expect(walking.unlock).toBe(true);
		expect(walking.from!.lat).toBeCloseTo(car.lat, 6);
	});

	it('treats a reported vehicle speed as a lockout even with little movement', () => {
		const gate = new WalkGate();
		const t0 = 1_700_000_000_000;
		gate.evaluate({ lat: 14.5547, lng: 121.0244, accuracy: 5, t: t0 });
		const fast = gate.evaluate({
			lat: 14.55471,
			lng: 121.0244,
			accuracy: 5,
			speed: 6.68,
			t: t0 + 1000
		});
		expect(fast.unlock).toBe(false);
		expect(fast.reason).toBe('too-fast');
		expect(fast.vehicle).toBe(true);
	});

	it('pauses unlocking for 45 seconds after vehicle speed', () => {
		const gate = new WalkGate();
		const t0 = 1_700_000_000_000;
		gate.evaluate({ lat: 14.5547, lng: 121.0244, accuracy: 5, t: t0 });

		const car = gate.evaluate({ lat: 14.554808, lng: 121.0244, accuracy: 5, t: t0 + 1000 });
		expect(car.unlock).toBe(false);
		expect(car.vehicle).toBe(true);
		expect(car.reason).toBe('too-fast');

		const stopped = gate.evaluate({ lat: 14.554808, lng: 121.0244, accuracy: 5, t: t0 + 30_000 });
		expect(stopped.unlock).toBe(false);
		expect(stopped.reason).toBe('vehicle-lockout');

		const sitting = gate.evaluate({ lat: 14.5548082, lng: 121.0244, accuracy: 5, t: t0 + 31_000 });
		expect(sitting.unlock).toBe(false);
		expect(sitting.reason).toBe('vehicle-lockout');

		const a = gate.evaluate({ lat: 14.554819, lng: 121.0244, accuracy: 5, t: t0 + 32_000 });
		const b = gate.evaluate({ lat: 14.55483, lng: 121.0244, accuracy: 5, t: t0 + 33_000 });
		const c = gate.evaluate({ lat: 14.554841, lng: 121.0244, accuracy: 5, t: t0 + 34_000 });
		expect(a.unlock).toBe(false);
		expect(b.unlock).toBe(false);
		expect(c.unlock).toBe(true);
		expect(c.reason).toBe('walking');
		expect(c.from!.lat).toBeGreaterThan(14.5548);
	});

	it('starts a fresh first fix after reanchoring', () => {
		const gate = new WalkGate();
		const t0 = 1_700_000_000_000;
		gate.evaluate({ lat: 14.5547, lng: 121.0244, accuracy: 5, t: t0 });
		gate.reanchor();
		const result = gate.evaluate({ lat: 14.56, lng: 121.0244, accuracy: 5, t: t0 + 300_000 });
		expect(result.unlock).toBe(true);
		expect(result.reason).toBe('first-fix');
		expect(result.distance).toBe(0);
	});

	it('does not unlock with weak GPS', () => {
		const gate = new WalkGate();
		const result = gate.evaluate({
			lat: 14.5547,
			lng: 121.0244,
			accuracy: 120,
			t: 1_700_000_000_000
		});
		expect(result.unlock).toBe(false);
		expect(result.reason).toBe('weak-gps');
	});

	it('ignores a jump across a long gap', () => {
		const gate = new WalkGate();
		const t0 = 1_700_000_000_000;
		gate.evaluate({ lat: 14.5547, lng: 121.0244, accuracy: 5, t: t0 });
		const result = gate.evaluate({ lat: 14.6, lng: 121.0244, accuracy: 5, t: t0 + 300_000 });
		expect(result.unlock).toBe(false);
		expect(result.reason).toBe('resume-jump');
	});
});

describe('fix normalization', () => {
	it('retains a valid heading', () => {
		const fix = normalizeFix({ lat: 14.5547, lng: 121.0244, accuracy: 8, heading: 123.4, t: 1 });
		expect(fix!.heading).toBe(123.4);
	});

	it('drops invalid headings while keeping the fix', () => {
		expect(normalizeFix({ lat: 1, lng: 2, heading: 360 })!.heading).toBeNull();
		expect(normalizeFix({ lat: 1, lng: 2, heading: -1 })!.heading).toBeNull();
		expect(normalizeFix({ lat: 1, lng: 2, heading: 'north' })!.heading).toBeNull();
	});
});

describe('progress', () => {
	it('keeps unlocked cells permanent and counts them once', () => {
		const progress = createProgress();
		const a = cellFromLatLng(14.5547, 121.0244);
		const b = cellFromLatLng(14.5557, 121.0244);
		const first = unlockCells(progress, [a, b], 1_700_000_000_000);
		expect(first).toHaveLength(2);
		expect(Object.keys(progress.cells)).toHaveLength(2);
		expect(progress.stats.unlocks).toBe(2);

		const again = unlockCells(progress, [a], 1_700_000_100_000);
		expect(again).toHaveLength(0);
		expect(Object.keys(progress.cells)).toHaveLength(2);
		expect(progress.cells[a.key].n).toBe(2);

		const migrated = migrateProgress(JSON.parse(JSON.stringify(progress)));
		expect(Object.keys(migrated.cells)).toHaveLength(2);
		expect(progressStats(migrated).cellCount).toBe(2);
	});

	it('summarizes repeat visits for favorite paths', () => {
		const progress = createProgress();
		const favorite = cellFromLatLng(14.5547, 121.0244);
		const once = cellFromLatLng(14.5557, 121.0244);
		unlockCells(progress, [favorite, once], 1);
		unlockCells(progress, [favorite], 2);
		unlockCells(progress, [favorite], 3);
		const stats = progressStats(progress);
		expect(stats.visits).toBe(4);
		expect(stats.favoriteCells).toBe(1);
		expect(stats.maxVisits).toBe(3);
	});

	it('upgrades the stored progress version', () => {
		const migrated = migrateProgress({ version: 1, cells: {}, path: [] });
		expect(migrated.version).toBe(PROGRESS_VERSION);
	});

	it('archives a session and counts it once', () => {
		const progress = createProgress();
		const session: ActiveSession = {
			id: 'walk-1',
			startedAt: 1_700_000_000_000,
			distance: 12,
			walkingMs: 9000,
			unlocks: 3,
			profile: 'live',
			pausedAt: null,
			lastAcceptedAt: null,
			speed: 0,
			archived: false,
			path: []
		};
		appendSessionPoint(session, { lat: 14.5547, lng: 121.0244 }, session.startedAt);
		appendSessionPoint(session, { lat: 14.5548, lng: 121.0244 }, session.startedAt + 1000);
		const archived = archiveSession(progress, session, session.startedAt + 2000);
		expect(archived).not.toBeNull();
		expect(archived!.path).toHaveLength(2);
		expect(progress.sessions).toHaveLength(1);
		expect(progress.stats.sessions).toBe(1);
		expect(archiveSession(progress, session, session.startedAt + 3000)).toBeNull();
		expect(progress.sessions).toHaveLength(1);
	});

	it('groups walks into one history record per local day', () => {
		const dayOne = new Date(2026, 0, 15, 9, 0, 0).getTime();
		const dayTwo = new Date(2026, 0, 16, 9, 0, 0).getTime();
		const makeSession = (
			id: string,
			startedAt: number,
			distance: number,
			walkingMs: number,
			unlocks: number,
			baseLat: number
		): ArchivedSession => ({
			id,
			startedAt,
			endedAt: startedAt + 60_000,
			distance,
			walkingMs,
			unlocks,
			profile: 'live',
			path: [
				[baseLat, 121.0244, startedAt],
				[baseLat + 0.0001, 121.0244, startedAt + 30_000]
			]
		});
		const stored = [
			makeSession('walk-1', dayOne, 1200, 900_000, 8, 14.5547),
			makeSession('walk-2', dayOne + 6 * 3_600_000, 800, 600_000, 5, 14.556),
			makeSession('walk-3', dayTwo, 300, 300_000, 2, 14.558)
		];

		const grouped = groupSessionsByDay(stored);
		expect(grouped).toHaveLength(2);
		expect(stored).toHaveLength(3);
		expect(grouped[0].distance).toBe(2000);
		expect(grouped[0].walkingMs).toBe(1_500_000);
		expect(grouped[0].unlocks).toBe(13);
		expect(grouped[0].path).toHaveLength(4);
		expect(grouped[1].distance).toBe(300);
		expect(grouped[1].walkingMs).toBe(300_000);
	});

	it('keeps individual walks for export while grouping history by day', () => {
		const dayOne = new Date(2026, 0, 15, 9, 0, 0).getTime();
		const dayTwo = new Date(2026, 0, 16, 9, 0, 0).getTime();
		const legacySession = (id: string, startedAt: number, distance: number, unlocks: number) => ({
			id,
			startedAt,
			endedAt: startedAt + 60_000,
			distance,
			walkingMs: 30_000,
			unlocks,
			profile: 'live',
			path: [
				[14.5547, 121.0244, startedAt],
				[14.5548, 121.0244, startedAt + 30_000]
			]
		});
		const migrated = migrateProgress({
			version: 2,
			sessions: [
				legacySession('walk-1', dayOne, 10, 1),
				legacySession('walk-2', dayOne + 3_600_000, 20, 2),
				legacySession('walk-3', dayTwo, 30, 3)
			],
			stats: { sessions: 3 }
		});
		expect(migrated.version).toBe(PROGRESS_VERSION);
		expect(migrated.sessions).toHaveLength(3);
		expect(migrated.stats.sessions).toBe(3);
		const grouped = groupSessionsByDay(migrated.sessions);
		expect(grouped).toHaveLength(2);
		expect(grouped[0].distance).toBe(30);
		expect(grouped[0].walkingMs).toBe(60_000);
		expect(grouped[0].unlocks).toBe(3);
		expect(grouped[0].path).toHaveLength(4);
		expect(grouped[1].distance).toBe(30);
	});

	it('normalizes, stores, lists, and migrates tile notes', () => {
		const progress = createProgress();
		const cell = cellFromLatLng(14.5547, 121.0244);
		expect(normalizeNote('  hello \n  mist  ')).toBe('hello mist');
		expect(setCellNote(progress, cell.key, '  hello \n  mist  ', 42)).toBe('hello mist');
		expect(progress.notes[cell.key]).toEqual({ text: 'hello mist', t: 42 });
		const notes = listCellNotes(progress);
		expect(notes).toHaveLength(1);
		expect(notes[0].key).toBe(cell.key);
		expect(notes[0].lat).toBeCloseTo(cellCenter(cell).lat, 6);
		setCellNote(progress, cell.key, '', 43);
		expect(listCellNotes(progress)).toHaveLength(0);

		setCellNote(progress, cell.key, 'saved', 44);
		const migrated = migrateProgress(JSON.parse(JSON.stringify(progress)));
		expect(migrated.notes[cell.key].text).toBe('saved');
		expect(normalizeNote('x'.repeat(MAX_NOTE_LENGTH + 20))).toHaveLength(MAX_NOTE_LENGTH);
	});

	it('decimates and caps the path', () => {
		const progress = createProgress();
		appendPath(progress, { lat: 14.5547, lng: 121.0244 }, 1);
		appendPath(progress, { lat: 14.5547001, lng: 121.0244 }, 2);
		expect(progress.path).toHaveLength(1);
		appendPath(progress, { lat: 14.55472, lng: 121.0244 }, 3);
		expect(progress.path).toHaveLength(2);
		expect(progress.path[1][0]).toBe(round5(14.55472));
	});

	it('advances levels with explored cells', () => {
		expect(levelFor(0).name).toBe('Mistwalker');
		expect(levelFor(25).name).toBe('Pathfinder');
		expect(levelFor(4000).name).toBe('Atlas');
		expect(levelFor(4000).progress).toBe(1);
	});

	it('formats distance, area, and duration', () => {
		expect(formatDistance(500)).toBe('500 m');
		expect(formatDistance(1500)).toBe('1.50 km');
		expect(formatDistance(1609.344, 'imperial')).toBe('1.00 mi');
		expect(formatArea(144)).toBe('144 m²');
		expect(formatDuration(90_000)).toBe('2 min');
	});
});
