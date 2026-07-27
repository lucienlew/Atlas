/* Optional Claude layer.
 *
 * Atlas is fully usable without this: routes.js handles recording and querying
 * on-device with no network at all. This module only adds natural language.
 *
 * Requests go straight from the phone to api.anthropic.com — there is no server
 * in the middle, which is the whole point. That needs the direct browser access
 * header; if Anthropic changes its name, this is the one line to update.
 *
 * Efficiency carried over from the server version: prompt caching on the static
 * prefix, parallel tool calls, and compacted tool results.
 */
import * as tools from './tools.js';
import * as m from './model.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const BROWSER_HEADER = 'anthropic-dangerous-direct-browser-access';
export const MAX_STEPS = 6;
const HISTORY_LIMIT = 20;
const HISTORY_DROP = 8;

const SYSTEM = `You are Atlas, a private assistant for one owner, running entirely on their phone.
You act only through tools. Be concise: you are read on a small screen, so answer in a few short lines.

Rules:
- Never invent data. Call find_contacts before using a contact id.
- Request every tool you already have inputs for in ONE response; they run together.
  Only wait for a result when the next call truly depends on it.
- Dates and times must be full ISO values. Work them out from the current date
  below; never pass a phrase like "tomorrow 9am" to a tool.
- Restate the exact amount and person before recording money.
- Save durable facts with remember; check recall before asking the owner to repeat themselves.
- Mark reminders done with complete_reminder. Only delete_reminder if they want it gone.
- Recording money, deleting things and merging contacts will ask the owner to
  confirm before they run. Do not promise the action is done until it is.

Scanned documents: you get a preview of the text. Call read_document_text if it
was cut off. Then: receipt or invoice -> add_transaction, then update_document
linking transaction_id. Ticket or appointment -> create_event, then
update_document. Business card -> add_contact, then update_document. Anything
else -> update_document with a short summary. Always finish with update_document.`;

const STATIC_SYSTEM = { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } };
const CACHED_TOOLS = tools.SCHEMAS.map((s, i) => (i === tools.SCHEMAS.length - 1
  ? { ...s, cache_control: { type: 'ephemeral' } } : s));

function systemBlocks() {
  const day = m.todayISO();
  const weekday = new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' });
  return [STATIC_SYSTEM, {
    type: 'text',
    text: `Current date: ${weekday} ${day}. Current time: ${m.nowISO().slice(11, 16)}. Default currency: ${m.currency()}.`,
  }];
}

/* Shrink a tool result before it enters history: it is re-sent on every later
 * step of the turn. Nulls and empty containers tell the model nothing. */
function compact(value, depth = 0) {
  if (Array.isArray(value)) {
    const limit = depth ? 12 : 25;
    const out = value.slice(0, limit).map((v) => compact(v, depth + 1));
    if (value.length > limit) out.push(`…and ${value.length - limit} more`);
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    Object.entries(value).forEach(([k, v]) => {
      if (v === null || v === undefined || v === '' ) return;
      if (Array.isArray(v) && !v.length) return;
      if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) return;
      out[k] = compact(v, depth + 1);
    });
    return out;
  }
  if (typeof value === 'number') return Math.round(value * 100) / 100;
  return value;
}

function resultText(value) {
  const c = compact(value);
  return typeof c === 'string' ? c : JSON.stringify(c);
}

function cleanUserTurn(msg) {
  return msg.role === 'user' && typeof msg.content === 'string';
}

function withCacheBreakpoint(msgs) {
  if (!msgs.length) return msgs;
  const out = msgs.slice();
  const last = { ...out[out.length - 1] };
  let content = last.content;
  if (typeof content === 'string') content = [{ type: 'text', text: content }];
  else content = content.map((b) => ({ ...b }));
  content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: 'ephemeral' } };
  last.content = content;
  out[out.length - 1] = last;
  return out;
}

export class Conversation {
  constructor() {
    this.messages = [];
    this.pending = null;
    this.usage = { calls: 0, input: 0, output: 0, cache_read: 0 };
  }

  reset() {
    this.messages = [];
    this.pending = null;
  }

  get hasPending() { return this.pending !== null; }

  trim() {
    if (this.messages.length <= HISTORY_LIMIT) return;
    let msgs = this.messages.slice(-Math.max(this.messages.length - HISTORY_DROP, 2));
    while (msgs.length && !cleanUserTurn(msgs[0])) msgs.shift();
    this.messages = msgs;
  }

  addUser(text) {
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'user') {
      const block = { type: 'text', text };
      last.content = typeof last.content === 'string'
        ? [{ type: 'text', text: last.content }, block]
        : [...last.content, block];
    } else {
      this.messages.push({ role: 'user', content: text });
    }
  }

  rewind() {
    while (this.messages.length && !cleanUserTurn(this.messages[this.messages.length - 1])) this.messages.pop();
    if (this.messages.length) this.messages.pop();
  }

  async call(apiKey, model, maxTokens) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
        [BROWSER_HEADER]: 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemBlocks(),
        tools: CACHED_TOOLS,
        messages: withCacheBreakpoint(this.messages),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      let detail = body.slice(0, 300);
      try { detail = JSON.parse(body).error?.message || detail; } catch { /* keep raw */ }
      if (res.status === 401) throw new Error('Your API key was rejected. Check it in Settings.');
      if (res.status === 429) throw new Error('Rate limited. Wait a moment and try again.');
      if (res.status === 400 && /credit|balance/i.test(detail)) {
        throw new Error('Your API account is out of credit. Add credit in the Anthropic console.');
      }
      throw new Error(`API ${res.status}: ${detail}`);
    }
    const data = await res.json();
    if (data.usage) {
      this.usage.calls += 1;
      this.usage.input += data.usage.input_tokens || 0;
      this.usage.output += data.usage.output_tokens || 0;
      this.usage.cache_read += data.usage.cache_read_input_tokens || 0;
    }
    return data;
  }

  /* Returns {type:'text'|'confirm', ...}. */
  async send(text, cfg) {
    if (this.pending) await this.decline('Superseded by a new request.');
    this.addUser(text);
    this.trim();
    return this.loop(cfg);
  }

  async decline(reason) {
    const p = this.pending;
    this.pending = null;
    this.messages.push({ role: 'assistant', content: p.assistant });
    this.messages.push({
      role: 'user',
      content: p.calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: reason })),
    });
  }

  async resolve(approved, cfg) {
    const p = this.pending;
    if (!p) return { type: 'text', text: 'Nothing was waiting for approval.' };
    this.pending = null;
    this.messages.push({ role: 'assistant', content: p.assistant });
    const results = [];
    for (const c of p.calls) {
      const out = approved ? await tools.run(c.name, c.input) : 'Declined by the owner.';
      results.push({ type: 'tool_result', tool_use_id: c.id, content: resultText(out) });
    }
    this.messages.push({ role: 'user', content: results });
    this.trim();
    return this.loop(cfg);
  }

  async loop(cfg) {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      let data;
      try {
        data = await this.call(cfg.apiKey, cfg.model, cfg.maxTokens);
      } catch (e) {
        this.rewind();
        return { type: 'text', text: `${e.message} Nothing was changed.` };
      }
      const content = data.content || [];
      if (data.stop_reason !== 'tool_use') {
        this.messages.push({ role: 'assistant', content });
        const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        return { type: 'text', text: text || 'Done.', usage: { ...this.usage } };
      }
      const calls = content.filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      const sensitive = calls.filter((c) => tools.isSensitive(c.name));
      if (sensitive.length) {
        this.pending = { assistant: content, calls };
        return {
          type: 'confirm',
          text: 'This will change your records.',
          summary: sensitive.map((c) => tools.describe(c.name, c.input)),
        };
      }
      this.messages.push({ role: 'assistant', content });
      const results = [];
      for (const c of calls) {
        results.push({ type: 'tool_result', tool_use_id: c.id, content: resultText(await tools.run(c.name, c.input)) });
      }
      this.messages.push({ role: 'user', content: results });
    }
    return { type: 'text', text: `I stopped after ${MAX_STEPS} tool steps to avoid looping. Try asking more specifically.` };
  }
}

/* Vision OCR: send a photo straight to Claude. There is no on-device OCR here
 * on purpose — Tesseract.js would mean loading a WASM bundle from a CDN, and a
 * strict same-origin content policy is worth more than saving this one call. */
export async function readImage(apiKey, model, base64, mediaType) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      [BROWSER_HEADER]: 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: 'Transcribe every piece of text in this image exactly, keeping line breaks and all numbers, dates and totals verbatim. Output only the transcription.' },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`Could not read that image (API ${res.status}).`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}
