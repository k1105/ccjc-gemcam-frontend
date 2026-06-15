import * as THREE from 'three';
import gsap from 'gsap';
import {
  buildCurve,
  pathBoundaryNeighbors,
  pathTimes,
  samplePathByTime,
  applyLook,
  isKeyedOrientation,
  hasFreeOrientation,
  sampleAimPoint,
  sampleOrientationQuat,
  smoothToPoint,
  smoothQuat,
  buildKeyframeAimKeys,
  FollowEvaluator,
  LoopEvaluator,
} from './camera-eval.js';

const _look = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _head = new THREE.Vector3();
const _center = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _lin = new THREE.Vector3();
const MORPH_DEFAULT = 0.5; // follow/loop からの入口を線形モーフする秒数

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
    // 入口モーフ用: 直前フレームのカメラ速度（1フレーム差分）を追跡
    this._lastFramePos = new THREE.Vector3();
    this._lastVel = new THREE.Vector3();
    this._haveLastPos = false;
    // camera-eval へ渡す注視ターゲット解決子（targets Map 経由）
    this._resolve = (name, out) => this._resolveTarget(name, out);
  }

  /** 各 tick 末に呼び、フレーム間のカメラ速度を更新（フェーズ跨ぎの入口モーフに使う） */
  _track() {
    if (this._haveLastPos) this._lastVel.subVectors(this.camera.position, this._lastFramePos);
    this._lastFramePos.copy(this.camera.position);
    this._haveLastPos = true;
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

  _buildCurve(path, offset, closed = false, prev = null, next = null) {
    return buildCurve(path, offset, closed, this.camera.position, prev, next);
  }

  /** relativeTo を解決したワールドオフセット（無ければ zero）。境界 neighbor 計算用 */
  _offsetOf(shot) {
    return this._resolveOffset(shot) ?? new THREE.Vector3();
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

  /**
   * 向き評価。keys があれば u（線形フェーズ進行）でキーフレーム評価:
   * - quat キーを含む → free モード（quaternion を slerp して camera.quaternion に適用）
   * - それ以外 → aim 注視点内挿（camera.lookAt）
   * keys が無ければ従来の単一 lookAt。
   */
  _applyOrientation(lookCfg, aimKeys, uLin, posParam, dt) {
    if (isKeyedOrientation(lookCfg)) {
      const keys = lookCfg.keys;
      if (hasFreeOrientation(keys)) {
        const q = sampleOrientationQuat(keys, uLin, this._resolve, this.camera.position, _q);
        if (q) {
          // cut 直後は _lookInitialized=false → 初回 snap（不連続な向きへ即切替）
          if (!this._lookInitialized) {
            this.camera.quaternion.copy(q);
            this._lookInitialized = true;
          } else {
            smoothQuat(this.camera.quaternion, q, lookCfg.lerp, dt);
          }
        }
        return;
      }
      const pt = sampleAimPoint(keys, uLin, this._resolve, _look);
      if (pt) {
        smoothToPoint(this.lookCurrent, pt, lookCfg.lerp, dt, this._lookOpts());
        this.camera.lookAt(this.lookCurrent);
      }
    } else if (aimKeys) {
      // キーフレーム注視点オーバーライド（posParam=eased進行で補間）
      const pt = sampleAimPoint(aimKeys, posParam, this._resolve, _look);
      if (pt) {
        smoothToPoint(this.lookCurrent, pt, lookCfg?.lerp, dt, this._lookOpts());
        this.camera.lookAt(this.lookCurrent);
      }
    } else {
      this._applyLook(lookCfg, dt);
    }
  }

  /**
   * 解決済みワールド位置を返す（static ショット / cut の起点用）。
   * pos:"@current" は現在カメラ位置、配列は relativeTo オフセット加算。
   */
  _staticPos(phase, offset, out) {
    if (phase.pos === '@current') return out.copy(this.camera.position);
    out.set(phase.pos[0], phase.pos[1], phase.pos[2]);
    if (offset) out.add(offset);
    return out;
  }

  /**
   * 定点ショット（type:"static"）。duration 秒、固定位置にカメラを据える。
   * lookAt は target 指定なら被写体を追ってよい（定点パン/首振り）。fov は配列で
   * ランプ、数値で固定。cut:true なら向きを開始時に snap（マルチカムのハードカット）。
   */
  playStatic(phase) {
    if (phase.cut) this._lookInitialized = false;
    const offset = this._resolveOffset(phase);
    const pos = this._staticPos(phase, offset, _pos).clone();
    this.camera.position.copy(pos);
    const fovArr = Array.isArray(phase.fov);
    const fovFrom = phase.fov != null ? (fovArr ? phase.fov[0] : phase.fov) : null;
    const fovTo = phase.fov != null ? (fovArr ? phase.fov[1] ?? phase.fov[0] : phase.fov) : null;
    const state = { t: 0 };

    return new Promise((resolve) => {
      const tick = (dt) => {
        this.camera.position.copy(pos); // 定点（lookAt の target 追従はしてよい）
        if (fovFrom !== null) {
          this.camera.fov = fovFrom + (fovTo - fovFrom) * state.t;
          this.camera.updateProjectionMatrix();
        }
        this._applyOrientation(phase.lookAt, null, state.t, state.t, dt);
        this._track();
      };
      this.world.addTickable(tick);
      this._activeTicks.add(tick);

      const tween = gsap.to(state, {
        t: 1,
        duration: phase.duration ?? 1,
        ease: phase.ease || 'none',
        onComplete: () => {
          tick(1 / 60);
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
   * 一方向パスを再生して完了で resolve。
   * @param {object} phase
   * @param {{shots?:Array, index?:number}} [ctx] 隣接 path との境界 C1 連続化に使う文脈
   */
  playPhase(phase, ctx) {
    if (phase.cut) this._lookInitialized = false; // ハードカット: 向きを開始時 snap
    const offset = this._resolveOffset(phase);
    const nb =
      ctx?.shots && ctx.index != null
        ? pathBoundaryNeighbors(ctx.shots, ctx.index, (s) => this._offsetOf(s))
        : { prev: null, next: null };
    const curve = this._buildCurve(phase.path, offset, false, nb.prev, nb.next);
    const times = pathTimes(phase); // 各アンカーの正規化時刻（時間と曲線は独立）
    const aimKeys = buildKeyframeAimKeys(phase, times); // 注視点オーバーライド
    const state = { t: 0 };
    const fovFrom = phase.fov ? phase.fov[0] : null;
    const fovTo = phase.fov ? phase.fov[1] : null;
    let elapsed = 0; // 線形フェーズ進行（lookAt.keys用。位置イージングとは独立）

    // 直前が follow/loop（手続き的ホールド）なら、入口の速度を線形モーフして滑らかに繋ぐ
    let prevBase = null;
    if (ctx?.shots && ctx.index != null) {
      for (let j = ctx.index - 1; j >= 0; j--) {
        if (ctx.shots[j].type !== 'static') { prevBase = ctx.shots[j]; break; }
      }
    }
    const morphDur =
      prevBase && (prevBase.type === 'follow' || prevBase.type === 'loop')
        ? phase.morphIn ?? MORPH_DEFAULT
        : 0;
    const morphStart = this.camera.position.clone();
    const morphVel = this._lastVel.clone(); // 1フレーム差分（≒60fps基準）

    return new Promise((resolve) => {
      const tick = (dt) => {
        // state.t は gsap tween が ease 適用済みで駆動する eased 進行度。
        // 位置は時刻ベースで評価（アンカー times[i] の瞬間にその点。曲線編集で時刻不変）。
        samplePathByTime(curve, times, state.t, _pos);
        if (morphDur > 0 && elapsed < morphDur) {
          // 入口速度の線形延長 → パス位置 へ線形クロスフェード（速度が滑らかに移る）
          _lin.copy(morphStart).addScaledVector(morphVel, elapsed * 60);
          _pos.lerpVectors(_lin, _pos, elapsed / morphDur);
        }
        this.camera.position.copy(_pos);
        if (fovFrom !== null) {
          this.camera.fov = fovFrom + (fovTo - fovFrom) * state.t;
          this.camera.updateProjectionMatrix();
        }
        elapsed += dt;
        this._applyOrientation(phase.lookAt, aimKeys, Math.min(elapsed / phase.duration, 1), state.t, dt);
        this._track();
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
      this._track();

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
    // 入口速度を線形モーフ（直前フェーズの動きから滑らかに周回へ）
    const morphDur = phase.morphIn ?? MORPH_DEFAULT;
    const morphStart = this.camera.position.clone();
    const morphVel = this._lastVel.clone();

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
      if (morphDur > 0 && ev.elapsed < morphDur) {
        _lin.copy(morphStart).addScaledVector(morphVel, ev.elapsed * 60);
        this.camera.position.lerpVectors(_lin, this.camera.position, ev.elapsed / morphDur);
      }
      if (target) this.camera.lookAt(this.lookCurrent);
      this._track();

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
    this._haveLastPos = false; // 速度追跡もリセット
  }
}
