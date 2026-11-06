/**
 * 庁内テスト配布用 CRX（CRX3）の検証。
 *
 *   node tools/crx.mjs verify <file.crx> --zip <webstore.zip> [--expect-id <拡張ID>]
 *
 * CRX の生成そのものは Chrome 公式の `--pack-extension` / `--pack-extension-key` に任せる
 * （.github/workflows/internal-crx.yml）。ここでは「生成された CRX が期待どおりか」だけを
 * Node 標準モジュールで確認する。外部依存は持たない。
 *
 * 確認すること:
 *   - CRX3 の形式であり、署名（RSA-SHA256）が公開鍵で検証できる
 *   - 拡張 ID（公開鍵から計算）が、ヘッダーの crx_id と一致する。--expect-id があればそれとも一致する
 *   - 中身が、Web ストア用 ZIP と同じファイル・同じ内容である（開発用ファイルの混入がない）
 *   - 秘密鍵（PEM）がファイル名にも内容にも含まれていない
 *
 * 拡張 ID は公開情報。秘密鍵は読み込まず、出力にも一切出さない。
 */
import { createHash, createPublicKey, createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from './zip.mjs';

const CRX_MAGIC = 'Cr24';
const SIGNED_DATA_PREFIX = Buffer.from('CRX3 SignedData\0', 'latin1');

// --- 最小限の protobuf 読み取り（CrxFileHeader に必要な範囲） --------------------

function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('CRX ヘッダーが途中で終わっています。');
    const byte = buf[pos];
    pos += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('CRX ヘッダーの数値が大きすぎます。');
  }
  return { value, next: pos };
}

/** length-delimited フィールド（wire type 2）だけを { field, data } の配列で返す。 */
function readFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.next;
    const field = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    if (wireType === 2) {
      const length = readVarint(buf, pos);
      pos = length.next;
      if (pos + length.value > buf.length) throw new Error('CRX ヘッダーの長さが不正です。');
      fields.push({ field, data: buf.subarray(pos, pos + length.value) });
      pos += length.value;
    } else if (wireType === 0) {
      pos = readVarint(buf, pos).next;
    } else {
      throw new Error(`CRX ヘッダーに未対応の型があります（wire type ${wireType}）。`);
    }
  }
  return fields;
}

/** 公開鍵（DER, SubjectPublicKeyInfo）から拡張 ID（a〜p の 32 文字）を求める。 */
export function extensionIdFromPublicKey(publicKeyDer) {
  const digest = createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);
  return Array.from(digest, (byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f))).join('');
}

/**
 * CRX3 を読み取る（署名の検証は verifyCrx）。
 * @param {Buffer} crx
 */
export function parseCrx(crx) {
  if (crx.length < 12 || crx.subarray(0, 4).toString('latin1') !== CRX_MAGIC) {
    throw new Error('CRX 形式ではありません（先頭が Cr24 ではありません）。');
  }
  const version = crx.readUInt32LE(4);
  if (version !== 3) throw new Error(`CRX3 ではありません（version ${version}）。`);
  const headerSize = crx.readUInt32LE(8);
  const headerEnd = 12 + headerSize;
  if (headerEnd > crx.length) throw new Error('CRX ヘッダーの長さが不正です。');

  const fields = readFields(crx.subarray(12, headerEnd));
  const proofs = fields
    .filter((entry) => entry.field === 2) // sha256_with_rsa
    .map((entry) => {
      const parts = readFields(entry.data);
      const publicKey = parts.find((part) => part.field === 1);
      const signature = parts.find((part) => part.field === 2);
      if (!publicKey || !signature) throw new Error('CRX の署名情報が不完全です。');
      return { publicKey: publicKey.data, signature: signature.data };
    });
  const signedHeader = fields.find((entry) => entry.field === 10000);
  if (!signedHeader) throw new Error('CRX に signed_header_data がありません。');
  const crxId = readFields(signedHeader.data).find((part) => part.field === 1);
  if (!crxId) throw new Error('CRX に crx_id がありません。');

  return {
    proofs,
    signedHeaderData: signedHeader.data,
    crxId: crxId.data,
    zip: crx.subarray(headerEnd),
  };
}

/**
 * 署名と拡張 ID を検証し、拡張 ID と ZIP を返す。問題があれば例外。
 * @param {Buffer} crx
 * @param {{expectId?: string}} [options]
 * @returns {{extensionId: string, zip: Buffer}}
 */
export function verifyCrx(crx, { expectId } = {}) {
  const parsed = parseCrx(crx);
  if (parsed.proofs.length === 0) throw new Error('CRX に署名がありません。');

  const sizeBytes = Buffer.alloc(4);
  sizeBytes.writeUInt32LE(parsed.signedHeaderData.length);
  const signedPayload = Buffer.concat([SIGNED_DATA_PREFIX, sizeBytes, parsed.signedHeaderData, parsed.zip]);

  for (const proof of parsed.proofs) {
    const key = createPublicKey({ key: proof.publicKey, format: 'der', type: 'spki' });
    const ok = createVerify('sha256').update(signedPayload).verify(key, proof.signature);
    if (!ok) throw new Error('CRX の署名を検証できませんでした（内容が改ざんされたか、壊れています）。');
  }

  const extensionId = extensionIdFromPublicKey(parsed.proofs[0].publicKey);
  const headerId = Array.from(parsed.crxId, (byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f))).join('');
  if (headerId !== extensionId) {
    throw new Error(`CRX のヘッダーの ID（${headerId}）と公開鍵から求めた ID（${extensionId}）が一致しません。`);
  }
  if (expectId && expectId !== extensionId) {
    throw new Error(`拡張 ID が期待値と異なります（期待: ${expectId} / 実際: ${extensionId}）。署名鍵が変わった可能性があります。`);
  }
  return { extensionId, zip: parsed.zip };
}

const PRIVATE_KEY_MARKER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * CRX の中身が Web ストア用 ZIP と一致し、秘密鍵が含まれないことを確認する。
 * @param {Buffer} crxZip   CRX に入っている ZIP
 * @param {Buffer} storeZip Web ストア用 ZIP（npm run package の出力）
 */
export function assertSameContents(crxZip, storeZip) {
  // Chrome が作る ZIP にはディレクトリのエントリ（`src/` など）が入るため、ファイルだけを比べる。
  const filesOf = (zip) => new Map(readZip(zip).filter((entry) => !entry.name.endsWith('/')).map((entry) => [entry.name, entry.data]));
  const crxEntries = filesOf(crxZip);
  const storeEntries = filesOf(storeZip);

  for (const name of crxEntries.keys()) {
    if (!storeEntries.has(name)) throw new Error(`CRX に Web ストア用 ZIP にないファイルがあります: ${name}`);
  }
  for (const [name, data] of storeEntries) {
    if (!crxEntries.has(name)) throw new Error(`CRX に Web ストア用 ZIP のファイルが入っていません: ${name}`);
    if (!crxEntries.get(name).equals(data)) throw new Error(`CRX と Web ストア用 ZIP で内容が異なります: ${name}`);
  }
  for (const [name, data] of crxEntries) {
    if (/\.(pem|key)$/i.test(name)) throw new Error(`CRX に鍵ファイルらしきものが入っています: ${name}`);
    if (PRIVATE_KEY_MARKER.test(data.toString('latin1'))) throw new Error(`CRX に秘密鍵が含まれています: ${name}`);
  }
}

function main(argv) {
  const [command, crxPath, ...rest] = argv;
  const option = (name) => {
    const index = rest.indexOf(name);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  if (command !== 'verify' || !crxPath || !option('--zip')) {
    process.stderr.write('使い方: node tools/crx.mjs verify <file.crx> --zip <webstore.zip> [--expect-id <拡張ID>]\n');
    process.exit(2);
  }
  try {
    const crx = readFileSync(crxPath);
    if (PRIVATE_KEY_MARKER.test(crx.toString('latin1'))) throw new Error('CRX ファイルに秘密鍵が含まれています。');
    const { extensionId, zip } = verifyCrx(crx, { expectId: option('--expect-id') || undefined });
    assertSameContents(zip, readFileSync(option('--zip')));
    process.stdout.write(`CRX を確認しました: 署名 OK / 中身は Web ストア用 ZIP と一致 / 拡張 ID: ${extensionId}\n`);
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
