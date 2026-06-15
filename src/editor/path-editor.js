import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { buildCurve, kfPos, kfHandle } from '../core/camera-eval.js';

const _ndc = new THREE.Vector2();

const SELECTED_COLOR = 0xffd166;
const NORMAL_COLOR = 0xff4060;
const HANDLE_COLOR = 0x46d3ff;
const AIM_COLOR = 0x7cffb0; // 注視点(look)オーバーライド
const STATIC_COLOR = 0xffa040; // 定点(static)ショットの位置マーカー

/**
 * generate.shots を 3Dビューポート上で編集するショットエディタ。
 *
 * 【ショット管理】Shots フォルダで 定点/パス ショットの追加・削除・並べ替え。選択は
 *   タイムラインの◆（パス=キーフレーム / 定点=ショット）から。
 *
 * 【path ショット】カメラパスの編集:
 * - 位置キーフレーム（アンカー）: クリック選択 / TransformControls ドラッグ / 数値編集
 * - ベジェ: 各キーフレームを auto（CatmullRom自動接線）/ manual（in/out ハンドル）で切替
 * - 注視点(look)オーバーライド: 各キーフレームに任意で注視点を持たせられる（緑ポインタ）
 * - "@current" キーフレームは実行時カメラ位置に置換されるため編集対象外。
 *
 * 【static ショット】定点カメラの編集:
 * - 位置（橙マーカー）/ 注視点（緑ポインタ。fixed のみドラッグ可）を gizmo で操作
 * - 注視対象 fixed/bottle/heroParticle・duration・fov・cut（ハードカット）を GUI で
 *
 * 曲線/向きの評価は camera-eval（本番と共通）。変更は onChanged で通知（タイムライン自動リベイク）。
 *
 * path キーフレームのデータ形:
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
      phaseId: this._shots()[0]?.id ?? '', // 選択中ショット。タイムライン◆/管理ボタンで切替
      keyframe: 0,
      aimKey: 0, // 定点のパン（注視点キーフレーム）の編集対象index
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
    // static ショット用のビューポート要素
    this.staticPosSphere = null; // 定点位置マーカー（橙）
    this.staticLookSphere = null; // 定点の注視点（緑、fixed のみ）
    this.staticLookLine = null;
    this.staticAimSpheres = []; // 定点パン（注視点キーフレーム）の各点（緑、選択は黄）
    this.staticAimLine = null; // 注視点キーフレームを結ぶパン軌跡線
    this.staticPanel = null;

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

    // ショット/キーフレームの選択はタイムラインの◆・3Dクリック・管理ボタンで行う
    this.gui.add(this.state, 'preview').name('▶ Preview shot（実時間再生）');

    // ショット管理（追加/削除/並べ替え。選択中ショットに対して作用）
    this.shotsFolder = this.gui.addFolder('Shots（再生順・管理）');
    this._shotReadout = { cur: '—' };
    this._shotReadoutCtrl = this.shotsFolder.add(this._shotReadout, 'cur').name('選択中').disable();
    const acts = {
      addStatic: () => this._addShot('static'),
      addPath: () => this._addShot('path'),
      up: () => this._moveShot(-1),
      down: () => this._moveShot(1),
      remove: () => this._removeShot(),
    };
    this.shotsFolder.add(acts, 'addStatic').name('＋ 定点ショット（選択の直後）');
    this.shotsFolder.add(acts, 'addPath').name('＋ パスショット（選択の直後）');
    this.shotsFolder.add(acts, 'up').name('↑ 前へ移動');
    this.shotsFolder.add(acts, 'down').name('↓ 後へ移動');
    this.shotsFolder.add(acts, 'remove').name('🗑 ショット削除');

    this.kfFolder = this.gui.addFolder('Selected shot');
    this.rebuild();
  }

  _shots() {
    return this.ctx.choreo.data.generate.shots;
  }

  _currentShot() {
    return this._shots().find((s) => s.id === this.state.phaseId);
  }

  _phases() {
    return this.ctx.choreo.data.generate.shots.filter((p) => Array.isArray(p.path));
  }

  /** 選択中ショットが path 型ならそれを返す（path 編集系メソッド用。static 等では undefined） */
  _currentPhase() {
    const s = this._currentShot();
    return s && Array.isArray(s.path) ? s : undefined;
  }

  /** ショットの relativeTo を解決したワールドオフセット */
  _shotOffset(shot) {
    if (shot?.relativeTo !== 'bottle') return new THREE.Vector3();
    const g = this.ctx.choreo.data.generate;
    const scale = g.bottleScale ?? 1.6;
    return new THREE.Vector3(...g.bottlePos).add(new THREE.Vector3(0, 0.4 * scale, 0));
  }

  /** 選択中 path ショットの relativeTo ワールドオフセット */
  _offset() {
    return this._shotOffset(this._currentPhase());
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

  /** ショット切替・import 後などの全再構築。ショット種別で編集UIを振り分ける */
  rebuild() {
    this._updateShotReadout();
    this.timeline?._highlightSelectedShot?.(); // タイムラインの選択ハイライト更新
    const shot = this._currentShot();
    if (!shot) {
      this._clearPathViz();
      this._disposeStatic();
      return;
    }

    if (shot.type === 'static') {
      this.sel = { kind: 'static-pos', side: null };
      this._rebuildStaticViz();
      this._buildStaticPanel();
      return;
    }
    if (!Array.isArray(shot.path)) {
      // follow / loop: ビューポート編集なし（数値は Parameters で）
      this._clearPathViz();
      this._disposeStatic();
      this._buildHoldPanel(shot);
      return;
    }

    // path
    const phase = shot;
    const editable = phase.path.map((e, i) => (e === '@current' ? -1 : i)).filter((i) => i >= 0);
    this.state.keyframe = editable.includes(this.state.keyframe) ? this.state.keyframe : editable[0] ?? 0;
    this.sel = { kind: 'anchor', side: null };

    this._rebuildViz();
    this._buildKfPanel();
  }

  _updateShotReadout() {
    const shots = this._shots();
    const cur = this._currentShot();
    this._shotReadout.cur = cur ? `#${shots.indexOf(cur)} ${cur.id} (${cur.type})` : '—';
    this._shotReadoutCtrl?.updateDisplay();
  }

  /** path 系ビューポート要素（アンカー/線/ハンドル/aim）を全消去 */
  _clearPathViz() {
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
    this._rebuildHandles(); // 現在が非 path なら破棄のみ（guard 済）
    this._rebuildAim();
    this.tc.detach();
    this.tcHelper.visible = false;
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
   * 選択中キーフレーム「1つだけ」の編集パネルを構築する。
   * キーフレーム単位の編集は3モード:
   *   ① position … アンカー座標（赤球）
   *   ② bezier handle … カーブの接線（青ハンドル。auto/manual トグル）
   *   ③ look / aim … 注視点オーバーライド（緑ポインタ。on/off トグル）
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

    this.kfFolder
      .add({ kf: `${phase.id}  #${i}/${phase.path.length - 1}` }, 'kf')
      .name('keyframe')
      .disable();

    // キーフレームの追加 / 削除（選択中の path ショットに対して）
    this.kfFolder.add(this.state, 'addKeyframe').name('＋ keyframe（選択の直後に挿入）');
    this.kfFolder.add(this.state, 'removeKeyframe').name('− keyframe（選択を削除）');

    if (entry === '@current') {
      this.kfFolder.add({ info: '実行時カメラ位置（編集不可）' }, 'info').name('type').disable();
      return;
    }

    // ① position（アンカー）
    const posF = this.kfFolder.addFolder('① position（位置）');
    const pos = kfPos(entry);
    const posProxy = { x: pos.x, y: pos.y, z: pos.z };
    const posCtrls = ['x', 'y', 'z'].map((ax, ai) =>
      posF
        .add(posProxy, ax, -20, 20, 0.01)
        .name(ax)
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

    // ② bezier handle（カーブの接線）
    const manual = this._isManual(entry);
    const bezF = this.kfFolder.addFolder('② bezier handle（曲線）');
    bezF.add({ on: manual }, 'on').name('使う（auto ⇄ manual）').onChange((on) => this._setManual(on));
    if (manual) {
      for (const side of ['out', 'in']) {
        const key = side === 'in' ? 'hIn' : 'hOut';
        const h = kfHandle(entry, key) ?? new THREE.Vector3();
        const proxy = { x: h.x, y: h.y, z: h.z };
        const ctrls = ['x', 'y', 'z'].map((ax, ai) =>
          bezF
            .add(proxy, ax, -10, 10, 0.01)
            .name(`${side} ${ax}`)
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

    // ③ look / aim（注視点オーバーライド）
    const hasLook = this._hasLook(entry);
    const lookF = this.kfFolder.addFolder('③ look / aim（向き）');
    lookF.add({ on: hasLook }, 'on').name('注視点を上書き').onChange((on) => this._setLookOverride(on));
    if (hasLook) {
      const lk = entry.look;
      const pr = { x: lk[0], y: lk[1], z: lk[2] };
      this.aimProxy = pr;
      this.aimCtrls = ['x', 'y', 'z'].map((ax, ai) =>
        lookF
          .add(pr, ax, -20, 20, 0.01)
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

  // ---- static（定点）ショット ----

  /** static の注視点（fixed のみ点を返す。target はビューポート表示しない＝null） */
  _staticLookPoint(shot) {
    const lc = shot.lookAt;
    if (Array.isArray(lc?.point)) return new THREE.Vector3(...lc.point);
    if (lc?.target === 'bottle') return this._shotOffset({ relativeTo: 'bottle' });
    return null;
  }

  /** static のワールド位置（"@current" は不定なので null） */
  _staticPosWorld(shot) {
    if (shot.pos === '@current') return null;
    return new THREE.Vector3(...shot.pos).add(this._shotOffset(shot));
  }

  _disposeStatic() {
    for (const s of this.staticAimSpheres) {
      this.viz.remove(s);
      s.geometry.dispose();
      s.material.dispose();
    }
    this.staticAimSpheres = [];
    for (const k of ['staticPosSphere', 'staticLookSphere', 'staticLookLine', 'staticAimLine']) {
      const o = this[k];
      if (!o) continue;
      this.viz.remove(o);
      o.geometry.dispose();
      o.material.dispose();
      this[k] = null;
    }
  }

  /** 定点ショットのビューポート要素（位置マーカー＋注視点＋線）を再構築 */
  _rebuildStaticViz() {
    this._clearPathViz();
    this._disposeStatic();
    const shot = this._currentShot();
    if (!shot || shot.type !== 'static' || !this.active) {
      this.tc.detach();
      this.tcHelper.visible = false;
      return;
    }

    const posW = this._staticPosWorld(shot);
    if (posW) {
      this.staticPosSphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 16, 12),
        new THREE.MeshBasicMaterial({ color: STATIC_COLOR, depthTest: false, transparent: true })
      );
      this.staticPosSphere.renderOrder = 999;
      this.staticPosSphere.position.copy(posW);
      this.staticPosSphere.userData = { kind: 'static-pos' };
      this.viz.add(this.staticPosSphere);
    }

    const lc = shot.lookAt;
    if (Array.isArray(lc?.keys) && lc.keys.length) {
      // パン（注視点キーフレーム）: 各キー点を緑球（選択中は黄）、t 順に線で連結
      this.state.aimKey = Math.min(this.state.aimKey ?? 0, lc.keys.length - 1);
      const pts = [];
      lc.keys.forEach((k, idx) => {
        if (!Array.isArray(k.point)) return;
        const pt = new THREE.Vector3(...k.point);
        pts.push(pt);
        const sel = idx === this.state.aimKey;
        const s = new THREE.Mesh(
          new THREE.SphereGeometry(sel ? 0.06 : 0.045, 12, 10),
          new THREE.MeshBasicMaterial({ color: sel ? SELECTED_COLOR : AIM_COLOR, depthTest: false, transparent: true })
        );
        s.renderOrder = 1000;
        s.position.copy(pt);
        s.userData = { kind: 'static-aimkey', index: idx };
        this.viz.add(s);
        this.staticAimSpheres.push(s);
      });
      if (pts.length >= 2) {
        this.staticAimLine = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: AIM_COLOR, depthTest: false, transparent: true, opacity: 0.5 })
        );
        this.staticAimLine.renderOrder = 997;
        this.viz.add(this.staticAimLine);
      }
      // 定点位置 → 選択中の注視点キー の線
      const selSphere = this.staticAimSpheres[this.state.aimKey];
      if (posW && selSphere) {
        this.staticLookLine = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([posW.clone(), selSphere.position.clone()]),
          new THREE.LineBasicMaterial({ color: AIM_COLOR, depthTest: false, transparent: true, opacity: 0.35 })
        );
        this.staticLookLine.renderOrder = 996;
        this.viz.add(this.staticLookLine);
      }
      if (this.sel.kind !== 'static-pos') this.sel = { kind: 'static-aimkey', side: null };
    } else {
      // fixed（単一注視点・ドラッグ可）/ target（追従・表示のみ）
      const lp = this._staticLookPoint(shot);
      const draggableLook = Array.isArray(lc?.point);
      if (lp && draggableLook) {
        this.staticLookSphere = new THREE.Mesh(
          new THREE.SphereGeometry(0.05, 12, 10),
          new THREE.MeshBasicMaterial({ color: AIM_COLOR, depthTest: false, transparent: true })
        );
        this.staticLookSphere.renderOrder = 1000;
        this.staticLookSphere.position.copy(lp);
        this.staticLookSphere.userData = { kind: 'static-look' };
        this.viz.add(this.staticLookSphere);
      }
      if (lp && posW) {
        this.staticLookLine = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([posW.clone(), lp.clone()]),
          new THREE.LineBasicMaterial({ color: AIM_COLOR, depthTest: false, transparent: true, opacity: 0.6 })
        );
        this.staticLookLine.renderOrder = 997;
        this.viz.add(this.staticLookLine);
      }
    }

    this._attachStaticGizmo();
  }

  _attachStaticGizmo() {
    let obj = null;
    if (this.sel.kind === 'static-aimkey') obj = this.staticAimSpheres[this.state.aimKey];
    else if (this.sel.kind === 'static-look') obj = this.staticLookSphere;
    if (!obj) {
      this.sel = { kind: 'static-pos', side: null };
      obj = this.staticPosSphere ?? this.staticLookSphere ?? this.staticAimSpheres[this.state.aimKey];
    }
    if (obj && this.active) {
      this.tc.attach(obj);
      this.tcHelper.visible = true;
    } else {
      this.tc.detach();
      this.tcHelper.visible = false;
    }
  }

  /** static の補助線（pos→注視点 / パン軌跡）だけ更新（球は dispose しない） */
  _redrawStaticLine() {
    const a = this.staticPosSphere?.position;
    // パン軌跡線（注視点キーフレームを結ぶ）
    if (this.staticAimLine && this.staticAimSpheres.length >= 2) {
      this.staticAimLine.geometry.dispose();
      this.staticAimLine.geometry = new THREE.BufferGeometry().setFromPoints(
        this.staticAimSpheres.map((s) => s.position.clone())
      );
    }
    // pos→注視点 の線（選択中キー or fixed の look）
    const b = this.staticAimSpheres[this.state.aimKey]?.position ?? this.staticLookSphere?.position;
    if (this.staticLookLine && a && b) {
      this.staticLookLine.geometry.dispose();
      this.staticLookLine.geometry = new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]);
    }
  }

  /** 定点ショットの編集パネル: ① position ② look/aim ③ timing/fov/cut */
  _buildStaticPanel() {
    this.kfFolder.destroy();
    this.kfFolder = this.gui.addFolder('Selected shot');
    this.kfPanel = null;
    this.aimProxy = null;
    this.aimCtrls = null;
    this.staticPanel = null;

    const shot = this._currentShot();
    if (!shot) return;
    this.kfFolder.add({ t: `${shot.id}（定点 static）` }, 't').name('shot').disable();

    // ① position
    const posF = this.kfFolder.addFolder('① position（定点位置）');
    const isCurrent = shot.pos === '@current';
    posF.add({ on: isCurrent }, 'on').name('"@current"（実行時カメラ位置）').onChange((on) => this._setStaticCurrent(on));
    let posProxy = null;
    let posCtrls = [];
    if (!isCurrent) {
      posProxy = { x: shot.pos[0], y: shot.pos[1], z: shot.pos[2] };
      posCtrls = ['x', 'y', 'z'].map((ax, ai) =>
        posF
          .add(posProxy, ax, -20, 20, 0.01)
          .name(ax)
          .onChange((v) => {
            shot.pos[ai] = Number(v.toFixed(3));
            this._rebuildStaticViz();
            this.onChanged?.();
          })
      );
    }

    // ② look / aim
    const lookF = this.kfFolder.addFolder('② look / aim（注視）');
    const mode = Array.isArray(shot.lookAt?.keys)
      ? 'keyframe'
      : shot.lookAt?.target ?? 'fixed';
    lookF
      .add({ mode }, 'mode', ['fixed', 'bottle', 'heroParticle', 'keyframe'])
      .name('注視対象')
      .onChange((m) => this._setStaticLookMode(m));
    let lookProxy = null;
    let lookCtrls = [];
    let aimKeyProxy = null;
    let aimKeyCtrls = [];
    if (mode === 'fixed') {
      if (!Array.isArray(shot.lookAt?.point)) shot.lookAt = { mode: 'fixed', point: [0, 0.5, 0] };
      const lp = shot.lookAt.point;
      lookProxy = { x: lp[0], y: lp[1], z: lp[2] };
      lookCtrls = ['x', 'y', 'z'].map((ax, ai) =>
        lookF
          .add(lookProxy, ax, -20, 20, 0.01)
          .name(ax)
          .onChange((v) => {
            shot.lookAt.point[ai] = Number(v.toFixed(3));
            this._rebuildStaticViz();
            this.onChanged?.();
          })
      );
    } else if (mode === 'keyframe') {
      // パン: 注視点キーフレーム列。各キーは t（0–1＝ショット内進行）と look 点
      const keys = shot.lookAt.keys;
      this.state.aimKey = Math.min(this.state.aimKey ?? 0, keys.length - 1);
      lookF
        .add({ lerp: shot.lookAt.lerp ?? 1.0 }, 'lerp', 0.01, 1, 0.01)
        .name('追従 lerp（1=即時）')
        .onChange((v) => {
          shot.lookAt.lerp = Number(v.toFixed(3));
          this.onChanged?.();
        });
      lookF.add({ add: () => this._addAimKey() }, 'add').name('＋ 注視点キーフレーム');
      lookF.add({ rm: () => this._removeAimKey() }, 'rm').name('− 注視点キーフレーム');
      const i = this.state.aimKey;
      lookF
        .add({ s: `#${i}/${keys.length - 1}（緑球クリックで選択）` }, 's')
        .name('編集中キー')
        .disable();
      lookF.add({ prev: () => this._selectAimKey(Math.max(0, i - 1)) }, 'prev').name('◀ 前のキー');
      lookF.add({ next: () => this._selectAimKey(Math.min(keys.length - 1, i + 1)) }, 'next').name('次のキー ▶');
      const k = keys[i];
      if (k) {
        if (!Array.isArray(k.point)) k.point = [0, 0.5, 0];
        lookF
          .add(k, 't', 0, 1, 0.01)
          .name('t（ショット内 0–1）')
          .onChange(() => this.onChanged?.());
        aimKeyProxy = { x: k.point[0], y: k.point[1], z: k.point[2] };
        aimKeyCtrls = ['x', 'y', 'z'].map((ax, ai) =>
          lookF
            .add(aimKeyProxy, ax, -20, 20, 0.01)
            .name(`look ${ax}`)
            .onChange((v) => {
              k.point[ai] = Number(v.toFixed(3));
              this._rebuildStaticViz();
              this.onChanged?.();
            })
        );
      }
    } else {
      lookF
        .add({ lerp: shot.lookAt?.lerp ?? 1.0 }, 'lerp', 0.01, 1, 0.01)
        .name('追従 lerp')
        .onChange((v) => {
          shot.lookAt.lerp = Number(v.toFixed(3));
          this.onChanged?.();
        });
    }

    // ③ timing / fov / cut
    if (typeof shot.start !== 'number') shot.start = 0;
    const tF = this.kfFolder.addFolder('③ timing / fov');
    tF.add(shot, 'start', 0, 60, 0.05).name('start（開始秒・被せ位置）').onChange(() => this.onChanged?.());
    // duration: スライダーは 5s 上限、数値入力は上限なしで自由に
    const durC = tF.add(shot, 'duration', 0.1, 5, 0.1).name('duration（秒・slider上限5s）');
    durC.onChange(() => this.onChanged?.());
    durC._clamp = (v) => (v < 0.1 ? 0.1 : v); // lil-gui 0.21: 上限クランプを外す（slider/drag は _max=5 のまま）
    if (Array.isArray(shot.fov)) {
      tF.add(shot.fov, 0, 10, 120, 1).name('fov 開始').onChange(() => this.onChanged?.());
      tF.add(shot.fov, 1, 10, 120, 1).name('fov 終了').onChange(() => this.onChanged?.());
    } else {
      const fp = { fov: shot.fov ?? 45 };
      tF.add(fp, 'fov', 10, 120, 1).name('fov').onChange((v) => {
        shot.fov = v;
        this.onChanged?.();
      });
    }
    tF.add({ cut: !!shot.cut }, 'cut').name('cut（直前からハードカット）').onChange((on) => {
      shot.cut = on;
      this.onChanged?.();
    });

    this.staticPanel = { posProxy, posCtrls, lookProxy, lookCtrls, aimKeyProxy, aimKeyCtrls };
  }

  /** ギズモで注視点キーを動かした時、パネルの look x/y/z 表示を同期 */
  _syncStaticPanelAim(shot) {
    const sp = this.staticPanel;
    const k = shot.lookAt?.keys?.[this.state.aimKey];
    if (!sp?.aimKeyProxy || !Array.isArray(k?.point)) return;
    [sp.aimKeyProxy.x, sp.aimKeyProxy.y, sp.aimKeyProxy.z] = k.point;
    sp.aimKeyCtrls.forEach((c) => c.updateDisplay());
  }

  _syncStaticPanelPos(shot) {
    const sp = this.staticPanel;
    if (!sp?.posProxy || shot.pos === '@current') return;
    [sp.posProxy.x, sp.posProxy.y, sp.posProxy.z] = shot.pos;
    sp.posCtrls.forEach((c) => c.updateDisplay());
  }

  _syncStaticPanelLook(shot) {
    const sp = this.staticPanel;
    if (!sp?.lookProxy || !Array.isArray(shot.lookAt?.point)) return;
    [sp.lookProxy.x, sp.lookProxy.y, sp.lookProxy.z] = shot.lookAt.point;
    sp.lookCtrls.forEach((c) => c.updateDisplay());
  }

  _setStaticCurrent(on) {
    const shot = this._currentShot();
    if (on) {
      shot.pos = '@current';
    } else {
      const p = this.ctx.world.camera.position;
      shot.pos = [Number(p.x.toFixed(2)), Number(p.y.toFixed(2)), Number(p.z.toFixed(2))];
    }
    this._rebuildStaticViz();
    this._buildStaticPanel();
    this.onChanged?.();
  }

  _setStaticLookMode(m) {
    const shot = this._currentShot();
    const base = Array.isArray(shot.lookAt?.point)
      ? shot.lookAt.point
      : Array.isArray(shot.lookAt?.keys?.[0]?.point)
        ? shot.lookAt.keys[0].point
        : [0, 0.5, 0];
    if (m === 'fixed') {
      shot.lookAt = { mode: 'fixed', point: [...base] };
    } else if (m === 'keyframe') {
      // 2点のパンを初期生成（現在の注視点 → 横へ2m）。t は 0→1
      shot.lookAt = {
        lerp: shot.lookAt?.lerp ?? 1.0,
        keys: [
          { t: 0, point: [...base] },
          { t: 1, point: [base[0] + 2, base[1], base[2]] },
        ],
      };
      this.state.aimKey = 0;
    } else {
      shot.lookAt = { mode: 'target', target: m, lerp: shot.lookAt?.lerp ?? 1.0 };
    }
    this._rebuildStaticViz();
    this._buildStaticPanel();
    this.onChanged?.();
  }

  /** 選択中の注視点キーを切替（緑球クリック / 前後ボタン） */
  _selectAimKey(i) {
    this.state.aimKey = i;
    this.sel = { kind: 'static-aimkey', side: null };
    this._rebuildStaticViz();
    this._buildStaticPanel();
  }

  /** 注視点キーフレームを選択キーの直後に追加 */
  _addAimKey() {
    const shot = this._currentShot();
    const keys = shot.lookAt?.keys;
    if (!keys) return;
    const i = this.state.aimKey;
    const cur = keys[i];
    const next = keys[i + 1];
    const t = next ? (cur.t + next.t) / 2 : Math.min(1, (cur.t ?? 0) + 0.25);
    const point = Array.isArray(cur.point) ? [...cur.point] : [0, 0.5, 0];
    keys.splice(i + 1, 0, { t: Number(t.toFixed(3)), point });
    this.state.aimKey = i + 1;
    this.sel = { kind: 'static-aimkey', side: null };
    this._rebuildStaticViz();
    this._buildStaticPanel();
    this.onChanged?.();
  }

  /** 注視点キーフレームを削除（最低2点は残す＝パンの両端） */
  _removeAimKey() {
    const shot = this._currentShot();
    const keys = shot.lookAt?.keys;
    if (!keys || keys.length <= 2) return;
    keys.splice(this.state.aimKey, 1);
    this.state.aimKey = Math.max(0, this.state.aimKey - 1);
    this.sel = { kind: 'static-aimkey', side: null };
    this._rebuildStaticViz();
    this._buildStaticPanel();
    this.onChanged?.();
  }

  /** follow / loop 選択時の情報パネル（ビューポート編集なし） */
  _buildHoldPanel(shot) {
    this.kfFolder.destroy();
    this.kfFolder = this.gui.addFolder('Selected shot');
    this.kfPanel = null;
    this.kfFolder.add({ t: `${shot.id}（${shot.type}・ホールド）` }, 't').name('shot').disable();
    this.kfFolder
      .add({ i: '数値は Parameters > generate で調整' }, 'i')
      .name('info')
      .disable();
  }

  // ---- ショット管理（追加 / 削除 / 並べ替え / 選択） ----

  _uniqueId(base) {
    const ids = new Set(this._shots().map((s) => s.id));
    let n = 1;
    while (ids.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  }

  /** タイムラインのプレイヘッドが乗っているショットの id（なければ null） */
  _playheadShotId() {
    const tl = this.timeline;
    if (!tl?.isOpen || !tl.baked) return null;
    return tl._phaseAt(tl.frame)?.id ?? null;
  }

  /**
   * 新規ショットを挿入して選択する。
   * - static: シークバー（プレイヘッド）が乗っているショットの直後に挿入
   * - path  : 選択中ショットの直後に挿入
   */
  _addShot(type) {
    const shots = this._shots();
    let at;
    let start = 0;
    if (type === 'static') {
      const tl = this.timeline;
      start = tl?.isOpen && tl.baked ? Number(tl.currentTime.toFixed(3)) : 0; // シークバー位置から開始
      const phId = this._playheadShotId();
      const idx = phId ? shots.findIndex((s) => s.id === phId) : -1;
      at = idx >= 0 ? idx + 1 : shots.length;
    } else {
      const cur = this._currentShot();
      at = cur ? shots.indexOf(cur) + 1 : shots.length;
    }
    const id = this._uniqueId(type);
    const shot =
      type === 'static'
        ? { id, type: 'static', start, duration: 2.0, pos: [0, 1, 3], lookAt: { mode: 'fixed', point: [0, 0.5, 0] }, fov: 45 }
        : {
            id,
            type: 'path',
            duration: 2.0,
            ease: 'none',
            path: [[0, 1, 3], [0, 1, 1]],
            lookAt: { mode: 'fixed', point: [0, 0.5, 0] },
          };
    shots.splice(at, 0, shot);
    this.state.phaseId = id;
    this.state.keyframe = 0;
    this.sel = { kind: 'anchor', side: null };
    this.rebuild();
    this.onChanged?.();
  }

  _removeShot() {
    const shots = this._shots();
    if (shots.length <= 1) return; // 最低1ショットは残す
    const i = shots.indexOf(this._currentShot());
    if (i < 0) return;
    shots.splice(i, 1);
    const next = shots[Math.max(0, i - 1)];
    this.state.phaseId = next.id;
    this.state.keyframe = 0;
    this.sel = { kind: 'anchor', side: null };
    this.rebuild();
    this.onChanged?.();
  }

  _moveShot(dir) {
    const shots = this._shots();
    const i = shots.indexOf(this._currentShot());
    const j = i + dir;
    if (i < 0 || j < 0 || j >= shots.length) return;
    [shots[i], shots[j]] = [shots[j], shots[i]];
    this.rebuild();
    this.onChanged?.();
  }

  /** 外部（タイムラインのショットブロック/◆）からショットを選択 */
  selectShot(shotId) {
    if (!this._shots().some((s) => s.id === shotId)) return;
    this.state.phaseId = shotId;
    this.state.keyframe = 0;
    this.sel = { kind: 'anchor', side: null };
    this.rebuild();
  }

  // ---- 可視化 ----

  _rebuildViz() {
    for (const s of this.spheres) {
      this.viz.remove(s);
      s.geometry.dispose();
      s.material.dispose();
    }
    this.spheres = [];
    this._disposeStatic(); // path 表示時は static マーカーを消す

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
    if (!phase) return; // static/follow/loop 選択時は破棄のみ
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
    const targets = [
      ...this.handles,
      ...(this.aimSphere ? [this.aimSphere] : []),
      ...this.staticAimSpheres,
      ...(this.staticLookSphere ? [this.staticLookSphere] : []),
      ...(this.staticPosSphere ? [this.staticPosSphere] : []),
      ...this.spheres,
    ];
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
    if (ud.kind === 'static-aimkey') {
      this._selectAimKey(ud.index); // 注視点キーを選択（ギズモ＆パネル更新）
    } else if (ud.kind === 'static-pos' || ud.kind === 'static-look') {
      this.sel = { kind: ud.kind, side: null };
      this._attachStaticGizmo();
    } else if (ud.kind === 'handle') {
      this.sel = { kind: 'handle', side: ud.side };
      this._attachGizmo();
    } else if (ud.kind === 'aim') {
      this.sel = { kind: 'aim' };
      this._attachGizmo();
    } else {
      this.state.keyframe = ud.kfIndex;
      this._selectAnchor();
    }
  }

  /** キーフレーム選択時（3Dクリック / タイムライン◆ / phase切替後） */
  _selectAnchor() {
    this.sel = { kind: 'anchor', side: null };
    this._rebuildHandles();
    this._rebuildAim();
    this._attachGizmo();
    this._buildKfPanel();
  }

  /** 外部（タイムラインの◆クリック・3Dクリック等）からの選択。phase もここで切替 */
  selectKeyframe(phaseId, kfIndex) {
    if (!this._phases().some((p) => p.id === phaseId)) return;
    const phaseChanged = this.state.phaseId !== phaseId;
    this.state.phaseId = phaseId;
    this.state.keyframe = kfIndex;
    this.sel = { kind: 'anchor', side: null };
    if (phaseChanged) this.rebuild();
    else this._selectAnchor();
  }

  /** 選択キーフレームの auto ⇄ manual を切替 */
  _setManual(wantManual) {
    const phase = this._currentPhase();
    const i = this.state.keyframe;
    const entry = phase.path[i];
    if (!entry || entry === '@current') return;
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
    this.onChanged?.();
  }

  /** 選択キーフレームの look override を切替 */
  _setLookOverride(want) {
    const phase = this._currentPhase();
    const i = this.state.keyframe;
    const entry = phase.path[i];
    if (!entry || entry === '@current') return;
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

    if (ud.kind === 'static-aimkey') {
      const shot = this._currentShot();
      const k = shot.lookAt?.keys?.[ud.index];
      if (!k) return;
      k.point = [
        Number(obj.position.x.toFixed(3)),
        Number(obj.position.y.toFixed(3)),
        Number(obj.position.z.toFixed(3)),
      ];
      this._redrawStaticLine();
      this._syncStaticPanelAim(shot);
      this.onChanged?.();
      return;
    }
    if (ud.kind === 'static-pos') {
      const shot = this._currentShot();
      const local = obj.position.clone().sub(this._shotOffset(shot));
      shot.pos = [Number(local.x.toFixed(3)), Number(local.y.toFixed(3)), Number(local.z.toFixed(3))];
      this._redrawStaticLine();
      this._syncStaticPanelPos(shot);
      this.onChanged?.();
      return;
    }
    if (ud.kind === 'static-look') {
      const shot = this._currentShot();
      shot.lookAt = shot.lookAt ?? { mode: 'fixed' };
      shot.lookAt.mode = 'fixed';
      shot.lookAt.point = [
        Number(obj.position.x.toFixed(3)),
        Number(obj.position.y.toFixed(3)),
        Number(obj.position.z.toFixed(3)),
      ];
      this._redrawStaticLine();
      this._syncStaticPanelLook(shot);
      this.onChanged?.();
      return;
    }

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
    if (!phase) return; // path ショット選択時のみ
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
    if (!phase) return; // path ショット選択時のみ
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

  /** ショット単体プレビュー */
  _preview() {
    const { director, manager, choreo } = this.ctx;
    const shot = this._currentShot();
    if (!shot) return;

    if (!manager.is('generate')) {
      const g = choreo.data.generate;
      const scale = g.bottleScale ?? 1.6;
      const bottleCenter = new THREE.Vector3(...g.bottlePos).add(new THREE.Vector3(0, 0.4 * scale, 0));
      director.registerTarget('bottle', (out) => out.copy(bottleCenter));
      director.registerTarget('heroParticle', (out) => out.copy(bottleCenter));
    }

    if (shot.type === 'loop') {
      const hold = director.playLoop(shot);
      setTimeout(() => hold.release(), 3000);
    } else if (shot.type === 'follow') {
      const hold = director.playFollow(shot);
      setTimeout(() => hold.release(), 3000);
    } else if (shot.type === 'static') {
      director.playStatic(shot);
    } else {
      director.playPhase(shot);
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
    this._disposeStatic();
  }
}
