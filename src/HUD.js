// ============================================================================
// HUD.js — cinematic DOM HUD: health / stamina, per-guard detection diamonds,
// directional parry telegraph, prompts, banners, desync overlay and a perf
// panel. Drop SpriteCook art into public/assets/ui/ to skin it (see SKINS).
// ============================================================================
import * as THREE from 'three';

const SKINS = {           // element id -> SpriteCook PNG (falls back to CSS art if missing)
  'hud-vitals': 'vitals_frame.png',
  'hud-health-fill': 'health_fill.png',
  'hud-stamina-fill': 'stamina_fill.png',
  'hud-emblem': 'emblem.png',
  'hud-telegraph': 'parry_ring.png',
};

const CSS = `
#hud{position:fixed;inset:0;pointer-events:none;font-family:'IM Fell English SC','Georgia',serif;color:#f3ead7;text-shadow:0 2px 6px #000a;user-select:none}
#hud-vitals{position:absolute;left:36px;top:32px;width:340px;padding:14px 18px 14px 74px;background-size:100% 100%;
  background-color:#0d0f14aa;border:1px solid #c9a55a88;border-radius:4px;box-shadow:0 6px 30px #0008}
#hud-emblem{position:absolute;left:12px;top:50%;width:50px;height:50px;transform:translateY(-50%) rotate(45deg);border:2px solid #c9a55a;
  background:radial-gradient(circle,#8a1414 0 35%,#1b1b1b 36%);background-size:cover}
.hud-bar{height:12px;margin:5px 0;background:#0008;border:1px solid #c9a55a55;overflow:hidden}
.hud-bar>div{height:100%;transform-origin:left;background-size:100% 100%;transition:transform .08s linear}
#hud-health-fill{background:linear-gradient(90deg,#6d0c0c,#c62828)}
#hud-stamina-fill{background:linear-gradient(90deg,#9c7b2c,#f0cf6a)}
#hud-stamina-fill.exhausted{background:linear-gradient(90deg,#555,#888)}
.hud-label{font-size:12px;letter-spacing:3px;opacity:.8}
#hud-status{position:absolute;left:36px;top:130px;font-size:15px;letter-spacing:4px}
#hud-notify{position:absolute;top:18%;left:50%;transform:translateX(-50%);font-size:30px;letter-spacing:6px;transition:opacity .4s}
#hud-banner{position:absolute;top:38%;left:0;right:0;text-align:center;opacity:0;transition:opacity .8s}
#hud-banner h1{font-size:54px;margin:0;letter-spacing:12px;font-weight:normal}
#hud-banner p{font-size:20px;letter-spacing:4px;margin:6px 0 0;color:#e2c47c}
#hud-banner .rule{height:1px;width:520px;margin:12px auto;background:linear-gradient(90deg,transparent,#c9a55a,transparent)}
#hud-prompts{position:absolute;bottom:48px;left:50%;transform:translateX(-50%);display:flex;gap:26px;font-size:17px}
#hud-prompts kbd{display:inline-block;min-width:26px;padding:3px 8px;margin-right:8px;border:1px solid #c9a55a;border-radius:3px;
  background:#0d0f14cc;font-family:inherit;text-align:center}
#hud-telegraph{position:absolute;left:50%;top:50%;width:150px;height:150px;margin:-75px;border-radius:50%;opacity:0;
  background-size:cover;transition:opacity .1s}
#hud-telegraph svg{width:100%;height:100%}
#hud-telegraph .arrow{font-size:46px;position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.hud-diamond{position:absolute;width:22px;height:22px;margin:-11px;transform:rotate(45deg);border:2px solid #fff;overflow:hidden;background:#0006}
.hud-diamond>div{position:absolute;left:0;right:0;bottom:0;background:#f5d142}
.hud-diamond.alert{border-color:#e53935}.hud-diamond.alert>div{background:#e53935}
#hud-flash{position:absolute;inset:0;background:radial-gradient(circle,transparent 55%,#a0000088);opacity:0;transition:opacity .35s}
#hud-parry{position:absolute;inset:0;background:radial-gradient(circle,#fff6 0,transparent 60%);opacity:0;transition:opacity .25s}
#hud-desync{position:absolute;inset:0;background:#f4f1ea;color:#222;display:flex;align-items:center;justify-content:center;
  font-size:52px;letter-spacing:14px;opacity:0;transition:opacity 1.2s;text-shadow:none}
#hud-perf{position:absolute;right:14px;bottom:12px;font:12px/1.5 ui-monospace,monospace;color:#cde;background:#0008;padding:6px 10px;border-radius:3px;white-space:pre}
#hud-hidden{position:absolute;left:36px;top:156px;font-size:14px;letter-spacing:4px;color:#9fd18a;opacity:0;transition:opacity .2s}
`;

export class HUD {
  constructor(root = document.body) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.el = document.createElement('div');
    this.el.id = 'hud';
    this.el.innerHTML = `
      <div id="hud-vitals"><div id="hud-emblem"></div>
        <div class="hud-label">HEALTH</div><div class="hud-bar"><div id="hud-health-fill"></div></div>
        <div class="hud-label">STAMINA</div><div class="hud-bar"><div id="hud-stamina-fill"></div></div></div>
      <div id="hud-status"></div><div id="hud-hidden">◈ HIDDEN</div>
      <div id="hud-markers"></div>
      <div id="hud-notify"></div>
      <div id="hud-banner"><div class="rule"></div><h1></h1><p></p><div class="rule"></div></div>
      <div id="hud-telegraph"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="none" stroke="#fff3" stroke-width="5"/>
        <circle id="hud-tele-ring" cx="50" cy="50" r="44" fill="none" stroke="#f5d142" stroke-width="5" stroke-dasharray="276.5" stroke-dashoffset="276.5" transform="rotate(-90 50 50)"/></svg>
        <div class="arrow" id="hud-tele-arrow"></div></div>
      <div id="hud-prompts"></div>
      <div id="hud-flash"></div><div id="hud-parry"></div>
      <div id="hud-desync">DESYNCHRONIZED</div>
      <div id="hud-perf"></div>`;
    root.appendChild(this.el);
    this.$ = (id) => this.el.querySelector(`#${id}`);
    this._notifyT = 0; this._bannerT = 0; this._promptKey = '';
    this.markers = [];
    this.showPerf = true;
    this._applySkins();
  }

  /** SpriteCook skins: only swap in when the PNG actually loads. */
  _applySkins(base = 'assets/ui/') {
    for (const [id, file] of Object.entries(SKINS)) {
      const img = new Image();
      img.onload = () => {
        const el = this.$(id);
        el.style.backgroundImage = `url(${img.src})`;
        el.style.backgroundColor = 'transparent';
        if (id === 'hud-vitals') el.style.border = 'none';
      };
      img.src = base + file;
    }
  }

  notify(text, seconds = 1.5) {
    if (!text) return;
    const n = this.$('hud-notify');
    n.textContent = text; n.style.opacity = 1;
    this._notifyT = seconds;
  }

  banner(title, subtitle = '', seconds = 3.5) {
    const b = this.$('hud-banner');
    b.querySelector('h1').textContent = title;
    b.querySelector('p').textContent = subtitle;
    b.style.opacity = 1;
    this._bannerT = seconds;
  }

  setPrompts(list) {
    const key = list.map((p) => p.join()).join('|');
    if (key === this._promptKey) return;
    this._promptKey = key;
    this.$('hud-prompts').innerHTML = list.map(([k, t]) => `<span><kbd>${k}</kbd>${t}</span>`).join('');
  }

  damageFlash() { const f = this.$('hud-flash'); f.style.opacity = 1; setTimeout(() => (f.style.opacity = 0), 120); }
  parryFlash() { const f = this.$('hud-parry'); f.style.opacity = 1; setTimeout(() => (f.style.opacity = 0), 90); }
  desync(on) { this.$('hud-desync').style.opacity = on ? 1 : 0; }

  update(dt, { player, director, camera, perf }) {
    this.$('hud-health-fill').style.transform = `scaleX(${player.health / 100})`;
    const st = this.$('hud-stamina-fill');
    st.style.transform = `scaleX(${player.stamina / 100})`;
    st.classList.toggle('exhausted', player.exhausted);

    const status = director.inCombat ? '⚔ CONFLICT' : director.maxDetection > 0.3 ? '◆ SUSPICIOUS' : '';
    this.$('hud-status').textContent = status;
    this.$('hud-status').style.color = director.inCombat ? '#ff6b5e' : '#f5d142';
    this.$('hud-hidden').style.opacity = player.hidden ? 1 : 0;

    if (this._notifyT > 0 && (this._notifyT -= dt) <= 0) this.$('hud-notify').style.opacity = 0;
    if (this._bannerT > 0 && (this._bannerT -= dt) <= 0) this.$('hud-banner').style.opacity = 0;

    this._updateTelegraph(director);
    this._updateMarkers(director, camera);

    const pf = this.$('hud-perf');
    pf.style.display = this.showPerf ? 'block' : 'none';
    if (this.showPerf && perf) {
      pf.textContent = `FPS ${perf.fps.toFixed(0).padStart(3)}  ${perf.ms.toFixed(1)} ms\n` +
        `draw calls ${perf.calls}  tris ${(perf.tris / 1000).toFixed(0)}k\n` +
        `chunks ${perf.chunks} loaded / ${perf.visible} in frustum\n` +
        `res scale ${perf.scale.toFixed(2)}  state ${player.state}`;
    }
  }

  _updateTelegraph(director) {
    const t = director.threat, el = this.$('hud-telegraph');
    if (!t) { el.style.opacity = 0; return; }
    el.style.opacity = 1;
    this.$('hud-tele-ring').setAttribute('stroke-dashoffset', String(276.5 * (1 - t.progress)));
    this.$('hud-tele-ring').setAttribute('stroke', t.inWindow ? '#e53935' : '#f5d142');
    this.$('hud-tele-arrow').textContent = { left: '◀ Q', right: 'E ▶', high: '▲ R' }[t.dir];
  }

  _updateMarkers(director, camera) {
    const layer = this.$('hud-markers');
    const v = new THREE.Vector3();
    let used = 0;
    for (const g of director.guards) {
      if (g.dead || g.detection <= 0.02 || !g.mesh.visible) continue;
      v.set(g.pos.x, g.pos.y + 2.35, g.pos.z).project(camera);
      if (v.z > 1) continue;
      let m = this.markers[used];
      if (!m) { m = document.createElement('div'); m.className = 'hud-diamond'; m.appendChild(document.createElement('div')); layer.appendChild(m); this.markers.push(m); }
      m.style.display = 'block';
      m.style.left = `${THREE.MathUtils.clamp((v.x * 0.5 + 0.5) * innerWidth, 20, innerWidth - 20)}px`;
      m.style.top = `${THREE.MathUtils.clamp((-v.y * 0.5 + 0.5) * innerHeight, 20, innerHeight - 20)}px`;
      m.firstChild.style.height = `${g.detection * 100}%`;
      m.classList.toggle('alert', g.state === 'combat');
      used++;
    }
    for (let i = used; i < this.markers.length; i++) this.markers[i].style.display = 'none';
  }
}
