/* Wiring: lock state, the composer, settings, backup, scanning.
 *
 * The security-relevant behaviour lives here:
 * - the derived key exists only inside store.js and only while unlocked
 * - leaving the app for longer than the auto-lock window drops it
 * - the API key is stored as an ordinary encrypted record, so it is protected
 *   by the same passphrase as everything else
 */
import * as store from './store.js';
import * as m from './model.js';
import * as routes from './routes.js';
import * as ai from './ai.js';
import { eventToICS } from './ics.js';
import * as ui from './ui.js';
import * as people from './people.js';
import * as history from './history.js';
import { passphraseStrength } from './crypto.js';

const DEFAULT_MODEL = 'claude-sonnet-5';
const conversation = new ai.Conversation();
let setupMode = false;
let lockTimer = null;

/* ---------------- lock lifecycle ---------------- */
function autoLockMinutes() {
  const raw = Number(m.setting('autolock_minutes', 5));
  return Number.isFinite(raw) && raw >= 0 ? raw : 5;
}

function lockNow(message) {
  clearTimeout(lockTimer);
  store.lock();
  conversation.reset();
  ui.clearLog();
  ui.showApp(false);
  ui.el.pass.value = '';
  ui.el.pass2.value = '';
  ['sheet', 'peopleSheet', 'personSheet', 'splitSheet', 'historySheet', 'agendaSheet'].forEach((id) => {
    const n = document.getElementById(id);
    if (n) n.classList.add('hidden');
  });
  ui.note(ui.el.gateNote, message || '', message ? 'note-warn' : '');
  ui.el.gateGo.textContent = 'Unlock';
}

document.addEventListener('visibilitychange', () => {
  if (!store.isUnlocked()) return;
  if (document.visibilityState === 'hidden') {
    const minutes = autoLockMinutes();
    if (minutes === 0) { lockNow('Locked when you left the app.'); return; }
    lockTimer = setTimeout(() => lockNow('Locked after time away.'), minutes * 60 * 1000);
  } else {
    clearTimeout(lockTimer);
  }
});

/* ---------------- gate ---------------- */
async function paintGate() {
  const ready = await store.isInitialised();
  setupMode = !ready;
  ui.el.pass2.classList.toggle('hidden', ready);
  ui.el.gateRestore.classList.toggle('hidden', ready);
  ui.el.gateGo.textContent = ready ? 'Unlock' : 'Create vault';
  ui.el.gateSub.textContent = ready
    ? 'Everything you record stays encrypted on this device.'
    : 'Choose a passphrase. It encrypts everything, it is never sent anywhere, and it cannot be recovered.';
  ui.el.pass.setAttribute('autocomplete', ready ? 'current-password' : 'new-password');
}

async function openVault() {
  const pass = ui.el.pass.value;
  if (!pass) { ui.note(ui.el.gateNote, 'Enter your passphrase.', 'note-warn'); return; }
  ui.el.gateGo.disabled = true;
  ui.note(ui.el.gateNote, 'Deriving key…');
  try {
    if (setupMode) {
      const strength = passphraseStrength(pass);
      if (strength.level === 'short') { ui.note(ui.el.gateNote, strength.note, 'note-warn'); return; }
      if (pass !== ui.el.pass2.value) { ui.note(ui.el.gateNote, 'The two passphrases do not match.', 'note-bad'); return; }
      await store.initialise(pass);
      await m.setSetting('currency', 'SGD');
      await m.setSetting('autolock_minutes', 5);
    } else {
      await store.unlock(pass);
    }
    ui.el.pass.value = '';
    ui.el.pass2.value = '';
    ui.note(ui.el.gateNote, '');
    enterApp();
  } catch (e) {
    ui.note(ui.el.gateNote, e.message, 'note-bad');
  } finally {
    ui.el.gateGo.disabled = false;
  }
}

function enterApp() {
  ui.showApp(true);
  loadSettingsIntoForm();
  openingCard();
}

/* First thing you see: the brief if there is anything to brief on, the
 * shorthand if the vault is empty. An empty screen should tell you what to do
 * next, not just sit there. */
async function openingCard() {
  const total = Object.values(store.counts()).reduce((a, b) => a + b, 0);
  if (!total) {
    ui.card({ markdown: `**Vault created.** Nothing in it yet.\n\n${routes.HELP}` });
    return;
  }
  try {
    const brief = await routes.match('today');
    if (brief) ui.card(brief, { source: 'local' });
  } catch { /* a broken brief must not block the app */ }
}

/* ---------------- composer ---------------- */
async function handle(text) {
  ui.said(text);
  ui.el.input.value = '';
  ui.el.input.style.height = 'auto';

  const before = m.nowISO();

  // 1. Local, free, instant.
  try {
    const local = await routes.match(text);
    if (local) {
      ui.card(local, { source: 'local' });
      await offerNewEvents(before);
      refreshStats();
      return;
    }
  } catch (e) {
    ui.card({ title: 'Could not do that', text: e.message }, { bad: true });
    return;
  }

  // 2. Otherwise Claude, if a key is set.
  const apiKey = m.setting('api_key', '');
  if (!apiKey) {
    ui.card({
      title: 'I did not recognise that',
      text: 'Shorthand covers recording and asking without any network. For plain sentences, add an API key in Settings.',
      footer: 'Type help to see the shorthand.',
    }, { bad: true });
    return;
  }

  ui.working(true);
  try {
    const cfg = { apiKey, model: m.setting('model', DEFAULT_MODEL) || DEFAULT_MODEL, maxTokens: 1024 };
    let result = await conversation.send(text, cfg);
    await present(result, cfg, before);
  } catch (e) {
    ui.card({ title: 'Something went wrong', text: e.message }, { bad: true });
  } finally {
    ui.working(false);
    refreshStats();
  }
}

async function present(result, cfg, before) {
  if (result.type === 'confirm') {
    ui.confirmCard(result.summary, async (approved) => {
      ui.working(true);
      try {
        const next = await conversation.resolve(approved, cfg);
        await present(next, cfg, before);
      } catch (e) {
        ui.card({ title: 'Something went wrong', text: e.message }, { bad: true });
      } finally {
        ui.working(false);
        refreshStats();
      }
    });
    return;
  }
  ui.card({ text: result.text }, { source: 'model' });
  await offerNewEvents(before);
}

/* Any event created during the turn comes back as a tap-to-add .ics. */
async function offerNewEvents(since) {
  const fresh = m.eventsCreatedAfter(since);
  fresh.forEach((ev) => {
    const blob = new Blob([eventToICS(ev, { alarmMinutes: ev.all_day ? null : 30 })], { type: 'text/calendar' });
    const name = `${ev.title.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'event'}.ics`;
    ui.attachment(ev.title, name, URL.createObjectURL(blob));
  });
}

/* ---------------- scanning ---------------- */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('Could not read that file.'));
    r.readAsDataURL(file);
  });
}

async function shrink(file, maxEdge = 1600) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
  return blob || file;
}

async function scan(file) {
  const apiKey = m.setting('api_key', '');
  if (!apiKey) {
    ui.card({
      title: 'Scanning needs a Claude API key',
      text: 'Reading a receipt is the one thing Atlas cannot do on-device. Add a key in Settings, or record it by hand: spent 12.50 coffee',
    }, { bad: true });
    return;
  }
  ui.said(`📎 ${file.name || 'photo'}`);
  ui.working(true, 'reading the image…');
  try {
    const small = await shrink(file);
    const b64 = await fileToBase64(small);
    const model = m.setting('model', DEFAULT_MODEL) || DEFAULT_MODEL;
    const text = await ai.readImage(apiKey, model, b64, 'image/jpeg');
    if (!text) { ui.card({ title: 'No text found in that image.' }, { bad: true }); return; }
    const docId = await m.createDocument(text, file.name || 'photo.jpg');
    const preview = text.slice(0, 1200);
    const more = text.length - preview.length;
    const prompt = `[Scanned document #${docId}] OCR preview${more > 0 ? ` (first ${preview.length} of ${text.length} characters; call read_document_text for the remaining ${more})` : ''}:\n${preview}\n\nClassify this document, take the right action, then link it to document ${docId}.`;
    ui.working(true, 'filing it…');
    const before = m.nowISO();
    const cfg = { apiKey, model, maxTokens: 900 };
    const result = await conversation.send(prompt, cfg);
    await present(result, cfg, before);
  } catch (e) {
    ui.card({ title: 'Could not read that', text: e.message }, { bad: true });
  } finally {
    ui.working(false);
    refreshStats();
  }
}

/* ---------------- settings ---------------- */
function loadSettingsIntoForm() {
  ui.el.apiKey.value = m.setting('api_key', '') || '';
  ui.el.model.value = m.setting('model', DEFAULT_MODEL) || DEFAULT_MODEL;
  ui.el.currency.value = m.currency();
  ui.el.autolock.value = String(autoLockMinutes());
  refreshStats();
}

async function refreshStats() {
  if (!store.isUnlocked()) return;
  const counts = store.counts();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  ui.el.statRecords.textContent = String(total);
  ui.el.statBackup.textContent = m.setting('last_backup', 'never');
  const u = conversation.usage;
  ui.el.statTokens.textContent = `${(u.input + u.output).toLocaleString()} in ${u.calls} call(s)`;
  const denom = u.input + u.cache_read;
  ui.el.statCache.textContent = denom ? `${Math.round((u.cache_read / denom) * 100)}%` : '—';
  try {
    const persisted = navigator.storage && navigator.storage.persisted
      ? await navigator.storage.persisted() : false;
    ui.el.statPersist.textContent = persisted ? 'protected' : 'not guaranteed — back up';
    ui.el.statPersist.className = `stat-value ${persisted ? 'stat-good' : 'stat-bad'}`;
  } catch {
    ui.el.statPersist.textContent = 'unknown';
  }
}

async function saveBackup() {
  try {
    const bundle = await store.exportBundle();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `atlas-backup-${m.todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    await m.setSetting('last_backup', m.nowISO().replace('T', ' '));
    refreshStats();
    ui.toast('Backup saved. Keep it somewhere you will find it.');
  } catch (e) {
    ui.toast(e.message, true);
  }
}

async function restoreFrom(file, passphrase) {
  const bundle = JSON.parse(await file.text());
  const res = await store.importBundle(bundle, passphrase);
  ui.toast(`Restored ${res.restored} record(s).`);
  return res;
}

/* ---------------- events ---------------- */
ui.el.gateGo.addEventListener('click', openVault);
ui.el.pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') openVault(); });
ui.el.pass2.addEventListener('keydown', (e) => { if (e.key === 'Enter') openVault(); });

ui.el.pass.addEventListener('input', () => {
  if (!setupMode) return;
  const s = passphraseStrength(ui.el.pass.value);
  ui.note(ui.el.gateNote, s.note, s.level === 'strong' ? '' : 'note-warn');
});

ui.el.gateRestore.addEventListener('click', () => ui.el.restoreFile.click());
ui.el.restoreFile.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const pass = ui.el.pass.value;
  if (!pass) { ui.note(ui.el.gateNote, 'Type the backup\u2019s passphrase first, then pick the file.', 'note-warn'); return; }
  try {
    await restoreFrom(file, pass);
    await paintGate();
    enterApp();
    await openingCard();
  } catch (err) {
    ui.note(ui.el.gateNote, err.message, 'note-bad');
  } finally {
    e.target.value = '';
  }
});

ui.el.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = ui.el.input.value.trim();
  if (text) handle(text);
});

ui.el.input.addEventListener('input', () => {
  ui.el.input.style.height = 'auto';
  ui.el.input.style.height = `${Math.min(ui.el.input.scrollHeight, 120)}px`;
});

ui.el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    ui.el.composer.requestSubmit();
  }
});

ui.el.cameraBtn.addEventListener('click', () => ui.el.scanFile.click());
ui.el.scanFile.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) scan(file);
  e.target.value = '';
});

/* Any change made in the People section refreshes the settings counters, so the
 * record count and the ledger never drift apart from what you just did. */
people.init(() => refreshStats(), (id) => history.openHistory({ contactId: id }));
history.init({ changed: () => refreshStats(), openPerson: (id) => people.openPerson(id) });
ui.el.peopleBtn.addEventListener('click', () => people.openPeople());
ui.el.historyBtn.addEventListener('click', () => history.openHistory({ contactId: null }));
ui.el.agendaBtn.addEventListener('click', () => history.openAgenda());

ui.el.lockBtn.addEventListener('click', () => lockNow('Locked.'));
ui.el.settingsBtn.addEventListener('click', () => { loadSettingsIntoForm(); ui.el.sheet.classList.remove('hidden'); });
ui.el.sheetClose.addEventListener('click', () => ui.el.sheet.classList.add('hidden'));

ui.el.saveSettings.addEventListener('click', async () => {
  try {
    await m.setSetting('api_key', ui.el.apiKey.value.trim());
    await m.setSetting('model', ui.el.model.value.trim() || DEFAULT_MODEL);
    await m.setSetting('currency', (ui.el.currency.value.trim() || 'SGD').toUpperCase());
    const minutes = Math.max(0, Math.min(120, Number(ui.el.autolock.value) || 0));
    await m.setSetting('autolock_minutes', minutes);
    ui.toast('Preferences saved.');
  } catch (e) {
    ui.toast(e.message, true);
  }
});

ui.el.exportBtn.addEventListener('click', saveBackup);
ui.el.importBtn.addEventListener('click', () => ui.el.importFile.click());
ui.el.importFile.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const pass = window.prompt('Passphrase for that backup file:');
  if (pass) {
    try {
      await restoreFrom(file, pass);
      ui.clearLog();
      loadSettingsIntoForm();
      ui.el.sheet.classList.add('hidden');
      await openingCard();
    } catch (err) {
      ui.toast(err.message, true);
    }
  }
  e.target.value = '';
});

ui.el.eraseBtn.addEventListener('click', async () => {
  if (!window.confirm('Erase every record on this device? Without a backup this cannot be undone.')) return;
  if (!window.confirm('Last check. Everything will be gone.')) return;
  await store.destroy();
  conversation.reset();
  ui.clearLog();
  ui.showApp(false);
  ui.el.sheet.classList.add('hidden');
  await paintGate();
  ui.note(ui.el.gateNote, 'Everything was erased.', 'note-warn');
});

/* ---------------- boot ---------------- */
async function boot() {
  await paintGate();
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); } catch { /* offline use is a bonus, not a requirement */ }
  }
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch { /* Safari may refuse; the backup is the real answer */ }
  }
}

boot();

/* Exposed for test.html, which runs the crypto and model suites on the device
 * you actually rely on. Nothing else reads these. */
window.__atlas = { store, model: m, routes, ai, ics: { eventToICS } };
