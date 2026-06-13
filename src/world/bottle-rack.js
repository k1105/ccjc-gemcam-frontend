import * as THREE from 'three';
import gsap from 'gsap';
import { createBottle } from './bottle-factory.js';

/**
 * 10本のボトルラインナップ。アプリ起動時に1度だけ構築し、ループをまたいで再利用する。
 * - idle 揺れ（tick は main.js が world に常駐登録）
 * - selectAndSink(): 選択ボトルが回転しながら画面下へ沈む
 * - returnFromLeft(): 全ボトルが左から回転しながら定位置へ戻る
 */
export class BottleRack {
  constructor(brands, choreo) {
    this.brands = brands;
    this.choreo = choreo;
    this.group = new THREE.Group();
    this.bottles = new Map(); // slug -> { root, spin, baseX, index }
    this.swayEnabled = true;
  }

  async init(scene) {
    const cfg = this.choreo.data.select.rack;
    const n = this.brands.list.length;
    const totalWidth = cfg.spacing * (n - 1);

    const created = await Promise.all(this.brands.list.map((b) => createBottle(b)));

    created.forEach((model, i) => {
      const brand = this.brands.list[i];
      // root: 配置・沈下移動用 / spin: 回転・揺れ用（分離して tween 干渉を防ぐ）
      const root = new THREE.Group();
      const spin = new THREE.Group();
      spin.add(model);
      root.add(spin);

      const baseX = -totalWidth / 2 + i * cfg.spacing;
      root.position.set(baseX, 0, 0);
      this.group.add(root);
      this.bottles.set(brand.slug, { root, spin, baseX, index: i });
    });

    this.group.position.set(0, cfg.y, cfg.z);
    scene.add(this.group);
  }

  setVisible(visible) {
    this.group.visible = visible;
  }

  /** エディタからの spacing/y/z 変更を待機中レイアウトへ即反映 */
  applyLayout() {
    const cfg = this.choreo.data.select.rack;
    const n = this.brands.list.length;
    const totalWidth = cfg.spacing * (n - 1);
    for (const entry of this.bottles.values()) {
      entry.baseX = -totalWidth / 2 + entry.index * cfg.spacing;
      entry.root.position.x = entry.baseX;
    }
    this.group.position.set(0, cfg.y, cfg.z);
  }

  /** main.js から world.addTickable で常駐登録される */
  tick = (dt, elapsed) => {
    if (!this.group.visible || !this.swayEnabled) return;
    const cfg = this.choreo.data.select.rack;
    let i = 0;
    for (const { spin } of this.bottles.values()) {
      const phase = i * 0.7;
      spin.rotation.y = Math.sin(elapsed * cfg.idleSwaySpeed + phase) * 0.35 + phase;
      spin.position.y = Math.sin(elapsed * cfg.idleSwaySpeed * 1.3 + phase) * cfg.idleSwayAmp;
      i++;
    }
  };

  getBottleWorldPos(slug, out = new THREE.Vector3()) {
    const entry = this.bottles.get(slug);
    if (!entry) return out.set(0, 0, 0);
    return entry.root.getWorldPosition(out);
  }

  /** 選択ボトルを回転させながら画面下へ沈めて非表示にする */
  selectAndSink(slug, bag) {
    const cfg = this.choreo.data.select.sink;
    const entry = this.bottles.get(slug);
    if (!entry) return Promise.resolve();

    this.swayEnabled = false;
    return new Promise((resolve) => {
      const tl = bag.timeline({ onComplete: resolve });
      tl.to(entry.spin.rotation, {
        y: entry.spin.rotation.y + Math.PI * 2 * cfg.rotations,
        duration: cfg.duration,
        ease: 'power1.in',
      }, cfg.preDelay);
      tl.to(entry.root.position, {
        y: cfg.dropY,
        duration: cfg.duration,
        ease: cfg.ease,
      }, cfg.preDelay);
      tl.add(() => {
        entry.root.visible = false;
      });
      tl.to({}, { duration: cfg.postDelay });
    });
  }

  /** 強制リセット用: 全ボトルを即座に定位置へ */
  resetInstant() {
    for (const { root, spin, baseX } of this.bottles.values()) {
      gsap.killTweensOf(root.position);
      gsap.killTweensOf(spin.rotation);
      root.visible = true;
      root.position.set(baseX, 0, 0);
      spin.position.set(0, 0, 0);
      spin.rotation.set(0, 0, 0);
    }
    this.swayEnabled = true;
  }

  /** returnFromBelow の前準備: 全ボトルを定位置xのまま画面下に隠しておく */
  prepareReturn() {
    const cfg = this.choreo.data.select.return;
    this.swayEnabled = false;
    for (const entry of this.bottles.values()) {
      entry.root.visible = false;
      entry.root.position.set(entry.baseX, cfg.fromY, 0);
      entry.spin.position.set(0, 0, 0);
    }
  }

  /** 左のボトルから順に、下から定位置へフレームイン（y座標のみ変化。リザルト後→SELECT） */
  returnFromBelow(bag) {
    const cfg = this.choreo.data.select.return;
    this.swayEnabled = false;

    const entries = [...this.bottles.values()].sort((a, b) => a.index - b.index);
    return new Promise((resolve) => {
      const tl = bag.timeline({
        onComplete: () => {
          this.swayEnabled = true;
          resolve();
        },
      });
      entries.forEach((entry, i) => {
        const start = i * cfg.stagger;
        tl.add(() => {
          entry.root.visible = true;
        }, start);
        tl.fromTo(entry.root.position,
          { x: entry.baseX, y: cfg.fromY },
          { y: 0, duration: cfg.perBottle, ease: cfg.ease },
          start
        );
        tl.fromTo(entry.spin.rotation,
          { y: -Math.PI * 2 * cfg.rotations },
          { y: 0, duration: cfg.perBottle, ease: cfg.ease },
          start
        );
      });
    });
  }

  dispose(scene) {
    scene.remove(this.group);
    this.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((m) => {
          for (const v of Object.values(m)) {
            if (v && v.isTexture) v.dispose();
          }
          m.dispose();
        });
      }
    });
  }
}
