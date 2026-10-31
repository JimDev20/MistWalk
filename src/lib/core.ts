/* MistWalk core — pure, testable geography, walking gate, and progress logic. */

import type {
	ActiveSession,
	ArchivedSession,
	CellBounds,
	FixInput,
	GridCell,
	LatLng,
	Level,
	LevelDefinition,
	NormalizedFix,
	NoteItem,
	PathPoint,
	Progress,
	ProgressSummary,
	Units,
	Verdict
} from './types.ts';

export const EARTH_RADIUS_M = 6378137;
export const MAX_MERCATOR_LAT = 85.05112878;
export const CELL_SIZE_M = 12;
export const WALK_LIMIT_MPS = 3.0; // ~10.8 km/h: a very brisk walk
export const VEHICLE_LIMIT_MPS = 4.2; // ~15 km/h: anything faster cannot unlock
export const UNLOCK_ACCURACY_M = 35;
export const VEHICLE_LOCKOUT_MS = 45_000;
export const PATH_STEP_M = 4;
export const MAX_PATH_POINTS = 12_000;
export const PROGRESS_VERSION = 3;
export const MAX_SESSION_POINTS = 4_000;
export const MAX_SESSIONS = 60;
export const MAX_NOTE_LENGTH = 280;

/* ------------------------------------------------------------------ */
/* Web Mercator helpers                                                */
/* ------------------------------------------------------------------ */

export function clampLat(lat: number): number {
	return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
}

export function normalizeLng(lng: number): number {
	const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
	return wrapped === -180 ? 180 : wrapped;
}

export function projectMeters(lat: number, lng: number): { x: number; y: number } {
	const safeLat = clampLat(lat);
	return {
		x: (EARTH_RADIUS_M * (normalizeLng(lng) * Math.PI)) / 180,
		y: EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (safeLat * Math.PI) / 360))
	};
}

export function unprojectMeters(x: number, y: number): LatLng {
	return {
		lat: ((2 * Math.atan(Math.exp(y / EARTH_RADIUS_M)) - Math.PI / 2) * 180) / Math.PI,
		lng: ((x / EARTH_RADIUS_M) * 180) / Math.PI
	};
}

/* ------------------------------------------------------------------ */
/* The 12-metre grid                                                   */
/* ------------------------------------------------------------------ */

export function cellKey(x: number, y: number): string {
	return `${x.toString(36)}_${y.toString(36)}`;
}

export function parseCellKey(key: unknown): GridCell | null {
	if (typeof key !== 'string') return null;
	const parts = key.split('_');
	if (parts.length !== 2) return null;
	const x = parseInt(parts[0], 36);
	const y = parseInt(parts[1], 36);
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
	return { x, y, key };
}

export function cellFromLatLng(lat: number, lng: number, size = CELL_SIZE_M): GridCell {
	const { x, y } = projectMeters(lat, lng);
	const cx = Math.floor(x / size);
	const cy = Math.floor(y / size);
	return { x: cx, y: cy, key: cellKey(cx, cy) };
}

export function cellFromKey(key: unknown): GridCell | null {
	return parseCellKey(key);
}

export function cellToBounds(cell: Pick<GridCell, 'x' | 'y'>, size = CELL_SIZE_M): CellBounds {
	const nw = unprojectMeters(cell.x * size, (cell.y + 1) * size);
	const se = unprojectMeters((cell.x + 1) * size, cell.y * size);
	return {
		west: nw.lng,
		north: nw.lat,
		east: se.lng,
		south: se.lat
	};
}

export function cellCenter(cell: Pick<GridCell, 'x' | 'y'>, size = CELL_SIZE_M): LatLng {
	return unprojectMeters((cell.x + 0.5) * size, (cell.y + 0.5) * size);
}

export function cellCorners(cell: Pick<GridCell, 'x' | 'y'>, size = CELL_SIZE_M): LatLng[] {
	const b = cellToBounds(cell, size);
	return [
		{ lat: b.north, lng: b.west },
		{ lat: b.north, lng: b.east },
		{ lat: b.south, lng: b.east },
		{ lat: b.south, lng: b.west }
	];
}

/** Approximate ground area of one cell at a given latitude. */
export function cellAreaM2(lat: number, size = CELL_SIZE_M): number {
	const safe = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, Math.abs(lat)));
	const scale = Math.cos((safe * Math.PI) / 180);
	return size * size * scale * scale;
}

/* ------------------------------------------------------------------ */
/* Distance / bearing                                                  */
/* ------------------------------------------------------------------ */

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export function haversineMeters(a: LatLng, b: LatLng): number {
	const dLat = toRad(b.lat - a.lat);
	const dLng = toRad(b.lng - a.lng);
	const lat1 = toRad(a.lat);
	const lat2 = toRad(b.lat);
	const sinLat = Math.sin(dLat / 2);
	const sinLng = Math.sin(dLng / 2);
	const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDegrees(a: LatLng, b: LatLng): number {
	const lat1 = toRad(a.lat);
	const lat2 = toRad(b.lat);
	const dLng = toRad(b.lng - a.lng);
	const y = Math.sin(dLng) * Math.cos(lat2);
	const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
	return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Interpolate a great-circle-ish line into points no more than stepM apart. */
export function interpolatePoints(from: LatLng, to: LatLng, stepM = PATH_STEP_M): LatLng[] {
	if (!from || !to) return [];
	const total = haversineMeters(from, to);
	if (!Number.isFinite(total) || total < 0.01) return [{ ...to }];
	if (total > 250) return [{ ...to }];
	const steps = Math.max(1, Math.ceil(total / Math.max(1, stepM)));
	const points = [];
	for (let i = 1; i <= steps; i += 1) {
		const f = i / steps;
		points.push({
			lat: from.lat + (to.lat - from.lat) * f,
			lng: from.lng + (to.lng - from.lng) * f
		});
	}
	return points;
}

export function cellsAlongLine(from: LatLng, to: LatLng, stepM = 5): GridCell[] {
	const seen = new Set();
	const cells = [];
	for (const point of interpolatePoints(from, to, stepM)) {
		const cell = cellFromLatLng(point.lat, point.lng);
		if (!seen.has(cell.key)) {
			seen.add(cell.key);
			cells.push(cell);
		}
	}
	return cells;
}

/* ------------------------------------------------------------------ */
/* Walking-only gate                                                   */
/* ------------------------------------------------------------------ */

export function normalizeFix(input: FixInput | null | undefined): NormalizedFix | null {
	if (!input || typeof input !== 'object') return null;
	const lat = Number(input.lat);
	const lng = Number(input.lng);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
	const accuracy = Number.isFinite(Number(input.accuracy))
		? Math.max(0, Number(input.accuracy))
		: null;
	const t = Number.isFinite(Number(input.t)) ? Number(input.t) : Date.now();
	let speed = null;
	if (input.speed !== null && input.speed !== undefined && Number.isFinite(Number(input.speed))) {
		const s = Number(input.speed);
		if (s >= 0 && s < 120) speed = s;
	}
	let heading = null;
	if (
		input.heading !== null &&
		input.heading !== undefined &&
		Number.isFinite(Number(input.heading))
	) {
		const h = Number(input.heading);
		if (h >= 0 && h < 360) heading = h;
	}
	return { lat, lng, accuracy, t, speed, heading };
}

/**
 * Stateful gate. Feed it every geolocation fix. It returns whether movement may
 * unlock cells, whether the user appears to be in a vehicle, and the distance
 * that should count toward walking statistics.
 */
export class WalkGate {
	limit: number;
	vehicleLimit: number;
	maxAccuracy: number;
	lockoutMs: number;
	lastFix: NormalizedFix | null;
	lastUnlockFix: NormalizedFix | null;
	vehicleUntil: number;
	calmFixes: number;
	lastReason: string;

	constructor({
		limit = WALK_LIMIT_MPS,
		vehicleLimit = VEHICLE_LIMIT_MPS,
		maxAccuracy = UNLOCK_ACCURACY_M,
		lockoutMs = VEHICLE_LOCKOUT_MS
	}: {
		limit?: number;
		vehicleLimit?: number;
		maxAccuracy?: number;
		lockoutMs?: number;
	} = {}) {
		this.limit = limit;
		this.vehicleLimit = vehicleLimit;
		this.maxAccuracy = maxAccuracy;
		this.lockoutMs = lockoutMs;
		this.lastFix = null;
		this.lastUnlockFix = null;
		this.vehicleUntil = 0;
		this.calmFixes = 0;
		this.lastReason = 'ready';
	}

	reset() {
		this.lastFix = null;
		this.lastUnlockFix = null;
		this.vehicleUntil = 0;
		this.calmFixes = 0;
		this.lastReason = 'ready';
	}

	/** Used when the page resumes: do not bridge a large gap. */
	reanchor() {
		// Start clean. The next fix is treated as a first fix and can only unlock
		// the tile it lands in — never a corridor from the old location.
		this.lastFix = null;
		this.lastUnlockFix = null;
		this.vehicleUntil = 0;
		this.calmFixes = 0;
	}

	evaluate(input: FixInput): Verdict {
		const fix = normalizeFix(input);
		if (!fix) {
			return {
				unlock: false,
				walking: false,
				reason: 'bad-fix',
				distance: 0,
				speed: null,
				vehicle: false,
				accuracyOk: false
			};
		}
		const accuracyOk = fix.accuracy === null || fix.accuracy <= this.maxAccuracy;

		if (!this.lastFix) {
			this.lastFix = fix;
			this.lastReason = accuracyOk ? 'first-fix' : 'weak-gps';
			this.lastUnlockFix = accuracyOk ? fix : null;
			return {
				unlock: accuracyOk,
				walking: true,
				reason: this.lastReason,
				distance: 0,
				speed: 0,
				from: fix,
				to: fix,
				vehicle: false,
				accuracyOk
			};
		}

		const dt = (fix.t - this.lastFix.t) / 1000;
		if (dt < 0.15) {
			return {
				unlock: false,
				walking: false,
				reason: 'duplicate',
				distance: 0,
				speed: null,
				vehicle: false,
				accuracyOk
			};
		}

		const distance = haversineMeters(this.lastFix, fix);
		const rawSpeed = distance / dt;
		const reportedSpeed = fix.speed;
		const now = fix.t;

		// A long gap can hide a car journey. Never bridge it.
		if (dt > 120 && distance > 100) {
			this.lastFix = fix;
			// Anchor at the new place. Never let the next walk retroactively unlock
			// the road that was crossed during the gap.
			this.lastUnlockFix = fix;
			this.lastReason = 'resume-jump';
			return {
				unlock: false,
				walking: false,
				reason: 'resume-jump',
				distance: 0,
				speed: rawSpeed,
				vehicle: false,
				accuracyOk
			};
		}

		if (distance > 300 && dt < 60) {
			this.lastFix = fix;
			this.lastUnlockFix = fix;
			this.lastReason = 'gps-jump';
			return {
				unlock: false,
				walking: false,
				reason: 'gps-jump',
				distance: 0,
				speed: rawSpeed,
				vehicle: false,
				accuracyOk
			};
		}

		const vehicleSuspected =
			(reportedSpeed !== null && reportedSpeed > this.vehicleLimit) ||
			(rawSpeed > this.vehicleLimit && distance > 8 && accuracyOk) ||
			(distance > 400 && dt < 120);

		if (vehicleSuspected) {
			this.vehicleUntil = now + this.lockoutMs;
			this.calmFixes = 0;
			this.lastFix = fix;
			// The vehicle's route must never become a walked corridor later.
			this.lastUnlockFix = fix;
			this.lastReason = 'too-fast';
			return {
				unlock: false,
				walking: false,
				reason: 'too-fast',
				distance: 0,
				speed: reportedSpeed ?? rawSpeed,
				vehicle: true,
				accuracyOk
			};
		}

		if (now < this.vehicleUntil) {
			const calm =
				rawSpeed >= 0.25 &&
				rawSpeed <= 2.2 &&
				(reportedSpeed === null || reportedSpeed <= 2.5) &&
				distance >= 0.25 &&
				distance < 15;
			this.calmFixes = calm ? this.calmFixes + 1 : 0;
			this.lastFix = fix;
			// Move the unlock anchor with the vehicle, not with the last footstep.
			this.lastUnlockFix = fix;
			if (this.calmFixes < 3) {
				this.lastReason = 'vehicle-lockout';
				return {
					unlock: false,
					walking: false,
					reason: 'vehicle-lockout',
					distance: 0,
					speed: reportedSpeed ?? rawSpeed,
					vehicle: true,
					accuracyOk
				};
			}
			// Three calm fixes in a row: assume the walk resumed.
			this.vehicleUntil = 0;
			this.calmFixes = 0;
		}

		const tooFastForWalk =
			(reportedSpeed !== null && reportedSpeed > this.limit) ||
			(accuracyOk && rawSpeed > this.limit);

		if (tooFastForWalk) {
			this.lastFix = fix;
			this.lastUnlockFix = fix;
			this.lastReason = 'too-fast';
			return {
				unlock: false,
				walking: false,
				reason: 'too-fast',
				distance: 0,
				speed: reportedSpeed ?? rawSpeed,
				from: fix,
				to: fix,
				vehicle: false,
				accuracyOk
			};
		}

		// Only interpolate from a trusted (walking) anchor. If none exists, the
		// current fix can unlock its own tile and nothing behind it.
		const from = this.lastUnlockFix || fix;
		this.lastFix = fix;

		if (distance < 0.8) {
			this.lastReason = accuracyOk ? 'stationary' : 'weak-gps';
			if (accuracyOk) this.lastUnlockFix = fix;
			return {
				unlock: accuracyOk,
				walking: true,
				reason: this.lastReason,
				distance: 0,
				speed: 0,
				from,
				to: fix,
				vehicle: false,
				accuracyOk
			};
		}

		if (!accuracyOk) {
			this.lastReason = 'weak-gps';
			return {
				unlock: false,
				walking: true,
				reason: 'weak-gps',
				distance: 0,
				speed: rawSpeed,
				from,
				to: fix,
				vehicle: false,
				accuracyOk
			};
		}

		this.lastUnlockFix = fix;
		this.lastReason = 'walking';
		return {
			unlock: true,
			walking: true,
			reason: 'walking',
			distance,
			speed: reportedSpeed ?? rawSpeed,
			from,
			to: fix,
			vehicle: false,
			accuracyOk
		};
	}
}

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

export function createProgress(): Progress {
	return {
		version: PROGRESS_VERSION,
		cells: {},
		path: [],
		sessions: [],
		notes: {},
		stats: {
			distance: 0,
			walkingMs: 0,
			sessions: 0,
			unlocks: 0,
			startedAt: Date.now(),
			lastWalkAt: 0
		},
		last: null,
		settings: {
			units: 'metric',
			sound: true,
			haptics: true,
			autoTrack: true,
			wakeLock: true
		}
	};
}

export function migrateProgress(raw: unknown): Progress {
	if (!raw || typeof raw !== 'object') return createProgress();
	const source = raw as Record<string, unknown>;
	const base = createProgress();
	const readPath = (value: unknown) =>
		Array.isArray(value)
			? (value.filter((point) => Array.isArray(point) && point.length >= 2) as Progress['path'])
			: [];
	const rawSessions = Array.isArray(source.sessions)
		? source.sessions
				.filter((session) => session && typeof session === 'object')
				.map((session): ArchivedSession => {
					const item = session as Record<string, unknown>;
					return {
						id: String(item.id || ''),
						startedAt: Number(item.startedAt) || 0,
						endedAt: Number(item.endedAt) || 0,
						distance: Math.max(0, Number(item.distance) || 0),
						walkingMs: Math.max(0, Number(item.walkingMs) || 0),
						unlocks: Math.max(0, Number(item.unlocks) || 0),
						profile: item.profile === 'demo' ? 'demo' : 'live',
						path: readPath(item.path).slice(-MAX_SESSION_POINTS)
					};
				})
		: [];
	const sessions = rawSessions.slice(-MAX_SESSIONS);
	const out: Progress = {
		...base,
		cells:
			source.cells && typeof source.cells === 'object' ? (source.cells as Progress['cells']) : {},
		path: readPath(source.path),
		sessions,
		notes: {},
		last:
			source.last && typeof source.last === 'object'
				? (source.last as Progress['last'])
				: base.last,
		stats:
			source.stats && typeof source.stats === 'object'
				? { ...base.stats, ...(source.stats as Partial<Progress['stats']>) }
				: base.stats,
		settings:
			source.settings && typeof source.settings === 'object'
				? { ...base.settings, ...(source.settings as Partial<Progress['settings']>) }
				: base.settings
	};
	if (source.notes && typeof source.notes === 'object') {
		for (const [key, note] of Object.entries(source.notes)) {
			if (!parseCellKey(key) || !note || typeof note !== 'object') continue;
			const data = note as { text?: unknown; t?: unknown };
			const text = String(data.text || '')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, MAX_NOTE_LENGTH);
			if (!text) continue;
			out.notes[key] = { text, t: Number(data.t) || 0 };
		}
	}
	out.version = base.version;
	if (!Number.isFinite(out.stats.distance)) out.stats.distance = 0;
	if (!Number.isFinite(out.stats.walkingMs)) out.stats.walkingMs = 0;
	if (!Number.isFinite(out.stats.unlocks)) out.stats.unlocks = Object.keys(out.cells).length;
	out.stats.sessions = Math.max(
		Number.isFinite(out.stats.sessions) ? out.stats.sessions : 0,
		rawSessions.length,
		out.sessions.length
	);
	return out;
}

export function unlockCells(
	progress: Progress,
	cells: GridCell[],
	t = Date.now(),
	source = 'gps'
): GridCell[] {
	const added: GridCell[] = [];
	for (const cell of cells) {
		if (!cell || !cell.key) continue;
		const existing = progress.cells[cell.key];
		if (!existing) {
			progress.cells[cell.key] = { t, n: 1, s: source };
			added.push(cell);
		} else {
			existing.n = (existing.n || 1) + 1;
			existing.lt = t;
		}
	}
	progress.stats.unlocks = Object.keys(progress.cells).length;
	return added;
}

export function appendPath(progress: Progress, point: LatLng, t: number): void {
	const path = progress.path;
	const last = path[path.length - 1];
	if (!last) {
		path.push([round5(point.lat), round5(point.lng), t]);
	} else {
		const prev = { lat: last[0], lng: last[1] };
		const gap = haversineMeters(prev, point);
		const age = t - (last[2] || 0);
		if (gap >= 2 || age >= 12_000) {
			path.push([round5(point.lat), round5(point.lng), t]);
		}
	}
	if (path.length > MAX_PATH_POINTS) {
		path.splice(0, path.length - MAX_PATH_POINTS);
	}
}

export function round5(value: number): number {
	return Math.round(value * 100000) / 100000;
}

export function appendSessionPoint(session: ActiveSession, point: LatLng, t = Date.now()): boolean {
	if (!session || !Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) return false;
	const path = (session.path ||= []);
	const last = path[path.length - 1];
	if (!last) {
		path.push([round5(point.lat), round5(point.lng), t]);
	} else {
		const gap = haversineMeters({ lat: last[0], lng: last[1] }, point);
		const age = t - (last[2] || 0);
		if (gap < PATH_STEP_M && age < 12_000) return false;
		path.push([round5(point.lat), round5(point.lng), t]);
	}
	if (path.length > MAX_SESSION_POINTS) path.splice(0, path.length - MAX_SESSION_POINTS);
	return true;
}

function mergeSessionPath(target: PathPoint[], source: PathPoint[]): PathPoint[] {
	const path = target.slice();
	for (const point of source) {
		if (!Array.isArray(point) || point.length < 2) continue;
		const last = path[path.length - 1];
		if (last && last[0] === point[0] && last[1] === point[1] && last[2] === point[2]) continue;
		path.push(point);
	}
	if (path.length > MAX_SESSION_POINTS) path.splice(0, path.length - MAX_SESSION_POINTS);
	return path;
}

export function groupSessionsByDay(sessions: ArchivedSession[]): ArchivedSession[] {
	const groups = new Map<string, ArchivedSession>();
	const ordered = [...sessions]
		.filter((session) => session && typeof session === 'object')
		.sort(
			(a, b) =>
				(Number(a.startedAt) || Number(a.endedAt) || 0) -
					(Number(b.startedAt) || Number(b.endedAt) || 0) ||
				(Number(a.endedAt) || 0) - (Number(b.endedAt) || 0)
		);
	for (const session of ordered) {
		const stamp = Number(session.startedAt) || Number(session.endedAt) || 0;
		const profile = session.profile === 'demo' ? 'demo' : 'live';
		const key = `${profile}:${dayKey(stamp)}`;
		const path = Array.isArray(session.path) ? session.path.slice(-MAX_SESSION_POINTS) : [];
		const existing = groups.get(key);
		if (!existing) {
			groups.set(key, {
				...session,
				startedAt: Number(session.startedAt) || stamp,
				endedAt: Number(session.endedAt) || stamp,
				distance: Math.max(0, Number(session.distance) || 0),
				walkingMs: Math.max(0, Number(session.walkingMs) || 0),
				unlocks: Math.max(0, Number(session.unlocks) || 0),
				profile,
				path
			});
			continue;
		}
		existing.startedAt = Math.min(existing.startedAt || stamp, stamp);
		existing.endedAt = Math.max(existing.endedAt || 0, Number(session.endedAt) || stamp);
		existing.distance += Math.max(0, Number(session.distance) || 0);
		existing.walkingMs += Math.max(0, Number(session.walkingMs) || 0);
		existing.unlocks += Math.max(0, Number(session.unlocks) || 0);
		existing.path = mergeSessionPath(existing.path, path);
	}
	return [...groups.values()].sort((a, b) => a.startedAt - b.startedAt || a.endedAt - b.endedAt);
}

export function archiveSession(
	progress: Progress,
	session: ActiveSession,
	endedAt = Date.now()
): ArchivedSession | null {
	if (!progress || !session || session.archived) return null;
	const path = Array.isArray(session.path) ? session.path.slice(-MAX_SESSION_POINTS) : [];
	const distance = Math.max(0, Number(session.distance) || 0);
	const unlocks = Math.max(0, Number(session.unlocks) || 0);
	session.archived = true;
	if (path.length < 2 && distance < 1 && unlocks < 1) return null;
	const startedAt = Number(session.startedAt) || Number(path[0]?.[2]) || endedAt;
	const record: ArchivedSession = {
		id: session.id || `walk-${endedAt.toString(36)}`,
		startedAt,
		endedAt,
		distance,
		walkingMs: Math.max(0, Number(session.walkingMs) || 0),
		unlocks,
		profile: session.profile === 'demo' ? 'demo' : 'live',
		path
	};
	const sessions = Array.isArray(progress.sessions) ? progress.sessions : [];
	sessions.push(record);
	progress.sessions = sessions.slice(-MAX_SESSIONS);
	progress.stats = progress.stats || {};
	progress.stats.sessions = (Number(progress.stats.sessions) || 0) + 1;
	return record;
}

export function normalizeNote(text: unknown): string {
	return String(text || '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_NOTE_LENGTH);
}

export function setCellNote(
	progress: Progress,
	key: string,
	text: unknown,
	t = Date.now()
): string {
	if (!progress || !parseCellKey(key)) return '';
	const value = normalizeNote(text);
	progress.notes = progress.notes && typeof progress.notes === 'object' ? progress.notes : {};
	if (!value) delete progress.notes[key];
	else progress.notes[key] = { text: value, t };
	return value;
}

export function listCellNotes(progress: Progress): NoteItem[] {
	const notes: NoteItem[] = [];
	if (!progress?.notes) return notes;
	for (const [key, note] of Object.entries(progress.notes)) {
		const cell = parseCellKey(key);
		if (!cell || !note?.text) continue;
		const center = cellCenter(cell);
		notes.push({ key, text: note.text, t: Number(note.t) || 0, lat: center.lat, lng: center.lng });
	}
	return notes.sort((a, b) => b.t - a.t);
}

export function progressStats(progress: Progress): ProgressSummary {
	const cells = Object.entries(progress.cells || {});
	let area = 0;
	let visits = 0;
	let favoriteCells = 0;
	let maxVisits = 0;
	const days = new Set<string>();
	let firstAt: number | null = null;
	let lastAt: number | null = null;
	for (const [key, meta] of cells) {
		const cell = parseCellKey(key);
		if (!cell) continue;
		const center = cellCenter(cell);
		area += cellAreaM2(center.lat);
		const count = Math.max(1, Number(meta?.n) || 1);
		visits += count;
		maxVisits = Math.max(maxVisits, count);
		if (count >= 2) favoriteCells += 1;
		if (meta && Number.isFinite(meta.t)) {
			const day = dayKey(meta.t);
			days.add(day);
			if (firstAt === null || meta.t < firstAt) firstAt = meta.t;
			if (lastAt === null || meta.t > lastAt) lastAt = meta.t;
		}
	}
	const orderedDays = [...days].sort();
	let streak = 0;
	if (orderedDays.length) {
		const today = dayKey(Date.now());
		const yesterday = dayKey(Date.now() - 86_400_000);
		const lastDay = orderedDays[orderedDays.length - 1];
		if (lastDay === today || lastDay === yesterday) {
			streak = 1;
			for (let i = orderedDays.length - 1; i > 0; i -= 1) {
				const a = new Date(`${orderedDays[i]}T12:00:00`);
				const b = new Date(`${orderedDays[i - 1]}T12:00:00`);
				if (Math.round((a.getTime() - b.getTime()) / 86_400_000) === 1) streak += 1;
				else break;
			}
		}
	}
	const count = cells.length;
	const level = levelFor(count);
	return {
		cellCount: count,
		areaM2: area,
		visits,
		favoriteCells,
		maxVisits,
		archivedSessions: Array.isArray(progress.sessions) ? progress.sessions.length : 0,
		sessions: Number(progress.stats.sessions) || 0,
		notes:
			progress.notes && typeof progress.notes === 'object' ? Object.keys(progress.notes).length : 0,
		days: orderedDays.length,
		streak,
		firstAt,
		lastAt,
		level,
		distance: progress.stats.distance || 0,
		walkingMs: progress.stats.walkingMs || 0
	};
}

export const LEVELS: LevelDefinition[] = [
	{ min: 0, name: 'Mistwalker', tag: 'The map is still sleeping.' },
	{ min: 25, name: 'Pathfinder', tag: 'A trail is forming.' },
	{ min: 100, name: 'Wayfinder', tag: 'Streets remember you.' },
	{ min: 250, name: 'Trailblazer', tag: 'The fog is giving way.' },
	{ min: 600, name: 'Cartographer', tag: 'You are drawing a new world.' },
	{ min: 1500, name: 'Horizon Seeker', tag: 'No street is truly unknown.' },
	{ min: 4000, name: 'Atlas', tag: 'The mist answers to you.' }
];

export function levelFor(cellCount: number): Level {
	let index = 0;
	for (let i = 0; i < LEVELS.length; i += 1) {
		if (cellCount >= LEVELS[i].min) index = i;
	}
	const current = LEVELS[index];
	const next = LEVELS[index + 1] || null;
	const progress = next
		? Math.max(0, Math.min(1, (cellCount - current.min) / (next.min - current.min)))
		: 1;
	return { ...current, index, next, progress };
}

export function dayKey(t: number): string {
	const d = new Date(t);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function formatDistance(meters: number, units: Units = 'metric'): string {
	if (!Number.isFinite(meters)) meters = 0;
	if (units === 'imperial') {
		const feet = meters * 3.28084;
		if (feet < 1000) return `${Math.round(feet)} ft`;
		return `${(feet / 5280).toFixed(feet / 5280 >= 10 ? 1 : 2)} mi`;
	}
	if (meters < 1000) return `${Math.round(meters)} m`;
	return `${(meters / 1000).toFixed(meters / 1000 >= 10 ? 1 : 2)} km`;
}

export function formatArea(m2: number, units: Units = 'metric'): string {
	if (!Number.isFinite(m2)) m2 = 0;
	if (units === 'imperial') {
		const ft2 = m2 * 10.7639;
		if (ft2 < 43560) return `${Math.round(ft2).toLocaleString()} ft²`;
		return `${(ft2 / 43560).toFixed(2)} acres`;
	}
	if (m2 < 10_000) return `${Math.round(m2).toLocaleString()} m²`;
	return `${(m2 / 1_000_000).toFixed(m2 / 1_000_000 >= 10 ? 1 : 2)} km²`;
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return '0 min';
	const totalMinutes = Math.round(ms / 60_000);
	if (totalMinutes < 1) return '<1 min';
	if (totalMinutes < 60) return `${totalMinutes} min`;
	const h = Math.floor(totalMinutes / 60);
	const m = totalMinutes % 60;
	return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatClock(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = totalSeconds % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatCoordinate(lat: number, lng: number, digits = 5): string {
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '—';
	const ns = lat >= 0 ? 'N' : 'S';
	const ew = lng >= 0 ? 'E' : 'W';
	return `${Math.abs(lat).toFixed(digits)}° ${ns}  ${Math.abs(lng).toFixed(digits)}° ${ew}`;
}

export function formatSpeed(mps: number, units: Units = 'metric'): string {
	if (!Number.isFinite(mps) || mps < 0.05) return '0.0';
	if (units === 'imperial') return (mps * 2.23694).toFixed(1);
	return (mps * 3.6).toFixed(1);
}

export function speedUnit(units: Units = 'metric'): string {
	return units === 'imperial' ? 'mph' : 'km/h';
}

/** Convert viewport screen points back to a geographic line, clipped to bounds. */
export function cellIsInBounds(
	cell: Pick<GridCell, 'x' | 'y'>,
	bounds: CellBounds,
	size = CELL_SIZE_M
): boolean {
	const b = cellToBounds(cell, size);
	return !(
		b.east < bounds.west ||
		b.west > bounds.east ||
		b.north < bounds.south ||
		b.south > bounds.north
	);
}

export function progressToPercent(cellCount: number, total = 1_000_000): number {
	return Math.min(100, (cellCount / total) * 100);
}
