/* MistWalk core — pure, testable geography, walking gate, and progress logic. */

export const EARTH_RADIUS_M = 6378137;
export const MAX_MERCATOR_LAT = 85.05112878;
export const CELL_SIZE_M = 12;
export const WALK_LIMIT_MPS = 3.0; // ~10.8 km/h: a very brisk walk
export const VEHICLE_LIMIT_MPS = 4.2; // ~15 km/h: anything faster cannot unlock
export const UNLOCK_ACCURACY_M = 35;
export const VEHICLE_LOCKOUT_MS = 45_000;
export const PATH_STEP_M = 4;
export const MAX_PATH_POINTS = 12_000;

const EARTH_CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS_M;

/* ------------------------------------------------------------------ */
/* Web Mercator helpers                                                */
/* ------------------------------------------------------------------ */

export function clampLat(lat) {
  return Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
}

export function normalizeLng(lng) {
  const wrapped = ((lng + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

export function projectMeters(lat, lng) {
  const safeLat = clampLat(lat);
  return {
    x: EARTH_RADIUS_M * (normalizeLng(lng) * Math.PI) / 180,
    y: EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + (safeLat * Math.PI) / 360)),
  };
}

export function unprojectMeters(x, y) {
  return {
    lat: (2 * Math.atan(Math.exp(y / EARTH_RADIUS_M)) - Math.PI / 2) * 180 / Math.PI,
    lng: (x / EARTH_RADIUS_M) * 180 / Math.PI,
  };
}

/* ------------------------------------------------------------------ */
/* The 12-metre grid                                                   */
/* ------------------------------------------------------------------ */

export function cellKey(x, y) {
  return `${x.toString(36)}_${y.toString(36)}`;
}

export function parseCellKey(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split('_');
  if (parts.length !== 2) return null;
  const x = parseInt(parts[0], 36);
  const y = parseInt(parts[1], 36);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y, key };
}

export function cellFromLatLng(lat, lng, size = CELL_SIZE_M) {
  const { x, y } = projectMeters(lat, lng);
  const cx = Math.floor(x / size);
  const cy = Math.floor(y / size);
  return { x: cx, y: cy, key: cellKey(cx, cy) };
}

export function cellFromKey(key) {
  return parseCellKey(key);
}

export function cellToBounds(cell, size = CELL_SIZE_M) {
  const nw = unprojectMeters(cell.x * size, (cell.y + 1) * size);
  const se = unprojectMeters((cell.x + 1) * size, cell.y * size);
  return {
    west: nw.lng,
    north: nw.lat,
    east: se.lng,
    south: se.lat,
  };
}

export function cellCenter(cell, size = CELL_SIZE_M) {
  return unprojectMeters((cell.x + 0.5) * size, (cell.y + 0.5) * size);
}

export function cellCorners(cell, size = CELL_SIZE_M) {
  const b = cellToBounds(cell, size);
  return [
    { lat: b.north, lng: b.west },
    { lat: b.north, lng: b.east },
    { lat: b.south, lng: b.east },
    { lat: b.south, lng: b.west },
  ];
}

/** Approximate ground area of one cell at a given latitude. */
export function cellAreaM2(lat, size = CELL_SIZE_M) {
  const safe = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, Math.abs(lat)));
  const scale = Math.cos((safe * Math.PI) / 180);
  return size * size * scale * scale;
}

/* ------------------------------------------------------------------ */
/* Distance / bearing                                                  */
/* ------------------------------------------------------------------ */

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

export function haversineMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDegrees(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Interpolate a great-circle-ish line into points no more than stepM apart. */
export function interpolatePoints(from, to, stepM = PATH_STEP_M) {
  if (!from || !to) return [];
  const total = haversineMeters(from, to);
  if (!Number.isFinite(total) || total < 0.01) return [{ ...to }];
  if (total > 250) return [{ ...to }];
  const steps = Math.max(1, Math.ceil(total / Math.max(1, stepM)));
  const points = [];
  for (let i = 1; i <= steps; i += 1) {
    const f = i / steps;
    points.push({
      lat: from.lat + (to.lat - from.lat) * f,
      lng: from.lng + (to.lng - from.lng) * f,
    });
  }
  return points;
}

export function cellsAlongLine(from, to, stepM = 5) {
  const seen = new Set();
  const cells = [];
  for (const point of interpolatePoints(from, to, stepM)) {
    const cell = cellFromLatLng(point.lat, point.lng);
    if (!seen.has(cell.key)) {
      seen.add(cell.key);
      cells.push(cell);
    }
  }
  return cells;
}

/* ------------------------------------------------------------------ */
/* Walking-only gate                                                   */
/* ------------------------------------------------------------------ */

export function normalizeFix(input) {
  if (!input || typeof input !== 'object') return null;
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const accuracy = Number.isFinite(Number(input.accuracy)) ? Math.max(0, Number(input.accuracy)) : null;
  const t = Number.isFinite(Number(input.t)) ? Number(input.t) : Date.now();
  let speed = null;
  if (input.speed !== null && input.speed !== undefined && Number.isFinite(Number(input.speed))) {
    const s = Number(input.speed);
    if (s >= 0 && s < 120) speed = s;
  }
  return { lat, lng, accuracy, t, speed };
}

/**
 * Stateful gate. Feed it every geolocation fix. It returns whether movement may
 * unlock cells, whether the user appears to be in a vehicle, and the distance
 * that should count toward walking statistics.
 */
export class WalkGate {
  constructor({
    limit = WALK_LIMIT_MPS,
    vehicleLimit = VEHICLE_LIMIT_MPS,
    maxAccuracy = UNLOCK_ACCURACY_M,
    lockoutMs = VEHICLE_LOCKOUT_MS,
  } = {}) {
    this.limit = limit;
    this.vehicleLimit = vehicleLimit;
    this.maxAccuracy = maxAccuracy;
    this.lockoutMs = lockoutMs;
    this.lastFix = null;
    this.lastUnlockFix = null;
    this.vehicleUntil = 0;
    this.calmFixes = 0;
    this.lastReason = 'ready';
  }

  reset() {
    this.lastFix = null;
    this.lastUnlockFix = null;
    this.vehicleUntil = 0;
    this.calmFixes = 0;
    this.lastReason = 'ready';
  }

  /** Used when the page resumes: do not bridge a large gap. */
  reanchor() {
    // Start clean. The next fix is treated as a first fix and can only unlock
    // the tile it lands in — never a corridor from the old location.
    this.lastFix = null;
    this.lastUnlockFix = null;
    this.vehicleUntil = 0;
    this.calmFixes = 0;
  }

  evaluate(input) {
    const fix = normalizeFix(input);
    if (!fix) {
      return { unlock: false, walking: false, reason: 'bad-fix', distance: 0, added: [] };
    }
    const accuracyOk = fix.accuracy === null || fix.accuracy <= this.maxAccuracy;

    if (!this.lastFix) {
      this.lastFix = fix;
      this.lastReason = accuracyOk ? 'first-fix' : 'weak-gps';
      this.lastUnlockFix = accuracyOk ? fix : null;
      return {
        unlock: accuracyOk,
        walking: true,
        reason: this.lastReason,
        distance: 0,
        speed: 0,
        from: fix,
        to: fix,
        vehicle: false,
        accuracyOk,
      };
    }

    const dt = (fix.t - this.lastFix.t) / 1000;
    if (dt < 0.15) {
      return { unlock: false, walking: false, reason: 'duplicate', distance: 0, vehicle: false, accuracyOk };
    }

    const distance = haversineMeters(this.lastFix, fix);
    const rawSpeed = distance / dt;
    const reportedSpeed = fix.speed;
    const now = fix.t;

    // A long gap can hide a car journey. Never bridge it.
    if (dt > 120 && distance > 100) {
      this.lastFix = fix;
      // Anchor at the new place. Never let the next walk retroactively unlock
      // the road that was crossed during the gap.
      this.lastUnlockFix = fix;
      this.lastReason = 'resume-jump';
      return { unlock: false, walking: false, reason: 'resume-jump', distance: 0, speed: rawSpeed, vehicle: false, accuracyOk };
    }

    if (distance > 300 && dt < 60) {
      this.lastFix = fix;
      this.lastUnlockFix = fix;
      this.lastReason = 'gps-jump';
      return { unlock: false, walking: false, reason: 'gps-jump', distance: 0, speed: rawSpeed, vehicle: false, accuracyOk };
    }

    const vehicleSuspected =
      (reportedSpeed !== null && reportedSpeed > this.vehicleLimit) ||
      (rawSpeed > this.vehicleLimit && distance > 8 && accuracyOk) ||
      (distance > 400 && dt < 120);

    if (vehicleSuspected) {
      this.vehicleUntil = now + this.lockoutMs;
      this.calmFixes = 0;
      this.lastFix = fix;
      // The vehicle's route must never become a walked corridor later.
      this.lastUnlockFix = fix;
      this.lastReason = 'too-fast';
      return {
        unlock: false,
        walking: false,
        reason: 'too-fast',
        distance: 0,
        speed: reportedSpeed ?? rawSpeed,
        vehicle: true,
        accuracyOk,
      };
    }

    if (now < this.vehicleUntil) {
      const calm =
        rawSpeed >= 0.25 &&
        rawSpeed <= 2.2 &&
        (reportedSpeed === null || reportedSpeed <= 2.5) &&
        distance >= 0.25 &&
        distance < 15;
      this.calmFixes = calm ? this.calmFixes + 1 : 0;
      this.lastFix = fix;
      // Move the unlock anchor with the vehicle, not with the last footstep.
      this.lastUnlockFix = fix;
      if (this.calmFixes < 3) {
        this.lastReason = 'vehicle-lockout';
        return {
          unlock: false,
          walking: false,
          reason: 'vehicle-lockout',
          distance: 0,
          speed: reportedSpeed ?? rawSpeed,
          vehicle: true,
          accuracyOk,
        };
      }
      // Three calm fixes in a row: assume the walk resumed.
      this.vehicleUntil = 0;
      this.calmFixes = 0;
    }

    // Only interpolate from a trusted (walking) anchor. If none exists, the
    // current fix can unlock its own tile and nothing behind it.
    const from = this.lastUnlockFix || fix;
    this.lastFix = fix;

    if (distance < 0.8) {
      this.lastReason = accuracyOk ? 'stationary' : 'weak-gps';
      if (accuracyOk) this.lastUnlockFix = fix;
      return {
        unlock: accuracyOk,
        walking: true,
        reason: this.lastReason,
        distance: 0,
        speed: 0,
        from,
        to: fix,
        vehicle: false,
        accuracyOk,
      };
    }

    if (!accuracyOk) {
      this.lastReason = 'weak-gps';
      return {
        unlock: false,
        walking: true,
        reason: 'weak-gps',
        distance: 0,
        speed: rawSpeed,
        from,
        to: fix,
        vehicle: false,
        accuracyOk,
      };
    }

    this.lastUnlockFix = fix;
    this.lastReason = 'walking';
    return {
      unlock: true,
      walking: true,
      reason: 'walking',
      distance,
      speed: reportedSpeed ?? rawSpeed,
      from,
      to: fix,
      vehicle: false,
      accuracyOk,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

export function createProgress() {
  return {
    version: 2,
    cells: {},
    path: [],
    stats: {
      distance: 0,
      walkingMs: 0,
      sessions: 0,
      unlocks: 0,
      startedAt: Date.now(),
      lastWalkAt: 0,
    },
    last: null,
    settings: {
      units: 'metric',
      sound: true,
      haptics: true,
      autoTrack: true,
      wakeLock: true,
    },
  };
}

export function migrateProgress(raw) {
  if (!raw || typeof raw !== 'object') return createProgress();
  const base = createProgress();
  const out = {
    ...base,
    ...raw,
    cells: raw.cells && typeof raw.cells === 'object' ? raw.cells : {},
    path: Array.isArray(raw.path) ? raw.path.filter((p) => Array.isArray(p) && p.length >= 2) : [],
    stats: { ...base.stats, ...(raw.stats || {}) },
    settings: { ...base.settings, ...(raw.settings || {}) },
  };
  if (!Number.isFinite(out.stats.distance)) out.stats.distance = 0;
  if (!Number.isFinite(out.stats.walkingMs)) out.stats.walkingMs = 0;
  if (!Number.isFinite(out.stats.unlocks)) out.stats.unlocks = Object.keys(out.cells).length;
  return out;
}

export function unlockCells(progress, cells, t = Date.now(), source = 'gps') {
  const added = [];
  for (const cell of cells) {
    if (!cell || !cell.key) continue;
    const existing = progress.cells[cell.key];
    if (!existing) {
      progress.cells[cell.key] = { t, n: 1, s: source };
      added.push(cell);
    } else {
      existing.n = (existing.n || 1) + 1;
      existing.lt = t;
    }
  }
  progress.stats.unlocks = Object.keys(progress.cells).length;
  return added;
}

export function appendPath(progress, point, t) {
  const path = progress.path;
  const last = path[path.length - 1];
  if (!last) {
    path.push([round5(point.lat), round5(point.lng), t]);
  } else {
    const prev = { lat: last[0], lng: last[1] };
    const gap = haversineMeters(prev, point);
    const age = t - (last[2] || 0);
    if (gap >= 2 || age >= 12_000) {
      path.push([round5(point.lat), round5(point.lng), t]);
    }
  }
  if (path.length > MAX_PATH_POINTS) {
    path.splice(0, path.length - MAX_PATH_POINTS);
  }
}

export function round5(value) {
  return Math.round(value * 100000) / 100000;
}

export function progressStats(progress) {
  const cells = Object.entries(progress.cells || {});
  let area = 0;
  const days = new Set();
  let firstAt = null;
  let lastAt = null;
  for (const [key, meta] of cells) {
    const cell = parseCellKey(key);
    if (!cell) continue;
    const center = cellCenter(cell);
    area += cellAreaM2(center.lat);
    if (meta && Number.isFinite(meta.t)) {
      const day = dayKey(meta.t);
      days.add(day);
      if (firstAt === null || meta.t < firstAt) firstAt = meta.t;
      if (lastAt === null || meta.t > lastAt) lastAt = meta.t;
    }
  }
  const orderedDays = [...days].sort();
  let streak = 0;
  if (orderedDays.length) {
    const today = dayKey(Date.now());
    const yesterday = dayKey(Date.now() - 86_400_000);
    const lastDay = orderedDays[orderedDays.length - 1];
    if (lastDay === today || lastDay === yesterday) {
      streak = 1;
      for (let i = orderedDays.length - 1; i > 0; i -= 1) {
        const a = new Date(`${orderedDays[i]}T12:00:00`);
        const b = new Date(`${orderedDays[i - 1]}T12:00:00`);
        if (Math.round((a - b) / 86_400_000) === 1) streak += 1;
        else break;
      }
    }
  }
  const count = cells.length;
  const level = levelFor(count);
  return {
    cellCount: count,
    areaM2: area,
    days: orderedDays.length,
    streak,
    firstAt,
    lastAt,
    level,
    distance: progress.stats.distance || 0,
    walkingMs: progress.stats.walkingMs || 0,
  };
}

export const LEVELS = [
  { min: 0, name: 'Mistwalker', tag: 'The map is still sleeping.' },
  { min: 25, name: 'Pathfinder', tag: 'A trail is forming.' },
  { min: 100, name: 'Wayfinder', tag: 'Streets remember you.' },
  { min: 250, name: 'Trailblazer', tag: 'The fog is giving way.' },
  { min: 600, name: 'Cartographer', tag: 'You are drawing a new world.' },
  { min: 1500, name: 'Horizon Seeker', tag: 'No street is truly unknown.' },
  { min: 4000, name: 'Atlas', tag: 'The mist answers to you.' },
];

export function levelFor(cellCount) {
  let index = 0;
  for (let i = 0; i < LEVELS.length; i += 1) {
    if (cellCount >= LEVELS[i].min) index = i;
  }
  const current = LEVELS[index];
  const next = LEVELS[index + 1] || null;
  const progress = next
    ? Math.max(0, Math.min(1, (cellCount - current.min) / (next.min - current.min)))
    : 1;
  return { ...current, index, next, progress };
}

export function dayKey(t) {
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function formatDistance(meters, units = 'metric') {
  if (!Number.isFinite(meters)) meters = 0;
  if (units === 'imperial') {
    const feet = meters * 3.28084;
    if (feet < 1000) return `${Math.round(feet)} ft`;
    return `${(feet / 5280).toFixed(feet / 5280 >= 10 ? 1 : 2)} mi`;
  }
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters / 1000 >= 10 ? 1 : 2)} km`;
}

export function formatArea(m2, units = 'metric') {
  if (!Number.isFinite(m2)) m2 = 0;
  if (units === 'imperial') {
    const ft2 = m2 * 10.7639;
    if (ft2 < 43560) return `${Math.round(ft2).toLocaleString()} ft²`;
    return `${(ft2 / 43560).toFixed(2)} acres`;
  }
  if (m2 < 10_000) return `${Math.round(m2).toLocaleString()} m²`;
  return `${(m2 / 1_000_000).toFixed(m2 / 1_000_000 >= 10 ? 1 : 2)} km²`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0 min';
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 1) return '<1 min';
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatCoordinate(lat, lng, digits = 5) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '—';
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(digits)}° ${ns}  ${Math.abs(lng).toFixed(digits)}° ${ew}`;
}

export function formatSpeed(mps, units = 'metric') {
  if (!Number.isFinite(mps) || mps < 0.05) return '0.0';
  if (units === 'imperial') return (mps * 2.23694).toFixed(1);
  return (mps * 3.6).toFixed(1);
}

export function speedUnit(units = 'metric') {
  return units === 'imperial' ? 'mph' : 'km/h';
}

/** Convert viewport screen points back to a geographic line, clipped to bounds. */
export function cellIsInBounds(cell, bounds, size = CELL_SIZE_M) {
  const b = cellToBounds(cell, size);
  return !(b.east < bounds.west || b.west > bounds.east || b.north < bounds.south || b.south > bounds.north);
}

export function progressToPercent(cellCount, total = 1_000_000) {
  return Math.min(100, (cellCount / total) * 100);
}
