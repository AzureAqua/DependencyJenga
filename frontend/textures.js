// textures.js - canvas textures for the block faces. What they show is decided in appearance.js:
// base colour, a friction surface (knurled vs glossy streaks), cracks for fragility, a CVSS badge for vulnerable
// blocks, a padlock on locked rows, and the dependency name. Every face gets the same treatment, so a block reads
// correctly from any side.
import * as THREE from 'three';
import { INK, PAPER_INK } from './appearance.js';

export { INK };
const FONT = '"Patrick Hand", "Comic Sans MS", "Segoe Print", "Marker Felt", cursive';

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function grain(ctx, w, h, r) {
  ctx.lineWidth = 1;
  for (let i = 0; i < Math.max(4, h / 7); i++) {
    const y = r() * h;
    ctx.strokeStyle = `rgba(80,50,20,${0.04 + r() * 0.05})`;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= w; x += w / 8) ctx.lineTo(x, y + (r() - 0.5) * 3);
    ctx.stroke();
  }
}

/** Friction: grippy = knurled crosshatch + sandpaper speckle, slippery = long glossy diagonal streaks. */
function surface(ctx, w, h, grip, r, unit) {
  const k = Math.max(0, (grip - 0.25) / 0.75); // grippiness of the pattern
  if (k > 0) {
    const step = unit * 0.16;
    ctx.lineWidth = Math.max(1, unit * 0.012);
    ctx.strokeStyle = `rgba(30,20,10,${0.08 + 0.22 * k})`;
    ctx.beginPath();
    for (let x = -h; x < w + h; x += step) {
      ctx.moveTo(x, 0); ctx.lineTo(x + h, h);
      ctx.moveTo(x + h, 0); ctx.lineTo(x, h);
    }
    ctx.stroke();
    const dots = Math.round((w * h) / (unit * unit) * 60 * k);
    for (let i = 0; i < dots; i++) {
      ctx.fillStyle = r() < 0.5 ? `rgba(0,0,0,${0.12 + 0.2 * k})` : `rgba(255,255,255,${0.1 + 0.15 * k})`;
      const s = unit * (0.01 + r() * 0.015);
      ctx.fillRect(r() * w, r() * h, s, s);
    }
  }
  const slick = Math.max(0, (0.6 - grip) / 0.6); // glossiness of the pattern
  if (slick > 0) {
    ctx.save();
    for (let i = 0; i < 3; i++) {
      const x = (i + 0.2 + r() * 0.6) * (w / 3);
      const bw = unit * (0.08 + r() * 0.12);
      const g = ctx.createLinearGradient(x - bw, 0, x + bw, 0);
      const a = 0.18 + 0.4 * slick;
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, `rgba(255,255,255,${a})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.setTransform(1, 0, -0.6, 1, h * 0.3, 0); // skewed streak
      ctx.fillRect(x - bw, 0, bw * 2, h);
    }
    ctx.restore();
  }
}

/** Fragility: jagged cracks running in from the edges, more and longer the more fragile the block. */
function cracks(ctx, w, h, strength, r, unit) {
  const n = 1 + Math.round(strength * 5);
  for (let i = 0; i < n; i++) {
    // start on a random edge, wander inwards
    const side = Math.floor(r() * 4);
    let x = side === 0 ? 0 : side === 1 ? w : r() * w;
    let y = side === 2 ? 0 : side === 3 ? h : r() * h;
    let ang = Math.atan2(h / 2 - y, w / 2 - x) + (r() - 0.5) * 1.2;
    const len = unit * (0.35 + 0.65 * strength) * (0.6 + r() * 0.6);
    const seg = unit * 0.07;
    const pts = [[x, y]];
    for (let d = 0; d < len; d += seg) {
      ang += (r() - 0.5) * 1.1;
      x += Math.cos(ang) * seg; y += Math.sin(ang) * seg;
      pts.push([x, y]);
    }
    // pale chipped rim (offset a touch) under a dark fissure
    const off = Math.max(1, unit * 0.01);
    for (const [col, lw, o] of [['rgba(255,240,220,0.45)', 0.035, off], ['rgba(25,8,4,0.85)', 0.018, 0]]) {
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1.5, unit * lw);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach(([px, py], j) => (j ? ctx.lineTo(px + o, py + o) : ctx.moveTo(px + o, py + o)));
      ctx.stroke();
    }
  }
}

function octagon(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 8 + (i * Math.PI) / 4;
    ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  ctx.closePath();
}

/** Red stop-sign badge with the worst CVSS score. Returns the width it occupies. */
function badge(ctx, cvss, h, unit) {
  const r = Math.min(h * 0.32, unit * 0.3), cx = r * 1.35, cy = h / 2;
  octagon(ctx, cx, cy, r);
  ctx.fillStyle = '#c1121f';
  ctx.fill();
  ctx.lineWidth = Math.max(2, r * 0.12);
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${r * 0.95}px ${FONT}`;
  ctx.fillText(cvss.toFixed(1), cx, cy + r * 0.05);
  return cx + r * 1.2;
}

/** Padlock in the right-hand end of the face. Returns the width it occupies. */
function padlock(ctx, w, h, ink, unit) {
  const s = Math.min(h * 0.42, unit * 0.32), cx = w - s * 1.1, cy = h / 2 + s * 0.15;
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = s * 0.16;
  ctx.beginPath();
  ctx.arc(cx, cy - s * 0.2, s * 0.32, Math.PI, 0);
  ctx.lineTo(cx + s * 0.32, cy);
  ctx.moveTo(cx - s * 0.32, cy);
  ctx.lineTo(cx - s * 0.32, cy - s * 0.2);
  ctx.stroke();
  ctx.fillRect(cx - s * 0.48, cy - s * 0.05, s * 0.96, s * 0.7);
  return s * 2.2;
}

function splitLines(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return [text];
  // try to break near the middle at a separator
  const seps = [];
  for (let i = 1; i < text.length - 1; i++) if ('-_/.: @'.includes(text[i])) seps.push(i + 1);
  if (!seps.length) return [text];
  const mid = text.length / 2;
  seps.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
  const k = seps[0];
  return [text.slice(0, k).trim(), text.slice(k).trim()];
}

/**
 * Paint one face. unit = canvas pixels per world unit of block height, so patterns have the same physical
 * scale on every face. Returns the canvas.
 */
export function paintFace({ w, h, look, text = '', sub = '', seed = 1, fontMax, unit = h, marks = true }) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const r = rng(seed);
  ctx.fillStyle = look.css;
  ctx.fillRect(0, 0, w, h);
  grain(ctx, w, h, r);
  surface(ctx, w, h, look.grip, r, unit);
  if (look.cracks > 0) cracks(ctx, w, h, look.cracks, r, unit);
  // lighter top edge / darker bottom edge for a toy look
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(255,255,255,0.2)');
  g.addColorStop(0.5, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // sketchy border; locked blocks get a dashed one
  ctx.strokeStyle = look.ink === PAPER_INK ? 'rgba(255,248,236,0.55)' : 'rgba(43,33,24,0.55)';
  ctx.lineWidth = Math.max(2, h * 0.04);
  if (look.locked) ctx.setLineDash([h * 0.12, h * 0.08]);
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
  ctx.setLineDash([]);

  let left = 0, right = 0;
  if (marks && look.vuln) left = badge(ctx, look.cvss, h, unit);
  if (marks && look.locked) right = padlock(ctx, w, h, look.ink, unit);

  if (text) {
    const maxW = (w - left - right) * 0.88;
    const subH = sub ? h * 0.2 : 0;
    const availH = h * 0.8 - subH;
    let size = Math.min(fontMax ?? h * 0.62, availH);
    let lines;
    for (;;) {
      ctx.font = `${size}px ${FONT}`;
      lines = splitLines(ctx, text, maxW);
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const tooTall = lines.length * size * 1.02 > availH;
      if ((widest <= maxW && !tooTall) || size < 9) break;
      size *= 0.92;
    }
    ctx.fillStyle = look.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const blockH = lines.length * size * 1.02;
    const cy = h / 2 - subH / 2;
    const mx = left + (w - left - right) / 2;
    lines.forEach((l, i) => ctx.fillText(l, mx, cy - blockH / 2 + size * 1.02 * (i + 0.5)));
    if (sub) {
      ctx.font = `${h * 0.17}px ${FONT}`;
      ctx.globalAlpha = 0.7;
      ctx.fillText(sub, mx, h - h * 0.14);
      ctx.globalAlpha = 1;
    }
  }
  return c;
}

function toTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** A small swatch (data URL) for the HTML legend, drawn with the same code as the blocks. */
export function swatchURL(look, w = 84, h = 48) {
  return paintFace({ w, h, look, seed: 7, unit: h * 1.3 }).toDataURL();
}

/**
 * Texture a BoxGeometry(L, H, w) (L along local x) with ONE canvas atlas holding its long, end and top faces, and
 * remap the box's UVs onto it, so the block renders with a single material (one draw call instead of six).
 * res scales the texture resolution down for very big towers (1 = full). Returns {material, texture}.
 */
export function skinBlock(geo, dep, look, L, H, w, res = 1) {
  const seed = look.seed;
  const name = String(dep.name);
  const sub = dep.version ? `${dep.version}` : '';
  const hLong = Math.round(96 * res), unit = hLong / H;
  const wLong = Math.min(Math.round(1024 * res), Math.round(unit * L));
  const long = paintFace({ w: wLong, h: hLong, look, text: name, sub, seed, unit: wLong / L });
  const hEnd = hLong;
  const wEnd = Math.max(Math.round(48 * res), Math.round((hEnd * w) / H));
  const end = paintFace({ w: wEnd, h: hEnd, look, text: name, seed: seed + 1, fontMax: hEnd * 0.5, unit });
  // the top is mostly hidden under the next layer: surface and cracks only
  const tw = Math.min(Math.round(512 * res), Math.round(unit * L * 0.6)), th = Math.max(24, Math.round(unit * w * 0.6));
  const top = paintFace({ w: tw, h: th, look, seed: seed + 2, unit: unit * 0.6, marks: false });

  // atlas: long face on the first row, end + top faces on the second (1px gutters against bleeding)
  const W = Math.max(wLong, wEnd + 1 + tw), Hh = hLong + 1 + Math.max(hEnd, th);
  const atlas = document.createElement('canvas');
  atlas.width = W;
  atlas.height = Hh;
  const ctx = atlas.getContext('2d');
  ctx.fillStyle = look.css;
  ctx.fillRect(0, 0, W, Hh);
  const rects = { long: [0, 0, wLong, hLong], end: [0, hLong + 1, wEnd, hEnd], top: [wEnd + 1, hLong + 1, tw, th] };
  ctx.drawImage(long, 0, 0);
  ctx.drawImage(end, rects.end[0], rects.end[1]);
  ctx.drawImage(top, rects.top[0], rects.top[1]);

  // BoxGeometry face order: +x, -x, +y, -y, +z, -z (4 vertices each); canvas y runs down, texture v runs up
  const faceRect = [rects.end, rects.end, rects.top, rects.top, rects.long, rects.long];
  const uv = geo.attributes.uv;
  for (let f = 0; f < 6; f++) {
    const [x0, y0, rw, rh] = faceRect[f];
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, (x0 + uv.getX(i) * rw) / W, 1 - (y0 + (1 - uv.getY(i)) * rh) / Hh);
    }
  }
  uv.needsUpdate = true;
  geo.clearGroups();
  const texture = toTexture(atlas);
  // MeshStandardMaterial: the slippery gloss comes from low roughness plus the painted streaks (no clearcoat pass)
  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: look.roughness, metalness: 0 });
  return { material, texture };
}
