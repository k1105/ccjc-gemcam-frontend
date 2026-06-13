import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * ブランドごとのボトル3Dモデルを /models/{slug}.glb からロードする。
 * slug は config/brands.json と public/models/ のファイル名で一致させる規約。
 *
 * 返り値: THREE.Group（原点=ボトル底中心、高さ ~0.8 ワールド単位）
 */

const gltfLoader = new GLTFLoader();

export async function createBottle(brand) {
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
