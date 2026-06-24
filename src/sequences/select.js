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
    const { world, overlay, keyboard, brands, choreo, bottleRack } = this.ctx;
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

    // lookAt 維持（カメラは固定。ドリフトは廃止）
    this.tick = () => {
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
    this.bag.disposeAll();
  }
}
