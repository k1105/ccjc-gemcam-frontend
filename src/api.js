/**
 * ブース用バックエンド (ccjc/server) を呼び出して実画像を生成するサービス。
 * 旧 MockApiService と同じ generateToyImage(brand, snapshotDataUrl, onProgress) インタフェースを維持。
 */
import { isAuthRequired } from './core/auth-env.js';

// Vercel等の同一オリジン運用では VITE_API_BASE='' を設定する（?? なら空文字はフォールバックしない）
const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787';

export class ApiService {
  /**
   * @param {string} brandSlug - config/brands.json の slug（例: 'coca-cola'）
   * @param {string} snapshotDataUrl - 撮影画像の data URL
   * @param {function} onProgress - 0-100 の進捗コールバック
   * @returns {Promise<{ id: string, imageUrl: string, brandLabel: string }>}
   */
  async generateToyImage(brandSlug, snapshotDataUrl, onProgress) {
    // 実生成は数〜十数秒の単発リクエスト。応答到着までは疑似的に ~90% まで進め、完了で 100% にする。
    let percent = 0;
    const ticker = setInterval(() => {
      percent = Math.min(percent + Math.random() * 4 + 1, 90);
      if (onProgress) onProgress(percent);
    }, 400);

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (isAuthRequired()) {
        const { getCurrentIdToken } = await import('./core/auth-gate.js');
        const idToken = await getCurrentIdToken();
        if (idToken) headers.Authorization = `Bearer ${idToken}`;
      }
      const res = await fetch(`${API_BASE}/api/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ brand: brandSlug, image: snapshotDataUrl }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `生成APIエラー (${res.status})`);
      }

      const data = await res.json();
      clearInterval(ticker);
      if (onProgress) onProgress(100);
      if (data.stored === false) {
        console.warn('[api] 生成は成功しましたが保存に失敗しています（Storage/Firestore 未記録）');
      }
      return data;
    } catch (err) {
      clearInterval(ticker);
      throw err;
    }
  }
}
