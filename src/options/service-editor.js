/**
 * サービス編集画面。Vault から取得したサービス 1 件を直接編集する。
 */

import { MSG, request } from '../lib/messages.js';
import {
  FIELD_KIND,
  FIELD_SCOPE,
  ORIGIN_MODE,
  PATHNAME_MODE,
  changeFieldScope,
  createAccount,
  createField,
  createMatchRule,
  createService,
  isPendingRule,
  normalizeOrigin,
} from '../lib/model.js';
import { $, clear, el, setStatus } from '../ui/dom.js';
import {
  createAccountAutosaveTrigger,
  createSaveQueue,
  renderAccountCards,
  renderSaveStatus,
  renderValueFields,
  select,
  snapshotServiceExceptAccounts,
  textInput,
} from '../ui/account-editor.js';

const ORIGIN_MODE_LABELS = [
  [ORIGIN_MODE.EXACT, '完全一致'],
  [ORIGIN_MODE.SUFFIX, 'サブドメイン含む'],
];
const PATHNAME_MODE_LABELS = [
  [PATHNAME_MODE.EXACT, '完全一致'],
  [PATHNAME_MODE.PREFIX, '前方一致'],
  [PATHNAME_MODE.ANY, 'パス問わず'],
];
const SCOPE_LABELS = [
  [FIELD_SCOPE.ACCOUNT, 'アカウント'],
  [FIELD_SCOPE.SHARED, '共通'],
];
const KIND_LABELS = [
  [FIELD_KIND.TEXT, '通常'],
  [FIELD_KIND.SECRET, '秘密'],
];

export function createServiceEditor({ onChanged }) {
  let service = null;
  // 一覧を素早く切り替えたとき、先に開始した取得が後から完了しても
  // 現在表示中のサービスを上書きしないための世代番号。
  let loadVersion = 0;

  // アカウントの自動保存。「アカウント以外」（名前・URL・入力項目・共通値）は
  // persisted が指す直前保存済みの内容のまま保ち、明示的な「保存」でのみ更新する。
  // persisted が null の間（＝一度も保存していない新規サービス）は自動保存しない。
  let persisted = null;
  const saveQueue = createSaveQueue();

  function renderAccountSaveStatus(status, error) {
    renderSaveStatus($('#account-save-status'), status, { error, onRetry: () => triggerAccountAutosave() });
  }

  const triggerAccountAutosave = createAccountAutosaveTrigger({
    getService: () => service,
    getPersistedBase: () => persisted,
    saveQueue,
    sendSave: (payload) => request(MSG.SERVICE_SAVE, { service: payload }),
    onStatus: renderAccountSaveStatus,
  });

  /**
   * オリジン入力欄。入力途中の値を正規化してしまわないよう、
   * 確定（フォーカスが外れた時点）で正規化し、その結果を画面へも反映する。
   */
  function originInput(rule, placeholder) {
    const input = el('input', {
      attrs: { type: 'text', autocomplete: 'off', placeholder },
      props: { value: rule.origin || '' },
      on: {
        change: () => {
          rule.origin = normalizeOrigin(input.value);
          input.value = rule.origin;
          // オリジンが確定すれば、protocol 未確定の旧条件は不要になる。
          if (rule.origin) delete rule.legacy;
        },
      },
    });
    return input;
  }

  // --- 描画 -----------------------------------------------------------------

  function render() {
    $('#editor-empty').classList.toggle('hidden', Boolean(service));
    $('#editor-body').classList.toggle('hidden', !service);
    if (!service) return;

    $('#editor-title').textContent = service.name || '(新規サービス)';
    $('#svc-name').value = service.name;
    $('#svc-note').value = service.note || '';
    renderRules();
    renderFields();
    renderSharedValues();
    renderAccounts();
  }

  function renderRules() {
    const body = $('#rule-rows');
    clear(body);
    for (const rule of service.matchRules) {
      // protocol 未確定の旧条件は、対象ページを開いた時点で自動的に確定する。
      const pending = isPendingRule(rule);
      const row = el('tr', {}, [
        el('td', {}, [originInput(rule, pending
          ? `${rule.legacy.hostname}（プロトコル未確定・対象ページを開くと自動設定）`
          : 'https://example.asp.lgwan.jp')]),
        el('td', { className: 'col-mode' }, [
          select(ORIGIN_MODE_LABELS, rule.originMode, (value) => { rule.originMode = value; }),
        ]),
        el('td', {}, [textInput(rule.pathname, (value) => { rule.pathname = value.trim(); })]),
        el('td', { className: 'col-mode' }, [
          select(PATHNAME_MODE_LABELS, rule.pathnameMode, (value) => { rule.pathnameMode = value; }),
        ]),
        el('td', { className: 'col-action' }, [
          el('button', {
            className: 'link danger',
            text: '削除',
            attrs: { type: 'button' },
            on: {
              click: () => {
                service.matchRules = service.matchRules.filter((entry) => entry.id !== rule.id);
                renderRules();
              },
            },
          }),
        ]),
      ]);
      body.append(row);
    }
  }

  function renderFields() {
    const body = $('#field-rows');
    clear(body);
    $('#field-empty').classList.toggle('hidden', service.fields.length > 0);

    for (const field of service.fields) {
      const summary = el('div', { className: 'locator-summary', text: describeLocator(field.locator) });
      const editor = el('div', { className: 'locator-edit hidden' }, [
        textInput(field.locator.elementId, (value) => {
          field.locator.elementId = value.trim();
          summary.textContent = describeLocator(field.locator);
        }, { placeholder: 'id' }),
        textInput(field.locator.name, (value) => {
          field.locator.name = value.trim();
          summary.textContent = describeLocator(field.locator);
        }, { placeholder: 'name' }),
        textInput(field.locator.cssPath, (value) => {
          field.locator.cssPath = value.trim();
          summary.textContent = describeLocator(field.locator);
        }, { placeholder: 'CSSセレクタ' }),
      ]);
      const toggle = el('button', {
        className: 'link',
        text: '識別情報を編集',
        attrs: { type: 'button' },
        on: { click: () => editor.classList.toggle('hidden') },
      });

      body.append(el('tr', {}, [
        el('td', {}, [textInput(field.label, (value) => {
          field.label = value;
          renderSharedValues();
          renderAccounts();
        })]),
        el('td', { className: 'col-mode' }, [
          select(SCOPE_LABELS, field.scope, (value) => {
            // 入力済みの値は破棄せず、変更後の区分側へ引き継ぐ。
            changeFieldScope(service, field, value);
            renderSharedValues();
            renderAccounts();
          }),
        ]),
        el('td', { className: 'col-mode' }, [
          select(KIND_LABELS, field.kind, (value) => {
            field.kind = value;
            renderSharedValues();
            renderAccounts();
          }),
        ]),
        el('td', {}, [summary, toggle, editor]),
        el('td', { className: 'col-action' }, [
          el('button', {
            className: 'link danger',
            text: '削除',
            attrs: { type: 'button' },
            on: {
              click: () => {
                service.fields = service.fields.filter((entry) => entry.id !== field.id);
                delete service.sharedValues[field.id];
                for (const account of service.accounts) delete account.values[field.id];
                renderFields();
                renderSharedValues();
                renderAccounts();
              },
            },
          }),
        ]),
      ]));
    }
  }

  function describeLocator(locator) {
    const parts = [locator.tagName || 'input'];
    if (locator.type) parts.push(`[${locator.type}]`);
    if (locator.elementId) parts.push(`#${locator.elementId}`);
    if (locator.name) parts.push(`name=${locator.name}`);
    if (!locator.elementId && !locator.name && locator.cssPath) parts.push(locator.cssPath);
    if (locator.labelText) parts.push(`「${locator.labelText}」`);
    return parts.join(' ');
  }

  function renderSharedValues() {
    const sharedFields = service.fields.filter((field) => field.scope === FIELD_SCOPE.SHARED);
    $('#shared-empty').classList.toggle('hidden', sharedFields.length > 0);
    renderValueFields($('#shared-values'), sharedFields, service.sharedValues);
  }

  function renderAccounts() {
    const accountFields = service.fields.filter((field) => field.scope === FIELD_SCOPE.ACCOUNT);
    renderAccountCards($('#account-list'), service.accounts, accountFields, {
      onChange: triggerAccountAutosave,
      onRemove: triggerAccountAutosave,
    });
  }

  // --- 操作 -----------------------------------------------------------------

  $('#svc-name').addEventListener('input', (event) => {
    if (!service) return;
    service.name = event.target.value;
    $('#editor-title').textContent = service.name || '(新規サービス)';
  });

  $('#svc-note').addEventListener('input', (event) => {
    if (service) service.note = event.target.value;
  });

  $('#btn-add-rule').addEventListener('click', () => {
    if (!service) return;
    service.matchRules.push(createMatchRule({ pathnameMode: PATHNAME_MODE.EXACT, pathname: '/' }));
    renderRules();
  });

  $('#btn-add-account').addEventListener('click', () => {
    if (!service) return;
    service.accounts.push(createAccount({ name: `アカウント${service.accounts.length + 1}` }));
    renderAccounts();
    triggerAccountAutosave();
  });

  /**
   * 保存前の確認。どの URL にも一致しないサービスが黙って出来上がるのを防ぐ。
   * @returns {string} 問題があればその内容、なければ空文字
   */
  function validate() {
    if (!service.name.trim()) return 'サービス名を入力してください。';
    if (!service.matchRules.length) return '対象URLの条件を 1 つ以上追加してください。';
    const invalid = service.matchRules.some((rule) => !rule.origin && !isPendingRule(rule));
    if (invalid) return 'オリジンを「https://ホスト名」の形式で入力してください。';
    return '';
  }

  $('#btn-save-service').addEventListener('click', async () => {
    if (!service) return;
    const problem = validate();
    if (problem) {
      setStatus($('#editor-status'), problem, 'error');
      return;
    }
    const targetService = service;
    try {
      // アカウントの自動保存と同じキューを通し、古い保存処理と新しい保存処理が
      // 前後することなく順番に実行されるようにする。
      await saveQueue.enqueue(async () => {
        const result = await request(MSG.SERVICE_SAVE, { service: targetService });
        targetService.id = result.serviceId;
        persisted = snapshotServiceExceptAccounts(targetService);
      });
      // 一覧を再読込した後に結果を表示する（再読込で状態表示がクリアされるため）。
      await onChanged(targetService.id);
      setStatus($('#editor-status'), '保存しました。', 'ok');
    } catch (error) {
      setStatus($('#editor-status'), error.message, 'error');
    }
  });

  $('#btn-delete-service').addEventListener('click', async () => {
    if (!service) return;
    const confirmed = confirm(`サービス「${service.name}」と登録済みの認証情報を削除します。よろしいですか？`);
    if (!confirmed) return;
    try {
      await request(MSG.SERVICE_DELETE, { serviceId: service.id });
      service = null;
      persisted = null;
      render();
      await onChanged(null);
    } catch (error) {
      setStatus($('#editor-status'), error.message, 'error');
    }
  });

  return {
    async load(serviceId) {
      const version = ++loadVersion;
      const result = await request(MSG.SERVICE_GET, { serviceId });
      if (version !== loadVersion) return;
      service = result.service;
      // 既に保存済みのサービスなので、この時点からアカウントの変更は自動保存する。
      persisted = snapshotServiceExceptAccounts(service);
      renderAccountSaveStatus(null);
      setStatus($('#editor-status'), '');
      render();
    },
    createNew() {
      loadVersion += 1;
      service = createService('');
      service.fields = [createField({ label: 'ユーザーID' }), createField({ label: 'パスワード', kind: FIELD_KIND.SECRET })];
      service.accounts = [createAccount({ name: '標準ユーザー' })];
      service.matchRules = [createMatchRule({ pathname: '/' })];
      // 新規サービスは未保存の間、アカウントの変更も自動保存しない（最初は明示的な保存が必要）。
      persisted = null;
      renderAccountSaveStatus(null);
      setStatus($('#editor-status'), 'ログイン画面から設定すると、対象入力欄の識別情報も登録されます。');
      render();
    },
    clear() {
      loadVersion += 1;
      service = null;
      persisted = null;
      renderAccountSaveStatus(null);
      render();
    },
    currentId() {
      return service ? service.id : null;
    },
  };
}
