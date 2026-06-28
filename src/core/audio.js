/**
 * Web Audio による効果音エンジン。
 * 現状は beep（オシレータ合成）のみ。将来サンプル音源（URL）を足せるよう、
 * playSound(def) で def.sound の種別を見て分岐する形にしておく。
 *
 * AudioContext はユーザー操作後でないと resume できないブラウザ制約があるため、
 * 遅延生成し、再生のたびに resume() を試みる（最初のクリック/キー後に鳴り始める）。
 */

let _ctx = null;

/** 共有 AudioContext を遅延生成。suspended なら resume を試みる */
function audioCtx() {
  if (!_ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    _ctx = new AC();
  }
  if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
  return _ctx;
}

export const BEEP_DEFAULTS = { freq: 880, duration: 0.12, volume: 0.3, wave: 'sine' };

/**
 * 合成ビープを1発鳴らす。クリックノイズ防止に短いアタック/リリースのエンベロープを掛ける。
 * @param {{freq?:number, duration?:number, volume?:number, wave?:OscillatorType}} [opts]
 */
export function playBeep(opts = {}) {
  const ac = audioCtx();
  if (!ac) return;
  const freq = opts.freq ?? BEEP_DEFAULTS.freq;
  const dur = Math.max(opts.duration ?? BEEP_DEFAULTS.duration, 0.02);
  const vol = opts.volume ?? BEEP_DEFAULTS.volume;

  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = opts.wave ?? BEEP_DEFAULTS.wave;
  osc.frequency.value = freq;

  const now = ac.currentTime;
  const attack = Math.min(0.005, dur * 0.25);
  const release = Math.min(0.03, dur * 0.4);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(vol, now + attack);
  gain.gain.setValueAtTime(vol, now + Math.max(dur - release, attack));
  gain.gain.linearRampToValueAtTime(0, now + dur);

  osc.connect(gain).connect(ac.destination);
  osc.start(now);
  osc.stop(now + dur + 0.02);
  osc.onended = () => {
    osc.disconnect();
    gain.disconnect();
  };
}

// --- サンプル音源（ファイル/URL/data URL）の再生 ---

const _bufferCache = new Map(); // 解決済みURL -> Promise<AudioBuffer>

/** "beep" 以外の sound 値を再生可能な URL に解決する（相対パスは BASE_URL を前置） */
function resolveUrl(u) {
  if (/^(https?:|data:|blob:)/.test(u) || u.startsWith('/')) return u;
  return `${import.meta.env.BASE_URL}${u}`;
}

/** URL の音源を fetch → decodeAudioData してキャッシュする（失敗はキャッシュしない） */
function loadBuffer(url) {
  if (_bufferCache.has(url)) return _bufferCache.get(url);
  const ac = audioCtx();
  if (!ac) return Promise.reject(new Error('AudioContext 不可'));
  const p = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.arrayBuffer();
    })
    .then((buf) => ac.decodeAudioData(buf));
  _bufferCache.set(url, p);
  p.catch(() => _bufferCache.delete(url)); // 次回再試行できるように失敗は消す
  return p;
}

/**
 * サンプル音源を遅延ロードのキャッシュへ温めておく（本番開始前に呼ぶと初回再生のもたつきが消える）。
 * beep は合成なので何もしない。
 */
export function preloadSound(def = {}) {
  const kind = def.sound ?? 'beep';
  if (kind && kind !== 'beep') loadBuffer(resolveUrl(kind)).catch(() => {});
}

/** サンプル音源のフェード既定（クリックノイズ防止の短いイン/アウト、秒） */
export const SAMPLE_FADE_DEFAULTS = { fadeIn: 0.008, fadeOut: 0.015 };

/** サンプル音源を1発再生（ロード失敗時は beep にフォールバック）。
 * 頭/尻のクリックノイズ防止に短いフェードイン/アウトのエンベロープを掛ける。 */
function playBuffer(url, { volume, fadeIn, fadeOut } = {}) {
  const ac = audioCtx();
  if (!ac) return;
  loadBuffer(resolveUrl(url))
    .then((buffer) => {
      const src = ac.createBufferSource();
      const gain = ac.createGain();
      const vol = volume ?? 1.0;
      src.buffer = buffer;
      src.connect(gain).connect(ac.destination);

      // フェード尺はバッファ長を超えないようにクランプ（極短サンプルでも破綻しない）
      const dur = buffer.duration;
      const fIn = Math.min(fadeIn ?? SAMPLE_FADE_DEFAULTS.fadeIn, dur * 0.5);
      const fOut = Math.min(fadeOut ?? SAMPLE_FADE_DEFAULTS.fadeOut, dur * 0.5);
      const now = ac.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(vol, now + fIn);
      gain.gain.setValueAtTime(vol, now + Math.max(dur - fOut, fIn));
      gain.gain.linearRampToValueAtTime(0, now + dur);

      src.start(now);
      src.stop(now + dur);
      src.onended = () => {
        src.disconnect();
        gain.disconnect();
      };
    })
    .catch((err) => {
      console.warn(`[audio] 音源の読み込みに失敗 "${url}" — beep で代替`, err);
      playBeep();
    });
}

/**
 * サウンド定義を1発再生する。
 * - sound:"beep"（既定）… 合成ビープ（freq/duration/volume/wave）
 * - それ以外 … サンプル音源とみなし、URL/パス/data URL をロードして再生（volume）
 * @param {{sound?:string, freq?:number, duration?:number, volume?:number, wave?:OscillatorType}} [def]
 */
export function playSound(def = {}) {
  const kind = def.sound ?? 'beep';
  if (kind === 'beep') playBeep(def);
  else playBuffer(kind, { volume: def.volume ?? 1.0, fadeIn: def.fadeIn, fadeOut: def.fadeOut });
}

/**
 * choreo.data.sfx[name] の効果音を1発再生する（enabled:false や未定義は無音）。
 * 各シーケンスのトリガ地点（ボトル選択・カウントダウン・シャッター・リザルト登場・
 * スライドイン）から呼ぶ共通入口。定義は choreography.json の sfx が初期値で、
 * エディタ/JSON/localStorage で上書きできる。
 */
export function playSfx(choreo, name) {
  const def = choreo?.data?.sfx?.[name];
  if (!def || def.enabled === false) return;
  playSound(def);
}

/** sfx 全件のサンプルを事前ロードしてキャッシュを温める（本番開始前に1回） */
export function preloadAllSfx(choreo) {
  const sfx = choreo?.data?.sfx;
  if (!sfx) return;
  for (const def of Object.values(sfx)) preloadSound(def);
}

/**
 * GENERATE の音響レイヤー（generate.sounds）のサンプルを事前ロードして温める。
 * sfx と違い、これらは SoundScheduler が絶対秒で発火するため初回ロードが遅れると
 * 発音が start から後ろにずれる（炭酸/泡の音が断続的に聞こえる原因）。本番開始前に1回呼ぶ。
 */
export function preloadGenerateSounds(choreo) {
  const sounds = choreo?.data?.generate?.sounds;
  if (!Array.isArray(sounds)) return;
  for (const def of sounds) preloadSound(def);
}
