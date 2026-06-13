// firebase-admin 初期化の共有モジュール。Firestore / Storage の両方がここを通る。
import { initializeApp, cert, getApps } from 'firebase-admin/app';

/**
 * firebase-admin アプリを初期化（済みなら何もしない）。
 * Storage のバケット名は FIREBASE_STORAGE_BUCKET で上書き可能。
 * 未指定時は新形式のデフォルト（<project-id>.firebasestorage.app）を使う。
 */
export function ensureFirebaseApp() {
  if (getApps().length > 0) return;

  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    throw new Error('FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY が未設定です');
  }

  initializeApp({
    credential: cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      // .env では改行を \n でエスケープして1行で持つ想定
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
    storageBucket:
      process.env.FIREBASE_STORAGE_BUCKET || `${FIREBASE_PROJECT_ID}.firebasestorage.app`,
  });
}
