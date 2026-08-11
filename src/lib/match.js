/**
 * URL からサービスを判定する処理。
 * ドメイン単位ではなく hostname + pathname で判定し、
 * 同一ドメイン配下でも path 違いを別サービスとして扱えるようにする。
 */

import { HOSTNAME_MODE, PATHNAME_MODE, createMatchRule } from './model.js';

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

function hostMatches(rule, hostname) {
  const target = hostname.toLowerCase();
  const expected = (rule.hostname || '').toLowerCase().replace(/^\.+/, '');
  if (!expected) return false;
  if (rule.hostnameMode === HOSTNAME_MODE.SUFFIX) {
    return target === expected || target.endsWith(`.${expected}`);
  }
  return target === expected;
}

function pathMatches(rule, pathname) {
  if (rule.pathnameMode === PATHNAME_MODE.ANY) return true;
  const target = normalizePath(pathname);
  const expected = normalizePath(rule.pathname || '/');
  if (rule.pathnameMode === PATHNAME_MODE.PREFIX) {
    return target === expected || target.startsWith(expected === '/' ? '/' : `${expected}/`);
  }
  return target === expected;
}

/** ルール単体の一致判定。 */
export function ruleMatches(rule, url) {
  return hostMatches(rule, url.hostname) && pathMatches(rule, url.pathname);
}

/**
 * 一致の「厳密さ」。複数サービスが一致した場合の優先順位に使う。
 * exact 指定・長い path ほど優先される。
 */
function ruleScore(rule) {
  let score = 0;
  score += rule.hostnameMode === HOSTNAME_MODE.EXACT ? 100 : 40;
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
    hostname: url.hostname,
    hostnameMode: HOSTNAME_MODE.EXACT,
    pathname: normalizePath(url.pathname),
    pathnameMode: PATHNAME_MODE.EXACT,
  });
}

/** ルールを人間可読な 1 行表記にする。 */
export function describeRule(rule) {
  const host = rule.hostnameMode === HOSTNAME_MODE.SUFFIX ? `*.${rule.hostname}` : rule.hostname;
  if (rule.pathnameMode === PATHNAME_MODE.ANY) return `${host}（パス問わず）`;
  const path = normalizePath(rule.pathname);
  return rule.pathnameMode === PATHNAME_MODE.PREFIX ? `${host}${path}/*` : `${host}${path}`;
}
