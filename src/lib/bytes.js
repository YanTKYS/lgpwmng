/**
 * バイト列と文字列の相互変換ユーティリティ。
 * 外部ライブラリを使わず、標準 Web API のみで実装する。
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** @param {string} text @returns {Uint8Array} */
export function encodeUtf8(text) {
  return textEncoder.encode(text);
}

/** @param {ArrayBuffer|Uint8Array} buffer @returns {string} */
export function decodeUtf8(buffer) {
  return textDecoder.decode(buffer);
}

/** @param {number} length @returns {Uint8Array} */
export function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** @param {ArrayBuffer|Uint8Array} buffer @returns {string} Base64 文字列 */
export function toBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** @param {string} base64 @returns {Uint8Array} */
export function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
