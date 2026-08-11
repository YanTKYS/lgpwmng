/**
 * Service Worker。
 * Vault の復号結果はここだけが保持し、ページ側へは入力に必要な値のみを渡す。
 */

import { MSG } from '../lib/messages.js';
import { findMatchingServices } from '../lib/match.js';
import {
  ACCOUNT_ROLE,
  buildFillValues,
  normalizeService,
  summarizeService,
} from '../lib/model.js';
import { pageAgent } from './page-agent.js';
import {
  changeMasterPassword,
  createNewVault,
  exportBackup,
  getVault,
  importBackup,
  initSessionStorage,
  isInitialized,
  isUnlocked,
  lock,
  saveVault,
  unlock,
} from './vault-store.js';

const SCAN_PREFIX = 'lgpwmng.scan.';

initSessionStorage();

chrome.runtime.onInstalled.addListener(() => {
  initSessionStorage();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: toMessage(error) }));
  return true; // 非同期応答
});

function toMessage(error) {
  if (error && typeof error.message === 'string') return error.message;
  return '処理に失敗しました。';
}

async function handle(message) {
  const payload = (message && message.payload) || {};
  switch (message && message.type) {
    case MSG.VAULT_STATUS:
      return { initialized: await isInitialized(), unlocked: await isUnlocked() };

    case MSG.VAULT_CREATE:
      await createNewVault(payload.password);
      return { unlocked: true };

    case MSG.VAULT_UNLOCK:
      await unlock(payload.password);
      return { unlocked: true };

    case MSG.VAULT_LOCK:
      await lock();
      return { unlocked: false };

    case MSG.VAULT_CHANGE_PASSWORD:
      await changeMasterPassword(payload.currentPassword, payload.newPassword);
      return { changed: true };

    case MSG.VAULT_EXPORT:
      return exportBackup(payload.passphrase);

    case MSG.VAULT_IMPORT:
      return importBackup(payload.backup, payload.passphrase, payload.mode === 'merge' ? 'merge' : 'replace');

    case MSG.SERVICE_LIST: {
      const vault = await getVault();
      return { services: vault.services.map(summarizeService) };
    }

    case MSG.SERVICE_GET: {
      const vault = await getVault();
      const service = vault.services.find((entry) => entry.id === payload.serviceId);
      if (!service) throw new Error('サービスが見つかりません。');
      return { service };
    }

    case MSG.SERVICE_SAVE:
      return saveService(payload.service);

    case MSG.SERVICE_DELETE: {
      const vault = await getVault();
      const index = vault.services.findIndex((entry) => entry.id === payload.serviceId);
      if (index < 0) throw new Error('サービスが見つかりません。');
      vault.services.splice(index, 1);
      await saveVault(vault);
      return { deleted: true };
    }

    case MSG.SERVICE_MATCH: {
      const vault = await getVault();
      return { services: findMatchingServices(vault, payload.url).map(summarizeService) };
    }

    case MSG.PAGE_SCAN:
      return scanPage(payload.tabId);

    case MSG.SCAN_RESULT_GET: {
      const key = SCAN_PREFIX + payload.tabId;
      const stored = await chrome.storage.session.get(key);
      return stored[key] || null;
    }

    case MSG.PAGE_HIGHLIGHT:
      return runPageAgent(payload.tabId, 'highlight', { locator: payload.locator });

    case MSG.FILL_RUN:
      return runFill(payload);

    default:
      throw new Error('不明な要求です。');
  }
}

async function saveService(rawService) {
  const vault = await getVault();
  const service = normalizeService(rawService);
  if (!service.name.trim()) throw new Error('サービス名を入力してください。');
  service.updatedAt = Date.now();
  const index = vault.services.findIndex((entry) => entry.id === service.id);
  if (index >= 0) {
    service.createdAt = vault.services[index].createdAt;
    vault.services[index] = service;
  } else {
    vault.services.push(service);
  }
  await saveVault(vault);
  return { serviceId: service.id };
}

async function scanPage(tabId) {
  const result = await runPageAgent(tabId, 'scan', {});
  const key = SCAN_PREFIX + tabId;
  // 走査結果には入力値を含めない（page-agent 側で値そのものは返していない）。
  await chrome.storage.session.set({ [key]: { ...result, scannedAt: Date.now() } });
  return result;
}

/**
 * 指定アカウントの値を対象タブへ入力する。ログインボタンは押下しない。
 */
async function runFill({ tabId, serviceId, accountId, confirmAdmin }) {
  const vault = await getVault();
  const service = vault.services.find((entry) => entry.id === serviceId);
  if (!service) throw new Error('サービスが見つかりません。');
  const account = service.accounts.find((entry) => entry.id === accountId);
  if (!account) throw new Error('アカウントが見つかりません。');
  if (account.role === ACCOUNT_ROLE.ADMIN && confirmAdmin !== true) {
    throw new Error('管理者アカウントの使用が確認されていません。');
  }
  const entries = buildFillValues(service, account);
  if (!entries.length) throw new Error('入力できる値が登録されていません。');

  const result = await runPageAgent(tabId, 'fill', { entries });
  return {
    serviceName: service.name,
    accountName: account.name,
    role: account.role,
    results: result.results || [],
  };
}

async function runPageAgent(tabId, action, payload) {
  if (!Number.isInteger(tabId)) throw new Error('対象タブを特定できません。');
  let injection;
  try {
    [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: pageAgent,
      args: [action, payload],
    });
  } catch {
    throw new Error('このページへアクセスできません。対象のログイン画面を開いた状態で、拡張アイコンから操作してください。');
  }
  if (!injection || injection.result === undefined || injection.result === null) {
    throw new Error('ページの処理結果を取得できませんでした。');
  }
  return injection.result;
}
