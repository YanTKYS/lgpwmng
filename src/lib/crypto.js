/**
 * Vault の暗号化・復号。
 * 独自暗号は実装せず、Web Crypto API のみを利用する。
 *   鍵導出: PBKDF2 (SHA-256)
 *   暗号化: AES-GCM 256bit
 */

import { decodeUtf8, encodeUtf8, fromBase64, randomBytes, toBase64 } from './bytes.js';

export const KDF = {
  name: 'PBKDF2',
  hash: 'SHA-256',
  iterations: 310000,
  saltLength: 16,
};

const CIPHER_NAME = 'AES-GCM';
const IV_LENGTH = 12;

/**
 * マスターパスワードから AES-GCM 鍵を導出する。
 * 導出鍵は chrome.storage.session へ退避するため extractable にしている。
 *
 * @param {string} password
 * @param {{salt: string, iterations: number, hash?: string}} kdfParams
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(password, kdfParams) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encodeUtf8(password),
    KDF.name,
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: KDF.name,
      salt: fromBase64(kdfParams.salt),
      iterations: kdfParams.iterations,
      hash: kdfParams.hash || KDF.hash,
    },
    baseKey,
    { name: CIPHER_NAME, length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

/** 新しい KDF パラメータを生成する。 */
export function createKdfParams() {
  return {
    name: KDF.name,
    hash: KDF.hash,
    iterations: KDF.iterations,
    salt: toBase64(randomBytes(KDF.saltLength)),
  };
}

/**
 * 任意のオブジェクトを AES-GCM で暗号化する。
 * @param {CryptoKey} key
 * @param {unknown} payload
 * @returns {Promise<{iv: string, data: string}>}
 */
export async function encryptJson(key, payload) {
  const iv = randomBytes(IV_LENGTH);
  const encrypted = await crypto.subtle.encrypt(
    { name: CIPHER_NAME, iv },
    key,
    encodeUtf8(JSON.stringify(payload)),
  );
  return { iv: toBase64(iv), data: toBase64(encrypted) };
}

/**
 * AES-GCM で暗号化されたオブジェクトを復号する。
 * 認証タグ検証に失敗した場合（パスワード誤り・改竄）は例外となる。
 *
 * @param {CryptoKey} key
 * @param {{iv: string, data: string}} envelope
 * @returns {Promise<unknown>}
 */
export async function decryptJson(key, envelope) {
  const decrypted = await crypto.subtle.decrypt(
    { name: CIPHER_NAME, iv: fromBase64(envelope.iv) },
    key,
    fromBase64(envelope.data),
  );
  return JSON.parse(decodeUtf8(decrypted));
}

/** 導出鍵を Base64 raw 形式で書き出す（session storage 退避用）。 */
export async function exportKey(key) {
  return toBase64(await crypto.subtle.exportKey('raw', key));
}

/** Base64 raw 形式の鍵を CryptoKey へ復元する。 */
export async function importKey(base64Key) {
  return crypto.subtle.importKey(
    'raw',
    fromBase64(base64Key),
    { name: CIPHER_NAME, length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}
