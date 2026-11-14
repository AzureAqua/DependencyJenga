// mapping.js - the ONE place where dependency metrics become physics.
//
// Each entry in MAPPINGS turns one (derived) metric into one physics property:
//
//   id        unique key
//   prop      physics property name written onto every block's `phys` object
//             (consumers: tower.js reads `width`; game.js reads `density`, `friction`,
//              and optionally `restitution`, `linearDamping`, `angularDamping`)
//   enabled   false => entry is ignored (kept as a ready-made example)
//   label     human name of the metric (UI legend)
//   source    (dep) => number|null   metric accessor (may combine several metrics)
//   scale     'log' | 'linear'       transform applied before normalising
//   clamp     [lowPct, highPct]      percentile clamp across the CURRENT dependency set
//                                    (falls back to min/max when the set is tiny)
//   range     [out0, out1]           output range: t=0 -> out0, t=1 -> out1
//   nullT     normalised position (0..1) used when the metric is missing (null)
//   legend    one-line explanation shown in the UI
//
// To add a new property: append ONE entry here and (if it is a brand new
// property name) read `phys.<prop>.value` where the body/collider is built in game.js.

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const log1p = (v) => Math.log1p(Math.max(0, v));

/** "Number of uses": imports in the analysed repo + deps in the tree that need it + global popularity. */
export function usesScore(d) {
  const m = d.metrics || {};
  const imp = num(m.import_count), dit = num(m.dependents_in_tree), gd = num(m.global_dependents);
  if (imp === null && dit === null && gd === null) return null;
  return 1.0 * log1p(imp ?? 0) + 1.5 * log1p(dit ?? 0) + 0.4 * log1p(gd ?? 0);
}

export const MAPPINGS = [
  {
    id: 'size',
    prop: 'width',
    enabled: true,
    label: 'Bundle size',
    target: 'block width',
    source: (d) => num(d.metrics?.size_bytes),
    scale: 'log',
    clamp: [5, 95],
    range: [0.7, 1.7], // world units (tower is 3.6 wide)
    nullT: 0.25,
    legend: 'Bigger bundle → wider block',
  },
  {
    id: 'uses',
    prop: 'density',
    enabled: true,
    label: 'Number of uses',
    target: 'weight (density)',
    source: usesScore, // already log-combined, so scale is 'linear'
    scale: 'linear',
    clamp: [5, 95],
    range: [0.5, 3.5],
    nullT: 0.35,
    legend: 'More uses (imports + dependents) → heavier block',
  },
  {
    id: 'commits',
    prop: 'friction',
    enabled: true,
    label: 'Recent commits (90d)',
    target: 'friction',
    source: (d) => num(d.metrics?.recent_commits),
    scale: 'log',
    clamp: [5, 95],
    range: [0.1, 0.75],
    nullT: 0.2,
    legend: 'Actively maintained → grippy; abandoned → slippery',
  },

  // ---- Examples for future properties (flip `enabled` to true to try them) ----
  // game.js already applies phys.restitution / phys.linearDamping / phys.angularDamping when present.
  {
    id: 'issues',
    prop: 'restitution',
    enabled: false,
    label: 'Open issues',
    target: 'bounciness',
    source: (d) => num(d.metrics?.open_issues),
    scale: 'log',
    clamp: [5, 95],
    range: [0.0, 0.3],
    nullT: 0,
    legend: 'More open issues → bouncier',
  },
  {
    id: 'age',
    prop: 'angularDamping',
    enabled: false,
    label: 'Project age',
    target: 'angular damping',
    source: (d) => num(d.metrics?.age_days),
    scale: 'log',
    clamp: [5, 95],
    range: [0.2, 3.0],
    nullT: 0.5,
    legend: 'Older project → harder to spin',
  },
];

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Normalise every enabled mapping across `deps`.
 * Returns array (parallel to deps) of { [prop]: {value, t, raw, missing, mappingId} }.
 */
export function computePhysics(deps, mappings = MAPPINGS) {
  const out = deps.map(() => ({}));
  for (const mp of mappings) {
    if (!mp.enabled) continue;
    const xf = (v) => (mp.scale === 'log' ? log1p(v) : v);
    const raws = deps.map((d) => mp.source(d));
    const xs = raws.map((r) => (r === null ? null : xf(r)));
    const sorted = xs.filter((x) => x !== null).sort((a, b) => a - b);
    let lo = 0, hi = 0;
    if (sorted.length >= 8) {
      lo = percentile(sorted, mp.clamp?.[0] ?? 0);
      hi = percentile(sorted, mp.clamp?.[1] ?? 100);
    } else if (sorted.length) {
      lo = sorted[0];
      hi = sorted[sorted.length - 1];
    }
    deps.forEach((d, i) => {
      const missing = xs[i] === null;
      let t;
      if (missing) t = mp.nullT ?? 0.5;
      else if (hi - lo < 1e-9) t = 0.5;
      else t = Math.min(1, Math.max(0, (xs[i] - lo) / (hi - lo)));
      const value = mp.range[0] + (mp.range[1] - mp.range[0]) * t;
      out[i][mp.prop] = { value, t, raw: raws[i], missing, mappingId: mp.id };
    });
  }
  return out;
}
