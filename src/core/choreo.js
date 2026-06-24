import choreographyJson from '../choreo/choreography.json';

const STORAGE_KEY = 'ccjc:choreo';
// public/ 直下に置いた実行時差し替え用の振付ファイル。
// ビルドし直さずに差し替えられるよう、import せず fetch で取得する。
const RUNTIME_URL = `${import.meta.env.BASE_URL}choreography.json`;

/**
 * choreography.json のランタイムストア。
 * 実行時に public/choreography.json を fetch して初期データとする（Choreo.load）。
 * 取得に失敗した場合は bundled の src/choreo/choreography.json にフォールバックする。
 * いずれの場合も bundled を「既定値」とし、取得ファイルに存在しないプロパティは
 * 初期値で補完されるため、後方互換性のないファイルでも読み込める。
 *
 * デバッグエディタは data を直接ミューテートし、export で JSON ダウンロード /
 * import でファイル差し替えプレビューを行う。エディタでの編集は localStorage に
 * 自動保存され、リロード後も復元される（バージョン不一致の保存データは破棄）。
 */
export class Choreo {
  /**
   * public/choreography.json を取得して Choreo を構築する非同期ファクトリ。
   * 取得失敗時は bundled の初期値で構築する。
   */
  static async load() {
    let runtime = null;
    try {
      const res = await fetch(RUNTIME_URL, { cache: 'no-cache' });
      if (res.ok) {
        runtime = await res.json();
      } else {
        console.warn(`[Choreo] ${RUNTIME_URL} の取得に失敗 (${res.status}) — bundled を使用`);
      }
    } catch (err) {
      console.warn(`[Choreo] ${RUNTIME_URL} の取得に失敗 — bundled を使用`, err);
    }
    return new Choreo(runtime);
  }

  /**
   * @param {object|null} [data] 初期データ。未指定なら bundled の初期値を使う。
   */
  constructor(data = null) {
    // ディープコピーして元のモジュールキャッシュ／取得オブジェクトを汚さない
    this.data = structuredClone(data ?? choreographyJson);
    this._restoreFromStorage();
    // version を上げずに後から増えたセクション（scene 等）を補完する。
    // 取得ファイルや旧 localStorage 保存に無いキーだけを bundled 初期値で埋める。
    this._fillMissingDefaults();
  }

  /**
   * bundled 初期値にあって data に無いキーを再帰的に補完する。
   * 既存の値（ユーザー編集）は保持し、後から増えたネストキー
   * （generate.particles.brightMin 等）だけを埋める。
   */
  _fillMissingDefaults() {
    fillMissing(this.data, choreographyJson);
  }

  /** localStorage に編集途中の状態があれば復元（version 一致時のみ） */
  _restoreFromStorage() {
    let raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      return; // localStorage 不可（プライベートモード等）なら静かに諦める
    }
    if (!raw) return;
    try {
      const saved = JSON.parse(raw);
      if (saved?.version !== this.data.version) {
        console.warn('[Choreo] 保存データの version 不一致のため破棄します');
        this.clearSaved();
        return;
      }
      this.data = saved;
      console.log('[Choreo] localStorage から編集状態を復元しました');
    } catch (err) {
      console.warn('[Choreo] 保存データの読み込みに失敗', err);
    }
  }

  /** 現在の data を localStorage へ保存（エディタの編集確定時に呼ぶ） */
  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (err) {
      console.warn('[Choreo] 保存に失敗', err);
    }
  }

  /** 保存をクリアして bundled の初期値へ戻す */
  clearSaved() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* noop */
    }
    this.data = structuredClone(choreographyJson);
  }

  /** エディタの import 用 */
  replace(json) {
    if (!json || json.version !== this.data.version) {
      console.warn('[Choreo] version mismatch or invalid json — applying anyway');
    }
    this.data = structuredClone(json);
    // 取得・構築時と同様、欠落プロパティ（scene 等）を bundled 初期値で補完して
    // 後方互換性のないファイルでも読み込めるようにする。
    this._fillMissingDefaults();
  }

  toJSONString() {
    return JSON.stringify(this.data, null, 2);
  }
}

/**
 * defaults にあって target に無いキーを再帰的に埋める（既存値は上書きしない）。
 * プレーンオブジェクトのみ再帰し、配列・プリミティブは既存があればそのまま残す。
 */
function fillMissing(target, defaults) {
  for (const key of Object.keys(defaults)) {
    const dv = defaults[key];
    if (target[key] === undefined) {
      target[key] = structuredClone(dv);
    } else if (
      dv && typeof dv === 'object' && !Array.isArray(dv) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      fillMissing(target[key], dv);
    }
  }
}
