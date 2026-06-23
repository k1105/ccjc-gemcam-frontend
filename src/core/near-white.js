/**
 * near-white（ほぼ白）のピクセルを完全な #ffffff に潰す共通ユーティリティ。
 *
 * 判定は「各チャンネル閾値」方式: R/G/B が全て threshold 以上のピクセルを
 * (255,255,255) にスナップする。アルファは保持する。
 *
 * 依存ゼロ・フレームワーク非依存。別アプリ（ギャラリー等）へそのままコピーして使える。
 * 画像の取得元（同一/クロスオリジン）には関与しない純粋なピクセル処理。
 */

/** 閾値（0-255）。R/G/B が全てこの値以上なら純白に潰す。230 でハードコード。 */
export const DEFAULT_NEAR_WHITE_THRESHOLD = 230;

/**
 * ImageData をその場（in-place）で書き換え、near-white を #ffffff に潰す。
 * @param {ImageData} imageData
 * @param {{ threshold?: number }} [opts]
 * @returns {ImageData} 同じ imageData（チェーン用）
 */
export function crushNearWhiteImageData(imageData, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_NEAR_WHITE_THRESHOLD;
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] >= threshold && data[i + 1] >= threshold && data[i + 2] >= threshold) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      // data[i + 3]（アルファ）はそのまま
    }
  }
  return imageData;
}

/**
 * 画像ソース（Image / Canvas など drawImage 可能なもの）を canvas に描画し、
 * near-white を潰して返す。getImageData を使うため、クロスオリジン画像は
 * CORS 設定済み（かつ crossOrigin 付きでロード済み）でないと例外になる。
 * @param {CanvasImageSource & { naturalWidth?: number, width?: number, naturalHeight?: number, height?: number }} source
 * @param {{ threshold?: number }} [opts]
 * @returns {HTMLCanvasElement}
 */
export function crushNearWhiteToCanvas(source, opts = {}) {
  const w = source.naturalWidth || source.width;
  const h = source.naturalHeight || source.height;
  if (!w || !h) throw new Error('[near-white] ソースのサイズが取得できません');

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);

  const imageData = ctx.getImageData(0, 0, w, h); // taint 時はここで例外
  crushNearWhiteImageData(imageData, opts);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * URL を読み込んで near-white を潰した結果の data URL（PNG）を返す。
 * <img> 系の表示（RESULT 等）向けの便利関数。
 *
 * クロスオリジン画像で CORS 未設定 / 読み込み失敗 / canvas taint の場合は
 * 例外を投げず、フォールバックとして元の URL をそのまま返す（表示を壊さない）。
 *
 * @param {string} url
 * @param {{ threshold?: number, mimeType?: string }} [opts]
 * @returns {Promise<string>} 潰し済みの data URL、または失敗時は元の url
 */
export async function crushNearWhiteUrl(url, opts = {}) {
  if (!url) return url;
  try {
    const img = await loadImageForPixels(url);
    const canvas = crushNearWhiteToCanvas(img, opts);
    return canvas.toDataURL(opts.mimeType ?? 'image/png');
  } catch (err) {
    console.warn('[near-white] 潰し処理に失敗。元画像にフォールバックします:', err?.message ?? err);
    return url;
  }
}

/** ピクセル処理可能な状態で画像を読み込む（クロスオリジンは匿名 CORS で要求）。 */
function loadImageForPixels(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // data: URL 以外（http(s) 等）は CORS 付きで読み、canvas taint を避ける
    if (!url.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
    img.src = url;
  });
}
