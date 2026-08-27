/**
 * PRIVACY.md から GitHub Pages 公開用の docs/privacy.html を生成する。
 *
 *   node tools/build-docs.mjs           生成して書き出す
 *   node tools/build-docs.mjs --check   生成結果と既存ファイルが一致するか確認する
 *
 * プライバシーポリシーはリポジトリ内（PRIVACY.md）とウェブ公開版（docs/privacy.html）の
 * 2 か所で示す必要があるため、片方を単一の出典として生成する。内容がずれていないことは
 * 自動テスト（`--check` と同じ比較）で確認する。
 *
 * 対応する Markdown は PRIVACY.md で使っている範囲だけ（見出し・段落・箇条書き・番号付き
 * 箇条書き・表・引用・水平線と、強調 / コード / リンクのインライン記法）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const SOURCE_PATH = 'PRIVACY.md';
export const OUTPUT_PATH = 'docs/privacy.html';

const REPO_BLOB = 'https://github.com/YanTKYS/lgpwmng/blob/main/';

/** この行が現れたら、続く 1 ブロックを HTML 版から除く（リポジトリ内でだけ意味のある案内）。 */
const MD_ONLY = '<!-- md-only -->';

const escapeHtml = (text) => text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function resolveHref(href) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  return REPO_BLOB + href.replace(/^\.?\//, '');
}

function inline(text) {
  const codes = [];
  // コード中の記法を解釈しないよう、先に取り置く。
  let out = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `@@code${codes.length - 1}@@`;
  });

  out = escapeHtml(out);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${escapeHtml(resolveHref(href))}">${label}</a>`);
  out = out.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_, url) => `<a href="${url}">${url}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/@@code(\d+)@@/g, (_, index) => codes[Number(index)]);
  return out;
}

const isTableRow = (line) => line.startsWith('|') && line.endsWith('|');
const splitRow = (line) => line.slice(1, -1).split('|').map((cell) => cell.trim());

/**
 * @param {string} markdown
 * @returns {string} body の中身にあたる HTML
 */
export function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  const paragraph = [];
  let index = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph.length = 0;
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed === MD_ONLY) {
      flushParagraph();
      index += 1;
      while (index < lines.length && lines[index].trim() !== '') index += 1;
      continue;
    }

    if (trimmed === '') { flushParagraph(); index += 1; continue; }

    if (/^---+$/.test(trimmed)) {
      flushParagraph();
      html.push('<hr>');
      index += 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (isTableRow(trimmed) && index + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[index + 1].trim())) {
      flushParagraph();
      const header = splitRow(trimmed);
      index += 2;
      const rows = [];
      while (index < lines.length && isTableRow(lines[index].trim())) {
        rows.push(splitRow(lines[index].trim()));
        index += 1;
      }
      html.push('<table>');
      html.push(`<thead><tr>${header.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead>`);
      html.push('<tbody>');
      for (const row of rows) html.push(`<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`);
      html.push('</tbody></table>');
      continue;
    }

    if (trimmed.startsWith('> ')) {
      flushParagraph();
      const quote = [];
      while (index < lines.length && lines[index].trim().startsWith('> ')) {
        quote.push(lines[index].trim().slice(2));
        index += 1;
      }
      html.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`);
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.*)$/);
    const numbered = trimmed.match(/^\d+\.\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      const items = [];
      while (index < lines.length) {
        const current = lines[index].trim();
        const match = ordered ? current.match(/^\d+\.\s+(.*)$/) : current.match(/^[-*]\s+(.*)$/);
        if (match) { items.push(match[1]); index += 1; continue; }
        // 字下げされた続きの行は、直前の項目の続きとして扱う。
        if (current !== '' && /^\s{2,}/.test(lines[index]) && items.length > 0) {
          items[items.length - 1] += ` ${current}`;
          index += 1;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>`);
      for (const item of items) html.push(`<li>${inline(item)}</li>`);
      html.push(`</${tag}>`);
      continue;
    }

    paragraph.push(trimmed);
    index += 1;
  }

  flushParagraph();
  return html.join('\n');
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto;
    padding: 2rem 1.25rem 4rem;
    max-width: 46rem;
    font-family: system-ui, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", sans-serif;
    line-height: 1.8;
    color: #1c1f23;
    background: #fff;
  }
  h1 { font-size: 1.6rem; line-height: 1.4; margin: 0 0 1.5rem; }
  h2 { font-size: 1.2rem; margin: 2.5rem 0 0.75rem; padding-bottom: 0.35rem; border-bottom: 1px solid #d8dde3; }
  h3 { font-size: 1.02rem; margin: 1.75rem 0 0.5rem; }
  p, li { font-size: 0.95rem; }
  ul, ol { padding-left: 1.4rem; }
  li { margin: 0.3rem 0; }
  a { color: #0b5cab; }
  code {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 0.88em;
    background: #f1f3f5;
    padding: 0.1em 0.35em;
    border-radius: 3px;
  }
  blockquote {
    margin: 1.25rem 0;
    padding: 0.6rem 1rem;
    border-left: 4px solid #0b5cab;
    background: #f4f7fb;
  }
  blockquote p { margin: 0; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; display: block; overflow-x: auto; }
  th, td { border: 1px solid #d8dde3; padding: 0.45rem 0.6rem; text-align: left; vertical-align: top; font-size: 0.9rem; }
  th { background: #f1f3f5; white-space: nowrap; }
  hr { border: 0; border-top: 1px solid #d8dde3; margin: 2rem 0; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #d8dde3; font-size: 0.85rem; color: #5a626b; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6e9ee; background: #14171a; }
    h2, hr, th, td, footer { border-color: #333a42; }
    a { color: #74b3f0; }
    code { background: #22272c; }
    th { background: #1d2227; }
    blockquote { background: #1b2129; border-left-color: #74b3f0; }
    footer { color: #9aa4af; }
  }
`.trim();

/** PRIVACY.md の内容から docs/privacy.html の全文を組み立てる。 */
export function renderPrivacyPage(markdown) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="index, follow">
<title>lgpwmng プライバシーポリシー</title>
<style>
${PAGE_STYLE}
</style>
</head>
<body>
<main>
${renderMarkdown(markdown)}
</main>
<footer>
<p>このページは、リポジトリの <a href="${REPO_BLOB}${SOURCE_PATH}">${SOURCE_PATH}</a> から生成しています（<code>node tools/build-docs.mjs</code>）。両者の内容は同一です。</p>
<p><a href="./">lgpwmng ドキュメント</a> / <a href="https://github.com/YanTKYS/lgpwmng">GitHub リポジトリ</a></p>
</footer>
</body>
</html>
`;
}

/** 生成結果の全文。 */
export function buildPrivacyPage(repoRoot = REPO_ROOT) {
  return renderPrivacyPage(readFileSync(join(repoRoot, SOURCE_PATH), 'utf8'));
}

function main(argv) {
  const expected = buildPrivacyPage();
  const outPath = join(REPO_ROOT, OUTPUT_PATH);

  if (argv.includes('--check')) {
    let actual = '';
    try { actual = readFileSync(outPath, 'utf8'); } catch { /* 未生成 */ }
    if (actual !== expected) {
      process.stderr.write(`${OUTPUT_PATH} が ${SOURCE_PATH} と一致しません。node tools/build-docs.mjs を実行してください。\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${OUTPUT_PATH} は ${SOURCE_PATH} と一致しています。\n`);
    return;
  }

  writeFileSync(outPath, expected);
  process.stdout.write(`${OUTPUT_PATH} を生成しました。\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
