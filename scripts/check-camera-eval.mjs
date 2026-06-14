/**
 * Phase1 検証ハーネス: camera-simulator.bakeGenerateCamera の出力（全フレームの
 * pos/look/fov とフェーズ情報・マーカー）を決定論的に算出し、
 *   --save  … ベースライン(/tmp/cam-eval-baseline.json)へ保存
 *   (既定)  … ベースラインと突き合わせて最大絶対差を報告（一致=リファクタ無害）
 *
 * heroPos は GPU 非依存の決定論スタブを使い、カメラ数式の差分だけを切り出す。
 */
import * as THREE from 'three';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { bakeGenerateCamera } from '../src/editor/camera-simulator.js';

const BASELINE = '/tmp/cam-eval-baseline.json';
const choreo = JSON.parse(
  readFileSync(new URL('../src/choreo/choreography.json', import.meta.url))
);

// 決定論的な先鋒位置スタブ（実 PhotoParticles とは無関係でよい。再現性のみ重要）
function heroPos(out, t) {
  return out.set(
    Math.sin(t * 0.7) * 1.5 + t * 0.3,
    0.6 + Math.cos(t * 0.9) * 0.4,
    -t * 0.8 + Math.sin(t * 0.5) * 0.6
  );
}

const baked = bakeGenerateCamera(choreo.generate, { heroPos });
const snap = {
  totalFrames: baked.totalFrames,
  swapTime: baked.swapTime,
  phases: baked.phases.map((p) => ({
    id: p.id,
    type: p.type,
    startFrame: p.startFrame,
    frameCount: p.frameCount,
    markers: p.markers,
  })),
  pos: Array.from(baked.pos),
  look: Array.from(baked.look),
  fov: Array.from(baked.fov),
};

if (process.argv.includes('--save')) {
  writeFileSync(BASELINE, JSON.stringify(snap));
  console.log(`[baseline saved] frames=${snap.totalFrames} → ${BASELINE}`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error(`baseline がありません。先に \`node scripts/check-camera-eval.mjs --save\` を実行`);
  process.exit(1);
}
const base = JSON.parse(readFileSync(BASELINE));

let ok = true;
const fail = (msg) => {
  ok = false;
  console.error('  ✗ ' + msg);
};

if (snap.totalFrames !== base.totalFrames) fail(`totalFrames ${base.totalFrames} → ${snap.totalFrames}`);
if (snap.swapTime !== base.swapTime) fail(`swapTime ${base.swapTime} → ${snap.swapTime}`);
if (JSON.stringify(snap.phases) !== JSON.stringify(base.phases)) {
  fail('phases/markers が不一致');
  console.error('   base:', JSON.stringify(base.phases));
  console.error('   new :', JSON.stringify(snap.phases));
}

const maxDiff = (a, b) => {
  if (!a || !b || a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const dp = maxDiff(snap.pos, base.pos);
const dl = maxDiff(snap.look, base.look);
const df = maxDiff(snap.fov, base.fov);
const EPS = 1e-6;
console.log(`  max|Δ| pos=${dp.toExponential(2)} look=${dl.toExponential(2)} fov=${df.toExponential(2)}`);
if (dp > EPS) fail(`pos 差分 ${dp}`);
if (dl > EPS) fail(`look 差分 ${dl}`);
if (df > EPS) fail(`fov 差分 ${df}`);

console.log(ok ? '✓ ベイク一致（リファクタ無害）' : '✗ 不一致');
process.exit(ok ? 0 : 1);
