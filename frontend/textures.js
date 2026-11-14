// textures.js - canvas textures with the dependency name written on the block faces.
import * as THREE from 'three';

export const INK = '#2b2118';
const FONT = '"Patrick Hand", "Comic Sans MS", "Segoe Print", "Marker Felt", cursive';

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function grain(ctx, w, h, seed) {
  const r = rng(seed);
  ctx.lineWidth = 1;
  for (let i = 0; i < Math.max(4, h / 7); i++) {
    const y = r() * h;
    ctx.strokeStyle = `rgba(80,50,20,${0.05 + r() * 0.07})`;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= w; x += w / 8) ctx.lineTo(x, y + (r() - 0.5) * 3);
    ctx.stroke();
  }
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

function drawFace({ w, h, color, text, sub, seed, fontMax }) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  grain(ctx, w, h, seed);
  // lighter top edge / darker bottom edge for a toy look
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(255,255,255,0.22)');
  g.addColorStop(0.5, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // sketchy border
  ctx.strokeStyle = 'rgba(43,33,24,0.55)';
  ctx.lineWidth = Math.max(2, h * 0.04);
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);

  if (text) {
    const maxW = w * 0.86;
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
    ctx.fillStyle = INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const blockH = lines.length * size * 1.02;
    const cy = h / 2 - subH / 2;
    lines.forEach((l, i) => ctx.fillText(l, w / 2, cy - blockH / 2 + size * 1.02 * (i + 0.5)));
    if (sub) {
      ctx.font = `${h * 0.17}px ${FONT}`;
      ctx.fillStyle = 'rgba(43,33,24,0.65)';
      ctx.fillText(sub, w / 2, h - h * 0.14);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Returns {materials:[+x,-x,+y,-y,+z,-z], textures:[...]} for a box of (L x H x w), L along local x. */
export function makeBlockMaterials(dep, color, L, H, w) {
  const seed = hash(dep.id || dep.name);
  { // slight per-block lightness jitter so same-coloured blocks stay distinguishable
    const c = new THREE.Color(color);
    c.offsetHSL((((seed >>> 8) % 1000) / 1000 - 0.5) * 0.05, 0, ((seed % 1000) / 1000 - 0.5) * 0.16);
    color = '#' + c.getHexString();
  }
  const name = String(dep.name);
  const sub = dep.version ? `${dep.version}` : '';
  const hLong = 96;
  const wLong = Math.min(1024, Math.round((hLong * L) / H));
  const long = drawFace({ w: wLong, h: hLong, color, text: name, sub, seed });
  const hEnd = 96;
  const wEnd = Math.max(48, Math.round((hEnd * w) / H));
  const end = drawFace({ w: wEnd, h: hEnd, color, text: name, sub: '', seed: seed + 1, fontMax: hEnd * 0.5 });
  const top = drawFace({ w: 128, h: 128, color, text: '', sub: '', seed: seed + 2 });
  const mk = (map) => new THREE.MeshStandardMaterial({ map, roughness: 0.78, metalness: 0.0 });
  const mLong = mk(long), mEnd = mk(end), mTop = mk(top);
  return { materials: [mEnd, mEnd, mTop, mTop, mLong, mLong], textures: [long, end, top] };
}
