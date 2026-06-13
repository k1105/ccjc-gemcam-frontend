import gsap from 'gsap';

/**
 * Object3D 以下の geometry / material / texture を再帰的に破棄する。
 * 長時間稼働ブースでのリーク防止のため、シーケンス退場時に必ず呼ぶこと。
 */
export function disposeObject3D(root) {
  if (!root) return;
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      materials.forEach((mat) => {
        for (const value of Object.values(mat)) {
          if (value && value.isTexture) value.dispose();
        }
        mat.dispose();
      });
    }
  });
  if (root.parent) root.parent.remove(root);
}

/**
 * シーケンスが生成する一時リソース（timeout/interval/tween/listener/任意cleanup）の
 * 一括破棄バッグ。enter() で作り、exit()/強制リセットで disposeAll() する。
 */
export class TimerBag {
  constructor() {
    this.timeouts = new Set();
    this.intervals = new Set();
    this.tweens = new Set();
    this.listeners = [];
    this.cleanups = [];
    this.disposed = false;
  }

  setTimeout(fn, ms) {
    const id = window.setTimeout(() => {
      this.timeouts.delete(id);
      fn();
    }, ms);
    this.timeouts.add(id);
    return id;
  }

  setInterval(fn, ms) {
    const id = window.setInterval(fn, ms);
    this.intervals.add(id);
    return id;
  }

  /** gsap tween / timeline を登録して返す */
  tween(t) {
    this.tweens.add(t);
    return t;
  }

  /** gsap.to のショートハンド（自動登録） */
  to(target, vars) {
    return this.tween(gsap.to(target, vars));
  }

  timeline(vars) {
    return this.tween(gsap.timeline(vars));
  }

  addListener(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    this.listeners.push({ target, type, fn, options });
  }

  /** 任意のクリーンアップ関数を登録 */
  add(cleanupFn) {
    this.cleanups.push(cleanupFn);
  }

  /** ms 待つ Promise（バッグ破棄時は解決されないままになる＝後続処理も止まる） */
  delay(ms) {
    return new Promise((resolve) => this.setTimeout(resolve, ms));
  }

  disposeAll() {
    this.disposed = true;
    this.timeouts.forEach((id) => window.clearTimeout(id));
    this.intervals.forEach((id) => window.clearInterval(id));
    this.tweens.forEach((t) => t.kill());
    this.listeners.forEach(({ target, type, fn, options }) =>
      target.removeEventListener(type, fn, options)
    );
    this.cleanups.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.warn('[TimerBag] cleanup error', err);
      }
    });
    this.timeouts.clear();
    this.intervals.clear();
    this.tweens.clear();
    this.listeners.length = 0;
    this.cleanups.length = 0;
  }
}
