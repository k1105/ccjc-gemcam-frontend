import choreographyJson from '../choreo/choreography.json';

const STORAGE_KEY = 'ccjc:choreo';

/**
 * choreography.json のランタイムストア。
 * 本番は静的importした値をそのまま使う。デバッグエディタは data を直接ミューテートし、
 * export で JSON ダウンロード / import でファイル差し替えプレビューを行う。
 * エディタでの編集は localStorage に自動保存され、リロード後も復元される
 * （バージョン不一致の保存データは破棄して bundled の初期値を使う）。
 */
export class Choreo {
  constructor() {
    // ディープコピーして元のモジュールキャッシュを汚さない
    this.data = structuredClone(choreographyJson);
    this._restoreFromStorage();
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
    this.data = json;
  }

  toJSONString() {
    return JSON.stringify(this.data, null, 2);
  }
}
