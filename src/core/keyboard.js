/**
 * 単一の keydown リスナーで全キー入力を捌く。
 * - グローバルハンドラ（ESC リセット / D エディタ）は main.js が登録
 * - シーケンス固有ハンドラは enter() で setHandler / exit() で clearHandler
 */
export class Keyboard {
  constructor() {
    this.sequenceHandler = null;
    this.globalHandlers = [];
    this._onKeyDown = this._onKeyDown.bind(this);
    window.addEventListener('keydown', this._onKeyDown);
  }

  _onKeyDown(e) {
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    for (const handler of this.globalHandlers) {
      if (handler(key, e) === true) return; // consumed
    }
    if (this.sequenceHandler) this.sequenceHandler(key, e);
  }

  addGlobalHandler(fn) {
    this.globalHandlers.push(fn);
  }

  setHandler(fn) {
    this.sequenceHandler = fn;
  }

  clearHandler() {
    this.sequenceHandler = null;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
  }
}
