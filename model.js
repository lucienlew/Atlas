/* Data model, validation and queries.
 *
 * This is the port of the Python tools.py/db.py layer, and it keeps the rules
 * that mattered there:
 *   - amounts must be positive numbers (a negative repayment used to inflate a
 *     debt instead of clearing it)
 *   - dates must be real ISO values, never a phrase like "tomorrow 9am"
 *   - a record referring to a contact checks the contact exists first, so you
 *     get a readable message rather than a constraint error
 *   - repayments clamp to what is outstanding and report the overpayment
 *   - every write appends to an audit log
 *
 * Times are the device's local time, which on a phone you carry is simply
 * correct — no timezone configuration to get wrong.
 */
import * as store from './store.js';

export class DataError extends Error {}

/* ---------------- time ---------------- */
function pad(n) { return String(n).padStart(2, '0'); }

export function nowISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function todayISO() { return nowISO().slice(0, 10); }

export function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/;

export function parseWhen(value) {
  const s = String(value || '').trim();
  if (DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00`))) {
    return { kind: 'date', value: s };
  }
  if (DATETIME_RE.test(s)) {
    const norm = s.replace(' ', 'T').slice(0, 16);
    if (!Number.isNaN(Date.parse(`${norm}:00`))) return { kind: 'datetime', value: norm };
  }
  return { kind: null, value: null };
}

export function requireDate(value, field = 'date') {
  const p = parseWhen(value);
  if (!p.kind) throw new DataError(`${field} must be YYYY-MM-DD. Today is ${todayISO()}.`);
  return p.value.slice(0, 10);
}

export function requireDateTime(value, field = 'time') {
  const p = parseWhen(value);
  if (p.kind !== 'datetime') {
    throw new DataError(`${field} needs a date and a time, like ${todayISO()}T09:00. Today is ${todayISO()}.`);
  }
  return p.value;
}

/* ---------------- validation ---------------- */
export function amount(value, field = 'amount') {
  const v = Math.round(Number(value) * 100) / 100;
  if (!Number.isFinite(v)) throw new DataError(`${field} must be a number.`);
  if (v <= 0) throw new DataError(`${field} must be more than zero (got ${v}).`);
  if (v > 1e12) throw new DataError(`${field} is implausibly large (${v}).`);
  return v;
}

function text(value, field, max = 500) {
  const s = String(value == null ? '' : value).trim();
  if (!s) throw new DataError(`${field} cannot be empty.`);
  return s.slice(0, max);
}

/* ---------------- audit ---------------- */
async function audit(action, detail) {
  const id = store.nextId('audit');
  await store.put(`audit:${id}`, { id, action, detail: JSON.stringify(detail || {}).slice(0, 800), at: nowISO() });
}

export function auditTail(n = 30) {
  return store.all('audit').sort((a, b) => b.id - a.id).slice(0, n);
}

/* ---------------- settings ---------------- */
export function setting(k, fallback = null) {
  const row = store.get(`setting:${k}`);
  return row ? row.value : fallback;
}

export async function setSetting(k, value) {
  await store.put(`setting:${k}`, { key: k, value });
  return value;
}

export function currency() { return setting('currency', 'SGD'); }

export function money(v) {
  const n = Number(v) || 0;
  return `${currency()} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* ---------------- contacts ---------------- */
export async function addContact(fields) {
  const name = text(fields.full_name, 'full_name', 120);
  const id = store.nextId('contact');
  const record = {
    id,
    full_name: name,
    preferred_name: fields.preferred_name || null,
    nickname: fields.nickname || null,
    phones: fields.phone ? [String(fields.phone)] : [],
    emails: fields.email ? [String(fields.email)] : [],
    birthday: fields.birthday ? requireDate(fields.birthday, 'birthday') : null,
    address: fields.address || null,
    company: fields.company || null,
    job_title: fields.job_title || null,
    relationship: fields.relationship || null,
    tags: Array.isArray(fields.tags) ? fields.tags : [],
    notes: fields.notes || null,
    last_interaction: null,
    created_at: nowISO(),
  };
  await store.put(`contact:${id}`, record);
  await audit('add_contact', { id, name });
  return { contact_id: id, full_name: name };
}

export function contacts() { return store.all('contact'); }

export function findContacts(query = '') {
  const q = String(query || '').toLowerCase();
  const rows = contacts().filter((c) => !q || [c.full_name, c.preferred_name, c.nickname, c.company, c.relationship, ...(c.tags || [])]
    .filter(Boolean).some((f) => String(f).toLowerCase().includes(q)));
  return rows
    .sort((a, b) => a.full_name.localeCompare(b.full_name))
    .slice(0, 25)
    .map((c) => ({ id: c.id, full_name: c.full_name, relationship: c.relationship, company: c.company }));
}

export function requireContact(id) {
  const c = store.get(`contact:${Number(id)}`);
  if (!c) throw new DataError(`No contact with id ${id}. Search for them first, or add them.`);
  return c;
}

const SCALARS = ['full_name', 'preferred_name', 'nickname', 'birthday', 'address', 'company', 'job_title', 'relationship', 'notes'];

export async function updateContact(id, field, value) {
  const c = requireContact(id);
  if (!SCALARS.includes(field)) throw new DataError(`'${field}' cannot be edited this way.`);
  const next = { ...c, [field]: field === 'birthday' ? requireDate(value, 'birthday') : value };
  await store.put(`contact:${c.id}`, next);
  await audit('update_contact', { id: c.id, field });
  return { contact_id: c.id, [field]: next[field] };
}

export async function addContactDetail(id, kind, value, label) {
  const c = requireContact(id);
  if (kind === 'important_date') {
    const when = requireDate(value, 'date');
    const next = { ...c, important_dates: [...(c.important_dates || []), { label: label || 'date', date: when }] };
    await store.put(`contact:${c.id}`, next);
    await audit('add_contact_detail', { id: c.id, kind });
    return { contact_id: c.id, added: `${label || 'date'}: ${when}` };
  }
  const col = { phone: 'phones', email: 'emails', tag: 'tags' }[kind];
  if (!col) throw new DataError('kind must be one of: phone, email, tag, important_date.');
  const list = Array.from(new Set([...(c[col] || []), String(value)]));
  await store.put(`contact:${c.id}`, { ...c, [col]: list });
  await audit('add_contact_detail', { id: c.id, kind });
  return { contact_id: c.id, [col]: list };
}

export async function logInteraction(id, summary, channel) {
  const c = requireContact(id);
  const entry = { summary: text(summary, 'summary'), channel: channel || null, at: nowISO() };
  await store.put(`contact:${c.id}`, {
    ...c,
    interactions: [...(c.interactions || []), entry].slice(-50),
    last_interaction: entry.at,
  });
  await audit('log_interaction', { id: c.id });
  return { contact_id: c.id, logged: entry.summary };
}

export function getContact(id) {
  const c = requireContact(id);
  const mine = debts().filter((d) => d.contact_id === c.id && d.remaining > 0);
  return {
    profile: {
      id: c.id, full_name: c.full_name, preferred_name: c.preferred_name,
      nickname: c.nickname, phones: c.phones, emails: c.emails,
      birthday: c.birthday, address: c.address, company: c.company,
      job_title: c.job_title, relationship: c.relationship, tags: c.tags,
      notes: c.notes, last_interaction: c.last_interaction,
    },
    important_dates: c.important_dates || [],
    they_owe_me: mine.filter((d) => d.direction === 'owes_me').map((d) => ({ id: d.id, remaining: d.remaining, currency: d.currency, description: d.description })),
    i_owe_them: mine.filter((d) => d.direction === 'i_owe').map((d) => ({ id: d.id, remaining: d.remaining, currency: d.currency, description: d.description })),
    recent_transactions: transactions().filter((t) => t.contact_id === c.id).sort((a, b) => b.occurred_on.localeCompare(a.occurred_on)).slice(0, 5),
    recent_interactions: (c.interactions || []).slice(-5).reverse(),
  };
}

export async function mergeContacts(keepId, dupId) {
  const keep = requireContact(keepId);
  const dup = requireContact(dupId);
  if (keep.id === dup.id) throw new DataError('Cannot merge a contact into itself.');
  const union = (a, b) => Array.from(new Set([...(a || []), ...(b || [])]));
  await store.put(`contact:${keep.id}`, {
    ...keep,
    phones: union(keep.phones, dup.phones),
    emails: union(keep.emails, dup.emails),
    tags: union(keep.tags, dup.tags),
    important_dates: [...(keep.important_dates || []), ...(dup.important_dates || [])],
    interactions: [...(keep.interactions || []), ...(dup.interactions || [])].slice(-50),
    notes: [keep.notes, dup.notes].filter(Boolean).join(' | ') || null,
  });
  for (const d of debts()) {
    if (d.contact_id === dup.id) await store.put(`debt:${d.id}`, { ...d, contact_id: keep.id });
  }
  for (const t of transactions()) {
    if (t.contact_id === dup.id) await store.put(`txn:${t.id}`, { ...t, contact_id: keep.id });
  }
  await store.del(`contact:${dup.id}`);
  await audit('merge_contacts', { kept: keep.id, removed: dup.id });
  return { kept: keep.id, removed: dup.id };
}

/* ---------------- debts ---------------- */
export function debts() { return store.all('debt'); }

export async function recordDebt({ contact_id, direction, amount: amt, description, currency: cur }) {
  const who = requireContact(contact_id);
  const value = amount(amt);
  if (!['owes_me', 'i_owe'].includes(direction)) throw new DataError("direction must be 'owes_me' or 'i_owe'.");
  const id = store.nextId('debt');
  await store.put(`debt:${id}`, {
    id, contact_id: who.id, direction, original: value, remaining: value,
    currency: cur || currency(), description: description || null,
    created_at: nowISO(), settled_at: null, payments: [],
  });
  await audit('record_debt', { id, contact: who.full_name, direction, value });
  return { debt_id: id, contact: who.full_name, remaining: value, currency: cur || currency() };
}

export async function recordRepayment({ debt_id, amount: amt, note }) {
  const d = store.get(`debt:${Number(debt_id)}`);
  if (!d) throw new DataError(`No debt with id ${debt_id}. List debts first.`);
  const value = amount(amt);
  if (d.remaining <= 0) return { debt_id: d.id, remaining: 0, note: 'That debt was already settled; nothing recorded.' };
  const applied = Math.min(value, Math.round(d.remaining * 100) / 100);
  const remaining = Math.round((d.remaining - applied) * 100) / 100;
  await store.put(`debt:${d.id}`, {
    ...d, remaining, settled_at: remaining <= 0 ? nowISO() : null,
    payments: [...(d.payments || []), { amount: applied, note: note || null, at: nowISO() }],
  });
  await audit('record_repayment', { id: d.id, applied, remaining });
  const out = { debt_id: d.id, applied, remaining, currency: d.currency, settled: remaining <= 0 };
  if (applied < value) out.overpaid_by = Math.round((value - applied) * 100) / 100;
  return out;
}

export function listDebts({ contact_id, direction } = {}) {
  const byId = new Map(contacts().map((c) => [c.id, c.full_name]));
  return debts()
    .filter((d) => d.remaining > 0
      && (!contact_id || d.contact_id === Number(contact_id))
      && (!direction || d.direction === direction))
    .sort((a, b) => b.remaining - a.remaining)
    .map((d) => ({
      id: d.id, name: byId.get(d.contact_id) || '(deleted contact)',
      direction: d.direction, remaining: d.remaining, currency: d.currency,
      description: d.description,
    }));
}

/* ---------------- money ---------------- */
export function transactions() { return store.all('txn'); }

export async function addTransaction({ kind, amount: amt, category, merchant, description, occurred_on, currency: cur, contact_id }) {
  const value = amount(amt);
  if (!['expense', 'income'].includes(kind)) throw new DataError("kind must be 'expense' or 'income'.");
  if (contact_id != null) requireContact(contact_id);
  const id = store.nextId('txn');
  const when = occurred_on ? requireDate(occurred_on, 'occurred_on') : todayISO();
  await store.put(`txn:${id}`, {
    id, kind, amount: value, currency: cur || currency(),
    category: category || null, merchant: merchant || null,
    description: description || null, contact_id: contact_id ? Number(contact_id) : null,
    occurred_on: when, created_at: nowISO(),
  });
  await audit('add_transaction', { id, kind, value });
  return { transaction_id: id, amount: value, occurred_on: when };
}

export function spendingRows(since) {
  const groups = new Map();
  transactions()
    .filter((t) => t.kind === 'expense' && (!since || t.occurred_on >= since))
    .forEach((t) => {
      const k = t.category || 'uncategorised';
      const g = groups.get(k) || { category: k, total: 0, n: 0 };
      g.total = Math.round((g.total + t.amount) * 100) / 100;
      g.n += 1;
      groups.set(k, g);
    });
  return Array.from(groups.values()).sort((a, b) => b.total - a.total);
}

export function accounts() { return store.all('account'); }

export async function setAccountBalance({ name, balance, kind, currency: cur }) {
  const label = text(name, 'name', 60);
  const k = kind || 'asset';
  if (!['asset', 'liability'].includes(k)) throw new DataError("kind must be 'asset' or 'liability'.");
  const value = Math.round(Number(balance) * 100) / 100;
  if (!Number.isFinite(value)) throw new DataError('balance must be a number.');
  if (value < 0) throw new DataError('Record a debt as a positive number with kind=liability, not a negative balance.');
  const existing = accounts().find((a) => a.name.toLowerCase() === label.toLowerCase());
  const id = existing ? existing.id : store.nextId('account');
  await store.put(`account:${id}`, { id, name: label, kind: k, balance: value, currency: cur || currency(), updated_at: nowISO() });
  await audit('set_account_balance', { id, name: label, value });
  return { account: label, kind: k, balance: value, currency: cur || currency() };
}

export function wealth(month) {
  const m = month || todayISO().slice(0, 7);
  const accs = accounts();
  const sum = (list) => Math.round(list.reduce((t, a) => t + a.balance, 0) * 100) / 100;
  const assets = sum(accs.filter((a) => a.kind === 'asset'));
  const liabilities = sum(accs.filter((a) => a.kind === 'liability'));
  const debtTotal = (dir) => Math.round(debts().filter((d) => d.direction === dir && d.remaining > 0)
    .reduce((t, d) => t + d.remaining, 0) * 100) / 100;
  const flow = (kind) => Math.round(transactions().filter((t) => t.kind === kind && t.occurred_on.startsWith(m))
    .reduce((t, x) => t + x.amount, 0) * 100) / 100;
  const owedToMe = debtTotal('owes_me');
  const iOwe = debtTotal('i_owe');
  const netWorth = Math.round((assets - liabilities) * 100) / 100;
  const income = flow('income');
  const expense = flow('expense');
  return {
    currency: currency(), net_worth: netWorth,
    net_worth_incl_debts: Math.round((netWorth + owedToMe - iOwe) * 100) / 100,
    assets, liabilities, owed_to_me: owedToMe, i_owe: iOwe, month: m,
    income_this_month: income, expense_this_month: expense,
    net_cash_flow: Math.round((income - expense) * 100) / 100,
    accounts: accs.map((a) => ({ name: a.name, kind: a.kind, balance: a.balance, currency: a.currency })),
  };
}

/* ---------------- memory ---------------- */
export function memories() { return store.all('memory'); }

export async function remember(key, value, category) {
  const k = text(key, 'key', 80);
  const existing = memories().find((m) => m.key.toLowerCase() === k.toLowerCase());
  const id = existing ? existing.id : store.nextId('memory');
  await store.put(`memory:${id}`, {
    id, key: k, value: text(value, 'value', 2000), category: category || null,
    created_at: existing ? existing.created_at : nowISO(), updated_at: nowISO(),
  });
  await audit('remember', { key: k });
  return { remembered: k };
}

export function recall(query = '') {
  const q = String(query || '').toLowerCase();
  return memories()
    .filter((m) => !q || m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q))
    .slice(0, 30)
    .map((m) => ({ key: m.key, value: m.value, category: m.category }));
}

export async function forget(key) {
  const m = memories().find((x) => x.key.toLowerCase() === String(key).toLowerCase());
  if (!m) throw new DataError(`Nothing stored under '${key}'.`);
  await store.del(`memory:${m.id}`);
  await audit('forget', { key: m.key });
  return { forgotten: m.key };
}

/* ---------------- reminders ---------------- */
export function reminders() { return store.all('reminder'); }

export async function addReminder(textValue, dueAt) {
  const body = text(textValue, 'text', 300);
  const id = store.nextId('reminder');
  await store.put(`reminder:${id}`, {
    id, text: body, due_at: dueAt ? requireDateTime(dueAt, 'due_at') : null,
    done: false, created_at: nowISO(),
  });
  await audit('add_reminder', { id });
  return { reminder_id: id, due_at: dueAt || null };
}

export function openReminders() {
  return reminders().filter((r) => !r.done)
    .sort((a, b) => (a.due_at || '9999').localeCompare(b.due_at || '9999'));
}

export function remindersDue(day) {
  const end = `${day || todayISO()}T23:59`;
  return openReminders().filter((r) => r.due_at && r.due_at <= end);
}

export async function completeReminder(id) {
  const r = store.get(`reminder:${Number(id)}`);
  if (!r) throw new DataError(`No reminder with id ${id}.`);
  if (r.done) return { reminder_id: r.id, note: 'Already done.' };
  await store.put(`reminder:${r.id}`, { ...r, done: true, completed_at: nowISO() });
  await audit('complete_reminder', { id: r.id });
  return { reminder_id: r.id, completed: r.text };
}

export async function deleteReminder(id) {
  const r = store.get(`reminder:${Number(id)}`);
  if (!r) throw new DataError(`No reminder with id ${id}.`);
  await store.del(`reminder:${r.id}`);
  await audit('delete_reminder', { id: r.id });
  return { deleted_reminder: r.id };
}

/* ---------------- events ---------------- */
export function events() { return store.all('event'); }

export async function createEvent({ title, start_at, end_at, location, notes, contact_id, all_day }) {
  const name = text(title, 'title', 200);
  const start = all_day ? requireDate(start_at, 'start_at') : requireDateTime(start_at, 'start_at');
  let end = null;
  if (end_at) end = all_day ? requireDate(end_at, 'end_at') : requireDateTime(end_at, 'end_at');
  if (end && !all_day && end <= start) end = null;
  if (contact_id != null) requireContact(contact_id);
  const id = store.nextId('event');
  await store.put(`event:${id}`, {
    id, title: name, start_at: start, end_at: end, all_day: Boolean(all_day),
    location: location || null, notes: notes || null,
    contact_id: contact_id ? Number(contact_id) : null, created_at: nowISO(),
  });
  await audit('create_event', { id, title: name, start });
  return { event_id: id, title: name, start_at: start, all_day: Boolean(all_day) };
}

export function listEvents(from, to) {
  return events()
    .filter((e) => (!from || e.start_at >= from) && (!to || e.start_at <= to))
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
}

export async function deleteEvent(id) {
  const e = store.get(`event:${Number(id)}`);
  if (!e) throw new DataError(`No event with id ${id}.`);
  await store.del(`event:${e.id}`);
  await audit('delete_event', { id: e.id });
  return { deleted_event: e.id, title: e.title };
}

export function eventsCreatedAfter(iso) {
  return events().filter((e) => e.created_at >= iso).sort((a, b) => a.id - b.id);
}

/* ---------------- documents ---------------- */
export function documents() { return store.all('doc'); }

export async function createDocument(rawText, name) {
  const id = store.nextId('doc');
  await store.put(`doc:${id}`, { id, raw_text: rawText || '', file_name: name || null, created_at: nowISO() });
  await audit('create_document', { id, name });
  return id;
}

export async function updateDocument(id, fields) {
  const d = store.get(`doc:${Number(id)}`);
  if (!d) throw new DataError(`No document with id ${id}.`);
  const allowed = ['doc_type', 'merchant', 'summary', 'amount', 'currency', 'doc_date', 'contact_id', 'transaction_id'];
  const patch = {};
  allowed.forEach((k) => { if (fields[k] != null) patch[k] = fields[k]; });
  if (patch.doc_date) patch.doc_date = requireDate(patch.doc_date, 'doc_date');
  await store.put(`doc:${d.id}`, { ...d, ...patch });
  await audit('update_document', { id: d.id, type: patch.doc_type });
  return { document_id: d.id, ...patch };
}

export function documentText(id, offset = 0) {
  const d = store.get(`doc:${Number(id)}`);
  if (!d) throw new DataError(`No document with id ${id}.`);
  const start = Math.max(0, Number(offset) || 0);
  const chunk = (d.raw_text || '').slice(start, start + 6000);
  return { document_id: d.id, offset: start, text: chunk, remaining_chars: Math.max((d.raw_text || '').length - start - chunk.length, 0) };
}

export function listDocuments({ contact_id, doc_type } = {}) {
  return documents()
    .filter((d) => (!contact_id || d.contact_id === Number(contact_id)) && (!doc_type || d.doc_type === doc_type))
    .sort((a, b) => b.id - a.id).slice(0, 25)
    .map((d) => ({ id: d.id, doc_type: d.doc_type, merchant: d.merchant, amount: d.amount, doc_date: d.doc_date, summary: d.summary }));
}

/* ---------------- per-person position ---------------- */
/* Net position with one person: positive means they owe you, negative means you
 * owe them. Currencies are not converted - if you use more than one with the
 * same person, they are reported separately rather than silently summed. */
export function position(contactId) {
  const id = Number(contactId);
  const open = debts().filter((d) => d.contact_id === id && d.remaining > 0);
  const byCurrency = new Map();
  open.forEach((d) => {
    const cur = d.currency || currency();
    const signed = d.direction === 'owes_me' ? d.remaining : -d.remaining;
    byCurrency.set(cur, Math.round(((byCurrency.get(cur) || 0) + signed) * 100) / 100);
  });
  return {
    contact_id: id,
    by_currency: Array.from(byCurrency, ([cur, net]) => ({ currency: cur, net })),
    net: Math.round((byCurrency.get(currency()) || 0) * 100) / 100,
    owed_to_me: open.filter((d) => d.direction === 'owes_me'),
    i_owe: open.filter((d) => d.direction === 'i_owe'),
  };
}

/* Everyone, with their net position, heaviest balance first. Drives the People
 * list, which is the answer to "who do I need to sort out". */
export function peopleWithPositions() {
  return contacts()
    .map((c) => ({
      id: c.id,
      full_name: c.full_name,
      preferred_name: c.preferred_name,
      relationship: c.relationship,
      company: c.company,
      phones: c.phones || [],
      emails: c.emails || [],
      last_interaction: c.last_interaction,
      ...position(c.id),
    }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.full_name.localeCompare(b.full_name));
}

/* ---------------- splitting a bill ----------------
 * Allocation is resolved by the caller (the UI or the model tool) and validated
 * here, so there is exactly one place that decides what a split means.
 *
 * What gets recorded, and why:
 * - Your own share becomes an expense. That keeps spending summaries honest:
 *   a 60 dinner split three ways cost you 20, and a category total of 60 would
 *   be a lie.
 * - Everyone else's share becomes a debt. If you paid, they owe you. If someone
 *   else paid, you owe them your share.
 * The spending journal and the debt ledger are separate books here - account
 * balances are yours to maintain - so a share appearing in both is not double
 * counting.
 */
export async function splitBill({
  total, currency: cur, payer, participants, description, category, date, recordMyShare = true,
}) {
  const gross = amount(total, 'total');
  const money_cur = cur || currency();
  const when = date ? requireDate(date, 'date') : todayISO();
  if (!Array.isArray(participants) || !participants.length) {
    throw new DataError('Choose at least one person to split between.');
  }

  const parts = participants.map((p) => {
    const who = p.who === 'me' ? 'me' : Number(p.who);
    if (who !== 'me') requireContact(who);
    return { who, amount: amount(p.amount, 'share') };
  });
  const seen = new Set();
  parts.forEach((p) => {
    if (seen.has(String(p.who))) throw new DataError('The same person appears twice in the split.');
    seen.add(String(p.who));
  });

  const sum = Math.round(parts.reduce((t, p) => t + p.amount, 0) * 100) / 100;
  if (Math.abs(sum - gross) > 0.01) {
    throw new DataError(`The shares add up to ${sum}, not ${gross}. Adjust them before recording.`);
  }

  const payerId = payer === 'me' || payer == null ? 'me' : Number(payer);
  if (payerId !== 'me') requireContact(payerId);

  const label = description || 'Split bill';
  const mine = parts.find((p) => p.who === 'me');
  const created = { transaction_id: null, debts: [], label, total: gross, currency: money_cur };

  if (mine && recordMyShare) {
    const t = await addTransaction({
      kind: 'expense', amount: mine.amount, currency: money_cur,
      category: category || 'split', merchant: null,
      description: `${label} (your share of ${money_cur} ${gross})`,
      occurred_on: when,
      contact_id: payerId === 'me' ? null : payerId,
    });
    created.transaction_id = t.transaction_id;
  }

  if (payerId === 'me') {
    for (const p of parts) {
      if (p.who === 'me') continue;
      const d = await recordDebt({
        contact_id: p.who, direction: 'owes_me', amount: p.amount,
        description: label, currency: money_cur,
      });
      created.debts.push({ ...d, direction: 'owes_me', contact_id: p.who });
    }
  } else if (mine) {
    const d = await recordDebt({
      contact_id: payerId, direction: 'i_owe', amount: mine.amount,
      description: label, currency: money_cur,
    });
    created.debts.push({ ...d, direction: 'i_owe', contact_id: payerId });
  }

  await audit('split_bill', { total: gross, payer: payerId, people: parts.length });
  return created;
}

/* Even split with the remainder pennies handed to the earliest participants, so
 * the shares always add back to the exact total. */
export function evenShares(total, count) {
  const cents = Math.round(Number(total) * 100);
  if (!Number.isFinite(cents) || cents <= 0) throw new DataError('total must be more than zero.');
  if (!count || count < 1) throw new DataError('Choose at least one person.');
  const base = Math.floor(cents / count);
  let extra = cents - base * count;
  return Array.from({ length: count }, () => {
    const share = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
    return Math.round(share) / 100;
  });
}

/* ---------------- removing a person ---------------- */
export async function deleteContact(id, { force = false } = {}) {
  const c = requireContact(id);
  const open = debts().filter((d) => d.contact_id === c.id && d.remaining > 0);
  if (open.length && !force) {
    const total = Math.round(open.reduce((t, d) => t + d.remaining, 0) * 100) / 100;
    throw new DataError(`${c.full_name} still has ${open.length} open balance(s) totalling ${money(total)}. Settle or write them off first.`);
  }
  for (const d of debts()) {
    if (d.contact_id === c.id) await store.del(`debt:${d.id}`);
  }
  for (const t of transactions()) {
    if (t.contact_id === c.id) await store.put(`txn:${t.id}`, { ...t, contact_id: null });
  }
  for (const d of documents()) {
    if (d.contact_id === c.id) await store.put(`doc:${d.id}`, { ...d, contact_id: null });
  }
  await store.del(`contact:${c.id}`);
  await audit('delete_contact', { id: c.id, name: c.full_name, forced: force });
  return { deleted_contact: c.id, name: c.full_name };
}

/* Write off a balance without pretending it was paid, so the history stays
 * truthful: the payments list shows nothing, the debt just closes. */
export async function writeOffDebt(debtId, note) {
  const d = store.get(`debt:${Number(debtId)}`);
  if (!d) throw new DataError(`No debt with id ${debtId}.`);
  if (d.remaining <= 0) return { debt_id: d.id, note: 'Already closed.' };
  await store.put(`debt:${d.id}`, {
    ...d, remaining: 0, settled_at: nowISO(), written_off: true,
    write_off_note: note || null, written_off_amount: d.remaining,
  });
  await audit('write_off_debt', { id: d.id, amount: d.remaining });
  return { debt_id: d.id, written_off: d.remaining, currency: d.currency };
}

/* ---------------- bulk contact import ---------------- */
/* Used by the vCard importer. Matches on name first, then on any shared phone or
 * email, so re-importing your address book merges instead of duplicating. */
export function findExisting({ full_name, phones = [], emails = [] }) {
  const name = String(full_name || '').trim().toLowerCase();
  const digits = (s) => String(s).replace(/[^0-9]/g, '').slice(-8);
  const phoneKeys = new Set(phones.map(digits).filter((x) => x.length >= 7));
  const emailKeys = new Set(emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  return contacts().find((c) => {
    if (name && c.full_name.trim().toLowerCase() === name) return true;
    if (phoneKeys.size && (c.phones || []).some((p) => phoneKeys.has(digits(p)))) return true;
    if (emailKeys.size && (c.emails || []).some((e) => emailKeys.has(String(e).trim().toLowerCase()))) return true;
    return false;
  }) || null;
}

export async function upsertContact(card) {
  const existing = findExisting(card);
  if (!existing) {
    const created = await addContact({
      full_name: card.full_name,
      nickname: card.nickname, company: card.company, job_title: card.job_title,
      birthday: card.birthday, address: card.address, notes: card.notes,
    });
    const c = store.get(`contact:${created.contact_id}`);
    await store.put(`contact:${c.id}`, {
      ...c,
      phones: Array.from(new Set(card.phones || [])),
      emails: Array.from(new Set(card.emails || [])),
    });
    return { action: 'added', contact_id: c.id, full_name: c.full_name };
  }
  const union = (a, b) => Array.from(new Set([...(a || []), ...(b || [])]));
  await store.put(`contact:${existing.id}`, {
    ...existing,
    phones: union(existing.phones, card.phones),
    emails: union(existing.emails, card.emails),
    company: existing.company || card.company || null,
    job_title: existing.job_title || card.job_title || null,
    birthday: existing.birthday || (card.birthday ? requireDate(card.birthday, 'birthday') : null),
    address: existing.address || card.address || null,
    nickname: existing.nickname || card.nickname || null,
  });
  await audit('merge_imported_contact', { id: existing.id });
  return { action: 'merged', contact_id: existing.id, full_name: existing.full_name };
}

/* ---------------- brief ---------------- */
export function dailyBrief(day) {
  const d = day ? requireDate(day) : todayISO();
  const w = wealth();
  return {
    date: d,
    reminders_due: remindersDue(d),
    events_today: listEvents(d, `${d}T23:59`),
    wealth: { net_worth: w.net_worth, net_cash_flow: w.net_cash_flow, currency: w.currency },
  };
}
