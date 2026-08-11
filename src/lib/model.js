/**
 * Vault のデータモデル定義と正規化処理。
 *
 * Vault
 *  └─ services[]
 *       ├─ id / name / note
 *       ├─ matchRules[]   … URL 判定条件（hostname + pathname）
 *       ├─ fields[]       … 任意のログイン項目定義（ID/パスワード固定ではない）
 *       ├─ sharedValues{} … サービス共通値（自治体コード等）
 *       └─ accounts[]     … 複数アカウント（通常 / 管理者）
 */

export const SCHEMA_VERSION = 1;

export const FIELD_SCOPE = { SHARED: 'shared', ACCOUNT: 'account' };
export const FIELD_KIND = { TEXT: 'text', SECRET: 'secret' };
export const ACCOUNT_ROLE = { NORMAL: 'normal', ADMIN: 'admin' };

export const HOSTNAME_MODE = { EXACT: 'exact', SUFFIX: 'suffix' };
export const PATHNAME_MODE = { EXACT: 'exact', PREFIX: 'prefix', ANY: 'any' };

/** @returns {string} 衝突しない ID */
export function newId(prefix) {
  const uuid = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${uuid}`;
}

export function createVault() {
  return { schemaVersion: SCHEMA_VERSION, services: [], updatedAt: Date.now() };
}

export function createService(name = '') {
  const now = Date.now();
  return {
    id: newId('svc'),
    name,
    note: '',
    matchRules: [],
    fields: [],
    sharedValues: {},
    accounts: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function createMatchRule(partial = {}) {
  return {
    id: newId('rule'),
    hostname: partial.hostname || '',
    hostnameMode: partial.hostnameMode || HOSTNAME_MODE.EXACT,
    pathname: partial.pathname || '',
    pathnameMode: partial.pathnameMode || PATHNAME_MODE.EXACT,
  };
}

export function createField(partial = {}) {
  return {
    id: newId('fld'),
    label: partial.label || '',
    scope: partial.scope === FIELD_SCOPE.SHARED ? FIELD_SCOPE.SHARED : FIELD_SCOPE.ACCOUNT,
    kind: partial.kind === FIELD_KIND.SECRET ? FIELD_KIND.SECRET : FIELD_KIND.TEXT,
    locator: normalizeLocator(partial.locator),
  };
}

export function createAccount(partial = {}) {
  return {
    id: newId('acc'),
    name: partial.name || '',
    role: partial.role === ACCOUNT_ROLE.ADMIN ? ACCOUNT_ROLE.ADMIN : ACCOUNT_ROLE.NORMAL,
    note: partial.note || '',
    values: { ...(partial.values || {}) },
  };
}

/**
 * DOM 要素を識別するための情報。
 * 単一セレクタに依存せず複数のヒントを保持し、DOM 変更にある程度耐えられるようにする。
 */
export function normalizeLocator(locator = {}) {
  return {
    tagName: str(locator.tagName).toLowerCase(),
    type: str(locator.type).toLowerCase(),
    elementId: str(locator.elementId),
    name: str(locator.name),
    autocomplete: str(locator.autocomplete),
    placeholder: str(locator.placeholder),
    ariaLabel: str(locator.ariaLabel),
    labelText: str(locator.labelText),
    cssPath: str(locator.cssPath),
    formIndex: Number.isInteger(locator.formIndex) ? locator.formIndex : -1,
    indexInForm: Number.isInteger(locator.indexInForm) ? locator.indexInForm : -1,
  };
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

/** 外部から読み込んだ Vault を安全な形へ正規化する。 */
export function normalizeVault(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.services)) {
    throw new Error('Vault データの形式が不正です。');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    services: raw.services.map(normalizeService),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

export function normalizeService(raw = {}) {
  const service = createService(str(raw.name));
  if (str(raw.id)) service.id = raw.id;
  service.note = str(raw.note);
  service.createdAt = Number(raw.createdAt) || service.createdAt;
  service.updatedAt = Number(raw.updatedAt) || service.updatedAt;
  service.matchRules = asArray(raw.matchRules).map((rule) => {
    const normalized = createMatchRule(rule);
    if (str(rule.id)) normalized.id = rule.id;
    return normalized;
  });
  service.fields = asArray(raw.fields).map((field) => {
    const normalized = createField(field);
    if (str(field.id)) normalized.id = field.id;
    return normalized;
  });
  const fieldIds = new Set(service.fields.map((field) => field.id));
  service.sharedValues = pickValues(raw.sharedValues, fieldIds);
  service.accounts = asArray(raw.accounts).map((account) => {
    const normalized = createAccount(account);
    if (str(account.id)) normalized.id = account.id;
    normalized.values = pickValues(account.values, fieldIds);
    return normalized;
  });
  return service;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pickValues(values, fieldIds) {
  const result = {};
  if (!values || typeof values !== 'object') return result;
  for (const [key, value] of Object.entries(values)) {
    if (fieldIds.has(key) && typeof value === 'string') result[key] = value;
  }
  return result;
}

/**
 * UI へ渡すためにサービスを要約する。秘密情報の値そのものは含めない。
 */
export function summarizeService(service) {
  return {
    id: service.id,
    name: service.name,
    note: service.note,
    matchRules: service.matchRules.map((rule) => ({ ...rule })),
    fieldCount: service.fields.length,
    fields: service.fields.map((field) => ({
      id: field.id,
      label: field.label,
      scope: field.scope,
      kind: field.kind,
      hasSharedValue: Boolean(service.sharedValues[field.id]),
    })),
    accounts: service.accounts.map((account) => ({
      id: account.id,
      name: account.name,
      role: account.role,
      note: account.note,
      filledFieldCount: countFilled(service, account),
    })),
  };
}

function countFilled(service, account) {
  return service.fields.filter((field) => {
    const value = field.scope === FIELD_SCOPE.SHARED
      ? service.sharedValues[field.id]
      : account.values[field.id];
    return Boolean(value);
  }).length;
}

/** 指定アカウントで実際に入力される値の一覧を組み立てる。 */
export function buildFillValues(service, account) {
  return service.fields
    .map((field) => {
      const value = field.scope === FIELD_SCOPE.SHARED
        ? service.sharedValues[field.id]
        : account.values[field.id];
      return {
        fieldId: field.id,
        label: field.label,
        kind: field.kind,
        locator: field.locator,
        value: typeof value === 'string' ? value : '',
      };
    })
    .filter((entry) => entry.value !== '');
}
