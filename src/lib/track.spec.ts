import { describe, expect, it } from 'vitest';
import { cellFromLatLng, createProgress } from './core.ts';
import { buildGeoJSON, buildGpx, parseTrackFile, pathToGeoJsonFeature } from './track.ts';

function sampleProgress() {
	const progress = createProgress();
	progress.sessions.push({
		id: 'walk-1',
		startedAt: 1_700_000_000_000,
		endedAt: 1_700_000_100_000,
		distance: 120,
		walkingMs: 90_000,
		unlocks: 4,
		profile: 'live',
		path: [
			[14.5547, 121.0244, 1_700_000_000_000],
			[14.5548, 121.0245, 1_700_000_100_000]
		]
	});
	const cell = cellFromLatLng(14.5547, 121.0244);
	progress.notes[cell.key] = { text: 'A landmark', t: 1_700_000_200_000 };
	progress.places[cell.key] = {
		lat: 14.5547,
		lng: 121.0244,
		rating: 4,
		name: 'Bench with a view',
		comment: 'Quiet at sunrise',
		t: 1_700_000_300_000
	};
	return progress;
}

describe('track interchange', () => {
	it('exports GPX and reads it back', () => {
		const gpx = buildGpx(sampleProgress());
		expect(gpx).toContain('<gpx');
		expect(gpx).toContain('<trkpt lat="14.5547" lon="121.0244">');
		const parsed = parseTrackFile(gpx, 'morning.gpx');
		expect(parsed.name).toBe('morning');
		expect(parsed.points).toHaveLength(2);
		expect(parsed.points[0][0]).toBeCloseTo(14.5547, 6);
	});

	it('exports GeoJSON with notes, places, and imports line features', () => {
		const geojson = buildGeoJSON(sampleProgress());
		expect(geojson.features).toHaveLength(3);
		const [line, note, place] = geojson.features as Array<{
			geometry: { type: string; coordinates: number[] };
			properties: Record<string, unknown>;
		}>;
		expect(line.geometry.type).toBe('LineString');
		expect(note.geometry.type).toBe('Point');
		expect(place.geometry.type).toBe('Point');
		expect(place.properties).toMatchObject({
			name: 'Bench with a view',
			rating: 4,
			comment: 'Quiet at sunrise'
		});
		expect(place.geometry.coordinates).toEqual([121.0244, 14.5547]);
		const parsed = parseTrackFile(JSON.stringify(geojson), 'journey.geojson');
		expect(parsed.points).toHaveLength(2);
	});

	it('rejects backups, empty files, and short routes', () => {
		expect(() => parseTrackFile('', 'empty.gpx')).toThrow('empty');
		expect(() => parseTrackFile('{"app":"MistWalk"}', 'backup.json')).toThrow('backup');
		expect(() =>
			parseTrackFile(
				JSON.stringify({ type: 'LineString', coordinates: [[121.0244, 14.5547]] }),
				'short.geojson'
			)
		).toThrow('two or more points');
	});

	it('builds a GeoJSON feature from a path', () => {
		const feature = pathToGeoJsonFeature(
			[
				[14.5547, 121.0244, 0],
				[14.5548, 121.0245, 0]
			],
			'Imported'
		);
		expect(feature.properties.name).toBe('Imported');
		expect(feature.geometry.coordinates[0]).toEqual([121.0244, 14.5547]);
	});
});
