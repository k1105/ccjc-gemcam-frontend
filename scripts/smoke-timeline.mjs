/**
 * タイムラインエディタのスモークテスト:
 * D でエディタ起動 → タイムラインを開き、フレームステップ / スクラブの決定論性 /
 * 再生 / クローズ時のカメラ復元とリソース解放を検証する。
 *
 *   VITE_MOCK=1 npx vite --port 5199 を起動した状態で
 *   node scripts/smoke-timeline.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.SMOKE_URL || 'http://localhost:5199';
const OUT = new URL('../.smoke/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
page.on('pageerror', (err) => errors.push(String(err)));

const shot = (name) => page.screenshot({ path: `${OUT}${name}.png` });
const meminfo = () => page.evaluate(() => ({ ...window.app.ctx.world.renderer.info.memory }));
const campos = () =>
  page.evaluate(() => {
    const c = window.app.ctx.world.camera;
    return { x: c.position.x, y: c.position.y, z: c.position.z, fov: c.fov };
  });

let failed = 0;
const assert = (cond, label) => {
  console.log(`${cond ? 'OK ' : 'NG '} ${label}`);
  if (!cond) failed++;
};

console.log('--- load');
await page.goto(BASE);
await page.waitForFunction(() => window.app?.ctx.manager.currentName === 'select');
// SELECT 入場のカメラトゥイーン（1.2s）完了を待ってから基準値を取る
await page.waitForFunction(() => {
  const { world, choreo } = window.app.ctx;
  const cfg = choreo.data.select.camera;
  return Math.abs(world.camera.position.z - cfg.pos[2]) < 1e-3 && world.camera.fov === cfg.fov;
});
const camBefore = await campos();

console.log('--- open editor (D) + timeline');
await page.keyboard.press('D');
await page.waitForFunction(() => !!window.app.editor);
await page.waitForTimeout(800); // PathEditor の可視化が一度描画されるのを待つ
const memBase = await meminfo(); // 基準=エディタ表示後（タイムライン開閉のリーク検出用）
await page.evaluate(() => window.app.editor.timeline.open());
await page.waitForFunction(() => window.app.editor.timeline.isOpen);
await page.waitForTimeout(500);
// D で開くと既定が Free(俯瞰)。cam モードのフレーム検証のため明示的に Camera へ
await page.evaluate(() => window.app.editor.timeline._setViewMode('cam'));
await page.waitForTimeout(200);
await shot('30-timeline-open');

const baked = await page.evaluate(() => {
  const b = window.app.editor.timeline.baked;
  return {
    totalFrames: b.totalFrames,
    swapTime: b.swapTime,
    phases: b.shots.map((p) => ({ id: p.id, type: p.type, frames: p.frameCount, markers: (p.markers ?? []).length })),
  };
});
console.log('baked:', JSON.stringify(baked));
assert(baked.totalFrames > 300, `ベイク済み (${baked.totalFrames} frames)`);
assert(baked.phases.length === 4, '4ショット');
assert(baked.swapTime !== null, 'swapTime(photoRecede終了)が確定');

console.log('--- frame step determinism');
const seek = (f) => page.evaluate((n) => window.app.editor.timeline._seek(n), f);
await seek(120);
const a = await campos();
await seek(0);
await seek(120);
const b = await campos();
assert(JSON.stringify(a) === JSON.stringify(b), 'frame120 へのシークが決定論的（往復一致）');
await seek(121);
const c = await campos();
assert(JSON.stringify(a) !== JSON.stringify(c), '±1フレームでカメラ状態が変化');

console.log('--- keyboard step');
await page.keyboard.press('ArrowLeft');
const d = await campos();
assert(JSON.stringify(d) === JSON.stringify(a), '← で1フレーム戻る（=frame120）');

console.log('--- scrub to follow phase (particles visible)');
const followStart = await page.evaluate(() => {
  const p = window.app.editor.timeline.baked.shots.find((x) => x.type === 'follow');
  return p.startFrame + Math.floor(p.frameCount / 2);
});
await seek(followStart);
await page.waitForTimeout(300);
await shot('31-timeline-follow-mid');

console.log('--- free (俯瞰) view');
await page.keyboard.press('v');
await page.waitForTimeout(400);
const free = await page.evaluate(() => {
  const tl = window.app.editor.timeline;
  const cam = window.app.ctx.world.camera;
  const i = Math.round(tl.frame) * 3;
  const ghostMatchesBaked =
    Math.abs(tl.ghost.position.x - tl.baked.pos[i]) < 1e-6 &&
    Math.abs(tl.ghost.position.z - tl.baked.pos[i + 2]) < 1e-6;
  const camAwayFromPath =
    Math.hypot(cam.position.x - tl.baked.pos[i], cam.position.z - tl.baked.pos[i + 2]) > 1.0;
  return {
    mode: tl.viewMode,
    helperVisible: tl.helper.visible,
    trajLines: tl.traj.children.length,
    ghostMatchesBaked,
    camAwayFromPath,
  };
});
assert(free.mode === 'free', 'V で俯瞰モードへ');
assert(free.helperVisible, 'カメラヘルパー表示');
// 4ショットぶんの軌跡ライン + 先鋒(hero)ライン/ドット
assert(free.trajLines >= 4, `軌跡ラインがショット数ぶん以上 (${free.trajLines})`);
assert(free.ghostMatchesBaked, 'ゴーストがベイク位置に追従');
assert(free.camAwayFromPath, '実カメラはパスから離れた俯瞰位置');
await shot('34-timeline-free-view');
await page.keyboard.press('v');
await page.waitForTimeout(200);
const backToCam = await page.evaluate(() => {
  const tl = window.app.editor.timeline;
  const cam = window.app.ctx.world.camera;
  const i = Math.round(tl.frame) * 3;
  return tl.viewMode === 'cam' && Math.abs(cam.position.x - tl.baked.pos[i]) < 1e-6;
});
assert(backToCam, 'V で演出カメラ視点へ復帰');

console.log('--- play 1s');
await page.keyboard.press(' ');
await page.waitForTimeout(1000);
const playing = await page.evaluate(() => window.app.editor.timeline.playing);
assert(playing, 'Space で再生中');
await page.keyboard.press(' ');
await shot('32-timeline-playing');

console.log('--- edit a path value -> auto rebake');
const framesBefore = baked.totalFrames;
await page.evaluate(() => {
  const choreo = window.app.ctx.choreo;
  choreo.data.generate.shots[0].duration = 4.0; // 3.0 -> 4.0
  window.app.editor.timeline.invalidate();
});
await page.waitForTimeout(600);
const framesAfter = await page.evaluate(() => window.app.editor.timeline.baked.totalFrames);
assert(framesAfter === framesBefore + 60, `値変更で自動リベイク (${framesBefore} -> ${framesAfter})`);

console.log('--- click base block to select shot (incl. follow) ---');
const obBox = await page.$eval('.tlx-phase[data-shot="orbitFollow"]', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(obBox.x, obBox.y);
await page.waitForTimeout(300);
const blkSel = await page.evaluate(() => ({
  id: window.app.editor.pathEditor.state.phaseId,
  hi: !!document.querySelector('.tlx-phase[data-shot="orbitFollow"].tlx-selected'),
}));
assert(blkSel.id === 'orbitFollow', `follow ブロッククリックで選択 (${blkSel.id})`);
assert(blkSel.hi, 'クリックしたブロックが枠ハイライト');

console.log('--- add/remove a static shot @playhead (Phase4b)');
// プレイヘッドをショット#1(heroFollow)の中間へ → static はその直後(index 2)に入るはず
const phShot = await page.evaluate(() => {
  const tl = window.app.editor.timeline;
  const s = tl.baked.shots[1];
  tl._seek(s.startFrame + Math.floor(s.frameCount / 2));
  return { id: s.id, index: 1 };
});
const beforeShots = await page.evaluate(() => window.app.ctx.choreo.data.generate.shots.length);
await page.evaluate(() => window.app.editor.pathEditor._addShot());
await page.waitForTimeout(600);
const afterAdd = await page.evaluate(() => {
  const shots = window.app.ctx.choreo.data.generate.shots;
  const baked = window.app.editor.timeline.baked;
  const newIdx = shots.findIndex((s) => s.type === 'static');
  const ov = baked.shots.find((s) => s.type === 'static');
  const sf = ov ? ov.startFrame : -1;
  // オーバーレイ区間の先頭フレームが static の pos([0,1,3]) で base を上書きしているか
  const overridden = sf >= 0 && Math.hypot(baked.pos[sf * 3] - 0, baked.pos[sf * 3 + 1] - 1, baked.pos[sf * 3 + 2] - 3) < 1e-3;
  return { count: shots.length, hasStaticBake: !!ov, newIdx, overridden, startFrame: sf };
});
assert(afterAdd.count === beforeShots + 1, `static ショット追加 (${beforeShots} -> ${afterAdd.count})`);
assert(afterAdd.hasStaticBake, 'static ショットがベイクに反映');
assert(afterAdd.newIdx === phShot.index + 1, `プレイヘッド(${phShot.id})直後に挿入 (index ${afterAdd.newIdx})`);
assert(afterAdd.overridden, `オーバーレイが開始フレーム(${afterAdd.startFrame})で base を上書き`);

// 選択中ショットのタイムライン枠ハイライト
const hi = await page.evaluate(() => {
  const sel = [...document.querySelectorAll('.tlx-phase.tlx-selected')];
  const id = window.app.editor.pathEditor.state.phaseId;
  return { count: sel.length, matches: sel.length === 1 && sel[0].dataset.shot === id };
});
assert(hi.matches, `選択ショットのみ枠ハイライト (selected=${hi.count})`);

console.log('--- drag static block to retime (start) ---');
const startBefore = await page.evaluate(
  () => window.app.ctx.choreo.data.generate.shots.find((s) => s.type === 'static').start
);
const box = await page.$eval('.tlx-phase.tlx-static', (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(box.x, box.y);
await page.mouse.down();
await page.mouse.move(box.x - 60, box.y, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(600);
const dragRes = await page.evaluate(() => {
  const s = window.app.ctx.choreo.data.generate.shots.find((x) => x.type === 'static');
  const ov = window.app.editor.timeline.baked.shots.find((x) => x.type === 'static');
  return { start: s.start, sf: ov?.startFrame };
});
assert(dragRes.start < startBefore, `ドラッグで start が左へ移動 (${startBefore} -> ${dragRes.start})`);
assert(
  Math.abs(dragRes.sf - Math.round(dragRes.start * 60)) <= 1,
  `ベイクのオーバーレイ開始フレームが追従 (${dragRes.sf})`
);

console.log('--- click static block seeks to click pos (not head) ---');
const clk = await page.evaluate(() => {
  const tl = window.app.editor.timeline;
  const ov = tl.baked.shots.find((s) => s.type === 'static');
  const el = document.querySelector('.tlx-phase.tlx-static');
  const r = el.getBoundingClientRect();
  const t = document.querySelector('.tlx-track').getBoundingClientRect();
  return { startFrame: ov.startFrame, x: r.x + r.width * 0.8, y: r.y + r.height / 2, total: tl.baked.totalFrames, tl: t.left, tw: t.width };
});
await page.mouse.click(clk.x, clk.y);
await page.waitForTimeout(200);
const clkFrame = await page.evaluate(() => Math.round(window.app.editor.timeline.frame));
const clkExpected = Math.round(Math.max(0, Math.min((clk.x - clk.tl) / clk.tw, 1)) * (clk.total - 1));
assert(Math.abs(clkFrame - clkExpected) <= 1, `定点クリックでクリック位置へシーク (f=${clkFrame}, 期待≈${clkExpected})`);
assert(clkFrame > clk.startFrame + 1, `ブロック先頭にスナップしない (start=${clk.startFrame}, f=${clkFrame})`);

console.log('--- static pan (注視点キーフレーム) ---');
await page.evaluate(() => window.app.editor.pathEditor._setStaticLookMode('keyframe'));
await page.waitForTimeout(600);
const pan = await page.evaluate(() => {
  const s = window.app.ctx.choreo.data.generate.shots.find((x) => x.type === 'static');
  const b = window.app.editor.timeline.baked;
  const ov = b.shots.find((x) => x.type === 'static');
  const sf = ov.startFrame;
  const ef = ov.startFrame + ov.frameCount - 1;
  return { keys: s.lookAt.keys?.length, lookStartX: b.look[sf * 3], lookEndX: b.look[ef * 3] };
});
assert(pan.keys === 2, `注視点キーフレーム2点生成 (${pan.keys})`);
assert(Math.abs(pan.lookEndX - pan.lookStartX) > 0.5, `パンで注視点xが時間変化 (${(+pan.lookStartX).toFixed(2)} -> ${(+pan.lookEndX).toFixed(2)})`);

await page.evaluate(() => window.app.editor.pathEditor._removeShot());
await page.waitForTimeout(500);
const afterRemove = await page.evaluate(() => window.app.ctx.choreo.data.generate.shots.length);
assert(afterRemove === beforeShots, `static ショット削除で復元 (${afterRemove})`);

console.log('--- ＋keyframe at seekbar inserts anchor on curve ---');
const kfPre = await page.evaluate(() => {
  const tl = window.app.editor.timeline;
  const info = tl.baked.shots.find((s) => s.id === 'heroFollow');
  const F = info.startFrame + Math.floor(info.frameCount / 2);
  tl._seek(F);
  window.app.editor.pathEditor.selectKeyframe('heroFollow', 0);
  const path = window.app.ctx.choreo.data.generate.shots.find((s) => s.id === 'heroFollow').path;
  return { F, before: path.length, camAt: [tl.baked.pos[F * 3], tl.baked.pos[F * 3 + 1], tl.baked.pos[F * 3 + 2]] };
});
await page.evaluate(() => window.app.editor.pathEditor._addKeyframe());
await page.waitForTimeout(600);
const kfRes = await page.evaluate((camAt) => {
  const pe = window.app.editor.pathEditor;
  const path = window.app.ctx.choreo.data.generate.shots.find((s) => s.id === 'heroFollow').path;
  const a = path[pe.state.keyframe];
  const ap = Array.isArray(a) ? a : a.p;
  return {
    len: path.length,
    sel: pe.state.phaseId,
    dist: Math.hypot(ap[0] - camAt[0], ap[1] - camAt[1], ap[2] - camAt[2]),
  };
}, kfPre.camAt);
assert(kfRes.len === kfPre.before + 1, `アンカーが1つ追加 (${kfPre.before} -> ${kfRes.len})`);
assert(kfRes.sel === 'heroFollow', `playhead のショットが選択された (${kfRes.sel})`);
assert(kfRes.dist < 0.05, `追加アンカーがシークバー位置(曲線上)に一致 (Δ=${kfRes.dist.toFixed(4)})`);

console.log('--- close (Esc): camera restore + resource release');
await page.keyboard.press('Escape');
await page.waitForFunction(() => !window.app.editor.timeline.isOpen);
await page.waitForTimeout(800); // select ドリフト再開
const camAfter = await campos();
assert(Math.abs(camAfter.z - camBefore.z) < 0.01, `カメラz復元 (${camAfter.z.toFixed(3)})`);
assert(camAfter.fov === camBefore.fov, 'fov 復元');
const state = await page.evaluate(() => window.app.ctx.manager.currentName);
assert(state === 'select', 'Esc がブースリセットに化けていない（select のまま）');
// シーンにプレビュー残骸（写真プレーン/パーティクル/プレビューボトル）が無いこと
const leftover = await page.evaluate(() => {
  let points = 0;
  window.app.ctx.world.scene.traverse((o) => {
    if (o.isPoints) points++;
  });
  return points;
});
assert(leftover === 0, 'パーティクル(Points)がシーンに残っていない');
const memCycle1 = await meminfo();
await shot('33-timeline-closed');

// 開閉サイクルを繰り返してもメモリが増えないこと（初回はギズモ等の初描画
// アップロードがあるため、サイクル間の差分で判定する）
console.log('--- 2nd open/seek/play/close cycle (leak check)');
const runCycle = async () => {
  await page.evaluate(() => window.app.editor.timeline.open());
  await page.waitForFunction(() => window.app.editor.timeline.isOpen);
  await page.waitForTimeout(400);
  await seek(followStart);
  await page.keyboard.press(' ');
  await page.waitForTimeout(700);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.app.editor.timeline.isOpen);
  await page.waitForTimeout(300);
};
await runCycle();
const memCycle2 = await meminfo();
console.log('cycle1:', JSON.stringify(memCycle1), '-> cycle2:', JSON.stringify(memCycle2));
assert(
  memCycle2.geometries <= memCycle1.geometries && memCycle2.textures <= memCycle1.textures,
  '開閉サイクルでジオメトリ/テクスチャが増えない（リークなし）'
);

const fatal = errors.filter((e) => !e.includes('favicon'));
assert(fatal.length === 0, `コンソールエラーなし${fatal.length ? `: ${fatal.join(' | ')}` : ''}`);

await browser.close();
console.log(failed ? `\n${failed} 件失敗` : '\n全チェック通過');
process.exit(failed ? 1 : 0);
