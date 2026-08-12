/**
 * scan の候補と capture の現在値を対応付ける。
 *
 * 値を持つ capture 側を「先に見つかった一件」で選ばないことが重要である。
 * フレームを分離したうえで、DOM の構造情報を含む照合キーごとに検索し、そのキーが
 * capture 結果内で一意な場合だけ値を返す。曖昧な場合は空文字にして手入力を優先する。
 */

import { frameDescriptorKey } from './frame.js';

function present(value) {
  return value !== '' && value !== null && value !== undefined;
}

function compatible(candidate, entry) {
  const left = candidate.locator || {};
  const right = entry.locator || {};
  return (!present(left.tagName) || !present(right.tagName) || left.tagName === right.tagName)
    && (!present(left.type) || !present(right.type) || left.type === right.type);
}

function same(locator, other, keys) {
  return keys.every((key) => present(locator[key]) && locator[key] === other[key]);
}

// 単独の name より、フォーム内位置や型を含むキーを先に使う。各検索は一意なとき
// だけ成功するので、壊れた HTML に重複 id / name があっても先頭を採用しない。
const MATCH_KEYS = [
  ['elementId', 'tagName', 'type', 'formIndex', 'indexInForm'],
  ['cssPath', 'tagName', 'type'],
  ['name', 'tagName', 'type', 'formIndex', 'indexInForm'],
  ['tagName', 'type', 'formIndex', 'indexInForm'],
  ['elementId'],
  ['cssPath'],
  ['name', 'tagName', 'type'],
];

/**
 * candidates と同じ並びで capture 値を返す。一意に特定できない要素は空文字。
 * secret も通常項目も同じ fail-closed な規則で扱う。
 *
 * @param {Array<{locator: object, frame: object}>} candidates
 * @param {Array<{locator: object, frame: object, value: string}>} capturedEntries
 * @returns {string[]}
 */
export function matchCapturedValues(candidates = [], capturedEntries = []) {
  const byFrame = new Map();
  for (const entry of capturedEntries) {
    if (!entry || !entry.locator || typeof entry.value !== 'string') continue;
    const key = frameDescriptorKey(entry.frame);
    if (!byFrame.has(key)) byFrame.set(key, []);
    byFrame.get(key).push(entry);
  }

  return candidates.map((candidate) => {
    if (!candidate || !candidate.locator) return '';
    const pool = (byFrame.get(frameDescriptorKey(candidate.frame)) || [])
      .filter((entry) => compatible(candidate, entry));
    for (const keys of MATCH_KEYS) {
      const matches = pool.filter((entry) => same(candidate.locator, entry.locator, keys));
      if (matches.length === 1) return matches[0].value;
    }
    return '';
  });
}
