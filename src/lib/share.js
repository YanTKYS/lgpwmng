/**
 * アカウント共有（選択したサービス／アカウントだけを受け渡す機能）のロジック。
 *
 * マスターバックアップ（Vault 全体の保全・復旧、`lgpwmng-backup`）とは明確に分離し、
 * こちらは `lgpwmng-share` という独立した形式を持つ。暗号化自体は lib/crypto.js
 * （PBKDF2 + AES-GCM）を再利用し、ここでは
 *   - 選択済みサービス／アカウントの抽出
 *   - 共有ファイルの検証（形式・バージョン・破損の判別）
 *   - インポート計画（追加／更新の内訳）の作成
 *   - Vault 全体を置換しないマージ処理
 * を扱う。復号したデータは lib/model.js の normalizeVault() / normalizeService()
 * にそのまま通し、正規化・検証を再利用する。
 */

import {
  ACCOUNT_ROLE,
  BACKUP_FORMAT,
  SCHEMA_VERSION,
  SHARE_FORMAT,
  SHARE_FORMAT_VERSION,
  normalizeService,
  normalizeVault,
} from './model.js';
import { createKdfParams, decryptJson, deriveKey, encryptJson } from './crypto.js';

export class ShareFileError extends Error {}

// --- 選択済みアカウントの抽出 ---------------------------------------------------

/**
 * Vault から選択済みアカウントだけを抽出する。
 * 選択していないアカウント・サービスは一切含めない
 * （個人利用アカウントが意図せず含まれないことを優先する）。
 */
export function extractShareServices(vault, selection) {
  const services = [];
  for (const service of vault.services) {
    const ids = selection && selection[service.id];
    if (!Array.isArray(ids) || !ids.length) continue;
    const idSet = new Set(ids);
    const accounts = service.accounts
      .filter((account) => idSet.has(account.id))
      .map(cloneAccount);
    if (!accounts.length) continue;
    services.push({
      id: service.id,
      name: service.name,
      note: service.note,
      matchRules: service.matchRules.map(cloneRule),
      fields: service.fields.map(cloneField),
      sharedValues: { ...service.sharedValues },
      accounts,
    });
  }
  return services;
}

function cloneAccount(account) {
  return {
    id: account.id,
    name: account.name,
    role: account.role,
    note: account.note,
    values: { ...account.values },
  };
}

function cloneRule(rule) {
  const cloned = { ...rule };
  if (rule.legacy) cloned.legacy = { ...rule.legacy };
  return cloned;
}

function cloneField(field) {
  return { ...field, locator: { ...field.locator }, frame: { ...field.frame } };
}

/** 選択（またはデコード済み）データに管理者アカウントが含まれるか。 */
export function hasAdminAccount(services) {
  return services.some((service) => service.accounts.some((account) => account.role === ACCOUNT_ROLE.ADMIN));
}

// --- 暗号化ファイルの作成 -----------------------------------------------------

/**
 * 選択済みサービス／アカウントを暗号化した共有ファイルを作る。
 * 平文 JSON では出力しない。共有用パスフレーズは呼び出し側で 8 文字以上を検証する。
 */
export async function createShareFile(services, passphrase) {
  if (!Array.isArray(services) || !services.length) {
    throw new Error('共有するアカウントを1つ以上選択してください。');
  }
  const kdf = createKdfParams();
  const key = await deriveKey(passphrase, kdf);
  const envelope = await encryptJson(key, { services });
  return {
    format: SHARE_FORMAT,
    version: SHARE_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    kdf,
    iv: envelope.iv,
    data: envelope.data,
  };
}

// --- 読み込み・検証 -----------------------------------------------------------

/**
 * 復号を試みる前に、ファイルの種類を判別する。
 * マスターバックアップと共有ファイルを取り違えた場合に、正しい案内を出すため。
 */
function classify(file) {
  if (!file || typeof file !== 'object' || typeof file.format !== 'string') return 'invalid';
  if (file.format === BACKUP_FORMAT) return 'is-backup';
  if (file.format !== SHARE_FORMAT) return 'wrong-format';
  if (file.version !== SHARE_FORMAT_VERSION) return 'unsupported-version';
  if (
    !file.kdf
    || typeof file.kdf.salt !== 'string'
    || !Number.isFinite(file.kdf.iterations)
    || typeof file.iv !== 'string'
    || typeof file.data !== 'string'
  ) return 'invalid';
  return 'ok';
}

export function isShareFile(file) {
  return classify(file) === 'ok';
}

/**
 * 共有ファイルを復号し、正規化済みの services 配列を返す。
 * normalizeVault() を再利用して matchRules / fields / accounts / sharedValues 等を検証する。
 * 復号したデータをそのまま Vault へ入れることはない（呼び出し側で更にマージ処理を通す）。
 */
export async function decryptShareFile(file, passphrase) {
  const kind = classify(file);
  if (kind === 'is-backup') {
    throw new ShareFileError(
      'これはマスターバックアップファイルです。「共有用ファイルを取り込む」ではなく「バックアップを復元」から読み込んでください。',
    );
  }
  if (kind === 'wrong-format' || kind === 'invalid') {
    throw new ShareFileError('共有用ファイル（lgpwmng-share）の形式ではありません。');
  }
  if (kind === 'unsupported-version') {
    throw new ShareFileError('対応していないバージョンの共有ファイルです。');
  }

  let payload;
  try {
    const key = await deriveKey(passphrase, file.kdf);
    payload = await decryptJson(key, { iv: file.iv, data: file.data });
  } catch {
    throw new ShareFileError('パスフレーズが違うか、共有ファイルが壊れています。');
  }
  if (!payload || !Array.isArray(payload.services)) {
    throw new ShareFileError('共有ファイルの内容が不正です。');
  }
  const normalized = normalizeVault({
    schemaVersion: SCHEMA_VERSION,
    services: payload.services,
    updatedAt: Date.now(),
  });
  return normalized.services;
}

// --- インポート計画（追加／更新の内訳） -----------------------------------------

/**
 * Vault 全体を置換せず、共有データが Vault に対してどう作用するかを事前に示す計画を作る。
 * 保存は行わない（プレビュー用）。
 */
export function buildImportPlan(currentVault, shareServices) {
  const services = shareServices.map((shareService) => {
    const existing = currentVault.services.find((service) => service.id === shareService.id);
    const existingAccountIds = new Set(existing ? existing.accounts.map((account) => account.id) : []);
    const accountAdds = [];
    const accountUpdates = [];
    for (const account of shareService.accounts) {
      const summary = { id: account.id, name: account.name, role: account.role };
      if (existingAccountIds.has(account.id)) accountUpdates.push(summary);
      else accountAdds.push(summary);
    }
    return {
      serviceId: shareService.id,
      serviceName: shareService.name,
      isNewService: !existing,
      // 既存サービスの場合、実際の取り込み（applyShareImport）は matchRules / fields /
      // sharedValues も共有側の内容でマージ更新する。プレビューが account の増減しか
      // 示さないと実処理と食い違うため、ここで示しておく。
      settingsUpdated: Boolean(existing),
      accountAdds,
      accountUpdates,
    };
  });

  const totals = services.reduce(
    (acc, entry) => ({
      serviceAdds: acc.serviceAdds + (entry.isNewService ? 1 : 0),
      accountAdds: acc.accountAdds + entry.accountAdds.length,
      accountUpdates: acc.accountUpdates + entry.accountUpdates.length,
    }),
    { serviceAdds: 0, accountAdds: 0, accountUpdates: 0 },
  );

  return { services, totals, hasAdmin: hasAdminAccount(shareServices) };
}

// --- マージ処理（Vault への適用） -----------------------------------------------

/**
 * 共有データを Vault へマージする。
 *   - `current.services = imported.services` のような全体置換は行わない。
 *   - 同一 service.id が無ければ新規サービスとして追加する。
 *   - 同一 service.id があれば、既存サービス全体は置換せず、
 *     matchRules / fields / sharedValues を id ベースでマージ（追加・更新のみ、
 *     既存にしかない要素は保持）したうえで、共有対象の account だけを追加・更新する。
 *     未共有の既存アカウントは削除しない。
 * @returns {{serviceAdds: number, accountAdds: number, accountUpdates: number}}
 */
export function applyShareImport(vault, shareServices) {
  let serviceAdds = 0;
  let accountAdds = 0;
  let accountUpdates = 0;

  for (const shareService of shareServices) {
    const index = vault.services.findIndex((service) => service.id === shareService.id);
    if (index < 0) {
      const now = Date.now();
      const added = normalizeService(shareService);
      added.id = shareService.id;
      added.createdAt = now;
      added.updatedAt = now;
      vault.services.push(added);
      serviceAdds += 1;
      accountAdds += added.accounts.length;
      continue;
    }
    const existing = vault.services[index];
    const counts = { adds: 0, updates: 0 };
    vault.services[index] = mergeService(existing, shareService, counts);
    accountAdds += counts.adds;
    accountUpdates += counts.updates;
  }

  return { serviceAdds, accountAdds, accountUpdates };
}

/**
 * 既存サービスへ共有データをマージする。
 * サービス名・メモ・未共有アカウントなど利用者独自の内容は保護し、
 * matchRules / fields / sharedValues は共有側の定義で更新（id が無いものは追加、
 * 既存にしかないものはそのまま保持）、accounts は共有対象だけを追加・更新する。
 */
function mergeService(existing, shareService, counts) {
  const raw = {
    id: existing.id,
    name: existing.name,
    note: existing.note,
    matchRules: mergeById(existing.matchRules, shareService.matchRules),
    fields: mergeById(existing.fields, shareService.fields),
    sharedValues: { ...existing.sharedValues, ...shareService.sharedValues },
    accounts: mergeAccounts(existing.accounts, shareService.accounts, counts),
  };
  // normalizeService() が locator / frame / values の対応関係を安全側に検証し直す
  // （field 構成が異なっていても、値を別 field へ推測して移さない）。
  const merged = normalizeService(raw);
  merged.createdAt = existing.createdAt;
  merged.updatedAt = Date.now();
  return merged;
}

/**
 * id が一致する要素は共有側の内容で更新し、既存にしかない要素はそのまま残す
 * （未共有アカウントが使う field / matchRule を消さないため）。
 * 共有側にしかない要素は新規として追加する。
 */
function mergeById(existingList, incomingList) {
  const result = existingList.map((item) => ({ ...item }));
  const indexById = new Map(result.map((item, i) => [item.id, i]));
  for (const incoming of incomingList) {
    const cloned = { ...incoming };
    if (indexById.has(incoming.id)) {
      result[indexById.get(incoming.id)] = cloned;
    } else {
      indexById.set(incoming.id, result.length);
      result.push(cloned);
    }
  }
  return result;
}

/** 共有対象の account だけを追加・更新する。共有ファイルに含まれない既存 account は保持する。 */
function mergeAccounts(existingAccounts, incomingAccounts, counts) {
  const result = existingAccounts.map((account) => ({ ...account, values: { ...account.values } }));
  const indexById = new Map(result.map((account, i) => [account.id, i]));
  for (const incoming of incomingAccounts) {
    const cloned = { ...incoming, values: { ...incoming.values } };
    if (indexById.has(incoming.id)) {
      result[indexById.get(incoming.id)] = cloned;
      counts.updates += 1;
    } else {
      indexById.set(incoming.id, result.length);
      result.push(cloned);
      counts.adds += 1;
    }
  }
  return result;
}
