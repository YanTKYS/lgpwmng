/**
 * 公開（Chrome ウェブストア）準備に関する検査。
 *
 * 機能の振る舞いではなく、「公開してよい状態か」を機械的に確認する。
 *   - manifest.json が Manifest V3 で、権限が最小限であること
 *   - 外部通信・リモートコード・認証情報のログ出力が存在しないこと
 *   - 公開用 ZIP の中身が正しいこと（直下に manifest.json、開発用ファイルの混入なし）
 *   - Privacy Policy と審査用デモが存在し、内容がずれていないこと
 *   - 各所のバージョン表記が一致していること
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_ROOTS,
  buildPackage,
  collectPackageFiles,
  collectReferencedPaths,
  packageFileName,
  packageVersion,
} from '../tools/webstore-package.mjs';
import { readZip } from '../tools/zip.mjs';
import { OUTPUT_PATH, buildPrivacyPage } from '../tools/build-docs.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

/** 拡張本体のソース（公開用 ZIP に入るファイル）のみを対象にした一覧。 */
function extensionSources(extensions) {
  return collectPackageFiles(ROOT).filter((path) => extensions.some((ext) => path.endsWith(ext)));
}

function walkFiles(dir, base = ROOT, out = []) {
  for (const name of readdirSync(join(base, dir))) {
    const path = posix.join(dir, name);
    if (statSync(join(base, path)).isDirectory()) walkFiles(path, base, out);
    else out.push(path);
  }
  return out;
}

// --- manifest.json ------------------------------------------------------------

test('manifest.json は JSON として有効で、Manifest V3 である', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(typeof manifest.name, 'string');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('manifest.json の name と description がウェブストアの上限に収まる', () => {
  // 名前は 75 文字、description は 132 文字が上限（Chrome ウェブストア）。
  assert.ok(manifest.name.length <= 75, `name が長すぎます: ${manifest.name.length} 文字`);
  assert.ok(manifest.description.length > 0);
  assert.ok(
    manifest.description.length <= 132,
    `description が 132 文字を超えています: ${manifest.description.length} 文字`,
  );
});

test('manifest.json の権限は activeTab / scripting / storage のみ', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting', 'storage']);
  assert.equal(manifest.host_permissions, undefined, 'host_permissions は宣言しない');
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined, '常駐 content script は登録しない');
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
});

test('manifest.json に <all_urls> 等の広範な URL パターンがない', () => {
  const source = read('manifest.json');
  for (const pattern of ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*']) {
    assert.ok(!source.includes(pattern), `manifest.json に ${pattern} が含まれています`);
  }
});

test('CSP がリモートコードを許可していない', () => {
  const csp = manifest.content_security_policy?.extension_pages;
  assert.equal(typeof csp, 'string', 'extension_pages の CSP を明示する');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'self'/);
  for (const unsafe of ["'unsafe-eval'", "'unsafe-inline'", 'wasm-unsafe-eval', 'http://', 'https://']) {
    assert.ok(!csp.includes(unsafe), `CSP に ${unsafe} が含まれています`);
  }
});

test('アイコンは 16 / 32 / 48 / 128 の 4 サイズが揃っている', () => {
  for (const icons of [manifest.icons, manifest.action.default_icon]) {
    assert.deepEqual(Object.keys(icons).sort(), ['128', '16', '32', '48']);
    for (const [size, path] of Object.entries(icons)) {
      assert.ok(existsSync(join(ROOT, path)), `${path} がありません`);
      // PNG の IHDR から実寸を読む（実寸とサイズ指定のずれを防ぐ）。
      const png = readFileSync(join(ROOT, path));
      assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG', `${path} が PNG ではありません`);
      assert.equal(png.readUInt32BE(16), Number(size), `${path} の幅が ${size} ではありません`);
      assert.equal(png.readUInt32BE(20), Number(size), `${path} の高さが ${size} ではありません`);
    }
  }
});

// --- 外部通信・リモートコード ---------------------------------------------------

test('拡張のソースに外部通信 API の呼び出しがない', () => {
  const forbidden = [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
    /\bEventSource\b/,
    /\bsendBeacon\s*\(/,
    /\bimportScripts\s*\(/,
    /\bnavigator\.connection\b/,
    /chrome\.storage\.sync\b/,
  ];
  for (const path of extensionSources(['.js', '.html', '.css'])) {
    const source = read(path);
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(source), `${path} に ${pattern} が含まれています`);
    }
  }
});

test('拡張のソースに外部 URL の参照がない', () => {
  // 例外はドキュメント上の例示（プレースホルダ・エラーメッセージ）のみ。
  // 実際に読み込みや接続を行う形（src= / href= / import / connect）を禁止する。
  const loaders = [
    /<script[^>]+src\s*=\s*["']https?:/i,
    /<link[^>]+href\s*=\s*["']https?:/i,
    /<iframe/i,
    /@import\s+url\(\s*["']?https?:/i,
    /\bfrom\s+["'`]https?:/,
    /\bimport\s*\(\s*["'`]https?:/,
    /url\(\s*["']?https?:/,
  ];
  for (const path of extensionSources(['.js', '.html', '.css'])) {
    const source = read(path);
    for (const pattern of loaders) {
      assert.ok(!pattern.test(source), `${path} が外部リソースを参照しています（${pattern}）`);
    }
  }
});

test('拡張のソースに文字列からのコード生成がない', () => {
  const forbidden = [
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
    /setTimeout\s*\(\s*['"`]/,
    /setInterval\s*\(\s*['"`]/,
    /\binnerHTML\b/,
    /\bouterHTML\b/,
    /insertAdjacentHTML/,
    /document\.write/,
  ];
  for (const path of extensionSources(['.js', '.html'])) {
    const source = read(path);
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(source), `${path} に ${pattern} が含まれています`);
    }
  }
});

test('分析・広告・テレメトリの記述がない', () => {
  const forbidden = /google-analytics|googletagmanager|gtag\(|sentry|bugsnag|mixpanel|amplitude|doubleclick/i;
  for (const path of extensionSources(['.js', '.html', '.css', '.json'])) {
    assert.ok(!forbidden.test(read(path)), `${path} に外部サービスの記述があります`);
  }
});

// --- 認証情報のログ出力 ---------------------------------------------------------

test('拡張のソースに console 出力がない', () => {
  // 認証情報が意図せずログへ出ることを防ぐため、console 出力自体を置かない方針。
  for (const path of extensionSources(['.js'])) {
    assert.ok(!/\bconsole\s*\.\s*\w+\s*\(/.test(read(path)), `${path} に console 出力があります`);
  }
});

test('例外メッセージへ値そのものを埋め込んでいない', () => {
  // throw / Error のメッセージに、値を保持する変数を差し込んでいないことを確認する。
  const valueLike = /\b(password|secret|credential|sharedValues|passphrase)\b/i;
  for (const path of extensionSources(['.js'])) {
    const source = read(path);
    for (const match of source.matchAll(/(?:throw new \w*Error|new \w*Error)\(([^)]*)\)/g)) {
      assert.ok(
        !valueLike.test(match[1]),
        `${path} の例外メッセージが値を含む可能性があります: ${match[0]}`,
      );
    }
  }
});

test('テストのダミー認証情報が実在の資格情報らしくない', () => {
  // test/ と docs/ で使う値は、審査用デモと同じ明示的なダミー値に揃える。
  const demo = read('docs/reviewer-demo.html');
  for (const dummy of ['123456', 'test-user', 'test-pass-123']) {
    assert.ok(demo.includes(dummy), `審査用デモにダミー値 ${dummy} の記載がありません`);
  }
});

// --- 公開用パッケージ -----------------------------------------------------------

test('公開用 ZIP の対象は manifest.json / icons / src だけ', () => {
  assert.deepEqual(PACKAGE_ROOTS, ['manifest.json', 'icons', 'src']);
  const files = collectPackageFiles(ROOT);
  assert.ok(files.includes('manifest.json'));
  for (const file of files) {
    assert.ok(
      file === 'manifest.json' || file.startsWith('icons/') || file.startsWith('src/'),
      `公開対象に想定外のファイルがあります: ${file}`,
    );
  }
});

test('公開用 ZIP に開発用ファイルが混入しない', () => {
  const files = collectPackageFiles(ROOT);
  const excluded = [
    '.git/', '.github/', 'test/', 'docs/', 'tools/', 'dist/', 'node_modules/',
    'README.md', 'release-note.md', 'PRIVACY.md', 'package.json', 'package-lock.json',
  ];
  for (const file of files) {
    for (const prefix of excluded) {
      assert.ok(!file.startsWith(prefix), `${file} は公開用 ZIP に含めない`);
    }
    assert.ok(!file.endsWith('.test.js'), `${file} は公開用 ZIP に含めない`);
    assert.ok(!file.startsWith('.'), `${file} は公開用 ZIP に含めない`);
  }
});

test('実行に必要なファイルが公開用 ZIP から漏れていない', () => {
  // manifest.json を起点に HTML / JS / CSS の参照を辿り、到達するファイルを確認する。
  const referenced = collectReferencedPaths(ROOT);
  const files = collectPackageFiles(ROOT);
  for (const path of referenced) {
    assert.ok(files.includes(path), `参照されているのに公開用 ZIP へ入っていません: ${path}`);
  }
  // 逆に、パッケージへ入れるファイルはすべて manifest から到達できる（死蔵ファイルがない）。
  for (const path of files) {
    assert.ok(referenced.includes(path), `どこからも参照されていません: ${path}`);
  }
});

test('生成した ZIP の直下に manifest.json があり、中身が一致する', () => {
  const entries = readZip(buildPackage(ROOT));
  const names = entries.map((entry) => entry.name).sort();

  assert.ok(names.includes('manifest.json'), 'ZIP 直下に manifest.json がありません');
  // 「直下」であること: manifest.json を含むディレクトリで包まない。
  for (const name of names) {
    assert.ok(!name.startsWith('/'), `絶対パスで格納されています: ${name}`);
    assert.ok(!name.includes('..'), `相対参照が含まれています: ${name}`);
    assert.ok(!name.startsWith('lgpwmng/'), `ZIP をフォルダで包まない: ${name}`);
  }
  assert.deepEqual(names, collectPackageFiles(ROOT));

  const packedManifest = entries.find((entry) => entry.name === 'manifest.json');
  assert.deepEqual(JSON.parse(packedManifest.data.toString('utf8')), manifest);

  for (const entry of entries) {
    assert.deepEqual(entry.data, readFileSync(join(ROOT, entry.name)), `${entry.name} の内容が一致しません`);
  }
});

test('公開用 ZIP のファイル名にバージョンが入る', () => {
  assert.equal(packageVersion(ROOT), manifest.version);
  assert.equal(packageFileName(manifest.version), `lgpwmng-webstore-v${manifest.version}.zip`);
});

// --- 公開ドキュメント -----------------------------------------------------------

test('Privacy Policy と審査用デモが存在する', () => {
  for (const path of [
    'PRIVACY.md',
    'docs/privacy.html',
    'docs/index.html',
    'docs/reviewer-demo.html',
    'docs/webstore-review.md',
    'docs/webstore/single-purpose.md',
    'docs/webstore/permissions.md',
    'docs/webstore/privacy-practices.md',
    'docs/webstore/remote-code.md',
    'docs/webstore/listing-ja.md',
    'docs/webstore/screenshots.md',
    'docs/webstore/checklist.md',
  ]) {
    assert.ok(existsSync(join(ROOT, path)), `${path} がありません`);
    assert.ok(read(path).trim().length > 0, `${path} が空です`);
  }
});

test('docs/privacy.html は PRIVACY.md から生成した内容と一致する', () => {
  assert.equal(
    read(OUTPUT_PATH),
    buildPrivacyPage(ROOT),
    'PRIVACY.md を変更したら node tools/build-docs.mjs を実行してください',
  );
});

test('申告するデータ種別が申告案・チェックリスト・Privacy Policy で一致する', () => {
  // 申告・Privacy Policy・実際の挙動が食い違うとポリシー違反になり得るため、
  // 資料側の記載がずれないようにしておく。
  const declared = [
    'Personally identifiable information',
    'Authentication information',
    'Website content',
    'Web history',
  ];
  const practices = read('docs/webstore/privacy-practices.md');
  const checklist = read('docs/webstore/checklist.md');
  const policy = read('PRIVACY.md');

  for (const type of declared) {
    assert.ok(practices.includes(type), `privacy-practices.md に ${type} の記載がありません`);
    assert.ok(checklist.includes(type), `checklist.md に ${type} の記載がありません`);
    assert.ok(policy.includes(type), `PRIVACY.md に ${type} の記載がありません`);
  }
  // チェックしない種別を誤って申告対象へ入れていないこと。
  for (const type of ['Health information', 'Personal communications', 'Location', 'User activity']) {
    assert.match(
      practices,
      new RegExp(`\\| ${type} \\| しない \\|`),
      `privacy-practices.md で ${type} が「しない」になっていません`,
    );
  }
  // URL を扱うことが Privacy Policy 側にも書かれていること。
  assert.ok(policy.includes('web browsing activity'), 'PRIVACY.md に URL の分類の説明がありません');
});

test('必須の掲載画像が資料全体で必須として書かれている', () => {
  // Chrome ウェブストアの必須画像は 128x128 アイコン / スクリーンショット 1 枚以上 /
  // 440x280 の small promo tile。任意なのは 1400x560 の marquee のみ。
  for (const path of [
    'docs/webstore/screenshots.md',
    'docs/webstore/listing-ja.md',
    'docs/webstore/checklist.md',
    'docs/webstore/assets/README.md',
  ]) {
    const lines = read(path).split('\n').filter((line) => line.includes('440x280'));
    assert.ok(lines.length > 0, `${path} に small promo tile の記載がありません`);
    assert.ok(
      lines.some((line) => line.includes('必須')),
      `${path} が small promo tile を必須として書いていません`,
    );
    for (const line of lines) {
      assert.ok(
        !line.includes('任意') || line.includes('必須'),
        `${path} が small promo tile を任意として扱っています（必須です）: ${line.trim()}`,
      );
    }
  }
  // 任意なのは marquee だけであることも確認する。
  const screenshots = read('docs/webstore/screenshots.md');
  assert.match(screenshots, /1400x560[^\n]*任意|Marquee[^\n]*任意/, 'marquee は任意と書く');
});

test('Privacy Policy に外部送信しない旨と保存方法が明記されている', () => {
  const policy = read('PRIVACY.md');
  for (const phrase of [
    '外部サーバーへ送信しません',
    'chrome.storage.local',
    'PBKDF2',
    'AES-GCM',
    'マスターパスワードそのものは保存しません',
    'データ販売',
  ]) {
    assert.ok(policy.includes(phrase), `PRIVACY.md に「${phrase}」の記載がありません`);
  }
});

test('審査用デモに実在の組織名・内部ドメインを使っていない', () => {
  const forbidden = /lgwan\.jp|asp\.lgwan|\.lg\.jp/i;
  for (const path of walkFiles('docs').filter((file) => file.endsWith('.html'))) {
    assert.ok(!forbidden.test(read(path)), `${path} に実在ドメインらしき記述があります`);
  }
});

test('審査用デモは送信・外部読み込みを行わない', () => {
  for (const name of ['reviewer-demo.html', 'reviewer-demo-frame.html', 'reviewer-demo-frame-inner.html']) {
    const source = read(`docs/${name}`);
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(source), `docs/${name} が通信を行っています`);
    assert.ok(!/<script[^>]+src=/i.test(source), `docs/${name} が外部スクリプトを読み込んでいます`);
    assert.ok(!/\baction\s*=\s*["']http/i.test(source), `docs/${name} のフォームが外部へ送信します`);
  }
});

// --- バージョン整合 -------------------------------------------------------------

test('manifest / README / release-note のバージョンが一致する', () => {
  const version = manifest.version;

  const readme = read('README.md');
  const readmeVersion = readme.match(/現在のバージョン:\s*v(\d+\.\d+\.\d+)/);
  assert.ok(readmeVersion, 'README.md に「現在のバージョン: vX.Y.Z」の記載がありません');
  assert.equal(readmeVersion[1], version, 'README.md のバージョンが manifest.json と一致しません');

  const notes = read('release-note.md');
  const latest = notes.match(/^##\s+v(\d+\.\d+\.\d+)/m);
  assert.ok(latest, 'release-note.md に「## vX.Y.Z」の見出しがありません');
  assert.equal(latest[1], version, 'release-note.md の最新見出しが manifest.json と一致しません');
});

test('画面のバージョン表示は manifest から取得している', () => {
  // 表示を二重管理しないための確認。HTML / JS へ番号を直書きしない。
  assert.ok(
    read('src/options/options.js').includes('chrome.runtime.getManifest().version'),
    'options のバージョン表示は manifest から取得する',
  );
  for (const path of extensionSources(['.js', '.html'])) {
    const source = read(path);
    assert.ok(
      !new RegExp(`v?${manifest.version.replace(/\./g, '\\.')}`).test(source),
      `${path} にバージョン番号が直書きされています`,
    );
  }
});
