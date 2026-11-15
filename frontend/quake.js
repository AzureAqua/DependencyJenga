// quake.js - "exploits": after every turn, blocks with known vulnerabilities vibrate. Nothing shakes for the first
// couple of rounds; then it starts faint and grows every round - every player's wave in a round is equally strong,
// so nobody gets the easier ones - and is harder for a higher CVSS score.
// No three.js here so the motion can be exercised headless against Rapier.
//
// While a wave lasts, each shaking block is driven kinematically and shakes in every direction: along its
// length, across its width (knocking its neighbours) and up and down, each at a different frequency so the
// direction of the shake keeps sweeping round, plus a yaw wobble. It also walks steadily out of the tower along
// its length (the only way out - walking sideways would just shove the whole row). Being kinematic it can't be
// pinned by the load above it, so it shakes visibly wherever it sits and drags the blocks touching it along
// through friction. Vertically it never dips below its resting height: driven into the block beneath, a
// kinematic body would push with unlimited force and blow the tower apart. Each block keeps its walking
// direction across waves, so the damage accumulates. Afterwards it becomes an ordinary dynamic body again.

export const QUAKE_TIME = 2.0; // seconds of shaking per wave
// Wave intensity: 0 before the start round; FIRST_INTENSITY in it, then rising to 1 (the "full strength" the
// amplitudes below describe) RAMP_ROUNDS later, and on up to MAX_INTENSITY. `pace` stretches or squeezes the ramp.
export const DEFAULT_EXPLOITS = { enabled: true, startRound: 3, pace: 1 };
const FIRST_INTENSITY = 0.1; // playtested: x0.06 was imperceptible, x0.17 already clearly noticeable
const RAMP_ROUNDS = 5;
const RAMP_POWER = 1.3;
const MAX_INTENSITY = 3;
const FREQ = 4.5; // Hz
// Scaled for Rapier 0.21, whose solver transmits a kinematic shake far more strongly than 0.12 did: at these values
// an intact demo tower survives two full-strength waves and simulated games end around turn 14, as before.
const AMP = 0.016; // shake amplitude (units) along the block at full strength
const ACROSS = 0.008; // shake amplitude across the block (with the yaw wobble, enough to knock its neighbours)
const BOB = 0.008; // vertical rattle (units, peak to peak) at full strength, between resting height and above
const DRIFT = 0.02; // walking speed (units/s) along the block at full strength
const TWIST = 0.014; // yaw wobble (rad) at full strength; swings the corners into the neighbours
const RAMP = 0.3; // seconds to fade the shaking in and out
const DEFAULT_CVSS = 5; // advisories without a usable score still shake a bit

/** Highest CVSS score among a dependency's known vulnerabilities (null when it has none). */
export function maxCvss(dep) {
  const v = Array.isArray(dep?.vulns) ? dep.vulns : [];
  if (!v.length) return null;
  const scores = v.map((x) => x.cvss).filter((s) => typeof s === 'number' && isFinite(s));
  return scores.length ? Math.max(...scores) : DEFAULT_CVSS;
}

/** 0..1: CVSS 10 -> 1, 9.8 -> 0.97, 7.5 -> 0.65, 5 -> 0.35, 3 -> 0.16. */
export function quakeStrength(cvss) {
  return Math.min(1, Math.max(0, (cvss ?? DEFAULT_CVSS) / 10)) ** 1.5;
}

/** Round (1-based) that turn n (1-based) belongs to. */
export function roundOf(turn, players = 2) {
  return Math.ceil(turn / Math.max(1, players));
}

/** Intensity of the waves in round r (1-based). opts: {startRound, pace} (see DEFAULT_EXPLOITS). */
export function waveIntensity(round, { startRound = DEFAULT_EXPLOITS.startRound, pace = DEFAULT_EXPLOITS.pace } = {}) {
  if (round < startRound) return 0;
  const k = ((round - startRound) * pace) / RAMP_ROUNDS;
  return Math.min(MAX_INTENSITY, FIRST_INTENSITY + (1 - FIRST_INTENSITY) * k ** RAMP_POWER);
}

/** Words for an intensity, for the HUD. */
export function intensityLabel(i) {
  if (i <= 0) return 'none';
  if (i < 0.18) return 'faint';
  if (i < 0.35) return 'a tremor';
  if (i < 0.65) return 'noticeable';
  if (i < 1.1) return 'strong';
  if (i < 1.8) return 'violent';
  return 'catastrophic';
}

/**
 * Start a wave. blocks: [{body, cvss, removed}]; BodyType: RAPIER.RigidBodyType; intensity: waveIntensity(round).
 * A walking direction is stored on the block (quakeDir) the first time it shakes.
 */
export function beginQuake(blocks, BodyType, intensity = 1, rnd = Math.random) {
  return blocks.filter((b) => !b.removed).map((block) => {
    const body = block.body;
    block.quakeDir ??= rnd() < 0.5 ? -1 : 1;
    const p0 = { ...body.translation() }, q0 = { ...body.rotation() };
    // long axis (local +x) at the start, flattened to the horizontal
    let ax = 1 - 2 * (q0.y * q0.y + q0.z * q0.z), az = 2 * (q0.x * q0.z - q0.w * q0.y);
    const n = Math.hypot(ax, az) || 1;
    ax /= n; az /= n;
    body.setBodyType(BodyType.KinematicPositionBased, true);
    const ph = () => rnd() * Math.PI * 2;
    return { block, s: quakeStrength(block.cvss) * intensity, phase: ph(), phase2: ph(), phase3: ph(), p0, q0, ax, az, walk: 0 };
  });
}

/** Move the shaking blocks for time t (s) since the wave began; dt = physics step. Call once per step. */
export function applyQuake(quakers, t, dt) {
  const env = Math.max(0, Math.min(1, t / RAMP, (QUAKE_TIME - t) / RAMP));
  const w = 2 * Math.PI * FREQ;
  for (const q of quakers) {
    if (q.block.removed) continue;
    const k = q.s * env, ph = w * t + q.phase;
    q.walk += DRIFT * k * dt;
    const along = AMP * k * Math.sin(ph) + q.walk * q.block.quakeDir;
    const across = ACROSS * k * Math.sin(1.37 * w * t + q.phase2); // (-az, ax) is horizontal, across the block
    const lift = (BOB * k * (1 - Math.cos(1.81 * w * t + q.phase3))) / 2;
    q.block.body.setNextKinematicTranslation({
      x: q.p0.x + q.ax * along - q.az * across, y: q.p0.y + lift, z: q.p0.z + q.az * along + q.ax * across,
    });
    // yaw wobble: rotate the start orientation about world Y
    const a = (TWIST * k * Math.sin(1.3 * ph)) / 2, sy = Math.sin(a), cw = Math.cos(a), r = q.q0;
    q.block.body.setNextKinematicRotation({
      x: cw * r.x + sy * r.z, y: cw * r.y + sy * r.w, z: cw * r.z - sy * r.x, w: cw * r.w - sy * r.y,
    });
  }
}

/** End a wave: the blocks become dynamic again, at rest where they are. */
export function stopQuake(quakers, BodyType) {
  for (const { block } of quakers) {
    if (block.removed) continue;
    const body = block.body;
    body.setBodyType(BodyType.Dynamic, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
}
