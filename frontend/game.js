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

    const lineBase = new THREE.Color(INK);
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
          L, h: H, w, axis: layer.axis, level: layer.level ?? null, removed: false, bad: 0, locked: false,
          mass: rb.mass(), origin: null, color,
        };
        mesh.userData.block = block;
        layer.blocks[bi].block = block;
        this.blocks.push(block);
      }
    }
    // pre-settle the tower off-screen (up to ~6 s of simulated time)
    this.settleLog = [];
    for (let i = 0; i < 1200; i++) {
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
    let maxDisp = 0, maxSpeed = 0, asleep = 0, minUp = 1;
    for (const b of this.blocks) {
      const t = b.body.translation();
      const li = layout.layers[b.layer];
      const ox = li.axis === 'z' ? li.blocks[b.index].c : 0, oz = li.axis === 'z' ? 0 : li.blocks[b.index].c;
      maxDisp = Math.max(maxDisp, Math.hypot(t.x - ox, t.y - li.y, t.z - oz));
      const v = b.body.linvel();
      maxSpeed = Math.max(maxSpeed, Math.hypot(v.x, v.y, v.z));
      if (b.body.isSleeping()) asleep++;
      const q = b.body.rotation();
      minUp = Math.min(minUp, 1 - 2 * (q.x * q.x + q.z * q.z));
      b.origin = { x: t.x, y: t.y, z: t.z };
    }
    const stable = asleep === this.blocks.length && maxDisp < 0.7 && minUp > 0.95;
    this.settleReport = { maxDisp, maxSpeed, asleep, total: this.blocks.length, minUp, stable, layers: this.nLayers, mode: layout.mode };
    this.frameTower();
    this.state = 'idle';
    this.turnBlock = null;
    this.stillTime = 0;
    this.acc = 0;
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
    // only allow 1 block touch per turn
    if (this.turnBlock && !this.turnBlock.removed && b !== this.turnBlock) {
      return `You already touched ${this.turnBlock.dep.name} - you have to finish pulling it.`;
    }
    return this.structuralBlock(b);
  }

  /** Rules that depend only on the tower structure (not on the touch-move lock). */
  structuralBlock(b) {
    if (b.layer >= this.nLayers - 1) return "The top layer can't be taken.";
    const remaining = this.layout.layers[b.layer].blocks.filter((x) => !x.block.removed).length;
    if (remaining <= 1) return 'That is the last block of its layer.';
    return null;
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
    const cap = m * FMAX_ACC, f = Math.hypot(fx, fy, fz);
    if (f > cap) { const s = cap / f; fx *= s; fy *= s; fz *= s; }
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

  removeBlock(b) {
    const t = b.body.translation();
    // fly off in the direction the block was dragged
    let dx = t.x - b.origin.x, dz = t.z - b.origin.z;
    const dl = Math.hypot(dx, dz);
    if (dl > 1e-3) { dx /= dl; dz /= dl; } else { dx = b.axis === 'x' ? 1 : 0; dz = b.axis === 'x' ? 0 : 1; }
    const dir = { x: dx, z: dz };
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
      m.position.x = f.p0.x + f.dir.x * 3 * e;
      m.position.z = f.p0.z + f.dir.z * 3 * e;
      m.position.y = f.p0.y + 1.2 * e;
      m.scale.setScalar(1 - k * k);
    }
  }

  toppleCheck() {
    const held = this.pull?.block || this.turnBlock; // the block being worked on this turn may go anywhere
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
    if (this.state === 'settling') {
      this.settleTime += dt;
      this.stillTime = this.isCalm() ? this.stillTime + dt : 0;
      if (this.stillTime >= STILL_TIME || this.settleTime > SETTLE_CAP) {
        this.state = 'idle';
        this.turnBlock = null;
        if (!this.hasLegalMove()) return this._draw();
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
    else if (b === this.turnBlock) em = new THREE.Color(PLAYER_COLORS[this.playerIndex]).multiplyScalar(0.2).getHex();
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
    this.pull = { block: b, local, plane, anchor0: hit, target: hit.clone() };
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
    b.body.resetForces(false);
    b.body.resetTorques(false);
    this.paint(b);
    this.controls.enabled = true;
    this.renderer.domElement.style.cursor = '';
    if (this.state === 'pulling') this.state = 'idle';
    if (!silent) this.cb.onPullState?.(false, b);
  }
}
