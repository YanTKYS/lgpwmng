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
import { ruleMatches, suggestRuleFromUrl } from '../lib/match.js';
import { parseHttpUrl } from '../lib/url.js';
import { describeFrameDescriptor, frameDescriptorKey } from '../lib/frame.js';
import { matchCapturedValues } from '../lib/capture.js';
import { $, clear, el, fromTemplate, setStatus } from '../ui/dom.js';
import {
  createAccountAutosaveTrigger,
  createSaveQueue,
  nextAccountName,
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
  // ログイン画面から取得した現在値（capture の結果）。保存はせず、この画面の
  // メモリ上でだけ下書きの初期値として扱う。新規サービスの設定を開始したときだけ
  // 取得する（loadScan 完了後、値は state.candidates と対応付けた state.capturedValues
  // に変換して使う。setCandidates() が呼ばれるたびに、その時点の candidates に合わせて
  // 組み直す）。
  capturedEntries: [],
  capturedValues: [],
  // capture はログイン中の一人分なので、このアカウント以外には決して展開しない。
  initialCaptureAccountId: null,
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
  // 読み込みに失敗しても「ロックされています」とは表示しない
  // （サービスが見つからない等、アンロックしても解決しない原因があるため）。
  try {
    await loadService();
    const scan = await loadScan();
    if (!state.serviceId) {
      // 新規サービスのときだけ、この画面を開いた操作（「このログイン画面を設定」）
      // 自体を、ページの内容を初期値として使ってよい明示的な利用者操作とみなす。
      // 既存サービスの編集では取得しない（既存の登録値を無確認で置き換えないため）。
      state.service.name = defaultServiceName(scan);
      $('#service-name').value = state.service.name;
      await captureInitialValues();
    }
    renderRows();
  } catch (error) {
    setStatus($('#save-status'), error.message, 'error');
  }
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
    // サービス名は走査結果（ページタイトル）を見てから決めるため、ここでは空のままにする。
    state.service = createService('');
    state.service.accounts = [createAccount({ name: '標準ユーザー' })];
    state.initialCaptureAccountId = state.service.accounts[0].id;
    state.persisted = null;
  }
  renderAccountSaveStatus(null);
  $('#service-name').value = state.service.name;
  $('#service-note').value = state.service.note || '';
}

/** @returns {Promise<object|null>} 走査結果。取得できなければ null。 */
async function loadScan() {
  let scan = await request(MSG.SCAN_RESULT_GET, { tabId: state.tabId });
  if (!scan) {
    try {
      scan = await request(MSG.PAGE_SCAN, { tabId: state.tabId });
    } catch {
      scan = null;
    }
  }
  setCandidates(scan);
  return scan;
}

/**
 * 新規サービスの既定名。ページタイトルの方が業務システム名に近いため優先し、
 * タイトルを取得できない場合はホスト名を使う（どちらも利用者が上書きできる初期値）。
 */
function defaultServiceName(scan) {
  const title = scan && typeof scan.title === 'string' ? scan.title.trim() : '';
  if (title) return title.slice(0, 60);
  const pageUrl = parseHttpUrl(state.url);
  return pageUrl ? pageUrl.hostname : '';
}

/**
 * ログイン画面に入力済みの値を 1 回だけ取得する。
 *
 * scan（入力欄の構造）とは別のメッセージ（capture）で取得し、結果はどこにも
 * 保存せずこの画面のメモリ上（state.capturedEntries）にだけ置く。再スキャンでは
 * 呼び直さない（構造の更新と値の取得を分けるため）。
 *
 * 取得に失敗しても登録自体は継続できるよう、例外にはしない
 * （scan にさえ成功していれば、値は手入力で設定できる）。
 */
async function captureInitialValues() {
  try {
    const result = await request(MSG.PAGE_CAPTURE, { tabId: state.tabId });
    state.capturedEntries = result && Array.isArray(result.values) ? result.values : [];
  } catch {
    state.capturedEntries = [];
  }
  state.capturedValues = matchCapturedValues(state.candidates, state.capturedEntries);
  if (state.capturedValues.some((value) => value !== '')) {
    setStatus($('#save-status'), '入力済みの値を取り込みました。内容を確認してください。', 'ok');
  }
}

/**
 * 「候補が見つからない」旨の表示。全フレームを走査したうえで本当に 0 件の場合と、
 * 一部のフレームにアクセスできなかった場合とを区別する。内部の frameId や
 * 例外の内容はそのまま表示しない。
 */
function updateScanStatusMessage(scan) {
  const node = $('#no-candidates');
  const partial = Boolean(scan && scan.partial);
  const hasCandidates = state.candidates.length > 0;

  if (!hasCandidates) {
    node.textContent = partial
      ? '一部のフレームを確認できなかったため、入力欄の候補を取得できませんでした。ログイン画面を開いた状態で拡張アイコンから開き直してください。'
      : '入力欄の候補が取得できませんでした。ログイン画面を開いた状態で拡張アイコンから開き直してください。';
    node.classList.remove('hidden');
    return;
  }
  if (partial) {
    node.textContent = '一部のフレームを確認できませんでした。見つからない入力欄がある場合は、ログイン画面を開いた状態で拡張アイコンから開き直してください。';
    node.classList.remove('hidden');
    return;
  }
  node.classList.add('hidden');
}

/**
 * 「対象入力欄」の選択肢（option 要素）の雛形。
 * 内容は全行で同じなので候補 1 件につき 1 回だけ組み立て、各行へは複製して渡す。
 * 行ごとに組み立て直すと、入力欄の多い画面で設定画面が固まる。
 */
let candidateOptions = null;

/**
 * 走査結果を取り込む。選択肢の雛形を作り直す必要があるため、
 * 候補一覧の差し替えは必ずここを通す。
 */
function setCandidates(scan) {
  state.candidates = scan && Array.isArray(scan.candidates) ? scan.candidates : [];
  // capturedEntries は取得済み（新規サービスの設定開始時に 1 回だけ）のものをそのまま使い、
  // candidates との対応付けだけを組み直す。再スキャンのたびに値を取得し直すことはしない。
  state.capturedValues = matchCapturedValues(state.candidates, state.capturedEntries);
  candidateOptions = null;
  updateScanStatusMessage(scan);
}

// --- 行の生成 ---------------------------------------------------------------

function candidateLabel(candidate) {
  const locator = candidate.locator;
  const name = locator.labelText || candidate.guessLabel || locator.placeholder || locator.ariaLabel;
  const attrs = [locator.tagName + (locator.type ? `[${locator.type}]` : '')];
  if (locator.elementId) attrs.push(`#${locator.elementId}`);
  if (locator.name) attrs.push(`name=${locator.name}`);
  const label = `${name ? name.slice(0, 30) : '(名称不明)'} — ${attrs.join(' ')}`;
  const frameHint = describeFrameDescriptor(candidate.frame);
  return frameHint ? `${label} [フレーム: ${frameHint}]` : label;
}

/**
 * 識別情報（locator）が一致する候補を探す。frame を指定した場合は、
 * 同じフレームの候補だけを対象にする（再スキャンで frameId が変わっても、
 * 別フレームの同名項目へ誤って対応付けないため）。
 *
 * 既に別の行へ割り当て済みの候補（usedIndexes）は対象から外す。同じ候補が
 * 複数の行に入ると、保存時に「同じ入力欄が複数の項目に割り当てられています」
 * となり、手作業で直すまで保存できなくなるため。
 *
 * @returns {number} 候補の位置。見つからなければ -1
 */
function matchCandidateIndex(locator, frame, usedIndexes) {
  const frameKey = frame ? frameDescriptorKey(frame) : null;
  const usable = (candidate, index) => !usedIndexes.has(index)
    && (!frameKey || frameDescriptorKey(candidate.frame) === frameKey);

  // id → name → CSS セレクタの順に、確実な手掛かりから探す。
  for (const hint of ['elementId', 'name', 'cssPath']) {
    if (!locator[hint]) continue;
    const index = state.candidates.findIndex(
      (candidate, position) => usable(candidate, position) && candidate.locator[hint] === locator[hint],
    );
    if (index >= 0) return index;
  }
  return -1;
}

function renderRows() {
  clear($('#field-rows'));
  state.rows = [];

  if (state.serviceId) {
    const usedIndexes = new Set();
    for (const field of state.service.fields) {
      const index = matchCandidateIndex(field.locator, field.frame, usedIndexes);
      if (index >= 0) usedIndexes.add(index);
      addRow({
        fieldId: field.id,
        label: field.label,
        scope: field.scope,
        kind: field.kind,
        candidateIndex: index,
        locator: field.locator,
        frame: field.frame,
        use: true,
      });
    }
    addRowsForUnusedCandidates(usedIndexes);
  } else {
    // 同じ推定名（例: ユーザーID）が異なるフレームに複数存在する場合、
    // どちらが本物のログインフォームか自動では決められない。この場合は
    // 両方を候補として見せるだけにとどめ、既定でチェックしない
    // （最終的な確定は利用者が行う）。
    const framesByLabel = new Map();
    for (const candidate of state.candidates) {
      if (!candidate.guessLabel) continue;
      const key = frameDescriptorKey(candidate.frame);
      if (!framesByLabel.has(candidate.guessLabel)) framesByLabel.set(candidate.guessLabel, new Set());
      framesByLabel.get(candidate.guessLabel).add(key);
    }
    state.candidates.forEach((candidate, index) => {
      const frameKeys = candidate.guessLabel ? framesByLabel.get(candidate.guessLabel) : null;
      const ambiguousAcrossFrames = Boolean(frameKeys && frameKeys.size > 1);
      addRow({
        label: candidate.guessLabel || candidate.locator.labelText || '',
        scope: defaultScope(candidate.guessLabel),
        kind: candidate.guessKind,
        candidateIndex: index,
        capturedValue: state.capturedValues[index] || '',
        frame: candidate.frame,
        use: Boolean(candidate.guessLabel) && !ambiguousAcrossFrames,
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
      capturedValue: state.capturedValues[index] || '',
      frame: candidate.frame,
      use: false,
    });
  });
}

/**
 * 再スキャンの結果を反映する。
 * 行は作り直さずに「対象入力欄」の選択肢だけを差し替えるため、
 * 入力途中の表示名・値や、手動で追加した項目がそのまま残る。
 *
 * frameId は再スキャンのたびに変わり得るため使わず、フレーム自身の URL（frame）で
 * 対応付けを保持する。
 *
 * @param {Array<object|null>} previousLocators 差し替え前に各行が指していた入力欄
 * @param {Array<object|null>} previousFrames 差し替え前に各行が指していたフレーム
 */
function applyRescan(previousLocators, previousFrames) {
  const usedIndexes = new Set();
  state.rows.forEach((row, position) => {
    const locator = previousLocators[position];
    const frame = previousFrames[position];
    const index = locator ? matchCandidateIndex(locator, frame, usedIndexes) : -1;
    if (index >= 0) usedIndexes.add(index);
    // 再スキャンで見失った入力欄は、識別情報を保持したまま「見つかりません」と表示する。
    if (locator && index < 0) {
      row.locator = locator;
      row.frame = frame;
    }
    // 候補の並びが変わるため、取り込み済みの値との対応も取り直す。
    if (!row.userEdited) row.capturedValue = index >= 0 ? (state.capturedValues[index] || '') : '';
    fillCandidateOptions(row.candidateSelect, index, index < 0 ? locator : null);
  });
  addRowsForUnusedCandidates(usedIndexes);
  renderValues();
}

function defaultScope(label) {
  return SHARED_BY_DEFAULT.includes(label) ? FIELD_SCOPE.SHARED : FIELD_SCOPE.ACCOUNT;
}

/** 「確認」（強調表示）が失敗したときの案内。理由ごとに次の操作が分かる言い方にする。 */
const HIGHLIGHT_FAILURES = {
  'frame-ambiguous': '対象のフレームを一つに絞り込めませんでした。',
  'frame-not-found': '対象のフレームが見つかりませんでした。再スキャンしてください。',
  'frame-error': 'ページのフレーム構成を確認できませんでした。ログイン画面を開き直してください。',
  default: '対象の入力欄がログイン画面上に見つかりませんでした。',
};

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
    frame: init.frame || null,
    // ログイン画面に入力済みだった値（capture の結果）。項目がまだ確定していない
    // 間はここに保持するだけで、確定した時点（collectFields）で値へ反映する。
    capturedValue: init.capturedValue || '',
    // 空欄化を含む input イベントで明示的に立てる。値の比較による推測はしない。
    userEdited: false,
    useInput,
    labelInput,
    scopeSelect,
    kindSelect,
    candidateSelect,
  };

  // 区分（共通 / アカウント）の変更時は、既に入力済みの値を新しい区分側へ引き継いでから
  // 描画し直す。引き継ぎには変更前の区分が要るため、renderValues より先に行う。
  scopeSelect.addEventListener('change', () => {
    const field = findField(record);
    if (field) {
      changeFieldScope(state.service, field, scopeSelect.value);
      keepCapturedValueInInitialAccount(field, record);
    }
    renderValues();
  });

  // 対象入力欄の切り替え時は、新しい候補の現在値を反映する。ただし、利用者が
  // 既に値を手入力していれば（＝前回自動反映した値と現在の値が異なれば）上書きしない。
  // 例えば「ユーザーID」行の対象を候補Aから候補Bへ変更した場合、候補Aの値を
  // そのまま引き継がず、候補Bの現在値（あれば）に差し替える。
  candidateSelect.addEventListener('change', () => {
    record.capturedValue = capturedValueForSelection(candidateSelect.value);
    const field = findField(record);
    if (field) applyCapturedValueToField(field, record);
    renderValues();
  });

  // 値の入力欄は、項目の内容が確定したとき（change）だけ作り直す。
  // 表示名のキー入力のたびに作り直すと、入力中のアカウント欄が毎回消えて作り直される。
  for (const node of [useInput, labelInput, kindSelect]) {
    node.addEventListener('change', renderValues);
  }

  tr.querySelector('.highlight').addEventListener('click', async () => {
    const locator = resolveLocator(record);
    if (!locator) {
      setStatus($('#save-status'), '対象入力欄が選択されていません。', 'error');
      return;
    }
    const frame = resolveFrame(record);
    try {
      const result = await request(MSG.PAGE_HIGHLIGHT, { tabId: state.tabId, locator, frame });
      if (result && result.ok) {
        setStatus($('#save-status'), '対象のログイン画面で該当欄を強調表示しました。', 'ok');
      } else {
        const reason = result ? result.reason : '';
        setStatus($('#save-status'), HIGHLIGHT_FAILURES[reason] || HIGHLIGHT_FAILURES.default, 'error');
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

function candidateOptionsFor(select) {
  if (!candidateOptions) {
    candidateOptions = document.createDocumentFragment();
    candidateOptions.append(el('option', { text: '（未選択）', attrs: { value: '' } }));
    state.candidates.forEach((candidate, index) => {
      candidateOptions.append(el('option', { text: candidateLabel(candidate), attrs: { value: String(index) } }));
    });
  }
  select.append(candidateOptions.cloneNode(true));
}

/**
 * 「対象入力欄」の選択肢を組み立てる。
 * 候補に無い入力欄（既存項目・再スキャンで見失った項目）は「keep」として選べるようにする。
 */
function fillCandidateOptions(select, candidateIndex, keptLocator) {
  clear(select);
  candidateOptionsFor(select);

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

/** 選択中の候補が属するフレーム記述子。resolveLocator と対で使う。 */
function resolveFrame(record) {
  const value = record.candidateSelect.value;
  if (value === 'keep') return record.frame || null;
  if (value === '') return null;
  const candidate = state.candidates[Number(value)];
  return candidate ? candidate.frame : null;
}

/** 「対象入力欄」の選択値に対応する取得済みの現在値。候補を指していない場合は空文字。 */
function capturedValueForSelection(value) {
  if (value === '' || value === 'keep') return '';
  const index = Number(value);
  return Number.isInteger(index) ? (state.capturedValues[index] || '') : '';
}

/**
 * 取り込んだ値を反映してよい状態か。
 *
 * capture は新規サービスの下書きに対してだけ行うため、一度でも保存した後
 * （既存サービスの編集を含む）は反映しない。ここで区別しないと、既存サービスで
 * 「対象入力欄」を選び直しただけで、登録済みの共通値が消えてしまう。
 */
function isCaptureDraft() {
  return state.persisted === null;
}

/**
 * capturedValue を項目の値（共通値 / 各アカウントの値）へ反映する。
 *
 * 利用者が一度でも編集した行は（空欄にした場合も）上書きしない。アカウント項目は
 * 設定開始時の標準ユーザーだけが対象で、後から追加したアカウントへ複製しない。
 */
function applyCapturedValueToField(field, row) {
  if (!isCaptureDraft() || row.userEdited) return;
  const targets = field.scope === FIELD_SCOPE.SHARED
    ? [state.service.sharedValues]
    : state.service.accounts
      .filter((account) => account.id === state.initialCaptureAccountId)
      .map((account) => account.values);
  for (const values of targets) {
    if (row.capturedValue) values[field.id] = row.capturedValue;
    else delete values[field.id];
  }
}

/** capture 由来の未編集値を shared から account へ移した場合も複製を防ぐ。 */
function keepCapturedValueInInitialAccount(field, row) {
  if (!isCaptureDraft() || row.userEdited) return;
  if (!row.capturedValue || field.scope !== FIELD_SCOPE.ACCOUNT) return;
  for (const account of state.service.accounts) {
    if (account.id !== state.initialCaptureAccountId && account.values[field.id] === row.capturedValue) {
      delete account.values[field.id];
    }
  }
}

function markFieldUserEdited(field) {
  const row = state.rows.find((entry) => entry.fieldId === field.id);
  if (row) row.userEdited = true;
}

/** 行に対応する、確定済みの項目。まだ確定していない行では null。 */
function findField(row) {
  if (!row.fieldId) return null;
  return state.service.fields.find((field) => field.id === row.fieldId) || null;
}

// --- 値の入力欄 -------------------------------------------------------------

/**
 * 「使用」がオンの行から項目一覧を組み立てる。
 * 項目 ID は行ごとに一度決めたら変えない（値がアカウント / 共通値へ正しく紐付き続けるため）。
 *
 * 保存時（strict）は、表示名や対象入力欄の未入力・重複をエラーにする。
 * 画面の描画時（strict でない）は、設定の途中でも作業を続けられるよう、
 * まだ埋まっていない行を黙って飛ばす。
 *
 * @param {{strict: boolean}} options
 * @returns {{fields: Array, error: string}} error が空文字でなければ内容に問題がある
 */
function collectFields({ strict }) {
  const fields = [];
  const usedCandidates = new Set();
  for (const row of state.rows) {
    if (!row.useInput.checked) continue;
    const label = row.labelInput.value.trim();
    if (!label) {
      if (strict) return { fields, error: '使用する項目には表示名が必要です。' };
      continue;
    }
    const selected = resolveLocator(row);
    if (!selected && strict) {
      return { fields, error: `「${label}」の対象入力欄を選択してください。` };
    }
    const key = row.candidateSelect.value;
    if (strict && key !== 'keep') {
      if (usedCandidates.has(key)) {
        return { fields, error: '同じ入力欄が複数の項目に割り当てられています。' };
      }
      usedCandidates.add(key);
    }
    const field = createField({
      label,
      scope: row.scopeSelect.value,
      kind: row.kindSelect.value,
      // 対象入力欄が未選択の行も、区分・種別だけは値の入力欄の描画に使う。
      locator: selected || row.locator || {},
      frame: resolveFrame(row) || row.frame,
    });
    // 保存済みの項目は ID を保つ。ID が変わると登録済みの値が引き継がれない。
    if (row.fieldId) {
      field.id = row.fieldId;
    } else {
      row.fieldId = field.id;
      // 項目を初めて確定した時点で、ログイン画面に入力済みだった値を下書きへ反映する。
      applyCapturedValueToField(field, row);
    }
    fields.push(field);
  }
  return { fields, error: '' };
}

/**
 * 入力項目テーブルの内容をサービスへ反映し、共通値 / アカウント欄を再描画する。
 * サービスを読み込めていない間（読み込みに失敗した場合）は何もしない。
 */
function renderValues() {
  if (!state.service) return;
  const { fields } = collectFields({ strict: false });
  state.service.fields = fields;
  const sharedFields = fields.filter((field) => field.scope === FIELD_SCOPE.SHARED);
  const accountFields = fields.filter((field) => field.scope === FIELD_SCOPE.ACCOUNT);
  renderValueFields($('#shared-values'), sharedFields, state.service.sharedValues, { onEdit: markFieldUserEdited });
  $('#shared-empty').classList.toggle('hidden', sharedFields.length > 0);
  renderAccountCards($('#account-list'), state.service.accounts, accountFields, {
    onChange: triggerAccountAutosave,
    onRemove: triggerAccountAutosave,
    onEdit: markFieldUserEdited,
  });
}

// --- 保存 -------------------------------------------------------------------

/** 画面の入力内容から URL 条件を作る。整えた結果は画面へも反映する。 */
function buildRule() {
  const rule = createMatchRule({
    origin: $('#rule-origin').value.trim(),
    originMode: $('#rule-origin-mode').value,
    pathname: $('#rule-pathname').value,
    pathnameMode: $('#rule-pathname-mode').value,
  });
  // 解釈できなかったオリジンは、入力し直せるよう打った内容のまま残す。
  if (rule.origin) $('#rule-origin').value = rule.origin;
  $('#rule-pathname').value = rule.pathname;
  return rule;
}

async function save() {
  if (!state.service) {
    setStatus($('#save-status'), '設定を読み込めていません。ログイン画面を開いた状態で拡張アイコンから開き直してください。', 'error');
    return;
  }
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

  const { fields, error } = collectFields({ strict: true });
  if (error) {
    setStatus($('#save-status'), error, 'error');
    return;
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
  const url = parseHttpUrl(state.url);
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
  if (!state.service) return;
  const row = addRow({ use: true });
  row.labelInput.focus();
  renderValues();
});

$('#btn-add-account').addEventListener('click', () => {
  if (!state.service) return;
  state.service.accounts.push(createAccount({ name: nextAccountName(state.service.accounts) }));
  renderValues();
  triggerAccountAutosave();
});

$('#btn-rescan').addEventListener('click', async () => {
  try {
    const scan = await request(MSG.PAGE_SCAN, { tabId: state.tabId });
    // 候補を差し替える前に、各行が今どの入力欄・フレームを指しているかを控える。
    const previousLocators = state.rows.map((row) => resolveLocator(row));
    const previousFrames = state.rows.map((row) => resolveFrame(row));
    setCandidates(scan);
    applyRescan(previousLocators, previousFrames);
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
