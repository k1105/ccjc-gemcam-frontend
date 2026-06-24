import * as THREE from 'three';
import gsap from 'gsap';
import { createBottlePlane } from './bottle-factory.js';
import { playSfx } from '../core/audio.js';

/**
 * 10本のボトルラインナップ。アプリ起動時に1度だけ構築し、ループをまたいで再利用する。
 * - idle 揺れ（tick は main.js が world に常駐登録）
 * - selectAndFrameOut(): 選択ボトルを拡大、非選択を左右へフレームアウト（選択は色帯が通過して覆う）
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
    const created = await Promise.all(this.brands.list.map((b) => createBottlePlane(b)));
    const baseXs = this._computeBaseXs();

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

      const baseX = baseXs[i];
      root.position.set(baseX, 0, 0);
      // クリック選択（エディタの個別調整）で slug を辿れるよう root に持たせる
      root.userData.slug = brand.slug;
      this.group.add(root);
      // model は createBottlePlane の返す板グループ。サイズ・ベースラインの
      // 個別オーバーライドはこの model に効かせる（spin は選択強調アニメ専用なので分離）
      this.bottles.set(brand.slug, { root, spin, model, baseX, index: i, mats });
    });

    this.group.position.set(0, cfg.y, cfg.z);
    this.applyOverrides();
    scene.add(this.group);
  }

  /**
   * 飲料ごとのサイズ・ベースラインのオーバーライドを各 model へ反映する。
   * choreo.data.select.rack.overrides[slug] = { scale, baselineY }（未指定は等倍・0）。
   * spin の選択強調 scale とは独立に効くよう、内側の model に適用する。
   */
  applyOverrides() {
    const overrides = this.choreo.data.select.rack.overrides || {};
    for (const [slug, entry] of this.bottles) {
      const o = overrides[slug] || {};
      entry.model.scale.setScalar(typeof o.scale === 'number' ? o.scale : 1);
      entry.model.position.y = typeof o.baselineY === 'number' ? o.baselineY : 0;
    }
  }

  /**
   * 各ボトルの基準X座標を index 順で算出する。基本は spacing 等間隔だが、
   * overrides[slug].marginRight があればそのボトルの右側に隙間を足し、
   * 後続のボトルを右へ押し出す（累積）。全体は中央寄せに正規化する。
   * marginRight が全て 0 のときは従来の -totalWidth/2 + i*spacing と一致する。
   */
  _computeBaseXs() {
    const cfg = this.choreo.data.select.rack;
    const overrides = cfg.overrides || {};
    const xs = [];
    let cursor = 0;
    this.brands.list.forEach((b, i) => {
      xs.push(cursor);
      const mr = overrides[b.slug]?.marginRight;
      cursor += cfg.spacing + (typeof mr === 'number' ? mr : 0);
    });
    const totalWidth = xs.length ? xs[xs.length - 1] : 0; // 末尾ボトルの位置 = ラック全幅
    return xs.map((x) => x - totalWidth / 2);
  }

  setVisible(visible) {
    this.group.visible = visible;
  }

  /** エディタからの spacing/y/z/marginRight 変更を待機中レイアウトへ即反映 */
  applyLayout() {
    const cfg = this.choreo.data.select.rack;
    const baseXs = this._computeBaseXs();
    for (const entry of this.bottles.values()) {
      entry.baseX = baseXs[entry.index];
      entry.root.position.x = entry.baseX;
    }
    this.group.position.set(0, cfg.y, cfg.z);
    this.applyOverrides();
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

  /**
   * 選択演出（待機画面）:
   *  step1: 選択ボトルを scale 倍に拡大し、非選択ボトルを左右へフレームアウトさせる
   *         （選択より左にあるボトルは左、右にあるボトルは右へ）。
   *  step2: 選択ボトルは拡大したまま定位置に残し、下から上へ通過する色帯で覆い隠す
   *         （持ち上げはしない）。
   * step2 開始時（色帯起動タイミング）に onStep2 を1度呼び（呼び出し側が色帯演出を起動）、
   * 同時に返り値の Promise を解決して制御を返す。拡大状態のまま残る選択ボトルは
   * SHOOT 遷移時の disposeAll 後も 3D シーンに留まるが、その頃には色帯が全画面を
   * 覆っているため見えず、次サイクルの prepareReturn / resetInstant で初期化される。
   */
  selectAndFrameOut(slug, bag, onStep2) {
    const t = this.choreo.data.select.transition;
    const entry = this.bottles.get(slug);
    if (!entry) {
      onStep2?.();
      return Promise.resolve();
    }

    this.swayEnabled = false;
    return new Promise((resolve) => {
      const tl = bag.timeline();

      // step1: 選択ボトルを拡大
      tl.to(entry.spin.scale, {
        x: t.scale, y: t.scale, z: t.scale,
        duration: t.scaleDuration, ease: t.scaleEase,
      }, 0);

      // step1: 非選択ボトルを左右へフレームアウト（中心＝選択に近い順にわずかにずらす）
      const others = [...this.bottles.values()]
        .filter((o) => o !== entry)
        .sort((a, b) => Math.abs(a.index - entry.index) - Math.abs(b.index - entry.index));
      const stagger = t.sideStagger ?? 0;
      let sideOutEnd = 0; // 全非選択ボトルが左右へ抜けきる時刻
      others.forEach((other) => {
        const dir = other.index < entry.index ? -1 : 1;
        const dist = Math.abs(other.index - entry.index);
        const at = (dist - 1) * stagger;
        sideOutEnd = Math.max(sideOutEnd, at + t.sideDuration);
        tl.to(other.root.position, {
          x: other.baseX + dir * t.sideX,
          duration: t.sideDuration, ease: t.sideEase,
        }, at);
      });

      // step2: 非選択が抜けきってから hold ぶん間を置いて色帯を起動（onStep2）。
      // 選択ボトルは拡大したまま定位置に残し、下から上へ通過する色帯で覆い隠す
      // （持ち上げるとベースラインが揃わず崩れて見えるため、移動はさせない）。
      // 開始時に制御を呼び出し側へ返す（拡大より左右フレームアウトの方が長いので後者を基準にする）。
      const bandAt = Math.max(t.scaleDuration, sideOutEnd) + (t.hold ?? 0);
      tl.add(() => {
        onStep2?.();
        resolve();
      }, bandAt);
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
