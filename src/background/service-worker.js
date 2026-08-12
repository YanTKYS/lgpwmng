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
import {
  frameDescriptorFromUrl,
  frameDescriptorKey,
  frameDescriptorMatchesProbe,
  normalizeFrameDescriptor,
} from '../lib/frame.js';
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
      return runHighlight(payload);

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

/**
 * タブ内の全フレーム（トップ + frame / iframe）を走査し、候補を集約する。
 * 候補ごとに、後で同じフレームを再特定するための frame 記述子を付与する。
 */
async function scanPage(tabId) {
  const frameResults = await runPageAgentAllFrames(tabId, 'scan', {});
  if (!frameResults.length) {
    throw new Error('ページを走査できませんでした。対象のログイン画面を開いた状態で、拡張アイコンから操作してください。');
  }

  const topEntry = frameResults.find((entry) => entry.frameId === 0);

  // 見つかったフレームそれぞれが報告する子フレーム数の合計（+ トップ自身）と、
  // 実際に走査できたフレーム数を比べ、アクセスできなかったフレームがありそうかを判断する。
  // 厳密な保証ではなく、あくまで利用者への状況表示のための目安。
  let expectedFrameCount = 1;
  for (const entry of frameResults) {
    const count = entry.result && Number.isInteger(entry.result.childFrameCount) ? entry.result.childFrameCount : 0;
    expectedFrameCount += count;
  }
  const partial = frameResults.length < expectedFrameCount;

  const candidates = [];
  for (const entry of frameResults) {
    if (!entry.result || !Array.isArray(entry.result.candidates)) continue;
    const isTop = entry.frameId === 0;
    const frame = frameDescriptorFromUrl(entry.result.url, entry.result.frameName, isTop);
    for (const candidate of entry.result.candidates) {
      candidates.push({ ...candidate, frame });
    }
  }

  const result = {
    url: topEntry && topEntry.result ? topEntry.result.url : null,
    title: topEntry && topEntry.result ? topEntry.result.title : '',
    candidates,
    partial,
  };
  // 走査結果には入力値を含めない（page-agent 側で値そのものは返していない）。
  await chrome.storage.session.set({ [SCAN_KEY]: { ...result, tabId, scannedAt: Date.now() } });
  return result;
}

/** 強調表示。対象入力欄が属するフレームを再特定してから、そのフレーム内でだけ実行する。 */
async function runHighlight({ tabId, locator, frame }) {
  const resolution = await resolveFrame(tabId, frame);
  if (resolution.status === 'not-found') return { ok: false, reason: 'frame-not-found' };
  if (resolution.status === 'ambiguous') return { ok: false, reason: 'frame-ambiguous' };
  if (resolution.status === 'error') return { ok: false, reason: 'frame-error' };
  return runPageAgentInFrame(tabId, resolution.frameId, 'highlight', { locator });
}

/**
 * 指定アカウントの値を対象タブへ入力する。ログインボタンは押下しない。
 *
 * popup を開いた時点の判定結果には依存せず、入力の直前に現在のタブ URL を
 * 取得して照合する。さらにページ側でも location を再確認する（二重確認）。
 * フレーム内の項目は、トップページの条件に加えて、対象フレーム自身の
 * URL も入力直前に再確認する。
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

  const results = await fillAcrossFrames(tabId, entries, service.matchRules, service.name);
  return {
    serviceName: service.name,
    accountName: account.name,
    role: account.role,
    results,
  };
}

/**
 * entries をフレームごとにグループ化し、それぞれ対象フレームを再特定してから入力する。
 * トップフレーム宛ての項目は従来どおりトップフレームへ入力する。
 *
 * 対象フレームが見つからない、または同程度に一致するフレームが複数ある場合は、
 * 「トップURLが一致しているから任意のフレームへ入力してよい」とはせず、
 * 秘密項目は入力しない（fail closed）。通常項目は候補の先頭で弱一致として試す
 * （既存の locator の弱一致と同じ考え方）。
 */
async function fillAcrossFrames(tabId, entries, matchRules, serviceName) {
  const topEntries = entries.filter((entry) => normalizeFrameDescriptor(entry.frame).top);
  const frameEntries = entries.filter((entry) => !normalizeFrameDescriptor(entry.frame).top);
  const results = [];

  if (topEntries.length) {
    const topResult = await runPageAgentInFrame(tabId, 0, 'fill', { entries: topEntries, matchRules });
    if (topResult && topResult.error === 'url-mismatch') {
      throw new Error(`入力を中止しました。現在のページは「${serviceName}」の登録URLと一致しません。`);
    }
    results.push(...resolveFrameFillResult(topResult, topEntries));
  }

  // 同じフレームを指す項目はまとめてフレーム再特定・入力を行う。
  const groups = new Map();
  for (const entry of frameEntries) {
    const descriptor = normalizeFrameDescriptor(entry.frame);
    const key = frameDescriptorKey(descriptor);
    if (!groups.has(key)) groups.set(key, { descriptor, entries: [] });
    groups.get(key).entries.push(entry);
  }

  for (const { descriptor, entries: groupEntries } of groups.values()) {
    const resolution = await resolveFrame(tabId, descriptor);

    if (resolution.status === 'not-found' || resolution.status === 'error') {
      for (const entry of groupEntries) {
        results.push({ fieldId: entry.fieldId, label: entry.label, status: 'frame-not-found' });
      }
      continue;
    }

    if (resolution.status === 'ambiguous') {
      const secretEntries = groupEntries.filter((entry) => entry.kind === 'secret');
      const otherEntries = groupEntries.filter((entry) => entry.kind !== 'secret');
      for (const entry of secretEntries) {
        results.push({ fieldId: entry.fieldId, label: entry.label, status: 'frame-not-found' });
      }
      if (otherEntries.length) {
        const frameCheck = { origin: descriptor.origin, pathname: descriptor.pathname };
        const frameResult = await runPageAgentInFrameSafely(tabId, resolution.frameIds[0], 'fill', { entries: otherEntries, frameCheck });
        results.push(...forceWeak(resolveFrameFillResult(frameResult, otherEntries)));
      }
      continue;
    }

    const frameCheck = { origin: descriptor.origin, pathname: descriptor.pathname };
    const frameResult = await runPageAgentInFrameSafely(tabId, resolution.frameId, 'fill', { entries: groupEntries, frameCheck });
    if (frameResult && frameResult.error === 'url-mismatch') {
      // 対象フレームがその後に遷移した等で、フレーム自身の URL 再確認に失敗した。
      for (const entry of groupEntries) {
        results.push({ fieldId: entry.fieldId, label: entry.label, status: 'not-found' });
      }
      continue;
    }
    results.push(...resolveFrameFillResult(frameResult, groupEntries));
  }

  return sortByEntryOrder(results, entries);
}

/**
 * 結果をフレームごとに集めるため、そのままでは登録した項目の順に並ばない。
 * popup では登録順に並んでいる方が確認しやすいため、entries の順へ並べ直す。
 * 結果が返ってこなかった項目は「入力に失敗」として補い、項目と結果を 1 対 1 にする。
 */
function sortByEntryOrder(results, entries) {
  const byFieldId = new Map(results.map((result) => [result.fieldId, result]));
  return entries.map((entry) => byFieldId.get(entry.fieldId)
    || { fieldId: entry.fieldId, label: entry.label, status: 'error' });
}

function resolveFrameFillResult(frameResult, groupEntries) {
  if (!frameResult || !Array.isArray(frameResult.results)) {
    return groupEntries.map((entry) => ({ fieldId: entry.fieldId, label: entry.label, status: 'error' }));
  }
  return frameResult.results;
}

/** フレームが曖昧な状態で試した結果を、確実ではないものとして扱う。 */
function forceWeak(results) {
  return results.map((entry) => (entry.status === 'filled' ? { ...entry, status: 'filled-weak' } : entry));
}

/**
 * frame 記述子から、現在のタブでの対象 frameId を再特定する。
 * トップフレームの記述子（フレーム情報の無い旧データを含む）は probe 不要で
 * 即座に frameId 0 とみなす。
 *
 * @returns {{status: 'ok', frameId: number} | {status: 'ambiguous', frameIds: number[]} | {status: 'not-found'} | {status: 'error'}}
 */
async function resolveFrame(tabId, rawDescriptor) {
  const descriptor = normalizeFrameDescriptor(rawDescriptor);
  if (descriptor.top) return { status: 'ok', frameId: 0 };

  let probes;
  try {
    probes = await runPageAgentAllFrames(tabId, 'probe', {});
  } catch {
    return { status: 'error' };
  }

  let matches = probes.filter((entry) => entry.frameId !== 0 && entry.result
    && frameDescriptorMatchesProbe(descriptor, entry.result.url));
  if (matches.length > 1 && descriptor.name) {
    const byName = matches.filter((entry) => (entry.result.frameName || '') === descriptor.name);
    if (byName.length) matches = byName;
  }
  if (matches.length === 1) return { status: 'ok', frameId: matches[0].frameId };
  if (matches.length > 1) return { status: 'ambiguous', frameIds: matches.map((entry) => entry.frameId) };
  return { status: 'not-found' };
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

/**
 * タブ内の全フレーム（トップ + アクセスできる frame / iframe）で pageAgent を実行する。
 * activeTab 権限は、拡張アイコンが操作されたタブについて、同一オリジンか
 * どうかによらずフレームへのアクセスも許可する。別オリジンのフレームに
 * アクセスできない場合、chrome.scripting はそのフレームの結果を返さない
 * （＝ frameResults に含まれない）。無理な回避策は取らず、呼び出し側で
 * 「一部のフレームを確認できなかった」ことの目安として扱う。
 *
 * @returns {Array<{frameId: number, result: object}>}
 */
async function runPageAgentAllFrames(tabId, action, payload) {
  if (!Number.isInteger(tabId)) throw new Error('対象タブを特定できません。');
  let injections;
  try {
    injections = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      func: pageAgent,
      args: [action, payload],
    });
  } catch {
    throw new Error('このページへアクセスできません。対象のログイン画面を開いた状態で、拡張アイコンから操作してください。');
  }
  return (injections || [])
    .filter((injection) => injection && injection.result !== undefined && injection.result !== null)
    .map((injection) => ({ frameId: injection.frameId, result: injection.result }));
}

/** 特定の 1 フレームでのみ pageAgent を実行する。 */
async function runPageAgentInFrame(tabId, frameId, action, payload) {
  if (!Number.isInteger(tabId)) throw new Error('対象タブを特定できません。');
  let injection;
  try {
    [injection] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
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

/** runPageAgentInFrame の例外を握りつぶす版。フレーム単位の失敗で全体の入力を止めないために使う。 */
async function runPageAgentInFrameSafely(tabId, frameId, action, payload) {
  try {
    return await runPageAgentInFrame(tabId, frameId, action, payload);
  } catch {
    return null;
  }
}
