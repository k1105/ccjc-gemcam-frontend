// ブース用ローカルバックエンド。
// 会場PCで Vite フロントと同時起動し、Gemini 生成 → Firebase Storage 保存 → Firestore 記録を行う。
// 鍵類（GEMINI_API_KEY / FIREBASE_*）はこのサーバーのみが保持し、ブラウザへ出さない。
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { generateToyImage } from './gemini.js';
import { getProvider, getModel } from './provider.js';
import { putImage } from './storage.js';
import { saveLocalImage } from './local-store.js';
import { saveGeneration } from './firestore.js';
import { getBrand, brands } from './brands.js';
import { loadKeys, getMaskedKeys, saveKeys, hasKeys } from './api-keys.js';

// 起動時に .env / server/.keys.json からキーをロードする
loadKeys();

const app = express();
const PORT = process.env.PORT || 8787;
// このPCがどのブースか（例: A / B）。生成結果に booth として記録する。未設定なら記録しない。
const BOOTH_ID = (process.env.BOOTH_ID || '').trim() || undefined;

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
    booth: BOOTH_ID || null,
    provider: getProvider(), // 'gemini'（APIキー方式）| 'vertex'（Agent Platform）
    model: getModel(),
    mock: process.env.MOCK_GENERATION === 'true',
    keyCount: getMaskedKeys().count,
    brands: brands.map((b) => b.slug),
  });
});

// APIキー管理（フロントの設定パネル Shift+K から呼ぶ）。
// GET はマスク済みのみ返し、実キーはブラウザへ出さない。
app.get('/api/keys', (_req, res) => {
  res.json(getMaskedKeys());
});

// POST body: { keys: [v0, v1, v2] }
//   各値: 非空文字列=設定 / ""=クリア / null=既存保持（非破壊更新）
app.post('/api/keys', (req, res) => {
  try {
    const { keys } = req.body || {};
    if (!Array.isArray(keys)) {
      return res.status(400).json({ error: 'keys は配列で渡してください' });
    }
    res.json(saveKeys(keys));
  } catch (err) {
    console.error('[keys] error:', err);
    res.status(500).json({ error: err.message || 'キーの保存に失敗しました' });
  }
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

    // raw/generated でファイル名を揃え、後から対応を追えるようにする。
    const baseName = `${brand.slug}-${Date.now()}`;

    // 撮影 raw 画像を手元へ控える（失敗しても生成は止めない）。
    try {
      await saveLocalImage(Buffer.from(base64, 'base64'), 'raw', baseName, mime);
    } catch (localErr) {
      console.warn('[generate] raw のローカル保存に失敗:', localErr.message);
    }

    // 1. 生成
    const { buffer, mimeType } = await generateToyImage(brand.slug, base64, mime);

    // 生成結果を手元へ控える（失敗しても生成は止めない）。
    try {
      await saveLocalImage(buffer, 'generated', baseName, mimeType);
    } catch (localErr) {
      console.warn('[generate] generated のローカル保存に失敗:', localErr.message);
    }

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
        booth: BOOTH_ID,
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
  console.log(`[ccjc booth backend] listening on http://localhost:${PORT}${BOOTH_ID ? ` (booth=${BOOTH_ID})` : ' (booth未設定)'}`);
  if (process.env.MOCK_GENERATION === 'true') {
    console.log('[ccjc booth backend] MOCK_GENERATION=true (Gemini/Storage/Firestore を呼ばずモック応答)');
  } else if (getProvider() === 'vertex') {
    console.log(`[ccjc booth backend] 生成プロバイダ=vertex (Agent Platform) model=${getModel()}`);
  } else if (!hasKeys()) {
    console.warn('[ccjc booth backend] APIキー未設定 — フロントの設定パネル(Ctrl+K)から設定してください');
  }
});
