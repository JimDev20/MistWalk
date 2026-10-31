/* MistWalk storage — local-only, dual-written to localStorage + IndexedDB. */

import { createProgress, migrateProgress } from './core.ts';
import type { BackupFile, ImportedBackup, ProfileName, Progress, Settings } from './types.ts';

const DB_NAME = 'mistwalk';
const DB_VERSION = 1;
const STORE = 'profiles';
const LS_PREFIX = 'mistwalk';
const PROFILE_KEY = (profile: ProfileName) => `${LS_PREFIX}:${profile}:v1`;
const SETTINGS_KEY = `${LS_PREFIX}:settings:v1`;
const META_KEY = `${LS_PREFIX}:meta:v1`;

export const DEFAULT_SETTINGS = Object.freeze({
	provider: 'osm',
	basemap: 'osm',
	googleKey: '',
	units: 'metric',
	sound: true,
	haptics: true,
	wakeLock: true,
	showGrid: true,
	showFavorites: true,
	theme: 'night',
	highContrast: false,
	reduceMotion: false,
	autoTrack: true,
	onboarded: false,
	lastProfile: 'live'
}) satisfies Settings;

function safeParse(text: string | null): unknown {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function lsGet(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function lsSet(key: string, value: string): boolean {
	try {
		window.localStorage.setItem(key, value);
		return true;
	} catch (err) {
		console.warn('MistWalk: localStorage write failed', err);
		return false;
	}
}

function lsRemove(key: string): void {
	try {
		window.localStorage.removeItem(key);
	} catch {
		/* ignore */
	}
}

/* ------------------------------------------------------------------ */
/* IndexedDB mirror                                                    */
/* ------------------------------------------------------------------ */

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		if (!('indexedDB' in window)) {
			reject(new Error('IndexedDB unavailable'));
			return;
		}
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
		req.onblocked = () => reject(new Error('IndexedDB blocked'));
	}).catch((err) => {
		console.warn('MistWalk: IndexedDB unavailable', err);
		dbPromise = null;
		throw err;
	});
	return dbPromise;
}

async function idbGet(key: string): Promise<unknown> {
	try {
		const db = await openDb();
		return await new Promise<unknown>((resolve, reject) => {
			const tx = db.transaction(STORE, 'readonly');
			const req = tx.objectStore(STORE).get(key);
			req.onsuccess = () => resolve(req.result || null);
			req.onerror = () => reject(req.error);
		});
	} catch {
		return null;
	}
}

async function idbPut(key: string, value: unknown): Promise<boolean> {
	try {
		const db = await openDb();
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE, 'readwrite');
			tx.objectStore(STORE).put(value, key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error || new Error('aborted'));
		});
		return true;
	} catch {
		return false;
	}
}

async function idbDelete(key: string): Promise<void> {
	try {
		const db = await openDb();
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE, 'readwrite');
			tx.objectStore(STORE).delete(key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	} catch {
		/* ignore */
	}
}

/* ------------------------------------------------------------------ */
/* Settings / meta                                                     */
/* ------------------------------------------------------------------ */

export function loadSettings(): Settings {
	const raw = safeParse(lsGet(SETTINGS_KEY));
	const meta = safeParse(lsGet(META_KEY));
	const merged: Settings = {
		...DEFAULT_SETTINGS,
		...(raw && typeof raw === 'object' ? (raw as Partial<Settings>) : {}),
		...(meta && typeof meta === 'object' ? (meta as Partial<Settings>) : {})
	};
	// Older builds used CARTO, which now requires a key. Keep the app fully free.
	if (!['osm', 'osmfr', 'cyclosm'].includes(merged.basemap)) merged.basemap = 'osm';
	return merged;
}

export function saveSettings(settings: Settings): Settings {
	const safe: Settings = { ...DEFAULT_SETTINGS };
	for (const key of Object.keys(DEFAULT_SETTINGS)) {
		if (key in settings)
			(safe as unknown as Record<string, unknown>)[key] = (
				settings as unknown as Record<string, unknown>
			)[key];
	}
	safe.provider = settings.provider === 'google' ? 'google' : 'osm';
	safe.units = settings.units === 'imperial' ? 'imperial' : 'metric';
	safe.lastProfile = settings.lastProfile === 'demo' ? 'demo' : 'live';
	safe.basemap = ['osm', 'osmfr', 'cyclosm'].includes(settings.basemap)
		? (settings.basemap as Settings['basemap'])
		: 'osm';
	safe.googleKey = typeof settings.googleKey === 'string' ? settings.googleKey.trim() : '';
	safe.theme = settings.theme === 'paper' ? 'paper' : 'night';
	safe.highContrast = Boolean(settings.highContrast);
	safe.reduceMotion = Boolean(settings.reduceMotion);
	lsSet(SETTINGS_KEY, JSON.stringify(safe));
	return safe;
}

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

function normalizePayload(payload: unknown): { savedAt: number; data: Progress } | null {
	if (!payload || typeof payload !== 'object') return null;
	const record = payload as { data?: unknown; savedAt?: unknown };
	if (!record.data) return null;
	return {
		savedAt:
			typeof record.savedAt === 'number' && Number.isFinite(record.savedAt) ? record.savedAt : 0,
		data: migrateProgress(record.data)
	};
}

export async function loadProfileAsync(profile: ProfileName = 'live'): Promise<Progress> {
	const local = normalizePayload(safeParse(lsGet(PROFILE_KEY(profile))));
	// The localStorage snapshot is written synchronously on every meaningful
	// change, so use it immediately. Awaiting IndexedDB first made returning
	// users stare at an empty map while the browser opened the database.
	if (local) return local.data;

	const remote = normalizePayload(await idbGet(profile));
	if (remote) {
		// Repair the localStorage copy from the durable mirror.
		lsSet(PROFILE_KEY(profile), JSON.stringify(remote));
		return remote.data;
	}
	return createProgress();
}

export function saveProfile(profile: ProfileName, progress: Progress): boolean {
	const payload = JSON.stringify({ savedAt: Date.now(), data: progress });
	const ok = lsSet(PROFILE_KEY(profile), payload);
	// Fire-and-forget mirror. IndexedDB writes are asynchronous but ordered.
	void idbPut(profile, { savedAt: Date.now(), data: progress });
	return ok;
}

export async function clearProfile(profile: ProfileName): Promise<void> {
	lsRemove(PROFILE_KEY(profile));
	await idbDelete(profile);
}

export async function clearAll(): Promise<void> {
	for (const profile of ['live', 'demo'] as ProfileName[]) {
		lsRemove(PROFILE_KEY(profile));
		await idbDelete(profile);
	}
	lsRemove(SETTINGS_KEY);
	lsRemove(META_KEY);
}

/* ------------------------------------------------------------------ */
/* Backup                                                              */
/* ------------------------------------------------------------------ */

export function exportBackup(live: Progress, demo: Progress, settings: Settings): BackupFile {
	return {
		app: 'MistWalk',
		format: 1,
		exportedAt: new Date().toISOString(),
		settings: { ...settings },
		profiles: {
			live: migrateProgress(live),
			demo: migrateProgress(demo)
		}
	};
}

export function importBackup(raw: unknown): ImportedBackup {
	if (!raw || typeof raw !== 'object') throw new Error('This is not a MistWalk backup.');
	const record = raw as { app?: unknown; profiles?: unknown; settings?: unknown };
	if (record.app !== 'MistWalk') throw new Error('This file is not a MistWalk backup.');
	if (!record.profiles || typeof record.profiles !== 'object')
		throw new Error('The backup has no profiles.');
	const profiles = record.profiles as { live?: unknown; demo?: unknown };
	const live = profiles.live ? migrateProgress(profiles.live) : null;
	const demo = profiles.demo ? migrateProgress(profiles.demo) : null;
	if (!live || !demo) throw new Error('The backup is missing the live or simulator profile.');
	return {
		live,
		demo,
		settings:
			record.settings && typeof record.settings === 'object' ? (record.settings as Settings) : null
	};
}

export async function writeImported({ live, demo, settings }: ImportedBackup): Promise<void> {
	if (live) {
		saveProfile('live', live);
		await idbPut('live', { savedAt: Date.now(), data: live });
	}
	if (demo) {
		saveProfile('demo', demo);
		await idbPut('demo', { savedAt: Date.now(), data: demo });
	}
	if (settings) saveSettings(settings);
}

/** Rough bytes used by MistWalk in localStorage, for the settings screen. */
export function localUsageBytes(): number {
	let total = 0;
	try {
		for (let i = 0; i < localStorage.length; i += 1) {
			const key = localStorage.key(i);
			if (!key || !key.startsWith(LS_PREFIX)) continue;
			total += key.length + (localStorage.getItem(key) || '').length;
		}
	} catch {
		return 0;
	}
	return total * 2;
}
