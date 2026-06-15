import * as THREE from 'three';
import { PhotoParticles } from '../world/photo-particles.js';
import { createBottle } from '../world/bottle-factory.js';
import { disposeObject3D } from '../core/resources.js';

/**
 * タイムラインプレビュー用のサンドボックス generate シーン。
 * 本番（sequences/generate.js enter）と同じ手順でテスト写真プレーン・
 * PhotoParticles・ターゲットボトルを構築する。撮影は不要（テストパターン画像）。
 *
 * PhotoParticles は uTime のステートレス解析関数なので setTime() で
 * 任意時刻へ正確にスクラブできる。プレーン⇔パーティクルの切替（swap）も
 * setTime() 内で時刻に応じて再現する。
 *
 * 編集セッション中だけ生きるリソースなので close() で必ず全破棄すること。
 */
export class PreviewStage {
  constructor(ctx) {
    this.ctx = ctx;
    this.opened = false;
    this.plane = null;
    this.planeTexture = null;
    this.particles = null;
    this.bottle = null;
    this.canvas = null;
    this._bottleToken = 0; // 非同期ロードの競合ガード
  }

  /** @param {object} brand 表示するボトルのブランド */
  async open(brand) {
    const { world, choreo } = this.ctx;
    const gcfg = choreo.data.generate;
    const ph0 = gcfg.shots.find((s) => s.type !== 'static') ?? gcfg.shots[0];

    // --- generate.enter 鏡像: shot0 開始カメラからフラスタムを満たすプレーン ---
    const camPos = Array.isArray(ph0.path?.[0])
      ? new THREE.Vector3(...ph0.path[0])
      : world.camera.position.clone();
    const fov = ph0.fov ? ph0.fov[0] : world.camera.fov;
    const lookPoint = new THREE.Vector3(...(ph0.lookAt?.point ?? [0, 0.5, 0]));
    const dist = camPos.distanceTo(lookPoint);
    const planeH = 2 * dist * Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    const planeW = planeH * world.camera.aspect;

    this.planeCenter = lookPoint;
    this.planeW = planeW;
    this.planeH = planeH;

    this.canvas = makeTestPattern(640, Math.round(640 / world.camera.aspect));
    this.planeTexture = new THREE.CanvasTexture(this.canvas);
    this.planeTexture.colorSpace = THREE.SRGBColorSpace;
    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(planeW, planeH),
      new THREE.MeshBasicMaterial({ map: this.planeTexture, toneMapped: false })
    );
    this.plane.position.copy(lookPoint);
    world.scene.add(this.plane);

    const bottleScale = gcfg.bottleScale ?? 1.6;
    this.bottleCenter = new THREE.Vector3(...gcfg.bottlePos).add(
      new THREE.Vector3(0, 0.4 * bottleScale, 0)
    );

    this._buildParticles();
    await this.setBrand(brand);
    this.opened = true;
  }

  _buildParticles() {
    const { world, choreo } = this.ctx;
    this.particles = new PhotoParticles(world, choreo.data.generate.particles);
    this.particles.buildFromCanvas(this.canvas, {
      planeCenter: this.planeCenter,
      planeW: this.planeW,
      planeH: this.planeH,
      target: this.bottleCenter,
    });
    this.particles.points.visible = false;
    world.scene.add(this.particles.points);
  }

  /** particles パラメータ変更後の再構築（uniform は build 時に焼かれるため） */
  rebuildParticles() {
    if (!this.particles) return;
    const visible = this.particles.points.visible;
    const time = this.particles.time;
    this.particles.dispose(this.ctx.world.scene);
    this._buildParticles();
    this.particles.points.visible = visible;
    this.particles.setTime(time);
  }

  /** ボトルの差し替え（プレビューの見た目のみ。ベイクには影響しない） */
  async setBrand(brand) {
    const { world, choreo } = this.ctx;
    const token = ++this._bottleToken;
    if (this.bottle) {
      disposeObject3D(this.bottle);
      this.bottle = null;
    }
    if (!brand) return;
    const model = await createBottle(brand);
    if (token !== this._bottleToken) return; // 連打で古いロードが勝つのを防ぐ
    const gcfg = choreo.data.generate;
    model.position.set(...gcfg.bottlePos);
    model.scale.setScalar(gcfg.bottleScale ?? 1.6);
    world.scene.add(model);
    this.bottle = model;
  }

  /**
   * タイムライン時刻 T を反映。swapTime（photoRecede 終了時刻）より前は
   * 写真プレーン、以降はパーティクル（particleTime = T - swapTime）。
   */
  setTime(T, swapTime) {
    if (!this.particles) return;
    const swapped = swapTime !== null && T >= swapTime;
    if (this.plane) this.plane.visible = !swapped;
    this.particles.points.visible = swapped;
    this.particles.setTime(swapped ? T - swapTime : 0);
  }

  /** camera-simulator へ渡す hero 供給（particleTime 基準） */
  heroPos(out, particleTime) {
    if (!this.particles) return out.set(0, 0, 0);
    return this.particles.getHeroPosition(out, particleTime);
  }

  close() {
    const { world } = this.ctx;
    this._bottleToken++;
    if (this.plane) {
      world.scene.remove(this.plane);
      this.plane.geometry.dispose();
      this.plane.material.dispose();
      this.plane = null;
    }
    if (this.planeTexture) {
      this.planeTexture.dispose();
      this.planeTexture = null;
    }
    if (this.particles) {
      this.particles.dispose(world.scene);
      this.particles = null;
    }
    if (this.bottle) {
      disposeObject3D(this.bottle);
      this.bottle = null;
    }
    this.canvas = null;
    this.opened = false;
  }
}

/** 撮影写真の代わりに使うテストパターン（粒の色分布が分かるグラデ+グリッド） */
function makeTestPattern(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#e63946');
  grad.addColorStop(0.35, '#f4a261');
  grad.addColorStop(0.65, '#2a9d8f');
  grad.addColorStop(1, '#264653');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 2;
  const step = w / 10;
  for (let x = step; x < w; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = step; y < h; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(w * 0.5, h * 0.45, Math.min(w, h) * 0.08, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.font = `bold ${Math.round(h * 0.1)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('PREVIEW', w * 0.5, h * 0.75);
  return canvas;
}
