/**
 * 庁内テスト配布用 CRX（#27）に関する検査。
 *
 *   - CRX の検証（tools/crx.mjs）が、署名・拡張 ID・中身・秘密鍵の混入を正しく判定すること
 *   - workflow が、タグ以外では動かず、署名鍵を最小の範囲でしか使わないこと
 *
 * Chrome 本体での CRX 生成と、実機でのインストール可否はここでは確認しない
 * （後者は docs/internal-crx-distribution.md の実機検証項目）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSameContents, extensionIdFromPublicKey, parseCrx, verifyCrx } from '../tools/crx.mjs';
import { createZip } from '../tools/zip.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

// --- CRX3 を組み立てる（Chrome の --pack-extension と同じ形式） --------------------

function varint(value) {
  const bytes = [];
  let rest = value;
  while (rest > 0x7f) { bytes.push((rest & 0x7f) | 0x80); rest = Math.floor(rest / 128); }
  bytes.push(rest);
  return Buffer.from(bytes);
}

const field = (number, data) => Buffer.concat([varint(number * 8 + 2), varint(data.length), data]);

function buildCrx(zip, { privateKey, publicKey }) {
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const crxId = Buffer.from(extensionIdFromPublicKeyBytes(publicDer));
  const signedHeader = field(1, crxId);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(signedHeader.length);
  const signature = createSign('sha256')
    .update(Buffer.concat([Buffer.from('CRX3 SignedData\0', 'latin1'), size, signedHeader, zip]))
    .sign(privateKey);
  const proof = Buffer.concat([field(1, publicDer), field(2, signature)]);
  const header = Buffer.concat([field(2, proof), field(10000, signedHeader)]);
  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'latin1');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, zip]);
}

/** 公開鍵 DER の SHA-256 の先頭 16 バイト（crx_id）。 */
function extensionIdFromPublicKeyBytes(publicDer) {
  const id = extensionIdFromPublicKey(publicDer);
  return Buffer.from(Array.from({ length: 16 }, (_, i) => ((id.charCodeAt(i * 2) - 97) << 4) | (id.charCodeAt(i * 2 + 1) - 97)));
}

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const files = [
  { name: 'manifest.json', data: Buffer.from('{"version":"1.2.3"}') },
  { name: 'src/a.js', data: Buffer.from('export {};') },
];
const zip = createZip(files);

test('署名済み CRX3 を検証でき、公開鍵から拡張 ID を求められる', () => {
  const result = verifyCrx(buildCrx(zip, keys));
  assert.match(result.extensionId, /^[a-p]{32}$/);
  assert.equal(result.extensionId, extensionIdFromPublicKey(keys.publicKey.export({ type: 'spki', format: 'der' })));
  assert.ok(result.zip.equals(zip));
});

test('同じ署名鍵なら、中身が変わっても拡張 ID は変わらず、鍵が違えば変わる', () => {
  const next = createZip([...files, { name: 'src/b.js', data: Buffer.from('export {};') }]);
  assert.equal(verifyCrx(buildCrx(next, keys)).extensionId, verifyCrx(buildCrx(zip, keys)).extensionId);
  assert.notEqual(verifyCrx(buildCrx(zip, otherKeys)).extensionId, verifyCrx(buildCrx(zip, keys)).extensionId);
});

test('期待する拡張 ID と異なる場合は失敗する', () => {
  const crx = buildCrx(zip, keys);
  const id = verifyCrx(crx).extensionId;
  assert.doesNotThrow(() => verifyCrx(crx, { expectId: id }));
  assert.throws(() => verifyCrx(crx, { expectId: 'a'.repeat(32) }), /拡張 ID が期待値と異なります/);
});

test('内容が書き換えられた CRX は署名の検証で失敗する', () => {
  const crx = Buffer.from(buildCrx(zip, keys));
  crx[crx.length - 30] ^= 0xff;
  assert.throws(() => verifyCrx(crx), /署名を検証できませんでした/);
});

test('CRX3 でないファイルは拒否する', () => {
  assert.throws(() => parseCrx(Buffer.from('PK\u0003\u0004 not a crx at all')), /CRX 形式ではありません/);
  const v2 = Buffer.alloc(16);
  v2.write('Cr24', 0, 'latin1');
  v2.writeUInt32LE(2, 4);
  assert.throws(() => parseCrx(v2), /CRX3 ではありません/);
});

test('中身が Web ストア用 ZIP と異なる、または秘密鍵が含まれる場合は失敗する', () => {
  assert.doesNotThrow(() => assertSameContents(zip, zip));
  assert.throws(
    () => assertSameContents(createZip([...files, { name: 'docs/extra.md', data: Buffer.from('x') }]), zip),
    /Web ストア用 ZIP にないファイル/,
  );
  assert.throws(() => assertSameContents(createZip(files.slice(0, 1)), zip), /入っていません/);
  assert.throws(
    () => assertSameContents(createZip([files[0], { name: 'src/a.js', data: Buffer.from('changed') }]), zip),
    /内容が異なります/,
  );

  const pem = Buffer.from('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n');
  const withKey = [...files, { name: 'key.txt', data: pem }];
  assert.throws(() => assertSameContents(createZip(withKey), createZip(withKey)), /秘密鍵/);
  const withPemFile = [...files, { name: 'lgpwmng.pem', data: Buffer.from('x') }];
  assert.throws(() => assertSameContents(createZip(withPemFile), createZip(withPemFile)), /鍵ファイル/);
});

// --- workflow --------------------------------------------------------------------

const workflow = read('.github/workflows/internal-crx.yml');
const storeWorkflow = read('.github/workflows/webstore-package.yml');
const stripYamlComments = (source) => source.replace(/^\s*#.*$/gm, '');
const crxBody = stripYamlComments(workflow);

test('CRX の workflow はリリースタグの push でだけ動く', () => {
  const on = crxBody.slice(crxBody.indexOf('\non:'), crxBody.indexOf('\npermissions:'));
  assert.match(on, /push:\s*\n\s*tags:\s*\['v\*'\]/);
  assert.ok(!/pull_request|workflow_dispatch|branches:|schedule|workflow_run/.test(on), 'タグ以外の trigger があります');
});

test('署名鍵（Secrets）を参照するのは「CRX を生成」ステップだけで、Release 用ジョブへは渡さない', () => {
  const uses = crxBody.match(/\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/g) || [];
  assert.deepEqual(uses, ['${{ secrets.LGPWMNG_CRX_KEY }}']);

  const build = crxBody.slice(crxBody.indexOf('  build:'), crxBody.indexOf('  release:'));
  const release = crxBody.slice(crxBody.indexOf('  release:'));
  assert.ok(build.includes('secrets.LGPWMNG_CRX_KEY'));
  assert.ok(!release.includes('secrets.'), 'release ジョブへ鍵を渡してはいけません');
  // 鍵を渡す env は 1 ステップに閉じている（「CRX を生成」ステップの中にだけある）。
  const step = build.slice(build.indexOf('- name: CRX を生成'), build.indexOf('- name: CRX の署名と内容を確認'));
  assert.ok(step.includes('secrets.LGPWMNG_CRX_KEY'));
});

test('書き込み権限は Release 用ジョブだけで、ビルドと署名のジョブは読み取りのみ', () => {
  assert.match(crxBody, /^permissions:\s*\n\s*contents: read/m);
  const release = crxBody.slice(crxBody.indexOf('  release:'));
  assert.match(release, /permissions:\s*\n\s*contents: write/);
  const build = crxBody.slice(crxBody.indexOf('  build:'), crxBody.indexOf('  release:'));
  assert.ok(!/contents: write/.test(build));
});

test('CRX は常に固定の鍵で生成し、鍵を黙って作らず、成果物へ鍵を含めない', () => {
  const packs = crxBody.match(/--pack-extension=[^\n]*\\?\n[^\n]*/g) || [];
  assert.equal(packs.length, 1, 'CRX の生成コマンドは 1 か所だけです');
  assert.ok(packs.every((command) => command.includes('--pack-extension-key=')), '鍵を指定しない生成があります');
  assert.ok(!/openssl|genrsa|ssh-keygen/.test(crxBody), 'workflow 内で鍵を生成してはいけません');
  assert.match(crxBody, /LGPWMNG_CRX_KEY が未設定です/);
  // ログ・artifact へ鍵を出さない。
  assert.ok(!/echo[^\n]*\$\{?CRX_KEY|cat[^\n]*key\.pem|set -x|ACTIONS_STEP_DEBUG/.test(crxBody));
  const artifactPaths = crxBody.slice(crxBody.indexOf('upload-artifact'), crxBody.indexOf('if-no-files-found'));
  assert.ok(!/pem|key/i.test(artifactPaths.replace('lgpwmng-release-files', '')), 'artifact に鍵が入る可能性があります');
});

test('ZIP の生成・検証・バージョン照合を前提にしている', () => {
  for (const needle of ['npm test', 'npm run package', 'node tools/crx.mjs', '${GITHUB_REF_NAME#v}', 'merge-base --is-ancestor']) {
    assert.ok(crxBody.includes(needle), `${needle} がありません`);
  }
});

test('既存の Web ストア用 workflow は鍵を使わず、Pull Request では署名しない', () => {
  assert.ok(!/secrets\./.test(storeWorkflow));
  assert.ok(!/pack-extension/.test(storeWorkflow));
  assert.match(storeWorkflow, /pull_request:/);
  assert.match(storeWorkflow, /npm run package/);
});

test('配布手順書があり、実機での導入可否が未検証であることを明記している', () => {
  const doc = read('docs/internal-crx-distribution.md');
  assert.ok(doc.includes('未検証'));
  for (const needle of ['application/x-chrome-extension', 'ExtensionInstallSources', 'install_sources', 'chrome://policy', 'LGPWMNG_CRX_KEY', '拡張 ID']) {
    assert.ok(doc.includes(needle), `手順書に ${needle} の記載がありません`);
  }
  // 自動インストール設定（normal_installed / force_installed）は使わない旨を示している。
  assert.match(doc, /normal_installed[\s\S]{0,60}force_installed[\s\S]{0,80}使わない/);
});
