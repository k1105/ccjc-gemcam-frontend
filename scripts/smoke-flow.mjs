/**
 * 開発用スモークテスト: SELECT → SHOOT → GENERATE → RESULT → SELECT の
 * フルループを fake camera で通し、各ステップのスクリーンショットと
 * コンソールエラーを収集する。
 *
 *   VITE_MOCK=1 VITE_MOCK_DELAY=6000 npx vite --port 5199 を起動した状態で
 *   node scripts/smoke-flow.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.SMOKE_URL || 'http://localhost:5199';
const OUT = new URL('../.smoke/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(String(err)));

const shot = (name) => page.screenshot({ path: `${OUT}${name}.png` });
const sleep = (ms) => page.waitForTimeout(ms);
const state = () => page.evaluate(() => window.app?.ctx.manager.currentName);
const meminfo = () => page.evaluate(() => ({ ...window.app.ctx.world.renderer.info.memory }));
const waitState = (name, timeout = 30000) =>
  page
    .waitForFunction((n) => window.app?.ctx.manager.currentName === n, name, { timeout })
    .catch(async () => console.log(`TIMEOUT waiting ${name}. state:`, await state()));

console.log('--- load');
await page.goto(BASE);
await waitState('select');
await sleep(1500);
console.log('state:', await state(), 'mem:', await meminfo());
await shot('01-select');

console.log('--- press 3 (select brand)');
await page.keyboard.press('3');
await sleep(1000);
await shot('02-select-sink');
await waitState('shoot');
await sleep(900); // webcam 起動待ち
await shot('03-shoot');

console.log('--- press Enter (countdown)');
await page.keyboard.press('Enter');
await sleep(1500);
await shot('04-countdown');
await waitState('generate');
await sleep(400);
await shot('05-generate-photo');

await sleep(2800); // recede 完了 → 分解開始直後
await shot('06-generate-dissolve');
await sleep(3000); // heroFollow 中盤
await shot('07-generate-follow');
await sleep(3500); // flyBy 〜 orbit
await shot('08-generate-orbit');

console.log('--- waiting for result');
await waitState('result');
await sleep(2500);
console.log('state:', await state());
await shot('09-result');

console.log('--- waiting for loop back to select');
await waitState('select');
await sleep(800); // ボトル復帰アニメ中
await shot('10-select-return');
await sleep(2500);
console.log('state:', await state(), 'mem:', await meminfo());
await shot('10b-select-settled');

// --- ESC 強制リセット試験（generate 途中で叩く） ---
console.log('--- ESC reset test');
await page.keyboard.press('1');
await waitState('shoot');
await sleep(900);
await page.keyboard.press('Enter');
await waitState('generate');
await sleep(1200);
console.log('state before ESC:', await state());
await page.keyboard.press('Escape');
await sleep(1500);
console.log('state after ESC:', await state(), 'mem:', await meminfo());
await shot('11-after-esc');

console.log('\n=== console errors ===');
console.log(errors.length ? errors.join('\n') : '(none)');

await browser.close();
process.exit(errors.length ? 1 : 0);
