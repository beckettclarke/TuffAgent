import { agent, exec, preLabel, toolsFor, overlayOff, detachAll, currentTabInfo, TOOLS } from './tools.js';
import { complete, checkKey, listModels } from './llm.js';
import { md } from './md.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const DEFAULTS = {
  apiKey: '', model: 'anthropic/claude-haiku-5.5', reasoning: 'auto', fast: true, overlay: true,
  trusted: true, maxSteps: 40, unlimited: false, instructions: '', recent: [], v: 2,
};
const FEATURED = ['anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'openai/gpt-5.6-luna',
  'openai/gpt-5.6-terra', 'google/gemini-3.8-flash', 'x-ai/grok-4.7', 'moonshotai/kimi-k3', 'qwen/qwen3.8-flash'];
const PROVIDER_HUE = { anthropic: '#d97757', openai: '#10a37f', google: '#4285f4', 'x-ai': '#8b8b93', qwen: '#7c5cff', moonshotai: '#1f6feb',
  'meta-llama': '#0866ff', mistralai: '#fa520f', deepseek: '#4d6bfe', 'z-ai': '#3b82f6', minimax: '#e8475f', cohere: '#39594d' };

let S = { ...DEFAULTS };
let messages = [];
let models = [];
let running = false;
let ctrl = null;
let runEnded = Promise.resolve();
// Cache breakpoint on the newest (tool) message; switched off if a provider rejects it.
let cacheTail = true;
const MAC = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform);
// Current chat: messages above, plus a debug log of every run.
let chatId = null;
let chatCreated = 0;
let chatLog = [];

const save = () => chrome.storage.local.set({ settings: S });
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const firstUser = (msgs) => msgs.find((m) => m.role === 'user' && !m._img);
const chatTitle = (msgs) => { const u = firstUser(msgs); return String(u?._display ?? u?.content ?? 'New chat').replace(/\s+/g, ' ').slice(0, 90); };

async function saveThread() {
  if (!messages.length) return;
  chatId ||= newId();
  chatCreated ||= Date.now();
  const slim = messages.map((m) => (m._img ? { ...m, content: '[screenshot]' } : m));
  const meta = {
    id: chatId, title: chatTitle(messages), created: chatCreated, updated: Date.now(), model: S.model,
    steps: messages.filter((m) => m.role === 'tool').length,
  };
  const { chats = [] } = await chrome.storage.local.get('chats');
  await chrome.storage.local.set({
    chats: [meta, ...chats.filter((c) => c.id !== chatId)],
    ['chat:' + chatId]: { ...meta, messages: slim, log: chatLog },
    currentChat: chatId,
  }).catch(() => {});
}

// A run cut short (panel closed mid-tool) leaves calls without results.
function repair(msgs) {
  const answered = new Set(msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  for (let i = msgs.length - 1; i >= 0; i--) {
    for (const tc of msgs[i].tool_calls || []) {
      if (!answered.has(tc.id)) msgs.splice(i + 1, 0, { role: 'tool', tool_call_id: tc.id, content: 'Interrupted.', _label: 'Interrupted', _ok: false });
    }
  }
  return msgs;
}

function loadChat(c) {
  chatId = c?.id || null;
  chatCreated = c?.created || 0;
  chatLog = c?.log || [];
  messages = repair(Array.isArray(c?.messages) ? c.messages : []);
}

const log = (type, data) => chatLog.push({ t: Date.now(), type, ...data });
const modelInfo = (id = S.model) => models.find((m) => m.id === id);

// ── Icons for tool steps ──
const IC = {
  tab: '<rect x="2.5" y="3.5" width="11" height="9" rx="2"/><path d="M2.5 6.5h11"/>',
  nav: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.7 5.9 5.7 8s.7 3.9 2.3 5.5"/>',
  read: '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7"/>',
  find: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/>',
  click: '<path d="M5 2.5 12.5 8l-3.4.8 1.9 3.6-1.6.8-1.9-3.6L5 12z"/>',
  type: '<rect x="2" y="4.5" width="12" height="7" rx="1.6"/><path d="M4.5 7h.01M7 7h.01M9.5 7h.01M11.5 7h.01M5 9.3h6"/>',
  key: '<path d="M12.5 4v4.5a1.5 1.5 0 0 1-1.5 1.5H4M6 8 4 10l2 2"/>',
  scroll: '<rect x="4.5" y="2" width="7" height="12" rx="3.5"/><path d="M8 4.5v2.5"/>',
  hover: '<path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3"/><circle cx="8" cy="8" r="1.3"/>',
  shot: '<rect x="2" y="4" width="12" height="9" rx="2"/><circle cx="8" cy="8.5" r="2.3"/><path d="M5.5 4l1-1.5h3l1 1.5"/>',
  code: '<path d="m5.5 4.5-3 3.5 3 3.5M10.5 4.5l3 3.5-3 3.5"/>',
  book: '<path d="M4.5 2.5h7a1 1 0 0 1 1 1v10l-4.5-3-4.5 3v-10a1 1 0 0 1 1-1z"/>',
  hist: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',
  wait: '<path d="M4.5 2.5h7M4.5 13.5h7M5 2.5c0 3 6 3.5 6 5.5s-6 2.5-6 5.5M11 2.5c0 1-1 1.8-3 3"/>',
  sel: '<rect x="2.5" y="4" width="11" height="8" rx="2"/><path d="m6 7.3 2 2 2-2"/>',
  group: '<rect x="2" y="3" width="5" height="5" rx="1.2"/><rect x="9" y="3" width="5" height="5" rx="1.2"/><rect x="2" y="10" width="12" height="3.5" rx="1.2"/>',
  drag: '<path d="M3 3h3M3 3v3M13 13h-3M13 13v-3M3 3l10 10"/>',
};
const TOOL_ICON = {
  tabs_list: 'tab', tab_open: 'tab', tab_switch: 'tab', tab_close: 'tab', tab_group: 'group', navigate: 'nav', read_page: 'read',
  get_text: 'read', find: 'find', click: 'click', drag: 'drag', type: 'type', key: 'key', scroll: 'scroll', hover: 'hover', select_option: 'sel',
  screenshot: 'shot', run_js: 'code', bookmarks: 'book', history_search: 'hist', wait: 'wait',
};
const icon = (name) => `<svg viewBox="0 0 16 16">${IC[TOOL_ICON[name]] || IC.code}</svg>`;
const CHECK = '<svg class="check" viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7"/></svg>';
const XMARK = '<svg class="xmark" viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg>';

// ── Scroll management: follow output unless the user scrolled up ──
const scroller = $('#scroll');
let stick = true;
scroller.addEventListener('scroll', () => {
  stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  $('#jump').classList.toggle('show', !stick);
}, { passive: true });
let scrollQueued = false;
function follow(force) {
  if (force) stick = true;
  if (!stick || scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => { scrollQueued = false; scroller.scrollTop = scroller.scrollHeight; });
}
$('#jump').onclick = () => { scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' }); };

// ── Rendering ──
const thread = $('#thread');
const setEmpty = () => { $('#empty').hidden = thread.children.length > 0; };

function userBubble(text) {
  const w = el('div', 'msg-user');
  w.appendChild(el('div', 'bubble')).textContent = text;
  thread.appendChild(w);
  setEmpty();
}

function fmtMs(ms) { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`; }

class Turn {
  constructor() {
    this.root = thread.appendChild(el('div', 'turn'));
    this.steps = null;
    setEmpty();
  }
  stepsGroup() {
    if (!this.steps || this.root.lastElementChild !== this.steps) this.steps = this.root.appendChild(el('div', 'steps'));
    return this.steps;
  }
  waiting(label = 'Thinking') {
    this.clearWait();
    this.wait = this.root.appendChild(el('div', 'wait', `<span class="orb"></span><span class="shimmer">${label}</span>`));
    follow();
  }
  clearWait() { this.wait?.remove(); this.wait = null; }

  // One LLM response: thinking, streaming text, then tool steps.
  response() {
    const t = this;
    let thinkEl, textEl, rafT = 0, pendingText = '', thinkStart = 0;
    const pending = new Map();
    return {
      reasoning(r) {
        t.clearWait();
        if (!thinkEl) {
          thinkStart = performance.now();
          thinkEl = t.root.appendChild(el('details', 'think', `<summary><svg viewBox="0 0 12 12"><path d="m4.5 3 3 3-3 3"/></svg><span class="shimmer">Thinking</span></summary><div class="tbody"></div>`));
        }
        const b = thinkEl.querySelector('.tbody');
        b.textContent = r;
        b.scrollTop = b.scrollHeight;
        follow();
      },
      text(s) {
        t.clearWait();
        this.endThinking();
        if (!textEl) textEl = t.root.appendChild(el('div', 'md streaming'));
        pendingText = s;
        if (!rafT) rafT = requestAnimationFrame(() => { rafT = 0; textEl.innerHTML = md(pendingText); follow(); });
      },
      endThinking() {
        if (thinkEl && !thinkEl.dataset.done) {
          thinkEl.dataset.done = 1;
          const s = thinkEl.querySelector('summary span');
          s.className = '';
          s.textContent = `Thought for ${fmtMs(performance.now() - thinkStart)}`;
        }
      },
      toolStart(i, name) {
        t.clearWait();
        this.endThinking();
        pending.set(i, t.step(name, preLabel(name)));
      },
      stepAt(i, name) {
        if (!pending.has(i)) pending.set(i, t.step(name, preLabel(name)));
        return pending.get(i);
      },
      finish(msg) {
        t.clearWait();
        this.endThinking();
        if (rafT) cancelAnimationFrame(rafT), rafT = 0;
        if (textEl) { textEl.classList.remove('streaming'); textEl.innerHTML = md(msg.content || ''); }
        if (!msg.content && textEl) textEl.remove();
        return (msg.tool_calls || []).map((tc, i) => this.stepAt(i, tc.function.name));
      },
    };
  }

  step(name, label) {
    const s = el('div', 'step running');
    s.innerHTML = `<button class="step-head"><span class="sicon">${icon(name)}</span><span class="slabel"></span><span class="stime"></span><span class="sstate"><i class="ring"></i></span></button><div class="step-body"><div></div></div>`;
    s.querySelector('.slabel').textContent = label;
    s.querySelector('.step-head').onclick = () => s.classList.toggle('open');
    this.stepsGroup().appendChild(s);
    follow();
    const api = {
      el: s,
      label(l) { s.querySelector('.slabel').textContent = l; },
      done(ok, { label, args, result, ms, image }) {
        s.classList.remove('running');
        s.classList.add(ok ? 'ok' : 'fail');
        if (label) api.label(label);
        s.querySelector('.slabel').title = label || '';
        s.querySelector('.sstate').innerHTML = ok ? CHECK : XMARK;
        if (ms != null) s.querySelector('.stime').textContent = fmtMs(ms);
        const body = s.querySelector('.step-body > div');
        const argStr = args && Object.keys(args).length ? JSON.stringify(args, null, 1) : '';
        body.innerHTML = (argStr ? `<span class="k">Input</span><pre>${esc(argStr)}</pre>` : '') +
          (result ? `<span class="k">${ok ? 'Result' : 'Error'}</span><pre>${esc(result.length > 6000 ? result.slice(0, 6000) + '\n…' : result)}</pre>` : '');
        if (image) {
          const th = el('div', 'step-thumb');
          const img = th.appendChild(el('img'));
          img.src = image;
          img.onclick = () => s.classList.toggle('open');
          s.appendChild(th);
        }
        follow();
      },
    };
    return api;
  }

  meta({ steps, ms, cost, tokens }) {
    const parts = [];
    if (steps) parts.push(`${steps} step${steps === 1 ? '' : 's'}`);
    parts.push(fmtMs(ms));
    if (tokens) parts.push(`${tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : tokens} tok`);
    if (cost) parts.push(`$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`);
    this.root.appendChild(el('div', 'meta', parts.map((p) => `<span>${p}</span>`).join('')));
    follow();
  }
  notice(text) { this.root.appendChild(el('div', 'notice', esc(text))); follow(); }
  error(text, retry) {
    const c = el('div', 'err-card', `<div class="et"><b>Something went wrong</b>${esc(text)}</div>`);
    if (retry) {
      const b = el('button', 'btn ghost sm', 'Retry');
      b.onclick = () => { c.remove(); retry(); };
      c.appendChild(b);
    }
    this.root.appendChild(c);
    follow();
  }
}

// Rebuild the transcript from saved messages.
function replay() {
  thread.innerHTML = '';
  const results = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m]));
  let turn = null;
  for (const m of messages) {
    if (m.role === 'user' && !m._img) { userBubble(m._display ?? m.content); turn = null; continue; }
    if (m.role !== 'assistant') continue;
    turn ||= new Turn();
    turn.root.style.animation = 'none';
    if (m.content) turn.root.appendChild(el('div', 'md', md(m.content)));
    for (const tc of m.tool_calls || []) {
      const r = results.get(tc.id);
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
      const st = turn.step(tc.function.name, r?._label || preLabel(tc.function.name, args));
      st.el.style.animation = 'none';
      st.done(r?._ok !== false, { label: r?._label, args, result: r?.content, ms: r?._ms });
    }
    if (m._meta) turn.meta(m._meta);
  }
  setEmpty();
  follow(true);
}

// ── Prompt + request assembly ──
function systemPrompt() {
  // Date only: the system prompt opens every request, so it must stay byte-stable for prompt caching.
  return `You are TuffAgent, a fast browser agent living in the user's Chrome side panel. You control the browser through tools.
Date: ${new Date().toDateString()}. Platform: ${MAC ? 'macOS — shortcuts use Meta (⌘), e.g. Meta+a, Meta+z, Meta+Shift+h' : 'Windows/Linux — shortcuts use Control'}.

How to work:
- Act, don't narrate. Do the task with tools; only ask when genuinely blocked or before risky actions.
- Speed matters. When the next steps are predictable, emit several tool calls in one response (e.g. type into each field, then click submit) — they run in order.
- Element refs (e.g. e12) come from read_page/find. Prefer refs over selectors or coordinates. Refs go stale after navigation.
- navigate and tab_open already return a snapshot of the new page, and actions that trigger navigation return one too — don't call read_page right after them.
- click/type/key/hover results list what newly appeared on screen ("New on screen": menus, submenus, dialogs, suggestions) with refs. Use those refs directly in your next calls — no read_page or find needed. Chain through menus in one response when you know the item names.
- Use get_text to read or summarize content, read_page to act, find to locate one thing on a big page, run_js for bulk extraction or anything tools can't do.${modelInfo()?.vision === false ? '' : `
- Use screenshot when visual layout matters, the snapshot is confusing, or content is drawn on a canvas (Google Docs/Sheets text). Screenshots tag clickable elements with their refs — click those by ref, never by guessed coordinates. Use x/y only for canvas content, reading positions off the 100px edge rulers. To see the result of actions, end that same response with a screenshot call instead of spending a separate round.`}
- Text goes in with one type call, never key-by-key. In rich editors (Google Docs etc.), click where the text goes, then type without ref (types at the caret); use key Enter for new paragraphs.
- key takes repeats ("Shift+ArrowRight*12"). Select ranges with drag, a triple click (clicks: 3), or click then click again with modifiers: "shift".
- The current tab is given in <context>. tab_open (active) and tab_switch change it; other page tools accept tab_id.
- If something fails, adapt (re-read the page, try another element, scroll) instead of repeating the same call.
- Before irreversible or sensitive actions — purchases, sending messages or emails, posting publicly, deleting data, entering payment info or passwords — stop and ask the user to confirm, unless they explicitly asked for exactly that.
- Finish with a short answer or summary in markdown. No preamble.${S.instructions.trim() ? `\n\nUser's custom instructions:\n${S.instructions.trim()}` : ''}`;
}

// Tool results are trimmed by age. The cut-off points move in steps of 10
// results, so earlier messages stay byte-identical between rounds and provider
// prompt caches keep hitting.
function buildMessages() {
  const isAnthropic = S.model.includes('anthropic/');
  const lastUser = messages.findLastIndex((m) => m.role === 'user' && !m._img);
  const lastImg = messages.findLastIndex((m) => m._img);
  const toolOrd = new Map();
  messages.forEach((m, i) => { if (m.role === 'tool') toolOrd.set(i, toolOrd.size); });
  const fullFrom = Math.max(0, Math.floor((toolOrd.size - 6) / 10) * 10);
  const briefFrom = Math.max(0, Math.floor((toolOrd.size - 40) / 20) * 20);
  const out = messages.map((m, i) => {
    const c = {};
    for (const k in m) if (k[0] !== '_') c[k] = m[k];
    if (m.role === 'tool' && typeof c.content === 'string') {
      const n = toolOrd.get(i);
      const cap = i < lastUser || n < briefFrom ? 300 : n < fullFrom ? 1200 : Infinity;
      if (c.content.length > cap) c.content = c.content.slice(0, cap) + '\n…[trimmed]';
    }
    if (m._img && i !== lastImg) c.content = '[earlier screenshot omitted]';
    return c;
  });
  if (isAnthropic) {
    // Breakpoints: the system prompt, the user's turn, and the newest message, so
    // each round reads everything before it from cache.
    const mark = (i) => {
      const c = out[i];
      if (!c || c.role === 'assistant') return;
      if (typeof c.content === 'string') c.content = [{ type: 'text', text: c.content, cache_control: { type: 'ephemeral' } }];
      else if (Array.isArray(c.content) && c.content.length) c.content[c.content.length - 1] = { ...c.content[c.content.length - 1], cache_control: { type: 'ephemeral' } };
    };
    mark(lastUser);
    if (cacheTail && out.length - 1 !== lastUser) mark(out.length - 1);
  }
  const sys = isAnthropic
    ? { role: 'system', content: [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }] }
    : { role: 'system', content: systemPrompt() };
  return [sys, ...out];
}

function requestBody() {
  const info = modelInfo();
  const body = {
    model: S.model,
    messages: buildMessages(),
    tools: toolsFor(info ? info.vision : true),
    tool_choice: 'auto',
    parallel_tool_calls: true,
    max_tokens: 8192,
    usage: { include: true },
  };
  if (S.fast) body.provider = { sort: 'throughput' };
  if (S.reasoning !== 'auto') body.reasoning = { effort: S.reasoning };
  return body;
}

async function contextLine() {
  const t = await currentTabInfo();
  if (!t) return '';
  const count = (await chrome.tabs.query({ windowId: agent.windowId })).length;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `\n\n<context>Time: ${time}. Current tab [${t.id}]: ${t.title || ''} — ${t.url || ''}\n${count} tab${count === 1 ? '' : 's'} open in this window.</context>`;
}

// ── Agent loop ──
async function send(text) {
  text = text.trim();
  if (!text || running) return;
  userBubble(text);
  follow(true);
  messages.push({ role: 'user', content: text + (await contextLine()), _display: text });
  saveThread();
  run();
}

async function run() {
  let ended;
  runEnded = new Promise((r) => (ended = r));
  running = true;
  document.body.classList.add('running');
  updateSend();
  const turn = new Turn();
  ctrl = new AbortController();
  const signal = ctrl.signal;
  agent.trusted = S.trusted;
  agent.overlay = S.overlay;
  const t0 = performance.now();
  let steps = 0, cost = 0, tokens = 0, lastAssistant = null, hitLimit = true, stopped = false;
  const limit = S.unlimited ? Infinity : S.maxSteps;
  log('run', {
    prompt: messages.findLast((m) => m.role === 'user' && !m._img)?._display, model: S.model,
    settings: { reasoning: S.reasoning, fast: S.fast, trusted: S.trusted, overlay: S.overlay, maxSteps: S.unlimited ? 'unlimited' : S.maxSteps },
  });

  try {
    for (let i = 0; i < limit; i++) {
      turn.waiting(i === 0 ? 'Thinking' : 'Working');
      const view = turn.response();
      // Each tool call starts as soon as its arguments finish streaming, so the
      // browser works while the model is still writing the next call. Calls run
      // strictly in order.
      const calls = [], results = [], images = [];
      let chain = Promise.resolve(), started = 0;
      const parses = (tc) => { try { JSON.parse(tc.function.arguments?.trim() || '{}'); return true; } catch { return false; } };
      const pump = (final) => {
        while (started < calls.length && calls[started] && (final || parses(calls[started]))) {
          const k = started++;
          chain = chain.then(() => runTool(k, calls[k]));
        }
      };
      const runTool = async (k, tc) => {
        const name = tc.function.name;
        const sv = view.stepAt(k, name);
        if (signal.aborted) {
          results[k] = { role: 'tool', tool_call_id: tc.id, content: 'Cancelled: the user stopped the agent.', _label: 'Cancelled', _ok: false };
          sv.done(false, { label: 'Cancelled' });
          return;
        }
        let args = null;
        try { args = tc.function.arguments?.trim() ? JSON.parse(tc.function.arguments) : {}; } catch {}
        sv.label(preLabel(name, args || {}));
        const s0 = performance.now();
        let content, label, ok = true, image;
        try {
          if (!args) throw new Error(`Invalid JSON arguments: ${tc.function.arguments?.slice(0, 200)}`);
          const r = await exec(name, args);
          content = r.text; label = r.label; image = r.image;
        } catch (e) {
          ok = false;
          content = `Error: ${e.message}`;
          label = `${preLabel(name, args || {})} — failed`;
        }
        const ms = performance.now() - s0;
        sv.done(ok, { label, args, result: content, ms, image });
        const tab = agent.tabId != null ? await chrome.tabs.get(agent.tabId).catch(() => null) : null;
        log('tool', {
          name, args: args ?? tc.function.arguments, ok, ms: Math.round(ms), label, url: tab?.url,
          result: content.length > 4000 ? content.slice(0, 4000) + `…[${content.length} chars]` : content,
        });
        if (image) images.push(image);
        results[k] = { role: 'tool', tool_call_id: tc.id, content, _label: label, _ok: ok, _ms: Math.round(ms) };
        steps++;
      };

      let res;
      try {
        res = await complete({
          apiKey: S.apiKey, body: requestBody(), signal,
          onText: (s) => view.text(s), onReasoning: (r) => view.reasoning(r), onToolStart: (idx, name) => view.toolStart(idx, name),
          onToolReady: (idx, tc) => { calls[idx] = tc; pump(false); },
        });
      } catch (e) {
        if (started) {
          // Some actions already ran: keep history consistent with what happened.
          await chain;
          const partial = e.partial || { role: 'assistant', content: '' };
          partial.tool_calls = calls.slice(0, started);
          messages.push(partial, ...results.slice(0, started));
        } else if (cacheTail && /^400\b/.test(e.message) && /cache/i.test(e.message) && S.model.includes('anthropic/')) {
          cacheTail = false;
          i--;
          continue;
        }
        throw e;
      }
      const { msg, usage, finish, ttft, ms: llmMs, provider, genId } = res;
      if (usage) { cost += usage.cost || 0; tokens += usage.total_tokens || 0; }
      log('llm', {
        round: i, model: S.model, provider, id: genId, finish, ms: Math.round(llmMs), ttft: Math.round(ttft), usage,
        text: msg.content || '', toolCalls: (msg.tool_calls || []).map((tc) => tc.function.name),
      });
      view.finish(msg);
      lastAssistant = msg;
      (msg.tool_calls || []).forEach((tc, k) => { calls[k] = tc; });
      calls.length = msg.tool_calls?.length || 0;
      pump(true);
      await chain;
      messages.push(msg, ...results);
      if (!msg.tool_calls?.length) { hitLimit = false; break; }
      if (images.length) {
        messages.push({
          role: 'user', _img: true,
          content: [{ type: 'text', text: 'Screenshot from the screenshot tool:' }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))],
        });
      }
      refreshTab();
      if (signal.aborted) { hitLimit = false; stopped = true; turn.notice('Stopped.'); break; }
    }
    if (hitLimit) turn.notice(`Paused after ${S.maxSteps} rounds. Say “continue” to keep going, or turn off the step limit in settings.`);
  } catch (e) {
    turn.clearWait();
    hitLimit = false;
    if (e.name === 'AbortError' || signal.aborted) { stopped = true; turn.notice('Stopped.'); }
    else { log('error', { message: e.message, stack: e.stack }); turn.error(e.message, () => run()); }
  } finally {
    log('end', { steps, ms: Math.round(performance.now() - t0), cost, tokens, stopped, hitLimit });
    running = false;
    ctrl = null;
    document.body.classList.remove('running');
    updateSend();
    const meta = { steps, ms: performance.now() - t0, cost, tokens };
    turn.meta(meta);
    if (lastAssistant) lastAssistant._meta = meta;
    await saveThread();
    overlayOff();
    detachAll();
    ended();
  }
}

function stop() { ctrl?.abort(); }
// Abort and let the run finish writing to its own chat before switching.
async function halt() { if (running) { stop(); await runEnded; } }

// ── Composer ──
const input = $('#input');
const sendBtn = $('#sendBtn');
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; }
function updateSend() { sendBtn.disabled = !running && !input.value.trim(); sendBtn.title = running ? 'Stop (Esc)' : 'Send (⏎)'; }
input.addEventListener('input', () => { autosize(); updateSend(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!running) submit();
  }
});
function submit() {
  const v = input.value;
  if (!v.trim()) return;
  input.value = '';
  autosize(); updateSend();
  send(v);
}
sendBtn.onclick = () => (running ? stop() : submit());
document.querySelectorAll('.sugg').forEach((b) => { b.onclick = () => send(b.dataset.prompt); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (document.querySelector('.sheet.show')) closeSheets();
    else if (running) stop();
  }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(); }
});

async function newChat() {
  await halt();
  loadChat(null);
  chrome.storage.local.set({ currentChat: null });
  thread.innerHTML = '';
  const em = $('#empty');
  em.hidden = false;
  em.style.animation = 'none'; void em.offsetWidth; em.style.animation = '';
  em.querySelectorAll('.sugg').forEach((s) => { s.style.animation = 'none'; void s.offsetWidth; s.style.animation = ''; });
  input.focus();
}
$('#newBtn').onclick = newChat;

// ── Current tab chip ──
async function refreshTab() {
  const t = await currentTabInfo();
  const chip = $('#tabChip');
  const title = t ? t.title || t.url || 'Untitled' : 'No tab';
  const span = $('#tabTitle');
  if (span.textContent !== title) {
    span.textContent = title;
    chip.classList.remove('flash'); void chip.offsetWidth; chip.classList.add('flash');
  }
  const img = $('#tabIcon');
  const src = t?.favIconUrl && !t.favIconUrl.startsWith('chrome://') ? t.favIconUrl : '';
  if (src) img.src = src; else img.removeAttribute('src');
  chip.title = t?.url || '';
}
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (windowId !== agent.windowId) return;
  if (!running) agent.tabId = tabId;
  refreshTab();
});
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === agent.tabId && (info.title || info.favIconUrl || info.url)) refreshTab();
});

// ── Sheets ──
const scrim = $('#scrim');
function openSheet(id) {
  closeSheets(true);
  scrim.classList.add('show');
  const s = $(id);
  s.classList.add('show');
  s.setAttribute('aria-hidden', 'false');
}
function closeSheets(silent) {
  document.querySelectorAll('.sheet.show').forEach((s) => { s.classList.remove('show'); s.setAttribute('aria-hidden', 'true'); });
  if (!silent) { scrim.classList.remove('show'); input.focus(); }
}
scrim.onclick = () => closeSheets();

// Model picker
const pickQ = $('#pickQ');
const pickList = $('#pickList');
let kbIndex = -1;
const price = (p) => (p === 0 ? 'free' : p * 1e6 < 0.1 ? `$${(p * 1e6).toFixed(3)}` : `$${(p * 1e6).toFixed(2)}`);
const ctxFmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `${Math.round(n / 1000)}K`);

function modelRow(m) {
  const b = el('button', 'pick' + (m.id === S.model ? ' sel' : ''));
  const hue = PROVIDER_HUE[m.provider] || '#6b7280';
  b.innerHTML = `<span class="pav" style="background:${hue}">${esc(m.provider.slice(0, 2))}</span>
    <span class="pmain"><div class="pname">${esc(m.name)}</div><div class="pid">${esc(m.id)}</div></span>
    <span class="pside"><div class="badges">${m.vision ? '<span class="badge">vision</span>' : ''}${m.ctx ? `<span class="badge">${ctxFmt(m.ctx)}</span>` : ''}</div><div>${price(m.pin)} · ${price(m.pout)}</div></span>`;
  b.onclick = () => chooseModel(m.id);
  return b;
}

function renderPicker() {
  const q = pickQ.value.trim().toLowerCase();
  pickList.innerHTML = '';
  kbIndex = -1;
  if (!models.length) { pickList.appendChild(el('div', 'pick-empty', 'Loading models…')); return; }
  const terms = q.split(/\s+/).filter(Boolean);
  const match = (m) => terms.every((t) => (m.id + ' ' + m.name).toLowerCase().includes(t));
  const sec = (title, list) => {
    if (!list.length) return;
    pickList.appendChild(el('div', 'pick-sec', title));
    list.forEach((m) => pickList.appendChild(modelRow(m)));
  };
  if (!q) {
    const recent = S.recent.map((id) => modelInfo(id)).filter(Boolean);
    const featured = FEATURED.map((id) => modelInfo(id)).filter((m) => m && !S.recent.includes(m.id));
    sec('Recent', recent);
    sec('Fast & capable', featured);
    sec('All models', [...models].sort((a, b) => b.created - a.created));
  } else {
    const hits = models.filter(match).sort((a, b) => b.created - a.created);
    if (!hits.length) pickList.appendChild(el('div', 'pick-empty', `No models match “${esc(q)}”`));
    sec(`${hits.length} result${hits.length === 1 ? '' : 's'}`, hits);
  }
}
pickQ.addEventListener('input', renderPicker);
pickQ.addEventListener('keydown', (e) => {
  const rows = [...pickList.querySelectorAll('.pick')];
  if (!rows.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    rows[kbIndex]?.classList.remove('kb');
    kbIndex = (kbIndex + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows[kbIndex].classList.add('kb');
    rows[kbIndex].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    (rows[kbIndex] || rows[0]).click();
  }
});

function chooseModel(id) {
  S.model = id;
  S.recent = [id, ...S.recent.filter((x) => x !== id)].slice(0, 5);
  save();
  paintModel();
  closeSheets();
}
function paintModel() {
  const m = modelInfo();
  $('#modelName').textContent = m?.name || S.model.split('/').pop();
  $('#modelBtn').title = S.model;
  $('#setModel').textContent = S.model;
  const hue = PROVIDER_HUE[(m?.provider) || S.model.split('/')[0]];
  $('.pdot').style.background = hue || '';
}
function openPicker() {
  openSheet('#picker');
  pickQ.value = '';
  renderPicker();
  pickList.scrollTop = 0;
  setTimeout(() => pickQ.focus(), 60);
}
$('#modelBtn').onclick = openPicker;
$('#setModelBtn').onclick = openPicker;

async function loadModels() {
  const { modelCache } = await chrome.storage.local.get('modelCache');
  if (modelCache?.list?.length) { models = modelCache.list; paintModel(); }
  if (!modelCache || Date.now() - modelCache.at > 6 * 3600e3) {
    try {
      models = await listModels();
      chrome.storage.local.set({ modelCache: { at: Date.now(), list: models } });
      paintModel();
      if ($('#picker').classList.contains('show')) renderPicker();
    } catch {}
  }
}

// History + export
const histList = $('#histList');
const when = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const DL = '<svg viewBox="0 0 16 16"><path d="M8 2.5v7.5M4.8 7 8 10.2 11.2 7M3 12.8h10"/></svg>';
const TRASH = '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>';

let toastT;
function toast(text) {
  let t = $('.toast');
  if (!t) t = document.body.appendChild(el('div', 'toast'));
  t.textContent = text;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 1800);
}

async function renderHistory() {
  const { chats = [] } = await chrome.storage.local.get('chats');
  histList.innerHTML = '';
  $('#exportAll').disabled = !chats.length;
  if (!chats.length) { histList.appendChild(el('div', 'pick-empty', 'No chats yet.')); return; }
  const day = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return +d; };
  const today = day(Date.now());
  let lastSec = '';
  chats.forEach((c, i) => {
    const d = day(c.updated);
    const sec = d === today ? 'Today' : d === today - 864e5 ? 'Yesterday' : d > today - 7 * 864e5 ? 'This week' : 'Earlier';
    if (sec !== lastSec) { histList.appendChild(el('div', 'pick-sec', sec)); lastSec = sec; }
    const row = el('div', 'hist' + (c.id === chatId ? ' cur' : ''));
    row.style.animationDelay = `${Math.min(i, 12) * 18}ms`;
    row.innerHTML = `<button class="hmain"><div class="htitle"></div><div class="hsub"></div></button>
      <button class="hact" title="Export log">${DL}</button><button class="hact del" title="Delete">${TRASH}</button>`;
    row.querySelector('.htitle').textContent = c.title;
    row.querySelector('.hsub').textContent = `${when(c.updated)} · ${c.model?.split('/').pop() || ''} · ${c.steps} step${c.steps === 1 ? '' : 's'}`;
    row.querySelector('.hmain').onclick = () => openChat(c.id);
    row.querySelector('.hact').onclick = () => exportChats([c.id]);
    const del = row.querySelector('.del');
    del.onclick = async () => {
      if (!del.classList.contains('confirm')) {
        del.classList.add('confirm'); del.textContent = 'Delete?';
        setTimeout(() => { if (del.isConnected) { del.classList.remove('confirm'); del.innerHTML = TRASH; } }, 2500);
        return;
      }
      row.classList.add('gone');
      await deleteChat(c.id);
      setTimeout(renderHistory, 220);
    };
    histList.appendChild(row);
  });
}

async function openChat(id) {
  await halt();
  const key = 'chat:' + id;
  const c = (await chrome.storage.local.get(key))[key];
  if (!c) { toast('Chat not found'); return renderHistory(); }
  loadChat(c);
  chrome.storage.local.set({ currentChat: id });
  replay();
  closeSheets();
}

async function deleteChat(id) {
  const { chats = [] } = await chrome.storage.local.get('chats');
  await chrome.storage.local.set({ chats: chats.filter((c) => c.id !== id) });
  await chrome.storage.local.remove('chat:' + id);
  if (id === chatId) newChat();
}

function download(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = el('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function exportChats(ids) {
  if (ids.includes(chatId)) await saveThread();
  const keys = ids.map((id) => 'chat:' + id);
  const got = await chrome.storage.local.get(keys);
  const chats = keys.map((k) => got[k]).filter(Boolean);
  if (!chats.length) return toast('Nothing to export');
  const { apiKey, recent, ...settings } = S;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const slug = ids.length === 1 ? chats[0].title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'chat' : `${chats.length}-chats`;
  download(`tuffagent-${slug}-${stamp}.json`, {
    app: 'TuffAgent',
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    browser: navigator.userAgent,
    settings,
    systemPrompt: systemPrompt(),
    tools: TOOLS.map((t) => t.function.name),
    chats: chats.map(({ messages: msgs, log: lg, ...meta }) => ({ ...meta, log: lg || [], messages: msgs })),
  });
  toast(ids.length === 1 ? 'Log exported' : `Exported ${chats.length} chats`);
}

$('#historyBtn').onclick = () => { openSheet('#history'); renderHistory(); };
$('#exportAll').onclick = async () => {
  const { chats = [] } = await chrome.storage.local.get('chats');
  exportChats(chats.map((c) => c.id));
};

// Settings
function openSettings() {
  $('#setReasoning').value = S.reasoning;
  $('#setFast').checked = S.fast;
  $('#setOverlay').checked = S.overlay;
  $('#setTrusted').checked = S.trusted;
  $('#setSteps').value = S.maxSteps;
  $('#setUnlimited').checked = S.unlimited;
  $('#stepsRow').classList.toggle('off', S.unlimited);
  $('#setInstr').value = S.instructions;
  $('#setKey').textContent = S.apiKey ? `${S.apiKey.slice(0, 10)}…${S.apiKey.slice(-4)}` : '—';
  paintModel();
  openSheet('#settings');
}
$('#settingsBtn').onclick = openSettings;
$('#setReasoning').onchange = (e) => { S.reasoning = e.target.value; save(); };
$('#setFast').onchange = (e) => { S.fast = e.target.checked; save(); };
$('#setOverlay').onchange = (e) => { S.overlay = e.target.checked; save(); };
$('#setTrusted').onchange = (e) => { S.trusted = e.target.checked; save(); };
$('#setSteps').onchange = (e) => { S.maxSteps = Math.max(1, Math.min(500, +e.target.value || 40)); e.target.value = S.maxSteps; save(); };
$('#setUnlimited').onchange = (e) => { S.unlimited = e.target.checked; $('#stepsRow').classList.toggle('off', S.unlimited); save(); };
$('#setInstr').oninput = (e) => { S.instructions = e.target.value; save(); };
$('#setKeyBtn').onclick = () => { S.apiKey = ''; save(); closeSheets(); showOnboard(); };

// Onboarding
function showOnboard() {
  $('#onboard').hidden = false;
  setTimeout(() => $('#obKey').focus(), 50);
}
$('#obForm').onsubmit = async (e) => {
  e.preventDefault();
  const key = $('#obKey').value.trim();
  const btn = $('#obGo');
  const err = $('#obErr');
  const card = $('.ob-card');
  err.textContent = '';
  if (!key) { card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); return; }
  btn.classList.add('loading');
  try {
    await checkKey(key);
    S.apiKey = key;
    save();
    const ob = $('#onboard');
    ob.style.transition = 'opacity .3s ease, transform .35s cubic-bezier(.2,.8,.2,1)';
    ob.style.opacity = '0'; ob.style.transform = 'scale(1.02)';
    setTimeout(() => { ob.hidden = true; ob.style.cssText = ''; input.focus(); }, 320);
  } catch (ex) {
    err.textContent = ex.message;
    card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
  } finally {
    btn.classList.remove('loading');
  }
};

// ── Boot ──
(async () => {
  const [{ settings, thread: legacy, currentChat }, win] = await Promise.all([
    chrome.storage.local.get(['settings', 'thread', 'currentChat']),
    chrome.windows.getCurrent(),
  ]);
  S = { ...DEFAULTS, ...(settings || {}) };
  if ((settings?.v || 1) < 2) { S.trusted = true; S.v = 2; save(); }
  agent.windowId = win.id;
  const [active] = await chrome.tabs.query({ active: true, windowId: win.id });
  agent.tabId = active?.id ?? null;
  if (currentChat) loadChat((await chrome.storage.local.get('chat:' + currentChat))['chat:' + currentChat]);
  else if (Array.isArray(legacy) && legacy.length) {
    loadChat({ messages: legacy });
    await saveThread();
  }
  chrome.storage.local.remove('thread');
  paintModel();
  refreshTab();
  replay();
  loadModels();
  if (!S.apiKey) showOnboard();
  else input.focus();
  updateSend();
})();
