import { defineConfig } from 'vite';
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * public/sounds/ を走査して manifest.json を書き出す開発/ビルド用プラグイン。
 * これにより音響エディタ（生成 > Sound）のドロップダウンが、public/sounds に置いた
 * 音源ファイル（whsh.mp3 等）を実行時に自動で拾えるようになる。
 * 追加したら dev サーバ起動 or build で manifest が更新される。
 */
function soundsManifest() {
  const dir = resolve(__dirname, 'public/sounds');
  const write = () => {
    try {
      const files = readdirSync(dir)
        .filter((f) => /\.(mp3|wav|ogg|m4a|aac)$/i.test(f))
        .sort();
      writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(files, null, 2) + '\n');
    } catch {
      /* public/sounds が無い等は無視 */
    }
  };
  return {
    name: 'ccjc-sounds-manifest',
    buildStart: write,
    configureServer: write,
  };
}

export default defineConfig({
  plugins: [soundsManifest()],
});
