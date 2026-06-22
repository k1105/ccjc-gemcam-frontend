import * as THREE from 'three';

/**
 * 白基調ミニマルの環境（背景・ライティング・床のソフトシャドウ受け）。
 * bloom は使わない。距離フォグは背景色に溶け込ませる薄掛けのみ。
 */
// 背景＝フォグ色を一致させると、奥のオブジェクトが背景に自然に霞んで消える
const BG_COLOR = '#f5f5f7';
// fog 未指定時のフォールバック（距離フォグ: near 手前は素通し / far で完全に背景色）
const DEFAULT_FOG = { enabled: true, near: 3.5, far: 16 };
// sky 未指定時のフォールバック（天球なし＝単色背景）
const DEFAULT_SKY = { enabled: false, image: '', intensity: 1.0, blurriness: 0.0 };

const texLoader = new THREE.TextureLoader();

export function createEnvironment(scene, fogCfg = DEFAULT_FOG, skyCfg = DEFAULT_SKY) {
  scene.background = new THREE.Color(BG_COLOR);

  // 距離フォグ。色は常に背景色に固定し、有効/near/far だけ choreo から制御する。
  const fog = new THREE.Fog(BG_COLOR, fogCfg.near, fogCfg.far);
  // applyFog: choreo の値を受けて scene.fog を出し入れ・更新する（エディタのライブ調整用）
  const applyFog = (cfg) => {
    fog.near = cfg.near;
    fog.far = cfg.far;
    scene.fog = cfg.enabled ? fog : null;
  };
  applyFog(fogCfg);

  // --- 天球（equirectangular 背景）。任意画像を scene.background に貼ってドーム状に描画する。
  // scene.environment（RoomEnvironment＝ガラスの映り込み用 IBL）はそのまま残し、見た目の背景だけ差し替える。
  let bgTexture = null; // 現在背景に使っているテクスチャ（dispose 管理）
  let bgLoadToken = 0; // 非同期ロードの競合防止（後発ロードが先発を必ず勝つ）

  // fog 色を画像の平均色へ合わせる。fog 色は既定で背景色（白）固定のため、天球を出すと
  // 遠方オブジェクトが白いフォグに溶けて天球の上で白く浮く。平均色に寄せて天球の地色へ馴染ませる。
  const matchFogToImage = (img) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1; // 1px へ縮小＝面積平均でおおよその平均色を得る
      const cx = canvas.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0, 1, 1);
      const [r, g, b] = cx.getImageData(0, 0, 1, 1).data;
      // キャンバスのピクセルは sRGB。SRGBColorSpace 指定で内部表現へ正しく変換する。
      fog.color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
    } catch (err) {
      console.warn('[Environment] 天球の平均色取得に失敗 — fog 色は据え置き', err);
    }
  };

  // applySky: choreo の sky 設定（または overrideUrl）を受けて背景を出し入れする。
  // overrideUrl を渡すとデバッガからの任意ファイル検証用に cfg.image を無視してそのURLを読む。
  const applySky = (cfg = DEFAULT_SKY, overrideUrl = null) => {
    const url = overrideUrl ?? (cfg.enabled ? cfg.image : '');
    // 明るさ/ぼかしは即時反映（テクスチャの有無に依らない）
    scene.backgroundIntensity = cfg.intensity ?? 1;
    scene.backgroundBlurriness = cfg.blurriness ?? 0;

    const token = ++bgLoadToken;
    if (!url) {
      // 天球なし → 単色背景へ戻す。古いテクスチャは破棄。fog 色も背景色（白）へ戻す。
      scene.background = new THREE.Color(BG_COLOR);
      fog.color.set(BG_COLOR);
      if (bgTexture) { bgTexture.dispose(); bgTexture = null; }
      return;
    }
    texLoader.load(
      url,
      (tex) => {
        if (token !== bgLoadToken) { tex.dispose(); return; } // 後発ロードに追い越された
        tex.mapping = THREE.EquirectangularReflectionMapping;
        tex.colorSpace = THREE.SRGBColorSpace;
        if (bgTexture) bgTexture.dispose();
        bgTexture = tex;
        scene.background = tex;
        matchFogToImage(tex.image); // 遠方オブジェクトを天球の地色へ溶かす
      },
      undefined,
      (err) => console.error('[Environment] 天球画像の読み込みに失敗', url, err)
    );
  };
  applySky(skyCfg);

  const hemi = new THREE.HemisphereLight(0xffffff, 0xe8e8ec, 1.1);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 1.9);
  key.position.set(3.5, 6, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -6;
  key.shadow.camera.right = 6;
  key.shadow.camera.top = 6;
  key.shadow.camera.bottom = -6;
  key.shadow.bias = -0.0004;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-4, 2.5, 3);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 0.5);
  rim.position.set(0, 4, -6);
  scene.add(rim);

  // 影だけを受ける白床（背景と同化し、ボトルの接地感のみ与える）
  const shadowFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    // depthWrite を切る: 影だけ受ける床なので深度は書かない。
    // これを書くと、SELECTで沈むボトルが床ライン（≒足元 y=-0.45）で
    // 深度オクルージョンされ、画面下端まで届かず見切れてしまう。
    new THREE.ShadowMaterial({ opacity: 0.12, depthWrite: false })
  );
  shadowFloor.rotation.x = -Math.PI / 2;
  shadowFloor.position.y = -0.45;
  shadowFloor.receiveShadow = true;
  scene.add(shadowFloor);

  return {
    lights: { hemi, key, fill, rim },
    shadowFloor,
    applyFog,
    applySky,
    dispose() {
      scene.fog = null;
      scene.remove(hemi, key, fill, rim, shadowFloor);
      shadowFloor.geometry.dispose();
      shadowFloor.material.dispose();
      bgLoadToken++; // 進行中ロードのコールバックを無効化
      if (bgTexture) { bgTexture.dispose(); bgTexture = null; }
      scene.background = new THREE.Color(BG_COLOR);
    },
  };
}
