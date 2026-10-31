import { describe, expect, it } from 'vitest';
import {
	cellFromLatLng,
	createProgress,
	levelFor,
	progressStats,
	setCellNote,
	unlockCells
} from './core.ts';
import {
	achievementsFor,
	buildChallengeUrl,
	challengeFromUrl,
	challengeProgress,
	compassLabel,
	gpsQuality,
	nearestUnexplored,
	suggestedChallengeTarget
} from './features.ts';

describe('features', () => {
	it('awards achievements from progress and notes', () => {
		const progress = createProgress();
		const cell = cellFromLatLng(14.5547, 121.0244);
		unlockCells(progress, [cell], 1);
		setCellNote(progress, cell.key, 'A landmark', 2);
		progress.stats.distance = 1200;
		progress.stats.sessions = 1;
		const achievements = achievementsFor(progress);
		expect(achievements.find((item) => item.id === 'first-light')?.earned).toBe(true);
		expect(achievements.find((item) => item.id === 'first-km')?.earned).toBe(true);
		expect(achievements.find((item) => item.id === 'note-one')?.earned).toBe(true);
		expect(achievements.find((item) => item.id === 'pathfinder')?.earned).toBe(false);
	});

	it('finds the nearest unexplored cell and its bearing', () => {
		const progress = createProgress();
		const origin = { lat: 14.5547, lng: 121.0244 };
		const first = nearestUnexplored(progress, origin);
		expect(first).not.toBeNull();
		expect(first!.distance).toBe(0);
		expect(first!.bearing).toBeNull();

		unlockCells(progress, [cellFromLatLng(origin.lat, origin.lng)], 1);
		const next = nearestUnexplored(progress, origin);
		expect(next).not.toBeNull();
		expect(next!.key).not.toBe(first!.key);
		expect(next!.distance).toBeGreaterThan(0);
		expect(next!.bearing).not.toBeNull();
		expect(compassLabel(next!.bearing)).not.toBe('—');
	});

	it('summarizes GPS quality states', () => {
		expect(gpsQuality({ source: 'sim' }).level).toBe('sim');
		expect(gpsQuality({ tracking: 'locating' }).level).toBe('searching');
		expect(gpsQuality({ accuracy: 5 }).level).toBe('excellent');
		expect(gpsQuality({ accuracy: 30 }).level).toBe('fair');
		expect(gpsQuality({ accuracy: 80 }).level).toBe('poor');
		expect(gpsQuality({ accuracy: 8, ageMs: 60_000 }).level).toBe('stale');
	});

	it('parses, builds, and tracks local challenges', () => {
		const challenge = challengeFromUrl('?challenge=1&target=250&title=Mist%20Run');
		expect(challenge).toEqual({ title: 'Mist Run', target: 250, metric: 'cellCount' });
		expect(challengeFromUrl('?target=250')).toBeNull();
		expect(challengeFromUrl('?challenge=1&target=0')).toBeNull();

		const url = buildChallengeUrl('https://example.com/mistwalk?old=1#hash', challenge!);
		expect(url).toBe('https://example.com/mistwalk?challenge=1&target=250&title=Mist+Run');

		const progress = createProgress();
		progress.stats.unlocks = 100;
		const info = challengeProgress(progressStats(progress), challenge);
		expect(info).not.toBeNull();
		expect(info!.current).toBe(0);
		expect(info!.remaining).toBe(250);
		expect(info!.complete).toBe(false);
		const summary = { ...progressStats(progress), cellCount: 300 };
		expect(challengeProgress(summary, challenge)!.percent).toBe(100);
	});

	it('suggests the next level target for a challenge', () => {
		const summary = progressStats(createProgress());
		expect(suggestedChallengeTarget(summary, levelFor(30))).toBe(100);
		expect(suggestedChallengeTarget(null, null)).toBe(100);
	});
});
