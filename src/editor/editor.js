import { GUI } from 'lil-gui';
import { PathEditor } from './path-editor.js';
import { Timeline } from './timeline.js';
import { SoundEditor } from './sound-editor.js';
import { ScreenPreview } from './screen-preview.js';
import { BottleEditor } from './bottle-editor.js';
import { exportChoreo, importChoreo, importGrainImage, pickSkyImage } from './io.js';
import { setGlassConfig, refreshGlassMaterials } from '../world/bottle-factory.js';

/** タブ名 → 画面プレビュー種別。これ以外（生成/Camera/Lights/Particles/Env）は生成ルック編集 */
const SCREEN_TABS = { 待機: 'select', 撮影: 'shoot', リザルト: 'result' };

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
    this._building = true; // build 中の _selectTab でプレビューを起動しない（_show で適用）
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

    // --- カメラパス + タイムライン + 画面プレビュー ---
    this.pathEditor = new PathEditor(this.ctx, this.gui);
    this.timeline = new Timeline(this.ctx, { pathEditor: this.pathEditor });
    this.soundEditor = new SoundEditor(this.ctx);
    this.screenPreview = new ScreenPreview(this.ctx);
    this.pathEditor.timeline = this.timeline; // 定点ショットをプレイヘッド直後に挿入するため参照
    this.pathEditor.onChanged = () => {
      this.timeline.invalidate();
      touch();
    };
    // GUI ⇄ Timeline の音響レイヤー相互同期
    this.soundEditor.onChanged = () => {
      this.timeline.invalidate(); // 音ブロックの位置/有無を再描画
      touch();
    };
    this.timeline.onSoundsChanged = () => this.soundEditor.refresh();

    // --- 画面ごとのタブ: 各画面のプレビューを開いた状態でそのパラメータを編集 ---
    const onTuned = () => {
      // ラック系は SELECT 待機中ならレイアウトへ即反映
      if (manager.is('select')) bottleRack.applyLayout();
      touch();
    };

    // タブを開くとその画面が自動でプレビューされる（明示ボタンは不要）。
    // ⟳ ボタンだけは「演出の再生」という固有アクションなので残す。

    // 待機（SELECT）: ラック/沈下/復帰/カメラ
    // overrides（飲料ごとのサイズ・ベースライン）はクリック選択UI（BottleEditor）で
    // 編集するので、汎用ツリー生成からは除外する。
    const selectFolder = this.gui.addFolder('待機');
    // gradient（上端の影）は色・不透明度・長さに最適化した専用UIで編集する
    buildGuiFromObject(selectFolder, choreo.data.select, { onChange: onTuned, skipKeys: ['overrides', 'gradient'] });
    this._buildGradientFolder(selectFolder, onTuned);

    // 飲料 個別調整: 待機プレビュー中にキャンバスのボトルをクリックして編集
    this.bottleEditor = new BottleEditor(this.ctx, {
      onChange: () => {
        if (manager.is('select')) bottleRack.applyLayout();
        touch();
      },
    });
    this.bottleEditor.attach(selectFolder);

    // 撮影（SHOOT）: カウントダウン間隔 / シャッター後ディレイ
    const shootFolder = this.gui.addFolder('撮影');
    shootFolder.add({ replay: () => this.screenPreview.replay() }, 'replay').name('⟳ カウントダウンを再生');
    buildGuiFromObject(shootFolder, choreo.data.shoot, { onChange: touch });

    // 生成（GENERATE）パラメータ: カメラ編成に効く値はタイムラインへ通知（path/particles/lights は専用サブタブ）
    const generateFolder = this.gui.addFolder('生成');
    generateFolder.add({ timeline: () => this.timeline.toggle() }, 'timeline').name('🎬 Timeline 表示/非表示');
    buildGuiFromObject(generateFolder, choreo.data.generate, {
      skipKeys: ['path', 'particles', 'times', 'lights', 'sounds'], // パス/時刻/ライト/音は専用UIで編集
      onChange: () => {
        this.timeline.invalidate();
        touch();
      },
    });

    // リザルト（RESULT）: フェードイン / スタガー / 滞留 / アウトロ
    const resultFolder = this.gui.addFolder('リザルト');
    resultFolder.add({ replay: () => this.screenPreview.replay() }, 'replay').name('⟳ イントロ/アウトロを再生');
    buildGuiFromObject(resultFolder, choreo.data.result, { onChange: touch });

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

    // --- タブ化 ---
    // 最上位＝ページ選択（待機/撮影/生成/リザルト）。生成ルックの編集（Camera/Lights/
    // Particles/Env）は「生成」の内側にサブタブとしてネストする。
    this._setupTabs({
      待機: selectFolder,
      撮影: shootFolder,
      生成: {
        sub: {
          パラメータ: generateFolder,
          Camera: this.pathEditor.gui,
          Lights: this.pathEditor.lightsGui,
          Particles: particlesFolder,
          Sound: this.soundEditor.gui,
          Env: envFolder,
        },
      },
      リザルト: resultFolder,
    });
    this._building = false;
  }

  /**
   * 待機画面 上端グラデーション（影）の編集フォルダ。color/不透明度/長さに合わせた
   * レンジで lil-gui にバインドし、変更を待機プレビューへライブ反映する。
   */
  _buildGradientFolder(parent, touch) {
    const { choreo, overlay, manager } = this.ctx;
    const g = choreo.data.select.gradient;
    // 待機プレビュー中なら即反映（show=enabled トグルにも追従）
    const apply = () => {
      if (manager.is('select')) overlay.showSelectGradient(g);
      touch();
    };
    const folder = parent.addFolder('gradient（上端の影）');
    folder.add(g, 'enabled').name('表示').onChange(apply);
    folder.addColor(g, 'color').name('色').onChange(apply);
    folder.add(g, 'startOpacity', 0, 1, 0.01).name('開始の不透明度（上端）').onChange(apply);
    folder.add(g, 'endOpacity', 0, 1, 0.01).name('終了の不透明度（下端）').onChange(apply);
    folder.add(g, 'length', 0, 100, 1).name('影の長さ（画面高さ%）').onChange(apply);
    folder.close();
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

    // --- 天球（equirectangular 背景画像）。任意ファイルを選んで見え方を検証できる。
    const applySky = () => {
      environment.applySky(scene.sky);
      touch();
    };
    const sky = folder.addFolder('sky（天球背景）');
    const enabledCtrl = sky.add(scene.sky, 'enabled').name('有効').onChange(applySky);
    sky.add(scene.sky, 'image').name('画像URL/パス').onChange(applySky);
    sky.add(scene.sky, 'intensity', 0, 3, 0.01).name('明るさ').onChange(applySky);
    sky.add(scene.sky, 'blurriness', 0, 1, 0.01).name('ぼかし').onChange(applySky);
    // ローカルから任意ファイルを選んでライブ検証（object URL なので永続化はしない）。
    // 採用する画像が決まったら public/ 等に置き、上の「画像URL/パス」へそのパスを入力する運用。
    sky
      .add(
        {
          pick: () =>
            pickSkyImage((url, name) => {
              scene.sky.enabled = true;
              enabledCtrl.updateDisplay();
              environment.applySky(scene.sky, url); // cfg.image を無視して選んだファイルを即適用
              console.log('[Editor] 天球プレビュー中（未保存）:', name);
            }),
        },
        'pick'
      )
      .name('ファイルを選んで確認（未保存）');

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
   * 2階層タブで出し分ける（lil-gui にタブは無いので自作）。map の値は
   * フォルダ（葉タブ）か { sub: {...} }（サブタブ群）。最上位＝ページ選択、
   * サブ＝生成ルックの編集面。選択タブの中身だけ表示し、残りは display:none。
   * 各フォルダは常に開いた状態にして冗長なフォルダ見出しは隠す。
   */
  _setupTabs(map) {
    injectTabStyles();
    const names = Object.keys(map);

    // 葉/サブ問わず全フォルダを開いて見出しを隠す
    for (const v of Object.values(map)) {
      const folders = v.sub ? Object.values(v.sub) : [v];
      for (const f of folders) {
        f.open();
        f.$title.style.display = 'none';
      }
    }

    const bar = document.createElement('div');
    bar.className = 'editor-tabbar';
    this._tabButtons = {};
    this._tabEls = {}; // トップ名 → 表示切替する DOM（葉=folder.domElement / 群=wrapper）
    this._subGroups = {}; // トップ名 → { map, buttons, names }（sub を持つタブのみ）
    for (const name of names) {
      const btn = document.createElement('button');
      btn.className = 'editor-tab';
      btn.textContent = name;
      btn.addEventListener('click', () => this._selectTab(name));
      bar.appendChild(btn);
      this._tabButtons[name] = btn;
    }

    // DOM 並び: Config IO / タブバー / 各タブ中身（生成はサブタブバー＋サブ中身を内包）
    const c = this.gui.$children;
    c.appendChild(bar);
    for (const name of names) {
      const v = map[name];
      if (v.sub) {
        const wrapper = document.createElement('div');
        const subBar = document.createElement('div');
        subBar.className = 'editor-tabbar editor-subtabbar';
        const subButtons = {};
        const subNames = Object.keys(v.sub);
        for (const sn of subNames) {
          const sb = document.createElement('button');
          sb.className = 'editor-tab editor-subtab';
          sb.textContent = sn;
          sb.addEventListener('click', () => this._selectSubTab(name, sn));
          subBar.appendChild(sb);
          subButtons[sn] = sb;
        }
        wrapper.appendChild(subBar);
        for (const sn of subNames) wrapper.appendChild(v.sub[sn].domElement);
        c.appendChild(wrapper);
        this._tabEls[name] = wrapper;
        this._subGroups[name] = { map: v.sub, buttons: subButtons, names: subNames };
      } else {
        c.appendChild(v.domElement);
        this._tabEls[name] = v.domElement;
      }
    }

    // 直前のタブを rebuild をまたいで復元。初回は 生成（D 押下で従来通り Timeline ＋ 俯瞰）
    this._selectTab(this._activeTab && map[this._activeTab] ? this._activeTab : '生成');
  }

  _selectTab(name) {
    this._activeTab = name;
    for (const [n, el] of Object.entries(this._tabEls)) {
      el.style.display = n === name ? '' : 'none';
      this._tabButtons[n].classList.toggle('active', n === name);
    }
    // サブタブ群なら、サブも選択（前回 or 先頭）
    const group = this._subGroups[name];
    if (group) {
      const sub = this._activeSubTab && group.map[this._activeSubTab] ? this._activeSubTab : group.names[0];
      this._selectSubTab(name, sub);
    }
    this._applyTabPreview(name);
  }

  /** 生成タブ内のサブタブ切替（ページ＝プレビュー状態は変えない） */
  _selectSubTab(groupName, subName) {
    const group = this._subGroups[groupName];
    if (!group) return;
    this._activeSubTab = subName;
    for (const [sn, f] of Object.entries(group.map)) {
      f.domElement.style.display = sn === subName ? '' : 'none';
      group.buttons[sn].classList.toggle('active', sn === subName);
    }
  }

  /**
   * 最上位タブ（ページ）に応じてプレビュー状態を切り替える。
   * 画面ページ（待機/撮影/リザルト）= Timeline を閉じて DOM/待機プレビュー。
   * 生成ページ（サブタブ Camera/Lights/Particles/Env 共通）= オーバーレイを畳んで Timeline。
   */
  _applyTabPreview(name) {
    if (!this.visible || this._building) return; // build 時・非表示中は何もしない（_show で改めて適用）
    const screen = SCREEN_TABS[name];
    // 飲料の個別調整（クリック選択）は待機プレビュー中だけ有効化する
    this.bottleEditor?.setActive(screen === 'select');
    // 生成カメラのギズモ/パスは生成ルックタブのときだけ表示（画面プレビューには無関係なので隠す）
    const wantPath = !screen;
    if (this._pathActive !== wantPath) {
      this.pathEditor.setActive(wantPath);
      this._pathActive = wantPath;
    }
    if (screen) {
      if (this.timeline.isOpen) this.timeline.close();
      this.screenPreview.show(screen);
    } else {
      this.screenPreview.hide();
      if (!this.timeline.isOpen) {
        this.timeline.open().then(() => {
          // D 押下直後と同じく俯瞰から始める（初回のみ意味がある）
          if (this.visible && this.timeline.isOpen && !SCREEN_TABS[this._activeTab]) {
            this.timeline._setViewMode('free');
          }
        });
      }
    }
  }

  /** import 後などの全再構築 */
  rebuild() {
    const wasVisible = this.visible;
    this.screenPreview.hide();
    this.bottleEditor.dispose();
    this.timeline.dispose();
    this.soundEditor.dispose();
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
    document.body.classList.add('editor-active');
    // アクティブタブに応じてプレビューを起動（生成系なら Timeline ＋ 俯瞰＋パス編集、画面系なら DOM）
    this._pathActive = null; // _applyTabPreview に setActive を強制させる
    this._applyTabPreview(this._activeTab);
  }

  _hide() {
    this.visible = false;
    this.gui.hide();
    this.timeline.close();
    this.screenPreview.hide();
    this.bottleEditor.setActive(false);
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
    if (this.ctx.manager.is('select')) {
      this.ctx.bottleRack.applyLayout?.();
      this.ctx.overlay.showSelectGradient(this.ctx.choreo.data.select.gradient);
    }
    this.bottleEditor.refresh(); // 個別オーバーライドの値変化を編集フォルダ・ボックスへ反映
    // 環境（fog/ガラス）もスナップショットへ追従させる（updateDisplay だけでは scene に反映されない）
    const sc = this.ctx.choreo.data.scene;
    if (sc) {
      this.ctx.environment.applyFog?.(sc.fog);
      this.ctx.environment.applySky?.(sc.sky);
      setGlassConfig(sc.glass);
      refreshGlassMaterials(this.ctx.world.scene);
    }
    this.soundEditor.refresh(); // sounds 配列の増減を GUI に反映
    this.timeline.invalidate();
    this.ctx.choreo.save(); // undo/redo 後の状態も保存
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    clearTimeout(this._commitTimer);
    this.bottleEditor.dispose();
    this.screenPreview.dispose();
    this.timeline.dispose();
    this.soundEditor.dispose();
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
/* 生成タブ内のサブタブ（一段細く・くすませて階層を示す） */
.editor-subtabbar { margin: 2px 0 6px; padding-left: 10px; }
.editor-subtab {
  padding: 4px 3px; font-size: 10px;
  background: #17171b; color: #9a9aa8; border-color: #33333d;
}
.editor-subtab.active {
  background: #284a92; color: #fff; border-color: #284a92;
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
  colorFadeStart: '色フェード・開始秒',
  colorFadeEnd: '色フェード・終了秒',
  swapPixelRadius: '切替直後の粒半径(px)',
  swapSizeBoostDur: '切替直後サイズ・収束秒',
  sizeGrow: '成長量',
  surviveRatio: '生存率',
  rippleLead: '波・開始遅延',
  rippleAmp: '波・振幅',
  rippleFreq: '波・周波数 [x, y]',
  rippleSpeed: '波・速度',
  dissolveDelaySpread: '飛散の遅延ばらつき',
  dissolveNoiseScale: 'ディゾルブ・ノイズ細かさ',
  dissolveEdge: 'ディゾルブ・境界ぼかし幅',
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
