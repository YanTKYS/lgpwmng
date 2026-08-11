import { MSG, request } from '../lib/messages.js';
import { ACCOUNT_ROLE } from '../lib/model.js';
import { parseUrl } from '../lib/match.js';
import { $, clear, el, setStatus } from '../ui/dom.js';

const views = {
  init: $('#view-init'),
  unlock: $('#view-unlock'),
  main: $('#view-main'),
};

const state = {
  tabId: null,
  url: '',
  services: [],
  selectedServiceId: null,
  selectedAccountId: null,
};

function showView(name) {
  for (const [key, node] of Object.entries(views)) node.classList.toggle('hidden', key !== name);
}

async function boot() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab ? tab.id : null;
  state.url = tab && tab.url ? tab.url : '';

  const status = await request(MSG.VAULT_STATUS);
  if (!status.initialized) {
    showView('init');
    $('#init-password').focus();
    return;
  }
  if (!status.unlocked) {
    showView('unlock');
    $('#unlock-password').focus();
    return;
  }
  await showMain();
}

/**
 * 現在のページを画面へ表示する。
 * http と https は別サービスとして扱うため、プロトコル（とポート）を含めて表示する。
 */
function showPageLocation() {
  const url = parseUrl(state.url);
  $('#page-location').textContent = url ? `${url.origin}${url.pathname}` : '（対応していないページ）';
  return url;
}

async function showMain() {
  showView('main');
  const location = showPageLocation();
  $('#btn-setup').disabled = !location || !Number.isInteger(state.tabId);

  if (!location) {
    state.services = [];
    renderServices();
    return;
  }
  try {
    const result = await request(MSG.SERVICE_MATCH, { url: state.url, tabId: state.tabId });
    state.services = result.services;
    if (result.url) {
      // background 側で確定した URL を採用する。
      state.url = result.url;
      showPageLocation();
    }
    if (result.migratedCount) {
      setStatus($('#fill-status'), 'URL条件を現在のページに合わせて更新しました。', 'ok');
    }
  } catch (error) {
    state.services = [];
    setStatus($('#fill-status'), error.message, 'error');
  }
  renderServices();
}

function renderServices() {
  const hasServices = state.services.length > 0;
  $('#no-service').classList.toggle('hidden', hasServices);
  $('#account-block').classList.toggle('hidden', !hasServices);
  $('#service-switch').classList.toggle('hidden', state.services.length < 2);

  if (!hasServices) {
    $('#service-name').textContent = '未登録のログイン画面';
    $('#btn-fill').disabled = true;
    $('#btn-setup').textContent = 'このログイン画面を設定';
    return;
  }

  if (!state.services.some((service) => service.id === state.selectedServiceId)) {
    state.selectedServiceId = state.services[0].id;
  }

  const select = $('#service-select');
  clear(select);
  for (const service of state.services) {
    select.append(el('option', { text: service.name, attrs: { value: service.id } }));
  }
  select.value = state.selectedServiceId;

  const service = currentService();
  $('#service-name').textContent = service.name;
  $('#btn-setup').textContent = 'このログイン画面の設定を編集';
  renderAccounts(service);
}

function currentService() {
  return state.services.find((service) => service.id === state.selectedServiceId) || null;
}

function renderAccounts(service) {
  const list = $('#account-list');
  clear(list);
  state.selectedAccountId = null;

  if (!service.accounts.length) {
    list.append(el('div', { className: 'empty small', text: 'アカウントが登録されていません。' }));
    updateFillButton();
    return;
  }

  // 管理者アカウントは既定で選択しない（誤使用防止）。
  const defaultAccount = service.accounts.find((account) => account.role === ACCOUNT_ROLE.NORMAL);
  state.selectedAccountId = defaultAccount ? defaultAccount.id : null;

  for (const account of service.accounts) {
    const isAdmin = account.role === ACCOUNT_ROLE.ADMIN;
    const radio = el('input', {
      attrs: { type: 'radio', name: 'account', value: account.id },
      props: { checked: account.id === state.selectedAccountId },
      on: {
        change: () => {
          state.selectedAccountId = account.id;
          $('#admin-confirm-check').checked = false;
          clearFillResult();
          updateFillButton();
        },
      },
    });
    const label = el('label', { className: 'account-item' }, [
      radio,
      el('span', { className: 'name', text: account.name || '(名称未設定)' }),
      isAdmin ? el('span', { className: 'badge admin', text: '管理者' }) : null,
      el('span', { className: 'badge', text: `${account.filledFieldCount}項目` }),
    ]);
    list.append(label);
  }
  updateFillButton();
}

function selectedAccount() {
  const service = currentService();
  if (!service) return null;
  return service.accounts.find((account) => account.id === state.selectedAccountId) || null;
}

function updateFillButton() {
  const account = selectedAccount();
  const isAdmin = Boolean(account) && account.role === ACCOUNT_ROLE.ADMIN;
  $('#admin-confirm').classList.toggle('hidden', !isAdmin);
  const confirmed = !isAdmin || $('#admin-confirm-check').checked;
  $('#btn-fill').disabled = !account || !confirmed || !Number.isInteger(state.tabId);
}

/** 前回の入力結果の表示を消す。別のサービス / アカウントへ切り替えたときに呼ぶ。 */
function clearFillResult() {
  const list = $('#fill-result');
  clear(list);
  list.classList.add('hidden');
  setStatus($('#fill-status'), '');
}

// --- イベント ---------------------------------------------------------------

$('#form-init').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = $('#init-password').value;
  const confirmValue = $('#init-password-confirm').value;
  if (password !== confirmValue) {
    setStatus($('#init-status'), 'パスワードが一致しません。', 'error');
    return;
  }
  try {
    await request(MSG.VAULT_CREATE, { password });
    $('#init-password').value = '';
    $('#init-password-confirm').value = '';
    await showMain();
  } catch (error) {
    setStatus($('#init-status'), error.message, 'error');
  }
});

$('#form-unlock').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#unlock-password');
  try {
    await request(MSG.VAULT_UNLOCK, { password: input.value });
    input.value = '';
    setStatus($('#unlock-status'), '');
    await showMain();
  } catch (error) {
    input.value = '';
    setStatus($('#unlock-status'), error.message, 'error');
  }
});

$('#service-select').addEventListener('change', (event) => {
  state.selectedServiceId = event.target.value;
  const service = currentService();
  if (!service) return;
  $('#service-name').textContent = service.name;
  $('#admin-confirm-check').checked = false;
  clearFillResult();
  renderAccounts(service);
});

$('#admin-confirm-check').addEventListener('change', updateFillButton);

$('#btn-fill').addEventListener('click', async () => {
  const service = currentService();
  const account = selectedAccount();
  if (!service || !account) return;
  const button = $('#btn-fill');
  button.disabled = true;
  setStatus($('#fill-status'), '入力しています…');
  try {
    const result = await request(MSG.FILL_RUN, {
      tabId: state.tabId,
      serviceId: service.id,
      accountId: account.id,
      confirmAdmin: account.role === ACCOUNT_ROLE.ADMIN ? $('#admin-confirm-check').checked : false,
    });
    renderFillResult(result);
  } catch (error) {
    setStatus($('#fill-status'), error.message, 'error');
  } finally {
    updateFillButton();
  }
});

const RESULT_TEXTS = {
  filled: '入力しました',
  'filled-weak': '入力しました（候補一致が弱いため要確認）',
  'weak-skipped': '入力欄を特定できないため入力していません（設定を更新してください）',
  'not-found': '入力欄が見つかりません',
  error: '入力に失敗しました',
};

function renderFillResult(result) {
  const list = $('#fill-result');
  clear(list);
  list.classList.remove('hidden');

  const filled = result.results.filter((entry) => entry.status.startsWith('filled'));
  const weak = filled.filter((entry) => entry.status === 'filled-weak').length;
  const failed = result.results.length - filled.length;

  if (failed) {
    setStatus($('#fill-status'), `${filled.length}項目を入力（${failed}項目は入力できませんでした）`, 'error');
  } else if (weak) {
    // 入力はできたが、入力先が確実ではない項目がある。緑色にはせず確認を促す。
    setStatus($('#fill-status'), `${filled.length}項目を入力しました（うち${weak}項目は入力先の確認が必要です）。`);
  } else {
    setStatus($('#fill-status'), `${filled.length}項目を入力しました。ログイン操作は手動で行ってください。`, 'ok');
  }

  for (const entry of result.results) {
    list.append(el('li', {
      className: entry.status === 'filled' ? '' : 'warn',
      text: `${entry.label}: ${RESULT_TEXTS[entry.status] || RESULT_TEXTS.error}`,
    }));
  }
}

$('#btn-setup').addEventListener('click', async () => {
  setStatus($('#fill-status'), 'ページを解析しています…');
  try {
    await request(MSG.PAGE_SCAN, { tabId: state.tabId });
    const params = new URLSearchParams({ tab: String(state.tabId), url: state.url });
    const service = currentService();
    if (service) params.set('service', service.id);
    await chrome.tabs.create({ url: chrome.runtime.getURL(`src/setup/setup.html?${params.toString()}`) });
    window.close();
  } catch (error) {
    setStatus($('#fill-status'), error.message, 'error');
  }
});

$('#btn-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('#btn-lock').addEventListener('click', async () => {
  await request(MSG.VAULT_LOCK);
  showView('unlock');
  $('#unlock-password').focus();
});

boot().catch((error) => {
  showView('unlock');
  setStatus($('#unlock-status'), error.message, 'error');
});
