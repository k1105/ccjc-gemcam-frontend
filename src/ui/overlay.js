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

/** "#ccc" / "#cccccc" / "ccc" 形式の16進カラーを {r,g,b}(0-255) へ変換する */
function hexToRgb(hex) {
  let h = String(hex).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (h.length !== 6 || Number.isNaN(n)) return { r: 204, g: 204, b: 204 }; // #ccc フォールバック
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
