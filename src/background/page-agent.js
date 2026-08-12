/**
 * 対象ページ内で実行される処理。
 *
 * この関数は chrome.scripting.executeScript の func として文字列化されて注入されるため、
 * 外部スコープの変数・import を一切参照しない自己完結した実装にしている。
 * 呼び出しは利用者が拡張を操作したタイミングのみで、常駐 content script は登録しない。
 *
 * @param {'scan'|'fill'|'highlight'|'probe'} action
 * @param {object} payload
 */
export function pageAgent(action, payload) {
  // フレーム自身の識別（軽量）。frame / iframe どちらでもこのフレームの
  // 実行コンテキストから見れば同じ location / window.name で判別できるため、
  // 要素種別ごとの別実装は不要。
  if (action === 'probe') {
    return { url: location.href, frameName: safeFrameName() };
  }

  const FILLABLE_SELECTOR = 'input, select, textarea';
  const IGNORED_INPUT_TYPES = ['submit', 'button', 'reset', 'image', 'file', 'hidden'];

  const GUESS_RULES = [
    { keys: ['第二パスワード', '第2パスワード', 'パスワード2', 'password2', 'passwd2', 'pass2', 'secondpassword', 'subpassword'], label: '第二パスワード', kind: 'secret' },
    { keys: ['暗証番号', 'pin'], label: 'PIN', kind: 'secret' },
    { keys: ['パスワード', 'password', 'passwd', 'pswd'], label: 'パスワード', kind: 'secret' },
    { keys: ['自治体コード', '団体コード', '市町村コード', 'lgcode', 'citycode', 'orgcode', 'organizationcode'], label: '自治体コード', kind: 'text' },
    { keys: ['所属コード', '所属', '部署コード', '課コード', 'sectioncode', 'deptcode'], label: '所属コード', kind: 'text' },
    { keys: ['職員番号', '職員コード', 'staffno', 'staffcode', 'employeeno'], label: '職員番号', kind: 'text' },
    { keys: ['利用者id', 'ユーザーid', 'ユーザid', 'ログインid', '利用者番号', 'loginid', 'userid', 'username', 'uid', 'account'], label: 'ユーザーID', kind: 'text' },
  ];

  // 入力の直前に、実行中のページ（このフレーム）自身の URL が登録条件に一致するか
  // 確認する。background 側の確認とページ遷移が競合しても、ここで確実に中止できる。
  //
  // frameCheck が指定されている場合（子フレームへの入力）は、このフレーム自身の URL を、
  // 登録時に確認したフレーム URL（origin + pathname）と比較する。
  // トップフレームへの入力は、サービスの matchRules で確認する。
  if (action === 'fill') {
    const urlOk = payload.frameCheck
      ? frameSelfMatches(payload.frameCheck)
      : urlMatchesRules(payload.matchRules);
    if (!urlOk) return { error: 'url-mismatch', url: location.href };
  }

  // 入力欄と、その識別情報（locator）を 1 回だけ組み立てて使い回す。
  // 項目ごとに組み立て直すと、入力欄の多い画面で画面が固まることがある。
  const targets = collectTargets();

  if (action === 'scan') {
    return {
      url: location.href,
      title: document.title,
      frameName: safeFrameName(),
      // 子フレーム（frame / iframe）をどれだけ見つけたか。呼び出し側が
      // 「アクセスできなかったフレームがあるか」を大まかに判断するために使う。
      childFrameCount: document.querySelectorAll('frame, iframe').length,
      candidates: targets.map((target) => {
        const guess = guessMeaning(target.locator);
        return {
          locator: target.locator,
          guessLabel: guess.label,
          guessKind: guess.kind,
        };
      }),
    };
  }

  if (action === 'highlight') {
    const found = resolve(payload.locator, new Set());
    if (!found) return { ok: false };
    flash(found.element);
    return { ok: true };
  }

  if (action === 'fill') {
    const entries = payload.entries || [];
    const assigned = assignTargets(entries);
    const results = [];
    // ログインボタンの押下は行わない。値の入力のみを担当する。
    for (const entry of entries) {
      const found = assigned.get(entry.fieldId);
      if (!found) {
        results.push({ fieldId: entry.fieldId, label: entry.label, status: 'not-found' });
        continue;
      }
      // 秘密情報は、入力欄の特定が確実な場合のみ入力する。
      if (found.weak && entry.kind === 'secret') {
        results.push({ fieldId: entry.fieldId, label: entry.label, status: 'weak-skipped' });
        continue;
      }
      try {
        applyValue(found.element, entry.value);
        results.push({
          fieldId: entry.fieldId,
          label: entry.label,
          status: found.weak ? 'filled-weak' : 'filled',
        });
      } catch {
        results.push({ fieldId: entry.fieldId, label: entry.label, status: 'error' });
      }
    }
    return { results };
  }

  return { error: 'unknown-action' };

  // --- URL の確認 -------------------------------------------------------
  // src/lib/match.js と同じ判定を、ページ内で完結させるために持つ。

  function urlMatchesRules(rules) {
    if (!Array.isArray(rules) || rules.length === 0) return false;
    let url;
    try {
      url = new URL(location.href);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return rules.some((rule) => originOk(rule, url) && pathOk(rule, url));
  }

  function originOk(rule, url) {
    if (!rule || !rule.origin) return false;
    if (rule.originMode !== 'suffix') return url.origin.toLowerCase() === rule.origin.toLowerCase();
    let expected;
    try {
      expected = new URL(rule.origin);
    } catch {
      return false;
    }
    if (expected.protocol !== url.protocol || expected.port !== url.port) return false;
    const host = url.hostname.toLowerCase();
    const base = expected.hostname.toLowerCase();
    return host === base || host.endsWith(`.${base}`);
  }

  function pathOk(rule, url) {
    if (rule.pathnameMode === 'any') return true;
    const target = trimPath(url.pathname);
    const expected = trimPath(rule.pathname || '/');
    if (rule.pathnameMode === 'prefix') {
      return target === expected || target.startsWith(expected === '/' ? '/' : `${expected}/`);
    }
    return target === expected;
  }

  function trimPath(pathname) {
    if (!pathname) return '/';
    const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
    return trimmed === '' ? '/' : trimmed;
  }

  /**
   * このフレーム自身の URL が、登録時に確認したフレーム URL（origin + pathname）と
   * 一致するか。子フレームへの入力直前の再確認に使う（query 文字列は無視する）。
   */
  function frameSelfMatches(check) {
    let url;
    try {
      url = new URL(location.href);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.origin !== check.origin) return false;
    return trimPath(url.pathname) === trimPath(check.pathname);
  }

  /** frame / iframe の name 属性（window.name）。取得できなければ空文字。 */
  function safeFrameName() {
    try {
      return typeof window.name === 'string' ? window.name : '';
    } catch {
      return '';
    }
  }

  // --- 要素収集 ---------------------------------------------------------

  /** 入力対象になり得る要素と、その識別情報の組を返す。 */
  function collectTargets() {
    const scan = createScanContext();
    const list = [];
    for (const element of document.querySelectorAll(FILLABLE_SELECTOR)) {
      const type = (element.type || '').toLowerCase();
      if (IGNORED_INPUT_TYPES.includes(type)) continue;
      if (element.disabled || element.readOnly) continue;
      if (!isVisible(element)) continue;
      list.push({ element, locator: buildLocator(element, scan) });
    }
    return list;
  }

  /**
   * 走査中に使い回す位置情報。
   *
   * 入力欄ごとにページ全体を数え直すと、入力欄の多い画面では走査に数秒かかり
   * 画面が固まったように見える。並び順はフォーム / 親要素ごとに 1 回だけ求める。
   */
  function createScanContext() {
    const forms = Array.from(document.forms);
    const orderCache = new Map();
    const positionCache = new Map();

    return {
      /** フォーム（フォーム外は文書全体）の何番目の入力欄か。 */
      indexInScope(scope, element) {
        let order = orderCache.get(scope);
        if (!order) {
          order = new Map();
          scope.querySelectorAll(FILLABLE_SELECTOR).forEach((node, index) => order.set(node, index));
          orderCache.set(scope, order);
        }
        return order.has(element) ? order.get(element) : -1;
      },

      /** 親要素の中で、同じタグの何番目か（nth / 同じタグの総数）。 */
      siblingPosition(node) {
        const parent = node.parentElement;
        let position = positionCache.get(parent);
        if (!position) {
          position = { nth: new Map(), total: new Map() };
          for (const child of parent.children) {
            const count = (position.total.get(child.tagName) || 0) + 1;
            position.total.set(child.tagName, count);
            position.nth.set(child, count);
          }
          positionCache.set(parent, position);
        }
        return { nth: position.nth.get(node), total: position.total.get(node.tagName) };
      },

      formIndex(form) {
        return form ? forms.indexOf(form) : -1;
      },
    };
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function buildLocator(element, scan) {
    const form = element.form;
    return {
      tagName: element.tagName.toLowerCase(),
      type: (element.type || '').toLowerCase(),
      elementId: element.id || '',
      name: element.name || '',
      autocomplete: element.getAttribute('autocomplete') || '',
      placeholder: element.getAttribute('placeholder') || '',
      ariaLabel: element.getAttribute('aria-label') || '',
      labelText: findLabelText(element),
      cssPath: buildCssPath(element, scan),
      formIndex: scan.formIndex(form),
      indexInForm: scan.indexInScope(form || document, element),
    };
  }

  /**
   * 入力欄に対応するラベル文字列を、確実な手掛かりから順に探す。
   *
   * 中身のある文字列だけを採用する。`<label><input></label>` のように文字を
   * 持たないラベルを採用してしまうと、表のセルや直前の要素といった後続の
   * 手掛かりを見に行かなくなり、項目名を判定できなくなる。
   */
  function findLabelText(element) {
    const texts = [];
    const add = (text) => {
      const trimmed = (text || '').replace(/\s+/g, ' ').trim();
      if (trimmed) texts.push(trimmed);
    };

    for (const label of element.labels || []) add(label.textContent);
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const node = document.getElementById(id);
        if (node) add(node.textContent);
      }
    }
    if (!texts.length) {
      const cell = element.closest('td, th');
      if (cell && cell.previousElementSibling) add(cell.previousElementSibling.textContent);
    }
    if (!texts.length && element.previousElementSibling) add(element.previousElementSibling.textContent);
    if (!texts.length) add(element.title);
    return texts.join(' ').slice(0, 80);
  }

  function buildCssPath(element, scan) {
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 8) {
      if (node.id) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body' || !node.parentElement) {
        parts.unshift(tag);
        break;
      }
      const { nth, total } = scan.siblingPosition(node);
      parts.unshift(total > 1 ? `${tag}:nth-of-type(${nth})` : tag);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function cssEscape(value) {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, '\\$&');
  }

  function guessMeaning(locator) {
    const haystack = [
      locator.elementId,
      locator.name,
      locator.autocomplete,
      locator.placeholder,
      locator.ariaLabel,
      locator.labelText,
    ].join(' ').toLowerCase().replace(/[\s_-]/g, '');
    for (const rule of GUESS_RULES) {
      if (rule.keys.some((key) => haystack.includes(key))) {
        return { label: rule.label, kind: rule.kind };
      }
    }
    if (locator.type === 'password') return { label: 'パスワード', kind: 'secret' };
    return { label: '', kind: 'text' };
  }

  // --- 要素の再特定 -----------------------------------------------------

  /**
   * 各項目へ入力欄を割り当てる。
   *
   * 確実に特定できた項目から先に割り当て、残った入力欄を弱い一致の項目へ回す。
   * 登録順にそのまま割り当てると、先に登録した項目の弱い一致が、後の項目が確実に
   * 特定できる入力欄を先取りしてしまい、別の欄へ入力される場合がある。
   *
   * 一度どれかの項目に割り当てた入力欄は、入力の可否によらず他の項目へ渡さない。
   *
   * @returns {Map<string, {element: Element, weak: boolean}>} 項目 ID → 入力欄
   */
  function assignTargets(entries) {
    const used = new Set();
    const assigned = new Map();
    for (const strongOnly of [true, false]) {
      for (const entry of entries) {
        if (assigned.has(entry.fieldId)) continue;
        const found = resolve(entry.locator, used);
        if (!found || (strongOnly && found.weak)) continue;
        used.add(found.element);
        assigned.set(entry.fieldId, found);
      }
    }
    return assigned;
  }

  function resolve(locator, used) {
    let best = null;
    for (const target of targets) {
      if (used.has(target.element)) continue;
      const score = scoreLocator(target.locator, locator);
      if (score <= 0) continue;
      if (!best || score > best.score) best = { element: target.element, score };
    }
    if (best && best.score >= 25) return { element: best.element, weak: best.score < 40 };

    // ヒントが一致しない場合でも、同種の入力欄が 1 つだけならそれを候補にする。
    if (locator.type) {
      const sameType = targets.filter(
        (target) => !used.has(target.element) && target.locator.type === locator.type,
      );
      if (sameType.length === 1) return { element: sameType[0].element, weak: true };
    }
    return null;
  }

  /** ページ上の入力欄（current）が、登録済みの識別情報（locator）とどれだけ一致するか。 */
  function scoreLocator(current, locator) {
    if (locator.tagName && current.tagName !== locator.tagName) return 0;
    if (locator.type === 'password' && current.type !== 'password') return 0;
    if (locator.type && locator.type !== 'password' && current.type === 'password') return 0;

    let score = 0;
    if (locator.elementId && current.elementId === locator.elementId) score += 50;
    if (locator.name && current.name === locator.name) score += 40;
    if (locator.cssPath && current.cssPath === locator.cssPath) score += 25;
    if (locator.autocomplete && current.autocomplete === locator.autocomplete) score += 10;
    if (locator.placeholder && current.placeholder === locator.placeholder) score += 10;
    if (locator.ariaLabel && current.ariaLabel === locator.ariaLabel) score += 8;
    if (locator.labelText && current.labelText) {
      if (current.labelText === locator.labelText) score += 14;
      else if (current.labelText.includes(locator.labelText) || locator.labelText.includes(current.labelText)) score += 7;
    }
    if (locator.type && current.type === locator.type) score += 6;
    if (locator.formIndex >= 0 && current.formIndex === locator.formIndex) {
      score += locator.indexInForm >= 0 && current.indexInForm === locator.indexInForm ? 14 : 3;
    }
    return score;
  }

  // --- 値の入力 ---------------------------------------------------------

  /**
   * 入力欄へ値を反映する。
   *
   * 入力欄の種類ごとに、ページへ変更を伝える方法が異なる。
   * チェックボックス / ラジオは click() 自体が input / change を発火するため、
   * 合成イベントを重ねない。重ねると、onchange で入力チェックを行う業務システムで
   * 検証が二重に走ってしまう（onblur の二重発火と同じ問題）。
   */
  function applyValue(element, value) {
    element.focus();
    try {
      if (element.tagName.toLowerCase() === 'select') {
        selectOption(element, value);
        notifyChanged(element);
      } else if (element.type === 'checkbox' || element.type === 'radio') {
        applyChecked(element, value);
      } else {
        setNativeValue(element, value);
        notifyChanged(element);
      }
    } finally {
      // 入力できなかった場合もフォーカスは戻す。
      // blur() 自体が blur / focusout を発火するため、合成イベントは送らない。
      element.blur();
    }
  }

  function selectOption(element, value) {
    const options = Array.from(element.options);
    const target = options.find((option) => option.value === value)
      || options.find((option) => (option.textContent || '').trim() === value);
    if (!target) throw new Error('option not found');
    element.value = target.value;
  }

  /**
   * チェックボックス / ラジオの状態を合わせる。
   *
   * ラジオはクリックしても解除できないため、値が一致しない場合はこの入力欄では
   * 登録値を表現できない。黙って何もせず「入力しました」と報告すると、
   * 区分が変わっていないことに気付けないため、入力できなかったものとして扱う。
   */
  function applyChecked(element, value) {
    const shouldCheck = value === element.value || value === 'true' || value === '1' || value === 'on';
    if (element.type === 'radio' && !shouldCheck) throw new Error('radio value mismatch');
    if (element.checked !== shouldCheck) element.click();
  }

  function setNativeValue(element, value) {
    const prototype = element.tagName.toLowerCase() === 'textarea'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  /** 値が変わったことをページへ伝える。 */
  function notifyChanged(element) {
    element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  /**
   * 対象の入力欄を一時的に強調表示する。
   *
   * 強調表示中はその印を属性で残し、二重に強調表示しない。印が無いと、
   * 「確認」を続けて押したときに強調表示中の見た目を「元の見た目」として
   * 覚えてしまい、枠線が消えなくなる。
   */
  function flash(element) {
    const FLASHING = 'data-lgpwmng-flash';
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (element.hasAttribute(FLASHING)) return;
    const previousOutline = element.style.outline;
    const previousOffset = element.style.outlineOffset;
    element.setAttribute(FLASHING, '');
    element.style.outline = '2px solid #d94f00';
    element.style.outlineOffset = '1px';
    setTimeout(() => {
      element.style.outline = previousOutline;
      element.style.outlineOffset = previousOffset;
      element.removeAttribute(FLASHING);
    }, 1600);
  }
}
