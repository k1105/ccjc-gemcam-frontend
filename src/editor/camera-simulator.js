import * as THREE from 'three';
import gsap from 'gsap';

/**
 * generate.phases のカメラ編成を 1/60 秒固定ステップで決定論シミュレートし、
 * 全フレームのカメラ状態（位置 / 注視点 / fov）を配列にベイクする。
 * タイムラインエディタのフレーム単位スクラブはこのベイク結果を再生するだけなので、
 * どこへシークしても本番再生と同一の絵になる（lookAt の lerp 平滑化も
 * 開始から固定ステップで積分するため正確に再現される）。
 *
 * !! 各 phase の数式は core/camera-director.js（playPhase / playFollow / playLoop）
 * !! および sequences/generate.js（enter のカメラ初期化・swap タイミング）の鏡像。
 * !! director 側を変更したら必ずここも追従させること。
 *
 * 不定長フェーズのプレビュー尺:
 * - type:"follow" … minHold 秒（本番は生成API完了までだが下限はこの値）
 * - type:"loop"   … loopDuration で1周 → release（最寄り exitPoint まで進んで終了）
 */

export const FPS = 60;
const DT = 1 / FPS;
const MAX_PHASE_FRAMES = 120 * FPS; // 暴走保険

const _v = new THREE.Vector3();
const _head = new THREE.Vector3();
const _desired = new THREE.Vector3();

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
  const state = {
    pos: new THREE.Vector3(),
    lookCurrent: new THREE.Vector3(...(ph0.lookAt?.point ?? [0, 0.5, 0])),
    fov: ph0.fov ? ph0.fov[0] : 45,
    time: 0,
    swapTime: null, // photoRecede 終了 = パーティクル開始時刻
  };
  if (Array.isArray(ph0.path?.[0])) state.pos.set(...ph0.path[0]);

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

  // CameraDirector._applyLook 鏡像（lookInitialized は enter で済んでいる前提）
  const applyLook = (lookCfg, dt) => {
    if (!lookCfg) return;
    let target = null;
    if (lookCfg.mode === 'fixed') {
      target = _v.set(lookCfg.point[0], lookCfg.point[1], lookCfg.point[2]);
    } else if (lookCfg.mode === 'target') {
      target = resolveTarget(lookCfg.target, _v);
    }
    if (!target) return;
    const lerp = lookCfg.lerp ?? 1.0;
    if (lerp >= 1.0) {
      state.lookCurrent.copy(target);
    } else {
      const k = 1 - Math.pow(1 - lerp, dt * 60);
      state.lookCurrent.lerp(target, k);
    }
  };

  const record = () => {
    posArr.push(state.pos.x, state.pos.y, state.pos.z);
    lookArr.push(state.lookCurrent.x, state.lookCurrent.y, state.lookCurrent.z);
    fovArr.push(state.fov);
  };

  // CameraDirector._buildCurve / _resolveOffset 鏡像
  const buildCurve = (phase) => {
    const offset = phase.relativeTo === 'bottle' ? bottleCenter : null;
    const pts = phase.path.map((p) => {
      if (p === '@current') return state.pos.clone();
      const v = new THREE.Vector3(p[0], p[1], p[2]);
      if (offset) v.add(offset);
      return v;
    });
    return new THREE.CatmullRomCurve3(pts, phase.closed === true, 'centripetal');
  };

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

  /** playPhase 鏡像: gsap tween が state.t=ease(elapsed/duration) を駆動するのと等価 */
  function stepPath(phase, info) {
    const curve = buildCurve(phase);
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
      curve.getPointAt(Math.min(t, 1), state.pos);
      if (fovFrom !== null) state.fov = fovFrom + (fovTo - fovFrom) * t;
      applyLook(phase.lookAt, DT);
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

  /** playFollow 鏡像。プレビュー尺は minHold（本番の下限ホールド） */
  function stepFollow(phase, info) {
    const holdSec = phase.minHold ?? 3;
    const frames = Math.max(1, Math.round(holdSec * FPS));
    const center = bottleCenter;
    let elapsed = 0;
    let inited = false;
    let camAng = 0;
    let camRad = 0;
    let camHgt = 0;
    let lag0 = 0;
    let radOff0 = 0;
    let hgt0 = 0;

    for (let f = 1; f <= frames; f++) {
      elapsed += DT;
      env.heroPos(_head, particleTime());

      _desired.copy(_head).sub(center);
      _desired.y = 0;
      const distHead = _desired.length();
      const angHead = Math.atan2(_desired.z, _desired.x);
      const hgtHead = (_head.y - center.y) * (phase.headHeightInfluence ?? 0.5);

      if (!inited) {
        const rx = state.pos.x - center.x;
        const rz = state.pos.z - center.z;
        camRad = Math.hypot(rx, rz);
        camAng = Math.atan2(rz, rx);
        camHgt = state.pos.y - center.y;
        lag0 = wrapNear(angHead - camAng, phase.angleLag ?? 0);
        radOff0 = camRad - distHead;
        hgt0 = camHgt - hgtHead;
        inited = true;
      }

      const b = Math.min(elapsed / (phase.blendIn ?? 1.2), 1);
      const s = b * b * (3 - 2 * b);
      const lag = lag0 + ((phase.angleLag ?? 0) - lag0) * s;
      const radOff = radOff0 + ((phase.radiusOffset ?? 1.0) - radOff0) * s;
      const hgtOff = hgt0 + ((phase.heightOffset ?? 0.2) - hgt0) * s;

      const k = 1 - Math.pow(1 - (phase.posLerp ?? 0.06), DT * 60);
      camAng += wrapPi(angHead - lag - camAng) * k;
      camRad += (distHead + radOff - camRad) * k;
      camHgt += (hgtHead + hgtOff - camHgt) * k;

      state.pos.set(
        center.x + Math.cos(camAng) * camRad,
        center.y + camHgt,
        center.z + Math.sin(camAng) * camRad
      );

      if (phase.lookBlend != null) {
        _v.copy(center).lerp(_head, phase.lookBlend);
        const lookLerp = phase.lookAt?.lerp ?? 0.1;
        const k2 = 1 - Math.pow(1 - lookLerp, DT * 60);
        state.lookCurrent.lerp(_v, k2);
      } else {
        applyLook(phase.lookAt, DT);
      }
      state.time += DT;
      record();
    }
    info.holdSec = holdSec;
  }

  /** playLoop 鏡像。1周ホールド後に release()（最寄り exitPoint へ減速進行） */
  function stepLoop(phase, info) {
    const curve = buildCurve(phase);
    const blendDur = 0.7;
    const entryPos = state.pos.clone();
    const holdSec = phase.loopDuration ?? 6;
    const holdFrames = Math.max(1, Math.round(holdSec * FPS));

    let progress = 0;
    let blend = 0;
    let releasing = false;
    let releaseTarget = null;

    for (let f = 1; f <= MAX_PHASE_FRAMES; f++) {
      if (!releasing) {
        progress += DT / phase.loopDuration;
        if (f >= holdFrames) {
          const minP = phase.minHoldProgress ?? 0;
          const n = phase.exitPoints ?? 4;
          const base = Math.max(progress, minP);
          releaseTarget = Math.ceil(base * n + 1e-6) / n;
          releasing = true;
        }
      } else {
        const remaining = releaseTarget - progress;
        const step = Math.max(remaining * DT * 2.5, (DT / phase.loopDuration) * 0.5);
        progress = Math.min(progress + step, releaseTarget);
      }

      curve.getPointAt(progress % 1, state.pos);
      if (blend < 1) {
        blend = Math.min(blend + DT / blendDur, 1);
        const e = blend * blend * (3 - 2 * blend);
        state.pos.lerpVectors(entryPos, state.pos, e);
      }
      applyLook(phase.lookAt, DT);
      state.time += DT;
      record();

      if (releasing && progress >= releaseTarget - 1e-4) break;
    }
    info.holdSec = (posArr.length / 3 - 1 - info.startFrame) / FPS;
  }
}

/**
 * CatmullRom 制御点ごとの「曲線全長に対する弧長割合 u」。
 * getPointAt(u) は弧長パラメータなので、ease(t)>=u となった瞬間が通過フレーム。
 */
/** 角度を (-π, π] に正規化（camera-director.js と同一） */
function wrapPi(a) {
  return ((((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
}

/** 角度 a を、ref から ±π 以内の表現に直す */
function wrapNear(a, ref) {
  return ref + wrapPi(a - ref);
}

function controlPointArcFractions(curve) {
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
