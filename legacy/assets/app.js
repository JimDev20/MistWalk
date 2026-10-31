/* MistWalk — browser application.
   Live GPS or a virtual walker, a permanent 12-metre fog-of-war map,
   and a local-only save. No accounts, no servers, no tracking. */

import {
  WalkGate,
  appendPath,
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
  haversineMeters,
  normalizeFix,
  progressStats,
  speedUnit,
  unlockCells,
} from './core.js';
import {
  clearProfile,
  exportBackup,
  importBackup,
  loadProfileAsync,
  loadSettings,
  localUsageBytes,
  saveProfile,
  saveSettings,
  writeImported,
} from './storage.js';
import { FogRenderer } from './fog.js';
import { OsmMap } from './map-osm.js';
import { GoogleMap } from './map-google.js';

const DEFAULT_VIEW = { lat: 14.5547, lng: 121.0244, zoom: 19 };
const WALK_SPEED_MPS = 1.35;
const SIM_SPEEDS = [1, 4, 20];
const ATTRIBUTION_FALLBACK = '© OpenStreetMap contributors';

const $ = (id) => document.getElementById(id);

const ui = {
  mapShell: $('map-shell'),
  map: $('map'),
  onboarding: $('onboarding'),
  startGps: $('start-gps'),
  startDemo: $('start-demo'),
  onboardingHelp: $('onboarding-help'),
  brand: $('brand-btn'),
  statusPill: $('status-pill'),
  statusText: $('status-text'),
  statusDetail: $('status-detail'),
  searchBtn: $('search-btn'),
  settingsBtn: $('settings-btn'),
  helpBtn: $('help-btn'),
  levelName: $('level-name'),
  levelNumber: $('level-number'),
  hudState: $('hud-state'),
  hudStateText: $('hud-state-text'),
  levelTag: $('level-tag'),
  levelProgress: $('level-progress'),
  statArea: $('stat-area'),
  statTiles: $('stat-tiles'),
  statDistance: $('stat-distance'),
  statStreak: $('stat-streak'),
  walkCard: $('walk-card'),
  walkTime: $('walk-time'),
  walkDistance: $('walk-distance'),
  walkSpeed: $('walk-speed'),
  walkSpeedUnit: $('walk-speed-unit'),
  walkUnlocks: $('walk-unlocks'),
  followBtn: $('follow-btn'),
  walkToggle: $('walk-toggle'),
  coordText: $('coord-text'),
  providerText: $('provider-text'),
  googleLink: $('google-link'),
  mapAttribution: $('map-attribution'),
  hudAttribution: $('hud-attribution'),
  compassNeedle: $('compass-needle'),
  zoomIn: $('zoom-in'),
  zoomOut: $('zoom-out'),
  locateBtn: $('locate-btn'),
  fitBtn: $('fit-btn'),
  simPanel: $('sim-panel'),
  simHint: $('sim-hint'),
  simSpeed: $('sim-speed'),
  simPlace: $('sim-place'),
  simStop: $('sim-stop'),
  simExit: $('sim-exit'),
  toasts: $('toasts'),
  unlockFlash: $('unlock-flash'),
  scrim: $('scrim'),
  settingsModal: $('settings-modal'),
  helpModal: $('help-modal'),
  searchModal: $('search-modal'),
  gpsModal: $('gps-modal'),
  providerSeg: $('provider-seg'),
  basemapSelect: $('basemap-select'),
  osmSettings: $('osm-settings'),
  googleSettings: $('google-settings'),
  googleKey: $('google-key'),
  googleSave: $('google-save'),
  unitsToggle: $('units-toggle'),
  gridToggle: $('grid-toggle'),
  soundToggle: $('sound-toggle'),
  hapticsToggle: $('haptics-toggle'),
  wakeToggle: $('wake-toggle'),
  autotrackToggle: $('autotrack-toggle'),
  profileSeg: $('profile-seg'),
  profileNote: $('profile-note'),
  exportBtn: $('export-btn'),
  importBtn: $('import-btn'),
  importFile: $('import-file'),
  resetBtn: $('reset-btn'),
  storageUsage: $('storage-usage'),
  searchForm: $('search-form'),
  searchInput: $('search-input'),
  searchResults: $('search-results'),
  gpsMessage: $('gps-message'),
  gpsRetry: $('gps-retry'),
  gpsSim: $('gps-sim'),
  helpExport: $('help-export'),
};

const app = {
  settings: loadSettings(),
  profile: 'live',
  profiles: { live: null, demo: null },
  progress: createProgress(),
  stats: null,
  map: null,
  provider: null,
  fog: null,
  current: null,
  follow: true,
  tracking: 'idle',
  watchId: null,
  lastFixAt: 0,
  gate: new WalkGate(),
  session: null,
  recent: new Map(),
  pulses: [],
  renderQueued: false,
  pulseRaf: null,
  mapRenderQueued: false,
  saveTimer: null,
  pendingUnlocks: 0,
  unlockToastTimer: null,
  openModal: null,
  lastFocus: null,
  hasCentered: false,
  wakeLock: null,
  hiddenAt: 0,
  audio: null,
  userGesture: false,
  lastVehicleToast: 0,
  lastWeakToast: 0,
  lastTapToast: 0,
  lastSearchAt: 0,
  searchAbort: null,
  reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  debug: false,
  sim: {
    position: null,
    target: null,
    multiplier: 1,
    paused: false,
    raf: null,
    lastFrame: 0,
    time: Date.now(),
    anchored: false,
  },
  googleFailureHandled: false,
};

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function makeReadySignal() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function dismissBootScreen() {
  const screen = document.getElementById('boot-screen');
  if (!screen) return;
  screen.classList.add('is-done');
  setTimeout(() => screen.remove(), 620);
}

function initialView() {
  const last = app.progress.last;
  if (last && Number.isFinite(last.lat) && Number.isFinite(last.lng)) {
    return { lat: last.lat, lng: last.lng, zoom: Number.isFinite(last.zoom) ? last.zoom : 16 };
  }
  return { ...DEFAULT_VIEW };
}

function currentMapView() {
  if (app.map) {
    return { ...app.map.center, zoom: app.map.zoom };
  }
  return initialView();
}

function toast(message, kind = 'info', duration = 3400) {
  if (!message) return;
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.kind = kind;
  node.textContent = message;
  ui.toasts.appendChild(node);
  while (ui.toasts.children.length > 3) ui.toasts.firstElementChild?.remove();
  setTimeout(() => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 260);
  }, duration);
}

function setStatus(state, label, detail = '') {
  ui.statusPill.dataset.state = state;
  ui.statusText.textContent = label;
  ui.statusDetail.textContent = detail;
  if (ui.hudState) {
    ui.hudState.dataset.state = state;
    ui.hudStateText.textContent = label;
  }
}

function playUnlockSound() {
  if (!app.settings.sound || !app.userGesture) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!app.audio) app.audio = new AudioCtx();
    if (app.audio.state === 'suspended') void app.audio.resume();
    const ctx = app.audio;
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
    /* Audio is a nicety, never a failure. */
  }
}

function haptic() {
  if (!app.settings.haptics || !app.userGesture) return;
  try {
    navigator.vibrate?.(18);
  } catch {
    /* ignore */
  }
}

function flashUnlock() {
  let x = 50;
  let y = 50;
  if (app.current && app.map) {
    const p = app.map.project(app.current.lat, app.current.lng);
    if (p) {
      x = (p.x / Math.max(1, ui.mapShell.clientWidth)) * 100;
      y = (p.y / Math.max(1, ui.mapShell.clientHeight)) * 100;
    }
  }
  ui.unlockFlash.style.setProperty('--x', `${x}%`);
  ui.unlockFlash.style.setProperty('--y', `${y}%`);
  ui.unlockFlash.classList.remove('is-active');
  void ui.unlockFlash.offsetWidth;
  ui.unlockFlash.classList.add('is-active');
  setTimeout(() => ui.unlockFlash.classList.remove('is-active'), 1050);
}

function newSession() {
  app.session = {
    startedAt: Date.now(),
    pausedAt: null,
    lastAcceptedAt: null,
    distance: 0,
    walkingMs: 0,
    unlocks: 0,
    speed: 0,
  };
}

function sessionElapsed() {
  if (!app.session) return 0;
  const end = app.session.pausedAt || Date.now();
  return Math.max(0, end - app.session.startedAt);
}

function pauseSession() {
  if (app.session && !app.session.pausedAt) app.session.pausedAt = Date.now();
}

function resumeSession() {
  if (!app.session?.pausedAt) return;
  app.session.startedAt += Date.now() - app.session.pausedAt;
  app.session.pausedAt = null;
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  bindUI();
  const markGesture = () => {
    app.userGesture = true;
  };
  document.addEventListener('pointerdown', markGesture, { once: true, capture: true });
  document.addEventListener('keydown', markGesture, { once: true, capture: true });
  newSession();
  app.profile = app.settings.lastProfile === 'demo' ? 'demo' : 'live';

  const [live, demo] = await Promise.all([loadProfileAsync('live'), loadProfileAsync('demo')]);
  app.profiles.live = live;
  app.profiles.demo = demo;
  app.progress = app.profiles[app.profile];

  const view = initialView();
  try {
    await buildMap(app.settings.provider, view);
  } catch (err) {
    console.error('MistWalk map failed', err);
    // Last-resort free map, regardless of the saved provider.
    app.settings.provider = 'osm';
    saveSettings(app.settings);
    try {
      await buildMap('osm', view);
    } catch (err2) {
      console.error('MistWalk could not start the free map', err2);
      toast('The map could not load. Check your connection and reload.', 'error', 8000);
    }
  }

  updateAll();
  syncSettingsUI();

  if (!app.settings.onboarded) {
    showOnboarding();
  } else {
    hideOnboarding(true);
    if (app.profile === 'demo') {
      enterDemo();
    } else {
      void maybeAutoStartLive();
    }
  }

  setInterval(tick, 1000);
  setInterval(() => {
    if (app.tracking === 'live' || app.profile === 'demo') saveNow();
    else if (app.session?.distance > 0) saveNow();
  }, 15_000);

  window.addEventListener('resize', () => {
    app.map?.resize?.();
    resizeFog();
    scheduleRender();
  });
  window.addEventListener('orientationchange', () => setTimeout(() => {
    app.map?.resize?.();
    resizeFog();
    scheduleRender();
  }, 250));
  window.addEventListener('beforeunload', saveNow);
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', onVisibility);

  window.addEventListener('mistwalk:google-auth-failure', onGoogleAuthFailure);
  window.addEventListener('online', () => toast('Back online.', 'success', 2200));
  window.addEventListener('offline', () => toast('Offline. Map tiles may pause, but your progress is safe.', 'warn', 5000));

  setupServiceWorker();
  exposeDebugApi();

  if (app.profile === 'demo') enterDemo();
  updateAll();
  dismissBootScreen();

  // A tiny delayed hint for returning users whose location permission is still
  // on "prompt" rather than granted.
  setTimeout(() => {
    if (app.settings.onboarded && app.profile === 'live' && app.tracking === 'idle' && !app.openModal) {
      toast('GPS is standing by. Press Start GPS when you are ready to walk.', 'info', 5000);
    }
  }, 1800);
}

async function onGoogleAuthFailure() {
  if (app.provider !== 'google' || app.googleFailureHandled) return;
  app.googleFailureHandled = true;
  app.settings.provider = 'osm';
  saveSettings(app.settings);
  syncSettingsUI();
  toast('Google Maps rejected this key. The free map is still here.', 'warn', 6000);
  const view = currentMapView();
  try {
    await buildMap('osm', view, { silent: true });
    if (app.profile === 'demo') enterDemo();
    else updateStatusFromState();
  } catch (err) {
    console.error('Fallback map failed', err);
  }
}

/* ------------------------------------------------------------------ */
/* Map construction                                                    */
/* ------------------------------------------------------------------ */

async function buildMap(provider, view, { silent = false } = {}) {
  if (app.map) {
    try {
      app.map.destroy();
    } catch {
      /* ignore */
    }
    app.map = null;
    app.provider = null;
  }
  app.fog = null;
  ui.map.innerHTML = '';
  const ready = makeReadySignal();
  let engine = null;
  let authHandler = null;
  let authFailure = null;

  const common = {
    container: ui.map,
    fogHost: ui.mapShell,
    center: { lat: view.lat, lng: view.lng },
    zoom: view.zoom || 16,
    basemap: app.settings.basemap,
    onReady: () => ready.resolve(),
    onViewChange: () => onMapViewChange(),
    onUserDrag: () => setFollow(false),
    onTileError: () => toast('Some map tiles are slow. The free tiles may recover when you move.', 'warn', 4200),
    onClick: (lat, lng) => onMapClick(lat, lng),
  };

  try {
    if (provider === 'google') {
      if (!app.settings.googleKey) throw new Error('Google Maps needs an API key.');
      setStatus('locating', 'Connecting', 'Google Maps');
      authFailure = new Promise((_, reject) => {
        authHandler = () => reject(new Error('Google rejected the key.'));
        window.addEventListener('mistwalk:google-auth-failure', authHandler, { once: true });
      });
      engine = await GoogleMap.create({ ...common, key: app.settings.googleKey });
      await Promise.race([withTimeout(ready.promise, 12_000, 'Google Maps overlay timed out.'), authFailure]);
      app.map = engine;
      app.provider = 'google';
    } else {
      engine = new OsmMap(common);
      await withTimeout(ready.promise, 6000, 'The free map took too long to start.');
      app.map = engine;
      app.provider = 'osm';
    }
  } catch (err) {
    if (authHandler) window.removeEventListener('mistwalk:google-auth-failure', authHandler);
    try {
      engine?.destroy();
    } catch {
      /* ignore */
    }
    if (provider === 'google') {
      app.settings.provider = 'osm';
      app.settings.googleKey = app.settings.googleKey || '';
      saveSettings(app.settings);
      if (!silent) toast('Google Maps unavailable. Switched to the free map.', 'warn', 5200);
      return buildMap('osm', view, { silent: true });
    }
    throw err;
  } finally {
    if (authHandler) window.removeEventListener('mistwalk:google-auth-failure', authHandler);
  }

  app.fog = new FogRenderer(app.map.canvas);
  app.googleFailureHandled = false;
  resizeFog();
  app.map.resize?.();
  if (app.current && app.follow) {
    app.map.setView(app.current.lat, app.current.lng, Math.max(17, app.map.zoom), false);
  }
  updateProviderUI();
  syncSettingsUI();
  scheduleRender();
  if (!silent) setStatus(app.profile === 'demo' ? 'demo' : 'idle', app.profile === 'demo' ? 'Simulation' : 'Standby');
  return app.map;
}

function resizeFog() {
  if (!app.fog || !app.map) return;
  const width = app.provider === 'google'
    ? app.map.width || ui.map.clientWidth || ui.mapShell.clientWidth
    : ui.mapShell.clientWidth;
  const height = app.provider === 'google'
    ? app.map.height || ui.map.clientHeight || ui.mapShell.clientHeight
    : ui.mapShell.clientHeight;
  app.fog.resize(width, height, window.devicePixelRatio || 1);
}

function onMapViewChange() {
  scheduleRender();
  if (app.saveTimer == null && app.map) {
    // Zoom is remembered with the last position, not on every animation frame.
    scheduleSave(1500);
  }
}

function scheduleRender() {
  if (app.renderQueued) return;
  app.renderQueued = true;
  requestAnimationFrame(() => {
    app.renderQueued = false;
    renderMap();
  });
}

function renderMap() {
  if (!app.map || !app.fog) return;
  const bounds = app.map.bounds;
  if (!bounds) return;
  app.pulses = app.pulses.filter((pulse) => performance.now() - pulse.t < 1500);
  app.fog.render({
    project: (lat, lng) => app.map?.project(lat, lng) || null,
    cells: app.progress.cells,
    recent: app.recent,
    path: app.progress.path,
    current: app.profile === 'demo'
      ? (app.sim.position ? { ...app.sim.position, accuracy: 4, heading: app.current?.heading ?? null } : app.current)
      : app.current,
    target: app.profile === 'demo' ? app.sim.target : null,
    bounds,
    time: performance.now(),
    reducedMotion: app.reducedMotion,
    showGrid: app.settings.showGrid,
    pulses: app.pulses,
    zoom: app.map.zoom,
  });
  if (app.recent.size > 5000) {
    const cutoff = performance.now() - 10 * 60 * 1000;
    for (const [key, time] of app.recent) {
      if (time < cutoff) app.recent.delete(key);
    }
  }
}

function startPulseLoop() {
  if (app.pulseRaf) return;
  const tick = () => {
    if (!app.progress) return;
    app.pulses = app.pulses.filter((pulse) => performance.now() - pulse.t < 1500);
    renderMap();
    if (app.pulses.length) app.pulseRaf = requestAnimationFrame(tick);
    else app.pulseRaf = null;
  };
  app.pulseRaf = requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------ */
/* Progress / UI                                                       */
/* ------------------------------------------------------------------ */

function updateAll() {
  updateProgressUI();
  updateSessionUI();
  updatePositionUI();
  updateFollowUI();
  updateWalkButton();
  updateProviderUI();
  updateSimUI();
  updateStatusFromState();
}

function updateProgressUI() {
  const stats = progressStats(app.progress);
  app.stats = stats;
  const level = stats.level;
  ui.levelName.textContent = level.name;
  ui.levelNumber.textContent = pad2(level.index + 1);
  ui.levelTag.textContent = level.tag;
  ui.levelProgress.style.width = `${Math.round(level.progress * 100)}%`;
  ui.statArea.textContent = formatArea(stats.areaM2, app.settings.units);
  ui.statTiles.textContent = `${stats.cellCount.toLocaleString()} tile${stats.cellCount === 1 ? '' : 's'}`;
  ui.statDistance.textContent = formatDistance(stats.distance, app.settings.units);
  ui.statStreak.textContent = String(stats.streak);
  ui.walkSpeedUnit.textContent = speedUnit(app.settings.units);
  document.title = stats.cellCount
    ? `MistWalk: ${stats.cellCount.toLocaleString()} tiles revealed`
    : 'MistWalk: walk to uncover the world';
}

function updateSessionUI() {
  if (!app.session) return;
  ui.walkTime.textContent = formatClock(sessionElapsed());
  ui.walkDistance.textContent = formatDistance(app.session.distance, app.settings.units);
  ui.walkSpeed.textContent = formatSpeed(app.session.speed || 0, app.settings.units);
  ui.walkUnlocks.textContent = String(app.session.unlocks);
  const live = app.profile === 'demo'
    ? Boolean(app.sim.target) && !app.sim.paused
    : app.tracking === 'live' || app.tracking === 'locating';
  ui.walkCard.dataset.live = live ? 'true' : 'false';
}

function updatePositionUI() {
  if (app.current) {
    ui.coordText.textContent = formatCoordinate(app.current.lat, app.current.lng);
    if (Number.isFinite(app.current.heading)) {
      ui.compassNeedle.style.transform = `rotate(${app.current.heading}deg)`;
    }
  } else {
    ui.coordText.textContent = '—';
    ui.compassNeedle.style.transform = 'rotate(0deg)';
  }
  if (app.map) {
    ui.providerText.textContent = app.map.providerLabel;
    setAttribution(app.provider === 'google'
      ? 'Map data © Google'
      : app.map.attribution || ATTRIBUTION_FALLBACK);
  } else {
    ui.providerText.textContent = 'Connecting…';
    setAttribution(ATTRIBUTION_FALLBACK);
  }
  const googlePoint = app.current || (app.map ? app.map.center : null);
  if (googlePoint && ui.googleLink) {
    ui.googleLink.href = `https://www.google.com/maps/search/?api=1&query=${googlePoint.lat.toFixed(6)},${googlePoint.lng.toFixed(6)}`;
  }
  if (app.current && Number.isFinite(app.current.accuracy)) {
    if (['live', 'weak', 'vehicle'].includes(ui.statusPill.dataset.state)) {
      ui.statusDetail.textContent = `±${Math.round(app.current.accuracy)} m`;
    }
  }
}

function updateFollowUI() {
  ui.followBtn.classList.toggle('is-active', app.follow);
  const label = ui.followBtn.querySelector('span');
  if (label) label.textContent = app.follow ? 'Following' : 'Recenter';
  ui.followBtn.setAttribute('aria-pressed', String(app.follow));
}

function updateWalkButton() {
  const label = ui.walkToggle.querySelector('span');
  const use = ui.walkToggle.querySelector('use');
  if (app.profile === 'demo') {
    const walking = Boolean(app.sim.target) && !app.sim.paused;
    if (use) use.setAttribute('href', walking ? '#i-pause' : '#i-play');
    if (label) label.textContent = walking ? 'Pause' : (app.sim.paused ? 'Resume' : 'Walk');
    return;
  }
  const running = app.tracking === 'live' || app.tracking === 'locating';
  if (use) use.setAttribute('href', running ? '#i-pause' : '#i-play');
  if (label) label.textContent = running ? 'Pause' : (app.tracking === 'paused' ? 'Resume' : 'Start GPS');
}

function setAttribution(html) {
  ui.mapAttribution.innerHTML = html;
  if (ui.hudAttribution) ui.hudAttribution.innerHTML = html;
}

function updateProviderUI() {
  if (app.map) {
    ui.providerText.textContent = app.map.providerLabel;
    setAttribution(app.provider === 'google'
      ? 'Map data © Google'
      : app.map.attribution || ATTRIBUTION_FALLBACK);
  }
}

function updateSimUI() {
  const visible = app.profile === 'demo';
  ui.simPanel.hidden = !visible;
  if (!visible) return;
  const speed = app.sim.multiplier;
  ui.simSpeed.textContent = `${speed}×`;
  if (app.sim.target) {
    ui.simHint.textContent = app.sim.paused ? 'Paused. Tap the map to continue.' : 'Walking to your marker…';
  } else {
    ui.simHint.textContent = 'Tap the map to walk there.';
  }
}

function updateStatusFromState() {
  if (app.profile === 'demo') {
    if (app.sim.paused) setStatus('paused', 'Sim paused', 'Virtual GPS');
    else setStatus('demo', 'Simulation', 'Virtual GPS');
    return;
  }
  if (app.tracking === 'locating') setStatus('locating', 'Locating', 'Waiting for GPS');
  else if (app.tracking === 'paused') setStatus('paused', 'Paused', '');
  else if (app.tracking === 'error') setStatus('error', 'GPS blocked', '');
  else if (app.tracking === 'live') setStatus('live', 'Live', app.current ? `±${Math.round(app.current.accuracy || 0)} m` : '');
  else setStatus('idle', 'Standby', 'GPS off');
}

/* ------------------------------------------------------------------ */
/* Live GPS                                                            */
/* ------------------------------------------------------------------ */

async function maybeAutoStartLive() {
  if (app.profile !== 'live') return;
  if (!navigator.geolocation) {
    app.tracking = 'error';
    updateStatusFromState();
    toast('This browser does not expose geolocation.', 'error', 6000);
    return;
  }
  if (!window.isSecureContext) {
    app.tracking = 'error';
    updateStatusFromState();
    showGpsError('This page is not secure, so the browser will not share GPS. Open it through localhost or an HTTPS address.');
    return;
  }

  let permission = 'prompt';
  try {
    if (navigator.permissions?.query) {
      const result = await navigator.permissions.query({ name: 'geolocation' });
      permission = result.state;
      result.addEventListener?.('change', () => {
        if (result.state === 'granted' && app.profile === 'live' && app.tracking !== 'live') {
          void startLiveTracking();
        }
      });
    }
  } catch {
    /* Permissions API varies by browser. */
  }

  if (permission === 'granted' && app.settings.autoTrack) {
    await startLiveTracking();
  } else if (permission === 'denied') {
    app.tracking = 'error';
    updateStatusFromState();
    toast('GPS is blocked for this page. Use the simulator or allow location in site settings.', 'warn', 6000);
  } else {
    app.tracking = 'idle';
    updateStatusFromState();
  }
}

async function startLiveTracking({ userInitiated = false } = {}) {
  if (app.profile !== 'live') return;
  if (app.watchId !== null) return;
  if (!navigator.geolocation) {
    app.tracking = 'error';
    updateStatusFromState();
    toast('This browser does not support GPS.', 'error', 5000);
    return;
  }
  if (!window.isSecureContext) {
    showGpsError('GPS needs a secure page. Use localhost on this computer, or an HTTPS address on your phone.');
    return;
  }

  app.tracking = 'locating';
  app.follow = true;
  updateFollowUI();
  updateWalkButton();
  setStatus('locating', 'Locating', 'Waiting for GPS');
  if (userInitiated) resumeSession();
  if (app.current) app.gate.reanchor(app.current);

  try {
    app.watchId = navigator.geolocation.watchPosition(onGeoFix, onGeoError, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 25_000,
    });
  } catch (err) {
    app.watchId = null;
    app.tracking = 'error';
    updateStatusFromState();
    showGpsError(`GPS could not start: ${err?.message || 'unknown error'}`);
  }
}

function stopLiveTracking({ pause = true } = {}) {
  if (app.watchId !== null) {
    try {
      navigator.geolocation.clearWatch(app.watchId);
    } catch {
      /* ignore */
    }
    app.watchId = null;
  }
  releaseWakeLock();
  if (pause) {
    if (app.tracking !== 'idle' && app.tracking !== 'error') {
      app.tracking = 'paused';
      pauseSession();
      updateWalkButton();
      updateStatusFromState();
    }
  } else if (['live', 'locating', 'paused'].includes(app.tracking)) {
    app.tracking = 'idle';
  }
}

function onGeoFix(position) {
  if (app.profile !== 'live') return;
  const coords = position.coords || {};
  const fix = normalizeFix({
    lat: coords.latitude,
    lng: coords.longitude,
    accuracy: coords.accuracy,
    speed: coords.speed,
    heading: coords.heading,
    t: position.timestamp || Date.now(),
  });
  if (!fix) return;
  const wasLocating = app.tracking !== 'live';
  app.tracking = 'live';
  app.lastFixAt = Date.now();
  if (!app.hasCentered && app.map) {
    app.map.setView(fix.lat, fix.lng, Math.max(17, app.map.zoom), false);
    app.hasCentered = true;
  }
  setStatus('live', 'Live', fix.accuracy ? `±${Math.round(fix.accuracy)} m` : '');
  handleFix(fix, 'gps');
  acquireWakeLock();
  if (wasLocating) {
    toast('GPS locked. Walk to lift the mist.', 'success', 3800);
  }
}

function onGeoError(error) {
  const code = error?.code;
  if (code === 1) {
    stopLiveTracking({ pause: false });
    app.tracking = 'error';
    updateStatusFromState();
    updateWalkButton();
    releaseWakeLock();
    showGpsError('Location access was blocked. Allow it in your browser’s site settings, then retry.');
  } else {
    if (app.tracking !== 'live') {
      app.tracking = 'locating';
      setStatus('locating', 'Searching', 'No GPS fix yet');
    }
    toast(
      code === 3 ? 'Still looking for GPS. Move outdoors or near a window.' : 'GPS is temporarily unavailable. The map will retry.',
      'warn',
      5000,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Fix handling — the only place progress changes                      */
/* ------------------------------------------------------------------ */

function handleFix(rawFix, source = 'gps') {
  const fix = normalizeFix(rawFix);
  if (!fix) return;
  if (app.profile === 'demo' && source !== 'sim') return;
  if (app.profile === 'live' && source !== 'gps') return;

  const previous = app.current;
  let heading = Number.isFinite(Number(fix.heading)) && Number(fix.heading) >= 0 ? Number(fix.heading) : null;
  if (heading === null && previous && previous.lat !== undefined) {
    const moved = haversineMeters(previous, fix);
    if (moved > 1) heading = bearingDegrees(previous, fix);
  }

  if (source === 'sim') app.sim.position = { lat: fix.lat, lng: fix.lng };
  app.current = {
    lat: fix.lat,
    lng: fix.lng,
    accuracy: fix.accuracy,
    speed: fix.speed,
    heading: heading ?? previous?.heading ?? null,
    source,
    t: fix.t,
  };
  if (source === 'gps') app.lastFixAt = Date.now();

  const verdict = app.gate.evaluate(fix);

  if (verdict.distance > 0 && app.session) {
    app.session.distance += verdict.distance;
    app.progress.stats.distance += verdict.distance;
    const last = app.session.lastAcceptedAt;
    if (last !== null && fix.t > last) {
      const delta = Math.min(15_000, fix.t - last);
      app.session.walkingMs += delta;
      app.progress.stats.walkingMs += delta;
    }
  }
  if (verdict.walking && verdict.distance > 0) {
    app.session.lastAcceptedAt = fix.t;
    // Keep the all-time distance honest even between tile unlocks.
    updateProgressUI();
  }

  let addedCount = 0;
  if (verdict.unlock) {
    const from = verdict.from || fix;
    const cells = cellsAlongLine(from, fix, 5);
    if (!cells.length) cells.push(cellFromLatLng(fix.lat, fix.lng));
    const added = unlockCells(app.progress, cells, fix.t, source);
    addedCount = added.length;
    if (added.length) {
      app.session.unlocks += added.length;
      const now = performance.now();
      for (const cell of added.slice(0, 18)) {
        app.recent.set(cell.key, now);
        const center = cellCenter(cell);
        app.pulses.push({ lat: center.lat, lng: center.lng, t: performance.now() });
      }
      flashUnlock();
      haptic();
      playUnlockSound();
      queueUnlockToast(added.length);
      startPulseLoop();
      updateProgressUI();
    }
    appendPath(app.progress, fix, fix.t);
    app.progress.stats.lastWalkAt = fix.t;
    if (app.tracking === 'live') {
      setStatus('live', 'Live', fix.accuracy ? `±${Math.round(fix.accuracy)} m` : '');
    }
  } else if (verdict.reason === 'too-fast') {
    if (Date.now() - app.lastVehicleToast > 20_000) {
      app.lastVehicleToast = Date.now();
      toast('Vehicle speed detected. Unlocking is paused until you walk again.', 'warn', 5000);
      haptic();
    }
    setStatus('vehicle', 'Vehicle', 'Unlock paused');
  } else if (verdict.reason === 'weak-gps') {
    if (Date.now() - app.lastWeakToast > 25_000) {
      app.lastWeakToast = Date.now();
      toast('GPS accuracy is too low to unlock tiles. Step outside or wait for a better fix.', 'warn', 4500);
    }
    if (app.tracking === 'live') setStatus('weak', 'Weak GPS', `±${Math.round(fix.accuracy || 0)} m`);
  } else if (verdict.reason === 'resume-jump' || verdict.reason === 'gps-jump') {
    toast('Tracking resumed after a gap. Walk a few steps to continue.', 'info', 3800);
  } else if (app.tracking === 'live') {
    const detail = fix.accuracy ? `±${Math.round(fix.accuracy)} m` : '';
    setStatus('live', 'Live', detail);
  }

  if (app.progress.last) {
    app.progress.last.lat = fix.lat;
    app.progress.last.lng = fix.lng;
    app.progress.last.at = fix.t;
  } else {
    app.progress.last = { lat: fix.lat, lng: fix.lng, zoom: app.map?.zoom || 16, at: fix.t };
  }
  if (app.map) app.progress.last.zoom = app.map.zoom;

  if (verdict.distance > 0) {
    app.session.speed = verdict.speed || 0;
  } else if (verdict.walking && verdict.reason === 'stationary') {
    app.session.speed = 0;
  }

  if (app.follow) followCurrent();
  updatePositionUI();
  updateSessionUI();
  updateWalkButton();
  scheduleRender();
  // Standing still in an already-known tile should not rewrite the save (and
  // the IndexedDB mirror) every second. The 15 s autosave still records the
  // latest position; meaningful movement or a new tile saves immediately.
  if (verdict.distance > 0 || addedCount > 0 || verdict.reason === 'first-fix') {
    scheduleSave(700);
  }
}

function queueUnlockToast(count) {
  app.pendingUnlocks += count;
  if (app.unlockToastTimer) return;
  app.unlockToastTimer = setTimeout(() => {
    const n = app.pendingUnlocks;
    app.pendingUnlocks = 0;
    app.unlockToastTimer = null;
    if (n > 0) {
      toast(`${n} new tile${n === 1 ? '' : 's'} revealed.`, 'success', 3000);
    }
  }, 650);
}

/* ------------------------------------------------------------------ */
/* Following / view                                                    */
/* ------------------------------------------------------------------ */

function followCurrent(force = false) {
  if (!app.map || !app.follow) return;
  const point = app.current || app.sim.position;
  if (!point) return;
  if (!app.hasCentered || force) {
    app.map.setView(point.lat, point.lng, Math.max(17, app.map.zoom), false);
    app.hasCentered = true;
    return;
  }
  const p = app.map.project(point.lat, point.lng);
  if (!p) {
    app.map.panTo(point.lat, point.lng, true);
    return;
  }
  const width = ui.mapShell.clientWidth || 1;
  const height = ui.mapShell.clientHeight || 1;
  if (p.x < width * 0.28 || p.x > width * 0.72 || p.y < height * 0.24 || p.y > height * 0.72) {
    app.map.panTo(point.lat, point.lng, true);
  }
}

function setFollow(value, { recenter = false } = {}) {
  app.follow = value;
  updateFollowUI();
  if (value && recenter) followCurrent(true);
}

function recenter() {
  const point = app.current || app.sim.position;
  if (!point) {
    if (app.profile === 'live') {
      void startLiveTracking({ userInitiated: true });
    } else {
      toast('No walker yet. Tap the map to place yourself.', 'info', 3200);
    }
    return;
  }
  setFollow(true, { recenter: true });
}

function fitExplored() {
  if (!app.map) return;
  const keys = Object.keys(app.progress.cells);
  if (!keys.length) {
    toast('Nothing revealed yet. Walk to unlock your first tile.', 'info', 3200);
    return;
  }
  let north = -90;
  let south = 90;
  let east = -180;
  let west = 180;
  for (const key of keys) {
    const parsed = key.split('_');
    if (parsed.length !== 2) continue;
    const x = parseInt(parsed[0], 36);
    const y = parseInt(parsed[1], 36);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const b = cellToBounds({ x, y, key });
    north = Math.max(north, b.north);
    south = Math.min(south, b.south);
    east = Math.max(east, b.east);
    west = Math.min(west, b.west);
  }
  if (!Number.isFinite(north) || north <= south) return;
  app.follow = false;
  updateFollowUI();
  app.map.fitBounds({ north, south, east, west }, 56);
  toast('Showing everything you have revealed.', 'info', 2600);
}

/* ------------------------------------------------------------------ */
/* Simulation                                                          */
/* ------------------------------------------------------------------ */

function enterDemo() {
  app.profile = 'demo';
  app.settings.lastProfile = 'demo';
  saveSettings(app.settings);
  stopLiveTracking({ pause: false });
  const pos = app.progress.last || (app.map ? app.map.center : DEFAULT_VIEW);
  app.sim.position = { lat: pos.lat, lng: pos.lng };
  app.sim.target = null;
  app.sim.paused = false;
  app.sim.lastFrame = 0;
  app.sim.time = Date.now();
  app.sim.anchored = Boolean(app.progress.last);
  app.current = { ...app.sim.position, accuracy: 4, heading: app.current?.heading ?? null, source: 'sim' };
  app.gate.reset();
  app.hasCentered = true;
  app.follow = true;
  if (app.map) app.map.setView(app.sim.position.lat, app.sim.position.lng, Math.max(17, app.map.zoom), false);
  ui.simPanel.hidden = false;
  newSession();
  updateAll();
  setStatus('demo', 'Simulation', 'Virtual GPS');
  updateSimUI();
  scheduleRender();
}

function exitDemo() {
  stopSim({ silent: true });
  ui.simPanel.hidden = true;
  app.current = null;
  app.gate.reset();
  app.sim.position = null;
  app.sim.target = null;
  app.sim.anchored = false;
  updateSimUI();
  updateWalkButton();
  updateStatusFromState();
}

function startSimulationTo(lat, lng) {
  if (app.profile !== 'demo') return;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  app.sim.target = { lat, lng };
  app.sim.paused = false;
  app.sim.lastFrame = 0;
  app.follow = true;
  updateFollowUI();
  newSessionIfIdle();
  if (!app.sim.anchored || !app.current) {
    app.sim.position = { lat, lng };
    // A destination click with no prior position starts at the map centre,
    // not at the destination. This is only used on the very first click.
    const center = app.map?.center || DEFAULT_VIEW;
    app.sim.position = { lat: center.lat, lng: center.lng };
    app.sim.anchored = true;
    app.sim.time = Date.now();
    app.gate.reset();
    handleFix({ ...app.sim.position, accuracy: 4, heading: null, t: app.sim.time }, 'sim');
    app.sim.target = { lat, lng };
  }
  updateSimUI();
  updateWalkButton();
  if (!app.sim.raf) {
    app.sim.lastFrame = 0;
    app.sim.raf = requestAnimationFrame(simTick);
  }
}

function newSessionIfIdle() {
  if (!app.session || app.session.distance === 0 && app.session.unlocks === 0) {
    newSession();
  }
}

function simTick(now) {
  const sim = app.sim;
  if (app.profile !== 'demo' || !sim.target || sim.paused) {
    sim.raf = null;
    return;
  }
  if (!sim.lastFrame) sim.lastFrame = now;
  let realDelta = (now - sim.lastFrame) / 1000;
  sim.lastFrame = now;
  realDelta = Math.max(0, Math.min(0.12, realDelta));
  if (!realDelta) {
    sim.raf = requestAnimationFrame(simTick);
    return;
  }
  const simDelta = realDelta * sim.multiplier;
  sim.time += simDelta * 1000;

  if (!sim.position) {
    const center = app.map?.center || DEFAULT_VIEW;
    sim.position = { lat: center.lat, lng: center.lng };
  }
  const target = sim.target;
  const distance = haversineMeters(sim.position, target);
  if (distance < 0.35) {
    arriveAtTarget(target);
    return;
  }
  const step = Math.min(distance, WALK_SPEED_MPS * simDelta);
  const fraction = step / distance;
  const next = {
    lat: sim.position.lat + (target.lat - sim.position.lat) * fraction,
    lng: sim.position.lng + (target.lng - sim.position.lng) * fraction,
  };
  const heading = bearingDegrees(sim.position, next);
  sim.position = next;
  handleFix({ ...next, accuracy: 4, heading, t: sim.time }, 'sim');
  if (sim.target && !sim.paused) sim.raf = requestAnimationFrame(simTick);
  else sim.raf = null;
}

function arriveAtTarget(target) {
  if (!app.sim.target) return;
  const heading = app.current?.heading ?? null;
  app.sim.position = { ...target };
  handleFix({ ...target, accuracy: 4, heading, t: app.sim.time + 500 }, 'sim');
  app.sim.target = null;
  app.sim.paused = false;
  app.sim.raf = null;
  app.sim.lastFrame = 0;
  updateSimUI();
  updateWalkButton();
  updateStatusFromState();
  toast('You arrived. The mist remembers this path.', 'success', 3400);
}

function stopSim({ silent = false } = {}) {
  if (app.sim.raf) cancelAnimationFrame(app.sim.raf);
  app.sim.raf = null;
  app.sim.target = null;
  app.sim.paused = false;
  app.sim.lastFrame = 0;
  updateSimUI();
  updateWalkButton();
  if (!silent) updateStatusFromState();
}

function placeSimWalker() {
  if (app.profile !== 'demo' || !app.map) return;
  const center = app.map.center;
  app.sim.position = { lat: center.lat, lng: center.lng };
  app.sim.target = null;
  app.sim.paused = false;
  app.sim.anchored = true;
  app.sim.time = Date.now();
  app.sim.lastFrame = 0;
  app.gate.reset();
  app.current = { lat: center.lat, lng: center.lng, accuracy: 4, heading: null, source: 'sim' };
  handleFix({ lat: center.lat, lng: center.lng, accuracy: 4, heading: null, t: app.sim.time }, 'sim');
  setFollow(true, { recenter: true });
  updateSimUI();
  updateWalkButton();
  toast('Walker placed here. Tap the map to start walking.', 'success', 3200);
}

/* ------------------------------------------------------------------ */
/* Map interactions                                                    */
/* ------------------------------------------------------------------ */

function onMapClick(lat, lng) {
  if (app.profile === 'demo') {
    startSimulationTo(lat, lng);
    return;
  }
  if (Date.now() - app.lastTapToast > 6000) {
    app.lastTapToast = Date.now();
    toast('Live tiles are unlocked by walking, not tapping. Use the simulator to explore.', 'info', 4200);
  }
}

/* ------------------------------------------------------------------ */
/* Profile switching                                                   */
/* ------------------------------------------------------------------ */

async function switchProfile(next) {
  if (next !== 'live' && next !== 'demo') return;
  if (next === app.profile) {
    if (next === 'demo') enterDemo();
    return;
  }
  saveNow();
  stopLiveTracking({ pause: false });
  stopSim({ silent: true });
  app.profile = next;
  app.settings.lastProfile = next;
  saveSettings(app.settings);
  if (!app.profiles[next]) app.profiles[next] = await loadProfileAsync(next);
  app.progress = app.profiles[next];
  app.gate.reset();
  app.current = null;
  app.hasCentered = false;
  newSession();
  updateAll();
  const last = app.progress.last;
  if (last && Number.isFinite(last.lat) && app.map) {
    app.map.setView(last.lat, last.lng, last.zoom || 16, false);
    app.hasCentered = true;
  }
  if (next === 'demo') {
    enterDemo();
    toast('Simulator active. Tap the map to walk there.', 'info', 4500);
  } else {
    exitDemo();
    if (app.settings.autoTrack) {
      void maybeAutoStartLive();
    } else {
      app.tracking = 'idle';
      updateStatusFromState();
    }
  }
  syncSettingsUI();
  scheduleRender();
}

/* ------------------------------------------------------------------ */
/* Save                                                                */
/* ------------------------------------------------------------------ */

function scheduleSave(delay = 700) {
  if (app.saveTimer) clearTimeout(app.saveTimer);
  app.saveTimer = setTimeout(() => {
    app.saveTimer = null;
    saveNow();
  }, delay);
}

function saveNow() {
  if (!app.progress) return;
  app.profiles[app.profile] = app.progress;
  if (app.map) app.progress.last = {
    ...(app.progress.last || {}),
    lat: app.progress.last?.lat ?? app.current?.lat ?? app.map.center.lat,
    lng: app.progress.last?.lng ?? app.current?.lng ?? app.map.center.lng,
    zoom: app.map.zoom,
    at: Date.now(),
  };
  try {
    saveProfile(app.profile, app.progress);
    saveSettings(app.settings);
  } catch (err) {
    console.warn('MistWalk save failed', err);
    toast('Could not save progress. Export a backup now.', 'error', 6000);
  }
}

/* ------------------------------------------------------------------ */
/* Pause / wake lock                                                   */
/* ------------------------------------------------------------------ */

function toggleTracking() {
  if (app.profile === 'demo') {
    if (app.sim.target && !app.sim.paused) {
      app.sim.paused = true;
      if (app.sim.raf) cancelAnimationFrame(app.sim.raf);
      app.sim.raf = null;
      app.sim.lastFrame = 0;
      updateSimUI();
      updateWalkButton();
      setStatus('paused', 'Sim paused', 'Virtual GPS');
    } else if (app.sim.target && app.sim.paused) {
      app.sim.paused = false;
      app.sim.lastFrame = 0;
      if (!app.sim.raf) app.sim.raf = requestAnimationFrame(simTick);
      updateSimUI();
      updateWalkButton();
      setStatus('demo', 'Simulation', 'Virtual GPS');
    } else {
      toast('Tap the map to choose where to walk.', 'info', 2800);
    }
    return;
  }

  if (app.tracking === 'live' || app.tracking === 'locating') {
    stopLiveTracking({ pause: true });
    app.follow = false;
    updateFollowUI();
    toast('Live tracking paused. Your tiles are safe.', 'info', 2800);
  } else {
    resumeSession();
    void startLiveTracking({ userInitiated: true });
  }
  updateWalkButton();
}

async function acquireWakeLock() {
  if (!app.settings.wakeLock || !navigator.wakeLock || app.wakeLock) return;
  try {
    app.wakeLock = await navigator.wakeLock.request('screen');
    app.wakeLock.addEventListener('release', () => {
      app.wakeLock = null;
    });
  } catch {
    app.wakeLock = null;
  }
}

function releaseWakeLock() {
  try {
    app.wakeLock?.release();
  } catch {
    /* ignore */
  }
  app.wakeLock = null;
}

function onVisibility() {
  if (document.hidden) {
    app.hiddenAt = Date.now();
    saveNow();
    releaseWakeLock();
  } else {
    if (AppHiddenLongEnough()) {
      app.gate.reanchor(app.current);
      app.hasCentered = false;
    }
    app.sim.lastFrame = 0;
    if (app.profile === 'live' && app.tracking === 'live') acquireWakeLock();
    if (app.map) {
      app.map.resize?.();
      resizeFog();
      scheduleRender();
    }
  }
}

function AppHiddenLongEnough() {
  return app.hiddenAt && Date.now() - app.hiddenAt > 60_000;
}

/* ------------------------------------------------------------------ */
/* Tick / stale GPS                                                    */
/* ------------------------------------------------------------------ */

function tick() {
  updateSessionUI();
  updateWalkButton();
  if (app.profile === 'live' && app.tracking === 'live' && app.lastFixAt) {
    const age = Date.now() - app.lastFixAt;
    if (age > 28_000) {
      const currentState = ui.statusPill.dataset.state;
      if (currentState === 'live' || currentState === 'weak') {
        setStatus('weak', 'GPS stale', `${Math.round(age / 1000)}s ago`);
      }
    }
  }
  if (app.profile === 'demo' && app.sim.position && !app.current) {
    app.current = { ...app.sim.position, accuracy: 4, heading: null, source: 'sim' };
  }
}

/* ------------------------------------------------------------------ */
/* Modals                                                              */
/* ------------------------------------------------------------------ */

function openModal(id) {
  const modal = $(id);
  if (!modal) return;
  if (app.openModal && app.openModal !== id) closeModal(app.openModal, { restoreFocus: false });
  app.lastFocus = document.activeElement;
  modal.hidden = false;
  ui.scrim.hidden = false;
  app.openModal = id;
  const focusable = modal.querySelector('input:not([type="hidden"]), button, select, [tabindex="0"]');
  setTimeout(() => focusable?.focus?.(), 40);
}

function closeModal(id = app.openModal, { restoreFocus = true } = {}) {
  if (!id) return;
  const modal = $(id);
  if (modal) modal.hidden = true;
  if (app.openModal === id) {
    app.openModal = null;
    ui.scrim.hidden = true;
  }
  if (restoreFocus && app.lastFocus?.focus) {
    try {
      app.lastFocus.focus();
    } catch {
      /* ignore */
    }
  }
}

function closeAllModals() {
  for (const id of ['settings-modal', 'help-modal', 'search-modal', 'gps-modal']) {
    closeModal(id, { restoreFocus: false });
  }
}

function showGpsError(message) {
  if (message) ui.gpsMessage.textContent = message;
  openModal('gps-modal');
}

function openSettings() {
  syncSettingsUI();
  openModal('settings-modal');
}

function openSearch() {
  openModal('search-modal');
  setTimeout(() => ui.searchInput.focus(), 80);
}

function showOnboarding() {
  ui.onboarding.hidden = false;
}

function hideOnboarding(instant = false) {
  if (ui.onboarding.hidden) return;
  if (instant) {
    ui.onboarding.hidden = true;
    return;
  }
  ui.onboarding.classList.add('is-leaving');
  setTimeout(() => {
    ui.onboarding.hidden = true;
    ui.onboarding.classList.remove('is-leaving');
  }, 460);
}

/* ------------------------------------------------------------------ */
/* Settings UI                                                         */
/* ------------------------------------------------------------------ */

function syncSettingsUI() {
  for (const btn of ui.providerSeg.querySelectorAll('button')) {
    btn.classList.toggle('is-active', btn.dataset.provider === app.settings.provider);
    btn.setAttribute('aria-selected', String(btn.dataset.provider === app.settings.provider));
  }
  ui.osmSettings.hidden = app.settings.provider === 'google';
  ui.googleSettings.hidden = app.settings.provider !== 'google';
  ui.basemapSelect.value = app.settings.basemap;
  ui.googleKey.value = app.settings.googleKey || '';
  ui.unitsToggle.checked = app.settings.units === 'metric';
  ui.gridToggle.checked = Boolean(app.settings.showGrid);
  ui.soundToggle.checked = Boolean(app.settings.sound);
  ui.hapticsToggle.checked = Boolean(app.settings.haptics);
  ui.wakeToggle.checked = Boolean(app.settings.wakeLock);
  ui.autotrackToggle.checked = Boolean(app.settings.autoTrack);
  for (const btn of ui.profileSeg.querySelectorAll('button')) {
    btn.classList.toggle('is-active', btn.dataset.profile === app.profile);
    btn.setAttribute('aria-selected', String(btn.dataset.profile === app.profile));
  }
  ui.profileNote.textContent = app.profile === 'live'
    ? 'Live progress is unlocked only by real walking GPS. The simulator has its own separate map.'
    : 'Simulator progress is stored separately and never touches the live map.';
  const bytes = localUsageBytes();
  ui.storageUsage.textContent = `Local storage: ${bytes > 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`}, IndexedDB mirror on`;
  ui.exportBtn.disabled = false;
}

async function applyProvider(provider) {
  if (provider !== 'google' && provider !== 'osm') return;
  if (provider === 'google' && !app.settings.googleKey) {
    syncSettingsUI();
    ui.googleKey.focus();
    toast('Paste a Google Maps browser key first.', 'warn', 3600);
    return;
  }
  if (app.provider === provider && app.map) {
    app.settings.provider = provider;
    saveSettings(app.settings);
    syncSettingsUI();
    return;
  }
  const view = currentMapView();
  app.settings.provider = provider;
  saveSettings(app.settings);
  syncSettingsUI();
  try {
    await buildMap(provider, view, { silent: true });
    if (app.provider === provider) {
      toast(provider === 'google' ? 'Google Maps connected.' : 'Free OpenStreetMap connected.', 'success', 3000);
    } else {
      toast('Google Maps could not connect. Staying on the free map.', 'warn', 5000);
    }
    if (app.profile === 'demo') enterDemo();
    else updateStatusFromState();
  } catch (err) {
    console.error(err);
    app.settings.provider = 'osm';
    saveSettings(app.settings);
    syncSettingsUI();
    await buildMap('osm', view, { silent: true });
    toast('Could not connect to Google Maps. The free map is still here.', 'error', 5600);
  }
}

/* ------------------------------------------------------------------ */
/* Backup                                                              */
/* ------------------------------------------------------------------ */

function downloadBackup() {
  saveNow();
  app.profiles[app.profile] = app.progress;
  const data = exportBackup(app.profiles.live, app.profiles.demo, app.settings);
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
  toast('Backup exported. Keep it somewhere safe.', 'success', 3600);
}

async function handleImportFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const imported = importBackup(parsed);
    if (!window.confirm('Restore this backup? It will replace the live and simulator maps on this device.')) return;
    await writeImported(imported);
    const [live, demo] = await Promise.all([loadProfileAsync('live'), loadProfileAsync('demo')]);
    app.profiles.live = live;
    app.profiles.demo = demo;
    app.progress = app.profiles[app.profile];
    app.gate.reset();
    app.current = null;
    app.hasCentered = false;
    newSession();
    if (imported.settings) {
      app.settings = { ...app.settings, ...imported.settings };
      saveSettings(app.settings);
    }
    updateAll();
    syncSettingsUI();
    scheduleRender();
    toast('Backup restored. Every saved tile is back.', 'success', 4200);
  } catch (err) {
    console.error(err);
    toast(err?.message || 'That backup could not be read.', 'error', 6000);
  } finally {
    ui.importFile.value = '';
  }
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

async function runSearch(query) {
  const q = query.trim();
  if (q.length < 2) {
    toast('Type at least two characters to search.', 'info', 2400);
    return;
  }
  const now = Date.now();
  if (now - app.lastSearchAt < 1100) {
    toast('Give the free geocoder a second between searches.', 'info', 2400);
    return;
  }
  app.lastSearchAt = now;
  app.searchAbort?.abort();
  app.searchAbort = new AbortController();
  ui.searchResults.innerHTML = '<div class="search-loading">SEARCHING OPENSTREETMAP…</div>';
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`;
    const response = await fetch(url, {
      signal: app.searchAbort.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Search returned ${response.status}.`);
    const results = await response.json();
    renderSearchResults(Array.isArray(results) ? results : []);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error(err);
    ui.searchResults.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'search-empty';
    box.innerHTML = '<span class="eyebrow">SEARCH UNAVAILABLE</span><p>The free geocoder did not answer. Check your connection and try again.</p>';
    ui.searchResults.appendChild(box);
  }
}

function renderSearchResults(results) {
  ui.searchResults.innerHTML = '';
  if (!results.length) {
    const box = document.createElement('div');
    box.className = 'search-empty';
    box.innerHTML = '<span class="eyebrow">NO MATCHES</span><p>Try a city, street, or landmark with more detail.</p>';
    ui.searchResults.appendChild(box);
    return;
  }
  for (const item of results) {
    const lat = Number(item.lat);
    const lng = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-result';
    button.dataset.lat = String(lat);
    button.dataset.lng = String(lng);
    const icon = document.createElement('span');
    icon.className = 'search-result-icon';
    icon.textContent = (item.type || '•').slice(0, 2).toUpperCase();
    const copy = document.createElement('span');
    copy.className = 'search-result-copy';
    const strong = document.createElement('strong');
    strong.textContent = item.name || (item.display_name || '').split(',')[0] || 'Unnamed place';
    const small = document.createElement('small');
    small.textContent = item.display_name || '';
    copy.append(strong, small);
    button.append(icon, copy);
    button.addEventListener('click', () => {
      closeModal('search-modal');
      if (!app.map) return;
      app.follow = false;
      updateFollowUI();
      app.map.setView(lat, lng, 17, false);
      app.hasCentered = true;
      scheduleRender();
      if (app.profile === 'demo') {
        toast('Map moved. Press “Place me” to put the walker here, then tap a destination.', 'info', 5200);
      } else {
        toast('Map moved. Searching never unlocks tiles. Only walking does.', 'info', 4200);
      }
    });
    ui.searchResults.appendChild(button);
  }
}

/* ------------------------------------------------------------------ */
/* Settings actions                                                    */
/* ------------------------------------------------------------------ */

async function resetCurrentProfile() {
  const name = app.profile === 'live' ? 'live map' : 'simulator map';
  if (!window.confirm(`Reset the ${name}? Every tile, path, and distance in this profile will be erased. This cannot be undone.`)) return;
  const fresh = createProgress();
  app.progress = fresh;
  app.profiles[app.profile] = fresh;
  await clearProfile(app.profile);
  app.gate.reset();
  app.current = null;
  app.hasCentered = false;
  app.sim.position = null;
  app.sim.target = null;
  app.sim.anchored = false;
  stopSim({ silent: true });
  newSession();
  updateAll();
  syncSettingsUI();
  if (app.profile === 'demo') enterDemo();
  else {
    app.tracking = 'idle';
    updateStatusFromState();
    if (app.map) app.map.setView(DEFAULT_VIEW.lat, DEFAULT_VIEW.lng, DEFAULT_VIEW.zoom, false);
  }
  scheduleRender();
  toast('Profile reset. A new map begins in mist.', 'info', 3800);
}

/* ------------------------------------------------------------------ */
/* Event wiring                                                        */
/* ------------------------------------------------------------------ */

function bindUI() {
  ui.startGps.addEventListener('click', async () => {
    app.settings.onboarded = true;
    app.settings.lastProfile = 'live';
    saveSettings(app.settings);
    hideOnboarding();
    if (app.profile !== 'live') await switchProfile('live');
    app.follow = true;
    updateFollowUI();
    void startLiveTracking({ userInitiated: true });
  });

  ui.startDemo.addEventListener('click', async () => {
    app.settings.onboarded = true;
    app.settings.lastProfile = 'demo';
    saveSettings(app.settings);
    hideOnboarding();
    if (app.profile !== 'demo') await switchProfile('demo');
    else enterDemo();
    setTimeout(() => toast('Simulator ready. Tap the map to walk there.', 'info', 4600), 700);
  });

  ui.onboardingHelp.addEventListener('click', (event) => {
    event.preventDefault();
    openModal('help-modal');
  });

  ui.brand.addEventListener('click', () => openModal('help-modal'));
  ui.searchBtn.addEventListener('click', openSearch);
  ui.settingsBtn.addEventListener('click', openSettings);
  ui.helpBtn.addEventListener('click', () => openModal('help-modal'));
  ui.helpExport.addEventListener('click', () => {
    closeModal('help-modal');
    downloadBackup();
  });

  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => closeModal(button.dataset.close));
  }
  for (const modal of [ui.settingsModal, ui.helpModal, ui.searchModal, ui.gpsModal]) {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal(modal.id);
    });
  }
  ui.scrim.addEventListener('click', () => closeAllModals());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (app.openModal) closeAllModals();
      else if (!ui.onboarding.hidden) { /* onboarding is intentional */ }
    }
  });

  ui.followBtn.addEventListener('click', () => {
    if (app.follow) {
      setFollow(false);
      toast('Following paused. Pan freely.', 'info', 2200);
    } else {
      setFollow(true, { recenter: true });
    }
  });
  ui.walkToggle.addEventListener('click', toggleTracking);
  ui.zoomIn.addEventListener('click', () => app.map?.zoomBy(1));
  ui.zoomOut.addEventListener('click', () => app.map?.zoomBy(-1));
  ui.locateBtn.addEventListener('click', recenter);
  ui.fitBtn.addEventListener('click', fitExplored);

  ui.simSpeed.addEventListener('click', () => {
    const index = SIM_SPEEDS.indexOf(app.sim.multiplier);
    app.sim.multiplier = SIM_SPEEDS[(index + 1) % SIM_SPEEDS.length];
    updateSimUI();
    toast(`Simulation time ${app.sim.multiplier}×. The walking gate still sees ${WALK_SPEED_MPS} m/s.`, 'info', 3600);
  });
  ui.simPlace.addEventListener('click', placeSimWalker);
  ui.simStop.addEventListener('click', () => {
    stopSim();
    toast('Simulation stopped. Progress is saved.', 'info', 2600);
  });
  ui.simExit.addEventListener('click', () => {
    closeAllModals();
    void switchProfile('live');
  });

  ui.providerSeg.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-provider]');
    if (!button) return;
    const provider = button.dataset.provider;
    if (provider === 'google' && !app.settings.googleKey) {
      app.settings.provider = 'google';
      saveSettings(app.settings);
      syncSettingsUI();
      ui.googleKey.focus();
      toast('Paste a Google Maps browser key, then press Connect. The free map still works without one.', 'info', 5200);
      return;
    }
    void applyProvider(provider);
  });
  ui.googleSave.addEventListener('click', () => {
    const key = ui.googleKey.value.trim();
    if (key.length < 20) {
      toast('That does not look like a Google Maps key.', 'warn', 3400);
      return;
    }
    app.settings.googleKey = key;
    saveSettings(app.settings);
    void applyProvider('google');
  });
  ui.basemapSelect.addEventListener('change', () => {
    app.settings.basemap = ui.basemapSelect.value;
    saveSettings(app.settings);
    app.map?.setBasemap?.(app.settings.basemap);
    updateProviderUI();
    scheduleRender();
  });

  ui.unitsToggle.addEventListener('change', () => {
    app.settings.units = ui.unitsToggle.checked ? 'metric' : 'imperial';
    saveSettings(app.settings);
    updateAll();
  });
  ui.gridToggle.addEventListener('change', () => {
    app.settings.showGrid = ui.gridToggle.checked;
    saveSettings(app.settings);
    scheduleRender();
  });
  ui.soundToggle.addEventListener('change', () => {
    app.settings.sound = ui.soundToggle.checked;
    saveSettings(app.settings);
    if (app.settings.sound) playUnlockSound();
  });
  ui.hapticsToggle.addEventListener('change', () => {
    app.settings.haptics = ui.hapticsToggle.checked;
    saveSettings(app.settings);
  });
  ui.wakeToggle.addEventListener('change', () => {
    app.settings.wakeLock = ui.wakeToggle.checked;
    saveSettings(app.settings);
    if (!app.settings.wakeLock) releaseWakeLock();
    else if (app.tracking === 'live') acquireWakeLock();
  });
  ui.autotrackToggle.addEventListener('change', () => {
    app.settings.autoTrack = ui.autotrackToggle.checked;
    saveSettings(app.settings);
  });

  ui.profileSeg.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-profile]');
    if (!button) return;
    void switchProfile(button.dataset.profile).then(() => syncSettingsUI());
  });

  ui.exportBtn.addEventListener('click', downloadBackup);
  ui.importBtn.addEventListener('click', () => ui.importFile.click());
  ui.importFile.addEventListener('change', () => handleImportFile(ui.importFile.files?.[0]));
  ui.resetBtn.addEventListener('click', resetCurrentProfile);

  ui.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void runSearch(ui.searchInput.value);
  });

  ui.gpsRetry.addEventListener('click', () => {
    closeModal('gps-modal');
    if (app.profile !== 'live') void switchProfile('live').then(() => startLiveTracking({ userInitiated: true }));
    else void startLiveTracking({ userInitiated: true });
  });
  ui.gpsSim.addEventListener('click', async () => {
    closeModal('gps-modal');
    if (app.profile !== 'demo') await switchProfile('demo');
    else enterDemo();
  });

  // Keep the keyboard-visible focus ring but not a hover-only app.
  document.addEventListener('pointerdown', () => {
    if (document.activeElement?.blur && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
      document.activeElement.blur();
    }
  }, { passive: true });
}

/* ------------------------------------------------------------------ */
/* Service worker / debug                                              */
/* ------------------------------------------------------------------ */

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker registration failed', err));
}

function exposeDebugApi() {
  if (!new URLSearchParams(location.search).has('debug')) return;
  app.debug = true;
  window.__mistwalk = {
    app,
    state: () => ({
      profile: app.profile,
      tracking: app.tracking,
      provider: app.provider,
      cells: Object.keys(app.progress.cells).length,
      path: app.progress.path.length,
      distance: app.progress.stats.distance,
      current: app.current,
      follow: app.follow,
      status: ui.statusText.textContent,
      session: { ...app.session },
      sim: { position: app.sim.position, target: app.sim.target, paused: app.sim.paused },
      hasFog: Boolean(app.fog),
      canvas: app.fog ? { w: app.fog.width, h: app.fog.height } : null,
    }),
    fix: (lat, lng, opts = {}) => handleFix({
      lat,
      lng,
      accuracy: opts.accuracy ?? 4,
      speed: opts.speed ?? null,
      heading: opts.heading ?? null,
      t: opts.t ?? Date.now(),
    }, opts.source || 'gps'),
    switchProfile,
    enterDemo,
    placeSimWalker,
    startSimulationTo,
    recenter,
    fitExplored,
    saveNow,
    closeModals: closeAllModals,
    hideOnboarding: () => hideOnboarding(true),
    mapCenter: () => app.map?.center,
    setView: (lat, lng, zoom) => app.map?.setView(lat, lng, zoom ?? 16, false),
  };
}

/* ------------------------------------------------------------------ */
/* Go                                                                  */
/* ------------------------------------------------------------------ */

boot().catch((err) => {
  console.error('MistWalk boot failed', err);
  dismissBootScreen();
  toast('MistWalk could not start. Reload the page and try again.', 'error', 10_000);
});
