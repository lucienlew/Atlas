/* Encrypted storage over IndexedDB.
 *
 * Shape:
 *   meta    (plaintext)  salt, kdf params, verifier, schema version
 *   records (ciphertext)  id -> { iv, ct }
 *
 * Everything is decrypted into memory at unlock and queried from there. That is
 * a deliberate choice: the alternative is plaintext indexes for searching,
 * which would leak names and amounts to anyone who can read the database file.
 * A personal ledger is at most a few thousand records, so memory is free and
 * the leak is avoidable.
 */
import { KDF, deriveKey, encryptJSON, decryptJSON, makeVerifier, checkVerifier, randomBytes, toB64, fromB64 } from './crypto.js';

const DB_NAME = 'atlas';
const DB_VERSION = 1;
const META = 'meta';
const RECORDS = 'records';
const SCHEMA_VERSION = 1;

let db = null;
let key = null;
let cache = new Map();     // id -> decrypted object

function idb() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META);
      if (!d.objectStoreNames.contains(RECORDS)) d.createObjectStore(RECORDS);
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(new Error('Could not open local storage. If you are in Private Browsing, Atlas cannot save anything.'));
  });
}

function tx(store, mode) {
  return idb().then((d) => d.transaction(store, mode).objectStore(store));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function metaGet(k) { return wrap((await tx(META, 'readonly')).get(k)); }
async function metaPut(k, v) { return wrap((await tx(META, 'readwrite')).put(v, k)); }

export function isUnlocked() { return key !== null; }
export function schemaVersion() { return SCHEMA_VERSION; }

export async function isInitialised() {
  return Boolean(await metaGet('salt'));
}

/* First run: choose a passphrase. */
export async function initialise(passphrase) {
  if (await isInitialised()) throw new Error('This device already has a vault. Unlock it instead.');
  const salt = randomBytes(KDF.saltBytes);
  const k = await deriveKey(passphrase, salt);
  await metaPut('salt', toB64(salt));
  await metaPut('kdf', { iterations: KDF.iterations, hash: KDF.hash });
  await metaPut('verifier', await makeVerifier(k));
  await metaPut('schema', SCHEMA_VERSION);
  key = k;
  cache = new Map();
  return true;
}

export async function unlock(passphrase) {
  const saltB64 = await metaGet('salt');
  if (!saltB64) throw new Error('No vault on this device yet.');
  const kdf = (await metaGet('kdf')) || { iterations: KDF.iterations };
  const k = await deriveKey(passphrase, fromB64(saltB64), kdf.iterations);
  const verifier = await metaGet('verifier');
  if (!(await checkVerifier(k, verifier))) {
    throw new Error('That passphrase is wrong. Nothing was unlocked.');
  }
  key = k;
  await loadAll();
  return true;
}

/* Drop the key and every decrypted value. Called on auto-lock and on demand. */
export function lock() {
  key = null;
  cache.forEach((v, k2) => { cache.set(k2, null); });
  cache = new Map();
}

async function loadAll() {
  const store = await tx(RECORDS, 'readonly');
  const ids = await wrap(store.getAllKeys());
  const blobs = await wrap((await tx(RECORDS, 'readonly')).getAll());
  cache = new Map();
  const damaged = [];
  for (let i = 0; i < ids.length; i += 1) {
    try {
      cache.set(ids[i], await decryptJSON(key, blobs[i]));
    } catch {
      damaged.push(ids[i]);
    }
  }
  if (damaged.length) {
    console.warn('[store] unreadable records skipped:', damaged);
  }
  return { loaded: cache.size, damaged };
}

function requireKey() {
  if (!key) throw new Error('Atlas is locked.');
}

export function all(prefix) {
  requireKey();
  const out = [];
  cache.forEach((value, id) => {
    if (!prefix || id.startsWith(`${prefix}:`)) out.push(value);
  });
  return out;
}

export function get(id) {
  requireKey();
  return cache.get(id) || null;
}

export async function put(id, value) {
  requireKey();
  const blob = await encryptJSON(key, value);
  await wrap((await tx(RECORDS, 'readwrite')).put(blob, id));
  cache.set(id, value);
  return value;
}

export async function del(id) {
  requireKey();
  await wrap((await tx(RECORDS, 'readwrite')).delete(id));
  cache.delete(id);
}

export function nextId(prefix) {
  requireKey();
  let max = 0;
  cache.forEach((v, id) => {
    if (id.startsWith(`${prefix}:`)) {
      const n = Number(id.slice(prefix.length + 1));
      if (Number.isFinite(n) && n > max) max = n;
    }
  });
  return max + 1;
}

export function counts() {
  requireKey();
  const out = {};
  cache.forEach((v, id) => {
    const kind = id.split(':')[0];
    out[kind] = (out[kind] || 0) + 1;
  });
  return out;
}

/* ---------------- backup ----------------
 * The export is the raw ciphertext plus the salt, so it is only readable with
 * the same passphrase. It is also the ONLY protection against Safari evicting
 * local storage, which it is allowed to do. Take one regularly.
 */
export async function exportBundle() {
  const store = await tx(RECORDS, 'readonly');
  const ids = await wrap(store.getAllKeys());
  const blobs = await wrap((await tx(RECORDS, 'readonly')).getAll());
  return {
    format: 'atlas-encrypted-backup',
    version: SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    kdf: (await metaGet('kdf')) || { iterations: KDF.iterations, hash: KDF.hash },
    salt: await metaGet('salt'),
    verifier: await metaGet('verifier'),
    records: ids.map((id, i) => ({ id, ...blobs[i] })),
  };
}

/* Restoring replaces everything. We verify the passphrase against the bundle's
 * own verifier BEFORE touching local data, so a wrong passphrase cannot destroy
 * a working vault. */
export async function importBundle(bundle, passphrase) {
  if (!bundle || bundle.format !== 'atlas-encrypted-backup') {
    throw new Error('That file is not an Atlas backup.');
  }
  const kdf = bundle.kdf || { iterations: KDF.iterations };
  const k = await deriveKey(passphrase, fromB64(bundle.salt), kdf.iterations);
  if (!(await checkVerifier(k, bundle.verifier))) {
    throw new Error('That passphrase does not match this backup. Nothing was changed.');
  }
  const store = await tx(RECORDS, 'readwrite');
  await wrap(store.clear());
  const writer = await tx(RECORDS, 'readwrite');
  await Promise.all(bundle.records.map((r) => wrap(writer.put({ iv: r.iv, ct: r.ct }, r.id))));
  await metaPut('salt', bundle.salt);
  await metaPut('kdf', kdf);
  await metaPut('verifier', bundle.verifier);
  await metaPut('schema', bundle.version || SCHEMA_VERSION);
  key = k;
  const res = await loadAll();
  return { restored: res.loaded, damaged: res.damaged.length };
}

/* Irreversible. Used by "erase this device". */
export async function destroy() {
  const store = await tx(RECORDS, 'readwrite');
  await wrap(store.clear());
  const m = await tx(META, 'readwrite');
  await wrap(m.clear());
  lock();
}
