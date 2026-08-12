/**
 * ログイン画面設定ページ。
 * ページ上の入力欄候補と、登録するログイン項目を対応付ける。
 * 自動判定した候補名はあくまで初期値で、確定は利用者が行う。
 */

import { MSG, request } from '../lib/messages.js';
import {
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
import {
  createAccountAutosaveTrigger,
  createSaveQueue,
  renderAccountCards,
  renderSaveStatus,
  renderValueFields,
  snapshotService,
} from '../ui/account-editor.js';

const params = new URLSearchParams(location.search);
const state = {
  tabId: Number(params.get('tab')),
  url: params.get('url') || '',
  serviceId: params.get('service') || null,
  service: null,
  // アカウント以外（名前・URL・入力項目・共通値）の直前保存済みスナップショット。
  // null の間（＝まだ一度も保存していない新規サービス）はアカウントの変更も自動保存しない。
  persisted: null,
  candidates: [],
  rows: [],
};

const saveQueue = createSaveQueue();

function renderAccountSaveStatus(status, error) {
  renderSaveStatus($('#account-save-status'), status, { error, onRetry: () => triggerAccountAutosave() });
}

const triggerAccountAutosave = createAccountAutosaveTrigger({
  getService: () => state.service,
  getPersistedBase: () => state.persisted,
  setPersistedBase: (base) => { state.persisted = base; },
  saveQueue,
  sendSave: (payload) => request(MSG.SERVICE_SAVE, { service: payload }),
  onStatus: renderAccountSaveStatus,
});

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
  $('#rule-note').classList.toggle('hidden', !isExisting);

  const suggested = suggestRuleFromUrl(state.url);
  $('#rule-origin').value = suggested.origin;
  $('#rule-origin-mode').value = suggested.originMode;
  $('#rule-pathname').value = suggested.pathname;
  $('#rule-pathname-mode').value = suggested.pathnameMode;

  if (isExisting) {
    const result = await request(MSG.SERVICE_GET, { serviceId: state.serviceId });
    state.service = result.service;
    // 既に保存済みのサービスなので、この時点からアカウントの変更は自動保存する。
    state.persisted = snapshotService(state.service);
  } else {
    // 新規サービスも下書きとして最初から用意し、この画面だけで
    // 入力項目・アカウントまで一気通貫で設定できるようにする。
    // ただしまだ一度も保存していないため、アカウントの変更もこの時点では自動保存しない。
    const location = parseUrl(state.url);
    state.service = createService(location ? location.hostname : '');
    state.service.accounts = [createAccount({ name: '標準ユーザー' })];
    state.persisted = null;
  }
  renderAccountSaveStatus(null);
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
  if (!state.serviceId && scan && scan.title && !$('#service-name').value) {
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

  if (state.serviceId) {
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

  const record = {
    tr,
    fieldId: init.fieldId || null,
    locator: init.locator || null,
    useInput,
    labelInput,
    scopeSelect,
    kindSelect,
    candidateSelect,
  };

  // 区分（共通 / アカウント）の変更時は、既に入力済みの値を新しい区分側へ引き継ぐ。
  // select 要素は change より先に input が発火するため、renderValues（下の汎用リスナー）が
  // 区分を書き換えてしまう前に、ここで引き継ぎを済ませておく。
  scopeSelect.addEventListener('input', () => {
    const field = record.fieldId && state.service.fields.find((entry) => entry.id === record.fieldId);
    if (field) changeFieldScope(state.service, field, scopeSelect.value);
  });

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

/**
 * 「使用」がオンで表示名のある行から、下書きの項目一覧を組み立てる。
 * 項目 ID は行ごとに一度決めたら変えない（値がアカウント / 共通値へ正しく紐付き続けるため）。
 */
function currentFields() {
  const fields = [];
  for (const row of state.rows) {
    if (!row.useInput.checked) continue;
    const label = row.labelInput.value.trim();
    if (!label) continue;
    const locator = resolveLocator(row) || row.locator || {};
    const field = createField({ label, scope: row.scopeSelect.value, kind: row.kindSelect.value, locator });
    if (row.fieldId) field.id = row.fieldId;
    else row.fieldId = field.id;
    fields.push(field);
  }
  return fields;
}

/** 入力項目テーブルの内容をサービスへ反映し、共通値 / アカウント欄を再描画する。 */
function renderValues() {
  const fields = currentFields();
  state.service.fields = fields;
  const sharedFields = fields.filter((field) => field.scope === FIELD_SCOPE.SHARED);
  const accountFields = fields.filter((field) => field.scope === FIELD_SCOPE.ACCOUNT);
  renderValueFields($('#shared-values'), sharedFields, state.service.sharedValues);
  $('#shared-empty').classList.toggle('hidden', sharedFields.length > 0);
  renderAccountCards($('#account-list'), state.service.accounts, accountFields, {
    onChange: triggerAccountAutosave,
    onRemove: triggerAccountAutosave,
  });
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

  const fields = [];
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
    const field = createField({ label, scope: row.scopeSelect.value, kind: row.kindSelect.value, locator });
    // 保存済みの項目は ID を保つ。ID が変わると登録済みの値が引き継がれない。
    if (row.fieldId) field.id = row.fieldId;
    else row.fieldId = field.id;
    fields.push(field);
  }

  if (!fields.length) {
    setStatus($('#save-status'), '使用する項目を 1 つ以上選択してください。', 'error');
    return;
  }

  state.service.name = name;
  state.service.note = $('#service-note').value.trim();
  state.service.fields = fields;
  if (needsRule(state.service.matchRules, rule)) state.service.matchRules = state.service.matchRules.concat(rule);

  // クリックした時点の内容で固定する。キュー内の先行する自動保存を待つ間に
  // さらに編集されても、保存対象がその分だけ変わってしまわないようにするため。
  const snapshot = snapshotService(state.service);
  try {
    // アカウントの自動保存と同じキューを通し、古い保存処理と新しい保存処理が
    // 前後することなく順番に実行されるようにする。
    await saveQueue.enqueue(async () => {
      const result = await request(MSG.SERVICE_SAVE, { service: snapshot });
      state.serviceId = result.serviceId;
      const fresh = await request(MSG.SERVICE_GET, { serviceId: result.serviceId });
      state.service = fresh.service;
      state.persisted = snapshotService(state.service);
    });
    $('#rule-note').classList.remove('hidden');
    renderValues();
    setStatus($('#save-status'), '保存しました。続けてアカウントを追加・編集できます。', 'ok');
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

$('#btn-add-account').addEventListener('click', () => {
  state.service.accounts.push(createAccount({ name: `アカウント${state.service.accounts.length + 1}` }));
  renderValues();
  triggerAccountAutosave();
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
