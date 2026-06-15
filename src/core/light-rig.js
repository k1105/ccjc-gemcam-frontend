import * as THREE from 'three';

/**
 * 配置ライト（generate.lights）を THREE ライトとしてシーンへ反映する共有リグ。
 * 本番（sequences/generate.enter）とエディタプレビュー（editor/preview-stage）の
 * 両方が同じ sync(configs) を回すので、見た目が一致する。
 *
 * ライト config 形（id 必須）:
 *   { id, type:'point'|'spot'|'directional', pos:[x,y,z], color:'#rrggbb', intensity,
 *     distance?, decay?,           // point / spot
 *     target?:[x,y,z], angle?, penumbra?,   // spot / directional（directional は target 方向）
 *     intensityKeys?:[{t,v}], colorKeys?:[{t,c}] }  // 時刻キーフレーム（点滅/パルス。t=絶対秒）
 *
 * setTime(t) で intensityKeys/colorKeys を線形補間して反映する（両端はホールド）。
 */
const _ca = new THREE.Color();
const _cb = new THREE.Color();

export class LightRig {
  constructor(scene) {
    this.scene = scene;
    this.entries = new Map(); // id -> { type, light, target, cfg }
  }

  /** configs に一致するよう THREE ライトを増減・更新（id でreconcile） */
  sync(configs = []) {
    const seen = new Set();
    for (const cfg of configs) {
      if (!cfg || !cfg.id) continue;
      seen.add(cfg.id);
      let e = this.entries.get(cfg.id);
      if (!e || e.type !== cfg.type) {
        if (e) this._remove(cfg.id);
        e = this._make(cfg.type);
        this.entries.set(cfg.id, e);
      }
      e.cfg = cfg; // setTime 用にキーフレーム参照を保持
      this._apply(e, cfg);
    }
    for (const id of [...this.entries.keys()]) if (!seen.has(id)) this._remove(id);
  }

  _make(type) {
    let light;
    let target = null;
    if (type === 'spot') {
      light = new THREE.SpotLight(0xffffff, 1);
      target = light.target;
      this.scene.add(target);
    } else if (type === 'directional') {
      light = new THREE.DirectionalLight(0xffffff, 1);
      target = light.target;
      this.scene.add(target);
    } else {
      light = new THREE.PointLight(0xffffff, 1);
    }
    this.scene.add(light);
    return { type, light, target };
  }

  _apply(e, cfg) {
    const l = e.light;
    l.color.set(cfg.color ?? '#ffffff');
    l.intensity = cfg.intensity ?? 1;
    if (Array.isArray(cfg.pos)) l.position.set(cfg.pos[0], cfg.pos[1], cfg.pos[2]);
    if (e.type === 'point' || e.type === 'spot') {
      l.distance = cfg.distance ?? 0;
      l.decay = cfg.decay ?? 2;
    }
    if (e.type === 'spot') {
      l.angle = cfg.angle ?? 0.5;
      l.penumbra = cfg.penumbra ?? 0.3;
    }
    if (e.target && Array.isArray(cfg.target)) {
      e.target.position.set(cfg.target[0], cfg.target[1], cfg.target[2]);
    }
  }

  _remove(id) {
    const e = this.entries.get(id);
    if (!e) return;
    this.scene.remove(e.light);
    if (e.target) this.scene.remove(e.target);
    e.light.dispose?.();
    this.entries.delete(id);
  }

  /** 時刻 t（絶対秒）の intensityKeys/colorKeys を補間して反映（キーが無ければ静的値のまま） */
  setTime(t) {
    for (const e of this.entries.values()) {
      const cfg = e.cfg;
      if (!cfg) continue;
      if (Array.isArray(cfg.intensityKeys) && cfg.intensityKeys.length) {
        e.light.intensity = sampleScalar(cfg.intensityKeys, t);
      }
      if (Array.isArray(cfg.colorKeys) && cfg.colorKeys.length) {
        sampleColor(cfg.colorKeys, t, e.light.color);
      }
    }
  }

  dispose() {
    for (const id of [...this.entries.keys()]) this._remove(id);
  }
}

/** t 昇順にソートした配列（元配列は破壊しない。キー数は小さい前提） */
function sortedByT(keys) {
  return [...keys].sort((a, b) => a.t - b.t);
}

/** スカラーキー [{t,v}] を t で線形補間（両端ホールド） */
function sampleScalar(keys, t) {
  const k = sortedByT(keys);
  const n = k.length;
  if (t <= k[0].t) return k[0].v;
  if (t >= k[n - 1].t) return k[n - 1].v;
  for (let i = 0; i < n - 1; i++) {
    const a = k[i];
    const b = k[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const f = span > 1e-6 ? (t - a.t) / span : 0;
      return a.v + (b.v - a.v) * f;
    }
  }
  return k[n - 1].v;
}

/** カラーキー [{t,c('#rrggbb')}] を t で線形補間して out(THREE.Color) へ */
function sampleColor(keys, t, out) {
  const k = sortedByT(keys);
  const n = k.length;
  if (t <= k[0].t) return out.set(k[0].c);
  if (t >= k[n - 1].t) return out.set(k[n - 1].c);
  for (let i = 0; i < n - 1; i++) {
    const a = k[i];
    const b = k[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const f = span > 1e-6 ? (t - a.t) / span : 0;
      _ca.set(a.c);
      _cb.set(b.c);
      return out.copy(_ca).lerp(_cb, f);
    }
  }
  return out.set(k[n - 1].c);
}
