// ブース用ローカルバックエンド。
// 会場PCで Vite フロントと同時起動し、Gemini 生成 → Firebase Storage 保存 → Firestore 記録を行う。
// 鍵類（GEMINI_API_KEY / FIREBASE_*）はこのサーバーのみが保持し、ブラウザへ出さない。
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { getProvider, getModel } from './provider.js';
import { saveLocalImage } from './local-store.js';
import { runGenerate } from './generate-handler.js';
import { brands } from './brands.js';
import { loadKeys, getMaskedKeys, saveKeys, hasKeys } from './api-keys.js';

// 起動時に .env / server/.keys.json からキーをロードする
loadKeys();

const app = express();
const PORT = process.env.PORT || 8787;
// このPCがどのブースか（例: A / B）。生成結果に booth として記録する。未設定なら記録しない。
const BOOTH_ID = (process.env.BOOTH_ID || '').trim() || undefined;

app.use(cors());
app.use(express.json({ limit: '25mb' }));

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
  try {
    const { brand: brandSlug, image } = req.body || {};
    const result = await runGenerate({
      brandSlug,
      image,
      booth: BOOTH_ID,
      hooks: {
        // 撮影raw/生成結果を会場PCの手元にも控える（失敗しても生成は止めない。runGenerate側で警告ログ）
        onRawParsed: (buffer, mime, baseName) => saveLocalImage(buffer, 'raw', baseName, mime),
        onGenerated: (buffer, mime, baseName) => saveLocalImage(buffer, 'generated', baseName, mime),
      },
    });
    res.json(result);
  } catch (err) {
    console.error('[generate] error:', err);
    res.status(err.status || 500).json({ error: err.message || '生成に失敗しました' });
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
