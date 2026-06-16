/**
 * パスカット（移動 overlay）の自動スモーク:
 *  1) camera-simulator.bakeGenerateCamera が overlay path を焼き込む（layer/type/markers/軌跡）
 *  2) OverlayScheduler（本番）が同じカーブ上をカメラ移動・fov ランプ・向き snap する
 * GPU 非依存。frame 厳密一致ではなく、ベジェ補完・割り込み合成が機能することを検証する。
 */
import * as THREE from 'three';
import { bakeGenerateCamera, FPS } from '../src/editor/camera-simulator.js';
import { OverlayScheduler } from '../src/core/overlay-scheduler.js';

let ok = true;
const fail = (m) => { ok = false; console.error('  ✗ ' + m); };
const near = (a, b, eps, m) => { if (Math.abs(a - b) > eps) fail(`${m}: ${a} vs ${b} (eps ${eps})`); };

const heroPos = (out, t) => out.set(Math.sin(t) * 1.5, 0.6, -t * 0.8);

// base path 1本 + パスカット（移動 overlay）1本
const gcfg = {
  bottlePos: [10, 0.4, -6],
  bottleScale: 1.6,
  particles: { grid: [8, 8] },
  lights: [],
  shots: [
    {
      id: 'base', type: 'path', duration: 4.0, ease: 'none',
      path: [[0, 0.5, 2], [0, 0.6, 4], [0.5, 0.8, 5]], times: [0, 0.5, 1],
      lookAt: { mode: 'fixed', point: [0, 0.5, 0] }, fov: [45, 50],
    },
    {
      id: 'cut', type: 'path', start: 1.0, duration: 1.0, ease: 'none',
      path: [[-2, 1, 1], [0, 2, -1], [2, 1, -3]], times: [0, 0.5, 1],
      lookAt: { mode: 'fixed', point: [0, 0.5, 0] }, fov: [30, 60],
    },
  ],
};

// ---- 1) ベイク ----
const baked = bakeGenerateCamera(gcfg, { heroPos });
const cut = baked.shots.find((s) => s.id === 'cut');
if (!cut) fail('cut overlay info が無い');
else {
  if (cut.layer !== 'overlay') fail(`cut.layer=${cut.layer}（overlay 期待）`);
  if (cut.type !== 'path') fail(`cut.type=${cut.type}（path 期待）`);
  if (cut.markers.length !== 3) fail(`cut.markers=${cut.markers.length}（3 期待）`);
  near(cut.startFrame, Math.round(1.0 * FPS), 0.5, 'cut.startFrame');

  // overlay 窓の開始フレーム≈path[0]、終端≈path[2]（ベジェ端点はアンカーを通る）
  const f0 = cut.startFrame;
  const fE = cut.startFrame + cut.frameCount - 1;
  near(baked.pos[f0 * 3], -2, 0.15, 'bake 開始x');
  near(baked.pos[fE * 3 + 0], 2, 0.05, 'bake 終端x');
  near(baked.pos[fE * 3 + 2], -3, 0.05, 'bake 終端z');
  // 中間フレームは base パス(z<=5)ではなく cut パス上（y が base より高い ~2 付近を通る）
  const fmid = cut.startFrame + Math.floor(cut.frameCount / 2);
  if (!(baked.pos[fmid * 3 + 1] > 1.2)) fail(`bake 中間 y=${baked.pos[fmid * 3 + 1]}（cut 軌跡なら>1.2）`);
  // fov ランプ: 終端は cut の 60 に達する（base の 50 ではない）
  near(baked.fov[fE], 60, 0.5, 'bake 終端fov');

  // 俯瞰の本線(破線)用: basePos は overlay 上書き前の本線を保持している
  // → カット窓内では pos(=cut, y高い) と basePos(=本線, y低い) が食い違う
  if (!baked.basePos) fail('baked.basePos が無い');
  else {
    const yPos = baked.pos[fmid * 3 + 1];
    const yBase = baked.basePos[fmid * 3 + 1];
    if (!(yBase < 1.0)) fail(`basePos 本線 y=${yBase}（base パスなら<1.0）`);
    if (!(Math.abs(yPos - yBase) > 0.5)) fail(`カット窓で pos と basePos が食い違わない（${yPos} vs ${yBase}）`);
  }
}

// ---- 2) 本番スケジューラ ----
const camera = new THREE.PerspectiveCamera(45, 1.6, 0.1, 100);
const bottleCenter = new THREE.Vector3(10, 0.4, -6).add(new THREE.Vector3(0, 0.4 * 1.6, 0));
const scheduler = new OverlayScheduler(camera, {
  resolveTarget: (name, out) => {
    if (name === 'bottle') return out.copy(bottleCenter);
    if (name === 'heroParticle') return heroPos(out, 0);
    return null;
  },
  offsetFor: (shot) => (shot.relativeTo === 'bottle' ? bottleCenter.clone() : null),
});
scheduler.setShots(gcfg.shots);

const DT = 1 / FPS;
let overrodeDuring = false, overrodeOutside = false;
let midPos = null, endFov = null;
for (let f = 0; f < Math.round(3 * FPS); f++) {
  // base カメラの代役（窓外で scheduler が触らないことの確認用に毎フレーム既知値へ）
  camera.position.set(99, 99, 99);
  const did = scheduler.tick(DT);
  const now = (f + 1) * DT;
  if (now > 1.05 && now < 1.95) {
    if (did) overrodeDuring = true;
    if (now >= 1.45 && now <= 1.55) midPos = camera.position.clone(); // 窓中央（t≈0.5）
    if (now > 1.9) endFov = camera.fov; // 窓終盤
  }
  if (now > 2.2 && did) overrodeOutside = true;
}
if (!overrodeDuring) fail('cut 窓内で scheduler が上書きしていない');
if (overrodeOutside) fail('cut 窓外で scheduler が上書きしている');
if (!midPos) fail('窓中央でカメラ位置が取得できていない');
else if (!(midPos.y > 1.2)) fail(`scheduler 窓中央 y=${midPos.y}（cut 軌跡 t≈0.5 なら>1.2）`);
// 窓終盤の fov は cut の 60 へ近づく（base の 50 ではない）
if (endFov == null || endFov < 50) fail(`scheduler 終盤 fov=${endFov}（60 へ向かう想定）`);

console.log(ok ? '✓ パスカット: ベイク＋本番スケジューラ 正常' : '✗ パスカット 検証失敗');
process.exit(ok ? 0 : 1);
