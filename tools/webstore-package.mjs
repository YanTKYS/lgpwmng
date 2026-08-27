/**
 * Chrome ウェブストアへアップロードする公開用 ZIP を生成する。
 *
 *   node tools/webstore-package.mjs [--out-dir dist]
 *
 * 公開用パッケージには「拡張の実行に必要なファイル」だけを入れる。
 * 対象は許可リスト（PACKAGE_ROOTS）で決めており、docs / test / .github /
 * 開発用ファイルは列挙するまでもなく入らない。逆に実行に必要なファイルが
 * 抜けないことは、manifest.json と HTML / JS の参照を辿って検証する
 * （collectReferencedPaths）。この検証は自動テストからも呼び出す。
 */
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './zip.mjs';

export const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 公開用 ZIP へ入れるファイル・ディレクトリ（リポジトリ相対）。 */
export const PACKAGE_ROOTS = ['manifest.json', 'icons', 'src'];

/** 実行に不要なため、許可リスト配下にあっても除外するファイル名。 */
const EXCLUDED_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

function walk(root, base, out) {
  const stat = statSync(join(base, root));
  if (stat.isFile()) {
    if (!EXCLUDED_NAMES.has(posix.basename(root))) out.push(root);
    return out;
  }
  for (const name of readdirSync(join(base, root)).sort()) {
    walk(posix.join(root, name), base, out);
  }
  return out;
}

/**
 * 公開用 ZIP へ含めるファイルの一覧（ZIP 内パス、`/` 区切り、昇順）。
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function collectPackageFiles(repoRoot = REPO_ROOT) {
  const files = [];
  for (const entry of PACKAGE_ROOTS) walk(entry, repoRoot, files);
  return files.sort();
}

const RELATIVE_REF = /^(?!https?:|data:|chrome-extension:|#|\/\/)/;

function htmlReferences(source) {
  const refs = [];
  for (const match of source.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
    const value = match[1].split('#')[0].split('?')[0];
    if (value && RELATIVE_REF.test(value)) refs.push({ path: value, base: 'file' });
  }
  return refs;
}

function jsReferences(source) {
  const refs = [];
  // import / from はそのファイルからの相対、chrome.runtime.getURL() は拡張ルートからの相対。
  const relative = [/\bfrom\s+['"`]([^'"`]+)['"`]/g, /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g];
  for (const pattern of relative) {
    for (const match of source.matchAll(pattern)) {
      if (RELATIVE_REF.test(match[1])) refs.push({ path: match[1], base: 'file' });
    }
  }
  for (const match of source.matchAll(/chrome\.runtime\.getURL\(\s*['"`]([^'"`?]+)/g)) {
    if (RELATIVE_REF.test(match[1])) refs.push({ path: match[1], base: 'root' });
  }
  return refs;
}

function cssReferences(source) {
  const refs = [];
  for (const match of source.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
    if (RELATIVE_REF.test(match[1])) refs.push({ path: match[1], base: 'file' });
  }
  return refs;
}

function manifestReferences(manifest) {
  const refs = [];
  const visit = (value, key) => {
    if (typeof value === 'string') {
      // manifest 内でファイルを指すのは、拡張ルートからの相対パスだけ。
      if (/\.(js|html|css|png|json)$/i.test(value)) refs.push({ path: value, base: 'root' });
      return;
    }
    if (Array.isArray(value)) { value.forEach((item) => visit(item, key)); return; }
    if (value && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) visit(item, name);
    }
  };
  visit(manifest);
  return refs;
}

/**
 * manifest.json を起点に、拡張の実行時に読み込まれるファイルを辿って集める。
 * 参照先が見つからない場合は例外を投げる（リンク切れの検出を兼ねる）。
 *
 * @param {string} repoRoot
 * @returns {string[]} 拡張ルート相対パス（`/` 区切り、昇順）
 */
export function collectReferencedPaths(repoRoot = REPO_ROOT) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'manifest.json'), 'utf8'));
  const seen = new Set(['manifest.json']);
  const normalize = (ref, from) => (ref.base === 'root'
    ? posix.normalize(ref.path.replace(/^\.?\//, ''))
    : posix.normalize(posix.join(posix.dirname(from), ref.path)));

  const queue = manifestReferences(manifest).map((ref) => normalize(ref, 'manifest.json'));

  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);

    let source;
    try {
      source = readFileSync(join(repoRoot, path));
    } catch {
      throw new Error(`参照先のファイルがありません: ${path}`);
    }

    let refs = [];
    if (path.endsWith('.html')) refs = htmlReferences(source.toString('utf8'));
    else if (path.endsWith('.js')) refs = jsReferences(source.toString('utf8'));
    else if (path.endsWith('.css')) refs = cssReferences(source.toString('utf8'));

    for (const ref of refs) queue.push(normalize(ref, path));
  }

  return [...seen].sort();
}

/** manifest.json の version。 */
export function packageVersion(repoRoot = REPO_ROOT) {
  return JSON.parse(readFileSync(join(repoRoot, 'manifest.json'), 'utf8')).version;
}

/** 公開用 ZIP のファイル名。 */
export function packageFileName(version) {
  return `lgpwmng-webstore-v${version}.zip`;
}

/**
 * 公開用 ZIP を組み立てて Buffer で返す（ファイルへは書き出さない）。
 * @param {string} repoRoot
 */
export function buildPackage(repoRoot = REPO_ROOT) {
  const files = collectPackageFiles(repoRoot);
  const missing = collectReferencedPaths(repoRoot).filter((path) => !files.includes(path));
  if (missing.length > 0) {
    throw new Error(`実行に必要なファイルが公開用 ZIP から漏れています: ${missing.join(', ')}`);
  }
  return createZip(files.map((name) => ({ name, data: readFileSync(join(repoRoot, name)) })));
}

function main(argv) {
  const outIndex = argv.indexOf('--out-dir');
  const outDir = outIndex >= 0 ? argv[outIndex + 1] : join(REPO_ROOT, 'dist');
  const version = packageVersion();
  const zip = buildPackage();
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, packageFileName(version));
  writeFileSync(outPath, zip);

  const files = collectPackageFiles();
  process.stdout.write(`${relative(REPO_ROOT, outPath) || outPath} (${files.length} files, ${zip.length} bytes)\n`);
  for (const file of files) process.stdout.write(`  ${file}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
