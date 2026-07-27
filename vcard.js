/* vCard reading and writing.
 *
 * Why this file exists: iOS Safari has no Contacts API. The Contact Picker API
 * (navigator.contacts) is Chrome-on-Android only, so a web app cannot read your
 * Apple Contacts, and no amount of permissions prompting changes that.
 *
 * What does work is vCard files, both directions, entirely on the device:
 *   in  — export your address book from iCloud.com or the Shortcuts app as a
 *         .vcf and hand it to Atlas. Parsed here, never uploaded.
 *   out — Atlas writes a .vcf for one person; opening it offers to add them to
 *         Apple Contacts.
 *
 * The parser handles what Apple actually emits, which is more than the spec
 * suggests: grouped properties (item1.TEL), quoted-printable, base64 photos to
 * skip, folded lines, and vCard 2.1 / 3.0 / 4.0 date formats.
 */

/* Unfold: a line beginning with a space or tab continues the previous one. */
function unfold(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '');
}

function unescapeValue(v) {
  return String(v)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function decodeQuotedPrintable(v) {
  const bytes = [];
  for (let i = 0; i < v.length; i += 1) {
    if (v[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(v.slice(i + 1, i + 3))) {
      bytes.push(parseInt(v.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(v.charCodeAt(i));
    }
  }
  try {
    return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
  } catch {
    return v;
  }
}

/* NAME;PARAM=X;PARAM=Y:value  ->  { name, params, value } */
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const rawName = line.slice(0, colon);
  let value = line.slice(colon + 1);
  const bits = rawName.split(';');
  // Apple groups related properties as item1.TEL, item1.X-ABLabel and so on.
  let name = bits[0].toUpperCase();
  if (name.includes('.')) name = name.split('.').pop();
  const params = {};
  bits.slice(1).forEach((bit) => {
    const eq = bit.indexOf('=');
    if (eq < 0) { params.TYPE = `${params.TYPE ? `${params.TYPE},` : ''}${bit.toUpperCase()}`; return; }
    const k = bit.slice(0, eq).toUpperCase();
    const v = bit.slice(eq + 1).replace(/"/g, '');
    params[k] = params[k] ? `${params[k]},${v}` : v;
  });
  const encoding = (params.ENCODING || '').toUpperCase();
  if (encoding === 'QUOTED-PRINTABLE') value = decodeQuotedPrintable(value);
  return { name, params, value };
}

function normaliseDate(v) {
  const s = String(v).trim();
  let mt = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (mt) return `${mt[1]}-${mt[2]}-${mt[3]}`;
  // vCard 4 allows an omitted year for birthdays: --MM-DD
  mt = s.match(/^--(\d{2})-?(\d{2})$/);
  if (mt) return `1900-${mt[1]}-${mt[2]}`;
  return null;
}

function joinAddress(value) {
  // ADR is: po-box ; extended ; street ; locality ; region ; postcode ; country
  const p = value.split(';').map(unescapeValue);
  return [p[2], p[1], p[3], p[4], p[5], p[6]].filter(Boolean).join(', ') || null;
}

/* Returns an array of plain contact objects. Never throws on a malformed card:
 * a bad card is skipped and counted, because an address book export with one
 * odd entry should still import the other 300. */
export function parse(text) {
  const lines = unfold(text).split('\n');
  const cards = [];
  const skipped = [];
  let current = null;

  lines.forEach((raw) => {
    const line = raw.trim();
    if (!line) return;
    if (/^BEGIN:VCARD$/i.test(line)) {
      current = { phones: [], emails: [], _n: null };
      return;
    }
    if (/^END:VCARD$/i.test(line)) {
      if (!current) return;
      const card = finish(current);
      if (card) cards.push(card); else skipped.push('unnamed card');
      current = null;
      return;
    }
    if (!current) return;

    const p = parseLine(line);
    if (!p) return;
    const v = p.value;
    switch (p.name) {
      case 'FN': current.full_name = unescapeValue(v); break;
      case 'N': {
        const bits = v.split(';').map(unescapeValue);
        current._n = [bits[3], bits[1], bits[2], bits[0], bits[4]].filter(Boolean).join(' ').trim();
        break;
      }
      case 'NICKNAME': current.nickname = unescapeValue(v).split(',')[0]; break;
      case 'TEL': {
        const cleaned = unescapeValue(v).replace(/[^0-9+()\-\s]/g, '').trim();
        if (cleaned) current.phones.push(cleaned);
        break;
      }
      case 'EMAIL': {
        const cleaned = unescapeValue(v).trim();
        if (cleaned.includes('@')) current.emails.push(cleaned);
        break;
      }
      case 'ORG': current.company = unescapeValue(v).split(';')[0] || null; break;
      case 'TITLE': current.job_title = unescapeValue(v); break;
      case 'BDAY': current.birthday = normaliseDate(v); break;
      case 'ADR': if (!current.address) current.address = joinAddress(v); break;
      case 'NOTE': current.notes = unescapeValue(v).slice(0, 1000); break;
      default: break;   // PHOTO and X-* deliberately ignored
    }
  });

  return { cards, skipped: skipped.length };
}

function finish(c) {
  const name = (c.full_name || c._n || '').trim();
  if (!name) return null;
  return {
    full_name: name.slice(0, 120),
    nickname: c.nickname || null,
    company: c.company || null,
    job_title: c.job_title || null,
    birthday: c.birthday || null,
    address: c.address || null,
    notes: c.notes || null,
    phones: Array.from(new Set(c.phones)).slice(0, 8),
    emails: Array.from(new Set(c.emails)).slice(0, 8),
  };
}

/* ---------------- writing ---------------- */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let chunk = '';
  let len = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (len + n > limit) { out.push(chunk); chunk = ch; len = n; } else { chunk += ch; len += n; }
  }
  out.push(chunk);
  return out.join('\r\n ');
}

/* vCard 3.0 rather than 4.0: it is what iOS imports most reliably. */
export function toVCard(contact) {
  const names = String(contact.full_name || 'Unknown').trim().split(/\s+/);
  const last = names.length > 1 ? names.pop() : '';
  const first = names.join(' ');
  const lines = [
    'BEGIN:VCARD', 'VERSION:3.0',
    `N:${esc(last)};${esc(first)};;;`,
    `FN:${esc(contact.full_name || 'Unknown')}`,
  ];
  if (contact.nickname) lines.push(`NICKNAME:${esc(contact.nickname)}`);
  (contact.phones || []).forEach((p) => lines.push(`TEL;TYPE=CELL:${esc(p)}`));
  (contact.emails || []).forEach((e) => lines.push(`EMAIL;TYPE=INTERNET:${esc(e)}`));
  if (contact.company) lines.push(`ORG:${esc(contact.company)}`);
  if (contact.job_title) lines.push(`TITLE:${esc(contact.job_title)}`);
  if (contact.birthday) lines.push(`BDAY:${contact.birthday}`);
  if (contact.address) lines.push(`ADR;TYPE=HOME:;;${esc(contact.address)};;;;`);
  if (contact.notes) lines.push(`NOTE:${esc(contact.notes)}`);
  lines.push(`REV:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`);
  lines.push('END:VCARD');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export function toVCards(list) {
  return list.map(toVCard).join('');
}
