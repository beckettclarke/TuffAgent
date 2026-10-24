import { agent, exec, normalize, preLabel, toolsFor, overlayOff, detachAll, currentTabInfo, restoreChecklist, openChecklist, parseArgs, TOOLS } from './tools.js';
import { PACKS, packOf, packsForUrl } from './sites/index.js';
import { complete, checkKey, listModels } from './llm.js';
import { md } from './md.js';
import { field } from './field.js';
import { fa, toolIcon } from './icons.js';
import { activity } from './activity.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const DEFAULTS = {
  apiKey: '', model: 'anthropic/claude-haiku-5.5', reasoning: 'auto', fast: true, overlay: true,
  trusted: true, maxSteps: 100, unlimited: false, instructions: '', loader: 'line', recent: [], v: 3,
};
// Retries per model call (rate limits, overloaded providers, dropped streams).
const RETRIES = 5;
// Tools that don't touch a page or each other; a run of these in one response starts together.
const PARALLEL = new Set(['tab_open', 'tabs_list', 'history_search', 'bookmarks', 'downloads']);
const FEATURED = ['anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'openai/gpt-5.6-luna',
  'openai/gpt-5.6-terra', 'google/gemini-3.8-flash', 'x-ai/grok-4.7', 'moonshotai/kimi-k3', 'qwen/qwen3.8-flash'];

let S = { ...DEFAULTS };
let messages = [];
let models = [];
let running = false;
let ctrl = null;
let runEnded = Promise.resolve();
// Cache breakpoint on the newest (tool) message; switched off if a provider rejects it.
let cacheTail = true;
// How hard buildMessages trims history: raised when a request overflows the
// model's context window, reset when a new run starts.
let squeeze = 0;
const MAC = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform);
// Current chat: messages above, plus a debug log of every run.
let chatId = null;
let chatCreated = 0;
let chatLog = [];
// Site packs this chat has used. Sticky, so the tool list (and the prompt cache) stays put.
let chatPacks = new Set();

const save = () => chrome.storage.local.set({ settings: S });
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
// User turns the person typed (not screenshots or the agent's own nudges).
const typed = (m) => m.role === 'user' && !m._img && !m._hidden;
const firstUser = (msgs) => msgs.find(typed);
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
    ['chat:' + chatId]: { ...meta, messages: slim, log: chatLog, packs: [...chatPacks] },
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
  chatPacks = new Set(c?.packs || []);
  restoreChecklist(messages);
}

const waitingOn = () => `Waiting on ${modelInfo()?.name || S.model.split('/').pop()}`;
const log = (type, data) => chatLog.push({ t: Date.now(), type, ...data });
const modelInfo = (id = S.model) => models.find((m) => m.id === id);

// ── Icons for tool steps ──
const icon = (name, args) => fa(toolIcon(name, args));
const CHECK = '<i class="check fa-sharp fa-regular fa-check" aria-hidden="true"></i>';
const XMARK = '<i class="xmark fa-sharp fa-regular fa-xmark" aria-hidden="true"></i>';

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

// Copy button that sits under a message and shows on hover.
function copyBtn(text) {
  const b = el('button', 'copy', `${fa('copy')}<span>Copy</span>`);
  b.title = 'Copy';
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(text); } catch { toast('Couldn’t copy'); return; }
    b.classList.add('done');
    b.innerHTML = `${fa('check')}<span>Copied</span>`;
    field.at(b, 'ok');
    setTimeout(() => { b.classList.remove('done'); b.innerHTML = `${fa('copy')}<span>Copy</span>`; }, 1400);
  };
  return b;
}

function userBubble(text) {
  const w = el('div', 'msg-user');
  w.appendChild(el('div', 'bubble')).textContent = text;
  w.appendChild(copyBtn(text));
  thread.appendChild(w);
  setEmpty();
}

function fmtMs(ms) { return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`; }
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtCost = (c) => `$${c === 0 ? '0' : c < 0.01 ? c.toFixed(4) : c.toFixed(3)}`;
function fmtDur(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}h ${pad(m % 60)}m` : m ? `${m}m ${pad(s % 60)}s` : `${s}s`;
}

// ── Chat totals: agent working time (not time waiting on the user), tokens and
// cost across every run in this chat. Finished runs come from the log's "end"
// entries; the run in progress is added live.
let live = null;
let liveTick = 0;
function paintTotals() {
  let ms = 0, cost = 0, tokens = 0;
  for (const e of chatLog) if (e.type === 'end') { ms += e.ms || 0; cost += e.cost || 0; tokens += e.tokens || 0; }
  if (live) { ms += performance.now() - live.t0; cost += live.cost; tokens += live.tokens; }
  $('#totals').hidden = !live && !ms;
  $('#totTime').textContent = fmtDur(ms);
  $('#totTok').textContent = fmtTok(tokens);
  $('#totCost').textContent = fmtCost(cost);
}
function liveTotals(on) {
  clearInterval(liveTick);
  live = on ? { t0: performance.now(), cost: 0, tokens: 0 } : null;
  if (on) liveTick = setInterval(paintTotals, 1000);
  paintTotals();
}

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
    activity.set('wait', /^(Thinking|Working)$/.test(label) ? waitingOn() : label);
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
        activity.set('think');
        if (!thinkEl) {
          thinkStart = performance.now();
          thinkEl = t.root.appendChild(el('details', 'think', `<summary>${fa('chevron-right')}<span class="shimmer">Thinking</span></summary><div class="tbody"></div>`));
        }
        const b = thinkEl.querySelector('.tbody');
        b.textContent = r;
        b.scrollTop = b.scrollHeight;
        follow();
      },
      text(s) {
        t.clearWait();
        activity.set('write');
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
        activity.set('plan', preLabel(name), icon(name));
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
        if (textEl && msg.content) textEl.after(copyBtn(msg.content));
        if (!msg.content && textEl) textEl.remove();
        return (msg.tool_calls || []).map((tc, i) => this.stepAt(i, tc.function.name));
      },
      // A failed attempt that will be retried: take its partial output off screen.
      discard() {
        if (rafT) cancelAnimationFrame(rafT), rafT = 0;
        thinkEl?.remove(); textEl?.remove();
        for (const s of pending.values()) s.el.remove();
        if (t.steps && !t.steps.children.length) { t.steps.remove(); t.steps = null; }
        thinkEl = textEl = null;
        pending.clear();
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
    field.at(s.querySelector('.sicon'), 'step');
    const api = {
      el: s,
      label(l, args) {
        s.querySelector('.slabel').textContent = l;
        if (args) s.querySelector('.sicon').innerHTML = icon(name, args);
      },
      done(ok, { label, args, result, ms, image }) {
        s.classList.remove('running');
        s.classList.add(ok ? 'ok' : 'fail');
        if (label || args) api.label(label || s.querySelector('.slabel').textContent, args);
        s.querySelector('.slabel').title = label || '';
        s.querySelector('.sstate').innerHTML = ok ? CHECK : XMARK;
        field.at(s.querySelector('.sicon'), ok ? 'ok' : 'fail');
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
    if (tokens) parts.push(`${fmtTok(tokens)} tok`);
    if (cost) parts.push(fmtCost(cost));
    this.root.appendChild(el('div', 'meta', parts.map((p) => `<span>${p}</span>`).join('')));
    follow();
  }
  notice(text) { this.root.appendChild(el('div', 'notice', esc(text))); follow(); }
  error(text, retry) {
    const c = el('div', 'err-card', `<div class="et"><b>${fa('triangle-exclamation')}Something went wrong</b>${esc(text)}</div>`);
    if (retry) {
      const b = el('button', 'btn ghost sm', 'Retry');
      b.onclick = () => { c.remove(); retry(); };
      c.appendChild(b);
    }
    this.root.appendChild(c);
    follow();
    field.at(c, 'fail');
  }
}

// Rebuild the transcript from saved messages.
function replay() {
  thread.innerHTML = '';
  const results = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m]));
  let turn = null;
  for (const m of messages) {
    if (typed(m)) { userBubble(m._display ?? m.content); turn = null; continue; }
    if (m.role !== 'assistant') continue;
    turn ||= new Turn();
    turn.root.style.animation = 'none';
    if (m.content) turn.root.append(el('div', 'md', md(m.content)), copyBtn(m.content));
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
  paintTotals();
  follow(true);
}

// ── Prompt + request assembly ──
const activePacks = () => PACKS.filter((p) => chatPacks.has(p.id));

function systemPrompt() {
  // Date only: the system prompt opens every request, so it must stay byte-stable for prompt caching.
  return `You are TuffAgent, a fast browser agent living in the user's Chrome side panel. You control the browser through tools.
Date: ${new Date().toDateString()}. Platform: ${MAC ? 'macOS — shortcuts use Meta (⌘), e.g. Meta+a, Meta+z, Meta+Shift+h' : 'Windows/Linux — shortcuts use Control'}.

How to work:
- Act, don't narrate. Do the task with tools; only ask when genuinely blocked or before risky actions.
- Speed matters: every response costs a model round trip, so do as much as you can per response. When the next steps are predictable, emit several tool calls in one response (e.g. type into each field, then click submit, or a batch of independent edits) — they run in order. Consecutive tab_open, tabs_list, history_search, bookmarks and downloads calls run at the same time, so open several tabs in one response. One tool call per response is the slow path.
- Snapshots list the page in reading order: text, headings, table rows ("| a | b |") and controls with refs ("[e12] button …"); links inside text appear as [text](e12). navigate, tab_open and actions that load a page return one — read it instead of calling read_page. Lines marked ·off are outside the viewport; "not shown" lines were cut for length.
- Aim with a ref (e12), or with target = the element's visible label ("Add to cart"); when a label repeats, add near = text in the same row or card ("Order #1234") or nth. Never guess coordinates for elements that have a ref or a label. Refs go stale after navigation; labels don't.
- Action results report what appeared or changed ("New on screen", "Changed", "New text": menus, dialogs, suggestions, errors, toasts) with refs. Act on those directly — no read_page or find needed. Chain through menus in one response when you know the item names.
- Links that open a new tab switch the current tab to it (the result says so). Page alerts and confirms are accepted automatically and reported.
- Long or formatted text: paste (markdown or HTML) instead of type — headings, lists, tables and links in one call.
- Menus: menu with the visible labels (["Insert","Table"]) clicks through menu, submenu and item in one call.
- To find a fact on a long page, get_text with query (the lines that mention it). get_text to read or summarize, find to locate an element, run_js for bulk extraction or anything tools can't do.
- Go straight to URLs when you can build them: a site's search results (https://www.google.com/search?q=…, https://en.wikipedia.org/w/index.php?search=…, https://github.com/search?q=…, or the site's own ?q= pattern), a known page, sorted or filtered listings. Clear cookie banners and popups that cover the page.${modelInfo()?.vision === false ? '' : `
- Use screenshot when visual layout matters, the snapshot is confusing, or content is drawn on a canvas (Google Docs/Sheets text). Screenshots tag clickable elements with their refs — click those by ref, never by guessed coordinates. Use x/y only for canvas content, reading positions off the 100px edge rulers. To see the result of actions, end that same response with a screenshot call instead of spending a separate round.`}
- Text goes in with one type call, never key-by-key. In rich editors (Google Docs etc.), click where the text goes, then type without ref (types at the caret); use key Enter for new paragraphs.
- key takes repeats ("Shift+ArrowRight*12"). Select ranges with drag, a triple click (clicks: 3), or click then click again with modifiers: "shift".
- Move cards, list items and files with drag (ref → to_ref); to_position "top"/"bottom" drops before/after an item. A drag that moves nothing returns an error.
- Exact numbers beat dragging: when an app has number fields for size and position (W, H, X, Y, rotation, font size), type the values there. Never drag resize handles or tap arrow keys to place or size things.
- type replaces a field's text and reads it back; an error means the field holds something else, so read it and type the whole value again.
- The current tab is given in <context>. tab_open (active) and tab_switch change it; other page tools accept tab_id.
- Tasks with many requirements: call checklist first (one item per requirement), mark items done only after verifying them, and report from it with exact counts.
- Stay in scope: do what was asked, nothing more. No extra documents, designs, tabs, files or downloads, and no page-wide shortcuts ("Change all", "Apply to all", "Replace all") unless the task asks for them.
- When the task says what must be on top or behind, set the stacking order explicitly (To front / To back, Bring forward / Send backward) and read it back; never infer it.
- Recover without destroying: fix forward. Don't delete and recreate content, undo a long run of steps, or reload to escape a bad state; undo only the step that just went wrong.
- Trust tool results. A result without an error means it happened; don't re-check each step with screenshots, read_page or re-reads, and never redo something a result or an earlier check already confirmed. Verify once after a batch of edits and once at the end.
- Keep thinking short: pick the obvious next actions and emit them. Don't re-plan the whole task every round.
- If something fails, adapt (re-read the page, try another element, scroll) instead of repeating the same call. When a call fails, the remaining calls in that response are skipped, so re-plan from the error. After two failures on the same approach, switch approach (a dedicated tool, paste, menu search, run_js), or skip the item and come back to it.
- Finish the job. Don't stop with requirements left because a step is slow or fiddly; skip a stuck item, do the rest, then come back to it. Stop early only when truly blocked (sign-in, permission, missing information), and then say exactly what is left.
- Before irreversible or sensitive actions — purchases, sending messages or emails, posting publicly, deleting data, entering payment info or passwords — stop and ask the user to confirm, unless they explicitly asked for exactly that.
- Before answering, check the result against every part of the request (dates, counts, filters, sort order, which item). When asked for information, give the exact values as the page shows them (numbers, names, dates, prices) and where they came from.
- Finish with a short answer or summary in markdown, built from evidence: say only what tool results showed. Give no reasons or explanations the tools didn't show, and every number must match a value a tool measured (no rounding into a different number). No preamble.${activePacks().map((p) => `\n\n${p.prompt}`).join('')}${S.instructions.trim() ? `\n\nUser's custom instructions:\n${S.instructions.trim()}` : ''}`;
}

// Tool results are trimmed by age. The cut-off points move in steps of 10
// results, so earlier messages stay byte-identical between rounds and provider
// prompt caches keep hitting. After a context overflow (squeeze 1–3) fewer
// results stay whole and the steps get finer.
const KEEP_FULL = [6, 4, 2, 1], FULL_STEP = [10, 10, 5, 1], KEEP_MID = [40, 20, 10, 4], MID_CAP = [1200, 900, 600, 300];
function buildMessages() {
  const isAnthropic = S.model.includes('anthropic/');
  const lastUser = messages.findLastIndex(typed);
  const lastImg = messages.findLastIndex((m) => m._img);
  const toolOrd = new Map();
  messages.forEach((m, i) => { if (m.role === 'tool') toolOrd.set(i, toolOrd.size); });
  const step = FULL_STEP[squeeze];
  const fullFrom = Math.max(0, Math.floor((toolOrd.size - KEEP_FULL[squeeze]) / step) * step);
  const briefFrom = Math.max(0, Math.floor((toolOrd.size - KEEP_MID[squeeze]) / 20) * 20);
  // Old reasoning is most of the context on long runs (and invites the model to
  // re-argue settled steps). Drop plain reasoning text before the same cut-off as
  // tool results so the cache breaks at the same moment; signed or encrypted
  // reasoning (Anthropic, Gemini, OpenAI) is kept because providers need it back.
  const reasonFrom = fullFrom ? [...toolOrd].find(([, n]) => n === fullFrom)[0] : 0;
  const signed = (d) => d.signature || d.data || d.type === 'reasoning.encrypted';
  const out = messages.map((m, i) => {
    const c = {};
    for (const k in m) if (k[0] !== '_') c[k] = m[k];
    if (c.reasoning_details && i < reasonFrom) {
      const keep = c.reasoning_details.filter(signed);
      if (keep.length) c.reasoning_details = keep; else delete c.reasoning_details;
    }
    if (m.role === 'tool' && typeof c.content === 'string') {
      const n = toolOrd.get(i);
      const cap = i < lastUser || n < briefFrom ? 300 : n < fullFrom ? MID_CAP[squeeze] : Infinity;
      if (c.content.length > cap) c.content = c.content.slice(0, cap) + '\n…[trimmed]';
    }
    if (m._img && (i !== lastImg || squeeze >= 2)) c.content = '[earlier screenshot omitted]';
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
    tools: toolsFor(info ? info.vision : true, [...chatPacks]),
    tool_choice: 'auto',
    parallel_tool_calls: true,
    // Room for reasoning plus a long paste or a batch of calls: some providers
    // turn reasoning effort into a share of max_tokens, which left too little
    // at 8k. Not more, since that share is also how long the model may think.
    max_tokens: info?.maxOut ? Math.min(info.maxOut, 16000) : 8192,
    usage: { include: true },
  };
  // Agent turns are short (a few tool calls), so time to first token decides the
  // speed, not tokens per second.
  if (S.fast) body.provider = { sort: 'latency' };
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
  field.at(sendBtn, 'send');
  messages.push({ role: 'user', content: text + (await contextLine()), _display: text });
  saveThread();
  run();
}

async function run() {
  let ended;
  runEnded = new Promise((r) => (ended = r));
  running = true;
  document.body.classList.add('running');
  activity.set('wait', waitingOn());
  updateSend();
  const turn = new Turn();
  ctrl = new AbortController();
  const signal = ctrl.signal;
  agent.trusted = S.trusted;
  agent.overlay = S.overlay;
  const t0 = performance.now();
  liveTotals(true);
  let steps = 0, cost = 0, tokens = 0, lastAssistant = null, hitLimit = true, stopped = false;
  // Recoveries left this run: retried model calls, and nudges back to work
  // (cut-off replies, quitting with checklist items open).
  let recoveries = 12, nudges = 3, nudgedFor = '';
  // Recent calls, to notice the model repeating one that keeps giving the same result.
  const recent = [];
  // Small steps repeated toward one goal (arrow-key nudges, drags that move
  // nothing, probing the page with run_js), counted since the checklist last
  // changed. Past a limit the model is told to change approach.
  const grind = { keys: 0, drags: 0, js: 0, next: {} };
  const GRIND = {
    keys: [20, 'key presses', 'Tapping keys to nudge or step through things is the slow path: type the value into the app\'s number field, or use a menu command.'],
    drags: [5, 'drags that moved nothing', 'Dragging is not working here: use the app\'s size and position fields, or a site tool.'],
    js: [10, 'run_js calls', 'Probing the page with run_js is not converging: use read_page, find, a site tool, or act on what you already know.'],
  };
  // Site edits since the site's own read tool last ran, for the check before the final answer.
  let seq = 0, lastEdit = 0, lastRead = 0, finalChecked = false;
  const task = messages.findLast(typed)?._display || '';
  squeeze = 0;
  const limit = S.unlimited ? Infinity : S.maxSteps;
  log('run', {
    prompt: messages.findLast(typed)?._display, model: S.model, version: chrome.runtime.getManifest().version,
    settings: { reasoning: S.reasoning, fast: S.fast, trusted: S.trusted, overlay: S.overlay, maxSteps: S.unlimited ? 'unlimited' : S.maxSteps },
  });
  const nudge = (text) => { messages.push({ role: 'user', content: text, _hidden: true }); nudges--; };
  // Abortable pause between retries.
  const pause = (ms) => new Promise((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
  });

  try {
    for (let i = 0; i < limit; i++) {
      turn.waiting(i === 0 ? 'Thinking' : 'Working');
      // Offer a site's tools once its page is open (and keep them for the rest of the chat).
      for (const p of packsForUrl((await currentTabInfo())?.url)) chatPacks.add(p.id);
      let view = turn.response();
      // Each tool call starts as soon as its arguments finish streaming, so the
      // browser works while the model is still writing the next call. Calls run
      // in order, except that a run of independent ones (opening tabs, lookups)
      // starts together.
      const calls = [], results = [], images = [];
      // The calls in one response are a plan; once one fails, the rest act on a
      // page that isn't what the model expected (typing into the wrong place).
      let chain = Promise.resolve(), group = null, started = 0, failed = null, cutOff = false, acting = 0;
      const parses = (tc) => { try { JSON.parse(tc.function.arguments?.trim() || '{}'); return true; } catch { return false; } };
      const pump = (final) => {
        while (started < calls.length && calls[started] && (final || parses(calls[started]))) {
          const k = started++;
          if (PARALLEL.has(normalize(calls[k].function.name, {})[0])) {
            group ||= { before: chain, all: [] };
            group.all.push(group.before.then(() => runTool(k, calls[k])));
            chain = Promise.all(group.all);
          } else {
            group = null;
            chain = chain.then(() => runTool(k, calls[k]));
          }
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
        if (failed) {
          results[k] = { role: 'tool', tool_call_id: tc.id, content: `Skipped: ${failed} failed earlier in this response, so this call did not run.`, _label: 'Skipped', _ok: false };
          sv.done(false, { label: 'Skipped' });
          return;
        }
        const args = parseArgs(tc.function.arguments);
        sv.label(preLabel(name, args || {}), args);
        acting++;
        activity.set('act', preLabel(name, args || {}), icon(name, args || {}));
        const s0 = performance.now();
        let content, label, ok = true, image;
        try {
          if (!args) {
            throw new Error(`Invalid JSON arguments: ${tc.function.arguments?.slice(0, 200)}` +
              (cutOff ? ' — your response hit the output token limit mid-call. Send long content in smaller pieces.' : ''));
          }
          const r = await exec(name, args);
          content = r.text; label = r.label; image = r.image;
        } catch (e) {
          ok = false;
          failed = name;
          content = `Error: ${e.message}`;
          label = `${preLabel(name, args || {})} — failed`;
        }
        const ms = performance.now() - s0;
        sv.done(ok, { label, args, result: content, ms, image });
        if (!--acting) activity.set('wait', waitingOn());
        // Same call, same result, again: the model is stuck in a loop. Say so (to the
        // model only) so it changes approach instead of burning rounds.
        const sig = name + ' ' + JSON.stringify(args);
        const same = recent.filter((r) => r.sig === sig && r.content === content).length;
        recent.push({ sig, content });
        if (recent.length > 12) recent.shift();
        let said = content;
        if (same >= 2 && name !== 'wait' && name !== 'checklist') {
          said += `\n\nNote: this is call number ${same + 1} of ${name} with these exact arguments and the same result. Repeating it won't help: take a different approach (another element, find, scroll, keyboard, run_js, or another route to the goal).`;
        }
        if (name === 'checklist' && ok && (args?.set || args?.done?.length || args?.failed?.length)) Object.assign(grind, { keys: 0, drags: 0, js: 0, next: {} });
        if (name === 'key' && args?.keys) grind.keys += globalThis.TuffKeys.parse(String(args.keys)).reduce((n, k) => n + (k.text ? 0 : k.n), 0);
        if (name === 'drag' && /nothing moved|did not move/.test(content)) grind.drags++;
        if (name === 'run_js') grind.js++;
        for (const [k, [max, what, tip]] of Object.entries(GRIND)) {
          if (grind[k] <= Math.max(max, grind.next[k] || 0)) continue;
          said += `\n\nNote: ${grind[k]} ${what} since the checklist last changed. ${tip} Stop and take a different approach.`;
          grind.next[k] = grind[k] + max;
        }
        seq++;
        const pack = packOf(name);
        if (pack?.finalCheck === name) lastRead = seq;
        else if (pack && ok) lastEdit = seq;
        const tab = agent.tabId != null ? await chrome.tabs.get(agent.tabId).catch(() => null) : null;
        log('tool', {
          name, args: args ?? tc.function.arguments, ok, ms: Math.round(ms), label, url: tab?.url,
          result: content.length > 4000 ? content.slice(0, 4000) + `…[${content.length} chars]` : content,
        });
        if (image) images.push(image);
        results[k] = { role: 'tool', tool_call_id: tc.id, content: said, _label: label, _ok: ok, _ms: Math.round(ms) };
        steps++;
      };

      // One model call, retried on rate limits, provider errors, dropped or stalled
      // streams, empty replies and context overflow (with a tighter history).
      let res, resumed = false;
      for (let attempt = 0; ; attempt++) {
        let err = null;
        try {
          res = await complete({
            apiKey: S.apiKey, body: requestBody(), signal,
            onText: (s) => view.text(s), onReasoning: (r) => view.reasoning(r), onToolStart: (idx, name) => view.toolStart(idx, name),
            onToolReady: (idx, tc) => { calls[idx] = tc; pump(false); },
          });
          const u = res.usage;
          if (u) { cost += u.cost || 0; tokens += u.total_tokens || 0; live.cost = cost; live.tokens = tokens; paintTotals(); }
          const m = res.msg;
          if (m.content?.trim() || m.tool_calls?.length || signal.aborted) break;
          err = Object.assign(new Error('The model sent an empty reply'), { retriable: true });
        } catch (e) { err = e; }
        if (started) {
          // Some actions already ran: keep history consistent with what happened,
          // then let the model pick up from those results in the next round.
          await chain;
          const partial = err.partial || { role: 'assistant', content: '' };
          partial.tool_calls = calls.slice(0, started);
          messages.push(partial, ...results.slice(0, started));
          if (!err.retriable || recoveries-- <= 0) throw err;
          log('retry', { round: i, message: err.message, resumed: true });
          resumed = true;
          break;
        }
        if (signal.aborted) throw err;
        const anthropicCache = cacheTail && /^400\b/.test(err.message) && /cache/i.test(err.message) && S.model.includes('anthropic/');
        if (anthropicCache) cacheTail = false;
        else if (err.overflow && squeeze < KEEP_FULL.length - 1) squeeze++;
        else if (!err.retriable || attempt >= RETRIES || recoveries-- <= 0) throw err;
        const wait = anthropicCache || err.overflow ? 0
          : err.retryAfter ? Math.min(err.retryAfter * 1000, 30000) : Math.min(1000 * 2 ** attempt, 16000) * (0.75 + Math.random() / 2);
        log('retry', { round: i, attempt: attempt + 1, message: err.message, overflow: !!err.overflow, squeeze, wait: Math.round(wait) });
        view.discard();
        calls.length = 0;
        turn.waiting(err.overflow ? 'Trimming context' : `Retrying (${attempt + 1}/${RETRIES})`);
        if (wait) await pause(wait);
        if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
        view = turn.response();
      }
      if (resumed) continue;
      const { msg, usage, finish, ttft, ms: llmMs, provider, genId } = res;
      cutOff = finish === 'length';
      log('llm', {
        round: i, model: S.model, provider, id: genId, finish, ms: Math.round(llmMs), ttft: Math.round(ttft), usage, squeeze,
        text: msg.content || '', toolCalls: (msg.tool_calls || []).map((tc) => tc.function.name),
      });
      view.finish(msg);
      lastAssistant = msg;
      (msg.tool_calls || []).forEach((tc, k) => { calls[k] = tc; });
      calls.length = msg.tool_calls?.length || 0;
      pump(true);
      await chain;
      // Every 20 rounds, the request again, at the end of the newest message (the
      // cached prefix stays put): long runs drift away from what was asked.
      if (i && i % 20 === 0 && results.length) {
        const open = openChecklist();
        results[results.length - 1].content += `\n\nReminder of the task: "${task.length > 800 ? task.slice(0, 799) + '…' : task}"` +
          (open.length ? `\nOpen checklist items: ${open.map((x) => `${x.id}: ${x.text}`).join('; ')}` : '');
      }
      messages.push(msg, ...results);
      if (!msg.tool_calls?.length) {
        if (signal.aborted) { hitLimit = false; stopped = true; turn.notice('Stopped.'); break; }
        // A reply cut off by the output limit isn't an answer.
        if (cutOff && nudges > 0) {
          nudge('Your last reply was cut off by the output token limit. Continue from where it stopped, in shorter pieces.');
          continue;
        }
        // Quitting with requirements still open is the usual way long tasks fail.
        // Once per set of open items: a second stop on the same ones is deliberate.
        const open = openChecklist();
        const openIds = open.map((x) => x.id).join(',');
        if (open.length && nudges > 0 && openIds !== nudgedFor) {
          nudgedFor = openIds;
          nudge(`The checklist still has ${open.length} open item${open.length === 1 ? '' : 's'}: ${open.map((x) => x.id).join(', ')}. ` +
            'Keep working on them. If one truly cannot be done, mark it failed with a note saying why. If you need the user to decide or provide something, say so and stop.');
          continue;
        }
        // Site edits since the last read: read the result once with the site's own
        // tool before accepting the answer, so the summary is checked against the page.
        const url = lastEdit > lastRead && !finalChecked ? (await currentTabInfo())?.url || '' : '';
        const checker = url && activePacks().find((p) => p.finalCheck && p.match(url));
        if (checker && !signal.aborted) {
          finalChecked = true;
          const sv = turn.step(checker.finalCheck, 'Final check');
          const s0 = performance.now();
          let out, ok = true;
          try { out = (await exec(checker.finalCheck, {})).text; } catch (e) { ok = false; out = `Error: ${e.message}`; }
          sv.done(ok, { label: ok ? 'Final check' : 'Final check — failed', result: out, ms: performance.now() - s0 });
          log('tool', { name: checker.finalCheck, auto: true, ok, ms: Math.round(performance.now() - s0), result: out.length > 4000 ? out.slice(0, 4000) + '…' : out });
          messages.push({
            role: 'user', _hidden: true,
            content: `Automatic final check (${checker.finalCheck}):\n${out}\n\nCompare every requirement with this. If something is off, fix it. Otherwise give the final summary, with every number taken from this read or another tool result.`,
          });
          continue;
        }
        hitLimit = false;
        break;
      }
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
    liveTotals(false);
    running = false;
    ctrl = null;
    document.body.classList.remove('running');
    activity.stop();
    updateSend();
    const meta = { steps, ms: performance.now() - t0, cost, tokens };
    turn.meta(meta);
    field.at($('#composer'), stopped ? 'ok' : 'done');
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
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
    const b = input.getBoundingClientRect();
    field.ripple(b.left + Math.min(b.width - 8, 8 + (input.value.length % 64) * 6.5), b.top + 10, 'key');
  }
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
  paintTotals();
  field.ripple(innerWidth / 2, innerHeight * .4, 'done');
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
    field.at(chip, 'ok');
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
  b.innerHTML = `<span class="pav">${esc(m.provider.slice(0, 2))}</span>
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
const DL = fa('file-export');
const TRASH = fa('trash-can');

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
    tools: [...TOOLS, ...PACKS.flatMap((p) => p.tools)].map((t) => t.function.name),
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
  $('#setLoader').value = S.loader;
  $('#setKey').textContent = S.apiKey ? `${S.apiKey.slice(0, 10)}…${S.apiKey.slice(-4)}` : '—';
  paintModel();
  openSheet('#settings');
}
$('#settingsBtn').onclick = openSettings;
$('#setReasoning').onchange = (e) => { S.reasoning = e.target.value; save(); };
$('#setFast').onchange = (e) => { S.fast = e.target.checked; save(); };
$('#setOverlay').onchange = (e) => { S.overlay = e.target.checked; save(); };
$('#setTrusted').onchange = (e) => { S.trusted = e.target.checked; save(); };
$('#setSteps').onchange = (e) => { S.maxSteps = Math.max(1, Math.min(500, +e.target.value || DEFAULTS.maxSteps)); e.target.value = S.maxSteps; save(); };
$('#setUnlimited').onchange = (e) => { S.unlimited = e.target.checked; $('#stepsRow').classList.toggle('off', S.unlimited); save(); };
$('#setInstr').oninput = (e) => { S.instructions = e.target.value; save(); };
$('#setLoader').onchange = (e) => { S.loader = e.target.value; paintLoader(); save(); };
// Line or text (ASCII meter) loader in the composer while the agent works.
function paintLoader() { document.body.dataset.loader = S.loader; }
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
    field.at(btn, 'done');
    const ob = $('#onboard');
    ob.style.transition = 'opacity .3s ease, transform .35s cubic-bezier(.2,.8,.2,1)';
    ob.style.opacity = '0'; ob.style.transform = 'scale(1.02)';
    setTimeout(() => { ob.hidden = true; ob.style.cssText = ''; input.focus(); }, 320);
  } catch (ex) {
    err.textContent = ex.message;
    field.at(btn, 'fail');
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
  paintLoader();
  if ((settings?.v || 1) < 2) S.trusted = true;
  // 40 rounds was the old default and cut long tasks off mid-way.
  if ((settings?.v || 1) < 3 && S.maxSteps === 40) S.maxSteps = 100;
  if (S.v !== DEFAULTS.v) { S.v = DEFAULTS.v; save(); }
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
