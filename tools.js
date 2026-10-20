// Browser tools. Everything here runs in the side panel and talks to Chrome
// APIs directly, so each action is a single round trip.
import './keys.js';
import { mdToHtml, htmlToText } from './docmd.js';
import { PACKS, packOf } from './sites/index.js';

export const agent = {
  tabId: null,
  windowId: null,
  trusted: false,
  overlay: true,
  touched: new Set(),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const firstLine = (s) => String(s ?? '').split('\n')[0];
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

// ── Navigation tracking: lets clicks wait for DOMContentLoaded, not full load ──
const nav = new Map();
const navDone = (d) => {
  if (d.frameId !== 0) return;
  const n = nav.get(d.tabId);
  if (n) { n.pending = false; n.waiters.splice(0).forEach((f) => f()); }
};
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return;
  const n = nav.get(d.tabId) || { waiters: [] };
  n.pending = true; n.at = performance.now();
  nav.set(d.tabId, n);
});
chrome.webNavigation.onDOMContentLoaded.addListener(navDone);
chrome.webNavigation.onErrorOccurred.addListener(navDone);
chrome.webNavigation.onCompleted.addListener(navDone);
chrome.tabs.onRemoved.addListener((id) => { navDone({ tabId: id, frameId: 0 }); nav.delete(id); agent.touched.delete(id); });

function navStartedSince(tabId, t0) {
  const n = nav.get(tabId);
  return !!(n?.pending && n.at >= t0);
}
function waitNav(tabId, timeout = 8000) {
  const n = nav.get(tabId);
  if (!n?.pending) return Promise.resolve();
  return new Promise((r) => { n.waiters.push(r); setTimeout(r, timeout); });
}
// For actions we trigger ourselves (open/navigate): listen before acting.
function loaded(tabId, timeout = 8000) {
  let off;
  const p = new Promise((res) => {
    const f = (d) => { if ((d.tabId ?? d) === tabId && (d.frameId ?? 0) === 0) done(); };
    const u = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, timeout);
    function done() {
      chrome.webNavigation.onDOMContentLoaded.removeListener(f);
      chrome.webNavigation.onErrorOccurred.removeListener(f);
      chrome.tabs.onUpdated.removeListener(u);
      clearTimeout(t); res();
    }
    off = done;
    chrome.webNavigation.onDOMContentLoaded.addListener(f);
    chrome.webNavigation.onErrorOccurred.addListener(f);
    chrome.tabs.onUpdated.addListener(u);
  });
  p.cancel = off;
  return p;
}

// ── Content-script bridge ──
function friendly(e) {
  const m = String(e?.message || e);
  if (/Cannot access|cannot be scripted|chrome:\/\/|extensions gallery|Cannot script|webstore/i.test(m))
    return new Error('This page is restricted (chrome://, Web Store, PDF viewer, etc.) — it cannot be read or clicked. Navigate to a normal web page.');
  if (/No tab with id/i.test(m)) return new Error('That tab no longer exists. Call tabs_list.');
  if (/Frame with ID 0 was removed|frame was removed|navigated/i.test(m)) return null;
  return new Error(m);
}

async function cs(tabId, method, ...args) {
  const target = { tabId };
  const ov = agent.overlay ? 'TuffAgent is working' : null;
  const call = () => chrome.scripting.executeScript({
    target,
    func: async (m, a, ov) => {
      const t = window.__tuff;
      if (!t) return { missing: 1 };
      try { if (ov) t.overlay(true, ov); return { v: await t[m](...a) }; }
      catch (e) { return { err: String(e?.message || e) }; }
    },
    args: [method, args, ov],
  });
  let res;
  try { res = (await call())[0]?.result; }
  catch (e) { const f = friendly(e); if (f) throw f; return null; }
  if (res?.missing) {
    try { await chrome.scripting.executeScript({ target, files: ['keys.js', 'content.js'] }); res = (await call())[0]?.result; }
    catch (e) { const f = friendly(e); if (f) throw f; return null; }
  }
  if (ov) agent.touched.add(tabId);
  if (res == null) return null;
  if (res.err) throw new Error(res.err);
  return res.v;
}

// ── Trusted input via the DevTools protocol (opt-in; shows Chrome's debug bar) ──
const dbg = new Set();
chrome.debugger.onDetach.addListener((s) => dbg.delete(s.tabId));
async function cdp(tabId, method, params = {}) {
  if (!dbg.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3').catch((e) => { if (!/already attached/i.test(e.message)) throw e; });
    dbg.add(tabId);
  }
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    // Detached behind our back (onDetach doesn't fire for our own detach calls): re-attach once.
    if (!/not attached/i.test(e.message)) throw e;
    dbg.delete(tabId);
    await chrome.debugger.attach({ tabId }, '1.3');
    dbg.add(tabId);
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }
}
async function detach(tabId) {
  dbg.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}
export async function detachAll() {
  await Promise.all([...dbg].map(detach));
}

const MAC = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform);
// On macOS, DevTools key events don't run editing shortcuts unless named.
const MAC_CMD = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' };

async function cdpKeys(tabId, keys) {
  for (const k of globalThis.TuffKeys.parse(keys)) {
    if (k.text) { await cdp(tabId, 'Input.insertText', { text: k.text }); continue; }
    const mods = (k.alt ? 1 : 0) | (k.ctrl ? 2 : 0) | (k.meta ? 4 : 0) | (k.shift ? 8 : 0);
    const ch = k.key.length === 1;
    // A character with no key on a US layout (é, —, ²): insert it directly.
    if (ch && !k.keyCode && !(mods & 7)) { await cdp(tabId, 'Input.insertText', { text: k.key.repeat(k.n) }); continue; }
    const text = mods & 6 ? undefined : k.key === 'Enter' ? '\r' : ch ? k.key : undefined;
    const cmd = MAC && k.meta && !k.ctrl && !k.alt && (k.shift && k.key.toLowerCase() === 'z' ? 'redo' : !k.shift && MAC_CMD[k.key.toLowerCase()]);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: mods };
    const down = { ...base, type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text, ...(cmd ? { commands: [cmd] } : {}) };
    for (let i = 0; i < k.n; i++) {
      await cdp(tabId, 'Input.dispatchKeyEvent', down);
      await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    }
  }
}

const mouseMods = (s) => {
  const m = String(s || '').toLowerCase();
  return (/alt|option/.test(m) ? 1 : 0) | (/ctrl|control/.test(m) ? 2 : 0) | (/meta|cmd|command/.test(m) ? 4 : 0) | (/shift/.test(m) ? 8 : 0);
};
const mouseEv = (tabId, type, x, y, extra) => cdp(tabId, 'Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra });
async function cdpClick(tabId, x, y, clicks = 1, modifiers = 0) {
  await mouseEv(tabId, 'mouseMoved', x, y, { modifiers });
  for (let i = 1; i <= clicks; i++) {
    await mouseEv(tabId, 'mousePressed', x, y, { button: 'left', buttons: 1, clickCount: i, modifiers });
    await mouseEv(tabId, 'mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: i, modifiers });
  }
}
// Mouse drag with pauses so pointer-based sortables (dnd-kit, SortableJS) see
// real movement. A native HTML5 drag is intercepted and replayed as drag events,
// since CDP mouse moves alone never deliver dragover/drop. Returns 'dropped',
// 'refused' (HTML5 drag, target didn't accept) or null (plain mouse drag).
async function cdpDrag(tabId, p, modifiers = 0, hold = 0) {
  let data = null;
  const onEv = (src, method, params) => { if (src.tabId === tabId && method === 'Input.dragIntercepted') data = params.data; };
  chrome.debugger.onEvent.addListener(onEv);
  await cdp(tabId, 'Input.setInterceptDrags', { enabled: true }).catch(() => {});
  try {
    await mouseEv(tabId, 'mouseMoved', p.x1, p.y1, { modifiers });
    await mouseEv(tabId, 'mousePressed', p.x1, p.y1, { button: 'left', buttons: 1, clickCount: 1, modifiers });
    await sleep(Math.min(Math.max(+hold || 0, 40), 3000));
    const steps = 12;
    const at = (i) => [p.x1 + (p.x2 - p.x1) * i / steps, p.y1 + (p.y2 - p.y1) * i / steps];
    let i = 1;
    for (; i <= steps && !data; i++) {
      const [x, y] = at(i);
      await mouseEv(tabId, 'mouseMoved', x, y, { button: 'left', buttons: 1, modifiers });
      await sleep(16);
    }
    if (!data) {
      await sleep(60);
      await mouseEv(tabId, 'mouseReleased', p.x2, p.y2, { button: 'left', buttons: 0, clickCount: 1, modifiers });
      return null;
    }
    const drag = (type, x, y) => cdp(tabId, 'Input.dispatchDragEvent', { type, x, y, data, modifiers });
    await drag('dragEnter', ...at(i - 1));
    for (; i <= steps; i++) { await drag('dragOver', ...at(i)); await sleep(16); }
    await drag('dragOver', p.x2, p.y2);
    await sleep(60);
    let res = 'dropped';
    await drag('drop', p.x2, p.y2).catch(() => { res = 'refused'; });
    await mouseEv(tabId, 'mouseReleased', p.x2, p.y2, { button: 'left', buttons: 0, clickCount: 1, modifiers });
    return res;
  } finally {
    chrome.debugger.onEvent.removeListener(onEv);
    await cdp(tabId, 'Input.setInterceptDrags', { enabled: false }).catch(() => {});
  }
}

// Page JS through the DevTools protocol: no CSP / Trusted Types limits.
const SER = `(v) => {
  if (v === undefined) return 'undefined';
  if (typeof v === 'function') return String(v).slice(0, 500);
  if (v instanceof Node) return (v.outerHTML || v.textContent || String(v)).slice(0, 4000);
  try { const s = JSON.stringify(v, (k, x) => (x instanceof Node ? '<' + x.nodeName.toLowerCase() + '>' : x), 1); return s === undefined ? String(v) : s; }
  catch { return String(v); }
}`;
async function jsCdp(tabId, code) {
  const run = (body) => cdp(tabId, 'Runtime.evaluate', {
    expression: `(async () => { const ser = ${SER}; return ser(await (async () => ${body})()); })()`,
    awaitPromise: true, returnByValue: true, userGesture: true,
  });
  let out = await run(`(${code}\n)`);
  if (out.exceptionDetails && /SyntaxError/.test(out.exceptionDetails.exception?.description || '')) out = await run(`{${code}\n}`);
  if (out.exceptionDetails) return { err: out.exceptionDetails.exception?.description || out.exceptionDetails.text };
  return { ok: out.result?.value ?? 'undefined' };
}

// Real clipboard + ⌘V/Ctrl+V: a trusted paste for pages that ignore synthetic
// ones. Focus emulation lets the page write the clipboard while the panel has focus.
async function clipboardPaste(tabId, html, text) {
  await cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  try {
    const items = { 'text/plain': text, ...(html ? { 'text/html': html } : {}) };
    const out = await cdp(tabId, 'Runtime.evaluate', {
      expression: `navigator.clipboard.write([new ClipboardItem(Object.fromEntries(Object.entries(${JSON.stringify(items)}).map(([t, v]) => [t, new Blob([v], { type: t })])))]).then(() => 1)`,
      awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (out.exceptionDetails) throw new Error('Clipboard write failed: ' + (out.exceptionDetails.exception?.description || out.exceptionDetails.text));
    await cdpKeys(tabId, MAC ? 'Meta+v' : 'Control+v');
  } finally {
    cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
  }
}

// Paste text / markdown / HTML at the caret (or into a ref). Synthetic paste
// first (keeps the user's clipboard), then the real clipboard if the page ignored it.
async function pasteContent(id, a = {}) {
  const html = a.html != null ? String(a.html) : a.markdown != null ? mdToHtml(a.markdown) : null;
  const text = a.text != null ? String(a.text) : html ? htmlToText(html) : '';
  if (!text && !html) throw new Error('paste needs text, markdown or html');
  if (!a.clipboard) {
    const r = await cs(id, 'paste', { ref: a.ref, selector: a.selector, html, text });
    if (!r) throw new Error('Page is navigating; try again.');
    if (!r.unhandled) return r.text;
  }
  await cs(id, 'keyPrep', { ref: a.ref });
  await clipboardPaste(id, html, text);
  return `Pasted ${html ? 'formatted ' : ''}text (${text.length} chars) through the clipboard` + ((await cs(id, 'settle', 80, 900)) || '');
}

// Run a function in a tab's top frame (or given frames) and return its result.
async function page(tabId, func, args = [], world = 'ISOLATED', frameIds) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: frameIds ? { tabId, frameIds } : { tabId }, func, args, world });
    return r?.result;
  } catch (e) { const f = friendly(e); if (f) throw f; return null; }
}

// ── Checklist: requirement tracking for long, multi-part tasks ──
let checklist = [];
const MARK = { todo: '○', done: '✓', failed: '✗' };
// "id: text", a bare string (numbered), or { id, text }.
function item(x, i) {
  if (typeof x !== 'string') return { id: String(x?.id ?? i + 1), text: String(x?.text ?? x?.id ?? '') };
  const m = x.match(/^\s*([\w.-]{1,24})\s*:\s*(.+)$/);
  return m ? { id: m[1], text: m[2] } : { id: String(i + 1), text: x };
}
function applyChecklist(a = {}) {
  if (Array.isArray(a.set)) checklist = a.set.map(item).map((x) => ({ ...x, status: 'todo', note: '' }));
  if (Array.isArray(a.add)) for (const x of a.add) checklist.push({ ...item(x, checklist.length), status: 'todo', note: '' });
  // A note is evidence for one item; on a bulk update it would be copied onto every row.
  const noteFor = (ids, status) => a.note && ((ids?.length === 1) || (status === 'failed' && !a.done?.length));
  const mark = (ids, status) => {
    const miss = [];
    for (const id of ids || []) {
      const it = checklist.find((x) => x.id === String(id));
      if (it) { it.status = status; if (noteFor(ids, status)) it.note = a.note; } else miss.push(id);
    }
    return miss;
  };
  return [...mark(a.done, 'done'), ...mark(a.failed, 'failed'), ...mark(a.todo, 'todo')];
}
function checklistText(miss = []) {
  const n = (st) => checklist.filter((x) => x.status === st).length;
  const head = `Checklist: ${n('done')}/${checklist.length} done${n('failed') ? `, ${n('failed')} failed` : ''}${n('todo') ? `, ${n('todo')} to do` : ''}`;
  const rows = checklist.map((x) => `${MARK[x.status]} ${x.id}: ${x.text}${x.note ? ` — ${x.note}` : ''}`);
  return [head, ...rows, ...(miss.length ? [`Unknown ids: ${miss.join(', ')}`] : [])].join('\n');
}
// Rebuild from a saved chat's checklist calls.
export function restoreChecklist(messages = []) {
  checklist = [];
  for (const m of messages) for (const tc of m.tool_calls || []) {
    if (tc.function?.name !== 'checklist') continue;
    try { applyChecklist(JSON.parse(tc.function.arguments || '{}')); } catch {}
  }
}

// ── Helpers ──
async function resolveTab(a = {}) {
  if (a.tab_id != null) {
    const id = +a.tab_id;
    await chrome.tabs.get(id).catch(() => { throw new Error(`No tab ${id}. Call tabs_list.`); });
    agent.tabId = id;
    return id;
  }
  if (agent.tabId != null) {
    const ok = await chrome.tabs.get(agent.tabId).catch(() => null);
    if (ok) return agent.tabId;
  }
  const [t] = await chrome.tabs.query({ active: true, windowId: agent.windowId ?? undefined });
  if (!t) throw new Error('No active tab.');
  agent.tabId = t.id;
  return t.id;
}

function toUrl(s) {
  s = String(s || '').trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s)) return 'http://' + s;
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(s)) return 'https://' + s;
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);
}

async function quickSnapshot(tabId, maxChars = 9000) {
  try {
    const s = await cs(tabId, 'snapshot', { mode: 'interactive', maxChars });
    return s ? `\n\nPage now:\n${s}` : '';
  } catch (e) { return `\n\n(${e.message})`; }
}

// After an input action: if it kicked off a navigation, wait for DOM ready and
// hand back a fresh snapshot — saves the model a whole round trip.
async function afterAction(tabId, t0, text) {
  if (!navStartedSince(tabId, t0)) {
    await sleep(0);
    if (!navStartedSince(tabId, t0)) return text;
  }
  await waitNav(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return `${text}\nPage navigated → ${tab?.title || ''} — ${tab?.url || ''}` + (await quickSnapshot(tabId));
}

function blobToDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}

function fmtTab(t, cur) {
  const flags = [t.id === cur ? 'current' : '', t.active ? 'active' : '', t.pinned ? 'pinned' : '', t.audible ? 'audible' : '', t.groupId > 0 ? `group:${t.groupId}` : '']
    .filter(Boolean).join(',');
  return `[${t.id}]${flags ? ` (${flags})` : ''} ${clip(t.title || '', 70)} — ${clip(t.url || t.pendingUrl || '', 90)}`;
}

const ago = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};

// ── Tool schema (kept terse: every token here is latency) ──
const ref = { type: 'string', description: 'Element ref from read_page/find, e.g. "e12"' };
const tabId = { type: 'integer', description: 'Target tab (default: current tab)' };
const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

export const TOOLS = [
  fn('tabs_list', 'List open tabs across windows with ids, titles, URLs.'),
  fn('tab_open', 'Open a new tab. Returns its id and an interactive snapshot.', {
    url: { type: 'string', description: 'URL or search terms' },
    active: { type: 'boolean', description: 'Focus it and make it the current tab (default true)' },
  }, ['url']),
  fn('tab_switch', 'Focus a tab and make it the current tab.', { tab_id: tabId }, ['tab_id']),
  fn('tab_close', 'Close tabs.', { tab_ids: { type: 'array', items: { type: 'integer' } } }, ['tab_ids']),
  fn('tab_group', 'Group tabs (or ungroup with ungroup=true).', {
    tab_ids: { type: 'array', items: { type: 'integer' } },
    title: { type: 'string' },
    color: { type: 'string', enum: ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] },
    collapsed: { type: 'boolean' },
    ungroup: { type: 'boolean' },
  }, ['tab_ids']),
  fn('navigate', 'Navigate the current tab. Returns an interactive snapshot of the new page.', {
    url: { type: 'string', description: 'URL, search terms, or "back" / "forward" / "reload"' },
    tab_id: tabId,
  }, ['url']),
  fn('read_page', 'Snapshot of the page: interactive elements with refs (plus headings/text in mode=all). "·off" = outside viewport.', {
    mode: { type: 'string', enum: ['interactive', 'all'], description: 'default interactive' },
    viewport_only: { type: 'boolean' },
    tab_id: tabId,
  }),
  fn('get_text', 'Plain text content of the page (for reading/summarizing).', {
    selector: { type: 'string', description: 'Limit to an element' },
    max_chars: { type: 'integer' },
    tab_id: tabId,
  }),
  fn('find', 'Find elements by visible text/label. Returns refs. Query with the label words themselves ("Playfair Display"), not a description.', { query: { type: 'string' }, tab_id: tabId }, ['query']),
  fn('click', 'Click by ref (preferred), CSS selector, or viewport x/y (only for canvas content with no ref). Result lists elements that newly appeared (menus, dialogs) with refs.', {
    ref, selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' },
    clicks: { type: 'integer', description: '2 = double-click, 3 = triple-click (selects a paragraph)' },
    modifiers: { type: 'string', description: 'Held keys, e.g. "shift" to extend a selection' }, tab_id: tabId,
  }),
  fn('type', 'Type text in one go. With ref: into that field, replacing its text unless clear=false. Without ref: at the current caret/focus without clearing (rich editors like Google Docs — click into them first).', {
    ref, selector: { type: 'string' }, text: { type: 'string' },
    clear: { type: 'boolean' }, submit: { type: 'boolean', description: 'Press Enter after' }, tab_id: tabId,
  }, ['text']),
  fn('key', 'Press keys on the focused element. Space-separated combos; "*N" repeats, e.g. "Enter", "Meta+a Backspace", "Shift+ArrowRight*5", "ArrowDown*3 Enter". Use type for text.', {
    keys: { type: 'string' }, ref, tab_id: tabId,
  }, ['keys']),
  fn('paste', 'Paste text, markdown or HTML at the caret (or into ref) in one step, keeping formatting: headings, lists, links, bold, tables (markdown "||" merges a cell into the previous one), images by URL. Best way to put long or formatted text into rich editors.', {
    markdown: { type: 'string' }, html: { type: 'string' }, text: { type: 'string', description: 'Plain text' }, ref,
    clipboard: { type: 'boolean', description: 'Force the real clipboard + paste shortcut' }, tab_id: tabId,
  }),
  fn('menu', 'Click through a menu path by visible labels in one call, e.g. ["Format","Paragraph styles","Title"]. Opens menus and submenus in order; returns what is on screen after the last click.', {
    path: { type: 'array', items: { type: 'string' } }, tab_id: tabId,
  }, ['path']),
  fn('drag', 'Drag from ref or x/y to to_ref or to_x/to_y. Handles drag-and-drop (kanban cards, sortable lists, file trees, draggable items) as well as plain mouse drags: selecting text or table cells, sliders, resizing, panning.', {
    ref, x: { type: 'number' }, y: { type: 'number' }, to_ref: { type: 'string' }, to_x: { type: 'number' }, to_y: { type: 'number' },
    to_position: { type: 'string', enum: ['center', 'top', 'bottom', 'left', 'right'], description: 'Where on to_ref to drop (default center). top/bottom drops before/after an item in a list.' },
    hold: { type: 'integer', description: 'Ms to hold the press before moving, for long-press-to-drag UIs' },
    modifiers: { type: 'string' }, tab_id: tabId,
  }),
  fn('scroll', 'Scroll the page (or the scrollable area under center), or bring a ref into view.', {
    direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom', 'left', 'right'] },
    amount: { type: 'integer', description: 'Pixels (default ~1 screen)' },
    ref, tab_id: tabId,
  }),
  fn('hover', 'Hover an element (menus, tooltips).', { ref, tab_id: tabId }, ['ref']),
  fn('select_option', 'Choose an option in a native <select>.', { ref, value: { type: 'string', description: 'Option value or label' }, tab_id: tabId }, ['ref', 'value']),
  fn('screenshot', 'Capture the viewport. Clickable elements are boxed and tagged with their refs (listed in the result) — click those by ref. Edge rulers mark every 100px for x/y.', {
    labels: { type: 'boolean', description: 'Ref tags and rulers (default true)' }, tab_id: tabId,
  }),
  fn('run_js', 'Run JavaScript in the page (main world). Expression or statements; use `return` for statements. Async ok. Returns JSON.', {
    code: { type: 'string' }, frame: { type: 'string', description: 'Run inside an iframe: part of its URL/host (cross-origin ok)' }, tab_id: tabId,
  }, ['code']),
  fn('bookmarks', 'Bookmarks: search, recent, tree, create (omit url for folder), or remove.', {
    action: { type: 'string', enum: ['search', 'recent', 'tree', 'create', 'remove'] },
    query: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' },
    parent_id: { type: 'string', description: 'Folder id for create, or subtree root for tree' },
    id: { type: 'string', description: 'For remove' },
  }, ['action']),
  fn('history_search', 'Search browsing history.', {
    query: { type: 'string', description: 'Empty for recent' }, days: { type: 'integer', description: 'Look back (default 30)' },
    max_results: { type: 'integer' },
  }),
  fn('checklist', 'Track a multi-part task\'s requirements. set once at the start, then mark ids done/failed as you verify them (note = evidence). Base the final report on it.', {
    set: { type: 'array', items: { type: 'string' }, description: 'One "id: requirement" per item' },
    done: { type: 'array', items: { type: 'string' } }, failed: { type: 'array', items: { type: 'string' } }, note: { type: 'string' },
  }),
  fn('wait', 'Wait for text/selector to appear (preferred) or a fixed time.', {
    text: { type: 'string' }, selector: { type: 'string' }, ms: { type: 'integer', description: 'Fixed wait, max 5000' },
    timeout_ms: { type: 'integer' }, tab_id: tabId,
  }),
];

// Core tools, plus site packs (e.g. Google Docs) only when active.
export const toolsFor = (vision, packIds = []) => [
  ...(vision ? TOOLS : TOOLS.filter((t) => t.function.name !== 'screenshot')),
  ...PACKS.filter((p) => packIds.includes(p.id)).flatMap((p) => p.tools),
];

// Short label while a tool runs.
export function preLabel(name, a = {}) {
  const q = (s) => `“${clip(String(s ?? ''), 40)}”`;
  switch (name) {
    case 'tabs_list': return 'Checking tabs';
    case 'tab_open': return `Opening ${hostOf(toUrl(a.url))}`;
    case 'tab_switch': return 'Switching tab';
    case 'tab_close': return `Closing ${a.tab_ids?.length || ''} tab${a.tab_ids?.length === 1 ? '' : 's'}`;
    case 'tab_group': return a.ungroup ? 'Ungrouping tabs' : `Grouping tabs${a.title ? ' ' + q(a.title) : ''}`;
    case 'navigate': return /^(back|forward|reload)$/i.test(a.url) ? `Going ${a.url}` : `Going to ${hostOf(toUrl(a.url))}`;
    case 'read_page': return 'Reading page';
    case 'get_text': return 'Reading text';
    case 'find': return `Finding ${q(a.query)}`;
    case 'click': return 'Clicking';
    case 'type': return `Typing ${q(a.text)}`;
    case 'drag': return 'Dragging';
    case 'key': return `Pressing ${a.keys}`;
    case 'scroll': return a.ref ? 'Scrolling into view' : `Scrolling ${a.direction || 'down'}`;
    case 'hover': return 'Hovering';
    case 'select_option': return `Selecting ${q(a.value)}`;
    case 'screenshot': return 'Taking screenshot';
    case 'run_js': return 'Running JavaScript';
    case 'bookmarks': return { search: `Searching bookmarks ${q(a.query)}`, recent: 'Recent bookmarks', tree: 'Reading bookmarks', create: `Bookmarking ${q(a.title)}`, remove: 'Removing bookmark' }[a.action] || 'Bookmarks';
    case 'history_search': return a.query ? `Searching history ${q(a.query)}` : 'Recent history';
    case 'wait': return a.text || a.selector ? `Waiting for ${q(a.text || a.selector)}` : `Waiting ${a.ms || 500}ms`;
    case 'paste': return 'Pasting';
    case 'menu': return `Menu ${q((a.path || []).join(' › '))}`;
    case 'checklist': return 'Updating checklist';
    default: return packOf(name)?.preLabel?.(name, a) || name;
  }
}

// ── Execution ──
export async function exec(name, a = {}) {
  const t0 = performance.now();
  switch (name) {
    case 'tabs_list': {
      const tabs = await chrome.tabs.query({});
      const byWin = new Map();
      for (const t of tabs) (byWin.get(t.windowId) || byWin.set(t.windowId, []).get(t.windowId)).push(t);
      const out = [];
      for (const [w, list] of byWin) {
        out.push(`Window ${w}${w === agent.windowId ? ' (this window)' : ''}:`);
        for (const t of list) out.push('  ' + fmtTab(t, agent.tabId));
      }
      return { text: out.join('\n'), label: `Found ${tabs.length} tabs` };
    }

    case 'tab_open': {
      const url = toUrl(a.url);
      const active = a.active !== false;
      const tab = await chrome.tabs.create({ url, active, windowId: agent.windowId ?? undefined });
      const wait = loaded(tab.id);
      const fresh = await chrome.tabs.get(tab.id);
      if (fresh.status === 'complete') wait.cancel();
      await wait;
      if (active) agent.tabId = tab.id;
      const t = await chrome.tabs.get(tab.id);
      return {
        text: `Opened tab [${tab.id}] ${t.title || ''} — ${t.url || url}${active ? ' (now current)' : ''}` + (active ? await quickSnapshot(tab.id) : ''),
        label: `Opened ${hostOf(t.url || url)}`,
      };
    }

    case 'tab_switch': {
      const id = +a.tab_id;
      const t = await chrome.tabs.update(id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
      agent.tabId = id;
      return { text: `Current tab is now [${id}] ${t.title} — ${t.url}`, label: `Switched to “${clip(t.title, 32)}”` };
    }

    case 'tab_close': {
      const ids = (a.tab_ids || []).map(Number);
      await chrome.tabs.remove(ids);
      if (ids.includes(agent.tabId)) {
        agent.tabId = null;
        await resolveTab();
      }
      return { text: `Closed ${ids.length} tab(s). Current tab: ${agent.tabId}`, label: `Closed ${ids.length} tab${ids.length === 1 ? '' : 's'}` };
    }

    case 'tab_group': {
      const ids = (a.tab_ids || []).map(Number);
      if (a.ungroup) { await chrome.tabs.ungroup(ids); return { text: `Ungrouped ${ids.length} tabs`, label: `Ungrouped ${ids.length} tabs` }; }
      const gid = await chrome.tabs.group({ tabIds: ids });
      const upd = {};
      if (a.title) upd.title = a.title;
      if (a.color) upd.color = a.color;
      if (a.collapsed != null) upd.collapsed = !!a.collapsed;
      if (Object.keys(upd).length) await chrome.tabGroups.update(gid, upd);
      return { text: `Group ${gid} with ${ids.length} tabs`, label: `Grouped ${ids.length} tabs${a.title ? ` as “${a.title}”` : ''}` };
    }

    case 'navigate': {
      const id = await resolveTab(a);
      const word = String(a.url).toLowerCase().trim();
      const special = word === 'back' || word === 'forward' || word === 'reload';
      const wait = loaded(id, special && word !== 'reload' ? 2500 : 8000);
      if (word === 'back') await chrome.tabs.goBack(id).catch((e) => { wait.cancel(); throw e; });
      else if (word === 'forward') await chrome.tabs.goForward(id).catch((e) => { wait.cancel(); throw e; });
      else if (word === 'reload') await chrome.tabs.reload(id);
      else await chrome.tabs.update(id, { url: toUrl(a.url) });
      await wait;
      const t = await chrome.tabs.get(id);
      return {
        text: `Now at ${t.title || ''} — ${t.url}` + (await quickSnapshot(id)),
        label: special ? `Went ${word}` : `Went to ${hostOf(t.url)}`,
      };
    }

    case 'read_page': {
      const id = await resolveTab(a);
      const s = await cs(id, 'snapshot', { mode: a.mode || 'interactive', viewportOnly: !!a.viewport_only });
      const tab = await chrome.tabs.get(id);
      return { text: s ?? 'Page is navigating; try again.', label: `Read ${hostOf(tab.url)}` };
    }

    case 'get_text': {
      const id = await resolveTab(a);
      const s = await cs(id, 'text', { maxChars: a.max_chars || 15000, selector: a.selector });
      const tab = await chrome.tabs.get(id);
      return { text: s ?? 'Page is navigating; try again.', label: `Read text of ${hostOf(tab.url)}` };
    }

    case 'find': {
      const id = await resolveTab(a);
      const s = await cs(id, 'find', { query: a.query });
      const n = /^No matches/.test(s) ? 0 : s.split('\n').length;
      return { text: s, label: `Found ${n} match${n === 1 ? '' : 'es'} for “${clip(a.query, 30)}”` };
    }

    case 'click': {
      const id = await resolveTab(a);
      let text;
      if (agent.trusted) {
        const p = await cs(id, 'point', a);
        if (!p) throw new Error('Page is navigating; try again.');
        await cdpClick(id, p.x, p.y, Math.max(1, Math.min(3, +a.clicks || (a.double ? 2 : 1))), mouseMods(a.modifiers));
        text = `Clicked ${p.desc}` + ((await cs(id, 'settle')) || '');
      } else {
        text = (await cs(id, 'click', a)) ?? 'Clicked (page navigated)';
      }
      return { text: await afterAction(id, t0, text), label: firstLine(text).replace(/ \(warning.*$/, '') };
    }

    case 'drag': {
      const id = await resolveTab(a);
      let text;
      if (agent.trusted) {
        const p = await cs(id, 'dragPoints', a);
        if (!p) throw new Error('Page is navigating; try again.');
        const how = await cdpDrag(id, p, mouseMods(a.modifiers), a.hold);
        const note = how === 'dropped' ? ' (drag-and-drop: dropped)' : how === 'refused' ? ' (drag-and-drop: target did not accept the drop)' : '';
        text = `Dragged ${p.desc}${note}` + ((await cs(id, 'settle')) || '');
      } else text = (await cs(id, 'drag', a)) ?? 'Dragged (page navigated)';
      return { text: await afterAction(id, t0, text), label: firstLine(text) };
    }

    case 'type': {
      const id = await resolveTab(a);
      let text;
      if (agent.trusted) {
        const f = await cs(id, 'prepField', a);
        if (!f) throw new Error('Page is navigating; try again.');
        // insertText replaces the selection, so Backspace is only for clearing to empty.
        // Rich editors get Enter between lines (a raw "\n" may not make a paragraph).
        const parts = f.plain ? [String(a.text)] : String(a.text).split('\n');
        for (let i = 0; i < parts.length; i++) {
          if (i) await cdpKeys(id, 'Enter');
          if (parts[i]) await cdp(id, 'Input.insertText', { text: parts[i] });
        }
        if (!a.text && f.cleared) await cdpKeys(id, 'Backspace');
        if (a.submit) await cdpKeys(id, 'Enter');
        text = `Typed "${clip(String(a.text), 60)}" into ${f.desc}${a.submit ? ' and pressed Enter' : ''}` + ((await cs(id, 'settle')) || '');
      } else {
        text = (await cs(id, 'type', a)) ?? 'Typed (page navigated)';
      }
      return { text: await afterAction(id, t0, text), label: firstLine(text) };
    }

    case 'key': {
      const id = await resolveTab(a);
      let text;
      if (agent.trusted) {
        await cs(id, 'keyPrep', { ref: a.ref });
        await cdpKeys(id, String(a.keys));
        text = `Pressed ${String(a.keys).trim()}` + ((await cs(id, 'settle')) || '');
      } else text = (await cs(id, 'key', a)) ?? `Pressed ${a.keys}`;
      return { text: await afterAction(id, t0, text), label: clip(firstLine(text), 80) };
    }

    case 'scroll': {
      const id = await resolveTab(a);
      const s = await cs(id, 'scroll', a);
      return { text: s, label: a.ref ? firstLine(s) : `Scrolled ${a.direction || 'down'}` };
    }

    case 'hover': {
      const id = await resolveTab(a);
      let s;
      if (agent.trusted) {
        const p = await cs(id, 'point', { ...a, hover: true });
        if (!p) throw new Error('Page is navigating; try again.');
        await mouseEv(id, 'mouseMoved', p.x, p.y, {});
        s = `Hovered ${p.desc}` + ((await cs(id, 'settle')) || '');
      } else s = await cs(id, 'hover', a);
      return { text: s, label: firstLine(s) };
    }

    case 'select_option': {
      const id = await resolveTab(a);
      const s = await cs(id, 'selectOption', a);
      return { text: await afterAction(id, t0, s), label: firstLine(s) };
    }

    case 'screenshot': {
      const id = await resolveTab(a);
      const tab = await chrome.tabs.get(id);
      if (!tab.active) { await chrome.tabs.update(id, { active: true }); await sleep(150); }
      const prep = await cs(id, 'capturePrep', { labels: a.labels !== false }).catch(() => null);
      const vp = prep?.vp;
      let raw;
      try { raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 }); }
      finally { if (prep) cs(id, 'captureDone').catch(() => {}); }
      const bmp = await createImageBitmap(await (await fetch(raw)).blob());
      const w = Math.min(vp?.w || bmp.width, 1280, bmp.width);
      const h = Math.round(bmp.height * (w / bmp.width));
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      const image = await blobToDataURL(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 }));
      const k = vp ? vp.w / w : 1;
      return {
        text: `Screenshot of ${tab.title} (${w}×${h}). ` + (Math.abs(k - 1) < 0.01 ? 'Image pixels = viewport coords for click x/y.' : `Multiply image coords by ${k.toFixed(3)} for click x/y.`) +
          (prep?.legend ? `\nTagged elements:\n${prep.legend}` : ''),
        image, label: 'Took screenshot',
      };
    }

    case 'run_js': {
      const id = await resolveTab(a);
      const code = String(a.code || '');
      let frameIds;
      if (a.frame) {
        const want = String(a.frame).toLowerCase();
        const frames = (await chrome.webNavigation.getAllFrames({ tabId: id })) || [];
        const f = frames.find((x) => x.frameId !== 0 && (String(x.frameId) === want || x.url.toLowerCase().includes(want)));
        if (!f) throw new Error(`No frame matches "${a.frame}". Frames: ${frames.filter((x) => x.frameId).map((x) => clip(x.url, 80)).join(' | ') || 'none'}`);
        frameIds = [f.frameId];
      }
      // Trusted mode already holds the debugger: evaluate there first (no CSP/Trusted Types).
      let r = null, cdpErr = null;
      if (agent.trusted && !frameIds) r = await jsCdp(id, code).catch((e) => { cdpErr = e; return null; });
      if (!r) {
        try {
          [{ result: r } = {}] = await chrome.scripting.executeScript({
            target: frameIds ? { tabId: id, frameIds } : { tabId: id }, world: 'MAIN', args: [code],
            func: async (code) => {
              const ser = (v) => {
                if (v === undefined) return 'undefined';
                if (typeof v === 'function') return String(v).slice(0, 500);
                if (v instanceof Node) return (v.outerHTML || v.textContent || String(v)).slice(0, 4000);
                try { const s = JSON.stringify(v, (k, x) => (x instanceof Node ? `<${x.nodeName.toLowerCase()}>` : x), 1); return s === undefined ? String(v) : s; }
                catch { return String(v); }
              };
              let f;
              try { f = new Function(`return (async () => (${code}\n))()`); }
              catch (e) {
                if (e instanceof SyntaxError) {
                  try { f = new Function(`return (async () => {${code}\n})()`); }
                  catch (e2) { return e2 instanceof SyntaxError ? { err: 'SyntaxError: ' + e2.message } : { csp: 1 }; }
                } else return { csp: 1 };
              }
              try { return { ok: ser(await f()) }; } catch (e) { return { err: String(e?.stack || e).slice(0, 1500) }; }
            },
          });
        } catch (e) { const f = friendly(e); if (f) throw f; }
        if (r?.csp && frameIds) throw new Error('That frame blocks eval (CSP); run_js without frame can still reach same-origin frames.');
        if (r?.csp) {
          // Page CSP blocks eval — fall back to the DevTools protocol.
          if (cdpErr) throw new Error(`Page blocks eval and DevTools failed: ${cdpErr.message}`);
          r = await jsCdp(id, code);
          if (!agent.trusted) await detach(id);
        }
      }
      if (r?.err) throw new Error(r.err);
      return { text: await afterAction(id, t0, clip(r?.ok ?? 'undefined', 12000)), label: 'Ran JavaScript' };
    }

    case 'bookmarks': {
      const fmt = (b) => `[${b.id}] ${clip(b.title || '(untitled)', 70)}${b.url ? ' — ' + clip(b.url, 90) : ' (folder)'}`;
      switch (a.action) {
        case 'search': {
          const res = (await chrome.bookmarks.search(a.query || '')).slice(0, 40);
          return { text: res.map(fmt).join('\n') || 'No bookmarks found.', label: `Found ${res.length} bookmark${res.length === 1 ? '' : 's'}` };
        }
        case 'recent': {
          const res = await chrome.bookmarks.getRecent(25);
          return { text: res.map(fmt).join('\n') || 'No bookmarks.', label: 'Read recent bookmarks' };
        }
        case 'tree': {
          const roots = a.parent_id ? await chrome.bookmarks.getSubTree(a.parent_id) : await chrome.bookmarks.getTree();
          const out = [];
          const walk = (n, d) => {
            if (out.length > 400) return;
            if (n.title || n.url) out.push('  '.repeat(d) + fmt(n));
            for (const c of n.children || []) walk(c, d + (n.title ? 1 : 0));
          };
          roots.forEach((r) => walk(r, 0));
          return { text: clip(out.join('\n'), 14000) || 'Empty.', label: 'Read bookmarks' };
        }
        case 'create': {
          const b = await chrome.bookmarks.create({ title: a.title, url: a.url ? toUrl(a.url) : undefined, parentId: a.parent_id });
          return { text: `Created ${fmt(b)}`, label: `Bookmarked “${clip(b.title, 30)}”` };
        }
        case 'remove': {
          await chrome.bookmarks.remove(String(a.id));
          return { text: `Removed bookmark ${a.id}`, label: 'Removed bookmark' };
        }
      }
      throw new Error('Unknown bookmarks action');
    }

    case 'history_search': {
      const res = await chrome.history.search({
        text: a.query || '', maxResults: Math.min(a.max_results || 30, 100),
        startTime: Date.now() - (a.days || 30) * 864e5,
      });
      const text = res.map((h) => `${clip(h.title || '(untitled)', 70)} — ${clip(h.url, 90)} · ${ago(h.lastVisitTime)} · ${h.visitCount} visits`).join('\n');
      return { text: text || 'No history matches.', label: `Found ${res.length} history item${res.length === 1 ? '' : 's'}` };
    }

    case 'paste': {
      const id = await resolveTab(a);
      const text = await pasteContent(id, a);
      return { text: await afterAction(id, t0, text), label: firstLine(text) };
    }

    case 'menu': {
      const id = await resolveTab(a);
      const path = (Array.isArray(a.path) ? a.path : String(a.path || '').split(/\s*[>›]\s*/)).map(String).filter(Boolean);
      if (!path.length) throw new Error('menu needs a path');
      let diff = '';
      for (let i = 0; i < path.length; i++) {
        let p;
        try { p = await cs(id, 'menuFind', { label: path[i] }); }
        catch (e) {
          // Don't leave half-opened menus behind: they swallow the next keys and clicks.
          if (i) await (agent.trusted ? cdpKeys(id, `Escape*${i}`) : cs(id, 'key', { keys: `Escape*${i}` })).catch(() => {});
          throw new Error(`${e.message}${i ? ` (closed the menu after “${path.slice(0, i).join(' › ')}”)` : ''}`);
        }
        if (!p) throw new Error('Page is navigating; try again.');
        if (agent.trusted) {
          await mouseEv(id, 'mouseMoved', p.x, p.y, {});
          await cdpClick(id, p.x, p.y);
        } else await cs(id, 'click', { ref: p.ref });
        // Submenus open on hover/click; wait until the DOM settles before the next label.
        diff = (await cs(id, 'settle', 60, i === path.length - 1 ? 700 : 450)) || '';
      }
      const text = `Clicked ${path.join(' › ')}` + diff;
      return { text: await afterAction(id, t0, text), label: `Clicked ${clip(path.join(' › '), 70)}` };
    }

    case 'checklist': {
      const miss = applyChecklist(a);
      const text = checklistText(miss);
      return { text, label: firstLine(text) };
    }

    case 'wait': {
      if (a.text || a.selector) {
        const id = await resolveTab(a);
        const s = await cs(id, 'waitFor', { text: a.text, selector: a.selector, timeout: a.timeout_ms || 5000 });
        return { text: s, label: s };
      }
      const ms = Math.min(+a.ms || 500, 5000);
      await sleep(ms);
      return { text: `Waited ${ms}ms`, label: `Waited ${ms}ms` };
    }
  }
  const pack = packOf(name);
  if (pack) return pack.exec(name, a, API);
  throw new Error(`Unknown tool ${name}`);
}

// What site packs get to work with.
const API = {
  agent, MAC, sleep, clip, resolveTab, cs, cdp, page, afterAction, exec,
  keys: cdpKeys, click: cdpClick, mouseEv, paste: pasteContent, mdToHtml, htmlToText,
  insertText: (tabId, text) => cdp(tabId, 'Input.insertText', { text }),
};

export async function overlayOff() {
  const ids = [...agent.touched];
  agent.touched.clear();
  await Promise.all(ids.map((tabId) => chrome.scripting.executeScript({
    target: { tabId }, func: () => window.__tuff?.overlay(false),
  }).catch(() => {})));
}

export async function currentTabInfo() {
  try {
    const id = await resolveTab();
    const t = await chrome.tabs.get(id);
    return t;
  } catch { return null; }
}
