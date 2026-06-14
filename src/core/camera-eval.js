import * as THREE from 'three';

/**
 * カメラ評価の単一ソース（Phase1: 評価一本化）。
 * 本番ドライバ core/camera-director.js と エディタのベイカ editor/camera-simulator.js が
 * 「同じ数式を二度実装」していた状態を解消し、ここに集約する。
 * - director は実時計（gsap tween / world tick）でこれらを毎フレーム駆動する薄いドライバ
 * - simulator は 1/60 固定ステップで同じ関数を回してベイクする
 * どちらも同じ式を通るので、ベイク（プレビュー）と本番の絵は定義上一致する。
 *
 * 状態を持つ follow/loop は Evaluator クラスとして per-frame 状態を内包し、
 * step() を駆動側が呼ぶ。位置/向きの平滑化はフレームレート非依存の指数平滑
 * （k = 1 - (1-lerp)^(dt*60)）で、固定ステップでも実時計でも同一に積分される。
 */

const _t = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _look2 = new THREE.Vector3();
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _upv = new THREE.Vector3(0, 1, 0);

/** 角度を (-π, π] に正規化 */
export function wrapPi(a) {
  return ((((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
}

/** 角度 a を、ref から ±π 以内の表現に直す（ブレンドが最短経路を通るように） */
export function wrapNear(a, ref) {
  return ref + wrapPi(a - ref);
}

/**
 * キーフレームの位置を取り出す（local 座標、offset 未適用）。
 * 受理形: '@current' / [x,y,z]（auto） / { p:[x,y,z], hIn?, hOut? }（ハンドル付き）
 */
export function kfPos(entry, currentPos) {
  if (entry === '@current') return currentPos.clone();
  const a = Array.isArray(entry) ? entry : entry.p;
  return new THREE.Vector3(a[0], a[1], a[2]);
}

/** キーフレームのハンドル（pos からの相対デルタ）を返す。無ければ null */
export function kfHandle(entry, key) {
  if (entry && entry !== '@current' && !Array.isArray(entry) && Array.isArray(entry[key])) {
    const h = entry[key];
    return new THREE.Vector3(h[0], h[1], h[2]);
  }
  return null;
}

/** path にベジェハンドルが1つでもあるか */
export function hasManualHandles(path) {
  return path.some((e) => kfHandle(e, 'hIn') || kfHandle(e, 'hOut'));
}

/**
 * パスを曲線として構築。
 * - ハンドルが一切無ければ従来通り CatmullRom（centripetal）。既存JSONはビット完全一致。
 * - ハンドルが1つでもあれば CubicBezierCurve3 を連結した CurvePath。
 *   ハンドルの無いキーフレームは uniform Catmull-Rom 相当の自動接線（±t/3）を与える。
 * @param {Array<[number,number,number]|'@current'|{p,hIn?,hOut?}>} path
 * @param {THREE.Vector3|null} offset relativeTo 解決済みワールドオフセット（なければ null）
 * @param {boolean} closed 閉路か
 * @param {THREE.Vector3} currentPos "@current" の置換に使う現在カメラ位置
 */
export function buildCurve(path, offset, closed, currentPos) {
  if (!hasManualHandles(path)) {
    const pts = path.map((p) => {
      const v = kfPos(p, currentPos);
      if (offset && p !== '@current') v.add(offset); // '@current' は実位置そのまま
      return v;
    });
    return new THREE.CatmullRomCurve3(pts, closed, 'centripetal');
  }

  const n = path.length;
  const P = path.map((e) => {
    const v = kfPos(e, currentPos);
    if (offset && e !== '@current') v.add(offset); // '@current' は実位置そのまま
    return v;
  });
  // 自動接線（uniform Catmull-Rom）: t_i = (P[i+1]-P[i-1])/2
  const tangent = (i) => {
    const prev = closed ? P[(i - 1 + n) % n] : P[i - 1] ?? P[i];
    const next = closed ? P[(i + 1) % n] : P[i + 1] ?? P[i];
    return next.clone().sub(prev).multiplyScalar(0.5);
  };
  const outHandle = (i) => kfHandle(path[i], 'hOut') ?? tangent(i).multiplyScalar(1 / 3);
  const inHandle = (i) => kfHandle(path[i], 'hIn') ?? tangent(i).multiplyScalar(-1 / 3);

  const cp = new THREE.CurvePath();
  const segCount = closed ? n : n - 1;
  for (let i = 0; i < segCount; i++) {
    const j = (i + 1) % n;
    const p0 = P[i];
    const p3 = P[j];
    const p1 = p0.clone().add(outHandle(i));
    const p2 = p3.clone().add(inHandle(j));
    cp.add(new THREE.CubicBezierCurve3(p0, p1, p2, p3));
  }
  return cp;
}

/**
 * 一方向パスの位置・fov を eased 進行度 t（0..1, イージング適用済み）から評価。
 * @returns {number|null} 補間後の fov（fov 指定が無ければ null）
 */
export function samplePath(curve, easedT, fovFrom, fovTo, outPos) {
  curve.getPointAt(Math.min(easedT, 1), outPos);
  return fovFrom !== null ? fovFrom + (fovTo - fovFrom) * easedT : null;
}

/**
 * lookAt の注視点平滑化。lookCurrent を target へ指数平滑で寄せる（mutate）。
 * @param {object|undefined} lookCfg { mode:'fixed'|'target', point?, target?, lerp? }
 * @param {(name:string, out:THREE.Vector3)=>THREE.Vector3|null} resolveTarget
 * @param {{initialized?:boolean, onInit?:(target:THREE.Vector3)=>void}} [opts]
 *   初回（未初期化）は lookCurrent を target に snap してから補間（不連続防止）。
 * @returns {THREE.Vector3|null} 採用した注視点（無ければ null → 駆動側は lookAt を呼ばない）
 */
export function applyLook(lookCfg, dt, lookCurrent, resolveTarget, opts) {
  if (!lookCfg) return null;
  let target = null;
  if (lookCfg.mode === 'fixed') {
    target = _t.set(lookCfg.point[0], lookCfg.point[1], lookCfg.point[2]);
  } else if (lookCfg.mode === 'target') {
    target = resolveTarget(lookCfg.target, _t);
  }
  if (!target) return null;

  if (opts && opts.initialized === false) {
    lookCurrent.copy(target);
    opts.onInit?.(target);
  }
  const lerp = lookCfg.lerp ?? 1.0;
  if (lerp >= 1.0) {
    lookCurrent.copy(target);
  } else {
    const k = 1 - Math.pow(1 - lerp, dt * 60);
    lookCurrent.lerp(target, k);
  }
  return target;
}

// ---- 向きキーフレーム（Phase3a: aim 注視点の時間補間） ----
// lookAt が keys を持てば「u（線形フェーズ進行 0..1）」で注視点を内挿する。
// keys が無ければ従来の単一 lookAt（applyLook）として扱い、既存JSONはビット一致のまま。
// keys は t 昇順で与えられている前提（エディタが整列を保証する）。

/** lookAt がキーフレーム配列を持つか */
export function isKeyedOrientation(lookCfg) {
  return !!(lookCfg && Array.isArray(lookCfg.keys) && lookCfg.keys.length);
}

/** キー（{point}|{target}）の注視点を解決。null なら解決不能 */
function resolveKeyPoint(key, resolveTarget, out) {
  if (Array.isArray(key.point)) return out.set(key.point[0], key.point[1], key.point[2]);
  if (key.target) return resolveTarget(key.target, out);
  return null;
}

/** u における前後キーと内挿係数 f */
function segAt(keys, u) {
  const n = keys.length;
  if (n === 1 || u <= keys[0].t) return { a: keys[0], b: keys[0], f: 0 };
  const last = keys[n - 1];
  if (u >= last.t) return { a: last, b: last, f: 0 };
  for (let i = 0; i < n - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (u >= a.t && u <= b.t) {
      const span = b.t - a.t;
      return { a, b, f: span > 1e-6 ? (u - a.t) / span : 0 };
    }
  }
  return { a: last, b: last, f: 0 };
}

/** aim キーフレーム列から u 時点の注視点を内挿（point/target を lerp）。null なら解決不能 */
export function sampleAimPoint(keys, u, resolveTarget, out) {
  const { a, b, f } = segAt(keys, u);
  const pa = resolveKeyPoint(a, resolveTarget, _pa);
  if (!pa) return null;
  if (a === b || f <= 0) return out.copy(pa);
  const pb = resolveKeyPoint(b, resolveTarget, _pb) ?? pa;
  return out.copy(pa).lerp(pb, f);
}

/**
 * 各キーフレーム（制御点/アンカー）の「曲線全長に対する弧長割合 u」。
 * getPointAt(u) は弧長パラメータなので、ease(t)>=u となった瞬間が通過点。
 * CatmullRomCurve3 と（ベジェの）CurvePath の両方に対応。
 */
export function controlPointArcFractions(curve) {
  if (Array.isArray(curve.curves)) {
    const lens = curve.getCurveLengths();
    const total = lens[lens.length - 1] || 1;
    return [0, ...lens.map((l) => l / total)];
  }
  const n = curve.points.length;
  if (n < 2) return [0];
  const divisions = 200;
  const lengths = curve.getLengths(divisions);
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

/** path のキーフレームに注視点オーバーライド(look)が1つでもあるか */
export function hasKeyframeAim(path) {
  return path.some((e) => e && e !== '@current' && !Array.isArray(e) && Array.isArray(e.look));
}

/**
 * キーフレーム注視点オーバーライドを aim キー列へ変換する（既存 sampleAimPoint で評価できる形）。
 * 各キーフレーム i の時刻 t = そのキーフレームの弧長割合 fracs[i]（=カメラが通過する位置進行）。
 * look を持つキーはその点、持たないキーはフェーズ既定 lookAt（point/target）を採用する。
 * → カメラがキーフレーム間を進むのに合わせて注視点が補間される。
 * @returns aim キー配列、または look が無ければ null
 */
export function buildKeyframeAimKeys(phase, fracs) {
  const path = phase.path;
  if (!hasKeyframeAim(path)) return null;
  const lc = phase.lookAt;
  const def = Array.isArray(lc?.point)
    ? { point: lc.point }
    : lc?.target
      ? { target: lc.target }
      : { point: [0, 0.5, 0] };
  return path.map((e, i) => {
    const t = fracs[i] ?? (path.length > 1 ? i / (path.length - 1) : 0);
    if (e && e !== '@current' && !Array.isArray(e) && Array.isArray(e.look)) {
      return { t, point: e.look };
    }
    return { t, ...def };
  });
}

/** lookCurrent を point へ指数平滑（applyLook と同式。aim キーフレーム評価用） */
export function smoothToPoint(lookCurrent, point, lerp, dt, opts) {
  if (opts && opts.initialized === false) {
    lookCurrent.copy(point);
    opts.onInit?.(point);
  }
  const l = lerp ?? 1.0;
  if (l >= 1.0) lookCurrent.copy(point);
  else lookCurrent.lerp(point, 1 - Math.pow(1 - l, dt * 60));
}

// ---- 自由回転（Phase3b: quaternion キーフレーム） ----
// 向きトラックに quat キーが1つでもあれば「free モード」とし、向きを quaternion で
// 評価する（roll を含むため look 点では表現できない）。aim キー(point/target)は
// camPos からの lookAt 回転に変換して slerp に混ぜる。

/** 向きトラックが自由回転(quat)キーを含むか */
export function hasFreeOrientation(keys) {
  return keys.some((k) => Array.isArray(k.quat));
}

/** キーの目標 quaternion を解決（quat はそのまま、aim は camPos→点 の lookAt 回転）。null なら不能 */
function keyQuat(key, camPos, resolveTarget, out) {
  if (Array.isArray(key.quat)) {
    return out.set(key.quat[0], key.quat[1], key.quat[2], key.quat[3]).normalize();
  }
  const p = resolveKeyPoint(key, resolveTarget, _pa);
  if (!p) return null;
  _m4.lookAt(camPos, p, _upv); // camera.lookAt と同じ（カメラは eye=camPos, target=p）
  return out.setFromRotationMatrix(_m4);
}

/** quat キーフレーム列から u 時点の目標 quaternion を slerp 内挿。null なら不能 */
export function sampleOrientationQuat(keys, u, resolveTarget, camPos, out) {
  const { a, b, f } = segAt(keys, u);
  const qa = keyQuat(a, camPos, resolveTarget, _qa);
  if (!qa) return null;
  if (a === b || f <= 0) return out.copy(qa);
  const qb = keyQuat(b, camPos, resolveTarget, _qb) ?? qa;
  return out.slerpQuaternions(qa, qb, f);
}

/** currentQuat を targetQuat へ指数平滑 slerp（smoothToPoint の quaternion 版） */
export function smoothQuat(currentQuat, targetQuat, lerp, dt, opts) {
  if (opts && opts.initialized === false) {
    currentQuat.copy(targetQuat);
    opts.onInit?.();
  }
  const l = lerp ?? 1.0;
  if (l >= 1.0) currentQuat.copy(targetQuat);
  else currentQuat.slerp(targetQuat, 1 - Math.pow(1 - l, dt * 60));
}

/**
 * 追従ホールド評価器（type:"follow" の per-frame 積分）。
 * カメラは center まわりの極座標（角・半径・高さ）を平滑化しつつ、進入時の実オフセットを
 * blendIn 秒で設定値へ移行する。本番(director)・ベイク(simulator)双方がこの step を回す。
 */
export class FollowEvaluator {
  constructor(phase) {
    this.phase = phase;
    this.elapsed = 0;
    this.inited = false;
    this.camAng = 0;
    this.camRad = 0;
    this.camHgt = 0;
    this.lag0 = 0;
    this.radOff0 = 0;
    this.hgt0 = 0;
    this._center = null; // lookBlend 用に最後の center/head を保持（supplier 欠落時の保険）
    this._head = null;
  }

  /**
   * @param dt
   * @param {THREE.Vector3|null} head 先鋒位置（supplier 欠落時 null）
   * @param {THREE.Vector3|null} center 周回中心（同上）
   * @param {THREE.Vector3} pos カメラ位置（進入時に読み、毎フレーム書き込む）
   * @param {THREE.Vector3} lookCurrent 注視点（mutate）
   * @param resolveTarget applyLook フォールバック用
   * @param opts lookInit オプション（director のみ）
   * @returns {THREE.Vector3|null} 注視点（駆動側の lookAt 用）
   */
  step(dt, head, center, pos, lookCurrent, resolveTarget, opts) {
    const phase = this.phase;
    this.elapsed += dt;

    if (head && center) {
      this._head = head;
      this._center = center;

      _rel.copy(head).sub(center);
      _rel.y = 0;
      const distHead = _rel.length();
      const angHead = Math.atan2(_rel.z, _rel.x);
      const hgtHead = (head.y - center.y) * (phase.headHeightInfluence ?? 0.5);

      if (!this.inited) {
        const rx = pos.x - center.x;
        const rz = pos.z - center.z;
        this.camRad = Math.hypot(rx, rz);
        this.camAng = Math.atan2(rz, rx);
        this.camHgt = pos.y - center.y;
        this.lag0 = wrapNear(angHead - this.camAng, phase.angleLag ?? 0);
        this.radOff0 = this.camRad - distHead;
        this.hgt0 = this.camHgt - hgtHead;
        this.inited = true;
      }

      const b = Math.min(this.elapsed / (phase.blendIn ?? 1.2), 1);
      const s = b * b * (3 - 2 * b);
      const lag = this.lag0 + ((phase.angleLag ?? 0) - this.lag0) * s;
      const radOff = this.radOff0 + ((phase.radiusOffset ?? 1.0) - this.radOff0) * s;
      const hgtOff = this.hgt0 + ((phase.heightOffset ?? 0.2) - this.hgt0) * s;

      const k = 1 - Math.pow(1 - (phase.posLerp ?? 0.06), dt * 60);
      this.camAng += wrapPi(angHead - lag - this.camAng) * k;
      this.camRad += (distHead + radOff - this.camRad) * k;
      this.camHgt += (hgtHead + hgtOff - this.camHgt) * k;

      pos.set(
        center.x + Math.cos(this.camAng) * this.camRad,
        center.y + this.camHgt,
        center.z + Math.sin(this.camAng) * this.camRad
      );
    }

    if (phase.lookBlend != null) {
      const c = center ?? this._center;
      const h = head ?? this._head;
      if (!c || !h) return null;
      _look2.copy(c).lerp(h, phase.lookBlend);
      if (opts && opts.initialized === false) {
        lookCurrent.copy(_look2);
        opts.onInit?.(_look2);
      }
      const lookLerp = phase.lookAt?.lerp ?? 0.1;
      const k2 = 1 - Math.pow(1 - lookLerp, dt * 60);
      lookCurrent.lerp(_look2, k2);
      return _look2;
    }
    return applyLook(phase.lookAt, dt, lookCurrent, resolveTarget, opts);
  }
}

/**
 * 閉ループ周回評価器（type:"loop" の per-frame 積分）。
 * 進入時の実位置から blendDur 秒で曲線へ寄せ、release 後は最寄り exitPoint へ減速進行する。
 * - director: release() 時に beginRelease() を呼ぶ（呼び出し時点の progress から releaseTarget 確定）
 * - simulator: holdFrames 到達フレームで step に wantRelease=true を渡す
 *   （その場合は当該フレームの増分後の progress から確定 ＝ 旧 simulator と同順序）
 */
export class LoopEvaluator {
  constructor(phase, curve, entryPos) {
    this.phase = phase;
    this.curve = curve;
    this.entryPos = entryPos.clone();
    this.blendDur = 0.7;
    this.progress = 0;
    this.blend = 0;
    this.releasing = false;
    this.releaseTarget = null;
  }

  beginRelease() {
    const phase = this.phase;
    const minP = phase.minHoldProgress ?? 0;
    const n = phase.exitPoints ?? 4;
    const base = Math.max(this.progress, minP);
    this.releaseTarget = Math.ceil(base * n + 1e-6) / n;
    this.releasing = true;
  }

  /** @returns {THREE.Vector3|null} 注視点 */
  step(dt, pos, lookCurrent, resolveTarget, { wantRelease = false, lookOpts } = {}) {
    const phase = this.phase;
    if (!this.releasing) {
      this.progress += dt / phase.loopDuration;
      if (wantRelease) this.beginRelease();
    } else {
      const remaining = this.releaseTarget - this.progress;
      const stepv = Math.max(remaining * dt * 2.5, (dt / phase.loopDuration) * 0.5);
      this.progress = Math.min(this.progress + stepv, this.releaseTarget);
    }

    this.curve.getPointAt(this.progress % 1, pos);
    if (this.blend < 1) {
      this.blend = Math.min(this.blend + dt / this.blendDur, 1);
      const e = this.blend * this.blend * (3 - 2 * this.blend);
      pos.lerpVectors(this.entryPos, pos, e);
    }
    return applyLook(phase.lookAt, dt, lookCurrent, resolveTarget, lookOpts);
  }

  get done() {
    return this.releasing && this.progress >= this.releaseTarget - 1e-4;
  }
}
