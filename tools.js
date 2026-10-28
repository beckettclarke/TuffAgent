// Browser tools. Everything here runs in the side panel and talks to Chrome
// APIs directly, so each action is a single round trip.
import { CAN_DEBUG, FIREFOX } from './compat.js';
import './keys.js';
import { mdToHtml, htmlToText } from './docmd.js';
import { PACKS, packOf, packsForUrl } from './sites/index.js';

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
// Single-page apps change the URL without loading a page.
const spaNav = (d) => {
  if (d.frameId !== 0) return;
  const n = nav.get(d.tabId) || { waiters: [] };
  n.spa = { at: performance.now(), url: d.url };
  nav.set(d.tabId, n);
};
chrome.webNavigation.onHistoryStateUpdated.addListener(spaNav);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(spaNav);

// Tabs the page opens itself (target=_blank links, window.open) while an action runs.
const opened = [];
chrome.tabs.onCreated.addListener((t) => {
  opened.push({ id: t.id, opener: t.openerTabId, windowId: t.windowId, at: performance.now() });
  if (opened.length > 20) opened.shift();
});

function navStartedSince(tabId, t0) {
  const n = nav.get(tabId);
  return !!(n?.pending && n.at >= t0);
}
function waitNav(tabId, timeout = 8000) {
  const n = nav.get(tabId);
  if (!n?.pending) return Promise.resolve();
  return new Promise((r) => { n.waiters.push(r); setTimeout(r, timeout); });
}
// For actions we trigger ourselves (open/navigate): listen before acting. A
// same-document navigation (#hash, pushState) has no DOMContentLoaded, so it counts too.
function loaded(tabId, timeout = 8000) {
  let off;
  const p = new Promise((res) => {
    const f = (d) => { if ((d.tabId ?? d) === tabId && (d.frameId ?? 0) === 0) done(); };
    const u = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, timeout);
    const evs = [chrome.webNavigation.onDOMContentLoaded, chrome.webNavigation.onErrorOccurred,
      chrome.webNavigation.onReferenceFragmentUpdated, chrome.webNavigation.onHistoryStateUpdated];
    function done() {
      for (const ev of evs) ev.removeListener(f);
      chrome.tabs.onUpdated.removeListener(u);
      clearTimeout(t); res();
    }
    off = done;
    for (const ev of evs) ev.addListener(f);
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
  if (FIREFOX && /Missing host permission/i.test(m))
    return new Error('TuffAgent is not allowed on this site. In Firefox, open about:addons › TuffAgent › Permissions and turn on "Access your data for all websites".');
  if (/No tab with id/i.test(m)) return new Error('That tab no longer exists. Call tabs_list.');
  if (/Frame with ID 0 was removed|frame was removed|navigated/i.test(m)) return null;
  return new Error(m);
}

// A page call that never returns (a frozen page, or an alert/confirm that
// blocks its scripts) must not hang the whole run.
const CS_TIMEOUT = 15000;
function within(p, ms) {
  let t;
  const late = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('timeout'), { late: true })), ms); });
  return Promise.race([p, late]).finally(() => clearTimeout(t));
}

async function cs(tabId, method, ...args) {
  const target = { tabId };
  const ov = agent.overlay ? 'TuffAgent is working' : null;
  // Calls that wait on purpose get their own wait on top.
  const ms = CS_TIMEOUT + (method === 'waitFor' ? Math.min(+args[0]?.timeout || 5000, 20000) : 0);
  const fx = !CAN_DEBUG;
  if (fx) watchTab(tabId);
  const call = () => within(chrome.scripting.executeScript({
    target,
    func: async (m, a, ov, fx) => {
      const t = window.__tuff;
      if (!t) return { missing: 1 };
      try { if (ov) t.overlay(true, ov); if (fx) t.guard(); return { v: await t[m](...a) }; }
      catch (e) { return { err: String(e?.message || e) }; }
    },
    args: [method, args, ov, fx],
  }), ms);
  const attempt = async () => {
    try { return (await call())[0]?.result; }
    catch (e) {
      if (!e.late) { const f = friendly(e); if (f) throw f; return null; }
      // Blocked by a JS dialog: answer it and try once more.
      if (await unblock(tabId)) return (await call().catch(() => [{ result: null }]))[0]?.result;
      throw new Error(`The page did not respond in ${ms / 1000}s (frozen or busy). Try screenshot, key Escape, or navigate.`);
    }
  };
  let res = await attempt();
  if (res?.missing) {
    try { await within(chrome.scripting.executeScript({ target, files: ['keys.js', 'content.js'] }), CS_TIMEOUT); }
    catch (e) { if (e.late) throw new Error('The page did not respond (frozen or busy).'); const f = friendly(e); if (f) throw f; return null; }
    res = await attempt();
  }
  if (ov) agent.touched.add(tabId);
  if (res == null) return null;
  if (res.err) throw new Error(res.err);
  return res.v;
}

// ── Trusted input via the DevTools protocol (opt-in; shows Chrome's debug bar) ──
const dbg = new Set();
// XHR/fetch requests in flight per attached tab: requestId → { at, key }.
const inflight = new Map();
chrome.debugger?.onDetach.addListener((s) => { dbg.delete(s.tabId); inflight.delete(s.tabId); });

// Things the page did on its own (dialogs it showed), reported with the next tool result.
const notes = [];
const note = (s) => { if (notes.length < 10) notes.push(s); };
const takeNotes = () => (notes.length ? '\n\n' + notes.splice(0).join('\n') : '');

chrome.debugger?.onEvent.addListener((src, method, p) => {
  const tabId = src.tabId;
  if (method === 'Page.javascriptDialogOpening') {
    // An open alert/confirm freezes every script on the page, ours included. Accept
    // it at once (the agent's own action raised it) and tell the model what it said.
    note(`The page showed a ${p.type} dialog: “${clip(String(p.message || '').trim(), 300)}” — TuffAgent accepted it.`);
    chrome.debugger.sendCommand(src, 'Page.handleJavaScriptDialog', { accept: true, promptText: p.defaultPrompt || '' }).catch(() => {});
    return;
  }
  const reqs = inflight.get(tabId);
  if (!reqs) return;
  if (method === 'Network.requestWillBeSent') {
    if (p.type === 'XHR' || p.type === 'Fetch') reqs.set(p.requestId, { at: performance.now(), key: String(p.request?.url || '').split(/[?#]/)[0] });
  } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') reqs.delete(p.requestId);
});

async function attach(tabId) {
  if (!CAN_DEBUG) throw new Error('This needs the DevTools protocol, which only Chrome has. Try the plain click/type/key tools instead.');
  await chrome.debugger.attach({ tabId }, '1.3').catch((e) => { if (!/already attached/i.test(e.message)) throw e; });
  dbg.add(tabId);
  inflight.set(tabId, new Map());
  // Page events answer dialogs as they open; network events let actions wait for
  // the requests they started.
  await Promise.all(['Page.enable', 'Network.enable'].map((m) => chrome.debugger.sendCommand({ tabId }, m).catch(() => {})));
}
async function cdp(tabId, method, params = {}) {
  if (!dbg.has(tabId)) await attach(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    // Detached behind our back (onDetach doesn't fire for our own detach calls): re-attach once.
    if (!/not attached/i.test(e.message)) throw e;
    dbg.delete(tabId);
    await attach(tabId);
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }
}
// Attach before measuring where to click: the first attach shows Chrome's
// debugging bar, which shrinks the viewport under the coordinates.
async function ready(tabId) {
  if (dbg.has(tabId)) return;
  const first = !dbg.size;
  await attach(tabId);
  if (first) await sleep(150);
}
async function detach(tabId) {
  dbg.delete(tabId);
  inflight.delete(tabId);
  await chrome.debugger?.detach({ tabId }).catch(() => {});
}
// A page call timed out: if a JS dialog is what froze it, answer it.
async function unblock(tabId) {
  try {
    await cdp(tabId, 'Page.enable');
    await cdp(tabId, 'Page.handleJavaScriptDialog', { accept: true });
    note('A JS dialog was blocking the page — TuffAgent accepted it.');
    return true;
  } catch { return false; }
}

// ── Firefox: no DevTools protocol, so the same jobs are done other ways ──
// The page answers its own dialogs and reports them (content.js guard()), and
// webRequest tracks the XHR/fetch requests of tabs the agent works in. Each
// action's start is the cs() call that runs it.
const guarded = new Set();
const callAt = new Map();
function watchTab(tabId) {
  guarded.add(tabId);
  callAt.set(tabId, performance.now());
  if (!inflight.has(tabId)) inflight.set(tabId, new Map());
}
if (!CAN_DEBUG) {
  const xhr = { urls: ['<all_urls>'], types: ['xmlhttprequest'] };
  chrome.webRequest?.onBeforeRequest.addListener((d) => {
    inflight.get(d.tabId)?.set(d.requestId, { at: performance.now(), key: String(d.url).split(/[?#]/)[0] });
  }, xhr);
  const end = (d) => inflight.get(d.tabId)?.delete(d.requestId);
  chrome.webRequest?.onCompleted.addListener(end, xhr);
  chrome.webRequest?.onErrorOccurred.addListener(end, xhr);
  // Every window has its own sidebar: only the one working this tab answers.
  chrome.runtime.onMessage.addListener((m, sender) => {
    const tabId = sender.tab?.id;
    if (!guarded.has(tabId)) return;
    if (m?.tuffDialog) note(`The page showed a ${m.tuffDialog.type} dialog: “${clip(m.tuffDialog.message.trim(), 300)}” — TuffAgent accepted it.`);
    else if (m?.tuffNet) return netQuiet(tabId, callAt.get(tabId) ?? 0);
  });
  chrome.tabs.onRemoved.addListener((id) => { guarded.delete(id); callAt.delete(id); inflight.delete(id); });
}

// After an action, wait for the XHR/fetch requests it started (search results,
// form posts) to finish, up to a cap. A request that outlives the cap (long
// poll, stream) is ignored from then on.
const NET_CAP = 3000;
const slowUrls = new Map();
async function netQuiet(tabId, since) {
  const reqs = inflight.get(tabId);
  if (!reqs?.size) return false;
  const skip = slowUrls.get(tabId) || new Set();
  slowUrls.set(tabId, skip);
  const now = performance.now();
  for (const [id, r] of reqs) if (now - r.at > 60000) reqs.delete(id);
  const pending = () => [...reqs.values()].filter((r) => r.at >= since && !skip.has(r.key));
  if (!pending().length) return false;
  const end = now + NET_CAP;
  while (performance.now() < end) {
    await sleep(40);
    if (!pending().length) return true;
  }
  for (const r of pending()) skip.add(r.key);
  return true;
}

// What the page shows once it has reacted to an action: the DOM goes quiet,
// then the requests the action started finish, then the DOM goes quiet again.
// Returns the "New on screen" report.
async function settleAfter(tabId, t0, quiet = 80, cap = 700) {
  if (!inflight.has(tabId)) return (await cs(tabId, 'settle', quiet, cap)) || '';
  await cs(tabId, 'quiet', quiet, cap);
  if (await netQuiet(tabId, t0)) await cs(tabId, 'quiet', 60, cap);
  return (await cs(tabId, 'changes')) || '';
}
export async function detachAll() {
  await Promise.all([...dbg].map(detach));
  if (CAN_DEBUG) return;
  const ids = [...guarded];
  guarded.clear(); callAt.clear(); inflight.clear();
  await Promise.all(ids.map((tabId) => chrome.scripting.executeScript({
    target: { tabId }, func: () => window.__tuff?.unguard(),
  }).catch(() => {})));
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

// Type like a person, one key event per character, for fields whose scripts
// listen to keydown/keyup (autocompletes, input masks, live validation). A
// character with no key on a US layout is inserted directly.
async function cdpType(tabId, text) {
  for (const ch of text) {
    const k = globalThis.TuffKeys.charKey(ch);
    if (!k.keyCode) { await cdp(tabId, 'Input.insertText', { text: ch }); continue; }
    const base = { key: ch, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.shift ? 8 : 0 };
    await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyDown', text: ch, unmodifiedText: ch });
    await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
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
    // A small first move: pointer sortables (dnd-kit, react-beautiful-dnd) only
    // start dragging past an activation distance, and need a beat to pick up.
    const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1) || 1;
    await mouseEv(tabId, 'mouseMoved', p.x1 + (p.x2 - p.x1) / len * 6, p.y1 + (p.y2 - p.y1) / len * 6, { button: 'left', buttons: 1, modifiers });
    await sleep(50);
    const steps = Math.max(8, Math.min(30, Math.round(len / 25)));
    const at = (i) => [p.x1 + (p.x2 - p.x1) * i / steps, p.y1 + (p.y2 - p.y1) * i / steps];
    let i = 1;
    for (; i <= steps && !data; i++) {
      const [x, y] = at(i);
      await mouseEv(tabId, 'mouseMoved', x, y, { button: 'left', buttons: 1, modifiers });
      await sleep(16);
    }
    if (!data) {
      // Hover at the destination so the library settles on its drop position.
      await mouseEv(tabId, 'mouseMoved', p.x2, p.y2, { button: 'left', buttons: 1, modifiers });
      await sleep(150);
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
  if (!CAN_DEBUG) return clipboardPasteFirefox(tabId, html, text);
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

// Firefox: write the clipboard from the panel, then paste with the page's own
// paste command, which the page sees as a real paste. Needs the optional
// clipboard permissions, asked for when a message is sent (sidepanel.js).
async function clipboardPasteFirefox(tabId, html, text) {
  if (!(await chrome.permissions.contains({ permissions: ['clipboardRead', 'clipboardWrite'] })))
    throw new Error('The page ignored the paste, and the clipboard fallback needs clipboard access. Ask the user to allow it (it is asked for when they send a message), or use type instead.');
  const items = { 'text/plain': new Blob([text], { type: 'text/plain' }), ...(html ? { 'text/html': new Blob([html], { type: 'text/html' }) } : {}) };
  await navigator.clipboard.write([new ClipboardItem(items)]).catch((e) => { throw new Error('Clipboard write failed: ' + e.message); });
  if (!(await cs(tabId, 'execPaste'))) throw new Error('The page refused the paste. Use type instead.');
}

// Paste text / markdown / HTML at the caret (or into a ref). Synthetic paste
// first (keeps the user's clipboard), then the real clipboard if the page ignored it.
async function pasteContent(id, a = {}) {
  const html = a.html != null ? String(a.html) : a.markdown != null ? mdToHtml(a.markdown) : null;
  const text = a.text != null ? String(a.text) : html ? htmlToText(html) : '';
  if (!text && !html) throw new Error('paste needs text, markdown or html');
  if (!a.clipboard) {
    const r = await cs(id, 'paste', { ref: a.ref, target: a.target, near: a.near, nth: a.nth, selector: a.selector, html, text });
    if (!r) throw new Error('Page is navigating; try again.');
    if (!r.unhandled) return r.text;
  }
  await cs(id, 'keyPrep', { ref: a.ref, target: a.target, near: a.near, nth: a.nth });
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

// Items not yet done or failed: the run isn't finished while there are any.
export const openChecklist = () => checklist.filter((x) => x.status === 'todo');

// ── Tool arguments as models really send them ──
// Weaker models emit near-JSON: a code fence, a double-encoded string, raw
// newlines inside strings, trailing commas, or no braces. null if nothing parses.
export function parseArgs(raw) {
  const s = String(raw ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (!s) return {};
  for (const t of [s, repairJson(s), repairJson(`{${s}}`)]) {
    try {
      let v = JSON.parse(t);
      if (typeof v === 'string') v = JSON.parse(v);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {}
  }
  return null;
}
function repairJson(s) {
  let out = '', str = false, esc = false;
  for (const ch of s) {
    if (str) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') str = false;
      else if (ch === '\n' || ch === '\r' || ch === '\t') { out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t'; continue; }
    } else if (ch === '"') str = true;
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

// Names other agents use for these tools, which models trained on them reach for.
const ALIAS = {
  click_element: 'click', left_click: 'click', type_text: 'type', input_text: 'type', fill: 'type', fill_field: 'type',
  press_key: 'key', press: 'key', keypress: 'key', send_keys: 'key', go_to_url: 'navigate', goto: 'navigate', open_url: 'navigate',
  visit: 'navigate', new_tab: 'tab_open', open_tab: 'tab_open', switch_tab: 'tab_switch', close_tab: 'tab_close',
  extract_content: 'get_text', get_page_text: 'get_text', read_text: 'get_text', snapshot: 'read_page', get_page: 'read_page',
  page_snapshot: 'read_page', execute_js: 'run_js', evaluate: 'run_js', javascript: 'run_js', take_screenshot: 'screenshot',
  select_dropdown_option: 'select_option', scroll_page: 'scroll', go_back: 'navigate', scroll_down: 'scroll', scroll_up: 'scroll',
};
// "12", 12, "[e12]", "ref=e12" → "e12".
const normRef = (v) => {
  if (v == null || v === '') return v;
  const s = String(v).trim().replace(/^\[|\]$/g, '').replace(/^ref\s*[:=]\s*/i, '');
  return /^\d+$/.test(s) ? 'e' + s : s;
};
export function normalize(name, a) {
  a = a && typeof a === 'object' ? { ...a } : {};
  if (name === 'go_back') a.url = 'back';
  if (name === 'scroll_down' || name === 'scroll_up') a.direction ??= name.slice(7);
  name = ALIAS[name] || name;
  if (name !== 'bookmarks' && name !== 'checklist') {
    a.ref ??= a.element ?? a.element_ref ?? a.ref_id ?? a.index;
    if (a.ref != null) a.ref = normRef(a.ref);
    if (a.to_ref != null) a.to_ref = normRef(a.to_ref);
  }
  if (name === 'type') a.text ??= a.value ?? a.content ?? a.input;
  if (name === 'navigate' || name === 'tab_open') a.url ??= a.href ?? a.link;
  if (name === 'key') a.keys ??= a.key ?? a.combo;
  if (name === 'tab_close' && a.tab_ids == null && a.tab_id != null) a.tab_ids = [a.tab_id];
  if (name === 'tab_close' && !Array.isArray(a.tab_ids) && a.tab_ids != null) a.tab_ids = [a.tab_ids];
  return [name, a];
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

// A new page's content and controls, once it has rendered (apps often draw
// after DOMContentLoaded), so the model can read and act without a read_page.
async function quickSnapshot(tabId, maxChars = 10000) {
  try {
    const s = await cs(tabId, 'snapshot', { mode: 'all', maxChars, wait: true });
    return s ? `\n\nPage now:\n${s}` : '';
  } catch (e) { return `\n\n(${e.message})`; }
}

// Wait until a tab the page opened has its document (DOMContentLoaded).
async function tabReady(tabId) {
  const n = nav.get(tabId);
  if (n?.pending) return waitNav(tabId);
  if (n) return;
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (t?.status === 'loading') await loaded(tabId);
}

// After an input action: if it opened a tab or kicked off a navigation, wait
// for the new document and hand back a fresh snapshot — saves the model a
// round trip, and keeps it from acting on a tab it has left.
async function afterAction(tabId, t0, text) {
  if (!navStartedSince(tabId, t0)) await sleep(0);
  const born = opened.filter((o) => o.at >= t0 && o.id !== tabId && (o.opener === tabId || o.windowId === agent.windowId));
  if (born.length) {
    for (const o of born) opened.splice(opened.indexOf(o), 1);
    const o = born[born.length - 1];
    await tabReady(o.id);
    const t = await chrome.tabs.get(o.id).catch(() => null);
    if (t) {
      if (!t.active) return `${text}\nOpened a background tab [${t.id}] ${t.title || ''} — ${t.url || t.pendingUrl || ''} (tab_switch to use it).`;
      agent.tabId = t.id;
      return `${text}\nOpened a new tab [${t.id}] ${t.title || ''} — ${t.url || t.pendingUrl || ''} (now the current tab; the old one is [${tabId}]).` +
        (await quickSnapshot(t.id));
    }
  }
  if (!navStartedSince(tabId, t0)) {
    const spa = nav.get(tabId)?.spa;
    return spa && spa.at >= t0 ? `${text}\nURL changed → ${spa.url}` : text;
  }
  await waitNav(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return `${text}\nPage navigated → ${tab?.title || ''} — ${tab?.url || ''}` + (await quickSnapshot(tabId));
}

// Canvas apps say what a click selected (a shape, the page background), so the
// model never fills or moves the wrong element.
async function selectionNote(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  const p = packsForUrl(t?.url).find((x) => x.selection);
  if (!p) return '';
  try { const s = await p.selection(API, tabId); return s ? `\n${s}` : ''; } catch { return ''; }
}

// ── Downloads ──
const bytes = (n) => (!(n > 0) ? '? bytes' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`);
const fmtDownload = (d) => `[${d.id}] ${String(d.filename || '').split(/[\\/]/).pop() || '(no file yet)'} — ${d.mime || 'unknown type'}, ${bytes(d.fileSize || d.totalBytes || d.bytesReceived)}, ${d.state}` +
  `${d.error ? ` (${d.error})` : ''}, started ${ago(Date.parse(d.startTime))}, from ${hostOf(d.finalUrl || d.url)}`;
const downloadsSince = (ms) => chrome.downloads.search({ startedAfter: new Date(ms).toISOString(), orderBy: ['-startTime'], limit: 20 });

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
  if (s < 60) return Math.max(0, Math.round(s)) + 's ago';
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};

// ── Tool schema (kept terse: every token here is latency) ──
const ref = { type: 'string', description: 'Element ref from read_page/find, e.g. "e12"' };
const tabId = { type: 'integer', description: 'Target tab (default: current tab)' };
// Every element tool can aim by label instead of ref.
const target = { type: 'string', description: 'Instead of ref: the element\'s visible label, e.g. "Add to cart"' };
const near = { type: 'string', description: 'With target: pick the match nearest this text (same row, card or list item), e.g. a product or person name' };
const nth = { type: 'integer', description: 'With target: which of several equal matches, in page order (1 = first)' };
const aimBy = { ref, target, near, nth };
const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

export const TOOLS = [
  fn('tabs_list', 'List open tabs across windows with ids, titles, URLs.'),
  fn('tab_open', 'Open a new tab. Returns its id and a snapshot of the page.', {
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
  fn('navigate', 'Navigate the current tab. Returns a snapshot of the new page (text and controls).', {
    url: { type: 'string', description: 'URL, search terms, or "back" / "forward" / "reload"' },
    tab_id: tabId,
  }, ['url']),
  fn('read_page', 'Snapshot of the page in reading order: text, headings, table rows, and interactive elements with refs. Long pages keep what is on screen first. "·off" = outside viewport.', {
    mode: { type: 'string', enum: ['all', 'interactive'], description: 'all (default): text and controls; interactive: controls only' },
    viewport_only: { type: 'boolean' },
    tab_id: tabId,
  }),
  fn('get_text', 'Plain text of the page (reading/summarizing). With query: only the lines that mention it, with context — fastest way to find a fact on a long page.', {
    query: { type: 'string', description: 'Words to look for' },
    selector: { type: 'string', description: 'Limit to an element' },
    max_chars: { type: 'integer' },
    tab_id: tabId,
  }),
  fn('find', 'Find elements by visible text/label. Returns refs. Query with the label words themselves ("Playfair Display"), not a description.', { query: { type: 'string' }, tab_id: tabId }, ['query']),
  fn('click', 'Click an element by ref, or by its visible label (target, plus near/nth to pick among repeats), or a CSS selector. x/y only for canvas content with no element; it snaps to the control at that point. Result lists what appeared or changed (menus, dialogs, messages) with refs.', {
    ...aimBy, selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' },
    clicks: { type: 'integer', description: '2 = double-click, 3 = triple-click (selects a paragraph)' },
    modifiers: { type: 'string', description: 'Held keys, e.g. "shift" to extend a selection, "meta" to open a link in a background tab' }, tab_id: tabId,
  }),
  fn('type', 'Type text in one go. Into a field (ref or target), replacing its text unless clear=false; without one, at the current caret/focus without clearing (rich editors like Google Docs — click into them first). Date/time inputs take their value format (2025-03-14, 13:30); a <select> picks the matching option.', {
    ...aimBy, selector: { type: 'string' }, text: { type: 'string' },
    clear: { type: 'boolean' }, submit: { type: 'boolean', description: 'Press Enter after' }, tab_id: tabId,
  }, ['text']),
  fn('key', 'Press keys on the focused element (or ref/target first). Space-separated combos; "*N" repeats, e.g. "Enter", "Meta+a Backspace", "Shift+ArrowRight*5", "ArrowDown*3 Enter". Use type for text.', {
    keys: { type: 'string' }, ...aimBy, tab_id: tabId,
  }, ['keys']),
  fn('paste', 'Paste text, markdown or HTML at the caret (or into ref/target) in one step, keeping formatting: headings, lists, links, bold, tables (markdown "||" merges a cell into the previous one), images by URL. Best way to put long or formatted text into rich editors.', {
    markdown: { type: 'string' }, html: { type: 'string' }, text: { type: 'string', description: 'Plain text' }, ...aimBy,
    clipboard: { type: 'boolean', description: 'Force the real clipboard + paste shortcut' }, tab_id: tabId,
  }),
  fn('menu', 'Click through a menu path by visible labels in one call, e.g. ["Format","Paragraph styles","Title"]. Opens menus and submenus in order; returns what is on screen after the last click.', {
    path: { type: 'array', items: { type: 'string' } }, tab_id: tabId,
  }, ['path']),
  fn('drag', 'Drag an element (ref/target, or x/y) to another (to_ref/to_target), a point (to_x/to_y), or by an offset (dx/dy: sliders, resizing, panning). Real drag-and-drop for kanban cards, sortable lists, file trees; also plain mouse drags to select text or table cells. Reports whether the item moved.', {
    ...aimBy, x: { type: 'number' }, y: { type: 'number' },
    to_ref: { type: 'string' }, to_target: { type: 'string', description: 'Destination\'s visible label (a column title, list item, drop zone)' },
    to_near: { type: 'string', description: 'With to_target: the match nearest this text' },
    to_x: { type: 'number' }, to_y: { type: 'number' }, dx: { type: 'number' }, dy: { type: 'number' },
    to_position: { type: 'string', enum: ['center', 'top', 'bottom', 'left', 'right'], description: 'Where on the destination to drop (default center). top/bottom drops before/after an item in a list.' },
    hold: { type: 'integer', description: 'Ms to hold the press before moving, for long-press-to-drag UIs' },
    modifiers: { type: 'string' }, tab_id: tabId,
  }),
  fn('scroll', 'Scroll the page (or the scrollable area under center); the result shows what is on screen after. ref/target alone brings it into view; with direction scrolls inside that element (lists, sidebars, dialogs).', {
    direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom', 'left', 'right'] },
    amount: { type: 'integer', description: 'Pixels (default ~1 screen)' },
    ...aimBy, tab_id: tabId,
  }),
  fn('hover', 'Hover an element (menus, tooltips).', { ...aimBy, x: { type: 'number' }, y: { type: 'number' }, tab_id: tabId }),
  fn('select_option', 'Choose an option in a native <select> (ref/target is the select or its label).', { ...aimBy, value: { type: 'string', description: 'Option value or label' }, tab_id: tabId }, ['value']),
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
  fn('downloads', 'Recent downloads, newest first: file name, type, size, state and when. Use it to confirm a download happened, and how many times.', {
    limit: { type: 'integer', description: 'How many (default 10)' },
  }),
  fn('history_search', 'Search browsing history.', {
    query: { type: 'string', description: 'Empty for recent' }, days: { type: 'integer', description: 'Look back (default 30)' },
    max_results: { type: 'integer' },
  }),
  fn('checklist', 'Track a multi-part task\'s requirements. set once at the start, then mark ids done/failed as you verify them (note = evidence). Base the final report on it.', {
    set: { type: 'array', items: { type: 'string' }, description: 'One "id: requirement" per item' },
    done: { type: 'array', items: { type: 'string' } }, failed: { type: 'array', items: { type: 'string' } }, note: { type: 'string' },
  }),
  fn('wait', 'Wait for text/selector to appear (or disappear with gone=true, e.g. a spinner or "Loading"), or a fixed time.', {
    text: { type: 'string' }, selector: { type: 'string' }, gone: { type: 'boolean' }, ms: { type: 'integer', description: 'Fixed wait, max 5000' },
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
  [name, a] = normalize(name, a);
  const at = a.target ? ` ${q(a.target)}` : '';
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
    case 'click': return `Clicking${at}`;
    case 'type': return `Typing ${q(a.text)}`;
    case 'drag': return `Dragging${at}${a.to_target ? ` to ${q(a.to_target)}` : ''}`;
    case 'key': return `Pressing ${a.keys}`;
    case 'scroll': return (a.ref || a.target) && !a.direction ? 'Scrolling into view' : `Scrolling ${a.direction || 'down'}`;
    case 'hover': return `Hovering${at}`;
    case 'select_option': return `Selecting ${q(a.value)}`;
    case 'screenshot': return 'Taking screenshot';
    case 'run_js': return 'Running JavaScript';
    case 'bookmarks': return { search: `Searching bookmarks ${q(a.query)}`, recent: 'Recent bookmarks', tree: 'Reading bookmarks', create: `Bookmarking ${q(a.title)}`, remove: 'Removing bookmark' }[a.action] || 'Bookmarks';
    case 'history_search': return a.query ? `Searching history ${q(a.query)}` : 'Recent history';
    case 'downloads': return 'Checking downloads';
    case 'wait': return a.text || a.selector ? `Waiting for ${q(a.text || a.selector)}` : `Waiting ${a.ms || 500}ms`;
    case 'paste': return 'Pasting';
    case 'menu': return `Menu ${q((a.path || []).join(' › '))}`;
    case 'checklist': return 'Updating checklist';
    default: return packOf(name)?.preLabel?.(name, a) || name;
  }
}

// ── Execution ──
export async function exec(name, a = {}) {
  [name, a] = normalize(name, a);
  const r = await run(name, a);
  // Dialogs the page raised along the way.
  const said = takeNotes();
  if (said) r.text = (r.text || '') + said;
  return r;
}

let opens = 0;
async function run(name, a) {
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
      // Opens can run at the same time; the one started last becomes current.
      const seq = ++opens;
      const tab = await chrome.tabs.create({ url, active: a.active !== false, windowId: agent.windowId ?? undefined });
      const wait = loaded(tab.id);
      const fresh = await chrome.tabs.get(tab.id);
      if (fresh.status === 'complete') wait.cancel();
      await wait;
      const active = a.active !== false && seq === opens;
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
      if (!chrome.tabs.group) throw new Error('Tab groups are not supported in this browser.');
      const ids = (a.tab_ids || []).map(Number);
      if (a.ungroup) { await chrome.tabs.ungroup(ids); return { text: `Ungrouped ${ids.length} tabs`, label: `Ungrouped ${ids.length} tabs` }; }
      const gid = await chrome.tabs.group({ tabIds: ids });
      const upd = {};
      if (a.title) upd.title = a.title;
      if (a.color) upd.color = a.color;
      if (a.collapsed != null) upd.collapsed = !!a.collapsed;
      if (Object.keys(upd).length && chrome.tabGroups) await chrome.tabGroups.update(gid, upd);
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
      const s = await cs(id, 'snapshot', { mode: a.mode || 'all', viewportOnly: !!a.viewport_only, wait: true });
      const tab = await chrome.tabs.get(id);
      return { text: s ?? 'Page is navigating; try again.', label: `Read ${hostOf(tab.url)}` };
    }

    case 'get_text': {
      const id = await resolveTab(a);
      const s = await cs(id, 'text', { maxChars: a.max_chars || 15000, selector: a.selector, query: a.query });
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
        await ready(id);
        let p = await cs(id, 'point', a);
        if (!p) throw new Error('Page is navigating; try again.');
        if (p.popup) {
          // An open list or menu sits on the target: close it rather than click through it.
          await cdpKeys(id, 'Escape');
          await cs(id, 'quiet', 60, 400);
          p = await cs(id, 'point', a);
          if (!p) throw new Error('Page is navigating; try again.');
          if (p.popup) throw new Error(`${p.desc}: an open list or menu (${p.popup}) covers it and Escape did not close it. Pick an option in it or close it first.`);
          p.desc += ' (closed an open list that covered it)';
        }
        if (p.covered) {
          // Every spot of the element is under something else (a banner, an overlay):
          // a real click would land on that, so send the click to the element itself.
          text = await cs(id, 'click', a) ?? 'Clicked (page navigated)';
        } else {
          await cdpClick(id, p.x, p.y, Math.max(1, Math.min(3, +a.clicks || (a.double ? 2 : 1))), mouseMods(a.modifiers));
          text = `Clicked ${p.desc}` + await settleAfter(id, t0);
        }
      } else {
        text = (await cs(id, 'click', a)) ?? 'Clicked (page navigated)';
      }
      text = await afterAction(id, t0, text);
      return { text: text + await selectionNote(id), label: firstLine(text).replace(/ \((warning|\d+ matches|no exact match|closed an open).*$/, '') };
    }

    case 'drag': {
      const id = await resolveTab(a);
      let text;
      if (agent.trusted) {
        await ready(id);
        const p = await cs(id, 'dragPoints', a);
        if (!p) throw new Error('Page is navigating; try again.');
        const how = await cdpDrag(id, p, mouseMods(a.modifiers), a.hold);
        const note = how === 'dropped' ? ' (drag-and-drop: dropped)' : how === 'refused' ? ' (drag-and-drop: target did not accept the drop)' : '';
        const diff = await settleAfter(id, t0, 100, 900);
        text = `Dragged ${p.desc}${note}${(await cs(id, 'dragDone', p.desc, diff)) || ''}` + diff;
      } else text = (await cs(id, 'drag', a)) ?? 'Dragged (page navigated)';
      text = await afterAction(id, t0, text);
      return { text: text + await selectionNote(id), label: firstLine(text) };
    }

    case 'type': {
      const id = await resolveTab(a);
      let text;
      if (agent.trusted) {
        await ready(id);
        const f = await cs(id, 'prepField', a);
        if (!f) throw new Error('Page is navigating; try again.');
        const s = String(a.text ?? '');
        if (f.kind === 'select') return run('select_option', { ...a, ref: f.ref, target: undefined, value: s });
        let check = '';
        if (f.kind === 'value') text = await cs(id, 'setValue', { value: s });
        else {
          // The page's focus handlers may have reformatted the value and dropped the
          // selection: select it all again with the keyboard right before typing.
          if (f.plain && f.replace) { await cs(id, 'reselect'); await cdpKeys(id, MAC ? 'Meta+a' : 'Control+a'); }
          if (f.plain && s && s.length <= 80 && !s.includes('\n')) {
            // Short text in a plain field goes in key by key, so autocompletes and
            // masks that listen for key events react as they would to a person.
            await cdpType(id, s);
          } else {
            // insertText replaces the selection, so Backspace is only for clearing to empty.
            // Rich editors get Enter between lines (a raw "\n" may not make a paragraph).
            const parts = f.plain ? [s] : s.split('\n');
            for (let i = 0; i < parts.length; i++) {
              if (i) await cdpKeys(id, 'Enter');
              if (parts[i]) await cdp(id, 'Input.insertText', { text: parts[i] });
            }
          }
          if (!s && f.cleared) await cdpKeys(id, 'Backspace');
          // Read the value back before Enter (which may submit and clear it).
          if (f.plain) {
            let st = await cs(id, 'fieldState', s, f.replace);
            if (st && !st.ok && f.replace) {
              // Comboboxes and masked fields can re-select or reformat under key-by-key
              // typing: select all and put the whole value in at once, then check again.
              await cdpKeys(id, MAC ? 'Meta+a' : 'Control+a');
              await cdp(id, 'Input.insertText', { text: s });
              st = await cs(id, 'fieldState', s, true);
              if (st?.ok) check = ' (typed again in one piece: the first try left something else)';
            }
            if (st && !st.ok) throw new Error(`Typed "${clip(s, 60)}" into ${f.desc}, but the field shows "${st.shown}". The page changed or rejected the input. Read the field, then type the whole value again (or use the app's own control for it).`);
          }
          if (a.submit) await cdpKeys(id, 'Enter');
          text = `Typed "${clip(s, 60)}" into ${f.desc}${a.submit ? ' and pressed Enter' : ''}${check}`;
        }
        // Suggestion lists (search boxes, address and city pickers) take a moment to show.
        text += await settleAfter(id, t0, f.suggest ? 200 : 80, f.suggest ? 1500 : 700);
      } else {
        text = (await cs(id, 'type', a)) ?? 'Typed (page navigated)';
      }
      return { text: await afterAction(id, t0, text), label: firstLine(text) };
    }

    case 'key': {
      const id = await resolveTab(a);
      let text;
      if (agent.trusted) {
        await ready(id);
        await cs(id, 'keyPrep', { ref: a.ref, target: a.target, near: a.near, nth: a.nth });
        await cdpKeys(id, String(a.keys));
        text = `Pressed ${String(a.keys).trim()}` + await settleAfter(id, t0);
      } else text = (await cs(id, 'key', a)) ?? `Pressed ${a.keys}`;
      return { text: await afterAction(id, t0, text), label: clip(firstLine(text), 80) };
    }

    case 'scroll': {
      const id = await resolveTab(a);
      const s = await cs(id, 'scroll', a);
      if (s == null) throw new Error('Page is navigating; try again.');
      return { text: s, label: firstLine(s).replace(/;.*$/, '') };
    }

    case 'hover': {
      const id = await resolveTab(a);
      let s;
      if (agent.trusted) {
        await ready(id);
        const p = await cs(id, 'point', { ...a, hover: true });
        if (!p) throw new Error('Page is navigating; try again.');
        await mouseEv(id, 'mouseMoved', p.x, p.y, {});
        s = `Hovered ${p.desc}` + await settleAfter(id, t0);
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
          if (!CAN_DEBUG) throw new Error('This page blocks eval (CSP), so run_js cannot run here. Use read_page, find and the other tools instead.');
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

    case 'downloads': {
      const list = await chrome.downloads.search({ orderBy: ['-startTime'], limit: Math.max(1, Math.min(+a.limit || 10, 50)) });
      return { text: list.map(fmtDownload).join('\n') || 'No downloads.', label: `Found ${list.length} download${list.length === 1 ? '' : 's'}` };
    }

    case 'paste': {
      const id = await resolveTab(a);
      const text = await pasteContent(id, a);
      return { text: await afterAction(id, t0, text), label: firstLine(text) };
    }

    case 'menu': {
      const id = await resolveTab(a);
      if (agent.trusted) await ready(id);
      const path = (Array.isArray(a.path) ? a.path : String(a.path || '').split(/\s*[>›]\s*/)).map(String).filter(Boolean);
      if (!path.length) throw new Error('menu needs a path');
      let diff = '';
      const notes = [];
      for (let i = 0; i < path.length; i++) {
        let p;
        try { p = await cs(id, 'menuFind', { label: path[i], strict: true }); }
        catch (e) {
          // Don't leave half-opened menus behind: they swallow the next keys and clicks.
          if (i) await (agent.trusted ? cdpKeys(id, `Escape*${i}`) : cs(id, 'key', { keys: `Escape*${i}` })).catch(() => {});
          throw new Error(`${e.message}${i ? ` (closed the menu after “${path.slice(0, i).join(' › ')}”)` : ''}`);
        }
        if (!p) throw new Error('Page is navigating; try again.');
        const used = p.desc.match(/ \(no exact match for .*\)$/);
        if (used) notes.push(used[0]);
        if (agent.trusted) {
          await mouseEv(id, 'mouseMoved', p.x, p.y, {});
          await cdpClick(id, p.x, p.y);
        } else await cs(id, 'click', { ref: p.ref });
        // Submenus open on hover/click; wait until the DOM settles before the next label.
        diff = i === path.length - 1 ? await settleAfter(id, t0, 60, 700) : (await cs(id, 'settle', 60, 450)) || '';
      }
      const text = `Clicked ${path.join(' › ')}${notes.length ? notes.join('') : ''}` + diff;
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
        const s = await cs(id, 'waitFor', { text: a.text, selector: a.selector, gone: !!a.gone, timeout: a.timeout_ms || 5000 });
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
  agent, MAC, sleep, clip, resolveTab, cs, cdp, page, afterAction, exec, downloadsSince, fmtDownload,
  sameValue: (shown, typed, replace) => globalThis.TuffKeys.sameValue(shown, typed, replace),
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
