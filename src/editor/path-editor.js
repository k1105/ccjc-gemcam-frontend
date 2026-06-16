import * as THREE from 'three';
import gsap from 'gsap';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { buildCurve, kfPos, kfHandle, pathTimes, pathBoundaryNeighbors } from '../core/camera-eval.js';

const _ndc = new THREE.Vector2();

const SELECTED_COLOR = 0xffd166;
const NORMAL_COLOR = 0xff4060;
const HANDLE_COLOR = 0x46d3ff;
const AIM_COLOR = 0x7cffb0; // 注視点(look)オーバーライド
const STATIC_COLOR = 0xffa040; // 定点(static)ショットの位置マーカー
const STREAM_COLOR = 0xff5cc8; // 粒子ストリームのベジェ制御点(p1/p2)
const LIGHT_COLOR = 0xffcc33; // ライト配置マーカー（アンバー）

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
    this.gui = parentGui.addFolder('Camera Path (generate)'); // カメラタブの親（preview/Shots/Selected shot）
    this.lightsGui = parentGui.addFolder('Lights'); // ライトタブの親（配置/Selected light）
    this.active = false;
    this.onChanged = null;

    this.sel = { kind: 'anchor', side: null }; // 'anchor' | 'handle'(side) | 'aim'

    this.state = {
      phaseId: this._shots()[0]?.id ?? '', // 選択中ショット。タイムライン◆/管理ボタンで切替
      keyframe: 0,
      aimKey: 0, // 定点のパン（注視点キーフレーム）の編集対象index
      lightId: '', // 選択中の配置ライト
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
    // 粒子ストリーム（generate）の制御点ハンドル（p1/p2）
    this.streamP1Sphere = null;
    this.streamP2Sphere = null;
    this.streamLine = null;
    this.streamMarks = []; // p0/p3 参照マーカー
    // 配置ライト（generate.lights）
    this.lightMarkers = []; // 各ライトの位置マーカー
    this.lightTargetMarker = null; // 選択中 spot/directional の target
    this.lightLine = null; // 位置→target 線
    this.lightPanel = null;
    this.lightListFolder = null; // ライト一覧（選択用）

    this.tc = new TransformControls(ctx.world.camera, ctx.world.renderer.domElement);
    this.tcHelper = this.tc.getHelper();
    this.tcHelper.visible = false;
    ctx.world.scene.add(this.tcHelper);
    this.tc.enabled = false;
    this.tc.setSize(0.7);
    this.tc.addEventListener('objectChange', () => this._onObjectChange());

    // 回転モーダル用の不可視プロキシ。pivot に置いて rotate ギズモ（リング）を掴ませ、
    // その回転を「向きベクトル」へ写像する（マーカー球は自前の回転を持たないため）。
    this._rotProxy = new THREE.Object3D();
    ctx.world.scene.add(this._rotProxy);

    this.raycaster = new THREE.Raycaster();
    this._onPointerDown = (e) => this._pick(e);
    ctx.world.renderer.domElement.addEventListener('pointerdown', this._onPointerDown);

    // --- Blender 風モーダル変換（g/gx/gy/gz・r/rx/ry/rz・数値入力）。
    //     選択中ギズモ対象（this.tc.object）を移動/回転する。確定=左クリック/Enter、取消=右クリック/Esc。 ---
    this._modal = null;
    this._lastPointer = { x: 0, y: 0 };
    this._modalRay = new THREE.Raycaster();
    this._onModalKey = (e) => this._handleModalKey(e);
    this._onPointerTrack = (e) => this._trackPointer(e);
    this._onModalPointerDown = (e) => this._handleModalPointerDown(e);
    this._onModalContext = (e) => { if (this._modal) e.preventDefault(); };
    // capture: タイムラインの window キャプチャ（g/r/数字を握りつぶす）より先に処理する
    window.addEventListener('keydown', this._onModalKey, true);
    window.addEventListener('pointermove', this._onPointerTrack, true);
    ctx.world.renderer.domElement.addEventListener('pointerdown', this._onModalPointerDown, true);
    ctx.world.renderer.domElement.addEventListener('contextmenu', this._onModalContext);

    // ショット/キーフレームの選択はタイムラインの◆・3Dクリック・管理ボタンで行う
    this.gui.add(this.state, 'preview').name('▶ Preview shot（実時間再生）');

    // ショット管理（追加/削除/並べ替え。選択中ショットに対して作用。
    // 選択はタイムラインのブロック/◆クリック・3Dクリックで。選択中はタイムライン枠で表示）
    this.shotsFolder = this.gui.addFolder('Shots（再生順・管理）');
    const acts = {
      addStatic: () => this._addShot(),
      up: () => this._moveShot(-1),
      down: () => this._moveShot(1),
      remove: () => this._removeShot(),
    };
    this.shotsFolder.add(acts, 'addStatic').name('＋ 定点ショット（シークバー位置に被せる）');
    this.shotsFolder.add(acts, 'up').name('↑ 前へ移動');
    this.shotsFolder.add(acts, 'down').name('↓ 後へ移動');
    this.shotsFolder.add(acts, 'remove').name('🗑 ショット削除');

    this.kfFolder = this.gui.addFolder('Selected shot');

    // 配置ライト（generate.lights）: 種別を選んで追加、ビューポートで位置 gizmo 編集
    this.lightsFolder = this.lightsGui.addFolder('Lights（配置）');
    const lacts = {
      addPoint: () => this._addLight('point'),
      addSpot: () => this._addLight('spot'),
      addDir: () => this._addLight('directional'),
      remove: () => this._removeLight(),
    };
    this.lightsFolder.add(lacts, 'addPoint').name('＋ point');
    this.lightsFolder.add(lacts, 'addSpot').name('＋ spot');
    this.lightsFolder.add(lacts, 'addDir').name('＋ directional');
    this.lightsFolder.add(lacts, 'remove').name('🗑 ライト削除');
    this.lightFolder = this.lightsGui.addFolder('Selected light');

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

  /** path ショットの times（各アンカーの正規化時刻）配列を保証して返す（path と同インデックス） */
  _ensureTimes(shot) {
    const n = shot.path.length;
    if (!Array.isArray(shot.times) || shot.times.length !== n) {
      shot.times = pathTimes(shot); // 無ければ uniform で生成
    }
    return shot.times;
  }

  /** lil-gui の数値コントローラ: スライダーは有限レンジのまま、数値入力はクランプせず任意値に */
  _freeRange(ctrl) {
    ctrl._clamp = (v) => v; // lil-gui 0.21: 上下限クランプを無効化（slider/drag の写像は min/max のまま）
    return ctrl;
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

  /**
   * look override をONにした時の初期注視点。
   * 「そのキーフレーム時点で実際に見ている点」＝ベイク済み注視点を初期値にする
   * （ON にした瞬間に向きが飛ばない）。タイムライン未起動時はフェーズ既定 lookAt。
   */
  _defaultAimPoint() {
    const phase = this._currentPhase();
    const tl = this.timeline;
    if (tl?.isOpen && tl.baked && phase) {
      const info = tl.baked.shots.find((s) => s.id === phase.id && s.layer !== 'overlay');
      const m = info?.markers?.find((mk) => mk.kf === this.state.keyframe);
      if (m) {
        const F = Math.max(0, Math.min(m.frame, tl.baked.totalFrames - 1));
        return [tl.baked.look[F * 3], tl.baked.look[F * 3 + 1], tl.baked.look[F * 3 + 2]].map((v) =>
          Number(v.toFixed(3))
        );
      }
    }
    const lc = phase?.lookAt;
    const p = Array.isArray(lc?.point) ? lc.point : [0, 0.5, 0];
    return p.map((v) => Number(v.toFixed(3)));
  }

  setActive(active) {
    this.active = active;
    this.viz.visible = active;
    this.tc.enabled = active;
    this.tcHelper.visible = active && !!this.tc.object;
    if (!active) this._cancelModal();
    if (active) this.rebuild();
  }

  /** ショット切替・import 後などの全再構築。ショット種別で編集UIを振り分ける */
  rebuild() {
    this.timeline?._highlightSelectedShot?.(); // タイムラインの選択ハイライト更新
    const shot = this._currentShot();
    if (!shot) {
      this._clearPathViz();
      this._disposeStatic();
    } else if (shot.type === 'static') {
      this.sel = { kind: 'static-pos', side: null };
      this._rebuildStaticViz();
      this._buildStaticPanel();
    } else if (!Array.isArray(shot.path)) {
      // follow / loop: ビューポート編集なし（数値は Parameters で）
      this._clearPathViz();
      this._disposeStatic();
      this._buildHoldPanel(shot);
    } else {
      // path
      const phase = shot;
      const editable = phase.path.map((e, i) => (e === '@current' ? -1 : i)).filter((i) => i >= 0);
      this.state.keyframe = editable.includes(this.state.keyframe) ? this.state.keyframe : editable[0] ?? 0;
      this.sel = { kind: 'anchor', side: null };
      this._rebuildViz();
      this._buildKfPanel();
    }
    // 粒子ストリームのハンドル・配置ライトはショット選択に依存せず常に表示
    this._rebuildStreamViz();
    this._rebuildLightViz();
    this._buildLightList();
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
    this.kfFolder.add(this.state, 'addKeyframe').name('＋ keyframe（シークバー位置に追加）');
    this.kfFolder.add(this.state, 'removeKeyframe').name('− keyframe（選択を削除）');

    if (entry === '@current') {
      this.kfFolder.add({ info: '実行時カメラ位置（編集不可）' }, 'info').name('type').disable();
      return;
    }

    // 時刻（このアンカーに到達する正規化時刻 0–1。曲線編集とは独立）
    const times = this._ensureTimes(phase);
    const tProxy = { t: times[i] ?? 0 };
    this.kfFolder
      .add(tProxy, 't', 0, 1, 0.001)
      .name('t（到達時刻 0–1）')
      .onChange((v) => {
        times[i] = Number(v.toFixed(4));
        this._rebuildLine();
        this.onChanged?.();
      });

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
        this._freeRange(lookF.add(pr, ax, -180, 180, 0.01))
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
        this._freeRange(lookF.add(lookProxy, ax, -180, 180, 0.01))
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
          this._freeRange(lookF.add(aimKeyProxy, ax, -180, 180, 0.01))
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

  // ---- 粒子ストリーム（generate）の制御点ハンドル p1/p2 ----

  /** プレビュー中の PhotoParticles（タイムラインの stage が保持）。無ければ null */
  _particles() {
    return this.timeline?.stage?.particles ?? null;
  }

  _disposeStream() {
    if (this.tc.object === this.streamP1Sphere || this.tc.object === this.streamP2Sphere) {
      this.tc.detach();
      this.tcHelper.visible = false;
    }
    for (const m of this.streamMarks) {
      this.viz.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.streamMarks = [];
    for (const k of ['streamP1Sphere', 'streamP2Sphere', 'streamLine']) {
      const o = this[k];
      if (!o) continue;
      this.viz.remove(o);
      o.geometry.dispose();
      o.material.dispose();
      this[k] = null;
    }
  }

  _mkStreamHandle(pos, kind) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 14, 10),
      new THREE.MeshBasicMaterial({ color: STREAM_COLOR, depthTest: false, transparent: true })
    );
    m.renderOrder = 1000;
    m.position.copy(pos);
    m.userData = { kind };
    this.viz.add(m);
    return m;
  }

  /**
   * 粒子ストリームのベジェ(p0→p3, 制御点 p1/p2)を可視化＆ハンドル化。
   * cfg.streamP1Offset/Offset から live stream(this._stream)を再同期するので、
   * Parameters 編集・undo にも追従する。p0/p3 は写真位置/螺旋入口から導出（参照表示のみ）。
   */
  _rebuildStreamViz() {
    this._disposeStream();
    if (!this.active) return;
    const s = this._particles()?._stream;
    if (!s) return;
    const cfg = this.ctx.choreo.data.generate.particles;
    // cfg → live stream を再導出（uniform は s.p1/p2 を参照しているので即反映）
    s.p1.copy(s.p0).lerp(s.p3, 0.33).add(new THREE.Vector3(...cfg.streamP1Offset));
    s.p2.copy(s.p0).lerp(s.p3, 0.66).add(new THREE.Vector3(...cfg.streamP2Offset));

    for (const p of [s.p0, s.p3]) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0x888888, depthTest: false, transparent: true, opacity: 0.7 })
      );
      m.renderOrder = 998;
      m.position.copy(p);
      this.viz.add(m);
      this.streamMarks.push(m);
    }
    this.streamP1Sphere = this._mkStreamHandle(s.p1, 'stream-p1');
    this.streamP2Sphere = this._mkStreamHandle(s.p2, 'stream-p2');

    const pts = new THREE.CubicBezierCurve3(s.p0, s.p1, s.p2, s.p3).getPoints(64);
    this.streamLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: STREAM_COLOR, depthTest: false, transparent: true, opacity: 0.8 })
    );
    this.streamLine.renderOrder = 997;
    this.viz.add(this.streamLine);
  }

  /** ドラッグ中: ストリーム曲線ラインだけ更新（球は dispose しない） */
  _redrawStreamLine() {
    const s = this._particles()?._stream;
    if (!this.streamLine || !s) return;
    const pts = new THREE.CubicBezierCurve3(s.p0, s.p1, s.p2, s.p3).getPoints(64);
    this.streamLine.geometry.dispose();
    this.streamLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  }

  // ---- 配置ライト（generate.lights）----

  _lights() {
    const g = this.ctx.choreo.data.generate;
    if (!Array.isArray(g.lights)) g.lights = [];
    return g.lights;
  }

  _currentLight() {
    return this._lights().find((l) => l.id === this.state.lightId);
  }

  _uniqueLightId(base) {
    const ids = new Set(this._lights().map((l) => l.id));
    let n = 1;
    while (ids.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  }

  /** ライト変更をプレビューへ反映＋undo通知（ビューポート再構築なし） */
  _lightChanged() {
    const stage = this.timeline?.stage;
    stage?.syncLights?.(); // 静的値を反映（base）
    stage?.lightRig?.setTime?.(this.timeline?.currentTime ?? 0); // キーフレームを現在時刻で上書き
    this.onChanged?.();
  }

  _disposeLightViz() {
    if (
      this.tc.object &&
      (this.lightMarkers.includes(this.tc.object) || this.tc.object === this.lightTargetMarker)
    ) {
      this.tc.detach();
      this.tcHelper.visible = false;
    }
    for (const m of this.lightMarkers) {
      this.viz.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.lightMarkers = [];
    for (const k of ['lightTargetMarker', 'lightLine']) {
      const o = this[k];
      if (!o) continue;
      this.viz.remove(o);
      o.geometry.dispose();
      o.material.dispose();
      this[k] = null;
    }
  }

  /** 全ライトの位置マーカー（選択は強調）＋選択 spot/directional の target/線を再構築 */
  _rebuildLightViz() {
    this._disposeLightViz();
    if (!this.active) return;
    const lights = this._lights();
    for (const lt of lights) {
      const sel = lt.id === this.state.lightId;
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(sel ? 0.12 : 0.09, 14, 10),
        new THREE.MeshBasicMaterial({
          color: sel ? SELECTED_COLOR : LIGHT_COLOR,
          depthTest: false,
          transparent: true,
        })
      );
      m.renderOrder = 1000;
      m.position.set(lt.pos[0], lt.pos[1], lt.pos[2]);
      m.userData = { kind: 'light-pos', id: lt.id };
      this.viz.add(m);
      this.lightMarkers.push(m);
    }
    const cur = this._currentLight();
    if (cur && (cur.type === 'spot' || cur.type === 'directional') && Array.isArray(cur.target)) {
      this.lightTargetMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 12, 10),
        new THREE.MeshBasicMaterial({ color: LIGHT_COLOR, depthTest: false, transparent: true })
      );
      this.lightTargetMarker.renderOrder = 1000;
      this.lightTargetMarker.position.set(cur.target[0], cur.target[1], cur.target[2]);
      this.lightTargetMarker.userData = { kind: 'light-target', id: cur.id };
      this.viz.add(this.lightTargetMarker);
      this.lightLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(...cur.pos),
          new THREE.Vector3(...cur.target),
        ]),
        new THREE.LineBasicMaterial({ color: LIGHT_COLOR, depthTest: false, transparent: true, opacity: 0.5 })
      );
      this.lightLine.renderOrder = 999;
      this.viz.add(this.lightLine);
    }
    // ライト選択中ならギズモを対象マーカーへ
    if (this.sel.kind === 'light-pos' && cur) {
      const m = this.lightMarkers.find((x) => x.userData.id === cur.id);
      if (m && this.active) {
        this.tc.attach(m);
        this.tcHelper.visible = true;
      }
    } else if (this.sel.kind === 'light-target' && this.lightTargetMarker && this.active) {
      this.tc.attach(this.lightTargetMarker);
      this.tcHelper.visible = true;
    }
  }

  _redrawLightLine() {
    const cur = this._currentLight();
    if (!this.lightLine || !cur || !Array.isArray(cur.target)) return;
    this.lightLine.geometry.dispose();
    this.lightLine.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...cur.pos),
      new THREE.Vector3(...cur.target),
    ]);
  }

  /** 選択ライトの編集パネル（種別/色/強度/位置/距離/コーン/target） */
  _buildLightPanel() {
    this.lightFolder.destroy();
    this.lightFolder = this.lightsGui.addFolder('Selected light');
    this.lightPanel = null;
    const lt = this._currentLight();
    if (!lt) return;
    this.lightFolder.add({ t: lt.id }, 't').name('light').disable();
    this.lightFolder
      .add({ type: lt.type }, 'type', ['point', 'spot', 'directional'])
      .name('種別')
      .onChange((m) => this._setLightType(m));
    this.lightFolder.addColor(lt, 'color').name('色').onChange(() => this._lightChanged());
    this._lightKeyFolder(lt, 'colorKeys', 'color');
    this._freeRange(this.lightFolder.add(lt, 'intensity', 0, 50, 0.1))
      .name('強度')
      .onChange(() => this._lightChanged());
    this._lightKeyFolder(lt, 'intensityKeys', 'scalar');

    const posF = this.lightFolder.addFolder('位置');
    const posProxy = { x: lt.pos[0], y: lt.pos[1], z: lt.pos[2] };
    const posCtrls = ['x', 'y', 'z'].map((ax, ai) =>
      posF
        .add(posProxy, ax, -20, 20, 0.01)
        .name(ax)
        .onChange((v) => {
          lt.pos[ai] = Number(v.toFixed(3));
          const m = this.lightMarkers.find((x) => x.userData.id === lt.id);
          if (m) m.position.set(lt.pos[0], lt.pos[1], lt.pos[2]);
          this._redrawLightLine();
          this._lightChanged();
        })
    );

    if (lt.type !== 'directional') {
      this.lightFolder.add(lt, 'distance', 0, 50, 0.1).name('distance(0=無限)').onChange(() => this._lightChanged());
      this.lightFolder.add(lt, 'decay', 0, 4, 0.1).name('decay').onChange(() => this._lightChanged());
    }
    if (lt.type === 'spot') {
      this.lightFolder.add(lt, 'angle', 0.05, 1.4, 0.01).name('コーン角').onChange(() => this._lightChanged());
      this.lightFolder.add(lt, 'penumbra', 0, 1, 0.01).name('penumbra').onChange(() => this._lightChanged());
    }
    if ((lt.type === 'spot' || lt.type === 'directional') && Array.isArray(lt.target)) {
      const tF = this.lightFolder.addFolder('target（向き先）');
      ['x', 'y', 'z'].map((ax, ai) =>
        tF
          .add(lt.target, ai, -20, 20, 0.01)
          .name(ax)
          .onChange(() => {
            if (this.lightTargetMarker) this.lightTargetMarker.position.set(...lt.target);
            this._redrawLightLine();
            this._lightChanged();
          })
      );
    }
    this.lightPanel = { posProxy, posCtrls };
  }

  /** intensity/color のキーフレーム編集UI（点滅・パルス。t=絶対秒、現在時刻で追加） */
  _lightKeyFolder(lt, prop, kind) {
    const keys = lt[prop];
    const has = Array.isArray(keys) && keys.length;
    const label = kind === 'color' ? 'color keyframes（時間変化）' : 'intensity keyframes（点滅/パルス）';
    const f = this.lightFolder.addFolder(label);
    f.add({ on: !!has }, 'on').name('キーフレーム化').onChange((on) => this._setLightKeys(lt, prop, kind, on));
    if (!has) return;
    f.add({ add: () => this._addLightKey(lt, prop, kind) }, 'add').name('＋ キー（現在時刻）');
    keys.forEach((k, idx) => {
      const r = f.addFolder(`#${idx}  t=${(k.t ?? 0).toFixed(2)}s`);
      r.add(k, 't', 0, 20, 0.05).name('t（秒）').onChange(() => this._lightChanged());
      if (kind === 'scalar') {
        this._freeRange(r.add(k, 'v', 0, 50, 0.1)).name('強度').onChange(() => this._lightChanged());
      } else {
        r.addColor(k, 'c').name('色').onChange(() => this._lightChanged());
      }
      r.add({ rm: () => this._removeLightKey(lt, prop, idx) }, 'rm').name('削除');
    });
  }

  _setLightKeys(lt, prop, kind, on) {
    const now = Number((this.timeline?.currentTime ?? 0).toFixed(2));
    if (on) {
      lt[prop] =
        kind === 'scalar' ? [{ t: now, v: lt.intensity ?? 1 }] : [{ t: now, c: lt.color ?? '#ffffff' }];
    } else {
      delete lt[prop];
    }
    this._buildLightPanel();
    this._lightChanged();
  }

  _addLightKey(lt, prop, kind) {
    const keys = lt[prop];
    if (!keys) return;
    const now = Number((this.timeline?.currentTime ?? 0).toFixed(2));
    keys.push(kind === 'scalar' ? { t: now, v: lt.intensity ?? 1 } : { t: now, c: lt.color ?? '#ffffff' });
    this._buildLightPanel();
    this._lightChanged();
  }

  _removeLightKey(lt, prop, idx) {
    lt[prop]?.splice(idx, 1);
    if (lt[prop] && !lt[prop].length) delete lt[prop];
    this._buildLightPanel();
    this._lightChanged();
  }

  /** シーン内のライトをスタック表示して選択するパネルを再構築 */
  _buildLightList() {
    if (this.lightListFolder) this.lightListFolder.destroy();
    this.lightListFolder = this.lightsFolder.addFolder('一覧（クリックで選択）');
    const lights = this._lights();
    if (!lights.length) {
      this.lightListFolder.add({ i: '（なし）' }, 'i').name('lights').disable();
      return;
    }
    for (const lt of lights) {
      const selected = lt.id === this.state.lightId;
      this.lightListFolder
        .add({ sel: () => this._selectLight(lt.id) }, 'sel')
        .name(`${selected ? '● ' : '○ '}${lt.id}（${lt.type}）`);
    }
  }

  /** 選択ライトの種別を変更（必要フィールドを補完。LightRig が再生成で対応） */
  _setLightType(newType) {
    const lt = this._currentLight();
    if (!lt || lt.type === newType) return;
    lt.type = newType;
    if (newType !== 'directional') {
      lt.distance = lt.distance ?? 0;
      lt.decay = lt.decay ?? 2;
    }
    if ((newType === 'spot' || newType === 'directional') && !Array.isArray(lt.target)) {
      lt.target = [0, 0.5, 0];
    }
    if (newType === 'spot') {
      lt.angle = lt.angle ?? 0.6;
      lt.penumbra = lt.penumbra ?? 0.3;
    }
    this._rebuildLightViz();
    this._buildLightPanel();
    this._buildLightList();
    this._lightChanged();
  }

  _addLight(type) {
    const lights = this._lights();
    const id = this._uniqueLightId(type);
    const lt = {
      id,
      type,
      pos: [0, 3, 1],
      color: '#ffffff',
      intensity: type === 'directional' ? 1.5 : 15,
    };
    if (type !== 'directional') {
      lt.distance = 0;
      lt.decay = 2;
    }
    if (type === 'spot' || type === 'directional') lt.target = [0, 0.5, 0];
    if (type === 'spot') {
      lt.angle = 0.6;
      lt.penumbra = 0.3;
    }
    lights.push(lt);
    this.state.lightId = id;
    this.sel = { kind: 'light-pos', side: null };
    this._rebuildLightViz();
    this._buildLightPanel();
    this._buildLightList();
    this._lightChanged();
  }

  _removeLight() {
    const lights = this._lights();
    const i = lights.findIndex((l) => l.id === this.state.lightId);
    if (i < 0) return;
    lights.splice(i, 1);
    this.state.lightId = lights[Math.max(0, i - 1)]?.id ?? '';
    this.sel = { kind: 'anchor', side: null };
    this._rebuildLightViz();
    this._buildLightPanel();
    this._buildLightList();
    this._lightChanged();
  }

  /** ビューポート/一覧からライト選択 */
  _selectLight(id) {
    this.state.lightId = id;
    this.sel = { kind: 'light-pos', side: null };
    this._rebuildLightViz();
    this._buildLightPanel();
    this._buildLightList();
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
   * 定点(static)オーバーレイを追加して選択する。
   * シークバー（プレイヘッド）位置から start で被せ、playhead が乗っている base
   * ショットの直後に挿入する（配列順は表示用。実時刻は start が決める）。
   */
  _addShot() {
    const shots = this._shots();
    const tl = this.timeline;
    const start = tl?.isOpen && tl.baked ? Number(tl.currentTime.toFixed(3)) : 0; // シークバー位置から開始
    const phId = this._playheadShotId();
    const idx = phId ? shots.findIndex((s) => s.id === phId) : -1;
    const at = idx >= 0 ? idx + 1 : shots.length;
    const id = this._uniqueId('static');
    const shot = {
      id,
      type: 'static',
      start,
      duration: 2.0,
      pos: [0, 1, 3],
      lookAt: { mode: 'fixed', point: [0, 0.5, 0] },
      fov: 45,
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
    // 隣接 path との境界を C1 連続に表示（本番ベイクと同じ neighbor を使用）
    const nb = pathBoundaryNeighbors(this._shots(), this._shots().indexOf(phase), (s) => this._shotOffset(s));
    const curve = buildCurve(
      phase.path,
      this._offset(),
      phase.closed === true,
      this.ctx.world.camera.position,
      nb.prev,
      nb.next
    );
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
    if (this._modal) return; // モーダル変換中は再選択しない
    if (this.tc.axis) return;
    const targets = [
      ...this.handles,
      ...(this.aimSphere ? [this.aimSphere] : []),
      ...this.staticAimSpheres,
      ...(this.staticLookSphere ? [this.staticLookSphere] : []),
      ...(this.staticPosSphere ? [this.staticPosSphere] : []),
      ...(this.streamP1Sphere ? [this.streamP1Sphere] : []),
      ...(this.streamP2Sphere ? [this.streamP2Sphere] : []),
      ...this.lightMarkers,
      ...(this.lightTargetMarker ? [this.lightTargetMarker] : []),
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
    if (ud.kind === 'light-pos') {
      this._selectLight(ud.id); // ライト選択（gizmo は light-pos へ）
    } else if (ud.kind === 'light-target') {
      this.sel = { kind: 'light-target', side: null };
      if (this.lightTargetMarker) {
        this.tc.attach(this.lightTargetMarker);
        this.tcHelper.visible = true;
      }
    } else if (ud.kind === 'stream-p1' || ud.kind === 'stream-p2') {
      this.sel = { kind: ud.kind, side: null };
      const obj = ud.kind === 'stream-p1' ? this.streamP1Sphere : this.streamP2Sphere;
      if (obj) {
        this.tc.attach(obj);
        this.tcHelper.visible = true;
      }
    } else if (ud.kind === 'static-aimkey') {
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

  // target 省略時は tc のドラッグ対象。モーダル変換では実際に動かしたマーカーを渡す
  _onGizmoChange(target) {
    const obj = target || this.tc.object;
    if (!obj) return;
    const ud = obj.userData;

    if (ud.kind === 'light-pos' || ud.kind === 'light-target') {
      const lt = this._lights().find((l) => l.id === ud.id);
      if (!lt) return;
      const arr = ud.kind === 'light-pos' ? lt.pos : lt.target;
      if (!arr) return;
      arr[0] = Number(obj.position.x.toFixed(3));
      arr[1] = Number(obj.position.y.toFixed(3));
      arr[2] = Number(obj.position.z.toFixed(3));
      this._redrawLightLine();
      if (ud.kind === 'light-pos' && this.lightPanel?.posProxy) {
        [this.lightPanel.posProxy.x, this.lightPanel.posProxy.y, this.lightPanel.posProxy.z] = lt.pos;
        this.lightPanel.posCtrls.forEach((c) => c.updateDisplay());
      }
      this._lightChanged();
      return;
    }
    if (ud.kind === 'stream-p1' || ud.kind === 'stream-p2') {
      const s = this._particles()?._stream;
      if (!s) return;
      const cfg = this.ctx.choreo.data.generate.particles;
      const frac = ud.kind === 'stream-p1' ? 0.33 : 0.66;
      const off = obj.position.clone().sub(s.p0.clone().lerp(s.p3, frac));
      // offset 配列は in-place 更新（Parameters の lil-gui バインドを壊さない）
      const arr = ud.kind === 'stream-p1' ? cfg.streamP1Offset : cfg.streamP2Offset;
      arr[0] = Number(off.x.toFixed(3));
      arr[1] = Number(off.y.toFixed(3));
      arr[2] = Number(off.z.toFixed(3));
      // live stream（uniform 参照 Vector3）を mutate → GLSL/CPU 即同期
      (ud.kind === 'stream-p1' ? s.p1 : s.p2).copy(obj.position);
      this._redrawStreamLine();
      this.onChanged?.();
      return;
    }
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

  /**
   * キーフレーム（アンカー）追加。シークバー（プレイヘッド）が乗っている path ショットの、
   * その時刻のカメラ位置＝曲線上の点に新しいアンカーを挿入する。
   * - playhead 位置の base ショットを対象にする（path 以外なら不可メッセージ）
   * - 挿入位置は playhead 直前のアンカーの直後（markers の通過フレームで判定）
   * - タイムライン未起動時は従来の中点挿入にフォールバック
   */
  _addKeyframe() {
    const tl = this.timeline;
    if (!tl?.isOpen || !tl.baked) return this._addKeyframeMidpoint();

    const F = Math.round(tl.frame);
    const info = tl._phaseAt(F); // playhead が乗っている base ショット情報
    const shot = info && this._shots().find((s) => s.id === info.id);
    if (!shot) return;
    if (!Array.isArray(shot.path)) {
      tl._flashMessage?.('ホールド(follow/loop)ショットにはアンカーを追加できません');
      return;
    }

    // playhead 直前のアンカー index（markers の通過フレームから）
    let prevKf = 0;
    for (const m of info.markers ?? []) if (m.frame <= F) prevKf = m.kf;

    // 新アンカー = その時刻のベイク済みカメラ位置（曲線上）。relativeTo はローカルへ戻す
    const off = this._shotOffset(shot);
    const local = new THREE.Vector3(
      tl.baked.pos[F * 3],
      tl.baked.pos[F * 3 + 1],
      tl.baked.pos[F * 3 + 2]
    ).sub(off);
    const anchor = [Number(local.x.toFixed(3)), Number(local.y.toFixed(3)), Number(local.z.toFixed(3))];

    // 到達時刻 t = シークバー位置の eased 進行（前後アンカーの t の間にクランプ）
    const times = this._ensureTimes(shot);
    const easeFn = gsap.parseEase(shot.ease || 'none');
    const linP = info.frameCount > 0 ? (F - info.startFrame) / info.frameCount : 0;
    const tPrev = times[prevKf] ?? 0;
    const tNext = times[prevKf + 1] ?? 1;
    let t = easeFn(Math.max(0, Math.min(linP, 1)));
    t = Math.max(tPrev + 1e-4, Math.min(t, tNext - 1e-4));

    shot.path.splice(prevKf + 1, 0, anchor);
    times.splice(prevKf + 1, 0, Number(t.toFixed(4)));
    this.state.phaseId = shot.id; // playhead のショットを選択対象に
    this.state.keyframe = prevKf + 1;
    this.sel = { kind: 'anchor', side: null };
    this.rebuild();
    this.onChanged?.();
  }

  /** フォールバック: 選択キーフレームの直後に中点挿入（タイムライン未起動時） */
  _addKeyframeMidpoint() {
    const phase = this._currentPhase();
    if (!phase) return;
    const i = this.state.keyframe;
    const cur = this._localPos(phase.path[i]);
    const nextEntry = phase.path[i + 1];
    const dup = nextEntry
      ? cur.clone().lerp(this._localPos(nextEntry), 0.5)
      : cur.clone().add(new THREE.Vector3(0.3, 0, 0));
    const times = this._ensureTimes(phase);
    const tMid = nextEntry ? ((times[i] ?? 0) + (times[i + 1] ?? 1)) / 2 : Math.min(1, (times[i] ?? 0) + 0.1);
    phase.path.splice(i + 1, 0, [dup.x, dup.y, dup.z].map((v) => Number(v.toFixed(3))));
    times.splice(i + 1, 0, Number(tMid.toFixed(4)));
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
    if (Array.isArray(phase.times) && phase.times.length > i) phase.times.splice(i, 1);
    this.state.keyframe = Math.max(0, i - 1);
    this.sel = { kind: 'anchor', side: null };
    this.rebuild();
    this.onChanged?.();
  }

  // ====================== k / delete キーフレーム操作 ======================
  // k=現在時刻にキーフレーム追加 / delete=選択キーフレーム削除。
  // 対象は「アクティブな要素」＝選択状態（this.sel / 選択ショット）で切り替える。

  /**
   * k / delete が対象にする「アクティブな要素」種別を選択状態から判定。
   *   'light' … ライト選択中（色/強度キーフレーム）
   *   'aim'   … 定点ショットの注視点パン（lookAt.keys）
   *   'path'  … カメラパス（既定。プレイヘッド下の path ショットのアンカー）
   */
  _activeKeyTarget() {
    if ((this.sel?.kind === 'light-pos' || this.sel?.kind === 'light-target') && this._currentLight()) {
      return 'light';
    }
    const shot = this._currentShot();
    if (shot?.type === 'static' && Array.isArray(shot.lookAt?.keys)) return 'aim';
    return 'path';
  }

  /** k: アクティブな要素に現在時刻のキーフレームを追加（処理したら true） */
  _addKeyframeActive() {
    switch (this._activeKeyTarget()) {
      case 'light': {
        const lt = this._currentLight();
        let did = false;
        for (const [prop, kind] of [['intensityKeys', 'scalar'], ['colorKeys', 'color']]) {
          if (Array.isArray(lt[prop]) && lt[prop].length) {
            this._addLightKey(lt, prop, kind);
            did = true;
          }
        }
        if (!did) this.timeline?._flashMessage?.('このライトはキーフレーム化されていません（パネルで有効化）');
        return true;
      }
      case 'aim':
        this._addAimKey();
        return true;
      default:
        this._addKeyframe();
        return true;
    }
  }

  /** delete: アクティブな要素の選択中キーフレームを削除（処理したら true） */
  _removeKeyframeActive() {
    switch (this._activeKeyTarget()) {
      case 'light':
        return this._removeNearestLightKey(this._currentLight());
      case 'aim':
        this._removeAimKey();
        return true;
      default:
        this._removeKeyframe();
        return true;
    }
  }

  /** プレイヘッド（現在時刻）に最も近いライトキーを色/強度トラックから1つ削除 */
  _removeNearestLightKey(lt) {
    const now = this.timeline?.currentTime ?? 0;
    let best = null;
    for (const prop of ['intensityKeys', 'colorKeys']) {
      const keys = lt?.[prop];
      if (!Array.isArray(keys)) continue;
      keys.forEach((k, idx) => {
        const d = Math.abs((k.t ?? 0) - now);
        if (!best || d < best.d) best = { prop, idx, d };
      });
    }
    if (!best) return false;
    this._removeLightKey(lt, best.prop, best.idx);
    return true;
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

  // ====================== Blender 風モーダル変換 ======================
  // g=移動 / r=回転、続けて x|y|z でワールド軸拘束、数字で正確な数値入力。
  // 移動は対象マーカーを動かし、回転はその対象を「自然な基準点」周りに回す
  // （ライト注視点→ライト位置 / ライト位置→注視点 / 定点注視点→定点位置 …）。
  // 内部的には既存の this.tc.object を直接動かして _onGizmoChange() で choreo へ反映する。

  /** 最後のポインタ位置（client座標）を保持。移動モーダル中だけマウス追従で更新
   *  （回転はリングドラッグの objectChange と数値入力で駆動するため追従不要） */
  _trackPointer(e) {
    this._lastPointer.x = e.clientX;
    this._lastPointer.y = e.clientY;
    if (this._modal?.type === 'translate') this._updateModal();
  }

  _handleModalKey(e) {
    if (!this.active) return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return; // undo/redo 等は素通し

    const m = this._modal;
    const k = e.key;

    if (!m) {
      // 開始コマンド（選択中ギズモがある時だけ）
      let started = false;
      if (k === 'g' || k === 'G') started = this._startModal('translate');
      else if (k === 'r' || k === 'R') started = this._startModal('rotate');
      else if (k === 'k' || k === 'K') started = this._addKeyframeActive();
      else if (k === 'Delete' || k === 'Backspace') started = this._removeKeyframeActive();
      if (started) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    let handled = true;
    if (k === 'Escape') this._cancelModal();
    else if (k === 'Enter') this._confirmModal();
    else if (k === 'g' || k === 'G') { this._cancelModal(); this._startModal('translate'); } // モード切替（元状態から再初期化）
    else if (k === 'r' || k === 'R') { this._cancelModal(); this._startModal('rotate'); }
    else if (k === 'x' || k === 'X') this._setModalAxis('x');
    else if (k === 'y' || k === 'Y') this._setModalAxis('y');
    else if (k === 'z' || k === 'Z') this._setModalAxis('z');
    else if (k === 'Backspace') { m.numeric = m.numeric.slice(0, -1); this._updateModal(); }
    else if (k === '-') { m.numeric = m.numeric.startsWith('-') ? m.numeric.slice(1) : '-' + m.numeric; this._updateModal(); }
    else if (/^[0-9.]$/.test(k)) { m.numeric += k; this._updateModal(); }
    else handled = false;

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  _handleModalPointerDown(e) {
    const m = this._modal;
    if (!m) return;
    if (e.button === 2) {
      // 右クリック=取消
      e.preventDefault();
      e.stopPropagation();
      this._cancelModal();
      return;
    }
    if (m.type === 'rotate') {
      // 回転は左クリックでリングを掴ませる（tc に通す）。確定は Enter。
      return;
    }
    // 移動モーダル：左クリックで確定
    e.preventDefault();
    e.stopPropagation();
    this._confirmModal();
  }

  /** ワールド軸の単位ベクトル */
  _axisVec(axis) {
    return new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  }

  /**
   * 回転の基準点（ワールド）。対象の種別に応じて「向きの根元」を返す。
   * 自然な基準が無いもの（アンカー/ハンドル/ストリーム）は自分自身＝回転は実質無効。
   */
  _transformPivot(obj) {
    const ud = obj.userData || {};
    const self = obj.position.clone();
    switch (ud.kind) {
      case 'light-target': {
        const lt = this._lights().find((l) => l.id === ud.id);
        return lt && Array.isArray(lt.pos) ? new THREE.Vector3(...lt.pos) : self;
      }
      case 'light-pos': {
        const lt = this._lights().find((l) => l.id === ud.id);
        return lt && Array.isArray(lt.target) ? new THREE.Vector3(...lt.target) : self;
      }
      case 'static-look':
      case 'static-aimkey':
        return this._staticPosWorld(this._currentShot()) || self;
      case 'static-pos':
        return this._staticLookPoint(this._currentShot()) || self;
      case 'aim':
      case 'handle': {
        const entry = this._currentPhase()?.path[ud.kfIndex];
        return entry ? kfPos(entry).add(this._offset()) : self;
      }
      default:
        return self; // anchor / stream-p1 / stream-p2: 回転の基準なし
    }
  }

  /**
   * 回転時の操作対象。位置/姿勢の「位置」は固定し「向き」を回すため、向きマーカーへ差し替える。
   * - ライト: 位置マーカー(light-pos)選択でも target を回す（pivot=ライト位置）
   * - カメラのキーフレーム: アンカー選択時は注視点(look)上書きをONにして注視点を回す（pivot=アンカー位置）。
   *   look が無ければ「今見ている点」を初期値に生成するので向きは飛ばない。
   * 戻り値 createdLook: 今回 look 上書きを新規生成した場合 true（取消時に解除する）。
   */
  _rotateTarget(obj) {
    const ud = obj.userData || {};
    if (ud.kind === 'light-pos') {
      const lt = this._lights().find((l) => l.id === ud.id);
      if (lt && Array.isArray(lt.target) && this.lightTargetMarker?.userData?.id === ud.id) {
        return { obj: this.lightTargetMarker, createdLook: false };
      }
    }
    if (ud.kind === 'anchor' && ud.kfIndex === this.state.keyframe) {
      const entry = this._currentPhase()?.path[ud.kfIndex];
      if (entry && entry !== '@current') {
        const hadLook = this._hasLook(entry);
        if (!hadLook) this._setLookOverride(true); // 注視点上書きをON（現在の注視点が初期値）
        if (this.aimSphere) return { obj: this.aimSphere, createdLook: !hadLook };
      }
    }
    return { obj, createdLook: false };
  }

  /** モーダル変換を開始（または現モーダルのモードを切替）。対象が無ければ false */
  _startModal(type) {
    const restoreObj = this.tc.object; // 終了後に戻すギズモ対象（選択マーカー）
    if (!restoreObj || !this.active) return false;
    let obj = restoreObj;
    let createdLook = false;
    if (type === 'rotate') {
      const r = this._rotateTarget(obj);
      obj = r.obj;
      createdLook = r.createdLook;
    }
    const startPos = obj.position.clone();
    const pivot = this._transformPivot(obj);
    this._modal = {
      type,
      createdLook,
      restoreObj,
      axis: null, // null = 移動:視線平面 / 回転:視線軸
      numeric: '',
      obj,
      startPos,
      pivot,
      startDir: startPos.clone().sub(pivot), // 回転対象の向きベクトル（開始時）
      startPointer: { x: this._lastPointer.x, y: this._lastPointer.y },
      value: 0,
    };
    if (type === 'rotate') {
      // pivot に置いたプロキシへ回転リングを接続し、ドラッグで掴めるようにする
      this._rotProxy.position.copy(pivot);
      this._rotProxy.quaternion.identity();
      this._rotProxy.updateMatrixWorld();
      this.tc.attach(this._rotProxy);
      this.tc.setMode('rotate');
      this.tc.enabled = this.active; // ← リングを掴める
    } else {
      this.tc.setMode('translate');
      this.tc.enabled = false; // 移動は数値/マウス平面で駆動
    }
    this.tcHelper.visible = true;
    this._updateModal();
    return true;
  }

  _setModalAxis(axis) {
    const m = this._modal;
    m.axis = m.axis === axis ? null : axis; // 同じ軸の再押下で解除
    if (m.type === 'rotate') {
      // 軸拘束時は該当リングだけ表示
      this.tc.showX = !m.axis || m.axis === 'x';
      this.tc.showY = !m.axis || m.axis === 'y';
      this.tc.showZ = !m.axis || m.axis === 'z';
    }
    this._updateModal();
  }

  /** 現在の入力（マウス/数値・軸・リングドラッグ）から対象を再計算して反映 */
  _updateModal() {
    const m = this._modal;
    if (!m) return;
    if (m.type === 'translate') {
      const r = this._computeTranslate(m);
      m.value = r.value;
      m.obj.position.copy(r.pos);
      this._onGizmoChange(m.obj);
    } else {
      // 数値入力があればプロキシを単一軸回転で上書き、無ければリングドラッグのまま反映
      const num = parseFloat(m.numeric);
      if (!Number.isNaN(num)) {
        this._rotProxy.quaternion.setFromAxisAngle(this._rotAxisVec(m), num * THREE.MathUtils.DEG2RAD);
        this._rotProxy.updateMatrixWorld();
      }
      this._applyRotProxy();
    }
    this._updateHud();
  }

  /** プロキシの回転を向きベクトルへ写像してマーカーへ反映 */
  _applyRotProxy() {
    const m = this._modal;
    if (!m || m.type !== 'rotate') return;
    const pos = m.startDir.clone().applyQuaternion(this._rotProxy.quaternion).add(m.pivot);
    m.obj.position.copy(pos);
    this._onGizmoChange(m.obj);
    const q = this._rotProxy.quaternion;
    m.value = 2 * Math.acos(Math.min(1, Math.abs(q.w))) * THREE.MathUtils.RAD2DEG;
  }

  /** 数値回転の軸（未指定なら視線軸） */
  _rotAxisVec(m) {
    if (m.axis) return this._axisVec(m.axis);
    const f = new THREE.Vector3();
    this.ctx.world.camera.getWorldDirection(f);
    return f.normalize();
  }

  /** tc の objectChange を、回転プロキシのドラッグ／通常ギズモへ振り分け */
  _onObjectChange() {
    if (this._modal?.type === 'rotate' && this.tc.object === this._rotProxy) {
      this._applyRotProxy();
      this._updateHud();
      return;
    }
    this._onGizmoChange();
  }

  /** モーダル終了時の共通後始末（ギズモを選択マーカーへ戻す） */
  _endModal() {
    this.tc.setMode('translate'); // 通常ドラッグの矢印へ戻す
    this.tc.showX = this.tc.showY = this.tc.showZ = true;
    this.tc.enabled = this.active;
    this._removeHud();
  }

  _confirmModal() {
    const m = this._modal;
    if (!m) return;
    this._modal = null;
    this._endModal();
    if (m.restoreObj && this.active) this.tc.attach(m.restoreObj);
    this.onChanged?.();
  }

  _cancelModal() {
    const m = this._modal;
    if (!m) return;
    m.obj.position.copy(m.startPos); // 元へ戻す
    this._onGizmoChange(m.obj); // データを開始時へ復元
    this._modal = null;
    if (m.createdLook) this._setLookOverride(false); // 今回ONにした注視点上書きは取消で解除
    this._endModal();
    if (m.restoreObj && this.active) this.tc.attach(m.restoreObj);
  }

  /** client座標 → NDC */
  _pointerNdc(p) {
    const rect = this.ctx.world.renderer.domElement.getBoundingClientRect();
    _ndc.set(
      ((p.x - rect.left) / rect.width) * 2 - 1,
      -((p.y - rect.top) / rect.height) * 2 + 1
    );
    return _ndc;
  }

  /** 軸直線(origin,dir) 上で、ポインタ視線に最も近い点のパラメータ t */
  _closestParamOnAxis(origin, dir, pointer) {
    this._modalRay.setFromCamera(this._pointerNdc(pointer), this.ctx.world.camera);
    const ro = this._modalRay.ray.origin;
    const rd = this._modalRay.ray.direction; // 正規化済み
    const w0 = origin.clone().sub(ro);
    const b = dir.dot(rd);
    const d = dir.dot(w0);
    const e = rd.dot(w0);
    const denom = 1 - b * b; // dir,rd とも単位ベクトル → a=c=1
    if (Math.abs(denom) < 1e-6) return 0; // 視線と軸が平行
    return (b * e - d) / denom;
  }

  _computeTranslate(m) {
    const num = parseFloat(m.numeric);
    const hasNum = !Number.isNaN(num);
    if (m.axis) {
      const dir = this._axisVec(m.axis);
      const dist = hasNum
        ? num
        : this._closestParamOnAxis(m.startPos, dir, this._lastPointer) -
          this._closestParamOnAxis(m.startPos, dir, m.startPointer);
      return { pos: m.startPos.clone().addScaledVector(dir, dist), value: dist };
    }
    if (hasNum) {
      // 軸未指定の数値入力は X 軸へ（Blender 同様、最初の軸に適用）
      return { pos: m.startPos.clone().addScaledVector(this._axisVec('x'), num), value: num };
    }
    // 視線平面に沿った自由移動
    const n = new THREE.Vector3();
    this.ctx.world.camera.getWorldDirection(n);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, m.startPos);
    const cur = this._rayOnPlane(this._lastPointer, plane);
    const start = this._rayOnPlane(m.startPointer, plane);
    if (!cur || !start) return { pos: m.startPos.clone(), value: 0 };
    const delta = cur.sub(start);
    return { pos: m.startPos.clone().add(delta), value: delta.length() };
  }

  _rayOnPlane(pointer, plane) {
    this._modalRay.setFromCamera(this._pointerNdc(pointer), this.ctx.world.camera);
    const hit = new THREE.Vector3();
    return this._modalRay.ray.intersectPlane(plane, hit) ? hit : null;
  }

  // ---- モーダル中の操作ヒント（画面上部） ----
  _ensureHud() {
    if (this._hud) return this._hud;
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2000;' +
      'padding:4px 10px;background:rgba(20,20,26,.85);color:#e8e8ee;border:1px solid #3a3a44;' +
      'border-radius:5px;font:12px/1.3 "SF Mono",Menlo,Consolas,monospace;' +
      'pointer-events:none;white-space:nowrap;';
    document.body.appendChild(el);
    this._hud = el;
    return el;
  }

  _updateHud() {
    const m = this._modal;
    if (!m) return;
    const el = this._ensureHud();
    const verb = m.type === 'translate' ? 'Move' : 'Rotate';
    const axis = m.axis ? m.axis.toUpperCase() : 'view';
    const unit = m.type === 'translate' ? '' : '°';
    const shown = m.numeric !== '' ? m.numeric : m.value.toFixed(m.type === 'translate' ? 3 : 1);
    const drive = m.type === 'rotate' ? 'リング/数字' : 'マウス/数字';
    el.textContent = `${verb} [${axis}] ${shown}${unit}  ·  X/Y/Z=軸  ${drive}  Enter/左=確定  Esc/右=取消`;
  }

  _removeHud() {
    if (this._hud) {
      this._hud.remove();
      this._hud = null;
    }
  }

  dispose() {
    this._cancelModal();
    window.removeEventListener('keydown', this._onModalKey, true);
    window.removeEventListener('pointermove', this._onPointerTrack, true);
    this.ctx.world.renderer.domElement.removeEventListener('pointerdown', this._onModalPointerDown, true);
    this.ctx.world.renderer.domElement.removeEventListener('contextmenu', this._onModalContext);
    this._removeHud();
    this.ctx.world.renderer.domElement.removeEventListener('pointerdown', this._onPointerDown);
    this.tc.detach();
    this.tc.dispose();
    this.ctx.world.scene.remove(this.tcHelper);
    this.ctx.world.scene.remove(this._rotProxy);
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
    this._disposeStream();
    this._disposeLightViz();
  }
}
