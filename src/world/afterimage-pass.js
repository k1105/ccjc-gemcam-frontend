import * as THREE from 'three';
import { Pass } from 'postprocessing';

// pmndrs postprocessing には残像/モーションブラーのビルトインが無い（Issue #248 で要望止まり）ため、
// three.js 標準 AfterimagePass のフィードバック合成を pmndrs の Pass 基底へ移植した軽量版。
// 前フレームの蓄積（rtOld）を damp で減衰させ、現フレーム入力との max を取って尾を引かせる。
//
// パイプライン末尾（DOF/AA の後）に置く前提。深度は不要で色だけを扱う。

// フルスクリーン三角形の頂点規約は pmndrs common.vert に合わせる
// （position は NDC、vUv は position から導出）。
const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

// 蓄積合成: 古い絵を damp 倍して減衰（暗部 <0.1 は step で切り捨て＝無限残像を防ぐ）、
// 現フレームとチャンネルごとの max を取る。
const COMP_FRAG = /* glsl */ `
uniform sampler2D tOld;
uniform sampler2D tNew;
uniform float damp;
varying vec2 vUv;
void main() {
  vec4 texelOld = texture2D(tOld, vUv);
  vec4 texelNew = texture2D(tNew, vUv);
  float lum = max(max(texelOld.r, texelOld.g), texelOld.b);
  texelOld *= damp * step(0.1, lum);
  gl_FragColor = max(texelNew, texelOld);
}
`;

const COPY_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tDiffuse, vUv);
}
`;

export class AfterimagePass extends Pass {
  constructor(damp = 0.85) {
    super('AfterimagePass');

    this.compMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tOld: { value: null },
        tNew: { value: null },
        damp: { value: damp },
      },
      vertexShader: VERT,
      fragmentShader: COMP_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.copyMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: VERT,
      fragmentShader: COPY_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    // 残像の蓄積用 ping-pong バッファ。composer 本体（HalfFloat）に合わせてバンディングを防ぐ。
    const rtOpts = {
      depthBuffer: false,
      stencilBuffer: false,
      type: THREE.HalfFloatType,
    };
    this.rtOld = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    this.rtComp = new THREE.WebGLRenderTarget(1, 1, rtOpts);

    // 初回フレームは rtOld が未初期化なので黒クリアしてから合成する
    this._needsClear = true;

    // Pass の screen メッシュは fullscreenMaterial を入れた瞬間に生成される
    this.fullscreenMaterial = this.copyMaterial;
  }

  get damp() {
    return this.compMaterial.uniforms.damp.value;
  }

  set damp(value) {
    this.compMaterial.uniforms.damp.value = value;
  }

  render(renderer, inputBuffer, outputBuffer) {
    if (this._needsClear) {
      const prevClear = renderer.getClearColor(new THREE.Color());
      const prevAlpha = renderer.getClearAlpha();
      renderer.setRenderTarget(this.rtOld);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.setClearColor(prevClear, prevAlpha);
      this._needsClear = false;
    }

    // 1) 蓄積合成: max(現フレーム, damp*前蓄積) を rtComp へ
    this.compMaterial.uniforms.tOld.value = this.rtOld.texture;
    this.compMaterial.uniforms.tNew.value = inputBuffer.texture;
    this.fullscreenMaterial = this.compMaterial;
    renderer.setRenderTarget(this.rtComp);
    renderer.render(this.scene, this.camera);

    // 2) 合成結果を出力（最終パスなら画面へ）
    this.copyMaterial.uniforms.tDiffuse.value = this.rtComp.texture;
    this.fullscreenMaterial = this.copyMaterial;
    renderer.setRenderTarget(this.renderToScreen ? null : outputBuffer);
    renderer.render(this.scene, this.camera);

    // 3) ping-pong スワップ（今回の合成が次フレームの「前蓄積」になる）
    const tmp = this.rtOld;
    this.rtOld = this.rtComp;
    this.rtComp = tmp;
  }

  setSize(width, height) {
    this.rtOld.setSize(width, height);
    this.rtComp.setSize(width, height);
    this._needsClear = true;
  }

  dispose() {
    this.rtOld.dispose();
    this.rtComp.dispose();
    this.compMaterial.dispose();
    this.copyMaterial.dispose();
    super.dispose();
  }
}
