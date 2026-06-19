// ローカル保存アダプタ。撮影 raw 画像と生成結果を会場PCのディスクにも控える。
// 既定は Firebase Storage（storage.js）だが、こちらは万一のための手元バックアップ。
// 保存先ディレクトリ（LOCAL_ARCHIVE_DIR 既定 "local-archive"）は .gitignore 対象。
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

// server/ の一つ上（リポジトリルート）を基準にする。
const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const ARCHIVE_DIR = process.env.LOCAL_ARCHIVE_DIR
  ? resolve(ROOT, process.env.LOCAL_ARCHIVE_DIR)
  : join(ROOT, 'local-archive');

/**
 * 画像バッファをローカルへ保存する。
 * @param {Buffer} buffer
 * @param {'raw'|'generated'} kind - サブディレクトリ名
 * @param {string} baseName - 拡張子なしのファイル名（raw/generated で揃えると対応が分かりやすい）
 * @param {string} mimeType
 * @returns {Promise<string>} 保存した絶対パス
 */
export async function saveLocalImage(buffer, kind, baseName, mimeType = 'image/png') {
  const ext = EXT_BY_MIME[mimeType] || 'png';
  const dir = join(ARCHIVE_DIR, kind);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${baseName}.${ext}`);
  await writeFile(filePath, buffer);
  return filePath;
}
