import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const _ndc = new THREE.Vector2();

const SELECTED_COLOR = 0xffd166;
const NORMAL_COLOR = 0xff4060;

/**
 * generate.phases のカメラパス（CatmullRom キーフレーム）を
 * 3Dビューポート上で編集するツール。
 * - キーフレーム球をビューポートで直接クリックして選択（ドロップダウンと双方向同期）
 * - キーフレーム球の TransformControls ドラッグ / 数値スライダーの双方向編集
 * - パス曲線の Line 可視化
 * - phase 単体のプレビュー再生（フレーム単位はタイムラインエディタで）
 * - パス変更は onChanged コールバックで通知（タイムラインの自動リベイク用）
 * "@current" キーフレームは実行時のカメラ位置に置換されるため編集対象外。
 */
export class PathEditor {
  constructor(ctx, parentGui) {
    this.ctx = ctx;
    this.gui = parentGui.addFolder('Camera Path (generate)');
    this.active = false;
    this.onChanged = null; // パス変更通知（editor.js が接続）

    this.state = {
      phaseId: this._phases()[0]?.id ?? '',
      keyframe: 0,
      preview: () => this._preview(),
      addKeyframe: () => this._addKeyframe(),
      removeKeyframe: () => this._removeKeyframe(),
    };

    this.viz = new THREE.Group();
    this.viz.visible = false;
    ctx.world.scene.add(this.viz);
    this.spheres = [];
    this.line = null;
    this.kfControllers = []; // [{proxy, ctrls, index}]

    this.tc = new TransformControls(ctx.world.camera, ctx.world.renderer.domElement);
    this.tcHelper = this.tc.getHelper();
    this.tcHelper.visible = false;
    ctx.world.scene.add(this.tcHelper);
    this.tc.enabled = false;
    this.tc.setSize(0.7);
    this.tc.addEventListener('objectChange', () => this._onGizmoChange());

    // ビューポートでキーフレーム球を直接クリックして選択
    this.raycaster = new THREE.Raycaster();
    this._onPointerDown = (e) => this._pickSphere(e);
    ctx.world.renderer.domElement.addEventListener('pointerdown', this._onPointerDown);

    this.phaseCtrl = this.gui
      .add(this.state, 'phaseId', this._phases().map((p) => p.id))
      .name('Phase')
      .onChange(() => this.rebuild());
    this.kfSelectCtrl = this.gui
      .add(this.state, 'keyframe', [0])
      .name('Edit keyframe')
      .onChange(() => this._attachGizmo());
    this.gui.add(this.state, 'preview').name('▶ Preview phase（実時間再生）');
    this.gui.add(this.state, 'addKeyframe').name('+ keyframe（選択の直後に挿入）');
    this.gui.add(this.state, 'removeKeyframe').name('− keyframe（選択を削除）');

    this.kfFolder = this.gui.addFolder('Keyframes');
    this.rebuild();
  }

  _phases() {
    // パスを持つ phase のみ編集対象（type:"follow" は数値パラメータのみ→Parameters側で編集）
    return this.ctx.choreo.data.generate.phases.filter((p) => Array.isArray(p.path));
  }

  _currentPhase() {
    return this._phases().find((p) => p.id === this.state.phaseId);
  }

  /** relativeTo を解決したワールドオフセット */
  _offset() {
    const phase = this._currentPhase();
    if (phase?.relativeTo !== 'bottle') return new THREE.Vector3();
    const g = this.ctx.choreo.data.generate;
    const scale = g.bottleScale ?? 1.6;
    return new THREE.Vector3(...g.bottlePos).add(new THREE.Vector3(0, 0.4 * scale, 0));
  }

  setActive(active) {
    this.active = active;
    this.viz.visible = active;
    this.tc.enabled = active;
    this.tcHelper.visible = active && !!this.tc.object;
    if (active) this.rebuild();
  }

  /** phase 切替・import 後などの全再構築 */
  rebuild() {
    const phase = this._currentPhase();
    if (!phase) return;

    // --- キーフレーム数値コントローラ再構築（フォルダごと作り直すのが確実） ---
    this.kfFolder.destroy();
    this.kfFolder = this.gui.addFolder('Keyframes');
    this.kfControllers = [];

    phase.path.forEach((p, i) => {
      if (p === '@current') {
        const dummy = { info: '@current（実行時カメラ位置）' };
        this.kfFolder.add(dummy, 'info').name(`#${i}`).disable();
        return;
      }
      const proxy = { x: p[0], y: p[1], z: p[2] };
      const ctrls = ['x', 'y', 'z'].map((axis, ai) =>
        this.kfFolder
          .add(proxy, axis, -20, 20, 0.01)
          .name(`#${i}.${axis}`)
          .onChange((v) => {
            p[ai] = v;
            this._syncSphere(i);
            this._rebuildLine();
            this.onChanged?.();
          })
      );
      this.kfControllers.push({ index: i, proxy, ctrls });
    });

    // 編集対象キーフレームの選択肢を更新
    const editable = this.kfControllers.map((k) => k.index);
    this.state.keyframe = editable.includes(this.state.keyframe) ? this.state.keyframe : editable[0] ?? 0;
    this.kfSelectCtrl = this.kfSelectCtrl
      .options(editable.length ? editable : [0])
      .name('Edit keyframe')
      .onChange(() => this._attachGizmo());
    this.kfSelectCtrl.setValue(this.state.keyframe);

    this._rebuildViz();
  }

  _rebuildViz() {
    // 既存の可視化を破棄
    for (const s of this.spheres) {
      this.viz.remove(s);
      s.geometry.dispose();
      s.material.dispose();
    }
    this.spheres = [];
    if (this.line) {
      this.viz.remove(this.line);
      this.line.geometry.dispose();
      this.line.material.dispose();
      this.line = null;
    }

    const phase = this._currentPhase();
    const offset = this._offset();

    phase.path.forEach((p, i) => {
      if (p === '@current') return;
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 16, 12),
        new THREE.MeshBasicMaterial({ color: NORMAL_COLOR, depthTest: false, transparent: true })
      );
      sphere.renderOrder = 999;
      sphere.position.set(p[0], p[1], p[2]).add(offset);
      sphere.userData.kfIndex = i;
      this.viz.add(sphere);
      this.spheres.push(sphere);
    });

    this._rebuildLine();
    this._attachGizmo();
  }

  _resolvedPoints() {
    const phase = this._currentPhase();
    const offset = this._offset();
    return phase.path.map((p) => {
      if (p === '@current') return this.ctx.world.camera.position.clone();
      return new THREE.Vector3(p[0], p[1], p[2]).add(offset);
    });
  }

  _rebuildLine() {
    if (this.line) {
      this.viz.remove(this.line);
      this.line.geometry.dispose();
      this.line.material.dispose();
      this.line = null;
    }
    const phase = this._currentPhase();
    const pts = this._resolvedPoints();
    if (pts.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(pts, phase.closed === true, 'centripetal');
    const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(120));
    const mat = new THREE.LineBasicMaterial({ color: 0x3070ff, depthTest: false, transparent: true });
    this.line = new THREE.Line(geo, mat);
    this.line.renderOrder = 998;
    this.viz.add(this.line);
  }

  _sphereFor(index) {
    return this.spheres.find((s) => s.userData.kfIndex === index);
  }

  _syncSphere(index) {
    const phase = this._currentPhase();
    const sphere = this._sphereFor(index);
    if (!sphere) return;
    const p = phase.path[index];
    sphere.position.set(p[0], p[1], p[2]).add(this._offset());
  }

  _attachGizmo() {
    const sphere = this._sphereFor(this.state.keyframe);
    if (sphere && this.active) {
      this.tc.attach(sphere);
      this.tcHelper.visible = true;
    } else {
      this.tc.detach();
      this.tcHelper.visible = false;
    }
    // 選択中キーフレームをハイライト
    for (const s of this.spheres) {
      s.material.color.setHex(
        s.userData.kfIndex === this.state.keyframe ? SELECTED_COLOR : NORMAL_COLOR
      );
    }
  }

  /** ビューポートクリックでキーフレーム球を選択（ギズモ操作とは排他） */
  _pickSphere(e) {
    if (!this.active || e.button !== 0 || !this.spheres.length) return;
    if (this.tc.axis) return; // ギズモのハンドル上ではドラッグを優先
    const rect = this.ctx.world.renderer.domElement.getBoundingClientRect();
    _ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(_ndc, this.ctx.world.camera);
    const hits = this.raycaster.intersectObjects(this.spheres, false);
    if (!hits.length) return;
    this.kfSelectCtrl.setValue(hits[0].object.userData.kfIndex);
  }

  /** 外部（タイムラインの◆クリック等）からの選択 */
  selectKeyframe(phaseId, kfIndex) {
    if (this.state.phaseId !== phaseId) {
      if (!this._phases().some((p) => p.id === phaseId)) return;
      this.phaseCtrl.setValue(phaseId); // onChange 経由で rebuild
    }
    this.kfSelectCtrl.setValue(kfIndex);
  }

  _onGizmoChange() {
    const sphere = this.tc.object;
    if (!sphere) return;
    const i = sphere.userData.kfIndex;
    const phase = this._currentPhase();
    const local = sphere.position.clone().sub(this._offset());
    phase.path[i] = [
      Number(local.x.toFixed(3)),
      Number(local.y.toFixed(3)),
      Number(local.z.toFixed(3)),
    ];
    // 数値コントローラへ反映
    const entry = this.kfControllers.find((k) => k.index === i);
    if (entry) {
      entry.proxy.x = phase.path[i][0];
      entry.proxy.y = phase.path[i][1];
      entry.proxy.z = phase.path[i][2];
      entry.ctrls.forEach((c) => c.updateDisplay());
    }
    this._rebuildLine();
    this.onChanged?.();
  }

  /** 選択キーフレームの直後に挿入（次点との中点。末尾なら少し先へ） */
  _addKeyframe() {
    const phase = this._currentPhase();
    const i = this.state.keyframe;
    const cur = phase.path[i];
    if (!Array.isArray(cur)) return;
    const next = phase.path[i + 1];
    const dup = Array.isArray(next)
      ? [(cur[0] + next[0]) / 2, (cur[1] + next[1]) / 2, (cur[2] + next[2]) / 2]
      : [cur[0] + 0.3, cur[1], cur[2]];
    phase.path.splice(i + 1, 0, dup.map((v) => Number(v.toFixed(3))));
    this.state.keyframe = i + 1;
    this.rebuild();
    this.onChanged?.();
  }

  /** 選択キーフレームを削除 */
  _removeKeyframe() {
    const phase = this._currentPhase();
    const editableCount = phase.path.filter((p) => p !== '@current').length;
    if (phase.path.length <= 2 || editableCount <= 1) return;
    const i = this.state.keyframe;
    if (phase.path[i] === '@current') return;
    phase.path.splice(i, 1);
    this.state.keyframe = Math.max(0, i - 1); // rebuild が編集可能index へ補正する
    this.rebuild();
    this.onChanged?.();
  }

  /** phase 単体プレビュー（generate 実行中でなければ仮ターゲットを登録） */
  _preview() {
    const { director, manager, choreo } = this.ctx;
    const phase = this._currentPhase();
    if (!phase) return;

    if (!manager.is('generate')) {
      const g = choreo.data.generate;
      const scale = g.bottleScale ?? 1.6;
      const bottleCenter = new THREE.Vector3(...g.bottlePos).add(
        new THREE.Vector3(0, 0.4 * scale, 0)
      );
      director.registerTarget('bottle', (out) => out.copy(bottleCenter));
      director.registerTarget('heroParticle', (out) => out.copy(bottleCenter));
    }

    if (phase.type === 'loop') {
      const hold = director.playLoop(phase);
      // ループは3秒見せて release
      setTimeout(() => hold.release(), 3000);
    } else {
      director.playPhase(phase);
    }
  }

  dispose() {
    this.ctx.world.renderer.domElement.removeEventListener('pointerdown', this._onPointerDown);
    this.tc.detach();
    this.tc.dispose();
    this.ctx.world.scene.remove(this.tcHelper);
    this.ctx.world.scene.remove(this.viz);
    for (const s of this.spheres) {
      s.geometry.dispose();
      s.material.dispose();
    }
    if (this.line) {
      this.line.geometry.dispose();
      this.line.material.dispose();
    }
  }
}
