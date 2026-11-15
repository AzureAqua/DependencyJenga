// fragility.js - fragile blocks (repos with lots of open issues + PRs) pop when they are hit too hard.
// No three.js here so it can be exercised headless against Rapier.
//
// "Hit too hard" is measured the way you'd judge it for a glass: the g-force the block itself experiences.
// Each physics step the tracker takes the change in the block's velocity (linear, plus spin at its ends),
// removes what gravity accounts for, and pops the block if what is left exceeds what its fragility allows.
// A knock from a block being dragged into it, something landing on it or being slammed by a shaking neighbour
// all show up; the steady weight resting on it never does, however heavy. (Rapier's contact-force events were
// tried first, but they miss most of an impact.)

export const MIN_FRAGILITY = 0.08; // below this a block never pops
// g-force a block survives, from barely fragile -> most fragile. Tuned in a headless sim of the demo tower: careful
// pulls never pop anything; a block dragged into a fragile one at ~2 units/s pops the most fragile, at ~4 units/s
// the middling ones; an exploit wave's knocks can pop a very fragile block right next to a shaking one.
const SURVIVES_G = [60, 12];

/** g-force a block of this fragility (0..1) survives, or null if it never pops. */
export function popLimit(fragility) {
  if (!(fragility >= MIN_FRAGILITY)) return null;
  const f = (fragility - MIN_FRAGILITY) / (1 - MIN_FRAGILITY);
  return SURVIVES_G[0] + (SURVIVES_G[1] - SURVIVES_G[0]) * f;
}

export class PopTracker {
  /** blocks: [{body, L, fragility, removed}]. A block with `exempt` set (e.g. the one in hand) is not checked. */
  constructor(blocks, { gravity = 18, dt = 1 / 120 } = {}) {
    this.g = Math.abs(gravity);
    this.dt = dt;
    this.tracked = [];
    for (const block of blocks) {
      const limit = popLimit(block.fragility);
      if (limit != null) this.tracked.push({ block, limit, v: null, w: null, peak: 0 });
    }
  }

  /** Forget velocity history (call after anything that teleports or retypes bodies). */
  reset() {
    for (const s of this.tracked) s.v = s.w = null;
  }

  /** Call right after each world.step(). Returns the blocks that pop this step. */
  update() {
    const out = [];
    const { g, dt } = this;
    for (const s of this.tracked) {
      const b = s.block;
      if (b.removed) continue;
      const body = b.body;
      const v = body.linvel(), w = body.angvel();
      if (s.v && !b.exempt && !body.isKinematic() && !body.isSleeping()) {
        const ax = (v.x - s.v.x) / dt, ay = (v.y - s.v.y) / dt + g, az = (v.z - s.v.z) / dt;
        const lin = Math.hypot(ax, ay, az);
        const ang = (Math.hypot(w.x - s.w.x, w.y - s.w.y, w.z - s.w.z) / dt) * (b.L / 2);
        const gs = Math.max(lin, ang) / g;
        s.peak = Math.max(s.peak, gs / s.limit);
        if (gs > s.limit) { out.push(b); continue; }
      }
      s.v = { x: v.x, y: v.y, z: v.z };
      s.w = { x: w.x, y: w.y, z: w.z };
    }
    return out;
  }
}
