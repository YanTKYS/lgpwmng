import test from 'node:test';
import assert from 'node:assert/strict';
import { matchCapturedValues } from '../src/lib/capture.js';

const frame = (pathname = '/login') => ({ top: false, origin: 'https://example.test', pathname, name: '' });
const locator = (overrides = {}) => ({
  tagName: 'input', type: 'text', elementId: '', name: '', cssPath: '', formIndex: 0, indexInForm: 0, ...overrides,
});
const candidate = (loc, frm = frame()) => ({ locator: loc, frame: frm });
const captured = (loc, value, frm = frame()) => ({ locator: loc, value, frame: frm });

test('一意な elementId の値を取得する', () => {
  const loc = locator({ elementId: 'user' });
  assert.deepEqual(matchCapturedValues([candidate(loc)], [captured(loc, 'user01')]), ['user01']);
});

test('同名の text と password を型と位置で区別する', () => {
  const text = locator({ name: 'login', indexInForm: 0 });
  const secret = locator({ name: 'login', type: 'password', indexInForm: 1 });
  assert.deepEqual(matchCapturedValues(
    [candidate(text), candidate(secret)],
    [captured(text, 'user01'), captured(secret, 'pass01')],
  ), ['user01', 'pass01']);
});

test('同名・同型でもフォーム位置で区別する', () => {
  const first = locator({ name: 'login', formIndex: 0 });
  const second = locator({ name: 'login', formIndex: 1 });
  assert.deepEqual(matchCapturedValues(
    [candidate(first), candidate(second)],
    [captured(first, 'first'), captured(second, 'second')],
  ), ['first', 'second']);
});

test('完全に曖昧な locator は secret を含め自動反映しない', () => {
  const duplicate = locator({ name: 'login', type: 'password', formIndex: -1, indexInForm: -1 });
  assert.deepEqual(matchCapturedValues(
    [candidate(duplicate)],
    [captured(duplicate, 'one'), captured(duplicate, 'two')],
  ), ['']);
});

test('異なる frame の同名項目を混同しない', () => {
  const loc = locator({ name: 'login' });
  assert.deepEqual(matchCapturedValues(
    [candidate(loc, frame('/a')), candidate(loc, frame('/b'))],
    [captured(loc, 'A', frame('/a')), captured(loc, 'B', frame('/b'))],
  ), ['A', 'B']);
});
