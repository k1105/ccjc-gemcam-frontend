import gsap from 'gsap';
import { Sequence } from '../core/sequence-manager.js';
import { TimerBag } from '../core/resources.js';
import { playSfx } from '../core/audio.js';
import { crushNearWhiteUrl } from '../core/near-white.js';

/**
 * RESULT: 生成画像が装飾なしで中央フェードイン。左上に Next Chapter of Growth ロゴ、
 * 下端にブランドカラーの帯（rect）が「上から登場→全画面を覆う→下端固定で画面高さ10%
 * に定着」というモーションで現れる。滞留後にフレームアウトして真っ白になり、ボトル
 * 復帰アニメ付きで SELECT へ戻る。
 */
export class ResultSequence extends Sequence {
  async enter(payload) {
    const { overlay, choreo } = this.ctx;
    const { result, brand } = payload;
    this.bag = new TimerBag();
    const rcfg = choreo.data.result;
    const els = overlay.result;

    // 生成画像の near-white を完全な #ffffff に潰してから表示する（閾値 230 固定）。
    // CORS 未設定等で潰しに失敗した場合は元 URL にフォールバックされる。
    els.image.src = await crushNearWhiteUrl(result.imageUrl);
    els.rect.style.backgroundColor = brand.themeColor || '#000';

    // 初期状態リセット（前回アウトロの y 移動も戻す）
    gsap.set(els.image, { opacity: 0, y: 0 });
    gsap.set(els.logo, { opacity: 0, y: 0 });
    gsap.set(els.rect, { y: 0, scaleY: 0, transformOrigin: 'top center' });

    overlay.hideAll();
    overlay.show('result');
    playSfx(choreo, 'resultAppear');

    // --- フレームイン ---
    const r = rcfg.rect;
    const tl = this.bag.timeline();
    // rect: 上から登場して全画面を覆う → 下端を固定して画面高さ10%に定着
    tl.to(els.rect, { scaleY: 1, duration: r.dropDuration, ease: r.dropEase }, 0);
    tl.set(els.rect, { transformOrigin: 'bottom center' }, r.dropDuration);
    tl.to(
      els.rect,
      { scaleY: r.heightPct / 100, duration: r.settleDuration, ease: r.settleEase },
      r.dropDuration + r.holdFull
    );
    // 生成結果・ロゴは rect が画面全体を覆い切ってから登場（覆われた裏でフェードインし、
    // rect が下へ退くのに合わせて姿を現す）
    tl.to(els.image, { opacity: 1, duration: rcfg.imageFadeIn, ease: 'power2.out' }, r.dropDuration);
    tl.to(els.logo, { opacity: 1, duration: rcfg.imageFadeIn, ease: 'power2.out' }, r.dropDuration);

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
    const bandH = window.innerHeight * (rcfg.rect.heightPct / 100);
    return new Promise((resolve) => {
      const tl = this.bag.timeline({ onComplete: resolve });
      // 画像・ブランドカラー帯をそろえて画面の下へ抜く
      tl.to(els.image, {
        y: window.innerHeight,
        duration: o.imageSlideDown,
        ease: o.imageSlideEase,
      }, 0);
      tl.to(els.rect, {
        y: bandH, // 帯の高さぶん下へ動かして画面外へ送る
        duration: o.imageSlideDown,
        ease: o.imageSlideEase,
      }, 0);
      // ロゴも下方向へ流しつつフェードアウト
      tl.to(els.logo, {
        y: 40,
        opacity: 0,
        duration: o.elementDuration,
        ease: 'power2.in',
      }, 0);
      // 真っ白のまま保持
      tl.to({}, { duration: o.whiteHold });
    });
  }

  async exit() {
    const { overlay } = this.ctx;
    this.bag.disposeAll();
    const els = overlay.result;
    gsap.killTweensOf([els.image, els.logo, els.rect]);
    els.image.src = ''; // 前回画像のメモリ解放
    overlay.hide('result');
  }
}
