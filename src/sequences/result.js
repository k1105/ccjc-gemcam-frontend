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
    const { result, brand, displaySrc } = payload;
    this.bag = new TimerBag();
    const rcfg = choreo.data.result;
    const els = overlay.result;

    // 生成画像の near-white を #ffffff に潰した表示用 src。GENERATE が遷移前に
    // 処理済みの displaySrc を渡してくるのが通常で、その場合は再 fetch / 再処理せず
    // 即セットできる（白フラッシュ中の待ち時間を消す）。直接 RESULT に入った等で
    // 未指定なら、ここでフォールバックとして潰し処理する（失敗時は元 URL）。
    els.image.src = displaySrc ?? (await crushNearWhiteUrl(result.imageUrl));
    // <img> が実際に描画可能になるまで待つ（decode 完了前にフェードインを始めると
    // 画像が間に合わず空のまま表示されてしまう）。decode 非対応/失敗時は続行する。
    await this._awaitImageReady(els.image);
    // 待機中に exit された場合は以降のアニメーションを開始しない
    if (this.bag.disposed) return;
    els.rect.style.backgroundColor = brand.themeColor || '#000';
    overlay.applyResultLogos(rcfg.logos); // 上端ロゴ列の余白・オフセットを設定から反映

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

  /**
   * <img> がデコード済みで描画可能になるまで待つ。
   * decode() 対応ブラウザではそれを優先し、非対応・失敗時は onload で待機する。
   * いずれも失敗した場合でも表示は壊さないため resolve して続行する。
   */
  _awaitImageReady(img) {
    if (!img || !img.src) return Promise.resolve();
    if (typeof img.decode === 'function') {
      return img.decode().catch(() => this._awaitImageLoad(img));
    }
    return this._awaitImageLoad(img);
  }

  _awaitImageLoad(img) {
    // 既にデコード済みで自然サイズが確定していれば即時 resolve
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        img.removeEventListener('load', done);
        img.removeEventListener('error', done);
        resolve();
      };
      img.addEventListener('load', done);
      img.addEventListener('error', done); // 失敗時も表示は続行させる
    });
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
