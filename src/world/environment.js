import * as THREE from 'three';

/**
 * 白基調ミニマルの環境（背景・ライティング・床のソフトシャドウ受け）。
 * fog / bloom は使わない。
 */
export function createEnvironment(scene) {
  scene.background = new THREE.Color('#f5f5f7');

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
    dispose() {
      scene.remove(hemi, key, fill, rim, shadowFloor);
      shadowFloor.geometry.dispose();
      shadowFloor.material.dispose();
    },
  };
}
