import * as THREE from 'three';
import gsap from 'gsap';
import {
  buildCurve,
  isOverlay,
  pathTimes,
  samplePathByTime,
  buildKeyframeAimKeys,
  applyLook,
  isKeyedOrientation,
  hasFreeOrientation,
  sampleAimPoint,
  sampleOrientationQuat,
  smoothToPoint,
  smoothQuat,
} from './camera-eval.js';

const _look = new THREE.Vector3();
const _q = new THREE.Quaternion();

/**
 * 本番(GENERATE)で overlay カット（割り込み）を絶対時刻で再生するスケジューラ。
 *
 * base カメラ（director の playPhase/playFollow/playLoop）が毎フレーム確定した後、
 * world.cameraOverride 経由で「全 tick の最後」に呼ばれ、その時刻にアクティブな
 * overlay があればカメラ（位置 / 向き / fov）を上書きする＝マルチカムのカット。
 *
 * overlay の start は GENERATE 開始からの絶対秒。follow/loop の弾性ホールドで base 尺が
 * 伸びても、カットは絶対時刻で割り込む（エディタの固定尺ベイクと同じ時間軸）。
 *
 * 評価式は camera-eval に一本化されており、エディタのベイク
 * （camera-simulator.bakeStaticOverlay / bakePathOverlay）と定義上一致する。
 */
export class OverlayScheduler {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {{ resolveTarget:(name:string,out:THREE.Vector3)=>THREE.Vector3|null,
   *           offsetFor:(shot:object)=>THREE.Vector3|null }} deps
   */
  constructor(camera, { resolveTarget, offsetFor }) {
    this.camera = camera;
    this.resolve = resolveTarget;
    this.offsetFor = offsetFor;
    this.overlays = [];
    this.elapsed = 0;
    this._active = null; // 実行中 overlay のランタイム状態
  }

  /** gcfg.shots から overlay（start 持ち）だけ拾う。base ショットは無視 */
  setShots(shots) {
    this.overlays = (shots ?? []).filter(isOverlay);
    this.elapsed = 0;
    this._active = null;
  }

  /**
   * 全 tick 後に毎フレーム呼ぶ。今アクティブな overlay があればカメラを上書きする。
   * @returns {boolean} 上書きしたら true
   */
  tick(dt) {
    this.elapsed += dt;
    const now = this.elapsed;

    // 窓 [start, start+duration) に now が入る overlay。複数重なれば後勝ち（配列後方が上）
    let cur = null;
    for (const s of this.overlays) {
      const start = s.start ?? 0;
      const dur = s.duration ?? 1;
      if (now >= start && now < start + dur) cur = s;
    }
    if (!cur) {
      this._active = null;
      return false;
    }
    if (this._active?.shot !== cur) this._begin(cur);
    this._apply(now, dt);
    return true;
  }

  /** overlay 開始時の初期化（曲線/固定位置の確定・向き snap の準備） */
  _begin(shot) {
    const cam = this.camera;
    const offset = this.offsetFor(shot) ?? null;
    const st = {
      shot,
      start: shot.start ?? 0,
      dur: shot.duration ?? 1,
      easeFn: gsap.parseEase(shot.ease || 'none'),
      offset,
      curve: null,
      times: null,
      aimKeys: null,
      staticPos: null,
      // 向きは開始時に snap（カット）。lerp 平滑化は overlay 専用の状態で行う
      lookCurrent: new THREE.Vector3(),
      lookInit: { initialized: false, onInit: () => (st.lookInit.initialized = true) },
    };
    // fov ランプ
    const fovIsArr = Array.isArray(shot.fov);
    st.fovFrom = shot.fov != null ? (fovIsArr ? shot.fov[0] : shot.fov) : null;
    st.fovTo = shot.fov != null ? (fovIsArr ? shot.fov[1] ?? shot.fov[0] : shot.fov) : null;

    if (shot.type === 'path' && Array.isArray(shot.path)) {
      // '@current' アンカーは「カット開始時の base カメラ位置」を基準にする
      st.curve = buildCurve(shot.path, offset, shot.closed === true, cam.position.clone());
      st.times = pathTimes(shot);
      st.aimKeys = buildKeyframeAimKeys(shot, st.times);
    } else {
      // 固定位置カット（type:'static'）
      if (shot.pos === '@current' || !Array.isArray(shot.pos)) {
        st.staticPos = cam.position.clone();
      } else {
        st.staticPos = new THREE.Vector3(...shot.pos);
        if (offset) st.staticPos.add(offset);
      }
    }
    this._active = st;
  }

  /** アクティブ overlay の現フレームをカメラへ適用 */
  _apply(now, dt) {
    const cam = this.camera;
    const st = this._active;
    const lin = st.dur > 0 ? Math.max(0, Math.min((now - st.start) / st.dur, 1)) : 1;
    const t = st.easeFn(lin); // eased 進行（位置・fov）

    if (st.curve) samplePathByTime(st.curve, st.times, t, cam.position);
    else cam.position.copy(st.staticPos);

    if (st.fovFrom !== null) {
      const fov = st.fovFrom + (st.fovTo - st.fovFrom) * t;
      if (cam.fov !== fov) {
        cam.fov = fov;
        cam.updateProjectionMatrix();
      }
    }

    this._applyOrientation(st.shot.lookAt, st.aimKeys, lin, t, dt);
  }

  /** 向き評価（camera-director._applyOrientation の overlay 専用ローカル状態版） */
  _applyOrientation(lookCfg, aimKeys, uLin, posParam, dt) {
    const cam = this.camera;
    const st = this._active;
    if (isKeyedOrientation(lookCfg)) {
      const keys = lookCfg.keys;
      if (hasFreeOrientation(keys)) {
        const q = sampleOrientationQuat(keys, uLin, this.resolve, cam.position, _q);
        if (q) smoothQuat(cam.quaternion, q, lookCfg.lerp, dt, st.lookInit);
        return;
      }
      const pt = sampleAimPoint(keys, uLin, this.resolve, _look);
      if (pt) {
        smoothToPoint(st.lookCurrent, pt, lookCfg.lerp, dt, st.lookInit);
        cam.lookAt(st.lookCurrent);
      }
    } else if (aimKeys) {
      const pt = sampleAimPoint(aimKeys, posParam, this.resolve, _look);
      if (pt) {
        smoothToPoint(st.lookCurrent, pt, lookCfg?.lerp, dt, st.lookInit);
        cam.lookAt(st.lookCurrent);
      }
    } else {
      const target = applyLook(lookCfg, dt, st.lookCurrent, this.resolve, st.lookInit);
      if (target) cam.lookAt(st.lookCurrent);
    }
  }
}
