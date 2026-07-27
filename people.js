/* The People section: who you know, what stands between you, and splitting.
 *
 * Built with DOM nodes and textContent throughout — same rule as ui.js, for the
 * same reason. Nothing here uses innerHTML.
 */
import * as m from './model.js';
import * as vcard from './vcard.js';
import * as ui from './ui.js';

const $ = (id) => document.getElementById(id);
const sheets = { people: $('peopleSheet'), person: $('personSheet'), split: $('splitSheet') };
let onChanged = () => {};

export function init(changedCallback) {
  onChanged = changedCallback || (() => {});
}

function node(tag, className, textValue) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (textValue != null) n.textContent = textValue;
  return n;
}

function button(label, className, handler) {
  const b = node('button', className, label);
  b.type = 'button';
  b.addEventListener('click', handler);
  return b;
}

function ledgerRow(label, value, tone) {
  const li = node('li', 'row');
  li.appendChild(node('span', 'row-label', label));
  li.appendChild(node('span', 'row-fill'));
  li.appendChild(node('span', `row-value${tone ? ` ${tone}` : ''}`, value));
  return li;
}

function group(title) {
  const g = node('div', 'group');
  if (title) g.appendChild(node('p', 'group-title', title));
  return g;
}

function open(name) { sheets[name].classList.remove('hidden'); }
function close(name) { sheets[name].classList.add('hidden'); }

/* Positive net means they owe you. The sign carries the meaning, so the colour
 * is there to confirm it, not to replace it. */
function netLabel(net) {
  if (!net) return { text: 'settled', tone: '' };
  return net > 0
    ? { text: `owes you ${m.money(net)}`, tone: 'stat-good' }
    : { text: `you owe ${m.money(-net)}`, tone: 'stat-bad' };
}

/* ---------------- list ---------------- */
export function openPeople() {
  renderList();
  open('people');
}

export function renderList() {
  const filter = ($('peopleSearch').value || '').trim().toLowerCase();
  const host = $('peopleList');
  host.replaceChildren();

  const all = m.peopleWithPositions();
  const people = filter
    ? all.filter((p) => [p.full_name, p.preferred_name, p.company, p.relationship]
      .filter(Boolean).some((f) => f.toLowerCase().includes(filter)))
    : all;

  const owedToYou = all.filter((p) => p.net > 0).reduce((t, p) => t + p.net, 0);
  const youOwe = all.filter((p) => p.net < 0).reduce((t, p) => t - p.net, 0);

  const summary = node('div', 'card card-local');
  summary.appendChild(node('p', 'card-eyebrow', `${all.length} ${all.length === 1 ? 'person' : 'people'}`));
  const rows = node('ul', 'rows');
  rows.appendChild(ledgerRow('Owed to you', m.money(owedToYou), owedToYou ? 'stat-good' : ''));
  rows.appendChild(ledgerRow('You owe', m.money(youOwe), youOwe ? 'stat-bad' : ''));
  summary.appendChild(rows);
  host.appendChild(summary);

  if (!people.length) {
    const empty = node('div', 'card');
    empty.appendChild(node('h2', 'card-title', all.length ? 'Nobody matches that.' : 'No people yet.'));
    empty.appendChild(node('p', 'card-footer', all.length
      ? 'Clear the search to see everyone.'
      : 'Import your address book below, or type: contact Sara Lim'));
    host.appendChild(empty);
    return;
  }

  const list = node('div', 'people-list');
  people.forEach((p) => {
    const { text, tone } = netLabel(p.net);
    const row = button('', 'person-row', () => openPerson(p.id));
    row.replaceChildren();
    const left = node('div', 'person-row-main');
    left.appendChild(node('span', 'person-name', p.full_name));
    const sub = [p.relationship, p.company].filter(Boolean).join(' · ');
    if (sub) left.appendChild(node('span', 'person-sub', sub));
    row.appendChild(left);
    row.appendChild(node('span', `person-net ${tone}`, text));
    list.appendChild(row);
  });
  host.appendChild(list);
}

/* ---------------- one person ---------------- */
export function openPerson(id) {
  const detail = m.getContact(id);
  const pos = m.position(id);
  const c = detail.profile;
  const body = $('personBody');
  $('personTitle').textContent = c.full_name;
  body.replaceChildren();

  // headline position
  const head = node('div', 'card card-local');
  const { text, tone } = netLabel(pos.net);
  head.appendChild(node('p', 'card-eyebrow', [c.relationship, c.company, c.job_title].filter(Boolean).join(' · ') || 'contact'));
  head.appendChild(node('p', 'total', pos.net ? m.money(Math.abs(pos.net)) : '—'));
  head.appendChild(node('p', `total-label ${tone}`, text));
  if (pos.by_currency.length > 1) {
    const multi = node('ul', 'rows');
    pos.by_currency.forEach((x) => multi.appendChild(ledgerRow(x.currency, x.net.toFixed(2), x.net > 0 ? 'stat-good' : 'stat-bad')));
    head.appendChild(multi);
    head.appendChild(node('p', 'card-footer', 'More than one currency, so these are kept separate rather than added up.'));
  }
  body.appendChild(head);

  // reach them — the one place iOS integration genuinely works from a web app
  const reach = node('div', 'reach-row');
  (c.phones || []).slice(0, 2).forEach((p) => {
    reach.appendChild(linkChip('Call', `tel:${p.replace(/[^0-9+]/g, '')}`));
    reach.appendChild(linkChip('Text', `sms:${p.replace(/[^0-9+]/g, '')}`));
  });
  (c.emails || []).slice(0, 1).forEach((e) => reach.appendChild(linkChip('Email', `mailto:${e}`)));
  reach.appendChild(button('Add to Contacts', 'chip', () => exportOne(c)));
  if (reach.children.length) body.appendChild(reach);

  // balances, each settleable
  const balances = group('Open balances');
  if (!pos.owed_to_me.length && !pos.i_owe.length) {
    balances.appendChild(node('p', 'note', 'Nothing outstanding either way.'));
  }
  [...pos.owed_to_me, ...pos.i_owe].forEach((d) => balances.appendChild(debtCard(d, c)));
  balances.appendChild(button('Record a new balance', 'btn', () => newBalance(c)));
  balances.appendChild(button(`Split a bill with ${c.preferred_name || c.full_name.split(' ')[0]}`, 'btn', () => openSplit(c.id)));
  body.appendChild(balances);

  // details
  const info = group('Details');
  const rows = node('ul', 'rows');
  (c.phones || []).forEach((p) => rows.appendChild(ledgerRow('Phone', p)));
  (c.emails || []).forEach((e) => rows.appendChild(ledgerRow('Email', e)));
  if (c.birthday) rows.appendChild(ledgerRow('Birthday', c.birthday));
  if (c.address) rows.appendChild(ledgerRow('Address', c.address));
  (detail.important_dates || []).forEach((d) => rows.appendChild(ledgerRow(d.label, d.date)));
  if (rows.children.length) info.appendChild(rows);
  if (c.notes) info.appendChild(node('p', 'card-footer', c.notes));
  info.appendChild(addDetailForm(c));
  body.appendChild(info);

  // spending linked to them
  if (detail.recent_transactions.length) {
    const spend = group('Recent spending together');
    const rs = node('ul', 'rows');
    detail.recent_transactions.forEach((t) => rs.appendChild(ledgerRow(
      `${t.occurred_on} ${t.category || t.merchant || 'expense'}`, m.money(t.amount),
    )));
    spend.appendChild(rs);
    body.appendChild(spend);
  }

  if (detail.recent_interactions.length) {
    const hist = group('Recent contact');
    const rh = node('ul', 'rows');
    detail.recent_interactions.forEach((i) => rh.appendChild(ledgerRow(i.summary, (i.at || '').slice(5, 16).replace('T', ' '))));
    hist.appendChild(rh);
    body.appendChild(hist);
  }

  // destructive
  const danger = group('Remove');
  danger.appendChild(node('p', 'note', 'Deleting keeps their past expenses but unlinks them. Open balances must be settled or written off first.'));
  danger.appendChild(button(`Delete ${c.full_name}`, 'btn btn-danger', async () => {
    if (!window.confirm(`Delete ${c.full_name}?`)) return;
    try {
      await m.deleteContact(c.id);
      close('person');
      renderList();
      onChanged();
      ui.toast(`${c.full_name} deleted.`);
    } catch (e) {
      ui.toast(e.message, true);
    }
  }));
  body.appendChild(danger);

  open('person');
}

function linkChip(label, href) {
  const a = document.createElement('a');
  a.className = 'chip';
  a.href = href;
  a.textContent = label;
  a.rel = 'noopener';
  return a;
}

function debtCard(d, c) {
  const wrap = node('div', 'card');
  const owed = d.direction === 'owes_me';
  wrap.appendChild(node('p', 'card-eyebrow', owed ? `${c.full_name} owes you` : `you owe ${c.full_name}`));
  wrap.appendChild(node('h2', 'card-title', d.description || 'No description'));
  wrap.appendChild(node('p', 'total', `${d.currency} ${d.remaining.toFixed(2)}`));
  wrap.appendChild(node('p', 'total-label', `of ${d.currency} ${Number(d.original).toFixed(2)} · id ${d.id}`));

  const form = node('div', 'inline-form');
  const input = node('input', 'field field-mono');
  input.type = 'number';
  input.step = '0.01';
  input.min = '0';
  input.placeholder = 'amount';
  input.inputMode = 'decimal';
  form.appendChild(input);
  form.appendChild(button('Repay', 'btn btn-primary', async () => {
    try {
      const res = await m.recordRepayment({ debt_id: d.id, amount: input.value });
      ui.toast(res.settled ? 'Settled.' : `${m.money(res.remaining)} still outstanding.`);
      openPerson(c.id);
      renderList();
      onChanged();
    } catch (e) {
      ui.toast(e.message, true);
    }
  }));
  form.appendChild(button('All', 'btn', () => { input.value = String(d.remaining); }));
  wrap.appendChild(form);

  wrap.appendChild(button('Write it off', 'btn btn-quiet', async () => {
    if (!window.confirm(`Write off ${d.currency} ${d.remaining.toFixed(2)}? It closes without recording a payment.`)) return;
    try {
      await m.writeOffDebt(d.id, 'written off');
      ui.toast('Written off.');
      openPerson(c.id);
      renderList();
      onChanged();
    } catch (e) {
      ui.toast(e.message, true);
    }
  }));
  return wrap;
}

function newBalance(c) {
  const wrap = $('personBody');
  const box = node('div', 'card confirm');
  box.appendChild(node('p', 'card-eyebrow', 'new balance'));
  const dir = node('select', 'field');
  [['owes_me', `${c.full_name} owes me`], ['i_owe', `I owe ${c.full_name}`]].forEach(([v, label]) => {
    const o = node('option', null, label);
    o.value = v;
    dir.appendChild(o);
  });
  const amt = node('input', 'field field-mono');
  amt.type = 'number'; amt.step = '0.01'; amt.min = '0'; amt.placeholder = 'amount'; amt.inputMode = 'decimal';
  const desc = node('input', 'field');
  desc.type = 'text'; desc.placeholder = 'what for';
  box.appendChild(dir); box.appendChild(amt); box.appendChild(desc);
  const actions = node('div', 'confirm-actions');
  actions.appendChild(button('Record', 'btn btn-primary', async () => {
    try {
      await m.recordDebt({ contact_id: c.id, direction: dir.value, amount: amt.value, description: desc.value || null });
      ui.toast('Recorded.');
      openPerson(c.id);
      renderList();
      onChanged();
    } catch (e) {
      ui.toast(e.message, true);
    }
  }));
  actions.appendChild(button('Cancel', 'btn', () => box.remove()));
  box.appendChild(actions);
  wrap.appendChild(box);
  box.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function addDetailForm(c) {
  const form = node('div', 'inline-form');
  const kind = node('select', 'field');
  [['phone', 'Phone'], ['email', 'Email'], ['tag', 'Tag'], ['important_date', 'Date (YYYY-MM-DD)']].forEach(([v, label]) => {
    const o = node('option', null, label);
    o.value = v;
    kind.appendChild(o);
  });
  const value = node('input', 'field');
  value.type = 'text';
  value.placeholder = 'value';
  form.appendChild(kind);
  form.appendChild(value);
  form.appendChild(button('Add', 'btn', async () => {
    try {
      await m.addContactDetail(c.id, kind.value, value.value, kind.value === 'important_date' ? 'date' : null);
      openPerson(c.id);
      onChanged();
    } catch (e) {
      ui.toast(e.message, true);
    }
  }));
  return form;
}

/* ---------------- split a bill ---------------- */
let splitState = null;

export function openSplit(preselectId) {
  const people = m.contacts().sort((a, b) => a.full_name.localeCompare(b.full_name));
  splitState = {
    total: '', description: '', category: 'split', date: m.todayISO(),
    payer: 'me', mode: 'equal',
    selected: new Set(['me', ...(preselectId ? [String(preselectId)] : [])]),
    custom: new Map(), recordMyShare: true, people,
  };
  renderSplit();
  open('split');
}

function participantsFor() {
  const s = splitState;
  const ids = Array.from(s.selected);
  const total = Number(String(s.total).replace(',', '.'));
  if (!Number.isFinite(total) || total <= 0 || !ids.length) return [];
  if (s.mode === 'equal') {
    let shares;
    try { shares = m.evenShares(total, ids.length); } catch { return []; }
    return ids.map((who, i) => ({ who, amount: shares[i] }));
  }
  return ids.map((who) => ({ who, amount: Number(s.custom.get(who) || 0) }));
}

function nameOf(who) {
  if (who === 'me') return 'You';
  const c = m.contacts().find((x) => String(x.id) === String(who));
  return c ? c.full_name : `#${who}`;
}

function renderSplit() {
  const s = splitState;
  const body = $('splitBody');
  body.replaceChildren();

  const basics = group('The bill');
  const total = node('input', 'field field-mono');
  total.type = 'number'; total.step = '0.01'; total.min = '0'; total.inputMode = 'decimal';
  total.placeholder = `total in ${m.currency()}`;
  total.value = s.total;
  total.addEventListener('input', () => { s.total = total.value; refreshPreview(); });
  const desc = node('input', 'field');
  desc.type = 'text'; desc.placeholder = 'what it was (dinner, taxi, gift)'; desc.value = s.description;
  desc.addEventListener('input', () => { s.description = desc.value; });
  const cat = node('input', 'field');
  cat.type = 'text'; cat.placeholder = 'category'; cat.value = s.category;
  cat.addEventListener('input', () => { s.category = cat.value; });
  const date = node('input', 'field field-mono');
  date.type = 'date'; date.value = s.date;
  date.addEventListener('input', () => { s.date = date.value; });
  basics.append(total, desc, cat, date);
  body.appendChild(basics);

  const payer = group('Who paid');
  const sel = node('select', 'field');
  const me = node('option', null, 'You paid');
  me.value = 'me';
  sel.appendChild(me);
  s.people.forEach((c) => {
    const o = node('option', null, `${c.full_name} paid`);
    o.value = String(c.id);
    sel.appendChild(o);
  });
  sel.value = String(s.payer);
  sel.addEventListener('change', () => {
    s.payer = sel.value;
    s.selected.add(sel.value === 'me' ? 'me' : sel.value);
    renderSplit();
  });
  payer.appendChild(sel);
  body.appendChild(payer);

  const who = group('Split between');
  if (!s.people.length) {
    who.appendChild(node('p', 'note', 'No contacts yet. Import your address book, or type: contact Sara Lim'));
  }
  who.appendChild(toggleRow('me', 'You'));
  s.people.forEach((c) => who.appendChild(toggleRow(String(c.id), c.full_name)));
  body.appendChild(who);

  const how = group('How');
  const modeRow = node('div', 'group-row');
  ['equal', 'custom'].forEach((mode) => {
    const b = button(mode === 'equal' ? 'Split evenly' : 'Set each amount',
      `btn${s.mode === mode ? ' btn-primary' : ''}`, () => { s.mode = mode; renderSplit(); });
    modeRow.appendChild(b);
  });
  how.appendChild(modeRow);
  if (s.mode === 'custom') {
    Array.from(s.selected).forEach((id) => {
      const row = node('div', 'inline-form');
      row.appendChild(node('span', 'inline-label', nameOf(id)));
      const inp = node('input', 'field field-mono');
      inp.type = 'number'; inp.step = '0.01'; inp.min = '0'; inp.inputMode = 'decimal';
      inp.value = s.custom.get(id) || '';
      inp.addEventListener('input', () => { s.custom.set(id, inp.value); refreshPreview(); });
      row.appendChild(inp);
      how.appendChild(row);
    });
  }
  const shareToggle = node('label', 'check-row');
  const cb = node('input');
  cb.type = 'checkbox';
  cb.checked = s.recordMyShare;
  cb.addEventListener('change', () => { s.recordMyShare = cb.checked; refreshPreview(); });
  shareToggle.appendChild(cb);
  shareToggle.appendChild(node('span', null, 'Record your share as an expense'));
  how.appendChild(shareToggle);
  body.appendChild(how);

  const preview = node('div', 'group');
  preview.id = 'splitPreview';
  body.appendChild(preview);
  refreshPreview();
}

function toggleRow(id, label) {
  const s = splitState;
  const on = s.selected.has(id);
  const row = button('', `person-row${on ? ' is-on' : ''}`, () => {
    if (s.selected.has(id)) {
      if (String(s.payer) === id && id !== 'me') return;   // the payer must be in the split
      s.selected.delete(id);
    } else {
      s.selected.add(id);
    }
    renderSplit();
  });
  row.replaceChildren();
  const main = node('div', 'person-row-main');
  main.appendChild(node('span', 'person-name', label));
  row.appendChild(main);
  row.appendChild(node('span', 'person-net', on ? 'in' : ''));
  return row;
}

/* The preview is the point: it states exactly what will be written before you
 * commit, in the same language the ledger will use afterwards. */
function refreshPreview() {
  const host = $('splitPreview');
  if (!host) return;
  host.replaceChildren();
  const s = splitState;
  const parts = participantsFor();
  const total = Number(String(s.total).replace(',', '.'));

  host.appendChild(node('p', 'group-title', 'What will be recorded'));

  if (!parts.length) {
    host.appendChild(node('p', 'note', 'Enter a total and choose who was involved.'));
    return;
  }
  const sum = Math.round(parts.reduce((t, p) => t + p.amount, 0) * 100) / 100;
  const card = node('div', 'card card-local');
  const rows = node('ul', 'rows');
  parts.forEach((p) => rows.appendChild(ledgerRow(nameOf(p.who), m.money(p.amount))));
  card.appendChild(rows);

  const mine = parts.find((p) => p.who === 'me');
  const lines = [];
  if (mine && s.recordMyShare) lines.push(`Expense of ${m.money(mine.amount)} for your share.`);
  if (String(s.payer) === 'me') {
    parts.filter((p) => p.who !== 'me').forEach((p) => lines.push(`${nameOf(p.who)} owes you ${m.money(p.amount)}.`));
  } else if (mine) {
    lines.push(`You owe ${nameOf(s.payer)} ${m.money(mine.amount)}.`);
  }
  if (!lines.length) lines.push('Nothing — you are not in the split and did not pay.');
  card.appendChild(node('p', 'card-footer', lines.join('\n')));
  host.appendChild(card);

  if (Math.abs(sum - total) > 0.01) {
    host.appendChild(node('p', 'note note-bad', `Shares add up to ${m.money(sum)}, not ${m.money(total)}. Adjust before recording.`));
    return;
  }

  host.appendChild(button('Record this split', 'btn btn-primary', async () => {
    try {
      const res = await m.splitBill({
        total, currency: m.currency(), payer: s.payer, participants: parts,
        description: s.description || 'Split bill', category: s.category || 'split',
        date: s.date, recordMyShare: s.recordMyShare,
      });
      close('split');
      renderList();
      onChanged();
      ui.toast(`Split recorded — ${res.debts.length} balance(s) created.`);
    } catch (e) {
      ui.toast(e.message, true);
    }
  }));
}

/* ---------------- vCard in and out ---------------- */
export async function importVcf(file) {
  const text = await file.text();
  const { cards, skipped } = vcard.parse(text);
  if (!cards.length) {
    ui.toast('No contacts found in that file.', true);
    return;
  }
  const preview = cards.map((c) => ({ card: c, existing: m.findExisting(c) }));
  const willAdd = preview.filter((p) => !p.existing).length;
  const willMerge = preview.length - willAdd;
  const message = `${cards.length} contact(s) read: ${willAdd} new, ${willMerge} matching someone you already have (their phones and emails will be merged in).${skipped ? ` ${skipped} skipped for having no name.` : ''}\n\nImport them?`;
  if (!window.confirm(message)) return;

  let added = 0;
  let merged = 0;
  const failures = [];
  for (const p of preview) {
    try {
      const res = await m.upsertContact(p.card);
      if (res.action === 'added') added += 1; else merged += 1;
    } catch (e) {
      failures.push(p.card.full_name);
    }
  }
  renderList();
  onChanged();
  ui.toast(`${added} added, ${merged} merged${failures.length ? `, ${failures.length} failed` : ''}.`);
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function exportOne(c) {
  download(`${c.full_name.replace(/[^A-Za-z0-9._-]+/g, '_') || 'contact'}.vcf`, vcard.toVCard(c), 'text/vcard');
  ui.toast('Open the file to add them to Apple Contacts.');
}

export function exportAll() {
  const all = m.contacts();
  if (!all.length) { ui.toast('No contacts to export.', true); return; }
  download(`atlas-contacts-${m.todayISO()}.vcf`, vcard.toVCards(all), 'text/vcard');
  ui.toast(`${all.length} contact(s) written.`);
}

/* ---------------- wiring ---------------- */
$('peopleClose').addEventListener('click', () => close('people'));
$('personClose').addEventListener('click', () => { close('person'); renderList(); });
$('splitClose').addEventListener('click', () => close('split'));
$('peopleSearch').addEventListener('input', renderList);
$('peopleSplitBtn').addEventListener('click', () => openSplit());
$('vcfImportBtn').addEventListener('click', () => $('vcfFile').click());
$('vcfExportBtn').addEventListener('click', exportAll);
$('vcfFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) {
    try { await importVcf(file); } catch (err) { ui.toast(err.message, true); }
  }
  e.target.value = '';
});
