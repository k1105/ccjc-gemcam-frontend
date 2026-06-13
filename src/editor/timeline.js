import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bakeGenerateCamera, FPS } from './camera-simulator.js';
import { PreviewStage } from './preview-stage.js';

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
const TRAJ_COLORS = { path: 0x5b8bd5, follow: 0xb07cd8, loop: 0x35b3a2 };
const HERO_COLOR = 0xff8844;
export class Timeline {
  constructor(ctx, { pathEditor }) {
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
    this.viewMode = 'cam';
    this.ghost = null; // 演出カメラの分身（シーンには helper のみ追加）
    this.helper = null;
    this.lookLine = null;
    this.traj = null;
    this.heroMarker = null;
    this.orbit = null;
    this._orbitInitialized = false;

    this._tick = this._tick.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._buildDom();
  }

  get isOpen() {
    return this.open_;
  }

  toggle() {
    this.open_ ? this.close() : this.open();
  }

  async open() {
    const { manager, world, bottleRack, brands } = this.ctx;
    if (this.open_) return;
    if (!manager.is('select') || manager.transitioning) {
      this._flashMessage('SELECT 待機中のみ開けます（生成中は不可）');
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
    this._bake();

    this.frame = 0;
    this.playing = false;
    this.root.classList.remove('tlx-hidden');
    world.addTickable(this._tick);
    window.addEventListener('keydown', this._onKeyDown, true);
    this._applyFrame();
    this._render();
  }

  close() {
    if (!this.open_) return;
    const { world, manager, bottleRack } = this.ctx;
    this.open_ = false;
    this.playing = false;
    window.removeEventListener('keydown', this._onKeyDown, true);
    world.removeTickable(this._tick);
    this._disposeFreeView();
    this.stage.close();
    this.root.classList.add('tlx-hidden');

    // カメラ返還
    world.cameraLocked = false;
    if (this._camSnapshot) {
      world.camera.position.copy(this._camSnapshot.pos);
      world.camera.quaternion.copy(this._camSnapshot.quat);
      world.camera.fov = this._camSnapshot.fov;
      world.camera.updateProjectionMatrix();
      this._camSnapshot = null;
    }
    bottleRack.setVisible(manager.is('select'));
  }

  /**
   * choreo 変更通知（エディタの各 onChange から呼ぶ）。デバウンスしてリベイク。
   * @param {{scene?: boolean}} opts particles パラメータ変更時は scene:true（粒の再構築）
   */
  invalidate({ scene = false } = {}) {
    if (!this.open_) return;
    this._sceneDirty = this._sceneDirty || scene;
    clearTimeout(this._invalidateTimer);
    this._invalidateTimer = setTimeout(() => {
      if (!this.open_) return;
      if (this._sceneDirty) this.stage.rebuildParticles();
      this._sceneDirty = false;
      const keepTime = this.frame / FPS;
      this._bake();
      this.frame = Math.min(Math.round(keepTime * FPS), this.baked.totalFrames - 1);
      if (this.viewMode === 'free') this._rebuildTrajectory();
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
    if (!this.ctx.manager.is('select') || this.ctx.manager.transitioning) {
      this.close();
      return;
    }
    if (!this.playing || !this.baked) return;
    this.frame += dt * FPS * this.speed;
    const last = this.baked.totalFrames - 1;
    if (this.frame >= last) {
      if (this.loop) {
        this.frame = 0;
      } else {
        this.frame = last;
        this._setPlaying(false);
      }
    }
    this._applyFrame();
    this._renderPlayhead();
  }

  _applyFrame() {
    if (!this.baked) return;
    const { world } = this.ctx;
    const b = this.baked;
    const i = Math.max(0, Math.min(Math.round(this.frame), b.totalFrames - 1));
    const px = b.pos[i * 3], py = b.pos[i * 3 + 1], pz = b.pos[i * 3 + 2];
    const lx = b.look[i * 3], ly = b.look[i * 3 + 1], lz = b.look[i * 3 + 2];

    if (this.viewMode === 'free' && this.ghost) {
      // 俯瞰: 演出カメラはゴースト（フラスタムヘルパー）として動かす
      this.ghost.position.set(px, py, pz);
      this.ghost.fov = b.fov[i];
      this.ghost.updateProjectionMatrix();
      this.ghost.lookAt(lx, ly, lz);
      this.ghost.updateMatrixWorld(true);
      this.helper.update();
      const attr = this.lookLine.geometry.attributes.position;
      attr.setXYZ(0, px, py, pz);
      attr.setXYZ(1, lx, ly, lz);
      attr.needsUpdate = true;
      // 現在フレームの先鋒位置（スワップ前は写真上の初期位置に留まる）
      if (this.heroMarker && b.swapTime !== null) {
        this.stage.heroPos(this.heroMarker.position, Math.max(0, i / FPS - b.swapTime));
      }
    } else {
      world.camera.position.set(px, py, pz);
      if (world.camera.fov !== b.fov[i]) {
        world.camera.fov = b.fov[i];
        world.camera.updateProjectionMatrix();
      }
      world.camera.lookAt(lx, ly, lz);
    }
    this.stage.setTime(i / FPS, b.swapTime);
  }

  // ---- 俯瞰（Free）ビュー ----

  _toggleViewMode() {
    this._setViewMode(this.viewMode === 'cam' ? 'free' : 'cam');
  }

  _setViewMode(mode) {
    if (!this.open_ || mode === this.viewMode) return;
    const { world } = this.ctx;
    this.viewMode = mode;
    this.viewBtn.textContent = mode === 'free' ? '視点: Free(俯瞰)' : '視点: Camera';

    if (mode === 'free') {
      this._ensureFreeView();
      this._rebuildTrajectory();
      this.helper.visible = true;
      this.lookLine.visible = true;
      this.traj.visible = true;
      this.heroMarker.visible = true;
      // 初回のみ軌跡全体が収まる俯瞰位置へ（以降はユーザーの操作位置を維持）
      if (!this._orbitInitialized) {
        const { center, radius } = this._trajBounds();
        world.camera.fov = 45;
        world.camera.updateProjectionMatrix();
        world.camera.position.set(
          center.x + radius * 1.1,
          center.y + radius * 0.8,
          center.z + radius * 1.1
        );
        this.orbit.target.copy(center);
        this._orbitInitialized = true;
      }
      this.orbit.enabled = true;
      this.orbit.update();
    } else {
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
    const { world } = this.ctx;
    // near/far を絞ってヘルパーをコンパクトな「カメラの形」にする
    this.ghost = new THREE.PerspectiveCamera(45, world.camera.aspect, 0.15, 1.2);
    this.helper = new THREE.CameraHelper(this.ghost);
    this.helper.visible = false;
    world.scene.add(this.helper);

    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    this.lookLine = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.6 })
    );
    this.lookLine.visible = false;
    world.scene.add(this.lookLine);

    this.traj = new THREE.Group();
    this.traj.visible = false;
    world.scene.add(this.traj);

    // 現在フレームの先鋒位置マーカー（軌跡ライン/ドットは traj 内に構築）
    this.heroMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 12, 8),
      new THREE.MeshBasicMaterial({ color: HERO_COLOR })
    );
    this.heroMarker.visible = false;
    world.scene.add(this.heroMarker);

    this.orbit = new OrbitControls(world.camera, world.renderer.domElement);
    this.orbit.enabled = false;
    // キーフレーム球のギズモドラッグ中はオービットを止める（カメラが共回りしないように）
    this._onTcDragging = (e) => {
      if (this.orbit && this.viewMode === 'free') this.orbit.enabled = !e.value;
    };
    this.pathEditor.tc.addEventListener('dragging-changed', this._onTcDragging);
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
    for (const p of b.phases) {
      const pts = [];
      const end = Math.min(p.startFrame + p.frameCount, b.totalFrames - 1);
      for (let f = p.startFrame; f <= end; f += 2) {
        pts.push(new THREE.Vector3(b.pos[f * 3], b.pos[f * 3 + 1], b.pos[f * 3 + 2]));
      }
      if (pts.length < 2) continue;
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({
          color: TRAJ_COLORS[p.type] ?? 0x888888,
          transparent: true,
          opacity: 0.9,
        })
      );
      this.traj.add(line);
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
            new THREE.LineBasicMaterial({ color: HERO_COLOR, transparent: true, opacity: 0.75 })
          )
        );
        this.traj.add(
          new THREE.Points(
            new THREE.BufferGeometry().setFromPoints(pts),
            new THREE.PointsMaterial({ color: HERO_COLOR, size: 0.018 })
          )
        );
      }
    }
  }

  _trajBounds() {
    const b = this.baked;
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (let f = 0; f < b.totalFrames; f += 4) {
      box.expandByPoint(v.set(b.pos[f * 3], b.pos[f * 3 + 1], b.pos[f * 3 + 2]));
      box.expandByPoint(v.set(b.look[f * 3], b.look[f * 3 + 1], b.look[f * 3 + 2]));
    }
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(v).length() * 0.6, 3);
    return { center, radius };
  }

  _disposeFreeView() {
    const { world } = this.ctx;
    if (this.orbit) {
      this.pathEditor.tc.removeEventListener('dragging-changed', this._onTcDragging);
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
    this.viewMode = 'cam';
    this._orbitInitialized = false;
    if (this.viewBtn) this.viewBtn.textContent = '視点: Camera';
  }

  _seek(frame, { pause = true } = {}) {
    if (!this.baked) return;
    if (pause) this._setPlaying(false);
    this.frame = Math.max(0, Math.min(frame, this.baked.totalFrames - 1));
    this._applyFrame();
    this._renderPlayhead();
  }

  _setPlaying(on) {
    this.playing = on;
    this.playBtn.textContent = on ? '❚❚' : '▶';
    this.playBtn.title = on ? '停止 (Space)' : '再生 (Space)';
  }

  _phaseAt(frame) {
    if (!this.baked) return null;
    const i = Math.round(frame);
    return (
      this.baked.phases.find((p) => i >= p.startFrame && i < p.startFrame + p.frameCount) ??
      this.baked.phases[this.baked.phases.length - 1]
    );
  }

  // ---- キー操作 ----

  _onKeyDown(e) {
    // lil-gui のテキスト入力等は素通し
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const step = e.shiftKey ? 10 : 1;
    let consumed = true;
    switch (e.key) {
      case ' ':
        this._setPlaying(!this.playing);
        break;
      case 'ArrowLeft':
        this._seek(Math.round(this.frame) - step);
        break;
      case 'ArrowRight':
        this._seek(Math.round(this.frame) + step);
        break;
      case 'Home':
        this._seek(0);
        break;
      case 'End':
        this._seek(this.baked.totalFrames - 1);
        break;
      case 'v':
      case 'V':
        this._toggleViewMode();
        break;
      case 'Escape':
        this.close();
        break;
      case 'd':
      case 'D':
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
    const root = document.createElement('div');
    root.id = 'tlx-panel';
    root.className = 'tlx-hidden';
    root.innerHTML = `
      <div class="tlx-bar">
        <button data-act="prevPhase" title="前フェーズ先頭">⏮</button>
        <button data-act="stepBack" title="-1フレーム (←)">−1f</button>
        <button data-act="play" class="tlx-play" title="再生 (Space)">▶</button>
        <button data-act="stepFwd" title="+1フレーム (→)">+1f</button>
        <button data-act="nextPhase" title="次フェーズ先頭">⏭</button>
        <span class="tlx-readout"></span>
        <span class="tlx-spacer"></span>
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
      <div class="tlx-hint">←/→: ±1f（Shift ±10f）・Space: 再生・V: 視点(カメラ/俯瞰)・◆クリック: キーフレーム編集・ブロッククリック: シーク・俯瞰の橙ライン/ドット=先鋒の軌道とフレーム毎位置</div>
    `;
    document.body.appendChild(root);
    this.root = root;

    this.track = root.querySelector('.tlx-track');
    this.readout = root.querySelector('.tlx-readout');
    this.playBtn = root.querySelector('[data-act="play"]');
    this.viewBtn = root.querySelector('[data-act="view"]');
    this.brandSelect = root.querySelector('[data-act="brand"]');
    this.viewBtn.onclick = () => this._toggleViewMode();

    for (const b of this.ctx.brands.list) {
      const opt = document.createElement('option');
      opt.value = b.slug;
      opt.textContent = b.slug;
      this.brandSelect.appendChild(opt);
    }

    root.querySelector('[data-act="close"]').onclick = () => this.close();
    this.playBtn.onclick = () => this._setPlaying(!this.playing);
    root.querySelector('[data-act="stepBack"]').onclick = () => this._seek(Math.round(this.frame) - 1);
    root.querySelector('[data-act="stepFwd"]').onclick = () => this._seek(Math.round(this.frame) + 1);
    root.querySelector('[data-act="prevPhase"]').onclick = () => this._jumpPhase(-1);
    root.querySelector('[data-act="nextPhase"]').onclick = () => this._jumpPhase(1);
    root.querySelector('[data-act="speed"]').onchange = (e) => (this.speed = Number(e.target.value));
    root.querySelector('[data-act="loop"]').onchange = (e) => (this.loop = e.target.checked);
    this.brandSelect.onchange = () => {
      if (this.open_) this.stage.setBrand(this.ctx.brands.getBySlug(this.brandSelect.value));
    };

    // トラック上のスクラブ（ドラッグ）
    this.track.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('tlx-marker')) return; // ◆はクリック選択
      this.track.setPointerCapture(e.pointerId);
      const seekTo = (ev) => {
        const r = this.track.getBoundingClientRect();
        const ratio = Math.max(0, Math.min((ev.clientX - r.left) / r.width, 1));
        this._seek(Math.round(ratio * (this.baked.totalFrames - 1)));
      };
      seekTo(e);
      const move = (ev) => seekTo(ev);
      const up = () => {
        this.track.removeEventListener('pointermove', move);
        this.track.removeEventListener('pointerup', up);
      };
      this.track.addEventListener('pointermove', move);
      this.track.addEventListener('pointerup', up);
    });
  }

  _jumpPhase(dir) {
    if (!this.baked) return;
    const cur = this._phaseAt(this.frame);
    const idx = this.baked.phases.indexOf(cur);
    if (dir < 0 && Math.round(this.frame) > cur.startFrame + 2) {
      this._seek(cur.startFrame); // フェーズ途中なら自フェーズ先頭へ
      return;
    }
    const next = this.baked.phases[Math.max(0, Math.min(idx + dir, this.baked.phases.length - 1))];
    this._seek(next.startFrame);
  }

  /** トラック（フェーズブロック・マーカー・プレイヘッド）を再構築 */
  _render() {
    if (!this.baked) return;
    const b = this.baked;
    this.track.innerHTML = '';

    for (const p of b.phases) {
      const block = document.createElement('div');
      block.className = `tlx-phase tlx-${p.type}`;
      block.style.left = `${(p.startFrame / b.totalFrames) * 100}%`;
      block.style.width = `${(p.frameCount / b.totalFrames) * 100}%`;
      const holdNote = p.type === 'path' ? '' : ' (hold)';
      block.innerHTML = `<span class="tlx-phase-label">${p.id} <small>${p.holdSec.toFixed(1)}s${holdNote}</small></span>`;
      block.title = `${p.id} — クリックでシーク`;
      this.track.appendChild(block);

      for (const m of p.markers ?? []) {
        const marker = document.createElement('div');
        marker.className = `tlx-marker${m.editable ? '' : ' tlx-marker-ro'}`;
        marker.style.left = `${(m.frame / b.totalFrames) * 100}%`;
        marker.textContent = '◆';
        marker.title = m.editable
          ? `${p.id} keyframe #${m.kf} — クリックで編集対象に`
          : `${p.id} #${m.kf} (@current)`;
        marker.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this._seek(m.frame);
          if (m.editable) this.pathEditor.selectKeyframe(p.id, m.kf);
        });
        this.track.appendChild(marker);
      }
    }

    this.playhead = document.createElement('div');
    this.playhead.className = 'tlx-playhead';
    this.track.appendChild(this.playhead);
    this._renderPlayhead();
  }

  _renderPlayhead() {
    if (!this.baked || !this.playhead) return;
    const b = this.baked;
    const i = Math.max(0, Math.min(Math.round(this.frame), b.totalFrames - 1));
    this.playhead.style.left = `${(i / b.totalFrames) * 100}%`;

    const p = this._phaseAt(i);
    const lf = i - p.startFrame;
    this.readout.textContent =
      `${p.id}  f ${String(lf).padStart(4, ' ')}/${p.frameCount}  ${(lf / FPS).toFixed(3)}s` +
      `  ｜ 全体 f ${i}/${b.totalFrames - 1}  ${(i / FPS).toFixed(3)}/${((b.totalFrames - 1) / FPS).toFixed(2)}s`;
  }

  _flashMessage(msg) {
    this.root.classList.remove('tlx-hidden');
    this.readout.textContent = `⚠ ${msg}`;
    clearTimeout(this._msgTimer);
    this._msgTimer = setTimeout(() => {
      if (!this.open_) this.root.classList.add('tlx-hidden');
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
  if (document.getElementById('tlx-style')) return;
  const style = document.createElement('style');
  style.id = 'tlx-style';
  style.textContent = `
#tlx-panel {
  position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 1001;
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
  position: relative; height: 44px; background: #15151a;
  border: 1px solid #2c2c35; border-radius: 5px; overflow: hidden;
  cursor: crosshair; touch-action: none;
}
.tlx-phase {
  position: absolute; top: 0; bottom: 0; box-sizing: border-box;
  border-right: 1px solid rgba(0,0,0,0.55); overflow: hidden; pointer-events: none;
}
.tlx-path   { background: linear-gradient(#33557f, #2a4569); }
.tlx-follow { background: linear-gradient(#6a4a8c, #573b75); }
.tlx-loop   { background: linear-gradient(#2a7d72, #226359); }
.tlx-follow, .tlx-loop {
  background-image: repeating-linear-gradient(-45deg, rgba(255,255,255,0.06) 0 6px, transparent 6px 12px);
}
.tlx-phase-label {
  position: absolute; left: 6px; top: 4px; color: #fff; white-space: nowrap;
  text-shadow: 0 1px 2px rgba(0,0,0,0.6); pointer-events: none;
}
.tlx-phase-label small { color: rgba(255,255,255,0.6); }
.tlx-marker {
  position: absolute; bottom: 1px; transform: translateX(-50%);
  color: #ffd166; cursor: pointer; font-size: 11px; line-height: 1;
  padding: 2px 3px; z-index: 2;
}
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
