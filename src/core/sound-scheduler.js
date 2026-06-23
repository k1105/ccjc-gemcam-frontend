import { playSound, preloadSound } from './audio.js';

/**
 * GENERATE の音響レイヤー（choreo.data.generate.sounds）を絶対経過秒で再生する
 * スケジューラ。カメラの OverlayScheduler と同じ時間軸（GENERATE 開始からの経過秒）で、
 * 各サウンドの start を跨いだフレームでワンショット再生する。
 *
 * follow/loop の弾性ホールドで base 尺が伸びても、サウンドは絶対時刻で鳴る
 * （エディタの固定尺プレビュー＝Timeline と定義上一致する）。
 */
export class SoundScheduler {
  constructor() {
    this.sounds = [];
    this.elapsed = 0;
  }

  /** gcfg.sounds をセット（enabled:false は除外）。経過をリセットする */
  setSounds(sounds) {
    this.sounds = (sounds ?? [])
      .filter((s) => s && s.enabled !== false)
      .map((s) => ({ def: s, start: s.start ?? 0, fired: false }));
    this.elapsed = 0;
  }

  /** 毎フレーム呼ぶ。経過秒が start に達したサウンドを一度だけ発火する */
  tick(dt) {
    this.elapsed += dt;
    for (const s of this.sounds) {
      if (!s.fired && this.elapsed >= s.start) {
        s.fired = true;
        playSound(s.def);
      }
    }
  }
}
