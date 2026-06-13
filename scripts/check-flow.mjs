// ブース本番フローの通しテスト: Gemini生成 → Vercel Blob保存 → Firestore記録。
// 入力「自撮り写真」はテスト用にブランド画像で代用（疎通確認用）。
//
// 使い方:
//   node scripts/check-flow.mjs            # 既定 coca-cola
//   node scripts/check-flow.mjs sprite
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateToyImage } from '../server/gemini.js';
import { putImage } from '../server/storage.js';
import { saveGeneration } from '../server/firestore.js';
import { getBrand } from '../server/brands.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fail = (m) => { console.error(`\n❌ ${m}\n`); process.exit(1); };

const slug = process.argv[2] || 'coca-cola';
const brand = getBrand(slug);
if (!brand) fail(`未知のブランド: ${slug}`);

// テスト入力画像
let sampleBuf;
for (const ext of ['jpg', 'png']) {
  try { sampleBuf = readFileSync(resolve(__dirname, '..', 'public', 'brands', `${slug}.${ext}`)); break; } catch {}
}
if (!sampleBuf) fail(`テスト入力画像が見つかりません: public/brands/${slug}.(jpg|png)`);

console.log(`brand=${slug} (${brand.label})`);

// ① 生成
console.log('① Gemini 生成中…（10〜30秒）');
let buffer, mimeType;
try {
  ({ buffer, mimeType } = await generateToyImage(slug, sampleBuf.toString('base64'), 'image/jpeg'));
  console.log(`   OK (${(buffer.length / 1024).toFixed(0)}KB, ${mimeType})`);
} catch (e) { fail(`生成に失敗: ${e.message}`); }

// ② Blob 保存
console.log('② Vercel Blob へ保存中…');
let imageUrl;
try {
  const key = `generations/${slug}-flowtest-${process.pid}`;
  imageUrl = await putImage(buffer, key, mimeType);
  console.log(`   OK 公開URL: ${imageUrl}`);
} catch (e) { fail(`Blob保存に失敗: ${e.message}`); }

// ③ 公開URLが実際に取得できるか（HEAD）
console.log('③ 公開URLの到達確認…');
try {
  const res = await fetch(imageUrl, { method: 'HEAD' });
  if (!res.ok) fail(`公開URLにアクセスできません: HTTP ${res.status}`);
  console.log(`   OK HTTP ${res.status} (${res.headers.get('content-type')})`);
} catch (e) { fail(`公開URL到達確認に失敗: ${e.message}`); }

// ④ Firestore 記録
console.log('④ Firestore へメタ記録中…');
let docId;
try {
  docId = await saveGeneration({ brandSlug: slug, brandLabel: brand.label, imageUrl });
  console.log(`   OK docId: ${docId}`);
} catch (e) { fail(`Firestore記録に失敗: ${e.message}`); }

console.log('\n✅ フルフロー成功: 生成 → Blob保存 → 公開URL到達 → Firestore記録');
console.log('   ギャラリー (gallery) の一覧にこの1件が出ます。');
console.log(`   ※テスト記録です。不要なら Firestore の generations/${docId} と Blob を削除してください。\n`);
