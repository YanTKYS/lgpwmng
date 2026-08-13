/**
 * Vault の保管とロック状態の管理。
 *
 *   chrome.storage.local   … 暗号化済み Vault のみ
 *   chrome.storage.session … アンロック中の導出鍵（ブラウザ終了で消える）
 *   メモリ                 … 復号済み Vault（永続化しない）
 *
 * マスターパスワードそのものは保存しない。
 */

import {
  createKdfParams,
  decryptJson,
  deriveKey,
  encryptJson,
  exportKey,
  importKey,
} from '../lib/crypto.js';
import { BACKUP_FORMAT, SHARE_FORMAT, createVault, normalizeVault } from '../lib/model.js';
import {
  applyShareImport,
  buildImportPlan,
  createShareFile,
  decryptShareFile,
  extractShareServices,
} from '../lib/share.js';

const LOCAL_RECORD_KEY = 'lgpwmng.vault';
const SESSION_KEY_KEY = 'lgpwmng.sessionKey';

export { BACKUP_FORMAT };
const VAULT_FORMAT = 'lgpwmng-vault';

/** 復号済み Vault のメモリキャッシュ。Service Worker 終了時に失われる。 */
let cachedVault = null;
/** アンロック中の導出鍵。 */
let cachedKey = null;

export class VaultLockedError extends Error {
  constructor() {
    super('Vault がロックされています。マスターパスワードを入力してください。');
    this.name = 'VaultLockedError';
  }
}

export async function initSessionStorage() {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // 既定値が TRUSTED_CONTEXTS のため、失敗しても致命的ではない。
  }
}

async function readRecord() {
  const stored = await chrome.storage.local.get(LOCAL_RECORD_KEY);
  return stored[LOCAL_RECORD_KEY] || null;
}

async function writeRecord(record) {
  await chrome.storage.local.set({ [LOCAL_RECORD_KEY]: record });
}

export async function isInitialized() {
  return Boolean(await readRecord());
}

async function rememberKey(key, kdf) {
  cachedKey = key;
  await chrome.storage.session.set({
    [SESSION_KEY_KEY]: { key: await exportKey(key), kdf },
  });
}

/**
 * Service Worker が再起動してもアンロック状態を維持するため、
 * session storage から鍵を復元する。
 */
async function restoreKey() {
  if (cachedKey) return cachedKey;
  const stored = await chrome.storage.session.get(SESSION_KEY_KEY);
  const entry = stored[SESSION_KEY_KEY];
  if (!entry) return null;
  cachedKey = await importKey(entry.key);
  return cachedKey;
}

export async function isUnlocked() {
  return Boolean(await restoreKey());
}

export async function lock() {
  cachedKey = null;
  cachedVault = null;
  await chrome.storage.session.remove(SESSION_KEY_KEY);
}

/** 初回セットアップ。空の Vault を作成して暗号化保存する。 */
export async function createNewVault(password) {
  if (await isInitialized()) throw new Error('Vault は既に作成されています。');
  assertPassword(password);
  const kdf = createKdfParams();
  const key = await deriveKey(password, kdf);
  const vault = createVault();
  await persist(vault, key, kdf);
  await rememberKey(key, kdf);
  cachedVault = vault;
}

export async function unlock(password) {
  const record = await readRecord();
  if (!record) throw new Error('Vault が作成されていません。');
  const key = await deriveKey(password, record.kdf);
  let vault;
  try {
    vault = normalizeVault(await decryptJson(key, { iv: record.iv, data: record.data }));
  } catch {
    throw new Error('マスターパスワードが違います。');
  }
  cachedVault = vault;
  await rememberKey(key, record.kdf);
}

/** 復号済み Vault を取得する。ロック中は例外。 */
export async function getVault() {
  if (cachedVault) return cachedVault;
  const key = await restoreKey();
  if (!key) throw new VaultLockedError();
  const record = await readRecord();
  if (!record) throw new Error('Vault が作成されていません。');
  try {
    cachedVault = normalizeVault(await decryptJson(key, { iv: record.iv, data: record.data }));
  } catch {
    await lock();
    throw new VaultLockedError();
  }
  return cachedVault;
}

/** Vault を暗号化して保存する。 */
export async function saveVault(vault) {
  const key = await restoreKey();
  if (!key) throw new VaultLockedError();
  const record = await readRecord();
  if (!record) throw new Error('Vault が作成されていません。');
  vault.updatedAt = Date.now();
  // 鍵は既存の KDF パラメータから導出済みのため、salt は変更しない。
  await persist(vault, key, record.kdf);
  cachedVault = vault;
}

async function persist(vault, key, kdf) {
  const envelope = await encryptJson(key, vault);
  await writeRecord({
    format: VAULT_FORMAT,
    version: 1,
    kdf,
    iv: envelope.iv,
    data: envelope.data,
    updatedAt: Date.now(),
  });
}

export async function changeMasterPassword(currentPassword, newPassword) {
  const record = await readRecord();
  if (!record) throw new Error('Vault が作成されていません。');
  assertPassword(newPassword);
  const currentKey = await deriveKey(currentPassword, record.kdf);
  let vault;
  try {
    vault = normalizeVault(await decryptJson(currentKey, { iv: record.iv, data: record.data }));
  } catch {
    throw new Error('現在のマスターパスワードが違います。');
  }
  const kdf = createKdfParams();
  const newKey = await deriveKey(newPassword, kdf);
  await persist(vault, newKey, kdf);
  await rememberKey(newKey, kdf);
  cachedVault = vault;
}

/**
 * バックアップを書き出す。平文 JSON では出力せず、必ず暗号化する。
 * バックアップ用パスフレーズは Vault とは独立に指定できる。
 */
export async function exportBackup(passphrase) {
  const vault = await getVault();
  assertPassword(passphrase);
  const kdf = createKdfParams();
  const key = await deriveKey(passphrase, kdf);
  const envelope = await encryptJson(key, vault);
  return {
    format: BACKUP_FORMAT,
    version: 1,
    createdAt: new Date().toISOString(),
    kdf,
    iv: envelope.iv,
    data: envelope.data,
  };
}

/**
 * 復号を試みる前に、バックアップファイルとして必要な項目が揃っているか確認する。
 * 揃っていないまま復号へ進むと「パスフレーズが違います」と誤って案内してしまう。
 */
function isBackupFile(backup) {
  return Boolean(
    backup
    && backup.format === BACKUP_FORMAT
    && backup.kdf
    && typeof backup.kdf.salt === 'string'
    && Number.isFinite(backup.kdf.iterations)
    && typeof backup.iv === 'string'
    && typeof backup.data === 'string',
  );
}

/**
 * バックアップを読み込む。
 * @param {object} backup
 * @param {string} passphrase
 * @param {'replace'|'merge'} mode
 */
export async function importBackup(backup, passphrase, mode) {
  if (backup && backup.format === SHARE_FORMAT) {
    throw new Error('これは共有用ファイルです。「バックアップを復元」ではなく「共有用ファイルを取り込む」から読み込んでください。');
  }
  if (!isBackupFile(backup)) {
    throw new Error('バックアップファイルの形式が不正です。lgpwmng で書き出したファイルを選択してください。');
  }
  let imported;
  try {
    const key = await deriveKey(passphrase, backup.kdf);
    imported = normalizeVault(await decryptJson(key, { iv: backup.iv, data: backup.data }));
  } catch {
    throw new Error('バックアップのパスフレーズが違うか、ファイルが壊れています。');
  }
  const current = await getVault();
  if (mode === 'merge') {
    const existingIds = new Set(current.services.map((service) => service.id));
    const added = imported.services.filter((service) => !existingIds.has(service.id));
    current.services = current.services.concat(added);
    await saveVault(current);
    return { imported: added.length, total: current.services.length };
  }
  current.services = imported.services;
  await saveVault(current);
  return { imported: imported.services.length, total: current.services.length };
}

/**
 * アカウント共有用のエクスポート。
 * マスターバックアップ（Vault 全体）とは別の独立した形式（lgpwmng-share）で出力する。
 * 選択していないアカウント・サービスは一切含めない。
 *
 * @param {{[serviceId: string]: string[]}} selection サービスIDごとに選択した accountId
 * @param {string} passphrase 共有用パスフレーズ（Vault のマスターパスワードとは独立）
 */
export async function exportShare(selection, passphrase) {
  const vault = await getVault();
  assertPassword(passphrase);
  const services = extractShareServices(vault, selection);
  return createShareFile(services, passphrase);
}

/**
 * 共有ファイルを復号し、現在の Vault に対して何が追加・更新されるかの計画を返す。
 * Vault へは反映しない（取り込み前の内容確認用）。
 */
export async function previewShareImport(shareFile, passphrase) {
  const services = await decryptShareFile(shareFile, passphrase);
  const vault = await getVault();
  return buildImportPlan(vault, services);
}

/**
 * 共有ファイルを取り込む。
 * `current.services = imported.services` のような Vault 全体の置換は行わない。
 * 共有ファイルに含まれる対象（サービス／アカウント）だけを追加・更新し、
 * 個人サービス・個人アカウント・他の共有アカウント・利用者独自設定は維持する。
 */
export async function importShare(shareFile, passphrase) {
  const services = await decryptShareFile(shareFile, passphrase);
  const vault = await getVault();
  const result = applyShareImport(vault, services);
  await saveVault(vault);
  return result;
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('パスワードは 8 文字以上で指定してください。');
  }
}
