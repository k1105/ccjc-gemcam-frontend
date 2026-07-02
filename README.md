# ① 体験ブースアプリ (ccjc)

Vite フロント + ローカルNodeバックエンド。会場PCでローカル起動・キーボード操作・55inchモニター出力。

UIは「自販機の画面」を起点とした体験コンテンツ。白基調ミニマルの3D空間で
SELECT（10本のボトル）→ SHOOT（撮影）→ GENERATE（写真がパーティクルに分解されボトルへ飛ぶ）→ RESULT（生成画像）のループを回す。

## セットアップ

```bash
cd ccjc
npm install
cp .env.example .env   # 値を設定（GEMINI_API_KEY / BLOB_READ_WRITE_TOKEN / FIREBASE_* など）
```

## 起動

```bash
npm run booth   # Vite(フロント) と Node(バックエンド) を同時起動
```

- フロント: Vite の表示URL（既定 http://localhost:5173 ）を55inchブラウザで開く
- バックエンド: http://localhost:8787 （`PORT` で変更可、フロントは `VITE_API_BASE` で参照）

個別に起動する場合: `npm run dev`（フロント）/ `npm run server`（バックエンド）。

## 操作（キーボード）

- `0`〜`9` … ドリンク選択（SELECT画面）→ 撮影画面へ
- `Enter` … 撮影カウントダウン開始（SHOOT画面）
- `Esc` … いつでも初期画面（SELECT）へ強制リセット（バックヤード用）
- `D` … デバッグエディタ（コレオグラフィ編集）

## フロント構成（src/）

- `main.js` … ブートストラップ、グローバルキー
- `core/` … world（renderer/rAF）、sequence-manager、camera-director（カメラパス再生）、choreo、resources（TimerBag/dispose）、brands、mock-api
- `world/` … environment（白背景・照明）、bottle-factory（手続き生成ボトル。`public/models/{slug}.glb` を置けば自動でGLB優先）、bottle-rack、photo-particles（写真→パーティクル分解シェーダ）
- `sequences/` … select / shoot / generate / result の各画面
- `choreo/choreography.json` … カメラパス・タイミング等の全演出パラメータ（エディタで編集→export→ここに上書き）
- `editor/` … デバッグエディタ（dynamic import、本番では未ロード）

## デバッグエディタ（D キー）

- `Camera Path (generate)` … phase 選択、キーフレームのギズモ/スライダー編集、曲線可視化、単体プレビュー再生
- `Parameters` … 全演出数値（選択ラック、沈下/復帰アニメ、パーティクル、リザルトのタイミング等）
- `Config IO` … JSON export（ダウンロード）→ `src/choreo/choreography.json` に上書きして永続化 / import で一時プレビュー

## 鍵なしで通し動作確認（モック）

フロント単体のモック: 

```bash
VITE_MOCK=1 VITE_MOCK_DELAY=6000 npm run dev   # バックエンド不要。撮影画像を加工して返す
# VITE_MOCK_FAIL=1 で生成失敗系、VITE_AUTOPLAY=1 で自動ループ（ソークテスト用）
```

バックエンド込みのモック: `.env` に `MOCK_GENERATION=true`（Gemini/Blob/Firestore を呼ばない）。

## スモークテスト

```bash
VITE_MOCK=1 VITE_MOCK_DELAY=6000 npx vite --port 5199 &   # 別ターミナルでも可
node scripts/smoke-flow.mjs   # fake camera でフルループ+ESC試験、.smoke/ にスクショ保存

# 連続稼働ソークテスト（VITE_AUTOPLAY=1 のサーバーを port 5197 で起動して）
SOAK_MIN=30 node scripts/soak.mjs   # 30秒ごとに state/メモリ/ヒープをサンプリング
```

（要 `npm install --no-save playwright`。package.json には含めていない）

## サーバー構成

- `server/index.js` … 会場PC用Express。`POST /api/generate { brand, image }`、`GET /api/health`、`GET/POST /api/keys`
- `server/generate-handler.js` … 生成フロー本体（ブランド検証→Gemini→Storage→Firestore）。Express/Vercel Functions両方から呼ぶ共有ロジック
- `server/auth.js` … Firebase IDトークン検証 + `ALLOWED_EMAILS` 突合（Vercel専用）
- `server/gemini.js` … `@google/genai` で `gemini-3.1-flash-image` 呼び出し（プロンプト合成）
- `server/storage.js` … Firebase Storage 保存アダプタ
- `server/firestore.js` … firebase-admin でメタ保存
- `server/brands.js` / `config/brands.json` … ブランド定義
- `src/api.js` … フロントからバックエンドを呼ぶサービス

## Vercelデプロイ（ログイン必須運用）

会場PCでのローカル起動とは別に、Vercel単体で実生成まで完結させる構成もある（`/api` … Vercel Functions）。この構成では Firebase Authentication（Googleログイン）で `ALLOWED_EMAILS` に登録したアカウントのみアクセスできる。

- `api/health.js` / `api/auth/verify.js` / `api/generate.js` … `server/*.js` の共有ロジックを呼ぶVercel Functions
- `src/core/auth-gate.js` … ログインゲート（`VITE_REQUIRE_AUTH=1` の時だけ動的importされ、firebaseはローカル会場PCビルドのバンドルに含まれない）

Vercelプロジェクトの環境変数（Production/Preview）:

- サーバー側（非公開）: `GEMINI_API_KEY` / `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` / `ALLOWED_EMAILS`（カンマ区切りメール）
- クライアント側（`VITE_` 接頭辞・公開前提）: `VITE_REQUIRE_AUTH=1` / `VITE_API_BASE=`（空文字） / `VITE_FIREBASE_API_KEY` / `VITE_FIREBASE_AUTH_DOMAIN` / `VITE_FIREBASE_PROJECT_ID` / `VITE_FIREBASE_APP_ID`

事前にFirebase Consoleで Authentication → Sign-in method の Google プロバイダを有効化し、Webアプリを登録して `VITE_FIREBASE_*` の値を取得、Authorized domainsにVercelドメインを追加しておく。

## 本番前チェック

- 30分連続稼働テスト（会場PC・実カメラ）: `VITE_AUTOPLAY=1` で自動ループ可能
- Webカメラは撮影直後と全リセット経路で `track.stop()` 済み（`src/sequences/shoot.js`）
- 全シーケンスは TimerBag で tween/timer/listener を一括破棄（長時間稼働のリーク対策）
- `npm run build` の出力(`dist/`)に鍵が含まれないこと（鍵はバックエンドのみ・`VITE_*` には鍵を入れない）
