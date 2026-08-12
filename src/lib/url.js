/**
 * URL の共通ユーティリティ。
 *
 * サービスの URL 判定（match.js）とフレームの識別（frame.js）で同じ解釈が
 * 必要なため、双方が参照するここに一本化している。
 */

/**
 * http / https の URL としてのみ解釈する。
 * それ以外（chrome:// や about:blank など）は「対象外」として null を返す。
 *
 * @param {string} value
 * @returns {URL|null}
 */
export function parseHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

/**
 * 比較用にパスを正規化する。末尾の `/` の有無で判定が変わらないようにする。
 * 例: '' -> '/', '/app/' -> '/app'
 *
 * @param {string} pathname
 * @returns {string}
 */
export function normalizePathname(pathname) {
  if (!pathname) return '/';
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return trimmed === '' ? '/' : trimmed;
}

/**
 * 設定画面で入力されたパス条件を、URL の pathname と比較できる形へ整える。
 * 先頭の `/` を補い、クエリ（`?`）以降を落とす。
 * 例: 'login' -> '/login', '/app/' -> '/app', '/app?id=1' -> '/app'
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeRulePathname(value) {
  const raw = String(value || '').trim().split(/[?#]/)[0];
  if (!raw) return '/';
  return normalizePathname(raw.startsWith('/') ? raw : `/${raw}`);
}
