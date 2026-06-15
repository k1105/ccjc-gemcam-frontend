import * as THREE from 'three';

/**
 * 配置ライト（generate.lights）を THREE ライトとしてシーンへ反映する共有リグ。
 * 本番（sequences/generate.enter）とエディタプレビュー（editor/preview-stage）の
 * 両方が同じ sync(configs) を回すので、見た目が一致する。
 *
 * ライト config 形（id 必須）:
 *   { id, type:'point'|'spot'|'directional', pos:[x,y,z], color:'#rrggbb', intensity,
 *     distance?, decay?,           // point / spot
 *     target?:[x,y,z], angle?, penumbra? }  // spot / directional（directional は target 方向）
 */
export class LightRig {
  constructor(scene) {
    this.scene = scene;
    this.entries = new Map(); // id -> { type, light, target }
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

  dispose() {
    for (const id of [...this.entries.keys()]) this._remove(id);
  }
}
