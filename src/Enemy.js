// ============================================================================
// Enemy.js — Royal Navy / Redcoat guards: waypoint patrols, a true 3D view
// frustum (90° horizontal FOV, vertical limits, range) with line-of-sight
// raycasts, a Detection Gauge, alerting, musket fire, and a directional
// parry / counter combat loop coordinated by the EnemyDirector.
// ============================================================================
import * as THREE from 'three';

const VIEW_RANGE = 24;
const HALF_FOV_H = THREE.MathUtils.degToRad(45);   // 90° horizontal
const HALF_FOV_V = THREE.MathUtils.degToRad(38);
const ALERT_RADIUS = 18;
const SLEEP_DISTANCE = 110;
const DIRS = ['left', 'right', 'high'];

const _to = new THREE.Vector3();

export class Guard {
  constructor(scene, physics, route, index, character) {
    this.physics = physics;
    this.route = route;
    this.index = index;
    this.character = character;
    this.mesh = character.root;
    this.cone = buildViewCone();
    this.mesh.add(this.cone);
    scene.add(this.mesh);
    this.reset();
  }

  reset() {
    this.pos = this.route[0].clone();
    this.vel = new THREE.Vector3();
    this.facing = 0;
    this.wp = 1 % this.route.length;
    this.state = 'patrol';      // patrol | suspicious | combat | search | dead
    this.detection = 0;
    this.hp = 100;
    this.stagger = 0;
    this.lastSeen = null;
    this.lostTimer = 0; this.searchTimer = 0; this.waitTimer = 0;
    this.musket = { cd: 3 + Math.random() * 2, aim: 0 };
    this.dead = false; this._deathT = 0; this._anim = Math.random() * 6;
    this.canSee = false;
    this.mesh.visible = true;
    this.mesh.rotation.set(0, 0, 0);
  }

  get eye() { return new THREE.Vector3(this.pos.x, this.pos.y + 1.65, this.pos.z); }
  get forward() { return new THREE.Vector3(Math.sin(this.facing), 0, Math.cos(this.facing)); }
  distanceTo(p) { return this.pos.distanceTo(p); }

  // ---------------------------------------------------------------- vision
  /** 3D frustum test in the guard's local frame + LOS raycast. */
  canSeePlayer(player) {
    if (player.state === 'dead' || player.hidden) return false;
    const target = new THREE.Vector3(player.pos.x, player.pos.y + 1.3, player.pos.z);
    const eye = this.eye;
    _to.subVectors(target, eye);
    const dist = _to.length();
    if (dist > VIEW_RANGE) return false;
    if (dist < 1.6) return this.physics.lineOfSight(eye, target); // peripheral awareness

    const fwd = this.forward;
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
    const lz = _to.dot(fwd), lx = _to.dot(right), ly = _to.y;
    if (lz <= 0) return false;
    if (Math.abs(Math.atan2(lx, lz)) > HALF_FOV_H) return false;
    if (Math.abs(Math.atan2(ly, Math.hypot(lx, lz))) > HALF_FOV_V) return false;
    return this.physics.lineOfSight(eye, target);
  }

  // ---------------------------------------------------------------- update
  update(dt, player, director) {
    if (this.dead) return;
    const distToPlayer = this.distanceTo(player.pos);
    if (distToPlayer > SLEEP_DISTANCE) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    this.stagger = Math.max(0, this.stagger - dt);

    // Detection gauge
    this.canSee = this.canSeePlayer(player);
    if (this.canSee) {
      const closeness = 1 - distToPlayer / VIEW_RANGE;
      let rate = 0.45 * (1 + closeness * 3);
      if (player.sprinting) rate *= 1.8;
      if (player.state === 'climb') rate *= 1.4;
      if (this.state === 'suspicious' || this.state === 'search') rate *= 1.5;
      this.detection = Math.min(1, this.detection + rate * dt);
      this.lastSeen = player.pos.clone();
      this.lostTimer = 0;
    } else if (this.state !== 'combat') {
      this.detection = Math.max(0, this.detection - 0.18 * dt);
    }

    switch (this.state) {
      case 'patrol':
        this._patrol(dt);
        if (this.detection > 0.3) { this.state = 'suspicious'; this.waitTimer = 0; }
        break;
      case 'suspicious':
        if (this.lastSeen) {
          this._face(this.lastSeen, dt, 5);
          if (this.detection > 0.6) this._moveTo(this.lastSeen, 1.4, dt, 2);
          else this._halt(dt);
        }
        if (this.detection >= 1) director.alert(this, player);
        else if (this.detection <= 0) this.state = 'patrol';
        break;
      case 'search':
        this.searchTimer -= dt;
        if (this.lastSeen && this.pos.distanceTo(this.lastSeen) > 1.5) this._moveTo(this.lastSeen, 3, dt, 1);
        else { this._halt(dt); this.facing += dt * 1.4; }
        if (this.detection >= 1) director.alert(this, player);
        if (this.searchTimer <= 0) { this.state = 'patrol'; this.detection = 0.2; }
        break;
      case 'combat':
        this._combat(dt, player, director, distToPlayer);
        break;
    }
  }

  _combat(dt, player, director, dist) {
    if (!this.canSee) this.lostTimer += dt;
    if (this.lostTimer > 7 || player.state === 'dead') {
      this.state = 'search'; this.searchTimer = 7; this.detection = 0.7; return;
    }
    const goal = this.lastSeen || player.pos;
    this._face(player.pos, dt, 8);
    if (this.stagger > 0) return this._halt(dt);
    const heightGap = player.pos.y - this.pos.y;
    if (heightGap > 2.5) {
      // Target is up on a roof or rigging: hold ground and take a musket shot.
      this._halt(dt);
      this._musket(dt, player, director);
      return;
    }
    this.musket.aim = 0;
    // Circle the player at sword range, each guard on its own slot angle.
    const slot = (this.index * 2.39996) % (Math.PI * 2);
    const ring = director.attacker === this ? 1.5 : 2.8;
    const target = new THREE.Vector3(goal.x + Math.sin(slot) * ring, goal.y, goal.z + Math.cos(slot) * ring);
    if (dist > 1.3) this._moveTo(target, dist > 6 ? 5.2 : 2.4, dt, 0.3, false);
    else this._halt(dt);
  }

  _musket(dt, player, director) {
    const m = this.musket;
    m.cd -= dt;
    if (m.cd > 0) return;
    if (!this.canSee) { m.aim = 0; return; }
    m.aim += dt;
    director.musketAimed = Math.max(director.musketAimed, m.aim / 1.6);
    if (m.aim >= 1.6) {
      m.aim = 0; m.cd = 4 + Math.random() * 2;
      if (this.physics.lineOfSight(this.eye, player.chest)) { player.takeDamage(15); director.hud.notify('Musket shot!', 1.2); }
    }
  }

  _patrol(dt) {
    if (this.waitTimer > 0) { this.waitTimer -= dt; this._halt(dt); this.facing += Math.sin(this._anim) * dt * 0.6; return; }
    const target = this.route[this.wp];
    if (this._moveTo(target, 1.6, dt, 0.6)) {
      this.wp = (this.wp + 1) % this.route.length;
      this.waitTimer = 1.5 + Math.random() * 2;
    }
  }

  /** Steer toward target; returns true once within `arrive` metres. */
  _moveTo(target, speed, dt, arrive = 0.5, faceMove = true) {
    const dx = target.x - this.pos.x, dz = target.z - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < arrive) { this._halt(dt); return true; }
    const k = 1 - Math.exp(-8 * dt);
    this.vel.x += ((dx / d) * speed - this.vel.x) * k;
    this.vel.z += ((dz / d) * speed - this.vel.z) * k;
    if (faceMove) this._turn(Math.atan2(dx, dz), dt, 6);
    this._integrate(dt);
    return false;
  }

  _halt(dt) {
    const k = 1 - Math.exp(-10 * dt);
    this.vel.x -= this.vel.x * k; this.vel.z -= this.vel.z * k;
    this._integrate(dt);
  }

  _integrate(dt) {
    // Freeze in place while the chunk under this guard is streamed out.
    if (this.physics.groundHeight(this.pos, 4) === null) { this.vel.set(0, 0, 0); return null; }
    this.vel.y += this.physics.gravity * dt;
    this.pos.addScaledVector(this.vel, dt);
    const res = this.physics.resolveCylinder(this.pos, this.vel, 0.38, 1.8);
    if (this.pos.y < -2) { this.pos.copy(this.route[0]); this.vel.set(0, 0, 0); } // fell off the world
    return res;
  }

  _face(p, dt, rate) { this._turn(Math.atan2(p.x - this.pos.x, p.z - this.pos.z), dt, rate); }
  _turn(target, dt, rate) {
    let d = target - this.facing;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.facing += d * (1 - Math.exp(-rate * dt));
  }

  hit(dmg) {
    this.hp -= dmg;
    this.stagger = Math.max(this.stagger, 0.35);
    if (this.hp <= 0) this.kill();
  }

  kill() {
    this.dead = true; this.state = 'dead'; this.detection = 0; this._deathT = 0;
    this.cone.visible = false;
  }

  /** Per render frame: skinned animation, death fall and the view-cone tint. */
  animate(dt) {
    const m = this.mesh;
    if (!m.visible) return;
    m.position.copy(this.pos);
    m.rotation.y = this.facing;
    if (this.dead) {
      this._deathT = Math.min(1, this._deathT + dt * 2.2);
      m.rotation.x = -this._deathT * Math.PI / 2;
      m.position.y += 0.15 * this._deathT;
      if (this._deathT < 1) this.character.update(dt, { state: 'dead', speed: 0 });
      return;
    }
    const speed = Math.hypot(this.vel.x, this.vel.z);
    this._anim += dt * speed * 2.2;
    const atk = this._attackPose;
    m.rotation.x += ((this.stagger > 0 ? -0.2 : 0) - m.rotation.x) * (1 - Math.exp(-14 * dt));
    this.character.update(dt, {
      speed, state: 'ground', phase: this._anim,
      parry: atk && atk.p < 0.85 ? atk.dir : null,                 // telegraph: blade raised on the strike side
      swing: atk && atk.p >= 0.85 ? (atk.p - 0.85) / 0.15 : 0,
      aim: Math.min(1, this.musket.aim * 2),
      weapon: this.state === 'combat' && this.musket.aim === 0,
    });
    const c = this.cone.material;
    c.color.setRGB(1, 1 - this.detection * 0.7, 1 - this.detection);
    c.opacity = this.state === 'combat' ? 0.04 : 0.05 + this.detection * 0.12;
    this.cone.visible = Guard.showCones || this.detection > 0.05;
  }
}
Guard.showCones = false;

// ==========================================================================
export class EnemyDirector {
  constructor({ scene, physics, hud, cam, characters }) {
    Object.assign(this, { scene, physics, hud, cam, characters });
    this.guards = [];
    this.attacker = null;
    this.attack = null;           // { guard, dir, t, windup, window, early }
    this.cooldown = 1;
    this.threat = null;           // exposed to HUD / player prompts
    this.musketAimed = 0;
  }

  spawn(routes) {
    routes.forEach((route, i) => {
      const g = new Guard(this.scene, this.physics, route, i, this._redcoat());
      this.guards.push(g);
      if (route.length > 1 && i % 3 === 0) {           // a second guard on busy routes
        const g2 = new Guard(this.scene, this.physics, [...route].reverse(), i + 100, this._redcoat());
        this.guards.push(g2);
      }
    });
  }

  _redcoat() { return this.characters.create({ tint: 0xd8483a, outfit: 'guard' }); }

  animate(dt) { for (const g of this.guards) g.animate(dt); }

  reset() {
    for (const g of this.guards) g.reset();
    this.attacker = null; this.attack = null; this.threat = null;
  }

  get maxDetection() { return this.guards.reduce((m, g) => (g.dead ? m : Math.max(m, g.detection)), 0); }
  get inCombat() { return this.guards.some((g) => g.state === 'combat'); }

  alert(source, player) {
    for (const g of this.guards) {
      if (g.dead) continue;
      if (g === source || g.distanceTo(source.pos) < ALERT_RADIUS) {
        if (g.state !== 'combat') g.lostTimer = 0;
        g.state = 'combat'; g.detection = 1; g.lastSeen = player.pos.clone();
      }
    }
    if (!this._alerted) { this.hud.notify('You have been spotted!', 2); this._alerted = true; }
  }

  update(dt, player) {
    this.musketAimed = 0;
    for (const g of this.guards) g.update(dt, player, this);
    if (!this.inCombat) this._alerted = false;
    this._airAssassination(player);
    this._updateAttack(dt, player);
  }

  // Coordinated melee: one attacker at a time telegraphs a directional strike.
  _updateAttack(dt, player) {
    this.cooldown -= dt;
    if (this.attack) {
      const a = this.attack, g = a.guard;
      if (g.dead || g.stagger > 0 || player.state === 'dead') return this._endAttack(0.5);
      a.t += dt;
      const p = Math.min(1, a.t / a.windup);
      g._attackPose = { dir: a.dir, p };
      this.threat = { dir: a.dir, progress: p, inWindow: a.t >= a.windup - a.window, guard: g };
      if (a.t >= a.windup) {
        if (g.distanceTo(player.pos) < 3.2 && player.state !== 'dead') { player.takeDamage(18); this.hud.notify('Hit!', 0.6); }
        this._endAttack(0.7 + Math.random() * 0.8);
      }
      return;
    }
    if (this.cooldown > 0 || player.state === 'dead') return;
    let best = null, bestD = 3.6;
    for (const g of this.guards) {
      if (g.dead || g.state !== 'combat' || g.stagger > 0) continue;
      const d = g.distanceTo(player.pos);
      if (d < bestD && Math.abs(player.pos.y - g.pos.y) < 1.5) { best = g; bestD = d; }
    }
    if (best) {
      this.attacker = best;
      this.attack = { guard: best, dir: DIRS[Math.floor(Math.random() * 3)], t: 0, windup: 1.0, window: 0.38, early: false };
    }
  }

  _endAttack(cd) {
    if (this.attack) this.attack.guard._attackPose = null;
    this.attack = null; this.attacker = null; this.threat = null;
    this.cooldown = cd;
  }

  playerParry(player, dir) {
    const a = this.attack;
    if (!a) return;
    if (a.early) return;                           // spam protection
    const inWindow = a.t >= a.windup - a.window;
    if (!inWindow) { a.early = true; this.hud.notify('Too early!', 0.8); return; }
    if (dir !== a.dir) { a.early = true; this.hud.notify('Wrong direction!', 0.8); return; }
    a.guard.stagger = 1.4;
    this.hud.notify('PARRY! — Counter now (LMB)', 1.4);
    this.hud.parryFlash();
    this.cam.addShake(0.35);
    this._endAttack(1.2);
  }

  /** Unaware guard in reach, in front of the player → hidden-blade prompt. */
  assassinationTarget(player) {
    let best = null, bestD = 1.9;
    const fwd = player.forward;
    for (const g of this.guards) {
      if (g.dead || g.state === 'combat' || g.detection >= 1) continue;
      _to.subVectors(g.pos, player.pos);
      if (Math.abs(_to.y) > 1.2) continue;
      _to.y = 0;
      const d = _to.length();
      if (d < bestD && (d < 0.8 || _to.normalize().dot(fwd) > 0.3)) { best = g; bestD = d; }
    }
    return best;
  }

  playerAttack(player) {
    const sneak = this.assassinationTarget(player);
    if (sneak) {
      sneak.kill(); this.hud.notify('ASSASSINATED', 1.5); this.cam.addShake(0.25);
      this._witnesses(sneak, player);
      return;
    }
    let target = null, bestD = 2.6;
    const fwd = player.forward;
    for (const g of this.guards) {
      if (g.dead) continue;
      _to.subVectors(g.pos, player.pos); _to.y = 0;
      const d = _to.length();
      if (d < bestD && _to.normalize().dot(fwd) > 0.2) { target = g; bestD = d; }
    }
    if (!target) return;
    if (target.stagger > 0.4) { target.kill(); this.hud.notify('COUNTER KILL', 1.4); this.cam.addShake(0.4); return; }
    if (target.state !== 'combat') this.alert(target, player);
    if (Math.random() < 0.45) { this.hud.notify('Blocked', 0.6); return; }
    target.hit(34);
    if (target.dead) this.hud.notify('Redcoat down', 1);
  }

  _airAssassination(player) {
    if (player.state !== 'air' || player.vel.y > -3) return;
    for (const g of this.guards) {
      if (g.dead) continue;
      const dy = player.pos.y - g.pos.y;
      if (dy < 0.4 || dy > 2.6) continue;
      if (Math.hypot(player.pos.x - g.pos.x, player.pos.z - g.pos.z) < 1.1) {
        g.kill(); player.vel.y = 3;
        this.hud.notify('AIR ASSASSINATION', 1.6); this.cam.addShake(0.6);
        this._witnesses(g, player);
        return;
      }
    }
  }

  /** Guards who can see a kill become instantly suspicious. */
  _witnesses(victim, player) {
    for (const g of this.guards) {
      if (g.dead || g === victim) continue;
      if (g.distanceTo(victim.pos) < 15 && this.physics.lineOfSight(g.eye, victim.eye)) {
        g.detection = Math.max(g.detection, 0.75); g.lastSeen = player.pos.clone();
        if (g.state === 'patrol') g.state = 'suspicious';
      }
    }
  }
}

// ------------------------------------------------------------------- meshes
/** Visualised view frustum: apex at the eye, opening along +Z for VIEW_RANGE. */
function buildViewCone() {
  const radius = Math.tan(HALF_FOV_H) * VIEW_RANGE;
  const geo = new THREE.ConeGeometry(radius, VIEW_RANGE, 24, 1, true);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0, VIEW_RANGE / 2);
  geo.scale(1, Math.tan(HALF_FOV_V) / Math.tan(HALF_FOV_H), 1);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide });
  const cone = new THREE.Mesh(geo, mat);
  cone.position.y = 1.65;
  cone.renderOrder = 2;
  return cone;
}
