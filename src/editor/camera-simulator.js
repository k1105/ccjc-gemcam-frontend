import * as THREE from 'three';
import gsap from 'gsap';
import {
  buildCurve,
  samplePath,
  applyLook,
  isKeyedOrientation,
  hasFreeOrientation,
  sampleAimPoint,
  sampleOrientationQuat,
  smoothToPoint,
  smoothQuat,
  controlPointArcFractions,
  buildKeyframeAimKeys,
  FollowEvaluator,
  LoopEvaluator,
} from '../core/camera-eval.js';

/**
 * generate.shots のカメラ編成（ショット列）を 1/60 秒固定ステップで決定論シミュレートし、
 * 全フレームのカメラ状態（位置 / 注視点 / fov）を配列にベイクする。
 * タイムラインエディタのフレーム単位スクラブはこのベイク結果を再生するだけなので、
 * どこへシークしても本番再生と同一の絵になる（lookAt の lerp 平滑化も
 * 開始から固定ステップで積分するため正確に再現される）。
 *
 * phase の数式は core/camera-eval.js（buildCurve / samplePath / applyLook /
 * FollowEvaluator / LoopEvaluator）に一本化されており、本番ドライバ
 * core/camera-director.js と同じ関数を回す。ここはそれを固定ステップで駆動し、
 * 各フレームを配列へ記録するだけ（swap タイミング等の generate.enter 由来の初期化は下記で再現）。
 *
 * 不定長フェーズのプレビュー尺:
 * - type:"follow" … minHold 秒（本番は生成API完了までだが下限はこの値）
 * - type:"loop"   … loopDuration で1周 → release（最寄り exitPoint まで進んで終了）
 */

export const FPS = 60;
const DT = 1 / FPS;
const MAX_PHASE_FRAMES = 120 * FPS; // 暴走保険

const _head = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _recQuat = new THREE.Quaternion();
const _lookM = new THREE.Matrix4();
const _fwd = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * @param {object} gcfg choreo.data.generate
 * @param {{ heroPos: (out: THREE.Vector3, particleTime: number) => THREE.Vector3 }} env
 *   heroPos は PhotoParticles.getHeroPosition と同一（preview-stage が供給）
 * @returns {{
 *   fps: number, totalFrames: number, swapTime: number|null,
 *   pos: Float32Array, look: Float32Array, fov: Float32Array,
 *   shots: Array<{id, type, startFrame, frameCount, holdSec, markers: Array<{kf, frame, editable}>}>
 * }}
 */
export function bakeGenerateCamera(gcfg, env) {
  const bottleScale = gcfg.bottleScale ?? 1.6;
  const bottleCenter = new THREE.Vector3(...gcfg.bottlePos).add(
    new THREE.Vector3(0, 0.4 * bottleScale, 0)
  );

  // --- generate.enter 鏡像: shot0 開始位置へ即時セット ---
  const ph0 = gcfg.shots[0];
  const ph0Look =
    ph0.lookAt?.point ?? ph0.lookAt?.keys?.find((k) => Array.isArray(k.point))?.point ?? [0, 0.5, 0];
  const state = {
    pos: new THREE.Vector3(),
    lookCurrent: new THREE.Vector3(...ph0Look),
    quat: new THREE.Quaternion(), // 現在の向き（free 平滑化の起点・出力 quat チャンネル）
    fov: ph0.fov ? ph0.fov[0] : 45,
    time: 0,
    swapTime: null, // photoRecede 終了 = パーティクル開始時刻
  };
  const ph0Start = ph0.type === 'static' ? ph0.pos : ph0.path?.[0];
  if (Array.isArray(ph0Start)) state.pos.set(...ph0Start);
  else if (ph0Start && ph0Start !== '@current') state.pos.set(...ph0Start.p);

  // 向き平滑化の初期化フラグ（cut:true ショット開始時に false へ → 初回 snap）。
  // 既存ショットは常に true のままなので従来挙動とビット一致する。
  const lookInit = { initialized: true, onInit: () => (lookInit.initialized = true) };

  const posArr = [];
  const lookArr = [];
  const fovArr = [];
  const quatArr = [];
  const phaseInfos = [];

  const particleTime = () => (state.swapTime === null ? 0 : Math.max(0, state.time - state.swapTime));

  // CameraDirector.targets 鏡像（generate.enter で登録される2つ）
  const resolveTarget = (name, out) => {
    if (name === 'bottle') return out.copy(bottleCenter);
    if (name === 'heroParticle') return env.heroPos(out, particleTime());
    return null;
  };

  // 向き評価。優先順位:
  //  1) lookAt.keys（手書き向きトラック。free=quaternion / aim=注視点。u=線形進行）
  //  2) キーフレーム注視点オーバーライド aimKeys（posParam=eased進行で補間。エディタ既定）
  //  3) 従来の単一 lookAt
  // 返り値: free モードのときその quaternion、それ以外は null（record で look から quat を導出）。
  const applyOrientationSim = (lookCfg, aimKeys, uLin, posParam, dt) => {
    if (isKeyedOrientation(lookCfg)) {
      const keys = lookCfg.keys;
      if (hasFreeOrientation(keys)) {
        const q = sampleOrientationQuat(keys, uLin, resolveTarget, state.pos, _q);
        if (q) {
          smoothQuat(state.quat, q, lookCfg.lerp, dt, lookInit);
          _fwd.set(0, 0, -1).applyQuaternion(state.quat);
          state.lookCurrent.copy(state.pos).addScaledVector(_fwd, 2);
          return state.quat;
        }
        return null;
      }
      const pt = sampleAimPoint(keys, uLin, resolveTarget, _aim);
      if (pt) smoothToPoint(state.lookCurrent, pt, lookCfg.lerp, dt, lookInit);
    } else if (aimKeys) {
      const pt = sampleAimPoint(aimKeys, posParam, resolveTarget, _aim);
      if (pt) smoothToPoint(state.lookCurrent, pt, lookCfg?.lerp, dt, lookInit);
    } else {
      applyLook(lookCfg, dt, state.lookCurrent, resolveTarget, lookInit);
    }
    return null;
  };

  // freeQuat があればそれを向きとして記録、無ければ pos→lookCurrent の lookAt から導出。
  // いずれにせよ state.quat に現在の向きを残す（次フェーズの free 平滑化の起点になる）。
  const record = (freeQuat) => {
    posArr.push(state.pos.x, state.pos.y, state.pos.z);
    lookArr.push(state.lookCurrent.x, state.lookCurrent.y, state.lookCurrent.z);
    fovArr.push(state.fov);
    if (freeQuat) _recQuat.copy(freeQuat);
    else _recQuat.setFromRotationMatrix(_lookM.lookAt(state.pos, state.lookCurrent, UP));
    quatArr.push(_recQuat.x, _recQuat.y, _recQuat.z, _recQuat.w);
    state.quat.copy(_recQuat);
  };

  // パス構築（camera-eval.buildCurve へ委譲。relativeTo/'@current' を解決）
  const buildCurveSim = (phase) =>
    buildCurve(
      phase.path,
      phase.relativeTo === 'bottle' ? bottleCenter : null,
      phase.closed === true,
      state.pos
    );

  record(); // frame 0 = 初期状態

  for (const phase of gcfg.shots) {
    const startFrame = posArr.length / 3 - 1; // このショットの開始＝直前フレーム
    const info = { id: phase.id, type: phase.type, startFrame, frameCount: 0, holdSec: 0, markers: [] };

    // cut:true（path/static のハードカット）は向きを開始時 snap させる
    if (phase.cut && (phase.type === 'path' || phase.type === 'static')) {
      lookInit.initialized = false;
    }

    if (phase.type === 'path') {
      stepPath(phase, info);
    } else if (phase.type === 'static') {
      stepStatic(phase, info);
    } else if (phase.type === 'follow') {
      stepFollow(phase, info);
    } else if (phase.type === 'loop') {
      stepLoop(phase, info);
    }

    info.frameCount = posArr.length / 3 - 1 - startFrame;
    phaseInfos.push(info);

    // generate._run 鏡像: photoRecede 完了でプレーン→パーティクルへスワップ
    if (phase.type === 'path' && phase.id === 'photoRecede' && state.swapTime === null) {
      state.swapTime = state.time;
    }
  }

  return {
    fps: FPS,
    totalFrames: posArr.length / 3,
    swapTime: state.swapTime,
    pos: new Float32Array(posArr),
    look: new Float32Array(lookArr),
    fov: new Float32Array(fovArr),
    quat: new Float32Array(quatArr), // フレーム毎の向き（4成分/フレーム。roll を含む）
    shots: phaseInfos,
  };

  // ---- phase steppers（director の各 tick の固定ステップ版） ----

  /** type:"path"。camera-eval.samplePath で位置/fov、applyLook で注視点を評価 */
  function stepPath(phase, info) {
    const curve = buildCurveSim(phase);
    const easeFn = gsap.parseEase(phase.ease || 'none');
    const frames = Math.max(1, Math.round(phase.duration * FPS));
    const fovFrom = phase.fov ? phase.fov[0] : null;
    const fovTo = phase.fov ? phase.fov[1] : null;

    // キーフレーム通過位置マーカー（弧長割合 → ease 逆引き）
    const us = controlPointArcFractions(curve);
    const aimKeys = buildKeyframeAimKeys(phase, us); // 注視点オーバーライド（無ければ null）
    const pending = us.map((u, kf) => ({
      u,
      kf,
      editable: phase.path[kf] !== '@current',
      frame: u <= 1e-6 ? info.startFrame : undefined,
    }));

    for (let f = 1; f <= frames; f++) {
      const t = easeFn(Math.min((f * DT) / phase.duration, 1));
      const uLin = Math.min((f * DT) / phase.duration, 1); // 線形進行（lookAt.keys用）
      const fov = samplePath(curve, t, fovFrom, fovTo, state.pos);
      if (fov !== null) state.fov = fov;
      // posParam=t（eased進行＝getPointAt の引数）で注視点オーバーライドを補間
      const freeQ = applyOrientationSim(phase.lookAt, aimKeys, uLin, Math.min(t, 1), DT);
      state.time += DT;
      record(freeQ);
      for (const m of pending) {
        if (m.frame === undefined && Math.min(t, 1) >= m.u - 1e-6) {
          m.frame = info.startFrame + f;
        }
      }
    }
    info.holdSec = phase.duration;
    info.markers = pending.map((m) => ({
      kf: m.kf,
      frame: m.frame ?? info.startFrame + frames,
      editable: m.editable,
    }));
  }

  /**
   * type:"static"。duration 秒、固定位置にカメラを据える（定点）。
   * lookAt の target 追従はしてよい。fov は配列でランプ／数値で固定。
   */
  function stepStatic(phase, info) {
    // 位置: "@current" は直前フレーム位置を維持、配列は relativeTo オフセット加算
    if (phase.pos !== '@current') {
      state.pos.set(phase.pos[0], phase.pos[1], phase.pos[2]);
      if (phase.relativeTo === 'bottle') state.pos.add(bottleCenter);
    }
    const easeFn = gsap.parseEase(phase.ease || 'none');
    const dur = phase.duration ?? 1;
    const frames = Math.max(1, Math.round(dur * FPS));
    const fovArr = Array.isArray(phase.fov);
    const fovFrom = phase.fov != null ? (fovArr ? phase.fov[0] : phase.fov) : null;
    const fovTo = phase.fov != null ? (fovArr ? phase.fov[1] ?? phase.fov[0] : phase.fov) : null;

    for (let f = 1; f <= frames; f++) {
      const t = easeFn(Math.min((f * DT) / dur, 1));
      if (fovFrom !== null) state.fov = fovFrom + (fovTo - fovFrom) * t;
      const freeQ = applyOrientationSim(phase.lookAt, null, t, t, DT);
      state.time += DT;
      record(freeQ);
    }
    info.holdSec = dur;
    info.markers = [{ kf: 0, frame: info.startFrame, editable: true }];
  }

  /** type:"follow"。FollowEvaluator を固定ステップで回す。プレビュー尺は minHold */
  function stepFollow(phase, info) {
    const holdSec = phase.minHold ?? 3;
    const frames = Math.max(1, Math.round(holdSec * FPS));
    const ev = new FollowEvaluator(phase);

    for (let f = 1; f <= frames; f++) {
      env.heroPos(_head, particleTime());
      ev.step(DT, _head, bottleCenter, state.pos, state.lookCurrent, resolveTarget);
      state.time += DT;
      record();
    }
    info.holdSec = holdSec;
  }

  /** type:"loop"。LoopEvaluator を固定ステップで回し、holdFrames で release */
  function stepLoop(phase, info) {
    const curve = buildCurveSim(phase);
    const holdSec = phase.loopDuration ?? 6;
    const holdFrames = Math.max(1, Math.round(holdSec * FPS));
    const ev = new LoopEvaluator(phase, curve, state.pos);

    for (let f = 1; f <= MAX_PHASE_FRAMES; f++) {
      ev.step(DT, state.pos, state.lookCurrent, resolveTarget, { wantRelease: f >= holdFrames });
      state.time += DT;
      record();
      if (ev.done) break;
    }
    info.holdSec = (posArr.length / 3 - 1 - info.startFrame) / FPS;
  }
}

