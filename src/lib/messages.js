/**
 * 拡張内部のメッセージ種別。
 * content script へは Vault を渡さず、必要な値のみを背景側から注入する。
 */

export const MSG = {
  VAULT_STATUS: 'vault/status',
  VAULT_CREATE: 'vault/create',
  VAULT_UNLOCK: 'vault/unlock',
  VAULT_LOCK: 'vault/lock',
  VAULT_CHANGE_PASSWORD: 'vault/change-password',
  VAULT_EXPORT: 'vault/export',
  VAULT_IMPORT: 'vault/import',

  SERVICE_LIST: 'service/list',
  SERVICE_GET: 'service/get',
  SERVICE_SAVE: 'service/save',
  SERVICE_DELETE: 'service/delete',
  SERVICE_MATCH: 'service/match',

  PAGE_SCAN: 'page/scan',
  PAGE_HIGHLIGHT: 'page/highlight',
  SCAN_RESULT_GET: 'scan/get',

  FILL_RUN: 'fill/run',
};

/** background へ要求を送り、失敗時は例外にする。 */
export async function request(type, payload = {}) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type, payload });
  } catch {
    // 拡張の再読み込み直後などに発生する。原文のままだと英語のまま表示されるため置き換える。
    throw new Error('拡張機能と通信できませんでした。画面を開き直してください。');
  }
  if (!response) throw new Error('拡張機能が応答しませんでした。');
  if (!response.ok) throw new Error(response.error || '処理に失敗しました。');
  return response.data;
}
