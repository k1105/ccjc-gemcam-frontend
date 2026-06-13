import brandsConfig from '../../config/brands.json';

/**
 * config/brands.json をロードし、数字キー（'1'..'9','0'）→ ブランドの対応を構築する。
 * uiKey が明示されたブランドを優先し、残りは配列順に空いている数字へ割り当てる。
 * 表示順（ラックの並び）は brands.json の配列順。
 */
const DIGIT_ORDER = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

export class Brands {
  constructor() {
    this.list = brandsConfig.brands.slice(0, 10);
    this.byKey = new Map();
    this.bySlug = new Map();

    const unassigned = [];
    for (const brand of this.list) {
      this.bySlug.set(brand.slug, brand);
      if (brand.uiKey && DIGIT_ORDER.includes(brand.uiKey) && !this.byKey.has(brand.uiKey)) {
        this.byKey.set(brand.uiKey, brand);
      } else {
        unassigned.push(brand);
      }
    }
    const freeDigits = DIGIT_ORDER.filter((d) => !this.byKey.has(d));
    unassigned.forEach((brand, i) => {
      if (freeDigits[i]) this.byKey.set(freeDigits[i], brand);
    });

    // ラック表示等で使う「ブランド→割当キー」の逆引き
    this.keyBySlug = new Map();
    for (const [key, brand] of this.byKey) {
      this.keyBySlug.set(brand.slug, key);
    }
  }

  getByKey(key) {
    return this.byKey.get(key) ?? null;
  }

  getBySlug(slug) {
    return this.bySlug.get(slug) ?? null;
  }

  indexOf(slug) {
    return this.list.findIndex((b) => b.slug === slug);
  }
}
