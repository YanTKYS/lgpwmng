import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyShareImport,
  buildImportPlan,
  createShareFile,
  decryptShareFile,
  extractShareServices,
  hasAdminAccount,
  isShareFile,
  ShareFileError,
} from '../src/lib/share.js';
import { ACCOUNT_ROLE, BACKUP_FORMAT, createVault, normalizeVault } from '../src/lib/model.js';

const PASSPHRASE = 'share-pass-1';

function buildVault() {
  const raw = {
    schemaVersion: 3,
    services: [
      {
        id: 'svc_hr',
        name: '人事給与システム',
        note: 'メモ',
        matchRules: [{ id: 'rule_1', origin: 'https://hr.example.test', originMode: 'exact', pathname: '/login', pathnameMode: 'exact' }],
        fields: [
          { id: 'fld_user', label: 'ユーザーID', scope: 'account', kind: 'text', locator: { elementId: 'user' } },
          { id: 'fld_pass', label: 'パスワード', scope: 'account', kind: 'secret', locator: { elementId: 'pass' } },
          { id: 'fld_org', label: '団体コード', scope: 'shared', kind: 'text', locator: { elementId: 'org' } },
        ],
        sharedValues: { fld_org: '123456' },
        accounts: [
          { id: 'acc_personal', name: '個人アカウント', role: 'normal', values: { fld_user: 'me', fld_pass: 'mypw' } },
          { id: 'acc_admin', name: 'システム管理', role: 'admin', values: { fld_user: 'admin', fld_pass: 'adminpw' } },
          { id: 'acc_support', name: '問い合わせ用', role: 'normal', values: { fld_user: 'support', fld_pass: 'supportpw' } },
        ],
      },
      {
        id: 'svc_fin',
        name: '財務システム',
        matchRules: [{ id: 'rule_2', origin: 'https://fin.example.test', originMode: 'exact', pathname: '/', pathnameMode: 'any' }],
        fields: [{ id: 'fld_fin_user', label: 'ID', scope: 'account', kind: 'text', locator: {} }],
        sharedValues: {},
        accounts: [{ id: 'acc_fin_personal', name: '個人アカウント', role: 'normal', values: { fld_fin_user: 'me2' } }],
      },
    ],
    updatedAt: Date.now(),
  };
  return normalizeVault(raw);
}

// --- エクスポート -------------------------------------------------------------

test('選択したaccountだけ含まれる', () => {
  const vault = buildVault();
  const services = extractShareServices(vault, { svc_hr: ['acc_admin', 'acc_support'] });
  assert.equal(services.length, 1);
  const ids = services[0].accounts.map((a) => a.id).sort();
  assert.deepEqual(ids, ['acc_admin', 'acc_support']);
});

test('未選択accountが含まれない', () => {
  const vault = buildVault();
  const services = extractShareServices(vault, { svc_hr: ['acc_admin'] });
  const ids = services[0].accounts.map((a) => a.id);
  assert.ok(!ids.includes('acc_personal'));
  // 選択しなかったサービスも含まれない
  assert.ok(!services.some((s) => s.id === 'svc_fin'));
});

test('service定義・sharedValues・fieldsが含まれる', () => {
  const vault = buildVault();
  const [service] = extractShareServices(vault, { svc_hr: ['acc_admin'] });
  assert.equal(service.id, 'svc_hr');
  assert.equal(service.name, '人事給与システム');
  assert.equal(service.matchRules[0].origin, 'https://hr.example.test');
  assert.equal(service.fields.length, 3);
  assert.equal(service.sharedValues.fld_org, '123456');
});

test('admin roleが維持される', () => {
  const vault = buildVault();
  const services = extractShareServices(vault, { svc_hr: ['acc_admin'] });
  assert.equal(services[0].accounts[0].role, ACCOUNT_ROLE.ADMIN);
  assert.ok(hasAdminAccount(services));
});

test('0アカウントでは出力できない', async () => {
  await assert.rejects(() => createShareFile([], PASSPHRASE));
  const vault = buildVault();
  const services = extractShareServices(vault, {});
  assert.equal(services.length, 0);
  await assert.rejects(() => createShareFile(services, PASSPHRASE));
});

test('平文資格情報が外側のJSONへ露出しない', async () => {
  const vault = buildVault();
  const services = extractShareServices(vault, { svc_hr: ['acc_admin'] });
  const file = await createShareFile(services, PASSPHRASE);
  const outer = JSON.stringify(file);
  assert.ok(!outer.includes('adminpw'));
  assert.ok(!outer.includes('123456')); // 団体コード（sharedValues）も暗号化データの外に出ない
  assert.equal(file.format, 'lgpwmng-share');
  assert.equal(typeof file.data, 'string');
});

// --- インポート ---------------------------------------------------------------

async function makeShareFile(vault, selection, passphrase = PASSPHRASE) {
  const services = extractShareServices(vault, selection);
  return createShareFile(services, passphrase);
}

test('新規serviceを追加できる', async () => {
  const senderVault = buildVault();
  const file = await makeShareFile(senderVault, { svc_fin: ['acc_fin_personal'] });
  const receiverVault = createVault();
  const services = await decryptShareFile(file, PASSPHRASE);
  const result = applyShareImport(receiverVault, services);
  assert.equal(result.serviceAdds, 1);
  assert.equal(result.accountAdds, 1);
  assert.equal(receiverVault.services.length, 1);
  assert.equal(receiverVault.services[0].id, 'svc_fin');
});

test('既存serviceへ新規accountを追加できる', async () => {
  const senderVault = buildVault();
  const receiverVault = buildVault();
  // 受取側は「システム管理」をまだ持っていない状態を作る
  receiverVault.services[0].accounts = receiverVault.services[0].accounts.filter((a) => a.id !== 'acc_admin');

  const file = await makeShareFile(senderVault, { svc_hr: ['acc_admin'] });
  const services = await decryptShareFile(file, PASSPHRASE);
  const result = applyShareImport(receiverVault, services);
  assert.equal(result.accountAdds, 1);
  assert.equal(result.accountUpdates, 0);
  const merged = receiverVault.services.find((s) => s.id === 'svc_hr');
  assert.ok(merged.accounts.some((a) => a.id === 'acc_admin'));
});

test('同一account IDを更新できる（パスワード変更の再共有）', async () => {
  const receiverVault = buildVault();
  const senderVault = buildVault();
  senderVault.services[0].accounts.find((a) => a.id === 'acc_admin').values.fld_pass = 'bbbb';

  const file = await makeShareFile(senderVault, { svc_hr: ['acc_admin'] });
  const services = await decryptShareFile(file, PASSPHRASE);
  const result = applyShareImport(receiverVault, services);
  assert.equal(result.accountUpdates, 1);
  assert.equal(result.accountAdds, 0);
  const merged = receiverVault.services.find((s) => s.id === 'svc_hr').accounts.find((a) => a.id === 'acc_admin');
  assert.equal(merged.values.fld_pass, 'bbbb');
});

test('再インポートで重複しない', async () => {
  const senderVault = buildVault();
  const receiverVault = createVault();
  const file = await makeShareFile(senderVault, { svc_hr: ['acc_admin'] });

  for (let i = 0; i < 3; i += 1) {
    const services = await decryptShareFile(file, PASSPHRASE);
    applyShareImport(receiverVault, services);
  }
  const service = receiverVault.services.find((s) => s.id === 'svc_hr');
  assert.equal(service.accounts.length, 1);
  assert.equal(service.accounts.filter((a) => a.id === 'acc_admin').length, 1);
});

test('未共有の既存accountを削除しない', async () => {
  const senderVault = buildVault();
  const receiverVault = buildVault(); // 個人アカウント・問い合わせ用を既に持っている

  const file = await makeShareFile(senderVault, { svc_hr: ['acc_admin'] });
  const services = await decryptShareFile(file, PASSPHRASE);
  applyShareImport(receiverVault, services);

  const service = receiverVault.services.find((s) => s.id === 'svc_hr');
  const ids = service.accounts.map((a) => a.id).sort();
  assert.deepEqual(ids, ['acc_admin', 'acc_personal', 'acc_support']);
  // 個人アカウントの値は変わっていない
  const personal = service.accounts.find((a) => a.id === 'acc_personal');
  assert.equal(personal.values.fld_pass, 'mypw');
});

test('sharedValuesを反映できる', async () => {
  const senderVault = buildVault();
  senderVault.services[0].sharedValues.fld_org = '999999';
  const receiverVault = buildVault();

  const file = await makeShareFile(senderVault, { svc_hr: ['acc_admin'] });
  const services = await decryptShareFile(file, PASSPHRASE);
  applyShareImport(receiverVault, services);

  const service = receiverVault.services.find((s) => s.id === 'svc_hr');
  assert.equal(service.sharedValues.fld_org, '999999');
});

test('field IDを維持できる（field構成が異なっても既存accountの値は同一field ID分だけ保持）', async () => {
  const senderVault = buildVault();
  // 送信側にだけ存在する新項目を追加
  senderVault.services[0].fields.push({ id: 'fld_extra', label: '追加項目', scope: 'account', kind: 'text', locator: {}, frame: { top: true } });
  const receiverVault = buildVault();
  // 受取側にだけ存在する項目（personal account が使っている）
  receiverVault.services[0].fields.push({ id: 'fld_local', label: '内線番号', scope: 'account', kind: 'text', locator: {}, frame: { top: true } });
  receiverVault.services[0].accounts.find((a) => a.id === 'acc_personal').values.fld_local = '1234';

  const file = await makeShareFile(senderVault, { svc_hr: ['acc_admin'] });
  const services = await decryptShareFile(file, PASSPHRASE);
  applyShareImport(receiverVault, services);

  const service = receiverVault.services.find((s) => s.id === 'svc_hr');
  // 送信側の新項目が追加されている
  assert.ok(service.fields.some((f) => f.id === 'fld_extra'));
  // 受取側だけの項目は消えず、値も保持される
  assert.ok(service.fields.some((f) => f.id === 'fld_local'));
  const personal = service.accounts.find((a) => a.id === 'acc_personal');
  assert.equal(personal.values.fld_local, '1234');
});

test('管理者roleを維持できる', async () => {
  const senderVault = buildVault();
  const receiverVault = createVault();
  const file = await makeShareFile(senderVault, { svc_hr: ['acc_admin'] });
  const services = await decryptShareFile(file, PASSPHRASE);
  applyShareImport(receiverVault, services);
  const account = receiverVault.services[0].accounts.find((a) => a.id === 'acc_admin');
  assert.equal(account.role, ACCOUNT_ROLE.ADMIN);
});

// --- 安全性 --------------------------------------------------------------------

test('不正formatを拒否する', async () => {
  await assert.rejects(() => decryptShareFile({ format: 'not-a-share-format', version: 1 }, PASSPHRASE), ShareFileError);
  await assert.rejects(() => decryptShareFile(null, PASSPHRASE), ShareFileError);
  await assert.rejects(() => decryptShareFile('not-json-object', PASSPHRASE), ShareFileError);
});

test('version非対応を拒否する', async () => {
  const vault = buildVault();
  const file = await makeShareFile(vault, { svc_hr: ['acc_admin'] });
  const bumped = { ...file, version: 999 };
  await assert.rejects(() => decryptShareFile(bumped, PASSPHRASE), ShareFileError);
});

test('パスフレーズ不一致を拒否する', async () => {
  const vault = buildVault();
  const file = await makeShareFile(vault, { svc_hr: ['acc_admin'] });
  await assert.rejects(() => decryptShareFile(file, 'wrong-passphrase'), ShareFileError);
});

test('マスターバックアップを共有ファイルとして取り込めない', async () => {
  const backupLike = { format: BACKUP_FORMAT, version: 1, kdf: {}, iv: 'a', data: 'b' };
  assert.equal(isShareFile(backupLike), false);
  await assert.rejects(() => decryptShareFile(backupLike, PASSPHRASE), /マスターバックアップ/);
});

test('既存Vault全体を置換しない', async () => {
  const senderVault = buildVault();
  const receiverVault = buildVault();
  const originalFinService = receiverVault.services.find((s) => s.id === 'svc_fin');

  const file = await makeShareFile(senderVault, { svc_hr: ['acc_admin'] });
  const services = await decryptShareFile(file, PASSPHRASE);
  applyShareImport(receiverVault, services);

  // 共有していない財務システムがそのまま残っている
  assert.ok(receiverVault.services.some((s) => s.id === 'svc_fin'));
  assert.deepEqual(receiverVault.services.find((s) => s.id === 'svc_fin').accounts.map((a) => a.id), originalFinService.accounts.map((a) => a.id));
  assert.equal(receiverVault.services.length, 2);
});

test('buildImportPlan は Vault を変更せずに内訳だけを返す', async () => {
  const senderVault = buildVault();
  const receiverVault = buildVault();
  receiverVault.services[0].accounts = receiverVault.services[0].accounts.filter((a) => a.id !== 'acc_admin');
  const before = JSON.stringify(receiverVault);

  const file = await makeShareFile(senderVault, { svc_hr: ['acc_admin'] });
  const services = await decryptShareFile(file, PASSPHRASE);
  const plan = buildImportPlan(receiverVault, services);

  assert.equal(JSON.stringify(receiverVault), before);
  assert.equal(plan.totals.accountAdds, 1);
  assert.equal(plan.totals.accountUpdates, 0);
  assert.equal(plan.hasAdmin, true);
});

test('buildImportPlan は既存serviceのsettings更新（matchRules/fields/sharedValuesのマージ）も示す', async () => {
  const senderVault = buildVault();
  const receiverVault = buildVault(); // svc_hr は既存、svc_fin は共有しない
  const file = await makeShareFile(senderVault, { svc_hr: ['acc_admin'] });
  const services = await decryptShareFile(file, PASSPHRASE);
  const plan = buildImportPlan(receiverVault, services);

  const hr = plan.services.find((s) => s.serviceId === 'svc_hr');
  assert.equal(hr.isNewService, false);
  assert.equal(hr.settingsUpdated, true);
});

test('buildImportPlan は新規serviceにはsettings更新を示さない', async () => {
  const senderVault = buildVault();
  const receiverVault = createVault();
  const file = await makeShareFile(senderVault, { svc_fin: ['acc_fin_personal'] });
  const services = await decryptShareFile(file, PASSPHRASE);
  const plan = buildImportPlan(receiverVault, services);

  const fin = plan.services.find((s) => s.serviceId === 'svc_fin');
  assert.equal(fin.isNewService, true);
  assert.equal(fin.settingsUpdated, false);
});
