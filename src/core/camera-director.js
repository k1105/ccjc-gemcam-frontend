import * as THREE from 'three';
import gsap from 'gsap';

const _look = new THREE.Vector3();
const _pos = new THREE.Vector3();

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
    const pts = path.map((p) => {
      if (p === '@current') return this.camera.position.clone();
      const v = new THREE.Vector3(p[0], p[1], p[2]);
      if (offset) v.add(offset);
      return v;
    });
    return new THREE.CatmullRomCurve3(pts, closed, 'centripetal');
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
    let targetPoint = null;
    if (lookCfg.mode === 'fixed') {
      _look.set(lookCfg.point[0], lookCfg.point[1], lookCfg.point[2]);
      targetPoint = _look;
    } else if (lookCfg.mode === 'target') {
      const supplier = this.targets.get(lookCfg.target);
      if (supplier) {
        supplier(_look);
        targetPoint = _look;
      }
    }
    if (!targetPoint) return;

    if (!this._lookInitialized) this.syncLookFromCamera(targetPoint);

    const lerp = lookCfg.lerp ?? 1.0;
    if (lerp >= 1.0) {
      this.lookCurrent.copy(targetPoint);
    } else {
      // フレームレート非依存の指数平滑
      const k = 1 - Math.pow(1 - lerp, dt * 60);
      this.lookCurrent.lerp(targetPoint, k);
    }
    this.camera.lookAt(this.lookCurrent);
  }

  /** 一方向パスを再生して完了で resolve */
  playPhase(phase) {
    const offset = this._resolveOffset(phase);
    const curve = this._buildCurve(phase.path, offset);
    const state = { t: 0 };
    const fovFrom = phase.fov ? phase.fov[0] : null;
    const fovTo = phase.fov ? phase.fov[1] : null;

    return new Promise((resolve) => {
      const tick = (dt) => {
        curve.getPointAt(Math.min(state.t, 1), _pos);
        this.camera.position.copy(_pos);
        if (fovFrom !== null) {
          this.camera.fov = fovFrom + (fovTo - fovFrom) * state.t;
          this.camera.updateProjectionMatrix();
        }
        this._applyLook(phase.lookAt, dt);
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
    const blendDur = 0.7; // 進入時のブレンド秒数
    const entryPos = this.camera.position.clone();

    let progress = 0; // 累積（mod せず保持: minHoldProgress 判定用）
    let blend = 0;
    let releasing = false;
    let releaseTarget = null;
    let resolveFn = null;

    const tick = (dt) => {
      if (!releasing) {
        progress += dt / phase.loopDuration;
      } else {
        // 脱出点へ向けて減速気味に進める
        const remaining = releaseTarget - progress;
        const step = Math.max(remaining * dt * 2.5, dt / phase.loopDuration * 0.5);
        progress = Math.min(progress + step, releaseTarget);
      }

      curve.getPointAt(progress % 1, _pos);
      if (blend < 1) {
        blend = Math.min(blend + dt / blendDur, 1);
        const e = blend * blend * (3 - 2 * blend); // smoothstep
        _pos.lerpVectors(entryPos, _pos, e);
      }
      this.camera.position.copy(_pos);
      this._applyLook(phase.lookAt, dt);

      if (releasing && progress >= releaseTarget - 1e-4) {
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
          const minP = phase.minHoldProgress ?? 0;
          const n = phase.exitPoints ?? 4;
          const base = Math.max(progress, minP);
          // base 以降で最寄りの k/n 地点へ
          releaseTarget = Math.ceil(base * n + 1e-6) / n;
          releasing = true;
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
    const head = new THREE.Vector3();
    const center = new THREE.Vector3();
    const rel = new THREE.Vector3();
    let resolveFn = null;
    let releasing = false;
    let elapsed = 0;
    // カメラ極座標状態（進入時に実位置から初期化）と進入時の実オフセット
    let inited = false;
    let camAng = 0;
    let camRad = 0;
    let camHgt = 0;
    let lag0 = 0;
    let radOff0 = 0;
    let hgt0 = 0;

    const tick = (dt) => {
      elapsed += dt;
      const headSup = this.targets.get(phase.target);
      const centerSup = this.targets.get(phase.center);
      if (headSup && centerSup) {
        headSup(head);
        centerSup(center);

        rel.copy(head).sub(center);
        rel.y = 0;
        const distHead = rel.length();
        const angHead = Math.atan2(rel.z, rel.x);
        const hgtHead = (head.y - center.y) * (phase.headHeightInfluence ?? 0.5);

        if (!inited) {
          // 進入時のカメラ実位置を極座標で採取。実オフセットから設定オフセットへ
          // blendIn 秒で移行することで、phase 切替時の desired の飛び（鞭打ち）を防ぐ
          const rx = this.camera.position.x - center.x;
          const rz = this.camera.position.z - center.z;
          camRad = Math.hypot(rx, rz);
          camAng = Math.atan2(rz, rx);
          camHgt = this.camera.position.y - center.y;
          lag0 = wrapNear(angHead - camAng, phase.angleLag ?? 0);
          radOff0 = camRad - distHead;
          hgt0 = camHgt - hgtHead;
          inited = true;
        }

        // 進入時オフセット → 設定値へ smoothstep で移行
        const b = Math.min(elapsed / (phase.blendIn ?? 1.2), 1);
        const s = b * b * (3 - 2 * b);
        const lag = lag0 + ((phase.angleLag ?? 0) - lag0) * s;
        const radOff = radOff0 + ((phase.radiusOffset ?? 1.0) - radOff0) * s;
        const hgtOff = hgt0 + ((phase.heightOffset ?? 0.2) - hgt0) * s;

        // 極座標で平滑化: 螺旋進入時の角速度の急変・半径の急縮みをならし、
        // 軌道は常に center まわりの円弧として描かれる
        const k = 1 - Math.pow(1 - (phase.posLerp ?? 0.06), dt * 60);
        camAng += wrapPi(angHead - lag - camAng) * k;
        camRad += (distHead + radOff - camRad) * k;
        camHgt += (hgtHead + hgtOff - camHgt) * k;

        this.camera.position.set(
          center.x + Math.cos(camAng) * camRad,
          center.y + camHgt,
          center.z + Math.sin(camAng) * camRad
        );
      }

      // lookBlend: 注視点をボトル中心(0)〜先鋒(1) の線上に置く。
      // 先鋒は粒1個で被写体として見えないため、先鋒だけを注視すると
      // 画面中央が空きボトルが端に追いやられる。両者をフレームに収める配分
      if (phase.lookBlend != null) {
        _look.copy(center).lerp(head, phase.lookBlend);
        if (!this._lookInitialized) this.syncLookFromCamera(_look);
        const lookLerp = phase.lookAt?.lerp ?? 0.1;
        const k2 = 1 - Math.pow(1 - lookLerp, dt * 60);
        this.lookCurrent.lerp(_look, k2);
        this.camera.lookAt(this.lookCurrent);
      } else {
        this._applyLook(phase.lookAt, dt);
      }

      // 生成が速く終わっても minHold 秒は周回を見せてから抜ける
      if (releasing && elapsed >= (phase.minHold ?? 0)) {
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

/** 角度を (-π, π] に正規化 */
function wrapPi(a) {
  return ((((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
}

/** 角度 a を、ref から ±π 以内の表現に直す（ブレンドが最短経路を通るように） */
function wrapNear(a, ref) {
  return ref + wrapPi(a - ref);
}
