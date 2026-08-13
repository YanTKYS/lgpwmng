/**
 * アカウント共有（選択したサービス／アカウントだけの共有用エクスポート／インポート）の UI。
 *
 * マスターバックアップ（Vault 全体の保全・復旧、options.js の #form-export / #form-import）
 * とは別の導線として分離している。共有用パスフレーズはここで入力欄に保持している間だけ使い、
 * chrome.storage / localStorage / Vault のいずれにも保存しない。処理完了後は入力欄もクリアする。
 */

import { MSG, request } from '../lib/messages.js';
import { ACCOUNT_ROLE } from '../lib/model.js';
import { $, clear, el, setStatus } from '../ui/dom.js';
import { downloadJson, timestamp } from '../ui/download.js';

/**
 * @param {{onImported?: () => (void|Promise<void>)}} [options]
 *   共有インポートが Vault へ反映された後に呼ばれる（サービス一覧・編集中サービスの再読込用）。
 *   これを行わないと、インポート前から開いていた編集画面が古い accounts のまま残り、
 *   その状態でアカウントを自動保存すると直前のインポート結果を上書きしてしまう。
 */
export function createSharePanel({ onImported } = {}) {
  const exportDialog = $('#share-export-dialog');
  const importDialog = $('#share-import-dialog');

  // --- 共有用ファイルを作成 -----------------------------------------------------

  /** サービスID → 選択した accountId の集合。 */
  const selection = new Map();

  function selectedCount() {
    let total = 0;
    for (const set of selection.values()) total += set.size;
    return total;
  }

  function hasAdminSelected(services) {
    return services.some((service) => {
      const set = selection.get(service.id);
      if (!set || !set.size) return false;
      return service.accounts.some((account) => set.has(account.id) && account.role === ACCOUNT_ROLE.ADMIN);
    });
  }

  /** 選択件数と管理者警告を1か所で更新する。個別選択・全選択・初期描画のすべてから呼ぶ。 */
  function renderExportState(services) {
    $('#share-export-count', exportDialog).textContent = `選択中: ${selectedCount()}件`;
    $('#share-export-admin-notice', exportDialog).classList.toggle('hidden', !hasAdminSelected(services));
  }

  function renderExportServices(body, services) {
    clear(body);
    if (!services.length) {
      body.append(el('p', { className: 'small muted', text: 'サービスが登録されていません。' }));
      return;
    }
    for (const service of services) {
      if (!selection.has(service.id)) selection.set(service.id, new Set());
      const set = selection.get(service.id);

      const rows = service.accounts.map((account) => {
        const checkbox = el('input', {
          attrs: { type: 'checkbox' },
          props: { checked: set.has(account.id) },
          on: {
            change: () => {
              if (checkbox.checked) set.add(account.id);
              else set.delete(account.id);
              renderExportState(services);
            },
          },
        });
        return el('label', { className: 'row share-account-row' }, [
          checkbox,
          el('span', { text: account.name || '(名称未設定)' }),
          account.role === ACCOUNT_ROLE.ADMIN ? el('span', { className: 'badge admin', text: '管理者' }) : null,
        ]);
      });

      const selectAll = el('button', {
        className: 'link',
        text: '全選択/解除',
        attrs: { type: 'button' },
        on: {
          click: () => {
            const allSelected = service.accounts.length > 0 && service.accounts.every((account) => set.has(account.id));
            set.clear();
            if (!allSelected) for (const account of service.accounts) set.add(account.id);
            renderExportServices(body, services);
          },
        },
      });

      body.append(el('div', { className: 'share-service-group' }, [
        el('div', { className: 'row block-head' }, [
          el('strong', { text: service.name || '(名称未設定)' }),
          el('span', { className: 'spacer' }),
          selectAll,
        ]),
        ...rows,
      ]));
    }
    renderExportState(services);
  }

  async function openExport() {
    selection.clear();
    setStatus($('#share-export-status', exportDialog), '');
    $('#share-export-passphrase', exportDialog).value = '';
    $('#share-export-passphrase-confirm', exportDialog).value = '';
    $('#share-export-admin-notice', exportDialog).classList.add('hidden');
    const body = $('#share-export-services', exportDialog);
    clear(body);
    body.append(el('p', { className: 'small muted', text: '読み込み中…' }));
    exportDialog.showModal();
    try {
      const result = await request(MSG.SERVICE_LIST);
      renderExportServices(body, result.services);
    } catch (error) {
      clear(body);
      body.append(el('p', { className: 'small muted', text: error.message }));
    }
  }

  $('#btn-share-export-open').addEventListener('click', () => { openExport(); });
  $('#btn-share-export-cancel', exportDialog).addEventListener('click', () => exportDialog.close());

  $('#share-export-form', exportDialog).addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('#share-export-status', exportDialog);
    if (!selectedCount()) {
      setStatus(status, '共有するアカウントを1つ以上選択してください。', 'error');
      return;
    }
    const passInput = $('#share-export-passphrase', exportDialog);
    const confirmInput = $('#share-export-passphrase-confirm', exportDialog);
    if (passInput.value !== confirmInput.value) {
      setStatus(status, 'パスフレーズが一致しません。', 'error');
      return;
    }
    const payload = {};
    for (const [serviceId, set] of selection.entries()) {
      if (set.size) payload[serviceId] = Array.from(set);
    }
    try {
      const file = await request(MSG.SHARE_EXPORT, { selection: payload, passphrase: passInput.value });
      downloadJson(file, `lgpwmng-share-${timestamp()}.json`);
      setStatus(status, '共有用ファイルを保存しました。', 'ok');
    } catch (error) {
      setStatus(status, error.message, 'error');
    } finally {
      // 共有用パスフレーズは処理中だけ利用し、完了後は入力欄もクリアする（保存はしない）。
      passInput.value = '';
      confirmInput.value = '';
    }
  });

  // --- 共有用ファイルを取り込む --------------------------------------------------

  /** 復号済みの内容確認から取り込み実行までの間だけ保持する。保存はしない。 */
  let pending = null;

  function resetImportDialog() {
    pending = null;
    $('#share-import-step-file', importDialog).classList.remove('hidden');
    $('#share-import-step-preview', importDialog).classList.add('hidden');
    $('#share-import-step-done', importDialog).classList.add('hidden');
    $('#share-import-file', importDialog).value = '';
    $('#share-import-passphrase', importDialog).value = '';
    setStatus($('#share-import-status', importDialog), '');
    clear($('#share-import-preview-list', importDialog));
    $('#share-import-admin-notice', importDialog).classList.add('hidden');
  }

  function renderPreview(plan) {
    const list = $('#share-import-preview-list', importDialog);
    clear(list);
    for (const service of plan.services) {
      const rows = [
        // 既存サービスは、共有側の URL条件・入力項目・sharedValues も取り込み時にマージ更新される。
        ...(service.settingsUpdated ? ['サービス設定 → 更新'] : []),
        ...service.accountAdds.map((account) => `${account.name || '(名称未設定)'} → 追加`),
        ...service.accountUpdates.map((account) => `${account.name || '(名称未設定)'} → 更新`),
      ];
      list.append(el('div', { className: 'share-service-group' }, [
        el('div', { className: 'row block-head' }, [
          el('strong', { text: `${service.serviceName || '(名称未設定)'}${service.isNewService ? '（新規サービス）' : ''}` }),
        ]),
        ...rows.map((text) => el('div', { className: 'small', text })),
      ]));
    }
    const summary = `追加：${plan.totals.accountAdds}アカウント／更新：${plan.totals.accountUpdates}アカウント`
      + (plan.totals.serviceAdds ? `（新規サービス${plan.totals.serviceAdds}件を含む）` : '');
    list.append(el('div', { className: 'small muted', text: summary }));
    $('#share-import-admin-notice', importDialog).classList.toggle('hidden', !plan.hasAdmin);
  }

  $('#btn-share-import-open').addEventListener('click', () => {
    resetImportDialog();
    importDialog.showModal();
  });
  $('#btn-share-import-cancel', importDialog).addEventListener('click', () => importDialog.close());
  $('#btn-share-import-close', importDialog).addEventListener('click', () => importDialog.close());
  $('#btn-share-import-back', importDialog).addEventListener('click', () => {
    pending = null;
    $('#share-import-step-preview', importDialog).classList.add('hidden');
    $('#share-import-step-file', importDialog).classList.remove('hidden');
  });

  importDialog.addEventListener('close', () => resetImportDialog());

  $('#btn-share-import-decrypt', importDialog).addEventListener('click', async () => {
    const status = $('#share-import-status', importDialog);
    const fileInput = $('#share-import-file', importDialog);
    const passInput = $('#share-import-passphrase', importDialog);
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      setStatus(status, '共有ファイルを選択してください。', 'error');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setStatus(status, 'ファイルを読み取れませんでした。' , 'error');
      return;
    }
    try {
      const plan = await request(MSG.SHARE_IMPORT_PREVIEW, { file: parsed, passphrase: passInput.value });
      pending = { file: parsed, passphrase: passInput.value };
      renderPreview(plan);
      $('#share-import-step-file', importDialog).classList.add('hidden');
      $('#share-import-step-preview', importDialog).classList.remove('hidden');
    } catch (error) {
      setStatus(status, error.message, 'error');
    } finally {
      passInput.value = '';
    }
  });

  $('#btn-share-import-commit', importDialog).addEventListener('click', async () => {
    if (!pending) return;
    const request_ = pending;
    pending = null;
    try {
      const result = await request(MSG.SHARE_IMPORT_COMMIT, request_);
      // Vault へ反映されたので、サービス一覧・編集中のサービスを最新の内容へ読み直す。
      // これを怠ると、インポート前から開いていた編集画面が古い accounts のまま残り、
      // そこでアカウントを自動保存すると今回追加・更新した内容を消してしまう。
      // 取り込み自体は既に成功しているため、再読込の失敗を取り込み失敗として扱わない。
      if (onImported) await Promise.resolve(onImported()).catch(() => {});
      const parts = [];
      if (result.serviceAdds) parts.push(`${result.serviceAdds}サービスを追加`);
      parts.push(`${result.accountAdds}アカウントを追加`);
      parts.push(`${result.accountUpdates}アカウントを更新`);
      $('#share-import-result', importDialog).textContent = `${parts.join('、')}しました。`;
      $('#share-import-step-preview', importDialog).classList.add('hidden');
      $('#share-import-step-done', importDialog).classList.remove('hidden');
    } catch (error) {
      setStatus($('#share-import-status', importDialog), error.message, 'error');
      $('#share-import-step-preview', importDialog).classList.add('hidden');
      $('#share-import-step-file', importDialog).classList.remove('hidden');
    }
  });
}
