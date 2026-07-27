/* On-device checks. These run against your actual phone's WebCrypto, which is
 * the only place the timing number means anything.
 *
 * Deliberately limited to pure functions: crypto and .ics generation. It does
 * NOT touch storage, so running this can never disturb your real vault. The
 * full suite, including the storage and validation layers, runs under Node via
 * test-node.mjs.
 */
import * as c from './crypto.js';
import { eventToICS } from './ics.js';

const out = document.getElementById('results');
let pass = 0;
const failed = [];

function line(text, state) {
  const p = document.createElement('p');
  p.className = `check ${state || ''}`.trim();
  p.textContent = text;
  out.appendChild(p);
}

function ok(name, cond) {
  if (cond) { pass += 1; line(`✓ ${name}`, 'good'); } else { failed.push(name); line(`✗ ${name}`, 'bad'); }
}

async function throws(name, fn) {
  try { await fn(); failed.push(name); line(`✗ ${name} (no error raised)`, 'bad'); } catch { pass += 1; line(`✓ ${name}`, 'good'); }
}

async function run() {
  line('Crypto', 'head');
  const salt = c.randomBytes(16);
  const t0 = performance.now();
  const key = await c.deriveKey('correct horse battery staple', salt);
  const ms = Math.round(performance.now() - t0);
  line(`600,000-round key derivation took ${ms}ms on this device`, ms > 4000 ? 'bad' : 'good');
  if (ms > 4000) line('That is slow enough to be annoying at unlock. It is still correct.', 'note');

  ok('random salt is 16 bytes', salt.length === 16);
  ok('base64 round-trips', c.toB64(c.fromB64(c.toB64(salt))) === c.toB64(salt));

  const blob = await c.encryptJSON(key, { secret: 'peanuts', amount: 60 });
  ok('ciphertext does not contain the plaintext', !JSON.stringify(blob).includes('peanuts'));
  const back = await c.decryptJSON(key, blob);
  ok('decrypts to the same value', back.secret === 'peanuts' && back.amount === 60);

  const again = await c.encryptJSON(key, { secret: 'peanuts', amount: 60 });
  ok('same value encrypts differently each time (fresh IV)', again.ct !== blob.ct);

  const wrongKey = await c.deriveKey('wrong passphrase', salt);
  await throws('wrong key cannot decrypt', () => c.decryptJSON(wrongKey, blob));

  const tampered = { iv: blob.iv, ct: `${blob.ct.slice(0, -4)}AAAA` };
  await throws('tampered ciphertext is rejected (GCM auth tag)', () => c.decryptJSON(key, tampered));

  ok('verifier accepts the right key', await c.checkVerifier(key, await c.makeVerifier(key)));
  ok('verifier rejects the wrong key', !(await c.checkVerifier(wrongKey, await c.makeVerifier(key))));
  ok('derived key is not extractable', key.extractable === false);

  line('Calendar files', 'head');
  const timed = eventToICS({ id: 1, title: 'Gym, and\nstuff', start_at: '2026-07-28T06:00' }, { alarmMinutes: 30 });
  ok('commas and newlines escaped', timed.includes('SUMMARY:Gym\\, and\\nstuff'));
  ok('one-hour default end', timed.includes('DTSTART:20260728T060000') && timed.includes('DTEND:20260728T070000'));
  ok('alarm included', timed.includes('TRIGGER:-PT30M'));
  const allDay = eventToICS({ id: 2, title: 'Holiday', start_at: '2026-07-29', all_day: true });
  ok('all-day uses VALUE=DATE with an exclusive end', allDay.includes('DTSTART;VALUE=DATE:20260729') && allDay.includes('DTEND;VALUE=DATE:20260730'));
  ok('DTSTAMP is UTC', /DTSTAMP:\d{8}T\d{6}Z/.test(timed));
  const long = eventToICS({ id: 3, title: 'x'.repeat(120), start_at: '2026-07-28T06:00' });
  ok('long lines folded under 76 octets', long.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 76));

  line('Environment', 'head');
  ok('running over HTTPS or localhost (required for storage and service workers)', window.isSecureContext);
  ok('IndexedDB available', 'indexedDB' in window);
  ok('service workers available', 'serviceWorker' in navigator);
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
  line(persisted ? 'Storage is marked persistent by this browser.' : 'Storage is NOT marked persistent — take backups.', persisted ? 'good' : 'note');

  line(`${pass} passed, ${failed.length} failed`, failed.length ? 'bad head' : 'good head');
  if (failed.length) line(`Failed: ${failed.join(', ')}`, 'bad');
}

run().catch((e) => line(`Suite crashed: ${e.message}`, 'bad'));
