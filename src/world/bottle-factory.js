import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

/**
 * ブランドごとのボトル3Dモデルを /models/{slug}.glb からロードする。
 * slug は config/brands.json と public/models/ のファイル名で一致させる規約。
 *
 * 返り値: THREE.Group（原点=ボトル底中心、高さ ~0.8 ワールド単位）
 */

// Draco 圧縮された GLB（例: ilohas.glb）を展開するためのデコーダ。
// デコーダ本体は public/draco/ に置き、Vite がルート配信する。
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('/draco/');

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

// ガラス（transmission）マテリアルの見え方を一元管理する設定。
// GLB の baseColor は 0.8 グレー固定で出てくる（プリンシプルBSDF 既定）ため、
// 透明部分がグレーに濁る。ここでロード時に白基調のクリアガラスへ正規化する。
// choreo.data.scene.glass の値を main 起動時に setGlassConfig() で流し込む。
const glassConfig = {
  tint: '#ffffff',
  roughness: 0.05,
  ior: 1.5,
  transmission: 1.0,
  thickness: 0.3,
  envMapIntensity: 1.5,
};

export function setGlassConfig(cfg) {
  if (cfg) Object.assign(glassConfig, cfg);
}

// transmission を持つ（=ガラスとして出力された）物理マテリアルか
function isGlassMaterial(mat) {
  return mat && mat.isMeshPhysicalMaterial && mat.transmission > 0;
}

// 1マテリアルへ現在の glassConfig を適用する
function applyGlassConfig(mat) {
  mat.color.set(glassConfig.tint);
  mat.transmission = glassConfig.transmission;
  mat.roughness = glassConfig.roughness;
  mat.metalness = 0;
  mat.ior = glassConfig.ior;
  mat.thickness = glassConfig.thickness;
  mat.envMapIntensity = glassConfig.envMapIntensity;
  // 透過は深度書き込みすると背後が抜けないことがあるため、薄ガラス前提で素直に透過させる
  mat.transparent = true;
  mat.needsUpdate = true;
}

/**
 * シーン/グループ配下の全ガラスマテリアルへ glassConfig を再適用する。
 * エディタからのライブ調整で使う（既にロード済みのボトルへ反映）。
 */
export function refreshGlassMaterials(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (isGlassMaterial(m)) applyGlassConfig(m);
  });
}

export async function createBottle(brand) {
  const glbUrl = `/models/${brand.slug}.glb`;
  try {
    const gltf = await gltfLoader.loadAsync(glbUrl);
    const model = gltf.scene;
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (isGlassMaterial(m)) applyGlassConfig(m);
      }
    });
    return normalizeGlbModel(model);
  } catch (err) {
    // モデル欠落はラック全体を巻き込まず、該当ブランドのみ空表示にする
    console.error(`[bottle-factory] GLBロード失敗: ${glbUrl}`, err);
    return new THREE.Group();
  }
}

/**
 * ブランドの商品画像（public/brands/*）を板ポリゴンとして生成する。
 * createBottle と同じ規約（原点=底中心、高さ TARGET_HEIGHT）に揃えるので、
 * BottleRack のレイアウト・揺れ・沈下アニメーションがそのまま流用できる。
 *
 * 返り値: THREE.Group（原点=画像下端中心）
 */
const texLoader = new THREE.TextureLoader();

export async function createBottlePlane(brand) {
  // brands.json の productImage は "public/brands/xxx.png"。public 配下は Vite がルート配信する
  const imgUrl = '/' + brand.productImage.replace(/^\/?public\//, '');
  try {
    const tex = await texLoader.loadAsync(imgUrl);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;

    // 背景が不透明な商品画像（例: Aquarius / Ayataka）には、別途用意した
    // シルエットのアルファマップ "{name}-alpha.png" で切り抜きをかける。
    // 用意が無いブランドは 404 になるので、その場合は黙って従来どおり map のαに任せる。
    const alphaMap = await loadAlphaMap(imgUrl);

    const img = tex.image;
    const aspect = img.width > 0 && img.height > 0 ? img.width / img.height : 1;
    // 画像板は常に標準高さで生成し、ブランドごとのサイズ差は BottleRack が
    // choreo.data.select.rack.overrides[slug].scale で個別に補正する（エディタで調整可能）。
    const height = TARGET_HEIGHT;
    const width = height * aspect;

    const geo = new THREE.PlaneGeometry(width, height);
    geo.translate(0, height / 2, 0); // 原点を下端中心へ
    // 透過PNG前提: 完全透明な背景は alphaTest で破棄し、半透明エッジは blend で残す。
    // 回さない（常に正面）ので片面描画でよい。
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      alphaMap,
      transparent: true,
      alphaTest: 0.1,
      side: THREE.FrontSide,
    });
    const mesh = new THREE.Mesh(geo, mat);

    const root = new THREE.Group();
    root.add(mesh);
    return root;
  } catch (err) {
    // 画像欠落はラック全体を巻き込まず、該当ブランドのみ空表示にする
    console.error(`[bottle-factory] 画像ロード失敗: ${imgUrl}`, err);
    return new THREE.Group();
  }
}

/**
 * 商品画像 URL から "{name}-alpha.png" を導出してアルファマップを読む。
 * alphaMap は輝度（白=不透明 / 黒=透明）を α として使うデータテクスチャなので、
 * sRGB ではなくリニア（NoColorSpace）で扱う。未用意のブランドは 404 → null。
 */
async function loadAlphaMap(imgUrl) {
  const alphaUrl = imgUrl.replace(/\.[^./]+$/, '-alpha.png');
  try {
    const alpha = await texLoader.loadAsync(alphaUrl);
    alpha.colorSpace = THREE.NoColorSpace;
    alpha.anisotropy = 4;
    return alpha;
  } catch {
    return null;
  }
}

// GLB は出所によって原点・サイズがまちまちなので、
// 共通規約（原点=底中心、高さ TARGET_HEIGHT）に揃える
const TARGET_HEIGHT = 0.8;

function normalizeGlbModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = size.y > 0 ? TARGET_HEIGHT / size.y : 1;
  model.scale.setScalar(scale);
  model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  const root = new THREE.Group();
  root.add(model);
  return root;
}
