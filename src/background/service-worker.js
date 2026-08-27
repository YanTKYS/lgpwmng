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
import { getConsent, grantConsent, requireConsent } from './consent.js';
import { pageAgent } from './page-agent.js';
import {
  changeMasterPassword,
  createNewVault,
  exportBackup,
  exportShare,
  getVault,
  importBackup,
  importShare,
  initSessionStorage,
  isInitialized,
  isUnlocked,
  lock,
  previewShareImport,
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
    case MSG.CONSENT_STATUS:
      return getConsent();

    case MSG.CONSENT_GRANT:
      return grantConsent();

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

    case MSG.SHARE_EXPORT:
      return exportShare(payload.selection, payload.passphrase);

    case MSG.SHARE_IMPORT_PREVIEW:
      return previewShareImport(payload.file, payload.passphrase);

    case MSG.SHARE_IMPORT_COMMIT:
      return importShare(payload.file, payload.passphrase);

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

    // ここから下はページへ触れる処理。UI 側の制御だけに頼らず、
    // background でも同意済みかを確認する。
    case MSG.SERVICE_MATCH:
      await requireConsent();
      return matchForPage(payload);

    case MSG.PAGE_SCAN:
      await requireConsent();
      return scanPage(payload.tabId);

    case MSG.PAGE_CAPTURE:
      await requireConsent();
      return capturePage(payload.tabId);

    case MSG.SCAN_RESULT_GET: {
      // 新たに走査するわけではないが、SCAN_KEY には過去にページから取得した
      // 入力欄の構造が入っている。更新直後にまだ同意していない場合へ備えて、
      // 読み出しにも同意を求める。
      await requireConsent();
      const stored = (await chrome.storage.session.get(SCAN_KEY))[SCAN_KEY];
      // 別のタブを走査した結果を渡さない（設定ページが誤った入力欄を表示するため）。
      return stored && stored.tabId === payload.tabId ? stored : null;
    }

    case MSG.PAGE_HIGHLIGHT:
      await requireConsent();
      return runHighlight(payload);

    case MSG.FILL_RUN:
      await requireConsent();
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
 * この時点で、protocol 未確定（schemaVersion 1 形式）の URL 条件のうち現在のページに
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
  const frameResults = await runInAllFrames(tabId, 'scan', {});
  if (!frameResults.length) {
    throw new Error('ページを走査できませんでした。対象のログイン画面を開いた状態で、拡張アイコンから操作してください。');
  }

  const candidates = [];
  for (const entry of frameResults) {
    const frame = frameDescriptorFromUrl(entry.result.url, entry.result.frameName, entry.frameId === 0);
    for (const candidate of asArray(entry.result.candidates)) {
      candidates.push({ ...candidate, frame });
    }
  }

  const top = frameResults.find((entry) => entry.frameId === 0);
  const result = {
    url: top ? top.result.url : null,
    title: top ? top.result.title : '',
    candidates,
    partial: hasUnreachableFrames(frameResults),
  };
  // 走査結果には入力値を含めない（page-agent 側で値そのものは返していない）。
  await chrome.storage.session.set({ [SCAN_KEY]: { ...result, tabId, scannedAt: Date.now() } });
  return result;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 走査できなかったフレームがありそうか。
 *
 * 各フレームが報告した子フレーム数の合計（+ トップ自身）と、実際に結果を返した
 * フレーム数を比べる。厳密な保証ではなく、利用者への状況表示のための目安。
 */
function hasUnreachableFrames(frameResults) {
  const expected = frameResults.reduce(
    (total, entry) => total + (Number(entry.result.childFrameCount) || 0),
    1,
  );
  return frameResults.length < expected;
}

/**
 * ログイン画面に入力済みの値を、全フレームから 1 回だけ取得する。
 *
 * scan とは別のアクション（'capture'）として実行し、走査（入力欄の構造）とは
 * 責務を分ける。呼び出すのは、利用者が「このログイン画面を設定」を実行した
 * ときだけ（新規サービスの設定を開始した直後）で、常駐監視は行わない。
 *
 * 取得した値はどこにも保存せず、メッセージの応答としてそのまま呼び出し元
 * （setup ページ）へ返す。scanPage() のように chrome.storage.session へ
 * 保存することはしない（秘密情報を一時ストレージへ平文で残さないため）。
 */
async function capturePage(tabId) {
  const frameResults = await runInAllFrames(tabId, 'capture', {});
  const values = [];
  for (const entry of frameResults) {
    const frame = frameDescriptorFromUrl(entry.result.url, entry.result.frameName, entry.frameId === 0);
    for (const item of asArray(entry.result.values)) {
      values.push({ locator: item.locator, value: item.value, frame });
    }
  }
  return { values };
}

/** 強調表示。対象入力欄が属するフレームを再特定してから、そのフレーム内でだけ実行する。 */
async function runHighlight({ tabId, locator, frame }) {
  const descriptor = normalizeFrameDescriptor(frame);
  let frameId = 0;
  if (!descriptor.top) {
    const frames = await probeFrames(tabId);
    if (!frames) return { ok: false, reason: 'frame-error' };
    const frameIds = matchFrames(frames, descriptor);
    if (!frameIds.length) return { ok: false, reason: 'frame-not-found' };
    if (frameIds.length > 1) return { ok: false, reason: 'frame-ambiguous' };
    frameId = frameIds[0];
  }
  return runInFrame(tabId, frameId, 'highlight', { locator });
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
 * トップフレーム宛ての項目はトップフレームへ入力する。
 */
async function fillAcrossFrames(tabId, entries, matchRules, serviceName) {
  const topEntries = [];
  // 同じフレームを指す項目はまとめてフレーム再特定・入力を行う。
  const groups = new Map();
  for (const entry of entries) {
    const descriptor = normalizeFrameDescriptor(entry.frame);
    if (descriptor.top) {
      topEntries.push(entry);
      continue;
    }
    const key = frameDescriptorKey(descriptor);
    if (!groups.has(key)) groups.set(key, { descriptor, entries: [] });
    groups.get(key).entries.push(entry);
  }

  const results = [];
  if (topEntries.length) {
    const topResult = await runInFrame(tabId, 0, 'fill', { entries: topEntries, matchRules });
    if (topResult && topResult.error === 'url-mismatch') {
      throw new Error(`入力を中止しました。現在のページは「${serviceName}」の登録URLと一致しません。`);
    }
    results.push(...toFillResults(topResult, topEntries));
  }

  if (groups.size) {
    // フレーム構成の確認は入力 1 回につき 1 度だけ行い、全グループで使い回す。
    const frames = await probeFrames(tabId);
    for (const group of groups.values()) {
      results.push(...await fillFrameGroup(tabId, frames, group));
    }
  }

  return sortByEntryOrder(results, entries);
}

/**
 * 同じフレームを指す項目をまとめて入力する。
 *
 * 対象フレームが見つからない、または同程度に一致するフレームが複数ある場合は、
 * 「トップURLが一致しているから任意のフレームへ入力してよい」とはせず、
 * 秘密項目は入力しない（fail closed）。通常項目は候補の先頭で弱一致として試す
 * （既存の locator の弱一致と同じ考え方）。
 *
 * @param {Array|null} frames probeFrames の結果。null は確認できなかったことを表す。
 */
async function fillFrameGroup(tabId, frames, { descriptor, entries }) {
  const frameIds = frames ? matchFrames(frames, descriptor) : [];
  if (!frameIds.length) return entries.map((entry) => statusFor(entry, 'frame-not-found'));

  // フレームを一つに絞り込めない場合、秘密項目は入力せず、通常項目のみ先頭のフレームで試す。
  const ambiguous = frameIds.length > 1;
  const skipped = ambiguous
    ? entries.filter((entry) => entry.kind === 'secret').map((entry) => statusFor(entry, 'frame-not-found'))
    : [];
  const targets = ambiguous ? entries.filter((entry) => entry.kind !== 'secret') : entries;
  if (!targets.length) return skipped;

  const frameCheck = { origin: descriptor.origin, pathname: descriptor.pathname };
  const frameResult = await runInFrameSafely(tabId, frameIds[0], 'fill', { entries: targets, frameCheck });
  if (frameResult && frameResult.error === 'url-mismatch') {
    // 対象フレームがその後に遷移した等で、フレーム自身の URL 再確認に失敗した。
    return skipped.concat(targets.map((entry) => statusFor(entry, 'not-found')));
  }
  const filled = toFillResults(frameResult, targets);
  return skipped.concat(ambiguous ? forceWeak(filled) : filled);
}

function statusFor(entry, status) {
  return { fieldId: entry.fieldId, label: entry.label, status };
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

/** ページから結果が返らなかった項目は「入力に失敗」として扱う。 */
function toFillResults(frameResult, entries) {
  if (!frameResult || !Array.isArray(frameResult.results)) {
    return entries.map((entry) => statusFor(entry, 'error'));
  }
  return frameResult.results;
}

/** フレームが曖昧な状態で試した結果を、確実ではないものとして扱う。 */
function forceWeak(results) {
  return results.map((entry) => (entry.status === 'filled' ? { ...entry, status: 'filled-weak' } : entry));
}

/**
 * タブ内のフレーム構成を確認する。
 * @returns {Promise<Array<{frameId: number, result: {url: string, frameName: string}}>|null>}
 *   確認できなかった場合は null。
 */
async function probeFrames(tabId) {
  try {
    return await runInAllFrames(tabId, 'probe', {});
  } catch {
    return null;
  }
}

/**
 * 登録済みの frame 記述子に該当する frameId を、現在のフレーム構成から探す。
 * URL（origin + pathname）で絞り、それでも複数残る場合はフレーム名で絞る。
 *
 * @returns {number[]} 該当する frameId。0 件なら見つからず、2 件以上なら絞り込めていない。
 */
function matchFrames(frames, descriptor) {
  const matches = frames.filter((entry) => entry.frameId !== 0 && entry.result
    && frameDescriptorMatchesProbe(descriptor, entry.result.url));
  if (matches.length > 1 && descriptor.name) {
    const byName = matches.filter((entry) => (entry.result.frameName || '') === descriptor.name);
    if (byName.length) return byName.map((entry) => entry.frameId);
  }
  return matches.map((entry) => entry.frameId);
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
 * 対象ページで pageAgent を実行する。
 *
 * activeTab 権限は、拡張アイコンが操作されたタブについて、同一オリジンか
 * どうかによらずフレームへのアクセスも許可する。別オリジンのフレームに
 * アクセスできない場合、chrome.scripting はそのフレームの結果を返さない。
 * 無理な回避策は取らず、結果を返したフレームだけを返す。
 *
 * @param {{allFrames: true}|{frameIds: number[]}} where 実行するフレームの指定
 * @returns {Promise<Array<{frameId: number, result: object}>>}
 */
async function runPageAgent(tabId, where, action, payload) {
  if (!Number.isInteger(tabId)) throw new Error('対象タブを特定できません。');
  let injections;
  try {
    injections = await chrome.scripting.executeScript({
      target: { tabId, ...where },
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

/** タブ内の全フレーム（トップ + アクセスできる frame / iframe）で実行する。 */
function runInAllFrames(tabId, action, payload) {
  return runPageAgent(tabId, { allFrames: true }, action, payload);
}

/** 特定の 1 フレームでのみ実行する。結果を取得できなければ例外。 */
async function runInFrame(tabId, frameId, action, payload) {
  const [entry] = await runPageAgent(tabId, { frameIds: [frameId] }, action, payload);
  if (!entry) throw new Error('ページの処理結果を取得できませんでした。');
  return entry.result;
}

/** runInFrame の例外を握りつぶす版。フレーム単位の失敗で全体の入力を止めないために使う。 */
async function runInFrameSafely(tabId, frameId, action, payload) {
  try {
    return await runInFrame(tabId, frameId, action, payload);
  } catch {
    return null;
  }
}
