import * as THREE from 'three';
import gsap from 'gsap';
import { createBottlePlane } from './bottle-factory.js';
import { playSfx } from '../core/audio.js';

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

    const created = await Promise.all(this.brands.list.map((b) => createBottlePlane(b)));

    created.forEach((model, i) => {
      const brand = this.brands.list[i];
      // root: 配置・沈下移動用 / spin: 回転・揺れ用（分離して tween 干渉を防ぐ）
      const root = new THREE.Group();
      const spin = new THREE.Group();
      spin.add(model);
      root.add(spin);

      // 選択時の opacity 演出用に、このボトルの全マテリアルを集めておく
      const mats = [];
      model.traverse((o) => {
        if (!o.material) return;
        const a = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of a) {
          m.transparent = true; // opacity を効かせるため
          mats.push(m);
        }
      });

      const baseX = -totalWidth / 2 + i * cfg.spacing;
      root.position.set(baseX, 0, 0);
      this.group.add(root);
      this.bottles.set(brand.slug, { root, spin, baseX, index: i, mats });
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
    // 上下の浮遊モーションは廃止。各ボトルは静止させる
    for (const { spin } of this.bottles.values()) {
      spin.position.y = 0;
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
    const hl = this.choreo.data.select.highlight;
    const entry = this.bottles.get(slug);
    if (!entry) return Promise.resolve();

    this.swayEnabled = false;
    return new Promise((resolve) => {
      const tl = bag.timeline({ onComplete: resolve });

      // 選択強調: 非選択ボトルを opacity=dimOpacity へ、選択ボトルを scale 倍へ。
      // いずれも滑らかなイージングで t=0 から同時に進める。
      let sinkAt = cfg.preDelay;
      if (hl) {
        for (const other of this.bottles.values()) {
          if (other === entry) continue;
          for (const m of other.mats) {
            tl.to(m, { opacity: hl.dimOpacity, duration: hl.duration, ease: hl.ease }, 0);
          }
        }
        tl.to(entry.spin.scale, {
          x: hl.scale, y: hl.scale, z: hl.scale,
          duration: hl.duration, ease: hl.ease,
        }, 0);
        // 強調を見せきってから沈める（hold ぶん間を置く）
        sinkAt = hl.duration + (hl.hold ?? 0) + cfg.preDelay;
      }

      // 画像板なので回転はさせず、下へ沈める動きだけ
      tl.to(entry.root.position, {
        y: cfg.dropY,
        duration: cfg.duration,
        ease: cfg.ease,
      }, sinkAt);
      tl.add(() => {
        entry.root.visible = false;
      });
      tl.to({}, { duration: cfg.postDelay });
    });
  }

  /** 強制リセット用: 全ボトルを即座に定位置へ */
  resetInstant() {
    for (const { root, spin, baseX, mats } of this.bottles.values()) {
      gsap.killTweensOf(root.position);
      gsap.killTweensOf(spin.rotation);
      gsap.killTweensOf(spin.scale);
      mats.forEach((m) => gsap.killTweensOf(m));
      root.visible = true;
      root.position.set(baseX, 0, 0);
      spin.position.set(0, 0, 0);
      spin.rotation.set(0, 0, 0);
      spin.scale.set(1, 1, 1);
      mats.forEach((m) => { m.opacity = 1; });
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
      // 前ループで付いた選択強調（拡大・減光）を戻す
      entry.spin.scale.set(1, 1, 1);
      entry.mats.forEach((m) => { m.opacity = 1; });
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
          playSfx(this.choreo, 'bottleSlideIn'); // 各ボトルの下からのスライドインに同期
        }, start);
        tl.fromTo(entry.root.position,
          { x: entry.baseX, y: cfg.fromY },
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
