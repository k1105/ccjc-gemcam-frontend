import gsap from 'gsap';
import { Sequence } from '../core/sequence-manager.js';
import { TimerBag } from '../core/resources.js';
import { playSfx } from '../core/audio.js';
import { normalizeRegion } from '../core/region.js';

/**
 * SHOOT: 3Dシーンからカメラ映像へクロスフェードでシームレスに切り替わる。
 * 「写真を撮ります」キャプションを表示し、Enter で 3/2/1 カウントダウン→撮影。
 * Webカメラは SELECT の沈下アニメ中にウォームアップ済み（core/webcam.js）。
 *
 * 撮影時に2枚キャプチャする:
 *  - apiSnapshot: 生成APIへ送るインプット。表示フレームを生成領域（shoot.region）で
 *    切り出したもの（ミラー済み）。領域はデバッグエディタの撮影タブで編集・可視化できる。
 *  - displaySnapshot: 画面アスペクト・cover crop・ミラー一致（GENERATE の写真平面／
 *    パーティクル演出用。こちらは全画面フレームをそのまま使う）
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
    overlay.hideShootRegion(); // 生成領域ボックスはデバッグ専用。本番では出さない
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

    // フレームの取り込み（drawImage のみ＝高速）。重い PNG エンコードやカメラ解放は
    // ここでは行わず、白フラッシュ裏（onWhite）へ回してシャッターの反応を即時にする。
    const frames = this._grabFrames(overlay);
    // シャッター音と白フラッシュを即発火（キー操作に即追従。ブロッキング処理を挟まない）
    playSfx(this.ctx.choreo, 'shutter');

    // シャッターの白フラッシュ。白くなりきった瞬間に GENERATE へ切り替え、
    // フラッシュが抜けると3D空間の写真平面が現れる（シームレスなハンドオフ）
    overlay.flashWhite({
      inDur: 0.07,
      hold: cfg.postSnapDelay,
      outDur: 0.5,
      onWhite: () => {
        // 画面が完全に白で覆われた裏で重い処理を行う（ジャンクは白に隠れて見えない）:
        // PNG エンコード（同期・数十ms）と Web カメラ解放（track.stop）。
        const apiSnapshotDataUrl = frames.apiCanvas.toDataURL('image/png');
        this.ctx.webcam.release();
        overlay.video.pause();
        overlay.video.srcObject = null;
        manager.go('generate', {
          brand: this.brand,
          apiSnapshotDataUrl,
          displayCanvas: frames.dispCanvas,
        });
      },
    });
  }

  /**
   * video から表示用（画面アスペクト・全画面）と API用（生成領域でクロップ）の2枚を
   * canvas へ描き込む（drawImage のみ）。PNG エンコード等の重い処理は呼び出し側が
   * 白フラッシュ裏で行う。
   *
   * apiCanvas は dispCanvas（＝画面に出ているミラー済み cover フレーム）から
   * 生成領域 region を切り出して作る。dispCanvas は画面表示そのものなので、
   * 領域の正規化矩形がデバッグの可視化ボックスとそのまま一致する。
   * @returns {{apiCanvas: HTMLCanvasElement, dispCanvas: HTMLCanvasElement}}
   */
  _grabFrames(overlay) {
    const video = overlay.video;
    const hasVideo = this.ctx.webcam.stream && video.readyState >= video.HAVE_CURRENT_DATA;

    // --- 表示用 画面アスペクト（ミラー、object-fit:cover と同一クロップ）。
    //     パーティクル演出・写真平面はこの全画面フレームを使う。 ---
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

    // --- 生成API用: 表示フレームを生成領域で切り出した画像（＝送信インプット） ---
    const region = normalizeRegion(this.ctx.choreo.data.shoot.region);
    const sx = Math.round(region.x * dispW);
    const sy = Math.round(region.y * dispH);
    const sw = Math.max(1, Math.round(region.w * dispW));
    const sh = Math.max(1, Math.round(region.h * dispH));
    const apiCanvas = document.createElement('canvas');
    apiCanvas.width = sw;
    apiCanvas.height = sh;
    apiCanvas.getContext('2d').drawImage(dispCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

    return { apiCanvas, dispCanvas };
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
