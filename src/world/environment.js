import * as THREE from 'three';

/**
 * 白基調ミニマルの環境（背景・ライティング・床のソフトシャドウ受け）。
 * bloom は使わない。距離フォグは背景色に溶け込ませる薄掛けのみ。
 */
// 背景＝フォグ色を一致させると、奥のオブジェクトが背景に自然に霞んで消える
const BG_COLOR = '#f5f5f7';
// fog 未指定時のフォールバック（距離フォグ: near 手前は素通し / far で完全に背景色）
const DEFAULT_FOG = { enabled: true, near: 3.5, far: 16 };

export function createEnvironment(scene, fogCfg = DEFAULT_FOG) {
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
    dispose() {
      scene.fog = null;
      scene.remove(hemi, key, fill, rim, shadowFloor);
      shadowFloor.geometry.dispose();
      shadowFloor.material.dispose();
    },
  };
}
