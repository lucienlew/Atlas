/* Rendering. Every value from storage or from the model is inserted with
 * textContent, never innerHTML — an XSS bug in this app would expose the
 * decryption key held in memory, so there is no version of "just this once".
 */
const $ = (id) => document.getElementById(id);

export const el = {
  gate: $('gate'), gateSeal: $('gateSeal'), gateSub: $('gateSub'), gateNote: $('gateNote'),
  gateGo: $('gateGo'), gateRestore: $('gateRestore'), restoreFile: $('restoreFile'),
  pass: $('pass'), pass2: $('pass2'),
  bar: $('bar'), log: $('log'), working: $('working'), composer: $('composer'),
  input: $('input'), send: $('send'), cameraBtn: $('cameraBtn'), scanFile: $('scanFile'),
  settingsBtn: $('settingsBtn'), lockBtn: $('lockBtn'),
  nav: $('nav'), peopleBtn: $('peopleBtn'), historyBtn: $('historyBtn'),
  agendaBtn: $('agendaBtn'),
  sheet: $('sheet'), sheetClose: $('sheetClose'),
  apiKey: $('apiKey'), model: $('model'), currency: $('currency'), autolock: $('autolock'),
  saveSettings: $('saveSettings'), exportBtn: $('exportBtn'), importBtn: $('importBtn'),
  importFile: $('importFile'), eraseBtn: $('eraseBtn'),
  statRecords: $('statRecords'), statPersist: $('statPersist'), statBackup: $('statBackup'),
  statTokens: $('statTokens'), statCache: $('statCache'),
};

function node(tag, className, textValue) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (textValue != null) n.textContent = textValue;
  return n;
}

/* A deliberately tiny formatter: **bold**, *label*, and line breaks. Built from
 * text nodes, so there is no HTML parsing path for content to escape through. */
function formatted(text) {
  const wrap = node('p', 'prose');
  const parts = String(text).split(/(\*\*[^*]+\*\*|\*[^*\n]+\*)/g);
  parts.forEach((part) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) wrap.appendChild(node('strong', null, part.slice(2, -2)));
    else if (/^\*[^*]+\*$/.test(part)) wrap.appendChild(node('em', null, part.slice(1, -1)));
    else if (part) wrap.appendChild(document.createTextNode(part));
  });
  return wrap;
}

function scrollDown() {
  requestAnimationFrame(() => { el.log.scrollTop = el.log.scrollHeight; });
}

export function said(text) {
  const n = node('div', 'said rises', text);
  el.log.appendChild(n);
  scrollDown();
}

/* The passbook card: eyebrow, title, optional big tabular total, leader rows. */
export function card(result, { source = 'local', bad = false } = {}) {
  const wrap = node('div', `card rises ${bad ? 'card-bad' : (source === 'model' ? 'card-model' : 'card-local')}`);
  wrap.appendChild(node('p', 'card-eyebrow', bad ? 'error' : (source === 'model' ? 'claude' : 'on device')));

  if (result.markdown) {
    wrap.appendChild(formatted(result.markdown));
  } else {
    if (result.title) wrap.appendChild(node('h2', 'card-title', result.title));
    if (result.total) {
      wrap.appendChild(node('p', 'total', result.total));
      wrap.appendChild(node('p', 'total-label', result.totalLabel || 'total'));
    }
    if (result.rows && result.rows.length) {
      const list = node('ul', 'rows');
      result.rows.forEach((r) => {
        const li = node('li', 'row');
        li.appendChild(node('span', 'row-label', r.label));
        li.appendChild(node('span', 'row-fill'));
        li.appendChild(node('span', 'row-value', r.value));
        list.appendChild(li);
      });
      wrap.appendChild(list);
    }
    if (result.text) wrap.appendChild(formatted(result.text));
    if (result.footer) wrap.appendChild(node('p', 'card-footer', result.footer));
  }
  el.log.appendChild(wrap);
  scrollDown();
  return wrap;
}

export function confirmCard(summary, onDecide) {
  const wrap = node('div', 'card confirm rises');
  wrap.appendChild(node('p', 'card-eyebrow', 'needs your approval'));
  wrap.appendChild(node('h2', 'card-title', 'This will change your records'));
  const list = node('ul', 'confirm-list');
  summary.forEach((s) => list.appendChild(node('li', null, s)));
  wrap.appendChild(list);

  const actions = node('div', 'confirm-actions');
  const yes = node('button', 'btn btn-primary', 'Approve');
  const no = node('button', 'btn', 'Cancel');
  yes.type = 'button';
  no.type = 'button';
  const settle = (approved) => {
    actions.remove();
    wrap.appendChild(node('p', 'card-footer', approved ? 'Approved.' : 'Cancelled. Nothing changed.'));
    onDecide(approved);
  };
  yes.addEventListener('click', () => settle(true));
  no.addEventListener('click', () => settle(false));
  actions.appendChild(yes);
  actions.appendChild(no);
  wrap.appendChild(actions);

  el.log.appendChild(wrap);
  scrollDown();
  return wrap;
}

export function attachment(label, filename, blobUrl) {
  const wrap = node('div', 'card rises card-local');
  wrap.appendChild(node('p', 'card-eyebrow', 'calendar'));
  const a = document.createElement('a');
  a.className = 'card-title';
  a.href = blobUrl;
  a.download = filename;
  a.textContent = label;
  wrap.appendChild(a);
  wrap.appendChild(node('p', 'card-footer', 'Open it to add this to your Calendar.'));
  el.log.appendChild(wrap);
  scrollDown();
}

let toastTimer = null;

export function toast(message, bad = false) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const n = node('div', `toast${bad ? ' toast-bad' : ''}`, message);
  document.body.appendChild(n);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => n.remove(), bad ? 5200 : 2600);
}

export function working(on, label = 'thinking…') {
  el.working.textContent = label;
  el.working.classList.toggle('hidden', !on);
  el.send.disabled = on;
}

export function showApp(on) {
  el.gate.classList.toggle('hidden', on);
  [el.bar, el.nav, el.log, el.composer].forEach((n) => n.classList.toggle('hidden', !on));
  el.gateSeal.classList.toggle('is-open', on);
  if (on) el.input.focus();
}

export function clearLog() { el.log.replaceChildren(); }

export function note(target, message, tone = '') {
  target.textContent = message;
  target.className = `note ${tone}`.trim();
}
