// Minimal OpenRouter streaming client (OpenAI-compatible chat completions).

const BASE = 'https://openrouter.ai/api/v1';
const HEADERS = { 'HTTP-Referer': 'https://github.com/tuffagent', 'X-Title': 'TuffAgent' };

export async function checkKey(apiKey) {
  const r = await fetch(`${BASE}/key`, { headers: { Authorization: `Bearer ${apiKey}`, ...HEADERS } });
  if (!r.ok) throw new Error(r.status === 401 ? 'That key was rejected by OpenRouter.' : `OpenRouter returned ${r.status}`);
  return (await r.json()).data;
}

export async function listModels() {
  const r = await fetch(`${BASE}/models`);
  if (!r.ok) throw new Error(`Could not load models (${r.status})`);
  const { data } = await r.json();
  return data
    .filter((m) => !m.id.endsWith(':batch') && (m.supported_parameters || []).includes('tools'))
    .map((m) => ({
      id: m.id,
      name: m.name.replace(/^[^:]+:\s*/, ''),
      provider: m.id.split('/')[0].replace(/^~/, ''),
      ctx: m.context_length,
      vision: (m.architecture?.input_modalities || []).includes('image'),
      reasoning: (m.supported_parameters || []).includes('reasoning'),
      pin: +m.pricing?.prompt || 0,
      pout: +m.pricing?.completion || 0,
      created: m.created || 0,
    }));
}

// Merge streamed reasoning_details fragments by index so they can be sent
// back verbatim (Gemini/Anthropic need signatures preserved across turns).
function mergeDetails(acc, items) {
  for (const it of items) {
    const i = it.index ?? acc.length;
    const cur = acc[i];
    if (!cur) { acc[i] = { ...it }; continue; }
    for (const [k, v] of Object.entries(it)) {
      if (k === 'index') continue;
      if (typeof v === 'string' && (k === 'text' || k === 'summary' || k === 'data') && typeof cur[k] === 'string') cur[k] += v;
      else if (v != null) cur[k] = v;
    }
  }
}

/**
 * Streams one completion. Calls handlers as data arrives and resolves with the
 * assembled assistant message plus usage. onToolReady(i, call) fires once a
 * tool call's arguments are complete (they parse, or the next call began), so it can run
 * while the rest of the response streams. A mid-stream error carries the
 * partial message as err.partial.
 */
export async function complete({ apiKey, body, signal, onText, onReasoning, onToolStart, onToolReady }) {
  const started = performance.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...HEADERS },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!res.ok) {
    const t = await res.text();
    let msg = t;
    try { const j = JSON.parse(t); msg = j.error?.metadata?.raw || j.error?.message || t; } catch {}
    throw new Error(`${res.status} · ${String(msg).slice(0, 400)}`);
  }

  const msg = { role: 'assistant', content: '', tool_calls: [] };
  const details = [];
  let reasoning = '';
  let usage = null, finish = null, ttft = 0, provider = null, genId = null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', ready = 0;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.error) throw new Error(j.error.message || 'Provider error');
        if (j.usage) usage = j.usage;
        if (j.provider) provider = j.provider;
        if (j.id) genId = j.id;
        const ch = j.choices?.[0];
        if (!ch) continue;
        if (ch.finish_reason) finish = ch.finish_reason;
        const d = ch.delta || {};
        if (!ttft && (d.content || d.reasoning || d.tool_calls)) ttft = performance.now() - started;
        if (d.reasoning) { reasoning += d.reasoning; onReasoning?.(reasoning); }
        if (d.reasoning_details?.length) mergeDetails(details, d.reasoning_details);
        if (d.content) { msg.content += d.content; onText?.(msg.content); }
        for (const tc of d.tool_calls || []) {
          const i = tc.index ?? msg.tool_calls.length;
          let cur = msg.tool_calls[i];
          if (!cur) {
            cur = msg.tool_calls[i] = { id: tc.id || `call_${Date.now()}_${i}`, type: 'function', function: { name: '', arguments: '' } };
            for (; ready < i; ready++) if (msg.tool_calls[ready]) onToolReady?.(ready, msg.tool_calls[ready]);
          }
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) { const fresh = !cur.function.name; cur.function.name += tc.function.name; if (fresh) onToolStart?.(i, cur.function.name); }
          if (tc.function?.arguments) {
            cur.function.arguments += tc.function.arguments;
            // A complete JSON object can't grow, so the call is ready now.
            if (i === ready && cur.function.arguments.trimEnd().endsWith('}')) {
              try { JSON.parse(cur.function.arguments); onToolReady?.(ready, cur); ready++; } catch {}
            }
          }
        }
      }
    }
  } catch (e) {
    msg.tool_calls = msg.tool_calls.filter(Boolean);
    e.partial = msg;
    throw e;
  }

  msg.tool_calls = msg.tool_calls.filter(Boolean);
  if (!msg.tool_calls.length) delete msg.tool_calls;
  if (details.length) msg.reasoning_details = details.filter(Boolean);
  return { msg, reasoning, usage, finish, ttft, provider, genId, ms: performance.now() - started };
}
