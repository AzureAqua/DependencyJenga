// tower.js - choosing which dependencies become blocks, ordering them and laying out layers.

export const TOWER_WIDTH = 3.6; // also the length of every block
export const BLOCK_GAP = 0.03; // gap between blocks inside a layer
export const LAYER_GAP = 0.003; // vertical gap between layers
export const HEIGHT_RANGE = [0.5, 0.8]; // layer height range (driven by avg width-t of the layer)
export const MAX_PER_LAYER = 5;

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
 * items: [{dep, phys}] already ordered bottom->top. phys.width.value drives block width.
 * Returns {width, layers:[{index, axis, height, y, blocks:[{dep, phys, w, c}]}], totalHeight}
 *   axis 'x' => block length runs along X, blocks are arranged along Z (c = z centre)
 *   axis 'z' => block length runs along Z, blocks are arranged along X (c = x centre)
 */
export function buildLayout(items, W = TOWER_WIDTH) {
  const rows = [];
  let i = 0;
  const usable = (k) => W - BLOCK_GAP * (k - 1);
  while (i < items.length) {
    const row = [items[i]];
    let sum = items[i].phys.width.value;
    i++;
    while (i < items.length && row.length < MAX_PER_LAYER) {
      const next = items[i].phys.width.value;
      const newSum = sum + next;
      const uNew = usable(row.length + 1);
      const include = newSum <= uNew * 1.12 || Math.abs(newSum - uNew) < Math.abs(sum - usable(row.length));
      if (!include) break;
      row.push(items[i]);
      sum = newSum;
      i++;
    }
    rows.push({ row, sum });
  }

  const layers = [];
  let y = LAYER_GAP;
  rows.forEach(({ row, sum }, li) => {
    const k = row.length;
    let s = usable(k) / sum;
    s = Math.min(s, 1.5); // a sparse final layer is allowed to stay partial (centred)
    const widths = row.map((it) => it.phys.width.value * s);
    const total = widths.reduce((a, b) => a + b, 0) + BLOCK_GAP * (k - 1);
    let cursor = -total / 2;
    const avgT = row.reduce((a, it) => a + it.phys.width.t, 0) / k;
    const height = HEIGHT_RANGE[0] + (HEIGHT_RANGE[1] - HEIGHT_RANGE[0]) * avgT;
    const blocks = row.map((it, bi) => {
      const w = widths[bi];
      const c = cursor + w / 2;
      cursor += w + BLOCK_GAP;
      return { dep: it.dep, phys: it.phys, w, c };
    });
    layers.push({ index: li, axis: li % 2 === 0 ? 'x' : 'z', height, y: y + height / 2, blocks });
    y += height + LAYER_GAP;
  });
  return { width: W, layers, totalHeight: y };
}
