/** 設定ページの外枠。サービス一覧・タブ切り替え・マスターパスワード・バックアップを扱う。 */

import { MSG, request } from '../lib/messages.js';
import { describeRule } from '../lib/match.js';
import { $, $$, clear, el, setStatus } from '../ui/dom.js';
import { downloadJson, timestamp } from '../ui/download.js';
import { createServiceEditor } from './service-editor.js';
import { createSharePanel } from './share-panel.js';

// draft: 「新規」で作成中の、まだ一度も保存していないサービスがあるか（一覧に仮の行を出すための表示用）。
const state = { services: [], selectedId: null, filter: '', draft: false };

const editor = createServiceEditor({
  onChanged: async (serviceId) => {
    state.selectedId = serviceId;
    state.draft = false;
    await reloadServices();
  },
  // アカウントの自動保存後は一覧の表示だけを更新する。編集中の内容は読み直さない。
  onAccountsSaved: () => { refreshList().catch(() => {}); },
});

/**
 * データ利用への同意状態を表示する。
 * 同意そのものは popup で行うため、ここでは状態を示すだけにしている。
 */
async function showConsentState() {
  try {
    const consent = await request(MSG.CONSENT_STATUS);
    $('#about-consent').textContent = consent.granted
      ? `同意済み（開示バージョン ${consent.version}）`
      : '未同意（拡張アイコンから同意画面を確認してください）';
  } catch {
    $('#about-consent').textContent = '取得できませんでした';
  }
}

createSharePanel({
  // 共有インポートで Vault が更新されたら、一覧と編集中のサービスを読み直す。
  // 読み直さないと、開いたままの編集画面が古い accounts を持ち続け、その後の
  // アカウント自動保存でインポート結果を上書きしてしまう。
  onImported: () => reloadServices(),
});

async function boot() {
  $('#about-version').textContent = `v${chrome.runtime.getManifest().version}`;
  await showConsentState();
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

/** サービス一覧（左側）だけを最新の内容にする。編集中の内容は読み直さない。 */
async function refreshList() {
  const result = await request(MSG.SERVICE_LIST);
  state.services = result.services;
  renderList();
}

async function reloadServices() {
  await refreshList();
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

  $('#service-count').textContent = filter
    ? `${services.length} / ${state.services.length}件`
    : `${state.services.length}件`;

  if (state.draft) {
    list.append(el('li', { className: 'draft-item', attrs: { 'aria-current': 'true' } }, [
      el('span', { className: 'service-name', text: '新規サービス' }),
      el('span', { className: 'sub', text: '未保存（右の画面で保存すると一覧に追加されます）' }),
    ]));
  }

  if (!services.length) {
    if (!state.draft || filter) {
      list.append(el('li', { className: 'small muted empty-item', text: filter ? '該当するサービスがありません。' : 'サービスが登録されていません。' }));
    }
    return;
  }

  for (const service of services) {
    const button = el('button', {
      attrs: { type: 'button', 'aria-current': service.id === state.selectedId ? 'true' : 'false' },
      on: {
        click: async () => {
          state.selectedId = service.id;
          state.draft = false;
          renderList();
          try {
            await editor.load(service.id);
          } catch (error) {
            setStatus($('#editor-status'), error.message, 'error');
          }
        },
      },
    }, [
      el('span', { className: 'service-name', text: service.name || '(名称未設定)' }),
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
  state.draft = false;
  await boot();
});

// --- サービス一覧 -----------------------------------------------------------

$('#service-filter').addEventListener('input', (event) => {
  state.filter = event.target.value;
  renderList();
});

$('#btn-new-service').addEventListener('click', () => {
  state.selectedId = null;
  state.draft = true;
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

// 「置換」は既存サービスを削除するため、選んだ時点で警告を表示する（取り込みの動作自体は変えない）。
$('#import-mode').addEventListener('change', (event) => {
  $('#import-replace-warning').classList.toggle('hidden', event.target.value !== 'replace');
});

$('#form-export').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#export-passphrase');
  try {
    const backup = await request(MSG.VAULT_EXPORT, { passphrase: input.value });
    downloadJson(backup, `lgpwmng-backup-${timestamp()}.json`);
    input.value = '';
    setStatus($('#export-status'), '暗号化バックアップを保存しました。', 'ok');
  } catch (error) {
    setStatus($('#export-status'), error.message, 'error');
  }
});

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
    state.draft = false;
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
