// 生成フロー本体（ブランド検証 → Gemini生成 → Storage保存 → Firestore記録）。
// ローカルExpress（server/index.js）・Vercel Functions（api/generate.js）の両方から呼ぶ共有ロジック。
// 会場PC専用のraw/generated画像ローカル保存は含まない（呼び出し側のhooksで行う）。
import { generateToyImage } from './gemini.js';
import { putImage } from './storage.js';
import { saveGeneration } from './firestore.js';
import { getBrand } from './brands.js';

// data URL ("data:image/png;base64,....") を {mime, base64} に分解
export function parseDataUrl(image) {
  const m = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/s.exec(image || '');
  if (m) return { mime: m[1], base64: m[2] };
  // 既に純粋な base64 が来た場合は png とみなす
  return { mime: 'image/png', base64: (image || '').replace(/^data:[^,]+,/, '') };
}

/**
 * @param {object} params
 * @param {string} params.brandSlug
 * @param {string} params.image - data URL
 * @param {string} [params.booth]
 * @param {object} [params.hooks]
 * @param {(buffer: Buffer, mime: string, baseName: string) => Promise<void>} [params.hooks.onRawParsed]
 * @param {(buffer: Buffer, mime: string, baseName: string) => Promise<void>} [params.hooks.onGenerated]
 * @returns {Promise<{ id: string, brand: string, brandLabel: string, imageUrl: string, stored?: boolean, mock?: boolean }>}
 */
export async function runGenerate({ brandSlug, image, booth, hooks = {} }) {
  const started = Date.now();
  const brand = getBrand(brandSlug);
  if (!brand) {
    const err = new Error(`未知のブランド: ${brandSlug}`);
    err.status = 400;
    throw err;
  }
  if (!image) {
    const err = new Error('image が必要です');
    err.status = 400;
    throw err;
  }

  // 鍵なしでもフロントを通しで動作確認できるモック（MOCK_GENERATION=true）
  if (process.env.MOCK_GENERATION === 'true') {
    await new Promise((r) => setTimeout(r, 1500));
    return {
      id: `mock-${Date.now()}`,
      brand: brand.slug,
      brandLabel: brand.label,
      imageUrl: image, // 撮影画像をそのまま返す
      mock: true,
    };
  }

  const { mime, base64 } = parseDataUrl(image);
  const baseName = `${brand.slug}-${Date.now()}`;

  if (hooks.onRawParsed) {
    try {
      await hooks.onRawParsed(Buffer.from(base64, 'base64'), mime, baseName);
    } catch (localErr) {
      console.warn('[generate] raw のローカル保存に失敗:', localErr.message);
    }
  }

  // 1. 生成
  const { buffer, mimeType } = await generateToyImage(brand.slug, base64, mime);

  if (hooks.onGenerated) {
    try {
      await hooks.onGenerated(buffer, mimeType, baseName);
    } catch (localErr) {
      console.warn('[generate] generated のローカル保存に失敗:', localErr.message);
    }
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
      booth,
    });
  } catch (storageErr) {
    stored = false;
    console.warn('[generate] 保存に失敗（生成は成功）。data URL で返します:', storageErr.message);
    imageUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
    id = `unsaved-${Date.now()}`;
  }

  console.log(`[generate] ${brand.slug} done in ${Date.now() - started}ms -> ${id}${stored ? '' : ' (未保存)'}`);
  return { id, brand: brand.slug, brandLabel: brand.label, imageUrl, stored };
}
