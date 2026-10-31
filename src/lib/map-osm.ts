/* MistWalk OSM map adapter — Leaflet + free tiles, no API key. */

import L from 'leaflet';
import type { Basemap, CellBounds, LatLng } from './types.ts';

const BASEMAPS: Record<
	Basemap,
	{
		url: string;
		subdomains: string;
		maxZoom: number;
		label: string;
		attribution: string;
	}
> = {
	osm: {
		url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
		subdomains: 'abc',
		maxZoom: 19,
		label: 'Standard',
		attribution:
			'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
	},
	osmfr: {
		url: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
		subdomains: 'abc',
		maxZoom: 19,
		label: 'OSM France',
		attribution:
			'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · <a href="https://openstreetmap.fr/" target="_blank" rel="noopener">OSM France</a>'
	},
	cyclosm: {
		url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
		subdomains: 'abc',
		maxZoom: 20,
		label: 'CyclOSM',
		attribution:
			'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · <a href="https://www.cyclosm.org/" target="_blank" rel="noopener">CyclOSM</a>'
	}
};

export class OsmMap {
	container: HTMLElement;
	fogHost: HTMLElement;
	canvas: HTMLCanvasElement;
	map: L.Map;
	tileLayer: L.TileLayer;
	basemap: Basemap;
	destroyed: boolean;
	pending: boolean;
	userDragged = false;
	tileErrors: number;
	onViewChange?: () => void;
	onTileError?: () => void;
	onClick?: (lat: number, lng: number) => void;
	onUserDrag?: () => void;

	constructor({
		container,
		fogHost,
		center,
		zoom = 17,
		basemap = 'osm',
		onViewChange,
		onReady,
		onTileError,
		onClick,
		onUserDrag
	}: {
		container: HTMLElement;
		fogHost: HTMLElement;
		center: LatLng;
		zoom?: number;
		basemap?: Basemap;
		onViewChange?: () => void;
		onReady?: (map: OsmMap) => void;
		onTileError?: () => void;
		onClick?: (lat: number, lng: number) => void;
		onUserDrag?: () => void;
	}) {
		this.container = container;
		this.fogHost = fogHost;
		this.onViewChange = onViewChange;
		this.onTileError = onTileError;
		this.onClick = onClick;
		this.onUserDrag = onUserDrag;
		this.basemap = BASEMAPS[basemap] ? basemap : 'osm';
		this.destroyed = false;
		this.pending = false;
		this.tileErrors = 0;

		this.canvas = document.createElement('canvas');
		this.canvas.className = 'fog-canvas fog-canvas--osm';
		this.canvas.setAttribute('aria-hidden', 'true');
		this.fogHost.appendChild(this.canvas);

		this.map = L.map(container, {
			zoomControl: false,
			attributionControl: false,
			preferCanvas: true,
			worldCopyJump: true,
			minZoom: 2,
			maxZoom: 20,
			zoomSnap: 0.25,
			zoomDelta: 0.5,
			wheelPxPerZoomLevel: 130,
			fadeAnimation: true,
			zoomAnimation: true,
			markerZoomAnimation: false
		});
		this.map.setView([center.lat, center.lng], zoom, { animate: false });

		this.tileLayer = this.makeTileLayer(this.basemap);
		this.tileLayer.addTo(this.map);

		this.map.on('move zoom resize', () => this.scheduleChange());
		this.map.on('click', (event: L.LeafletMouseEvent) => {
			if (this.onClick) this.onClick(event.latlng.lat, event.latlng.lng);
		});
		this.map.on('dragstart', () => {
			this.userDragged = true;
			this.onUserDrag?.();
		});

		this.tileLayer.on('tileerror', () => {
			this.tileErrors = (this.tileErrors || 0) + 1;
			if (this.onTileError && this.tileErrors === 6) this.onTileError();
		});

		// Leaflet needs a beat after the container becomes visible.
		requestAnimationFrame(() => {
			if (this.destroyed) return;
			this.map.invalidateSize(false);
			this.scheduleChange();
			if (onReady) onReady(this);
		});
	}

	makeTileLayer(name: Basemap): L.TileLayer {
		const spec = BASEMAPS[name] || BASEMAPS.osm;
		return L.tileLayer(spec.url, {
			subdomains: spec.subdomains,
			maxZoom: spec.maxZoom,
			attribution: spec.attribution,
			crossOrigin: true,
			updateWhenIdle: false,
			keepBuffer: 3,
			detectRetina: false
		});
	}

	scheduleChange(): void {
		if (this.destroyed || this.pending) return;
		this.pending = true;
		requestAnimationFrame(() => {
			this.pending = false;
			if (this.destroyed) return;
			this.onViewChange?.();
		});
	}

	get attribution(): string {
		return BASEMAPS[this.basemap].attribution;
	}

	get providerLabel(): string {
		return `OpenStreetMap · ${BASEMAPS[this.basemap].label}`;
	}

	get zoom(): number {
		return this.map.getZoom();
	}

	get center(): LatLng {
		const c = this.map.getCenter();
		return { lat: c.lat, lng: c.lng };
	}

	get bounds(): CellBounds {
		const b = this.map.getBounds();
		return { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
	}

	project(lat: number, lng: number): { x: number; y: number } | null {
		try {
			const p = this.map.latLngToContainerPoint([lat, lng]);
			if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
			return { x: p.x, y: p.y };
		} catch {
			return null;
		}
	}

	unproject(x: number, y: number): LatLng {
		const p = this.map.containerPointToLatLng([x, y]);
		return { lat: p.lat, lng: p.lng };
	}

	setView(lat: number, lng: number, zoom = this.zoom, animate = false): void {
		this.map.setView([lat, lng], zoom, { animate });
	}

	panTo(lat: number, lng: number, animate = true): void {
		this.map.panTo([lat, lng], { animate });
	}

	zoomBy(delta: number): void {
		this.map.setZoom(this.map.getZoom() + delta);
	}

	fitBounds(bounds: CellBounds, padding = 48): void {
		this.map.fitBounds(
			[
				[bounds.south, bounds.west],
				[bounds.north, bounds.east]
			],
			{ padding: [padding, padding], maxZoom: 18, animate: true }
		);
	}

	setBasemap(name: Basemap): void {
		if (!BASEMAPS[name] || name === this.basemap) return;
		this.basemap = name;
		this.tileErrors = 0;
		const old = this.tileLayer;
		this.tileLayer = this.makeTileLayer(name);
		this.tileLayer.addTo(this.map);
		if (old) {
			setTimeout(() => this.map.removeLayer(old), 250);
		}
		this.tileLayer.on('tileerror', () => {
			this.tileErrors = (this.tileErrors || 0) + 1;
			if (this.onTileError && this.tileErrors === 6) this.onTileError();
		});
	}

	resize(): void {
		this.map.invalidateSize(false);
		this.scheduleChange();
	}

	destroy(): void {
		this.destroyed = true;
		this.canvas.remove();
		this.map.remove();
		this.container.innerHTML = '';
	}
}
