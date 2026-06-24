import * as THREE from 'three';
import { Sequence } from '../core/sequence-manager.js';
import { isOverlay } from '../core/camera-eval.js';
import { OverlayScheduler } from '../core/overlay-scheduler.js';
import { SoundScheduler } from '../core/sound-scheduler.js';
import { TimerBag, disposeObject3D } from '../core/resources.js';
import { PhotoParticles, makeDissolveMaterial } from '../world/photo-particles.js';
import { createBottle } from '../world/bottle-factory.js';
import { LightRig } from '../core/light-rig.js';

/**
 * GENERATE: 撮影写真が3D平面としてカメラから遠ざかり、パーティクルに分解されて
 * 選択ボトルへ流れていく。カメラは hero パーティクルを追従し、ボトル付近を
 * フライバイ → 生成完了まで周回 → プルバック → 閃光 → RESULT。
 * choreography.json の generate.shots がカメラ編成（ショット列）を定義する。
 */
export class GenerateSequence extends Sequence {
  async enter(payload) {
    const { world, overlay, choreo, api, bottleRack, director } = this.ctx;
    const { brand, apiSnapshotDataUrl, displayCanvas } = payload;
    this.bag = new TimerBag();
    this.brand = brand;
    this.plane = null;
    this.planeTexture = null;
    this.particles = null;
    this.bottle = null;

    const gcfg = choreo.data.generate;
    bottleRack.setVisible(false);
    overlay.hideAll();

    // 配置ライト（generate.lights）をシーンへ反映＋経過秒でキーフレーム駆動
    this.lightRig = new LightRig(world.scene);
    this.lightRig.sync(gcfg.lights ?? []);
    let lightElapsed = 0;
    const lightTick = (dt) => {
      lightElapsed += dt;
      this.lightRig?.setTime(lightElapsed);
    };
    world.addTickable(lightTick);
    this.bag.add(() => world.removeTickable(lightTick));

    // 音響レイヤー（generate.sounds）を GENERATE 開始からの絶対経過秒で再生
    this.soundScheduler = new SoundScheduler();
    this.soundScheduler.setSounds(gcfg.sounds ?? []);
    const soundTick = (dt) => {
      if (!this.bag.disposed) this.soundScheduler.tick(dt);
    };
    world.addTickable(soundTick);
    this.bag.add(() => world.removeTickable(soundTick));

    // --- カメラを最初の base ショット開始位置へ即時セット（DOM白フラッシュ中） ---
    const ph0 = gcfg.shots.find((s) => !isOverlay(s)) ?? gcfg.shots[0];
    const startKf = ph0.path ? ph0.path[0] : ph0.pos;
    world.camera.position.set(...(Array.isArray(startKf) ? startKf : startKf.p));
    world.camera.fov = ph0.fov ? ph0.fov[0] : world.camera.fov;
    world.camera.updateProjectionMatrix();
    // 初期注視点: 単一 lookAt.point か、向きキーフレームの最初の point を採用（無ければ既定）
    const lookArr =
      ph0.lookAt?.point ?? ph0.lookAt?.keys?.find((k) => Array.isArray(k.point))?.point ?? [0, 0.5, 0];
    const lookPoint = new THREE.Vector3(...lookArr);
    director.syncLookFromCamera(lookPoint);
    world.camera.lookAt(lookPoint);

    // --- 写真平面: 現在のフラスタムを正確に満たすサイズで配置 ---
    const planeCenter = lookPoint.clone();
    const dist = world.camera.position.distanceTo(planeCenter);
    const planeH = 2 * dist * Math.tan(THREE.MathUtils.degToRad(world.camera.fov) / 2);
    const planeW = planeH * world.camera.aspect;

    this.planeTexture = new THREE.CanvasTexture(displayCanvas);
    this.planeTexture.colorSpace = THREE.SRGBColorSpace;
    world.renderer.initTexture(this.planeTexture); // スワップ時のヒッチ防止

    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(planeW, planeH),
      new THREE.MeshBasicMaterial({ map: this.planeTexture, toneMapped: false })
    );
    this.plane.position.copy(planeCenter);
    world.scene.add(this.plane);
    // 写真→粒のディゾルブに使う値（_swapToParticles で平面シェーダへ渡す）。
    // パーティクルの出発順と同じ等方ノイズ場にするため縦横比を補正する。
    this._planeAspect = planeW / planeH;

    // --- ターゲットボトル（遠方に配置、生成完了の主役） ---
    const BOTTLE_SCALE = gcfg.bottleScale ?? 1.6; // 遠景の主役なので少し大きく
    const bottlePos = new THREE.Vector3(...gcfg.bottlePos);
    const bottleCenter = bottlePos.clone().add(new THREE.Vector3(0, 0.4 * BOTTLE_SCALE, 0));
    this.bottleCenter = bottleCenter;
    // 被写界深度のピントを主役ボトルへ。退場時に固定距離へ戻す（postfx 無効時は no-op）
    world.setFocusTarget(bottleCenter);
    this.bag.add(() => world.setFocusTarget(null));
    createBottle(brand).then((model) => {
      if (this.bag.disposed) return;
      model.position.copy(bottlePos);
      model.scale.setScalar(BOTTLE_SCALE);
      world.scene.add(model);
      this.bottle = model;
    });

    // --- パーティクル構築（追加は分解開始時） ---
    this.particles = new PhotoParticles(world, gcfg.particles);
    this.particles.buildFromCanvas(displayCanvas, {
      planeCenter,
      planeW,
      planeH,
      target: bottleCenter,
    });

    // --- カメラ追従ターゲット登録 ---
    director.registerTarget('bottle', (out) => out.copy(bottleCenter));
    director.registerTarget('heroParticle', (out) => this.particles.getHeroPosition(out));

    // --- overlay カット（割り込み）スケジューラ: base カメラ確定後に絶対時刻で被せる ---
    const overlayScheduler = new OverlayScheduler(world.camera, {
      resolveTarget: (name, out) => director._resolveTarget(name, out),
      offsetFor: (shot) => director._resolveOffset(shot),
    });
    overlayScheduler.setShots(gcfg.shots);
    world.cameraOverride = (dt) => {
      if (!this.bag.disposed) overlayScheduler.tick(dt);
    };
    this.bag.add(() => {
      world.cameraOverride = null;
    });

    // --- 生成APIは演出と並行して即時開始 ---
    // pullBack を見せ終えた時点で「完了済みか」を即判定したいので、結果/失敗を
    // フラグに控えておく（.then の rejection ハンドラが未処理拒否警告も兼ねる）。
    this.apiResult = null;
    this.apiError = null;
    this.apiPromise = api.generateToyImage(brand.slug, apiSnapshotDataUrl, () => {});
    this.apiPromise.then(
      (r) => {
        this.apiResult = r;
      },
      (e) => {
        this.apiError = e;
      }
    );

    // 編成本体（exit 時に director.stop() で停止する）
    this._run(gcfg).catch((err) => {
      if (this.bag.disposed) return;
      console.error('[Generate] failed', err);
      this._fail();
    });
  }

  async _run(gcfg) {
    const { overlay, manager, director } = this.ctx;

    // base ショットを順に再生し、必ず pullBack まで通しで見せる。
    // type:"loop"/"follow"（生成完了待ちのホールド点）は特殊カットなので再生しない。
    for (let i = 0; i < gcfg.shots.length; i++) {
      const ph = gcfg.shots[i];
      if (this.bag.disposed) return;

      // overlay カット（start 持ち）は「上に被せる」絶対時刻再生。逐次フローには乗せず
      // OverlayScheduler が world.cameraOverride で base カメラの上に被せる。
      if (isOverlay(ph)) continue;

      if (ph.type === 'path') {
        await director.playPhase(ph, { shots: gcfg.shots, index: i }); // 隣接 path と境界連続化
        if (this.bag.disposed) return;
        // 写真の後退が終わったら平面→パーティクルへスワップして分解開始
        if (ph.id === 'photoRecede') this._swapToParticles();
      } else {
        // ホールド系（loop/follow）。生成完了は待たず、1周（loopDuration / minHold）
        // ぶんだけ通しで見せてから次フェーズへ抜ける（無限ループにはしない）。
        const hold = ph.type === 'follow' ? director.playFollow(ph) : director.playLoop(ph);
        await this.bag.delay((ph.loopDuration ?? ph.minHold ?? 0) * 1000);
        if (this.bag.disposed) return;
        await hold.release();
        if (this.bag.disposed) return;
      }
    }
    if (this.bag.disposed) return;

    // pullBack まで見せ終えた時点で生成結果を確認する。
    // 完了済みなら即座に遷移。未完了なら画面中央にロゴを出して完了を待つ。
    if (this.apiError) {
      this._fail();
      return;
    }
    let result = this.apiResult;
    if (!result) {
      overlay.showGenerateWaitLogo();
      try {
        result = await this.apiPromise;
      } catch (err) {
        if (this.bag.disposed) return;
        overlay.hideGenerateWaitLogo();
        console.error('[Generate] API error', err);
        this._fail();
        return;
      }
      if (this.bag.disposed) return;
    }

    // リザルト画像を事前ロード（フェードインのポップ防止）
    await preloadImage(result.imageUrl).catch(() => {});
    if (this.bag.disposed) return;

    // 待機ロゴを表示していた場合はフェードアウトしてから遷移（パッと消えないように）。
    // 表示していなければ即時 resolve され、従来どおりカメラからのホワイトアウトになる。
    await overlay.fadeOutGenerateWaitLogo(0.5);
    if (this.bag.disposed) return;
    overlay.flashWhite({
      inDur: 0.12,
      hold: 0.15,
      outDur: 0.8,
      onWhite: () => {
        manager.go('result', { result, brand: this.brand });
      },
    });
  }

  _swapToParticles() {
    const { world, choreo } = this.ctx;
    const pcfg = choreo.data.generate.particles;
    world.scene.add(this.particles.points);
    this.particles.start();
    this.bag.add(() => this.particles.stopTicking());

    if (!this.plane) return;

    // ハードカットせず、写真平面を simplex noise マップで有機的にディゾルブさせる。
    // パーティクルと同一のノイズ場・進行クロック（particles.time）を共有するので、
    // 「写真が粒へ溶けるパッチ」と「その粒が飛び出すパッチ」が連動して見える。
    // ディゾルブは波（ripple）の時間内に完了させ、以降は粒のみになる。
    const lead = pcfg.rippleLead;
    const dissolveMat = makeDissolveMaterial(this.planeTexture, {
      aspect: this._planeAspect,
      noiseScale: pcfg.dissolveNoiseScale ?? 6.0,
      lead,
      edge: pcfg.dissolveEdge ?? 0.3,
    });
    this.plane.material.dispose();
    this.plane.material = dissolveMat;
    this.plane.renderOrder = 1; // 半透明の写真を粒（renderOrder=0）より手前へ重ねる

    const dissolveTick = () => {
      const shader = dissolveMat.userData.shader;
      if (shader) shader.uniforms.uDTime.value = this.particles.time;
      // 完全に溶けきったら平面を破棄（少しのマージンを足して取りこぼしを防ぐ）
      if (this.particles.time >= lead * 1.08) {
        world.removeTickable(dissolveTick);
        if (this.plane) {
          world.scene.remove(this.plane);
          this.plane.geometry.dispose();
          this.plane.material.dispose();
          this.plane = null;
        }
      }
    };
    world.addTickable(dissolveTick);
    this.bag.add(() => world.removeTickable(dissolveTick));
  }

  async _fail() {
    const { overlay, manager } = this.ctx;
    await overlay.setWhite(true, 0.5);
    manager.reset('select');
  }

  async exit() {
    const { world, director, overlay } = this.ctx;
    director.stop();
    director.clearTargets();
    overlay.hideGenerateWaitLogo(); // ESC/リセット含め待機ロゴの残留を防ぐ
    this.bag.disposeAll();

    if (this.lightRig) {
      this.lightRig.dispose();
      this.lightRig = null;
    }

    if (this.plane) {
      world.scene.remove(this.plane);
      this.plane.geometry.dispose();
      this.plane.material.dispose();
      this.plane = null;
    }
    if (this.planeTexture) {
      this.planeTexture.dispose();
      this.planeTexture = null;
    }
    if (this.particles) {
      this.particles.dispose(world.scene);
      this.particles = null;
    }
    if (this.bottle) {
      disposeObject3D(this.bottle);
      this.bottle = null;
    }
  }
}

function preloadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => (img.decode ? img.decode().then(resolve, resolve) : resolve());
    img.onerror = reject;
    img.src = url;
  });
}
