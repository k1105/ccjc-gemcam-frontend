// Vercelデプロイ専用の認証ゲート。Firebase IDトークンを検証し、
// ALLOWED_EMAILS（カンマ区切りの環境変数）に含まれるメールのみ通す。
// 会場PCローカル運用（server/index.js）では使わない。
import { getAuth } from 'firebase-admin/auth';
import { ensureFirebaseApp } from './firebase.js';

function allowedEmails() {
  return (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Authorization: Bearer <idToken> ヘッダを検証し、許可済みユーザーのメールを返す。
 * 不正/未許可の場合は err.status を付けた Error を投げる。
 * @param {string | undefined} authorizationHeader
 * @returns {Promise<{ email: string }>}
 */
export async function verifyAllowedUser(authorizationHeader) {
  const m = /^Bearer (.+)$/.exec(authorizationHeader || '');
  if (!m) {
    const err = new Error('ログインが必要です');
    err.status = 401;
    throw err;
  }

  ensureFirebaseApp();

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(m[1]);
  } catch {
    const err = new Error('トークンが無効です。再度ログインしてください');
    err.status = 401;
    throw err;
  }

  const email = (decoded.email || '').trim().toLowerCase();
  if (!email || !allowedEmails().includes(email)) {
    const err = new Error('このアカウントは許可されていません');
    err.status = 403;
    throw err;
  }

  return { email };
}
