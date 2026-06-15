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

  // --- generate.enter 鏡像: 最初の base ショット（static オーバーレイは除く）の開始位置へ ---
  const ph0 = gcfg.shots.find((s) => s.type !== 'static') ?? gcfg.shots[0];
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

  // freeQuat があればそれを向き、無ければ pos→lookCurrent の lookAt から導出（_recQuat に格納）
  const recQuat = (freeQuat) => {
    if (freeQuat) _recQuat.copy(freeQuat);
    else _recQuat.setFromRotationMatrix(_lookM.lookAt(state.pos, state.lookCurrent, UP));
    return _recQuat;
  };

  // 末尾に1フレーム追記（base パスの逐次記録）。state.quat に現在の向きを残す。
  const record = (freeQuat) => {
    posArr.push(state.pos.x, state.pos.y, state.pos.z);
    lookArr.push(state.lookCurrent.x, state.lookCurrent.y, state.lookCurrent.z);
    fovArr.push(state.fov);
    const q = recQuat(freeQuat);
    quatArr.push(q.x, q.y, q.z, q.w);
    state.quat.copy(q);
  };

  // 任意フレーム f を state から上書き（static オーバーレイ用）。
  const writeFrame = (f, freeQuat) => {
    const q = recQuat(freeQuat);
    posArr[f * 3] = state.pos.x;
    posArr[f * 3 + 1] = state.pos.y;
    posArr[f * 3 + 2] = state.pos.z;
    lookArr[f * 3] = state.lookCurrent.x;
    lookArr[f * 3 + 1] = state.lookCurrent.y;
    lookArr[f * 3 + 2] = state.lookCurrent.z;
    fovArr[f] = state.fov;
    quatArr[f * 4] = q.x;
    quatArr[f * 4 + 1] = q.y;
    quatArr[f * 4 + 2] = q.z;
    quatArr[f * 4 + 3] = q.w;
  };

  // フレーム数を n まで拡張（不足分は直前フレームの値で埋める＝ホールド）。
  const ensureFrames = (n) => {
    let cur = fovArr.length;
    while (cur < n) {
      const s = (cur - 1) * 3;
      const sq = (cur - 1) * 4;
      posArr.push(posArr[s], posArr[s + 1], posArr[s + 2]);
      lookArr.push(lookArr[s], lookArr[s + 1], lookArr[s + 2]);
      fovArr.push(fovArr[cur - 1]);
      quatArr.push(quatArr[sq], quatArr[sq + 1], quatArr[sq + 2], quatArr[sq + 3]);
      cur++;
    }
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

  // --- base パス: 逐次再生されるショット（path/follow/loop）を時系列に連結 ---
  // static は「上に被せるオーバーレイ」なので base には含めず、後段で絶対時刻に焼き込む。
  for (const phase of gcfg.shots) {
    if (phase.type === 'static') continue;
    const startFrame = posArr.length / 3 - 1; // このショットの開始＝直前フレーム
    const info = { id: phase.id, type: phase.type, startFrame, frameCount: 0, holdSec: 0, markers: [], layer: 'base' };

    // cut:true（path のハードカット）は向きを開始時 snap させる
    if (phase.cut && phase.type === 'path') lookInit.initialized = false;

    if (phase.type === 'path') {
      stepPath(phase, info);
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

  // --- overlay パス: static ショットを start（絶対秒）からの区間に焼き込む（base を上書き） ---
  for (const phase of gcfg.shots) {
    if (phase.type !== 'static') continue;
    phaseInfos.push(bakeStaticOverlay(phase));
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

  /** type:"path"。位置は時刻ベース（samplePathByTime）。通過時刻はアンカーの times[i] で固定 */
  function stepPath(phase, info) {
    // 隣接 path との境界 C1 連続化（共有点で接線を揃える）
    const nb = pathBoundaryNeighbors(
      gcfg.shots,
      gcfg.shots.indexOf(phase),
      (s) => (s.relativeTo === 'bottle' ? bottleCenter : new THREE.Vector3())
    );
    const curve = buildCurve(
      phase.path,
      phase.relativeTo === 'bottle' ? bottleCenter : null,
      phase.closed === true,
      state.pos,
      nb.prev,
      nb.next
    );
    const easeFn = gsap.parseEase(phase.ease || 'none');
    const frames = Math.max(1, Math.round(phase.duration * FPS));
    const fovFrom = phase.fov ? phase.fov[0] : null;
    const fovTo = phase.fov ? phase.fov[1] : null;

    // 各アンカーの正規化時刻（曲線編集に依存しない）。マーカー＝eased進行が times[i] に達した瞬間
    const times = pathTimes(phase);
    const aimKeys = buildKeyframeAimKeys(phase, times); // 注視点オーバーライド（無ければ null）
    const pending = times.map((u, kf) => ({
      u,
      kf,
      editable: phase.path[kf] !== '@current',
      frame: u <= 1e-6 ? info.startFrame : undefined,
    }));

    for (let f = 1; f <= frames; f++) {
      const t = easeFn(Math.min((f * DT) / phase.duration, 1)); // eased 進行
      const uLin = Math.min((f * DT) / phase.duration, 1); // 線形進行（lookAt.keys用）
      samplePathByTime(curve, times, t, state.pos);
      if (fovFrom !== null) state.fov = fovFrom + (fovTo - fovFrom) * t;
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
   * type:"static"（定点オーバーレイ）。start（絶対秒）から duration 秒、固定位置の
   * カメラで base タイムラインを上書きする（マルチカムのカット）。lookAt の target
   * 追従はしてよい。fov は配列でランプ／数値で固定。開始時は向きを snap（ハードカット）。
   */
  function bakeStaticOverlay(phase) {
    const dur = phase.duration ?? 1;
    const startFrame = Math.max(0, Math.round((phase.start ?? 0) * FPS));
    const frames = Math.max(1, Math.round(dur * FPS));
    ensureFrames(startFrame + frames); // 不足分は直前フレームでホールドして拡張

    // 位置: "@current" は overlay 開始時の base カメラ位置、配列は relativeTo 加算
    if (phase.pos === '@current') {
      state.pos.set(
        posArr[startFrame * 3] ?? 0,
        posArr[startFrame * 3 + 1] ?? 0,
        posArr[startFrame * 3 + 2] ?? 0
      );
    } else {
      state.pos.set(phase.pos[0], phase.pos[1], phase.pos[2]);
      if (phase.relativeTo === 'bottle') state.pos.add(bottleCenter);
    }

    const easeFn = gsap.parseEase(phase.ease || 'none');
    const fovIsArr = Array.isArray(phase.fov);
    const fovFrom = phase.fov != null ? (fovIsArr ? phase.fov[0] : phase.fov) : null;
    const fovTo = phase.fov != null ? (fovIsArr ? phase.fov[1] ?? phase.fov[0] : phase.fov) : null;
    if (fovFrom !== null) state.fov = fovFrom;

    lookInit.initialized = false; // オーバーレイは開始時に向きを snap（カット）

    for (let k = 1; k <= frames; k++) {
      const f = startFrame + k - 1;
      const t = easeFn(Math.min((k * DT) / dur, 1));
      if (fovFrom !== null) state.fov = fovFrom + (fovTo - fovFrom) * t;
      state.time = f / FPS; // hero 等の被写体解決を絶対時刻に合わせる
      const freeQ = applyOrientationSim(phase.lookAt, null, t, t, DT);
      writeFrame(f, freeQ);
    }
    return {
      id: phase.id,
      type: 'static',
      startFrame,
      frameCount: frames,
      holdSec: dur,
      markers: [{ kf: 0, frame: startFrame, editable: true }],
      layer: 'overlay',
    };
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

