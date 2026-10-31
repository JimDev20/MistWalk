/* MistWalk fog renderer — an opaque, textured mist with permanent cut-outs. */

import {
  cellCorners,
  cellFromLatLng,
  cellToBounds,
  parseCellKey,
} from './core.js';

const TAU = Math.PI * 2;

function makeNoiseCanvas(size = 160) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
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

function polygon(ctx, points) {
  if (!points || points.length < 3) return false;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
  return true;
}

function cellCornersScreen(project, cell) {
  const corners = cellCorners(cell);
  const out = [];
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
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    this.mask = document.createElement('canvas');
    this.maskCtx = this.mask.getContext('2d', { alpha: true });
    this.trail = document.createElement('canvas');
    this.trailCtx = this.trail.getContext('2d', { alpha: true });
    this.noise = makeNoiseCanvas(160);
    this.noisePattern = this.ctx.createPattern(this.noise, 'repeat');
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.cellRange = null;
    this.stats = { visible: 0, drawn: 0 };
  }

  resize(width, height, dpr = 1) {
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

  computeCellRange(bounds, margin = 2) {
    if (!bounds) return null;
    const nw = cellFromLatLng(Math.min(85, bounds.north), bounds.west);
    const se = cellFromLatLng(Math.max(-85, bounds.south), bounds.east);
    let minX = Math.min(nw.x, se.x) - margin;
    let maxX = Math.max(nw.x, se.x) + margin;
    let minY = Math.min(nw.y, se.y) - margin;
    let maxY = Math.max(nw.y, se.y) + margin;
    // World views can be huge; that is fine because there will be few cells.
    if (maxX - minX > 40000 || maxY - minY > 40000) {
      return { minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity };
    }
    return { minX, maxX, minY, maxY };
  }

  isVisibleCell(cell) {
    const r = this.cellRange;
    if (!r) return true;
    return cell.x >= r.minX && cell.x <= r.maxX && cell.y >= r.minY && cell.y <= r.maxY;
  }

  drawFogBase(time) {
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
      { x: 0.54, y: 0.08 + drift * 0.04, r: 0.48, c: 'rgba(180, 180, 180, 0.13)' },
    ];
    for (const b of blooms) {
      const gradient = ctx.createRadialGradient(b.x * w, b.y * h, 0, b.x * w, b.y * h, b.r * Math.max(w, h));
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
    const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.28, w / 2, h / 2, Math.max(w, h) * 0.75);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.52)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  }

  punchCells(project, cells, recent, time) {
    const { width: w, height: h } = this;
    const mask = this.maskCtx;
    mask.clearRect(0, 0, w, h);
    mask.globalCompositeOperation = 'source-over';
    mask.fillStyle = '#fff';

    let drawn = 0;
    for (const [key, meta] of Object.entries(cells || {})) {
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

  drawTrail(project, path) {
    if (!Array.isArray(path) || path.length < 2) return;
    const { ctx } = this;
    const tctx = this.trailCtx;
    const points = [];
    const start = Math.max(0, path.length - 1600);
    for (let i = start; i < path.length; i += 1) {
      const p = path[i];
      if (!Array.isArray(p)) continue;
      const sp = project(p[0], p[1]);
      if (!sp || !Number.isFinite(sp.x) || !Number.isFinite(sp.y)) continue;
      if (sp.x < -60 || sp.y < -60 || sp.x > this.width + 60 || sp.y > this.height + 60) {
        // Keep a gap-free line by retaining points just outside, but drop far ones.
        if (sp.x < -2000 || sp.y < -2000 || sp.x > this.width + 2000 || sp.y > this.height + 2000) continue;
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

  drawAccuracy(project, current) {
    if (!current || !Number.isFinite(current.accuracy)) return;
    if (current.accuracy <= 0 || current.accuracy > 500) return;
    const center = project(current.lat, current.lng);
    if (!center) return;
    const latRad = (current.lat * Math.PI) / 180;
    const deltaLng = current.accuracy / Math.max(1, 111320 * Math.cos(latRad));
    const edge = project(current.lat, current.lng + deltaLng);
    if (!edge) return;
    const radius = Math.abs(edge.x - center.x);
    if (!Number.isFinite(radius) || radius < 2) return;

    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, TAU);
    ctx.fillStyle = current.accuracy <= 35 ? 'rgba(56, 189, 248, 0.07)' : 'rgba(251, 191, 36, 0.06)';
    ctx.fill();
    ctx.strokeStyle = current.accuracy <= 35 ? 'rgba(125, 211, 252, 0.28)' : 'rgba(251, 191, 36, 0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    ctx.stroke();
    ctx.restore();
  }

  drawMarker(project, current) {
    if (!current) return;
    const p = project(current.lat, current.lng);
    if (!p) return;
    const { ctx } = this;
    const good = current.accuracy === null || current.accuracy === undefined || current.accuracy <= 35;
    const accent = good ? '#9cecf5' : '#f0c75e';
    const heading = Number.isFinite(current.heading) ? (current.heading * Math.PI) / 180 : 0;
    const ink = '#f3f3f3';

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Flat halo. No glow; the avatar is the marker.
    ctx.beginPath();
    ctx.arc(0, 0, 34, 0, TAU);
    ctx.fillStyle = good ? 'rgba(156, 236, 245, 0.09)' : 'rgba(240, 199, 94, 0.1)';
    ctx.fill();

    // Direction wedge rotates; the male avatar stays upright.
    ctx.save();
    ctx.rotate(heading);
    ctx.beginPath();
    ctx.moveTo(0, -40);
    ctx.lineTo(-6.5, -31);
    ctx.lineTo(6.5, -31);
    ctx.closePath();
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.restore();

    // Male avatar: broad shoulders, short hair, upright at every heading.
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, TAU);
    ctx.fillStyle = '#0b0b0b';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = ink;
    ctx.stroke();

    // The front of the ring carries the one accent and follows the heading.
    ctx.save();
    ctx.rotate(heading);
    ctx.beginPath();
    ctx.arc(0, 0, 26, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.restore();

    // shoulders / chest
    ctx.beginPath();
    ctx.moveTo(-12.5, 19);
    ctx.bezierCurveTo(-12.5, 4, -6.5, 0.5, 0, 0.5);
    ctx.bezierCurveTo(6.5, 0.5, 12.5, 4, 12.5, 19);
    ctx.closePath();
    ctx.fillStyle = ink;
    ctx.fill();

    // neck
    ctx.fillStyle = ink;
    ctx.fillRect(-3.6, -2.5, 7.2, 5.5);

    // head
    ctx.beginPath();
    ctx.arc(0, -8.5, 6.4, 0, TAU);
    ctx.fillStyle = ink;
    ctx.fill();

    // short hair
    ctx.beginPath();
    ctx.arc(0, -9.8, 6.4, Math.PI, TAU);
    ctx.fillStyle = '#2a2a2a';
    ctx.fill();

    ctx.restore();
  }

  drawPulses(project, pulses, time, reducedMotion) {
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

  drawTarget(project, current, target) {
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

  /**
   * @param {object} frame
   * @param {(lat:number,lng:number)=>{x:number,y:number}|null} frame.project
   * @param {object} frame.cells
   * @param {Map<string,number>} frame.recent
   * @param {Array} frame.path
   * @param {object|null} frame.current
   * @param {object|null} frame.target
   * @param {object} frame.bounds
   * @param {number} frame.time
   * @param {boolean} frame.reducedMotion
   * @param {boolean} frame.showGrid
   */
  render(frame) {
    if (!this.width || !this.height) return;
    const {
      project,
      cells = {},
      recent = new Map(),
      path = [],
      current = null,
      target = null,
      bounds = null,
      time = performance.now(),
      reducedMotion = false,
      showGrid = true,
      pulses = [],
      zoom = 16,
    } = frame;

    this.showGrid = showGrid && zoom >= 15;
    this.cellRange = this.computeCellRange(bounds, 1);

    this.drawFogBase(time);
    this.punchCells(project, cells, recent, time);
    this.drawTrail(project, path);
    this.drawAccuracy(project, current);
    this.drawPulses(project, pulses, time, reducedMotion);
    this.drawTarget(project, current, target);
    this.drawMarker(project, current, time, reducedMotion);
  }
}
