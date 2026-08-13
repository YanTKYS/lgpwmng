import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeRule,
  findMatchingServices,
  serviceMatchesUrl,
} from '../src/lib/match.js';
import { createMatchRule, createService } from '../src/lib/model.js';

function service(name, rules) {
  const entry = createService(name);
  entry.matchRules = rules.map(createMatchRule);
  return entry;
}

// --- URL 判定 -----------------------------------------------------------------

test('http と https は別のサービスとして扱う', () => {
  const https = service('HTTPS版', [{ origin: 'https://sys.example.test', pathname: '/login' }]);
  assert.equal(serviceMatchesUrl(https, 'https://sys.example.test/login'), true);
  assert.equal(serviceMatchesUrl(https, 'http://sys.example.test/login'), false);
});

test('末尾の / の有無で判定が変わらない', () => {
  const entry = service('申請', [{ origin: 'https://sys.example.test', pathname: '/app' }]);
  assert.equal(serviceMatchesUrl(entry, 'https://sys.example.test/app/'), true);
});

test('前方一致は途中まで同じだけの別パスに一致しない', () => {
  const entry = service('申請', [{ origin: 'https://sys.example.test', pathname: '/app', pathnameMode: 'prefix' }]);
  assert.equal(serviceMatchesUrl(entry, 'https://sys.example.test/app/login'), true);
  assert.equal(serviceMatchesUrl(entry, 'https://sys.example.test/application'), false);
});

test('複数サービスが一致した場合は厳密な条件を先に返す', () => {
  const vault = {
    services: [
      service('全体', [{ origin: 'https://sys.example.test', pathnameMode: 'any' }]),
      service('申請画面', [{ origin: 'https://sys.example.test', pathname: '/apply/login' }]),
    ],
  };
  const matched = findMatchingServices(vault, 'https://sys.example.test/apply/login');
  assert.deepEqual(matched.map((entry) => entry.name), ['申請画面', '全体']);
});

test('対象外のページでは一致しない', () => {
  const vault = { services: [service('申請', [{ origin: 'https://sys.example.test', pathnameMode: 'any' }])] };
  assert.deepEqual(findMatchingServices(vault, 'chrome://extensions'), []);
});

// --- 一覧表示用の表記 -----------------------------------------------------------

test('URL条件を1行で表記する', () => {
  const exact = createMatchRule({ origin: 'https://sys.example.test', pathname: '/login' });
  assert.equal(describeRule(exact), 'https://sys.example.test/login');

  const prefix = createMatchRule({ origin: 'https://sys.example.test', pathname: '/app', pathnameMode: 'prefix' });
  assert.equal(describeRule(prefix), 'https://sys.example.test/app/*');

  const any = createMatchRule({ origin: 'https://sys.example.test', originMode: 'suffix', pathnameMode: 'any' });
  assert.equal(describeRule(any), 'https://*.sys.example.test（パス問わず）');
});

test('パスが / の前方一致でも // とならない', () => {
  const rule = createMatchRule({ origin: 'https://sys.example.test', pathname: '/', pathnameMode: 'prefix' });
  assert.equal(describeRule(rule), 'https://sys.example.test/*');
});
