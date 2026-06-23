/**
 * Gemini API キー設定パネル（Ctrl+K で開閉）。
 * - ローカルバックエンド (server) の GET/POST /api/keys を叩く。
 * - GET はマスク済みのみ返るため、実キーはブラウザに保持しない。
 * - 最大3本。空欄のまま保存した枠は既存キーを保持（非破壊）。クリアボタンで明示削除。
 */
const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8787';
const SLOT_COUNT = 3;

export class KeySettings {
  constructor() {
    this.open = false;
    this.slots = []; // { input, clearBtn, hint, hadKey, cleared }
    this._root = null;
    this._buildDom();
  }

  _buildDom() {
    const root = document.createElement('div');
    root.id = 'key-settings';
    Object.assign(root.style, {
      position: 'fixed',
      inset: '0',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.6)',
      zIndex: '10000',
      fontFamily: 'system-ui, sans-serif',
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      width: 'min(520px, 92vw)',
      background: '#1b1d22',
      color: '#f2f2f2',
      borderRadius: '12px',
      padding: '24px',
      boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
      boxSizing: 'border-box',
    });

    const title = document.createElement('div');
    title.textContent = 'Gemini API キー設定';
    Object.assign(title.style, { fontSize: '18px', fontWeight: '600', marginBottom: '4px' });

    const sub = document.createElement('div');
    sub.textContent = '最大3本。生成ごとにラウンドロビンで使い、失敗時は次のキーへ自動で切り替えます。';
    Object.assign(sub.style, { fontSize: '12px', color: '#9aa0a6', marginBottom: '16px', lineHeight: '1.5' });

    panel.append(title, sub);

    for (let i = 0; i < SLOT_COUNT; i++) {
      const row = document.createElement('div');
      Object.assign(row.style, { marginBottom: '14px' });

      const label = document.createElement('label');
      label.textContent = `キー ${i + 1}`;
      Object.assign(label.style, { display: 'block', fontSize: '12px', color: '#c7c9cc', marginBottom: '6px' });

      const inputWrap = document.createElement('div');
      Object.assign(inputWrap.style, { display: 'flex', gap: '8px' });

      const input = document.createElement('input');
      input.type = 'password';
      input.autocomplete = 'off';
      input.spellcheck = false;
      Object.assign(input.style, {
        flex: '1',
        minWidth: '0',
        padding: '10px 12px',
        borderRadius: '8px',
        border: '1px solid #3a3d44',
        background: '#0f1115',
        color: '#f2f2f2',
        fontSize: '14px',
        fontFamily: 'ui-monospace, monospace',
        boxSizing: 'border-box',
      });

      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.textContent = 'クリア';
      Object.assign(clearBtn.style, {
        padding: '0 12px',
        borderRadius: '8px',
        border: '1px solid #3a3d44',
        background: 'transparent',
        color: '#e06b6b',
        fontSize: '12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      });

      const hint = document.createElement('div');
      Object.assign(hint.style, { fontSize: '11px', color: '#9aa0a6', marginTop: '5px', minHeight: '14px' });

      const slot = { input, clearBtn, hint, hadKey: false, cleared: false };

      input.addEventListener('input', () => {
        if (input.value.length > 0) slot.cleared = false;
        this._renderHint(slot);
      });
      clearBtn.addEventListener('click', () => {
        input.value = '';
        slot.cleared = slot.hadKey; // 既存があった枠だけ「クリア対象」にする
        this._renderHint(slot);
      });

      inputWrap.append(input, clearBtn);
      row.append(label, inputWrap, hint);
      panel.append(row);
      this.slots.push(slot);
    }

    const status = document.createElement('div');
    Object.assign(status.style, { fontSize: '12px', minHeight: '18px', margin: '4px 0 14px', color: '#9aa0a6' });
    this._status = status;
    panel.append(status);

    const actions = document.createElement('div');
    Object.assign(actions.style, { display: 'flex', justifyContent: 'flex-end', gap: '10px' });

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = '閉じる';
    Object.assign(cancelBtn.style, {
      padding: '10px 18px', borderRadius: '8px', border: '1px solid #3a3d44',
      background: 'transparent', color: '#e2e2e2', fontSize: '14px', cursor: 'pointer',
    });
    cancelBtn.addEventListener('click', () => this.hide());

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = '保存';
    Object.assign(saveBtn.style, {
      padding: '10px 18px', borderRadius: '8px', border: 'none',
      background: '#3b82f6', color: '#fff', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
    });
    saveBtn.addEventListener('click', () => this._save());
    this._saveBtn = saveBtn;

    actions.append(cancelBtn, saveBtn);
    panel.append(actions);

    // 背景クリックで閉じる（パネル内クリックは伝播させない）
    root.addEventListener('click', (e) => { if (e.target === root) this.hide(); });
    panel.addEventListener('click', (e) => e.stopPropagation());

    root.append(panel);
    document.body.append(root);
    this._root = root;
  }

  _renderHint(slot) {
    if (slot.input.value.length > 0) {
      slot.hint.textContent = '新しいキーを設定します';
      slot.hint.style.color = '#5fae6b';
    } else if (slot.cleared) {
      slot.hint.textContent = 'このキーを削除します';
      slot.hint.style.color = '#e06b6b';
    } else if (slot.hadKey) {
      slot.hint.textContent = `${slot.maskedText}（空欄保存で保持）`;
      slot.hint.style.color = '#9aa0a6';
    } else {
      slot.hint.textContent = '未設定';
      slot.hint.style.color = '#9aa0a6';
    }
  }

  async _load() {
    this._status.textContent = '読み込み中…';
    try {
      const res = await fetch(`${API_BASE}/api/keys`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const slotsData = data.slots || [];
      this.slots.forEach((slot, i) => {
        const d = slotsData[i] || {};
        slot.input.value = '';
        slot.cleared = false;
        slot.hadKey = !!d.hasKey;
        slot.maskedText = d.masked || '';
        slot.input.placeholder = d.hasKey ? d.masked : '未設定';
        this._renderHint(slot);
      });
      this._status.textContent = `現在 ${data.count} 本設定済み`;
      this._status.style.color = '#9aa0a6';
    } catch (err) {
      this._status.textContent = `バックエンドに接続できません: ${err.message}`;
      this._status.style.color = '#e06b6b';
    }
  }

  async _save() {
    // 各枠の値: 非空=設定 / クリア対象="" / それ以外=null（既存保持）
    const keys = this.slots.map((slot) => {
      if (slot.input.value.trim().length > 0) return slot.input.value.trim();
      if (slot.cleared) return '';
      return null;
    });

    this._saveBtn.disabled = true;
    this._status.textContent = '保存中…';
    this._status.style.color = '#9aa0a6';
    try {
      const res = await fetch(`${API_BASE}/api/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      this._status.textContent = `保存しました（現在 ${data.count} 本）`;
      this._status.style.color = '#5fae6b';
      await this._load(); // マスク表示を更新
    } catch (err) {
      this._status.textContent = `保存に失敗: ${err.message}`;
      this._status.style.color = '#e06b6b';
    } finally {
      this._saveBtn.disabled = false;
    }
  }

  show() {
    this.open = true;
    this._root.style.display = 'flex';
    this._load();
  }

  hide() {
    this.open = false;
    this._root.style.display = 'none';
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }
}
