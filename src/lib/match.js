/**
 * URL からサービスを判定する処理。
 *
 * 判定は origin（プロトコル + ホスト名 + ポート）と pathname で行う。
 * http と https は別のものとして扱い、同一ドメイン配下でも path 違いを
 * 別サービスとして登録できるようにする。
 */

import { ORIGIN_MODE, PATHNAME_MODE, createMatchRule } from './model.js';

/** @param {string} rawUrl @returns {URL|null} */
export function parseUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

function normalizePath(pathname) {
  if (!pathname) return '/';
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return trimmed === '' ? '/' : trimmed;
}

function originMatches(rule, url) {
  if (!rule.origin) return false;
  if (rule.originMode !== ORIGIN_MODE.SUFFIX) {
    return url.origin.toLowerCase() === rule.origin.toLowerCase();
  }
  // サブドメイン一致。プロトコルとポートは一致していなければならない。
  let expected;
  try {
    expected = new URL(rule.origin);
  } catch {
    return false;
  }
  if (expected.protocol !== url.protocol || expected.port !== url.port) return false;
  const host = url.hostname.toLowerCase();
  const base = expected.hostname.toLowerCase();
  return host === base || host.endsWith(`.${base}`);
}

function pathMatches(rule, url) {
  if (rule.pathnameMode === PATHNAME_MODE.ANY) return true;
  const target = normalizePath(url.pathname);
  const expected = normalizePath(rule.pathname || '/');
  if (rule.pathnameMode === PATHNAME_MODE.PREFIX) {
    return target === expected || target.startsWith(expected === '/' ? '/' : `${expected}/`);
  }
  return target === expected;
}

/** ルール単体の一致判定。 */
export function ruleMatches(rule, url) {
  return originMatches(rule, url) && pathMatches(rule, url);
}

/**
 * サービスが URL に一致するか。入力直前の再確認にも利用する。
 * @param {{matchRules: Array}} service
 * @param {string} rawUrl
 */
export function serviceMatchesUrl(service, rawUrl) {
  const url = parseUrl(rawUrl);
  if (!url) return false;
  return service.matchRules.some((rule) => ruleMatches(rule, url));
}

/**
 * 一致の「厳密さ」。複数サービスが一致した場合の優先順位に使う。
 * exact 指定・長い path ほど優先される。
 */
function ruleScore(rule) {
  let score = rule.originMode === ORIGIN_MODE.EXACT ? 100 : 40;
  if (rule.pathnameMode === PATHNAME_MODE.EXACT) score += 100 + normalizePath(rule.pathname).length;
  else if (rule.pathnameMode === PATHNAME_MODE.PREFIX) score += 50 + normalizePath(rule.pathname).length;
  return score;
}

/**
 * URL に一致するサービスを、厳密な順に並べて返す。
 * @param {{services: Array}} vault
 * @param {string} rawUrl
 */
export function findMatchingServices(vault, rawUrl) {
  const url = parseUrl(rawUrl);
  if (!url) return [];
  const matched = [];
  for (const service of vault.services) {
    let best = -1;
    for (const rule of service.matchRules) {
      if (ruleMatches(rule, url)) best = Math.max(best, ruleScore(rule));
    }
    if (best >= 0) matched.push({ service, score: best });
  }
  matched.sort((a, b) => b.score - a.score || a.service.name.localeCompare(b.service.name, 'ja'));
  return matched.map((entry) => entry.service);
}

/** 現在の URL から既定のマッチ条件を作る（登録支援用）。 */
export function suggestRuleFromUrl(rawUrl) {
  const url = parseUrl(rawUrl);
  if (!url) return createMatchRule();
  return createMatchRule({
    origin: url.origin,
    originMode: ORIGIN_MODE.EXACT,
    pathname: normalizePath(url.pathname),
    pathnameMode: PATHNAME_MODE.EXACT,
  });
}

/** ルールを人間可読な 1 行表記にする。 */
export function describeRule(rule) {
  const origin = rule.originMode === ORIGIN_MODE.SUFFIX
    ? rule.origin.replace('://', '://*.')
    : rule.origin;
  if (rule.pathnameMode === PATHNAME_MODE.ANY) return `${origin}（パス問わず）`;
  const path = normalizePath(rule.pathname);
  return rule.pathnameMode === PATHNAME_MODE.PREFIX ? `${origin}${path}/*` : `${origin}${path}`;
}
