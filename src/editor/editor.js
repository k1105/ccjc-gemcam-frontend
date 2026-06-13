import { GUI } from 'lil-gui';
import { PathEditor } from './path-editor.js';
import { Timeline } from './timeline.js';
import { exportChoreo, importChoreo } from './io.js';

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
  }

  _build() {
    this.gui = new GUI({ title: 'CCJC Choreography Editor', width: 330 });
    this.gui.domElement.style.position = 'fixed';
    this.gui.domElement.style.top = '12px';
    this.gui.domElement.style.right = '12px';
    this.gui.domElement.style.zIndex = '1000';
    this.gui.hide();

    const { choreo, manager, bottleRack } = this.ctx;

    // --- IO ---
    const ioFolder = this.gui.addFolder('Config IO');
    ioFolder.add({ export: () => exportChoreo(choreo) }, 'export').name('Export JSON（→ src/choreo/ に上書き）');
    ioFolder.add({ import: () => importChoreo(choreo, () => this.rebuild()) }, 'import').name('Import JSON');

    // --- カメラパス + タイムライン ---
    this.pathEditor = new PathEditor(this.ctx, this.gui);
    this.timeline = new Timeline(this.ctx, { pathEditor: this.pathEditor });
    this.pathEditor.onChanged = () => this.timeline.invalidate();
    this.gui
      .add({ open: () => this.timeline.toggle() }, 'open')
      .name('🎬 Timeline（フレーム単位プレビュー）');

    // --- タイミング/パラメータ（choreo JSON を再帰的にGUI化） ---
    const onTuned = () => {
      // ラック系は SELECT 待機中ならレイアウトへ即反映
      if (manager.is('select')) bottleRack.applyLayout();
    };
    const tune = this.gui.addFolder('Parameters');
    buildGuiFromObject(tune.addFolder('select'), choreo.data.select, { onChange: onTuned });
    buildGuiFromObject(tune.addFolder('shoot'), choreo.data.shoot, {});
    // generate: カメラ編成に効く値はタイムラインへ通知。particles はシェーダ
    // uniform に焼かれるため scene:true（プレビューの粒を再構築）
    const gen = tune.addFolder('generate');
    buildGuiFromObject(gen, choreo.data.generate, {
      skipKeys: ['path', 'particles'], // パスは PathEditor で編集
      onChange: () => this.timeline.invalidate(),
    });
    buildGuiFromObject(gen.addFolder('particles'), choreo.data.generate.particles, {
      onChange: () => this.timeline.invalidate({ scene: true }),
    });
    buildGuiFromObject(tune.addFolder('result'), choreo.data.result, {});
    tune.folders.forEach((f) => f.close());
  }

  /** import 後などの全再構築 */
  rebuild() {
    const wasVisible = this.visible;
    this.timeline.dispose();
    this.pathEditor.dispose();
    this.gui.destroy();
    this._build();
    if (wasVisible) this._show();
  }

  toggle() {
    this.visible ? this._hide() : this._show();
  }

  _show() {
    this.visible = true;
    this.gui.show();
    this.pathEditor.setActive(true);
    document.body.classList.add('editor-active');
  }

  _hide() {
    this.visible = false;
    this.gui.hide();
    this.timeline.close();
    this.pathEditor.setActive(false);
    document.body.classList.remove('editor-active');
  }

  dispose() {
    this.timeline.dispose();
    this.pathEditor.dispose();
    this.gui.destroy();
    document.body.classList.remove('editor-active');
  }
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
function buildGuiFromObject(folder, obj, { skipKeys = [], onChange } = {}) {
  for (const [key, val] of Object.entries(obj)) {
    if (skipKeys.includes(key)) continue;

    if (typeof val === 'number') {
      const [min, max] = rangeFor(val);
      folder.add(obj, key, min, max, 0.01).onChange(onChange);
    } else if (typeof val === 'string' || typeof val === 'boolean') {
      folder.add(obj, key).onChange(onChange);
    } else if (Array.isArray(val)) {
      if (val.length && val.every((x) => typeof x === 'number')) {
        const sub = folder.addFolder(key);
        val.forEach((x, i) => {
          const proxy = { v: x };
          const [min, max] = rangeFor(x);
          sub
            .add(proxy, 'v', min, max, 0.01)
            .name(`[${i}]`)
            .onChange((nv) => {
              val[i] = nv;
              onChange?.();
            });
        });
        sub.close();
      } else if (val.length && val.every((x) => x && typeof x === 'object')) {
        const sub = folder.addFolder(key);
        val.forEach((item, i) => {
          const label = item.id ?? item.el ?? String(i);
          buildGuiFromObject(sub.addFolder(label), item, { skipKeys, onChange });
        });
        sub.close();
      }
      // 混在配列（"@current" を含む path 等）はスキップ
    } else if (val && typeof val === 'object') {
      const sub = folder.addFolder(key);
      buildGuiFromObject(sub, val, { skipKeys, onChange });
      sub.close();
    }
  }
}
