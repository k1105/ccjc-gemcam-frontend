import gsap from 'gsap';
import { normalizeRegion } from '../core/region.js';

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
    this.shootRegion = document.getElementById('shoot-region');
    this.shootCaption = document.getElementById('shoot-caption');
    this.countdown = document.getElementById('countdown');
    this.flash = document.getElementById('flash-overlay');
    this.generateWaitLogo = document.getElementById('generate-wait-logo');
    this.result = {
      image: document.getElementById('result-image'),
      // logo はロゴ列のコンテナ（#result-logos）。gsap はこのコンテナをフェード/スライドさせる。
      logo: document.getElementById('result-logos'),
      rect: document.getElementById('result-rect'),
    };
  }

  /**
   * リザルト上端のロゴ列のレイアウトを choreo 設定から適用する。
   * 余白（上・左右）と高さはコンテナへ、各ロゴの上下左右オフセットは
   * CSS 変数として渡し（子要素の transform: translate に反映）、
   * gsap が触るコンテナの transform とは別レイヤーで効かせる。
   * cfg: { height, marginTop, marginLeft, marginRight,
   *        left:{height?,offsetX,offsetY}, right:{height?,offsetX,offsetY} }
   * 左右の height は個別サイズ（vh）。未指定なら共通 height にフォールバックする。
   */
  applyResultLogos(cfg) {
    const el = this.result.logo;
    if (!el || !cfg) return;
    const L = cfg.left ?? {};
    const R = cfg.right ?? {};
    el.style.setProperty('--logos-height', `${cfg.height ?? 7}vh`);
    el.style.setProperty('--logos-margin-top', `${cfg.marginTop ?? 5.5}vh`);
    el.style.setProperty('--logos-margin-left', `${cfg.marginLeft ?? 4.5}vw`);
    el.style.setProperty('--logos-margin-right', `${cfg.marginRight ?? 4.5}vw`);
    el.style.setProperty('--logo-left-h', `${L.height ?? cfg.height ?? 7}vh`);
    el.style.setProperty('--logo-right-h', `${R.height ?? cfg.height ?? 7}vh`);
    el.style.setProperty('--logo-left-x', `${L.offsetX ?? 0}px`);
    el.style.setProperty('--logo-left-y', `${L.offsetY ?? 0}px`);
    el.style.setProperty('--logo-right-x', `${R.offsetX ?? 0}px`);
    el.style.setProperty('--logo-right-y', `${R.offsetY ?? 0}px`);
  }

  show(name) {
    this.screens[name]?.classList.remove('hidden');
  }

  hide(name) {
    this.screens[name]?.classList.add('hidden');
  }

  hideAll() {
    Object.values(this.screens).forEach((el) => el.classList.add('hidden'));
    // 待機画面専用の上端グラデーションも必ず一緒に隠す（他画面への残留防止）。
    // SELECT は hideAll の後に showSelectGradient で出し直す。
    this.hideSelectGradient();
    // GENERATE 待機ロゴの残留も防ぐ。
    this.hideGenerateWaitLogo();
  }

  /**
   * GENERATE 待機ロゴ（中央）を表示する。
   * カメラ映像を 1.0s でホワイトアウトし、その白地の上にロゴをフェードインして
   * からゆっくり明滅（pulse）させる。
   */
  showGenerateWaitLogo() {
    const el = this.generateWaitLogo;
    if (!el) return;
    gsap.killTweensOf(el);
    el.classList.remove('hidden');
    // カメラ映像を 1.0s でホワイトアウト（ロゴは flash の上に出る）
    this.setWhite(true, 1.0);
    // フェードイン → ゆっくり明滅（sine yoyo の無限ループ）
    gsap
      .timeline()
      .fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.8, ease: 'power2.out' })
      .to(el, { opacity: 0.3, duration: 1.2, ease: 'sine.inOut', repeat: -1, yoyo: true });
  }

  /** GENERATE 待機ロゴを即座に隠す（ESC/リセット等の即時クリア用）。 */
  hideGenerateWaitLogo() {
    const el = this.generateWaitLogo;
    if (!el) return;
    gsap.killTweensOf(el);
    el.classList.add('hidden');
    gsap.set(el, { opacity: 0 });
  }

  /**
   * GENERATE 待機ロゴをフェードアウトして隠す（結果遷移時にパッと消えないように）。
   * 既に隠れている場合は即時 resolve。明滅ループは killTweensOf で止める。
   */
  fadeOutGenerateWaitLogo(dur = 0.5) {
    const el = this.generateWaitLogo;
    if (!el || el.classList.contains('hidden')) return Promise.resolve();
    gsap.killTweensOf(el);
    return new Promise((resolve) => {
      gsap.to(el, {
        opacity: 0,
        duration: dur,
        ease: 'power2.in',
        onComplete: () => {
          el.classList.add('hidden');
          resolve();
        },
      });
    });
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
    const length = cfg.length ?? 40;
    const blur = cfg.blur ?? 0;
    const c = (a) => `rgba(${r},${g},${b},${a})`;

    if (blur > 0) {
      // blur(σ) はカーネルが要素の外側（透明域・画面外）を拾うため、そのままだと
      // 上端・左右の端が薄まって角が白く透ける。ガウスの広がり ≈ 3σ ぶんだけ要素を
      // 画面外へはみ出させ、その余白を上端色のベタ塗りで「塗り足し（ブリード）」する。
      // 端の薄まりはビューポート外に逃げるので、画面内の角は白くならない。
      // 縦グラデーションは横方向に一様なので、左右は幅を広げるだけでベタ塗りになる。
      const m = Math.ceil(blur * 3);
      el.style.top = `-${m}px`;
      el.style.left = `-${m}px`;
      el.style.width = `calc(100% + ${2 * m}px)`;
      // 上に m px 伸ばしたぶん高さも増やし、可視領域の影の長さ（length）を保つ。
      el.style.height = `calc(${length}vh + ${m}px)`;
      // 0〜m px は上端色のベタ塗り（画面外の塗り足し）、そこから下が本来のグラデーション。
      el.style.background =
        `linear-gradient(to bottom, ${c(top)} 0, ${c(top)} ${m}px, ${c(bottom)} 100%)`;
      el.style.filter = `blur(${blur}px)`;
    } else {
      // ブラー無し: 余計なはみ出し／filter を消して既定のレイアウトへ戻す。
      el.style.top = '0';
      el.style.left = '0';
      el.style.width = '100%';
      el.style.height = `${length}vh`;
      el.style.background =
        `linear-gradient(to bottom, ${c(top)} 0%, ${c(bottom)} 100%)`;
      el.style.filter = 'none';
    }
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
  brandWipeUp(color, cfg, onCovered) {
    const el = this.selectRect;
    if (!el) return Promise.resolve(onCovered?.());

    const token = ++this._wipeToken;
    const alive = () => token === this._wipeToken;

    gsap.killTweensOf(el);
    el.style.backgroundColor = color || '#000';
    el.style.visibility = 'visible';
    gsap.set(el, { y: 0, yPercent: 100 }); // 画面下に待避（px成分を0に固定し yPercent のみで動かす）

    return new Promise((resolve) => {
      const tl = gsap.timeline({
        onComplete: () => {
          if (alive()) {
            el.style.visibility = 'hidden';
            gsap.set(el, { y: 0, yPercent: 100 }); // 次サイクルに備えて画面下へ退避
          }
          resolve();
        },
      });
      this._wipeTl = tl;

      // ① 下から登場して全画面を覆う
      tl.to(el, { yPercent: 0, duration: cfg.riseDuration, ease: cfg.riseEase });
      // ② 覆い切ったところで一旦停止し、裏でカメラ画面へハンドオフ（重い video アタッチ/
      //    デコードはこの“覆われている”間に）。最低 holdFull は覆ったまま保持し、カメラ
      //    準備完了 or maxHold で打ち切ってから ③ を再生する。
      tl.addPause('+=0', () => {
        const ready = Promise.resolve(onCovered?.());
        Promise.all([
          wait(cfg.holdFull ?? 0),
          Promise.race([ready, wait(cfg.maxHold ?? 0)]),
        ]).then(() => {
          if (alive()) tl.play();
        });
      });
      // ③ そのまま上へ流れて画面外へ → カメラ画面が出現
      tl.to(el, { yPercent: -100, duration: cfg.flowDuration, ease: cfg.flowEase });
    });
  }

  /** 強制リセット時などに選択演出の帯を即座に隠して初期化する（進行中の brandWipeUp も無効化） */
  resetBrandWipe() {
    this._wipeToken = (this._wipeToken ?? 0) + 1; // 進行中ワイプを無効化（再生・後始末を抑止）
    this._wipeTl?.kill();
    this._wipeTl = null;
    const el = this.selectRect;
    if (!el) return;
    gsap.killTweensOf(el);
    el.style.visibility = 'hidden';
    gsap.set(el, { y: 0, yPercent: 100 });
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
   * 生成領域（API へ送るクロップ範囲）のボックスを撮影画面に重ねて可視化する。
   * region は画面に対する正規化矩形 {x,y,w,h}（0..1）。デバッグ専用（本番は呼ばない）。
   */
  showShootRegion(region) {
    const el = this.shootRegion;
    if (!el) return;
    const r = normalizeRegion(region);
    el.style.left = `${r.x * 100}%`;
    el.style.top = `${r.y * 100}%`;
    el.style.width = `${r.w * 100}%`;
    el.style.height = `${r.h * 100}%`;
    el.classList.remove('hidden');
  }

  hideShootRegion() {
    this.shootRegion?.classList.add('hidden');
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
