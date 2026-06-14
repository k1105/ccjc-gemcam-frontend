import * as THREE from 'three';
import gsap from 'gsap';
import {
  buildCurve,
  samplePath,
  applyLook,
  isKeyedOrientation,
  sampleAimPoint,
  smoothToPoint,
  FollowEvaluator,
  LoopEvaluator,
} from './camera-eval.js';

const _look = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _head = new THREE.Vector3();
const _center = new THREE.Vector3();

/**
 * choreography JSON の phase 定義（CatmullRom キーフレームパス）を再生するカメラ演出機。
 * - type:"path"  … duration/ease 付きの一方向パス（playPhase）
 * - type:"loop"  … 閉path を不定時間周回し、release() で脱出点へ寄せて終了（playLoop）
 * - lookAt は fixed（固定点）/ target（登録 supplier、毎フレーム lerp 平滑化）
 * - "@current" キーフレーム … phase 開始時のカメラ実位置に置換（不定長ループ後の連続性確保）
 * - relativeTo:"bottle" … 登録済み offset 供給元の位置を加算（ボトルローカル座標で記述可能）
 */
export class CameraDirector {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.targets = new Map(); // name -> (outVec3) => void
    this.lookCurrent = new THREE.Vector3();
    this._lookInitialized = false;
    this._activeTicks = new Set();
    this._activeTweens = new Set();
    // camera-eval へ渡す注視ターゲット解決子（targets Map 経由）
    this._resolve = (name, out) => this._resolveTarget(name, out);
  }

  registerTarget(name, supplier) {
    this.targets.set(name, supplier);
  }

  clearTargets() {
    this.targets.clear();
  }

  /** 現在のカメラ向きから lookCurrent を初期化（最初の phase 開始時に呼ぶ） */
  syncLookFromCamera(point) {
    if (point) {
      this.lookCurrent.copy(point);
    } else {
      const dir = this.camera.getWorldDirection(_look);
      this.lookCurrent.copy(this.camera.position).addScaledVector(dir, 5);
    }
    this._lookInitialized = true;
  }

  _buildCurve(path, offset, closed = false) {
    return buildCurve(path, offset, closed, this.camera.position);
  }

  /** targets Map から注視/オフセット供給元を解決（camera-eval 用） */
  _resolveTarget(name, out) {
    const supplier = this.targets.get(name);
    if (!supplier) return null;
    supplier(out);
    return out;
  }

  /** camera-eval.applyLook の lookInit オプション（初回 snap で不連続を防ぐ） */
  _lookOpts() {
    return {
      initialized: this._lookInitialized,
      onInit: () => {
        this._lookInitialized = true;
      },
    };
  }

  _resolveOffset(phase) {
    if (!phase.relativeTo) return null;
    const supplier = this.targets.get(phase.relativeTo);
    if (!supplier) {
      console.warn(`[Director] unknown relativeTo: ${phase.relativeTo}`);
      return null;
    }
    const out = new THREE.Vector3();
    supplier(out);
    return out;
  }

  _applyLook(lookCfg, dt) {
    const target = applyLook(lookCfg, dt, this.lookCurrent, this._resolve, this._lookOpts());
    if (target) this.camera.lookAt(this.lookCurrent);
  }

  /** 向き評価。keys があれば u（線形フェーズ進行）で aim キーフレーム内挿、無ければ従来の単一 lookAt */
  _applyOrientation(lookCfg, u, dt) {
    if (isKeyedOrientation(lookCfg)) {
      const pt = sampleAimPoint(lookCfg.keys, u, this._resolve, _look);
      if (pt) {
        smoothToPoint(this.lookCurrent, pt, lookCfg.lerp, dt, this._lookOpts());
        this.camera.lookAt(this.lookCurrent);
      }
    } else {
      this._applyLook(lookCfg, dt);
    }
  }

  /** 一方向パスを再生して完了で resolve */
  playPhase(phase) {
    const offset = this._resolveOffset(phase);
    const curve = this._buildCurve(phase.path, offset);
    const state = { t: 0 };
    const fovFrom = phase.fov ? phase.fov[0] : null;
    const fovTo = phase.fov ? phase.fov[1] : null;
    let elapsed = 0; // 線形フェーズ進行（向きキー用。位置イージングとは独立）

    return new Promise((resolve) => {
      const tick = (dt) => {
        // state.t は gsap tween が ease 適用済みで駆動する eased 進行度
        const fov = samplePath(curve, state.t, fovFrom, fovTo, _pos);
        this.camera.position.copy(_pos);
        if (fov !== null) {
          this.camera.fov = fov;
          this.camera.updateProjectionMatrix();
        }
        elapsed += dt;
        this._applyOrientation(phase.lookAt, Math.min(elapsed / phase.duration, 1), dt);
      };
      this.world.addTickable(tick);
      this._activeTicks.add(tick);

      const tween = gsap.to(state, {
        t: 1,
        duration: phase.duration,
        ease: phase.ease || 'none',
        onComplete: () => {
          tick(1 / 60); // 終端を確定
          this.world.removeTickable(tick);
          this._activeTicks.delete(tick);
          this._activeTweens.delete(tween);
          resolve();
        },
      });
      this._activeTweens.add(tween);
    });
  }

  /**
   * 閉ループを周回。返り値の release() を呼ぶと、minHoldProgress を満たしつつ
   * 最寄りの脱出点（ループを exitPoints 等分した位置）まで進んで resolve する。
   */
  playLoop(phase) {
    const offset = this._resolveOffset(phase);
    const curve = this._buildCurve(phase.path, offset, phase.closed !== false);
    const ev = new LoopEvaluator(phase, curve, this.camera.position);
    let resolveFn = null;

    const tick = (dt) => {
      const target = ev.step(dt, this.camera.position, this.lookCurrent, this._resolve, {
        lookOpts: this._lookOpts(),
      });
      if (target) this.camera.lookAt(this.lookCurrent);

      if (ev.done) {
        this.world.removeTickable(tick);
        this._activeTicks.delete(tick);
        resolveFn();
      }
    };
    this.world.addTickable(tick);
    this._activeTicks.add(tick);

    return {
      release: () => {
        return new Promise((resolve) => {
          resolveFn = resolve;
          ev.beginRelease(); // 呼び出し時点の progress から最寄り exitPoint を確定
        });
      },
    };
  }

  /**
   * 追従ホールド: カメラは追従ターゲット（彗星の先鋒）を注視しながら、
   * 先鋒と同じ螺旋を共有するカメラ専用軌道——半径 +radiusOffset・方位角
   * -angleLag・高さ +heightOffset——を浮遊し、斜め後ろ上から追跡する。
   * 進入時はカメラ実位置の実オフセットを採取して blendIn 秒で設定値へ
   * 移行し（phase 切替の不連続防止）、以降は極座標で平滑化する
   * （螺旋進入時の角速度・半径の急変もここでならされる）。
   * release() で resolve（後続 pullBack の "@current" が連続性を引き受ける）。
   */
  playFollow(phase) {
    const ev = new FollowEvaluator(phase);
    let resolveFn = null;
    let releasing = false;

    const tick = (dt) => {
      // 追従ターゲット（先鋒）と周回中心（ボトル）を毎フレーム解決
      const headSup = this.targets.get(phase.target);
      const centerSup = this.targets.get(phase.center);
      let head = null;
      let center = null;
      if (headSup && centerSup) {
        headSup(_head);
        centerSup(_center);
        head = _head;
        center = _center;
      }
      // 極座標の平滑化・blendIn・lookBlend は FollowEvaluator が担う
      const target = ev.step(
        dt,
        head,
        center,
        this.camera.position,
        this.lookCurrent,
        this._resolve,
        this._lookOpts()
      );
      if (target) this.camera.lookAt(this.lookCurrent);

      // 生成が速く終わっても minHold 秒は周回を見せてから抜ける
      if (releasing && ev.elapsed >= (phase.minHold ?? 0)) {
        this.world.removeTickable(tick);
        this._activeTicks.delete(tick);
        resolveFn();
      }
    };
    this.world.addTickable(tick);
    this._activeTicks.add(tick);

    return {
      release: () => {
        return new Promise((resolve) => {
          resolveFn = resolve;
          releasing = true;
        });
      },
    };
  }

  /** 強制リセット用: 動作中の tick / tween を全て止める */
  stop() {
    for (const tick of this._activeTicks) this.world.removeTickable(tick);
    this._activeTicks.clear();
    for (const tween of this._activeTweens) tween.kill();
    this._activeTweens.clear();
    this._lookInitialized = false;
  }
}
