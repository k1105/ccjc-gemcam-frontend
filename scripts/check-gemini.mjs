// Gemini 画像生成が実際に画像を返すか確認する。
// プロンプト合成 + 参照画像添付 + API 呼び出し（server/gemini.js をそのまま使用）。
// テスト入力の「自撮り写真」はブランド画像で代用する（疎通確認用。出力品質の評価ではない）。
//
// 使い方:
//   node scripts/check-gemini.mjs            # 既定 coca-cola
//   node scripts/check-gemini.mjs sprite     # ブランド指定
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateToyImage } from '../server/gemini.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!process.env.GEMINI_API_KEY) fail('GEMINI_API_KEY が .env に未設定です。');

const slug = process.argv[2] || 'coca-cola';
const samplePath = resolve(__dirname, '..', 'public', 'brands', `${slug}.jpg`);
let sampleBuf;
try {
  sampleBuf = readFileSync(samplePath);
} catch {
  // jpg が無ければ png を試す
  try {
    sampleBuf = readFileSync(resolve(__dirname, '..', 'public', 'brands', `${slug}.png`));
  } catch {
    fail(`テスト入力画像が見つかりません: public/brands/${slug}.(jpg|png)`);
  }
}

console.log(`① 入力準備: OK (brand=${slug}, model=${process.env.GEMINI_MODEL || 'gemini-3.1-flash-image'})`);
console.log('② Gemini 呼び出し中…（10〜30秒程度かかります）');

const t0 = process.hrtime.bigint();
try {
  const { buffer, mimeType } = await generateToyImage(slug, sampleBuf.toString('base64'), 'image/jpeg');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  if (!buffer?.length) fail('応答に画像データが含まれていませんでした。');

  const ext = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png';
  const outPath = resolve(__dirname, `_gemini-test-output.${ext}`);
  writeFileSync(outPath, buffer);

  console.log(`③ 生成: OK (${(buffer.length / 1024).toFixed(0)}KB, ${mimeType}, ${(ms / 1000).toFixed(1)}秒)`);
  console.log(`   出力サンプル: ${outPath}`);
  console.log('\n✅ Gemini 画像生成OK。ブースの本番フローで使えます。');
  console.log('   （このテスト出力は疎通確認用。実際の品質は本物の自撮り写真で確認してください）\n');
} catch (e) {
  let hint = '';
  if (/API key not valid|API_KEY_INVALID|invalid.*key/i.test(e.message)) {
    hint = '\n   → APIキーが無効。Google AI Studio で発行したキーを .env の GEMINI_API_KEY に正しく入れているか確認。';
  } else if (/not found|NOT_FOUND|is not supported|model/i.test(e.message)) {
    hint = `\n   → モデル名を確認。.env の GEMINI_MODEL（現在: ${process.env.GEMINI_MODEL || '既定'}）が有効か、画像生成対応モデルか。`;
  } else if (/quota|RESOURCE_EXHAUSTED|429/i.test(e.message)) {
    hint = '\n   → クォータ超過 or 課金未設定。Google AI Studio / Cloud の課金・上限を確認。';
  } else if (/PERMISSION_DENIED|403/i.test(e.message)) {
    hint = '\n   → 権限エラー。APIキーの制限設定（許可API/リファラ制限）を確認。';
  }
  fail(`Gemini 呼び出しに失敗: ${e.message}${hint}`);
}
