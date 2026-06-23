import * as THREE from "three";
import gsap from "gsap";
import {OrbitControls} from "three/addons/controls/OrbitControls.js";
import {bakeGenerateCamera, FPS} from "./camera-simulator.js";
import {PreviewStage} from "./preview-stage.js";
import {playSound} from "../core/audio.js";

/**
 * generate カメラ編成のタイムラインエディタ（画面下部ドック）。
 * カメラ全フェーズを camera-simulator でベイクし、1フレーム単位で
 * スクラブ / ステップ / 再生プレビューする。
 *
 * - フェーズブロック: 幅=尺。クリックでシーク
 * - ◆マーカー: path キーフレームの通過フレーム。クリックで PathEditor の編集対象に
 * - choreo の値が変わったら invalidate() → 自動リベイク（現在フレーム維持）
 * - プレビュー中は world.cameraLocked でカメラを占有（SELECT のドリフトを停止）
 *
 * 視点モード（V で切替）:
 * - Camera … 演出カメラの中から見る（本番と同じ絵）
 * - Free   … OrbitControls の俯瞰。演出カメラはフラスタムヘルパー（ゴースト）として
 *            表示され、ベイク済み全フェーズの軌跡ライン上をスクラブに追従して動く。
 *            俯瞰のままキーフレーム球をドラッグすると軌跡が自動リベイクされる。
 *            先鋒（hero粒）の軌道も橙ライン+フレーム毎ドットで表示され、
 *            現在フレームの先鋒位置に球マーカーが追従する
 *
 * キー操作（パネル表示中・キャプチャで奪う）:
 *   Space 再生/停止 ・ ←/→ ±1f（Shift ±10f）・ Home/End 先頭/末尾
 *   V 視点切替 ・ Esc 閉じる
 */
const TRAJ_COLORS = {
  path: 0x5b8bd5,
  follow: 0xb07cd8,
  loop: 0x35b3a2,
  static: 0xd5a15b,
};
const HERO_COLOR = 0xff8844;
export class Timeline {
  constructor(ctx, {pathEditor}) {
    this.ctx = ctx;
    this.pathEditor = pathEditor;
    this.stage = new PreviewStage(ctx);
    this.open_ = false;
    this.playing = false;
    this.speed = 1;
    this.loop = true;
    this.frame = 0;
    this.baked = null;
    this._invalidateTimer = null;
    this._camSnapshot = null;

    // 俯瞰（Free）ビュー関連。初回切替時に遅延生成し close で全破棄
    this.viewMode = "cam";
    this.ghost = null; // 演出カメラの分身（シーンには helper のみ追加）
    this.helper = null;
    this.lookLine = null;
    this.traj = null;
    this.heroMarker = null;
    this.orbit = null;
    this._orbitInitialized = false;
    this._freeCamSnapshot = null; // cam⇄free トグル間で俯瞰カメラ姿勢を保持

    this._tick = this._tick.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._buildDom();
  }

  get isOpen() {
    return this.open_;
  }

  /** 現在のプレイヘッド時刻（秒） */
  get currentTime() {
    return this.frame / FPS;
  }

  toggle() {
    this.open_ ? this.close() : this.open();
  }

  async open() {
    const {manager, world, bottleRack, brands} = this.ctx;
    if (this.open_) return;
    if (!manager.is("select") || manager.transitioning) {
      this._flashMessage("SELECT 待機中のみ開けます（生成中は不可）");
      return;
    }
    this.open_ = true;

    // カメラを占有（close で復元）
    this._camSnapshot = {
      pos: world.camera.position.clone(),
      quat: world.camera.quaternion.clone(),
      fov: world.camera.fov,
    };
    world.cameraLocked = true;
    bottleRack.setVisible(false);

    const brand = brands.getBySlug(this.brandSelect.value) ?? brands.list[0];
    await this.stage.open(brand);
    // ステージ読み込み中に close() された場合はゾンビ化（パネル再表示）しないよう撤退
    if (!this.open_) return;
    this._bake();

    this.frame = 0;
    this.playing = false;
    this.root.classList.remove("tlx-hidden");
    world.addTickable(this._tick);
    window.addEventListener("keydown", this._onKeyDown, true);
    this._applyFrame();
    this._render();
    this.pathEditor._rebuildStreamViz?.(); // 粒子ストリームのハンドルを表示（particles 生成後）
  }

  close() {
    if (!this.open_) return;
    const {world, manager, bottleRack} = this.ctx;
    this.open_ = false;
    this.playing = false;
    window.removeEventListener("keydown", this._onKeyDown, true);
    world.removeTickable(this._tick);
    this._disposeFreeView();
    this.pathEditor._disposeStream?.(); // particles 破棄に合わせてストリームのハンドルも破棄
    this.stage.close();
    this.root.classList.add("tlx-hidden");

    // カメラ返還
    world.cameraLocked = false;
    if (this._camSnapshot) {
      world.camera.position.copy(this._camSnapshot.pos);
      world.camera.quaternion.copy(this._camSnapshot.quat);
      world.camera.fov = this._camSnapshot.fov;
      world.camera.updateProjectionMatrix();
      this._camSnapshot = null;
    }
    bottleRack.setVisible(manager.is("select"));
  }

  /**
   * choreo 変更通知（エディタの各 onChange から呼ぶ）。デバウンスしてリベイク。
   * @param {{scene?: boolean}} opts particles パラメータ変更時は scene:true（粒の再構築）
   */
  invalidate({scene = false} = {}) {
    if (!this.open_) return;
    this._sceneDirty = this._sceneDirty || scene;
    clearTimeout(this._invalidateTimer);
    this._invalidateTimer = setTimeout(() => {
      if (!this.open_) return;
      if (this._sceneDirty) {
        this.stage.rebuildParticles();
        this.pathEditor._rebuildStreamViz?.(); // 新 particles インスタンスへハンドルを貼り直し
      }
      this._sceneDirty = false;
      const keepTime = this.frame / FPS;
      this._bake();
      this.frame = Math.min(
        Math.round(keepTime * FPS),
        this.baked.totalFrames - 1,
      );
      if (this.viewMode === "free") this._rebuildTrajectory();
      this._applyFrame();
      this._render();
    }, 150);
  }

  _bake() {
    this.baked = bakeGenerateCamera(this.ctx.choreo.data.generate, {
      heroPos: (out, t) => this.stage.heroPos(out, t),
    });
  }

  // ---- 再生・適用 ----

  _tick(dt) {
    // タイムライン表示中に万一シーケンスが動いたら撤収（カメラ衝突防止）
    if (!this.ctx.manager.is("select") || this.ctx.manager.transitioning) {
      this.close();
      return;
    }
    if (!this.playing || !this.baked) return;
    const prevFrame = this.frame;
    this.frame += dt * FPS * this.speed;
    const last = this.baked.totalFrames - 1;
    let wrapped = false;
    if (this.frame >= last) {
      if (this.loop) {
        this.frame = 0;
        wrapped = true;
      } else {
        this.frame = last;
        this._setPlaying(false);
      }
    }
    // 再生プレビュー: プレイヘッドが跨いだ音響イベントを試聴（巻き戻し/ループ折返しは鳴らさない）
    if (!wrapped) this._fireSoundsBetween(prevFrame, this.frame);
    this._applyFrame();
    this._renderPlayhead();
  }

  /** [fromFrame, toFrame) を前進したとき、その区間に start を持つ音を鳴らす（再生プレビュー用） */
  _fireSoundsBetween(fromFrame, toFrame) {
    if (toFrame <= fromFrame) return;
    const fromT = fromFrame / FPS;
    const toT = toFrame / FPS;
    for (const s of this.ctx.choreo.data.generate.sounds ?? []) {
      if (s.enabled === false) continue;
      const t = s.start ?? 0;
      if (t > fromT && t <= toT) playSound(s);
    }
  }

  _applyFrame() {
    if (!this.baked) return;
    const {world} = this.ctx;
    const b = this.baked;
    const i = Math.max(0, Math.min(Math.round(this.frame), b.totalFrames - 1));
    const px = b.pos[i * 3],
      py = b.pos[i * 3 + 1],
      pz = b.pos[i * 3 + 2];
    const lx = b.look[i * 3],
      ly = b.look[i * 3 + 1],
      lz = b.look[i * 3 + 2];

    if (this.viewMode === "free" && this.ghost) {
      // 俯瞰: 演出カメラはゴースト（フラスタムヘルパー）として動かす
      this.ghost.position.set(px, py, pz);
      this.ghost.fov = b.fov[i];
      this.ghost.updateProjectionMatrix();
      if (b.quat) this.ghost.quaternion.fromArray(b.quat, i * 4);
      else this.ghost.lookAt(lx, ly, lz);
      this.ghost.updateMatrixWorld(true);
      this.helper.update();
      const attr = this.lookLine.geometry.attributes.position;
      attr.setXYZ(0, px, py, pz);
      attr.setXYZ(1, lx, ly, lz);
      attr.needsUpdate = true;
      // 現在フレームの先鋒位置（スワップ前は写真上の初期位置に留まる）
      if (this.heroMarker && b.swapTime !== null) {
        this.stage.heroPos(
          this.heroMarker.position,
          Math.max(0, i / FPS - b.swapTime),
        );
      }
    } else {
      world.camera.position.set(px, py, pz);
      if (world.camera.fov !== b.fov[i]) {
        world.camera.fov = b.fov[i];
        world.camera.updateProjectionMatrix();
      }
      if (b.quat) world.camera.quaternion.fromArray(b.quat, i * 4);
      else world.camera.lookAt(lx, ly, lz);
    }
    this.stage.setTime(i / FPS, b.swapTime);
  }

  // ---- 俯瞰（Free）ビュー ----

  _toggleViewMode() {
    this._setViewMode(this.viewMode === "cam" ? "free" : "cam");
  }

  _setViewMode(mode) {
    if (!this.open_ || mode === this.viewMode) return;
    const {world} = this.ctx;
    this.viewMode = mode;
    this.viewBtn.textContent =
      mode === "free" ? "視点: Free(俯瞰)" : "視点: Camera";

    if (mode === "free") {
      this._ensureFreeView();
      this._rebuildTrajectory();
      this.helper.visible = true;
      this.lookLine.visible = true;
      this.traj.visible = true;
      this.heroMarker.visible = true;
      // 初回のみ軌跡全体が収まる俯瞰位置へ。2回目以降は前回の俯瞰位置を復元
      // （cam モードは world.camera をベイク位置で上書きするため、復元しないと
      //   俯瞰へ戻ったときにパス内部へ飛んでしまう）
      if (!this._orbitInitialized) {
        const {center, radius} = this._trajBounds();
        world.camera.fov = 45;
        world.camera.updateProjectionMatrix();
        world.camera.position.set(
          center.x + radius * 1.1,
          center.y + radius * 0.8,
          center.z + radius * 1.1,
        );
        this.orbit.target.copy(center);
        this._orbitInitialized = true;
      } else if (this._freeCamSnapshot) {
        world.camera.position.copy(this._freeCamSnapshot.pos);
        world.camera.fov = this._freeCamSnapshot.fov;
        world.camera.updateProjectionMatrix();
        this.orbit.target.copy(this._freeCamSnapshot.target);
      }
      this.orbit.enabled = true;
      this.orbit.update();
    } else {
      // cam へ抜ける直前の俯瞰カメラ姿勢を保存（次に free へ戻すとき復元）
      this._freeCamSnapshot = {
        pos: world.camera.position.clone(),
        fov: world.camera.fov,
        target: this.orbit.target.clone(),
      };
      this.orbit.enabled = false;
      this.helper.visible = false;
      this.lookLine.visible = false;
      this.traj.visible = false;
      this.heroMarker.visible = false;
    }
    this._applyFrame();
  }

  _ensureFreeView() {
    if (this.ghost) return;
    const {world} = this.ctx;
    // near/far を絞ってヘルパーをコンパクトな「カメラの形」にする
    this.ghost = new THREE.PerspectiveCamera(
      45,
      world.camera.aspect,
      0.15,
      1.2,
    );
    this.helper = new THREE.CameraHelper(this.ghost);
    this.helper.visible = false;
    world.scene.add(this.helper);

    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    this.lookLine = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({
        color: 0xffd166,
        transparent: true,
        opacity: 0.6,
      }),
    );
    this.lookLine.visible = false;
    world.scene.add(this.lookLine);

    this.traj = new THREE.Group();
    this.traj.visible = false;
    world.scene.add(this.traj);

    // 現在フレームの先鋒位置マーカー（軌跡ライン/ドットは traj 内に構築）
    this.heroMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 12, 8),
      new THREE.MeshBasicMaterial({color: HERO_COLOR}),
    );
    this.heroMarker.visible = false;
    world.scene.add(this.heroMarker);

    this.orbit = new OrbitControls(world.camera, world.renderer.domElement);
    this.orbit.enabled = false;
    // キーフレーム球のギズモドラッグ中はオービットを止める（カメラが共回りしないように）
    this._onTcDragging = (e) => {
      if (this.orbit && this.viewMode === "free") this.orbit.enabled = !e.value;
    };
    this.pathEditor.tc.addEventListener("dragging-changed", this._onTcDragging);
  }

  /** ベイク済み全フレームからフェーズ色分けの軌跡ラインを構築 */
  _rebuildTrajectory() {
    if (!this.traj || !this.baked) return;
    for (const child of [...this.traj.children]) {
      this.traj.remove(child);
      child.geometry.dispose();
      child.material.dispose();
    }
    const b = this.baked;
    // カット（overlay）が被さっているフレーム窓。本線はこの中で「迂回せず破線」にする
    const cutWindows = b.shots
      .filter((p) => p.layer === "overlay")
      .map((p) => [p.startFrame, p.startFrame + p.frameCount]);
    const inCut = (f) => cutWindows.some(([a, z]) => f >= a && f < z);

    for (const p of b.shots) {
      const color = TRAJ_COLORS[p.type] ?? 0x888888;
      if (p.layer === "overlay") {
        // 割り込みカメラの軌跡＝実際に通る線。本線とは繋げず実線で別個に描く。
        // 終端は overlay 最終フレーム(startFrame+frameCount-1)まで。+1 すると窓外＝base
        // 位置（上書きされていない本線）を拾って終わりが本線へ繋がって見えるので含めない。
        const pts = this._trajPoints(
          b.pos,
          p.startFrame,
          p.startFrame + p.frameCount - 1,
        );
        if (pts.length >= 2) this.traj.add(this._trajLine(pts, color, false));
        continue;
      }
      // 本線（base）= overlay 上書き前の本来の軌跡。カット窓内は破線・窓外は実線で分割
      const src = b.basePos ?? b.pos;
      const end = Math.min(p.startFrame + p.frameCount, src.length / 3 - 1);
      let run = [];
      let runCut = null;
      const flush = () => {
        if (run.length >= 2) this.traj.add(this._trajLine(run, color, runCut));
        run = [];
      };
      for (let f = p.startFrame; f <= end; f += 2) {
        const c = inCut(f);
        const pt = new THREE.Vector3(
          src[f * 3],
          src[f * 3 + 1],
          src[f * 3 + 2],
        );
        if (runCut === null) runCut = c;
        if (c !== runCut) {
          run.push(pt); // 境界点は両 run で共有して切れ目なく繋ぐ
          flush();
          run = [pt];
          runCut = c;
        } else {
          run.push(pt);
        }
      }
      flush();
    }

    // 先鋒（hero粒）の軌道: スワップ以降をフレーム毎に CPU 評価。
    // ライン + フレーム毎ドット（ドット間隔で速度も読める）
    if (b.swapTime !== null) {
      const start = Math.ceil(b.swapTime * FPS);
      const pts = [];
      const v = new THREE.Vector3();
      for (let f = start; f < b.totalFrames; f++) {
        pts.push(this.stage.heroPos(v, f / FPS - b.swapTime).clone());
      }
      if (pts.length >= 2) {
        this.traj.add(
          new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(pts),
            new THREE.LineBasicMaterial({
              color: HERO_COLOR,
              transparent: true,
              opacity: 0.75,
            }),
          ),
        );
        this.traj.add(
          new THREE.Points(
            new THREE.BufferGeometry().setFromPoints(pts),
            new THREE.PointsMaterial({color: HERO_COLOR, size: 0.018}),
          ),
        );
      }
    }
  }

  /** pos 配列の [startFrame, endFrame]（両端含む）を2フレーム間引きで Vector3[] に */
  _trajPoints(pos, startFrame, endFrame) {
    const pts = [];
    const end = Math.min(endFrame, pos.length / 3 - 1);
    const at = (f) =>
      new THREE.Vector3(pos[f * 3], pos[f * 3 + 1], pos[f * 3 + 2]);
    let f = startFrame;
    for (; f <= end; f += 2) pts.push(at(f));
    if (f - 2 !== end && end > startFrame) pts.push(at(end)); // 間引きで飛んだ終端を補う
    return pts;
  }

  /** 軌跡ライン1本。dashed=true は破線（カット窓に被さった本線の表現） */
  _trajLine(points, color, dashed) {
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    if (dashed) {
      const line = new THREE.Line(
        geo,
        new THREE.LineDashedMaterial({
          color,
          transparent: true,
          opacity: 0.55,
          dashSize: 0.09,
          gapSize: 0.07,
        }),
      );
      line.computeLineDistances(); // 破線は線距離が必須
      return line;
    }
    return new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({color, transparent: true, opacity: 0.9}),
    );
  }

  _trajBounds() {
    const b = this.baked;
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (let f = 0; f < b.totalFrames; f += 4) {
      box.expandByPoint(
        v.set(b.pos[f * 3], b.pos[f * 3 + 1], b.pos[f * 3 + 2]),
      );
      box.expandByPoint(
        v.set(b.look[f * 3], b.look[f * 3 + 1], b.look[f * 3 + 2]),
      );
    }
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(v).length() * 0.6, 3);
    return {center, radius};
  }

  _disposeFreeView() {
    const {world} = this.ctx;
    if (this.orbit) {
      this.pathEditor.tc.removeEventListener(
        "dragging-changed",
        this._onTcDragging,
      );
      this.orbit.dispose();
      this.orbit = null;
    }
    if (this.helper) {
      world.scene.remove(this.helper);
      this.helper.dispose();
      this.helper = null;
    }
    if (this.lookLine) {
      world.scene.remove(this.lookLine);
      this.lookLine.geometry.dispose();
      this.lookLine.material.dispose();
      this.lookLine = null;
    }
    if (this.traj) {
      for (const child of [...this.traj.children]) {
        child.geometry.dispose();
        child.material.dispose();
      }
      world.scene.remove(this.traj);
      this.traj = null;
    }
    if (this.heroMarker) {
      world.scene.remove(this.heroMarker);
      this.heroMarker.geometry.dispose();
      this.heroMarker.material.dispose();
      this.heroMarker = null;
    }
    this.ghost = null;
    this.viewMode = "cam";
    this._orbitInitialized = false;
    this._freeCamSnapshot = null;
    if (this.viewBtn) this.viewBtn.textContent = "視点: Camera";
  }

  _seek(frame, {pause = true} = {}) {
    if (!this.baked) return;
    if (pause) this._setPlaying(false);
    this.frame = Math.max(0, Math.min(frame, this.baked.totalFrames - 1));
    this._applyFrame();
    this._renderPlayhead();
  }

  _setPlaying(on) {
    this.playing = on;
    this.playBtn.textContent = on ? "❚❚" : "▶";
    this.playBtn.title = on ? "停止 (Space)" : "再生 (Space)";
  }

  /** プレイヘッド位置の base ショット（overlay=static は除外。読み出し/ジャンプ用） */
  _phaseAt(frame) {
    if (!this.baked) return null;
    const i = Math.round(frame);
    const base = this.baked.shots.filter((p) => p.layer !== "overlay");
    return (
      base.find((p) => i >= p.startFrame && i < p.startFrame + p.frameCount) ??
      base[base.length - 1]
    );
  }

  // ---- キー操作 ----

  _onKeyDown(e) {
    // lil-gui のテキスト入力等は素通し
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    // Cmd/Ctrl ショートカット（undo/redo 等）はエディタ側へ通す
    if (e.metaKey || e.ctrlKey) return;

    const step = e.shiftKey ? 10 : 1;
    let consumed = true;
    switch (e.key) {
      case " ":
        this._setPlaying(!this.playing);
        break;
      case "ArrowLeft":
        this._seek(Math.round(this.frame) - step);
        break;
      case "ArrowRight":
        this._seek(Math.round(this.frame) + step);
        break;
      case "Home":
        this._seek(0);
        break;
      case "End":
        this._seek(this.baked.totalFrames - 1);
        break;
      case "v":
      case "V":
        this._toggleViewMode();
        break;
      case "Escape":
        this.close();
        break;
      case "d":
      case "D":
        // D はエディタ全体のトグルに渡す（タイムラインは閉じる）
        this.close();
        consumed = false;
        break;
      default:
        // 0-9 等のブース操作キーを誤爆させない
        consumed = true;
    }
    if (consumed) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // ---- DOM ----

  _buildDom() {
    injectStyles();
    const root = document.createElement("div");
    root.id = "tlx-panel";
    root.className = "tlx-hidden";
    root.innerHTML = `
      <div class="tlx-bar">
        <button data-act="prevPhase" title="前フェーズ先頭">⏮</button>
        <button data-act="stepBack" title="-1フレーム (←)">−1f</button>
        <button data-act="play" class="tlx-play" title="再生 (Space)">▶</button>
        <button data-act="stepFwd" title="+1フレーム (→)">+1f</button>
        <button data-act="nextPhase" title="次フェーズ先頭">⏭</button>
        <span class="tlx-readout"></span>
        <span class="tlx-spacer"></span>
        <button data-act="addBeep" title="プレイヘッド位置にビープ（音マーカー）を追加">＋🔊 ビープ</button>
        <button data-act="view" title="視点切替 (V): 演出カメラ ⇄ 俯瞰オービット">視点: Camera</button>
        <label>speed <select data-act="speed">
          <option value="0.1">0.1×</option><option value="0.25">0.25×</option>
          <option value="0.5">0.5×</option><option value="1" selected>1×</option>
        </select></label>
        <label><input type="checkbox" data-act="loop" checked> loop</label>
        <label>bottle <select data-act="brand"></select></label>
        <button data-act="close" title="閉じる (Esc)">✕</button>
      </div>
      <div class="tlx-track"></div>
    `;
    document.body.appendChild(root);
    this.root = root;

    this.track = root.querySelector(".tlx-track");
    this.readout = root.querySelector(".tlx-readout");
    this.playBtn = root.querySelector('[data-act="play"]');
    this.viewBtn = root.querySelector('[data-act="view"]');
    this.brandSelect = root.querySelector('[data-act="brand"]');
    this.viewBtn.onclick = () => this._toggleViewMode();

    for (const b of this.ctx.brands.list) {
      const opt = document.createElement("option");
      opt.value = b.slug;
      opt.textContent = b.slug;
      this.brandSelect.appendChild(opt);
    }

    root.querySelector('[data-act="addBeep"]').onclick = () => this._addBeep();
    root.querySelector('[data-act="close"]').onclick = () => this.close();
    this.playBtn.onclick = () => this._setPlaying(!this.playing);
    root.querySelector('[data-act="stepBack"]').onclick = () =>
      this._seek(Math.round(this.frame) - 1);
    root.querySelector('[data-act="stepFwd"]').onclick = () =>
      this._seek(Math.round(this.frame) + 1);
    root.querySelector('[data-act="prevPhase"]').onclick = () =>
      this._jumpPhase(-1);
    root.querySelector('[data-act="nextPhase"]').onclick = () =>
      this._jumpPhase(1);
    root.querySelector('[data-act="speed"]').onchange = (e) =>
      (this.speed = Number(e.target.value));
    root.querySelector('[data-act="loop"]').onchange = (e) =>
      (this.loop = e.target.checked);
    this.brandSelect.onchange = () => {
      if (this.open_)
        this.stage.setBrand(this.ctx.brands.getBySlug(this.brandSelect.value));
    };

    // トラック上のスクラブ（ドラッグ）
    this.track.addEventListener("pointerdown", (e) => {
      if (e.target.classList.contains("tlx-marker")) return; // ◆はクリック選択
      this.track.setPointerCapture(e.pointerId);
      const seekTo = (ev) => {
        const r = this.track.getBoundingClientRect();
        const ratio = Math.max(0, Math.min((ev.clientX - r.left) / r.width, 1));
        this._seek(Math.round(ratio * (this.baked.totalFrames - 1)));
      };
      seekTo(e);
      const move = (ev) => seekTo(ev);
      const up = () => {
        this.track.removeEventListener("pointermove", move);
        this.track.removeEventListener("pointerup", up);
      };
      this.track.addEventListener("pointermove", move);
      this.track.addEventListener("pointerup", up);
    });
  }

  _jumpPhase(dir) {
    if (!this.baked) return;
    const base = this.baked.shots.filter((p) => p.layer !== "overlay");
    const cur = this._phaseAt(this.frame);
    const idx = base.indexOf(cur);
    if (dir < 0 && Math.round(this.frame) > cur.startFrame + 2) {
      this._seek(cur.startFrame); // ショット途中なら自ショット先頭へ
      return;
    }
    const next = base[Math.max(0, Math.min(idx + dir, base.length - 1))];
    this._seek(next.startFrame);
  }

  /** トラック（全レーンのブロック・マーカー・プレイヘッド）を再構築 */
  _render() {
    if (!this.baked) return;
    this.track.innerHTML = "";
    // 上から順にレーン（横ストリップ）を描く。現状はカメラの2レーンのみ。
    // ライト/粒子は今後 _collectLanes() に append するだけで積める。
    for (const lane of this._collectLanes()) this._renderLane(lane);

    this.playhead = document.createElement("div");
    this.playhead.className = "tlx-playhead";
    this.track.appendChild(this.playhead);
    this._renderPlayhead();
    this._highlightSelectedShot();
  }

  /**
   * タイムラインの全レーンを上から順に返す（汎用トラック・モデル）。
   * 各レーンは clips（ブロック）と markers（◆）と操作（クリック/ドラッグ）を自給する。
   * laneClass が CSS の縦位置を決める（cam=既存の tlx-layer-static / tlx-layer-main）。
   * @returns {Array<{laneClass:string, divider?:boolean, tag?:string, clips:Array}>}
   */
  _collectLanes() {
    return [...this._cameraLanes(), this._soundLane()];
    // 今後: ...this._lightLanes(), ...this._particleLanes() も同様に積める
  }

  /**
   * 音響レーン（generate.sounds）。各サウンドを start 位置の小ブロックとして並べる。
   * ドラッグで位置移動 / クリックで試聴＋シーク / ✕ で削除。空でも「音」レーンは常に表示する。
   */
  _soundLane() {
    const total = this.baked.totalFrames;
    const sounds = this.ctx.choreo.data.generate.sounds ?? [];
    const clips = sounds.map((s) => {
      const startF = (s.start ?? 0) * FPS;
      const dispDur = Math.max(s.duration ?? 0.12, 0.12);
      return {
        id: s.id,
        className: "tlx-phase tlx-sound",
        leftPct: (startF / total) * 100,
        widthPct: ((dispDur * FPS) / total) * 100,
        labelHtml: `<span class="tlx-phase-label">🔊 ${s.id}</span>`,
        title: `${s.id} (${(s.start ?? 0).toFixed(2)}s, ${s.sound ?? "beep"}) — ドラッグで移動 / クリックで試聴 / ✕で削除`,
        onClip: (el) => this._attachSoundDrag(el, s.id),
      };
    });
    return {
      laneClass: "tlx-layer-sound",
      divider: true,
      dividerTop: 60,
      tag: "音",
      tagTop: 62,
      clips,
    };
  }

  _findSound(id) {
    return (this.ctx.choreo.data.generate.sounds ?? []).find(
      (s) => s.id === id,
    );
  }

  /** base を頭にした未使用の連番IDを返す（beep1, beep2, ...） */
  _uniqueSoundId(base) {
    const ids = new Set(
      (this.ctx.choreo.data.generate.sounds ?? []).map((s) => s.id),
    );
    let i = 1;
    while (ids.has(`${base}${i}`)) i++;
    return `${base}${i}`;
  }

  /** プレイヘッド位置にビープ1発を追加（保存＋再描画＋試聴） */
  _addBeep() {
    if (!this.baked) return;
    const g = this.ctx.choreo.data.generate;
    if (!Array.isArray(g.sounds)) g.sounds = [];
    const def = {
      id: this._uniqueSoundId("beep"),
      start: Number((this.frame / FPS).toFixed(3)),
      sound: "beep",
      freq: 880,
      duration: 0.12,
      volume: 0.3,
    };
    g.sounds.push(def);
    this.pathEditor.onChanged?.(); // invalidate（再描画）＋ undo/保存
    this.onSoundsChanged?.(); // GUI 音響エディタへ反映
    this.readout.textContent = `🔊 ${def.id} を ${def.start.toFixed(2)}s に追加`;
    playSound(def);
  }

  _removeSound(id) {
    const g = this.ctx.choreo.data.generate;
    const i = (g.sounds ?? []).findIndex((s) => s.id === id);
    if (i < 0) return;
    g.sounds.splice(i, 1);
    this.pathEditor.onChanged?.(); // invalidate（再描画）＋ undo/保存
    this.onSoundsChanged?.(); // GUI 音響エディタへ反映
  }

  /**
   * 音響ブロックを掴んで左右ドラッグ → start（絶対秒）を移動。ドラッグ中は DOM 位置だけ動かし、
   * 離した時に1回だけ onChanged（再描画＋undo/保存）する。動かさなければクリック扱い＝シーク＋試聴。
   * ブロック右肩の ✕ で削除。
   */
  _attachSoundDrag(el, soundId) {
    el.style.pointerEvents = "auto";
    el.style.cursor = "ew-resize";

    const del = document.createElement("button");
    del.className = "tlx-sound-del";
    del.textContent = "✕";
    del.title = "削除";
    del.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this._removeSound(soundId);
    });
    el.appendChild(del);

    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!this.baked) return;
      const sound = this._findSound(soundId);
      if (!sound) return;
      const rect = this.track.getBoundingClientRect();
      const total = this.baked.totalFrames;
      const startX = e.clientX;
      const startStart = sound.start ?? 0;
      const maxStart = Math.max(0, (total - 1) / FPS);
      let moved = false;
      el.setPointerCapture(e.pointerId);

      const move = (ev) => {
        if (Math.abs(ev.clientX - startX) > 3) moved = true;
        const dFrames = ((ev.clientX - startX) / rect.width) * total;
        let ns = startStart + dFrames / FPS;
        ns = Math.max(0, Math.min(ns, maxStart));
        ns = Math.round(ns * FPS) / FPS; // フレーム量子化
        sound.start = Number(ns.toFixed(3));
        this._repositionSound(soundId);
        this.readout.textContent = `${sound.id}  start ${ns.toFixed(2)}s（ドラッグ中）`;
      };
      const up = (ev) => {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        if (moved) {
          this.pathEditor.onChanged?.(); // 再描画＋undo/保存（移動確定）
          this.onSoundsChanged?.(); // GUI の開始秒スライダーへ反映
        } else {
          this._seek(Math.round((sound.start ?? 0) * FPS));
          playSound(sound); // クリック＝試聴
        }
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
  }

  /** ドラッグ中の音響ブロックの left だけ更新（リベイクしない） */
  _repositionSound(soundId) {
    const sound = this._findSound(soundId);
    if (!sound || !this.baked) return;
    const total = this.baked.totalFrames;
    const el = this.track.querySelector(`.tlx-phase[data-shot="${soundId}"]`);
    if (el) el.style.left = `${(((sound.start ?? 0) * FPS) / total) * 100}%`;
  }

  /** カメラトラック: カット(オーバーレイ=上) / メイン(base=下) の2レーン */
  _cameraLanes() {
    const b = this.baked;
    const total = b.totalFrames;
    const toClip = (p) => {
      const overlay = p.layer === "overlay";
      const holdNote =
        p.type === "follow" || p.type === "loop" ? " (hold)" : "";
      return {
        id: p.id,
        className: `tlx-phase tlx-${p.type}`,
        leftPct: (p.startFrame / total) * 100,
        widthPct: (p.frameCount / total) * 100,
        labelHtml: `<span class="tlx-phase-label">${p.id} <small>${p.holdSec.toFixed(1)}s${holdNote}</small></span>`,
        // カット(overlay)ブロック=掴んでドラッグで start 移動。base=クリックで選択＋シーク
        title: overlay
          ? `${p.id} — クリックで選択 / ドラッグで開始位置を移動`
          : `${p.id} — クリックで選択＋シーク`,
        onClip: overlay
          ? (el) => this._attachShotDrag(el, p.id)
          : (el) => this._attachBlockSelect(el, p.id),
        markers: (p.markers ?? []).map((m) => this._cameraMarkerSpec(p, m)),
      };
    };
    return [
      {
        laneClass: "tlx-layer-static",
        divider: true,
        dividerTop: 22,
        tag: "カット",
        clips: b.shots.filter((p) => p.layer === "overlay").map(toClip),
      },
      {
        laneClass: "tlx-layer-main",
        clips: b.shots.filter((p) => p.layer !== "overlay").map(toClip),
      },
    ];
  }

  /**
   * カメラの◆マーカー1つ分の spec。
   * 定点(static)カット=単一マーカーをドラッグで start 移動。
   * path のキーフレーム（編集可）=左右ドラッグで時刻(times)移動／クリックで選択。
   * '@current'（編集不可）=クリックでシークのみ。
   */
  _cameraMarkerSpec(p, m) {
    const base = {
      id: p.id,
      leftPct: (m.frame / this.baked.totalFrames) * 100,
      editable: m.editable,
    };
    if (p.type === "static" && m.editable) {
      // 定点マーカーも掴んで左右ドラッグで start を移動（クリックは選択）
      return {
        ...base,
        title: `${p.id} — ドラッグで開始位置を移動`,
        attachDrag: true,
      };
    }
    if (m.editable) {
      // path キーフレーム: 左右ドラッグで到達時刻 times[kf] を移動（クリックで選択）
      return {
        ...base,
        kf: m.kf,
        frame: m.frame,
        title: `${p.id} keyframe #${m.kf} — ドラッグで時刻移動 / クリックで編集`,
        attachKfDrag: true,
      };
    }
    return {
      ...base,
      title: `${p.id} #${m.kf} (@current)`,
      onClick: () => this._seek(m.frame),
    };
  }

  /** 1レーン分（区切り線・行ラベル・clips・markers）を track へ描く */
  _renderLane(lane) {
    if (lane.divider) {
      const divider = document.createElement("div");
      divider.className = "tlx-layer-divider";
      if (lane.dividerTop != null) divider.style.top = `${lane.dividerTop}px`;
      this.track.appendChild(divider);
    }
    if (lane.tag) {
      const tag = document.createElement("div");
      tag.className = "tlx-layer-tag";
      tag.textContent = lane.tag;
      if (lane.tagTop != null) tag.style.top = `${lane.tagTop}px`;
      this.track.appendChild(tag);
    }
    for (const clip of lane.clips) {
      const block = document.createElement("div");
      block.className = `${clip.className} ${lane.laneClass}`;
      block.dataset.shot = clip.id;
      block.style.left = `${clip.leftPct}%`;
      block.style.width = `${clip.widthPct}%`;
      block.innerHTML = clip.labelHtml ?? "";
      if (clip.title) block.title = clip.title;
      this.track.appendChild(block);
      clip.onClip?.(block);
      for (const m of clip.markers ?? []) this._renderMarker(m, lane);
    }
  }

  /** ◆マーカー1つを track へ描く（spec の onClick / attachDrag に従う） */
  _renderMarker(m, lane) {
    const marker = document.createElement("div");
    marker.className = `tlx-marker ${lane.laneClass}-mk${m.editable ? "" : " tlx-marker-ro"}`;
    marker.dataset.shot = m.id;
    marker.style.left = `${m.leftPct}%`;
    marker.textContent = "◆";
    if (m.title) marker.title = m.title;
    if (m.attachDrag) {
      this._attachShotDrag(marker, m.id);
    } else if (m.attachKfDrag) {
      this._attachKfDrag(marker, m.id, m.kf, m.frame);
    } else if (m.onClick) {
      marker.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        m.onClick();
      });
    }
    this.track.appendChild(marker);
  }

  /** 選択中ショット（pathEditor.state.phaseId）のブロックを枠でハイライト */
  _highlightSelectedShot() {
    const selId = this.pathEditor?.state?.phaseId;
    this.track?.querySelectorAll(".tlx-phase").forEach((el) => {
      el.classList.toggle("tlx-selected", el.dataset.shot === selId);
    });
  }

  /**
   * 定点(static)オーバーレイをタイムラインで掴んで左右ドラッグ → start（被せ開始秒）を移動。
   * ドラッグ中は DOM 位置だけ動かし、離した時に1回だけリベイク（onChanged）する。
   * 動かさなければクリック扱い＝シーク＆選択。
   */
  _attachShotDrag(el, shotId) {
    el.style.pointerEvents = "auto";
    el.style.cursor = "ew-resize";
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!this.baked) return;
      const shot = this.ctx.choreo.data.generate.shots.find(
        (s) => s.id === shotId,
      );
      if (!shot) return;
      const rect = this.track.getBoundingClientRect();
      const total = this.baked.totalFrames;
      const startX = e.clientX;
      const startStart = shot.start ?? 0;
      const maxStart = Math.max(0, (total - 1) / FPS);
      let moved = false;
      el.setPointerCapture(e.pointerId);

      const move = (ev) => {
        if (Math.abs(ev.clientX - startX) > 3) moved = true;
        const dFrames = ((ev.clientX - startX) / rect.width) * total;
        let ns = startStart + dFrames / FPS;
        ns = Math.max(0, Math.min(ns, maxStart));
        ns = Math.round(ns * FPS) / FPS; // フレーム量子化
        shot.start = Number(ns.toFixed(3));
        this._repositionStatic(shotId);
        this.readout.textContent = `${shot.id}  start ${ns.toFixed(2)}s（ドラッグ中）`;
      };
      const up = (ev) => {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        this.pathEditor.selectShot(shotId);
        if (moved) {
          this.pathEditor.onChanged?.(); // リベイク＋undo（移動確定）
        } else {
          // クリック＝先頭へではなく、クリックした位置へシーク
          const ratio = Math.max(
            0,
            Math.min((ev.clientX - rect.left) / rect.width, 1),
          );
          this._seek(Math.round(ratio * (total - 1)));
        }
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
  }

  /**
   * path のキーフレーム◆を左右ドラッグ → 到達時刻 times[kf] を移動（時間と曲線は独立）。
   * ドラッグ中は DOM 位置と times だけ更新し、離した時に1回だけリベイク（onChanged）。
   * 動かさなければクリック扱い＝シーク＋キーフレーム選択。base / 移動カット 両対応。
   * times[kf] = ease( (F - startFrame)/frameCount )（=ベイクのマーカー時刻計算の逆算）。
   * 前後キーの通過フレームでクランプして順序が入れ替わらないようにする。
   */
  _attachKfDrag(el, shotId, kf, markerFrame) {
    el.style.pointerEvents = "auto";
    el.style.cursor = "ew-resize";
    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!this.baked) return;
      const shot = this.ctx.choreo.data.generate.shots.find(
        (s) => s.id === shotId,
      );
      const info = this.baked.shots.find((s) => s.id === shotId);
      if (!shot || !info || !Array.isArray(shot.path)) return;
      const times = this.pathEditor._ensureTimes(shot);
      const easeFn = gsap.parseEase(shot.ease || "none");
      const rect = this.track.getBoundingClientRect();
      const total = this.baked.totalFrames;
      const startX = e.clientX;
      // 前後キーの通過フレームでクランプ（隣接キーがある時だけ余白±1、端はショット端まで）
      const mk = info.markers ?? [];
      const prevM = mk.find((x) => x.kf === kf - 1);
      const nextM = mk.find((x) => x.kf === kf + 1);
      const fPrev = prevM ? prevM.frame + 1 : info.startFrame;
      const fNext = nextM ? nextM.frame - 1 : info.startFrame + info.frameCount;
      let moved = false;
      el.setPointerCapture(e.pointerId);
      this.pathEditor.selectKeyframe(shotId, kf);

      const move = (ev) => {
        if (Math.abs(ev.clientX - startX) > 3) moved = true;
        const ratio = Math.max(
          0,
          Math.min((ev.clientX - rect.left) / rect.width, 1),
        );
        let F = ratio * (total - 1);
        F = Math.max(fPrev, Math.min(F, fNext)); // 隣接キーの間にクランプ
        const linP =
          info.frameCount > 0
            ? Math.max(0, Math.min((F - info.startFrame) / info.frameCount, 1))
            : 0;
        times[kf] = Number(easeFn(linP).toFixed(4));
        el.style.left = `${(F / total) * 100}%`;
        this.readout.textContent = `${shot.id} #${kf}  t ${times[kf].toFixed(3)}（ドラッグ中）`;
        this._seek(Math.round(F)); // プレイヘッドをマーカーに追従
      };
      const up = (ev) => {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        if (moved)
          this.pathEditor.onChanged?.(); // リベイク＋undo（時刻確定）
        else this._seek(markerFrame); // クリック＝そのキーフレーム位置へシーク（選択は済）
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
    });
  }

  /**
   * base ショット（path/follow/loop）のブロック: クリックでショット選択＋シーク、
   * ドラッグでスクラブ（トラックと同じ）。
   */
  _attachBlockSelect(block, shotId) {
    block.style.pointerEvents = "auto";
    block.style.cursor = "pointer";
    block.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (!this.baked) return;
      block.setPointerCapture(e.pointerId);
      const seekTo = (ev) => {
        const r = this.track.getBoundingClientRect();
        const ratio = Math.max(0, Math.min((ev.clientX - r.left) / r.width, 1));
        this._seek(Math.round(ratio * (this.baked.totalFrames - 1)));
      };
      seekTo(e);
      this.pathEditor.selectShot(shotId);
      const move = (ev) => seekTo(ev);
      const up = (ev) => {
        block.releasePointerCapture?.(ev.pointerId);
        block.removeEventListener("pointermove", move);
        block.removeEventListener("pointerup", up);
      };
      block.addEventListener("pointermove", move);
      block.addEventListener("pointerup", up);
    });
  }

  /** ドラッグ中の定点ブロック/マーカーの left/width だけ更新（リベイクしない） */
  _repositionStatic(shotId) {
    const shot = this.ctx.choreo.data.generate.shots.find(
      (s) => s.id === shotId,
    );
    if (!shot || !this.baked) return;
    const total = this.baked.totalFrames;
    const leftPct = (((shot.start ?? 0) * FPS) / total) * 100;
    const block = this.track.querySelector(`.tlx-phase[data-shot="${shotId}"]`);
    if (block) {
      block.style.left = `${leftPct}%`;
      block.style.width = `${(((shot.duration ?? 1) * FPS) / total) * 100}%`;
    }
    const mk = this.track.querySelector(`.tlx-marker[data-shot="${shotId}"]`);
    if (mk) mk.style.left = `${leftPct}%`;
  }

  _renderPlayhead() {
    if (!this.baked || !this.playhead) return;
    const b = this.baked;
    const i = Math.max(0, Math.min(Math.round(this.frame), b.totalFrames - 1));
    this.playhead.style.left = `${(i / b.totalFrames) * 100}%`;

    const p = this._phaseAt(i);
    const lf = i - p.startFrame;
    this.readout.textContent =
      `${p.id}  f ${String(lf).padStart(4, " ")}/${p.frameCount}  ${(lf / FPS).toFixed(3)}s` +
      `  ｜ 全体 f ${i}/${b.totalFrames - 1}  ${(i / FPS).toFixed(3)}/${((b.totalFrames - 1) / FPS).toFixed(2)}s`;
  }

  _flashMessage(msg) {
    this.root.classList.remove("tlx-hidden");
    this.readout.textContent = `⚠ ${msg}`;
    clearTimeout(this._msgTimer);
    this._msgTimer = setTimeout(() => {
      if (!this.open_) this.root.classList.add("tlx-hidden");
    }, 2200);
  }

  dispose() {
    this.close();
    clearTimeout(this._invalidateTimer);
    clearTimeout(this._msgTimer);
    this.root.remove();
  }
}

/** エディタ専用CSS（本番 style.css を汚さずランタイム注入） */
function injectStyles() {
  if (document.getElementById("tlx-style")) return;
  const style = document.createElement("style");
  style.id = "tlx-style";
  style.textContent = `
#tlx-panel {
  position: fixed; left: 354px; right: 12px; bottom: 12px; z-index: 1001;
  background: rgba(18, 18, 22, 0.92); color: #e8e8ee;
  border: 1px solid #3a3a44; border-radius: 8px;
  font: 12px/1.4 'SF Mono', Menlo, Consolas, monospace;
  padding: 8px 10px; backdrop-filter: blur(6px);
}
#tlx-panel.tlx-hidden { display: none; }
.tlx-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.tlx-bar button {
  background: #2a2a33; color: #e8e8ee; border: 1px solid #44444f; border-radius: 4px;
  padding: 3px 9px; cursor: pointer; font: inherit;
}
.tlx-bar button:hover { background: #3a3a46; }
.tlx-bar .tlx-play { min-width: 38px; font-size: 13px; }
.tlx-bar label { display: flex; align-items: center; gap: 4px; color: #9a9aa8; }
.tlx-bar select { background: #2a2a33; color: #e8e8ee; border: 1px solid #44444f; border-radius: 4px; font: inherit; }
.tlx-readout { color: #ffd166; white-space: pre; }
.tlx-spacer { flex: 1; }
.tlx-track {
  position: relative; height: 84px; background: #15151a;
  border: 1px solid #2c2c35; border-radius: 5px; overflow: hidden;
  cursor: crosshair; touch-action: none;
}
/* 3レイヤー: カット(上) 2..20px / メイン(中) 24..58px / 音(下) 64..82px */
.tlx-phase {
  position: absolute; box-sizing: border-box;
  border-right: 1px solid rgba(0,0,0,0.55); overflow: hidden; pointer-events: none;
}
.tlx-layer-static { top: 2px; height: 18px; }
.tlx-layer-main   { top: 24px; height: 34px; }
.tlx-layer-sound  { top: 64px; height: 18px; }
.tlx-layer-divider {
  position: absolute; left: 0; right: 0; top: 22px; height: 1px;
  background: #2c2c35; pointer-events: none; z-index: 1;
}
.tlx-layer-tag {
  position: absolute; left: 4px; top: 3px; font-size: 9px; color: #6e6147;
  pointer-events: none; z-index: 1; letter-spacing: 1px;
}
.tlx-path   { background: linear-gradient(#33557f, #2a4569); }
.tlx-static { background: linear-gradient(#7f6533, #695227); }
.tlx-follow { background: linear-gradient(#6a4a8c, #573b75); }
.tlx-loop   { background: linear-gradient(#2a7d72, #226359); }
.tlx-follow, .tlx-loop {
  background-image: repeating-linear-gradient(-45deg, rgba(255,255,255,0.06) 0 6px, transparent 6px 12px);
}
/* 音響ブロック: 小さく置き、ラベルははみ出して読ませる。✕は hover で出す */
.tlx-sound {
  background: linear-gradient(#9c4b6e, #7c3a57);
  overflow: visible; min-width: 18px; border-radius: 3px;
  border: 1px solid rgba(255,255,255,0.12);
}
.tlx-sound .tlx-phase-label { left: 4px; top: 1px; font-size: 10px; }
.tlx-sound-del {
  position: absolute; top: -7px; right: -7px;
  width: 14px; height: 14px; line-height: 1; padding: 0;
  font-size: 9px; text-align: center;
  background: #c0405e; color: #fff; border: 1px solid #e0607e;
  border-radius: 50%; cursor: pointer; display: none; z-index: 4;
}
.tlx-sound:hover .tlx-sound-del { display: block; }
.tlx-phase.tlx-selected {
  box-shadow: inset 0 0 0 2px #ffd166, 0 0 6px rgba(255, 209, 102, 0.5);
  border-radius: 3px; z-index: 2;
}
.tlx-phase-label {
  position: absolute; left: 6px; top: 3px; color: #fff; white-space: nowrap;
  text-shadow: 0 1px 2px rgba(0,0,0,0.6); pointer-events: none; font-size: 11px;
}
.tlx-phase-label small { color: rgba(255,255,255,0.6); }
.tlx-marker {
  position: absolute; transform: translateX(-50%);
  color: #ffd166; cursor: pointer; font-size: 11px; line-height: 1;
  padding: 2px 3px; z-index: 2;
}
.tlx-layer-static-mk { top: 4px; }
.tlx-layer-main-mk { top: 40px; }
.tlx-marker:hover { color: #ffffff; transform: translateX(-50%) scale(1.35); }
.tlx-marker-ro { color: #8888a0; cursor: default; }
.tlx-playhead {
  position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px;
  background: #ff4060; z-index: 3; pointer-events: none;
  box-shadow: 0 0 6px rgba(255, 64, 96, 0.8);
}
.tlx-hint { margin-top: 6px; color: #6e6e7d; }
`;
  document.head.appendChild(style);
}
