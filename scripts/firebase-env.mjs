// サービスアカウント鍵(JSON)を .env 用の3行に変換して出力する。
// private_key の改行エスケープ（手書きで最も間違えやすい箇所）を自動化する。
//
// 使い方:
//   node scripts/firebase-env.mjs ~/Downloads/xxxxx-firebase-adminsdk-xxxx.json
//
// 出力された3行を ccjc/.env と gallery/.env.local に貼り付ける。
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('使い方: node scripts/firebase-env.mjs <サービスアカウントJSONのパス>');
  process.exit(1);
}

let sa;
try {
  sa = JSON.parse(readFileSync(path, 'utf8'));
} catch (e) {
  console.error(`JSONを読めませんでした: ${path}\n${e.message}`);
  process.exit(1);
}

const { project_id, client_email, private_key } = sa;
if (!project_id || !client_email || !private_key) {
  console.error('このJSONはサービスアカウント鍵ではないようです（project_id / client_email / private_key が見つからない）');
  process.exit(1);
}

// 実際の改行を \n の2文字に変換し、ダブルクォートで囲む（.env で1行に収めるため）
const escapedKey = private_key.replace(/\n/g, '\\n');

console.log('# ↓ この3行を .env / .env.local に貼り付け（既存の同名行は置き換え）');
console.log(`FIREBASE_PROJECT_ID=${project_id}`);
console.log(`FIREBASE_CLIENT_EMAIL=${client_email}`);
console.log(`FIREBASE_PRIVATE_KEY="${escapedKey}"`);
