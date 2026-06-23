// Gemini API キーのプール管理。
// - 最大3本を保持し、リクエストごとにラウンドロビンで開始キーを進める。
// - 生成失敗（429/クォータ・認証エラー）時は同一リクエストを次のキーで再試行できるよう、
//   試行順（getAttemptOrder）を返す。
// - 初期値は .env の GEMINI_API_KEY（あれば key1 として seed）。
//   フロントの設定パネルから上書きでき、server/.keys.json に永続化してサーバー再起動後も復元する。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MAX_KEYS = 3;
const STORE_PATH = join(dirname(fileURLToPath(import.meta.url)), '.keys.json');

let _keys = []; // 実キー文字列の配列（最大3本、空文字は含めない）
let _cursor = 0; // ラウンドロビンの開始位置

// 入力配列を正規化（trim・空除去・最大3本）
function sanitize(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map((k) => (typeof k === 'string' ? k.trim() : ''))
    .filter((k) => k.length > 0)
    .slice(0, MAX_KEYS);
}

function persist() {
  try {
    writeFileSync(STORE_PATH, JSON.stringify({ keys: _keys }, null, 2), 'utf8');
  } catch (err) {
    console.warn('[api-keys] 永続化に失敗:', err.message);
  }
}

// 起動時の初期化。ファイル → .env の順で seed する。
export function loadKeys() {
  let fromFile = [];
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    fromFile = sanitize(raw.keys);
  } catch {
    // ファイルが無い/壊れている場合は無視して .env にフォールバック
  }

  if (fromFile.length > 0) {
    _keys = fromFile;
  } else if (process.env.GEMINI_API_KEY) {
    _keys = sanitize([process.env.GEMINI_API_KEY]);
  } else {
    _keys = [];
  }
  _cursor = 0;
  console.log(`[api-keys] ${_keys.length}本のキーをロードしました`);
  return _keys.length;
}

export function hasKeys() {
  return _keys.length > 0;
}

// 末尾4文字以外を伏せた表示用文字列。実キーはブラウザへ返さない。
function mask(key) {
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

// GET /api/keys 用。常にマスク済みで、枠ごとの有無を返す。
export function getMaskedKeys() {
  const slots = [];
  for (let i = 0; i < MAX_KEYS; i++) {
    const key = _keys[i];
    slots.push({ index: i, hasKey: !!key, masked: key ? mask(key) : null });
  }
  return { count: _keys.length, max: MAX_KEYS, slots };
}

// POST /api/keys 用。各枠の値は次のいずれか:
//   - 非空文字列 : その枠を新しいキーに設定
//   - ""        : その枠をクリア
//   - null/undefined : 既存を保持（非破壊更新。空欄保存で誤って消さないため）
export function saveKeys(values) {
  const incoming = Array.isArray(values) ? values : [];
  const merged = [];
  for (let i = 0; i < MAX_KEYS; i++) {
    const v = incoming[i];
    if (v === null || v === undefined) {
      if (_keys[i]) merged.push(_keys[i]); // 既存保持
    } else if (typeof v === 'string') {
      const t = v.trim();
      if (t.length > 0) merged.push(t); // 設定。"" はクリア（pushしない）
    }
  }
  _keys = merged.slice(0, MAX_KEYS);
  _cursor = 0; // 構成が変わったので開始位置をリセット
  persist();
  console.log(`[api-keys] キーを更新しました（${_keys.length}本）`);
  return getMaskedKeys();
}

// 1リクエストで試すキーの順序を返す（ラウンドロビン開始 + 残りをフェイルオーバー用に続ける）。
// 呼び出すたびに開始位置を1つ進める。キー未設定なら空配列。
export function getAttemptOrder() {
  const n = _keys.length;
  if (n === 0) return [];
  const start = _cursor % n;
  _cursor = (_cursor + 1) % n;
  const order = [];
  for (let i = 0; i < n; i++) order.push(_keys[(start + i) % n]);
  return order;
}
