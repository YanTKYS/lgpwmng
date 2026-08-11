/**
 * 対象ページ内で実行される処理。
 *
 * この関数は chrome.scripting.executeScript の func として文字列化されて注入されるため、
 * 外部スコープの変数・import を一切参照しない自己完結した実装にしている。
 * 呼び出しは利用者が拡張を操作したタイミングのみで、常駐 content script は登録しない。
 *
 * @param {'scan'|'fill'|'highlight'} action
 * @param {object} payload
 */
export function pageAgent(action, payload) {
  const FILLABLE_TAGS = ['input', 'select', 'textarea'];
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

  const elements = collectElements();

  if (action === 'scan') {
    return {
      url: location.href,
      title: document.title,
      candidates: elements.map((element, index) => describe(element, index)),
    };
  }

  if (action === 'highlight') {
    const found = resolve(payload.locator, new Set());
    if (!found) return { ok: false };
    flash(found.element);
    return { ok: true };
  }

  if (action === 'fill') {
    // 入力の直前に、実行中のページ自身の URL が登録条件に一致するか確認する。
    // background 側の確認とページ遷移が競合しても、ここで確実に中止できる。
    if (!urlMatchesRules(payload.matchRules)) {
      return { error: 'url-mismatch', url: location.href };
    }

    const used = new Set();
    const results = [];
    // ログインボタンの押下は行わない。値の入力のみを担当する。
    for (const entry of payload.entries || []) {
      const found = resolve(entry.locator, used);
      if (!found) {
        results.push({ fieldId: entry.fieldId, label: entry.label, status: 'not-found' });
        continue;
      }
      // 秘密情報は、入力欄の特定が確実な場合のみ入力する。
      if (found.weak && entry.kind === 'secret') {
        results.push({ fieldId: entry.fieldId, label: entry.label, status: 'weak-skipped' });
        continue;
      }
      used.add(found.element);
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

  // --- 要素収集 ---------------------------------------------------------

  function collectElements() {
    const list = [];
    for (const element of document.querySelectorAll('input, select, textarea')) {
      if (!FILLABLE_TAGS.includes(element.tagName.toLowerCase())) continue;
      const type = (element.type || '').toLowerCase();
      if (IGNORED_INPUT_TYPES.includes(type)) continue;
      if (element.disabled || element.readOnly) continue;
      if (!isVisible(element)) continue;
      list.push(element);
    }
    return list;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function describe(element, index) {
    const locator = buildLocator(element);
    const guess = guessMeaning(element, locator);
    return {
      index,
      locator,
      guessLabel: guess.label,
      guessKind: guess.kind,
      hasValue: Boolean(element.value),
      options: element.tagName.toLowerCase() === 'select'
        ? Array.from(element.options).slice(0, 50).map((option) => ({
          value: option.value,
          text: (option.textContent || '').trim().slice(0, 60),
        }))
        : [],
    };
  }

  function buildLocator(element) {
    const form = element.form;
    const forms = Array.from(document.forms);
    const formIndex = form ? forms.indexOf(form) : -1;
    const scope = form || document;
    const siblings = Array.from(scope.querySelectorAll('input, select, textarea'));
    return {
      tagName: element.tagName.toLowerCase(),
      type: (element.type || '').toLowerCase(),
      elementId: element.id || '',
      name: element.name || '',
      autocomplete: element.getAttribute('autocomplete') || '',
      placeholder: element.getAttribute('placeholder') || '',
      ariaLabel: element.getAttribute('aria-label') || '',
      labelText: findLabelText(element),
      cssPath: buildCssPath(element),
      formIndex,
      indexInForm: siblings.indexOf(element),
    };
  }

  function findLabelText(element) {
    const texts = [];
    if (element.labels && element.labels.length) {
      for (const label of element.labels) texts.push(label.textContent || '');
    }
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const node = document.getElementById(id);
        if (node) texts.push(node.textContent || '');
      }
    }
    if (!texts.length) {
      const cell = element.closest('td, th');
      const previousCell = cell && cell.previousElementSibling;
      if (previousCell) texts.push(previousCell.textContent || '');
    }
    if (!texts.length && element.previousElementSibling) {
      texts.push(element.previousElementSibling.textContent || '');
    }
    if (!texts.length && element.title) texts.push(element.title);
    return texts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function buildCssPath(element) {
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 8) {
      if (node.id) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') {
        parts.unshift(tag);
        break;
      }
      const parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const sameTag = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag);
      node = parent;
    }
    return parts.join(' > ');
  }

  function cssEscape(value) {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, '\\$&');
  }

  function guessMeaning(element, locator) {
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

  function resolve(locator, used) {
    let best = null;
    for (const element of elements) {
      if (used.has(element)) continue;
      const score = scoreElement(element, locator);
      if (score <= 0) continue;
      if (!best || score > best.score) best = { element, score };
    }
    if (best && best.score >= 25) return { element: best.element, weak: best.score < 40 };

    // ヒントが一致しない場合でも、同種の入力欄が 1 つだけならそれを候補にする。
    if (locator.type) {
      const sameType = elements.filter(
        (element) => !used.has(element) && (element.type || '').toLowerCase() === locator.type,
      );
      if (sameType.length === 1) return { element: sameType[0], weak: true };
    }
    return null;
  }

  function scoreElement(element, locator) {
    const current = buildLocator(element);
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

  function applyValue(element, value) {
    const tag = element.tagName.toLowerCase();
    element.focus();
    if (tag === 'select') {
      selectOption(element, value);
    } else if (element.type === 'checkbox' || element.type === 'radio') {
      const checked = value === element.value || value === 'true' || value === '1' || value === 'on';
      if (element.checked !== checked) element.click();
    } else {
      setNativeValue(element, value);
    }
    dispatch(element, 'input');
    dispatch(element, 'change');
    element.blur();
    dispatch(element, 'blur');
  }

  function selectOption(element, value) {
    const options = Array.from(element.options);
    const target = options.find((option) => option.value === value)
      || options.find((option) => (option.textContent || '').trim() === value);
    if (!target) throw new Error('option not found');
    element.value = target.value;
  }

  function setNativeValue(element, value) {
    const prototype = element.tagName.toLowerCase() === 'textarea'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(element, value);
    else element.value = value;
  }

  function dispatch(element, type) {
    const event = type === 'input'
      ? new InputEvent('input', { bubbles: true, composed: true })
      : new Event(type, { bubbles: true, composed: true });
    element.dispatchEvent(event);
  }

  function flash(element) {
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const previousOutline = element.style.outline;
    const previousOffset = element.style.outlineOffset;
    element.style.outline = '2px solid #d94f00';
    element.style.outlineOffset = '1px';
    setTimeout(() => {
      element.style.outline = previousOutline;
      element.style.outlineOffset = previousOffset;
    }, 1600);
  }
}
