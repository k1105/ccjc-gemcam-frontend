import gsap from 'gsap';
import { Sequence } from '../core/sequence-manager.js';
import { TimerBag } from '../core/resources.js';
import { playSfx } from '../core/audio.js';

/**
 * SHOOT: 3Dシーンからカメラ映像へクロスフェードでシームレスに切り替わる。
 * 「写真を撮ります」キャプションを表示し、Enter で 3/2/1 カウントダウン→撮影。
 * Webカメラは SELECT の沈下アニメ中にウォームアップ済み（core/webcam.js）。
 *
 * 撮影時に2枚キャプチャする:
 *  - apiSnapshot: 640x480（バックエンド契約用、ミラー済み）
 *  - displaySnapshot: 画面アスペクト・cover crop・ミラー一致（GENERATE の写真平面用）
 */
export class ShootSequence extends Sequence {
  async enter(payload = {}) {
    const { overlay, keyboard, manager, choreo, webcam } = this.ctx;
    this.bag = new TimerBag();
    this.brand = payload.brand;
    this.counting = false;

    const screen = overlay.screens.shoot;
    overlay.hideAll();
    overlay.hideCountdown();
    // 色帯ワイプ経由なら帯が画面を覆っている裏で即表示（帯が捲れてカメラが現れる）
    gsap.set(screen, { opacity: payload.fromWipe ? 1 : 0 });
    gsap.set(overlay.shootCaption, { opacity: 0 });
    overlay.show('shoot');

    // 退場時の後始末（ESC含む全経路）
    this.bag.add(() => {
      webcam.release();
      overlay.video.pause();
      overlay.video.srcObject = null;
      gsap.killTweensOf([screen, overlay.shootCaption]);
      gsap.set(screen, { clearProps: 'opacity' });
    });

    // Webカメラ（SELECT でウォームアップ済みなら即時）
    try {
      const stream = await webcam.acquire();
      if (this.bag.disposed) return;
      overlay.video.classList.remove('hidden');
      overlay.videoPlaceholder.classList.add('hidden');
      overlay.video.srcObject = stream;
      await waitForVideoReady(overlay.video, 1500);
      if (this.bag.disposed) return;
    } catch (err) {
      console.warn('[Shoot] webcam unavailable, fallback to simulated snapshot', err);
      overlay.video.classList.add('hidden');
      overlay.videoPlaceholder.classList.remove('hidden');
    }

    // 色帯ワイプ経由なら、カメラ初回フレーム準備が整ったことを SELECT 側へ通知する。
    // これにより帯は“覆われている間”に重いデコードを終えてから流れ、流れ中のジャンクを避ける。
    payload.onReady?.();

    // 3Dシーン → カメラ映像へクロスフェード（シームレスな切り替え）。
    // 色帯ワイプ経由のときは帯のハンドオフで切り替わるのでフェードは省略。
    if (!payload.fromWipe) {
      this.bag.to(screen, { opacity: 1, duration: 0.7, ease: 'power2.inOut' });
    }
    this.bag.to(overlay.shootCaption, { opacity: 1, duration: 0.6, delay: 0.45 });

    keyboard.setHandler((key) => {
      if (key === 'Enter' && !this.counting) {
        this._startCountdown(choreo.data.shoot, manager, overlay);
      }
    });
  }

  async _startCountdown(cfg, manager, overlay) {
    this.counting = true;
    const intervalMs = cfg.countdownInterval * 1000;

    // キャプションを引っ込めてカウントダウン
    this.bag.to(overlay.shootCaption, { opacity: 0, duration: 0.3 });

    for (let n = 3; n >= 1; n--) {
      overlay.showCountdownTick(n);
      playSfx(this.ctx.choreo, 'countdown');
      await this.bag.delay(intervalMs);
      if (this.bag.disposed) return;
    }
    overlay.hideCountdown();

    const snapshots = this._capture(overlay);
    playSfx(this.ctx.choreo, 'shutter');
    this.ctx.webcam.release();
    overlay.video.pause();
    overlay.video.srcObject = null;

    // シャッターの白フラッシュ。白くなりきった瞬間に GENERATE へ切り替え、
    // フラッシュが抜けると3D空間の写真平面が現れる（シームレスなハンドオフ）
    overlay.flashWhite({
      inDur: 0.07,
      hold: cfg.postSnapDelay,
      outDur: 0.5,
      onWhite: () => manager.go('generate', { brand: this.brand, ...snapshots }),
    });
  }

  /** video から API用 640x480 と 表示用（画面アスペクト）を同時にキャプチャ */
  _capture(overlay) {
    const video = overlay.video;
    const hasVideo = this.ctx.webcam.stream && video.readyState >= video.HAVE_CURRENT_DATA;

    // --- API用 640x480（ミラー） ---
    const apiCanvas = document.createElement('canvas');
    apiCanvas.width = 640;
    apiCanvas.height = 480;
    const apiCtx = apiCanvas.getContext('2d');
    if (hasVideo) {
      drawCover(apiCtx, video, 640, 480, true);
    } else {
      drawPlaceholder(apiCtx, 640, 480);
    }

    // --- 表示用 画面アスペクト（ミラー、object-fit:cover と同一クロップ） ---
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dispW = 1280;
    const dispH = Math.round((dispW * vh) / vw);
    const dispCanvas = document.createElement('canvas');
    dispCanvas.width = dispW;
    dispCanvas.height = dispH;
    const dispCtx = dispCanvas.getContext('2d');
    if (hasVideo) {
      drawCover(dispCtx, video, dispW, dispH, true);
    } else {
      drawPlaceholder(dispCtx, dispW, dispH);
    }

    return {
      apiSnapshotDataUrl: apiCanvas.toDataURL('image/png'),
      displayCanvas: dispCanvas,
    };
  }

  async exit() {
    const { keyboard, overlay } = this.ctx;
    keyboard.clearHandler();
    this.bag.disposeAll(); // webcam解放・videoデタッチ・opacity復帰はbagのcleanupで実施
    overlay.hideCountdown();
    overlay.hide('shoot');
  }
}

/** video のフレームが描画可能になるまで待つ（タイムアウト付き） */
function waitForVideoReady(video, timeoutMs) {
  if (video.readyState >= video.HAVE_CURRENT_DATA) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('loadeddata', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    video.addEventListener('loadeddata', done);
  });
}

/** object-fit: cover 相当のクロップで video を canvas に描画（mirror オプション付き） */
function drawCover(ctx, video, dw, dh, mirror) {
  const sw = video.videoWidth;
  const sh = video.videoHeight;
  const sourceAspect = sw / sh;
  const destAspect = dw / dh;

  let cropW = sw;
  let cropH = sh;
  if (sourceAspect > destAspect) {
    cropW = sh * destAspect;
  } else {
    cropH = sw / destAspect;
  }
  const sx = (sw - cropW) / 2;
  const sy = (sh - cropH) / 2;

  ctx.save();
  if (mirror) {
    ctx.translate(dw, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, dw, dh);
  ctx.restore();
}

function drawPlaceholder(ctx, w, h) {
  ctx.fillStyle = '#1a1a1c';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#9a9aa0';
  ctx.font = `500 ${Math.round(w / 28)}px Outfit, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('SIMULATED SNAPSHOT', w / 2, h / 2);
}
