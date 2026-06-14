import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { buildCurve, kfPos, kfHandle } from '../core/camera-eval.js';

const _ndc = new THREE.Vector2();

const SELECTED_COLOR = 0xffd166;
const NORMAL_COLOR = 0xff4060;
const HANDLE_COLOR = 0x46d3ff;
const AIM_COLOR = 0x7cffb0; // 注視点(look)オーバーライド

/**
 * generate.phases のカメラパスを 3Dビューポート上で編集するツール。
 * - 位置キーフレーム（アンカー）: クリック選択 / TransformControls ドラッグ / 数値編集
 * - ベジェ: 各キーフレームを auto（CatmullRom自動接線）/ manual（in/out ハンドル）で切替
 * - 注視点(look)オーバーライド: 各キーフレームに任意で注視点を持たせられる。緑のポインタ球を
 *   ビューポートでドラッグして「このキーフレーム付近ではここを見る」を指定。カメラが
 *   キーフレーム間を進むのに合わせて注視点が補間される（look 未指定のキーはフェーズ既定 lookAt）。
 * - 曲線/向きの評価は camera-eval（本番と共通）。パス変更は onChanged で通知（タイムライン自動リベイク）。
 * "@current" キーフレームは実行時カメラ位置に置換されるため編集対象外。
 *
 * データ形:
 *   auto              … [x,y,z]
 *   manual / look付き  … { p:[x,y,z], hIn?, hOut?, look?:[lx,ly,lz] }
 */
export class PathEditor {
  constructor(ctx, parentGui) {
    this.ctx = ctx;
    this.gui = parentGui.addFolder('Camera Path (generate)');
    this.active = false;
    this.onChanged = null;

    this.sel = { kind: 'anchor', side: null }; // 'anchor' | 'handle'(side) | 'aim'

    this.state = {
      phaseId: this._phases()[0]?.id ?? '',
      keyframe: 0,
      manual: false,
      lookOverride: false,
      preview: () => this._preview(),
      addKeyframe: () => this._addKeyframe(),
      removeKeyframe: () => this._removeKeyframe(),
    };

    this.viz = new THREE.Group();
    this.viz.visible = false;
    ctx.world.scene.add(this.viz);
    this.spheres = []; // アンカー球
    this.handles = []; // 選択中KFの in/out ハンドル球
    this.handleLines = null;
    this.line = null; // パス曲線
    this.aimSphere = null; // 選択中KFの注視点ポインタ
    this.aimLine = null; // KF位置→注視点 の線
    this.kfPanel = null;

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
    this.lookCtrl = this.gui
      .add(this.state, 'lookOverride')
      .name('look override（選択KFの注視点）')
      .onChange(() => this._toggleLookOverride());
    this.gui.add(this.state, 'preview').name('▶ Preview phase（実時間再生）');
    this.gui.add(this.state, 'addKeyframe').name('+ keyframe（選択の直後に挿入）');
    this.gui.add(this.state, 'removeKeyframe').name('− keyframe（選択を削除）');

    this.kfFolder = this.gui.addFolder('Selected keyframe');
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

  _localPos(entry) {
    if (entry === '@current') {
      return this.ctx.world.camera.position.clone().sub(this._offset());
    }
    return kfPos(entry);
  }

  _isManual(entry) {
    return !!(kfHandle(entry, 'hIn') || kfHandle(entry, 'hOut'));
  }

  _hasLook(entry) {
    return !!(entry && entry !== '@current' && !Array.isArray(entry) && Array.isArray(entry.look));
  }

  /** フェーズ既定 lookAt の点（look override 初期値） */
  _defaultAimPoint() {
    const lc = this._currentPhase()?.lookAt;
    const p = Array.isArray(lc?.point) ? lc.point : [0, 0.5, 0];
    return p.map((v) => Number(v.toFixed(3)));
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

    const editable = phase.path.map((e, i) => (e === '@current' ? -1 : i)).filter((i) => i >= 0);
    this.state.keyframe = editable.includes(this.state.keyframe) ? this.state.keyframe : editable[0] ?? 0;
    this.sel = { kind: 'anchor', side: null };

    this.kfSelectCtrl = this.kfSelectCtrl
      .options(editable.length ? editable : [0])
      .name('Edit keyframe')
      .onChange(() => this._selectAnchor());
    this.kfSelectCtrl.updateDisplay();

    this._rebuildViz();
    this._buildKfPanel();
    this._syncToggles();
  }

  /** 選択KFの状態に合わせて manual / lookOverride チェックを同期 */
  _syncToggles() {
    const entry = this._currentPhase()?.path[this.state.keyframe];
    const isKf = entry && entry !== '@current';
    this.state.manual = isKf ? this._isManual(entry) : false;
    this.state.lookOverride = isKf ? this._hasLook(entry) : false;
    this.manualCtrl?.updateDisplay();
    this.manualCtrl?.enable(!!isKf);
    this.lookCtrl?.updateDisplay();
    this.lookCtrl?.enable(!!isKf);
  }

  /** path[i] のアンカー軸を書き込む（auto=配列 / object 両対応） */
  _setAnchor(i, axis, v) {
    const entry = this._currentPhase().path[i];
    const r = Number(v.toFixed(3));
    if (Array.isArray(entry)) entry[axis] = r;
    else entry.p[axis] = r;
  }

  /** path[i] のハンドル（hIn/hOut）デルタ軸を書き込む */
  _setHandle(i, key, axis, v) {
    const entry = this._currentPhase().path[i];
    if (!Array.isArray(entry[key])) entry[key] = [0, 0, 0];
    entry[key][axis] = Number(v.toFixed(3));
  }

  /**
   * 選択中キーフレーム「1つだけ」の数値パネルを構築する。
   * pos.x/y/z（manual なら handle in/out のデルタ、look override なら注視点 x/y/z）。
   */
  _buildKfPanel() {
    this.kfFolder.destroy();
    this.kfFolder = this.gui.addFolder('Selected keyframe');
    this.kfPanel = null;
    this.aimProxy = null;
    this.aimCtrls = null;

    const phase = this._currentPhase();
    const i = this.state.keyframe;
    const entry = phase?.path[i];
    if (!entry) return;

    this.kfFolder.add({ index: `#${i} / ${phase.path.length - 1}` }, 'index').name('index').disable();

    if (entry === '@current') {
      this.kfFolder.add({ info: '実行時カメラ位置（編集不可）' }, 'info').name('type').disable();
      return;
    }

    const pos = kfPos(entry);
    const posProxy = { x: pos.x, y: pos.y, z: pos.z };
    const posCtrls = ['x', 'y', 'z'].map((ax, ai) =>
      this.kfFolder
        .add(posProxy, ax, -20, 20, 0.01)
        .name(`pos ${ax}`)
        .onChange((v) => {
          this._setAnchor(i, ai, v);
          this._syncSphere(i);
          this._redrawHandles();
          this._redrawAim();
          this._rebuildLine();
          this.onChanged?.();
        })
    );
    this.kfPanel = { index: i, posProxy, posCtrls };

    if (this._isManual(entry)) {
      for (const side of ['out', 'in']) {
        const key = side === 'in' ? 'hIn' : 'hOut';
        const h = kfHandle(entry, key) ?? new THREE.Vector3();
        const proxy = { x: h.x, y: h.y, z: h.z };
        const f = this.kfFolder.addFolder(side === 'in' ? 'handle in (Δ from pos)' : 'handle out (Δ from pos)');
        const ctrls = ['x', 'y', 'z'].map((ax, ai) =>
          f.add(proxy, ax, -10, 10, 0.01)
            .name(ax)
            .onChange((v) => {
              this._setHandle(i, key, ai, v);
              this._redrawHandles();
              this._rebuildLine();
              this.onChanged?.();
            })
        );
        this.kfPanel[side] = { proxy, ctrls };
      }
    }

    if (this._hasLook(entry)) {
      const lk = entry.look;
      const pr = { x: lk[0], y: lk[1], z: lk[2] };
      this.aimProxy = pr;
      const f = this.kfFolder.addFolder('look（注視点・ワールド）');
      this.aimCtrls = ['x', 'y', 'z'].map((ax, ai) =>
        f.add(pr, ax, -20, 20, 0.01)
          .name(ax)
          .onChange((v) => {
            entry.look[ai] = Number(v.toFixed(3));
            if (this.aimSphere) this.aimSphere.position.set(entry.look[0], entry.look[1], entry.look[2]);
            this._redrawAim();
            this.onChanged?.();
          })
      );
    }
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
    this._rebuildAim();
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
    const curve = buildCurve(phase.path, this._offset(), phase.closed === true, this.ctx.world.camera.position);
    const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(160));
    const mat = new THREE.LineBasicMaterial({ color: 0x3070ff, depthTest: false, transparent: true });
    this.line = new THREE.Line(geo, mat);
    this.line.renderOrder = 998;
    this.viz.add(this.line);
  }

  /** 選択中KFが manual のとき in/out ハンドル球＋接続線を描く */
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
    const entry = phase.path[this.state.keyframe];
    if (!entry || entry === '@current' || !this._isManual(entry)) return;

    const offset = this._offset();
    const anchorW = kfPos(entry).add(offset);
    const linePts = [];

    for (const side of ['in', 'out']) {
      const h = kfHandle(entry, side === 'in' ? 'hIn' : 'hOut');
      if (!h) continue;
      const handleW = anchorW.clone().add(h);
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.045, 12, 10),
        new THREE.MeshBasicMaterial({ color: HANDLE_COLOR, depthTest: false, transparent: true })
      );
      sphere.renderOrder = 1000;
      sphere.position.copy(handleW);
      sphere.userData = { kind: 'handle', kfIndex: this.state.keyframe, side };
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

  /** ドラッグ中の軽量更新: ハンドル球を data から再配置し接続線だけ作り直す（tc 球を dispose しない） */
  _redrawHandles() {
    const entry = this._currentPhase().path[this.state.keyframe];
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

  /** 選択中KFの注視点ポインタ球＋接続線を再構築（look override がある場合のみ） */
  _rebuildAim() {
    if (this.aimSphere) {
      this.viz.remove(this.aimSphere);
      this.aimSphere.geometry.dispose();
      this.aimSphere.material.dispose();
      this.aimSphere = null;
    }
    if (this.aimLine) {
      this.viz.remove(this.aimLine);
      this.aimLine.geometry.dispose();
      this.aimLine.material.dispose();
      this.aimLine = null;
    }
    if (!this.active) return;
    const entry = this._currentPhase()?.path[this.state.keyframe];
    if (!entry || !this._hasLook(entry)) return;

    const lk = entry.look;
    this.aimSphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.05, 12, 10),
      new THREE.MeshBasicMaterial({ color: AIM_COLOR, depthTest: false, transparent: true })
    );
    this.aimSphere.renderOrder = 1000;
    this.aimSphere.position.set(lk[0], lk[1], lk[2]);
    this.aimSphere.userData = { kind: 'aim', kfIndex: this.state.keyframe };
    this.viz.add(this.aimSphere);

    const anchorW = kfPos(entry).add(this._offset());
    this.aimLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([anchorW, this.aimSphere.position.clone()]),
      new THREE.LineBasicMaterial({ color: AIM_COLOR, depthTest: false, transparent: true, opacity: 0.6 })
    );
    this.aimLine.renderOrder = 997;
    this.viz.add(this.aimLine);
  }

  /** KF位置→注視点 の線だけ更新（球は dispose しない） */
  _redrawAim() {
    const entry = this._currentPhase()?.path[this.state.keyframe];
    if (!this.aimLine || !entry || !this._hasLook(entry)) return;
    const anchorW = kfPos(entry).add(this._offset());
    this.aimLine.geometry.dispose();
    this.aimLine.geometry = new THREE.BufferGeometry().setFromPoints([
      anchorW,
      this.aimSphere ? this.aimSphere.position.clone() : anchorW,
    ]);
  }

  _sphereFor(index) {
    return this.spheres.find((s) => s.userData.kfIndex === index);
  }

  _handleFor(side) {
    return this.handles.find((h) => h.userData.side === side);
  }

  _syncSphere(index) {
    const sphere = this._sphereFor(index);
    if (!sphere) return;
    sphere.position.copy(kfPos(this._currentPhase().path[index])).add(this._offset());
  }

  /** 現在の選択（アンカー/ハンドル/aim）に応じてギズモを付け替え、色を更新 */
  _attachGizmo() {
    let obj = null;
    if (this.sel.kind === 'handle') obj = this._handleFor(this.sel.side);
    else if (this.sel.kind === 'aim') obj = this.aimSphere;
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

  /** ビューポートクリックでアンカー/ハンドル/aim 球を選択（ギズモ操作とは排他） */
  _pick(e) {
    if (!this.active || e.button !== 0) return;
    if (this.tc.axis) return;
    const targets = [...this.handles, ...(this.aimSphere ? [this.aimSphere] : []), ...this.spheres];
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
    } else if (ud.kind === 'aim') {
      this.sel = { kind: 'aim' };
      this._attachGizmo();
    } else {
      this.kfSelectCtrl.setValue(ud.kfIndex); // onChange → _selectAnchor
    }
  }

  /** Edit keyframe ドロップダウン or アンカークリック時 */
  _selectAnchor() {
    this.sel = { kind: 'anchor', side: null };
    this._rebuildHandles();
    this._rebuildAim();
    this._attachGizmo();
    this._buildKfPanel();
    this._syncToggles();
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
      this._syncToggles();
      return;
    }
    const wantManual = this.state.manual;
    if (wantManual === this._isManual(entry)) return;

    if (wantManual) {
      const t = this._autoTangent(i);
      const obj = Array.isArray(entry) ? this._toObject(entry) : entry;
      obj.hIn = [-t.x / 3, -t.y / 3, -t.z / 3].map((v) => Number(v.toFixed(3)));
      obj.hOut = [t.x / 3, t.y / 3, t.z / 3].map((v) => Number(v.toFixed(3)));
      phase.path[i] = obj;
    } else {
      const obj = entry;
      delete obj.hIn;
      delete obj.hOut;
      if (!this._hasLook(obj)) phase.path[i] = [obj.p[0], obj.p[1], obj.p[2]];
    }
    this.sel = { kind: 'anchor', side: null };
    this._rebuildHandles();
    this._rebuildLine();
    this._attachGizmo();
    this._buildKfPanel();
    this._syncToggles();
    this.onChanged?.();
  }

  /** 選択キーフレームの look override を切替 */
  _toggleLookOverride() {
    const phase = this._currentPhase();
    const i = this.state.keyframe;
    const entry = phase.path[i];
    if (!entry || entry === '@current') {
      this._syncToggles();
      return;
    }
    const want = this.state.lookOverride;
    if (want === this._hasLook(entry)) return;

    if (want) {
      const obj = Array.isArray(entry) ? this._toObject(entry) : entry;
      obj.look = this._defaultAimPoint();
      phase.path[i] = obj;
    } else {
      const obj = entry;
      delete obj.look;
      if (!this._isManual(obj)) phase.path[i] = [obj.p[0], obj.p[1], obj.p[2]];
    }
    this.sel = { kind: 'anchor', side: null };
    this._rebuildAim();
    this._attachGizmo();
    this._buildKfPanel();
    this._syncToggles();
    this.onChanged?.();
  }

  /** 配列キーフレームを { p:[...] } オブジェクト形へ */
  _toObject(arr) {
    return { p: [arr[0], arr[1], arr[2]] };
  }

  /** uniform Catmull-Rom 自動接線 t_i = (P[i+1]-P[i-1])/2（local 座標、camera-eval と同式） */
  _autoTangent(i) {
    const path = this._currentPhase().path;
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

    if (ud.kind === 'aim') {
      // 注視点（ワールド座標。offset 非適用）
      const entry = phase.path[ud.kfIndex];
      if (!entry || !this._hasLook(entry)) return;
      entry.look = [
        Number(obj.position.x.toFixed(3)),
        Number(obj.position.y.toFixed(3)),
        Number(obj.position.z.toFixed(3)),
      ];
      if (this.state.keyframe === ud.kfIndex && this.aimProxy && this.aimCtrls) {
        [this.aimProxy.x, this.aimProxy.y, this.aimProxy.z] = entry.look;
        this.aimCtrls.forEach((c) => c.updateDisplay());
      }
      this._redrawAim();
      this.onChanged?.();
      return;
    }

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
      const side = ud.side;
      if (this.kfPanel?.index === ud.kfIndex && this.kfPanel[side]) {
        const pr = this.kfPanel[side].proxy;
        [pr.x, pr.y, pr.z] = entry[key];
        this.kfPanel[side].ctrls.forEach((c) => c.updateDisplay());
      }
      this._redrawHandles();
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

    if (this.kfPanel?.index === i) {
      this.kfPanel.posProxy.x = p[0];
      this.kfPanel.posProxy.y = p[1];
      this.kfPanel.posProxy.z = p[2];
      this.kfPanel.posCtrls.forEach((c) => c.updateDisplay());
    }
    this._redrawHandles();
    this._redrawAim();
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
    if (this.aimSphere) {
      this.aimSphere.geometry.dispose();
      this.aimSphere.material.dispose();
    }
    if (this.aimLine) {
      this.aimLine.geometry.dispose();
      this.aimLine.material.dispose();
    }
    if (this.line) {
      this.line.geometry.dispose();
      this.line.material.dispose();
    }
  }
}
