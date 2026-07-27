/* Transaction history and the agenda.
 *
 * The spending summary answers "where does my money go". This answers "what
 * actually happened", which is the question you ask when a total looks wrong.
 * Repayments are kept in a separate stream from expenses on purpose: settling a
 * debt is not spending, it is money moving against something already recorded,
 * and mixing them would double-count every split bill.
 */
import * as m from './model.js';
import { eventToICS, remindersToICS } from './ics.js';
import * as ui from './ui.js';

const $ = (id) => document.getElementById(id);
let onChanged = () => {};
let openPersonRef = () => {};

export function init({ changed, openPerson } = {}) {
  onChanged = changed || (() => {});
  openPersonRef = openPerson || (() => {});
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

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const monthLabel = (key) => {
  if (!/^\d{4}-\d{2}$/.test(key)) return 'Undated';
  const d = new Date(`${key}-01T12:00:00`);
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};

/* ---------------- history ---------------- */
const state = { stream: 'spending', kind: '', category: '', contactId: null };

export function openHistory(opts = {}) {
  if (opts.contactId !== undefined) state.contactId = opts.contactId;
  renderHistory();
  $('historySheet').classList.remove('hidden');
}

function chipRow(options, current, onPick) {
  const row = node('div', 'chip-row');
  options.forEach(([value, label]) => {
    const b = button(label, `chip${String(current) === String(value) ? ' is-on' : ''}`, () => onPick(value));
    row.appendChild(b);
  });
  return row;
}

function renderHistory() {
  const host = $('historyBody');
  host.replaceChildren();

  const filters = node('div', 'group');
  filters.appendChild(chipRow([
    ['spending', 'Expenses & income'],
    ['movements', 'Repayments'],
  ], state.stream, (v) => { state.stream = v; renderHistory(); }));

  if (state.stream === 'spending') {
    filters.appendChild(chipRow([
      ['', 'All'], ['expense', 'Out'], ['income', 'In'],
    ], state.kind, (v) => { state.kind = v; renderHistory(); }));
    const cats = m.categoriesUsed();
    if (cats.length > 1) {
      filters.appendChild(chipRow([['', 'Every category'], ...cats.map((c) => [c, c])],
        state.category, (v) => { state.category = v; renderHistory(); }));
    }
  }

  if (state.contactId != null) {
    const who = m.contacts().find((c) => c.id === Number(state.contactId));
    filters.appendChild(chipRow([['clear', `Only ${who ? m.displayName(who) : 'one person'} — clear`]],
      'never', () => { state.contactId = null; renderHistory(); }));
  }
  host.appendChild(filters);

  const rows = state.stream === 'spending'
    ? m.transactionHistory({ kind: state.kind || null, category: state.category || null, contactId: state.contactId })
    : m.movementHistory({ contactId: state.contactId });

  if (!rows.length) {
    const empty = node('div', 'card');
    empty.appendChild(node('h2', 'card-title', state.stream === 'spending'
      ? 'Nothing recorded yet.' : 'No repayments yet.'));
    empty.appendChild(node('p', 'card-footer', state.stream === 'spending'
      ? 'Try: spent 12.50 coffee' : 'Repayments appear here once someone settles up.'));
    host.appendChild(empty);
    return;
  }

  const total = rows.reduce((t, r) => t + (r.kind === 'income' ? r.amount : -r.amount), 0);
  if (state.stream === 'spending') {
    const head = node('div', 'card card-local');
    head.appendChild(node('p', 'card-eyebrow', `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`));
    head.appendChild(node('p', 'total', m.money(Math.abs(total))));
    head.appendChild(node('p', `total-label ${total < 0 ? 'stat-bad' : 'stat-good'}`,
      total < 0 ? 'net out' : 'net in'));
    host.appendChild(head);
  }

  m.byMonth(rows).forEach((g) => {
    const section = node('div', 'group');
    const header = node('div', 'month-head');
    header.appendChild(node('span', 'month-name', monthLabel(g.month)));
    if (state.stream === 'spending') {
      header.appendChild(node('span', `month-net ${g.net < 0 ? 'stat-bad' : 'stat-good'}`,
        `${g.net < 0 ? '−' : '+'}${m.money(Math.abs(g.net))}`));
    }
    section.appendChild(header);
    const list = node('div', 'entry-list');
    g.rows.forEach((r) => list.appendChild(state.stream === 'spending' ? entryRow(r) : movementRow(r)));
    section.appendChild(list);
    host.appendChild(section);
  });
}

function entryRow(r) {
  const row = node('div', 'entry');
  const main = node('div', 'entry-main');
  const title = [r.merchant, r.category].filter(Boolean)[0] || 'expense';
  main.appendChild(node('span', 'entry-title', title));
  const bits = [r.date, r.merchant && r.category !== r.merchant ? r.category : null, r.who]
    .filter(Boolean).join(' · ');
  main.appendChild(node('span', 'entry-sub', bits));
  if (r.description) main.appendChild(node('span', 'entry-note', r.description));
  row.appendChild(main);

  const right = node('div', 'entry-right');
  right.appendChild(node('span', `entry-amount ${r.kind === 'income' ? 'stat-good' : ''}`,
    `${r.kind === 'income' ? '+' : '−'}${r.currency} ${r.amount.toFixed(2)}`));
  const actions = node('div', 'entry-actions');
  if (r.contact_id) {
    actions.appendChild(button('person', 'mini-btn', () => {
      $('historySheet').classList.add('hidden');
      openPersonRef(r.contact_id);
    }));
  }
  actions.appendChild(button('delete', 'mini-btn mini-btn-danger', async () => {
    if (!window.confirm(`Delete this ${r.kind} of ${r.currency} ${r.amount.toFixed(2)}?`)) return;
    try {
      await m.deleteTransaction(r.id);
      renderHistory();
      onChanged();
      ui.toast('Deleted.');
    } catch (e) {
      ui.toast(e.message, true);
    }
  }));
  right.appendChild(actions);
  row.appendChild(right);
  return row;
}

function movementRow(r) {
  const row = node('div', 'entry');
  const main = node('div', 'entry-main');
  const towards = r.direction === 'owes_me' ? `${r.who} → you` : `you → ${r.who}`;
  main.appendChild(node('span', 'entry-title', r.kind === 'write_off' ? `Written off · ${r.who}` : towards));
  main.appendChild(node('span', 'entry-sub', [r.date, r.description].filter(Boolean).join(' · ')));
  if (r.note) main.appendChild(node('span', 'entry-note', r.note));
  row.appendChild(main);
  const right = node('div', 'entry-right');
  const tone = r.kind === 'write_off' ? 'stat-bad' : (r.direction === 'owes_me' ? 'stat-good' : '');
  right.appendChild(node('span', `entry-amount ${tone}`, `${r.currency} ${Number(r.amount).toFixed(2)}`));
  right.appendChild(node('span', 'entry-sub', r.kind === 'write_off' ? 'no payment' : 'repayment'));
  row.appendChild(right);
  return row;
}

/* ---------------- agenda ---------------- */
export function openAgenda() {
  renderAgenda();
  $('agendaSheet').classList.remove('hidden');
}

function renderAgenda() {
  const host = $('agendaBody');
  host.replaceChildren();

  const explain = node('div', 'card card-local');
  explain.appendChild(node('p', 'card-eyebrow', 'how this works'));
  explain.appendChild(node('h2', 'card-title', 'One-way, by design of iOS'));
  explain.appendChild(node('p', 'card-footer',
    'Safari cannot read or write your Calendar, so Atlas keeps its own events and '
    + 'hands them to iOS Calendar as files you tap to add. Each one carries a 30-minute '
    + 'alert. Nothing flows back — an event you edit in Calendar will not change here.'));
  host.appendChild(explain);

  const upcoming = m.agenda();
  const past = m.pastEvents(25);
  const due = m.openReminders().filter((r) => r.due_at);

  const actions = node('div', 'group-row');
  actions.appendChild(button('Export all events', 'btn', () => {
    const all = m.events();
    if (!all.length) { ui.toast('No events to export.', true); return; }
    download(`atlas-events-${m.todayISO()}.ics`,
      all.map((e) => eventToICS(e, { alarmMinutes: e.all_day ? null : 30 })).join(''),
      'text/calendar');
    ui.toast(`${all.length} event(s) written. Open the file to add them.`);
  }));
  actions.appendChild(button('Export reminders', 'btn', () => {
    if (!due.length) { ui.toast('No reminders with a time set.', true); return; }
    download(`atlas-reminders-${m.todayISO()}.ics`, remindersToICS(due), 'text/calendar');
    ui.toast(`${due.length} reminder(s) written as calendar to-dos.`);
  }));
  host.appendChild(actions);

  host.appendChild(section('Upcoming', upcoming, true));
  if (due.length) {
    const g = node('div', 'group');
    g.appendChild(node('p', 'group-title', 'Reminders with a time'));
    const list = node('div', 'entry-list');
    due.forEach((r) => {
      const row = node('div', 'entry');
      const main = node('div', 'entry-main');
      main.appendChild(node('span', 'entry-title', r.text));
      main.appendChild(node('span', 'entry-sub', (r.due_at || '').replace('T', ' ')));
      row.appendChild(main);
      const right = node('div', 'entry-right');
      right.appendChild(button('done', 'mini-btn', async () => {
        await m.completeReminder(r.id);
        renderAgenda();
        onChanged();
      }));
      row.appendChild(right);
      list.appendChild(row);
    });
    g.appendChild(list);
    host.appendChild(g);
  }
  if (past.length) host.appendChild(section('Past', past, false));
}

function section(title, rows, allowAdd) {
  const g = node('div', 'group');
  g.appendChild(node('p', 'group-title', title));
  if (!rows.length) {
    g.appendChild(node('p', 'note', title === 'Upcoming'
      ? `Nothing scheduled. Try: event dentist @ ${m.tomorrowISO()} 10:00 at Orchard`
      : 'Nothing yet.'));
    return g;
  }
  const list = node('div', 'entry-list');
  rows.forEach((e) => {
    const row = node('div', 'entry');
    const main = node('div', 'entry-main');
    main.appendChild(node('span', 'entry-title', e.title));
    main.appendChild(node('span', 'entry-sub', [
      e.all_day ? `${e.start_at} · all day` : e.start_at.replace('T', ' '),
      e.location, e.who,
    ].filter(Boolean).join(' · ')));
    if (e.notes) main.appendChild(node('span', 'entry-note', e.notes));
    row.appendChild(main);
    const right = node('div', 'entry-right');
    const acts = node('div', 'entry-actions');
    if (allowAdd) {
      acts.appendChild(button('add', 'mini-btn', () => {
        download(`${e.title.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'event'}.ics`,
          eventToICS(e, { alarmMinutes: e.all_day ? null : 30 }), 'text/calendar');
      }));
    }
    acts.appendChild(button('delete', 'mini-btn mini-btn-danger', async () => {
      if (!window.confirm(`Delete "${e.title}"?`)) return;
      try {
        await m.deleteEvent(e.id);
        renderAgenda();
        onChanged();
      } catch (err) {
        ui.toast(err.message, true);
      }
    }));
    right.appendChild(acts);
    row.appendChild(right);
    list.appendChild(row);
  });
  g.appendChild(list);
  return g;
}

/* ---------------- wiring ---------------- */
$('historyClose').addEventListener('click', () => $('historySheet').classList.add('hidden'));
$('agendaClose').addEventListener('click', () => $('agendaSheet').classList.add('hidden'));
