/**
 * アカウント関連 UI の共通部品。
 * setup.html（ログイン画面設定）と options.html（サービス一覧）の双方から、
 * 同じアカウント一覧描画・追加・削除・値編集ロジックを利用するために切り出している。
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

export function textInput(value, onChange, attrs = {}) {
  return el('input', {
    attrs: { type: 'text', autocomplete: 'off', ...attrs },
    props: { value: value || '' },
    on: { input: (event) => onChange(event.target.value) },
  });
}

/** 秘密項目の入力欄。既定で非表示（password）にし、ボタンで表示 / 非表示を切り替える。 */
export function secretInput(value, onChange) {
  const input = el('input', {
    attrs: { type: 'password', autocomplete: 'off' },
    props: { value: value || '' },
    on: { input: (event) => onChange(event.target.value) },
  });
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

export function valueInput(field, value, onChange) {
  return field.kind === FIELD_KIND.SECRET ? secretInput(value, onChange) : textInput(value, onChange);
}

/** 「表示名 + 入力欄」の並びで項目値を描画する（サービス共通値 / アカウント値の双方で使う）。 */
export function renderValueFields(container, fields, values) {
  clear(container);
  for (const field of fields) {
    container.append(el('div', {}, [
      el('div', { className: 'field-label', text: field.label }),
      valueInput(field, values[field.id], (value) => {
        if (value) values[field.id] = value;
        else delete values[field.id];
      }),
    ]));
  }
}

/**
 * アカウント一覧を描画する。accounts 配列を直接書き換える
 * （名前・区分・各項目値の編集、削除）。追加は呼び出し側の「追加」ボタンで行う。
 */
export function renderAccountCards(container, accounts, accountFields, { onRemove } = {}) {
  clear(container);
  if (!accounts.length) {
    container.append(el('p', { className: 'small muted', text: 'アカウントが登録されていません。' }));
    return;
  }
  for (const account of accounts) {
    const card = el('div', { className: `account-card${account.role === ACCOUNT_ROLE.ADMIN ? ' admin' : ''}` });
    const head = el('div', { className: 'row account-head' }, [
      textInput(account.name, (value) => { account.name = value; }, { placeholder: 'アカウント名' }),
      select(ROLE_LABELS, account.role, (value) => {
        account.role = value;
        card.classList.toggle('admin', value === ACCOUNT_ROLE.ADMIN);
      }),
      el('span', { className: 'spacer' }),
      el('button', {
        className: 'link danger',
        text: '削除',
        attrs: { type: 'button' },
        on: {
          click: () => {
            const index = accounts.indexOf(account);
            if (index >= 0) accounts.splice(index, 1);
            renderAccountCards(container, accounts, accountFields, { onRemove });
            if (onRemove) onRemove();
          },
        },
      }),
    ]);
    head.querySelector('input').classList.add('name');
    card.append(head);

    if (accountFields.length) {
      const grid = el('div', { className: 'value-grid' });
      renderValueFields(grid, accountFields, account.values);
      card.append(grid);
    } else {
      card.append(el('p', { className: 'small muted', text: 'アカウント区分の項目がありません。' }));
    }
    container.append(card);
  }
}
