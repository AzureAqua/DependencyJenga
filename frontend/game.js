// game.js - three.js scene + Rapier physics + pulling interaction + turn/topple state machine.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { colorFor, PLAYER_COLORS } from './theme.js';
import { makeBlockMaterials, INK } from './textures.js';

const GRAVITY = -18;
const DT = 1 / 120; // physics step
const OMEGA = 14; // pull spring natural frequency (rad/s)
const ZETA = 0.9;
const FMAX_ACC = 700; // max pull force per unit block mass
const REMOVE_FRACTION = 0.9; // block counts as taken once this fraction of its length is out
const STILL_TIME = 1.0; // seconds of calm before the turn passes
const SETTLE_CAP = 8; // hard cap (s) for the settling phase
const BG = 0xf4eddc;

let rapierReady = null;
export function initPhysics() {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

export class Game {
  /** cb: onHover(block,x,y) onSelect(block) onHint(msg) onRemoved(block) onTurnEnd() onGameOver(info) onPullState(bool) */
  constructor(container, cb = {}) {
    this.container = container;
    this.cb = cb;
    this.state = 'empty'; // empty | idle | pulling | settling | over
    this.blocks = [];
    this.world = null;
    this.pull = null;
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
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(r.domElement);
    r.domElement.style.touchAction = 'none';

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG);
    this.scene.fog = new THREE.Fog(BG, 45, 110);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 300);
    this.camera.position.set(11, 8, 13);

    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 70;

    this.scene.add(new THREE.HemisphereLight(0xfff6e6, 0xb9a98a, 0.85));
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
    const table = new THREE.Mesh(
      new THREE.CylinderGeometry(14, 14.4, 0.5, 64),
      new THREE.MeshStandardMaterial({ color: 0xe9dcbb, roughness: 0.95 }),
    );
    table.position.y = -0.25;
    table.receiveShadow = true;
    this.scene.add(table);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(14.05, 0.06, 8, 96),
      new THREE.MeshBasicMaterial({ color: 0x3a2e22 }),
    );
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

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- tower
  clearTower() {
    for (const b of this.blocks) {
      this.group.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.edges.geometry.dispose();
      b.edges.material.dispose();
      b.matList.forEach((m) => m.dispose());
      b.textures.forEach((t) => t.dispose());
    }
    for (const f of this.fading) this.group.remove(f.block.mesh);
    this.fading = [];
    this.blocks = [];
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
    try { world.integrationParameters.numSolverIterations = 12; } catch (e) { /* older API */ }
    world.createCollider(RAPIER.ColliderDesc.cuboid(40, 0.5, 40).setTranslation(0, -0.5, 0).setFriction(0.9));

    const L = layout.width;
    const lineBase = new THREE.Color(INK);
    for (const layer of layout.layers) {
      const odd = layer.axis === 'z';
      for (let bi = 0; bi < layer.blocks.length; bi++) {
        const it = layer.blocks[bi];
        const ph = it.phys;
        const H = layer.height, w = it.w;
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
        world.createCollider(cd, rb);

        const color = colorFor(it.dep);
        const { materials, textures } = makeBlockMaterials(it.dep, color, L, H, w);
        const geo = new THREE.BoxGeometry(L, H, w);
        const mesh = new THREE.Mesh(geo, materials);
        mesh.castShadow = mesh.receiveShadow = true;
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          new THREE.LineBasicMaterial({ color: lineBase.clone(), transparent: true, opacity: 0.65 }),
        );
        mesh.add(edges);
        this.group.add(mesh);
        const block = {
          id: it.dep.id, dep: it.dep, phys: ph, layer: layer.index, index: bi,
          body: rb, mesh, edges, matList: [materials[4], materials[0], materials[2]], textures,
          L, h: H, w, axis: layer.axis, removed: false, bad: 0, locked: false,
          mass: rb.mass(), origin: null, color,
        };
        mesh.userData.block = block;
        layer.blocks[bi].block = block;
        this.blocks.push(block);
      }
    }
    // pre-settle the tower off-screen (up to ~6 s of simulated time)
    this.settleLog = [];
    for (let i = 0; i < 720; i++) {
      // ramp gravity in so the stack loads smoothly instead of ringing like a Newton's cradle
      if (i <= 120) world.gravity = { x: 0, y: GRAVITY * Math.min(1, i / 120), z: 0 };
      world.step();
      if (i % 30 === 0) {
        let md = 0, ml = -1, ms = 0;
        for (const b of this.blocks) {
          const t = b.body.translation(), li = layout.layers[b.layer], c = li.blocks[b.index].c;
          const d = Math.hypot(t.x - (li.axis === 'z' ? c : 0), t.z - (li.axis === 'z' ? 0 : c)) + Math.abs(t.y - li.y) * 0.2;
          if (d > md) { md = d; ml = b.layer; }
          const v = b.body.linvel(); ms = Math.max(ms, Math.hypot(v.x, v.y, v.z));
        }
        this.settleLog.push([i, +md.toFixed(2), ml, +ms.toFixed(3)]);
      }
      if (i > 240 && i % 30 === 0 && this.blocks.every((b) => b.body.isSleeping())) break;
    }
    this.syncMeshes();
    let maxDisp = 0, maxSpeed = 0, asleep = 0;
    for (const b of this.blocks) {
      const t = b.body.translation();
      const li = layout.layers[b.layer];
      const ox = li.axis === 'z' ? li.blocks[b.index].c : 0, oz = li.axis === 'z' ? 0 : li.blocks[b.index].c;
      maxDisp = Math.max(maxDisp, Math.hypot(t.x - ox, t.y - li.y, t.z - oz));
      const v = b.body.linvel();
      maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z));
      if (b.body.isSleeping()) asleep++;
      b.origin = { x: t.x, y: t.y, z: t.z };
    }
    this.settleReport = { maxDisp, maxSpeed, asleep, total: this.blocks.length };
    this.frameTower();
    this.state = 'idle';
    this.stillTime = 0;
    this.acc = 0;
  }

  frameTower() {
    const H = this.layout.totalHeight;
    const aspect = this.camera.aspect || 1.5;
    const fit = (H * 0.58 + 2.5) / Math.tan((this.camera.fov * Math.PI) / 360); // fit height
    const dist = Math.max(14, fit, 9 / Math.min(1, aspect) / Math.tan((this.camera.fov * Math.PI) / 360) * 0.6);
    this.controls.target.set(0, H * 0.45, 0);
    this.camera.position.set(dist * 0.62, H * 0.45 + dist * 0.28, dist * 0.78);
    this.controls.update();
    const sc = this.sun.shadow.camera;
    sc.top = Math.max(20, H + 6);
    sc.updateProjectionMatrix();
    this.sun.position.set(9, H + 14, 12);
  }

  syncMeshes() {
    for (const b of this.blocks) {
      if (b.removed) continue;
      const t = b.body.translation(), q = b.body.rotation();
      b.mesh.position.set(t.x, t.y, t.z);
      b.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    }
  }

  // ---------------------------------------------------------------- rules
  isPullable(b) {
    if (!b || b.removed) return null;
    if (b.layer >= this.nLayers - 1) return "The top layer can't be taken.";
    const remaining = this.layout.layers[b.layer].blocks.filter((x) => !x.block.removed).length;
    if (remaining <= 1) return 'That is the last block of its layer.';
    return null;
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
    if (this.world) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= DT && steps < 6) {
        this.applyPull();
        this.world.step();
        this.acc -= DT;
        steps++;
      }
      if (steps === 6) this.acc = 0;
      this.syncMeshes();
      this.checkRemoval();
      this.checkState(dt);
    }
    this.updateFading(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  applyPull() {
    const p = this.pull;
    if (!p) return;
    const b = p.block, body = b.body;
    const pos = body.translation(), vel = body.linvel();
    const a = b.axis;
    const err = p.target - pos[a];
    const m = b.mass;
    let F = m * OMEGA * OMEGA * err - m * 2 * ZETA * OMEGA * vel[a];
    const cap = m * FMAX_ACC;
    F = Math.max(-cap, Math.min(cap, F));
    // keep the block straight: lateral spring + orientation spring (PD), so it slides out like on rails
    const perp = a === 'x' ? pos.z : pos.x;
    const perpV = a === 'x' ? vel.z : vel.x;
    const Fp = m * 250 * (p.perp0 - perp) - m * 30 * perpV;
    body.resetForces(true);
    body.addForce(a === 'x' ? { x: F, y: 0, z: Fp } : { x: Fp, y: 0, z: F }, true);
    const q = body.rotation(), q0 = p.q0;
    // relative rotation q * conj(q0)
    let rx = q.w * -q0.x + q.x * q0.w + q.y * -q0.z - q.z * -q0.y;
    let ry = q.w * -q0.y - q.x * -q0.z + q.y * q0.w + q.z * -q0.x;
    let rz = q.w * -q0.z + q.x * -q0.y - q.y * -q0.x + q.z * q0.w;
    const rw = q.w * q0.w + q.x * q0.x + q.y * q0.y + q.z * q0.z;
    const sgn = rw < 0 ? -1 : 1;
    const I = m * (b.L * b.L + b.w * b.w) / 12 * 3; // generous inertia estimate
    const av = body.angvel();
    body.resetTorques(true);
    body.addTorque({
      x: I * (-400 * 2 * sgn * rx - 30 * av.x),
      y: I * (-400 * 2 * sgn * ry - 30 * av.y),
      z: I * (-400 * 2 * sgn * rz - 30 * av.z),
    }, true);
  }

  checkRemoval() {
    const p = this.pull;
    if (!p) return;
    const b = p.block;
    const a = b.axis;
    const d = Math.abs(b.body.translation()[a] - b.origin[a]);
    if (d >= this.W * REMOVE_FRACTION) this.removeBlock(b);
  }

  removeBlock(b) {
    const dir = Math.sign(b.body.translation()[b.axis] - b.origin[b.axis]) || 1;
    const t = b.body.translation();
    this.world.removeRigidBody(b.body);
    b.removed = true;
    b.edges.material.opacity = 0.65;
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
      m.position[f.block.axis] = f.p0[f.block.axis] + f.dir * 3 * e;
      m.position.y = f.p0.y + 1.2 * e;
      m.scale.setScalar(1 - k * k);
    }
  }

  toppleCheck() {
    const held = this.pull?.block;
    for (const b of this.blocks) {
      if (b.removed || b === held) continue;
      const t = b.body.translation(), q = b.body.rotation();
      const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
      const dropped = b.origin.y - t.y > Math.max(0.9, b.h * 1.1);
      const grounded = b.layer >= 1 && t.y < b.h / 2 + 0.12;
      const tilted = upY < 0.57;
      const strayed = Math.hypot(t.x - b.origin.x, t.z - b.origin.z) > this.W * 1.3;
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
    if (this.state === 'settling') {
      this.settleTime += dt;
      this.stillTime = this.isCalm() ? this.stillTime + dt : 0;
      if (this.stillTime >= STILL_TIME || this.settleTime > SETTLE_CAP) {
        this.state = 'idle';
        this.cb.onTurnEnd?.();
      }
    }
  }

  endGame(fallen) {
    this.state = 'over';
    this.releasePull(true);
    this.controls.enabled = true;
    this.cb.onGameOver?.({ fallen, culprit: this.lastPulled || fallen });
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
    let em = 0x000000, line = INK;
    if (this.pull?.block === b) { em = new THREE.Color(PLAYER_COLORS[this.playerIndex]).multiplyScalar(0.35).getHex(); }
    else if (b === this.hovered) em = 0x3a3322;
    if (b === this.selected) { line = '#d62828'; if (em === 0) em = 0x241c10; }
    for (const m of b.matList) m.emissive.setHex(em);
    b.edges.material.color.set(line);
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
      if (this.pull) this.releasePull(false);
      else if (!p.moved) this.select(p.hit ? p.hit.block : null);
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', () => this.setHover(null));
  }

  tryBeginPull(p, e) {
    const b = p.hit.block;
    if (!this.canInteract()) {
      if (this.state === 'settling') this.cb.onHint?.('Wait for the tower to settle...');
      p.hit = null;
      return;
    }
    const why = this.isPullable(b);
    if (why) { this.cb.onHint?.(why); p.hit = null; return; }
    // screen-space direction of the pull axis
    const a = b.axis;
    const p0 = p.hit.point.clone();
    const p1 = p0.clone();
    p1[a] += 1;
    const s0 = this.toScreen(p0), s1 = this.toScreen(p1);
    let vx = s1.x - s0.x, vy = s1.y - s0.y;
    let len = Math.hypot(vx, vy);
    if (len < 35) { // looking along the axis: fall back to a slow, steady mapping
      if (len < 1e-3) { vx = 1; vy = 0; len = 1; }
      vx = (vx / len) * 35; vy = (vy / len) * 35; len = 35;
    }
    const start = b.body.translation()[a];
    this.pull = { block: b, mx: p.x, my: p.y, vx, vy, vv: len * len, start, target: start };
    this.lastPulled = b;
    this.state = 'pulling';
    // Hard axis/rotation locks make Rapier treat the block as infinitely "heavy" in friction, which drags the
    // whole layer above along. So we keep it dynamic and steer it with soft springs instead (see applyPull).
    const q = b.body.rotation(), tp = b.body.translation();
    this.pull.q0 = { x: q.x, y: q.y, z: q.z, w: q.w };
    this.pull.perp0 = a === 'x' ? tp.z : tp.x;
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
    const s = ((e.clientX - p.mx) * p.vx + (e.clientY - p.my) * p.vy) / p.vv;
    const lim = this.W * 1.6;
    p.target = p.start + Math.max(-lim, Math.min(lim, s));
  }

  releasePull(silent) {
    const p = this.pull;
    if (!p) return;
    const b = p.block;
    this.pull = null;
    b.body.resetForces(false);
    b.body.resetTorques(false);
    this.paint(b);
    this.controls.enabled = true;
    this.renderer.domElement.style.cursor = '';
    if (this.state === 'pulling') this.state = 'idle';
    if (!silent) this.cb.onPullState?.(false, b);
  }
}
