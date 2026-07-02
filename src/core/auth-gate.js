// Vercelデプロイ専用のログインゲート。isAuthRequired()（auth-env.js）が true のときだけ
// main.js/api.js から動的importされる（firebaseをローカル会場PCビルドのバンドルに含めないため）。
// Googleサインイン → /api/auth/verify で許可アカウントか確認 → 通れば boot() へ進む。
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  getIdToken,
} from 'firebase/auth';

let auth = null;

/** 現在ログイン中ユーザーのIDトークン（未ログイン時は null）。ApiService から呼ぶ。 */
export async function getCurrentIdToken() {
  if (!auth?.currentUser) return null;
  return getIdToken(auth.currentUser);
}

/** ログインゲートを表示し、許可アカウントでのサインインが完了するまで待つ Promise を返す。 */
export function waitForAllowedUser() {
  const gate = document.getElementById('login-gate');
  const signInBtn = document.getElementById('login-gate-signin');
  const signOutBtn = document.getElementById('login-gate-signout');
  const statusEl = document.getElementById('login-gate-status');
  const setStatus = (text) => {
    if (statusEl) statusEl.textContent = text || '';
  };

  const app = initializeApp({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  });
  auth = getAuth(app);
  const provider = new GoogleAuthProvider();

  gate?.classList.remove('hidden');

  return new Promise((resolve) => {
    signInBtn?.addEventListener('click', async () => {
      setStatus('');
      signInBtn.disabled = true;
      try {
        await signInWithPopup(auth, provider);
      } catch (err) {
        console.error('[auth-gate] signIn error:', err);
        setStatus('ログインに失敗しました');
      } finally {
        signInBtn.disabled = false;
      }
    });

    signOutBtn?.addEventListener('click', () => {
      signOut(auth).catch((err) => console.error('[auth-gate] signOut error:', err));
    });

    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        signOutBtn?.classList.add('hidden');
        signInBtn?.classList.remove('hidden');
        return;
      }
      signInBtn?.classList.add('hidden');
      signOutBtn?.classList.remove('hidden');
      setStatus('確認中…');
      try {
        const idToken = await getIdToken(user);
        const res = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setStatus(data.error || 'このアカウントは許可されていません');
          return;
        }
        gate?.classList.add('hidden');
        resolve();
      } catch (err) {
        console.error('[auth-gate] verify error:', err);
        setStatus('確認に失敗しました。通信環境を確認してください');
      }
    });
  });
}
