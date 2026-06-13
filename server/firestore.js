// Firestore (firebase-admin) の生成結果メタ保存。初期化は server/firebase.js に共通化。
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { ensureFirebaseApp } from './firebase.js';

const COLLECTION = process.env.FIRESTORE_COLLECTION || 'generations';

let _db = null;
function db() {
  if (_db) return _db;
  ensureFirebaseApp();
  _db = getFirestore();
  return _db;
}

/**
 * 生成結果のメタデータを保存し、ドキュメントIDを返す。
 * 入力した自撮り写真は保存しない（プライバシー配慮）。
 * @param {{ brandSlug: string, brandLabel: string, imageUrl: string }} meta
 * @returns {Promise<string>} docId
 */
export async function saveGeneration({ brandSlug, brandLabel, imageUrl }) {
  const ref = await db().collection(COLLECTION).add({
    brandSlug,
    brandLabel,
    imageUrl,
    source: 'booth',
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}
