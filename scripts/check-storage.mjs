// Firebase Storage への接続を実際に「アップロード→URL取得→ダウンロード→削除」して確認する。
// .env を読み込み、_healthcheck/ 配下にテスト画像を置いて消すだけ（本番データには触れない）。
//
// 使い方:
//   node scripts/check-storage.mjs
import 'dotenv/config';
import { getStorage } from 'firebase-admin/storage';
import { ensureFirebaseApp } from '../server/firebase.js';
import { putImage } from '../server/storage.js';

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  fail('環境変数が未設定です。.env に FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY を設定してください。');
}

try {
  ensureFirebaseApp();
} catch (e) {
  fail(`firebase-admin の初期化に失敗: ${e.message}`);
}
const bucket = getStorage().bucket();
console.log('① 認証情報の読み込み: OK');
console.log(`   bucket: ${bucket.name}`);

const [exists] = await bucket.exists().catch((e) => fail(`バケット確認に失敗: ${e.message}`));
if (!exists) {
  fail(
    `バケット ${bucket.name} が存在しません。\n` +
      '   → Firebase Console の「Storage」→「始める」で有効化してください（Blaze プランが必要です）。\n' +
      '   → バケット名がデフォルトと異なる場合は .env に FIREBASE_STORAGE_BUCKET を設定してください。'
  );
}
console.log('② バケット存在確認: OK');

// 1x1 透明PNG
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

let url;
try {
  url = await putImage(png, `_healthcheck/test-${Date.now()}`, 'image/png');
  console.log('③ アップロード + URL取得: OK');
  console.log(`   url: ${url}`);
} catch (e) {
  fail(`アップロードに失敗: ${e.message}`);
}

const res = await fetch(url);
if (!res.ok) fail(`URL からのダウンロードに失敗: HTTP ${res.status}`);
const body = Buffer.from(await res.arrayBuffer());
if (!body.equals(png)) fail('ダウンロードした内容がアップロードと一致しません');
console.log('④ 公開URLでダウンロード: OK');

const objectPath = decodeURIComponent(new URL(url).pathname.split('/o/')[1]);
await bucket.file(objectPath).delete();
console.log('⑤ 後始末（削除）: OK');

console.log('\n✅ Firebase Storage 接続OK。ブースの画像保存に使えます。\n');
process.exit(0);
