// Gemini 画像生成（gemini-3.1-flash-image / Nano Banana 2）
// 自撮り写真 + 商品参照画像 + プロンプトを渡し、4等身3DCGキャラ画像を生成する。
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { getBrand, resolveProductImagePath } from './brands.js';

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-image';

// 生成1回あたりの上限。undici 既定の HeadersTimeout(300s) より先に
// こちらで打ち切ってリトライする（混雑時は1回あたり2分超かかることがある）
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 240_000);
const MAX_ATTEMPTS = Number(process.env.GEMINI_ATTEMPTS || 2);

// リトライ対象: ネットワーク断・タイムアウト・サーバ側一時エラー（4xxの拒否等は対象外）
function isRetryable(err) {
  const code = err?.cause?.code ?? err?.code;
  if (
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN'
  ) {
    return true;
  }
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  const status = err?.status;
  return status === 429 || (status >= 500 && status < 600);
}

// 環境変数でプロンプト雛形を差し替え可能。{brand_label} と {brand_fragment} を展開する。
const DEFAULT_PROMPT_TEMPLATE = [
  '参照写真に写っている人物（複数人の場合は全員）を、4頭身にデフォルメした可愛い3DCGキャラクターに変換してください。',
  '本人の髪型・髪色・服装・顔の特徴・表情の雰囲気を残しつつ、ツヤのあるトイフィギュア風／コマーシャルポップな3DCGスタイルで描いてください。',
  '{brand_fragment}',
  'キャラクターと飲料商品を一緒に、明るくカラフルなスタジオ背景の正方形構図で配置してください。',
  'ブランド: {brand_label}',
].join('\n');

let _client = null;
function client() {
  if (!_client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY が未設定です');
    _client = new GoogleGenAI({ apiKey });
  }
  return _client;
}

function mimeFromPath(p) {
  const ext = extname(p).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function buildPrompt(brand) {
  const template = process.env.GENERATION_PROMPT_TEMPLATE || DEFAULT_PROMPT_TEMPLATE;
  return template
    .replace(/\{brand_label\}/g, brand.label)
    .replace(/\{brand_fragment\}/g, brand.promptFragment || '');
}

/**
 * @param {string} brandSlug
 * @param {string} selfieBase64 - data URL prefix を除いた base64
 * @param {string} selfieMime - 例: 'image/png'
 * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
 */
export async function generateToyImage(brandSlug, selfieBase64, selfieMime = 'image/png') {
  const brand = getBrand(brandSlug);
  if (!brand) throw new Error(`未知のブランド: ${brandSlug}`);

  const contents = [
    { text: buildPrompt(brand) },
    { inlineData: { mimeType: selfieMime, data: selfieBase64 } },
  ];

  // 商品参照画像（あれば添付）
  const productPath = resolveProductImagePath(brand);
  if (productPath) {
    try {
      const productData = readFileSync(productPath).toString('base64');
      contents.push({
        inlineData: { mimeType: mimeFromPath(productPath), data: productData },
      });
    } catch (err) {
      console.warn(`[gemini] 商品参照画像を読めませんでした: ${productPath}`, err.message);
    }
  }

  let response;
  for (let attempt = 1; ; attempt++) {
    const t0 = Date.now();
    try {
      response = await client().models.generateContent({
        model: MODEL,
        contents,
        config: {
          httpOptions: { timeout: TIMEOUT_MS },
          responseModalities: ['TEXT', 'IMAGE'],
          // 結果画面は正方形前提のため出力をAPI側で固定する
          responseFormat: { image: { aspectRatio: process.env.GEMINI_ASPECT_RATIO || '1:1' } },
        },
      });
      break;
    } catch (err) {
      const elapsed = Date.now() - t0;
      if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
      console.warn(
        `[gemini] attempt ${attempt}/${MAX_ATTEMPTS} failed after ${elapsed}ms (${err?.cause?.code ?? err?.status ?? err.message}) — retrying`
      );
    }
  }

  const parts = response?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      return {
        buffer: Buffer.from(part.inlineData.data, 'base64'),
        mimeType: part.inlineData.mimeType || 'image/png',
      };
    }
  }

  // 画像が返らなかった場合はテキスト（拒否理由など）を拾ってエラーにする
  const textPart = parts.find((p) => p.text)?.text;
  throw new Error(`画像が生成されませんでした${textPart ? `: ${textPart}` : ''}`);
}
