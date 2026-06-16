import * as THREE from 'three';

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

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);

    this._loop = this._loop.bind(this);
    this._rafId = requestAnimationFrame(this._loop);
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

    this.renderer.render(this.scene, this.camera);
  }

  _onResize() {
    this.width = this.container.clientWidth;
    this.height = this.container.clientHeight;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height);
  }

  dispose() {
    this.running = false;
    if (this._rafId !== null) cancelAnimationFrame(this._rafId);
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
