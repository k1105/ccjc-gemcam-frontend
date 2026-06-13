/**
 * Webカメラの共有管理。SELECT のボトル沈下中に acquire() でウォームアップしておき、
 * SHOOT 入場時には既にストリームが温まっている＝シームレスに映像へ切り替えられる。
 * release() は撮影直後・SELECT再入場・各リセット経路から呼ばれる（LED消灯の保証）。
 */
export class Webcam {
  constructor() {
    this.stream = null;
    this.promise = null;
  }

  acquire() {
    if (!this.promise) {
      this.promise = navigator.mediaDevices
        .getUserMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'user' },
          audio: false,
        })
        .then((stream) => {
          this.stream = stream;
          return stream;
        })
        .catch((err) => {
          this.promise = null;
          throw err;
        });
    }
    return this.promise;
  }

  release() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
    }
    this.stream = null;
    this.promise = null;
  }
}
