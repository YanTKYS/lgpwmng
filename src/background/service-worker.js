/**
 * Service Worker。
 * Vault の復号結果はここだけが保持し、ページ側へは入力に必要な値のみを渡す。
 */

import { MSG } from '../lib/messages.js';
import { findMatchingServices, migrateLegacyRulesForUrl, serviceMatchesUrl } from '../lib/match.js';
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

/**
 * 直前の走査結果の受け渡し先。
 * popup が走査してから設定ページが読み出すまでの一時的な置き場のため、
 * タブごとに貯めず最新の 1 件だけを保持する。
 */
const SCAN_KEY = 'lgpwmng.scan';

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

    case MSG.SERVICE_MATCH:
      return matchForPage(payload);

    case MSG.PAGE_SCAN:
      return scanPage(payload.tabId);

    case MSG.SCAN_RESULT_GET: {
      const stored = (await chrome.storage.session.get(SCAN_KEY))[SCAN_KEY];
      // 別のタブを走査した結果を渡さない（設定ページが誤った入力欄を表示するため）。
      return stored && stored.tabId === payload.tabId ? stored : null;
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

/**
 * 現在のページに対応するサービスを返す。
 *
 * この時点で、protocol 未確定（v0.1.0 形式）の URL 条件のうち現在のページに
 * 該当するものを、実際の origin で確定させて Vault へ保存する。
 * 判定に用いる URL は、可能な限り background 側で取得した値を優先する。
 */
async function matchForPage({ url, tabId }) {
  const vault = await getVault();
  const resolvedUrl = (await readTabUrl(tabId)) || url;
  const migration = migrateLegacyRulesForUrl(vault, resolvedUrl);
  if (migration.changed) await saveVault(vault);
  return {
    url: resolvedUrl,
    services: findMatchingServices(vault, resolvedUrl).map(summarizeService),
    migratedCount: migration.migrated.length,
  };
}

/** タブの URL を取得する。取得できない場合は null（推測はしない）。 */
async function readTabUrl(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab && tab.url ? tab.url : null;
  } catch {
    return null;
  }
}

async function scanPage(tabId) {
  const result = await runPageAgent(tabId, 'scan', {});
  // 走査結果には入力値を含めない（page-agent 側で値そのものは返していない）。
  await chrome.storage.session.set({ [SCAN_KEY]: { ...result, tabId, scannedAt: Date.now() } });
  return result;
}

/**
 * 指定アカウントの値を対象タブへ入力する。ログインボタンは押下しない。
 *
 * popup を開いた時点の判定結果には依存せず、入力の直前に現在のタブ URL を
 * 取得して照合する。さらにページ側でも location を再確認する（二重確認）。
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
  await assertTabMatchesService(tabId, service);

  const entries = buildFillValues(service, account);
  if (!entries.length) throw new Error('入力できる値が登録されていません。');

  const result = await runPageAgent(tabId, 'fill', { entries, matchRules: service.matchRules });
  if (result.error === 'url-mismatch') {
    throw new Error(`入力を中止しました。現在のページは「${service.name}」の登録URLと一致しません。`);
  }
  return {
    serviceName: service.name,
    accountName: account.name,
    role: account.role,
    results: result.results || [],
  };
}

/**
 * 入力直前に現在のタブ URL がサービスの条件に一致するか確認する。
 * URL を取得できない場合も入力しない（fail closed）。
 */
async function assertTabMatchesService(tabId, service) {
  if (!Number.isInteger(tabId)) throw new Error('対象タブを特定できません。');
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error('対象タブを確認できませんでした。ログイン画面を開き直してください。');
  }
  if (!tab || !tab.url) {
    throw new Error('対象タブのURLを確認できませんでした。ログイン画面で拡張アイコンから操作してください。');
  }
  if (!serviceMatchesUrl(service, tab.url)) {
    throw new Error(`入力を中止しました。現在のページは「${service.name}」の登録URLと一致しません。`);
  }
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
