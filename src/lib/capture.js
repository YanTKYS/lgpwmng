/**
 * ログイン画面の現在値（capture の結果）と、走査候補（scan の candidates）を
 * 対応付ける処理。
 *
 * capture は「入力欄の識別情報（locator）+ フレーム + 値」の平たいリストで届く。
 * どの candidate と同じ入力欄を指しているかは、同じフレーム内で
 * id → name → CSSセレクタの順に一致するかで判定する
 * （setup.js の対応付け全般で使っている考え方と同じ）。
 */

import { frameDescriptorKey } from './frame.js';

const LOCATOR_HINTS = ['elementId', 'name', 'cssPath'];

/**
 * candidates の各要素に対応する、取得済みの現在値を返す（candidates と同じ並びの配列）。
 * 対応するものが無い、または値が取得できなかった場合は空文字。
 *
 * @param {Array<{locator: object, frame: object}>} candidates
 * @param {Array<{locator: object, frame: object, value: string}>} capturedEntries
 * @returns {string[]}
 */
export function matchCapturedValues(candidates, capturedEntries) {
  const byFrame = new Map();
  for (const entry of capturedEntries) {
    const key = frameDescriptorKey(entry.frame);
    if (!byFrame.has(key)) byFrame.set(key, []);
    byFrame.get(key).push(entry);
  }

  return candidates.map((candidate) => {
    const pool = byFrame.get(frameDescriptorKey(candidate.frame)) || [];
    for (const hint of LOCATOR_HINTS) {
      const hintValue = candidate.locator[hint];
      if (!hintValue) continue;
      const found = pool.find((entry) => entry.locator[hint] === hintValue);
      if (found) return found.value;
    }
    return '';
  });
}
