import gsap from 'gsap';

/**
 * 撮影 / リザルト / 待機 画面の単体プレビュー（エディタ専用）。
 *
 * 本番の DOM オーバーレイ（#screen-shoot / #screen-result）をそのまま使い、
 * choreo の値で「静止プレビュー」を表示する。replay() で現在の値を使った演出
 * （撮影=カウントダウン＋シャッター / リザルト=イントロ→滞留→アウトロ）を再生する。
 *
 * 本番シーケンス（select/shoot/result）には触れず overlay の DOM だけを操作する。
 * manager は select 待機のまま。万一 select を抜けた / 遷移が始まったら自動撤収する。
 * editor が閉じる・タブが切り替わるときは必ず hide() でオーバーレイを片付けること。
 */
export class ScreenPreview {
  constructor(ctx) {
    this.ctx = ctx;
    this.active = null; // 'select' | 'shoot' | 'result' | null
    this._animToken = 0; // 再生（replay）のキャンセル用トークン
    this._tl = null; // 再生中の gsap タイムライン
    this._tick = this._tick.bind(this);
  }

  /** 指定画面の静止プレビューを表示。'select' はオーバーレイを畳んだ待機状態。 */
  show(screen) {
    if (this.active === screen) return;
    this._stopAnim();
    const { overlay, world } = this.ctx;
    overlay.hideAll();
    overlay.hideCountdown();
    this._clearProps();

    if (screen === 'shoot') this._showShoot();
    else if (screen === 'result') this._showResult();
    else this._showSelect();

    if (!this.active) world.addTickable(this._tick); // 本番遷移で自動撤収する監視
    this.active = screen;
  }

  /** プレビュー終了。オーバーレイを隠してインラインスタイルを戻す。 */
  hide() {
    if (!this.active) return;
    this._stopAnim();
    const { overlay, world } = this.ctx;
    world.removeTickable(this._tick);
    overlay.hideAll();
    overlay.hideCountdown();
    this._clearProps();
    this.active = null;
  }

  /** 現在の画面の演出を、いまの choreo 値で再生する（撮影/リザルトのみ）。 */
  async replay() {
    if (this.active === 'shoot') await this._runShootAnim();
    else if (this.active === 'result') await this._runResultAnim();
  }

  // ---- 静止プレビュー ----

  _showSelect() {
    // 待機＝オーバーレイ無し。ボトルラックを見せるだけ（カメラドリフトは SELECT tick が継続）
    this.ctx.bottleRack.setVisible(true);
  }

  _showShoot() {
    const { overlay } = this.ctx;
    overlay.hideAll();
    // Webカメラは掴まずプレースホルダ表示（編集中にカメラLEDを点けない）
    overlay.video.classList.add('hidden');
    overlay.video.srcObject = null;
    overlay.videoPlaceholder.classList.remove('hidden');
    gsap.set(overlay.screens.shoot, { opacity: 1 });
    gsap.set(overlay.shootCaption, { opacity: 1 });
    overlay.show('shoot');
  }

  _showResult() {
    const { overlay, brands } = this.ctx;
    const els = overlay.result;
    const brand = brands.list[0];
    els.image.src = makeResultTestImage(1280, 1600);
    els.brandBR.textContent = brand?.label ?? 'ブランド名';
    // ロゴは画像パス依存を避けてラベル文字で代用（レイアウト/タイミング確認には十分）
    els.logoImg.hidden = true;
    els.logoTR.textContent = brand?.label ?? 'LOGO';
    overlay.hideAll();
    gsap.set(els.image, { opacity: 1, y: 0 });
    gsap.set([els.textBL, els.logoTR, els.brandBR], { opacity: 1, x: 0, y: 0 });
    overlay.show('result');
  }

  // ---- 演出再生（本番 sequences のミラー。choreo 値はライブ参照） ----

  async _runShootAnim() {
    const { overlay } = this.ctx;
    const cfg = this.ctx.choreo.data.shoot;
    const token = ++this._animToken;
    this._showShoot();
    await this._wait(150);
    if (token !== this._animToken) return;

    // キャプションを引っ込めて 3-2-1 → シャッター（本番 shoot.js のミラー、遷移はしない）
    await this._playTimeline((tl) => tl.to(overlay.shootCaption, { opacity: 0, duration: 0.3 }), token);
    if (token !== this._animToken) return;

    const ms = cfg.countdownInterval * 1000;
    for (let n = 3; n >= 1; n--) {
      overlay.showCountdownTick(n);
      await this._wait(ms);
      if (token !== this._animToken) return;
    }
    overlay.hideCountdown();
    // シャッターの白フラッシュ。本番のような GENERATE 遷移はしない。
    const inDur = 0.07;
    const outDur = 0.5;
    overlay.flashWhite({ inDur, hold: cfg.postSnapDelay, outDur });
    await this._wait((inDur + cfg.postSnapDelay + outDur) * 1000);
    if (token !== this._animToken) return;
    this._showShoot(); // 静止プレビューへ復帰（キャプション再表示）
  }

  async _runResultAnim() {
    const { overlay } = this.ctx;
    const rcfg = this.ctx.choreo.data.result;
    const els = overlay.result;
    const token = ++this._animToken;

    // イントロ初期状態（本番 result.js enter のミラー）
    this._showResult();
    gsap.set(els.image, { opacity: 0, y: 0 });
    gsap.set([els.textBL, els.logoTR, els.brandBR], { opacity: 0, x: 0, y: 0 });

    await this._playTimeline((tl) => {
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
    }, token);
    if (token !== this._animToken) return;

    await this._wait(rcfg.dwell * 1000);
    if (token !== this._animToken) return;

    // アウトロ（本番 result.js _outro のミラー）
    const o = rcfg.outro;
    await this._playTimeline((tl) => {
      tl.to(els.image, { y: window.innerHeight, duration: o.imageSlideDown, ease: o.imageSlideEase }, 0);
      [els.textBL, els.logoTR, els.brandBR].forEach((el, i) => {
        tl.to(el, { opacity: 0, duration: o.elementDuration, ease: 'power2.in' }, o.imageSlideDown * 0.5 + i * o.elementsStagger);
      });
      tl.to({}, { duration: o.whiteHold });
    }, token);
    if (token !== this._animToken) return;
    this._showResult(); // 静止プレビューへ復帰
  }

  // ---- ヘルパー ----

  /** select を抜けた／遷移が始まったらプレビューを撤収（本番フローとの衝突防止） */
  _tick() {
    const { manager } = this.ctx;
    if (!manager.is('select') || manager.transitioning) this.hide();
  }

  /** gsap タイムラインを1本組んで再生し、尺ぶん待つ（キャンセルは token 側で判定） */
  _playTimeline(build, token) {
    const tl = gsap.timeline({ paused: true });
    this._tl = tl;
    build(tl);
    tl.play();
    return this._wait(tl.totalDuration() * 1000);
  }

  _wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 進行中の再生を止める（トークンを無効化し、走っている tween/timeline を kill） */
  _stopAnim() {
    this._animToken++;
    if (this._tl) {
      this._tl.kill();
      this._tl = null;
    }
    const { overlay } = this.ctx;
    const els = overlay.result;
    gsap.killTweensOf([overlay.shootCaption, overlay.flash, els.image, els.textBL, els.logoTR, els.brandBR]);
  }

  /** プレビューで触ったインラインスタイルを除去して CSS 既定へ戻す */
  _clearProps() {
    const { overlay } = this.ctx;
    const els = overlay.result;
    gsap.set(
      [overlay.screens.shoot, overlay.screens.result, overlay.shootCaption, overlay.flash, els.image, els.textBL, els.logoTR, els.brandBR],
      { clearProps: 'opacity,transform' }
    );
  }

  dispose() {
    this.hide();
  }
}

/** リザルト写真の代わりに使うテスト画像（グラデ＋枠＋ラベル）の data URL */
function makeResultTestImage(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#1d2b3a');
  grad.addColorStop(0.5, '#3a5068');
  grad.addColorStop(1, '#0f1620');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 6;
  ctx.strokeRect(40, 40, w - 80, h - 80);

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = `600 ${Math.round(w * 0.07)}px Outfit, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('RESULT PREVIEW', w / 2, h / 2);
  return canvas.toDataURL('image/png');
}
