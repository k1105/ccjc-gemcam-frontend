import gsap from 'gsap';
import { Sequence } from '../core/sequence-manager.js';
import { TimerBag } from '../core/resources.js';

/** 縦書き表示用の日本語ブランド名（brands.json は変更しない方針のためフロント側で対応） */
const JP_NAMES = {
  'coca-cola': 'コカ・コーラ',
  'coca-cola-zero': 'コカ・コーラ ゼロ',
  ilohas: 'い・ろ・は・す',
  aquarius: 'アクエリアス',
  'yakan-no-mugicha': 'やかんの麦茶',
  sprite: 'スプライト',
  ayataka: '綾鷹',
  georgia: 'ジョージア ザ・ブラック',
  'soken-bicha': '爽健美茶',
  toreta: 'トレタ',
};

/** 右上ロゴ画像。slug と public/logos/{file} を対応させる（拡張子はファイルごとに異なる） */
const LOGO_FILES = {
  'coca-cola': 'coca-cola.png',
  'coca-cola-zero': 'coca-cola-zero.png',
  ilohas: 'ilohas.webp',
  aquarius: 'aquarius.webp',
  'yakan-no-mugicha': 'yakan-no-mugicha.webp',
  sprite: 'sprite.png',
  ayataka: 'ayataka.jpg',
  georgia: 'georgia.webp',
  'soken-bicha': 'soken-bicha.jpg',
  toreta: 'toreta.webp',
};

/**
 * RESULT: 生成画像が装飾なしで中央フェードイン。左下テキスト / 右上ロゴ /
 * 右下縦書きブランド名が段階フレームイン。滞留後に段階フレームアウトして
 * 真っ白になり、ボトル復帰アニメ付きで SELECT へ戻る。
 */
export class ResultSequence extends Sequence {
  async enter(payload) {
    const { overlay, manager, choreo } = this.ctx;
    const { result, brand } = payload;
    this.bag = new TimerBag();
    const rcfg = choreo.data.result;
    const els = overlay.result;

    els.image.src = result.imageUrl;
    els.brandBR.textContent = JP_NAMES[brand.slug] ?? brand.label;

    // 右上ロゴ：画像があれば <img>、無ければラベル文字をフォールバック表示
    const logoFile = LOGO_FILES[brand.slug];
    if (logoFile) {
      els.logoImg.src = `/logos/${logoFile}`;
      els.logoImg.alt = brand.label;
      els.logoImg.hidden = false;
      els.logoTR.textContent = '';
      els.logoTR.appendChild(els.logoImg);
    } else {
      els.logoImg.hidden = true;
      els.logoTR.textContent = brand.label;
    }

    // 初期状態リセット
    gsap.set(els.image, { opacity: 0, y: 0 });
    gsap.set([els.textBL, els.logoTR, els.brandBR], { opacity: 0, x: 0, y: 0 });

    overlay.hideAll();
    overlay.show('result');

    // --- 段階フレームイン ---
    const tl = this.bag.timeline();
    tl.to(els.image, { opacity: 1, duration: rcfg.imageFadeIn, ease: 'power2.out' }, 0);
    for (const item of rcfg.stagger) {
      const el = els[item.el];
      if (!el) continue;
      tl.fromTo(
        el,
        { opacity: 0, x: item.x ?? 0, y: item.y ?? 0 },
        { opacity: 1, x: 0, y: 0, duration: item.duration, ease: item.ease },
        item.delay
      );
    }

    // 滞留→アウトロ→遷移は enter の外で進行させる
    // （enter 内で待つと manager.go が完了せず次遷移が busy 扱いになる）
    this._run(rcfg, els).catch((err) => console.error('[Result] run error', err));
  }

  async _run(rcfg, els) {
    const { overlay, manager } = this.ctx;
    await this.bag.delay((rcfg.dwell + rcfg.imageFadeIn) * 1000);
    if (this.bag.disposed) return;
    await this._outro(rcfg, els);
    if (this.bag.disposed) return;

    // リザルト画面を消しても白が継続するようフラッシュを重ねてから遷移
    await overlay.setWhite(true, 0.05);
    manager.go('select', { withReturn: true });
  }

  _outro(rcfg, els) {
    const o = rcfg.outro;
    return new Promise((resolve) => {
      const tl = this.bag.timeline({ onComplete: resolve });
      // 画像がまず画面の下へフレームアウト
      tl.to(els.image, {
        y: window.innerHeight,
        duration: o.imageSlideDown,
        ease: o.imageSlideEase,
      }, 0);
      // 他要素も段階的にアウト
      [els.textBL, els.logoTR, els.brandBR].forEach((el, i) => {
        tl.to(el, {
          opacity: 0,
          duration: o.elementDuration,
          ease: 'power2.in',
        }, o.imageSlideDown * 0.5 + i * o.elementsStagger);
      });
      // 真っ白のまま保持
      tl.to({}, { duration: o.whiteHold });
    });
  }

  async exit() {
    const { overlay } = this.ctx;
    this.bag.disposeAll();
    const els = overlay.result;
    gsap.killTweensOf([els.image, els.textBL, els.logoTR, els.brandBR]);
    els.image.src = ''; // 前回画像のメモリ解放
    overlay.hide('result');
  }
}
