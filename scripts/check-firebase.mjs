// Firestore への接続を実際に「書き込み→読み取り→削除」して確認する。
// .env を読み込み、_healthcheck コレクションにテスト文書を作って消すだけ（本番データには触れない）。
//
// 使い方:
//   node scripts/check-firebase.mjs
import 'dotenv/config';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;

if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  fail(
    '環境変数が未設定です。.env に FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY を設定してください。\n' +
      '   （scripts/firebase-env.mjs でJSONから生成できます）'
  );
}

console.log('① 環境変数: OK');
console.log(`   project: ${FIREBASE_PROJECT_ID}`);
console.log(`   client : ${FIREBASE_CLIENT_EMAIL}`);

// private_key の形が正しいかを先にチェック（改行エスケープ忘れの早期検出）
const key = FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
if (!key.includes('BEGIN PRIVATE KEY') || !key.trim().endsWith('-----END PRIVATE KEY-----')) {
  fail(
    'FIREBASE_PRIVATE_KEY の形が不正です。ダブルクォートで囲み、改行を \\n にしているか確認してください。\n' +
      '   scripts/firebase-env.mjs を使うと自動で正しい形式になります。'
  );
}

try {
  if (getApps().length === 0) {
    initializeApp({
      credential: cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: key,
      }),
    });
  }
} catch (e) {
  fail(`firebase-admin の初期化に失敗: ${e.message}`);
}
console.log('② 認証情報の読み込み: OK');

const db = getFirestore();
const ref = db.collection('_healthcheck').doc();

try {
  await ref.set({ ok: true, at: FieldValue.serverTimestamp() });
  console.log('③ 書き込み: OK');

  const snap = await ref.get();
  if (!snap.exists) fail('書き込んだ文書を読み戻せませんでした');
  console.log('④ 読み取り: OK');

  await ref.delete();
  console.log('⑤ 後始末（削除）: OK');
} catch (e) {
  // よくある原因をわかりやすく案内
  let hint = '';
  if (/NOT_FOUND|database.*does not exist|5 NOT_FOUND/i.test(e.message)) {
    hint =
      '\n   → Firestore データベースがまだ作成されていない可能性。Firebase Console で「Firestore Database」→「データベースの作成」を実行してください。';
  } else if (/PERMISSION_DENIED|7 PERMISSION_DENIED/i.test(e.message)) {
    hint =
      '\n   → 権限不足。サービスアカウントに「Cloud Datastore ユーザー」または編集者ロールが付いているか確認してください。';
  } else if (/UNAUTHENTICATED|invalid_grant|Invalid JWT/i.test(e.message)) {
    hint =
      '\n   → 認証エラー。private_key の貼り付けミス（改行エスケープ）か、鍵の失効が疑われます。JSONから生成し直してください。';
  }
  fail(`Firestore 操作に失敗: ${e.message}${hint}`);
}

console.log('\n✅ Firestore 接続OK。ブース／ギャラリー両方で同じ認証情報が使えます。\n');
process.exit(0);
