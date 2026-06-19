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
    this.video = document.getElementById('webcam-video');
    this.videoPlaceholder = document.getElementById('webcam-placeholder');
    this.shootCaption = document.getElementById('shoot-caption');
    this.countdown = document.getElementById('countdown');
    this.flash = document.getElementById('flash-overlay');
    this.result = {
      image: document.getElementById('result-image'),
      textBL: document.getElementById('result-text-bl'),
      logoTR: document.getElementById('result-logo-tr'),
      logoImg: document.getElementById('result-logo-img'),
      brandBR: document.getElementById('result-brand-br'),
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
