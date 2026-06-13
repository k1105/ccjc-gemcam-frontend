// ブース用ローカルバックエンド。
// 会場PCで Vite フロントと同時起動し、Gemini 生成 → Firebase Storage 保存 → Firestore 記録を行う。
// 鍵類（GEMINI_API_KEY / FIREBASE_*）はこのサーバーのみが保持し、ブラウザへ出さない。
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { generateToyImage } from './gemini.js';
import { putImage } from './storage.js';
import { saveGeneration } from './firestore.js';
import { getBrand, brands } from './brands.js';

const app = express();
const PORT = process.env.PORT || 8787;

app.use(cors());
app.use(express.json({ limit: '25mb' }));

// data URL ("data:image/png;base64,....") を {mime, base64} に分解
function parseDataUrl(image) {
  const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/s.exec(image || '');
  if (m) return { mime: m[1], base64: m[2] };
  // 既に純粋な base64 が来た場合は png とみなす
  return { mime: 'image/png', base64: (image || '').replace(/^data:[^,]+,/, '') };
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-image',
    mock: process.env.MOCK_GENERATION === 'true',
    brands: brands.map((b) => b.slug),
  });
});

app.post('/api/generate', async (req, res) => {
  const started = Date.now();
  try {
    const { brand: brandSlug, image } = req.body || {};
    const brand = getBrand(brandSlug);
    if (!brand) return res.status(400).json({ error: `未知のブランド: ${brandSlug}` });
    if (!image) return res.status(400).json({ error: 'image が必要です' });

    // 鍵なしでもフロントを通しで動作確認できるモック（MOCK_GENERATION=true）
    if (process.env.MOCK_GENERATION === 'true') {
      await new Promise((r) => setTimeout(r, 1500));
      return res.json({
        id: `mock-${Date.now()}`,
        brand: brand.slug,
        brandLabel: brand.label,
        imageUrl: image, // 撮影画像をそのまま返す
        mock: true,
      });
    }

    const { mime, base64 } = parseDataUrl(image);

    // 1. 生成
    const { buffer, mimeType } = await generateToyImage(brand.slug, base64, mime);

    // 2. ストレージ保存 + Firestore 記録
    // Storage 側の障害・未設定で保存に失敗しても生成自体は成功しているので、
    // 画像を data URL で返してフロントの通し動作を止めない。
    let imageUrl;
    let id;
    let stored = true;
    try {
      const key = `generations/${brand.slug}-${Date.now()}`;
      imageUrl = await putImage(buffer, key, mimeType);
      id = await saveGeneration({
        brandSlug: brand.slug,
        brandLabel: brand.label,
        imageUrl,
      });
    } catch (storageErr) {
      stored = false;
      console.warn('[generate] 保存に失敗（生成は成功）。data URL で返します:', storageErr.message);
      imageUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
      id = `unsaved-${Date.now()}`;
    }

    console.log(`[generate] ${brand.slug} done in ${Date.now() - started}ms -> ${id}${stored ? '' : ' (未保存)'}`);
    res.json({ id, brand: brand.slug, brandLabel: brand.label, imageUrl, stored });
  } catch (err) {
    console.error('[generate] error:', err);
    res.status(500).json({ error: err.message || '生成に失敗しました' });
  }
});

app.listen(PORT, () => {
  console.log(`[ccjc booth backend] listening on http://localhost:${PORT}`);
  if (process.env.MOCK_GENERATION === 'true') {
    console.log('[ccjc booth backend] MOCK_GENERATION=true (Gemini/Storage/Firestore を呼ばずモック応答)');
  }
});
