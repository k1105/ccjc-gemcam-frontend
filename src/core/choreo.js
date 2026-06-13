import choreographyJson from '../choreo/choreography.json';

/**
 * choreography.json のランタイムストア。
 * 本番は静的importした値をそのまま使う。デバッグエディタは data を直接ミューテートし、
 * export で JSON ダウンロード / import でファイル差し替えプレビューを行う。
 */
export class Choreo {
  constructor() {
    // ディープコピーして元のモジュールキャッシュを汚さない
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
