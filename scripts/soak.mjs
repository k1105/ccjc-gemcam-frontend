import { chromium } from 'playwright';
const MINUTES = Number(process.env.SOAK_MIN || 6);
const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--enable-precise-memory-info'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:5197');
await page.waitForTimeout(2000);

let loops = 0;
let lastState = '';
page.on('console', (m) => {
  if (m.text().includes('result -> select')) loops++;
});

const start = Date.now();
while (Date.now() - start < MINUTES * 60000) {
  await page.waitForTimeout(30000);
  const sample = await page.evaluate(() => ({
    state: window.app?.ctx.manager.currentName,
    mem: { ...window.app.ctx.world.renderer.info.memory },
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1,
    tickables: window.app.ctx.world.tickables.size,
  }));
  console.log(`[${Math.round((Date.now() - start) / 1000)}s] loops=${loops}`, JSON.stringify(sample));
}
console.log('=== errors:', errors.length ? errors.slice(0, 5).join(' | ') : '(none)');
await browser.close();
process.exit(errors.length ? 1 : 0);
