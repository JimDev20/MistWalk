/* MistWalk fog renderer — an opaque, textured mist with permanent cut-outs. */

import { cellCorners, cellFromLatLng, haversineMeters, parseCellKey } from './core.ts';
import type {
	CellBounds,
	CellMeta,
	GridCell,
	LatLng,
	NormalizedFix,
	PathPoint,
	ReplayState
} from './types.ts';

const TAU = Math.PI * 2;

interface Point {
	x: number;
	y: number;
}

type Project = (lat: number, lng: number) => Point | null;

interface Pulse {
	lat: number;
	lng: number;
	t: number;
}

interface PlaceMarker {
	key: string;
	lat: number;
	lng: number;
	rating: number;
}

interface FogStats {
	visible: number;
	drawn: number;
	favorites: number;
}

interface RenderFrame {
	project: Project;
	cells?: Record<string, CellMeta>;
	recent?: Map<string, number>;
	path?: PathPoint[];
	current?: NormalizedFix | null;
	target?: LatLng | null;
	guide?: LatLng | null;
	replay?: ReplayState | null;
	bounds?: CellBounds | null;
	time?: number;
	reducedMotion?: boolean;
	showGrid?: boolean;
	showFavorites?: boolean;
	places?: PlaceMarker[];
	highlightPlace?: string | null;
	pulses?: Pulse[];
	zoom?: number;
}

function makeNoiseCanvas(size = 160): HTMLCanvasElement {
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d');
	if (!ctx) return canvas;
	const image = ctx.createImageData(size, size);
	for (let i = 0; i < image.data.length; i += 4) {
		const v = 95 + Math.random() * 120;
		image.data[i] = v;
		image.data[i + 1] = v + 8;
		image.data[i + 2] = v + 20;
		image.data[i + 3] = Math.random() * 26;
	}
	ctx.putImageData(image, 0, 0);
	return canvas;
}

function polygon(ctx: CanvasRenderingContext2D, points: Point[] | null): boolean {
	if (!points || points.length < 3) return false;
	ctx.beginPath();
	ctx.moveTo(points[0].x, points[0].y);
	for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
	ctx.closePath();
	return true;
}

function starPath(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	outer: number,
	inner = outer * 0.45
): void {
	ctx.beginPath();
	for (let i = 0; i < 10; i += 1) {
		const radius = i % 2 === 0 ? outer : inner;
		const angle = -Math.PI / 2 + (i * Math.PI) / 5;
		const px = x + Math.cos(angle) * radius;
		const py = y + Math.sin(angle) * radius;
		if (i === 0) ctx.moveTo(px, py);
		else ctx.lineTo(px, py);
	}
	ctx.closePath();
}

function cellCornersScreen(project: Project, cell: GridCell): Point[] | null {
	const corners = cellCorners(cell);
	const out: Point[] = [];
	for (const c of corners) {
		const p = project(c.lat, c.lng);
		if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
		out.push(p);
	}
	return out;
}

/**
 * Draws the fog, explored holes, trail, location marker and simulator target.
 * All drawing is in CSS pixels; the canvas backing store handles DPR.
 */
export class FogRenderer {
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	mask: HTMLCanvasElement;
	maskCtx: CanvasRenderingContext2D;
	trail: HTMLCanvasElement;
	trailCtx: CanvasRenderingContext2D;
	noise: HTMLCanvasElement;
	noisePattern: CanvasPattern | null;
	width: number;
	height: number;
	dpr: number;
	cellRange: { minX: number; maxX: number; minY: number; maxY: number } | null;
	stats: FogStats;
	showGrid = true;
	showFavorites = true;

	constructor(canvas: HTMLCanvasElement) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d', { alpha: true })!;
		this.mask = document.createElement('canvas');
		this.maskCtx = this.mask.getContext('2d', { alpha: true })!;
		this.trail = document.createElement('canvas');
		this.trailCtx = this.trail.getContext('2d', { alpha: true })!;
		this.noise = makeNoiseCanvas(160);
		this.noisePattern = this.ctx.createPattern(this.noise, 'repeat');
		this.width = 0;
		this.height = 0;
		this.dpr = 1;
		this.cellRange = null;
		this.stats = { visible: 0, drawn: 0, favorites: 0 };
	}

	resize(width: number, height: number, dpr = 1): void {
		const w = Math.max(1, Math.round(width));
		const h = Math.max(1, Math.round(height));
		const ratio = Math.max(1, Math.min(2, dpr || 1));
		if (this.width === w && this.height === h && this.dpr === ratio) return;
		this.width = w;
		this.height = h;
		this.dpr = ratio;
		this.canvas.width = Math.round(w * ratio);
		this.canvas.height = Math.round(h * ratio);
		this.canvas.style.width = `${w}px`;
		this.canvas.style.height = `${h}px`;
		this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		this.mask.width = Math.round(w * ratio);
		this.mask.height = Math.round(h * ratio);
		this.maskCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
		this.trail.width = Math.round(w * ratio);
		this.trail.height = Math.round(h * ratio);
		this.trailCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
	}

	computeCellRange(
		bounds: CellBounds | null,
		margin = 2
	): { minX: number; maxX: number; minY: number; maxY: number } | null {
		if (!bounds) return null;
		const nw = cellFromLatLng(Math.min(85, bounds.north), bounds.west);
		const se = cellFromLatLng(Math.max(-85, bounds.south), bounds.east);
		const minX = Math.min(nw.x, se.x) - margin;
		const maxX = Math.max(nw.x, se.x) + margin;
		const minY = Math.min(nw.y, se.y) - margin;
		const maxY = Math.max(nw.y, se.y) + margin;
		// World views can be huge; that is fine because there will be few cells.
		if (maxX - minX > 40000 || maxY - minY > 40000) {
			return { minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity };
		}
		return { minX, maxX, minY, maxY };
	}

	isVisibleCell(cell: GridCell): boolean {
		const r = this.cellRange;
		if (!r) return true;
		return cell.x >= r.minX && cell.x <= r.maxX && cell.y >= r.minY && cell.y <= r.maxY;
	}

	drawFogBase(time: number): void {
		const { ctx, width: w, height: h } = this;
		ctx.globalCompositeOperation = 'source-over';
		ctx.clearRect(0, 0, w, h);

		const base = ctx.createLinearGradient(0, 0, 0, h);
		base.addColorStop(0, '#1c1c1c');
		base.addColorStop(0.55, '#131313');
		base.addColorStop(1, '#090909');
		ctx.fillStyle = base;
		ctx.fillRect(0, 0, w, h);

		// Large slow mist blooms.
		const drift = (time / 90000) % 1;
		const blooms = [
			{ x: 0.18 + drift * 0.06, y: 0.25, r: 0.62, c: 'rgba(150, 150, 150, 0.24)' },
			{ x: 0.82 - drift * 0.05, y: 0.62, r: 0.7, c: 'rgba(112, 112, 112, 0.20)' },
			{ x: 0.54, y: 0.08 + drift * 0.04, r: 0.48, c: 'rgba(180, 180, 180, 0.13)' }
		];
		for (const b of blooms) {
			const gradient = ctx.createRadialGradient(
				b.x * w,
				b.y * h,
				0,
				b.x * w,
				b.y * h,
				b.r * Math.max(w, h)
			);
			gradient.addColorStop(0, b.c);
			gradient.addColorStop(0.55, b.c.replace(/[\d.]+\)$/, '0.10)'));
			gradient.addColorStop(1, 'rgba(0,0,0,0)');
			ctx.fillStyle = gradient;
			ctx.fillRect(0, 0, w, h);
		}

		// Fine mist grain.
		if (this.noisePattern) {
			ctx.save();
			ctx.globalAlpha = 0.62;
			ctx.fillStyle = this.noisePattern;
			ctx.fillRect(0, 0, w, h);
			ctx.restore();
		}

		// Vignette makes the edges feel deeper and keeps the HUD legible.
		const vignette = ctx.createRadialGradient(
			w / 2,
			h / 2,
			Math.min(w, h) * 0.28,
			w / 2,
			h / 2,
			Math.max(w, h) * 0.75
		);
		vignette.addColorStop(0, 'rgba(0,0,0,0)');
		vignette.addColorStop(1, 'rgba(0,0,0,0.52)');
		ctx.fillStyle = vignette;
		ctx.fillRect(0, 0, w, h);
	}

	punchCells(
		project: Project,
		cells: Record<string, CellMeta>,
		recent: Map<string, number>,
		time: number
	): void {
		const { width: w, height: h } = this;
		const mask = this.maskCtx;
		mask.clearRect(0, 0, w, h);
		mask.globalCompositeOperation = 'source-over';
		mask.fillStyle = '#fff';

		let drawn = 0;
		for (const key of Object.keys(cells || {})) {
			const cell = parseCellKey(key);
			if (!cell || !this.isVisibleCell(cell)) continue;
			const pts = cellCornersScreen(project, cell);
			if (!pts) continue;
			if (!polygon(mask, pts)) continue;
			mask.fill();
			drawn += 1;
		}
		this.stats.visible = drawn;

		const ctx = this.ctx;
		ctx.save();
		ctx.globalCompositeOperation = 'destination-out';
		if ('filter' in ctx) ctx.filter = 'blur(1.6px)';
		ctx.drawImage(this.mask, 0, 0, w, h);
		ctx.restore();

		if (!drawn) return;

		if (this.showFavorites) {
			ctx.save();
			let favorites = 0;
			for (const key of Object.keys(cells || {})) {
				const count = Number(cells[key]?.n) || 1;
				if (count < 2) continue;
				const cell = parseCellKey(key);
				if (!cell || !this.isVisibleCell(cell)) continue;
				const pts = cellCornersScreen(project, cell);
				if (!pts || !polygon(ctx, pts)) continue;
				const strength = Math.min(0.3, 0.07 + Math.log2(count) * 0.05);
				ctx.fillStyle = `rgba(251, 191, 36, ${strength})`;
				ctx.fill();
				favorites += 1;
			}
			this.stats.favorites = favorites;
			ctx.restore();
		} else {
			this.stats.favorites = 0;
		}

		// A faint survey grid inside the cleared area.
		if (this.showGrid) {
			ctx.save();
			ctx.lineWidth = 0.65;
			for (const key of Object.keys(cells || {})) {
				const cell = parseCellKey(key);
				if (!cell || !this.isVisibleCell(cell)) continue;
				const pts = cellCornersScreen(project, cell);
				if (!pts || !polygon(ctx, pts)) continue;
				const age = time - (recent?.get(key) ?? -Infinity);
				if (age < 6000) {
					const a = 1 - age / 6000;
					ctx.strokeStyle = `rgba(125, 211, 252, ${0.16 + a * 0.5})`;
					ctx.lineWidth = 0.9;
				} else {
					ctx.strokeStyle = 'rgba(159, 196, 235, 0.10)';
					ctx.lineWidth = 0.55;
				}
				ctx.stroke();
			}
			ctx.restore();
		}
	}

	drawTrail(project: Project, path: PathPoint[]): void {
		if (!Array.isArray(path) || path.length < 2) return;
		const { ctx } = this;
		const tctx = this.trailCtx;
		const points: Point[] = [];
		const start = Math.max(0, path.length - 1600);
		for (let i = start; i < path.length; i += 1) {
			const p = path[i];
			if (!Array.isArray(p)) continue;
			const sp = project(p[0], p[1]);
			if (!sp || !Number.isFinite(sp.x) || !Number.isFinite(sp.y)) continue;
			if (sp.x < -60 || sp.y < -60 || sp.x > this.width + 60 || sp.y > this.height + 60) {
				// Keep a gap-free line by retaining points just outside, but drop far ones.
				if (sp.x < -2000 || sp.y < -2000 || sp.x > this.width + 2000 || sp.y > this.height + 2000)
					continue;
			}
			points.push(sp);
		}
		if (points.length < 2) return;

		tctx.clearRect(0, 0, this.width, this.height);
		tctx.save();
		tctx.lineJoin = 'round';
		tctx.lineCap = 'round';
		tctx.beginPath();
		tctx.moveTo(points[0].x, points[0].y);
		for (let i = 1; i < points.length; i += 1) tctx.lineTo(points[i].x, points[i].y);
		tctx.strokeStyle = 'rgba(6, 34, 48, 0.7)';
		tctx.lineWidth = 6;
		tctx.stroke();
		tctx.strokeStyle = 'rgba(103, 232, 249, 0.9)';
		tctx.lineWidth = 2.2;
		tctx.shadowColor = 'rgba(34, 211, 238, 0.65)';
		tctx.shadowBlur = 8;
		tctx.stroke();
		tctx.restore();

		// Composite the trail beneath the fog. It is visible only through the
		// unlocked holes, never as a line across unexplored mist.
		ctx.save();
		ctx.globalCompositeOperation = 'destination-over';
		ctx.drawImage(this.trail, 0, 0, this.width, this.height);
		ctx.restore();
	}

	drawPlaces(
		project: Project,
		places: PlaceMarker[] | undefined,
		highlight: string | null | undefined,
		zoom: number
	): void {
		if (!places?.length) return;
		const { ctx } = this;
		ctx.save();
		let selected: PlaceMarker | null = null;
		for (const place of places) {
			if (highlight && place.key === highlight) {
				selected = place;
				continue;
			}
			const p = project(place.lat, place.lng);
			if (!p || p.x < -30 || p.y < -30 || p.x > this.width + 30 || p.y > this.height + 30) continue;
			const rating = Math.max(1, Math.min(5, Math.round(Number(place.rating) || 1)));
			const size = zoom >= 15 ? 6 + rating * 1.1 : 3.2;
			ctx.beginPath();
			ctx.ellipse(p.x, p.y + 2, size * 0.95, size * 0.35, 0, 0, TAU);
			ctx.fillStyle = 'rgba(4, 8, 13, 0.5)';
			ctx.fill();
			starPath(ctx, p.x, p.y - size * 0.2, size);
			ctx.fillStyle = `rgba(251, 191, 36, ${0.52 + rating * 0.08})`;
			ctx.fill();
			ctx.strokeStyle = 'rgba(8, 12, 18, 0.92)';
			ctx.lineWidth = 1.1;
			ctx.stroke();
			if (zoom >= 16.5 && size >= 10) {
				ctx.fillStyle = 'rgba(20, 12, 2, 0.9)';
				ctx.font = `700 ${Math.max(7, size * 0.78)}px ui-sans-serif, system-ui, sans-serif`;
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText(String(rating), p.x, p.y - size * 0.2);
			}
		}
		if (selected) this.drawPlaceHighlight(project, selected, zoom);
		ctx.restore();
	}

	drawPlaceHighlight(project: Project, place: PlaceMarker, zoom: number): void {
		const p = project(place.lat, place.lng);
		if (!p || p.x < -90 || p.y < -90 || p.x > this.width + 90 || p.y > this.height + 90) return;
		const rating = Math.max(1, Math.min(5, Math.round(Number(place.rating) || 1)));
		const scale = zoom >= 17 ? 1.2 : zoom >= 15 ? 1 : 0.85;
		const topY = p.y - 26 * scale;
		const { ctx } = this;
		ctx.save();

		const glow = ctx.createRadialGradient(p.x, topY, 2, p.x, topY, 48 * scale);
		glow.addColorStop(0, 'rgba(251, 191, 36, 0.34)');
		glow.addColorStop(0.55, 'rgba(251, 191, 36, 0.12)');
		glow.addColorStop(1, 'rgba(251, 191, 36, 0)');
		ctx.fillStyle = glow;
		ctx.beginPath();
		ctx.arc(p.x, topY, 48 * scale, 0, TAU);
		ctx.fill();

		ctx.beginPath();
		ctx.ellipse(p.x, p.y + 3, 24 * scale, 8 * scale, 0, 0, TAU);
		ctx.fillStyle = 'rgba(3, 7, 12, 0.45)';
		ctx.fill();
		ctx.beginPath();
		ctx.ellipse(p.x, p.y, 20 * scale, 6 * scale, 0, 0, TAU);
		ctx.strokeStyle = 'rgba(251, 191, 36, 0.65)';
		ctx.lineWidth = 2 * scale;
		ctx.stroke();

		const beam = ctx.createLinearGradient(p.x, p.y, p.x, topY + 18 * scale);
		beam.addColorStop(0, 'rgba(251, 191, 36, 0.05)');
		beam.addColorStop(1, 'rgba(251, 191, 36, 0.55)');
		ctx.beginPath();
		ctx.moveTo(p.x, p.y);
		ctx.lineTo(p.x, topY + 18 * scale);
		ctx.strokeStyle = beam;
		ctx.lineWidth = 2 * scale;
		ctx.stroke();

		for (let layer = 4; layer >= 1; layer -= 1) {
			const y = topY + layer * 5 * scale;
			starPath(ctx, p.x, y, 20 * scale, 8 * scale);
			ctx.fillStyle = `rgba(${180 - layer * 18}, ${120 - layer * 10}, ${20 + layer * 3}, 0.78)`;
			ctx.fill();
			ctx.strokeStyle = 'rgba(10, 8, 4, 0.65)';
			ctx.lineWidth = 1.2 * scale;
			ctx.stroke();
		}

		const topStar = ctx.createLinearGradient(0, topY - 20 * scale, 0, topY + 20 * scale);
		topStar.addColorStop(0, '#fff2b6');
		topStar.addColorStop(0.45, '#fbbf24');
		topStar.addColorStop(1, '#d97706');
		starPath(ctx, p.x, topY, 20 * scale, 8 * scale);
		ctx.fillStyle = topStar;
		ctx.fill();
		ctx.strokeStyle = 'rgba(10, 8, 4, 0.9)';
		ctx.lineWidth = 1.8 * scale;
		ctx.stroke();

		ctx.fillStyle = '#2a1a02';
		ctx.font = `800 ${14 * scale}px ui-sans-serif, system-ui, sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(String(rating), p.x, topY + 1);
		ctx.restore();
	}

	drawAccuracy(project: Project, current: NormalizedFix | null): void {
		const accuracy = Number(current?.accuracy);
		if (!current || !Number.isFinite(accuracy)) return;
		if (accuracy <= 0 || accuracy > 500) return;
		const center = project(current.lat, current.lng);
		if (!center) return;
		const latRad = (current.lat * Math.PI) / 180;
		const deltaLng = accuracy / Math.max(1, 111320 * Math.cos(latRad));
		const edge = project(current.lat, current.lng + deltaLng);
		if (!edge) return;
		const radius = Math.abs(edge.x - center.x);
		if (!Number.isFinite(radius) || radius < 2) return;

		const { ctx } = this;
		ctx.save();
		ctx.beginPath();
		ctx.arc(center.x, center.y, radius, 0, TAU);
		ctx.fillStyle = accuracy <= 35 ? 'rgba(56, 189, 248, 0.07)' : 'rgba(251, 191, 36, 0.06)';
		ctx.fill();
		ctx.strokeStyle = accuracy <= 35 ? 'rgba(125, 211, 252, 0.28)' : 'rgba(251, 191, 36, 0.3)';
		ctx.lineWidth = 1;
		ctx.setLineDash([4, 5]);
		ctx.stroke();
		ctx.restore();
	}

	drawMarker(project: Project, current: NormalizedFix | null): void {
		if (!current) return;
		const p = project(current.lat, current.lng);
		if (!p) return;
		const { ctx } = this;
		const good =
			current.accuracy === null || current.accuracy === undefined || current.accuracy <= 35;
		const accent = good ? '#9cecf5' : '#f0c75e';
		const hasHeading = current.heading !== null && Number.isFinite(current.heading);
		const heading = hasHeading ? (current.heading! * Math.PI) / 180 : 0;
		const ink = '#f3f3f3';

		ctx.save();
		ctx.translate(p.x, p.y);
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';

		ctx.beginPath();
		ctx.arc(0, 0, 30, 0, TAU);
		ctx.fillStyle = good ? 'rgba(156, 236, 245, 0.08)' : 'rgba(240, 199, 94, 0.09)';
		ctx.fill();

		if (hasHeading) {
			ctx.save();
			ctx.rotate(heading);
			ctx.beginPath();
			ctx.moveTo(0, -36);
			ctx.lineTo(-5.5, -26);
			ctx.lineTo(5.5, -26);
			ctx.closePath();
			ctx.fillStyle = accent;
			ctx.fill();
			ctx.restore();
		}

		ctx.beginPath();
		ctx.arc(0, 0, 15, 0, TAU);
		ctx.fillStyle = '#0b1119';
		ctx.fill();
		ctx.lineWidth = 1.5;
		ctx.strokeStyle = ink;
		ctx.stroke();

		ctx.beginPath();
		ctx.arc(0, 0, 5.2, 0, TAU);
		ctx.fillStyle = accent;
		ctx.fill();

		ctx.restore();
	}

	drawPulses(project: Project, pulses: Pulse[], time: number, reducedMotion: boolean): void {
		if (reducedMotion || !pulses?.length) return;
		const { ctx } = this;
		ctx.save();
		for (const pulse of pulses) {
			const age = time - pulse.t;
			if (age < 0 || age > 1500) continue;
			const p = project(pulse.lat, pulse.lng);
			if (!p) continue;
			const f = age / 1500;
			const radius = 5 + f * 34;
			ctx.beginPath();
			ctx.arc(p.x, p.y, radius, 0, TAU);
			ctx.strokeStyle = `rgba(103, 232, 249, ${(1 - f) * 0.65})`;
			ctx.lineWidth = 1.5;
			ctx.stroke();
			ctx.beginPath();
			ctx.arc(p.x, p.y, Math.max(0.1, 3 * (1 - f)), 0, TAU);
			ctx.fillStyle = `rgba(224, 242, 254, ${(1 - f) * 0.9})`;
			ctx.fill();
		}
		ctx.restore();
	}

	drawTarget(project: Project, current: NormalizedFix | null, target: LatLng | null): void {
		if (!target) return;
		const p = project(target.lat, target.lng);
		if (!p) return;
		const { ctx } = this;
		ctx.save();

		if (current) {
			const c = project(current.lat, current.lng);
			if (c) {
				ctx.beginPath();
				ctx.moveTo(c.x, c.y);
				ctx.lineTo(p.x, p.y);
				ctx.strokeStyle = 'rgba(251, 191, 36, 0.42)';
				ctx.lineWidth = 1.3;
				ctx.setLineDash([3, 7]);
				ctx.stroke();
			}
		}

		ctx.setLineDash([]);
		ctx.translate(p.x, p.y);
		ctx.rotate(Math.PI / 4);
		ctx.fillStyle = 'rgba(251, 191, 36, 0.14)';
		ctx.strokeStyle = 'rgba(251, 191, 36, 0.9)';
		ctx.lineWidth = 1.4;
		ctx.fillRect(-7, -7, 14, 14);
		ctx.strokeRect(-7, -7, 14, 14);
		ctx.rotate(-Math.PI / 4);
		ctx.fillStyle = 'rgba(254, 243, 199, 0.95)';
		ctx.font = '600 9px "Segoe UI", system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.fillText('WALK HERE', 0, -16);
		ctx.restore();
	}

	drawGuide(project: Project, current: NormalizedFix | null, guide: LatLng | null): void {
		if (!guide) return;
		const p = project(guide.lat, guide.lng);
		if (!p) return;
		const { ctx } = this;
		ctx.save();
		if (current) {
			const c = project(current.lat, current.lng);
			if (c) {
				ctx.beginPath();
				ctx.moveTo(c.x, c.y);
				ctx.lineTo(p.x, p.y);
				ctx.strokeStyle = 'rgba(156, 236, 245, 0.38)';
				ctx.lineWidth = 1.2;
				ctx.setLineDash([2, 8]);
				ctx.stroke();
			}
		}
		ctx.setLineDash([]);
		ctx.translate(p.x, p.y);
		ctx.rotate(Math.PI / 4);
		ctx.fillStyle = 'rgba(156, 236, 245, 0.12)';
		ctx.strokeStyle = 'rgba(156, 236, 245, 0.95)';
		ctx.lineWidth = 1.6;
		ctx.fillRect(-7, -7, 14, 14);
		ctx.strokeRect(-7, -7, 14, 14);
		ctx.rotate(-Math.PI / 4);
		ctx.fillStyle = 'rgba(224, 251, 255, 0.96)';
		ctx.font = '600 9px "Archivo", "Segoe UI", system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.fillText('NEAREST MIST', 0, -16);
		ctx.restore();
	}

	drawReplay(project: Project, replay: ReplayState | null): void {
		if (!replay?.path || replay.path.length < 2) return;
		const points: Point[] = [];
		const breaks: boolean[] = [];
		let previous: PathPoint | null = null;
		for (const point of replay.path) {
			if (!Array.isArray(point)) continue;
			const projected = project(point[0], point[1]);
			if (!projected || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) continue;
			const gapMs = previous ? (Number(point[2]) || 0) - (Number(previous[2]) || 0) : 0;
			const gapM = previous
				? haversineMeters({ lat: previous[0], lng: previous[1] }, { lat: point[0], lng: point[1] })
				: 0;
			points.push(projected);
			breaks.push(Boolean(previous) && (gapMs > 30 * 60_000 || gapM > 1_000));
			previous = point;
		}
		if (points.length < 2) return;
		const { ctx } = this;
		const end = Math.max(1, Math.min(points.length, Number(replay.index) || points.length));
		const trace = (limit: number) => {
			ctx.beginPath();
			for (let i = 0; i < limit; i += 1) {
				if (i === 0 || breaks[i]) ctx.moveTo(points[i].x, points[i].y);
				else ctx.lineTo(points[i].x, points[i].y);
			}
		};
		ctx.save();
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';
		trace(points.length);
		ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
		ctx.lineWidth = 3;
		ctx.setLineDash([5, 6]);
		ctx.stroke();
		ctx.setLineDash([]);
		trace(end);
		ctx.strokeStyle = 'rgba(255, 183, 197, 0.96)';
		ctx.lineWidth = 3.2;
		ctx.stroke();
		const head = points[end - 1];
		ctx.beginPath();
		ctx.arc(head.x, head.y, 5, 0, TAU);
		ctx.fillStyle = '#ffb7c5';
		ctx.fill();
		ctx.strokeStyle = 'rgba(7, 7, 7, 0.9)';
		ctx.lineWidth = 2;
		ctx.stroke();
		ctx.restore();
	}

	/**
	 * @param {object} frame
	 * @param {(lat:number,lng:number)=>{x:number,y:number}|null} frame.project
	 * @param {object} frame.cells
	 * @param {Map<string,number>} frame.recent
	 * @param {Array} frame.path
	 * @param {object|null} frame.current
	 * @param {object|null} frame.target
	 * @param {object|null} frame.guide
	 * @param {object|null} frame.replay
	 * @param {object} frame.bounds
	 * @param {number} frame.time
	 * @param {boolean} frame.reducedMotion
	 * @param {boolean} frame.showGrid
	 * @param {boolean} frame.showFavorites
	 */
	render(frame: RenderFrame): void {
		if (!this.width || !this.height) return;
		const {
			project,
			cells = {},
			recent = new Map(),
			path = [],
			current = null,
			target = null,
			guide = null,
			replay = null,
			bounds = null,
			time = performance.now(),
			reducedMotion = false,
			showGrid = true,
			showFavorites = true,
			places = [],
			highlightPlace = null,
			pulses = [],
			zoom = 16
		} = frame;

		this.showGrid = showGrid && zoom >= 15;
		this.showFavorites = showFavorites && zoom >= 15;
		this.cellRange = this.computeCellRange(bounds, 1);

		this.drawFogBase(time);
		this.punchCells(project, cells, recent, time);
		this.drawTrail(project, path);
		this.drawPlaces(project, places, highlightPlace, zoom);
		this.drawAccuracy(project, current);
		this.drawPulses(project, pulses, time, reducedMotion);
		this.drawTarget(project, current, target);
		this.drawGuide(project, current, guide);
		this.drawReplay(project, replay);
		this.drawMarker(project, current);
	}
}
