/**
 * アカウント関連 UI の共通部品。
 * setup.html（ログイン画面設定）と options.html（サービス一覧）の双方から、
 * 同じアカウント一覧描画・追加・削除・値編集・自動保存ロジックを利用するために切り出している。
 */

import { ACCOUNT_ROLE, FIELD_KIND } from '../lib/model.js';
import { clear, el } from './dom.js';

export const ROLE_LABELS = [
  [ACCOUNT_ROLE.NORMAL, '通常'],
  [ACCOUNT_ROLE.ADMIN, '管理者'],
];

export function select(options, value, onChange, className = '') {
  const node = el('select', { className });
  for (const [optionValue, label] of options) {
    node.append(el('option', { text: label, attrs: { value: optionValue } }));
  }
  node.value = value;
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

/**
 * @param {Function} [onCommit] 値が確定した（change / blur）タイミングで呼ばれる。
 *   自動保存のトリガー用で、キー入力のたびには呼ばれない。
 */
export function textInput(value, onChange, attrs = {}, onCommit) {
  const input = el('input', {
    attrs: { type: 'text', autocomplete: 'off', ...attrs },
    props: { value: value || '' },
    on: { input: (event) => onChange(event.target.value) },
  });
  if (onCommit) input.addEventListener('change', () => onCommit());
  return input;
}

/** 秘密項目の入力欄。既定で非表示（password）にし、ボタンで表示 / 非表示を切り替える。 */
export function secretInput(value, onChange, onCommit) {
  const input = el('input', {
    attrs: { type: 'password', autocomplete: 'off' },
    props: { value: value || '' },
    on: { input: (event) => onChange(event.target.value) },
  });
  if (onCommit) input.addEventListener('change', () => onCommit());
  const toggle = el('button', {
    text: '表示',
    attrs: { type: 'button' },
    on: {
      click: () => {
        const visible = input.type === 'text';
        input.type = visible ? 'password' : 'text';
        toggle.textContent = visible ? '表示' : '隠す';
      },
    },
  });
  return el('div', { className: 'secret-row' }, [input, toggle]);
}

export function valueInput(field, value, onChange, onCommit) {
  return field.kind === FIELD_KIND.SECRET
    ? secretInput(value, onChange, onCommit)
    : textInput(value, onChange, {}, onCommit);
}

/**
 * 「表示名 + 入力欄」の並びで項目値を描画する（サービス共通値 / アカウント値の双方で使う）。
 * onCommit を渡さない呼び出し（サービス共通値など）は自動保存の対象にならない。
 */
export function renderValueFields(container, fields, values, onCommit) {
  clear(container);
  for (const field of fields) {
    container.append(el('div', {}, [
      el('div', { className: 'field-label', text: field.label }),
      valueInput(field, values[field.id], (value) => {
        if (value) values[field.id] = value;
        else delete values[field.id];
      }, onCommit),
    ]));
  }
}

/**
 * アカウント一覧を描画する。accounts 配列を直接書き換える
 * （名前・区分・各項目値の編集、削除）。追加は呼び出し側の「追加」ボタンで行う。
 *
 * @param {Function} [onChange] 名前 / 区分 / 各項目値が確定したときに呼ばれる（自動保存のトリガー用）。
 * @param {Function} [onRemove] アカウントを削除したときに呼ばれる（自動保存のトリガー用）。
 */
export function renderAccountCards(container, accounts, accountFields, { onRemove, onChange } = {}) {
  clear(container);
  if (!accounts.length) {
    container.append(el('p', { className: 'small muted', text: 'アカウントが登録されていません。' }));
    return;
  }
  for (const account of accounts) {
    const card = el('div', { className: `account-card${account.role === ACCOUNT_ROLE.ADMIN ? ' admin' : ''}` });
    const nameInput = textInput(account.name, (value) => { account.name = value; }, { placeholder: 'アカウント名' }, onChange);
    nameInput.classList.add('name');
    const head = el('div', { className: 'row account-head' }, [
      nameInput,
      select(ROLE_LABELS, account.role, (value) => {
        account.role = value;
        card.classList.toggle('admin', value === ACCOUNT_ROLE.ADMIN);
        if (onChange) onChange();
      }),
      el('span', { className: 'spacer' }),
      el('button', {
        className: 'link danger',
        text: '削除',
        attrs: { type: 'button' },
        on: {
          click: () => {
            const confirmed = confirm(`アカウント「${account.name || '(名称未設定)'}」を削除しますか？`);
            if (!confirmed) return;
            const index = accounts.indexOf(account);
            if (index >= 0) accounts.splice(index, 1);
            renderAccountCards(container, accounts, accountFields, { onRemove, onChange });
            if (onRemove) onRemove();
          },
        },
      }),
    ]);
    card.append(head);

    if (accountFields.length) {
      const grid = el('div', { className: 'value-grid' });
      renderValueFields(grid, accountFields, account.values, onChange);
      card.append(grid);
    } else {
      card.append(el('p', { className: 'small muted', text: 'アカウント区分の項目がありません。' }));
    }
    container.append(card);
  }
}

// --- 自動保存 ----------------------------------------------------------------

/**
 * サービス全体のディープクローン。保存直後のスナップショット（自動保存の基準）や、
 * 明示保存をクリックした時点の内容を固定するために使う。
 */
export function snapshotService(service) {
  return JSON.parse(JSON.stringify(service));
}

/**
 * サービス設定（入力項目の区分変更・削除など）の未保存の変更が、アカウントの
 * 自動保存に混ざらないようにする。
 *
 * changeFieldScope() や項目削除は、入力欄への即時フィードバックのために
 * account.values / sharedValues を画面上ですぐに書き換える。しかしこれらは
 * 「入力項目」＝サービス設定の一部であり、明示保存されるまでは Vault へ
 * 反映してはならない。そこで、直前保存時の項目一覧（base.fields）と現在の
 * 項目一覧（live.fields）を比較し、区分または存在が変わった項目（＝まだ
 * 保存されていない変更がある項目）については値を直前保存時のまま送り、
 * 変わっていない項目の値・アカウント名・区分は現在の内容をそのまま送る。
 */
export function buildSafeAccountsPayload(base, live) {
  const baseFieldsById = new Map((base.fields || []).map((field) => [field.id, field]));
  const dirtyFieldIds = new Set();
  for (const field of live.fields || []) {
    const original = baseFieldsById.get(field.id);
    if (!original || original.scope !== field.scope) dirtyFieldIds.add(field.id);
  }
  for (const field of base.fields || []) {
    if (!(live.fields || []).some((entry) => entry.id === field.id)) dirtyFieldIds.add(field.id);
  }

  const baseAccountsById = new Map((base.accounts || []).map((account) => [account.id, account]));

  return (live.accounts || []).map((account) => {
    const baseAccount = baseAccountsById.get(account.id);
    const values = {};
    const seen = new Set();
    for (const [fieldId, value] of Object.entries(account.values || {})) {
      seen.add(fieldId);
      if (dirtyFieldIds.has(fieldId)) {
        // 未保存の項目変更の影響を受けた値は、直前保存時の値のまま据え置く。
        if (baseAccount && baseAccount.values[fieldId] !== undefined) values[fieldId] = baseAccount.values[fieldId];
      } else {
        values[fieldId] = value;
      }
    }
    // 未保存の変更（区分変更 / 削除）によって現在の account.values から
    // 消えてしまった値を、直前保存時の内容から復元する。
    if (baseAccount) {
      for (const [fieldId, value] of Object.entries(baseAccount.values || {})) {
        if (seen.has(fieldId) || !dirtyFieldIds.has(fieldId)) continue;
        values[fieldId] = value;
      }
    }
    return { ...account, values };
  });
}

/**
 * 直列保存キュー。積まれた保存処理を必ず1件ずつ、積んだ順に実行する。
 * 実行中に新しい保存が積まれても、古い処理が後から完了して新しい値を
 * 上書きすることはない（すべて順番に実行されるため）。1件の失敗が
 * 後続の処理を止めることもない。
 */
export function createSaveQueue() {
  let chain = Promise.resolve();
  return {
    enqueue(task) {
      const run = chain.catch(() => {}).then(task);
      chain = run;
      return run;
    },
  };
}

/**
 * アカウントの変更を自動保存するトリガーを作る。
 * 「アカウント以外」の項目（サービス設定）は getPersistedBase() が返す直前保存済みの
 * 状態のまま送る。accounts は getService() の最新の状態から、未保存のサービス設定
 * 変更の影響（buildSafeAccountsPayload）を取り除いたうえで送る。
 *
 * getPersistedBase() が null を返す間（＝まだ一度も明示保存されていない新規サービス）
 * は何もしない。
 */
export function createAccountAutosaveTrigger({ getService, getPersistedBase, setPersistedBase, saveQueue, sendSave, onStatus }) {
  let outstanding = 0;
  return function trigger() {
    const service = getService();
    const baseAtTrigger = getPersistedBase();
    if (!service || !baseAtTrigger) return;
    const targetId = service.id;
    outstanding += 1;
    onStatus('saving');
    saveQueue.enqueue(async () => {
      // 実行時点の最新の状態を読み直す（間に明示保存や他の変更が挟まっていれば反映するため）。
      const base = getPersistedBase();
      const live = getService();
      if (!base || base.id !== targetId || !live || live.id !== targetId) return; // 別のサービスへ切り替わっていた場合は何もしない
      const accounts = buildSafeAccountsPayload(base, live);
      await sendSave({ ...base, accounts });
      // 保存できた accounts の内容を、以後の自動保存が比較・送信する基準として反映する。
      // 「アカウント以外」の内容（サービス設定）はこの自動保存では変えていないので据え置く。
      if (setPersistedBase) setPersistedBase({ ...base, accounts });
    }).then(
      () => {
        outstanding -= 1;
        if (outstanding === 0) onStatus('saved');
      },
      (error) => {
        outstanding -= 1;
        onStatus('error', error);
      },
    );
  };
}

/** 保存状態の小さな表示（保存中… / 保存済み / 保存できませんでした [再試行]）。 */
export function renderSaveStatus(node, status, { error, onRetry } = {}) {
  clear(node);
  if (status === 'saving') {
    node.className = 'status muted';
    node.textContent = '保存中…';
  } else if (status === 'saved') {
    node.className = 'status muted';
    node.textContent = '保存済み';
  } else if (status === 'error') {
    node.className = 'status error';
    node.append(el('span', { text: error && error.message ? `保存できませんでした（${error.message}）` : '保存できませんでした' }));
    if (onRetry) {
      node.append(document.createTextNode(' '));
      node.append(el('button', { className: 'link', text: '再試行', attrs: { type: 'button' }, on: { click: onRetry } }));
    }
  } else {
    node.className = 'status';
    node.textContent = '';
  }
}
