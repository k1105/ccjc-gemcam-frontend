/**
 * 生成領域（region）= 画面に対する正規化矩形 { x, y, w, h }（各 0..1）。
 * 撮影画面で「生成API へ送るインプット」を画面のどの矩形に絞るかを表す。
 * 値を [0,1] に丸め、画面外へはみ出さないよう幅・高さをクランプして返す。
 */
export function normalizeRegion(region) {
  const clamp01 = (v) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
  const x = clamp01(region?.x ?? 0);
  const y = clamp01(region?.y ?? 0);
  const w = clamp01(region?.w ?? 1);
  const h = clamp01(region?.h ?? 1);
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
}
