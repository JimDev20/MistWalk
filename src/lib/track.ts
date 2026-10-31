/* MistWalk track interchange — private GPX and GeoJSON import/export. */

import { cellCenter, MAX_SESSION_POINTS, parseCellKey } from './core.ts';
import type { PathPoint, Progress } from './types.ts';

interface Track {
	name: string;
	path: PathPoint[];
	session?: Progress['sessions'][number];
}

function escapeXml(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function isoTime(value: unknown): string {
	const date = new Date(Number(value));
	return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function cleanPath(path: unknown): PathPoint[] {
	if (!Array.isArray(path)) return [];
	return path
		.filter(
			(point) =>
				Array.isArray(point) &&
				Number.isFinite(Number(point[0])) &&
				Number.isFinite(Number(point[1]))
		)
		.map((point): PathPoint => [Number(point[0]), Number(point[1]), Number(point[2]) || 0])
		.slice(-MAX_SESSION_POINTS);
}

function tracksFor(progress: Progress): Track[] {
	const tracks: Track[] = [];
	if (progress?.path?.length >= 2) {
		tracks.push({ name: 'Recent trail', path: cleanPath(progress.path) });
	}
	for (const session of progress?.sessions || []) {
		const path = cleanPath(session.path);
		if (path.length < 2) continue;
		tracks.push({
			name: `${session.profile === 'demo' ? 'Simulator' : 'Walk'} ${new Date(session.startedAt || 0).toLocaleString()}`,
			path,
			session
		});
	}
	return tracks;
}

export function buildGpx(
	progress: Progress,
	{ name = 'MistWalk journey' }: { name?: string } = {}
) {
	const tracks = tracksFor(progress);
	const now = new Date().toISOString();
	const parts = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<gpx version="1.1" creator="MistWalk" xmlns="http://www.topografix.com/GPX/1/1">',
		`<metadata><name>${escapeXml(name)}</name><time>${now}</time></metadata>`
	];
	for (const track of tracks) {
		parts.push(`<trk><name>${escapeXml(track.name)}</name><type>walking</type><trkseg>`);
		for (const point of track.path) {
			const time = isoTime(point[2]);
			parts.push(
				`<trkpt lat="${point[0]}" lon="${point[1]}">${time ? `<time>${time}</time>` : ''}</trkpt>`
			);
		}
		parts.push('</trkseg></trk>');
	}
	parts.push('</gpx>');
	return parts.join('\n');
}

export function buildGeoJSON(
	progress: Progress,
	{ name = 'MistWalk journey' }: { name?: string } = {}
) {
	const features: Record<string, unknown>[] = [];
	for (const track of tracksFor(progress)) {
		features.push({
			type: 'Feature',
			properties: {
				name: track.name,
				profile: track.session?.profile || 'live',
				startedAt: track.session?.startedAt || null,
				distance: track.session?.distance || null
			},
			geometry: {
				type: 'LineString',
				coordinates: track.path.map((point) => [point[1], point[0]])
			}
		});
	}
	for (const [key, note] of Object.entries(progress?.notes || {})) {
		const cell = parseCellKey(key);
		if (!cell) continue;
		const center = cellCenter(cell);
		features.push({
			type: 'Feature',
			properties: { name: 'Tile note', note: note.text, updatedAt: note.t || null },
			geometry: { type: 'Point', coordinates: [center.lng, center.lat] }
		});
	}
	return { type: 'FeatureCollection', name, features };
}

function parseGeoJson(raw: unknown): PathPoint[] {
	const rows: PathPoint[] = [];
	const addLine = (coordinates: unknown) => {
		if (!Array.isArray(coordinates)) return;
		for (const pair of coordinates) {
			if (!Array.isArray(pair) || pair.length < 2) continue;
			rows.push([Number(pair[1]), Number(pair[0]), 0]);
		}
	};
	const visit = (item: unknown) => {
		if (!item || typeof item !== 'object') return;
		const node = item as {
			type?: unknown;
			features?: unknown;
			geometry?: unknown;
			coordinates?: unknown;
		};
		if (node.type === 'FeatureCollection') {
			const features = Array.isArray(node.features) ? node.features : [];
			for (const feature of features) visit(feature);
			return;
		}
		if (node.type === 'Feature') {
			visit(node.geometry);
			return;
		}
		if (node.type === 'LineString') addLine(node.coordinates);
		else if (node.type === 'MultiLineString') {
			const lines = Array.isArray(node.coordinates) ? node.coordinates : [];
			for (const line of lines) addLine(line);
		} else if (Array.isArray(node.coordinates)) addLine(node.coordinates);
	};
	visit(raw);
	return rows;
}

function parseGpx(text: string): PathPoint[] {
	const rows: PathPoint[] = [];
	const pointPattern = /<(trkpt|rtept)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
	let match: RegExpExecArray | null;
	while ((match = pointPattern.exec(text))) {
		const attrs = match[2];
		const lat = Number(attrs.match(/\blat=["']([^"']+)["']/i)?.[1]);
		const lng = Number(attrs.match(/\blon=["']([^"']+)["']/i)?.[1]);
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
		const timeText = match[3].match(/<time>([^<]+)<\/time>/i)?.[1];
		const time = timeText ? Date.parse(timeText) : 0;
		rows.push([lat, lng, Number.isFinite(time) ? time : 0]);
	}
	return rows;
}

export function parseTrackFile(text: unknown, filename = '') {
	const source = String(text || '').trim();
	if (!source) throw new Error('That track file is empty.');
	const lower = filename.toLowerCase();
	let points: PathPoint[];
	if (lower.endsWith('.gpx') || source.startsWith('<')) {
		points = parseGpx(source);
	} else {
		let parsed;
		try {
			parsed = JSON.parse(source);
		} catch {
			throw new Error('This is not a GPX or GeoJSON track.');
		}
		if (parsed?.app === 'MistWalk') {
			throw new Error('This is a MistWalk backup. Use Restore backup instead.');
		}
		points = parseGeoJson(parsed);
	}
	points = cleanPath(points).slice(0, MAX_SESSION_POINTS);
	if (points.length < 2)
		throw new Error('That file does not contain a route with two or more points.');
	const fallback = Date.now();
	let last = fallback - points.length * 1000;
	for (const point of points) {
		if (!point[2]) last += 1000;
		else last = point[2];
		if (!point[2]) point[2] = last;
	}
	return {
		name: filename.replace(/\.[^.]+$/, '') || 'Imported track',
		points
	};
}

export function pathToGeoJsonFeature(points: unknown, name = 'Imported track') {
	return {
		type: 'Feature',
		properties: { name },
		geometry: {
			type: 'LineString',
			coordinates: cleanPath(points).map((point) => [point[1], point[0]])
		}
	};
}
