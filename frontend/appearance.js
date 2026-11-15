// appearance.js - every gameplay property of a block, made visible. One channel per property:
//
//   hue          known vulnerabilities: cool blue = none; yellow -> orange -> red as the worst CVSS score rises.
//                Vulnerable blocks also show their score on every face and smoulder (a red glow that pulses
//                faster when the next exploit wave is one turn away).
//   lightness    weight (density): pale = light, dark = heavy.
//   texture      friction: matte and knurled = grippy; glossy and streaked = slippery.
//   cracks       fragility (open issues + PRs): more and longer cracks = pops from a smaller knock.
//   size         bundle size is the block's real width.
//   padlock      a locked row (can't be pulled).
//   cream/gold   the analysed project itself.
//
// Kind and ecosystem are deliberately not encoded: they don't change how a block behaves.
import { quakeStrength } from './quake.js';
import { MIN_FRAGILITY } from './fragility.js';

export const INK = '#2b2118';
export const PAPER_INK = '#fff8ec';
const SAFE_HUE = [196, 222]; // small per-block jitter so neighbours stay distinguishable
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---- words for the same properties, shown next to the numbers in the UI
const band = (v, words) => words[Math.min(words.length - 1, Math.max(0, Math.floor((v ?? 0.5) * words.length)))];
/** Weight level 0..1 (relative to this tower) -> word. */
export const weightWord = (level) => band(level, ['very light', 'light', 'medium', 'heavy', 'very heavy']);
/** Friction level 0..1 -> word. */
export const gripWord = (level) => band(level, ['very slippery', 'slippery', 'average grip', 'grippy', 'very grippy']);
/** Fragility level 0..1 -> word. */
export function fragilityWord(level) {
  if (!(level >= MIN_FRAGILITY)) return 'sturdy';
  return band((level - MIN_FRAGILITY) / (1 - MIN_FRAGILITY), ['a little fragile', 'fragile', 'very fragile', 'glass']);
}

/** Hue for a CVSS score: 2 -> yellow (52), 6 -> orange (26), 10 -> red (0). */
export function vulnHue(cvss) {
  return 52 * (1 - clamp01(((cvss ?? 5) - 2) / 8));
}

/**
 * {weight, grip, fragility} are physics levels 0..1 (phys.<prop>.level), cvss is the worst score or null.
 * Returns everything textures.js and game.js need to draw the block.
 */
export function lookFor({ id = '', weight = 0.5, grip = 0.5, fragility = 0, cvss = null, locked = false, cap = false }) {
  const seed = hash(String(id));
  if (cap) {
    return { cap: true, css: 'hsl(44, 90%, 88%)', ink: INK, weight: 0.3, grip: 0.75, cvss: null, vuln: false,
      strength: 0, cracks: 0, locked: true, roughness: 0.6, clearcoat: 0.3, seed };
  }
  const vuln = cvss != null;
  const hue = vuln ? vulnHue(cvss) : SAFE_HUE[0] + ((seed % 1000) / 1000) * (SAFE_HUE[1] - SAFE_HUE[0]);
  // saturation is fixed (it encodes nothing); vulnerable blocks use a stronger one and a narrower, never-pastel
  // lightness range so the warning hue stays loud on light blocks
  const sat = vuln ? 0.75 : 0.45;
  const light = vuln ? 0.72 - 0.4 * weight : 0.84 - 0.52 * weight;
  const cracks = fragility >= MIN_FRAGILITY ? (fragility - MIN_FRAGILITY) / (1 - MIN_FRAGILITY) : 0;
  return {
    cap: false, hue, sat, light, css: `hsl(${hue.toFixed(0)}, ${(sat * 100).toFixed(0)}%, ${(light * 100).toFixed(0)}%)`,
    ink: light < 0.52 ? PAPER_INK : INK, weight, grip, cvss, vuln, strength: vuln ? quakeStrength(cvss) : 0, cracks, locked,
    roughness: 0.22 + 0.73 * grip, clearcoat: clamp01(1 - grip * 1.4), seed,
  };
}
