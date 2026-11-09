/* MistWalk controller — Svelte state, GPS, simulator, fog map and persistence. */

import {
	WalkGate,
	appendPath,
	appendSessionPoint,
	archiveSession,
	bearingDegrees,
	cellCenter,
	cellFromLatLng,
	cellToBounds,
	cellsAlongLine,
	createProgress,
	formatArea,
	formatClock,
	formatCoordinate,
	formatDistance,
	formatSpeed,
	groupSessionsByDay,
	haversineMeters,
	listCellNotes,
	listPlaces,
	normalizeFix,
	parseCellKey,
	progressStats,
	removePlace,
	setCellNote,
	setPlace,
	speedUnit,
	TRAVEL_MODE_LABELS,
	unlockCells
} from './core.ts';
import {
	cacheMembership,
	cachedApprovedMembership,
	clearAll,
	clearProfile,
	exportBackup as createBackup,
	importBackup,
	lastLocalSavedAt,
	loadProfileAsync,
	loadSettings,
	localUsageBytes,
	saveProfile,
	saveSettings,
	writeImported
} from './storage.ts';
import { FogRenderer } from './fog.ts';
import type {
	Achievement,
	ArchivedSession,
	Basemap,
	FixInput,
	ImportedBackup,
	MapEngine,
	MemberRecord,
	MemberStatus,
	PathPoint,
	PlaceData,
	PlaceDraft,
	ReplayTrackInput,
	SearchResult,
	SessionView,
	Settings
} from './types.ts';
import {
	achievementsFor,
	buildChallengeUrl,
	challengeFromUrl,
	challengeProgress,
	compassLabel,
	formatDistanceMeters,
	gpsQuality,
	nearestUnexplored,
	suggestedChallengeTarget
} from './features.ts';
import { buildGeoJSON, buildGpx, parseTrackFile } from './track.ts';
import {
	cloudConfigured,
	cloudSignOut,
	createInviteCode,
	deleteCloudBackup,
	fetchCloudBackup,
	fetchCloudMeta,
	fetchMembers,
	fetchMembership,
	redeemInviteCode,
	setMemberStatus,
	signInWithPassword,
	signUpWithPassword,
	updatePassword,
	uploadCloudBackup,
	watchCloudAuth
} from './cloud.ts';

const DEFAULT_VIEW = { lat: 14.5547, lng: 121.0244, zoom: 19 };
const WALK_SPEED_MPS = 1.35;
const SIM_SPEEDS = [1, 4, 20];
const OSM_ATTRIBUTION = [
	{ text: '© OpenStreetMap contributors', href: 'https://www.openstreetmap.org/copyright' }
];
const GOOGLE_ATTRIBUTION = [{ text: 'Map data © Google', href: 'https://maps.google.com' }];
const ATTRIBUTION_FALLBACK = OSM_ATTRIBUTION;

function osmAttribution(basemap: string) {
	const parts = [...OSM_ATTRIBUTION];
	if (basemap === 'osmfr') parts.push({ text: 'OSM France', href: 'https://openstreetmap.fr/' });
	else if (basemap === 'cyclosm') parts.push({ text: 'CyclOSM', href: 'https://www.cyclosm.org/' });
	return parts;
}

function pad2(n: number) {
	return String(n).padStart(2, '0');
}

function makeReadySignal() {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : '';
}

function errorName(err: unknown): string {
	return err instanceof Error ? err.name : '';
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			}
		);
	});
}

function initialUi() {
	return {
		levelName: 'Mistwalker',
		levelNumber: '01',
		levelTag: 'The map is still sleeping.',
		levelProgress: 0,
		statArea: '0 m²',
		statTiles: '0 tiles',
		statDistance: '0 m',
		statStreak: '0',
		walkTime: '00:00',
		walkDistance: '0 m',
		walkSpeed: '0.0',
		walkSpeedUnit: 'km/h',
		walkUnlocks: '0',
		walkLive: false,
		coordText: '—',
		heading: null,
		googleLink: 'https://www.google.com/maps',
		providerLabel: 'OpenStreetMap',
		attribution: ATTRIBUTION_FALLBACK,
		followActive: true,
		followLabel: 'Following',
		walkButtonLabel: 'Start GPS',
		walkButtonIcon: '#i-play',
		simHint: 'Tap the map to walk there.',
		simSpeedLabel: '1×',
		simVisible: false,
		favoriteSummary: 'Walk a route twice to map repeat visits.',
		gpsLabel: 'No fix',
		gpsDetail: 'GPS is standing by',
		gpsLevel: 'idle',
		badgeCount: '0',
		sessionCount: '0 walks',
		historyCount: '0 days',
		noteCount: '0 notes',
		placeCount: '0 places',
		nearestLabel: 'Find the nearest unexplored tile.',
		storageUsage: 'Stored locally on this device.'
	};
}

class MistWalk {
	// The Svelte reactive tree is intentionally structural; domain data is typed in types.ts.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	state = $state<any>({
		ready: false,
		booted: false,
		onboarded: false,
		settings: {
			provider: 'osm',
			basemap: 'osm',
			googleKey: '',
			units: 'metric',
			sound: true,
			haptics: true,
			wakeLock: true,
			showGrid: true,
			showFavorites: true,
			autoTrack: true,
			theme: 'night',
			highContrast: false,
			reduceMotion: false,
			onboarded: false,
			lastProfile: 'live'
		},
		profile: 'live',
		profiles: { live: null, demo: null },
		progress: null,
		stats: null,
		current: null,
		follow: true,
		tracking: 'idle',
		session: null,
		sim: {
			position: null,
			target: null,
			multiplier: 1,
			paused: false,
			lastFrame: 0,
			time: 0,
			anchored: false
		},
		status: { state: 'idle', label: 'Standby', detail: 'Loading' },
		provider: null,
		ui: initialUi(),
		onboarding: false,
		onboardingLeaving: false,
		modal: null,
		toasts: [],
		flash: { active: false, x: 50, y: 50 },
		search: { results: [], loading: false, error: '', query: '' },
		gps: { message: '', accuracy: null, ageMs: null, quality: 'idle' },
		sessions: [],
		notes: [],
		places: [],
		placeDraft: null,
		placePick: false,
		highlightPlace: null,
		achievements: [],
		replay: null,
		guide: null,
		battery: null,
		challenge: null,
		journey: { tab: 'overview' },
		cloud: {
			configured: cloudConfigured,
			status: cloudConfigured ? 'checking' : 'local',
			user: null,
			member: null,
			email: '',
			busy: false,
			sample: false,
			message: cloudConfigured ? 'Checking your access…' : 'Cloud sync is not configured.',
			lastSavedAt: 0,
			syncState: 'idle',
			syncMessage: '',
			members: [],
			membersBusy: false,
			inviteCode: '',
			inviteBusy: false
		},
		now: Date.now(),
		debug: false
	});

	map: MapEngine | null = null;
	fog: FogRenderer | null = null;
	mapContainer: HTMLElement | null = null;
	mapShell: HTMLElement | null = null;
	started = false;
	renderQueued = false;
	resizeHandler: (() => void) | null = null;
	gate = new WalkGate();
	watchId: number | null = null;
	saveTimer: ReturnType<typeof setTimeout> | null = null;
	unlockToastTimer: ReturnType<typeof setTimeout> | null = null;
	pendingUnlocks = 0;
	pulseRaf: number | null = null;
	simRaf: number | null = null;
	lastFixAt = 0;
	lastVehicleToast = 0;
	lastWeakToast = 0;
	lastTapToast = 0;
	lastFastToast = 0;
	lastSearchAt = 0;
	searchAbort: AbortController | null = null;
	recent = new Map<string, number>();
	pulses: Array<{ lat: number; lng: number; t: number }> = [];
	hasCentered = false;
	wakeLock: WakeLockSentinel | null = null;
	hiddenAt = 0;
	audio: AudioContext | null = null;
	userGesture = false;
	googleFailureHandled = false;
	reducedMotion = false;
	replayRaf: number | null = null;
	hideFinalizeTimer: ReturnType<typeof setTimeout> | null = null;
	earnedAchievements: Set<string> | null = null;
	cloudStop: (() => void) | null = null;
	cloudSyncTimer: ReturnType<typeof setTimeout> | null = null;
	cloudSyncInFlight = false;
	cloudDirty = false;
	cloudSyncFailures = 0;
	cloudCheckAt = 0;
	lastSeenRemoteAt = 0;
	accessCheckAt = 0;
	membershipSeq = 0;
	approvedHandledFor = '';
	sampleReturnProfile: 'live' | 'demo' = 'live';
	toastId = 0;
	lastFocus: HTMLElement | null = null;

	async init(mapContainer: HTMLElement, mapShell: HTMLElement): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.mapContainer = mapContainer;
		this.mapShell = mapShell;
		this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

		this.state.settings = loadSettings();
		this.state.challenge = challengeFromUrl(window.location.search);
		this.applyAccessibility();
		this.state.onboarded = this.state.settings.onboarded;
		this.state.profile = this.state.settings.lastProfile === 'demo' ? 'demo' : 'live';
		this.newSession();

		const [live, demo] = await Promise.all([loadProfileAsync('live'), loadProfileAsync('demo')]);
		this.state.profiles = { live, demo };
		this.state.progress = this.state.profiles[this.state.profile];

		const view = this.initialView();
		try {
			await this.buildMap(this.state.settings.provider, view);
		} catch (err) {
			console.error('MistWalk map failed', err);
			this.state.settings.provider = 'osm';
			saveSettings(this.state.settings);
			try {
				await this.buildMap('osm', view);
			} catch (err2) {
				console.error('MistWalk could not start the free map', err2);
				this.toast('The map could not load. Check your connection and reload.', 'error', 8000);
			}
		}

		this.refreshAll();

		if (cloudConfigured) {
			this.state.onboarding = false;
			this.state.tracking = 'idle';
		} else if (!this.state.onboarded) {
			this.showOnboarding();
		} else {
			this.hideOnboarding(true);
			if (this.state.profile === 'demo') this.enterDemo();
			else void this.maybeAutoStartLive();
		}

		this.bindWindowEvents();
		this.setupServiceWorker();
		this.exposeDebugApi();
		void this.requestPersistentStorage();
		void this.initCloud();
		void this.initBattery();

		this.state.ready = true;
		this.state.booted = true;

		setTimeout(() => {
			if (
				this.state.onboarded &&
				this.state.profile === 'live' &&
				this.state.tracking === 'idle' &&
				!this.state.modal &&
				(!cloudConfigured || this.state.cloud.status === 'approved')
			) {
				this.toast('GPS is standing by. Press Start GPS when you are ready to walk.', 'info', 5000);
			}
		}, 1800);
	}

	async requestPersistentStorage(): Promise<void> {
		try {
			if (navigator.storage?.persist) await navigator.storage.persist();
		} catch {
			/* Storage persistence is best-effort. */
		}
	}

	bindWindowEvents() {
		document.addEventListener(
			'pointerdown',
			() => {
				this.userGesture = true;
			},
			{ once: true, capture: true }
		);
		document.addEventListener(
			'keydown',
			() => {
				this.userGesture = true;
			},
			{ once: true, capture: true }
		);

		this.resizeHandler = () => {
			this.map?.resize?.();
			this.resizeFog();
			this.scheduleRender();
		};
		window.addEventListener('resize', this.resizeHandler);
		window.addEventListener('orientationchange', () => {
			setTimeout(() => this.resizeHandler?.(), 250);
		});
		window.addEventListener('beforeunload', () => this.saveNow());
		window.addEventListener('pagehide', () => {
			this.finalizeSession();
			this.saveNow();
		});
		window.addEventListener('pageshow', () => {
			if (this.state.session?.archived) this.newSession();
		});
		document.addEventListener('visibilitychange', () => this.onVisibility());
		window.addEventListener('mistwalk:google-auth-failure', () => void this.onGoogleAuthFailure());
		window.addEventListener('online', () => this.toast('Back online.', 'success', 2200));
		window.addEventListener('offline', () =>
			this.toast('Offline. Map tiles may pause, but your progress is safe.', 'warn', 5000)
		);
		document.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && this.state.modal) this.closeAllModals();
		});

		setInterval(() => this.tick(), 1000);
		setInterval(() => {
			if (this.state.tracking === 'live' || this.state.profile === 'demo') this.saveNow();
			else if (this.state.session?.distance > 0) this.saveNow();
		}, 15_000);
	}

	/* ------------------------------------------------------------------ */
	/* Map                                                                 */
	/* ------------------------------------------------------------------ */

	async buildMap(
		provider: string,
		view: { lat: number; lng: number; zoom?: number },
		{ silent = false }: { silent?: boolean } = {}
	): Promise<void> {
		if (!this.mapContainer || !this.mapShell) throw new Error('Map container is not ready.');
		if (this.map) {
			try {
				this.map.destroy();
			} catch {
				/* ignore */
			}
			this.map = null;
			this.state.provider = null;
		}
		this.fog = null;
		this.mapContainer.innerHTML = '';

		const ready = makeReadySignal();
		let engine: MapEngine | null = null;
		let authHandler: (() => void) | null = null;
		let authFailure: Promise<never>;

		const common = {
			container: this.mapContainer,
			fogHost: this.mapShell,
			center: { lat: view.lat, lng: view.lng },
			zoom: view.zoom || 16,
			basemap: this.state.settings.basemap,
			onReady: () => ready.resolve(),
			onViewChange: () => this.onMapViewChange(),
			onUserDrag: () => this.setFollow(false),
			onTileError: () =>
				this.toast(
					'Some map tiles are slow. The free tiles may recover when you move.',
					'warn',
					4200
				),
			onClick: (lat: number, lng: number) => this.onMapClick(lat, lng)
		};

		try {
			if (provider === 'google') {
				if (!this.state.settings.googleKey) throw new Error('Google Maps needs an API key.');
				this.setStatus('locating', 'Connecting', 'Google Maps');
				authFailure = new Promise<never>((_, reject) => {
					authHandler = () => reject(new Error('Google rejected the key.'));
					window.addEventListener('mistwalk:google-auth-failure', authHandler, { once: true });
				});
				const { GoogleMap } = await import('./map-google.ts');
				engine = await GoogleMap.create({ ...common, key: this.state.settings.googleKey });
				await Promise.race([
					withTimeout(ready.promise, 12_000, 'Google Maps overlay timed out.'),
					authFailure
				]);
				this.map = engine;
				this.state.provider = 'google';
			} else {
				const { OsmMap } = await import('./map-osm.ts');
				engine = new OsmMap(common);
				await withTimeout(ready.promise, 6000, 'The free map took too long to start.');
				this.map = engine;
				this.state.provider = 'osm';
			}
		} catch (err) {
			if (authHandler) window.removeEventListener('mistwalk:google-auth-failure', authHandler);
			try {
				engine?.destroy();
			} catch {
				/* ignore */
			}
			if (provider === 'google') {
				this.state.settings.provider = 'osm';
				saveSettings(this.state.settings);
				if (!silent) this.toast('Google Maps unavailable. Switched to the free map.', 'warn', 5200);
				return this.buildMap('osm', view, { silent: true });
			}
			throw err;
		} finally {
			if (authHandler) window.removeEventListener('mistwalk:google-auth-failure', authHandler);
		}

		if (!this.map) throw new Error('The map engine did not start.');
		this.fog = new FogRenderer(this.map.canvas);
		this.googleFailureHandled = false;
		this.resizeFog();
		this.map.resize?.();
		if (this.state.current && this.state.follow) {
			this.map.setView(
				this.state.current.lat,
				this.state.current.lng,
				Math.max(17, this.map.zoom),
				false
			);
		}
		this.refreshProvider();
		this.scheduleRender();
		if (!silent) {
			this.setStatus(
				this.state.profile === 'demo' ? 'demo' : 'idle',
				this.state.profile === 'demo' ? 'Simulation' : 'Standby',
				this.state.profile === 'demo' ? 'Virtual GPS' : ''
			);
		}
	}

	async onGoogleAuthFailure() {
		if (this.state.provider !== 'google' || this.googleFailureHandled) return;
		this.googleFailureHandled = true;
		this.state.settings.provider = 'osm';
		saveSettings(this.state.settings);
		this.toast('Google Maps rejected this key. The free map is still here.', 'warn', 6000);
		const view = this.currentMapView();
		try {
			await this.buildMap('osm', view, { silent: true });
			if (this.state.profile === 'demo') this.enterDemo();
			else this.refreshStatus();
		} catch (err) {
			console.error('Fallback map failed', err);
		}
	}

	resizeFog() {
		if (!this.fog || !this.map) return;
		const width =
			this.state.provider === 'google'
				? this.map.width || this.mapContainer?.clientWidth || this.mapShell?.clientWidth
				: this.mapShell?.clientWidth;
		const height =
			this.state.provider === 'google'
				? this.map.height || this.mapContainer?.clientHeight || this.mapShell?.clientHeight
				: this.mapShell?.clientHeight;
		this.fog.resize(width || 1, height || 1, window.devicePixelRatio || 1);
	}

	onMapViewChange() {
		this.scheduleRender();
		if (this.saveTimer == null && this.map) this.scheduleSave(1500);
	}

	scheduleRender() {
		if (this.renderQueued) return;
		this.renderQueued = true;
		requestAnimationFrame(() => {
			this.renderQueued = false;
			this.renderMap();
		});
	}

	renderMap() {
		if (!this.map || !this.fog) return;
		const bounds = this.map.bounds;
		if (!bounds) return;
		this.pulses = this.pulses.filter((pulse) => performance.now() - pulse.t < 1500);
		this.fog.render({
			project: (lat: number, lng: number) => this.map?.project(lat, lng) || null,
			cells: this.state.progress?.cells || {},
			recent: this.recent,
			path: this.state.progress?.path || [],
			current:
				this.state.profile === 'demo'
					? this.state.sim.position
						? {
								...this.state.sim.position,
								accuracy: 4,
								heading: this.state.current?.heading ?? null
							}
						: this.state.current
					: this.state.current,
			target: this.state.profile === 'demo' ? this.state.sim.target : null,
			guide: this.state.guide,
			replay: this.state.replay,
			bounds,
			time: performance.now(),
			reducedMotion: this.reducedMotion,
			showGrid: this.state.settings.showGrid,
			showFavorites: this.state.settings.showFavorites,
			places: this.state.places,
			highlightPlace: this.state.highlightPlace,
			pulses: this.pulses,
			zoom: this.map.zoom
		});
		if (this.recent.size > 5000) {
			const cutoff = performance.now() - 10 * 60 * 1000;
			for (const [key, time] of this.recent) {
				if (time < cutoff) this.recent.delete(key);
			}
		}
	}

	startPulseLoop() {
		if (this.pulseRaf) return;
		const frame = () => {
			if (!this.state.progress) {
				this.pulseRaf = null;
				return;
			}
			this.pulses = this.pulses.filter((pulse) => performance.now() - pulse.t < 1500);
			this.renderMap();
			if (this.pulses.length) this.pulseRaf = requestAnimationFrame(frame);
			else this.pulseRaf = null;
		};
		this.pulseRaf = requestAnimationFrame(frame);
	}

	/* ------------------------------------------------------------------ */
	/* UI helpers                                                          */
	/* ------------------------------------------------------------------ */

	toast(message: string, kind = 'info', duration = 3400): void {
		if (!message) return;
		const id = ++this.toastId;
		this.state.toasts.push({ id, message, kind, leaving: false });
		while (this.state.toasts.length > 3) this.state.toasts.shift();
		setTimeout(() => {
			const entry = this.state.toasts.find((item: { id: number }) => item.id === id);
			if (entry) entry.leaving = true;
			setTimeout(() => {
				const index = this.state.toasts.findIndex((item: { id: number }) => item.id === id);
				if (index !== -1) this.state.toasts.splice(index, 1);
			}, 260);
		}, duration);
	}

	setStatus(statusState: string, label: string, detail = ''): void {
		this.state.status = { state: statusState, label, detail };
	}

	playUnlockSound() {
		if (!this.state.settings.sound || !this.userGesture) return;
		try {
			const AudioCtx =
				window.AudioContext ||
				(window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
			if (!AudioCtx) return;
			if (!this.audio) this.audio = new AudioCtx();
			if (this.audio.state === 'suspended') void this.audio.resume();
			const ctx = this.audio;
			const now = ctx.currentTime;
			[660, 990, 1320].forEach((freq, index) => {
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = 'sine';
				osc.frequency.setValueAtTime(freq, now + index * 0.045);
				gain.gain.setValueAtTime(0.0001, now + index * 0.045);
				gain.gain.exponentialRampToValueAtTime(0.035, now + index * 0.045 + 0.012);
				gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.045 + 0.34);
				osc.connect(gain).connect(ctx.destination);
				osc.start(now + index * 0.045);
				osc.stop(now + index * 0.045 + 0.36);
			});
		} catch {
			/* Audio is optional. */
		}
	}

	haptic() {
		if (!this.state.settings.haptics || !this.userGesture) return;
		try {
			navigator.vibrate?.(18);
		} catch {
			/* ignore */
		}
	}

	flashUnlock() {
		let x = 50;
		let y = 50;
		if (this.state.current && this.map) {
			const p = this.map.project(this.state.current.lat, this.state.current.lng);
			if (p) {
				x = (p.x / Math.max(1, this.mapShell?.clientWidth || 1)) * 100;
				y = (p.y / Math.max(1, this.mapShell?.clientHeight || 1)) * 100;
			}
		}
		this.state.flash = { active: false, x, y };
		requestAnimationFrame(() => {
			this.state.flash.active = true;
		});
		setTimeout(() => {
			this.state.flash.active = false;
		}, 1050);
	}

	newSession() {
		this.finalizeSession();
		this.state.session = {
			id:
				globalThis.crypto?.randomUUID?.() ||
				`walk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
			startedAt: Date.now(),
			pausedAt: null,
			lastAcceptedAt: null,
			distance: 0,
			walkingMs: 0,
			unlocks: 0,
			speed: 0,
			profile: this.state.profile,
			path: [],
			archived: false
		};
		this.refreshSession();
	}

	finalizeSession() {
		const progress = this.state.progress;
		const session = this.state.session;
		if (!progress || !session || session.archived) return null;
		const record = archiveSession(progress, session, Date.now());
		if (record) {
			saveProfile(record.profile, progress);
			this.refreshProgress();
		}
		return record;
	}

	sessionElapsed() {
		if (!this.state.session) return 0;
		const end = this.state.session.pausedAt || Date.now();
		return Math.max(0, end - this.state.session.startedAt);
	}

	pauseSession() {
		if (this.state.session && !this.state.session.pausedAt)
			this.state.session.pausedAt = Date.now();
	}

	resumeSession() {
		if (this.state.session?.archived) this.newSession();
		if (!this.state.session?.pausedAt) return;
		this.state.session.startedAt += Date.now() - this.state.session.pausedAt;
		this.state.session.pausedAt = null;
	}

	refreshAll() {
		this.refreshProgress();
		this.refreshSession();
		this.refreshPosition();
		this.refreshGpsQuality();
		this.refreshFollow();
		this.refreshWalkButton();
		this.refreshProvider();
		this.refreshSim();
		this.refreshStatus();
		this.state.ui.storageUsage = `Local storage: ${this.formatBytes(localUsageBytes())} · IndexedDB mirror on`;
	}

	formatBytes(bytes: number): string {
		return bytes > 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
	}

	refreshProgress() {
		if (!this.state.progress) return;
		const stats = progressStats(this.state.progress);
		this.state.stats = stats;
		const level = stats.level;
		const ui = this.state.ui;
		ui.levelName = level.name;
		ui.levelNumber = pad2(level.index + 1);
		ui.levelTag = level.tag;
		ui.levelProgress = Math.round(level.progress * 100);
		ui.statArea = formatArea(stats.areaM2, this.state.settings.units);
		ui.statTiles = `${stats.cellCount.toLocaleString()} tile${stats.cellCount === 1 ? '' : 's'}`;
		ui.statDistance = formatDistance(stats.distance, this.state.settings.units);
		ui.statStreak = String(stats.streak);
		ui.favoriteSummary = stats.favoriteCells
			? `${stats.favoriteCells.toLocaleString()} repeat-visit tile${stats.favoriteCells === 1 ? '' : 's'}, up to ${stats.maxVisits}×`
			: 'Walk a route twice to map repeat visits.';
		ui.walkSpeedUnit = speedUnit(this.state.settings.units);

		const sessions = groupSessionsByDay(this.state.progress.sessions || [])
			.reverse()
			.map((session: ArchivedSession) => ({
				...session,
				dateLabel: session.startedAt
					? new Date(session.startedAt).toLocaleDateString(undefined, {
							weekday: 'short',
							month: 'short',
							day: 'numeric',
							year: 'numeric'
						})
					: 'Unknown date',
				durationLabel: formatClock(
					session.walkingMs || Math.max(0, session.endedAt - session.startedAt)
				),
				distanceLabel: formatDistance(session.distance, this.state.settings.units),
				profileLabel: session.profile === 'demo' ? 'Simulator' : 'Live',
				pointCount: session.path?.length || 0
			}));
		const notes = listCellNotes(this.state.progress).map((note) => ({
			...note,
			coordsLabel: formatCoordinate(note.lat, note.lng),
			dateLabel: note.t ? new Date(note.t).toLocaleString() : 'No date'
		}));
		const places = listPlaces(this.state.progress).map((place) => ({
			...place,
			coordsLabel: formatCoordinate(place.lat, place.lng),
			dateLabel: place.ut || place.t ? new Date(place.ut || place.t).toLocaleString() : 'No date'
		}));
		const achievements = achievementsFor(this.state.progress, stats);
		const earned = new Set(achievements.filter((badge) => badge.earned).map((badge) => badge.id));
		if (this.earnedAchievements) {
			for (const badge of achievements) {
				if (badge.earned && !this.earnedAchievements.has(badge.id)) {
					this.toast(`Badge earned: ${badge.title}.`, 'success', 4200);
				}
			}
		}
		this.earnedAchievements = earned;
		this.state.sessions = sessions;
		this.state.notes = notes;
		this.state.places = places;
		this.state.achievements = achievements;
		ui.badgeCount = `${earned.size}/${achievements.length}`;
		ui.sessionCount = `${stats.sessions} walk${stats.sessions === 1 ? '' : 's'}`;
		ui.historyCount = `${sessions.length} day${sessions.length === 1 ? '' : 's'}`;
		ui.noteCount = `${notes.length} note${notes.length === 1 ? '' : 's'}`;
		ui.placeCount = `${places.length} place${places.length === 1 ? '' : 's'}`;
		if (
			this.state.highlightPlace &&
			this.state.highlightPlace !== this.state.placeDraft?.key &&
			!places.some((place) => place.key === this.state.highlightPlace)
		) {
			this.state.highlightPlace = null;
		}
		if (typeof document !== 'undefined') {
			document.title = stats.cellCount
				? `MistWalk: ${stats.cellCount.toLocaleString()} tiles revealed`
				: 'MistWalk: walk to uncover the world';
		}
		this.scheduleRender();
	}

	refreshSession() {
		if (!this.state.session) return;
		const ui = this.state.ui;
		ui.walkTime = formatClock(this.sessionElapsed());
		ui.walkDistance = formatDistance(this.state.session.distance, this.state.settings.units);
		ui.walkSpeed = formatSpeed(this.state.session.speed || 0, this.state.settings.units);
		ui.walkUnlocks = String(this.state.session.unlocks);
		ui.walkLive =
			this.state.profile === 'demo'
				? Boolean(this.state.sim.target) && !this.state.sim.paused
				: this.state.tracking === 'live' || this.state.tracking === 'locating';
	}

	refreshPosition() {
		const ui = this.state.ui;
		const current = this.state.current;
		if (current) {
			ui.coordText = formatCoordinate(current.lat, current.lng);
			ui.heading = Number.isFinite(current.heading) ? current.heading : null;
		} else {
			ui.coordText = '—';
			ui.heading = null;
		}
		const googlePoint = current || (this.map ? this.map.center : null);
		if (googlePoint) {
			ui.googleLink = `https://www.google.com/maps/search/?api=1&query=${googlePoint.lat.toFixed(6)},${googlePoint.lng.toFixed(6)}`;
		}
		this.refreshProvider();
		if (
			current &&
			Number.isFinite(current.accuracy) &&
			['live', 'weak', 'vehicle'].includes(this.state.status.state)
		) {
			this.state.status.detail = `±${Math.round(current.accuracy)} m`;
		}
	}

	refreshGpsQuality() {
		const current = this.state.current;
		const source = this.state.profile === 'demo' && current ? 'sim' : 'gps';
		const ageMs = source === 'gps' && this.lastFixAt ? Date.now() - this.lastFixAt : null;
		const quality = gpsQuality({
			accuracy: current?.accuracy,
			ageMs,
			source,
			tracking: this.state.tracking
		});
		this.state.gps.accuracy = Number.isFinite(current?.accuracy) ? current.accuracy : null;
		this.state.gps.ageMs = ageMs;
		this.state.gps.quality = quality.level;
		this.state.ui.gpsLabel = quality.label;
		this.state.ui.gpsDetail = quality.detail;
		this.state.ui.gpsLevel = quality.level;
	}

	applyAccessibility() {
		if (typeof document === 'undefined') return;
		const root = document.documentElement;
		root.dataset.theme = this.state.settings.theme === 'paper' ? 'paper' : 'night';
		root.dataset.contrast = this.state.settings.highContrast ? 'high' : 'normal';
		root.dataset.motion = this.state.settings.reduceMotion ? 'reduce' : 'auto';
		this.reducedMotion =
			this.state.settings.reduceMotion ||
			(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
	}

	async initBattery() {
		const nav = navigator as Navigator & {
			getBattery?: () => Promise<{
				level: number;
				charging: boolean;
				addEventListener?: (type: string, handler: () => void) => void;
			}>;
		};
		if (!nav.getBattery) return;
		try {
			const battery = await nav.getBattery();
			const update = () => {
				this.state.battery = {
					level: Math.round((battery.level || 0) * 100),
					charging: Boolean(battery.charging)
				};
			};
			update();
			battery.addEventListener?.('levelchange', update);
			battery.addEventListener?.('chargingchange', update);
		} catch {
			this.state.battery = null;
		}
	}

	refreshProvider() {
		const ui = this.state.ui;
		if (this.map) {
			ui.providerLabel = this.map.providerLabel;
			ui.attribution =
				this.state.provider === 'google'
					? GOOGLE_ATTRIBUTION
					: osmAttribution(this.state.settings.basemap);
		} else {
			ui.providerLabel = 'Connecting…';
			ui.attribution = ATTRIBUTION_FALLBACK;
		}
	}

	refreshFollow() {
		this.state.ui.followActive = this.state.follow;
		this.state.ui.followLabel = this.state.follow ? 'Following' : 'Recenter';
	}

	refreshWalkButton() {
		const ui = this.state.ui;
		if (this.state.profile === 'demo') {
			const walking = Boolean(this.state.sim.target) && !this.state.sim.paused;
			ui.walkButtonIcon = walking ? '#i-pause' : '#i-play';
			ui.walkButtonLabel = walking ? 'Pause' : this.state.sim.paused ? 'Resume' : 'Walk';
			return;
		}
		const running = this.state.tracking === 'live' || this.state.tracking === 'locating';
		ui.walkButtonIcon = running ? '#i-pause' : '#i-play';
		ui.walkButtonLabel = running
			? 'Pause'
			: this.state.tracking === 'paused'
				? 'Resume'
				: 'Start GPS';
	}

	refreshSim() {
		const visible = this.state.profile === 'demo';
		this.state.ui.simHint = this.state.sim.target
			? this.state.sim.paused
				? 'Paused. Tap the map to continue.'
				: 'Walking to your marker…'
			: 'Tap the map to walk there.';
		this.state.ui.simSpeedLabel = `${this.state.sim.multiplier}×`;
		this.state.ui.simVisible = visible;
	}

	refreshStatus() {
		if (this.state.profile === 'demo') {
			if (this.state.sim.paused) this.setStatus('paused', 'Sim paused', 'Virtual GPS');
			else this.setStatus('demo', 'Simulation', 'Virtual GPS');
			return;
		}
		if (this.state.tracking === 'locating')
			this.setStatus('locating', 'Locating', 'Waiting for GPS');
		else if (this.state.tracking === 'paused') this.setStatus('paused', 'Paused', '');
		else if (this.state.tracking === 'error') this.setStatus('error', 'GPS blocked', '');
		else if (this.state.tracking === 'live') {
			this.setStatus(
				'live',
				'Live',
				this.state.current ? `±${Math.round(this.state.current.accuracy || 0)} m` : ''
			);
		} else this.setStatus('idle', 'Standby', 'GPS off');
	}

	initialView() {
		const last = this.state.progress?.last;
		if (last && Number.isFinite(last.lat) && Number.isFinite(last.lng)) {
			return { lat: last.lat, lng: last.lng, zoom: Number.isFinite(last.zoom) ? last.zoom : 16 };
		}
		return { ...DEFAULT_VIEW };
	}

	currentMapView() {
		if (this.map) return { ...this.map.center, zoom: this.map.zoom };
		return this.initialView();
	}

	/* ------------------------------------------------------------------ */
	/* Live GPS                                                            */
	/* ------------------------------------------------------------------ */

	async maybeAutoStartLive() {
		if (this.state.profile !== 'live') return;
		if (this.liveAccessBlocked()) return;
		if (!navigator.geolocation) {
			this.state.tracking = 'error';
			this.refreshStatus();
			this.toast('This browser does not expose geolocation.', 'error', 6000);
			return;
		}
		if (!window.isSecureContext) {
			this.state.tracking = 'error';
			this.refreshStatus();
			this.showGpsError(
				'This page is not secure, so the browser will not share GPS. Open it through localhost or an HTTPS address.'
			);
			return;
		}

		let permission = 'prompt';
		try {
			if (navigator.permissions?.query) {
				const result = await navigator.permissions.query({ name: 'geolocation' });
				permission = result.state;
				result.addEventListener?.('change', () => {
					if (
						result.state === 'granted' &&
						this.state.profile === 'live' &&
						this.state.tracking !== 'live' &&
						this.state.settings.autoTrack
					) {
						void this.startLiveTracking();
					}
				});
			}
		} catch {
			/* Permissions API varies by browser. */
		}

		if (permission === 'granted' && this.state.settings.autoTrack) {
			await this.startLiveTracking();
		} else if (permission === 'denied') {
			this.state.tracking = 'error';
			this.refreshStatus();
			this.toast(
				'GPS is blocked for this page. Use the simulator or allow location in site settings.',
				'warn',
				6000
			);
		} else {
			this.state.tracking = 'idle';
			this.refreshStatus();
		}
	}

	async startLiveTracking({ userInitiated = false } = {}) {
		if (this.state.profile !== 'live' || this.watchId !== null) return;
		if (this.liveAccessBlocked()) {
			if (userInitiated) this.noteAccessRequired();
			return;
		}
		if (!navigator.geolocation) {
			this.state.tracking = 'error';
			this.refreshStatus();
			this.toast('This browser does not support GPS.', 'error', 5000);
			return;
		}
		if (!window.isSecureContext) {
			this.showGpsError(
				'GPS needs a secure page. Use localhost on this computer, or an HTTPS address on your phone.'
			);
			return;
		}

		this.state.tracking = 'locating';
		this.state.follow = true;
		this.refreshFollow();
		this.refreshWalkButton();
		this.setStatus('locating', 'Locating', 'Waiting for GPS');
		if (userInitiated) this.resumeSession();
		if (this.state.current) this.gate.reanchor();

		try {
			this.watchId = navigator.geolocation.watchPosition(
				(position) => this.onGeoFix(position),
				(error) => this.onGeoError(error),
				{ enableHighAccuracy: true, maximumAge: 1000, timeout: 25_000 }
			);
		} catch (err) {
			this.watchId = null;
			this.state.tracking = 'error';
			this.refreshStatus();
			this.showGpsError(`GPS could not start: ${errorMessage(err) || 'unknown error'}`);
		}
	}

	stopLiveTracking({ pause = true } = {}) {
		if (this.watchId !== null) {
			try {
				navigator.geolocation.clearWatch(this.watchId);
			} catch {
				/* ignore */
			}
			this.watchId = null;
		}
		this.releaseWakeLock();
		if (pause) {
			if (this.state.tracking !== 'idle' && this.state.tracking !== 'error') {
				this.state.tracking = 'paused';
				this.pauseSession();
				this.refreshWalkButton();
				this.refreshStatus();
			}
		} else if (['live', 'locating', 'paused'].includes(this.state.tracking)) {
			this.state.tracking = 'idle';
		}
	}

	onGeoFix(position: GeolocationPosition): void {
		if (this.state.profile !== 'live') return;
		const coords = position.coords || {};
		const fix = normalizeFix({
			lat: coords.latitude,
			lng: coords.longitude,
			accuracy: coords.accuracy,
			speed: coords.speed,
			heading: coords.heading,
			t: position.timestamp || Date.now()
		});
		if (!fix) return;
		const wasLocating = this.state.tracking !== 'live';
		this.state.tracking = 'live';
		this.lastFixAt = Date.now();
		if (!this.hasCentered && this.map) {
			this.map.setView(fix.lat, fix.lng, Math.max(17, this.map.zoom), false);
			this.hasCentered = true;
		}
		this.setStatus('live', 'Live', fix.accuracy ? `±${Math.round(fix.accuracy)} m` : '');
		this.handleFix(fix, 'gps');
		this.acquireWakeLock();
		if (wasLocating) this.toast('GPS locked. Walk to lift the mist.', 'success', 3800);
	}

	onGeoError(error: GeolocationPositionError): void {
		const code = error?.code;
		if (code === 1) {
			this.stopLiveTracking({ pause: false });
			this.state.tracking = 'error';
			this.refreshStatus();
			this.refreshWalkButton();
			this.releaseWakeLock();
			this.showGpsError(
				'Location access was blocked. Allow it in your browser’s site settings, then retry.'
			);
			return;
		}
		if (this.state.tracking !== 'live') {
			this.state.tracking = 'locating';
			this.setStatus('locating', 'Searching', 'No GPS fix yet');
		}
		this.toast(
			code === 3
				? 'Still looking for GPS. Move outdoors or near a window.'
				: 'GPS is temporarily unavailable. The map will retry.',
			'warn',
			5000
		);
	}

	/* ------------------------------------------------------------------ */
	/* Fix handling                                                        */
	/* ------------------------------------------------------------------ */

	handleFix(rawFix: FixInput, source = 'gps'): void {
		const fix = normalizeFix(rawFix);
		if (!fix) return;
		if (this.state.profile === 'demo' && source !== 'sim') return;
		if (this.state.profile === 'live' && source !== 'gps') return;

		const previous = this.state.current;
		let heading = fix.heading;
		if (heading === null && previous && previous.lat !== undefined) {
			const moved = haversineMeters(previous, fix);
			if (moved > 1) heading = bearingDegrees(previous, fix);
		}

		if (source === 'sim') this.state.sim.position = { lat: fix.lat, lng: fix.lng };
		this.state.current = {
			lat: fix.lat,
			lng: fix.lng,
			accuracy: fix.accuracy,
			speed: fix.speed,
			heading: heading ?? previous?.heading ?? null,
			source,
			t: fix.t
		};
		if (source === 'gps') this.lastFixAt = Date.now();

		const verdict = this.gate.evaluate(fix);
		const session = this.state.session;

		if (session && verdict.walking && (verdict.unlock || verdict.distance > 0)) {
			appendSessionPoint(session, fix, fix.t);
		}

		if (verdict.distance > 0 && session) {
			session.distance += verdict.distance;
			this.state.progress.stats.distance += verdict.distance;
			const last = session.lastAcceptedAt;
			if (last !== null && fix.t > last) {
				const delta = Math.min(15_000, fix.t - last);
				session.walkingMs += delta;
				this.state.progress.stats.walkingMs += delta;
			}
		}
		if (session && verdict.walking && verdict.distance > 0) {
			session.lastAcceptedAt = fix.t;
			this.refreshProgress();
		}

		let addedCount = 0;
		if (verdict.unlock) {
			const from = verdict.from || fix;
			const cells = cellsAlongLine(from, fix, 5);
			if (!cells.length) cells.push(cellFromLatLng(fix.lat, fix.lng));
			const added = unlockCells(this.state.progress, cells, fix.t, source, session?.id || '');
			addedCount = added.length;
			if (added.length) {
				session.unlocks += added.length;
				const now = performance.now();
				for (const cell of added.slice(0, 18)) {
					this.recent.set(cell.key, now);
					const center = cellCenter(cell);
					this.pulses.push({ lat: center.lat, lng: center.lng, t: performance.now() });
				}
				this.flashUnlock();
				this.haptic();
				this.playUnlockSound();
				this.queueUnlockToast(added.length);
				this.startPulseLoop();
				this.refreshProgress();
				if (this.state.guide && added.some((cell) => cell.key === this.state.guide.key)) {
					this.state.guide = null;
					this.toast('Nearest mist cleared. A new patch is waiting.', 'success', 3200);
				}
			}
			appendPath(this.state.progress, fix, fix.t);
			this.state.progress.stats.lastWalkAt = fix.t;
			if (this.state.tracking === 'live') {
				this.setStatus('live', 'Live', fix.accuracy ? `±${Math.round(fix.accuracy)} m` : '');
			}
		} else if (verdict.reason === 'too-fast') {
			const modeLabel = TRAVEL_MODE_LABELS[verdict.mode];
			if (verdict.vehicle) {
				if (Date.now() - this.lastVehicleToast > 20_000) {
					this.lastVehicleToast = Date.now();
					this.toast(
						`${modeLabel} speed detected. Unlocking is paused until you walk again.`,
						'warn',
						5000
					);
					this.haptic();
				}
				this.setStatus('vehicle', modeLabel, 'Unlock paused');
			} else {
				if (Date.now() - this.lastFastToast > 20_000) {
					this.lastFastToast = Date.now();
					this.toast(
						`${modeLabel} speed is too fast to count. Slow to walking pace and the mist will lift again.`,
						'warn',
						4800
					);
				}
				this.setStatus('vehicle', modeLabel, 'Unlock paused');
			}
		} else if (verdict.reason === 'vehicle-lockout') {
			this.setStatus('vehicle', TRAVEL_MODE_LABELS[verdict.mode], 'Unlock paused');
		} else if (verdict.reason === 'weak-gps') {
			if (Date.now() - this.lastWeakToast > 25_000) {
				this.lastWeakToast = Date.now();
				this.toast(
					'GPS accuracy is too low to unlock tiles. Step outside or wait for a better fix.',
					'warn',
					4500
				);
			}
			if (this.state.tracking === 'live') {
				this.setStatus('weak', 'Weak GPS', `±${Math.round(fix.accuracy || 0)} m`);
			}
		} else if (verdict.reason === 'resume-jump' || verdict.reason === 'gps-jump') {
			this.toast('Tracking resumed after a gap. Walk a few steps to continue.', 'info', 3800);
		} else if (this.state.tracking === 'live') {
			this.setStatus('live', 'Live', fix.accuracy ? `±${Math.round(fix.accuracy)} m` : '');
		}

		if (this.state.progress.last) {
			this.state.progress.last.lat = fix.lat;
			this.state.progress.last.lng = fix.lng;
			this.state.progress.last.at = fix.t;
		} else {
			this.state.progress.last = {
				lat: fix.lat,
				lng: fix.lng,
				zoom: this.map?.zoom || 16,
				at: fix.t
			};
		}
		if (this.map) this.state.progress.last.zoom = this.map.zoom;

		if (verdict.distance > 0) session.speed = verdict.speed || 0;
		else if (verdict.walking && verdict.reason === 'stationary') session.speed = 0;

		if (this.state.follow) this.followCurrent();
		this.refreshPosition();
		this.refreshSession();
		this.refreshWalkButton();
		this.scheduleRender();
		if (verdict.distance > 0 || addedCount > 0 || verdict.reason === 'first-fix')
			this.scheduleSave(700);
	}

	queueUnlockToast(count: number): void {
		this.pendingUnlocks += count;
		if (this.unlockToastTimer) return;
		this.unlockToastTimer = setTimeout(() => {
			const n = this.pendingUnlocks;
			this.pendingUnlocks = 0;
			this.unlockToastTimer = null;
			if (n > 0) this.toast(`${n} new tile${n === 1 ? '' : 's'} revealed.`, 'success', 3000);
		}, 650);
	}

	/* ------------------------------------------------------------------ */
	/* Following / view                                                    */
	/* ------------------------------------------------------------------ */

	followCurrent(force = false) {
		if (!this.map || !this.state.follow) return;
		const point = this.state.current || this.state.sim.position;
		if (!point) return;
		if (!this.hasCentered || force) {
			this.map.setView(point.lat, point.lng, Math.max(17, this.map.zoom), false);
			this.hasCentered = true;
			return;
		}
		const p = this.map.project(point.lat, point.lng);
		if (!p) {
			this.map.panTo(point.lat, point.lng, true);
			return;
		}
		const width = this.mapShell?.clientWidth || 1;
		const height = this.mapShell?.clientHeight || 1;
		if (p.x < width * 0.28 || p.x > width * 0.72 || p.y < height * 0.24 || p.y > height * 0.72) {
			this.map.panTo(point.lat, point.lng, true);
		}
	}

	setFollow(value: boolean, { recenter = false }: { recenter?: boolean } = {}): void {
		this.state.follow = value;
		this.refreshFollow();
		if (value && recenter) this.followCurrent(true);
	}

	toggleFollow() {
		if (this.state.follow) {
			this.setFollow(false);
			this.toast('Following paused. Pan freely.', 'info', 2200);
			return;
		}
		this.setFollow(true, { recenter: true });
	}

	recenter() {
		const point = this.state.current || this.state.sim.position;
		if (!point) {
			if (this.state.profile === 'live') void this.startLiveTracking({ userInitiated: true });
			else this.toast('No walker yet. Tap the map to place yourself.', 'info', 3200);
			return;
		}
		this.setFollow(true, { recenter: true });
	}

	fitExplored() {
		if (!this.map) return;
		const keys = Object.keys(this.state.progress.cells);
		if (!keys.length) {
			this.toast('Nothing revealed yet. Walk to unlock your first tile.', 'info', 3200);
			return;
		}
		let north = -90;
		let south = 90;
		let east = -180;
		let west = 180;
		for (const key of keys) {
			const cell = parseCellKey(key);
			if (!cell) continue;
			const b = cellToBounds(cell);
			north = Math.max(north, b.north);
			south = Math.min(south, b.south);
			east = Math.max(east, b.east);
			west = Math.min(west, b.west);
		}
		if (!Number.isFinite(north) || north <= south) return;
		this.state.follow = false;
		this.refreshFollow();
		this.map.fitBounds({ north, south, east, west }, 56);
		this.toast('Showing everything you have revealed.', 'info', 2600);
	}

	zoomIn() {
		this.map?.zoomBy(1);
	}

	zoomOut() {
		this.map?.zoomBy(-1);
	}

	/* ------------------------------------------------------------------ */
	/* Journey, notes and replay                                           */
	/* ------------------------------------------------------------------ */

	currentPoint() {
		return this.state.current || this.state.sim.position || this.map?.center || null;
	}

	currentCellKey() {
		const point = this.currentPoint();
		if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
		return cellFromLatLng(point.lat, point.lng).key;
	}

	noteForCurrent() {
		const key = this.currentCellKey();
		return key ? this.state.progress?.notes?.[key]?.text || '' : '';
	}

	currentCellLabel() {
		const cell = parseCellKey(this.currentCellKey());
		if (!cell) return '';
		const center = cellCenter(cell);
		return formatCoordinate(center.lat, center.lng);
	}

	saveNote(text: string): string {
		const key = this.currentCellKey();
		if (!key || !this.state.progress) {
			this.toast('Move the map to a place before leaving a note.', 'info', 3000);
			return '';
		}
		const value = setCellNote(this.state.progress, key, text, Date.now());
		this.refreshProgress();
		this.scheduleSave(200);
		this.toast(
			value ? 'Tile note saved locally.' : 'Tile note removed.',
			value ? 'success' : 'info',
			2800
		);
		return value;
	}

	deleteNote(key: string): void {
		if (!this.state.progress) return;
		setCellNote(this.state.progress, key, '', Date.now());
		this.refreshProgress();
		this.scheduleSave(200);
		this.toast('Tile note removed.', 'info', 2400);
	}

	jumpToNote(key: string): void {
		const cell = parseCellKey(key);
		if (!cell || !this.map) return;
		const center = cellCenter(cell);
		this.closeAllModals();
		this.state.follow = false;
		this.refreshFollow();
		this.map.setView(center.lat, center.lng, Math.max(17, this.map.zoom), false);
		this.hasCentered = true;
		this.scheduleRender();
		this.toast('Moved to your note.', 'info', 2400);
	}

	placeTargetLabel(): string {
		const draft = this.state.placeDraft as PlaceDraft | null;
		return draft ? formatCoordinate(draft.lat, draft.lng) : '';
	}

	openPlaceForm(lat: number, lng: number): void {
		if (!this.state.progress || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
		const key = cellFromLatLng(lat, lng).key;
		const existing = this.state.progress.places?.[key] as PlaceData | undefined;
		this.state.placeDraft = {
			key,
			lat: existing?.lat ?? lat,
			lng: existing?.lng ?? lng,
			rating: existing?.rating ?? 0,
			name: existing?.name ?? '',
			comment: existing?.comment ?? '',
			t: existing?.t,
			ut: existing?.ut
		} satisfies PlaceDraft;
		this.state.placePick = false;
		this.state.highlightPlace = key;
		this.state.journey.tab = 'places';
		this.openModal('journey-modal');
		this.scheduleRender();
	}

	useCurrentPlace(): void {
		const point = this.currentPoint();
		if (!point) {
			this.toast('No map position yet. Tap the map to choose a place.', 'info', 3000);
			return;
		}
		this.openPlaceForm(point.lat, point.lng);
	}

	startPlacePick(): void {
		this.closeAllModals();
		this.state.placeDraft = null;
		this.state.highlightPlace = null;
		this.state.placePick = true;
		this.scheduleRender();
		this.toast('Tap the map to mark a favorite place.', 'info', 3600);
	}

	togglePlacePick(): void {
		if (this.state.placePick) {
			this.state.placePick = false;
			this.toast('Place pick cancelled.', 'info', 2000);
			return;
		}
		this.startPlacePick();
	}

	clearPlaceDraft(): void {
		this.state.placeDraft = null;
		this.state.highlightPlace = null;
		this.state.placePick = false;
		this.scheduleRender();
	}

	savePlace(input: Partial<PlaceData>): boolean {
		const draft = this.state.placeDraft as PlaceDraft | null;
		if (!draft || !this.state.progress) {
			this.toast('Choose a place on the map first.', 'info', 2800);
			return false;
		}
		const saved = setPlace(
			this.state.progress,
			draft.key,
			{
				lat: draft.lat,
				lng: draft.lng,
				rating: input.rating,
				name: input.name,
				comment: input.comment
			},
			Date.now()
		);
		if (!saved) {
			this.toast('Choose a star rating from 1 to 5.', 'info', 2800);
			return false;
		}
		this.state.placeDraft = { key: draft.key, ...saved } satisfies PlaceDraft;
		this.state.highlightPlace = draft.key;
		this.refreshProgress();
		this.scheduleSave(200);
		this.scheduleRender();
		this.toast('Favorite place saved.', 'success', 2800);
		return true;
	}

	editPlace(key: string): void {
		const place = this.state.progress?.places?.[key] as PlaceData | undefined;
		if (!place) return;
		this.openPlaceForm(place.lat, place.lng);
	}

	deletePlace(key: string): void {
		if (!this.state.progress) return;
		if (!removePlace(this.state.progress, key)) return;
		if (this.state.placeDraft?.key === key) this.state.placeDraft = null;
		if (this.state.highlightPlace === key) this.state.highlightPlace = null;
		this.refreshProgress();
		this.scheduleSave(200);
		this.scheduleRender();
		this.toast('Favorite place removed.', 'info', 2400);
	}

	jumpToPlace(key: string): void {
		const place = this.state.progress?.places?.[key] as PlaceData | undefined;
		if (!place || !this.map) return;
		this.closeAllModals();
		this.state.follow = false;
		this.refreshFollow();
		this.map.setView(place.lat, place.lng, Math.max(17, this.map.zoom), false);
		this.hasCentered = true;
		this.state.highlightPlace = key;
		this.scheduleRender();
		this.toast('Moved to your favorite place.', 'info', 2400);
	}

	placeAt(lat: number, lng: number): (PlaceData & { key: string }) | null {
		if (!this.map || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
		const click = this.map.project(lat, lng);
		if (!click) return null;
		let best: (PlaceData & { key: string }) | null = null;
		let bestDistance = 24;
		for (const place of this.state.places as Array<PlaceData & { key: string }>) {
			const point = this.map.project(place.lat, place.lng);
			if (!point) continue;
			const distance = Math.hypot(point.x - click.x, point.y - click.y);
			if (distance <= bestDistance) {
				best = place;
				bestDistance = distance;
			}
		}
		return best;
	}

	guideToUnexplored() {
		const origin = this.currentPoint();
		const target = nearestUnexplored(this.state.progress, origin);
		if (!origin || !target) {
			this.toast('No unexplored tiles within reach. Try a wider view.', 'info', 3600);
			return;
		}
		this.state.guide = target;
		this.state.follow = false;
		this.refreshFollow();
		const direction = compassLabel(target.bearing);
		this.state.ui.nearestLabel = target.distance
			? `${formatDistanceMeters(target.distance)} ${direction}`
			: 'You are standing in it';
		if (this.map) {
			if (target.distance < 25) {
				this.map.setView(target.lat, target.lng, Math.max(18, this.map.zoom), false);
			} else {
				const north = Math.max(origin.lat, target.lat);
				const south = Math.min(origin.lat, target.lat);
				const east = Math.max(origin.lng, target.lng);
				const west = Math.min(origin.lng, target.lng);
				this.map.fitBounds({ north, south, east, west }, 90);
			}
			this.hasCentered = true;
		}
		this.scheduleRender();
		this.toast(
			target.distance
				? `Nearest mist: ${formatDistanceMeters(target.distance)} ${direction}.`
				: 'You are on an unexplored tile. Walk a few steps to clear it.',
			'info',
			4200
		);
	}

	clearGuide() {
		this.state.guide = null;
		this.state.ui.nearestLabel = 'Find the nearest unexplored tile.';
		this.scheduleRender();
		this.toast('Guide cleared.', 'info', 2000);
	}

	fitPoints(points: PathPoint[]): void {
		if (!this.map || !Array.isArray(points) || points.length < 2) return;
		let north = -90;
		let south = 90;
		let east = -180;
		let west = 180;
		for (const point of points) {
			if (!Array.isArray(point)) continue;
			north = Math.max(north, point[0]);
			south = Math.min(south, point[0]);
			east = Math.max(east, point[1]);
			west = Math.min(west, point[1]);
		}
		if (!Number.isFinite(north) || north <= south) return;
		this.map.fitBounds({ north, south, east, west }, 96);
		this.hasCentered = true;
	}

	playSession(id: string): void {
		const session = this.state.sessions.find((item: SessionView) => item.id === id);
		if (!session?.path || session.path.length < 2) {
			this.toast('That day has no route to replay.', 'info', 2800);
			return;
		}
		this.startReplay({
			id: session.id,
			path: session.path,
			label: `${session.dateLabel} · ${session.durationLabel}`,
			detail: `${session.distanceLabel} · ${session.profileLabel}`
		});
	}

	startReplay(track: ReplayTrackInput): void {
		this.closeAllModals();
		this.stopReplay(false);
		this.state.replay = {
			id: track.id || `route-${Date.now()}`,
			path: track.path,
			label: track.label || 'Route',
			detail: track.detail || '',
			index: track.path.length,
			playing: false,
			rate: 0.02,
			lastFrame: 0
		};
		if (this.reducedMotion) {
			this.state.replay.detail = `${this.state.replay.detail} · motion reduced`.trim();
		}
		this.fitPoints(track.path);
		this.scheduleRender();
	}

	toggleReplay() {
		const replay = this.state.replay;
		if (!replay) return;
		if (this.reducedMotion) {
			this.toast('Route animation is off while Reduce motion is enabled.', 'info', 3200);
			return;
		}
		if (replay.playing) {
			replay.playing = false;
			if (this.replayRaf) cancelAnimationFrame(this.replayRaf);
			this.replayRaf = null;
			this.scheduleRender();
			return;
		}
		if (replay.index >= replay.path.length) replay.index = 1;
		replay.playing = true;
		replay.lastFrame = 0;
		replay.rate = Math.max(0.012, replay.path.length / 14_000);
		if (this.replayRaf) cancelAnimationFrame(this.replayRaf);
		this.replayRaf = requestAnimationFrame((now) => this.replayTick(now));
	}

	replayTick(now: number): void {
		const replay = this.state.replay;
		if (!replay?.playing) {
			this.replayRaf = null;
			return;
		}
		if (!replay.lastFrame) replay.lastFrame = now;
		const delta = Math.max(0, Math.min(120, now - replay.lastFrame));
		replay.lastFrame = now;
		replay.index = Math.min(replay.path.length, replay.index + delta * replay.rate);
		this.scheduleRender();
		if (replay.index >= replay.path.length) {
			replay.playing = false;
			this.replayRaf = null;
			this.toast('Route replay finished.', 'info', 2400);
			return;
		}
		this.replayRaf = requestAnimationFrame((frame) => this.replayTick(frame));
	}

	stopReplay(announce = true) {
		if (this.replayRaf) cancelAnimationFrame(this.replayRaf);
		this.replayRaf = null;
		const hadReplay = Boolean(this.state.replay);
		this.state.replay = null;
		this.scheduleRender();
		if (announce && hadReplay) this.toast('Route overlay cleared.', 'info', 2200);
	}

	/* ------------------------------------------------------------------ */
	/* Simulator                                                           */
	/* ------------------------------------------------------------------ */

	enterDemo() {
		this.state.profile = 'demo';
		this.state.settings.lastProfile = 'demo';
		saveSettings(this.state.settings);
		this.stopLiveTracking({ pause: false });
		const pos = this.state.progress.last || (this.map ? this.map.center : DEFAULT_VIEW);
		this.state.sim.position = { lat: pos.lat, lng: pos.lng };
		this.state.sim.target = null;
		this.state.sim.paused = false;
		this.state.sim.lastFrame = 0;
		this.state.sim.time = Date.now();
		this.state.sim.anchored = Boolean(this.state.progress.last);
		this.state.current = {
			...this.state.sim.position,
			accuracy: 4,
			heading: this.state.current?.heading ?? null,
			source: 'sim'
		};
		this.gate.reset();
		this.hasCentered = true;
		this.state.follow = true;
		if (this.map)
			this.map.setView(
				this.state.sim.position.lat,
				this.state.sim.position.lng,
				Math.max(17, this.map.zoom),
				false
			);
		this.state.onboarding = false;
		this.newSession();
		this.refreshAll();
		this.setStatus('demo', 'Simulation', 'Virtual GPS');
		this.refreshSim();
		this.scheduleRender();
	}

	exitDemo() {
		this.stopSim({ silent: true });
		this.state.current = null;
		this.gate.reset();
		this.state.sim.position = null;
		this.state.sim.target = null;
		this.state.sim.anchored = false;
		this.refreshSim();
		this.refreshWalkButton();
		this.refreshStatus();
	}

	startSimulationTo(lat: number, lng: number): void {
		if (this.state.profile !== 'demo') return;
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
		this.state.sim.target = { lat, lng };
		this.state.sim.paused = false;
		this.state.sim.lastFrame = 0;
		this.state.follow = true;
		this.refreshFollow();
		this.newSessionIfIdle();
		if (!this.state.sim.anchored || !this.state.current) {
			const center = this.map?.center || DEFAULT_VIEW;
			this.state.sim.position = { lat: center.lat, lng: center.lng };
			this.state.sim.anchored = true;
			this.state.sim.time = Date.now();
			this.gate.reset();
			this.handleFix(
				{ ...this.state.sim.position, accuracy: 4, heading: null, t: this.state.sim.time },
				'sim'
			);
			this.state.sim.target = { lat, lng };
		}
		this.refreshSim();
		this.refreshWalkButton();
		if (!this.simRaf) {
			this.state.sim.lastFrame = 0;
			this.simRaf = requestAnimationFrame((now) => this.simTick(now));
		}
	}

	newSessionIfIdle() {
		if (
			!this.state.session ||
			this.state.session.archived ||
			(this.state.session.distance === 0 && this.state.session.unlocks === 0)
		)
			this.newSession();
	}

	simTick(now: number): void {
		const sim = this.state.sim;
		if (this.state.profile !== 'demo' || !sim.target || sim.paused) {
			this.simRaf = null;
			return;
		}
		if (!sim.lastFrame) sim.lastFrame = now;
		let realDelta = (now - sim.lastFrame) / 1000;
		sim.lastFrame = now;
		realDelta = Math.max(0, Math.min(0.12, realDelta));
		if (!realDelta) {
			this.simRaf = requestAnimationFrame((frame) => this.simTick(frame));
			return;
		}
		const simDelta = realDelta * sim.multiplier;
		sim.time += simDelta * 1000;

		if (!sim.position) {
			const center = this.map?.center || DEFAULT_VIEW;
			sim.position = { lat: center.lat, lng: center.lng };
		}
		const target = sim.target;
		const distance = haversineMeters(sim.position, target);
		if (distance < 0.35) {
			this.arriveAtTarget(target);
			return;
		}
		const step = Math.min(distance, WALK_SPEED_MPS * simDelta);
		const fraction = step / distance;
		const next = {
			lat: sim.position.lat + (target.lat - sim.position.lat) * fraction,
			lng: sim.position.lng + (target.lng - sim.position.lng) * fraction
		};
		const heading = bearingDegrees(sim.position, next);
		sim.position = next;
		this.handleFix({ ...next, accuracy: 4, heading, t: sim.time }, 'sim');
		if (sim.target && !sim.paused)
			this.simRaf = requestAnimationFrame((frame) => this.simTick(frame));
		else this.simRaf = null;
	}

	arriveAtTarget(target: { lat: number; lng: number }): void {
		if (!this.state.sim.target) return;
		const heading = this.state.current?.heading ?? null;
		this.state.sim.position = { ...target };
		this.handleFix({ ...target, accuracy: 4, heading, t: this.state.sim.time + 500 }, 'sim');
		this.state.sim.target = null;
		this.state.sim.paused = false;
		this.simRaf = null;
		this.state.sim.lastFrame = 0;
		this.finalizeSession();
		this.refreshSim();
		this.refreshWalkButton();
		this.refreshStatus();
		this.toast('You arrived. The mist remembers this path.', 'success', 3400);
	}

	stopSim({ silent = false } = {}) {
		if (this.simRaf) cancelAnimationFrame(this.simRaf);
		this.simRaf = null;
		this.finalizeSession();
		this.state.sim.target = null;
		this.state.sim.paused = false;
		this.state.sim.lastFrame = 0;
		this.refreshSim();
		this.refreshWalkButton();
		if (!silent) this.refreshStatus();
	}

	placeSimWalker() {
		if (this.state.profile !== 'demo' || !this.map) return;
		const center = this.map.center;
		this.state.sim.position = { lat: center.lat, lng: center.lng };
		this.state.sim.target = null;
		this.state.sim.paused = false;
		this.state.sim.anchored = true;
		this.state.sim.time = Date.now();
		this.state.sim.lastFrame = 0;
		this.gate.reset();
		this.state.current = {
			lat: center.lat,
			lng: center.lng,
			accuracy: 4,
			heading: null,
			source: 'sim'
		};
		this.handleFix(
			{ lat: center.lat, lng: center.lng, accuracy: 4, heading: null, t: this.state.sim.time },
			'sim'
		);
		this.setFollow(true, { recenter: true });
		this.refreshSim();
		this.refreshWalkButton();
		this.toast('Walker placed here. Tap the map to start walking.', 'success', 3200);
	}

	cycleSimSpeed() {
		const index = SIM_SPEEDS.indexOf(this.state.sim.multiplier);
		this.state.sim.multiplier = SIM_SPEEDS[(index + 1) % SIM_SPEEDS.length];
		this.refreshSim();
		this.toast(
			`Simulation time ${this.state.sim.multiplier}×. The walking gate still sees ${WALK_SPEED_MPS} m/s.`,
			'info',
			3600
		);
	}

	toggleWalk() {
		if (this.state.profile === 'demo') {
			if (this.state.sim.target && !this.state.sim.paused) {
				this.state.sim.paused = true;
				this.finalizeSession();
				if (this.simRaf) cancelAnimationFrame(this.simRaf);
				this.simRaf = null;
				this.state.sim.lastFrame = 0;
				this.refreshSim();
				this.refreshWalkButton();
				this.setStatus('paused', 'Sim paused', 'Virtual GPS');
			} else if (this.state.sim.target && this.state.sim.paused) {
				if (this.state.session?.archived) this.newSession();
				this.state.sim.paused = false;
				this.state.sim.lastFrame = 0;
				if (!this.simRaf) this.simRaf = requestAnimationFrame((now) => this.simTick(now));
				this.refreshSim();
				this.refreshWalkButton();
				this.setStatus('demo', 'Simulation', 'Virtual GPS');
			} else {
				this.toast('Tap the map to choose where to walk.', 'info', 2800);
			}
			return;
		}

		if (this.state.tracking === 'live' || this.state.tracking === 'locating') {
			this.finalizeSession();
			this.stopLiveTracking({ pause: true });
			this.state.follow = false;
			this.refreshFollow();
			this.toast('Live tracking paused. Your tiles are safe.', 'info', 2800);
		} else {
			this.resumeSession();
			void this.startLiveTracking({ userInitiated: true });
		}
		this.refreshWalkButton();
	}

	/* ------------------------------------------------------------------ */
	/* Map interaction                                                     */
	/* ------------------------------------------------------------------ */

	onMapClick(lat: number, lng: number): void {
		if (this.state.placePick) {
			this.openPlaceForm(lat, lng);
			return;
		}
		const place = this.placeAt(lat, lng);
		if (place) {
			this.openPlaceForm(place.lat, place.lng);
			return;
		}
		if (this.state.highlightPlace) {
			this.state.highlightPlace = null;
			this.scheduleRender();
		}
		if (this.state.profile === 'demo') {
			this.startSimulationTo(lat, lng);
			return;
		}
		if (Date.now() - this.lastTapToast > 6000) {
			this.lastTapToast = Date.now();
			this.toast(
				'Live tiles are unlocked by walking, not tapping. Use the simulator to explore.',
				'info',
				4200
			);
		}
	}

	/* ------------------------------------------------------------------ */
	/* Profiles                                                            */
	/* ------------------------------------------------------------------ */

	async switchProfile(next: string): Promise<void> {
		if (next !== 'live' && next !== 'demo') return;
		if (cloudConfigured && this.state.cloud.status !== 'approved') {
			this.noteAccessRequired();
			return;
		}
		if (next === 'live' && (this.state.cloud.sample || this.liveAccessBlocked())) {
			this.noteAccessRequired();
			return;
		}
		if (next === this.state.profile) {
			if (next === 'demo') this.enterDemo();
			return;
		}
		this.saveNow();
		this.finalizeSession();
		this.stopReplay(false);
		this.stopLiveTracking({ pause: false });
		this.stopSim({ silent: true });
		this.state.profile = next;
		this.state.settings.lastProfile = next;
		saveSettings(this.state.settings);
		if (!this.state.profiles[next]) this.state.profiles[next] = await loadProfileAsync(next);
		this.state.progress = this.state.profiles[next];
		this.clearPlaceDraft();
		this.gate.reset();
		this.state.current = null;
		this.hasCentered = false;
		this.newSession();
		this.refreshAll();
		const last = this.state.progress.last;
		if (last && Number.isFinite(last.lat) && this.map) {
			this.map.setView(last.lat, last.lng, last.zoom || 16, false);
			this.hasCentered = true;
		}
		if (next === 'demo') {
			this.enterDemo();
			this.toast('Simulator active. Tap the map to walk there.', 'info', 4500);
		} else {
			this.exitDemo();
			if (this.state.settings.autoTrack) void this.maybeAutoStartLive();
			else {
				this.state.tracking = 'idle';
				this.refreshStatus();
			}
		}
		this.refreshSim();
		this.scheduleRender();
	}

	/* ------------------------------------------------------------------ */
	/* Save                                                                */
	/* ------------------------------------------------------------------ */

	scheduleSave(delay = 700) {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.saveNow();
		}, delay);
	}

	saveNow() {
		if (!this.state.progress) return;
		if (this.state.cloud.sample) return;
		this.state.profiles[this.state.profile] = this.state.progress;
		if (this.map) {
			this.state.progress.last = {
				...(this.state.progress.last || {}),
				lat: this.state.progress.last?.lat ?? this.state.current?.lat ?? this.map.center.lat,
				lng: this.state.progress.last?.lng ?? this.state.current?.lng ?? this.map.center.lng,
				zoom: this.map.zoom,
				at: Date.now()
			};
		}
		try {
			saveProfile(this.state.profile, this.state.progress);
			saveSettings(this.state.settings);
			this.state.ui.storageUsage = `Local storage: ${this.formatBytes(localUsageBytes())} · IndexedDB mirror on`;
			this.queueCloudUpload();
		} catch (err) {
			console.warn('MistWalk save failed', err);
			this.toast('Could not save progress. Export a backup now.', 'error', 6000);
		}
	}

	/* ------------------------------------------------------------------ */
	/* Lifecycle                                                           */
	/* ------------------------------------------------------------------ */

	suspendActivity() {
		this.finalizeSession();
		this.stopReplay(false);
		this.state.guide = null;
		this.stopLiveTracking({ pause: false });
		this.stopSim({ silent: true });
		this.releaseWakeLock();
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (this.unlockToastTimer) {
			clearTimeout(this.unlockToastTimer);
			this.unlockToastTimer = null;
		}
		this.pendingUnlocks = 0;
		if (this.pulseRaf) cancelAnimationFrame(this.pulseRaf);
		this.pulseRaf = null;
		this.recent.clear();
		this.pulses = [];
		this.gate.reset();
		this.state.current = null;
		this.state.sim.position = null;
		this.state.sim.target = null;
		this.state.sim.paused = false;
		this.state.sim.anchored = false;
		this.hasCentered = false;
		this.lastFixAt = 0;
		this.state.tracking = 'idle';
	}

	/* ------------------------------------------------------------------ */
	/* Wake lock / visibility / tick                                       */
	/* ------------------------------------------------------------------ */

	async acquireWakeLock() {
		if (!this.state.settings.wakeLock || !navigator.wakeLock || this.wakeLock) return;
		try {
			this.wakeLock = await navigator.wakeLock.request('screen');
			this.wakeLock.addEventListener('release', () => {
				this.wakeLock = null;
			});
		} catch {
			this.wakeLock = null;
		}
	}

	releaseWakeLock() {
		try {
			this.wakeLock?.release();
		} catch {
			/* ignore */
		}
		this.wakeLock = null;
	}

	onVisibility() {
		if (document.hidden) {
			this.hiddenAt = Date.now();
			this.saveNow();
			if (this.canAutoSync()) void this.flushCloudUpload();
			this.releaseWakeLock();
			if (this.hideFinalizeTimer) clearTimeout(this.hideFinalizeTimer);
			this.hideFinalizeTimer = setTimeout(() => {
				this.hideFinalizeTimer = null;
				if (document.hidden) this.finalizeSession();
			}, 300_000);
		} else {
			if (this.hideFinalizeTimer) {
				clearTimeout(this.hideFinalizeTimer);
				this.hideFinalizeTimer = null;
			}
			if (this.state.session?.archived) this.newSession();
			if (this.hiddenAt && Date.now() - this.hiddenAt > 60_000) {
				this.gate.reanchor();
				this.hasCentered = false;
			}
			this.state.sim.lastFrame = 0;
			void this.checkAccess();
			void this.checkRemoteUpdates();
			if (this.state.profile === 'live' && this.state.tracking === 'live')
				void this.acquireWakeLock();
			if (this.map) {
				this.map.resize?.();
				this.resizeFog();
				this.scheduleRender();
			}
		}
	}

	tick() {
		this.state.now = Date.now();
		this.refreshSession();
		this.refreshWalkButton();
		this.refreshGpsQuality();
		if (this.state.profile === 'live' && this.state.tracking === 'live' && this.lastFixAt) {
			const age = Date.now() - this.lastFixAt;
			if (
				age > 28_000 &&
				(this.state.status.state === 'live' || this.state.status.state === 'weak')
			) {
				this.setStatus('weak', 'GPS stale', `${Math.round(age / 1000)}s ago`);
			}
		}
		if (this.state.profile === 'demo' && this.state.sim.position && !this.state.current) {
			this.state.current = {
				...this.state.sim.position,
				accuracy: 4,
				heading: null,
				source: 'sim'
			};
		}
	}

	/* ------------------------------------------------------------------ */
	/* Modals / onboarding                                                 */
	/* ------------------------------------------------------------------ */

	openModal(id: string): void {
		if (this.state.modal && this.state.modal !== id) this.closeModal(this.state.modal, false);
		this.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		this.state.modal = id;
		setTimeout(() => {
			const modal = document.getElementById(id);
			const focusable = modal?.querySelector(
				'input:not([type="hidden"]), button, select, [tabindex="0"]'
			);
			(focusable as HTMLElement | null)?.focus?.();
		}, 40);
	}

	closeModal(id = this.state.modal, restoreFocus = true) {
		if (!id) return;
		if (this.state.modal === id) this.state.modal = null;
		if (restoreFocus && this.lastFocus?.focus) {
			try {
				this.lastFocus.focus();
			} catch {
				/* ignore */
			}
		}
	}

	closeAllModals() {
		this.state.modal = null;
	}

	openSettings() {
		this.openModal('settings-modal');
	}

	openSearch() {
		this.openModal('search-modal');
	}

	openHelp() {
		this.openModal('help-modal');
	}

	openJourney(tab = 'overview') {
		this.state.journey.tab = ['overview', 'history', 'notes', 'places'].includes(tab)
			? tab
			: 'overview';
		this.openModal('journey-modal');
	}

	setJourneyTab(tab: string): void {
		if (!['overview', 'history', 'notes', 'places'].includes(tab)) return;
		this.state.journey.tab = tab;
	}

	challengeInfo() {
		return challengeProgress(this.state.stats, this.state.challenge);
	}

	async shareChallenge() {
		const target = suggestedChallengeTarget(this.state.stats, this.state.stats?.level);
		const title = `Reveal ${target.toLocaleString()} tiles`;
		const challenge = { target, title, metric: 'cellCount' };
		const url = buildChallengeUrl(window.location.href, challenge);
		this.state.challenge = challenge;
		try {
			await navigator.clipboard.writeText(url);
			window.history.replaceState(null, '', url);
			this.toast('Challenge link copied. Send it to a friend.', 'success', 4200);
		} catch {
			window.prompt('Copy this challenge link:', url);
		}
	}

	dismissChallenge() {
		this.state.challenge = null;
		const url = new URL(window.location.href);
		for (const key of ['challenge', 'target', 'title']) url.searchParams.delete(key);
		window.history.replaceState(null, '', url);
	}

	showGpsError(message: string): void {
		if (message) this.state.gps.message = message;
		this.openModal('gps-modal');
	}

	showOnboarding() {
		this.state.onboarding = true;
		this.state.onboardingLeaving = false;
	}

	hideOnboarding(instant = false) {
		if (!this.state.onboarding) return;
		if (instant) {
			this.state.onboarding = false;
			return;
		}
		this.state.onboardingLeaving = true;
		setTimeout(() => {
			this.state.onboarding = false;
			this.state.onboardingLeaving = false;
		}, 460);
	}

	async startGps() {
		if (this.liveAccessBlocked()) {
			this.noteAccessRequired();
			return;
		}
		this.state.onboarded = true;
		this.state.settings.onboarded = true;
		this.state.settings.lastProfile = 'live';
		saveSettings(this.state.settings);
		this.hideOnboarding();
		if (this.state.profile !== 'live') await this.switchProfile('live');
		this.state.follow = true;
		this.refreshFollow();
		void this.startLiveTracking({ userInitiated: true });
	}

	async startDemo() {
		this.state.onboarded = true;
		this.state.settings.onboarded = true;
		this.state.settings.lastProfile = 'demo';
		saveSettings(this.state.settings);
		this.hideOnboarding();
		if (this.state.profile !== 'demo') await this.switchProfile('demo');
		else this.enterDemo();
		setTimeout(() => this.toast('Simulator ready. Tap the map to walk there.', 'info', 4600), 700);
	}

	retryGps() {
		this.closeModal('gps-modal');
		if (this.state.profile !== 'live')
			void this.switchProfile('live').then(() => this.startLiveTracking({ userInitiated: true }));
		else void this.startLiveTracking({ userInitiated: true });
	}

	useSimulatorFromGps() {
		this.closeModal('gps-modal');
		void this.switchProfile('demo');
	}

	/* ------------------------------------------------------------------ */
	/* Settings                                                            */
	/* ------------------------------------------------------------------ */

	chooseProvider(provider: string): void {
		if (provider === 'google' && !this.state.settings.googleKey) {
			this.state.settings.provider = 'google';
			saveSettings(this.state.settings);
			this.toast(
				'Paste a Google Maps browser key, then press Connect. The free map still works without one.',
				'info',
				5200
			);
			return;
		}
		void this.applyProvider(provider);
	}

	async applyProvider(provider: string): Promise<void> {
		if (provider !== 'google' && provider !== 'osm') return;
		if (provider === 'google' && !this.state.settings.googleKey) {
			this.toast('Paste a Google Maps browser key first.', 'warn', 3600);
			return;
		}
		if (this.state.provider === provider && this.map) {
			this.state.settings.provider = provider;
			saveSettings(this.state.settings);
			return;
		}
		const view = this.currentMapView();
		this.state.settings.provider = provider;
		saveSettings(this.state.settings);
		try {
			await this.buildMap(provider, view, { silent: true });
			if (this.state.provider === provider) {
				this.toast(
					provider === 'google' ? 'Google Maps connected.' : 'Free OpenStreetMap connected.',
					'success',
					3000
				);
			} else {
				this.toast('Google Maps could not connect. Staying on the free map.', 'warn', 5000);
			}
			if (this.state.profile === 'demo') this.enterDemo();
			else this.refreshStatus();
		} catch (err) {
			console.error(err);
			this.state.settings.provider = 'osm';
			saveSettings(this.state.settings);
			await this.buildMap('osm', view, { silent: true });
			this.toast('Could not connect to Google Maps. The free map is still here.', 'error', 5600);
		}
	}

	setBasemap(name: string): void {
		const basemap: Basemap = ['osm', 'osmfr', 'cyclosm'].includes(name) ? (name as Basemap) : 'osm';
		this.state.settings.basemap = basemap;
		saveSettings(this.state.settings);
		this.map?.setBasemap?.(basemap);
		this.refreshProvider();
		this.scheduleRender();
	}

	saveGoogleKey(key: string): void {
		const value = String(key || '').trim();
		if (value.length < 20) {
			this.toast('That does not look like a Google Maps key.', 'warn', 3400);
			return;
		}
		this.state.settings.googleKey = value;
		saveSettings(this.state.settings);
		void this.applyProvider('google');
	}

	setSetting(key: keyof Settings, value: unknown): void {
		this.state.settings[key] = value;
		saveSettings(this.state.settings);
		if (key === 'units') this.refreshAll();
		else if (key === 'showGrid' || key === 'showFavorites') this.scheduleRender();
		else if (key === 'theme' || key === 'highContrast' || key === 'reduceMotion') {
			this.applyAccessibility();
			this.scheduleRender();
		} else if (key === 'sound' && value) this.playUnlockSound();
		else if (key === 'wakeLock') {
			if (!value) this.releaseWakeLock();
			else if (this.state.tracking === 'live') void this.acquireWakeLock();
		}
	}

	/* ------------------------------------------------------------------ */
	/* Backup / restore                                                    */
	/* ------------------------------------------------------------------ */

	downloadBackup() {
		if (this.state.cloud.sample) {
			this.toast('Sample mode does not export. Sign in and get approved first.', 'warn', 4200);
			return;
		}
		this.saveNow();
		const data = createBackup(
			this.state.profiles.live,
			this.state.profiles.demo,
			this.state.settings
		);
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		const date = new Date().toISOString().slice(0, 10);
		a.href = url;
		a.download = `mistwalk-backup-${date}.json`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 4000);
		this.toast('Backup exported. Keep it somewhere safe.', 'success', 3600);
	}

	downloadTextFile(filename: string, text: string, type: string): void {
		const blob = new Blob([text], { type });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 4000);
	}

	exportTracks(format = 'gpx') {
		if (this.state.cloud.sample) {
			this.toast('Sample mode does not export. Sign in and get approved first.', 'warn', 4200);
			return;
		}
		this.saveNow();
		const progress = this.state.progress;
		if (!progress) return;
		const date = new Date().toISOString().slice(0, 10);
		if (format === 'geojson') {
			this.downloadTextFile(
				`mistwalk-journey-${date}.geojson`,
				JSON.stringify(buildGeoJSON(progress), null, 2),
				'application/geo+json'
			);
			this.toast('GeoJSON exported with tracks and notes.', 'success', 3600);
			return;
		}
		this.downloadTextFile(
			`mistwalk-journey-${date}.gpx`,
			buildGpx(progress),
			'application/gpx+xml'
		);
		this.toast('GPX track exported.', 'success', 3600);
	}

	async importTrackFile(file: File): Promise<void> {
		if (!file) return;
		try {
			const track = parseTrackFile(await file.text(), file.name);
			this.startReplay({
				id: `import-${Date.now()}`,
				path: track.points,
				label: track.name,
				detail: 'Imported track · overlay only'
			});
			this.toast('Track loaded as a private overlay. It does not unlock tiles.', 'success', 5000);
		} catch (err) {
			this.toast(errorMessage(err) || 'That track could not be read.', 'error', 6000);
		}
	}

	async downloadShareCard() {
		const canvas = document.createElement('canvas');
		canvas.width = 1080;
		canvas.height = 1080;
		const ctx = canvas.getContext('2d');
		const stats = this.state.stats;
		if (!ctx || !stats) return;
		const units = this.state.settings.units;
		ctx.fillStyle = '#070707';
		ctx.fillRect(0, 0, 1080, 1080);
		ctx.strokeStyle = '#9cecf5';
		ctx.lineWidth = 2;
		ctx.strokeRect(42, 42, 996, 996);
		ctx.fillStyle = '#9cecf5';
		ctx.font = '700 24px Archivo, Segoe UI, sans-serif';
		ctx.fillText('MISTWALK / FIELD RECORD', 88, 126);
		ctx.fillStyle = '#f3f3f3';
		ctx.font = '700 108px Archivo, Segoe UI, sans-serif';
		ctx.fillText(stats.level.name, 88, 250);
		ctx.fillStyle = '#a3a3a3';
		ctx.font = '400 26px Archivo, Segoe UI, sans-serif';
		ctx.fillText(`Level ${stats.level.index + 1} · ${new Date().toLocaleDateString()}`, 92, 300);

		const rows = [
			['Revealed', formatArea(stats.areaM2, units)],
			['Tiles', stats.cellCount.toLocaleString()],
			['Walked', formatDistance(stats.distance, units)],
			['Streak', `${stats.streak} day${stats.streak === 1 ? '' : 's'}`],
			['Walks', String(stats.sessions || 0)],
			['Repeat visits', stats.favoriteCells.toLocaleString()]
		];
		rows.forEach(([label, value], index: number) => {
			const x = 88 + (index % 2) * 452;
			const y = 420 + Math.floor(index / 2) * 168;
			ctx.fillStyle = '#7c7c7c';
			ctx.font = '600 22px Archivo, Segoe UI, sans-serif';
			ctx.fillText(label.toUpperCase(), x, y);
			ctx.fillStyle = '#f3f3f3';
			ctx.font = '700 48px Archivo, Segoe UI, sans-serif';
			ctx.fillText(value, x, y + 58);
		});
		ctx.fillStyle = '#a3a3a3';
		ctx.font = '400 24px Archivo, Segoe UI, sans-serif';
		ctx.fillText(
			`${this.state.achievements.filter((badge: Achievement) => badge.earned).length} badges · ${stats.notes || 0} notes · ${this.state.places.length} places · ${stats.favoriteCells} repeat-visit tiles`,
			88,
			980
		);
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
		if (!blob) {
			this.toast('The share card could not be generated.', 'error', 4000);
			return;
		}
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `mistwalk-card-${new Date().toISOString().slice(0, 10)}.png`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 4000);
		this.toast('Share card exported as a private image.', 'success', 3600);
	}

	async handleImportFile(file: File): Promise<void> {
		if (!file) return;
		if (this.state.cloud.sample) {
			this.toast(
				'Sample mode does not import backups. Sign in and get approved first.',
				'warn',
				4200
			);
			return;
		}
		try {
			const parsed = JSON.parse(await file.text());
			const imported = importBackup(parsed);
			if (
				!window.confirm(
					'Restore this backup? It will replace the live and simulator maps on this device.'
				)
			)
				return;
			await this.applyImported(imported);
			this.toast('Backup restored. Every saved tile is back.', 'success', 4200);
		} catch (err) {
			console.error(err);
			this.toast(errorMessage(err) || 'That backup could not be read.', 'error', 6000);
		}
	}

	async applyImported(imported: ImportedBackup): Promise<void> {
		const previousProvider = this.state.provider;
		const previousBasemap = this.map?.basemap;
		this.suspendActivity();
		await writeImported(imported);
		const [live, demo] = await Promise.all([loadProfileAsync('live'), loadProfileAsync('demo')]);
		this.state.profiles = { live, demo };
		this.state.progress = this.state.profiles[this.state.profile];
		this.clearPlaceDraft();
		if (imported.settings) {
			this.state.settings = { ...this.state.settings, ...imported.settings };
		}
		this.state.settings.lastProfile = this.state.profile;
		this.state.settings.onboarded = true;
		this.state.settings = saveSettings(this.state.settings);
		this.state.onboarded = true;
		this.newSession();
		this.refreshAll();

		const last = this.state.progress.last;
		const view =
			last && Number.isFinite(last.lat)
				? { lat: last.lat, lng: last.lng, zoom: last.zoom || 16 }
				: this.currentMapView();
		const provider = this.state.settings.provider;
		const basemap = this.state.settings.basemap;
		const needsMap = !this.map || provider !== previousProvider || basemap !== previousBasemap;
		if (needsMap) await this.buildMap(provider, view, { silent: true });
		else if (this.map && last) this.map.setView(view.lat, view.lng, view.zoom, false);

		this.hasCentered = false;
		if (this.state.profile === 'demo') this.enterDemo();
		else {
			this.state.tracking = 'idle';
			this.refreshAll();
			this.setStatus('idle', 'Standby', 'GPS off');
		}
		this.scheduleRender();
	}

	async resetProfile() {
		if (this.state.cloud.sample) {
			this.toast('Sample mode does not reset saved maps.', 'warn', 4200);
			return;
		}
		const name = this.state.profile === 'live' ? 'live map' : 'simulator map';
		if (
			!window.confirm(
				`Reset the ${name}? Every tile, path, and distance in this profile will be erased. This cannot be undone.`
			)
		)
			return;
		const profile = this.state.profile;
		this.suspendActivity();
		const fresh = createProgress();
		this.state.progress = fresh;
		this.state.profiles[profile] = fresh;
		this.clearPlaceDraft();
		await clearProfile(profile);
		this.newSession();
		this.refreshAll();
		if (profile === 'demo') {
			this.enterDemo();
		} else {
			this.state.tracking = 'idle';
			this.refreshAll();
			this.setStatus('idle', 'Standby', 'GPS off');
			if (this.map) this.map.setView(DEFAULT_VIEW.lat, DEFAULT_VIEW.lng, DEFAULT_VIEW.zoom, false);
		}
		this.scheduleRender();
		this.toast('Profile reset. A new map begins in mist.', 'info', 3800);
	}

	async wipeLocalData() {
		if (this.state.cloud.sample) {
			this.toast('Sample mode does not erase device data.', 'warn', 4200);
			return;
		}
		if (
			!window.confirm(
				'Delete every local MistWalk profile, walk, note, and setting on this device? Cloud copies are separate and must be deleted from Settings first. This cannot be undone.'
			)
		)
			return;
		this.suspendActivity();
		await clearAll();
		window.location.reload();
	}

	/* ------------------------------------------------------------------ */
	/* Access, accounts and cloud sync                                     */
	/* ------------------------------------------------------------------ */

	liveAccessBlocked(): boolean {
		if (this.state.cloud.sample) return true;
		if (!cloudConfigured) return false;
		return this.state.cloud.status !== 'approved';
	}

	accessGateVisible(): boolean {
		if (!cloudConfigured) return false;
		if (this.state.cloud.sample) return false;
		return this.state.cloud.status !== 'approved';
	}

	isAdmin(): boolean {
		return (
			this.state.cloud.member?.role === 'admin' &&
			this.state.cloud.member?.status === 'approved' &&
			this.state.cloud.status === 'approved'
		);
	}

	canAutoSync(): boolean {
		return Boolean(
			cloudConfigured &&
			!this.state.cloud.sample &&
			this.state.cloud.user &&
			this.state.cloud.member?.status === 'approved' &&
			this.state.cloud.status === 'approved'
		);
	}

	noteAccessRequired(): void {
		this.toast(
			'The owner must approve this account before the map or simulator unlocks.',
			'warn',
			5200
		);
	}

	async initCloud() {
		if (!cloudConfigured) return;
		this.state.cloud.message = 'Checking your access…';
		try {
			this.cloudStop = await watchCloudAuth(async (user) => {
				this.state.cloud.user = user;
				if (!user) {
					this.saveNow();
					this.suspendActivity();
					this.cancelCloudSync();
					this.cloudDirty = false;
					cacheMembership(null);
					this.state.cloud.member = null;
					this.state.cloud.status = 'signed-out';
					this.state.cloud.members = [];
					this.state.cloud.lastSavedAt = 0;
					this.state.cloud.syncState = 'idle';
					this.state.cloud.syncMessage = '';
					this.state.cloud.inviteCode = '';
					this.approvedHandledFor = '';
					this.lastSeenRemoteAt = 0;
					this.state.cloud.message = 'Sign in or create an account to request access.';
					return;
				}
				this.state.cloud.email = user.email || '';
				await this.refreshMembership();
			});
		} catch (err) {
			this.state.cloud.status = 'error';
			this.state.cloud.message =
				errorMessage(err) || 'The cloud session could not be checked. Try reloading the page.';
		}
	}

	async refreshMembership(): Promise<void> {
		const seq = ++this.membershipSeq;
		try {
			const member = await fetchMembership();
			if (seq !== this.membershipSeq) return;
			this.state.cloud.member = member;
			if (!member) {
				const cached = !navigator.onLine
					? cachedApprovedMembership(this.state.cloud.user?.id || '')
					: null;
				if (cached) {
					this.state.cloud.member = cached;
					this.state.cloud.status = 'approved';
					this.approvedHandledFor = '';
					this.state.cloud.message = 'Offline. Using cached approval; cloud sync will retry.';
					this.showApprovedShell();
					return;
				}
				cacheMembership(null);
				this.state.cloud.status = 'pending';
				this.state.cloud.message =
					'This account has no membership row yet. Install the Supabase schema, then sign in again.';
				return;
			}
			cacheMembership(member);
			this.state.cloud.status = member.status;
			if (member.status === 'approved') {
				this.state.cloud.message =
					member.role === 'admin' ? 'Owner access approved.' : 'Access approved.';
				await this.afterApproved(member);
			} else if (member.status === 'pending') {
				this.approvedHandledFor = '';
				this.cancelCloudSync();
				this.cloudDirty = false;
				this.state.cloud.message = 'Waiting for the owner to approve this account.';
			} else {
				this.approvedHandledFor = '';
				this.cancelCloudSync();
				this.cloudDirty = false;
				this.state.cloud.message = 'This account was not approved.';
			}
		} catch (err) {
			if (seq !== this.membershipSeq) return;
			const cached = cachedApprovedMembership(this.state.cloud.user?.id || '');
			if (cached) {
				this.state.cloud.member = cached;
				this.state.cloud.status = 'approved';
				this.approvedHandledFor = '';
				this.state.cloud.message =
					'Offline or the server is unreachable. Using cached approval; cloud sync will retry.';
				this.showApprovedShell();
				return;
			}
			this.state.cloud.status = 'error';
			this.state.cloud.message =
				errorMessage(err) ||
				'Membership could not be verified. Check that the Supabase schema is installed.';
		}
	}

	async checkAccess(): Promise<void> {
		if (!cloudConfigured || !this.state.cloud.user || this.state.cloud.sample) return;
		const now = Date.now();
		if (now - this.accessCheckAt < 60000) return;
		this.accessCheckAt = now;
		try {
			const member = await fetchMembership();
			if (!member) {
				const cached = !navigator.onLine
					? cachedApprovedMembership(this.state.cloud.user?.id || '')
					: null;
				if (cached) {
					this.state.cloud.member = cached;
					this.state.cloud.status = 'approved';
					this.approvedHandledFor = '';
					this.state.cloud.message = 'Offline. Using cached approval; cloud sync will retry.';
					return;
				}
				cacheMembership(null);
				this.state.cloud.status = 'pending';
				this.approvedHandledFor = '';
				this.cancelCloudSync();
				this.cloudDirty = false;
				this.suspendActivity();
				this.state.cloud.message =
					'This account has no membership row yet. Ask the owner to check the deployment.';
				return;
			}
			const previous = this.state.cloud.status;
			this.state.cloud.member = member;
			this.state.cloud.status = member.status;
			if (member.status === 'approved') {
				cacheMembership(member);
				if (previous !== 'approved' || !this.approvedHandledFor) {
					await this.afterApproved(member);
				}
			} else {
				cacheMembership(member);
				this.approvedHandledFor = '';
				this.cancelCloudSync();
				this.cloudDirty = false;
				this.suspendActivity();
				this.state.cloud.message =
					member.status === 'pending'
						? 'Waiting for the owner to approve this account.'
						: 'This account was not approved.';
			}
		} catch (err) {
			console.warn('Access check failed', err);
		}
	}

	async afterApproved(member: MemberRecord): Promise<void> {
		if (this.approvedHandledFor === member.user_id) {
			await this.refreshCloudMeta();
			return;
		}
		this.approvedHandledFor = member.user_id;

		if (this.state.cloud.sample) {
			await this.exitSample(false);
		}

		await this.refreshCloudMeta();
		const remoteAt = this.state.cloud.lastSavedAt;
		const localAt = lastLocalSavedAt();

		if (remoteAt > 0 && remoteAt > localAt + 2000) {
			const saved = new Date(remoteAt).toLocaleString();
			if (
				window.confirm(
					`A newer cloud backup exists (${saved}). Restore it on this device? This replaces the local maps.`
				)
			) {
				await this.restoreCloud(false);
			}
		} else if (localAt > 0 && localAt > remoteAt + 2000) {
			await this.uploadCloud({ silent: true });
		}

		this.showApprovedShell();
	}

	showApprovedShell(): void {
		if (!this.state.onboarded) {
			this.showOnboarding();
			return;
		}
		this.hideOnboarding(true);
		if (this.state.profile === 'demo') this.enterDemo();
		else void this.maybeAutoStartLive();
	}

	async signUpCloud(email: string, password: string): Promise<void> {
		const value = String(email || '').trim();
		if (!value || !value.includes('@')) {
			this.state.cloud.message = 'Enter a valid email address.';
			return;
		}
		if (String(password || '').length < 8) {
			this.state.cloud.message = 'Use a password with at least 8 characters.';
			return;
		}
		this.state.cloud.busy = true;
		this.state.cloud.email = value;
		try {
			const { needsConfirmation } = await signUpWithPassword(value, password);
			if (needsConfirmation) {
				this.state.cloud.message =
					'Your account was created, but this Supabase project still requires email confirmation. Ask the owner to turn off “Confirm email” in Supabase, then sign in.';
				this.toast('Email confirmation is still enabled in Supabase.', 'error', 7000);
				return;
			}
			this.state.cloud.message = 'Account created. Waiting for the owner to approve this account.';
			this.toast('Account created. Waiting for owner approval.', 'success', 5200);
			await this.refreshMembership();
		} catch (err) {
			const text = errorMessage(err) || 'The account could not be created.';
			this.state.cloud.message = /already registered/i.test(text)
				? 'An account already exists for this email. Sign in instead.'
				: text;
			this.toast(this.state.cloud.message, 'error', 6500);
		} finally {
			this.state.cloud.busy = false;
		}
	}

	async signInCloudWithPassword(email: string, password: string): Promise<void> {
		const value = String(email || '').trim();
		if (!value || !value.includes('@')) {
			this.state.cloud.message = 'Enter a valid email address.';
			return;
		}
		if (!password) {
			this.state.cloud.message = 'Enter your password.';
			return;
		}
		this.state.cloud.busy = true;
		this.state.cloud.email = value;
		try {
			await signInWithPassword(value, password);
			this.state.cloud.message = 'Signed in. Checking your access…';
			await this.refreshMembership();
		} catch (err) {
			const text = errorMessage(err) || 'Sign-in failed.';
			this.state.cloud.message = /invalid login credentials/i.test(text)
				? 'Email or password is incorrect.'
				: text;
			this.toast(this.state.cloud.message, 'error', 6500);
		} finally {
			this.state.cloud.busy = false;
		}
	}

	async changeCloudPassword(password: string): Promise<boolean> {
		if (!this.state.cloud.user) {
			this.state.cloud.message = 'Sign in before changing the password.';
			return false;
		}
		if (String(password || '').length < 8) {
			this.state.cloud.message = 'Use a password with at least 8 characters.';
			return false;
		}
		this.state.cloud.busy = true;
		try {
			await updatePassword(password);
			this.state.cloud.message = 'Password updated.';
			this.toast('Password updated.', 'success', 3600);
			return true;
		} catch (err) {
			this.state.cloud.message = errorMessage(err) || 'The password could not be changed.';
			this.toast(this.state.cloud.message, 'error', 6500);
			return false;
		} finally {
			this.state.cloud.busy = false;
		}
	}

	async signOutCloud() {
		try {
			await cloudSignOut();
			this.saveNow();
			this.suspendActivity();
			this.cancelCloudSync();
			this.cloudDirty = false;
			this.cloudSyncFailures = 0;
			this.state.cloud.lastSavedAt = 0;
			this.state.cloud.syncState = 'idle';
			this.state.cloud.syncMessage = '';
			cacheMembership(null);
			this.state.cloud.member = null;
			this.state.cloud.status = 'signed-out';
			this.state.cloud.user = null;
			this.state.cloud.members = [];
			this.state.cloud.inviteCode = '';
			this.approvedHandledFor = '';
			this.lastSeenRemoteAt = 0;
			this.state.cloud.message = this.state.cloud.sample
				? 'Sample mode. Sign in to request a real map.'
				: 'Signed out. Your local map is unchanged.';
			this.toast('Signed out. Local progress stays on this device.', 'info', 3600);
		} catch (err) {
			this.state.cloud.message = errorMessage(err) || 'Could not sign out.';
		}
	}

	async redeemCloudInvite(code: string): Promise<void> {
		const value = String(code || '').trim();
		if (!value) {
			this.state.cloud.message = 'Enter an invite code.';
			return;
		}
		if (!this.state.cloud.user) {
			this.state.cloud.message = 'Sign in with your email first, then redeem the invite.';
			return;
		}
		this.state.cloud.inviteBusy = true;
		try {
			await redeemInviteCode(value);
			this.state.cloud.inviteCode = '';
			this.state.cloud.message =
				'Invite accepted. The owner still has to approve this account before the map or simulator unlocks.';
			this.toast('Invite accepted. Waiting for owner approval.', 'success', 5200);
			await this.refreshMembership();
		} catch (err) {
			this.state.cloud.message = errorMessage(err) || 'That invite could not be redeemed.';
			this.toast(this.state.cloud.message, 'error', 6000);
		} finally {
			this.state.cloud.inviteBusy = false;
		}
	}

	async enterSample(): Promise<void> {
		if (this.state.cloud.status === 'approved') {
			await this.switchProfile('live');
			return;
		}
		if (cloudConfigured) {
			this.state.cloud.message = 'The simulator is locked until the owner approves this account.';
			this.noteAccessRequired();
			return;
		}
		if (this.state.cloud.sample) return;
		this.saveNow();
		this.suspendActivity();
		this.sampleReturnProfile = this.state.settings.lastProfile === 'demo' ? 'demo' : 'live';
		this.state.cloud.sample = true;
		this.state.cloud.message = 'Sample mode. Sign in to request a real map.';
		const fresh = createProgress();
		this.state.profiles = { ...this.state.profiles, demo: fresh };
		this.state.profile = 'demo';
		this.state.progress = fresh;
		this.clearPlaceDraft();
		this.state.settings.lastProfile = 'demo';
		this.state.onboarding = false;
		this.enterDemo();
		this.toast('Sample simulator. Progress is not saved.', 'info', 5200);
	}

	async exitSample(announce = true): Promise<void> {
		if (!this.state.cloud.sample) return;
		this.suspendActivity();
		this.state.cloud.sample = false;
		const [live, demo] = await Promise.all([loadProfileAsync('live'), loadProfileAsync('demo')]);
		this.state.profiles = { live, demo };
		const next = this.sampleReturnProfile;
		this.state.profile = next;
		this.state.progress = this.state.profiles[next];
		this.clearPlaceDraft();
		this.state.settings.lastProfile = next;
		saveSettings(this.state.settings);
		this.gate.reset();
		this.state.current = null;
		this.state.tracking = 'idle';
		this.newSession();
		this.refreshAll();
		this.setStatus('idle', 'Standby', 'GPS off');
		if (next === 'demo') this.enterDemo();
		if (announce) this.toast('Sample closed. Sign in to keep a real map.', 'info', 4200);
		if (this.state.cloud.user && this.state.cloud.status !== 'approved') {
			await this.refreshMembership();
		}
	}

	async refreshCloudMeta() {
		try {
			const meta = await fetchCloudMeta();
			this.state.cloud.lastSavedAt = meta?.saved_at || 0;
			this.lastSeenRemoteAt = this.state.cloud.lastSavedAt;
		} catch (err) {
			console.warn('Cloud metadata failed', err);
		}
	}

	cancelCloudSync(): void {
		if (this.cloudSyncTimer) clearTimeout(this.cloudSyncTimer);
		this.cloudSyncTimer = null;
	}

	queueCloudUpload(): void {
		if (!this.canAutoSync()) return;
		this.cloudDirty = true;
		this.cancelCloudSync();
		this.cloudSyncTimer = setTimeout(() => {
			this.cloudSyncTimer = null;
			void this.flushCloudUpload();
		}, 9000);
	}

	async flushCloudUpload(): Promise<void> {
		if (!this.canAutoSync() || !this.cloudDirty) return;
		if (this.cloudSyncInFlight || this.state.cloud.busy) return;
		this.cloudSyncInFlight = true;
		this.state.cloud.syncState = 'saving';
		this.state.cloud.syncMessage = 'Saving to your private cloud copy…';
		try {
			const backup = createBackup(
				this.state.profiles.live,
				this.state.profiles.demo,
				this.state.settings
			);
			await uploadCloudBackup(backup);
			this.cloudDirty = false;
			this.cloudSyncFailures = 0;
			this.state.cloud.lastSavedAt = Date.now();
			this.lastSeenRemoteAt = this.state.cloud.lastSavedAt;
			this.state.cloud.syncState = 'saved';
			this.state.cloud.syncMessage = 'Synced to the cloud.';
		} catch (err) {
			this.cloudSyncFailures += 1;
			this.state.cloud.syncState = 'error';
			this.state.cloud.syncMessage = errorMessage(err) || 'Cloud sync failed.';
			console.warn('Cloud sync failed', err);
		} finally {
			this.cloudSyncInFlight = false;
			if (this.cloudDirty && this.cloudSyncFailures < 4) {
				this.cancelCloudSync();
				this.cloudSyncTimer = setTimeout(() => {
					this.cloudSyncTimer = null;
					void this.flushCloudUpload();
				}, 15000 * this.cloudSyncFailures);
			}
		}
	}

	async checkRemoteUpdates(): Promise<void> {
		if (!this.canAutoSync()) return;
		const now = Date.now();
		if (now - this.cloudCheckAt < 30000) return;
		this.cloudCheckAt = now;
		try {
			const meta = await fetchCloudMeta();
			const remoteAt = meta?.saved_at || 0;
			this.state.cloud.lastSavedAt = remoteAt;
			if (remoteAt > this.lastSeenRemoteAt + 2000 && remoteAt > lastLocalSavedAt() + 2000) {
				this.state.cloud.syncState = 'idle';
				this.state.cloud.syncMessage =
					'A newer cloud backup is available. Open settings and restore it.';
				this.toast('A newer cloud backup is available on another device.', 'info', 5200);
			}
			this.lastSeenRemoteAt = remoteAt;
		} catch (err) {
			console.warn('Cloud update check failed', err);
		}
	}

	async syncNow(): Promise<void> {
		if (!this.canAutoSync()) {
			this.toast('Sign in with an approved account to sync.', 'warn', 3600);
			return;
		}
		this.saveNow();
		this.cloudDirty = true;
		this.cloudSyncFailures = 0;
		await this.flushCloudUpload();
	}

	async uploadCloud({ silent = false } = {}) {
		if (!this.canAutoSync()) {
			this.toast('Sign in with an approved account to upload.', 'warn', 3600);
			return;
		}
		this.state.cloud.busy = true;
		this.state.cloud.syncState = 'saving';
		try {
			this.saveNow();
			const backup = createBackup(
				this.state.profiles.live,
				this.state.profiles.demo,
				this.state.settings
			);
			await uploadCloudBackup(backup);
			this.cloudDirty = false;
			this.cloudSyncFailures = 0;
			this.state.cloud.lastSavedAt = Date.now();
			this.lastSeenRemoteAt = this.state.cloud.lastSavedAt;
			this.state.cloud.syncState = 'saved';
			this.state.cloud.syncMessage = 'Synced to the cloud.';
			this.state.cloud.message = 'Cloud backup uploaded.';
			if (!silent) this.toast('Cloud backup saved to Supabase.', 'success', 4000);
		} catch (err) {
			this.state.cloud.syncState = 'error';
			this.state.cloud.syncMessage = errorMessage(err) || 'Cloud upload failed.';
			this.state.cloud.message = errorMessage(err) || 'Cloud upload failed.';
			if (!silent) this.toast(this.state.cloud.message, 'error', 6000);
		} finally {
			this.state.cloud.busy = false;
		}
	}

	async restoreCloud(ask = true) {
		if (!this.canAutoSync()) {
			this.toast('Sign in with an approved account to restore.', 'warn', 3600);
			return;
		}
		if (this.cloudSyncInFlight) {
			this.toast('A cloud sync is finishing. Try restoring again in a moment.', 'info', 3600);
			return;
		}
		this.state.cloud.busy = true;
		try {
			const remote = await fetchCloudBackup();
			if (!remote?.data) {
				this.toast('No cloud backup exists for this account yet.', 'info', 4000);
				return;
			}
			const saved = remote.saved_at
				? new Date(remote.saved_at).toLocaleString()
				: 'an unknown time';
			if (
				ask &&
				!window.confirm(
					`Restore the cloud backup from ${saved}? It will replace the live and simulator maps on this device.`
				)
			)
				return;
			this.cancelCloudSync();
			this.cloudDirty = false;
			const imported = importBackup(remote.data);
			await this.applyImported(imported);
			this.cancelCloudSync();
			this.cloudDirty = false;
			this.state.cloud.lastSavedAt = remote.saved_at || Date.now();
			this.lastSeenRemoteAt = this.state.cloud.lastSavedAt;
			this.state.cloud.syncState = 'saved';
			this.state.cloud.syncMessage = 'Restored from the cloud.';
			this.state.cloud.message = 'Cloud backup restored.';
			this.toast('Cloud backup restored.', 'success', 4200);
		} catch (err) {
			this.state.cloud.message = errorMessage(err) || 'Cloud restore failed.';
			this.toast(this.state.cloud.message, 'error', 6000);
		} finally {
			this.state.cloud.busy = false;
		}
	}

	async deleteCloudCopy() {
		if (!this.canAutoSync()) {
			this.toast('Sign in with an approved account first.', 'warn', 3600);
			return;
		}
		if (this.cloudSyncInFlight) {
			this.toast('A cloud sync is finishing. Try deleting again in a moment.', 'info', 3600);
			return;
		}
		if (
			!window.confirm(
				'Delete the cloud copy for this account? The map on this device will not be touched. Auto-sync will upload a new copy after your next save.'
			)
		)
			return;
		this.state.cloud.busy = true;
		try {
			await deleteCloudBackup();
			this.cancelCloudSync();
			this.cloudDirty = false;
			this.cloudSyncFailures = 0;
			this.state.cloud.lastSavedAt = 0;
			this.lastSeenRemoteAt = 0;
			this.state.cloud.syncState = 'idle';
			this.state.cloud.syncMessage = 'No cloud copy is stored.';
			this.state.cloud.message = 'Cloud backup deleted. This device is unchanged.';
			this.toast('Cloud copy deleted.', 'success', 3600);
		} catch (err) {
			this.state.cloud.message = errorMessage(err) || 'The cloud copy could not be deleted.';
			this.toast(this.state.cloud.message, 'error', 6000);
		} finally {
			this.state.cloud.busy = false;
		}
	}

	async loadMembers(): Promise<void> {
		if (!this.isAdmin()) return;
		this.state.cloud.membersBusy = true;
		try {
			this.state.cloud.members = await fetchMembers();
		} catch (err) {
			this.toast(errorMessage(err) || 'Members could not be loaded.', 'error', 6000);
		} finally {
			this.state.cloud.membersBusy = false;
		}
	}

	async decideMember(userId: string, status: MemberStatus): Promise<void> {
		if (!this.isAdmin()) return;
		this.state.cloud.membersBusy = true;
		try {
			await setMemberStatus(userId, status);
			await this.loadMembers();
			this.toast(status === 'approved' ? 'Explorer approved.' : 'Access updated.', 'success', 3200);
		} catch (err) {
			this.toast(errorMessage(err) || 'Access could not be updated.', 'error', 6000);
		} finally {
			this.state.cloud.membersBusy = false;
		}
	}

	async makeInvite(): Promise<void> {
		if (!this.isAdmin()) return;
		this.state.cloud.inviteBusy = true;
		try {
			this.state.cloud.inviteCode = await createInviteCode(7);
			this.toast('Invite code created. It expires in 7 days.', 'success', 4200);
		} catch (err) {
			this.toast(errorMessage(err) || 'The invite could not be created.', 'error', 6000);
		} finally {
			this.state.cloud.inviteBusy = false;
		}
	}

	async copyInvite(): Promise<void> {
		const code = this.state.cloud.inviteCode;
		if (!code) return;
		if (!navigator.clipboard?.writeText) {
			this.toast(`Invite code: ${code}`, 'info', 8000);
			return;
		}
		try {
			await navigator.clipboard.writeText(code);
			this.toast('Invite code copied.', 'success', 2600);
		} catch {
			this.toast(`Invite code: ${code}`, 'info', 8000);
		}
	}

	/* ------------------------------------------------------------------ */
	/* Search                                                              */
	/* ------------------------------------------------------------------ */

	async runSearch(query: string): Promise<void> {
		const q = String(query || '').trim();
		this.state.search.query = q;
		if (q.length < 2) {
			this.toast('Type at least two characters to search.', 'info', 2400);
			return;
		}
		const now = Date.now();
		if (now - this.lastSearchAt < 1100) {
			this.toast('Give the free geocoder a second between searches.', 'info', 2400);
			return;
		}
		this.lastSearchAt = now;
		this.searchAbort?.abort();
		this.searchAbort = new AbortController();
		this.state.search.loading = true;
		this.state.search.error = '';
		this.state.search.results = [];
		try {
			const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`;
			const response = await fetch(url, {
				signal: this.searchAbort.signal,
				headers: { Accept: 'application/json' }
			});
			if (!response.ok) throw new Error(`Search returned ${response.status}.`);
			const payload: unknown = await response.json();
			const results = (Array.isArray(payload) ? payload : []) as SearchResult[];
			this.state.search.results = results.filter(
				(item) => Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lon))
			);
		} catch (err) {
			if (errorName(err) === 'AbortError') return;
			console.error(err);
			this.state.search.error =
				'The free geocoder did not answer. Check your connection and try again.';
		} finally {
			this.state.search.loading = false;
		}
	}

	goToSearchResult(item: SearchResult): void {
		this.closeModal('search-modal');
		if (!this.map) return;
		const lat = Number(item.lat);
		const lng = Number(item.lon);
		this.state.follow = false;
		this.refreshFollow();
		this.map.setView(lat, lng, 17, false);
		this.hasCentered = true;
		this.scheduleRender();
		if (this.state.profile === 'demo') {
			this.toast(
				'Map moved. Press “Place me” to put the walker here, then tap a destination.',
				'info',
				5200
			);
		} else {
			this.toast('Map moved. Searching never unlocks tiles. Only walking does.', 'info', 4200);
		}
	}

	/* ------------------------------------------------------------------ */
	/* Service worker / debug                                              */
	/* ------------------------------------------------------------------ */

	setupServiceWorker() {
		if (!('serviceWorker' in navigator)) return;
		if (!/^https?:$/.test(location.protocol)) return;
		navigator.serviceWorker
			.register('/sw.js')
			.catch((err) => console.warn('Service worker registration failed', err));
	}

	exposeDebugApi() {
		if (!new URLSearchParams(location.search).has('debug')) return;
		this.state.debug = true;
		const debugWindow = window as Window & { __mistwalk?: unknown };
		debugWindow.__mistwalk = {
			app: this,
			state: () => ({
				profile: this.state.profile,
				tracking: this.state.tracking,
				provider: this.state.provider,
				cells: Object.keys(this.state.progress.cells).length,
				path: this.state.progress.path.length,
				distance: this.state.progress.stats.distance,
				current: this.state.current,
				follow: this.state.follow,
				status: this.state.status,
				session: { ...this.state.session },
				sim: { ...this.state.sim },
				hasFog: Boolean(this.fog),
				canvas: this.fog ? { w: this.fog.width, h: this.fog.height } : null
			}),
			fix: (
				lat: number,
				lng: number,
				opts: {
					accuracy?: number;
					speed?: number | null;
					heading?: number | null;
					t?: number;
					source?: string;
				} = {}
			) =>
				this.handleFix(
					{
						lat,
						lng,
						accuracy: opts.accuracy ?? 4,
						speed: opts.speed ?? null,
						heading: opts.heading ?? null,
						t: opts.t ?? Date.now()
					},
					opts.source || 'gps'
				),
			switchProfile: (profile: string) => this.switchProfile(profile),
			enterDemo: () => this.enterDemo(),
			placeSimWalker: () => this.placeSimWalker(),
			startSimulationTo: (lat: number, lng: number) => this.startSimulationTo(lat, lng),
			recenter: () => this.recenter(),
			fitExplored: () => this.fitExplored(),
			saveNow: () => this.saveNow(),
			closeModals: () => this.closeAllModals(),
			hideOnboarding: () => this.hideOnboarding(true),
			mapCenter: () => this.map?.center,
			setView: (lat: number, lng: number, zoom: number) =>
				this.map?.setView(lat, lng, zoom ?? 16, false)
		};
	}
}

export const app = new MistWalk();
