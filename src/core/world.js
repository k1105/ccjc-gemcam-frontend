import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  DepthOfFieldEffect,
  SMAAEffect,
} from 'postprocessing';
import { AfterimagePass } from '../world/afterimage-pass.js';

/**
 * 常駐3Dワールド。renderer / scene / camera / rAF ループを一元管理する。
 * シーケンスは addTickable() でフレーム更新関数を登録し、退場時に必ず remove する。
 */
export class World {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.width = this.container.clientWidth;
    this.height = this.container.clientHeight;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.1, 100);
    this.camera.position.set(0, 0.4, 4.2);
    this.camera.lookAt(0, 0.3, 0);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(this.width, this.height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.container.appendChild(this.renderer.domElement);

    // ガラス（transmission）マテリアルに映り込み・ハイライトを与えるための環境マップ（IBL）。
    // RoomEnvironment は外部 HDRI 不要の合成スタジオ環境。背景には使わず scene.environment にのみ適用し、
    // 単色背景（environment.js の #f5f5f7）の見た目は維持する。
    this._pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = this._pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.clock = new THREE.Clock();
    this.tickables = new Set();
    this.running = true;
    this._rafId = null;
    // デバッグエディタのタイムラインプレビューがカメラを占有している間 true。
    // カメラを毎フレーム動かす常駐 tick（SELECT のドリフト等）はこれを尊重する
    this.cameraLocked = false;
    // 全 tickable 実行後・render 直前に呼ばれるカメラ最終上書きフック。
    // overlay カット（割り込み）が base カメラの上に被さるために使う（GENERATE で設定）。
    // (dt:number, elapsed:number) => void
    this.cameraOverride = null;

    // ポストプロセス（setupPostFX で有効化）。無効時は null のまま renderer 直描画。
    this.composer = null;
    this.dof = null;
    this.afterimage = null;
    // DOF のフォーカス対象（world 座標 Vector3 の参照 / null=固定距離）。
    // シーケンスが setFocusTarget で主役（ボトル等）を指す。
    this.focusTarget = null;

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);

    this._loop = this._loop.bind(this);
    this._rafId = requestAnimationFrame(this._loop);
  }

  /**
   * ポストプロセス（被写界深度 + 残像モーションブラー + SMAA）を有効化する。
   * cfg.enabled が false / 未指定なら何もせず renderer 直描画のまま。
   * choreo.data.scene.postfx を main.js から渡す。
   *
   * tone mapping は three がレンダーターゲット描画でもシェーダ内で適用するため、
   * renderer.toneMapping（Neutral）はそのまま使い、最終パスで pmndrs が sRGB 変換する。
   * これで composer 経由でも既存の色味を維持する。
   */
  setupPostFX(cfg) {
    if (!cfg || !cfg.enabled || this.composer) return;

    // postprocessing は HalfFloat レンダーターゲット等の追加 WebGL 機能を要求する。
    // 非対応環境（貧弱な GPU / ソフトウェア GL）で初期化に失敗しても本編が落ちないよう、
    // 例外時は composer を破棄して renderer 直描画へ退避する（ブース運用の保険）。
    try {
      // HalfFloat: DOF のボケ階調や残像の蓄積でバンディングを出さないため
      this.composer = new EffectComposer(this.renderer, {
        frameBufferType: THREE.HalfFloatType,
      });
      this.composer.addPass(new RenderPass(this.scene, this.camera));

      const dofCfg = cfg.dof ?? {};
      if (dofCfg.enabled !== false) {
        this.dof = new DepthOfFieldEffect(this.camera, {
          focusDistance: dofCfg.focusDistance ?? 3.0, // world 単位（カメラからの距離）
          focusRange: dofCfg.focusRange ?? 4.0, // ピントが合う前後幅（大きいほど被写界深度が深い）
          bokehScale: dofCfg.bokehScale ?? 2.0, // ボケの強さ
          resolutionScale: dofCfg.resolutionScale ?? 0.5, // ボケ計算の内部解像度（負荷調整）
        });
        // 既に focusTarget があれば追従、無ければ focusDistance 固定
        this.dof.target = this.focusTarget;
        this.composer.addPass(new EffectPass(this.camera, this.dof));
      }
      // composer 経由ではキャンバスの MSAA が効かないため SMAA で輪郭を整える。
      // SMAA は convolution 系なので DOF とは別 EffectPass に分ける。
      this.composer.addPass(new EffectPass(this.camera, new SMAAEffect()));

      const aiCfg = cfg.afterimage ?? {};
      if (aiCfg.enabled !== false) {
        this.afterimage = new AfterimagePass(aiCfg.damp ?? 0.85);
        this.composer.addPass(this.afterimage);
      }

      this.composer.setSize(this.width, this.height);
    } catch (err) {
      console.error('[World] postprocessing 初期化失敗 — 直描画へ退避', err);
      this.composer?.dispose();
      this.composer = null;
      this.dof = null;
      this.afterimage = null;
    }
  }

  /**
   * DOF のフォーカス対象を設定する。world 座標の Vector3 を渡すとそこへ自動ピント、
   * null で固定距離（focusDistance）に戻る。Vector3 は参照で保持されるので、
   * 毎フレーム動く対象なら同じインスタンスの中身を更新すれば追従する。
   */
  setFocusTarget(vec3OrNull) {
    this.focusTarget = vec3OrNull ?? null;
    if (this.dof) this.dof.target = this.focusTarget;
  }

  addTickable(fn) {
    this.tickables.add(fn);
    return fn;
  }

  removeTickable(fn) {
    this.tickables.delete(fn);
  }

  _loop() {
    if (!this.running) return;
    this._rafId = requestAnimationFrame(this._loop);

    const dt = this.clock.getDelta();
    const elapsed = this.clock.elapsedTime;

    for (const fn of this.tickables) {
      fn(dt, elapsed);
    }
    // base カメラ確定後に overlay カットを上書き（tick 追加順に依存せず必ず最後に被さる）
    if (this.cameraOverride) this.cameraOverride(dt, elapsed);

    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  _onResize() {
    this.width = this.container.clientWidth;
    this.height = this.container.clientHeight;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height);
    // composer.setSize は内部で pixelRatio を考慮し renderer.setSize も呼ぶ
    this.composer?.setSize(this.width, this.height);
  }

  dispose() {
    this.running = false;
    if (this._rafId !== null) cancelAnimationFrame(this._rafId);
    window.removeEventListener('resize', this._onResize);
    this.scene.environment?.dispose();
    this._pmrem?.dispose();
    this.composer?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
