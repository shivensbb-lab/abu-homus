// ============================================================================
// Camera.js — cinematic over-the-shoulder follow camera.
// Mouse drives yaw/pitch; the rig trails the player's rear vector with
// critically-damped smoothing and pulls in when geometry blocks the view.
// ============================================================================
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();

export class FollowCamera {
  constructor(aspect, physics) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.1, 1200);
    this.physics = physics;
    this.yaw = Math.PI;          // radians around +Y
    this.pitch = -0.18;          // radians, negative looks down
    this.distance = 3.4;
    this.shoulder = new THREE.Vector3(0.65, 1.62, 0); // right-shoulder offset
    this.currentDist = this.distance;
    this.pivot = new THREE.Vector3();
    this.baseFov = 62;
    this.fovKick = 0;            // added during sprint / leap
    this.shake = 0;
    this.orbit = null;           // { t, duration, center } during synchronisation
  }

  get forward() { return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }
  get right() { return new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }

  handleMouse(input) {
    if (this.orbit) return;
    this.yaw -= input.mouse.dx * input.sensitivity;
    this.pitch -= input.mouse.dy * input.sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.2, 0.75);
  }

  /** Sweeping 360° pan used when the player synchronises at a viewpoint. */
  startSyncOrbit(center, duration = 4.5) {
    this.orbit = { t: 0, duration, center: center.clone(), startYaw: this.yaw };
  }

  addShake(amount) { this.shake = Math.min(1, this.shake + amount); }

  update(dt, target, { sprinting = false, leaping = false, climbing = false } = {}) {
    if (this.orbit) return this._updateOrbit(dt);

    // Smooth pivot (player's upper body) — exponential damping is frame-rate independent.
    const pivotTarget = _v.copy(target);
    const k = 1 - Math.exp(-14 * dt);
    this.pivot.lerp(pivotTarget, k);

    const wantDist = climbing ? this.distance + 1.2 : leaping ? this.distance + 2.5 : this.distance;
    const wantFov = this.baseFov + (sprinting ? 8 : 0) + (leaping ? 14 : 0);
    this.camera.fov += (wantFov - this.camera.fov) * (1 - Math.exp(-5 * dt));
    this.camera.updateProjectionMatrix();

    // Orbit direction from yaw/pitch
    const cp = Math.cos(this.pitch);
    _dir.set(Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp); // points from pivot back to camera
    const shoulderWorld = this.right.multiplyScalar(this.shoulder.x);
    const origin = new THREE.Vector3().copy(this.pivot).add(shoulderWorld);
    origin.y += this.shoulder.y;

    // Collision: pull camera in front of anything solid between shoulder and camera
    let dist = wantDist;
    const hit = this.physics.raycast(origin, _dir, wantDist + 0.3, (c) => c.solid);
    if (hit) dist = Math.max(0.6, hit.distance - 0.3);
    // snap in fast, ease out slow
    const rate = dist < this.currentDist ? 25 : 4;
    this.currentDist += (dist - this.currentDist) * (1 - Math.exp(-rate * dt));

    this.camera.position.copy(origin).addScaledVector(_dir, this.currentDist);
    const lookAt = origin.clone().addScaledVector(_dir, -10);

    if (this.shake > 0) {
      const s = this.shake * this.shake * 0.15;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.shake = Math.max(0, this.shake - dt * 2.5);
    }
    this.camera.lookAt(lookAt);
  }

  _updateOrbit(dt) {
    const o = this.orbit;
    o.t += dt;
    const p = Math.min(1, o.t / o.duration);
    const ease = p * p * (3 - 2 * p);
    const angle = o.startYaw + ease * Math.PI * 2;
    const radius = 9 + Math.sin(p * Math.PI) * 6;
    const height = 3 + Math.sin(p * Math.PI) * 4;
    this.camera.position.set(
      o.center.x + Math.sin(angle) * radius,
      o.center.y + height,
      o.center.z + Math.cos(angle) * radius,
    );
    this.camera.lookAt(o.center.x, o.center.y + 1, o.center.z);
    if (p >= 1) { this.yaw = o.startYaw; this.orbit = null; }
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
