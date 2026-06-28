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

// GLB の baseColor が「プリンシプルBSDF 既定の 0.8 グレー」かどうか。
// 既定グレーは透過させると濁るので白へ正規化する対象。
// 作者が意図的に着彩した色（例: 綾鷹の黄土色）はこの判定を外れ、色を保持する。
function isDefaultGrayColor(color) {
  const EPS = 0.02;
  return (
    Math.abs(color.r - 0.8) < EPS &&
    Math.abs(color.g - 0.8) < EPS &&
    Math.abs(color.b - 0.8) < EPS
  );
}

// 1マテリアルへ現在の glassConfig を適用する
function applyGlassConfig(mat) {
  // 既定グレーのガラスのみ白基調のクリアガラスへ正規化する。
  // 着彩済みのガラス（綾鷹の黄土色など）は元の色を活かして透過させる。
  if (isDefaultGrayColor(mat.color)) mat.color.set(glassConfig.tint);
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

// 商品板（MeshStandardMaterial）の見え方設定。色を白(1.0)等倍のままだと受光で
// 白飛びするため、アルベドを下げて全体を一段暗くする。IBL(envMap)の寄与も絞る。
// roughness を少し下げるとスイープ光のハイライトが板の上を流れて陰影が動いて見える。
// choreo.data.scene.brandLight の値を main 起動時に setBrandPlaneConfig() で流し込む。
const brandPlaneConfig = {
  brightness: 0.32, // アルベド（リニア。1=明るい / 小さいほど暗い）
  envMapIntensity: 0.25, // 環境マップ（IBL）の寄与。小さいほど暗く締まる
  roughness: 0.62, // 小さいほど光沢が出てハイライトが動いて見える
  normalScale: 1.8, // ノーマルマップの凹凸の強さ
};

// choreo.data.scene.brandLight（plane* キー）→ brandPlaneConfig へ取り込む
export function setBrandPlaneConfig(cfg) {
  if (!cfg) return;
  if (cfg.planeBrightness != null) brandPlaneConfig.brightness = cfg.planeBrightness;
  if (cfg.planeEnvIntensity != null) brandPlaneConfig.envMapIntensity = cfg.planeEnvIntensity;
  if (cfg.planeRoughness != null) brandPlaneConfig.roughness = cfg.planeRoughness;
  if (cfg.planeNormalScale != null) brandPlaneConfig.normalScale = cfg.planeNormalScale;
}

// 1マテリアルへ現在の brandPlaneConfig を適用する
function applyBrandPlaneConfig(mat) {
  mat.color.setScalar(brandPlaneConfig.brightness); // リニア空間で直接アルベドを下げる
  mat.envMapIntensity = brandPlaneConfig.envMapIntensity;
  mat.roughness = brandPlaneConfig.roughness;
  mat.normalScale?.set(brandPlaneConfig.normalScale, brandPlaneConfig.normalScale);
  mat.needsUpdate = true;
}

/**
 * シーン配下の全商品板マテリアルへ brandPlaneConfig を再適用する。
 * エディタからのライブ調整で使う（既に生成済みの板へ反映）。
 */
export function refreshBrandPlaneMaterials(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m?.userData?.isBrandPlane) applyBrandPlaneConfig(m);
  });
}

export async function createBottlePlane(brand) {
  // brands.json の productImage は "public/brands/xxx.png"。public 配下は Vite がルート配信する
  const imgUrl = '/' + brand.productImage.replace(/^\/?public\//, '');
  try {
    const tex = await texLoader.loadAsync(imgUrl);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;

    // 背景が不透明な商品画像（例: Aquarius / Ayataka）には、別途用意した
    // シルエットのアルファマップ "alpha/{name}-alpha.png" で切り抜きをかける。
    // 用意が無いブランドは 404 になるので、その場合は黙って従来どおり map のαに任せる。
    const alphaMap = await loadAlphaMap(imgUrl);
    // 正方形のノーマルマップ "normal/{name}.png"。あればライティングで凹凸を出す。
    const normalMap = await loadNormalMap(imgUrl);

    const img = tex.image;
    const aspect = img.width > 0 && img.height > 0 ? img.width / img.height : 1;
    // 画像板は常に標準高さで生成し、ブランドごとのサイズ差は BottleRack が
    // choreo.data.select.rack.overrides[slug].scale で個別に補正する（エディタで調整可能）。
    const height = TARGET_HEIGHT;
    const width = height * aspect;

    // ノーマルマップは正方形なので、縦長の板へは「高さ合わせ・中央寄せ」で貼る。
    // v（高さ）は全域 0..1、u（幅）は板のアスペクト比ぶんだけ中央から切り出す。
    if (normalMap) {
      normalMap.wrapS = THREE.ClampToEdgeWrapping;
      normalMap.wrapT = THREE.ClampToEdgeWrapping;
      normalMap.repeat.set(aspect, 1);
      normalMap.offset.set((1 - aspect) / 2, 0);
      normalMap.needsUpdate = true;
    }

    const geo = new THREE.PlaneGeometry(width, height);
    geo.translate(0, height / 2, 0); // 原点を下端中心へ
    // 透過PNG前提: 完全透明な背景は alphaTest で破棄し、半透明エッジは blend で残す。
    // 回さない（常に正面）ので片面描画でよい。
    // ノーマルマップを効かせるためライティングを受ける MeshStandardMaterial を使う
    // （色はテクスチャそのままに見えるよう roughness=1 / metalness=0）。
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      alphaMap,
      normalMap,
      transparent: true,
      alphaTest: 0.1,
      side: THREE.FrontSide,
      metalness: 0,
    });
    mat.userData.isBrandPlane = true; // refreshBrandPlaneMaterials の対象印
    applyBrandPlaneConfig(mat); // 明るさ/roughness/envMap/normalScale を適用
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
 * 商品画像 URL "{dir}/{name}.{ext}" の {dir} と {name} を取り出す。
 */
function splitBrandImage(imgUrl) {
  const slash = imgUrl.lastIndexOf('/');
  const dir = imgUrl.slice(0, slash); // 例: "/brands"
  const base = imgUrl.slice(slash + 1).replace(/\.[^.]+$/, ''); // 例: "coca-cola"
  return { dir, base };
}

/**
 * 商品画像 URL から "{dir}/alpha/{name}-alpha.png" を導出してアルファマップを読む。
 * alphaMap は輝度（白=不透明 / 黒=透明）を α として使うデータテクスチャなので、
 * sRGB ではなくリニア（NoColorSpace）で扱う。未用意のブランドは 404 → null。
 */
async function loadAlphaMap(imgUrl) {
  const { dir, base } = splitBrandImage(imgUrl);
  const alphaUrl = `${dir}/alpha/${base}-alpha.png`;
  try {
    const alpha = await texLoader.loadAsync(alphaUrl);
    alpha.colorSpace = THREE.NoColorSpace;
    alpha.anisotropy = 4;
    return alpha;
  } catch {
    return null;
  }
}

/**
 * 商品画像 URL から "{dir}/normal/{name}.png" を導出してノーマルマップを読む。
 * 法線データはリニア（NoColorSpace）で扱う。未用意のブランドは 404 → null。
 */
async function loadNormalMap(imgUrl) {
  const { dir, base } = splitBrandImage(imgUrl);
  const normalUrl = `${dir}/normal/${base}.png`;
  try {
    const normal = await texLoader.loadAsync(normalUrl);
    normal.colorSpace = THREE.NoColorSpace;
    normal.anisotropy = 4;
    return normal;
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
