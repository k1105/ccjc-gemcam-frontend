// 生成プロバイダの切替。現行の APIキー方式を残したまま、env で切り替えられる。
//
//   GENERATION_PROVIDER=gemini  … Gemini Developer API（APIキー方式・現行デフォルト）
//   GENERATION_PROVIDER=vertex  … Gemini Enterprise Agent Platform（旧 Vertex AI）
//                                 GCPプロジェクト + サービスアカウント(ADC)認証。APIキー不要。
//
// どちらも同じ @google/genai SDK・同じ generateContent 署名で呼べるため、
// 切り替えは「どのクライアントを使うか」だけの差になる。
import { GoogleGenAI } from '@google/genai';
import { getAttemptOrder } from './api-keys.js';

const DEFAULT_MODEL = 'gemini-3.1-flash-image';

// 'gemini'（既定）か 'vertex' を返す。未知の値は gemini にフォールバック。
export function getProvider() {
  const p = (process.env.GENERATION_PROVIDER || 'gemini').trim().toLowerCase();
  return p === 'vertex' || p === 'agent-platform' ? 'vertex' : 'gemini';
}

// 使用モデル名。Vertex 側で別名にしたい場合は VERTEX_MODEL で上書きできる。
export function getModel() {
  if (getProvider() === 'vertex') {
    return process.env.VERTEX_MODEL || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  }
  return process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

// --- Gemini Developer API（APIキー方式） ---
// キーごとにクライアントを使い回す（毎回 new するとコネクション再確立で遅くなるため）。
const _geminiClients = new Map();
function geminiClientFor(apiKey) {
  let c = _geminiClients.get(apiKey);
  if (!c) {
    c = new GoogleGenAI({ apiKey });
    _geminiClients.set(apiKey, c);
  }
  return c;
}

// --- Gemini Enterprise Agent Platform（Vertex AI） ---
let _vertexClient = null;
function vertexClient() {
  if (_vertexClient) return _vertexClient;

  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.VERTEX_PROJECT;
  const location =
    process.env.GOOGLE_CLOUD_LOCATION || process.env.VERTEX_LOCATION || 'global';
  if (!project) {
    throw new Error(
      'Agent Platform(Vertex)モードには GOOGLE_CLOUD_PROJECT（または VERTEX_PROJECT）が必要です'
    );
  }

  // 認証は2系統。優先順:
  //  1) env にサービスアカウントを直接持つ（VERTEX_CLIENT_EMAIL + VERTEX_PRIVATE_KEY）
  //     … 既存の FIREBASE_* と同じく .env だけで完結。会場PCにJSONを置かなくてよい。
  //  2) 未指定なら ADC（GOOGLE_APPLICATION_CREDENTIALS / gcloud auth application-default login）。
  const clientEmail = process.env.VERTEX_CLIENT_EMAIL;
  const privateKey = process.env.VERTEX_PRIVATE_KEY;
  const opts = { vertexai: true, project, location };
  if (clientEmail && privateKey) {
    opts.googleAuthOptions = {
      projectId: project,
      credentials: {
        client_email: clientEmail,
        // .env では改行を \n でエスケープして1行で持つ想定（FIREBASE_PRIVATE_KEY と同様）
        private_key: privateKey.replace(/\\n/g, '\n'),
      },
    };
  }

  _vertexClient = new GoogleGenAI(opts);
  return _vertexClient;
}

/**
 * 1リクエストで試すクライアント列を返す。
 *  - gemini: キープール（ラウンドロビン開始 + 残りをフェイルオーバー用に続ける）
 *  - vertex: 単一クライアント（キープールは使わない）
 * @returns {{ client: import('@google/genai').GoogleGenAI, label: string }[]}
 */
export function getAttemptClients() {
  if (getProvider() === 'vertex') {
    return [{ client: vertexClient(), label: 'vertex' }];
  }
  const keys = getAttemptOrder();
  return keys.map((apiKey, i) => ({
    client: geminiClientFor(apiKey),
    label: `key ${i + 1}/${keys.length}`,
  }));
}
