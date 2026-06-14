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
} from '../core/camera-eval.js';

/**
 * generate.phases のカメラ編成を 1/60 秒固定ステップで決定論シミュレートし、
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

/**
 * @param {object} gcfg choreo.data.generate
 * @param {{ heroPos: (out: THREE.Vector3, particleTime: number) => THREE.Vector3 }} env
 *   heroPos は PhotoParticles.getHeroPosition と同一（preview-stage が供給）
 * @returns {{
 *   fps: number, totalFrames: number, swapTime: number|null,
 *   pos: Float32Array, look: Float32Array, fov: Float32Array,
 *   phases: Array<{id, type, startFrame, frameCount, holdSec, markers: Array<{kf, frame, editable}>}>
 * }}
 */
export function bakeGenerateCamera(gcfg, env) {
  const bottleScale = gcfg.bottleScale ?? 1.6;
  const bottleCenter = new THREE.Vector3(...gcfg.bottlePos).add(
    new THREE.Vector3(0, 0.4 * bottleScale, 0)
  );

  // --- generate.enter 鏡像: phase0 開始位置へ即時セット ---
  const ph0 = gcfg.phases[0];
  const ph0Look =
    ph0.lookAt?.point ?? ph0.lookAt?.keys?.find((k) => Array.isArray(k.point))?.point ?? [0, 0.5, 0];
  const state = {
    pos: new THREE.Vector3(),
    lookCurrent: new THREE.Vector3(...ph0Look),
    fov: ph0.fov ? ph0.fov[0] : 45,
    time: 0,
    swapTime: null, // photoRecede 終了 = パーティクル開始時刻
  };
  const ph0Start = ph0.path?.[0];
  if (Array.isArray(ph0Start)) state.pos.set(...ph0Start);
  else if (ph0Start && ph0Start !== '@current') state.pos.set(...ph0Start.p);

  const posArr = [];
  const lookArr = [];
  const fovArr = [];
  const phaseInfos = [];

  const particleTime = () => (state.swapTime === null ? 0 : Math.max(0, state.time - state.swapTime));

  // CameraDirector.targets 鏡像（generate.enter で登録される2つ）
  const resolveTarget = (name, out) => {
    if (name === 'bottle') return out.copy(bottleCenter);
    if (name === 'heroParticle') return env.heroPos(out, particleTime());
    return null;
  };

  // 向き評価（keys があれば aim キーフレーム内挿、無ければ従来の単一 lookAt）。
  // u は線形フェーズ進行（位置イージングとは独立）。lookInitialized は enter 済み前提。
  const applyOrientationSim = (lookCfg, u, dt) => {
    if (isKeyedOrientation(lookCfg)) {
      const pt = sampleAimPoint(lookCfg.keys, u, resolveTarget, _aim);
      if (pt) smoothToPoint(state.lookCurrent, pt, lookCfg.lerp, dt);
    } else {
      applyLook(lookCfg, dt, state.lookCurrent, resolveTarget);
    }
  };

  const record = () => {
    posArr.push(state.pos.x, state.pos.y, state.pos.z);
    lookArr.push(state.lookCurrent.x, state.lookCurrent.y, state.lookCurrent.z);
    fovArr.push(state.fov);
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

  for (const phase of gcfg.phases) {
    const startFrame = posArr.length / 3 - 1; // このフェーズの開始＝直前フレーム
    const info = { id: phase.id, type: phase.type, startFrame, frameCount: 0, holdSec: 0, markers: [] };

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

  return {
    fps: FPS,
    totalFrames: posArr.length / 3,
    swapTime: state.swapTime,
    pos: new Float32Array(posArr),
    look: new Float32Array(lookArr),
    fov: new Float32Array(fovArr),
    phases: phaseInfos,
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
    const pending = us.map((u, kf) => ({
      u,
      kf,
      editable: phase.path[kf] !== '@current',
      frame: u <= 1e-6 ? info.startFrame : undefined,
    }));

    for (let f = 1; f <= frames; f++) {
      const t = easeFn(Math.min((f * DT) / phase.duration, 1));
      const uLin = Math.min((f * DT) / phase.duration, 1); // 線形進行（向きキー用）
      const fov = samplePath(curve, t, fovFrom, fovTo, state.pos);
      if (fov !== null) state.fov = fov;
      applyOrientationSim(phase.lookAt, uLin, DT);
      state.time += DT;
      record();
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

/**
 * 各キーフレーム（制御点/アンカー）の「曲線全長に対する弧長割合 u」。
 * getPointAt(u) は弧長パラメータなので、ease(t)>=u となった瞬間が通過フレーム。
 * CatmullRomCurve3 と（ベジェの）CurvePath の両方に対応。
 */
function controlPointArcFractions(curve) {
  // CurvePath（ベジェ連結）: サブカーブの累積長からアンカー割合を出す
  if (Array.isArray(curve.curves)) {
    const lens = curve.getCurveLengths(); // 累積長（length = curves.length）
    const total = lens[lens.length - 1] || 1;
    // アンカー0=0, アンカーi=lens[i-1]/total。開path なら末尾アンカーは 1
    return [0, ...lens.map((l) => l / total)];
  }

  const n = curve.points.length;
  if (n < 2) return [0];
  const divisions = 200;
  const lengths = curve.getLengths(divisions); // index i = パラメータ t=i/divisions までの弧長
  const total = lengths[divisions] || 1;
  return curve.points.map((_, i) => {
    const t = curve.closed ? i / n : i / (n - 1);
    const fi = t * divisions;
    const i0 = Math.floor(fi);
    const frac = fi - i0;
    const len = i0 >= divisions ? total : lengths[i0] + (lengths[i0 + 1] - lengths[i0]) * frac;
    return len / total;
  });
}
