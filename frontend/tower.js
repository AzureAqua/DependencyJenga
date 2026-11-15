// tower.js - choosing which dependencies become blocks, ordering them and laying out layers.

export const TOWER_WIDTH = 3.6; // also the length of every block
export const BLOCK_GAP = 0.03; // gap between blocks inside a layer
export const LAYER_GAP = 0.003; // vertical gap between layers
export const HEIGHT_RANGE = [0.5, 0.8]; // layer height range (driven by avg width-t of the layer)
export const MAX_PER_LAYER = 5; // uniform-column fallback only
export const S_MIN = 2.4; // narrowest tier footprint (waist)
export const S_MAX = 7; // widest tier footprint for a small tower; grows with the tower (see footprintCap)
export const S_CEIL = 16; // absolute limit on the footprint, however big the tower
export const SUPPORT = 0.45; // a tier is at least this fraction of the widest tier above it
export const SLENDER = 5; // ...and at least 1/SLENDER of the tower height resting on it
export const TOWER_ASPECT = 2; // target height / width of a big tower, used to derive its footprint cap
export const OVERHANG_MAX = 1.5; // a layer's block length may be at most this x the across-span of the layer below
export const MAX_PER_ROW = 7; // blocks per physical layer in a wide tier
export const CAP_HEIGHT = 0.9; // the analysed project's own block, crowning the tower
export const CAP_MAX_WIDTH = 2;

const KIND_RANK = {
  language: 0, runtime: 1, system: 2, package_manager: 3, build_tool: 4, container: 5, ci: 6, package: 7,
};
const rank = (d) => KIND_RANK[d.kind] ?? 7;
const n = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

function byDependents(a, b) {
  return (
    n(b.metrics?.dependents_in_tree) - n(a.metrics?.dependents_in_tree) ||
    n(b.metrics?.global_dependents) - n(a.metrics?.global_dependents) ||
    n(b.metrics?.import_count) - n(a.metrics?.import_count) ||
    String(a.name).localeCompare(String(b.name))
  );
}

/** Pick at most `limit` deps: all non-packages, then direct deps, then top transitives by dependents. */
export function selectDependencies(deps, limit) {
  if (deps.length <= limit) return deps.slice();
  const nonPkg = deps.filter((d) => d.kind !== 'package').sort((a, b) => rank(a) - rank(b) || byDependents(a, b));
  const direct = deps.filter((d) => d.kind === 'package' && d.direct).sort(byDependents);
  const trans = deps.filter((d) => d.kind === 'package' && !d.direct).sort(byDependents);
  return [...nonPkg, ...direct, ...trans].slice(0, limit);
}

/** Bottom -> top ordering (xkcd style: foundations first, leaves last). */
export function orderDependencies(items) {
  return items.slice().sort((a, b) => rank(a.dep) - rank(b.dep) || byDependents(a.dep, b.dep));
}

/**
 * Longest-path layering on `depends_on` restricted to the selected items.
 * Returns {levelOf: Map(id -> level), count} (level 0 = depends on nothing in the set),
 * or null when no item has an in-set edge (=> caller falls back to the uniform column).
 * Edges to ids outside the set are ignored; cycles are broken by ignoring back-edges.
 */
export function assignLevels(items) {
  const ids = new Set(items.map((it) => it.dep.id));
  const deps = new Map(items.map((it) => [it.dep.id, (Array.isArray(it.dep.depends_on) ? it.dep.depends_on : []).filter((x) => ids.has(x) && x !== it.dep.id)]));
  if (![...deps.values()].some((a) => a.length)) return null;
  const level = new Map();
  const state = new Map(); // 1 = on stack, 2 = done
  const visit = (id) => {
    state.set(id, 1);
    let lv = 0;
    for (const d of deps.get(id)) {
      const st = state.get(d);
      if (st === 1) continue; // back-edge: ignore
      if (st !== 2) visit(d);
      lv = Math.max(lv, level.get(d) + 1);
    }
    level.set(id, lv);
    state.set(id, 2);
  };
  for (const it of items) if (!state.has(it.dep.id)) visit(it.dep.id);
  // compress empty levels (cannot happen with longest-path, kept for safety)
  const used = [...new Set(level.values())].sort((a, b) => a - b);
  const remap = new Map(used.map((v, i) => [v, i]));
  for (const [k, v] of level) level.set(k, remap.get(v));
  return { levelOf: level, count: used.length };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Greedy row packer: take blocks from items[i..] that fit a span of U. Returns the row and its widths. */
function packRow(items, i, U, maxPer, minSpan = S_MIN) {
  const usable = (k) => U - BLOCK_GAP * (k - 1);
  const row = [items[i]];
  let sum = items[i].phys.width.value;
  let j = i + 1;
  while (j < items.length && row.length < maxPer) {
    const newSum = sum + items[j].phys.width.value;
    const uNew = usable(row.length + 1);
    if (!(newSum <= uNew * 1.12 || Math.abs(newSum - uNew) < Math.abs(sum - usable(row.length)))) break;
    row.push(items[j]);
    sum = newSum;
    j++;
  }
  const k = row.length;
  const sFull = usable(k) / sum;
  const sMin = (Math.min(U, minSpan) - BLOCK_GAP * (k - 1)) / sum; // never thinner than the waist / the support it owes
  const s = Math.min(sFull, Math.max(Math.min(sFull, 1.5), sMin)); // sparse rows stay partial (centred)
  const widths = row.map((it) => it.phys.width.value * s);
  const span = widths.reduce((a, b) => a + b, 0) + BLOCK_GAP * (k - 1);
  return { row, widths, span, next: j };
}

function finishLayer(layers, y, axis, length, span, level, row, widths, fixedHeight) {
  const k = row.length;
  let cursor = -span / 2;
  const avgT = row.reduce((a, it) => a + it.phys.width.t, 0) / k;
  const height = fixedHeight ?? HEIGHT_RANGE[0] + (HEIGHT_RANGE[1] - HEIGHT_RANGE[0]) * avgT;
  const blocks = row.map((it, bi) => {
    const w = widths[bi];
    const c = cursor + w / 2;
    cursor += w + BLOCK_GAP;
    return { dep: it.dep, phys: it.phys, w, c, length };
  });
  layers.push({ index: layers.length, axis, height, y: y + height / 2, length, span, level, blocks });
  return y + height + LAYER_GAP;
}

/**
 * The analysed project as one block on top of everything (xkcd 2347's "all modern digital infrastructure").
 * cap: {dep, phys}; phys.width is ignored - the block is sized to sit safely on the layer below.
 */
function capLayer(layers, y, cap) {
  const prev = layers[layers.length - 1];
  const L = prev ? Math.min(OVERHANG_MAX * prev.span, Math.max(prev.length, S_MIN)) : TOWER_WIDTH;
  const w = prev ? Math.min(prev.length, CAP_MAX_WIDTH) : CAP_MAX_WIDTH;
  y = finishLayer(layers, y, layers.length % 2 === 0 ? 'x' : 'z', L, w, null, [cap], [w], CAP_HEIGHT);
  layers[layers.length - 1].cap = true;
  return y;
}

/** Old layout: every block TOWER_WIDTH long, layers packed by kind order (used when there is no dependency graph). */
function uniformLayout(items, cap, W = TOWER_WIDTH) {
  const layers = [];
  let y = LAYER_GAP;
  let i = 0;
  while (i < items.length) {
    const r = packRow(items, i, W, MAX_PER_LAYER);
    y = finishLayer(layers, y, layers.length % 2 === 0 ? 'x' : 'z', W, r.span, null, r.row, r.widths);
    i = r.next;
  }
  if (cap) y = capLayer(layers, y, cap);
  return { width: W, layers, totalHeight: y, mode: 'uniform', levelCount: 0 };
}

/**
 * items: [{dep, phys}] already ordered bottom->top. phys.width.value drives block width.
 * opts.mergeSingletons: fold single-block levels into the level below (stability fallback).
 * opts.capstone: {dep, phys} placed alone as the top layer (flagged layer.cap) - the analysed project itself.
 * Returns {width (max block length), mode, levelCount, totalHeight,
 *          layers:[{index, axis, height, y, length, span, level, blocks:[{dep, phys, w, c, length}]}]}
 *   axis 'x' => block length runs along X, blocks are arranged along Z (c = z centre)
 *   axis 'z' => block length runs along Z, blocks are arranged along X (c = x centre)
 * Depth mode: one tier per dependency level (level 0 at the bottom), tier side S ~ sqrt(sumWidths*TOWER_WIDTH),
 * capped at a footprint that grows with the tower (S_MAX..S_CEIL); oversized tiers are scaled down together.
 * Consecutive physical layers satisfy: span(upper) <= length(lower) and length(upper) <= OVERHANG_MAX * span(lower).
 */
export function buildLayout(items, opts = {}) {
  const lv = assignLevels(items);
  if (!lv) return uniformLayout(items, opts.capstone);
  let tiers = [];
  for (let l = 0; l < lv.count; l++) tiers.push({ level: l, items: items.filter((it) => lv.levelOf.get(it.dep.id) === l) });
  if (opts.mergeSingletons) {
    const merged = [];
    for (const t of tiers) {
      if (merged.length && t.items.length === 1) merged[merged.length - 1].items.push(...t.items);
      else merged.push(t);
    }
    tiers = merged;
  }
  const layers = [];
  let y = LAYER_GAP;
  let prev = null; // {L, A} of the layer below
  let maxL = S_MIN;
  // Footprint cap grows with the tower: a side-S row holds ~S of block width, so a tower of total width
  // `total` capped at S is ~avgHeight*total/S tall; solve for height = TOWER_ASPECT * S.
  for (const t of tiers) t.raw = Math.sqrt(t.items.reduce((a, it) => a + it.phys.width.value, 0) * TOWER_WIDTH);
  const total = tiers.reduce((a, t) => a + (t.raw * t.raw) / TOWER_WIDTH, 0);
  const avgH = (HEIGHT_RANGE[0] + HEIGHT_RANGE[1]) / 2;
  const cap = clamp(Math.sqrt((avgH * total) / TOWER_ASPECT), S_MAX, S_CEIL);
  // If the biggest tier still exceeds the cap, shrink every tier by the same factor so they keep their proportions.
  const scale = Math.min(1, cap / Math.max(...tiers.map((t) => t.raw)));
  // Support, worked out from the top down: a tier must be at least SUPPORT x the widest tier above it and
  // at least (height above) / SLENDER wide, or a heavy tower ends up balanced on a narrow waist.
  let widestAbove = 0, heightAbove = 0;
  for (let k = tiers.length - 1; k >= 0; k--) {
    const t = tiers[k];
    t.need = Math.min(cap, Math.max(S_MIN, SUPPORT * widestAbove, heightAbove / SLENDER));
    t.S = Math.max(clamp(t.raw * scale, S_MIN, cap), t.need);
    widestAbove = Math.max(widestAbove, t.S);
    heightAbove += avgH * Math.max(1, (t.raw * t.raw) / TOWER_WIDTH / t.S);
  }
  for (const t of tiers) {
    const S = t.S;
    const maxPer = Math.max(MAX_PER_ROW, Math.ceil(S / 1.1));
    let i = 0;
    while (i < t.items.length) {
      const L = prev ? Math.min(S, OVERHANG_MAX * prev.A) : S;
      const U = prev ? Math.min(S, prev.L) : S;
      const r = packRow(t.items, i, U, maxPer, t.need);
      y = finishLayer(layers, y, layers.length % 2 === 0 ? 'x' : 'z', L, r.span, t.level, r.row, r.widths);
      prev = { L, A: r.span };
      maxL = Math.max(maxL, L);
      i = r.next;
    }
  }
  if (opts.capstone) y = capLayer(layers, y, opts.capstone);
  return { width: maxL, layers, totalHeight: y, mode: 'depth', levelCount: tiers.length };
}
