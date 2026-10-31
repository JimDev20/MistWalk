/* MistWalk Google Maps adapter — optional, key required, fog drawn as an overlay. */

import type { Basemap, CellBounds, LatLng } from './types.ts';

const GOOGLE_LOAD_TIMEOUT = 18_000;

interface FogHooks {
	onAdd?: () => void;
	onDraw?: (width: number, height: number) => void;
}

interface GoogleMapOptions {
	container: HTMLElement;
	center: LatLng;
	zoom?: number;
	basemap?: Basemap;
	key: string;
	onViewChange?: () => void;
	onReady?: (map: GoogleMap) => void;
	onClick?: (lat: number, lng: number) => void;
	onUserDrag?: () => void;
}

const LIGHT_STYLES: google.maps.MapTypeStyle[] = [
	{ elementType: 'geometry', stylers: [{ color: '#e8eef4' }] },
	{ featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#edf2ef' }] },
	{ featureType: 'water', elementType: 'geometry', stylers: [{ color: '#c5d9e7' }] },
	{ featureType: 'road', elementType: 'geometry', stylers: [{ color: '#ffffff' }] },
	{ featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#f7fafc' }] },
	{ featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
	{ featureType: 'transit', stylers: [{ visibility: 'off' }] },
	{ elementType: 'labels.text.fill', stylers: [{ color: '#3d4c5c' }] },
	{ elementType: 'labels.text.stroke', stylers: [{ color: '#f5f8fa' }] }
];

const DARK_STYLES: google.maps.MapTypeStyle[] = [
	{ elementType: 'geometry', stylers: [{ color: '#111b26' }] },
	{ featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#0d1620' }] },
	{ featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0a2532' }] },
	{ featureType: 'road', elementType: 'geometry', stylers: [{ color: '#22303e' }] },
	{ featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#263645' }] },
	{ featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
	{ featureType: 'transit', stylers: [{ visibility: 'off' }] },
	{ elementType: 'labels.text.fill', stylers: [{ color: '#91a8bc' }] },
	{ elementType: 'labels.text.stroke', stylers: [{ color: '#0a1119' }] }
];

function mapStyles(): google.maps.MapTypeStyle[] {
	return document.documentElement.dataset.theme === 'paper' ? LIGHT_STYLES : DARK_STYLES;
}

let loader: { key: string; promise: Promise<void> } | null = null;

export function googleMapsAvailable(): boolean {
	return Boolean(window.google?.maps?.Map);
}

export function loadGoogleMaps(
	key: string,
	{ timeout = GOOGLE_LOAD_TIMEOUT }: { timeout?: number } = {}
): Promise<void> {
	if (googleMapsAvailable()) return Promise.resolve();
	if (!key) return Promise.reject(new Error('A Google Maps API key is needed.'));
	if (loader && loader.key === key) return loader.promise;

	// Google calls this global when the key is invalid or unauthorized. Install
	// it before the script arrives so failures cannot get lost.
	window.gm_authFailure = () => {
		window.dispatchEvent(new CustomEvent('mistwalk:google-auth-failure'));
	};

	const promise = new Promise<void>((resolve, reject) => {
		const callbackName = `__mistwalkGoogleReady_${Date.now()}`;
		let settled = false;
		const script = document.createElement('script');
		const callbacks = window as unknown as Record<string, unknown>;
		const cleanup = () => {
			delete callbacks[callbackName];
			clearTimeout(timer);
		};
		const fail = (err: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			script.remove();
			loader = null;
			reject(err);
		};
		const timer = setTimeout(
			() => fail(new Error('Google Maps did not finish loading. Check your connection and key.')),
			timeout
		);

		callbacks[callbackName] = () => {
			if (settled) return;
			settled = true;
			cleanup();
			if (googleMapsAvailable()) resolve();
			else reject(new Error('Google Maps loaded without a Map class.'));
		};

		script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=${callbackName}`;
		script.async = true;
		script.defer = true;
		script.onerror = () =>
			fail(
				new Error(
					'Google Maps could not be downloaded. The free OpenStreetMap map is still available.'
				)
			);
		document.head.appendChild(script);
	});

	loader = { key, promise };
	return promise;
}

interface FogOverlayInstance {
	setMap(map: google.maps.Map | null): void;
	screenPoint(lat: number, lng: number): { x: number; y: number } | null;
	latLngAt(x: number, y: number): LatLng | null;
}

type FogOverlayConstructor = new (canvas: HTMLCanvasElement, hooks: FogHooks) => FogOverlayInstance;

let fogOverlayClass: FogOverlayConstructor | null = null;

/**
 * The Google Maps script is loaded lazily, so this class cannot extend
 * google.maps.OverlayView at module-evaluation time. Build it on first use.
 */
function getFogOverlayClass(): FogOverlayConstructor {
	if (fogOverlayClass) return fogOverlayClass;
	fogOverlayClass = class FogOverlay extends google.maps.OverlayView implements FogOverlayInstance {
		canvas: HTMLCanvasElement;
		hooks: FogHooks;
		projection: google.maps.MapCanvasProjection | null;
		added: boolean;

		constructor(canvas: HTMLCanvasElement, hooks: FogHooks) {
			super();
			this.canvas = canvas;
			this.hooks = hooks;
			this.projection = null;
			this.added = false;
		}

		onAdd(): void {
			const panes = this.getPanes();
			if (!panes?.overlayLayer) throw new Error('Google Maps overlay layer unavailable.');
			panes.overlayLayer.appendChild(this.canvas);
			this.added = true;
			this.hooks.onAdd?.();
		}

		onRemove(): void {
			this.canvas.remove();
			this.added = false;
		}

		draw(): void {
			if (!this.added) return;
			const projection = this.getProjection();
			const map = this.getMap();
			if (!projection || !(map instanceof google.maps.Map)) return;
			this.projection = projection;
			const div = map.getDiv();
			const width = div.clientWidth;
			const height = div.clientHeight;
			if (!width || !height) return;
			const center = map.getCenter();
			if (!center) return;
			const cp = projection.fromLatLngToDivPixel(center);
			if (!cp) return;
			this.canvas.style.left = `${Math.round(cp.x - width / 2)}px`;
			this.canvas.style.top = `${Math.round(cp.y - height / 2)}px`;
			this.canvas.style.width = `${width}px`;
			this.canvas.style.height = `${height}px`;
			this.hooks.onDraw?.(width, height);
		}

		screenPoint(lat: number, lng: number): { x: number; y: number } | null {
			if (!this.projection) return null;
			try {
				const p = this.projection.fromLatLngToContainerPixel(new google.maps.LatLng(lat, lng));
				if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
				return { x: p.x, y: p.y };
			} catch {
				return null;
			}
		}

		latLngAt(x: number, y: number): LatLng | null {
			if (!this.projection) return null;
			try {
				const ll = this.projection.fromContainerPixelToLatLng(new google.maps.Point(x, y));
				if (!ll) return null;
				return { lat: ll.lat(), lng: ll.lng() };
			} catch {
				return null;
			}
		}
	};
	return fogOverlayClass!;
}

export class GoogleMap {
	container: HTMLElement;
	surface: HTMLDivElement;
	canvas: HTMLCanvasElement;
	map: google.maps.Map | null;
	overlay: FogOverlayInstance | null;
	basemap: Basemap;
	destroyed: boolean;
	pending: boolean;
	ready: boolean;
	notifiedReady: boolean;
	width: number;
	height: number;
	onViewChange?: () => void;
	onClick?: (lat: number, lng: number) => void;
	onUserDrag?: () => void;

	static async create(options: GoogleMapOptions): Promise<GoogleMap> {
		await loadGoogleMaps(options.key);
		return new GoogleMap(options);
	}

	constructor({
		container,
		center,
		zoom = 17,
		basemap = 'osm',
		onViewChange,
		onReady,
		onClick,
		onUserDrag
	}: GoogleMapOptions) {
		this.container = container;
		this.onViewChange = onViewChange;
		this.onClick = onClick;
		this.onUserDrag = onUserDrag;
		this.destroyed = false;
		this.pending = false;
		this.basemap = basemap;
		this.ready = false;
		this.notifiedReady = false;
		this.width = 0;
		this.height = 0;

		this.surface = document.createElement('div');
		this.surface.className = 'google-map-surface';
		container.appendChild(this.surface);

		this.canvas = document.createElement('canvas');
		this.canvas.className = 'fog-canvas fog-canvas--google';
		this.canvas.setAttribute('aria-hidden', 'true');

		const map = new google.maps.Map(this.surface, {
			center: { lat: center.lat, lng: center.lng },
			zoom,
			disableDefaultUI: true,
			clickableIcons: false,
			keyboardShortcuts: false,
			gestureHandling: 'greedy',
			tilt: 0,
			heading: 0,
			backgroundColor: '#0b1119',
			styles: mapStyles(),
			mapTypeId: 'roadmap',
			maxZoom: 21,
			minZoom: 2
		});
		this.map = map;

		map.addListener('click', (event: google.maps.MapMouseEvent) => {
			if (this.onClick && event.latLng) this.onClick(event.latLng.lat(), event.latLng.lng());
		});

		const FogOverlay = getFogOverlayClass();
		this.overlay = new FogOverlay(this.canvas, {
			onAdd: () => {
				this.ready = true;
				this.scheduleChange();
			},
			onDraw: (width: number, height: number) => {
				this.width = width;
				this.height = height;
				// Wait for the first real projection/draw so the fog canvas is never
				// shown for a frame over an unprotected Google map.
				if (!this.notifiedReady) {
					this.notifiedReady = true;
					onReady?.(this);
				}
				this.scheduleChange();
			}
		});
		this.overlay.setMap(map);

		for (const event of ['bounds_changed', 'zoom_changed', 'idle']) {
			map.addListener(event, () => this.scheduleChange());
		}
		map.addListener('dragstart', () => this.onUserDrag?.());
		google.maps.event.addListenerOnce(map, 'idle', () => {
			requestAnimationFrame(() => {
				this.scheduleChange();
				if (!this.ready) onReady?.(this);
			});
		});

		// If the key is rejected, tell the app so it can fall back to the free map.
		window.gm_authFailure = () => {
			window.dispatchEvent(new CustomEvent('mistwalk:google-auth-failure'));
		};
	}

	scheduleChange(): void {
		if (this.destroyed || this.pending) return;
		this.pending = true;
		requestAnimationFrame(() => {
			this.pending = false;
			if (!this.destroyed) this.onViewChange?.();
		});
	}

	get attribution(): string {
		return '<a href="https://maps.google.com" target="_blank" rel="noopener">Google Maps</a>';
	}

	get providerLabel(): string {
		return 'Google Maps';
	}

	get zoom(): number {
		return this.map?.getZoom() ?? 17;
	}

	get center(): LatLng {
		const c = this.map?.getCenter();
		return c ? { lat: c.lat(), lng: c.lng() } : { lat: 0, lng: 0 };
	}

	get bounds(): CellBounds | null {
		const b = this.map?.getBounds();
		if (!b) return null;
		return {
			north: b.getNorthEast().lat(),
			east: b.getNorthEast().lng(),
			south: b.getSouthWest().lat(),
			west: b.getSouthWest().lng()
		};
	}

	project(lat: number, lng: number): { x: number; y: number } | null {
		return this.overlay?.screenPoint(lat, lng) ?? null;
	}

	unproject(x: number, y: number): LatLng | null {
		return this.overlay?.latLngAt(x, y) ?? null;
	}

	setView(lat: number, lng: number, zoom = this.zoom, animate = false): void {
		this.map?.setOptions({ center: { lat, lng }, zoom });
		if (animate) this.map?.panTo({ lat, lng });
	}

	panTo(lat: number, lng: number, animate = true): void {
		if (animate) this.map?.panTo({ lat, lng });
		else this.map?.setCenter({ lat, lng });
	}

	zoomBy(delta: number): void {
		this.map?.setZoom(this.zoom + delta);
	}

	fitBounds(bounds: CellBounds, padding = 48): void {
		this.map?.fitBounds(
			{ north: bounds.north, south: bounds.south, east: bounds.east, west: bounds.west },
			padding
		);
	}

	setBasemap(name: Basemap): void {
		this.basemap = name;
		this.map?.setOptions({ styles: mapStyles() });
	}

	resize(): void {
		if (this.map) google.maps.event.trigger(this.map, 'resize');
		this.scheduleChange();
	}

	destroy(): void {
		this.destroyed = true;
		this.overlay?.setMap(null);
		this.overlay = null;
		this.canvas.remove();
		if (this.map) google.maps.event.clearInstanceListeners(this.map);
		this.map = null;
		this.surface.remove();
		this.container.innerHTML = '';
	}
}
