/**
 * 開発用モックAPI。ApiService と同一インタフェース。
 * VITE_MOCK=1 で有効化。VITE_MOCK_DELAY（ms, default 8000）/ VITE_MOCK_FAIL=1 で挙動調整。
 * 生成結果は撮影スナップショットにブランド色の帯を焼き込んだ画像を返す（視覚確認用）。
 */
export class MockApiService {
  constructor() {
    this.delayMs = Number(import.meta.env.VITE_MOCK_DELAY || 8000);
    this.shouldFail = import.meta.env.VITE_MOCK_FAIL === '1';
  }

  async generateToyImage(brandSlug, snapshotDataUrl, onProgress) {
    let percent = 0;
    const ticker = setInterval(() => {
      percent = Math.min(percent + Math.random() * 4 + 1, 90);
      if (onProgress) onProgress(percent);
    }, 400);

    try {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      if (this.shouldFail) throw new Error('[Mock] 生成失敗シミュレーション');

      const imageUrl = await this._composeMockResult(brandSlug, snapshotDataUrl);
      if (onProgress) onProgress(100);
      return { id: `mock-${Date.now()}`, imageUrl, brandLabel: brandSlug.toUpperCase() };
    } finally {
      clearInterval(ticker);
    }
  }

  _composeMockResult(brandSlug, snapshotDataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 640;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 640, 640);
        ctx.drawImage(img, 0, 80, 640, 480);
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.font = '600 28px Outfit, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`MOCK RESULT — ${brandSlug}`, 320, 48);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => resolve(snapshotDataUrl);
      img.src = snapshotDataUrl;
    });
  }
}
