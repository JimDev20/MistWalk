/* MistWalk storage — local-only, dual-written to localStorage + IndexedDB. */

import { createProgress, migrateProgress } from './core.js';

const DB_NAME = 'mistwalk';
const DB_VERSION = 1;
const STORE = 'profiles';
const LS_PREFIX = 'mistwalk';
const PROFILE_KEY = (profile) => `${LS_PREFIX}:${profile}:v1`;
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
  autoTrack: true,
  onboarded: false,
  lastProfile: 'live',
});

function safeParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function lsGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (err) {
    console.warn('MistWalk: localStorage write failed', err);
    return false;
  }
}

function lsRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* IndexedDB mirror                                                    */
/* ------------------------------------------------------------------ */

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
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

async function idbGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbPut(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
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

async function idbDelete(key) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
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

export function loadSettings() {
  const raw = safeParse(lsGet(SETTINGS_KEY));
  const meta = safeParse(lsGet(META_KEY));
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(raw && typeof raw === 'object' ? raw : {}),
    ...(meta && typeof meta === 'object' ? meta : {}),
  };
  // Older builds used CARTO, which now requires a key. Keep the app fully free.
  if (!['osm', 'osmfr', 'cyclosm'].includes(merged.basemap)) merged.basemap = 'osm';
  return merged;
}

export function saveSettings(settings) {
  // Keep unknown keys out of storage.
  const safe = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key in settings) safe[key] = settings[key];
  }
  safe.provider = settings.provider === 'google' ? 'google' : 'osm';
  safe.units = settings.units === 'imperial' ? 'imperial' : 'metric';
  safe.lastProfile = settings.lastProfile === 'demo' ? 'demo' : 'live';
  safe.basemap = ['osm', 'osmfr', 'cyclosm'].includes(settings.basemap) ? settings.basemap : 'osm';
  safe.googleKey = typeof settings.googleKey === 'string' ? settings.googleKey.trim() : '';
  lsSet(SETTINGS_KEY, JSON.stringify(safe));
  return { ...DEFAULT_SETTINGS, ...safe };
}

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (!payload.data) return null;
  return {
    savedAt: Number.isFinite(payload.savedAt) ? payload.savedAt : 0,
    data: migrateProgress(payload.data),
  };
}

export async function loadProfileAsync(profile = 'live') {
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

export function saveProfile(profile, progress) {
  const payload = JSON.stringify({ savedAt: Date.now(), data: progress });
  const ok = lsSet(PROFILE_KEY(profile), payload);
  // Fire-and-forget mirror. IndexedDB writes are asynchronous but ordered.
  void idbPut(profile, { savedAt: Date.now(), data: progress });
  return ok;
}

export async function clearProfile(profile) {
  lsRemove(PROFILE_KEY(profile));
  await idbDelete(profile);
}

export async function clearAll() {
  for (const profile of ['live', 'demo']) {
    lsRemove(PROFILE_KEY(profile));
    await idbDelete(profile);
  }
  lsRemove(SETTINGS_KEY);
  lsRemove(META_KEY);
}

/* ------------------------------------------------------------------ */
/* Backup                                                              */
/* ------------------------------------------------------------------ */

export function exportBackup(live, demo, settings) {
  return {
    app: 'MistWalk',
    format: 1,
    exportedAt: new Date().toISOString(),
    settings: { ...settings },
    profiles: {
      live: migrateProgress(live),
      demo: migrateProgress(demo),
    },
  };
}

export function importBackup(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('This is not a MistWalk backup.');
  if (raw.app !== 'MistWalk') throw new Error('This file is not a MistWalk backup.');
  if (!raw.profiles || typeof raw.profiles !== 'object') throw new Error('The backup has no profiles.');
  const live = raw.profiles.live ? migrateProgress(raw.profiles.live) : null;
  const demo = raw.profiles.demo ? migrateProgress(raw.profiles.demo) : null;
  if (!live && !demo) throw new Error('The backup contains no exploration data.');
  return {
    live,
    demo,
    settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : null,
  };
}

export async function writeImported({ live, demo, settings }) {
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
export function localUsageBytes() {
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
