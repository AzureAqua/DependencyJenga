// game.js - three.js scene + Rapier physics + pulling interaction + turn/topple state machine.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLAYER_COLORS } from './theme.js';
import { lookFor } from './appearance.js';
import { PopTracker } from './fragility.js';
import { skinBlock } from './textures.js';
import { QUAKE_TIME, DEFAULT_EXPLOITS, maxCvss, roundOf, waveIntensity, beginQuake, applyQuake, stopQuake } from './quake.js';

const GRAVITY = -18;
const DT = 1 / 120; // physics step
const OMEGA = 14; // pull spring natural frequency (rad/s)
const ZETA = 0.9;
const PULL_SELF = 3; // max pull force = |g| * (PULL_SELF * own mass + PULL_LOAD * mass of the layers above)
const PULL_LOAD = 1.5;
const HELD_VMAX = 7, HELD_WMAX = 6; // speed limits for the block in hand (units/s, rad/s)
const BODY_VMAX = 30, BODY_WMAX = 25; // and for everything else
const REMOVE_FRACTION = 0.9; // block counts as taken once this fraction of its length is out
const STILL_TIME = 1.0; // seconds of calm before the turn passes
const SETTLE_CAP = 8; // hard cap (s) for the settling phase
const PLACE_HOVER = 0.6; // how far above the tower a block being put back on top floats

/** Rules a game can be configured with (see Game.configure). */
export const DEFAULT_RULES = {
  players: 2,
  lockedRows: 3, // the project block plus the rows just under it can't be touched
  exploits: { ...DEFAULT_EXPLOITS },
  fragile: true, // fragile blocks pop when hit too hard
  placeOnTop: false, // a pulled block must be put back on top of the tower, as in real Jenga
};

const SCENE_THEMES = {
  light: { bg: 0xf4eddc, table: 0xe9dcbb, rim: 0x3a2e22, sky: 0xfff6e6, ground: 0xb9a98a, hemi: 0.85, sun: 1.9 },
  dark: { bg: 0x1c1915, table: 0x3a3229, rim: 0x0d0b09, sky: 0xe6dccb, ground: 0x2e271f, hemi: 0.7, sun: 1.7 },
};

// Physics engine, loaded at startup: the SIMD build is several times faster; older browsers get the plain one.
let RAPIER = null;
let rapierReady = null;
// smallest wasm module using a SIMD instruction (same probe as wasm-feature-detect)
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
export function initPhysics() {
  if (!rapierReady) {
    rapierReady = (async () => {
      let simd = false;
      try { simd = WebAssembly.validate(SIMD_PROBE); } catch { /* no wasm SIMD */ }
      RAPIER = (await import(simd ? '@dimforge/rapier3d-simd-compat' : '@dimforge/rapier3d-compat')).default;
      await RAPIER.init();
      return { simd };
    })();
  }
  return rapierReady;
}

/** Graphics presets (see Game.setQuality). */
const QUALITY = {
  high: { dpr: 2, shadows: true, soft: true },
  balanced: { dpr: 1.5, shadows: true, soft: false },
  fast: { dpr: 1, shadows: false, soft: false },
};
const IDLE_FPS = 20; // while only the vulnerable blocks' glow is animating

export class Game {
  /** cb: onHover(block,x,y) onSelect(block) onHint(msg) onRemoved(block) onTurnEnd() onGameOver(info) onPullState(bool)
   *      onQuake(active, blocks, intensity) onPop(block, {turn}) onPlacing(active, block) */
  constructor(container, cb = {}) {
    this.container = container;
    this.cb = cb;
    this.rules = structuredClone(DEFAULT_RULES);
    this.placing = null; // {block, axis, x, z, top} while a pulled block is being put back on top
    this.state = 'empty'; // empty | idle | pulling | placing | settling | quaking | over
    this.quakers = [];
    this.turnsDone = 0; // completed turns: drives how hard the exploit wave after each turn shakes
    this.quakeIntensity = 0;
    this.quakeTime = 0;
    this.afterQuake = false;
    this.time = 0;
    this.lastRender = -1;
    this.dirty = true; // something visible changed: render this frame even if nothing moves
    this.quality = 'balanced';
    this._glow = new THREE.Color();
    this.pops = null; // PopTracker for fragile blocks
    this.shards = []; // flying debris of popped blocks
    this.turnPops = []; // blocks popped since the current turn began
    this.blocks = [];
    this.world = null;
    this.pull = null;
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q1 = new THREE.Quaternion();
    this.pending = null;
    this.hovered = null;
    this.selected = null;
    this.fading = [];
    this.acc = 0;
    this.playerIndex = 0;
    this.lastPulled = null;
    this.stillTime = 0;
    this.settleTime = 0;

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.balanced.dpr));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(r.domElement);
    r.domElement.style.touchAction = 'none';

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SCENE_THEMES.light.bg);
    this.scene.fog = new THREE.Fog(SCENE_THEMES.light.bg, 45, 110);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 300);
    this.camera.position.set(11, 8, 13);

    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 70;

    this.hemi = new THREE.HemisphereLight(0xfff6e6, 0xb9a98a, 0.85);
    this.scene.add(this.hemi);
    const sun = (this.sun = new THREE.DirectionalLight(0xffffff, 1.9));
    sun.position.set(9, 24, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -16; sc.right = 16; sc.top = 20; sc.bottom = -16; sc.near = 1; sc.far = 80;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun);

    // table
    const table = (this.table = new THREE.Mesh(
      new THREE.CylinderGeometry(14, 14.4, 0.5, 64),
      new THREE.MeshStandardMaterial({ color: 0xe9dcbb, roughness: 0.95 }),
    ));
    table.position.y = -0.25;
    table.receiveShadow = true;
    this.scene.add(table);
    const rim = (this.rim = new THREE.Mesh(
      new THREE.TorusGeometry(14.05, 0.06, 8, 96),
      new THREE.MeshBasicMaterial({ color: 0x3a2e22 }),
    ));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.001;
    this.scene.add(rim);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();

    this._onResize = () => this.resize();
    new ResizeObserver(this._onResize).observe(container);
    this.resize();
    this._bindPointer();
    this.clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Light or dark surroundings (the blocks themselves keep their colours: those carry gameplay meaning). */
  setTheme(dark) {
    const t = SCENE_THEMES[dark ? 'dark' : 'light'];
    this.scene.background.setHex(t.bg);
    this.scene.fog.color.setHex(t.bg);
    this.table.material.color.setHex(t.table);
    this.rim.material.color.setHex(t.rim);
    this.hemi.color.setHex(t.sky);
    this.hemi.groundColor.setHex(t.ground);
    this.hemi.intensity = t.hemi;
    this.sun.intensity = t.sun;
    this.dirty = true;
  }

  /** 'high' | 'balanced' | 'fast': render resolution and shadows. */
  setQuality(q) {
    const cfg = QUALITY[q] || QUALITY.balanced;
    this.quality = QUALITY[q] ? q : 'balanced';
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio, cfg.dpr));
    const type = cfg.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (r.shadowMap.enabled !== cfg.shadows || r.shadowMap.type !== type) {
      r.shadowMap.enabled = cfg.shadows;
      r.shadowMap.type = type;
      this.sun.castShadow = cfg.shadows;
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
      this.scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
    }
    this.resize();
  }

  /** Rules for the next loadTower (see DEFAULT_RULES); missing keys keep their defaults. */
  configure(rules = {}) {
    this.rules = { ...structuredClone(DEFAULT_RULES), ...rules, exploits: { ...DEFAULT_EXPLOITS, ...(rules.exploits || {}) } };
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  // ---------------------------------------------------------------- tower
  clearTower() {
    for (const b of this.blocks) this.disposeBlock(b);
    for (const f of this.fading) this.group.remove(f.block.mesh);
    this.fading = [];
    for (const sh of this.shards) this.disposeShards(sh);
    this.shards = [];
    this.pops = null;
    this.turnPops = [];
    this.placing = null;
    this.blocks = [];
    this.quakers = [];
    this.pull = null;
    this.pending = null;
    this.hovered = null;
    this.selected = null;
    if (this.world) this.world.free();
    this.world = null;
  }

  loadTower(layout, playerIndex = 0) {
    this.clearTower();
    this.layout = layout;
    this.W = layout.width;
    this.nLayers = layout.layers.length;
    this.playerIndex = playerIndex;
    this.lastPulled = null;
    const world = (this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 }));
    world.timestep = DT;
    // Rapier 0.21's solver holds even a ~500-block stack together at its default 4 iterations (tested headless)
    world.createCollider(RAPIER.ColliderDesc.cuboid(40, 0.5, 40).setTranslation(0, -0.5, 0).setFriction(0.9));

    const tBuild = performance.now();
    const nBlocks = layout.layers.reduce((a, l) => a + l.blocks.length, 0);
    const res = nBlocks > 300 ? 0.5 : nBlocks > 150 ? 0.75 : 1; // keep texture memory sane for huge towers
    for (const layer of layout.layers) {
      const odd = layer.axis === 'z';
      for (let bi = 0; bi < layer.blocks.length; bi++) {
        const it = layer.blocks[bi];
        const ph = it.phys;
        const H = layer.height, w = it.w, L = it.length ?? layer.length ?? layout.width;
        const x = odd ? it.c : 0, z = odd ? 0 : it.c;
        const rot = odd ? { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 } : { x: 0, y: 0, z: 0, w: 1 };
        const rb = world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(x, layer.y, z)
            .setRotation(rot)
            .setLinearDamping(0.05)
            .setAngularDamping(ph.angularDamping?.value ?? 0.6)
            .setCanSleep(true),
        );
        const cd = RAPIER.ColliderDesc.cuboid(L / 2, H / 2, w / 2)
          .setDensity(ph.density?.value ?? 1)
          .setFriction(ph.friction?.value ?? 0.5)
          .setRestitution(ph.restitution?.value ?? 0);
        const collider = world.createCollider(cd, rb);

        const cvss = maxCvss(it.dep);
        const fragility = layer.cap || !this.rules.fragile ? 0 : ph.fragility?.level ?? 0;
        const look = lookFor({
          id: it.dep.id || it.dep.name, weight: ph.density?.level, grip: ph.friction?.level, fragility, cvss,
          cap: !!layer.cap, locked: !!layer.cap || layer.index >= this.nLayers - this.rules.lockedRows,
        });
        // one texture atlas + one material per block = one draw call (a multi-material box costs six, plus shadows)
        const geo = new THREE.BoxGeometry(L, H, w);
        const { material, texture } = skinBlock(geo, it.dep, look, L, H, w, res);
        const mesh = new THREE.Mesh(geo, material);
        mesh.castShadow = mesh.receiveShadow = true;
        this.group.add(mesh);
        const block = {
          id: it.dep.id, dep: it.dep, phys: ph, layer: layer.index, index: bi,
          body: rb, collider, mesh, edges: null, matList: [material], textures: [texture],
          L, h: H, w, axis: layer.axis, level: layer.level ?? null, removed: false, bad: 0, locked: false,
          mass: rb.mass(), origin: null, color: look.css, look, cap: !!layer.cap, cvss, fragility, exempt: false,
        };
        mesh.userData.block = block;
        layer.blocks[bi].block = block;
        this.blocks.push(block);
      }
    }
    // Pre-settle the tower off-screen (at most ~6 s of simulated time). Once everything has been still for a moment
    // the bodies are put to sleep directly instead of waiting out Rapier's ~2 s sleep timer.
    const tSettle = performance.now();
    let steps = 0, calm = 0;
    for (; steps < 1200; steps++) {
      // ramp gravity in so the stack loads smoothly instead of ringing like a Newton's cradle
      if (steps <= 120) world.gravity = { x: 0, y: GRAVITY * Math.min(1, steps / 120), z: 0 };
      world.step();
      if (steps > 150 && steps % 10 === 0) {
        let vmax = 0;
        for (const b of this.blocks) {
          if (b.body.isSleeping()) continue;
          const v = b.body.linvel(), w = b.body.angvel();
          vmax = Math.max(vmax, Math.hypot(v.x, v.y, v.z), Math.hypot(w.x, w.y, w.z) * b.L * 0.5);
        }
        calm = vmax < 0.02 ? calm + 10 : 0;
        if (calm >= 40) { for (const b of this.blocks) b.body.sleep(); break; }
      }
    }
    const tDone = performance.now();
    this.syncMeshes(true);
    let maxDisp = 0, maxSpeed = 0, asleep = 0, minUp = 1;
    for (const b of this.blocks) {
      const t = b.body.translation();
      const li = layout.layers[b.layer];
      const ox = li.axis === 'z' ? li.blocks[b.index].c : 0, oz = li.axis === 'z' ? 0 : li.blocks[b.index].c;
      maxDisp = Math.max(maxDisp, Math.hypot(t.x - ox, t.z - oz)); // sideways only: a tall stack compresses a little
      const v = b.body.linvel();
      maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z));
      if (b.body.isSleeping()) asleep++;
      const q = b.body.rotation();
      minUp = Math.min(minUp, 1 - 2 * (q.x * q.x + q.z * q.z));
      b.origin = { x: t.x, y: t.y, z: t.z };
    }
    const stable = asleep === this.blocks.length && maxDisp < 0.7 && minUp > 0.95;
    this.settleReport = {
      maxDisp, maxSpeed, asleep, total: this.blocks.length, minUp, stable, layers: this.nLayers, mode: layout.mode,
      steps, buildMs: Math.round(tSettle - tBuild), settleMs: Math.round(tDone - tSettle),
    };
    this.pops = new PopTracker(this.blocks, { gravity: GRAVITY, dt: DT });
    this.frameTower();
    this.state = 'idle';
    this.turnBlock = null;
    this.stillTime = 0;
    this.acc = 0;
    this.turnsDone = 0;
    this.afterQuake = false;
    this.dirty = true;
    if (!this.hasLegalMove()) this._draw();
    return this.settleReport;
  }

  _draw() {
    this.state = 'over';
    this.releasePull(true);
    this.controls.enabled = true;
    this.cb.onGameOver?.({ draw: true });
  }

  frameTower() {
    const H = this.layout.totalHeight;
    const aspect = this.camera.aspect || 1.5;
    const fit = (H * 0.58 + 2.5) / Math.tan((this.camera.fov * Math.PI) / 360); // fit height
    const dist = Math.max(14, fit, (this.W * 2.5) / Math.min(1, aspect) / Math.tan((this.camera.fov * Math.PI) / 360) * 0.6);
    this.controls.target.set(0, H * 0.45, 0);
    this.camera.position.set(dist * 0.62, H * 0.45 + dist * 0.28, dist * 0.78);
    this.controls.update();
    const sc = this.sun.shadow.camera;
    const R = Math.max(16, this.W * 2.2 + 6);
    sc.left = -R; sc.right = R; sc.bottom = -R;
    sc.top = Math.max(20, H + 6, R);
    sc.updateProjectionMatrix();
    this.sun.position.set(9, H + 14, 12);
  }

  /** Copy body poses to the meshes (sleeping bodies don't move, so they are skipped). Returns how many moved. */
  syncMeshes(all = false) {
    let moved = 0;
    for (const b of this.blocks) {
      if (b.removed || (!all && b.body.isSleeping())) continue;
      const t = b.body.translation(), q = b.body.rotation();
      b.mesh.position.set(t.x, t.y, t.z);
      b.mesh.quaternion.set(q.x, q.y, q.z, q.w);
      moved++;
    }
    return moved;
  }

  disposeBlock(b) {
    this.group.remove(b.mesh);
    b.mesh.geometry.dispose();
    this.disposeEdges(b);
    b.matList.forEach((m) => m.dispose());
    b.textures.forEach((t) => t.dispose());
  }

  /** The red outline only exists on the selected block (one line mesh per block would be one more draw call each). */
  disposeEdges(b) {
    if (!b.edges) return;
    b.mesh.remove(b.edges);
    b.edges.geometry.dispose();
    b.edges.material.dispose();
    b.edges = null;
  }

  // ---------------------------------------------------------------- rules
  isPullable(b) {
    if (!b || b.removed) return null;
    // only allow 1 block touch per turn
    if (this.turnBlock && !this.turnBlock.removed && b !== this.turnBlock) {
      return `You already touched ${this.turnBlock.dep.name} - you have to finish pulling it.`;
    }
    return this.structuralBlock(b);
  }

  /** Rules that depend only on the tower structure (not on the touch-move lock). */
  structuralBlock(b) {
    if (b.cap) return `That's ${b.dep.name} itself - it rests on everything below.`;
    if (b.placed) return 'Blocks put back on top stay there.';
    if (this.isLockedRow(b)) return `The top ${this.rules.lockedRows} rows are locked.`;
    return null;
  }

  isLockedRow(b) {
    return b.cap || b.placed || b.layer >= this.nLayers - this.rules.lockedRows;
  }

  /** Blocks still in the tower that have known vulnerabilities. */
  vulnerable() {
    return this.blocks.filter((b) => !b.removed && b.cvss != null);
  }

  /** True if any block could still be pulled (ignores the touch-move lock). */
  hasLegalMove() {
    return this.blocks.some((b) => !b.removed && !this.structuralBlock(b));
  }

  canInteract() {
    return this.state === 'idle' || this.state === 'pulling';
  }

  setPlayer(i) {
    this.playerIndex = i;
  }

  // ---------------------------------------------------------------- loop
  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    let glowing = false;
    if (this.world) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= DT && steps < 6) {
        this.applyPull();
        if (this.state === 'placing') this.updatePlacement();
        if (this.state === 'quaking') { applyQuake(this.quakers, this.quakeTime, DT); this.quakeTime += DT; }
        this.world.step();
        this.limitSpeeds();
        if (this.state !== 'over') for (const b of this.pops.update()) this.popBlock(b);
        this.acc -= DT;
        steps++;
      }
      if (steps === 6) this.acc = 0;
      if (this.syncMeshes()) this.dirty = true;
      this.checkRemoval();
      this.checkState(dt);
      if (this.state === 'quaking') this.glowQuakers();
      else if (this.rules.exploits.enabled) glowing = this.glowVulnerable();
    }
    this.time += dt;
    const animating = this.fading.length || this.shards.length || this.camTween;
    this.updateFading(dt);
    this.updateShards(dt);
    this.updateCamTween(dt);
    const camMoved = this.controls.update();
    // Render on demand: a settled tower with a still camera needs no new frames (only the glow, at a low rate).
    const busy = this.dirty || camMoved || animating || this.pull || this.placing || this.state === 'quaking';
    if (busy || (glowing && this.time - this.lastRender >= 1 / IDLE_FPS) || this.lastRender < 0) {
      this.renderer.render(this.scene, this.camera);
      this.lastRender = this.time;
      this.dirty = false;
    }
  }

  // Safety net against "explosions": the held block may not be rammed around faster than a hand would move
  // it, and nothing may leave a contact faster than a hard fall would make it (deep-penetration kickback).
  limitSpeeds() {
    const held = this.pull?.block;
    for (const b of this.blocks) {
      if (b.removed || b.body.isSleeping() || b.body.isKinematic()) continue;
      const vmax = b === held ? HELD_VMAX : BODY_VMAX;
      const v = b.body.linvel();
      const s = Math.hypot(v.x, v.y, v.z);
      if (s > vmax) { const k = vmax / s; b.body.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true); }
      const w = b.body.angvel();
      const ws = Math.hypot(w.x, w.y, w.z);
      const wmax = b === held ? HELD_WMAX : BODY_WMAX;
      if (ws > wmax) { const k = wmax / ws; b.body.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, true); }
    }
  }

  applyPull() {
    const p = this.pull;
    if (!p) return;
    const b = p.block, body = b.body;
    const pos = body.translation(), vel = body.linvel();
    const m = b.mass;
    // Free drag: a damped spring between the grabbed point on the block and the cursor's point in the world.
    // The force acts at the grab point, so the block is free to slide in any direction, twist and wiggle.
    const q = body.rotation(), av = body.angvel();
    const r = this._v1.copy(p.local).applyQuaternion(this._q1.set(q.x, q.y, q.z, q.w)); // anchor offset (world)
    const ax = pos.x + r.x, ay = pos.y + r.y, az = pos.z + r.z;
    // velocity of the anchor point: v + w x r
    const vx = vel.x + av.y * r.z - av.z * r.y;
    const vy = vel.y + av.z * r.x - av.x * r.z;
    const vz = vel.z + av.x * r.y - av.y * r.x;
    const k = m * OMEGA * OMEGA, c = m * 2 * ZETA * OMEGA;
    let fx = k * (p.target.x - ax) - c * vx;
    let fy = k * (p.target.y - ay) - c * vy;
    let fz = k * (p.target.z - az) - c * vz;
    const cap = p.fcap, f = Math.hypot(fx, fy, fz);
    if (f > cap) { const s = cap / f; fx *= s; fy *= s; fz *= s; }
    // Vertically a hand can lift or press with about the block's own weight, never crush the layers below.
    const vcap = Math.abs(GRAVITY) * m * 2;
    fy = Math.max(-vcap, Math.min(vcap, fy));
    body.resetForces(true);
    body.resetTorques(true);
    body.addForceAtPoint({ x: fx, y: fy, z: fz }, { x: ax, y: ay, z: az }, true);
    // light angular damping so the block does not spin wildly around the grab point
    const I = m * (b.L * b.L + b.w * b.w) / 12;
    body.addTorque({ x: -I * 8 * av.x, y: -I * 8 * av.y, z: -I * 8 * av.z }, true);
  }

  checkRemoval() {
    // Also covers a block that was let go while still moving and coasts clear of the tower on its own.
    const b = this.pull?.block || this.turnBlock;
    if (!b || b.removed || (this.state !== 'pulling' && this.state !== 'idle')) return;
    const t = b.body.translation();
    // out of the tower in any direction (sideways, or lifted clear)
    const d = Math.hypot(t.x - b.origin.x, t.y - b.origin.y, t.z - b.origin.z);
    if (d >= b.L * REMOVE_FRACTION) this.removeBlock(b);
  }

  // ---------------------------------------------------------------- fragile blocks
  /** A fragile block was hit too hard: it bursts into shards and leaves the tower. */
  popBlock(b) {
    if (b.removed) return;
    const turn = b === this.turnBlock;
    this.world.removeRigidBody(b.body);
    b.removed = true;
    b.popped = true;
    if (this.pull?.block === b) this.releasePull(true);
    if (this.hovered === b) this.setHover(null);
    if (this.selected === b) this.select(null);
    this.spawnShards(b);
    this.disposeBlock(b);
    this.turnPops.push(b);
    // the block being worked on this turn is gone either way: the turn moves on once the tower settles
    if (turn && (this.state === 'pulling' || this.state === 'idle')) {
      this.state = 'settling';
      this.stillTime = 0;
      this.settleTime = 0;
    }
    this.cb.onPop?.(b, { turn });
  }

  spawnShards(b) {
    const n = 18;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(b.color), roughness: 0.7, transparent: true });
    const t = b.mesh.position, q = b.mesh.quaternion;
    const parts = [];
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(geo, mat);
      const s = Math.min(b.h, b.w) * (0.18 + Math.random() * 0.3);
      m.scale.set(s * (0.6 + Math.random()), s * (0.5 + Math.random() * 0.5), s * (0.6 + Math.random()));
      const local = new THREE.Vector3((Math.random() - 0.5) * b.L, (Math.random() - 0.5) * b.h, (Math.random() - 0.5) * b.w).applyQuaternion(q);
      m.position.set(t.x + local.x, t.y + local.y, t.z + local.z);
      m.castShadow = true;
      const out = local.clone().normalize().multiplyScalar(2 + Math.random() * 3);
      parts.push({ m, v: new THREE.Vector3(out.x, 2 + Math.random() * 3, out.z), spin: new THREE.Vector3(Math.random() * 12, Math.random() * 12, Math.random() * 12) });
      this.group.add(m);
    }
    this.shards.push({ parts, geo, mat, age: 0 });
  }

  updateShards(dt) {
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const sh = this.shards[i];
      sh.age += dt;
      for (const p of sh.parts) {
        p.v.y += GRAVITY * dt;
        p.m.position.addScaledVector(p.v, dt);
        if (p.m.position.y < p.m.scale.y / 2) { p.m.position.y = p.m.scale.y / 2; p.v.multiplyScalar(0.4); p.v.y = Math.abs(p.v.y) * 0.3; }
        p.m.rotation.x += p.spin.x * dt; p.m.rotation.y += p.spin.y * dt; p.m.rotation.z += p.spin.z * dt;
      }
      sh.mat.opacity = Math.max(0, 1 - Math.max(0, sh.age - 0.8) / 0.6);
      if (sh.age > 1.4) { this.disposeShards(sh); this.shards.splice(i, 1); }
    }
  }

  disposeShards(sh) {
    for (const p of sh.parts) this.group.remove(p.m);
    sh.geo.dispose();
    sh.mat.dispose();
  }

  // ---------------------------------------------------------------- putting blocks back on top
  /** Lift the pulled block clear; it follows the cursor above the tower until it is dropped. */
  startPlacing(b) {
    this.pull = null;
    this.controls.enabled = true;
    this.renderer.domElement.style.cursor = '';
    this.cb.onPullState?.(false);
    if (this.hovered === b) this.setHover(null);
    b.exempt = true;
    // forces persist in Rapier until reset: without this the drag force would launch the block once it is dropped
    b.body.resetForces(true);
    b.body.resetTorques(true);
    b.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    b.collider.setSensor(true); // floats through anything while carried
    const top = this.layout.layers[this.nLayers - 1];
    this.placing = { block: b, axis: top.axis === 'x' ? 'z' : 'x', x: 0, z: 0, top: 0 };
    this.state = 'placing';
    this.cb.onRemoved?.(b);
    this.cb.onPlacing?.(true, b);
    this.updatePlacement();
    this.lookDownAtTop();
  }

  /** Glide the camera up so it looks down on the top of the tower (aiming a block needs a view from above). */
  lookDownAtTop() {
    let top = 0;
    for (const x of this.blocks) if (!x.removed && x !== this.placing?.block) top = Math.max(top, x.body.translation().y + x.h / 2);
    const target = new THREE.Vector3(0, top, 0);
    const dir = this.camera.position.clone().sub(this.controls.target);
    const az = Math.atan2(dir.x, dir.z);
    const dist = Math.max(14, this.W * 2.6);
    const elev = (55 * Math.PI) / 180;
    const pos = new THREE.Vector3(Math.sin(az) * Math.cos(elev) * dist, top + Math.sin(elev) * dist, Math.cos(az) * Math.cos(elev) * dist);
    this.camTween = { t: 0, p0: this.camera.position.clone(), p1: pos, c0: this.controls.target.clone(), c1: target };
  }

  updateCamTween(dt) {
    const tw = this.camTween;
    if (!tw) return;
    tw.t = Math.min(1, tw.t + dt / 0.6);
    const e = tw.t * tw.t * (3 - 2 * tw.t);
    this.camera.position.lerpVectors(tw.p0, tw.p1, e);
    this.controls.target.lerpVectors(tw.c0, tw.c1, e);
    if (tw.t >= 1) this.camTween = null;
  }

  _placeRotation(axis) {
    return axis === 'z' ? { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 } : { x: 0, y: 0, z: 0, w: 1 };
  }

  /** Highest surface under the carried block's footprint (ray casts on a 3x3 grid). */
  _surfaceUnder(p) {
    const b = p.block;
    const hx = (p.axis === 'x' ? b.L : b.w) / 2, hz = (p.axis === 'x' ? b.w : b.L) / 2;
    let top = 0;
    for (const fx of [-0.95, 0, 0.95]) {
      for (const fz of [-0.95, 0, 0.95]) {
        const ray = new RAPIER.Ray({ x: p.x + fx * hx, y: 500, z: p.z + fz * hz }, { x: 0, y: -1, z: 0 });
        const hit = this.world.castRay(ray, 1000, true, undefined, undefined, undefined, b.body);
        if (hit) top = Math.max(top, 500 - hit.timeOfImpact);
      }
    }
    return top;
  }

  updatePlacement() {
    const p = this.placing;
    if (!p) return;
    p.top = this._surfaceUnder(p);
    const b = p.block;
    b.body.setNextKinematicTranslation({ x: p.x, y: p.top + b.h / 2 + PLACE_HOVER, z: p.z });
    b.body.setNextKinematicRotation(this._placeRotation(p.axis));
  }

  /** Move the carried block to follow the cursor (on a horizontal plane at its current height). */
  movePlacement(clientX, clientY) {
    const p = this.placing;
    if (!p) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(p.top + p.block.h / 2 + PLACE_HOVER));
    const pt = this.raycaster.ray.intersectPlane(plane, this._v2);
    if (!pt) return;
    const R = this.W * 0.9, d = Math.hypot(pt.x, pt.z); // stay over (or just off) the tower
    const k = d > R ? R / d : 1;
    p.x = pt.x * k;
    p.z = pt.z * k;
  }

  rotatePlacement() {
    if (this.placing) this.placing.axis = this.placing.axis === 'x' ? 'z' : 'x';
  }

  /** Drop the carried block just above the surface under it; it is a normal (unpullable) block from then on. */
  dropPlacement() {
    const p = this.placing;
    if (!p) return;
    const b = p.block;
    p.top = this._surfaceUnder(p);
    const pos = { x: p.x, y: p.top + b.h / 2 + 0.02, z: p.z };
    b.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    b.body.resetForces(true);
    b.body.resetTorques(true);
    b.collider.setSensor(false);
    b.body.setTranslation(pos, true);
    b.body.setRotation(this._placeRotation(p.axis), true);
    b.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.exempt = false;
    b.placed = true;
    b.axis = p.axis;
    b.layer = this.nLayers; // above everything that was built
    b.origin = { ...pos };
    b.bad = 0;
    this.pops.reset();
    this.placing = null;
    this.camTween = null;
    this.state = 'settling';
    this.stillTime = 0;
    this.settleTime = 0;
    this.paint(b);
    this.cb.onPlacing?.(false, b);
  }

  removeBlock(b) {
    if (this.rules.placeOnTop) return this.startPlacing(b);
    const t = b.body.translation();
    // fly off in the direction the block was dragged
    let dx = t.x - b.origin.x, dz = t.z - b.origin.z;
    const dl = Math.hypot(dx, dz);
    if (dl > 1e-3) { dx /= dl; dz /= dl; } else { dx = b.axis === 'x' ? 1 : 0; dz = b.axis === 'x' ? 0 : 1; }
    const dir = { x: dx, z: dz };
    this.world.removeRigidBody(b.body);
    b.removed = true;
    this.disposeEdges(b);
    this.fading.push({ block: b, age: 0, dir, p0: { x: t.x, y: t.y, z: t.z } });
    this.pull = null;
    this.controls.enabled = true;
    this.renderer.domElement.style.cursor = '';
    this.cb.onPullState?.(false);
    if (this.hovered === b) this.setHover(null);
    this.state = 'settling';
    this.stillTime = 0;
    this.settleTime = 0;
    this.cb.onRemoved?.(b);
  }

  updateFading(dt) {
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const f = this.fading[i];
      f.age += dt;
      const k = f.age / 0.7;
      if (k >= 1) {
        this.group.remove(f.block.mesh);
        f.block.mesh.geometry.dispose();
        f.block.matList.forEach((m) => m.dispose());
        f.block.textures.forEach((t) => t.dispose());
        this.fading.splice(i, 1);
        continue;
      }
      const m = f.block.mesh;
      const e = 1 - (1 - k) * (1 - k);
      m.position.x = f.p0.x + f.dir.x * 3 * e;
      m.position.z = f.p0.z + f.dir.z * 3 * e;
      m.position.y = f.p0.y + 1.2 * e;
      m.scale.setScalar(1 - k * k);
    }
  }

  toppleCheck() {
    // the block being worked on this turn may go anywhere - until it has been put back on top
    const held = this.pull?.block || this.placing?.block || (this.turnBlock?.placed ? null : this.turnBlock);
    for (const b of this.blocks) {
      if (b.removed || b === held) continue;
      const t = b.body.translation(), q = b.body.rotation();
      const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
      const dropped = b.origin.y - t.y > Math.max(0.9, b.h * 1.1);
      const grounded = b.layer >= 1 && t.y < b.h / 2 + 0.12;
      const tilted = upY < 0.57;
      const strayed = Math.hypot(t.x - b.origin.x, t.z - b.origin.z) > b.L * 1.3;
      if (dropped || grounded || tilted || strayed) {
        b.why = { dropped, grounded, tilted, strayed, upY, dy: b.origin.y - t.y };
        if (++b.bad >= 6) { this.lastTopple = { name: b.dep.name, ...b.why }; return b; }
      } else b.bad = 0;
    }
    return null;
  }

  isCalm() {
    for (const b of this.blocks) {
      if (b.removed || b.body.isSleeping()) continue;
      const v = b.body.linvel(), w = b.body.angvel();
      if (v.x * v.x + v.y * v.y + v.z * v.z > 0.0036 || w.x * w.x + w.y * w.y + w.z * w.z > 0.0064) return false;
    }
    return true;
  }

  checkState(dt) {
    if (this.state === 'over' || this.state === 'empty') return;
    const fallen = this.toppleCheck();
    if (fallen) return this.endGame(fallen);
    if (this.state === 'quaking' && this.quakeTime >= QUAKE_TIME) this.endQuake();
    if (this.state === 'settling') {
      this.settleTime += dt;
      this.stillTime = this.isCalm() ? this.stillTime + dt : 0;
      if (this.stillTime >= STILL_TIME || this.settleTime > SETTLE_CAP) {
        this.state = 'idle';
        const last = this.turnBlock;
        this.turnBlock = null;
        if (last && !last.removed) {
          if (last.placed) last.origin = { ...last.body.translation() };
          this.paint(last); // drop the "this turn's block" tint
        }
        this.turnPops = [];
        if (!this.hasLegalMove()) return this._draw();
        if (this.afterQuake) this.afterQuake = false;
        else {
          this.turnsDone++;
          // an exploit wave after every turn (from the configured start round on)
          if (this.vulnerable().length && this.waveAfter(this.turnsDone) > 0) return this.startQuake();
        }
        this.cb.onTurnEnd?.();
      }
    }
  }

  // ---------------------------------------------------------------- exploits
  /** Intensity of the wave after turn n (0 when exploits are off or it is too early). */
  waveAfter(turn) {
    const ex = this.rules.exploits;
    return ex.enabled ? waveIntensity(roundOf(turn, this.rules.players), ex) : 0;
  }

  /** Intensity of the wave that will follow the current turn. */
  nextIntensity() {
    return this.waveAfter(this.turnsDone + 1);
  }

  /** Round the current turn belongs to. */
  round() {
    return roundOf(this.turnsDone + 1, this.rules.players);
  }

  /**
   * Vulnerable blocks shake for QUAKE_TIME seconds - harder for higher CVSS and for every round played so far -
   * then the tower settles again.
   */
  startQuake() {
    this.state = 'quaking';
    this.quakeTime = 0;
    this.quakeIntensity = this.waveAfter(this.turnsDone); // the same for every player's turn in a round
    this.quakers = beginQuake(this.vulnerable(), RAPIER.RigidBodyType, this.quakeIntensity);
    this.pops.reset();
    this.cb.onQuake?.(true, this.quakers.map((q) => q.block), this.quakeIntensity);
  }

  endQuake() {
    stopQuake(this.quakers, RAPIER.RigidBodyType);
    this.pops.reset();
    const shaken = this.quakers.map((q) => q.block);
    this.quakers = [];
    this.lastShaken = shaken;
    for (const b of shaken) this.paint(b);
    this.state = 'settling';
    this.afterQuake = true;
    this.stillTime = 0;
    this.settleTime = 0;
    this.cb.onQuake?.(false, shaken);
  }

  /** Vulnerable blocks smoulder: a red glow that pulses brighter and faster as the waves grow. */
  glowVulnerable() {
    const lvl = this.state === 'over' ? 0 : Math.min(1, this.nextIntensity());
    let n = 0;
    for (const b of this.blocks) {
      if (b.removed || !b.look.vuln || b === this.hovered || b === this.selected || b === this.pull?.block || b === this.turnBlock) continue;
      const p = 0.5 + 0.5 * Math.sin(this.time * (1.6 + 5.5 * lvl) + (b.look.seed % 628) / 100);
      const k = b.look.strength * (0.04 + (0.1 + 0.25 * lvl) * p);
      this._glow.set(0xd62828).multiplyScalar(k);
      for (const m of b.matList) m.emissive.copy(this._glow);
      n++;
    }
    return n > 0;
  }

  glowQuakers() {
    const k = 0.5 + 0.5 * Math.sin(this.quakeTime * 18);
    for (const q of this.quakers) {
      if (q.block.removed) continue;
      const em = new THREE.Color(0xd62828).multiplyScalar(0.15 + 0.35 * Math.min(1, q.s) * k).getHex();
      for (const m of q.block.matList) m.emissive.setHex(em);
    }
  }

  endGame(fallen) {
    const quake = this.state === 'quaking' || this.afterQuake;
    const shaken = this.state === 'quaking' ? this.quakers.map((q) => q.block) : quake ? this.lastShaken : [];
    if (this.state === 'quaking') { stopQuake(this.quakers, RAPIER.RigidBodyType); this.quakers = []; }
    this.afterQuake = false;
    this.state = 'over';
    this.releasePull(true);
    this.controls.enabled = true;
    this.cb.onGameOver?.({ fallen, culprit: this.lastPulled || fallen, quake, shaken, popped: this.turnPops.slice() });
  }

  // ---------------------------------------------------------------- selection
  setHover(b, x, y) {
    if (this.hovered !== b) {
      if (this.hovered) this.paint(this.hovered);
      this.hovered = b;
      if (b) this.paint(b);
    }
    this.cb.onHover?.(b, x, y);
  }
  select(b) {
    const prev = this.selected;
    this.selected = b;
    if (prev) this.paint(prev);
    if (b) this.paint(b);
    this.cb.onSelect?.(b);
  }
  paint(b) {
    if (b.removed) return;
    let em = 0x000000;
    if (this.pull?.block === b) { em = new THREE.Color(PLAYER_COLORS[this.playerIndex]).multiplyScalar(0.35).getHex(); }
    else if (b === this.hovered) em = 0x3a3322;
    else if (b === this.turnBlock) em = new THREE.Color(PLAYER_COLORS[this.playerIndex]).multiplyScalar(0.2).getHex();
    if (b === this.selected) {
      if (em === 0) em = 0x241c10;
      if (!b.edges) {
        b.edges = new THREE.LineSegments(new THREE.EdgesGeometry(b.mesh.geometry), new THREE.LineBasicMaterial({ color: 0xd62828 }));
        b.mesh.add(b.edges);
      }
    } else this.disposeEdges(b);
    for (const m of b.matList) m.emissive.setHex(em);
    this.dirty = true;
  }

  // ---------------------------------------------------------------- pointer
  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const meshes = this.blocks.filter((b) => !b.removed).map((b) => b.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return hit ? { block: hit.object.userData.block, point: hit.point } : null;
  }

  _bindPointer() {
    const el = this.renderer.domElement;
    const cont = this.container;
    let hoverRaf = 0;
    let lastMove = null;

    cont.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.world) return;
      if (this.state === 'placing') { // a click drops the carried block; a drag still orbits
        this.pending = { x: e.clientX, y: e.clientY, hit: null, id: e.pointerId, moved: false, place: true };
        return;
      }
      const hit = this.pick(e.clientX, e.clientY);
      this.pending = { x: e.clientX, y: e.clientY, hit, id: e.pointerId, moved: false };
      if (hit) {
        e.stopPropagation(); // keep OrbitControls out of it
        this.setHover(null);
      }
    }, true);

    window.addEventListener('pointermove', (e) => {
      const p = this.pending;
      if (p && p.id === e.pointerId) {
        const dist = Math.hypot(e.clientX - p.x, e.clientY - p.y);
        if (dist > 6) p.moved = true;
        if (p.hit && !this.pull && p.moved) this.tryBeginPull(p, e);
        if (this.pull) this.updatePullTarget(e);
        return;
      }
      if (e.target !== el || !this.world) return;
      if (this.state === 'placing') { this.movePlacement(e.clientX, e.clientY); return; }
      lastMove = e;
      if (!hoverRaf) {
        hoverRaf = requestAnimationFrame(() => {
          hoverRaf = 0;
          if (!lastMove || this.pending) return;
          const hit = this.pick(lastMove.clientX, lastMove.clientY);
          const b = hit ? hit.block : null;
          this.setHover(b, lastMove.clientX, lastMove.clientY);
          el.style.cursor = b ? (this.canInteract() && !this.isPullable(b) ? 'grab' : 'pointer') : '';
        });
      }
    });

    const up = (e) => {
      const p = this.pending;
      if (!p || p.id !== e.pointerId) return;
      this.pending = null;
      if (p.place) { if (!p.moved && this.state === 'placing') this.dropPlacement(); return; }
      if (this.pull) this.releasePull(false);
      else if (!p.moved) this.select(p.hit ? p.hit.block : null);
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', () => this.setHover(null));
    window.addEventListener('keydown', (e) => {
      if (this.state !== 'placing' || e.target.closest?.('input, textarea, select')) return;
      if (e.key === 'r' || e.key === 'R') this.rotatePlacement();
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.dropPlacement(); }
    });
  }

  tryBeginPull(p, e) {
    const b = p.hit.block;
    if (!this.canInteract()) {
      if (this.state === 'settling') this.cb.onHint?.('Wait for the tower to settle...');
      if (this.state === 'quaking') this.cb.onHint?.('Hold on - the tower is being exploited!');
      p.hit = null;
      return;
    }
    const why = this.isPullable(b);
    if (why) { this.cb.onHint?.(why); p.hit = null; return; }
    // Free drag. The cursor moves the grabbed point within a plane through that point: the horizontal plane
    // when we look down at the tower enough for that to be well-defined (blocks slide in any direction),
    // otherwise a vertical plane facing the camera. Holding Shift always uses the camera-facing plane (lift).
    const hit = p.hit.point.clone();
    const q = b.body.rotation(), tp = b.body.translation();
    const local = hit.clone().sub(this._v1.set(tp.x, tp.y, tp.z))
      .applyQuaternion(this._q1.set(q.x, q.y, q.z, q.w).invert());
    // Use the ray through the grab point (not the camera centre) to judge how steeply we look at the plane.
    const view = hit.clone().sub(this.camera.position).normalize();
    const normal = !e.shiftKey && Math.abs(view.y) > 0.1
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(view.x, e.shiftKey ? view.y : 0, view.z).normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit);
    // Pull strength: enough to beat friction from everything resting above (top and bottom faces), not the
    // old fixed 700 m/s^2 per unit mass, which could ram a block through its neighbours.
    let load = 0;
    for (const x of this.blocks) if (!x.removed && x.layer > b.layer) load += x.mass;
    const fcap = Math.abs(GRAVITY) * (PULL_SELF * b.mass + PULL_LOAD * load);
    this.pull = { block: b, local, plane, anchor0: hit, target: hit.clone(), fcap };
    b.body.enableCcd(true);
    b.exempt = true; // the block in hand can't pop from the player's own pull (what it hits can)
    this.lastPulled = b;
    this.turnBlock = b;
    this.state = 'pulling';
    b.body.wakeUp();
    this.controls.enabled = false;
    this.renderer.domElement.style.cursor = 'grabbing';
    this.paint(b);
    this.cb.onPullState?.(true, b);
    this.updatePullTarget(e);
  }

  toScreen(v) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const n = v.clone().project(this.camera);
    return { x: (n.x * 0.5 + 0.5) * rect.width, y: (-n.y * 0.5 + 0.5) * rect.height };
  }

  updatePullTarget(e) {
    const p = this.pull;
    if (!p) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const pt = this.raycaster.ray.intersectPlane(p.plane, this._v2);
    if (!pt) return; // cursor ray misses the drag plane (e.g. above the horizon): keep the last target
    // keep the target within reach so a stray cursor cannot fling the block
    const d = pt.sub(p.anchor0), lim = p.block.L * 1.6, len = d.length();
    if (len > lim) d.multiplyScalar(lim / len);
    p.target.copy(p.anchor0).add(d);
  }

  releasePull(silent) {
    const p = this.pull;
    if (!p) return;
    const b = p.block;
    this.pull = null;
    b.exempt = false;
    if (b.removed) { this.controls.enabled = true; this.renderer.domElement.style.cursor = ''; return; }
    b.body.resetForces(false);
    b.body.resetTorques(false);
    this.paint(b);
    this.controls.enabled = true;
    this.renderer.domElement.style.cursor = '';
    if (this.state === 'pulling') this.state = 'idle';
    if (!silent) this.cb.onPullState?.(false, b);
  }
}
