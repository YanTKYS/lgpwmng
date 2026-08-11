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

async function showMain() {
  showView('main');
  const location = parseUrl(state.url);
  $('#page-location').textContent = location ? `${location.hostname}${location.pathname}` : '（対応していないページ）';
  $('#btn-setup').disabled = !location || state.tabId === null;

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
      const resolved = parseUrl(state.url);
      if (resolved) $('#page-location').textContent = `${resolved.hostname}${resolved.pathname}`;
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
  $('#btn-fill').disabled = !account || !confirmed || state.tabId === null;
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
  $('#service-name').textContent = service.name;
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

function renderFillResult(result) {
  const list = $('#fill-result');
  clear(list);
  list.classList.remove('hidden');
  const filled = result.results.filter((entry) => entry.status.startsWith('filled')).length;
  const failed = result.results.filter((entry) => !entry.status.startsWith('filled'));
  setStatus(
    $('#fill-status'),
    failed.length
      ? `${filled}項目を入力（${failed.length}項目は入力できませんでした）`
      : `${filled}項目を入力しました。ログイン操作は手動で行ってください。`,
    failed.length ? 'error' : 'ok',
  );
  for (const entry of result.results) {
    const text = entry.status === 'filled' ? '入力しました'
      : entry.status === 'filled-weak' ? '入力しました（候補一致が弱いため要確認）'
        : entry.status === 'weak-skipped' ? '入力欄を特定できないため入力していません（設定を更新してください）'
          : entry.status === 'not-found' ? '入力欄が見つかりません'
            : '入力に失敗しました';
    list.append(el('li', {
      className: entry.status === 'filled' ? '' : 'warn',
      text: `${entry.label}: ${text}`,
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
