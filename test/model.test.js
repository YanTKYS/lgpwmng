import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIELD_SCOPE,
  buildFillValues,
  changeFieldScope,
  createAccount,
  createField,
  createService,
  summarizeService,
} from '../src/lib/model.js';

function buildService() {
  const service = createService('申請システム');
  const org = createField({ label: '団体コード', scope: FIELD_SCOPE.SHARED });
  const user = createField({ label: 'ユーザーID' });
  const pass = createField({ label: 'パスワード', kind: 'secret' });
  service.fields = [org, user, pass];
  service.sharedValues = { [org.id]: '123456' };
  service.accounts = [
    createAccount({ name: '標準ユーザー', values: { [user.id]: 'staff01', [pass.id]: 'pw01' } }),
    createAccount({ name: '管理ユーザー', role: 'admin', values: { [user.id]: 'admin01' } }),
  ];
  return { service, org, user, pass };
}

test('入力する値は共通値とアカウント値を項目の順で組み立てる', () => {
  const { service, org, user, pass } = buildService();
  assert.deepEqual(
    buildFillValues(service, service.accounts[0]).map((entry) => [entry.fieldId, entry.value]),
    [[org.id, '123456'], [user.id, 'staff01'], [pass.id, 'pw01']],
  );
  // 値が登録されていない項目は入力対象にしない。
  assert.deepEqual(
    buildFillValues(service, service.accounts[1]).map((entry) => entry.fieldId),
    [org.id, user.id],
  );
});

test('アカウント一覧の要約は登録済み項目数を数える', () => {
  const { service } = buildService();
  const summary = summarizeService(service);
  assert.equal(summary.fieldCount, 3);
  assert.deepEqual(summary.accounts.map((account) => account.filledFieldCount), [3, 2]);
  // 登録された値そのものは要約に含めない。
  assert.ok(!JSON.stringify(summary).includes('pw01'));
});

test('区分を共通へ変えるとアカウントの値を引き継ぐ', () => {
  const { service, user } = buildService();
  changeFieldScope(service, user, FIELD_SCOPE.SHARED);
  assert.equal(service.sharedValues[user.id], 'staff01');
});

test('区分をアカウントへ戻しても共通値は失われない', () => {
  const { service, org } = buildService();
  changeFieldScope(service, org, FIELD_SCOPE.ACCOUNT);
  for (const account of service.accounts) {
    assert.equal(account.values[org.id], '123456');
  }
  changeFieldScope(service, org, FIELD_SCOPE.SHARED);
  assert.equal(service.sharedValues[org.id], '123456');
});
