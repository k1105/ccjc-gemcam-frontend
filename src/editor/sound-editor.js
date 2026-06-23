import { GUI } from 'lil-gui';
import { playSound } from '../core/audio.js';
import { importAudioFile } from './io.js';

/**
 * public/sounds/manifest.json（vite.config.js のプラグインが自動生成）を1度だけ取得。
 * 返り値は ['sounds/whsh.mp3', ...] のパス配列で、音響エディタの音源ドロップダウンに使う。
 */
let _manifestPromise = null;
function fetchSoundManifest() {
  if (!_manifestPromise) {
    const url = `${import.meta.env.BASE_URL}sounds/manifest.json`;
    _manifestPromise = fetch(url, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : []))
      .then((files) => (Array.isArray(files) ? files.map((f) => `sounds/${f}`) : []))
      .catch(() => []);
  }
  return _manifestPromise;
}

/** sfx イベントの日本語ラベル（choreo.data.sfx のキー → 表示名） */
const SFX_LABELS = {
  select: 'ボトル選択',
  countdown: 'カウントダウン(3/2/1)',
  shutter: 'シャッター',
  resultAppear: 'リザルト登場',
  bottleSlideIn: 'ボトル スライドイン',
};

/**
 * 効果音の編集パネル（生成サブタブ「Sound」）。2系統を1か所で扱う:
 *  1) シーン効果音（choreo.data.sfx）… 選択 / カウントダウン / シャッター / リザルト登場 /
 *     スライドイン。choreography.json が初期値で、ここ（または JSON/localStorage）で上書きできる。
 *  2) 生成タイムラインのビープ（choreo.data.generate.sounds）… Timeline のドラッグ操作と同じ
 *     データを編集し、相互に同期する（onChanged→Timeline 再描画 / refresh()→GUI 再構築）。
 *
 * 各行: 種別（beep or パス/URL or 埋め込み）/ beep の音程・長さ / 音量 / 有効 / 試聴 /
 * ファイル埋め込み。生成ビープのみ 開始秒 と 削除 を持つ。
 */
export class SoundEditor {
  constructor(ctx) {
    this.ctx = ctx;
    this.onChanged = null; // Editor が invalidate + undo/保存 を差し込む
    this.gui = new GUI({ title: 'Sound', width: 330 });
    this._sfxFolder = null;
    this._listFolder = null;
    this._available = null; // public/sounds の音源パス一覧（manifest 取得後にドロップダウン化）
    this._build();
    // public/sounds/manifest.json を取得できたら音源をドロップダウンで選べるよう作り直す
    fetchSoundManifest().then((paths) => {
      this._available = paths;
      this._rebuildAll();
    });
  }

  _sounds() {
    const g = this.ctx.choreo.data.generate;
    if (!Array.isArray(g.sounds)) g.sounds = [];
    return g.sounds;
  }

  _sfx() {
    return this.ctx.choreo.data.sfx ?? (this.ctx.choreo.data.sfx = {});
  }

  _build() {
    this.gui.add({ add: () => this._addBeep() }, 'add').name('＋ 生成ビープを追加');
    this._rebuildAll();
  }

  _rebuildAll() {
    this._rebuildSfx();
    this._rebuildList();
  }

  // ---- シーン効果音（sfx） ----

  _rebuildSfx() {
    if (this._sfxFolder) this._sfxFolder.destroy();
    this._sfxFolder = this.gui.addFolder('効果音（シーン別）');
    this._sfxFolder.open();
    const sfx = this._sfx();
    for (const key of Object.keys(sfx)) {
      this._buildRow(this._sfxFolder, sfx[key], {
        title: SFX_LABELS[key] ?? key,
        icon: '🔈',
      });
    }
  }

  // ---- 生成タイムラインのビープ（generate.sounds） ----

  _rebuildList() {
    if (this._listFolder) this._listFolder.destroy();
    const sounds = this._sounds();
    this._listFolder = this.gui.addFolder(`生成ビープ (${sounds.length})`);
    this._listFolder.open();
    for (const s of sounds) {
      this._buildRow(this._listFolder, s, {
        title: s.id,
        icon: '🔊',
        showStart: true,
        onDelete: () => this._remove(s.id),
      });
    }
  }

  /**
   * サウンド定義1件分の行（サブフォルダ）。sfx・生成ビープ共通。
   * @param {GUI} parent  追加先フォルダ
   * @param {object} s    編集対象の sound 定義（直接ミューテートする）
   * @param {{title:string, icon:string, showStart?:boolean, onDelete?:()=>void}} opts
   */
  _buildRow(parent, s, { title, icon, showStart = false, onDelete } = {}) {
    // lil-gui バインドのため欠けている既定値を補う（JSON にも書き戻る）
    s.sound ??= 'beep';
    s.volume ??= 0.5;
    s.enabled ??= true;
    if (showStart) s.start ??= 0;

    const f = parent.addFolder(`${icon} ${title}${s.enabled ? '' : '（無効）'}`);
    const changed = () => this.onChanged?.();

    if (showStart) f.add(s, 'start', 0, 30, 0.01).name('開始秒').onChange(changed);

    const embedded = typeof s.sound === 'string' && s.sound.startsWith('data:');
    if (embedded) {
      f.add({ kind: '（埋め込み音源）' }, 'kind').name('種別').disable();
      f.add(
        { clear: () => { s.sound = 'beep'; this._rebuildAll(); changed(); } },
        'clear'
      ).name('埋め込みを消す（beepへ）');
    } else {
      // manifest 取得後は public/sounds の音源をドロップダウンで選択可能に。
      // 現在値がプリセットに無い（手入力パス/URL）場合は先頭に足して選択状態を保てるようにする。
      if (this._available) {
        const presets = ['beep', ...this._available];
        const opts = presets.includes(s.sound) ? presets : [s.sound, ...presets];
        f.add({ sel: s.sound }, 'sel', opts)
          .name('音源を選択')
          .onChange((v) => { s.sound = v; this._rebuildAll(); changed(); });
      }
      // 直接入力（beep / 任意パス / URL）。ドロップダウンに無い音源もここで指定できる。
      f.add(s, 'sound').name('種別: beep / パス・URL').onChange(() => { this._rebuildAll(); changed(); });
    }

    if (s.sound === 'beep') {
      s.freq ??= 880;
      s.duration ??= 0.12;
      f.add(s, 'freq', 100, 4000, 1).name('音程(Hz)').onChange(changed);
      f.add(s, 'duration', 0.02, 2, 0.01).name('長さ(s)').onChange(changed);
    }
    f.add(s, 'volume', 0, 1, 0.01).name('音量').onChange(changed);
    f.add(s, 'enabled').name('有効').onChange(() => { this._rebuildAll(); changed(); });

    f.add({ play: () => playSound(s) }, 'play').name('▶ 試聴');
    f.add(
      { upload: () => importAudioFile((dataUrl) => { s.sound = dataUrl; this._rebuildAll(); changed(); }) },
      'upload'
    ).name('音源ファイルを埋め込み');
    if (onDelete) f.add({ del: onDelete }, 'del').name('🗑 削除');
    f.close();
  }

  // ---- 生成ビープの追加/削除 ----

  _uniqueId(base) {
    const ids = new Set(this._sounds().map((s) => s.id));
    let i = 1;
    while (ids.has(`${base}${i}`)) i++;
    return `${base}${i}`;
  }

  _addBeep() {
    const def = {
      id: this._uniqueId('beep'),
      start: 0,
      sound: 'beep',
      freq: 880,
      duration: 0.12,
      volume: 0.3,
      enabled: true,
    };
    this._sounds().push(def);
    this._rebuildList();
    this.onChanged?.();
    playSound(def);
  }

  _remove(id) {
    const sounds = this._sounds();
    const i = sounds.findIndex((s) => s.id === id);
    if (i < 0) return;
    sounds.splice(i, 1);
    this._rebuildList();
    this.onChanged?.();
  }

  /** Timeline 側で generate.sounds が変わったとき（追加/移動/削除）に呼ばれ、表示を作り直す */
  refresh() {
    this._rebuildAll();
  }

  dispose() {
    this.gui.destroy();
  }
}
