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
 * サービスのうち「アカウント以外」（名前・URL条件・入力項目・サービス共通値）の
 * 最小限のスナップショットを取る。自動保存はこの内容を変えず、accounts だけを
 * 差し替えて送るために使う。
 */
export function snapshotServiceExceptAccounts(service) {
  return {
    id: service.id,
    name: service.name,
    note: service.note,
    matchRules: JSON.parse(JSON.stringify(service.matchRules)),
    fields: JSON.parse(JSON.stringify(service.fields)),
    sharedValues: JSON.parse(JSON.stringify(service.sharedValues)),
    createdAt: service.createdAt,
  };
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
 * 「アカウント以外」の項目は getPersistedBase() が返す直前保存済みの状態のまま送り、
 * accounts だけ getService().accounts の最新値を都度読み直して送る。
 *
 * getPersistedBase() が null を返す間（＝まだ一度も明示保存されていない新規サービス）
 * は何もしない。
 */
export function createAccountAutosaveTrigger({ getService, getPersistedBase, saveQueue, sendSave, onStatus }) {
  let outstanding = 0;
  return function trigger() {
    const service = getService();
    const baseAtTrigger = getPersistedBase();
    if (!service || !baseAtTrigger) return;
    const targetService = service;
    const targetId = service.id;
    outstanding += 1;
    onStatus('saving');
    saveQueue.enqueue(async () => {
      // 実行時点の最新の基準値を読み直す（間に明示保存が挟まっていれば反映するため）。
      const base = getPersistedBase();
      if (!base || base.id !== targetId) return; // 別のサービスへ切り替わっていた場合は何もしない
      const payload = { ...base, accounts: targetService.accounts };
      await sendSave(payload);
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
