import {
	bearingDegrees,
	cellCenter,
	cellFromLatLng,
	cellKey,
	haversineMeters,
	progressStats
} from './core.ts';
import type {
	Achievement,
	Challenge,
	ChallengeInfo,
	GpsQuality,
	GuideTarget,
	LatLng,
	Level,
	Progress,
	ProgressSummary
} from './types.ts';

const ACHIEVEMENT_DEFS = [
	{
		id: 'first-light',
		title: 'First light',
		detail: 'Reveal your first tile.',
		metric: 'cellCount',
		target: 1
	},
	{
		id: 'pathfinder',
		title: 'Pathfinder',
		detail: 'Reveal 25 tiles.',
		metric: 'cellCount',
		target: 25
	},
	{
		id: 'neighbour',
		title: 'Neighbour',
		detail: 'Reveal 100 tiles.',
		metric: 'cellCount',
		target: 100
	},
	{
		id: 'district',
		title: 'District',
		detail: 'Reveal 500 tiles.',
		metric: 'cellCount',
		target: 500
	},
	{
		id: 'cartographer',
		title: 'Cartographer',
		detail: 'Reveal 1,500 tiles.',
		metric: 'cellCount',
		target: 1500
	},
	{ id: 'atlas', title: 'Atlas', detail: 'Reveal 4,000 tiles.', metric: 'cellCount', target: 4000 },
	{
		id: 'first-walk',
		title: 'First walk',
		detail: 'Finish one walk.',
		metric: 'sessions',
		target: 1
	},
	{ id: 'regular', title: 'Regular', detail: 'Finish 10 walks.', metric: 'sessions', target: 10 },
	{
		id: 'centurion',
		title: 'Centurion',
		detail: 'Finish 50 walks.',
		metric: 'sessions',
		target: 50
	},
	{ id: 'spark', title: 'Spark', detail: 'Walk three days in a row.', metric: 'streak', target: 3 },
	{
		id: 'keeper',
		title: 'Keeper',
		detail: 'Walk seven days in a row.',
		metric: 'streak',
		target: 7
	},
	{
		id: 'undying',
		title: 'Undying',
		detail: 'Walk thirty days in a row.',
		metric: 'streak',
		target: 30
	},
	{
		id: 'first-km',
		title: 'First kilometre',
		detail: 'Walk 1 km.',
		metric: 'distance',
		target: 1000
	},
	{
		id: 'five-km',
		title: 'Five kilometres',
		detail: 'Walk 5 km.',
		metric: 'distance',
		target: 5000
	},
	{
		id: 'ten-km',
		title: 'Ten kilometres',
		detail: 'Walk 10 km.',
		metric: 'distance',
		target: 10000
	},
	{ id: 'marathon', title: 'Marathon', detail: 'Walk 42.2 km.', metric: 'distance', target: 42195 },
	{ id: 'century', title: 'Century', detail: 'Walk 100 km.', metric: 'distance', target: 100000 },
	{
		id: 'favorite-ten',
		title: 'Home ground',
		detail: 'Cross 10 tiles twice.',
		metric: 'favoriteCells',
		target: 10
	},
	{
		id: 'favorite-hundred',
		title: 'Deep roots',
		detail: 'Cross 100 tiles twice.',
		metric: 'favoriteCells',
		target: 100
	},
	{
		id: 'deep-roots',
		title: 'Old path',
		detail: 'Cross one tile five times.',
		metric: 'maxVisits',
		target: 5
	},
	{
		id: 'ancient-path',
		title: 'Ancient path',
		detail: 'Cross one tile 25 times.',
		metric: 'maxVisits',
		target: 25
	},
	{
		id: 'note-one',
		title: 'Note keeper',
		detail: 'Leave a note on a tile.',
		metric: 'notes',
		target: 1
	},
	{
		id: 'note-ten',
		title: 'Archivist',
		detail: 'Leave 10 tile notes.',
		metric: 'notes',
		target: 10
	}
];

export const ACHIEVEMENTS = Object.freeze(ACHIEVEMENT_DEFS);

export function achievementsFor(
	progress: Progress,
	stats: ProgressSummary = progressStats(progress)
): Achievement[] {
	const values: Record<string, number> = {
		cellCount: stats.cellCount || 0,
		sessions: Number(progress?.stats?.sessions) || 0,
		streak: stats.streak || 0,
		distance: stats.distance || 0,
		favoriteCells: stats.favoriteCells || 0,
		maxVisits: stats.maxVisits || 0,
		notes: stats.notes || 0
	};
	return ACHIEVEMENT_DEFS.map((def) => {
		const value = values[def.metric] || 0;
		return {
			...def,
			value,
			earned: value >= def.target,
			progress: Math.max(0, Math.min(1, value / def.target))
		};
	});
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function compassLabel(bearing: number | null | undefined): string {
	if (bearing === null || bearing === undefined || !Number.isFinite(bearing)) return '—';
	return COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

export function nearestUnexplored(
	progress: Progress,
	origin: LatLng,
	{ maxRings = 400 }: { maxRings?: number } = {}
): GuideTarget | null {
	if (!Number.isFinite(origin?.lat) || !Number.isFinite(origin?.lng)) return null;
	const cells = progress?.cells || {};
	const base = cellFromLatLng(origin.lat, origin.lng);
	const currentKey = cellKey(base.x, base.y);
	const currentCenter = cellCenter(base);
	if (!cells[currentKey]) {
		return {
			key: currentKey,
			lat: currentCenter.lat,
			lng: currentCenter.lng,
			distance: 0,
			bearing: null,
			rings: 0
		};
	}
	const radius = Math.max(1, Math.round(Number(maxRings) || 400));
	for (let rings = 1; rings <= radius; rings += 1) {
		let best: GuideTarget | null = null;
		for (let dx = -rings; dx <= rings; dx += 1) {
			for (let dy = -rings; dy <= rings; dy += 1) {
				if (Math.max(Math.abs(dx), Math.abs(dy)) !== rings) continue;
				const key = cellKey(base.x + dx, base.y + dy);
				if (cells[key]) continue;
				const center = cellCenter({ x: base.x + dx, y: base.y + dy });
				const distance = haversineMeters(origin, center);
				if (!best || distance < best.distance) {
					best = { key, lat: center.lat, lng: center.lng, distance, rings, bearing: null };
				}
			}
		}
		if (best) {
			best.bearing = bearingDegrees(origin, best);
			return best;
		}
	}
	return null;
}

export function gpsQuality({
	accuracy = null,
	ageMs = null,
	source = 'gps',
	tracking = 'idle'
}: {
	accuracy?: number | null;
	ageMs?: number | null;
	source?: string;
	tracking?: string;
} = {}): GpsQuality {
	if (source === 'sim') {
		return { level: 'sim', label: 'Simulated', detail: '±4 m virtual fix' };
	}
	if (tracking === 'locating') {
		return { level: 'searching', label: 'Searching', detail: 'Waiting for a fix' };
	}
	if (!Number.isFinite(accuracy)) {
		return { level: 'idle', label: 'No fix', detail: 'GPS is standing by' };
	}
	const metres = Math.max(1, Math.round(Number(accuracy)));
	const age = Number.isFinite(ageMs) ? Math.round(Number(ageMs) / 1000) : null;
	const ageDetail = age !== null && age > 8 ? ` · ${age}s ago` : '';
	if (age !== null && age > 45) {
		return { level: 'stale', label: 'Stale fix', detail: `±${metres} m · ${age}s ago` };
	}
	const safeAccuracy = Number(accuracy);
	if (safeAccuracy <= 10)
		return { level: 'excellent', label: 'Excellent', detail: `±${metres} m${ageDetail}` };
	if (safeAccuracy <= 20)
		return { level: 'good', label: 'Good', detail: `±${metres} m${ageDetail}` };
	if (safeAccuracy <= 35)
		return { level: 'fair', label: 'Fair', detail: `±${metres} m${ageDetail}` };
	if (safeAccuracy <= 60)
		return { level: 'weak', label: 'Weak', detail: `±${metres} m${ageDetail}` };
	return { level: 'poor', label: 'Poor', detail: `±${metres} m${ageDetail}` };
}

export function formatDistanceMeters(metres: number): string {
	const value = Number(metres) || 0;
	return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
}

export function challengeFromUrl(search = ''): Challenge | null {
	const params = new URLSearchParams(search);
	if (!params.has('challenge')) return null;
	const target = Math.round(Number(params.get('target')));
	if (!Number.isFinite(target) || target < 1 || target > 10_000_000) return null;
	const title = String(params.get('title') || 'Reveal the mist')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 48);
	return { title: title || 'Reveal the mist', target, metric: 'cellCount' };
}

export function buildChallengeUrl(
	baseUrl: string,
	{ target, title = 'Reveal the mist' }: { target: number; title?: string }
): string {
	const safeTarget = Math.max(1, Math.round(Number(target) || 0));
	const params = new URLSearchParams({
		challenge: '1',
		target: String(safeTarget),
		title: String(title || 'Reveal the mist')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 48)
	});
	return `${String(baseUrl || '').replace(/[?#].*$/, '')}?${params.toString()}`;
}

export function challengeProgress(
	stats: ProgressSummary | null | undefined,
	challenge: Challenge | null | undefined
): ChallengeInfo | null {
	if (!challenge) return null;
	const target = Math.max(1, Number(challenge.target) || 1);
	const current = Math.max(0, Number(stats?.cellCount) || 0);
	return {
		...challenge,
		current,
		remaining: Math.max(0, target - current),
		percent: Math.min(100, Math.round((current / target) * 100)),
		complete: current >= target
	};
}

export function suggestedChallengeTarget(
	stats: ProgressSummary | null | undefined,
	level: Level | null | undefined
): number {
	const next = Number(level?.next?.min);
	if (Number.isFinite(next) && next > 0) return next;
	return Math.max(100, (Number(stats?.cellCount) || 0) + 100);
}
