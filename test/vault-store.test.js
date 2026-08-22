import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * chrome.storage.local / chrome.storage.session の最小モック。
 * vault-store.js はこれらのみに依存しているため、Service Worker 環境を
 * 用意しなくてもロジックを検証できる。
 */
function installChromeMock() {
  const local = new Map();
  const session = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === 'string') return { [key]: local.get(key) };
          return {};
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) local.set(k, v);
        },
      },
      session: {
        async get(key) {
          if (typeof key === 'string') return { [key]: session.get(key) };
          return {};
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) session.set(k, v);
        },
        async remove(key) { session.delete(key); },
        async setAccessLevel() {},
      },
    },
  };
}

installChromeMock();
const store = await import('../src/background/vault-store.js');

const MASTER = 'master-pass-1';

test.beforeEach(async () => {
  installChromeMock();
  await store.lock();
});

async function seedVault(serviceOverrides = {}) {
  await store.createNewVault(MASTER);
  const vault = await store.getVault();
  vault.services.push({
    id: 'svc_1',
    name: 'テストサービス',
    note: '',
    matchRules: [{ id: 'r1', origin: 'https://example.test', originMode: 'exact', pathname: '/', pathnameMode: 'any' }],
    fields: [{ id: 'f1', label: 'ID', scope: 'account', kind: 'text', locator: {}, frame: { top: true } }],
    sharedValues: {},
    accounts: [{ id: 'a1', name: '個人アカウント', role: 'normal', note: '', values: { f1: 'me' } }],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...serviceOverrides,
  });
  await store.saveVault(vault);
  return vault;
}

// --- 回帰: マスターバックアップ -------------------------------------------------

test('マスターバックアップ保存が動作する', async () => {
  await seedVault();
  const backup = await store.exportBackup('backup-pass-1');
  assert.equal(backup.format, store.BACKUP_FORMAT);
  assert.equal(typeof backup.data, 'string');
  assert.ok(!JSON.stringify(backup).includes('個人アカウント')); // 平文はバックアップの外側へ出ない
});

test('マスターバックアップreplaceが動作する', async () => {
  await seedVault();
  const backup = await store.exportBackup('backup-pass-1');
  const vault = await store.getVault();
  vault.services.push({
    id: 'svc_extra', name: '追加サービス', note: '', matchRules: [], fields: [], sharedValues: {}, accounts: [], createdAt: Date.now(), updatedAt: Date.now(),
  });
  await store.saveVault(vault);
  assert.equal((await store.getVault()).services.length, 2);

  const result = await store.importBackup(backup, 'backup-pass-1', 'replace');
  assert.equal(result.imported, 1);
  assert.equal((await store.getVault()).services.length, 1);
});

test('マスターバックアップmergeが動作する', async () => {
  await seedVault();
  const backup = await store.exportBackup('backup-pass-1');
  const vault = await store.getVault();
  vault.services.push({
    id: 'svc_extra', name: '追加サービス', note: '', matchRules: [], fields: [], sharedValues: {}, accounts: [], createdAt: Date.now(), updatedAt: Date.now(),
  });
  await store.saveVault(vault);

  const result = await store.importBackup(backup, 'backup-pass-1', 'merge');
  // svc_1 は既に存在するため追加されない
  assert.equal(result.imported, 0);
  assert.equal((await store.getVault()).services.length, 2);
});

// --- 安全性: マスターバックアップと共有ファイルの取り違え防止 --------------------------

test('共有ファイルをマスターバックアップとして取り込めない', async () => {
  await seedVault();
  const shareFile = await store.exportShare({ svc_1: ['a1'] }, 'share-pass-1');
  await assert.rejects(() => store.importBackup(shareFile, 'share-pass-1', 'merge'));
});

test('非対応バージョンのマスターバックアップを取り込めない', async () => {
  await seedVault();
  const backup = await store.exportBackup('backup-pass-1');
  backup.version += 1;
  await assert.rejects(
    () => store.importBackup(backup, 'backup-pass-1', 'replace'),
    /対応していないバージョン/,
  );
});

// --- アカウント共有: 背景側の一連の流れ -----------------------------------------

test('共有エクスポート→プレビュー→取り込みが一気通貫で成立する', async () => {
  await seedVault();
  const shareFile = await store.exportShare({ svc_1: ['a1'] }, 'share-pass-1');

  installChromeMock(); // 受取側の別 Vault を模す（別端末相当）
  await store.createNewVault(MASTER);

  const plan = await store.previewShareImport(shareFile, 'share-pass-1');
  assert.equal(plan.totals.accountAdds, 1);
  assert.equal((await store.getVault()).services.length, 0); // プレビューでは反映しない

  const result = await store.importShare(shareFile, 'share-pass-1');
  assert.equal(result.serviceAdds, 1);
  assert.equal(result.accountAdds, 1);
  const vault = await store.getVault();
  assert.equal(vault.services.length, 1);
  assert.equal(vault.services[0].accounts[0].values.f1, 'me');
});

test('共有インポートは既存Vaultの他サービスを残す', async () => {
  await seedVault();
  const shareFile = await store.exportShare({ svc_1: ['a1'] }, 'share-pass-1');

  installChromeMock(); // 受取側の別 Vault を模す（別端末相当）
  await store.createNewVault(MASTER);
  const vault = await store.getVault();
  vault.services.push({
    id: 'svc_other', name: '他のサービス', note: '', matchRules: [], fields: [], sharedValues: {}, accounts: [{ id: 'a9', name: '別アカウント', role: 'normal', note: '', values: {} }], createdAt: Date.now(), updatedAt: Date.now(),
  });
  await store.saveVault(vault);

  await store.importShare(shareFile, 'share-pass-1');
  const after = await store.getVault();
  assert.equal(after.services.length, 2);
  assert.ok(after.services.some((s) => s.id === 'svc_other' && s.accounts.some((a) => a.id === 'a9')));
});

test('共有エクスポートには8文字未満のパスフレーズを使えない', async () => {
  await seedVault();
  await assert.rejects(() => store.exportShare({ svc_1: ['a1'] }, 'short'));
});
