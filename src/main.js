import './style.css';
import { World } from './core/world.js';
import { SequenceManager } from './core/sequence-manager.js';
import { Keyboard } from './core/keyboard.js';
import { Brands } from './core/brands.js';
import { Choreo } from './core/choreo.js';
import { CameraDirector } from './core/camera-director.js';
import { MockApiService } from './core/mock-api.js';
import { Webcam } from './core/webcam.js';
import { ApiService } from './api.js';
import { Overlay } from './ui/overlay.js';
import { createEnvironment } from './world/environment.js';
import { setGlassConfig } from './world/bottle-factory.js';
import { BottleRack } from './world/bottle-rack.js';
import { SelectSequence } from './sequences/select.js';
import { ShootSequence } from './sequences/shoot.js';
import { GenerateSequence } from './sequences/generate.js';
import { ResultSequence } from './sequences/result.js';

async function boot() {
  const world = new World('canvas-container');
  const choreo = await Choreo.load();
  const brands = new Brands();
  const overlay = new Overlay();
  const keyboard = new Keyboard();
  const manager = new SequenceManager();
  const director = new CameraDirector(world.camera, world);
  const api = import.meta.env.VITE_MOCK === '1' ? new MockApiService() : new ApiService();

  // ガラスマテリアルの見え方はボトル生成より前に確定させる（ロード時に適用されるため）
  setGlassConfig(choreo.data.scene.glass);
  const environment = createEnvironment(world.scene, choreo.data.scene.fog);
  world.setupPostFX(choreo.data.scene.postfx);

  const bottleRack = new BottleRack(brands, choreo);
  await bottleRack.init(world.scene);
  world.addTickable(bottleRack.tick);

  const ctx = {
    world,
    choreo,
    brands,
    overlay,
    keyboard,
    manager,
    director,
    api,
    webcam: new Webcam(),
    bottleRack,
    environment,
  };

  manager.register('select', new SelectSequence(ctx));
  manager.register('shoot', new ShootSequence(ctx));
  manager.register('generate', new GenerateSequence(ctx));
  manager.register('result', new ResultSequence(ctx));

  // --- グローバルキー ---
  let editor = null;
  keyboard.addGlobalHandler((key) => {
    // ESC: バックヤードの強制リセット
    if (key === 'Escape') {
      manager.reset('select');
      return true;
    }
    // D: デバッグエディタ（lazy import — 本番ではチャンクごと未ロード）
    if (key === 'D') {
      if (editor) {
        editor.toggle();
      } else {
        import('./editor/editor.js').then(({ Editor }) => {
          editor = new Editor(ctx);
          if (window.app) window.app.editor = editor; // デバッグ/スモークテスト用フック
          editor.toggle();
        });
      }
      return true;
    }
    return false;
  });

  // WebGL コンテキストロスト対策（待機中なら自動復帰）
  world.renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.error('[World] WebGL context lost — reloading');
    window.location.reload();
  });

  await manager.go('select');
  window.app = { ctx }; // デバッグ用フック

  // ソークテスト用オートパイロット（VITE_AUTOPLAY=1）: 自動でループを回し続ける
  if (import.meta.env.VITE_AUTOPLAY === '1') {
    console.log('[Autoplay] enabled');
    setInterval(() => {
      if (manager.transitioning) return;
      if (manager.is('select')) {
        const key = String(Math.floor(Math.random() * 10));
        window.dispatchEvent(new KeyboardEvent('keydown', { key }));
      } else if (manager.is('shoot')) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      }
    }, 3000);
  }
}

window.addEventListener('DOMContentLoaded', boot);
