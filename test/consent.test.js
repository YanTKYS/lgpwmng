import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * chrome.storage.local の最小モック。consent.js はこれだけに依存する。
 */
function installChromeMock({ failing = false } = {}) {
  const local = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (failing) throw new Error('storage unavailable');
          return { [key]: local.get(key) };
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) local.set(k, v);
        },
      },
    },
  };
  return local;
}

installChromeMock();
const consent = await import('../src/background/consent.js');

test.beforeEach(() => { installChromeMock(); });

test('初期状態は未同意', async () => {
  const state = await consent.getConsent();
  assert.equal(state.granted, false);
  assert.equal(state.version, 0);
  assert.equal(state.requiredVersion, consent.CONSENT_VERSION);
});

test('同意すると記録され、次回以降は同意済みになる', async () => {
  const granted = await consent.grantConsent();
  assert.equal(granted.granted, true);
  assert.equal(granted.version, consent.CONSENT_VERSION);

  const state = await consent.getConsent();
  assert.equal(state.granted, true);
  assert.equal(state.version, consent.CONSENT_VERSION);
});

test('同意バージョンを storage へ保存する', async () => {
  const local = installChromeMock();
  await consent.grantConsent();
  const stored = local.get('lgpwmng.consent');
  assert.equal(stored.privacyConsentVersion, consent.CONSENT_VERSION);
  assert.equal(typeof stored.grantedAt, 'number');
  // 認証情報は同意の記録に含めない。
  assert.deepEqual(Object.keys(stored).sort(), ['grantedAt', 'privacyConsentVersion']);
});

test('古いバージョンへの同意は未同意として扱う（開示内容の変更で再同意）', async () => {
  const local = installChromeMock();
  local.set('lgpwmng.consent', { privacyConsentVersion: consent.CONSENT_VERSION - 1 });
  const state = await consent.getConsent();
  assert.equal(state.granted, false);
  assert.equal(state.version, consent.CONSENT_VERSION - 1);
});

test('壊れた記録は未同意として扱う', async () => {
  for (const broken of [null, {}, { privacyConsentVersion: 'yes' }, { privacyConsentVersion: null }]) {
    const local = installChromeMock();
    local.set('lgpwmng.consent', broken);
    assert.equal((await consent.getConsent()).granted, false, `${JSON.stringify(broken)} は未同意`);
  }
});

test('storage を読めない場合も未同意として扱う', async () => {
  installChromeMock({ failing: true });
  assert.equal((await consent.getConsent()).granted, false);
});

test('未同意では requireConsent が例外になる', async () => {
  await assert.rejects(() => consent.requireConsent(), (error) => {
    assert.equal(error.name, 'ConsentRequiredError');
    // 例外メッセージに認証情報や URL を含めない。
    assert.match(error.message, /同意/);
    return true;
  });
});

test('同意済みでは requireConsent が通る', async () => {
  await consent.grantConsent();
  await consent.requireConsent();
});
