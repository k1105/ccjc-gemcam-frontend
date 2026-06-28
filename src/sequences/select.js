import * as THREE from 'three';
import { Sequence } from '../core/sequence-manager.js';
import { TimerBag } from '../core/resources.js';
import { playSfx } from '../core/audio.js';

/**
 * SELECT: 10本のボトルが横並び。0-9キーで選択すると
 * 選択ボトルが回転しながら画面下へ沈み、SHOOT へ遷移する。
 * 旧 TITLE+SELECT を統合した、体験の待機ステートでもある。
 */
export class SelectSequence extends Sequence {
  async enter(payload = {}) {
    const { world, overlay, keyboard, brands, choreo, bottleRack, environment } = this.ctx;
    this.bag = new TimerBag();
    this.selecting = false;

    overlay.hideAll();
    overlay.resetBrandWipe(); // 前サイクル/強制リセットの選択演出の帯を確実に消す
    overlay.showSelectGradient(choreo.data.select.gradient); // 待機画面上端の影
    this.ctx.webcam.release(); // ウォームアップ後にESC等で戻った場合のLED消灯を保証
    bottleRack.setVisible(true);
    if (payload.withReturn) bottleRack.prepareReturn();

    const camCfg = choreo.data.select.camera;

    // リセット時・リザルト明け（画面が白い間）はカメラを即時定位置へ
    if (payload.reset || payload.withReturn) {
      if (payload.reset) bottleRack.resetInstant();
      world.camera.position.set(...camCfg.pos);
      world.camera.fov = camCfg.fov;
      world.camera.updateProjectionMatrix();
    } else {
      // 通常遷移: カメラを定位置へ滑らかに寄せる
      this.bag.to(world.camera.position, {
        x: camCfg.pos[0], y: camCfg.pos[1], z: camCfg.pos[2],
        duration: 1.2, ease: 'power2.inOut',
      });
      this.bag.to(world.camera, {
        fov: camCfg.fov, duration: 1.2, ease: 'power2.inOut',
        onUpdate: () => world.camera.updateProjectionMatrix(),
      });
    }

    // 待機画面 専用のスイープ光: 商品板の手前を左→右へ実際に移動する点光源。
    // 位置で照らすので、各板が光の通過に合わせて順に明るくなる（PointLight=距離で減衰）。
    // この画面でだけ効かせたいので SELECT の enter/exit でライフサイクル管理する
    //（他画面=SHOOT/GENERATE/RESULT には足さない）。設定は scene.brandLight を毎フレーム参照。
    const bl = choreo.data.scene.brandLight ?? {};
    // PointLight(色, 強さ, 届く距離=減衰カットオフ, decay)。decay=2 で物理的な 1/d² 減衰。
    this.sweepLight = new THREE.PointLight(0xffffff, bl.sweepIntensity ?? 8, bl.sweepRange ?? 2.5, 2);
    this.sweepLight.position.set(0, bl.sweepHeight ?? -0.3, bl.sweepDistance ?? 2.9);
    world.scene.add(this.sweepLight);

    // 待機中はベース照明（key/fill/rim/hemi）を絞ってスイープ光を主役にする。
    // 常時強い一様光があると動くライトが埋もれて「動いて見えない」ため。
    // 元の強さを控えておき、毎フレーム baseDim 係数で反映（exit で復元）。
    this._baseLights = environment?.lights ? Object.values(environment.lights) : [];
    this._baseIntensities = this._baseLights.map((l) => l.intensity);

    // lookAt 維持（カメラは固定。ドリフトは廃止）＋ スイープ光を左→右へ走らせる
    this.tick = (_dt, elapsed) => {
      const c = choreo.data.scene.brandLight ?? {};
      // ベース照明を待機用に絞る（原値×係数なのでスライダーが即反映）
      const dim = c.baseDim ?? 0.4;
      this._baseLights.forEach((l, i) => { l.intensity = this._baseIntensities[i] * dim; });
      const light = this.sweepLight;
      light.visible = c.sweepEnabled !== false;
      light.intensity = c.sweepIntensity ?? 8;
      light.distance = c.sweepRange ?? 2.5; // 0=無限。範囲を絞るほど局所的に照らす
      const amp = c.sweepAmplitude ?? 2.2;
      const period = c.sweepPeriod ?? 5;
      // phase 0→1 を繰り返し、X を左(-amp)→右(+amp)へ直線移動（右端で左へ戻る）。
      // ラック幅より広く振らせ、両端では板の射程外に出るので戻りの瞬間が目立たない。
      const phase = (((elapsed / period) % 1) + 1) % 1;
      light.position.set(-amp + 2 * amp * phase, c.sweepHeight ?? -0.3, c.sweepDistance ?? 2.9);
      if (world.cameraLocked) return; // タイムラインプレビュー中はカメラを明け渡す
      world.camera.lookAt(camCfg.look[0], camCfg.look[1], camCfg.look[2]);
    };
    world.addTickable(this.tick);

    // 白フラッシュが残っていれば抜く（リザルト明け・強制リセット時）
    overlay.setWhite(false, payload.withReturn ? 0.5 : 0.3);

    // リザルトからの復帰時はボトルが左から順に、下から定位置へフレームイン
    if (payload.withReturn) {
      await bottleRack.returnFromBelow(this.bag);
    }

    keyboard.setHandler((key) => {
      if (this.selecting) return;
      const brand = brands.getByKey(key);
      if (brand) this._select(brand);
    });
  }

  async _select(brand) {
    const { bottleRack, manager, webcam, overlay, choreo } = this.ctx;
    this.selecting = true;
    console.log(`[Select] brand=${brand.slug}`);
    playSfx(this.ctx.choreo, 'select');
    // 選択演出中にWebカメラをウォームアップ → 色帯が捲れた瞬間にカメラが映る
    webcam.acquire().catch(() => {});

    const t = choreo.data.select.transition;
    // SHOOT 側がカメラの初回フレーム準備を整えたら解決される（帯はこれを待ってから流す）
    let signalCameraReady;
    const cameraReady = new Promise((res) => { signalCameraReady = res; });

    let bandDone = Promise.resolve();
    // step1（拡大＋左右フレームアウト）→ step2（色帯を下から立ち上げて通過させる）
    await bottleRack.selectAndFrameOut(brand.slug, this.bag, () => {
      // step2: ブランドカラーの帯が全画面を覆い、覆い切ったら SHOOT へ切替、
      // カメラ準備が整ってから（覆われている間に重いデコードを済ませて）上へ流れて去る
      bandDone = overlay.brandWipeUp(brand.themeColor, t.band, () => {
        manager.go('shoot', { brand, fromWipe: true, onReady: signalCameraReady });
        return cameraReady;
      });
    });
    await bandDone;
  }

  async exit() {
    const { world, keyboard, overlay } = this.ctx;
    keyboard.clearHandler();
    overlay.hideSelectGradient();
    if (this.tick) world.removeTickable(this.tick);
    // 待機専用スイープ光を撤去（他画面に持ち込まない）
    if (this.sweepLight) {
      world.scene.remove(this.sweepLight);
      this.sweepLight.dispose();
      this.sweepLight = null;
    }
    // 絞っていたベース照明を元の強さへ戻す（他画面へ持ち越さない）
    if (this._baseLights) {
      this._baseLights.forEach((l, i) => { l.intensity = this._baseIntensities[i]; });
      this._baseLights = null;
    }
    this.bag.disposeAll();
  }
}
