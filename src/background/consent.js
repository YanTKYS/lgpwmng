/**
 * データ利用に関する初回同意の記録。
 *
 * Chrome ウェブストアは、ユーザーデータを扱う拡張について、取得より前に
 * 「何を・何のために扱うか」を UI 上で目立つ形で示し、利用者が明示的に同意する
 * 操作を経ることを求めている。lgpwmng は現在のページの URL・入力欄の構造・
 * 入力済みの値（認証情報を含む）を扱うため、同意を得るまでこれらに触れない。
 *
 * 保存するのは同意したバージョンだけで、認証情報とは無関係のため
 * chrome.storage.local へ平文で置く（Vault の暗号化とは独立）。
 * 扱うデータの内容を変えたときは CONSENT_VERSION を上げて再同意を求める。
 */

const CONSENT_KEY = 'lgpwmng.consent';

/** 現在の開示内容のバージョン。開示内容を変えたら上げる。 */
export const CONSENT_VERSION = 1;

/**
 * 同意状態を返す。
 * @returns {Promise<{granted: boolean, version: number, requiredVersion: number}>}
 */
export async function getConsent() {
  let stored;
  try {
    stored = (await chrome.storage.local.get(CONSENT_KEY))[CONSENT_KEY];
  } catch {
    // 読み出せない場合は未同意として扱う（先に進めない側へ倒す）。
    stored = null;
  }
  const version = stored && Number.isInteger(stored.privacyConsentVersion)
    ? stored.privacyConsentVersion
    : 0;
  return { granted: version >= CONSENT_VERSION, version, requiredVersion: CONSENT_VERSION };
}

/** 現在のバージョンへの同意を記録する。 */
export async function grantConsent() {
  await chrome.storage.local.set({
    [CONSENT_KEY]: { privacyConsentVersion: CONSENT_VERSION, grantedAt: Date.now() },
  });
  return { granted: true, version: CONSENT_VERSION, requiredVersion: CONSENT_VERSION };
}

export class ConsentRequiredError extends Error {
  constructor() {
    super('データ利用への同意が必要です。拡張アイコンから同意画面を確認してください。');
    this.name = 'ConsentRequiredError';
  }
}

/**
 * 同意が済んでいなければ例外にする。
 * ページへ触れる処理（走査・取り込み・入力・URL 照合）の前に呼ぶ。
 */
export async function requireConsent() {
  const consent = await getConsent();
  if (!consent.granted) throw new ConsentRequiredError();
}
