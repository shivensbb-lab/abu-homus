// ============================================================================
// Input.js — keyboard + pointer-lock mouse state with per-frame edge events.
// ============================================================================
export class Input {
  constructor(element) {
    this.element = element;
    this.down = new Set();
    this.pressed = new Set();   // keys that went down this frame
    this.mouse = { dx: 0, dy: 0, left: false, right: false, leftPressed: false, rightPressed: false };
    this.locked = false;
    this.fallback = false;      // playing without pointer lock (embedded frames, some app views)
    this.sensitivity = 0.0022;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.add(e.code);
      if (['Space', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
      if (e.code === 'Escape' && this.fallback) this._setFallback(false);
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());

    element.addEventListener('mousedown', (e) => {
      if (!this.active) return;
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftPressed = true; }
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightPressed = true; }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.active) return;
      this.mouse.dx += e.movementX;
      this.mouse.dy += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === element;
      if (this.locked) this.fallback = false;
      dispatchEvent(new Event('inputchange'));
    });
  }

  get active() { return this.locked || this.fallback; }

  _setFallback(on) { this.fallback = on; dispatchEvent(new Event('inputchange')); }

  /** Try pointer lock; if the frame refuses it, play with free mouse look instead. */
  requestLock() {
    let settled = false;
    const fail = () => { if (!settled && !this.locked) { settled = true; this._setFallback(true); } };
    try {
      const r = this.element.requestPointerLock?.();
      if (r && typeof r.catch === 'function') r.catch(fail);
      else if (!this.element.requestPointerLock) fail();
    } catch { fail(); }
    document.addEventListener('pointerlockerror', fail, { once: true });
    setTimeout(fail, 400);
  }

  isDown(code) { return this.down.has(code); }
  wasPressed(code) { return this.pressed.has(code); }

  /** Movement axes: x = strafe (D positive), y = forward (W positive). */
  moveAxes() {
    const x = (this.isDown('KeyD') ? 1 : 0) - (this.isDown('KeyA') ? 1 : 0);
    const y = (this.isDown('KeyW') ? 1 : 0) - (this.isDown('KeyS') ? 1 : 0);
    const len = Math.hypot(x, y) || 1;
    return { x: x / len, y: y / len, active: x !== 0 || y !== 0 };
  }

  /** Arrow keys turn the camera too (handy without a locked mouse). */
  keyLook(dt) {
    const x = (this.isDown('ArrowRight') ? 1 : 0) - (this.isDown('ArrowLeft') ? 1 : 0);
    const y = (this.isDown('ArrowDown') ? 1 : 0) - (this.isDown('ArrowUp') ? 1 : 0);
    this.mouse.dx += x * dt * 900; this.mouse.dy += y * dt * 500;
  }

  /** Call once at the end of every rendered frame. */
  endFrame() {
    this.pressed.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.leftPressed = false;
    this.mouse.rightPressed = false;
  }
}
