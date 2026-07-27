/* Crypto layer. Nothing else in the app touches WebCrypto directly.
 *
 * Design decisions, and why:
 * - PBKDF2-HMAC-SHA256 at 600,000 iterations: the current OWASP figure for this
 *   primitive. About a second once at unlock, and expensive for anyone guessing
 *   offline against a stolen export.
 * - The derived key is created with extractable:false, so even code running in
 *   this page cannot read the raw key bytes back out of it.
 * - AES-256-GCM with a fresh random 96-bit IV for every encryption. GCM is
 *   authenticated, so a wrong passphrase or a tampered record fails to decrypt
 *   rather than returning plausible garbage. That is also how unlock is
 *   verified, which means there is no password hash anywhere to leak.
 * - Records are encrypted individually, not as one blob, so one corrupt record
 *   cannot take the whole store down with it.
 */
export const KDF = { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, saltBytes: 16 };
const IV_BYTES = 12;
const VERIFIER_PLAINTEXT = 'atlas.verifier.v1';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function toB64(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

export async function deriveKey(passphrase, salt, iterations = KDF.iterations) {
  if (!passphrase) throw new Error('A passphrase is required.');
  const material = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: KDF.hash },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJSON(key, value) {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)),
  );
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

export async function decryptJSON(key, blob) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct),
  );
  return JSON.parse(dec.decode(plain));
}

export async function makeVerifier(key) {
  return encryptJSON(key, VERIFIER_PLAINTEXT);
}

export async function checkVerifier(key, blob) {
  try {
    return (await decryptJSON(key, blob)) === VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}

/* Guidance shown at setup. Not a security control — it exists so you don't
 * protect a decade of financial history with "password1". */
export function passphraseStrength(p) {
  const s = p || '';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(s)).length;
  if (s.length >= 24) return { level: 'strong', note: 'Long. Good.' };
  if (s.length >= 16 && classes >= 2) return { level: 'ok', note: 'Acceptable. Length beats symbols.' };
  if (s.length >= 12) return { level: 'weak', note: 'Short. Four random words is stronger than this.' };
  return { level: 'short', note: 'Use at least 12 characters. Four random words is ideal.' };
}
