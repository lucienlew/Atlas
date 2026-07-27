/* Zero-inference layer: everything here runs on-device with no API call.
 *
 * This exists for two reasons. It is free, and it works with no API key at all,
 * which means Atlas is a usable encrypted ledger even if you never connect a
 * model. And it is instant, which for "who owes me money" matters more than
 * being clever.
 *
 * Anything that doesn't match falls through to the model (if a key is set).
 */
import * as m from './model.js';

const NAME = '([\\p{L}][\\p{L}\\s.\'-]{0,40}?)';
const AMT = '([0-9]+(?:[.,][0-9]{1,2})?)';

function num(s) { return Number(String(s).replace(',', '.')); }

function leader(label, value) {
  return { label, value };
}

/* ---------------- read-only answers ---------------- */
function owedToMe() {
  const rows = m.listDebts({ direction: 'owes_me' });
  if (!rows.length) return { title: 'Nobody owes you anything.', rows: [] };
  const total = rows.reduce((t, r) => t + r.remaining, 0);
  return {
    title: 'Owed to you', total: m.money(total),
    rows: rows.map((r) => leader(r.description ? `${r.name} — ${r.description}` : r.name, m.money(r.remaining))),
  };
}

function iOwe() {
  const rows = m.listDebts({ direction: 'i_owe' });
  if (!rows.length) return { title: 'You owe nothing.', rows: [] };
  const total = rows.reduce((t, r) => t + r.remaining, 0);
  return {
    title: 'You owe', total: m.money(total),
    rows: rows.map((r) => leader(r.description ? `${r.name} — ${r.description}` : r.name, m.money(r.remaining))),
  };
}

function worth() {
  const w = m.wealth();
  const rows = [
    leader('Assets', m.money(w.assets)),
    leader('Liabilities', m.money(w.liabilities)),
  ];
  if (w.owed_to_me) rows.push(leader('Owed to you', m.money(w.owed_to_me)));
  if (w.i_owe) rows.push(leader('You owe', m.money(w.i_owe)));
  rows.push(leader(`In, ${w.month}`, m.money(w.income_this_month)));
  rows.push(leader(`Out, ${w.month}`, m.money(w.expense_this_month)));
  return { title: 'Net worth', total: m.money(w.net_worth), rows, footer: `Including debts, ${m.money(w.net_worth_incl_debts)}.` };
}

function spending(since) {
  const from = since || `${m.todayISO().slice(0, 7)}-01`;
  const rows = m.spendingRows(from);
  if (!rows.length) return { title: `No spending recorded since ${from}.`, rows: [] };
  const total = rows.reduce((t, r) => t + r.total, 0);
  return {
    title: `Spending since ${from}`, total: m.money(total),
    rows: rows.map((r) => leader(`${r.category} (${r.n})`, m.money(r.total))),
  };
}

function reminderList() {
  const rows = m.openReminders();
  if (!rows.length) return { title: 'No open reminders.', rows: [] };
  return {
    title: 'Open reminders',
    rows: rows.map((r) => leader(`[${r.id}] ${r.text}`, r.due_at ? r.due_at.replace('T', ' ') : '—')),
  };
}

function brief() {
  const b = m.dailyBrief();
  const rows = [];
  b.reminders_due.forEach((r) => rows.push(leader(`Due — ${r.text}`, (r.due_at || '').slice(11, 16) || '—')));
  b.events_today.forEach((e) => rows.push(leader(e.location ? `${e.title} · ${e.location}` : e.title, e.all_day ? 'all day' : e.start_at.slice(11, 16))));
  if (!rows.length) rows.push(leader('Nothing due and nothing scheduled', '—'));
  return {
    title: `Today · ${b.date}`, total: m.money(b.wealth.net_worth), totalLabel: 'net worth',
    rows, footer: `Cash flow this month ${m.money(b.wealth.net_cash_flow)}.`,
  };
}

function week() {
  const from = m.todayISO();
  // Local day arithmetic. toISOString() here would convert to UTC and, for any
  // positive offset early in the day, hand back yesterday - a 6-day "week".
  const d = new Date(`${from}T12:00:00`);
  d.setDate(d.getDate() + 7);
  const to = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const rows = m.listEvents(from, `${to}T23:59`);
  if (!rows.length) return { title: 'Nothing scheduled in the next 7 days.', rows: [] };
  return {
    title: 'Next 7 days',
    rows: rows.map((e) => leader(e.location ? `${e.title} · ${e.location}` : e.title,
      e.all_day ? `${e.start_at.slice(5, 10)} all day` : `${e.start_at.slice(5, 10)} ${e.start_at.slice(11, 16)}`)),
  };
}

function contactList(q) {
  const rows = m.findContacts(q || '');
  if (!rows.length) return { title: q ? `No contacts matching "${q}".` : 'No contacts yet.', rows: [] };
  return { title: q ? `Contacts matching "${q}"` : 'Contacts', rows: rows.map((c) => leader(c.display_name + (c.display_name === c.full_name ? '' : ` (${c.full_name})`), c.relationship || '—')) };
}

export const HELP = `**Shorthand** — instant, private, and free. No model involved.

*Ask*
· owed · i owe · people · worth · spending · reminders · today · week
· contacts [name] · log

*Record*
· spent 12.50 coffee
· spent 42 groceries at Cold Storage
· earned 3000 salary
· john owes 20 dinner
· i owe sara 15 taxi
· john paid 20
· split 60 dinner with john, sara
· remind call the bank @ ${m.tomorrowISO()} 09:00
· event dentist @ ${m.tomorrowISO()} 10:00 at Orchard
· contact Sara Lim
· note allergy: peanuts
· balance DBS 12000 · balance Amex 800 liability
· done 3

Anything else goes to Claude, if you've added an API key in Settings.`;

/* ---------------- write commands ---------------- */
async function findOne(name) {
  const hits = m.findContacts(name.trim());
  if (!hits.length) throw new m.DataError(`No contact called "${name.trim()}". Add them with: contact ${name.trim()}`);
  if (hits.length > 1) {
    const want = name.trim().toLowerCase();
    const exact = hits.filter((h) => h.full_name.toLowerCase() === want
      || String(h.nickname || '').toLowerCase() === want);
    if (exact.length === 1) return exact[0];
    throw new m.DataError(`"${name.trim()}" matches ${hits.map((h) => h.display_name).join(', ')}. Be more specific.`);
  }
  return hits[0];
}

function whenFrom(raw) {
  const s = raw.trim().replace(/\s+/, 'T');
  return m.requireDateTime(s, 'time');
}

const WRITES = [
  {
    re: new RegExp(`^spent\\s+${AMT}\\s+(.+?)(?:\\s+at\\s+(.+))?$`, 'iu'),
    run: async (mt) => {
      const r = await m.addTransaction({ kind: 'expense', amount: num(mt[1]), category: mt[2].trim(), merchant: mt[3] ? mt[3].trim() : null });
      return { title: 'Expense recorded', rows: [leader(mt[2].trim() + (mt[3] ? ` · ${mt[3].trim()}` : ''), m.money(r.amount))] };
    },
  },
  {
    re: new RegExp(`^earned\\s+${AMT}\\s+(.+)$`, 'iu'),
    run: async (mt) => {
      const r = await m.addTransaction({ kind: 'income', amount: num(mt[1]), category: mt[2].trim() });
      return { title: 'Income recorded', rows: [leader(mt[2].trim(), m.money(r.amount))] };
    },
  },
  {
    re: new RegExp(`^${NAME}\\s+owes?\\s+${AMT}(?:\\s+(?:for\\s+)?(.+))?$`, 'iu'),
    run: async (mt) => {
      const c = await findOne(mt[1]);
      const r = await m.recordDebt({ contact_id: c.id, direction: 'owes_me', amount: num(mt[2]), description: mt[3] ? mt[3].trim() : null });
      return { title: `${c.display_name} owes you`, rows: [leader(r.description || 'recorded', m.money(r.remaining))], total: m.money(r.remaining) };
    },
  },
  {
    re: new RegExp(`^i\\s+owe\\s+${NAME}\\s+${AMT}(?:\\s+(?:for\\s+)?(.+))?$`, 'iu'),
    run: async (mt) => {
      const c = await findOne(mt[1]);
      const r = await m.recordDebt({ contact_id: c.id, direction: 'i_owe', amount: num(mt[2]), description: mt[3] ? mt[3].trim() : null });
      return { title: `You owe ${c.display_name}`, rows: [leader(r.description || 'recorded', m.money(r.remaining))], total: m.money(r.remaining) };
    },
  },
  {
    re: new RegExp(`^${NAME}\\s+(?:paid|repaid)\\s+${AMT}$`, 'iu'),
    run: async (mt) => {
      const c = await findOne(mt[1]);
      const open = m.listDebts({ contact_id: c.id, direction: 'owes_me' });
      if (!open.length) throw new m.DataError(`${c.display_name} has no outstanding debt to you.`);
      const r = await m.recordRepayment({ debt_id: open[0].id, amount: num(mt[2]) });
      const rows = [leader('Applied', m.money(r.applied)), leader('Still outstanding', m.money(r.remaining))];
      if (r.overpaid_by) rows.push(leader('Overpaid by', m.money(r.overpaid_by)));
      return { title: r.settled ? `${c.display_name} is settled up` : `${c.display_name} repaid you`, rows };
    },
  },
  {
    // "split 60 dinner with john, sara" — you paid, shared evenly with everyone
    // named plus yourself. Anything more involved (someone else paid, uneven
    // shares) goes through People -> split, where you can see the preview.
    re: new RegExp(`^split\\s+${AMT}\\s+(.+?)\\s+with\\s+(.+)$`, 'iu'),
    run: async (mt) => {
      const total = num(mt[1]);
      const label = mt[2].trim();
      const names = mt[3].split(/,|\band\b|&/).map((x) => x.trim()).filter(Boolean);
      if (!names.length) throw new m.DataError('Name at least one person to split with.');
      const found = [];
      for (const n of names) found.push(await findOne(n));
      const shares = m.evenShares(total, found.length + 1);
      const res = await m.splitBill({
        total,
        payer: 'me',
        description: label,
        category: 'split',
        participants: [
          { who: 'me', amount: shares[0] },
          ...found.map((c, i) => ({ who: c.id, amount: shares[i + 1] })),
        ],
      });
      const rows = [leader('Your share', m.money(shares[0]))];
      found.forEach((c, i) => rows.push(leader(`${c.display_name} owes you`, m.money(shares[i + 1]))));
      return {
        title: `${label} split ${found.length + 1} ways`,
        total: m.money(total),
        totalLabel: 'you paid',
        rows,
        footer: `Your share was recorded as an expense. ${res.debts.length} balance(s) created.`,
      };
    },
  },
  {
    re: /^remind\s+(.+?)\s+@\s*(.+)$/iu,
    run: async (mt) => {
      const r = await m.addReminder(mt[1].trim(), whenFrom(mt[2]));
      return { title: 'Reminder set', rows: [leader(mt[1].trim(), r.due_at.replace('T', ' '))] };
    },
  },
  {
    re: /^event\s+(.+?)\s+@\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})(?:\s+at\s+(.+))?$/iu,
    run: async (mt) => {
      const r = await m.createEvent({ title: mt[1].trim(), start_at: whenFrom(mt[2]), location: mt[3] ? mt[3].trim() : null });
      return { title: 'Event created', rows: [leader(r.title, r.start_at.replace('T', ' '))], eventId: r.event_id };
    },
  },
  {
    re: /^contact\s+(.+)$/iu,
    run: async (mt) => {
      const r = await m.addContact({ full_name: mt[1].trim() });
      return { title: 'Contact added', rows: [leader(r.full_name, `id ${r.contact_id}`)] };
    },
  },
  {
    re: /^note\s+([^:]{1,80}):\s*(.+)$/iu,
    run: async (mt) => {
      await m.remember(mt[1].trim(), mt[2].trim());
      return { title: 'Noted', rows: [leader(mt[1].trim(), mt[2].trim())] };
    },
  },
  {
    re: new RegExp(`^balance\\s+(.+?)\\s+${AMT}(\\s+liability)?$`, 'iu'),
    run: async (mt) => {
      const r = await m.setAccountBalance({ name: mt[1].trim(), balance: num(mt[2]), kind: mt[3] ? 'liability' : 'asset' });
      return { title: `${r.account} updated`, rows: [leader(r.kind, m.money(r.balance))] };
    },
  },
  {
    re: /^done\s+(\d+)$/iu,
    run: async (mt) => {
      const r = await m.completeReminder(Number(mt[1]));
      return { title: 'Done', rows: [leader(r.completed || `reminder ${r.reminder_id}`, '✓')] };
    },
  },
];

const READS = [
  [/^(owed|who owes me( money)?|what am i owed)$/iu, owedToMe],
  [/^(i owe|what do i owe|my debts|who do i owe( money)?)$/iu, iOwe],
  [/^(worth|net worth|networth|how am i doing|wealth)$/iu, worth],
  [/^(spending|spend|expenses)$/iu, () => spending()],
  [/^spending since (\d{4}-\d{2}-\d{2})$/iu, (mt) => spending(mt[1])],
  [/^(reminders?|todos?|to.?do)$/iu, reminderList],
  [/^(today|brief|agenda|what.?s my day|whats my day)$/iu, brief],
  [/^(week|this week|next 7 days|upcoming)$/iu, week],
  [/^(people|balances|who)$/iu, () => {
    const rows = m.peopleWithPositions().filter((p) => p.net !== 0);
    if (!rows.length) return { title: 'Everyone is settled up.', rows: [] };
    return {
      title: 'Where you stand',
      rows: rows.map((p) => leader(p.display_name,
        p.net > 0 ? `+${m.money(p.net)}` : `-${m.money(-p.net)}`)),
      footer: 'Open People for the detail, or to settle one.',
    };
  }],
  [/^contacts?$/iu, () => contactList('')],
  [/^contacts?\s+(.+)$/iu, (mt) => contactList(mt[1])],
  [/^(help|\?|commands)$/iu, () => ({ markdown: HELP })],
  [/^(log|audit|history)$/iu, () => ({
    title: 'Recent activity',
    rows: m.auditTail(20).map((a) => leader(a.action.replace(/_/g, ' '), a.at.slice(5, 16).replace('T', ' '))),
  })],
];

function normalise(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').replace(/[?!.]+$/, '');
}

/* Returns a result object, or null to fall through to the model. */
export async function match(input) {
  const t = normalise(input);
  if (!t) return null;
  for (const [re, fn] of READS) {
    const mt = t.match(re);
    if (mt) return { source: 'local', ...(await fn(mt)) };
  }
  for (const w of WRITES) {
    const mt = t.match(w.re);
    if (mt) return { source: 'local', ...(await w.run(mt)) };
  }
  return null;
}
