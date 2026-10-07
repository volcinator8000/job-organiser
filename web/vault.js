// Vault format shared with jobctl (C) and python/store.py:
//   "JOBVAULT" | version u8 | iterations u32be | salt[16] | iv[12] | AES-256-GCM(sqlite) + tag
// The 41-byte header is authenticated as additional data.

const MAGIC = new TextEncoder().encode('JOBVAULT');
const VERSION = 1;
const HDR_LEN = 41;
export const ITERATIONS = 600000;

export class WrongPassword extends Error {}

export function randomSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

// The derived key is non-extractable: page scripts can use it but never read it.
export async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(plain, key, salt, iterations) {
  const header = new Uint8Array(HDR_LEN);
  header.set(MAGIC, 0);
  header[8] = VERSION;
  new DataView(header.buffer).setUint32(9, iterations);
  header.set(salt, 13);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  header.set(iv, 29);
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: header }, key, plain));
  const out = new Uint8Array(HDR_LEN + ct.length);
  out.set(header, 0);
  out.set(ct, HDR_LEN);
  return out;
}

export function parseHeader(blob) {
  if (blob.length < HDR_LEN + 16 || !MAGIC.every((b, i) => blob[i] === b) || blob[8] !== VERSION)
    throw new Error('This file is not a job vault.');
  return {
    iterations: new DataView(blob.buffer, blob.byteOffset).getUint32(9),
    salt: blob.slice(13, 29),
    iv: blob.slice(29, 41),
  };
}

export async function open(blob, password) {
  const { iterations, salt, iv } = parseHeader(blob);
  const key = await deriveKey(password, salt, iterations);
  try {
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: blob.slice(0, HDR_LEN) }, key, blob.slice(HDR_LEN)));
    return { plain, key, salt, iterations };
  } catch {
    throw new WrongPassword('Wrong password (or the vault file is damaged).');
  }
}

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64) {
  const s = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
