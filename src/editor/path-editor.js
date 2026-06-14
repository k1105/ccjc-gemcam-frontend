import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { buildCurve, kfPos, kfHandle } from '../core/camera-eval.js';

const _ndc = new THREE.Vector2();

const SELECTED_COLOR = 0xffd166;
const NORMAL_COLOR = 0xff4060;
const HANDLE_COLOR = 0x46d3ff;

/**
 * generate.phases のカメラパスを 3Dビューポート上で編集するツール。
 * - キーフレーム球（アンカー）をクリック選択 / TransformControls でドラッグ / 数値スライダー編集
 * - 各キーフレームは auto（CatmullRom 自動接線）/ manual（ベジェ in/out ハンドル）を切替可能。
 *   manual のキーフレームを選択するとビューポートに in/out ハンドル球＋接続線が出る。
 *   ハンドルもクリック選択してドラッグでき、アンカーからの相対デルタとして保存される。
 * - パス曲線の Line は camera-eval.buildCurve で生成（手動ハンドルがあればベジェ表示）。
 * - パス変更は onChanged コールバックで通知（タイムラインの自動リベイク用）。
 * "@current" キーフレームは実行時のカメラ位置に置換されるため編集対象外。
 *
 * データ形:
 *   auto   … [x,y,z]
 *   manual … { p:[x,y,z], hIn:[dx,dy,dz], hOut:[dx,dy,dz] }（hIn/hOut は p からの相対デルタ）
 */
export class PathEditor {
  constructor(ctx, parentGui) {
    this.ctx = ctx;
    this.gui = parentGui.addFolder('Camera Path (generate)');
    this.active = false;
    this.onChanged = null;

    // 選択対象: アンカー or ハンドル（side: 'in'|'out'）
    this.sel = { kind: 'anchor', side: null };

    this.state = {
      phaseId: this._phases()[0]?.id ?? '',
      keyframe: 0,
      manual: false,
      toggleManual: () => this._toggleManual(),
      preview: () => this._preview(),
      addKeyframe: () => this._addKeyframe(),
      removeKeyframe: () => this._removeKeyframe(),
    };

    this.viz = new THREE.Group();
    this.viz.visible = false;
    ctx.world.scene.add(this.viz);
    this.spheres = []; // アンカー球
    this.handles = []; // 選択中キーフレームの in/out ハンドル球
    this.handleLines = null; // ハンドル接続線
    this.line = null;
    this.kfControllers = [];

    this.tc = new TransformControls(ctx.world.camera, ctx.world.renderer.domElement);
    this.tcHelper = this.tc.getHelper();
    this.tcHelper.visible = false;
    ctx.world.scene.add(this.tcHelper);
    this.tc.enabled = false;
    this.tc.setSize(0.7);
    this.tc.addEventListener('objectChange', () => this._onGizmoChange());

    this.raycaster = new THREE.Raycaster();
    this._onPointerDown = (e) => this._pick(e);
    ctx.world.renderer.domElement.addEventListener('pointerdown', this._onPointerDown);

    this.phaseCtrl = this.gui
      .add(this.state, 'phaseId', this._phases().map((p) => p.id))
      .name('Phase')
      .onChange(() => this.rebuild());
    this.kfSelectCtrl = this.gui
      .add(this.state, 'keyframe', [0])
      .name('Edit keyframe')
      .onChange(() => this._selectAnchor());
    this.manualCtrl = this.gui
      .add(this.state, 'manual')
      .name('Bezier handles（選択KFを auto/manual）')
      .onChange(() => this._toggleManual());
    this.gui.add(this.state, 'preview').name('▶ Preview phase（実時間再生）');
    this.gui.add(this.state, 'addKeyframe').name('+ keyframe（選択の直後に挿入）');
    this.gui.add(this.state, 'removeKeyframe').name('− keyframe（選択を削除）');

    this.kfFolder = this.gui.addFolder('Keyframes');
    this.rebuild();
  }

  _phases() {
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

  /** 編集対象キーフレームの local 位置（'@current' は camera 実位置 − offset で近似） */
  _localPos(entry) {
    if (entry === '@current') {
      return this.ctx.world.camera.position.clone().sub(this._offset());
    }
    return kfPos(entry);
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

    this.kfFolder.destroy();
    this.kfFolder = this.gui.addFolder('Keyframes');
    this.kfControllers = [];

    phase.path.forEach((entry, i) => {
      if (entry === '@current') {
        const dummy = { info: '@current（実行時カメラ位置）' };
        this.kfFolder.add(dummy, 'info').name(`#${i}`).disable();
        return;
      }
      const pos = kfPos(entry);
      const proxy = { x: pos.x, y: pos.y, z: pos.z };
      const ctrls = ['x', 'y', 'z'].map((axis, ai) =>
        this.kfFolder
          .add(proxy, axis, -20, 20, 0.01)
          .name(`#${i}.${axis}`)
          .onChange((v) => {
            this._setAnchor(i, ai, v);
            this._syncSphere(i);
            if (i === this.state.keyframe) this._redrawHandles();
            this._rebuildLine();
            this.onChanged?.();
          })
      );
      this.kfControllers.push({ index: i, proxy, ctrls });
    });

    const editable = this.kfControllers.map((k) => k.index);
    this.state.keyframe = editable.includes(this.state.keyframe) ? this.state.keyframe : editable[0] ?? 0;
    this.kfSelectCtrl = this.kfSelectCtrl
      .options(editable.length ? editable : [0])
      .name('Edit keyframe')
      .onChange(() => this._selectAnchor());
    this.kfSelectCtrl.setValue(this.state.keyframe);

    this._rebuildViz();
    this._syncManualToggle();
  }

  /** path[i] のアンカー軸を書き込む（auto=配列 / manual=オブジェクト両対応） */
  _setAnchor(i, axis, v) {
    const entry = this._currentPhase().path[i];
    const r = Number(v.toFixed(3));
    if (Array.isArray(entry)) entry[axis] = r;
    else entry.p[axis] = r;
  }

  _isManual(entry) {
    return !!(kfHandle(entry, 'hIn') || kfHandle(entry, 'hOut'));
  }

  _syncManualToggle() {
    const entry = this._currentPhase()?.path[this.state.keyframe];
    const isKf = entry && entry !== '@current';
    this.state.manual = isKf ? this._isManual(entry) : false;
    this.manualCtrl?.updateDisplay();
    this.manualCtrl?.enable(!!isKf);
  }

  // ---- 可視化 ----

  _rebuildViz() {
    for (const s of this.spheres) {
      this.viz.remove(s);
      s.geometry.dispose();
      s.material.dispose();
    }
    this.spheres = [];

    const phase = this._currentPhase();
    const offset = this._offset();

    phase.path.forEach((entry, i) => {
      if (entry === '@current') return;
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 16, 12),
        new THREE.MeshBasicMaterial({ color: NORMAL_COLOR, depthTest: false, transparent: true })
      );
      sphere.renderOrder = 999;
      sphere.position.copy(kfPos(entry)).add(offset);
      sphere.userData = { kind: 'anchor', kfIndex: i };
      this.viz.add(sphere);
      this.spheres.push(sphere);
    });

    this._rebuildLine();
    this._rebuildHandles();
    this._attachGizmo();
  }

  _rebuildLine() {
    if (this.line) {
      this.viz.remove(this.line);
      this.line.geometry.dispose();
      this.line.material.dispose();
      this.line = null;
    }
    const phase = this._currentPhase();
    if (phase.path.length < 2) return;
    const curve = buildCurve(
      phase.path,
      this._offset(),
      phase.closed === true,
      this.ctx.world.camera.position
    );
    const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(160));
    const mat = new THREE.LineBasicMaterial({ color: 0x3070ff, depthTest: false, transparent: true });
    this.line = new THREE.Line(geo, mat);
    this.line.renderOrder = 998;
    this.viz.add(this.line);
  }

  /** 選択中キーフレームが manual のとき in/out ハンドル球＋接続線を描く */
  _rebuildHandles() {
    for (const h of this.handles) {
      this.viz.remove(h);
      h.geometry.dispose();
      h.material.dispose();
    }
    this.handles = [];
    if (this.handleLines) {
      this.viz.remove(this.handleLines);
      this.handleLines.geometry.dispose();
      this.handleLines.material.dispose();
      this.handleLines = null;
    }

    const phase = this._currentPhase();
    const i = this.state.keyframe;
    const entry = phase.path[i];
    if (!entry || entry === '@current' || !this._isManual(entry)) return;

    const offset = this._offset();
    const anchorW = kfPos(entry).add(offset);
    const linePts = [];

    for (const side of ['in', 'out']) {
      const key = side === 'in' ? 'hIn' : 'hOut';
      const h = kfHandle(entry, key);
      if (!h) continue;
      const handleW = anchorW.clone().add(h);
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.045, 12, 10),
        new THREE.MeshBasicMaterial({ color: HANDLE_COLOR, depthTest: false, transparent: true })
      );
      sphere.renderOrder = 1000;
      sphere.position.copy(handleW);
      sphere.userData = { kind: 'handle', kfIndex: i, side };
      this.viz.add(sphere);
      this.handles.push(sphere);
      linePts.push(anchorW.clone(), handleW.clone());
    }

    if (linePts.length) {
      this.handleLines = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(linePts),
        new THREE.LineBasicMaterial({ color: HANDLE_COLOR, depthTest: false, transparent: true, opacity: 0.7 })
      );
      this.handleLines.renderOrder = 997;
      this.viz.add(this.handleLines);
    }
  }

  /**
   * ドラッグ中の軽量更新: 既存ハンドル球を data から再配置し接続線だけ作り直す。
   * 球を dispose しないので tc がアタッチ中の球を壊さない。
   */
  _redrawHandles() {
    const phase = this._currentPhase();
    const entry = phase.path[this.state.keyframe];
    if (!entry || entry === '@current' || !this._isManual(entry)) return;
    const anchorW = kfPos(entry).add(this._offset());
    const linePts = [];
    for (const h of this.handles) {
      const hd = kfHandle(entry, h.userData.side === 'in' ? 'hIn' : 'hOut');
      if (!hd) continue;
      h.position.copy(anchorW).add(hd);
      linePts.push(anchorW.clone(), h.position.clone());
    }
    if (this.handleLines) {
      this.handleLines.geometry.dispose();
      this.handleLines.geometry = new THREE.BufferGeometry().setFromPoints(linePts);
    }
  }

  _sphereFor(index) {
    return this.spheres.find((s) => s.userData.kfIndex === index);
  }

  _handleFor(side) {
    return this.handles.find((h) => h.userData.side === side);
  }

  _syncSphere(index) {
    const phase = this._currentPhase();
    const sphere = this._sphereFor(index);
    if (!sphere) return;
    sphere.position.copy(kfPos(phase.path[index])).add(this._offset());
  }

  /** 現在の選択（アンカー/ハンドル）に応じてギズモを付け替え、色を更新 */
  _attachGizmo() {
    let obj = null;
    if (this.sel.kind === 'handle') obj = this._handleFor(this.sel.side);
    if (!obj) {
      this.sel = { kind: 'anchor', side: null };
      obj = this._sphereFor(this.state.keyframe);
    }
    if (obj && this.active) {
      this.tc.attach(obj);
      this.tcHelper.visible = true;
    } else {
      this.tc.detach();
      this.tcHelper.visible = false;
    }
    for (const s of this.spheres) {
      s.material.color.setHex(
        s.userData.kfIndex === this.state.keyframe ? SELECTED_COLOR : NORMAL_COLOR
      );
    }
  }

  /** ビューポートクリックでアンカー/ハンドル球を選択（ギズモ操作とは排他） */
  _pick(e) {
    if (!this.active || e.button !== 0) return;
    if (this.tc.axis) return;
    const targets = [...this.handles, ...this.spheres]; // ハンドル優先
    if (!targets.length) return;
    const rect = this.ctx.world.renderer.domElement.getBoundingClientRect();
    _ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(_ndc, this.ctx.world.camera);
    const hits = this.raycaster.intersectObjects(targets, false);
    if (!hits.length) return;
    const ud = hits[0].object.userData;
    if (ud.kind === 'handle') {
      this.sel = { kind: 'handle', side: ud.side };
      this._attachGizmo();
    } else {
      this.kfSelectCtrl.setValue(ud.kfIndex); // onChange → _selectAnchor
    }
  }

  /** Edit keyframe ドロップダウン or アンカークリック時 */
  _selectAnchor() {
    this.sel = { kind: 'anchor', side: null };
    this._rebuildHandles();
    this._attachGizmo();
    this._syncManualToggle();
  }

  /** 外部（タイムラインの◆クリック等）からの選択 */
  selectKeyframe(phaseId, kfIndex) {
    if (this.state.phaseId !== phaseId) {
      if (!this._phases().some((p) => p.id === phaseId)) return;
      this.phaseCtrl.setValue(phaseId);
    }
    this.kfSelectCtrl.setValue(kfIndex);
  }

  /** 選択キーフレームの auto ⇄ manual を切替 */
  _toggleManual() {
    const phase = this._currentPhase();
    const i = this.state.keyframe;
    const entry = phase.path[i];
    if (!entry || entry === '@current') {
      this._syncManualToggle();
      return;
    }
    const wantManual = this.state.manual;
    const isManual = this._isManual(entry);
    if (wantManual === isManual) return;

    if (wantManual) {
      // auto → manual: 自動接線からハンドルを初期化（見た目が飛ばない）
      const t = this._autoTangent(i);
      const pos = kfPos(entry);
      phase.path[i] = {
        p: [pos.x, pos.y, pos.z].map((v) => Number(v.toFixed(3))),
        hIn: [-t.x / 3, -t.y / 3, -t.z / 3].map((v) => Number(v.toFixed(3))),
        hOut: [t.x / 3, t.y / 3, t.z / 3].map((v) => Number(v.toFixed(3))),
      };
    } else {
      // manual → auto: 配列へ戻す
      const pos = kfPos(entry);
      phase.path[i] = [pos.x, pos.y, pos.z].map((v) => Number(v.toFixed(3)));
    }
    this.sel = { kind: 'anchor', side: null };
    this._rebuildHandles();
    this._rebuildLine();
    this._attachGizmo();
    this.onChanged?.();
  }

  /** uniform Catmull-Rom 自動接線 t_i = (P[i+1]-P[i-1])/2（local 座標、camera-eval と同式） */
  _autoTangent(i) {
    const path = this._currentPhase().path;
    const n = path.length;
    const prev = this._localPos(path[i - 1] ?? path[i]);
    const next = this._localPos(path[i + 1] ?? path[i]);
    return next.sub(prev).multiplyScalar(0.5);
  }

  _onGizmoChange() {
    const obj = this.tc.object;
    if (!obj) return;
    const ud = obj.userData;
    const phase = this._currentPhase();
    const offset = this._offset();

    if (ud.kind === 'handle') {
      const entry = phase.path[ud.kfIndex];
      const anchorW = kfPos(entry).add(offset);
      const delta = obj.position.clone().sub(anchorW);
      const key = ud.side === 'in' ? 'hIn' : 'hOut';
      entry[key] = [
        Number(delta.x.toFixed(3)),
        Number(delta.y.toFixed(3)),
        Number(delta.z.toFixed(3)),
      ];
      this._redrawHandles(); // 接続線のみ更新（球は tc が動かしているので作り直さない）
      this._rebuildLine();
      this.onChanged?.();
      return;
    }

    // アンカー移動
    const i = ud.kfIndex;
    const entry = phase.path[i];
    const local = obj.position.clone().sub(offset);
    const p = [Number(local.x.toFixed(3)), Number(local.y.toFixed(3)), Number(local.z.toFixed(3))];
    if (Array.isArray(entry)) phase.path[i] = p;
    else entry.p = p;

    const ctl = this.kfControllers.find((k) => k.index === i);
    if (ctl) {
      ctl.proxy.x = p[0];
      ctl.proxy.y = p[1];
      ctl.proxy.z = p[2];
      ctl.ctrls.forEach((c) => c.updateDisplay());
    }
    this._redrawHandles(); // ハンドル球はアンカー相対なので追従（dispose せず再配置）
    this._rebuildLine();
    this.onChanged?.();
  }

  /** 選択キーフレームの直後に挿入（次点との中点。末尾なら少し先へ）。auto で挿入 */
  _addKeyframe() {
    const phase = this._currentPhase();
    const i = this.state.keyframe;
    const cur = this._localPos(phase.path[i]);
    const nextEntry = phase.path[i + 1];
    const dup = nextEntry
      ? cur.clone().lerp(this._localPos(nextEntry), 0.5)
      : cur.clone().add(new THREE.Vector3(0.3, 0, 0));
    phase.path.splice(i + 1, 0, [dup.x, dup.y, dup.z].map((v) => Number(v.toFixed(3))));
    this.state.keyframe = i + 1;
    this.sel = { kind: 'anchor', side: null };
    this.rebuild();
    this.onChanged?.();
  }

  _removeKeyframe() {
    const phase = this._currentPhase();
    const editableCount = phase.path.filter((p) => p !== '@current').length;
    if (phase.path.length <= 2 || editableCount <= 1) return;
    const i = this.state.keyframe;
    if (phase.path[i] === '@current') return;
    phase.path.splice(i, 1);
    this.state.keyframe = Math.max(0, i - 1);
    this.sel = { kind: 'anchor', side: null };
    this.rebuild();
    this.onChanged?.();
  }

  /** phase 単体プレビュー */
  _preview() {
    const { director, manager, choreo } = this.ctx;
    const phase = this._currentPhase();
    if (!phase) return;

    if (!manager.is('generate')) {
      const g = choreo.data.generate;
      const scale = g.bottleScale ?? 1.6;
      const bottleCenter = new THREE.Vector3(...g.bottlePos).add(new THREE.Vector3(0, 0.4 * scale, 0));
      director.registerTarget('bottle', (out) => out.copy(bottleCenter));
      director.registerTarget('heroParticle', (out) => out.copy(bottleCenter));
    }

    if (phase.type === 'loop') {
      const hold = director.playLoop(phase);
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
    for (const h of this.handles) {
      h.geometry.dispose();
      h.material.dispose();
    }
    if (this.handleLines) {
      this.handleLines.geometry.dispose();
      this.handleLines.material.dispose();
    }
    if (this.line) {
      this.line.geometry.dispose();
      this.line.material.dispose();
    }
  }
}
