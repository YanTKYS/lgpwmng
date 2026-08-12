/**
 * Vault のデータモデル定義と正規化処理。
 *
 * Vault
 *  └─ services[]
 *       ├─ id / name / note
 *       ├─ matchRules[]   … URL 判定条件（origin + pathname）
 *       ├─ fields[]       … 任意のログイン項目定義（ID/パスワード固定ではない）
 *       ├─ sharedValues{} … サービス共通値（自治体コード等）
 *       └─ accounts[]     … 複数アカウント（通常 / 管理者）
 */

import { normalizeFrameDescriptor } from './frame.js';

/**
 * 1: hostname + pathname
 * 2: origin + pathname
 * 3: origin + pathname（protocol 未確定の旧条件を legacy として保持できる）
 *    項目（field）に frame 情報を持てるようになったが、フレーム情報が無い
 *    項目は常にトップフレーム扱いとして読み込めるため、schemaVersion は
 *    据え置いている。
 */
export const SCHEMA_VERSION = 3;

export const FIELD_SCOPE = { SHARED: 'shared', ACCOUNT: 'account' };
export const FIELD_KIND = { TEXT: 'text', SECRET: 'secret' };
export const ACCOUNT_ROLE = { NORMAL: 'normal', ADMIN: 'admin' };

/** origin = プロトコル + ホスト名 + ポート。http と https は別のものとして扱う。 */
export const ORIGIN_MODE = { EXACT: 'exact', SUFFIX: 'suffix' };
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

/**
 * URL 判定条件を作る。
 *
 * origin が確定していない場合（schemaVersion 1 の hostname 形式）は、
 * プロトコルを推測せずに legacy として保持する。protocol 未確定のルールは
 * どの URL にも一致しないため、確定するまで認証情報が入力されることはない。
 */
export function createMatchRule(partial = {}) {
  const legacy = readLegacy(partial);
  const origin = normalizeOrigin(partial.origin);
  const rule = {
    id: newId('rule'),
    origin,
    originMode: resolveOriginMode(partial, legacy),
    pathname: partial.pathname || '',
    pathnameMode: partial.pathnameMode || PATHNAME_MODE.EXACT,
  };
  // origin が確定していれば legacy は不要になる。
  if (!origin && legacy) rule.legacy = legacy;
  return rule;
}

function resolveOriginMode(partial, legacy) {
  const mode = partial.originMode || (legacy ? legacy.hostnameMode : '');
  return mode === ORIGIN_MODE.SUFFIX ? ORIGIN_MODE.SUFFIX : ORIGIN_MODE.EXACT;
}

/**
 * protocol 未確定の旧条件を取り出す。
 * schemaVersion 1 の `hostname` / `hostnameMode`、および
 * schemaVersion 3 で保存した `legacy` の双方を受け付ける。
 */
function readLegacy(partial) {
  const source = partial && partial.legacy && typeof partial.legacy === 'object' ? partial.legacy : partial;
  if (!source || typeof source.hostname !== 'string' || !source.hostname.trim()) return null;
  return {
    hostname: source.hostname.trim().toLowerCase().replace(/^\.+/, ''),
    hostnameMode: source.hostnameMode === ORIGIN_MODE.SUFFIX ? ORIGIN_MODE.SUFFIX : ORIGIN_MODE.EXACT,
  };
}

/** protocol が未確定（実際のページを開くまで一致しない）ルールか。 */
export function isPendingRule(rule) {
  return Boolean(rule && !rule.origin && rule.legacy && rule.legacy.hostname);
}

/**
 * 設定画面で入力された文字列を origin 表記へ正規化する。
 * プロトコル省略時は https を補う（利用者が明示的に入力した値に対する既定であり、
 * 保存済みデータの protocol 推測には用いない）。
 */
export function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return '';
  }
}

export function createField(partial = {}) {
  return {
    id: newId('fld'),
    label: partial.label || '',
    scope: partial.scope === FIELD_SCOPE.SHARED ? FIELD_SCOPE.SHARED : FIELD_SCOPE.ACCOUNT,
    kind: partial.kind === FIELD_KIND.SECRET ? FIELD_KIND.SECRET : FIELD_KIND.TEXT,
    locator: normalizeLocator(partial.locator),
    // 対象入力欄が属するフレーム。情報が無い場合はトップフレーム扱いになる
    // （旧バージョンで登録した項目もそのまま読み込める）。
    frame: normalizeFrameDescriptor(partial.frame),
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
 * 項目の区分（共通 / アカウント）を変更する。
 * 変更後の区分側に値が無ければ引き継ぐだけで、変更前の区分の値は消さない。
 * そのため、誤って区分を変えてしまっても戻せば元の値のまま使える
 * （アカウントごとに異なる値を登録していた場合も失われない）。
 *
 * @param {object} service 値の保管先（sharedValues / accounts）を持つサービス
 * @param {object} field   区分を変更する項目
 * @param {string} nextScope FIELD_SCOPE のいずれか
 */
export function changeFieldScope(service, field, nextScope) {
  const scope = nextScope === FIELD_SCOPE.SHARED ? FIELD_SCOPE.SHARED : FIELD_SCOPE.ACCOUNT;
  if (field.scope === scope) return;
  field.scope = scope;

  if (scope === FIELD_SCOPE.SHARED) {
    if (service.sharedValues[field.id]) return;
    // アカウント側に値があれば、最初に見つかった値を共通値として引き継ぐ。
    const inherited = service.accounts.map((account) => account.values[field.id]).find(Boolean);
    if (inherited) service.sharedValues[field.id] = inherited;
    return;
  }
  // 共通値を、まだ値を持たないアカウントへ引き継ぐ。
  const shared = service.sharedValues[field.id];
  if (!shared) return;
  for (const account of service.accounts) {
    if (!account.values[field.id]) account.values[field.id] = shared;
  }
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
        frame: field.frame,
        value: typeof value === 'string' ? value : '',
      };
    })
    .filter((entry) => entry.value !== '');
}
