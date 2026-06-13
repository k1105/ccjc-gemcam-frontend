// 画像ストレージのアダプタ層。既定は Firebase Storage（Cloud Storage）。
// 別のストレージへ差し替える場合はこのファイルの putImage を実装し直すだけでよい。
import { randomUUID } from 'node:crypto';
import { getStorage, getDownloadURL } from 'firebase-admin/storage';
import { ensureFirebaseApp } from './firebase.js';

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * 画像バッファを保存し、公開URLを返す。
 * @param {Buffer} buffer
 * @param {string} key - 拡張子なしの一意なキー（例: "generations/coca-cola-20260606-xxxx"）
 * @param {string} mimeType
 * @returns {Promise<string>} 公開URL
 */
export async function putImage(buffer, key, mimeType = 'image/png') {
  ensureFirebaseApp();

  const ext = EXT_BY_MIME[mimeType] || 'png';
  const pathname = `${key}-${randomUUID().slice(0, 8)}.${ext}`;
  const file = getStorage().bucket().file(pathname);

  // getDownloadURL はアップロード時に firebaseStorageDownloadTokens が
  // 付いていないと storage/no-download-token で失敗するため、ここで発行する。
  await file.save(buffer, {
    resumable: false,
    metadata: {
      contentType: mimeType,
      metadata: { firebaseStorageDownloadTokens: randomUUID() },
    },
  });

  return getDownloadURL(file);
}
