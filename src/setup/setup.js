/**
 * ログイン画面設定ページ。
 * ページ上の入力欄候補と、登録するログイン項目を対応付ける。
 * 自動判定した候補名はあくまで初期値で、確定は利用者が行う。
 */

import { MSG, request } from '../lib/messages.js';
import {
  ACCOUNT_ROLE,
  FIELD_KIND,
  FIELD_SCOPE,
  changeFieldScope,
  createAccount,
  createField,
  createMatchRule,
  createService,
} from '../lib/model.js';
import { parseUrl, ruleMatches, suggestRuleFromUrl } from '../lib/match.js';
import { $, clear, el, fromTemplate, setStatus } from '../ui/dom.js';

const params = new URLSearchParams(location.search);
const state = {
  tabId: Number(params.get('tab')),
  url: params.get('url') || '',
  serviceId: params.get('service') || null,
  service: null,
  candidates: [],
  rows: [],
};

const SHARED_BY_DEFAULT = ['自治体コード', '所属コード'];

$('#page-url').textContent = state.url;

async function boot() {
  const status = await request(MSG.VAULT_STATUS);
  if (!status.initialized) {
    $('#locked').classList.remove('hidden');
    setStatus($('#unlock-status'), 'マスターパスワードが未設定です。拡張アイコンから設定してください。', 'error');
    return;
  }
  if (!status.unlocked) {
    $('#locked').classList.remove('hidden');
    $('#unlock-password').focus();
    return;
  }
  $('#locked').classList.add('hidden');
  $('#main').classList.remove('hidden');
  await loadService();
  await loadScan();
  renderRows();
}

async function loadService() {
  const isExisting = Boolean(state.serviceId);
  $('#values-block').classList.toggle('hidden', isExisting);
  $('#existing-note-block').classList.toggle('hidden', !isExisting);
  $('#rule-note').classList.toggle('hidden', !isExisting);

  const suggested = suggestRuleFromUrl(state.url);
  $('#rule-origin').value = suggested.origin;
  $('#rule-origin-mode').value = suggested.originMode;
  $('#rule-pathname').value = suggested.pathname;
  $('#rule-pathname-mode').value = suggested.pathnameMode;

  if (!isExisting) {
    const location = parseUrl(state.url);
    $('#service-name').value = location ? location.hostname : '';
    $('#account-name').value = '標準ユーザー';
    return;
  }
  const result = await request(MSG.SERVICE_GET, { serviceId: state.serviceId });
  state.service = result.service;
  $('#service-name').value = state.service.name;
  $('#service-note').value = state.service.note || '';
}

async function loadScan() {
  let scan = await request(MSG.SCAN_RESULT_GET, { tabId: state.tabId });
  if (!scan) {
    try {
      scan = await request(MSG.PAGE_SCAN, { tabId: state.tabId });
    } catch {
      scan = null;
    }
  }
  state.candidates = scan && Array.isArray(scan.candidates) ? scan.candidates : [];
  $('#no-candidates').classList.toggle('hidden', state.candidates.length > 0);
  if (!state.service && scan && scan.title && !$('#service-name').value) {
    $('#service-name').value = scan.title.slice(0, 60);
  }
}

// --- 行の生成 ---------------------------------------------------------------

function candidateLabel(candidate) {
  const locator = candidate.locator;
  const parts = [];
  const name = locator.labelText || candidate.guessLabel || locator.placeholder || locator.ariaLabel;
  parts.push(name ? name.slice(0, 30) : '(名称不明)');
  const attrs = [locator.tagName + (locator.type ? `[${locator.type}]` : '')];
  if (locator.elementId) attrs.push(`#${locator.elementId}`);
  if (locator.name) attrs.push(`name=${locator.name}`);
  return `${parts[0]} — ${attrs.join(' ')}`;
}

function matchCandidateIndex(locator) {
  const byId = state.candidates.findIndex(
    (candidate) => locator.elementId && candidate.locator.elementId === locator.elementId,
  );
  if (byId >= 0) return byId;
  const byName = state.candidates.findIndex(
    (candidate) => locator.name && candidate.locator.name === locator.name,
  );
  if (byName >= 0) return byName;
  return state.candidates.findIndex(
    (candidate) => locator.cssPath && candidate.locator.cssPath === locator.cssPath,
  );
}

function renderRows() {
  clear($('#field-rows'));
  state.rows = [];

  if (state.service) {
    const usedIndexes = new Set();
    for (const field of state.service.fields) {
      const index = matchCandidateIndex(field.locator);
      if (index >= 0) usedIndexes.add(index);
      addRow({
        fieldId: field.id,
        label: field.label,
        scope: field.scope,
        kind: field.kind,
        candidateIndex: index,
        locator: field.locator,
        use: true,
      });
    }
    addRowsForUnusedCandidates(usedIndexes);
  } else {
    state.candidates.forEach((candidate, index) => {
      addRow({
        label: candidate.guessLabel || candidate.locator.labelText || '',
        scope: defaultScope(candidate.guessLabel),
        kind: candidate.guessKind,
        candidateIndex: index,
        use: Boolean(candidate.guessLabel),
      });
    });
  }
  renderValues();
}

/** どの行にも割り当てられていない候補のうち、項目名を推定できたものを行として追加する。 */
function addRowsForUnusedCandidates(usedIndexes) {
  state.candidates.forEach((candidate, index) => {
    if (usedIndexes.has(index) || !candidate.guessLabel) return;
    addRow({
      label: candidate.guessLabel,
      scope: defaultScope(candidate.guessLabel),
      kind: candidate.guessKind,
      candidateIndex: index,
      use: false,
    });
  });
}

/**
 * 再スキャンの結果を反映する。
 * 行は作り直さずに「対象入力欄」の選択肢だけを差し替えるため、
 * 入力途中の表示名・値や、手動で追加した項目がそのまま残る。
 *
 * @param {Array<object|null>} previousLocators 差し替え前に各行が指していた入力欄
 */
function applyRescan(previousLocators) {
  const usedIndexes = new Set();
  state.rows.forEach((row, position) => {
    const locator = previousLocators[position];
    const index = locator ? matchCandidateIndex(locator) : -1;
    if (index >= 0) usedIndexes.add(index);
    // 再スキャンで見失った入力欄は、識別情報を保持したまま「見つかりません」と表示する。
    if (locator && index < 0) row.locator = locator;
    fillCandidateOptions(row.candidateSelect, index, index < 0 ? locator : null);
  });
  addRowsForUnusedCandidates(usedIndexes);
  renderValues();
}

function defaultScope(label) {
  return SHARED_BY_DEFAULT.includes(label) ? FIELD_SCOPE.SHARED : FIELD_SCOPE.ACCOUNT;
}

function addRow(init = {}) {
  const tr = fromTemplate('tpl-field-row');
  const useInput = tr.querySelector('.use');
  const labelInput = tr.querySelector('.label');
  const scopeSelect = tr.querySelector('.scope');
  const kindSelect = tr.querySelector('.kind');
  const candidateSelect = tr.querySelector('.candidate');

  useInput.checked = Boolean(init.use);
  labelInput.value = init.label || '';
  scopeSelect.value = init.scope || FIELD_SCOPE.ACCOUNT;
  kindSelect.value = init.kind === FIELD_KIND.SECRET ? FIELD_KIND.SECRET : FIELD_KIND.TEXT;

  fillCandidateOptions(candidateSelect, init.candidateIndex, init.locator);

  // 値の入力欄は行ごとに 1 つ作り、表示のたびに作り直さない（入力中の値が消えないように）。
  const valueInput = el('input', {
    className: 'value-input',
    attrs: { type: 'text', autocomplete: 'off' },
  });

  const record = {
    tr,
    fieldId: init.fieldId || null,
    locator: init.locator || null,
    useInput,
    labelInput,
    scopeSelect,
    kindSelect,
    candidateSelect,
    valueInput,
  };

  for (const node of [useInput, labelInput, scopeSelect, kindSelect]) {
    node.addEventListener('change', renderValues);
    node.addEventListener('input', renderValues);
  }

  tr.querySelector('.highlight').addEventListener('click', async () => {
    const locator = resolveLocator(record);
    if (!locator) {
      setStatus($('#save-status'), '対象入力欄が選択されていません。', 'error');
      return;
    }
    try {
      const result = await request(MSG.PAGE_HIGHLIGHT, { tabId: state.tabId, locator });
      if (result && result.ok) {
        setStatus($('#save-status'), '対象のログイン画面で該当欄を強調表示しました。', 'ok');
      } else {
        setStatus($('#save-status'), '対象の入力欄がログイン画面上に見つかりませんでした。', 'error');
      }
    } catch (error) {
      setStatus($('#save-status'), error.message, 'error');
    }
  });

  tr.querySelector('.remove').addEventListener('click', () => {
    state.rows = state.rows.filter((entry) => entry !== record);
    tr.remove();
    renderValues();
  });

  state.rows.push(record);
  $('#field-rows').append(tr);
  return record;
}

/**
 * 「対象入力欄」の選択肢を組み立てる。
 * 候補に無い入力欄（既存項目・再スキャンで見失った項目）は「keep」として選べるようにする。
 */
function fillCandidateOptions(select, candidateIndex, keptLocator) {
  clear(select);
  select.append(el('option', { text: '（未選択）', attrs: { value: '' } }));
  state.candidates.forEach((candidate, index) => {
    select.append(el('option', { text: candidateLabel(candidate), attrs: { value: String(index) } }));
  });

  if (Number.isInteger(candidateIndex) && candidateIndex >= 0) {
    select.value = String(candidateIndex);
    return;
  }
  if (!keptLocator) {
    select.value = '';
    return;
  }
  select.append(el('option', {
    text: `（現在のページに見つかりません）${keptLocator.elementId || keptLocator.name || ''}`,
    attrs: { value: 'keep' },
  }));
  select.value = 'keep';
}

function resolveLocator(record) {
  const value = record.candidateSelect.value;
  if (value === 'keep') return record.locator;
  if (value === '') return null;
  const candidate = state.candidates[Number(value)];
  return candidate ? candidate.locator : null;
}

// --- 値の入力欄 -------------------------------------------------------------

function renderValues() {
  if (state.service) return; // 既存サービスの値はサービス一覧側で編集する
  const shared = $('#shared-values');
  const account = $('#account-values');
  clear(shared);
  clear(account);
  let sharedCount = 0;

  for (const row of state.rows) {
    if (!row.useInput.checked) continue;
    const label = row.labelInput.value.trim();
    if (!label) continue;
    row.valueInput.type = row.kindSelect.value === FIELD_KIND.SECRET ? 'password' : 'text';
    const block = el('div', { className: 'value-row' }, [
      el('div', { className: 'field-label', text: label }),
      row.valueInput,
    ]);
    if (row.scopeSelect.value === FIELD_SCOPE.SHARED) {
      shared.append(block);
      sharedCount += 1;
    } else {
      account.append(block);
    }
  }
  $('#shared-empty').classList.toggle('hidden', sharedCount > 0);
}

// --- 保存 -------------------------------------------------------------------

function buildRule() {
  return createMatchRule({
    origin: $('#rule-origin').value.trim(),
    originMode: $('#rule-origin-mode').value,
    pathname: $('#rule-pathname').value.trim() || '/',
    pathnameMode: $('#rule-pathname-mode').value,
  });
}

async function save() {
  const name = $('#service-name').value.trim();
  if (!name) {
    setStatus($('#save-status'), 'サービス名を入力してください。', 'error');
    return;
  }
  const rule = buildRule();
  if (!rule.origin) {
    setStatus($('#save-status'), 'オリジンを「https://ホスト名」の形式で入力してください。', 'error');
    return;
  }

  // 保存する項目と、それを入力した行の対応。保存後に項目 ID を行へ書き戻すために持つ。
  const saved = [];
  const sharedValues = {};
  const accountValues = {};
  const usedCandidates = new Set();

  for (const row of state.rows) {
    if (!row.useInput.checked) continue;
    const label = row.labelInput.value.trim();
    if (!label) {
      setStatus($('#save-status'), '使用する項目には表示名が必要です。', 'error');
      return;
    }
    const locator = resolveLocator(row);
    if (!locator) {
      setStatus($('#save-status'), `「${label}」の対象入力欄を選択してください。`, 'error');
      return;
    }
    const key = row.candidateSelect.value;
    if (key !== 'keep') {
      if (usedCandidates.has(key)) {
        setStatus($('#save-status'), '同じ入力欄が複数の項目に割り当てられています。', 'error');
        return;
      }
      usedCandidates.add(key);
    }
    const field = createField({
      label,
      scope: row.scopeSelect.value,
      kind: row.kindSelect.value,
      locator,
    });
    // 保存済みの項目は ID を保つ。ID が変わると登録済みの値が引き継がれない。
    if (row.fieldId) field.id = row.fieldId;
    saved.push({ row, field });

    const value = row.valueInput.value;
    if (!state.service && value) {
      if (field.scope === FIELD_SCOPE.SHARED) sharedValues[field.id] = value;
      else accountValues[field.id] = value;
    }
  }

  if (!saved.length) {
    setStatus($('#save-status'), '使用する項目を 1 つ以上選択してください。', 'error');
    return;
  }
  const fields = saved.map((entry) => entry.field);

  let service;
  if (state.service) {
    // 区分（共通 / アカウント）を変えた項目は、登録済みの値を新しい区分側へ移す。
    for (const { row, field } of saved) {
      const original = state.service.fields.find((entry) => entry.id === field.id);
      if (original) changeFieldScope(state.service, original, row.scopeSelect.value);
    }
    service = { ...state.service, name, note: $('#service-note').value.trim(), fields };
    if (needsRule(service.matchRules, rule)) service.matchRules = service.matchRules.concat(rule);
  } else {
    service = createService(name);
    service.note = $('#service-note').value.trim();
    service.matchRules = [rule];
    service.fields = fields;
    service.sharedValues = sharedValues;
    service.accounts = [createAccount({
      name: $('#account-name').value.trim() || '既定アカウント',
      role: $('#account-role').value === ACCOUNT_ROLE.ADMIN ? ACCOUNT_ROLE.ADMIN : ACCOUNT_ROLE.NORMAL,
      values: accountValues,
    })];
  }

  try {
    const result = await request(MSG.SERVICE_SAVE, { service });
    state.serviceId = result.serviceId;
    const fresh = await request(MSG.SERVICE_GET, { serviceId: result.serviceId });
    state.service = fresh.service;
    // 続けて保存し直しても同じ項目として扱われるよう、保存した項目 ID を行へ戻す。
    for (const { row, field } of saved) row.fieldId = field.id;
    // 保存後は画面上に認証情報を残さない。
    for (const row of state.rows) row.valueInput.value = '';
    $('#values-block').classList.add('hidden');
    $('#existing-note-block').classList.remove('hidden');
    setStatus($('#save-status'), '保存しました。ログイン画面で拡張アイコンから入力できます。', 'ok');
  } catch (error) {
    setStatus($('#save-status'), error.message, 'error');
  }
}

/**
 * URL 条件を追加する必要があるか。
 *
 * 条件欄は現在のページの URL で初期表示される。利用者が触っていなければ、
 * 既存条件が現在のページに一致する時点で条件は足さなくてよい。
 * 利用者が条件欄を書き換えた場合は、同じ条件が無い限り追加する。
 */
function needsRule(existingRules, rule) {
  const url = parseUrl(state.url);
  const asSuggested = sameTarget(rule, suggestRuleFromUrl(state.url));
  return !existingRules.some((existing) => sameTarget(existing, rule)
    || (asSuggested && url && ruleMatches(existing, url)));
}

function sameTarget(a, b) {
  return a.origin === b.origin
    && a.originMode === b.originMode
    && a.pathname === b.pathname
    && a.pathnameMode === b.pathnameMode;
}

// --- イベント ---------------------------------------------------------------

$('#form-unlock').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#unlock-password');
  try {
    await request(MSG.VAULT_UNLOCK, { password: input.value });
    input.value = '';
    await boot();
  } catch (error) {
    input.value = '';
    setStatus($('#unlock-status'), error.message, 'error');
  }
});

$('#btn-add-field').addEventListener('click', () => {
  const row = addRow({ use: true });
  row.labelInput.focus();
  renderValues();
});

$('#btn-rescan').addEventListener('click', async () => {
  try {
    const scan = await request(MSG.PAGE_SCAN, { tabId: state.tabId });
    // 候補を差し替える前に、各行が今どの入力欄を指しているかを控える。
    const previousLocators = state.rows.map((row) => resolveLocator(row));
    state.candidates = Array.isArray(scan.candidates) ? scan.candidates : [];
    $('#no-candidates').classList.toggle('hidden', state.candidates.length > 0);
    applyRescan(previousLocators);
    setStatus($('#save-status'), 'ページを再スキャンしました。', 'ok');
  } catch (error) {
    setStatus($('#save-status'), error.message, 'error');
  }
});

// 保存中はボタンを止める。二度押しでサービスが二重に登録されるのを防ぐ。
$('#btn-save').addEventListener('click', async () => {
  const button = $('#btn-save');
  button.disabled = true;
  try {
    await save();
  } finally {
    button.disabled = false;
  }
});
$('#btn-open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

boot().catch((error) => {
  $('#locked').classList.remove('hidden');
  setStatus($('#unlock-status'), error.message, 'error');
});
