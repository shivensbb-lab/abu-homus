// ============================================================================
// Player.js — the pirate assassin: WASD + mouse-relative movement, the
// Swashbuckling Sprint (stamina), raycast parkour (climb / mantle / vault /
// wall-jump), synchronisation, Leap of Faith, swimming and combat input.
// ============================================================================
import * as THREE from 'three';
import { TAG } from './Physics.js';
import { WATER_Y } from './World.js';

const UP = new THREE.Vector3(0, 1, 0);
const WALK = 1.9, RUN = 4.4, SPRINT = 9.6, SWIM = 2.6;
const JUMP_V = 7.2;
const STAMINA_DRAIN = 26, STAMINA_REGEN = 20, REGEN_DELAY = 0.7;

export class Player {
  constructor({ scene, physics, world, hud, cam, character }) {
    Object.assign(this, { scene, physics, world, hud, cam, character });
    this.director = null;               // set by Game (EnemyDirector)
    this.radius = 0.38; this.height = 1.8;
    this.pos = world.spawn.clone();
    this.vel = new THREE.Vector3();
    this.facing = Math.PI;
    this.state = 'air';                 // ground | air | climb | mantle | leap | swim | sync | dead
    this.stamina = 100; this.exhausted = false; this._regenWait = 0;
    this.health = 100;
    this.sprinting = false; this.hidden = false; this.grounded = false;
    this.ground = null; this.onSync = null;
    this.climb = null; this.mantle = null; this.leap = null;
    this._regrab = 0; this._deadTimer = 0; this._anim = 0; this._attackCd = 0;
    this.respawnPoint = world.spawn.clone();
    this.synced = new Set();
    this.mesh = character.root;
    scene.add(this.mesh);
  }

  get chest() { return new THREE.Vector3(this.pos.x, this.pos.y + 1.2, this.pos.z); }
  get forward() { return new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing)); }

  // ------------------------------------------------------------------ update
  update(dt, input) {
    this._regrab = Math.max(0, this._regrab - dt);
    this._attackCd = Math.max(0, this._attackCd - dt);
    const axes = input.moveAxes();
    const wish = new THREE.Vector3()
      .addScaledVector(this.cam.forward, axes.y)
      .addScaledVector(this.cam.right, axes.x);
    if (wish.lengthSq() > 0) wish.normalize();

    this._updateStamina(dt, input, axes);

    switch (this.state) {
      case 'ground': case 'air': this._updateLocomotion(dt, input, wish, axes); break;
      case 'swim': this._updateSwim(dt, input, wish); break;
      case 'climb': this._updateClimb(dt, input, axes); break;
      case 'mantle': this._updateMantle(dt); break;
      case 'leap': this._updateLeap(dt); break;
      case 'sync': if (!this.cam.orbit) this.state = 'ground'; break;
      case 'dead': this._updateDead(dt); break;
    }

    if (this.state !== 'dead' && this.state !== 'leap') this._combatInput(input);
    this.hidden = !this.sprinting && this.state !== 'climb' &&
      !!this.physics.overlapsTag(this.pos, this.radius, this.height * 0.8, TAG.HIDE);
    this._prompts();
    this._axes = axes;
  }

  _updateStamina(dt, input, axes) {
    const wantsSprint = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    const canSprint = !this.exhausted && this.stamina > 0 && axes.active;
    this.sprinting = wantsSprint && canSprint && ['ground', 'air', 'climb'].includes(this.state);
    if (this.sprinting) {
      this.stamina -= STAMINA_DRAIN * dt * (this.state === 'climb' ? 0.6 : 1);
      this._regenWait = REGEN_DELAY;
      if (this.stamina <= 0) { this.stamina = 0; this.exhausted = true; this.hud.notify('Out of breath', 1.2); }
    } else if ((this._regenWait -= dt) <= 0) {
      this.stamina = Math.min(100, this.stamina + STAMINA_REGEN * dt);
      if (this.exhausted && this.stamina > 25) this.exhausted = false;
    }
  }

  // --------------------------------------------------------- ground & air
  _updateLocomotion(dt, input, wish, axes) {
    const walking = input.isDown('ControlLeft') || input.isDown('KeyC');
    const speed = this.sprinting ? SPRINT : walking ? WALK : RUN;
    const accel = this.grounded ? 14 : 2.5;
    const k = 1 - Math.exp(-accel * dt);
    this.vel.x += (wish.x * speed - this.vel.x) * k;
    this.vel.z += (wish.z * speed - this.vel.z) * k;
    this.vel.y += this.physics.gravity * dt;
    if (axes.active) this._turnTowards(Math.atan2(wish.x, wish.z), dt, this.grounded ? 12 : 4);

    if (this.grounded && input.wasPressed('Space')) {
      if (this.onSync && this._tryLeapOfFaith()) return;
      this.vel.y = JUMP_V; this.grounded = false;
    }
    if (this.onSync && input.wasPressed('KeyF')) return this._synchronise();

    this.pos.addScaledVector(this.vel, dt);
    const res = this.physics.resolveCylinder(this.pos, this.vel, this.radius, this.height);
    this.grounded = res.grounded; this.ground = res.ground;
    this.state = this.grounded ? 'ground' : 'air';
    this.onSync = this.grounded && res.ground?.tags.has(TAG.SYNC) ? res.ground : null;
    if (this.grounded) this.lastSafe = this.pos.clone();

    // Parkour: pressing into a climbable surface while in high profile or airborne.
    const highProfile = this.sprinting || !this.grounded || input.isDown('Space');
    if (axes.active && highProfile && this._regrab <= 0) this._tryParkour(wish);

    if (this.pos.y < WATER_Y - 1.0 && this.physics.overlapsTag(this.pos, 0.1, 1, TAG.WATER)) this._enterWater();
    if (this.pos.y < -30) this.takeDamage(999);
  }

  _turnTowards(target, dt, rate) {
    let d = target - this.facing;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.facing += d * (1 - Math.exp(-rate * dt));
  }

  /** Forward chest ray → climb, vault or mantle depending on obstacle height. */
  _tryParkour(wish) {
    const dir = wish.clone().setY(0).normalize();
    const reach = this.radius + 0.5;
    const solid = (c) => c.solid;
    // Chest ray for walls; knee ray catches low crates / quay edges for vaulting.
    let hit = this.physics.raycast(this.chest, dir, reach, solid);
    if (!hit) hit = this.physics.raycast(new THREE.Vector3(this.pos.x, this.pos.y + 0.55, this.pos.z), dir, reach, solid);
    if (!hit || Math.abs(hit.normal.y) > 0.5) return false;
    // Upward probe: is there head-room to climb (nothing solid directly above)?
    const above = this.physics.raycast(new THREE.Vector3(this.pos.x, this.pos.y + this.height, this.pos.z), UP, 0.8, (c) => c.solid);
    if (above) return false;
    const top = hit.collider.box.max.y;
    const rise = top - this.pos.y;
    if (rise < 0.5) return false;
    if (rise <= 1.7) return this._startMantle(new THREE.Vector3(hit.point.x, top, hit.point.z).addScaledVector(hit.normal, -(this.radius + 0.25)), 0.3);
    if (!hit.collider.climbable) return false;
    this._startClimb(hit);
    return true;
  }

  // -------------------------------------------------------------- climbing
  _startClimb(hit) {
    this.state = 'climb';
    this.vel.set(0, 0, 0);
    this.climb = { collider: hit.collider, normal: hit.normal.clone() };
    this.pos.x = hit.point.x + hit.normal.x * (this.radius + 0.05);
    this.pos.z = hit.point.z + hit.normal.z * (this.radius + 0.05);
    this.facing = Math.atan2(-hit.normal.x, -hit.normal.z);
    this.hud.notify(hit.collider.tags.has(TAG.RIGGING) ? 'Climbing the rigging' : '', 0.8);
  }

  _updateClimb(dt, input, axes) {
    const n = this.climb.normal;
    if (input.wasPressed('Space')) {                     // wall-jump away
      this.vel.set(n.x * 4.5, 5.5, n.z * 4.5);
      this.state = 'air'; this._regrab = 0.45; this.facing = Math.atan2(n.x, n.z);
      return;
    }
    if (input.wasPressed('KeyC') || input.wasPressed('ControlLeft')) {   // drop
      this.vel.set(n.x, 0, n.z); this.state = 'air'; this._regrab = 0.5; return;
    }
    const rigging = this.climb.collider.tags.has(TAG.RIGGING);
    const speed = (rigging ? 3.4 : 2.4) * (this.sprinting ? 1.6 : 1);
    const tangent = new THREE.Vector3(n.z, 0, -n.x);
    const next = this.pos.clone().addScaledVector(UP, axes.y * speed * dt).addScaledVector(tangent, axes.x * speed * 0.8 * dt);

    const chest = new THREE.Vector3(next.x, next.y + 1.2, next.z);
    const back = n.clone().negate();
    const hit = this.physics.raycast(chest, back, this.radius + 0.6, (c) => c.solid);
    if (hit && hit.collider.climbable && Math.abs(hit.normal.y) < 0.5) {
      this.pos.copy(next);
      this.pos.x = hit.point.x + hit.normal.x * (this.radius + 0.05);
      this.pos.z = hit.point.z + hit.normal.z * (this.radius + 0.05);
      this.climb.collider = hit.collider; this.climb.normal.copy(hit.normal);
      this.facing = Math.atan2(-hit.normal.x, -hit.normal.z);
    } else if (axes.y > 0) {
      // Chest cleared the top edge → look for a surface to mantle onto.
      const probe = this.pos.clone().addScaledVector(n, -(this.radius + 0.7));
      probe.y += 2.4;
      const h = this.physics.groundHeight(probe, 3);
      if (h !== null && h > this.pos.y + 0.6) this._startMantle(new THREE.Vector3(probe.x, h, probe.z), 0.4);
    }
    // Climbing down onto the ground
    if (axes.y < 0) {
      const g = this.physics.groundHeight(this.pos, 0.2);
      if (g !== null && this.pos.y - g < 0.15) { this.state = 'ground'; this.pos.y = g; this._regrab = 0.4; }
    }
  }

  _startMantle(to, duration) {
    this.state = 'mantle';
    this.mantle = { from: this.pos.clone(), to, t: 0, duration };
    this.vel.set(0, 0, 0);
    return true;
  }

  _updateMantle(dt) {
    const m = this.mantle;
    m.t = Math.min(1, m.t + dt / m.duration);
    const up = Math.min(1, m.t * 1.7), fwd = Math.max(0, (m.t - 0.35) / 0.65);
    this.pos.set(THREE.MathUtils.lerp(m.from.x, m.to.x, fwd), THREE.MathUtils.lerp(m.from.y, m.to.y + 0.02, up), THREE.MathUtils.lerp(m.from.z, m.to.z, fwd));
    if (m.t >= 1) { this.state = 'ground'; this.grounded = true; this.mantle = null; }
  }

  // ------------------------------------------------ sync & Leap of Faith
  _synchronise() {
    this.state = 'sync';
    this.vel.set(0, 0, 0);
    this.respawnPoint.copy(this.pos);
    const key = this.onSync.id;
    this.cam.startSyncOrbit(this.pos);
    if (!this.synced.has(key)) {
      this.synced.add(key);
      this.hud.banner('VIEWPOINT SYNCHRONIZED', 'Nearby haystacks revealed');
    }
  }

  _tryLeapOfFaith() {
    const range = 55;
    const q = new THREE.Box3(new THREE.Vector3(this.pos.x - range, this.pos.y - 60, this.pos.z - range), new THREE.Vector3(this.pos.x + range, this.pos.y, this.pos.z + range));
    const zones = this.physics.query(q, (c) => c.tags.has(TAG.HAYSTACK));
    const fwd = this.forward;
    let best = null, bestScore = Infinity;
    for (const z of zones) {
      const c = z.box.getCenter(new THREE.Vector3());
      const flat = new THREE.Vector3(c.x - this.pos.x, 0, c.z - this.pos.z);
      const d = flat.length();
      const drop = this.pos.y - z.box.max.y;
      if (drop < 6 || d > 8 + drop * 0.9) continue;
      const angle = d < 0.5 ? 0 : fwd.angleTo(flat.normalize());
      if (angle > 1.1) continue;
      const score = angle * 10 + d * 0.1;
      if (score < bestScore) { bestScore = score; best = { zone: z, center: c }; }
    }
    if (!best) { this.hud.notify('No safe landing in sight', 1.5); return false; }
    const p0 = this.pos.clone();
    const p2 = new THREE.Vector3(best.center.x, best.zone.box.min.y + 0.1, best.center.z);
    const p1 = p0.clone().lerp(p2, 0.25); p1.y = p0.y + 3;
    const duration = 0.9 + Math.sqrt((p0.y - p2.y) / 12);
    this.leap = { p0, p1, p2, t: 0, duration };
    this.state = 'leap';
    this.facing = Math.atan2(p2.x - p0.x, p2.z - p0.z);
    this.hud.notify('LEAP OF FAITH', 1.6);
    return true;
  }

  _updateLeap(dt) {
    const L = this.leap;
    L.t = Math.min(1, L.t + dt / L.duration);
    const t = L.t * L.t * (1.6 - 0.6 * L.t);      // accelerates like a real fall
    const a = 1 - t;
    this.pos.set(
      a * a * L.p0.x + 2 * a * t * L.p1.x + t * t * L.p2.x,
      a * a * L.p0.y + 2 * a * t * L.p1.y + t * t * L.p2.y,
      a * a * L.p0.z + 2 * a * t * L.p1.z + t * t * L.p2.z);
    if (L.t >= 1) {
      this.state = 'ground'; this.grounded = true; this.leap = null; this.vel.set(0, 0, 0);
      this.cam.addShake(0.5);
      this.hud.notify('Hidden in the hay', 1.5);
    }
  }

  // ------------------------------------------------------------- swimming
  _enterWater() { this.state = 'swim'; this.vel.y = 0; this.sprinting = false; }

  _updateSwim(dt, input, wish) {
    const k = 1 - Math.exp(-4 * dt);
    this.vel.x += (wish.x * SWIM - this.vel.x) * k;
    this.vel.z += (wish.z * SWIM - this.vel.z) * k;
    this.vel.y = 0;
    if (wish.lengthSq()) this._turnTowards(Math.atan2(wish.x, wish.z), dt, 5);
    this.pos.addScaledVector(this.vel, dt);
    this.pos.y = WATER_Y - 1.25;
    this.physics.resolveCylinder(this.pos, this.vel, this.radius, this.height, 0);
    this.pos.y = WATER_Y - 1.25;
    // Haul out onto docks / quays / hulls
    if (wish.lengthSq()) {
      const hit = this.physics.raycast(this.chest, wish.clone().normalize(), this.radius + 0.5, (c) => c.solid);
      if (hit && Math.abs(hit.normal.y) < 0.5) {
        const top = hit.collider.box.max.y;
        if (top - this.pos.y <= 3.2) this._startMantle(new THREE.Vector3(hit.point.x, top, hit.point.z).addScaledVector(hit.normal, -(this.radius + 0.3)), 0.55);
        else if (hit.collider.climbable) this._startClimb(hit);
      }
    }
    if (!this.physics.overlapsTag(this.pos, 0.1, 1.5, TAG.WATER)) this.state = 'air';
  }

  // --------------------------------------------------------------- combat
  _combatInput(input) {
    if (!this.director) return;
    if (input.mouse.leftPressed && this._attackCd <= 0) {
      this._attackCd = 0.45; this._swing = 0.3;
      this.director.playerAttack(this);
    }
    for (const [key, dir] of [['KeyQ', 'left'], ['KeyE', 'right'], ['KeyR', 'high']]) {
      if (!input.wasPressed(key)) continue;
      this._parryDir = dir; this._parryPose = 0.35;
      this.director.playerParry(this, dir);
    }
  }

  takeDamage(amount) {
    if (this.state === 'dead') return;
    this.health -= amount;
    this.cam.addShake(0.6);
    this.hud.damageFlash();
    if (this.health <= 0) {
      this.health = 0; this.state = 'dead'; this._deadTimer = 2.6;
      this.hud.desync(true);
    }
  }

  _updateDead(dt) {
    this._deadTimer -= dt;
    if (this._deadTimer > 0) return;
    this.pos.copy(this.respawnPoint); this.vel.set(0, 0, 0);
    this.world.preload(this.pos);
    this.health = 100; this.stamina = 100; this.state = 'air';
    this.director?.reset();
    this.hud.desync(false);
  }

  // -------------------------------------------------------- HUD prompts
  _prompts() {
    const p = [];
    if (this.onSync && this.state === 'ground') { p.push(['F', 'Synchronize'], ['SPACE', 'Leap of Faith']); }
    if (this.state === 'climb') p.push(['SPACE', 'Back eject'], ['C', 'Drop']);
    const t = this.director?.assassinationTarget(this);
    if (t) p.push(['LMB', 'Assassinate']);
    if (this.director?.threat) p.push(['Q / E / R', 'Parry left / right / high']);
    this.hud.setPrompts(p);
  }

  // ----------------------------------------------------------- animation
  /** Per render frame (not per physics step). */
  animate(dt) {
    const axes = this._axes || { active: false };
    const m = this.mesh;
    m.position.copy(this.pos);
    m.rotation.y = this.facing;
    const flatSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (this.state === 'climb') this._anim += dt * (axes.active ? 6 : 0);
    else this._anim += dt * flatSpeed * 1.7;
    let pitch = 0, lift = 0;
    if (this.state === 'leap') pitch = THREE.MathUtils.lerp(0.1, Math.PI * 0.5, Math.min(1, this.leap.t * 1.5));
    else if (this.state === 'swim') { pitch = 1.2; lift = 0.9; }
    else if (this.state === 'dead') pitch = -Math.min(1.45, (2.6 - this._deadTimer) * 3);
    m.rotation.x += (pitch - m.rotation.x) * (1 - Math.exp(-12 * dt));
    m.position.y += lift;
    if (this._swing > 0) this._swing -= dt;
    const threat = this.director?.threat;
    this.character.update(dt, {
      speed: this.state === 'swim' ? 2 : flatSpeed, state: this.state, phase: this._anim,
      swing: this._swing > 0 ? 1 - this._swing / 0.3 : 0,
      parry: this._parryPose > 0 ? this._parryDir : null,
      leap: this.leap?.t ?? 0, weapon: this._swing > 0 || !!threat || this.director?.inCombat,
    });
    this._parryPose = Math.max(0, (this._parryPose || 0) - dt);
  }
}
