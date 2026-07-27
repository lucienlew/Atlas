/* .ics generation. Ported from the Python version, including the parts that
 * were hard-won: iOS Calendar silently refuses a file if a value contains an
 * unescaped comma, semicolon, backslash or newline, or if a content line runs
 * past 75 octets unfolded. Date-only events must be VALUE=DATE with an
 * exclusive DTEND, or they arrive as midnight appointments.
 *
 * A VALARM is included when asked: iOS cannot expose the Clock app to a web
 * page, but a calendar alert with a lead time is the closest honest substitute
 * and it does wake the phone.
 */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let chunk = '';
  let chunkLen = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (chunkLen + n > limit) { out.push(chunk); chunk = ch; chunkLen = n; } else { chunk += ch; chunkLen += n; }
  }
  out.push(chunk);
  return out.join('\r\n ');
}

function stampUTC() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function compactLocal(iso) {
  return `${iso.slice(0, 10).replace(/-/g, '')}T${iso.slice(11, 16).replace(':', '')}00`;
}

const pad = (n) => String(n).padStart(2, '0');

/* Format a Date back to a LOCAL floating ISO string.
 *
 * This exists because toISOString() converts to UTC, and the times in a .ics
 * here are deliberately local floating times. Using toISOString() to do local
 * arithmetic shifts every value by the device's offset — invisible in a UTC
 * environment, an hour or a whole day wrong everywhere else. */
function localISO(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function addHoursLocal(iso, hours) {
  const d = new Date(`${iso.slice(0, 16)}:00`);   // parsed as local
  d.setHours(d.getHours() + hours);
  return localISO(d);
}

/* Calendar-day arithmetic, anchored in UTC so it cannot be nudged across a
 * date boundary by the device offset. Dates here are plain calendar dates with
 * no time, so UTC is simply the safe frame to count in. */
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function eventToICS(ev, { alarmMinutes = null } = {}) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Atlas//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:atlas-${ev.id || 'x'}-${Date.now()}@atlas.local`,
    `DTSTAMP:${stampUTC()}`,
  ];
  if (ev.all_day) {
    const start = ev.start_at.slice(0, 10);
    const last = (ev.end_at || start).slice(0, 10);
    lines.push(`DTSTART;VALUE=DATE:${start.replace(/-/g, '')}`);
    lines.push(`DTEND;VALUE=DATE:${addDays(last, 1).replace(/-/g, '')}`);
  } else {
    const start = compactLocal(ev.start_at);
    let end = ev.end_at ? compactLocal(ev.end_at) : null;
    if (!end || end <= start) end = compactLocal(addHoursLocal(ev.start_at, 1));
    lines.push(`DTSTART:${start}`, `DTEND:${end}`);
  }
  lines.push(`SUMMARY:${esc(ev.title || 'Event')}`);
  if (ev.location) lines.push(`LOCATION:${esc(ev.location)}`);
  if (ev.notes) lines.push(`DESCRIPTION:${esc(ev.notes)}`);
  if (alarmMinutes != null) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY',
      `TRIGGER:-PT${Math.max(0, Math.round(alarmMinutes))}M`,
      `DESCRIPTION:${esc(ev.title || 'Event')}`, 'END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export function remindersToICS(list) {
  const parts = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Atlas//EN', 'CALSCALE:GREGORIAN'];
  list.filter((r) => r.due_at).forEach((r) => {
    parts.push('BEGIN:VTODO', `UID:atlas-todo-${r.id}@atlas.local`, `DTSTAMP:${stampUTC()}`,
      `DUE:${compactLocal(r.due_at)}`, `SUMMARY:${esc(r.text)}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:PT0M', `DESCRIPTION:${esc(r.text)}`, 'END:VALARM',
      'END:VTODO');
  });
  parts.push('END:VCALENDAR');
  return `${parts.map(fold).join('\r\n')}\r\n`;
}
