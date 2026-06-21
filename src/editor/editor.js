import { GUI } from 'lil-gui';
import { PathEditor } from './path-editor.js';
import { Timeline } from './timeline.js';
import { exportChoreo, importChoreo, importGrainImage } from './io.js';
import { setGlassConfig, refreshGlassMaterials } from '../world/bottle-factory.js';

/**
 * デバッグエディタ（Dキーでトグル）。choreography の全数値を lil-gui で編集し、
 * JSON として export/import する。
 * - カメラパスは PathEditor（ギズモ+曲線可視化、球クリックで選択）
 * - generate 全フェーズのフレーム単位プレビューは Timeline（画面下部ドック）
 *   choreo の値を変えると自動でリベイクされ、スクラブ位置の絵が即更新される
 * デバッグ専用機能であり、main.js から dynamic import されるため
 * 本番では D を押さない限りロードすらされない。
 */
export class Editor {
  constructor(ctx) {
    this.ctx = ctx;
    this.visible = false;
    this._build();
    // undo/redo（choreo.data 全体のスナップショット履歴）
    this._undoStack = [JSON.stringify(this.ctx.choreo.data)];
    this._redoStack = [];
    this._commitTimer = null;
    this._onKeyDown = (e) => this._handleKey(e);
    window.addEventListener('keydown', this._onKeyDown);
  }

  _build() {
    this.gui = new GUI({ title: 'CCJC Choreography Editor', width: 330 });
    this.gui.domElement.style.position = 'fixed';
    this.gui.domElement.style.top = '12px';
    this.gui.domElement.style.left = '12px'; // 画面左へ
    this.gui.domElement.style.zIndex = '1000';
    // 縦に収まらない時はパネル内スクロール（タイムライン上に被らない）
    this.gui.domElement.style.maxHeight = 'calc(100vh - 24px)';
    this.gui.domElement.style.overflowY = 'auto';
    this.gui.hide();

    const { choreo, manager, bottleRack } = this.ctx;

    // --- IO ---
    const ioFolder = this.gui.addFolder('Config IO');
    ioFolder.add({ export: () => exportChoreo(choreo) }, 'export').name('Export JSON（→ src/choreo/ に上書き）');
    ioFolder.add({ import: () => importChoreo(choreo, () => this.rebuild()) }, 'import').name('Import JSON');
    ioFolder
      .add({ reset: () => this._resetSaved() }, 'reset')
      .name('保存をクリア（初期値に戻す）');

    const touch = () => this._touch(); // 編集を undo 履歴へ（デバウンス）

    // --- カメラパス + タイムライン ---
    this.pathEditor = new PathEditor(this.ctx, this.gui);
    this.timeline = new Timeline(this.ctx, { pathEditor: this.pathEditor });
    this.pathEditor.timeline = this.timeline; // 定点ショットをプレイヘッド直後に挿入するため参照
    this.pathEditor.onChanged = () => {
      this.timeline.invalidate();
      touch();
    };
    this._timelineCtrl = this.gui
      .add({ open: () => this.timeline.toggle() }, 'open')
      .name('🎬 Timeline（フレーム単位プレビュー）');

    // --- タイミング/パラメータ（choreo JSON を再帰的にGUI化） ---
    const onTuned = () => {
      // ラック系は SELECT 待機中ならレイアウトへ即反映
      if (manager.is('select')) bottleRack.applyLayout();
      touch();
    };
    const tune = this.gui.addFolder('Parameters');
    buildGuiFromObject(tune.addFolder('select'), choreo.data.select, { onChange: onTuned });
    buildGuiFromObject(tune.addFolder('shoot'), choreo.data.shoot, { onChange: touch });
    // generate: カメラ編成に効く値はタイムラインへ通知（particles は別タブへ）
    const gen = tune.addFolder('generate');
    buildGuiFromObject(gen, choreo.data.generate, {
      skipKeys: ['path', 'particles', 'times', 'lights'], // パス/時刻/ライトは PathEditor で編集
      onChange: () => {
        this.timeline.invalidate();
        touch();
      },
    });
    buildGuiFromObject(tune.addFolder('result'), choreo.data.result, { onChange: touch });
    tune.folders.forEach((f) => f.close());

    // particles は専用タブ（独立トップレベル）。シェーダ uniform に焼かれるため
    // scene:true でプレビューの粒を再構築する
    const particlesFolder = this.gui.addFolder('particles');
    const onParticlesChange = () => {
      this.timeline.invalidate({ scene: true });
      touch();
    };
    buildGuiFromObject(particlesFolder, choreo.data.generate.particles, {
      labels: PARTICLE_LABELS,
      skipKeys: ['grainImage'], // 画像はテキスト欄でなく専用のアップロードボタンで扱う
      onChange: onParticlesChange,
    });
    // 粒のベース画像（data URL）のアップロード / クリア（空=手続き的な丸スプライト）
    const pcfg = choreo.data.generate.particles;
    particlesFolder
      .add(
        { upload: () => importGrainImage((dataURL) => { pcfg.grainImage = dataURL; onParticlesChange(); }) },
        'upload'
      )
      .name('粒画像をアップロード');
    particlesFolder
      .add({ clear: () => { pcfg.grainImage = ''; onParticlesChange(); } }, 'clear')
      .name('粒画像をクリア（丸に戻す）');

    // --- 環境（fog / ガラス）: choreo.data.scene をライブ編集 ---
    const envFolder = this.gui.addFolder('environment');
    this._buildEnvFolder(envFolder);

    // --- タブ化（同時に操作しないものをタブへ。Config IO/Timeline は常時表示） ---
    this._setupTabs({
      Camera: this.pathEditor.gui,
      Lights: this.pathEditor.lightsGui,
      Particles: particlesFolder,
      Scene: tune,
      Env: envFolder,
    });
  }

  /**
   * 環境フォルダ（fog / ガラス）を組み立てる。choreo.data.scene を直接バインドし、
   * 変更時にライブ反映（fog→scene.fog / glass→ロード済みボトル）＋ undo 履歴へ記録する。
   */
  _buildEnvFolder(folder) {
    const { choreo, world, environment } = this.ctx;
    const scene = choreo.data.scene;
    const touch = () => this._touch();

    const applyFog = () => {
      environment.applyFog(scene.fog);
      touch();
    };
    const fog = folder.addFolder('fog');
    fog.add(scene.fog, 'enabled').name('有効').onChange(applyFog);
    fog.add(scene.fog, 'near', 0, 20, 0.1).name('near（手前の素通し境界）').onChange(applyFog);
    fog.add(scene.fog, 'far', 1, 60, 0.5).name('far（背景に溶ける距離）').onChange(applyFog);

    const applyGlass = () => {
      setGlassConfig(scene.glass);
      refreshGlassMaterials(world.scene);
      touch();
    };
    const glass = folder.addFolder('glass（透明部分）');
    glass.addColor(scene.glass, 'tint').name('色味（白=クリア）').onChange(applyGlass);
    glass.add(scene.glass, 'transmission', 0, 1, 0.01).name('透過').onChange(applyGlass);
    glass.add(scene.glass, 'roughness', 0, 1, 0.01).name('粗さ').onChange(applyGlass);
    glass.add(scene.glass, 'ior', 1, 2.333, 0.01).name('IOR（屈折率）').onChange(applyGlass);
    glass.add(scene.glass, 'thickness', 0, 2, 0.01).name('厚み（屈折の強さ）').onChange(applyGlass);
    glass
      .add(scene.glass, 'envMapIntensity', 0, 4, 0.05)
      .name('映り込み強度')
      .onChange(applyGlass);
  }

  /**
   * トップレベルのフォルダ群をタブで出し分ける。lil-gui にタブは無いので、
   * タブバーを自作し、選択タブの中身フォルダだけ表示する（残りは display:none）。
   * 各タブの中身は常に開いた状態にし、冗長なフォルダ見出しは隠す。
   */
  _setupTabs(map) {
    injectTabStyles();
    this._tabFolders = map;
    const names = Object.keys(map);

    for (const f of Object.values(map)) {
      f.open();
      f.$title.style.display = 'none';
    }

    const bar = document.createElement('div');
    bar.className = 'editor-tabbar';
    this._tabButtons = {};
    for (const name of names) {
      const btn = document.createElement('button');
      btn.className = 'editor-tab';
      btn.textContent = name;
      btn.addEventListener('click', () => this._selectTab(name));
      bar.appendChild(btn);
      this._tabButtons[name] = btn;
    }

    // DOM 並び: Config IO / 🎬 Timeline / タブバー / 各タブ中身
    const c = this.gui.$children;
    c.appendChild(this._timelineCtrl.domElement);
    c.appendChild(bar);
    for (const name of names) c.appendChild(map[name].domElement);

    // 直前のタブを rebuild をまたいで復元。無ければ先頭タブ
    this._selectTab(this._activeTab && map[this._activeTab] ? this._activeTab : names[0]);
  }

  _selectTab(name) {
    this._activeTab = name;
    for (const [n, f] of Object.entries(this._tabFolders)) {
      f.domElement.style.display = n === name ? '' : 'none';
      this._tabButtons[n].classList.toggle('active', n === name);
    }
  }

  /** import 後などの全再構築 */
  rebuild() {
    const wasVisible = this.visible;
    this.timeline.dispose();
    this.pathEditor.dispose();
    this.gui.destroy();
    this._build();
    // import 等で外から差し替わったので履歴をリセット
    this._undoStack = [JSON.stringify(this.ctx.choreo.data)];
    this._redoStack = [];
    if (wasVisible) this._show();
  }

  /** localStorage の保存を破棄し、bundled の初期値へ戻して再構築する */
  _resetSaved() {
    if (!confirm('保存した編集状態をクリアして初期値に戻しますか？')) return;
    this.ctx.choreo.clearSaved();
    this.rebuild();
    console.log('[Editor] 保存をクリアして初期値に戻しました');
  }

  toggle() {
    this.visible ? this._hide() : this._show();
  }

  _show() {
    this.visible = true;
    this.gui.show();
    this.pathEditor.setActive(true);
    document.body.classList.add('editor-active');
    // D 押下で直接 Timeline ＋ 視点:Free から始める
    this.timeline.open().then(() => {
      if (this.visible && this.timeline.isOpen) this.timeline._setViewMode('free');
    });
  }

  _hide() {
    this.visible = false;
    this.gui.hide();
    this.timeline.close();
    this.pathEditor.setActive(false);
    document.body.classList.remove('editor-active');
  }

  // ---- undo / redo ----

  /** 編集を履歴へ反映（デバウンス。連続操作は1ステップにまとめる） */
  _touch() {
    clearTimeout(this._commitTimer);
    this._commitTimer = setTimeout(() => this._commit(), 450);
  }

  /** 現在の状態が直近コミットと異なれば履歴に積み、localStorage へ保存する */
  _commit() {
    clearTimeout(this._commitTimer);
    const cur = JSON.stringify(this.ctx.choreo.data);
    if (cur !== this._undoStack[this._undoStack.length - 1]) {
      this._undoStack.push(cur);
      this._redoStack.length = 0;
      if (this._undoStack.length > 100) this._undoStack.shift();
      this.ctx.choreo.save(); // 最新の変更状態を永続化
    }
  }

  _handleKey(e) {
    if (!this.visible) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) this._redo();
      else this._undo();
    } else if (e.key === 'y' || e.key === 'Y') {
      e.preventDefault();
      e.stopPropagation();
      this._redo();
    }
  }

  _undo() {
    this._commit(); // 保留中の編集を確定してから戻す
    if (this._undoStack.length <= 1) return;
    this._redoStack.push(this._undoStack.pop());
    this._restore(this._undoStack[this._undoStack.length - 1]);
  }

  _redo() {
    if (!this._redoStack.length) return;
    const snap = this._redoStack.pop();
    this._undoStack.push(snap);
    this._restore(snap);
  }

  /** スナップショット(JSON文字列)を choreo.data へ in-place 復元し、ビューを更新 */
  _restore(json) {
    applySnapshot(this.ctx.choreo.data, JSON.parse(json));
    // lil-gui コントローラ・PathEditor・Timeline を再表示（バインドは維持）
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    this.pathEditor.rebuild();
    if (this.ctx.manager.is('select')) this.ctx.bottleRack.applyLayout?.();
    // 環境（fog/ガラス）もスナップショットへ追従させる（updateDisplay だけでは scene に反映されない）
    const sc = this.ctx.choreo.data.scene;
    if (sc) {
      this.ctx.environment.applyFog?.(sc.fog);
      setGlassConfig(sc.glass);
      refreshGlassMaterials(this.ctx.world.scene);
    }
    this.timeline.invalidate();
    this.ctx.choreo.save(); // undo/redo 後の状態も保存
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    clearTimeout(this._commitTimer);
    this.timeline.dispose();
    this.pathEditor.dispose();
    this.gui.destroy();
    document.body.classList.remove('editor-active');
  }
}

/**
 * src の内容を target へ in-place 反映（target のオブジェクト/配列参照を可能な限り維持）。
 * lil-gui や PathEditor が保持する choreo.data へのバインドを壊さずに undo 復元するため。
 */
function applySnapshot(target, src) {
  if (Array.isArray(target) && Array.isArray(src)) {
    target.length = src.length;
    for (let i = 0; i < src.length; i++) {
      if (src[i] && typeof src[i] === 'object' && target[i] && typeof target[i] === 'object' && Array.isArray(src[i]) === Array.isArray(target[i])) {
        applySnapshot(target[i], src[i]);
      } else {
        target[i] = structuredClone(src[i]);
      }
    }
    return;
  }
  for (const k of Object.keys(target)) if (!(k in src)) delete target[k];
  for (const k of Object.keys(src)) {
    const sv = src[k];
    const tv = target[k];
    if (sv && typeof sv === 'object' && tv && typeof tv === 'object' && Array.isArray(sv) === Array.isArray(tv)) {
      applySnapshot(tv, sv);
    } else {
      target[k] = structuredClone(sv);
    }
  }
}

/** タブバーのスタイルを一度だけ注入 */
function injectTabStyles() {
  if (document.getElementById('ccjc-editor-tab-style')) return;
  const style = document.createElement('style');
  style.id = 'ccjc-editor-tab-style';
  style.textContent = `
.editor-tabbar {
  display: flex; gap: 2px; margin: 6px 0 4px;
}
.editor-tab {
  flex: 1; padding: 5px 4px;
  background: #1b1b1f; color: #aaa;
  border: 1px solid #3a3a44; border-radius: 5px;
  font: 11px/1.2 'SF Mono', Menlo, Consolas, monospace; cursor: pointer;
}
.editor-tab:hover { color: #e8e8ee; border-color: #555; }
.editor-tab.active {
  background: #2c6cff; color: #fff; border-color: #2c6cff;
}
`;
  document.head.appendChild(style);
}

/** 値の大きさからスライダーレンジを推定 */
function rangeFor(v) {
  const m = Math.max(Math.abs(v) * 4, 2);
  return [-m, m];
}

/**
 * JSONオブジェクトを再帰的に lil-gui コントローラへ変換する。
 * 数値→スライダー / 文字列→テキスト / 真偽→チェック / 数値配列→インデックス別スライダー
 */
function buildGuiFromObject(folder, obj, { skipKeys = [], onChange, labels = {} } = {}) {
  // labels[key] があれば表示名だけ差し替える（JSONキー自体は uniform マッピングに使うため変えない）
  const nameOf = (key) => labels[key] ?? key;
  for (const [key, val] of Object.entries(obj)) {
    if (skipKeys.includes(key)) continue;

    if (typeof val === 'number') {
      const [min, max] = rangeFor(val);
      folder.add(obj, key, min, max, 0.01).name(nameOf(key)).onChange(onChange);
    } else if (typeof val === 'string' || typeof val === 'boolean') {
      folder.add(obj, key).name(nameOf(key)).onChange(onChange);
    } else if (Array.isArray(val)) {
      if (val.length && val.every((x) => typeof x === 'number')) {
        const sub = folder.addFolder(nameOf(key));
        // 配列へ直接バインド（proxy を使わない）。undo の updateDisplay で復元値が反映される
        val.forEach((x, i) => {
          const [min, max] = rangeFor(x);
          sub.add(val, i, min, max, 0.01).name(`[${i}]`).onChange(() => onChange?.());
        });
        sub.close();
      } else if (val.length && val.every((x) => x && typeof x === 'object')) {
        const sub = folder.addFolder(nameOf(key));
        val.forEach((item, i) => {
          const label = item.id ?? item.el ?? String(i);
          buildGuiFromObject(sub.addFolder(label), item, { skipKeys, onChange, labels });
        });
        sub.close();
      }
      // 混在配列（"@current" を含む path 等）はスキップ
    } else if (val && typeof val === 'object') {
      const sub = folder.addFolder(nameOf(key));
      buildGuiFromObject(sub, val, { skipKeys, onChange, labels });
      sub.close();
    }
  }
}

// パーティクルのパラメータ表示名（日本語）。lil-gui のラベルだけ差し替える辞書。
// キー = choreography.json の particles キー。未定義のキーは英語キーのまま表示される。
const PARTICLE_LABELS = {
  grid: 'グリッド数 [幅, 高さ]',
  size: '粒サイズ',
  useImageColor: '写真の色を反映',
  brightMin: '明度レンジ・最小',
  brightMax: '明度レンジ・最大',
  brightRandom: '明度ランダム度',
  sizeGrow: '成長量',
  surviveRatio: '生存率',
  rippleLead: '波・開始遅延',
  rippleAmp: '波・振幅',
  rippleFreq: '波・周波数 [x, y]',
  rippleSpeed: '波・速度',
  dissolveDelaySpread: '飛散の遅延ばらつき',
  headLead: '先頭の車間',
  flightDuration: '飛行時間',
  lateralRadius: '横ずれ半径',
  twist: 'ねじれ',
  noiseAmp: 'ゆらぎ・振幅',
  noiseFreq: 'ゆらぎ・周波数',
  streamP1Offset: '流路の制御点P1',
  streamP2Offset: '流路の制御点P2',
  helixEntryTangent: '螺旋・入射の接線強さ',
  helixRadius: '螺旋・半径',
  helixSpeed: '螺旋・速度',
  helixEntryY: '螺旋・入口の高さ',
  helixBobAmp: '螺旋・上下ゆれ振幅',
  helixBobFreq: '螺旋・上下ゆれ周波数',
  helixDescent: '螺旋・下降速度',
  helixDrop: '螺旋・最大下降量',
  helixFade: '螺旋・消えるまでの時間',
};
