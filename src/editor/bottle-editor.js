import * as THREE from 'three';

/**
 * 待機（SELECT）画面専用の「飲料 個別調整」ツール（エディタ専用）。
 *
 * エディタを開いて待機タブをプレビュー中、キャンバス上のボトルをクリックすると
 * そのバウンディングボックスを表示し、サイズ（scale）とベースライン（baselineY）を
 * 飲料ごとに個別オーバーライド編集できる。値は
 * choreo.data.select.rack.overrides[slug] = { scale, baselineY } に保存される。
 *
 * 適用は BottleRack.applyOverrides() が内側の model に効かせる（spin の選択強調
 * scale とは独立）。値は通常の choreo 編集と同じく undo / localStorage 保存される。
 */
export class BottleEditor {
  constructor(ctx, { onChange } = {}) {
    this.ctx = ctx;
    this.onChange = onChange || (() => {});
    this.active = false;
    this.selectedSlug = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.boxHelper = null; // 選択中ボトルのバウンディングボックス（world.scene 常駐）
    this.folder = null; // attach で受け取る親フォルダ（待機タブ）
    this.editFolder = null; // 選択中ボトルの編集フォルダ（選択ごとに作り直す）
    this._mrCtrl = null; // marginRight コントローラ（キー操作で updateDisplay する）
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  /** Editor の「待機」フォルダ配下に UI を作る（タブ表示と一緒に出し入れされる） */
  attach(parentFolder) {
    this.folder = parentFolder.addFolder('飲料 個別調整');
    this.folder.add({ hint: 'クリック/←→で選択' }, 'hint').name('選択').disable();
    this.folder.add({ hint: 'option+←→で右マージン' }, 'hint').name('調整').disable();
    this.folder.open();
  }

  /** 待機プレビュー中のみ true。クリック選択を受け付ける */
  setActive(on) {
    if (on === this.active) return;
    this.active = on;
    const canvas = this.ctx.world.renderer.domElement;
    if (on) {
      canvas.addEventListener('pointerdown', this._onPointerDown);
      window.addEventListener('keydown', this._onKeyDown);
    } else {
      canvas.removeEventListener('pointerdown', this._onPointerDown);
      window.removeEventListener('keydown', this._onKeyDown);
      this._clearSelection();
    }
  }

  /**
   * 左右キー操作:
   *  - 修飾なし → アクティブ飲料を前/次へ切り替え（端で止まる）
   *  - option(alt)+左右 → 選択中ボトルの marginRight を増減（既定 0.01 / shift で 0.1）
   * lil-gui の入力欄にフォーカス中は邪魔しない。
   */
  _onKeyDown(e) {
    if (!this.active) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const dir = e.key === 'ArrowRight' ? 1 : -1;

    if (e.altKey) {
      if (!this.selectedSlug) return;
      e.preventDefault();
      const ov = this._ensureOverride(this.selectedSlug);
      const step = (e.shiftKey ? 0.1 : 0.01) * dir;
      // 浮動小数の累積誤差を抑えて 0.001 刻みに丸める
      ov.marginRight = Math.round((ov.marginRight + step) * 1000) / 1000;
      this._mrCtrl?.updateDisplay();
      this.onChange(); // 再配置（applyLayout）＋ undo/保存
      this._refreshBox();
    } else {
      e.preventDefault();
      this._cycleSelection(dir);
    }
  }

  /** アクティブ飲料を index 順に dir（±1）だけ送る。未選択なら端から開始 */
  _cycleSelection(dir) {
    const list = this.ctx.brands.list;
    if (!list.length) return;
    let idx;
    if (!this.selectedSlug) {
      idx = dir > 0 ? 0 : list.length - 1;
    } else {
      const cur = list.findIndex((b) => b.slug === this.selectedSlug);
      idx = Math.max(0, Math.min(list.length - 1, cur + dir));
    }
    this._select(list[idx].slug);
  }

  _onPointerDown(e) {
    const canvas = this.ctx.world.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.ctx.world.camera);
    const hits = this.raycaster.intersectObjects(this.ctx.bottleRack.group.children, true);
    if (!hits.length) {
      this._clearSelection();
      return;
    }
    // ヒットしたメッシュから slug を持つ祖先（root）まで辿る
    let o = hits[0].object;
    while (o && o.userData.slug === undefined) o = o.parent;
    if (!o) {
      this._clearSelection();
      return;
    }
    this._select(o.userData.slug);
  }

  _select(slug) {
    const entry = this.ctx.bottleRack.bottles.get(slug);
    if (!entry) return;
    this.selectedSlug = slug;
    // バウンディングボックス（無ければ生成、あれば対象だけ張り替える）
    if (!this.boxHelper) {
      this.boxHelper = new THREE.BoxHelper(entry.root, 0x2c6cff);
      this.boxHelper.material.depthTest = false; // ボトルに隠れず常に見える
      this.boxHelper.renderOrder = 999;
      this.ctx.world.scene.add(this.boxHelper);
    } else {
      this.boxHelper.setFromObject(entry.root);
      this.boxHelper.visible = true;
    }
    this._refreshBox();
    this._buildEditFolder(slug);
  }

  _buildEditFolder(slug) {
    if (this.editFolder) {
      this.editFolder.destroy();
      this.editFolder = null;
    }
    const ov = this._ensureOverride(slug);
    const brand = this.ctx.brands.getBySlug(slug);
    const label = brand?.label ?? slug;
    const refresh = () => {
      this.onChange(); // applyLayout（再配置＋overrides）＋ undo/保存
      this._refreshBox();
    };
    this.editFolder = this.folder.addFolder(`◉ ${label}`);
    this.editFolder.add(ov, 'scale', 0.3, 2.0, 0.01).name('サイズ').onChange(refresh);
    this.editFolder.add(ov, 'baselineY', -0.5, 0.5, 0.005).name('ベースライン').onChange(refresh);
    this._mrCtrl = this.editFolder
      .add(ov, 'marginRight', -0.4, 1.0, 0.005)
      .name('右マージン（option+←→）')
      .onChange(refresh);
    this.editFolder
      .add(
        {
          reset: () => {
            ov.scale = 1;
            ov.baselineY = 0;
            ov.marginRight = 0;
            this.editFolder.controllersRecursive().forEach((c) => c.updateDisplay());
            refresh();
          },
        },
        'reset'
      )
      .name('リセット（等倍・0へ）');
    this.editFolder.open();
  }

  /** overrides[slug] を { scale, baselineY, marginRight } として確実に用意する */
  _ensureOverride(slug) {
    const rack = this.ctx.choreo.data.select.rack;
    if (!rack.overrides) rack.overrides = {};
    const o = rack.overrides[slug] || (rack.overrides[slug] = {});
    if (typeof o.scale !== 'number') o.scale = 1;
    if (typeof o.baselineY !== 'number') o.baselineY = 0;
    if (typeof o.marginRight !== 'number') o.marginRight = 0;
    return o;
  }

  /** ボックスを現在の選択ボトルの最新バウンディングに合わせ直す */
  _refreshBox() {
    if (!this.boxHelper || !this.selectedSlug) return;
    const entry = this.ctx.bottleRack.bottles.get(this.selectedSlug);
    if (!entry) return;
    entry.root.updateWorldMatrix(true, true);
    this.boxHelper.setFromObject(entry.root);
    this.boxHelper.update();
  }

  /** undo/redo 後など、現在の選択の編集フォルダ・ボックスを作り直す */
  refresh() {
    if (this.selectedSlug) this._select(this.selectedSlug);
  }

  _clearSelection() {
    this.selectedSlug = null;
    this._mrCtrl = null;
    if (this.boxHelper) this.boxHelper.visible = false;
    if (this.editFolder) {
      this.editFolder.destroy();
      this.editFolder = null;
    }
  }

  dispose() {
    this.setActive(false);
    if (this.boxHelper) {
      this.ctx.world.scene.remove(this.boxHelper);
      this.boxHelper.geometry?.dispose();
      this.boxHelper.material?.dispose();
      this.boxHelper = null;
    }
  }
}
