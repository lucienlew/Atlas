/* Tool registry for the model. Same shape as the Python version: every tool
 * declares whether it is sensitive, and sensitive tools cannot run until you
 * approve them. The model never touches storage directly.
 */
import * as m from './model.js';

export const REGISTRY = {};

function tool(name, description, schema, run, sensitive = false) {
  REGISTRY[name] = { name, description, input_schema: schema, run, sensitive };
}

const obj = (properties, required = []) => ({ type: 'object', properties, required });
const S = { type: 'string' };
const N = { type: 'number' };
const I = { type: 'integer' };

tool('find_contacts', 'Search contacts by name, nickname, company, tag or relationship.',
  obj({ query: S }), (a) => m.findContacts(a.query));

tool('get_contact', 'Full profile for one contact, including their debts, linked transactions, dates and recent interactions.',
  obj({ contact_id: I }, ['contact_id']), (a) => m.getContact(a.contact_id));

tool('add_contact', 'Create a contact with any known details.',
  obj({
    full_name: S, preferred_name: S, nickname: S, phone: S, email: S,
    relationship: { type: 'string', description: 'friend, family, client, etc.' },
    birthday: { type: 'string', description: 'YYYY-MM-DD' },
    address: S, company: S, job_title: S,
    tags: { type: 'array', items: S }, notes: S,
  }, ['full_name']), (a) => m.addContact(a));

tool('update_contact', 'Change one field on a contact.',
  obj({ contact_id: I, field: { type: 'string', enum: ['full_name', 'preferred_name', 'nickname', 'birthday', 'address', 'company', 'job_title', 'relationship', 'notes'] }, value: S },
    ['contact_id', 'field', 'value']), (a) => m.updateContact(a.contact_id, a.field, a.value));

tool('add_contact_detail', 'Append a phone, email, tag or important date to a contact.',
  obj({ contact_id: I, kind: { type: 'string', enum: ['phone', 'email', 'tag', 'important_date'] }, value: S, label: S },
    ['contact_id', 'kind', 'value']), (a) => m.addContactDetail(a.contact_id, a.kind, a.value, a.label));

tool('log_interaction', 'Record a touchpoint with a contact.',
  obj({ contact_id: I, summary: S, channel: S }, ['contact_id', 'summary']),
  (a) => m.logInteraction(a.contact_id, a.summary, a.channel));

tool('merge_contacts', 'Merge a duplicate contact into another, moving their debts, transactions and history over.',
  obj({ keep_id: I, duplicate_id: I }, ['keep_id', 'duplicate_id']),
  (a) => m.mergeContacts(a.keep_id, a.duplicate_id), true);

tool('record_debt', 'Record that someone owes the owner money, or that the owner owes someone.',
  obj({ contact_id: I, direction: { type: 'string', enum: ['owes_me', 'i_owe'] }, amount: N, description: S, currency: S },
    ['contact_id', 'direction', 'amount']), (a) => m.recordDebt(a), true);

tool('record_repayment', 'Log a full or partial repayment against a debt.',
  obj({ debt_id: I, amount: N, note: S }, ['debt_id', 'amount']),
  (a) => m.recordRepayment(a), true);

tool('split_bill', "Split a bill between people. Give the total and each person's "
  + "share; use who='me' for the owner. The owner's own share is recorded as an "
  + "expense and everyone else's becomes a debt, so spending summaries stay "
  + "accurate. Shares must add up to the total.",
  obj({
    total: N,
    payer: { type: 'string', description: "'me', or a contact id as a string" },
    participants: {
      type: 'array',
      description: 'every person in the split, with the amount they are responsible for',
      items: obj({
        who: { type: 'string', description: "'me' or a contact id" },
        amount: N,
      }, ['who', 'amount']),
    },
    description: S, category: S,
    date: { type: 'string', description: 'YYYY-MM-DD' },
    currency: S,
    record_my_share: { type: 'boolean', description: 'default true' },
  }, ['total', 'participants']),
  (a) => m.splitBill({
    total: a.total, payer: a.payer, participants: a.participants,
    description: a.description, category: a.category, date: a.date,
    currency: a.currency, recordMyShare: a.record_my_share !== false,
  }), true);

tool('even_shares', 'Work out an even split of a total between N people, with the '
  + 'remainder pennies distributed so the shares add back to the exact total. '
  + 'Use this before split_bill rather than dividing yourself.',
  obj({ total: N, people: I }, ['total', 'people']),
  (a) => ({ shares: m.evenShares(a.total, a.people) }));

tool('contact_position', 'Where the owner stands with one person: the net balance '
  + 'and every open debt in both directions.',
  obj({ contact_id: I }, ['contact_id']), (a) => m.position(a.contact_id));

tool('people_overview', 'Everyone the owner knows with their net balance, heaviest '
  + 'first. Use for "who do I need to settle up with".', obj({}),
  () => m.peopleWithPositions().map((p) => ({
    id: p.id, full_name: p.full_name, relationship: p.relationship, net: p.net,
  })));

tool('write_off_debt', 'Close a debt without recording a payment, when it will '
  + 'never be paid or is being forgiven.',
  obj({ debt_id: I, note: S }, ['debt_id']),
  (a) => m.writeOffDebt(a.debt_id, a.note), true);

tool('delete_contact', 'Delete a contact. Refuses while they have open balances '
  + 'unless force is true; their past expenses are kept but unlinked.',
  obj({ contact_id: I, force: { type: 'boolean' } }, ['contact_id']),
  (a) => m.deleteContact(a.contact_id, { force: Boolean(a.force) }), true);

tool('list_debts', 'List outstanding debts, optionally for one contact or one direction.',
  obj({ contact_id: I, direction: { type: 'string', enum: ['owes_me', 'i_owe'] } }),
  (a) => m.listDebts(a));

tool('add_transaction', 'Record an expense or income.',
  obj({
    kind: { type: 'string', enum: ['expense', 'income'] }, amount: N, category: S,
    merchant: S, description: S,
    occurred_on: { type: 'string', description: 'YYYY-MM-DD' }, currency: S,
    contact_id: { type: 'integer', description: 'who this relates to, if anyone' },
  }, ['kind', 'amount']), (a) => m.addTransaction(a), true);

tool('transaction_history', 'The actual list of expenses and income, newest '
  + 'first, with optional filters. Use this when asked what happened rather than '
  + 'how much in total.',
  obj({
    from: { type: 'string', description: 'YYYY-MM-DD' },
    to: { type: 'string', description: 'YYYY-MM-DD' },
    kind: { type: 'string', enum: ['expense', 'income'] },
    category: S, contact_id: I,
    limit: { type: 'integer', description: 'default 50' },
  }),
  (a) => m.transactionHistory({
    from: a.from ? m.requireDate(a.from, 'from') : null,
    to: a.to ? m.requireDate(a.to, 'to') : null,
    kind: a.kind || null, category: a.category || null,
    contactId: a.contact_id ?? null, limit: a.limit || 50,
  }));

tool('repayment_history', 'Every repayment and write-off, newest first. Settling a '
  + 'debt is not spending, so these are separate from transaction_history.',
  obj({ contact_id: I, from: S, to: S }),
  (a) => m.movementHistory({
    contactId: a.contact_id ?? null,
    from: a.from ? m.requireDate(a.from, 'from') : null,
    to: a.to ? m.requireDate(a.to, 'to') : null,
  }));

tool('delete_transaction', 'Delete an expense or income entry that was recorded in error.',
  obj({ transaction_id: I }, ['transaction_id']),
  (a) => m.deleteTransaction(a.transaction_id), true);

tool('rename_contact', "Set what the owner calls someone (nickname) and/or their "
  + 'full real name. Both stay searchable.',
  obj({ contact_id: I, nickname: S, full_name: S }, ['contact_id']),
  (a) => m.renameContact(a.contact_id, { nickname: a.nickname, full_name: a.full_name }));

tool('spending_summary', 'Total expenses by category, optionally since a date.',
  obj({ since: { type: 'string', description: 'YYYY-MM-DD' } }),
  (a) => m.spendingRows(a.since ? m.requireDate(a.since, 'since') : null));

tool('set_account_balance', "Create or update a manual account balance. kind='asset' for cash and investments, kind='liability' for a card balance or loan owed.",
  obj({ name: S, balance: N, kind: { type: 'string', enum: ['asset', 'liability'] }, currency: S }, ['name', 'balance']),
  (a) => m.setAccountBalance(a), true);

tool('wealth_overview', "Net worth and cash flow: assets minus liabilities, money owed either way, and this month's income against expense.",
  obj({ month: { type: 'string', description: 'YYYY-MM; omit for the current month' } }),
  (a) => m.wealth(a.month));

tool('remember', 'Store a durable fact or preference about the owner.',
  obj({ key: S, value: S, category: S }, ['key', 'value']),
  (a) => m.remember(a.key, a.value, a.category));

tool('recall', 'Retrieve stored facts matching a query.', obj({ query: S }), (a) => m.recall(a.query));

tool('forget', 'Delete a stored memory by its exact key.', obj({ key: S }, ['key']),
  (a) => m.forget(a.key), true);

tool('add_reminder', 'Create a reminder. due_at must be a full ISO datetime.',
  obj({ text: S, due_at: { type: 'string', description: 'YYYY-MM-DDTHH:MM' } }, ['text']),
  (a) => m.addReminder(a.text, a.due_at));

tool('list_reminders', 'List open reminders.', obj({}), () => m.openReminders());

tool('complete_reminder', 'Mark a reminder done.', obj({ reminder_id: I }, ['reminder_id']),
  (a) => m.completeReminder(a.reminder_id));

tool('delete_reminder', 'Delete a reminder outright. Prefer complete_reminder for something actually done.',
  obj({ reminder_id: I }, ['reminder_id']), (a) => m.deleteReminder(a.reminder_id), true);

tool('create_event', 'Create a calendar event. The owner gets a tap-to-add .ics file.',
  obj({
    title: S, start_at: { type: 'string', description: 'YYYY-MM-DDTHH:MM, or YYYY-MM-DD with all_day' },
    end_at: S, location: S, notes: S, contact_id: I,
    all_day: { type: 'boolean', description: 'true for a whole-day event' },
  }, ['title', 'start_at']), (a) => m.createEvent(a));

tool('list_events', 'List events between two ISO datetimes.', obj({ from: S, to: S }),
  (a) => m.listEvents(a.from, a.to));

tool('delete_event', 'Delete a calendar event by id.', obj({ event_id: I }, ['event_id']),
  (a) => m.deleteEvent(a.event_id), true);

tool('daily_brief', "The owner's brief for a date: reminders due, the day's events, and a short wealth snapshot.",
  obj({ date: { type: 'string', description: 'YYYY-MM-DD; omit for today' } }),
  (a) => m.dailyBrief(a.date));

tool('read_document_text', 'Get more of a scanned document\'s text. You are given a preview; only call this if it was cut off.',
  obj({ document_id: I, offset: I }, ['document_id']),
  (a) => m.documentText(a.document_id, a.offset));

tool('update_document', 'Classify a scanned document and link it to a contact and/or the transaction it produced.',
  obj({
    document_id: I, doc_type: S, merchant: S, summary: S, amount: N, currency: S,
    doc_date: { type: 'string', description: 'YYYY-MM-DD' }, contact_id: I, transaction_id: I,
  }, ['document_id']), (a) => m.updateDocument(a.document_id, a));

tool('list_documents', 'List stored documents, optionally by contact or type.',
  obj({ contact_id: I, doc_type: S }), (a) => m.listDocuments(a));

export const SCHEMAS = Object.values(REGISTRY).map(({ name, description, input_schema }) => ({ name, description, input_schema }));

export function isSensitive(name) {
  return Boolean(REGISTRY[name] && REGISTRY[name].sensitive);
}

export function describe(name, args, maxValue = 160) {
  const parts = Object.entries(args || {}).map(([k, v]) => {
    let s = String(v).replace(/\s+/g, ' ');
    if (s.length > maxValue) s = `${s.slice(0, maxValue)}… (+${s.length - maxValue})`;
    return `${k}=${s}`;
  });
  return `${name}(${parts.join(', ')})`;
}

export async function run(name, args) {
  const entry = REGISTRY[name];
  if (!entry) return `Unknown tool '${name}'. Available: ${Object.keys(REGISTRY).sort().join(', ')}.`;
  if (args && typeof args !== 'object') return 'Tool arguments must be an object.';
  try {
    return await entry.run(args || {});
  } catch (e) {
    return `Could not do that: ${e.message}`;
  }
}
