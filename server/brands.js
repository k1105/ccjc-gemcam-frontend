// ブランド設定ローダ。config/brands.json を読み込み、slug 引き / 商品参照画像の解決を行う。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..'); // ccjc/

const config = JSON.parse(
  readFileSync(join(ROOT, 'config', 'brands.json'), 'utf-8')
);

export const brands = config.brands;

export function getBrand(slug) {
  return brands.find((b) => b.slug === slug);
}

// productImage は ccjc ルートからの相対パス。絶対パスに解決して返す。
export function resolveProductImagePath(brand) {
  if (!brand?.productImage) return null;
  return join(ROOT, brand.productImage);
}
