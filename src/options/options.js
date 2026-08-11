/** 設定ページの外枠。サービス一覧・タブ切り替え・マスターパスワード・バックアップを扱う。 */

import { MSG, request } from '../lib/messages.js';
import { describeRule } from '../lib/match.js';
import { $, $$, clear, el, setStatus } from '../ui/dom.js';
import { createServiceEditor } from './service-editor.js';

const state = { services: [], selectedId: null, filter: '' };

const editor = createServiceEditor({
  onChanged: async (serviceId) => {
    state.selectedId = serviceId;
    await reloadServices();
  },
});

async function boot() {
  const status = await request(MSG.VAULT_STATUS);
  const locked = !status.unlocked;
  $('#locked').classList.toggle('hidden', !locked);
  $('#main').classList.toggle('hidden', locked);
  $('#init-hint').classList.toggle('hidden', status.initialized);
  if (locked) {
    if (status.initialized) $('#unlock-password').focus();
    return;
  }
  await reloadServices();
}

async function reloadServices() {
  const result = await request(MSG.SERVICE_LIST);
  state.services = result.services;
  renderList();
  if (state.selectedId && state.services.some((service) => service.id === state.selectedId)) {
    await editor.load(state.selectedId);
  } else if (!editor.currentId()) {
    editor.clear();
  }
}

function renderList() {
  const list = $('#service-list');
  clear(list);
  const filter = state.filter.trim().toLowerCase();
  const services = filter
    ? state.services.filter((service) => matchesFilter(service, filter))
    : state.services;

  if (!services.length) {
    list.append(el('li', { className: 'small muted', text: filter ? '該当するサービスがありません。' : 'サービスが登録されていません。' }));
    return;
  }

  for (const service of services) {
    const button = el('button', {
      attrs: { type: 'button', 'aria-current': service.id === state.selectedId ? 'true' : 'false' },
      on: {
        click: async () => {
          state.selectedId = service.id;
          renderList();
          try {
            await editor.load(service.id);
          } catch (error) {
            setStatus($('#editor-status'), error.message, 'error');
          }
        },
      },
    }, [
      el('span', { text: service.name || '(名称未設定)' }),
      el('span', {
        className: 'sub',
        text: service.matchRules.length ? describeRule(service.matchRules[0]) : 'URL条件なし',
      }),
      el('span', { className: 'sub', text: `${service.accounts.length}アカウント / ${service.fieldCount}項目` }),
    ]);
    list.append(el('li', {}, [button]));
  }
}

function matchesFilter(service, filter) {
  const haystack = [service.name, ...service.matchRules.map(describeRule)].join(' ').toLowerCase();
  return haystack.includes(filter);
}

// --- タブ -------------------------------------------------------------------

for (const button of $$('.tab-button')) {
  button.addEventListener('click', () => {
    for (const other of $$('.tab-button')) {
      other.setAttribute('aria-selected', String(other === button));
    }
    for (const panel of $$('.tab-panel')) {
      panel.classList.toggle('hidden', panel.dataset.panel !== button.dataset.tab);
    }
  });
}

// --- ロック / アンロック -----------------------------------------------------

$('#form-unlock').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#unlock-password');
  try {
    await request(MSG.VAULT_UNLOCK, { password: input.value });
    input.value = '';
    setStatus($('#unlock-status'), '');
    await boot();
  } catch (error) {
    input.value = '';
    setStatus($('#unlock-status'), error.message, 'error');
  }
});

$('#btn-lock').addEventListener('click', async () => {
  await request(MSG.VAULT_LOCK);
  editor.clear();
  state.services = [];
  state.selectedId = null;
  await boot();
});

// --- サービス一覧 -----------------------------------------------------------

$('#service-filter').addEventListener('input', (event) => {
  state.filter = event.target.value;
  renderList();
});

$('#btn-new-service').addEventListener('click', () => {
  state.selectedId = null;
  renderList();
  editor.createNew();
});

// --- マスターパスワード -----------------------------------------------------

$('#form-password').addEventListener('submit', async (event) => {
  event.preventDefault();
  const current = $('#current-password');
  const next = $('#new-password');
  const confirmInput = $('#new-password-confirm');
  if (next.value !== confirmInput.value) {
    setStatus($('#password-status'), '新しいパスワードが一致しません。', 'error');
    return;
  }
  try {
    await request(MSG.VAULT_CHANGE_PASSWORD, { currentPassword: current.value, newPassword: next.value });
    current.value = '';
    next.value = '';
    confirmInput.value = '';
    setStatus($('#password-status'), 'マスターパスワードを変更しました。', 'ok');
  } catch (error) {
    setStatus($('#password-status'), error.message, 'error');
  }
});

// --- バックアップ -----------------------------------------------------------

$('#form-export').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#export-passphrase');
  try {
    const backup = await request(MSG.VAULT_EXPORT, { passphrase: input.value });
    downloadJson(backup);
    input.value = '';
    setStatus($('#export-status'), '暗号化バックアップを保存しました。', 'ok');
  } catch (error) {
    setStatus($('#export-status'), error.message, 'error');
  }
});

/** ファイル名用の日時（端末のローカル時刻）。 */
function timestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function downloadJson(backup) {
  const stamp = timestamp();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = el('a', { attrs: { href: url, download: `lgpwmng-backup-${stamp}.json` } });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#form-import').addEventListener('submit', async (event) => {
  event.preventDefault();
  const fileInput = $('#import-file');
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    setStatus($('#import-status'), 'バックアップファイルを選択してください。', 'error');
    return;
  }
  try {
    const backup = JSON.parse(await file.text());
    const result = await request(MSG.VAULT_IMPORT, {
      backup,
      passphrase: $('#import-passphrase').value,
      mode: $('#import-mode').value,
    });
    $('#import-passphrase').value = '';
    fileInput.value = '';
    setStatus($('#import-status'), `${result.imported}件のサービスを取り込みました（現在${result.total}件）。`, 'ok');
    state.selectedId = null;
    editor.clear();
    await reloadServices();
  } catch (error) {
    const message = error instanceof SyntaxError ? 'ファイルを読み取れませんでした。' : error.message;
    setStatus($('#import-status'), message, 'error');
  }
});

boot().catch((error) => {
  $('#locked').classList.remove('hidden');
  setStatus($('#unlock-status'), error.message, 'error');
});
