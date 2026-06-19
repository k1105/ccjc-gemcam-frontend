import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

/**
 * ブランドごとのボトル3Dモデルを /models/{slug}.glb からロードする。
 * slug は config/brands.json と public/models/ のファイル名で一致させる規約。
 *
 * 例外的に FBX を使うブランドは FBX_MODELS に slug → ファイル名 を登録する。
 *
 * 返り値: THREE.Group（原点=ボトル底中心、高さ ~0.8 ワールド単位）
 */

// GLB ではなく FBX を使うブランド（生成中の表示モデル差し替え用）
const FBX_MODELS = {
  ilohas: 'ilohas.fbx',
};

const gltfLoader = new GLTFLoader();
const fbxLoader = new FBXLoader();

export async function createBottle(brand) {
  const fbxName = FBX_MODELS[brand.slug];
  if (fbxName) {
    const fbxUrl = `/models/${fbxName}`;
    try {
      // FBXLoader.loadAsync は Group を直接返す（GLTF と違い .scene は無い）
      const model = await fbxLoader.loadAsync(fbxUrl);
      model.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = false;
        }
      });
      return normalizeGlbModel(model);
    } catch (err) {
      console.error(`[bottle-factory] FBXロード失敗: ${fbxUrl}`, err);
      return new THREE.Group();
    }
  }

  const glbUrl = `/models/${brand.slug}.glb`;
  try {
    const gltf = await gltfLoader.loadAsync(glbUrl);
    const model = gltf.scene;
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
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
    // Sprite だけ元画像のボトルが大きく写っており、他と高さが揃わないので 0.85 倍に縮める
    const height = TARGET_HEIGHT * (HEIGHT_SCALE[brand.slug] ?? 1);
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

// 商品画像ごとのボトルの写り方の差を吸収する、ブランド別の高さ補正（未指定は 1）
const HEIGHT_SCALE = {
  sprite: 0.85,
};

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
