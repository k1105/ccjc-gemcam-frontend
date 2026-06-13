/**
 * シーケンス（画面）間の遷移を管理するステートマシン。
 * - 前シーケンスの exit() 完了を待ってから次の enter() を呼ぶ
 * - 遷移中の再入はキューせず無視（ブースのキー連打対策）
 * - ESC 強制リセットは reset() 経由（exit に force フラグを渡す）
 */
export class SequenceManager {
  constructor() {
    this.sequences = new Map();
    this.current = null;
    this.currentName = null;
    this.transitioning = false;
  }

  register(name, sequence) {
    this.sequences.set(name, sequence);
  }

  is(name) {
    return this.currentName === name;
  }

  async go(name, payload = {}) {
    if (this.transitioning) {
      console.warn(`[Seq] transition to ${name} ignored (busy)`);
      return;
    }
    const next = this.sequences.get(name);
    if (!next) {
      console.error(`[Seq] unknown sequence: ${name}`);
      return;
    }

    this.transitioning = true;
    console.log(`[Seq] ${this.currentName ?? '(none)'} -> ${name}`);
    try {
      if (this.current) await this.current.exit({ force: false });
      this.current = next;
      this.currentName = name;
      await next.enter(payload);
    } catch (err) {
      console.error(`[Seq] transition error -> ${name}`, err);
    } finally {
      this.transitioning = false;
    }
  }

  /** ESC等による強制リセット。現行シーケンスを叩き落として initial に戻す */
  async reset(initialName, payload = {}) {
    const next = this.sequences.get(initialName);
    if (!next) return;

    // 進行中の遷移があれば完了を待つ（exit/enter の並走による状態破壊を防ぐ）
    for (let i = 0; i < 100 && this.transitioning; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // 既に initial でも再enterする（選択沈下アニメ等の進行中アクションを破棄するため）
    console.log(`[Seq] FORCE RESET ${this.currentName} -> ${initialName}`);
    this.transitioning = true;
    try {
      if (this.current) await this.current.exit({ force: true });
      this.current = next;
      this.currentName = initialName;
      await next.enter({ ...payload, reset: true });
    } catch (err) {
      console.error('[Seq] reset error', err);
    } finally {
      this.transitioning = false;
    }
  }
}

/**
 * シーケンス基底クラス。ctx には world / overlay / brands / api / choreo /
 * manager / keyboard / bottleRack 等が入る（main.js で構築）。
 */
export class Sequence {
  constructor(ctx) {
    this.ctx = ctx;
  }

  /* eslint-disable-next-line no-unused-vars */
  async enter(payload) {}

  /* eslint-disable-next-line no-unused-vars */
  async exit({ force }) {}
}
