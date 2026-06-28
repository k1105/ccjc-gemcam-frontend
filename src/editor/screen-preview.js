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
    this._webcamToken = 0; // 撮影プレビューのカメラ取得（非同期）のキャンセル用トークン
    this._tl = null; // 再生中の gsap タイムライン
    this._tick = this._tick.bind(this);
  }

  /** 指定画面の静止プレビューを表示。'select' はオーバーレイを畳んだ待機状態。 */
  show(screen) {
    if (this.active === screen) return;
    this._stopAnim();
    const { overlay, world } = this.ctx;
    overlay.hideAll();
    overlay.hideSelectGradient();
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
    this._detachWebcam();
    overlay.hideShootRegion();
    overlay.hideAll();
    overlay.hideSelectGradient();
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
    this._detachWebcam();
    this.ctx.overlay.hideShootRegion();
    // 待機＝オーバーレイ無し。ボトルラックと上端グラデーションを見せる（カメラドリフトは SELECT tick が継続）
    this.ctx.bottleRack.setVisible(true);
    this.ctx.overlay.showSelectGradient(this.ctx.choreo.data.select.gradient);
  }

  _showShoot() {
    const { overlay, choreo } = this.ctx;
    overlay.hideAll();
    gsap.set(overlay.screens.shoot, { opacity: 1 });
    gsap.set(overlay.shootCaption, { opacity: 1 });
    overlay.show('shoot');
    // 生成領域（API クロップ範囲）を可視化（デバッグ専用）
    overlay.showShootRegion(choreo.data.shoot.region);
    // デバイスのカメラ映像をライブ表示（取得できなければプレースホルダ）
    this._attachWebcam();
  }

  _showResult() {
    const { overlay, brands } = this.ctx;
    this._detachWebcam();
    overlay.hideShootRegion();
    const els = overlay.result;
    const brand = brands.list[0];
    els.image.src = makeResultTestImage(1280, 1600);
    els.rect.style.backgroundColor = brand?.themeColor || '#000';
    overlay.applyResultLogos(this.ctx.choreo.data.result.logos); // ロゴ列の余白・オフセットを反映
    overlay.hideAll();
    gsap.set(els.image, { opacity: 1, y: 0 });
    gsap.set(els.logo, { opacity: 1, y: 0 });
    // 定着後の見え方（下端固定で画面高さ10%）を静止プレビューで再現
    gsap.set(els.rect, {
      y: 0,
      scaleY: this.ctx.choreo.data.result.rect.heightPct / 100,
      transformOrigin: 'bottom center',
    });
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
    gsap.set(els.logo, { opacity: 0 });
    gsap.set(els.rect, { scaleY: 0, transformOrigin: 'top center' });

    const r = rcfg.rect;
    await this._playTimeline((tl) => {
      tl.to(els.rect, { scaleY: 1, duration: r.dropDuration, ease: r.dropEase }, 0);
      tl.set(els.rect, { transformOrigin: 'bottom center' }, r.dropDuration);
      tl.to(els.rect, { scaleY: r.heightPct / 100, duration: r.settleDuration, ease: r.settleEase }, r.dropDuration + r.holdFull);
      // rect が画面全体を覆い切ってから結果・ロゴが登場
      tl.to(els.image, { opacity: 1, duration: rcfg.imageFadeIn, ease: 'power2.out' }, r.dropDuration);
      tl.to(els.logo, { opacity: 1, duration: rcfg.imageFadeIn, ease: 'power2.out' }, r.dropDuration);
    }, token);
    if (token !== this._animToken) return;

    await this._wait(rcfg.dwell * 1000);
    if (token !== this._animToken) return;

    // アウトロ（本番 result.js _outro のミラー）
    const o = rcfg.outro;
    const bandH = window.innerHeight * (r.heightPct / 100);
    await this._playTimeline((tl) => {
      tl.to(els.image, { y: window.innerHeight, duration: o.imageSlideDown, ease: o.imageSlideEase }, 0);
      tl.to(els.rect, { y: bandH, duration: o.imageSlideDown, ease: o.imageSlideEase }, 0);
      tl.to(els.logo, { y: 40, opacity: 0, duration: o.elementDuration, ease: 'power2.in' }, 0);
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

  /**
   * デバイスのカメラを取得して撮影プレビューの video へライブ表示する。
   * 取得は非同期なので、待っている間に別画面へ切り替わったら（トークン不一致）破棄する。
   * webcam はシングルトン（core/webcam.js）でキャッシュされるため再取得は軽い。
   */
  async _attachWebcam() {
    const { overlay, webcam } = this.ctx;
    // 既にこのプレビュー用に表示中なら何もしない（replay 復帰時のちらつき防止）
    if (overlay.video.srcObject && webcam.stream) return;
    const token = ++this._webcamToken;
    overlay.video.classList.add('hidden');
    overlay.videoPlaceholder.classList.remove('hidden');
    try {
      const stream = await webcam.acquire();
      if (token !== this._webcamToken) return; // 取得中に撤収/画面切替（解放は _detachWebcam が担う）
      overlay.video.srcObject = stream;
      overlay.video.classList.remove('hidden');
      overlay.videoPlaceholder.classList.add('hidden');
      await overlay.video.play?.().catch(() => {});
    } catch (err) {
      if (token !== this._webcamToken) return;
      console.warn('[ScreenPreview] webcam unavailable, showing placeholder', err);
      overlay.video.classList.add('hidden');
      overlay.videoPlaceholder.classList.remove('hidden');
    }
  }

  /** 撮影プレビューのカメラを解放して video をデタッチ（取得中の attach も無効化）。 */
  _detachWebcam() {
    const { overlay, webcam } = this.ctx;
    this._webcamToken++; // 進行中の _attachWebcam を無効化
    webcam.release();
    overlay.video.pause?.();
    overlay.video.srcObject = null;
    overlay.video.classList.add('hidden');
    overlay.videoPlaceholder.classList.remove('hidden');
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
    gsap.killTweensOf([overlay.shootCaption, overlay.flash, els.image, els.logo, els.rect]);
  }

  /** プレビューで触ったインラインスタイルを除去して CSS 既定へ戻す */
  _clearProps() {
    const { overlay } = this.ctx;
    const els = overlay.result;
    gsap.set(
      [overlay.screens.shoot, overlay.screens.result, overlay.shootCaption, overlay.flash, els.image, els.logo, els.rect],
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
