import gsap from 'gsap';

/**
 * DOMオーバーレイ（SHOOT映像 / カウントダウン / RESULT要素 / フラッシュ）の薄いラッパ。
 * 演出タイミング自体は各シーケンスが choreography 設定値で組む。
 */
export class Overlay {
  constructor() {
    this.screens = {
      shoot: document.getElementById('screen-shoot'),
      result: document.getElementById('screen-result'),
    };
    this.selectGradient = document.getElementById('select-gradient');
    this.selectRect = document.getElementById('select-rect');
    this._wipeToken = 0; // brandWipeUp の世代トークン（reset 割り込み検出用）
    this.video = document.getElementById('webcam-video');
    this.videoPlaceholder = document.getElementById('webcam-placeholder');
    this.shootCaption = document.getElementById('shoot-caption');
    this.countdown = document.getElementById('countdown');
    this.flash = document.getElementById('flash-overlay');
    this.result = {
      image: document.getElementById('result-image'),
      logo: document.getElementById('result-logo'),
      rect: document.getElementById('result-rect'),
    };
  }

  show(name) {
    this.screens[name]?.classList.remove('hidden');
  }

  hide(name) {
    this.screens[name]?.classList.add('hidden');
  }

  hideAll() {
    Object.values(this.screens).forEach((el) => el.classList.add('hidden'));
  }

  /**
   * 待機画面の上端グラデーション（影）を choreo 設定から適用する。
   * 上→下に向かって color の不透明度を startOpacity→endOpacity で変化させ、
   * 影の縦の長さは length（画面高さに対する vh）で指定する。
   */
  applySelectGradient(cfg) {
    const el = this.selectGradient;
    if (!el) return;
    if (!cfg || cfg.enabled === false) {
      el.classList.add('hidden');
      return;
    }
    const { r, g, b } = hexToRgb(cfg.color ?? '#cccccc');
    const top = cfg.startOpacity ?? 1;
    const bottom = cfg.endOpacity ?? 0;
    el.style.height = `${cfg.length ?? 40}vh`;
    el.style.background =
      `linear-gradient(to bottom, rgba(${r},${g},${b},${top}) 0%, rgba(${r},${g},${b},${bottom}) 100%)`;
  }

  /** グラデーションを設定に従って表示する（enabled:false なら表示しない） */
  showSelectGradient(cfg) {
    this.applySelectGradient(cfg);
    if (cfg && cfg.enabled !== false) this.selectGradient?.classList.remove('hidden');
  }

  hideSelectGradient() {
    this.selectGradient?.classList.add('hidden');
  }

  /**
   * 待機画面の選択演出: ブランドカラーの帯を画面下から立ち上げて全画面を覆い、
   * 覆い切った時点で onCovered を呼んで（裏でカメラ画面へ切替）、そのまま帯を
   * 上へ流して画面外へ抜く（＝カメラ画面が出現）。result の帯を上下反転したモーション。
   *
   * フレーム落ち対策:
   *  - display:none を使わず visibility で出し入れし、表示瞬間のレイヤー再生成を避ける。
   *  - 覆い切ってから「最低 holdFull」かつ「カメラ準備完了 or maxHold で打ち切り」まで
   *    覆ったまま待ち、video の初回デコード等の重い処理を覆われている間に済ませてから流す。
   *    onCovered は準備完了の Promise を返してよい（返さなければ holdFull のみで流す）。
   *
   * 帯の表示は SELECT→SHOOT のシーケンス境界をまたいで継続する（overlay 直下の要素）。
   * 進行中に resetBrandWipe() が割り込んだら（ESC等）トークン不一致で安全に中断する。
   */
  async brandWipeUp(color, cfg, onCovered) {
    const el = this.selectRect;
    if (!el) {
      await onCovered?.();
      return;
    }
    const token = ++this._wipeToken;
    const alive = () => token === this._wipeToken;

    gsap.killTweensOf(el);
    el.style.backgroundColor = color || '#000';
    gsap.set(el, { yPercent: 100, visibility: 'visible' });

    // 下から登場して全画面を覆う
    await gsap.to(el, { yPercent: 0, duration: cfg.riseDuration, ease: cfg.riseEase });
    if (!alive()) return;

    // 覆い切った裏でカメラ画面へハンドオフ（重い video アタッチ/デコードはこの間に）
    const ready = Promise.resolve(onCovered?.());
    // 最低 holdFull は覆ったまま保持し、カメラ準備完了 or maxHold で打ち切ってから流す
    await Promise.all([
      wait(cfg.holdFull ?? 0),
      Promise.race([ready, wait(cfg.maxHold ?? 0)]),
    ]);
    if (!alive()) return;

    // そのまま上へ流れて画面外へ → カメラ画面が出現
    await gsap.to(el, { yPercent: -100, duration: cfg.flowDuration, ease: cfg.flowEase });
    if (!alive()) return;

    // 次サイクルに備えて画面下へ退避して非表示に
    gsap.set(el, { yPercent: 100, visibility: 'hidden' });
  }

  /** 強制リセット時などに選択演出の帯を即座に隠して初期化する（進行中の brandWipeUp も無効化） */
  resetBrandWipe() {
    this._wipeToken = (this._wipeToken ?? 0) + 1; // 進行中ワイプを無効化
    const el = this.selectRect;
    if (!el) return;
    gsap.killTweensOf(el);
    gsap.set(el, { yPercent: 100, visibility: 'hidden' });
  }

  /** カウントダウン1拍ぶんの表示（CSSアニメ再トリガ） */
  showCountdownTick(n) {
    this.countdown.textContent = String(n);
    this.countdown.classList.remove('hidden', 'tick');
    void this.countdown.offsetWidth; // reflow でアニメ再トリガ
    this.countdown.classList.add('tick');
  }

  hideCountdown() {
    this.countdown.classList.add('hidden');
    this.countdown.classList.remove('tick');
  }

  /**
   * 白フラッシュ。inDur で白くなり、holdMs 維持後 outDur で抜ける。
   * 白くなりきったタイミングで onWhite を呼ぶ（画面切替に使う）。
   */
  flashWhite({ inDur = 0.15, hold = 0.05, outDur = 0.6, onWhite } = {}) {
    return new Promise((resolve) => {
      gsap.killTweensOf(this.flash);
      const tl = gsap.timeline({ onComplete: resolve });
      tl.to(this.flash, { opacity: 1, duration: inDur, ease: 'power2.in' });
      tl.add(() => {
        if (onWhite) onWhite();
      });
      tl.to(this.flash, { opacity: 0, duration: outDur, ease: 'power2.out' }, `+=${hold}`);
    });
  }

  /** 即座に白に固定 / 解除（強制リセット用） */
  setWhite(on, dur = 0.3) {
    gsap.killTweensOf(this.flash);
    return new Promise((resolve) => {
      gsap.to(this.flash, { opacity: on ? 1 : 0, duration: dur, onComplete: resolve });
    });
  }
}

/** 秒数だけ待つ Promise（brandWipeUp の hold/cap 用） */
function wait(seconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));
}

/** "#ccc" / "#cccccc" / "ccc" 形式の16進カラーを {r,g,b}(0-255) へ変換する */
function hexToRgb(hex) {
  let h = String(hex).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return { r: 204, g: 204, b: 204 }; // #ccc フォールバック
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
