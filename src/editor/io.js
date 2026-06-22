/**
 * choreography.json の export（ダウンロード）/ import（ファイル読み込み）。
 * 調整した値は export して src/choreo/choreography.json に上書きコミットする運用。
 */
export function exportChoreo(choreo) {
  const blob = new Blob([choreo.toJSONString()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'choreography.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * 粒テクスチャ用の画像を読み込み、data URL を onLoad へ渡す。
 * 呼び出し側で particles.grainImage へ格納し、粒を再構築して反映する。
 */
export function importGrainImage(onLoad) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      onLoad(reader.result);
      console.log('[Editor] grain image loaded:', file.name);
    };
    reader.onerror = () => alert(`画像の読み込みに失敗しました: ${file.name}`);
    reader.readAsDataURL(file);
  };
  input.click();
}

/**
 * 天球（背景）画像をローカルから選び、object URL を onPick(url, name) へ渡す。
 * 検証用途のため data URL ではなく object URL を返す（equirectangular は大きく、
 * data URL 化すると localStorage / JSON が肥大化するため永続化しない）。
 * 呼び出し側は受け取った URL を environment.applySky の overrideUrl に渡してライブ確認する。
 */
export function pickSkyImage(onPick) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    onPick(url, file.name);
    console.log('[Editor] 天球画像を選択:', file.name);
  };
  input.click();
}

export function importChoreo(choreo, onDone) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      choreo.replace(json);
      onDone?.();
      console.log('[Editor] choreography imported');
    } catch (err) {
      console.error('[Editor] import failed', err);
      alert(`importに失敗しました: ${err.message}`);
    }
  };
  input.click();
}
