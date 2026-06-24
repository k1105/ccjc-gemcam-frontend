import * as THREE from 'three';

const TAU = Math.PI * 2;

/**
 * 撮影写真をパーティクルに分解して選択ボトルへ流すシステム。
 *
 * 演出の流れ（すべて uTime のステートレス解析関数。スクラブ可能）:
 *  1. リップル: 写真の矩形が波打って形状が崩れる（uRippleLead 秒）
 *  2. 彗星ストリーム: 全パーティクルが共通のベジェパスに収束して流れる。
 *     hero は遅延の厳密な最小値を持ち（headLead の車間付き）、先鋒より先に
 *     粒は出ない。横ずれ半径は先頭からの遅れに比例し、先端が細く尾に向かって
 *     広がる錐形（コーン）の彗星になる。先鋒(hero)をカメラが追従
 *  3. ヘリックス: ベジェ終端はボトル周囲の螺旋パスに接線連続(C1)で接続しており、彗星は
 *     螺旋に「接するように」入射して巻き付き（中腹へ突っ込まない）、進行に応じてフェードする。
 *     （粒ごとに別軌道へ散らない＝雲にならない）
 *
 * - 単一 THREE.Points + ShaderMaterial（円形スプライト）、1ドローコール
 * - 色は ImageData から aColor 属性へ事前焼き込み
 * - hero は遅延ゼロ・横ずれゼロ＝ストリーム先頭。同一式を CPU でも評価して
 *   カメラ追従ターゲットと描画点を一致させる（ヘリックス中も追従可能）
 */
export class PhotoParticles {
  constructor(world, cfg) {
    this.world = world;
    this.cfg = cfg;
    this.points = null;
    this.material = null;
    this.geometry = null;
    this.time = 0;
    this.playing = false;
    this._tick = null;
    this._hero = null;
    this._target = new THREE.Vector3();
    this._planeCenter = new THREE.Vector3();
    this._planeSize = new THREE.Vector2();
    this._stream = null; // { p0, p1, p2, p3, side, up }
  }

  /**
   * @param {HTMLCanvasElement} canvas 表示用スナップショット
   * @param {{planeCenter: THREE.Vector3, planeW: number, planeH: number, target: THREE.Vector3, themeColor?: string}} opts
   */
  buildFromCanvas(canvas, { planeCenter, planeW, planeH, target, themeColor }) {
    const [gw, gh] = this.cfg.grid;
    const count = gw * gh;

    this._target.copy(target);
    this._planeCenter.copy(planeCenter);
    this._planeSize.set(planeW, planeH);
    // 色を落とす（useImageColor=false）際のフォールバック色。各飲料のテーマカラーを
    // 引き継ぎ、グレーではなくその色味へ溶け込ませる。未指定（エディタのテストパターン等）は
    // 白＝従来どおりのグレースケール挙動。aColor と同じ raw sRGB で扱う（線形化しない）。
    this._themeColor = hexToRGB(themeColor ?? this.cfg.themeColor);
    this._buildStream();

    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    const uvs = new Float32Array(count * 2);
    const colors = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 4);
    const isHero = new Float32Array(count);
    const positions = new Float32Array(count * 3); // ダミー（実位置はシェーダ計算）

    const rand = mulberry32(123456789);

    // hero: 画像中央やや上の1粒 = ストリーム先頭
    const heroGX = Math.floor(gw * 0.5);
    const heroGY = Math.floor(gh * 0.45);
    const heroIndex = heroGY * gw + heroGX;

    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const i = gy * gw + gx;
        const u = (gx + 0.5) / gw;
        const v = (gy + 0.5) / gh;
        uvs[i * 2] = u;
        uvs[i * 2 + 1] = v;

        // canvas は上が y=0、世界は上が +y なので v を反転してサンプル
        const px = Math.min(Math.floor(u * canvas.width), canvas.width - 1);
        const py = Math.min(Math.floor((1 - v) * canvas.height), canvas.height - 1);
        const o = (py * canvas.width + px) * 4;
        colors[i * 3] = img[o] / 255;
        colors[i * 3 + 1] = img[o + 1] / 255;
        colors[i * 3 + 2] = img[o + 2] / 255;

        seeds[i * 4] = rand();
        seeds[i * 4 + 1] = rand();
        seeds[i * 4 + 2] = rand();
        seeds[i * 4 + 3] = rand();

        isHero[i] = i === heroIndex ? 1 : 0;
      }
    }

    // hero は遅延ゼロ（=先鋒）・標準的な旋回半径
    seeds[heroIndex * 4] = 0.0;
    seeds[heroIndex * 4 + 2] = 0.5;

    this._hero = {
      uv: [uvs[heroIndex * 2], uvs[heroIndex * 2 + 1]],
      seed: [
        seeds[heroIndex * 4],
        seeds[heroIndex * 4 + 1],
        seeds[heroIndex * 4 + 2],
        seeds[heroIndex * 4 + 3],
      ],
    };

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('aGridUV', new THREE.BufferAttribute(uvs, 2));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.geometry.setAttribute('aIsHero', new THREE.BufferAttribute(isHero, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    // 粒の見た目: 写真の色を反映するか / しない場合は明度レンジ＋ランダムで単色化。
    // grainImage（data URL）があれば手続き的な丸の代わりにその画像で粒を描画する。
    const grainTex = grainTexture(this.cfg.grainImage);

    const s = this._stream;
    this.material = new THREE.ShaderMaterial({
      // fog:true の ShaderMaterial は fog 用 uniform(fogColor/fogNear/fogFar)を自前で持つ必要がある。
      // 無いと renderer.refreshFogUniforms が undefined.value で毎フレーム例外を投げる。
      // UniformsLib.fog をクローンして混ぜる（グローバル共有 uniform の汚染を防ぐためクローン）。
      uniforms: Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog), {
        uTime: { value: 0 },
        uUseImageColor: { value: this.cfg.useImageColor === false ? 0 : 1 },
        uBrightMin: { value: this.cfg.brightMin ?? 0.35 },
        uBrightMax: { value: this.cfg.brightMax ?? 1.0 },
        uBrightRandom: { value: this.cfg.brightRandom ?? 0.25 },
        uThemeColor: { value: this._themeColor },
        // 切り替え直後は画像色 → 時間で最終状態（useImageColor=false なら単色）へ遷移
        uColorFadeStart: { value: this.cfg.colorFadeStart ?? 1.4 },
        uColorFadeEnd: { value: this.cfg.colorFadeEnd ?? 3.5 },
        // 切り替え直後の粒サイズを画面ピクセル（半径）で直接指定し、uSwapSizeBoostDur 秒
        // かけて通常（システム指定）サイズへ収束させる。見た目で合わせられるよう px 固定。
        uSwapPixelRadius: { value: this.cfg.swapPixelRadius ?? 15 },
        uSwapSizeBoostDur: { value: this.cfg.swapSizeBoostDur ?? 1.5 },
        uUseTexture: { value: grainTex ? 1 : 0 },
        uTexture: { value: grainTex ?? fallbackTexture() },
        uTarget: { value: this._target },
        uPlaneCenter: { value: this._planeCenter },
        uPlaneSize: { value: this._planeSize },
        uP0: { value: s.p0 },
        uP1: { value: s.p1 },
        uP2: { value: s.p2 },
        uP3: { value: s.p3 },
        uSide: { value: s.side },
        uUp: { value: s.up },
        uRippleLead: { value: this.cfg.rippleLead },
        uRippleAmp: { value: this.cfg.rippleAmp },
        uRippleFreq: { value: new THREE.Vector2(...this.cfg.rippleFreq) },
        uRippleSpeed: { value: this.cfg.rippleSpeed },
        uDelaySpread: { value: this.cfg.dissolveDelaySpread },
        uHeadLead: { value: this.cfg.headLead },
        uFlightDur: { value: this.cfg.flightDuration },
        uLateral: { value: this.cfg.lateralRadius },
        uTwist: { value: this.cfg.twist },
        uNoiseAmp: { value: this.cfg.noiseAmp },
        uNoiseFreq: { value: this.cfg.noiseFreq },
        uHelixTheta0: { value: s.theta0 },
        uHelixY0: { value: s.y0 },
        uHelixRadius: { value: this.cfg.helixRadius },
        uHelixSpeed: { value: this.cfg.helixSpeed },
        uHelixBobAmp: { value: this.cfg.helixBobAmp },
        uHelixBobFreq: { value: this.cfg.helixBobFreq },
        uHelixDescent: { value: this.cfg.helixDescent },
        uHelixDrop: { value: this.cfg.helixDrop },
        uHelixFade: { value: this.cfg.helixFade },
        uSizeGrow: { value: this.cfg.sizeGrow },
        // 大小のばらけ具合（分布の偏り）。aSeed.z^bias の指数。大きいほど極端
        // （ほとんど小粒＋ごく一部だけ巨大）、1 に近いほどなめらか（小〜大が連続）。
        uSizeGrowBias: { value: this.cfg.sizeGrowBias ?? 6.0 },
        uSurviveRatio: { value: this.cfg.surviveRatio },
        uSizeWorld: { value: this.cfg.size },
        uProjScale: { value: 1000 },
      }),
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: true, // scene.fog を粒にも反映（fog uniform は上で UniformsLib.fog を混入済み）
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    return this.points;
  }

  /**
   * 写真平面→ボトルへの共通ストリームパス（彗星の軌道）と、
   * その終端が接続するボトル周囲のヘリックス（螺旋）を構築する。
   */
  _buildStream() {
    const cfg = this.cfg;
    const center = this._target;
    const p0 = this._planeCenter.clone();

    // ヘリックスのエントリ角: 入口での螺旋接線が彗星の進入方向(approach)と「同方向」に
    // なる点を選ぶ。こうすると彗星は中心へ突っ込まず、車が環状交差点に合流するように
    // 螺旋へ接して入射できる（進入方向に直交する旧来の点だと裏へ回り込むループになる）。
    // 螺旋の水平速度は sign(speed)*(-sinθ, cosθ) ∝ approach となる θ を解く。
    const approach = center.clone().sub(p0);
    approach.y = 0;
    approach.normalize();
    const sp = Math.sign(cfg.helixSpeed) || 1;
    const theta0 = Math.atan2(-approach.x * sp, approach.z * sp);
    const y0 = center.y + cfg.helixEntryY;
    const p3 = new THREE.Vector3(
      center.x + Math.cos(theta0) * cfg.helixRadius,
      y0,
      center.z + Math.sin(theta0) * cfg.helixRadius
    );

    // ヘリックス入口での接線（s2=0 の helixPos 微分方向）。彗星がこの向きで p3 に
    // 到達するようベジェ終端ハンドル p2 を接線の逆向きに置くと、半径方向から「突っ込む」
    // のではなく螺旋に接するように入射できる（C1 連続）。
    const entryTan = new THREE.Vector3(
      -Math.sin(theta0) * cfg.helixSpeed * cfg.helixRadius,
      -cfg.helixDescent + cfg.helixBobFreq * cfg.helixBobAmp,
      Math.cos(theta0) * cfg.helixSpeed * cfg.helixRadius
    ).normalize();
    const handle = p3.distanceTo(p0) * (cfg.helixEntryTangent ?? 0.4);

    const p1 = p0.clone().lerp(p3, 0.33).add(new THREE.Vector3(...cfg.streamP1Offset));
    const p2 = p3
      .clone()
      .addScaledVector(entryTan, -handle)
      .add(new THREE.Vector3(...cfg.streamP2Offset));

    const dir = p3.clone().sub(p0).normalize();
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(side, dir).normalize();

    this._stream = { p0, p1, p2, p3, side, up, theta0, y0 };
  }

  /**
   * ヘリックス上の位置（s2 = ベジェ終端からの経過秒）。シェーダと同一式。
   * キャップ上から巻き始め、ボトルに沿って下降していく（helixDrop で底打ち）。
   */
  _helixPos(s2, out) {
    const cfg = this.cfg;
    const s = this._stream;
    const ang = s.theta0 + s2 * cfg.helixSpeed;
    const drop = Math.min(s2 * cfg.helixDescent, cfg.helixDrop);
    return out.set(
      this._target.x + Math.cos(ang) * cfg.helixRadius,
      s.y0 - drop + Math.sin(s2 * cfg.helixBobFreq) * cfg.helixBobAmp,
      this._target.z + Math.sin(ang) * cfg.helixRadius
    );
  }

  /** world tick に登録して時間を進める */
  start() {
    this.playing = true;
    this._tick = (dt) => {
      if (this.playing) this.time += dt;
      this._updateUniforms();
    };
    this.world.addTickable(this._tick);
  }

  stopTicking() {
    if (this._tick) {
      this.world.removeTickable(this._tick);
      this._tick = null;
    }
    this.playing = false;
  }

  /** エディタのスクラブ用 */
  setTime(t) {
    this.time = t;
    this._updateUniforms();
  }

  _updateUniforms() {
    if (!this.material) return;
    this.material.uniforms.uTime.value = this.time;
    const fovRad = THREE.MathUtils.degToRad(this.world.camera.fov);
    this.material.uniforms.uProjScale.value =
      this.world.renderer.domElement.height / (2 * Math.tan(fovRad / 2));
  }

  /**
   * hero（ストリーム先頭）の現在位置。シェーダと同一式の CPU 評価。
   * hero は横ずれ・ノイズなしなので厳密に一致する。
   */
  getHeroPosition(out, time = this.time) {
    const h = this._hero;
    if (!h) return out.set(0, 0, 0);
    const cfg = this.cfg;
    const s = this._stream;
    const [su, sv] = h.uv;

    const start = _v1.set(
      this._planeCenter.x + (su - 0.5) * this._planeSize.x,
      this._planeCenter.y + (sv - 0.5) * this._planeSize.y,
      this._planeCenter.z
    );

    // リップル（写真が波打つ）— hero にも適用
    const rippleRamp = smoothstep(0, cfg.rippleLead * 0.6, time);
    const wave =
      Math.sin(su * cfg.rippleFreq[0] + time * cfg.rippleSpeed) *
      Math.cos(sv * cfg.rippleFreq[1] + time * cfg.rippleSpeed * 0.8) *
      cfg.rippleAmp *
      rippleRamp;
    start.z += wave;

    // hero の遅延は厳密な最小値（シェーダ側は非 hero に uHeadLead+spread を加算）
    const delay = cfg.rippleLead;
    const t = time - delay;
    if (t <= 0) return out.copy(start);

    // ベジェ終端 = ヘリックス入口（C0連続）。以降は共通螺旋を周回し続ける
    if (t >= cfg.flightDuration) {
      return this._helixPos(t - cfg.flightDuration, out);
    }

    const lt = t / cfg.flightDuration;
    // 共通ストリーム上の位置（hero は横ずれなし）
    const streamP = cubicBezier(s.p0, s.p1, s.p2, s.p3, lt, _v2);
    // 出発: 自分の位置からストリームへ収束
    out.copy(start).lerp(streamP, smoothstep(0.0, 0.3, lt));
    return out;
  }

  dispose(scene) {
    this.stopTicking();
    if (this.points) {
      scene.remove(this.points);
      this.geometry.dispose();
      this.material.dispose();
      this.points = null;
    }
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

function smoothstep(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

function cubicBezier(p0, p1, p2, p3, t, out) {
  const mt = 1 - t;
  out.set(0, 0, 0);
  out.addScaledVector(p0, mt * mt * mt);
  out.addScaledVector(p1, 3 * mt * mt * t);
  out.addScaledVector(p2, 3 * mt * t * t);
  out.addScaledVector(p3, t * t * t);
  return out;
}

// 粒テクスチャは data URL をキーに使い回す。粒の再構築（スライダー変更）ごとに
// 画像を読み直さないためのモジュールキャッシュ。共有なので個別 dispose しない。
const _grainCache = new Map();
function grainTexture(dataURL) {
  if (!dataURL) return null;
  let tex = _grainCache.get(dataURL);
  if (!tex) {
    tex = new THREE.TextureLoader().load(dataURL);
    tex.colorSpace = THREE.SRGBColorSpace;
    _grainCache.set(dataURL, tex);
  }
  return tex;
}

// uTexture サンプラに必ず有効なテクスチャを束ねるための 1x1 白（uUseTexture=0 時に使用）
let _fallbackTex = null;
function fallbackTexture() {
  if (!_fallbackTex) {
    _fallbackTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    _fallbackTex.needsUpdate = true;
  }
  return _fallbackTex;
}

// '#rrggbb' / 'rrggbb' を raw sRGB の vec3(0..1) へ。aColor（写真ピクセル /255）と
// 同じ非線形 sRGB のまま扱うため、THREE.Color の線形化は通さない。未指定は白。
function hexToRGB(hex) {
  if (!hex || typeof hex !== 'string') return new THREE.Vector3(1, 1, 1);
  const h = hex.replace('#', '').trim();
  if (h.length < 6) return new THREE.Vector3(1, 1, 1);
  return new THREE.Vector3(
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255
  );
}

/** 決定論的PRNG（シードはエディタ調整に対して安定） */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 2D simplex noise（Ashima / Stefan Gustavson, webgl-noise）。出力は概ね [-1, 1]。
// パーティクルの出発順（VERT）と、写真平面→粒のディゾルブ（generate.js の平面シェーダ）で
// 同一のノイズ場を共有し、写真の溶け方と粒の飛び出し方が同じパッチで連動するようにする。
export const SNOISE2D_GLSL = /* glsl */ `
vec3 snoise_mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 snoise_mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 snoise_permute(vec3 x) { return snoise_mod289(((x * 34.0) + 1.0) * x); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = snoise_mod289(i);
  vec3 p = snoise_permute(snoise_permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
`;

/**
 * 写真平面を simplex noise マスクで「欠けさせて」消すためのマテリアル。
 * 通常の MeshBasicMaterial（不透明・色管理は three 任せ）に onBeforeCompile でノイズの
 * 切り抜きを注入する。uDTime/uDLead で 0→1 に進む「前線」より小さいノイズ値の領域から
 * 順に discard していく＝写真が有機的なパッチ状に穴あきで消えていく。
 *
 * 平面は半透明（depthWrite=false）で、裏に居る粒の上にアルファ合成される。前線付近を
 * 幅 uDEdge でなめらかに不透明→透明へグラデーションさせるので、写真が粒の点描へ
 * 溶けていくように見える（硬い輪郭やディザのジラつき、明るい縁が出ない）。
 * 粒より必ず手前に重ねるため、呼び出し側は plane.renderOrder を粒より大きくすること。
 *
 * 本番（sequences/generate.js）とエディタのスクラブ（editor/preview-stage.js）で共有する。
 * 呼び出し側が毎フレーム material.userData.shader.uniforms.uDTime を進める。
 *
 * @param {THREE.Texture} map 表示テクスチャ（写真）
 * @param {{aspect:number, noiseScale:number, lead:number, edge?:number}} opts
 */
export function makeDissolveMaterial(map, { aspect, noiseScale, lead, edge = 0.3 }) {
  const mat = new THREE.MeshBasicMaterial({
    map,
    toneMapped: false,
    transparent: true,
    depthWrite: false,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDTime = { value: 0 };
    shader.uniforms.uDLead = { value: lead };
    shader.uniforms.uDAspect = { value: aspect };
    shader.uniforms.uDNoiseScale = { value: noiseScale };
    shader.uniforms.uDEdge = { value: edge };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vDUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n  vDUv = uv;');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uDTime;
        uniform float uDLead;
        uniform float uDAspect;
        uniform float uDNoiseScale;
        uniform float uDEdge;
        varying vec2 vDUv;
        ${SNOISE2D_GLSL}`
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        {
          // 縦横比補正済みノイズ場。前線 front 未満のノイズ値の領域を消していく。
          float nz = snoise(vec2(vDUv.x * uDAspect, vDUv.y) * uDNoiseScale) * 0.5 + 0.5;
          // 前線は 0 → 1+uDEdge まで進める。これで uDTime=0 は全面表示（欠けなし）、
          // uDTime=uDLead で完全消滅になる。ぼかし帯(幅 uDEdge)は前線の「消える側」に置く。
          float front = clamp(uDTime / max(uDLead, 1e-3), 0.0, 1.0) * (1.0 + uDEdge);
          // nz>=front は不透明、front-uDEdge 以下は透明、その間をなめらかにグラデーション。
          float alpha = smoothstep(front - uDEdge, front, nz);
          gl_FragColor.a *= alpha;
          if (gl_FragColor.a < 0.003) discard;
        }`
      );

    mat.userData.shader = shader;
  };
  return mat;
}

const VERT = /* glsl */ `
attribute vec2 aGridUV;
attribute vec3 aColor;
attribute vec4 aSeed;
attribute float aIsHero;

uniform float uTime;
uniform float uUseImageColor;
uniform float uBrightMin;
uniform float uBrightMax;
uniform float uBrightRandom;
uniform vec3 uThemeColor;
uniform float uColorFadeStart;
uniform float uColorFadeEnd;
uniform float uSwapPixelRadius;
uniform float uSwapSizeBoostDur;
uniform vec3 uTarget;
uniform vec3 uPlaneCenter;
uniform vec2 uPlaneSize;
uniform vec3 uP0;
uniform vec3 uP1;
uniform vec3 uP2;
uniform vec3 uP3;
uniform vec3 uSide;
uniform vec3 uUp;
uniform float uRippleLead;
uniform float uRippleAmp;
uniform vec2 uRippleFreq;
uniform float uRippleSpeed;
uniform float uDelaySpread;
uniform float uHeadLead;
uniform float uFlightDur;
uniform float uLateral;
uniform float uTwist;
uniform float uNoiseAmp;
uniform float uNoiseFreq;
uniform float uHelixTheta0;
uniform float uHelixY0;
uniform float uHelixRadius;
uniform float uHelixSpeed;
uniform float uHelixBobAmp;
uniform float uHelixBobFreq;
uniform float uHelixDescent;
uniform float uHelixDrop;
uniform float uHelixFade;
uniform float uSizeGrow;
uniform float uSizeGrowBias;
uniform float uSurviveRatio;
uniform float uSizeWorld;
uniform float uProjScale;

varying vec3 vColor;
varying float vAlpha;

#include <fog_pars_vertex>

const float TAU = 6.28318530718;

// ボトル周囲の共通螺旋（全パーティクルが時間差で同一パスを辿る＝彗星構造を維持）。
// キャップ上から巻き始め、ボトルに沿って下降していく
vec3 helixPos(float s2) {
  float ang = uHelixTheta0 + s2 * uHelixSpeed;
  float drop = min(s2 * uHelixDescent, uHelixDrop);
  return vec3(
    uTarget.x + cos(ang) * uHelixRadius,
    uHelixY0 - drop + sin(s2 * uHelixBobFreq) * uHelixBobAmp,
    uTarget.z + sin(ang) * uHelixRadius
  );
}

vec3 streamBezier(float t) {
  float mt = 1.0 - t;
  return uP0 * (mt * mt * mt)
       + uP1 * (3.0 * mt * mt * t)
       + uP2 * (3.0 * mt * t * t)
       + uP3 * (t * t * t);
}

void main() {
  // 切り替え直後は必ず画像色から始まる。最終状態は useImageColor で決まり、
  // 色を落とす場合（useImageColor=false）は [colorFadeStart, colorFadeEnd] 秒で
  // 画像色 → テーマ色（明度を [min,max] へ再マップ＋粒ごとランダムし、飲料の
  // テーマカラー uThemeColor で着色）へ滑らかに遷移する。uThemeColor=白なら
  // 従来どおりのグレースケール。useImageColor=true なら終始画像色のまま。
  vec3 colored = aColor;
  float lum = dot(aColor, vec3(0.299, 0.587, 0.114));
  float n = clamp(lum + (aSeed.x - 0.5) * uBrightRandom, 0.0, 1.0);
  vec3 mono = uThemeColor * mix(uBrightMin, uBrightMax, n);
  vec3 finalCol = (uUseImageColor > 0.5) ? colored : mono;
  float colorFade = smoothstep(uColorFadeStart, uColorFadeEnd, uTime);
  vColor = mix(colored, finalCol, colorFade);

  vec3 start = vec3(
    uPlaneCenter.x + (aGridUV.x - 0.5) * uPlaneSize.x,
    uPlaneCenter.y + (aGridUV.y - 0.5) * uPlaneSize.y,
    uPlaneCenter.z
  );

  // --- 1. リップル: 写真の矩形が波打って崩れる ---
  float rippleRamp = smoothstep(0.0, uRippleLead * 0.6, uTime);
  float wave = sin(aGridUV.x * uRippleFreq.x + uTime * uRippleSpeed)
             * cos(aGridUV.y * uRippleFreq.y + uTime * uRippleSpeed * 0.8)
             * uRippleAmp * rippleRamp;
  start.z += wave;

  // 遅延: hero は uRippleLead ちょうど＝厳密な最前。他粒は uHeadLead の車間を
  // 空けて続くため、先鋒より先にパーティクルは出ない
  float spreadT = aSeed.x * 0.55 + (1.0 - aGridUV.y) * 0.45;
  float delay = uRippleLead + (uHeadLead + spreadT * uDelaySpread) * (1.0 - aIsHero);

  // 先頭からの遅れ 0→1。横ずれ半径を遅れに比例させ、先端が細く
  // 尾に向かって広がる錐形（コーン）の彗星にする
  float lagN = clamp((delay - uRippleLead) / max(uHeadLead + uDelaySpread, 1e-3), 0.0, 1.0);
  float latAng = aSeed.w * TAU;
  float latR = uLateral * (0.2 + 0.8 * aSeed.z) * lagN * (1.0 - aIsHero);

  // 大半の粒は飛行中に消え、一部だけがボトルまで生き残る（疎な球の群れにする）
  float survive = max(step(1.0 - uSurviveRatio, aSeed.y), aIsHero);

  float t = uTime - delay;
  vec3 pos;
  float fade = 0.0;

  if (t <= 0.0) {
    pos = start;
  } else if (t >= uFlightDur) {
    // --- 3. ヘリックス: 先鋒を保ったまま生き残りがボトルに巻き付き下降していく ---
    float s2 = t - uFlightDur;
    pos = helixPos(s2);
    pos += (cos(latAng + uTwist + s2 * 1.5) * uSide + sin(latAng + uTwist + s2 * 1.5) * uUp) * latR;
    // 螺旋の進行に応じて緩やかにフェード。非生存粒はここまで来ない
    fade = mix(1.0, clamp(s2 / uHelixFade, 0.0, 1.0), survive);
  } else {
    float lt = t / uFlightDur;

    // --- 2. 彗星ストリーム: 共通ベジェパス + 細い横ずれ ---
    vec3 streamP = streamBezier(lt);
    float ang = latAng + lt * uTwist;
    streamP += (cos(ang) * uSide + sin(ang) * uUp) * latR;

    // 微細なノイズ（流れのきらめき）。錐形に合わせて先端ほど弱く、hero は無効
    float env = sin(3.14159265 * lt) * uNoiseAmp * lagN * (1.0 - aIsHero);
    streamP += vec3(
      sin(t * uNoiseFreq * 3.1 + aSeed.x * TAU),
      sin(t * uNoiseFreq * 2.3 + aSeed.y * TAU),
      sin(t * uNoiseFreq * 2.7 + aSeed.w * TAU)
    ) * env;

    // 出発: 自分の位置からストリームへ収束（終端はそのままヘリックス入口に接続）
    pos = mix(start, streamP, smoothstep(0.0, 0.3, lt));

    // 非生存粒は飛行の後半で光の中へ溶けるように消える
    fade = smoothstep(0.5, 0.95, lt) * (1.0 - survive);
  }

  vAlpha = 1.0 - fade;

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>  // vFogDepth = -mvPosition.z（fog反映用の視点距離）
  // 写真状態では均一サイズ。生き残った粒のうち少数だけが大きな球へ成長
  // （pow で偏らせ、大小の混ざった疎な球の群れにする）
  float flightT = clamp(t / uFlightDur, 0.0, 1.0);
  float grow = 1.0 + uSizeGrow * pow(aSeed.z, uSizeGrowBias) * smoothstep(0.15, 0.8, flightT) * survive;
  // システム指定サイズ（成長・退場フェードを反映した通常時）の画面ピクセル径。
  float normalWorld = uSizeWorld * (grow * mix(1.0, 0.35, fade) + aIsHero * 0.3);
  float normalPx = normalWorld * uProjScale / max(-mvPosition.z, 0.05);
  // 切替直後は粒の画面サイズを uSwapPixelRadius（半径px）で直接指定し、写真がピクセル分割
  // されたように見せる。uSwapSizeBoostDur 秒かけて通常サイズ(normalPx)へ収束。
  float swapPx = uSwapPixelRadius * 2.0; // 半径→直径(px)
  float pxSize = mix(swapPx, normalPx, smoothstep(0.0, uSwapSizeBoostDur, uTime));

  // 上限クランプ: 粒は消さず（至近まで急接近する演出を活かす）、巨大化だけを頭打ちにする。
  // 粒 1 個が塗る最大ピクセル数を固定上限に抑え、フィルレートの最悪値を保証する。
  const float MAX_POINT_SIZE = 256.0;
  gl_PointSize = min(pxSize, MAX_POINT_SIZE);
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uTexture;
uniform float uUseTexture;

varying vec3 vColor;
varying float vAlpha;

#include <fog_pars_fragment>

void main() {
  float mask;
  if (uUseTexture > 0.5) {
    // アップロードした粒画像で形を決める。色は vColor を使うので画像は形マスク扱い。
    // 透過PNG（アルファ）も白地JPG（輝度）も拾えるよう alpha×最大チャンネルでマスク化。
    // gl_PointCoord は上が0なので y を反転して画像を正立で貼る。
    vec4 t = texture2D(uTexture, vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y));
    mask = t.a * max(t.r, max(t.g, t.b));
  } else {
    // 円形スプライト（ソフトエッジ）
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    mask = 1.0 - smoothstep(0.35, 0.5, d);
  }
  gl_FragColor = vec4(vColor, vAlpha * mask);
  if (gl_FragColor.a < 0.01) discard;
  #include <fog_fragment>  // 遠景の粒を scene.fog の色へ補間（rgbのみ・alphaは保持）
}
`;
