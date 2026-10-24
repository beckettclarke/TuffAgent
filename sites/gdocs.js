// Google Docs pack. Docs draws text on a canvas and takes input through a
// hidden iframe, so these tools work the way a fast human does: paste whole
// formatted sections, find text to select it, use Docs' own shortcuts and menu
// search, and read the document back from its HTML export.

const MAC = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform);
const M = MAC ? 'Meta' : 'Control';
const DOC_RE = /^https:\/\/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/[\w-]+/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const fn = (name, description, properties = {}, required = []) => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required } },
});
const occurrence = { type: 'integer', description: 'Which match, default 1' };

// ── Page-side helpers (run in the tab through chrome.scripting) ──
function pageFocusDoc() {
  const f = document.querySelector('.docs-texteventtarget-iframe');
  const d = f?.contentDocument;
  const ed = d?.querySelector('[contenteditable="true"]') || d?.body;
  if (!ed) return false;
  if (document.activeElement !== f || d.activeElement !== ed) { f.contentWindow.focus(); ed.focus(); }
  return true;
}
// Where keyboard focus is: the document, a text field (find bar, comment box, link box), or elsewhere.
function pageFocus() {
  let a = document.activeElement;
  if (a?.classList?.contains('docs-texteventtarget-iframe')) return 'doc';
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  if (!a || a === document.body) return 'none';
  return a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable ? 'field' : 'other';
}
// "3 of 7" next to the focused find box.
function pageFindCount() {
  const a = document.activeElement;
  if (!a || a.tagName !== 'INPUT') return null;
  let box = a;
  for (let i = 0; i < 5 && box.parentElement; i++) box = box.parentElement;
  for (const e of box.querySelectorAll('*')) {
    if (e.children.length || !e.getClientRects().length) continue;
    const m = (e.textContent || '').trim().match(/^(\d+)\s*(?:of|\/)\s*(\d+)$/i);
    if (m) return { cur: +m[1], total: +m[2] };
  }
  return { cur: 0, total: -1 };
}
function pageState() {
  const q = (s) => document.querySelector(s);
  const st = q('[aria-label^="Document status"], .docs-title-save-label-text, #docs-save-indicator-badge');
  const status = (st?.getAttribute('aria-label') || st?.textContent || '').replace(/\s+/g, ' ').trim();
  const md = q('#docs-toolbar-mode-switcher');
  const mode = (md?.innerText || md?.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  const threads = [...document.querySelectorAll('.docos-anchoreddocoview')]
    .filter((t) => t.getClientRects().length).slice(0, 30)
    .map((t) => t.innerText.replace(/\s+/g, ' ').trim().slice(0, 400));
  return { title: document.title.replace(/ - Google Docs$/, ''), status, mode, threads, saving: /saving/i.test(status) };
}
// An open menu (left by an earlier click) eats Escape and the next keystrokes.
function pageMenuOpen() {
  return [...document.querySelectorAll('[role=menu], .goog-menu')].some((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
}
// What a toolbar control shows right now, e.g. "Styles" → "Title", "Font" → "Roboto".
function pageToolbar(label) {
  const el = [...document.querySelectorAll(`[aria-label="${label}"]`)].find((e) => e.getClientRects().length);
  return el ? (el.innerText || el.value || '').replace(/\s+/g, ' ').trim() : null;
}
// The toolbar's font size input. focus: focus and select it without a click
// (a click opens the size dropdown, and Enter then picks its highlighted size).
function pageFontSize(focus) {
  const el = [...document.querySelectorAll('input[aria-label="Font size"]')].find((e) => e.getClientRects().length);
  if (!el) return null;
  if (focus) { el.focus(); el.select(); }
  return el.value;
}
// A color palette swatch by its name ("yellow", "dark cornflower blue 2").
function pageSwatch(name) {
  for (const e of document.querySelectorAll('[title], [aria-label]')) {
    const n = (e.getAttribute('aria-label') || e.getAttribute('title') || '').trim().toLowerCase();
    if (n !== name) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 4 || r.width > 48 || r.height < 4 || r.height > 48 || getComputedStyle(e).visibility === 'hidden') continue;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }
  return null;
}
// A comment card whose text contains `text`: where to click it, its reply box,
// reply and resolve buttons (0×0 = hidden), and its text.
function pageCard(text) {
  const want = String(text).toLowerCase().replace(/\s+/g, ' ');
  const cards = [...document.querySelectorAll('.docos-anchoreddocoview')].filter((c) => c.getClientRects().length);
  const card = cards.find((c) => c.innerText.toLowerCase().replace(/\s+/g, ' ').includes(want));
  if (!card) return { err: `No comment card on screen contains "${String(text).slice(0, 60)}". Cards: ${cards.map((c) => `"${c.innerText.replace(/\s+/g, ' ').slice(0, 70)}"`).join(' | ') || 'none'}` };
  card.scrollIntoView({ block: 'center' });
  const at = (e) => { const r = e?.getBoundingClientRect(); return r && r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; };
  const r = card.getBoundingClientRect();
  const box = card.querySelector('[role=combobox][aria-label="Reply"], .docos-input-textarea');
  return {
    head: { x: r.x + Math.min(r.width / 2, 80), y: r.y + 14 },
    box: at(box), boxText: (box?.innerText || '').trim(),
    send: at(card.querySelector('[aria-label="Reply to comment"]')),
    resolve: at(card.querySelector('[aria-label^="Mark as resolved"]')),
    text: card.innerText.replace(/\s+/g, ' ').trim().slice(0, 1500),
  };
}
function pageTitleBox() {
  const el = [...document.querySelectorAll('input.docs-title-input, input[aria-label="Rename"]')].find((e) => e.getClientRects().length);
  const r = el?.getBoundingClientRect();
  return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
}
function pagePressed(label) {
  const b = document.getElementById(label.toLowerCase() + 'Button') || document.querySelector(`[role=button][aria-label^="${label}"]`);
  return b ? b.getAttribute('aria-pressed') === 'true' : null;
}
async function pageExport(fmt) {
  const m = location.pathname.match(/^(.*?\/d\/[^/]+)/);
  if (!m) return { err: 'not a document URL' };
  const url = location.origin + m[1] + '/export?format=' + fmt;
  try {
    const r = await fetch(url, { credentials: 'include' });
    return r.ok ? { body: await r.text() } : { err: 'HTTP ' + r.status, url };
  } catch (e) { return { err: String(e?.message || e), url }; }
}

// ── Export → compact structured summary ──
export function summarize(html, st = {}, { full = false, max = 16000 } = {}) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const css = new Map();
  for (const s of doc.querySelectorAll('style')) {
    for (const m of s.textContent.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      for (const sel of m[1].split(',')) css.set(sel.trim(), (css.get(sel.trim()) || '') + ';' + m[2]);
    }
  }
  const styleOf = (el) => [...el.classList].map((c) => css.get('.' + c) || '').join(';') + ';' + (el.getAttribute('style') || '');
  const prop = (el, p) => {
    const all = [...styleOf(el).matchAll(new RegExp(`(?:^|;)\\s*${p}\\s*:\\s*([^;]+)`, 'g'))];
    return all.length ? all[all.length - 1][1].trim() : '';
  };
  const pt = (v) => parseFloat(v) || 0;
  const inch = (v) => +(pt(v) / 72).toFixed(2);
  const isRef = (n) => n.nodeType === 1 && n.matches('a[href^="#cmnt"], a[href^="#ftnt"]');
  const textOf = (el) => {
    let s = '';
    const walk = (n) => {
      if (n.nodeType === 3) { s += n.nodeValue; return; }
      if (n.nodeType !== 1 || isRef(n)) return;
      if (n.tagName === 'BR') s += '\n';
      for (const c of n.childNodes) walk(c);
    };
    walk(el);
    return s.replace(/[ \t ]+/g, ' ').trim();
  };
  const realUrl = (h) => {
    try { const u = new URL(h); if (u.hostname.endsWith('google.com') && u.pathname === '/url') return u.searchParams.get('q') || h; } catch {}
    return h;
  };
  const color = (v) => (v && !/^(#000000|#000|black|transparent|inherit|initial)$/i.test(v) ? v : '');
  const quoted = (arr) => arr.slice(0, 4).map((t) => `"${clip(t, 40)}"`).join(', ') + (arr.length > 4 ? ` +${arr.length - 4}` : '');
  const cap = full ? 1e9 : 200;

  // Inline formatting summary for a paragraph or cell.
  function inlineInfo(el, total) {
    const runs = { bold: [], italic: [], underline: [], strike: [], color: [], highlight: [] };
    const len = { bold: 0, italic: 0, underline: 0, strike: 0 };
    const sizes = new Map(), fonts = new Map(), sizeRuns = new Map(), fontRuns = new Map();
    const add = (m, k, t) => (m.get(k) || m.set(k, []).get(k)).push(t);
    for (const sp of el.querySelectorAll('span')) {
      if (sp.querySelector('span')) continue;
      const t = textOf(sp);
      if (!t) continue;
      const fw = prop(sp, 'font-weight'), deco = prop(sp, 'text-decoration');
      const flags = { bold: fw === 'bold' || +fw >= 600, italic: prop(sp, 'font-style') === 'italic', underline: /underline/.test(deco), strike: /line-through/.test(deco) };
      for (const k in flags) if (flags[k]) { runs[k].push(t); len[k] += t.length; }
      const c = color(prop(sp, 'color'));
      if (c) runs.color.push(`${c} "${clip(t, 30)}"`);
      const bg = color(prop(sp, 'background-color'));
      if (bg) runs.highlight.push(`${bg} "${clip(t, 30)}"`);
      const fs = prop(sp, 'font-size'); if (fs) { sizes.set(fs, (sizes.get(fs) || 0) + t.length); add(sizeRuns, fs, t); }
      const ff = prop(sp, 'font-family').replace(/["']/g, '').split(',')[0].trim(); if (ff) { fonts.set(ff, (fonts.get(ff) || 0) + t.length); add(fontRuns, ff, t); }
    }
    const out = [];
    for (const k of ['bold', 'italic', 'underline', 'strike']) {
      if (!runs[k].length) continue;
      out.push(len[k] >= total * 0.95 ? k : `${k}: ${quoted(runs[k])}`);
    }
    if (runs.color.length) out.push(`color ${runs.color.slice(0, 3).join(', ')}`);
    if (runs.highlight.length) out.push(`highlight ${runs.highlight.slice(0, 3).join(', ')}`);
    const top = (m) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
    const size = top(sizes), font = top(fonts);
    // The main size/font, then every other run: a phrase in another font must show up.
    if (size && pt(size) !== 11) out.push(size);
    for (const [s, ts] of sizeRuns) if (s !== size) out.push(`${s}: ${quoted(ts)}`);
    if (font && font !== 'Arial') out.push(font);
    for (const [f, ts] of fontRuns) if (f !== font) out.push(`${f}: ${quoted(ts)}`);
    for (const a of el.querySelectorAll('a[href]')) {
      if (isRef(a) || !textOf(a)) continue;
      const h = a.getAttribute('href');
      out.push(`link "${clip(textOf(a), 40)}" → ${h.startsWith('#') ? `#${h.slice(1)} (in-doc)` : clip(realUrl(h), 90)}`);
    }
    for (const a of el.querySelectorAll('a[id^="id."]')) out.push(`bookmark ${a.id}`);
    for (const img of el.querySelectorAll('img')) {
      const box = img.closest('span') || img;
      const w = Math.round(pt(prop(img, 'width') || prop(box, 'width'))), h = Math.round(pt(prop(img, 'height') || prop(box, 'height')));
      let positioned = false;
      for (let p = img.parentElement; p && p !== el; p = p.parentElement) if (/position|float/.test(p.getAttribute('style') || '')) positioned = true;
      out.push(`image ${w}×${h}px${img.alt ? ` alt="${clip(img.alt, 60)}"` : ''}${img.title ? ` title="${clip(img.title, 60)}"` : ''}${positioned ? ' (positioned/wrapped)' : ' (inline)'}`);
    }
    return out;
  }

  const lines = [];
  const anchors = new Map();
  let pn = 0, empties = 0, words = 0, tables = 0, images = doc.querySelectorAll('img').length, seenContent = false;
  const header = [], footer = [], comments = [], notes = [];
  const listCount = [];

  const ALIGN = { center: 'center', right: 'right', justify: 'justified' };
  function paragraph(el, kind) {
    for (const hr of el.querySelectorAll('hr')) if (/page-break/.test(hr.getAttribute('style') || '')) lines.push('— page break —');
    const t = textOf(el);
    if (!t && !el.querySelector('img')) { empties++; return; }
    seenContent = true;
    pn++;
    words += t.split(/\s+/).filter(Boolean).length;
    for (const a of el.querySelectorAll('a[id^="cmnt_ref"]')) {
      const r = doc.createRange();
      r.setStart(el, 0); r.setEndBefore(a.closest('sup') || a);
      anchors.set(a.getAttribute('href').slice(1), { pn, ctx: r.toString().replace(/\s+/g, ' ').slice(-60) });
    }
    const al = ALIGN[prop(el, 'text-align')];
    const extra = inlineInfo(el, t.length);
    lines.push(`¶${pn} ${kind}${al ? ', ' + al : ''}${el.id ? ` #${el.id}` : ''}: ${clip(t.replace(/\n/g, ' ⏎ '), cap)}${extra.length ? `  [${extra.join('; ')}]` : ''}`);
  }

  function list(el) {
    const ordered = el.tagName === 'OL';
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      const lvl = +((li.className.match(/lst-kix_\w+-(\d+)/) || el.className.match(/lst-kix_\w+-(\d+)/) || [])[1] || 0);
      listCount.length = lvl + 1;
      listCount[lvl] = (listCount[lvl] || 0) + 1;
      const t = textOf(li);
      seenContent = true;
      words += t.split(/\s+/).filter(Boolean).length;
      const extra = inlineInfo(li, t.length);
      lines.push(`${'  '.repeat(lvl + 1)}${ordered ? listCount[lvl] + '.' : '•'} ${clip(t, cap)}${extra.length ? `  [${extra.join('; ')}]` : ''}`);
    }
  }

  function table(el) {
    tables++;
    seenContent = true;
    const rows = [...el.querySelectorAll('tr')].filter((tr) => tr.closest('table') === el);
    const cols = Math.max(0, ...rows.map((tr) => [...tr.children].reduce((n, td) => n + (+td.getAttribute('colspan') || 1), 0)));
    lines.push(`Table ${tables} (${rows.length}×${cols}):`);
    rows.forEach((tr, i) => {
      const tds = [...tr.children];
      const bgs = tds.map((td) => color(prop(td, 'background-color')));
      const sameBg = bgs.every((b) => b && b === bgs[0]);
      const cells = tds.map((td, k) => {
        const t = textOf(td);
        words += t.split(/\s+/).filter(Boolean).length;
        const cs = +td.getAttribute('colspan') || 1, rs = +td.getAttribute('rowspan') || 1;
        const ex = inlineInfo(td, t.length);
        if (!sameBg && bgs[k]) ex.push(`bg ${bgs[k]}`);
        return `${clip(t, full ? 1e9 : 60) || '∅'}${cs > 1 ? ` ⟨colspan ${cs}⟩` : ''}${rs > 1 ? ` ⟨rowspan ${rs}⟩` : ''}${ex.length ? ` [${ex.join('; ')}]` : ''}`;
      });
      lines.push(`  r${i + 1}: ${cells.join(' | ')}${sameBg ? `  (row bg ${bgs[0]})` : ''}`);
    });
  }

  for (const el of doc.body.children) {
    const t = el.tagName;
    if (t === 'P') paragraph(el, el.classList.contains('title') ? 'Title' : el.classList.contains('subtitle') ? 'Subtitle' : 'Normal');
    else if (/^H[1-6]$/.test(t)) paragraph(el, 'Heading ' + t[1]);
    else if (t === 'UL' || t === 'OL') list(el);
    else if (t === 'TABLE') table(el);
    else if (t === 'HR') lines.push(/page-break/.test(el.getAttribute('style') || '') ? '— page break —' : '— horizontal line —');
    else if (t === 'DIV') {
      if (el.querySelector('a[id^="cmnt"]:not([id^="cmnt_ref"])')) {
        const ps = [...el.querySelectorAll('p')].map(textOf).filter(Boolean);
        const id = el.querySelector('a[id^="cmnt"]').id;
        comments.push({ id, label: el.querySelector('a[id^="cmnt"]').textContent.trim() || id, text: ps });
      } else if (el.querySelector('a[id^="ftnt"]')) notes.push(textOf(el));
      else {
        const txt = [...el.querySelectorAll('p')].map(textOf).filter(Boolean).join(' / ') + (el.querySelector('img') ? ' [image]' : '');
        if (txt) (seenContent ? footer : header).push(txt);
      }
    }
  }

  const body = doc.body;
  const pad = prop(body, 'padding').split(/\s+/).map(inch);
  const [mt, mr = mt, mb = mt, ml = mr] = pad;
  const width = +(inch(prop(body, 'max-width')) + (mr || 0) + (ml || 0)).toFixed(2);
  const paper = { 8.5: 'Letter portrait', 11: 'Letter landscape', 8.27: 'A4 portrait', 11.69: 'A4 landscape' }[width] || '';
  const head = [
    `"${st.title || doc.title || 'Untitled'}"${st.status ? ' — ' + st.status : ''}${st.mode ? ' · mode: ' + st.mode : ''}`,
    width ? `Page: ${width}in wide${paper ? ` (${paper})` : ''}, margins ${[mt, mr, mb, ml].map((x) => x ?? '?').join('/')}in (top/right/bottom/left)` : '',
    `${pn} paragraphs, ${tables} tables, ${images} images, ~${words} words${empties ? `, ${empties} empty paragraphs` : ''}`,
    header.length ? `Header: ${header.map((h) => `"${clip(h, 120)}"`).join(' | ')}` : '',
    footer.length ? `Footer: ${footer.map((h) => `"${clip(h, 120)}"`).join(' | ')}` : '',
  ].filter(Boolean);
  const tail = [];
  if (comments.length) {
    tail.push('', `Comments in the export (${comments.length}, unresolved only):`);
    for (const c of comments) {
      const a = anchors.get(c.id);
      tail.push(`  ${c.label} on ${a ? `¶${a.pn} …"${a.ctx}"` : '?'}: ${c.text.map((x, i) => (i ? ' ↳ ' : '') + `"${clip(x, 160)}"`).join('')}`);
    }
  }
  if (notes.length) tail.push('', 'Footnotes:', ...notes.map((n) => '  ' + clip(n, 160)));
  if (st.threads?.length) tail.push('', `Comment/suggestion cards on screen (${st.threads.length}):`, ...st.threads.map((t, i) => `  ${i + 1}. ${t}`));
  let out = head.join('\n') + '\n\n' + lines.join('\n') + tail.join('\n');
  if (out.length > max) out = out.slice(0, max) + '\n… (truncated)';
  return out;
}

// ── Tool helpers ──
let lastEdit = 0;
async function until(api, id, func, want, ms = 1500, args = []) {
  const end = performance.now() + ms;
  for (;;) {
    const v = await api.page(id, func, args);
    if (want(v)) return v;
    if (performance.now() > end) return null;
    await sleep(40);
  }
}
async function focusDoc(api, id) {
  if (!(await api.page(id, pageFocusDoc))) throw new Error('Could not find the Docs editor — is the document fully loaded?');
}
async function fieldOpened(api, id, what) {
  if (!(await until(api, id, pageFocus, (v) => v === 'field'))) throw new Error(`${what} did not open — click into the document text and retry.`);
}
async function closeMenus(api, id) {
  for (let i = 0; i < 3 && (await api.page(id, pageMenuOpen)); i++) { await api.keys(id, 'Escape'); await sleep(60); }
}
// Select a match with Docs' find bar; leaves the selection (or caret) on it.
async function select(api, id, text, n = 1, cursor = 'select') {
  await closeMenus(api, id);
  await focusDoc(api, id);
  await api.keys(id, `${M}+f`);
  await fieldOpened(api, id, 'The find bar');
  // Empty the box first: otherwise the "1 of 1" read below can be the previous
  // search's count, and the selection stays on the previous match.
  await api.keys(id, `${M}+a Backspace`);
  await until(api, id, pageFindCount, (c) => !c || c.cur <= 0, 400);
  await api.insertText(id, String(text));
  let c = null;
  for (let t = 0; t < 30; t++) {
    await sleep(50);
    c = await api.page(id, pageFindCount);
    // "0 of 0" can linger from the empty box for a moment, so trust it only after a beat.
    if (c && (c.cur > 0 || (c.total === 0 && t >= 5) || (c.total < 0 && t > 8))) break;
  }
  if (c?.total === 0) { await api.keys(id, 'Escape'); throw new Error(`"${clip(text, 60)}" is not in the document.`); }
  n = Math.max(1, +n || 1);
  if (n > 1) {
    await api.keys(id, `Enter*${n - 1}`);
    await sleep(60);
    c = await api.page(id, pageFindCount);
  }
  // Escape closes the find bar and selects the match. If something else took it, press again.
  await api.keys(id, 'Escape');
  if (!(await until(api, id, pageFocus, (v) => v !== 'field', 300))) {
    await api.keys(id, 'Escape');
    await until(api, id, pageFocus, (v) => v !== 'field', 300);
  }
  if (cursor === 'start') await api.keys(id, 'ArrowLeft');
  else if (cursor === 'end') await api.keys(id, 'ArrowRight');
  return c?.total > 0 ? `match ${c.cur} of ${c.total}` : 'match';
}
async function clickFound(api, id, p) {
  await api.mouseEv(id, 'mouseMoved', p.x, p.y, {});
  await api.click(id, p.x, p.y);
}
// A visible control by label (menuFind scoring), polling while it renders. null if absent.
async function findLabel(api, id, label, roles, { wait = 0, exact = false, offscreen = false } = {}) {
  const end = performance.now() + wait;
  for (;;) {
    const p = await api.cs(id, 'menuFind', { label, roles, offscreen }).catch(() => null);
    if (p && (!exact || p.exact)) return p;
    if (performance.now() >= end) return null;
    await sleep(60);
  }
}
async function clickLabel(api, id, label, roles, opts) {
  const p = await findLabel(api, id, label, roles, { wait: 400, ...opts });
  if (!p) throw new Error(`Could not find "${label}" on screen.`);
  await clickFound(api, id, p);
  await api.cs(id, 'settle', 60, 500);
  return p;
}
const normName = (s) => String(s || '').toLowerCase().replace(/[‘’'"“”►]/g, '').replace(/\s+/g, ' ').trim();
const toolbarIs = (api, id, label, want) => until(api, id, pageToolbar, (v) => v != null && [normName(want), normName(want) + ' text'].includes(normName(v)), 500, [label])
  .then((v) => v != null);

async function paragraphStyle(api, id, name) {
  let err = null;
  for (const path of [['Format', 'Paragraph styles', name, `Apply '${name}'`], ['Styles', name]]) {
    try { await api.exec('menu', { path, tab_id: id }); }
    catch (e) { err ||= e; await closeMenus(api, id); continue; }
    await closeMenus(api, id);
    const shown = await api.page(id, pageToolbar, ['Styles']);
    // No readable toolbar: trust the menu. Otherwise it must show the new style.
    if (shown == null || (await toolbarIs(api, id, 'Styles', name))) return;
    err = new Error(`the Styles box shows "${shown}"`);
  }
  throw new Error(`Could not apply ${name}: ${err?.message}`);
}

const ITEM_ROLES = ['menuitemcheckbox', 'menuitem', 'menuitemradio', 'option'];
// Any Google font: pick it from the toolbar's font menu, or add it from More fonts first.
async function setFont(api, id, font) {
  font = String(font).trim();
  const fromMenu = async () => {
    await clickLabel(api, id, 'Font', ['listbox', 'combobox', 'button']);
    const p = await findLabel(api, id, font, ITEM_ROLES, { wait: 300, exact: true, offscreen: true });
    if (!p) return false;
    await clickFound(api, id, p);
    await api.cs(id, 'settle', 60, 500);
    return true;
  };
  if (await fromMenu()) return 'font';
  await clickLabel(api, id, 'More fonts', ITEM_ROLES);
  const box = await findLabel(api, id, 'Search', ['textbox', 'searchbox', 'combobox'], { wait: 3000 });
  if (!box) { await api.keys(id, 'Escape'); throw new Error('The More fonts dialog did not open.'); }
  await clickFound(api, id, box);
  await api.keys(id, `${M}+a`);
  await api.insertText(id, font);
  const opt = await findLabel(api, id, font, ['option', 'menuitemcheckbox', 'checkbox', 'menuitem'], { wait: 2500, exact: true, offscreen: true });
  if (!opt) { await api.keys(id, 'Escape'); throw new Error(`"${font}" is not in Docs' font library.`); }
  if (!opt.checked) await clickFound(api, id, opt);
  const ok = (await findLabel(api, id, 'OK', ['button'], { wait: 600, exact: true })) || (await findLabel(api, id, 'Done', ['button'], { wait: 300, exact: true }));
  if (!ok) { await api.keys(id, 'Escape'); throw new Error('Could not confirm the More fonts dialog.'); }
  await clickFound(api, id, ok);
  await api.cs(id, 'settle', 80, 700);
  await focusDoc(api, id);
  if (await toolbarIs(api, id, 'Font', font)) return 'font (added from More fonts)';
  if (await fromMenu()) return 'font (added from More fonts)';
  await closeMenus(api, id);
  throw new Error(`Added "${font}" but could not pick it from the font menu.`);
}

// Focus the size box without clicking it, type, Enter, then check the box shows
// the new size once the selection is back in the document. One retry by click.
async function setSize(api, id, size) {
  const want = String(+size);
  const shows = async () => { await focusDoc(api, id); return until(api, id, pageFontSize, (v) => v === want, 600, [false]); };
  if ((await api.page(id, pageFontSize, [true])) != null) {
    await api.insertText(id, want);
    await api.keys(id, 'Enter');
    await api.cs(id, 'settle', 60, 400);
    await closeMenus(api, id);
    if (await shows()) return;
  }
  const box = await findLabel(api, id, 'Font size', ['textbox', 'combobox', 'spinbutton'], { wait: 400 });
  if (!box) throw new Error('Could not find the Font size box.');
  await clickFound(api, id, box);
  await api.keys(id, `${M}+a`);
  await api.insertText(id, want);
  await api.keys(id, 'Enter');
  await api.cs(id, 'settle', 60, 400);
  await closeMenus(api, id);
  if (!(await shows())) throw new Error(`Size ${want} did not stick (the size box shows ${(await api.page(id, pageFontSize, [false])) ?? '?'}).`);
}

// Real keystrokes, one character at a time, for widgets that ignore inserted
// text (equation editor, title box). gap: pause between keys.
async function typeKeys(api, id, s, gap = 0) {
  for (const ch of String(s)) {
    await api.keys(id, ch === ' ' ? 'Space' : ch);
    if (gap) await sleep(/[\^_\\]/.test(ch) ? gap * 2 : gap);
  }
}

// "#15c", "1155cc", "blue", "rgb(…)" → "#1155cc".
export function toHex(c) {
  const s = String(c).trim();
  const h = s.replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(h)) return '#' + h.toLowerCase();
  if (/^[0-9a-f]{3}$/i.test(h)) return '#' + [...h].map((x) => x + x).join('').toLowerCase();
  const ctx = new OffscreenCanvas(1, 1).getContext('2d');
  ctx.fillStyle = '#010203';
  ctx.fillStyle = s;
  if (ctx.fillStyle === '#010203') throw new Error(`Unknown color "${c}" — use a hex value like #1155cc.`);
  return ctx.fillStyle;
}
// Docs palette names for common colors: clicking a swatch is faster and surer than the hex box.
const SWATCH = {
  '#000000': 'black', '#434343': 'dark gray 4', '#666666': 'dark gray 3', '#999999': 'dark gray 2', '#cccccc': 'gray', '#ffffff': 'white',
  '#980000': 'red berry', '#ff0000': 'red', '#ff9900': 'orange', '#ffff00': 'yellow', '#00ff00': 'green', '#00ffff': 'cyan',
  '#4a86e8': 'cornflower blue', '#0000ff': 'blue', '#9900ff': 'purple', '#ff00ff': 'magenta', '#1155cc': 'dark cornflower blue 2',
};
// Text or highlight color: a palette swatch when one matches, else the Custom… hex box.
async function setColor(api, id, button, value) {
  const none = /^(none|clear|transparent|off)$/i.test(String(value).trim());
  const hex = none ? null : toHex(value);
  await clickLabel(api, id, button, ['button', 'listbox', 'combobox']);
  if (none) {
    await clickLabel(api, id, 'None', ['button', 'menuitem', 'option'], { exact: true });
    return 'none';
  }
  const sw = SWATCH[hex] && (await until(api, id, pageSwatch, Boolean, 400, [SWATCH[hex]]));
  if (sw) {
    await clickFound(api, id, sw);
    await api.cs(id, 'settle', 60, 400);
    await focusDoc(api, id);
    return `${hex} (${SWATCH[hex]})`;
  }
  await clickLabel(api, id, 'Custom', ['button', 'menuitem'], { exact: true });
  const box = await findLabel(api, id, 'Hex color', ['textbox'], { wait: 1500 });
  if (!box) { await api.keys(id, 'Escape'); throw new Error('The custom color box did not open.'); }
  await clickFound(api, id, box);
  await api.keys(id, `${M}+a`);
  await api.insertText(id, hex);
  await clickLabel(api, id, 'OK', ['button'], { exact: true });
  await focusDoc(api, id);
  return hex;
}

const STYLE_HINT = 'title, subtitle, normal, heading1…heading6';
const LIST_KEY = { numbered: '7', number: '7', ordered: '7', bulleted: '8', bullet: '8', bullets: '8', checklist: '9', check: '9' };

async function run(name, a, api) {
  const id = await api.resolveTab(a);
  const tab = await chrome.tabs.get(id);
  if (!DOC_RE.test(tab.url || '')) throw new Error('The current tab is not a Google Doc. Switch to it (tab_switch) first.');
  switch (name) {
    case 'gdocs_read': {
      // Let recent edits reach Drive before exporting: a short beat for "Saving…" to
      // show up, then wait it out.
      const wait = 400 - (Date.now() - lastEdit);
      if (wait > 0) await sleep(wait);
      let st = null;
      for (let t = 0; t < 40; t++) { st = await api.page(id, pageState); if (!st?.saving) break; await sleep(120); }
      let r = await api.page(id, pageExport, ['html']);
      if (!r?.body && r?.url) {
        // The panel can fetch it too (host permission), e.g. if the export redirects cross-origin.
        try { const x = await fetch(r.url, { credentials: 'include' }); if (x.ok) r = { body: await x.text() }; } catch {}
      }
      if (!r?.body) throw new Error(`Could not export the document (${r?.err || 'no response'}).`);
      const text = summarize(r.body, st || {}, { full: !!a.full });
      return { text, label: `Read “${clip(st?.title || 'document', 40)}”` };
    }

    case 'gdocs_write': {
      let where = 'at the cursor';
      if (a.replace) where = `replacing “${clip(a.replace, 30)}” (${await select(api, id, a.replace, a.occurrence)})`;
      else if (a.after) where = `after “${clip(a.after, 30)}” (${await select(api, id, a.after, a.occurrence, 'end')})`;
      else if (a.before) where = `before “${clip(a.before, 30)}” (${await select(api, id, a.before, a.occurrence, 'start')})`;
      else {
        await focusDoc(api, id);
        if (a.at === 'end') { await api.keys(id, MAC ? 'Meta+ArrowDown' : 'Control+End'); where = 'at the end'; }
        else if (a.at === 'start') { await api.keys(id, MAC ? 'Meta+ArrowUp' : 'Control+Home'); where = 'at the start'; }
      }
      const html = a.html != null ? String(a.html) : a.markdown != null ? api.mdToHtml(a.markdown) : null;
      if (html == null && a.text == null) throw new Error('gdocs_write needs markdown, html or text');
      const chunks = html != null ? html.split(/<!--\s*pagebreak\s*-->/i) : String(a.text).split(/^\s*\\pagebreak\s*$/m);
      let last = '';
      for (let i = 0; i < chunks.length; i++) {
        if (i) await api.keys(id, `${M}+Enter`);
        const c = chunks[i].trim();
        if (!c) continue;
        last = await api.paste(id, html != null ? { html: `<html><body>${c}</body></html>`, clipboard: a.clipboard } : { text: c, clipboard: a.clipboard });
      }
      lastEdit = Date.now();
      const count = (re) => (html?.match(re) || []).length;
      const parts = [count(/<h[1-6][\s>]/gi) && `${count(/<h[1-6][\s>]/gi)} headings`, count(/<table[\s>]/gi) && `${count(/<table[\s>]/gi)} tables`,
        count(/<img\s/gi) && `${count(/<img\s/gi)} images`, chunks.length > 1 && `${chunks.length - 1} page breaks`].filter(Boolean);
      const via = /clipboard/.test(last) ? ' via clipboard' : '';
      return { text: `Pasted ${where}${parts.length ? ': ' + parts.join(', ') : ''}${via}.`, label: `Wrote ${where}` };
    }

    case 'gdocs_select': {
      if (a.cursor === 'doc_start' || a.cursor === 'doc_end') {
        await closeMenus(api, id);
        await focusDoc(api, id);
        const start = a.cursor === 'doc_start';
        await api.keys(id, start ? (MAC ? 'Meta+ArrowUp' : 'Control+Home') : (MAC ? 'Meta+ArrowDown' : 'Control+End'));
        return { text: `Cursor at the ${start ? 'start' : 'end'} of the document.`, label: `Cursor at document ${start ? 'start' : 'end'}` };
      }
      if (!a.text) throw new Error('gdocs_select needs text (or cursor "doc_start" / "doc_end").');
      const m = await select(api, id, a.text, a.occurrence, a.cursor || 'select');
      const what = a.cursor === 'start' ? 'Cursor before' : a.cursor === 'end' ? 'Cursor after' : 'Selected';
      return { text: `${what} “${clip(a.text, 60)}” (${m}).`, label: `${what} “${clip(a.text, 30)}”` };
    }

    case 'gdocs_format': {
      const done = [];
      if (a.text) done.push(`selected “${clip(a.text, 30)}” (${await select(api, id, a.text, a.occurrence)})`);
      else await focusDoc(api, id);
      if (a.clear_formatting) { await api.keys(id, `${M}+\\`); done.push('cleared formatting'); }
      if (a.style) {
        const s = String(a.style).toLowerCase().replace(/[\s_-]+/g, '');
        const h = s.match(/^(?:heading|h)([1-6])$/);
        if (s === 'title' || s === 'subtitle') { await paragraphStyle(api, id, s === 'title' ? 'Title' : 'Subtitle'); await focusDoc(api, id); }
        else {
          const name = h ? `Heading ${h[1]}` : s === 'normal' || s === 'normaltext' ? 'Normal text' : null;
          if (!name) throw new Error(`Unknown style "${a.style}" (${STYLE_HINT})`);
          await api.keys(id, `${M}+Alt+${h ? h[1] : 0}`);
          if (!(await toolbarIs(api, id, 'Styles', name)) && (await api.page(id, pageToolbar, ['Styles'])) != null) await paragraphStyle(api, id, name);
          await focusDoc(api, id);
        }
        done.push(`style ${a.style}`);
      }
      if (a.list) {
        const k = LIST_KEY[String(a.list).toLowerCase()];
        if (!k) throw new Error('list: numbered, bulleted or checklist');
        await api.keys(id, `${M}+Shift+${k}`);
        done.push(`${a.list} list`);
      }
      for (const [k, key, label] of [['bold', 'b', 'Bold'], ['italic', 'i', 'Italic'], ['underline', 'u', 'Underline']]) {
        if (a[k] == null) continue;
        const on = await api.page(id, pagePressed, [label]);
        if (on !== !!a[k]) await api.keys(id, `${M}+${key}`);
        if (on != null && !(await until(api, id, pagePressed, (v) => v === !!a[k], 400, [label]))) {
          throw new Error(`${label} did not turn ${a[k] ? 'on' : 'off'}.${done.length ? ` Already done: ${done.join(', ')}.` : ''}`);
        }
        done.push(`${a[k] ? '' : 'not '}${k}${on == null ? ' (toggled; state unknown)' : ''}`);
      }
      if (a.strikethrough != null) { await api.keys(id, MAC ? 'Meta+Shift+x' : 'Alt+Shift+5'); done.push('toggled strikethrough'); }
      if (a.align) {
        const k = { left: 'l', center: 'e', right: 'r', justify: 'j', justified: 'j' }[String(a.align).toLowerCase()];
        if (!k) throw new Error('align: left, center, right or justify');
        await api.keys(id, `${M}+Shift+${k}`);
        done.push(`align ${a.align}`);
      }
      if (a.link) {
        await api.keys(id, `${M}+k`);
        await fieldOpened(api, id, 'The link box');
        await api.insertText(id, String(a.link));
        await api.keys(id, 'Enter');
        done.push(`link → ${clip(a.link, 60)}`);
      }
      // Toolbar settings last: keyboard shortcuts above need the caret in the document.
      // A failure here keeps what already worked in the message.
      const step = async (f) => {
        try { done.push(await f()); }
        catch (e) { lastEdit = Date.now(); await closeMenus(api, id).catch(() => {}); throw new Error(`${e.message}${done.length ? ` Already done: ${done.join(', ')}.` : ''}`); }
      };
      if (a.font) await step(async () => `${await setFont(api, id, a.font)} ${a.font}`);
      if (a.size) await step(async () => { await setSize(api, id, a.size); return `size ${a.size}`; });
      if (a.color) await step(async () => `color ${await setColor(api, id, 'Text color', a.color)}`);
      if (a.highlight) await step(async () => `highlight ${await setColor(api, id, 'Highlight color', a.highlight)}`);
      // Hand the keyboard back to the document for whatever runs next.
      if (a.font || a.size || a.color || a.highlight) await focusDoc(api, id);
      lastEdit = Date.now();
      // Check the toolbar against what was asked, so the result can be trusted without a re-read.
      if (a.font) {
        const shown = await api.page(id, pageToolbar, ['Font']);
        if (shown && !(await toolbarIs(api, id, 'Font', a.font))) throw new Error(`The font box shows "${shown}", not ${a.font}. Already done: ${done.join(', ')}.`);
      }
      return { text: `Done: ${done.join(', ') || 'nothing to change'}. Style, bold/italic/underline, font and size were checked against the toolbar.`, label: `Formatted${a.text ? ` “${clip(a.text, 30)}”` : ''}` };
    }

    case 'gdocs_comment': {
      const out = [];
      if (a.comment) {
        if (!a.text) throw new Error('A new comment needs text (the passage to anchor it to).');
        const m = await select(api, id, a.text, a.occurrence);
        await api.keys(id, `${M}+Alt+m`);
        await fieldOpened(api, id, 'The comment box');
        await api.insertText(id, String(a.comment));
        await api.keys(id, `${M}+Enter`);
        await sleep(250);
        out.push(`Commented on “${clip(a.text, 40)}” (${m}): "${clip(a.comment, 80)}".`);
      }
      if (a.reply || a.resolve) {
        // The thread: one named by its comment text, else the comment just added.
        const thread = a.thread || a.comment;
        if (!thread) throw new Error('reply/resolve need thread (words from that comment).');
        await closeMenus(api, id);
        const card = async () => { const c = await api.page(id, pageCard, [thread]); if (c?.err) throw new Error(c.err); return c; };
        let c = await card();
        // Clicking the card makes it the active thread, which shows its reply box and buttons.
        await clickFound(api, id, c.head);
        await api.cs(id, 'settle', 60, 400);
        if (a.reply) {
          c = await card();
          if (!c.box) throw new Error(`The reply box did not show on the card "${clip(c.text, 60)}".`);
          await api.click(id, c.box.x, c.box.y);
          await sleep(80);
          await api.insertText(id, String(a.reply));
          // Docs enables the Reply button on key events, which inserted text doesn't send.
          await api.keys(id, 'Space Backspace');
          c = await card();
          if (c.send) await clickFound(api, id, c.send); else await api.keys(id, `${M}+Enter`);
          const posted = await until(api, id, pageCard, (v) => v && !v.err && !v.boxText && v.text.includes(String(a.reply).replace(/\s+/g, ' ').trim().slice(0, 40)), 2500, [thread]);
          if (!posted) throw new Error(`The reply did not post (the reply box still holds "${clip((await card()).boxText, 60)}").${out.length ? ' ' + out.join(' ') : ''}`);
          out.push(`Replied "${clip(a.reply, 60)}".`);
        }
        if (a.resolve) {
          c = await card();
          if (!c.resolve) { await api.mouseEv(id, 'mouseMoved', c.head.x, c.head.y, {}); await sleep(150); c = await card(); }
          if (!c.resolve) throw new Error(`No "Mark as resolved" button on the card "${clip(c.text, 60)}".${out.length ? ' ' + out.join(' ') : ''}`);
          await clickFound(api, id, c.resolve);
          const gone = await until(api, id, pageCard, (v) => v?.err, 2000, [thread]);
          if (!gone) throw new Error(`The thread is still open after clicking resolve.${out.length ? ' ' + out.join(' ') : ''}`);
          out.push('Resolved the thread.');
        }
      }
      if (!out.length) throw new Error('Nothing to do: give comment (new), reply, or resolve.');
      lastEdit = Date.now();
      return { text: out.join(' '), label: a.comment ? `Commented on “${clip(a.text, 30)}”` : a.resolve ? 'Resolved comment' : 'Replied to comment' };
    }

    case 'gdocs_rename': {
      const box = await api.page(id, pageTitleBox);
      if (!box) throw new Error('Could not find the title box.');
      await api.click(id, box.x, box.y);
      await sleep(80);
      await api.keys(id, `${M}+a`);
      await typeKeys(api, id, a.title);
      await api.keys(id, 'Enter');
      await focusDoc(api, id);
      const want = String(a.title).trim();
      const ok = await until(api, id, pageState, (s) => s?.title === want, 2500);
      if (!ok) throw new Error(`Docs did not keep the title (it shows "${(await api.page(id, pageState))?.title}"). Rename it from Drive instead: tab_open https://drive.google.com/file/d/${(tab.url.match(/\/d\/([\w-]+)/) || [])[1]}/view, click "Rename", type, OK.`);
      return { text: `Renamed the document to “${want}” (checked).`, label: `Renamed to “${clip(want, 30)}”` };
    }

    case 'gdocs_equation': {
      if (a.after) await select(api, id, a.after, a.occurrence, 'end');
      else { await closeMenus(api, id); await focusDoc(api, id); }
      // The equation toolbar's "New equation" button inserts one at the cursor.
      let btn = await findLabel(api, id, 'New equation', ['button']);
      if (!btn) {
        await api.keys(id, 'Alt+/');
        await fieldOpened(api, id, 'The menu search');
        await api.insertText(id, 'equation');
        const show = await findLabel(api, id, 'Show equation toolbar', ITEM_ROLES, { wait: 800 });
        if (show) await clickFound(api, id, show); else await api.keys(id, 'Escape');
        btn = await findLabel(api, id, 'New equation', ['button'], { wait: 800 });
      }
      if (!btn) throw new Error('Could not open the equation toolbar (View › Show equation toolbar).');
      await clickFound(api, id, btn);
      await sleep(250);
      // The equation box drops keys sent too fast, so type with gaps. ^ and _ start a
      // super/subscript; \\name followed by a space inserts a symbol (\\alpha, \\sum).
      await typeKeys(api, id, a.equation, 90);
      await sleep(200);
      await api.keys(id, 'Escape');
      lastEdit = Date.now();
      return { text: `Inserted an equation and typed “${clip(a.equation, 60)}”${a.after ? ` after “${clip(a.after, 30)}”` : ''}. gdocs_read can't show equation contents; one screenshot confirms it.`, label: 'Inserted equation' };
    }

    case 'gdocs_mode': {
      const k = { editing: 'z', suggesting: 'x', viewing: 'c' }[String(a.mode).toLowerCase()];
      if (!k) throw new Error('mode: editing, suggesting or viewing');
      await focusDoc(api, id);
      await api.keys(id, `${M}+Alt+Shift+${k}`);
      await sleep(250);
      const st = await api.page(id, pageState);
      return { text: `Switched to ${a.mode} mode${st?.mode ? ` (toolbar shows "${st.mode}")` : ''}.`, label: `${a.mode[0].toUpperCase()}${a.mode.slice(1)} mode` };
    }

    case 'gdocs_command': {
      await closeMenus(api, id);
      await focusDoc(api, id);
      await api.keys(id, 'Alt+/');
      await fieldOpened(api, id, 'The menu search');
      await api.insertText(id, String(a.query));
      await sleep(350);
      let text;
      try {
        // Exact label first: a loose match once ran "Move to previous bookmark" for "Bookmark".
        const p = await api.cs(id, 'menuFind', { label: a.pick || a.query, roles: ['menuitem', 'menuitemcheckbox', 'menuitemradio', 'option'], strict: true });
        await clickFound(api, id, p);
        text = `Ran ${p.desc}`;
      } catch (e) {
        // Nothing listed at all (results not rendered as menu items): Enter runs the top one.
        if (a.pick || !/^No visible menu item/.test(e.message) || / Open menu has:/.test(e.message)) {
          await api.keys(id, 'Escape');
          throw new Error(`${e.message}${a.pick ? '' : ' Give pick = the exact result label.'}`);
        }
        await api.keys(id, 'Enter');
        text = `Ran the top menu-search result for "${a.query}" (no result was listed to check it against)`;
      }
      text += (await api.cs(id, 'settle', 80, 700)) || '';
      lastEdit = Date.now();
      return { text, label: `Ran “${clip(a.pick || a.query, 40)}”` };
    }
  }
  throw new Error(`Unknown tool ${name}`);
}

export default {
  id: 'gdocs',
  title: 'Google Docs',
  match: (url) => DOC_RE.test(url),
  prompt: `Google Docs tools (gdocs_*) are on. Docs draws text on a canvas: never type it key by key, format it by clicking through menus and toolbars, or read it from screenshots.
- Order of operations: (1) the whole body in one gdocs_write; (2) all gdocs_format fix-ups in one response; (3) rename, comments, mode, header/footer, page numbers, table of contents and other inserts; (4) one gdocs_read, fix what it shows is off; (5) the summary. Don't interleave reading with writing.
- Fastest path: write the whole body in ONE gdocs_write (HTML). Inline CSS carries over: font-family (any Google font), font-size in pt, color, background-color (highlight), <b> <i> <u> <s>, <a href>, <h1>–<h6>, <ul>/<ol>, <hr>, tables (colspan/rowspan, <td style="background-color:…">, <b> header cells), <img src width height alt>, and <!--pagebreak-->.
- Fix-ups: gdocs_format on a text match. One call sets style, font, size, color, highlight, bold/italic/underline, list (numbered/bulleted/checklist), align and link together. Fonts not in the menu are added from More fonts for you. Title/Subtitle exist only as gdocs_format style; a style resets the paragraph's font, so give style and font in the same call.
- Put independent fix-ups in ONE response (several gdocs_format calls); they run in order and each re-finds its text.
- gdocs tools check their own work (toolbar state, title, comment cards) and return an error when something didn't take. A result without an error is done: don't screenshot, re-read or redo it.
- gdocs_read lists every font and size run per paragraph. Call it once after the body and fix-ups, and once at the end; not after each edit, and never screenshots to read text.
- Rename: gdocs_rename. Equation: gdocs_equation (e.g. "E=mc^2"). Comments: gdocs_comment adds, replies to (reply + thread) and resolves (resolve + thread) — no clicking on comment cards.
- Inserts happen at the cursor: place it first with gdocs_select (cursor start/end). Paths that work in current Docs (menu tool):
  Header: ["Insert","Page elements","Header"], type the text, Escape. Page numbers: ["Insert","Page elements","Page numbers"], then the footer option from "New on screen". Table of contents: ["Insert","Page elements","Table of contents"], then a style. Bookmark: ["Insert","Bookmark"], then Escape. Merge cells: click the first cell, shift-click the last, ["Format","Table","Merge cells"]. Named version: ["File","Version history","Name current version"], type, Save.
  Page setup: gdocs_command "Page setup". Image: click it, then "Wrap text options" › "Wrap text"; "Image options" › "Size & rotation" › Width; alt text: gdocs_command query and pick "Alt text".
  Link to a bookmark or heading: gdocs_format link = this document's URL + "#bookmark=<id>" or "#heading=<id>" (ids are in gdocs_read).
  Sharing: the Share button › "Restricted change general access" › "Anyone with the link", then the role › "Commenter", Done.
  Suggestions: gdocs_mode suggesting, gdocs_write (after/replace), gdocs_mode editing.
- Shortcuts: page break ${M}+Enter, undo ${M}+z, find and replace ${M}+Shift+h (type into Find and Replace with, click "Replace all", Close).`,
  // Read automatically before the run ends, so the final answer is checked against the document.
  finalCheck: 'gdocs_read',
  icon(name, a) {
    switch (name) {
      case 'gdocs_read': return 'file-magnifying-glass';
      case 'gdocs_write': return a.replace ? 'pen-to-square' : 'pen-nib';
      case 'gdocs_select': return a.cursor && a.cursor !== 'select' ? 'i-cursor' : 'highlighter-line';
      case 'gdocs_format':
        if (a.list) return { numbered: 'list-ol', bulleted: 'list-ul', checklist: 'list-check' }[a.list] || 'list';
        if (a.style) return 'heading';
        if (a.clear_formatting) return 'text-slash';
        if (a.link) return 'link';
        if (a.align) return `align-${a.align}`;
        if (a.highlight) return 'highlighter';
        if (a.color) return 'palette';
        if (a.bold != null) return 'bold';
        if (a.italic != null) return 'italic';
        if (a.underline != null) return 'underline';
        if (a.strikethrough != null) return 'strikethrough';
        if (a.size) return 'text-size';
        return 'font';
      case 'gdocs_comment': return a.resolve ? 'comment-check' : a.reply ? 'reply' : 'comment';
      case 'gdocs_rename': return 'tag';
      case 'gdocs_equation': return 'square-root-variable';
      case 'gdocs_mode': return { editing: 'pen', suggesting: 'comment-pen', viewing: 'eye' }[a.mode] || 'eye';
      case 'gdocs_command': return 'terminal';
    }
  },
  tools: [
    fn('gdocs_read', 'Structured state of the open Google Doc (from its export): page size and margins, each paragraph with style (Title/Heading…), alignment and inline formatting, tables as rows with merged cells and colors, images (size, alt, wrap), links, bookmarks, page breaks, header/footer, comments, on-screen comment/suggestion cards, save status, mode.', {
      full: { type: 'boolean', description: 'Full paragraph text (default clipped)' },
    }),
    fn('gdocs_write', 'Insert content into the Doc in one paste. markdown or html: headings, bold/italic, links, lists, tables ("||" merges a cell into the previous one; or HTML colspan/rowspan, cell background-color), images by public URL (![alt](url =300x200)). Inline CSS keeps font-family, font-size, color and background-color. A "\\pagebreak" line (or <!--pagebreak-->) inserts a page break. Position: cursor (default), at start/end, after/before a text match, or replace a match.', {
      markdown: { type: 'string' }, html: { type: 'string' }, text: { type: 'string', description: 'Plain text' },
      at: { type: 'string', enum: ['cursor', 'start', 'end'] }, after: { type: 'string' }, before: { type: 'string' }, replace: { type: 'string' }, occurrence,
      clipboard: { type: 'boolean', description: 'Paste through the real clipboard (if a normal paste did nothing)' },
    }),
    fn('gdocs_select', 'Select a text match in the Doc (case-insensitive find), or put the cursor at its start/end; cursor "doc_start"/"doc_end" (no text) puts it at the start or end of the whole document. Later key/type/paste calls act there.', {
      text: { type: 'string' }, occurrence, cursor: { type: 'string', enum: ['select', 'start', 'end', 'doc_start', 'doc_end'] },
    }),
    fn('gdocs_format', 'Format a text match (or the current selection) in one call: paragraph style, list, bold/italic/underline (true/false: set, not toggled), strikethrough (toggles), font family (any Google font), size, text color, highlight, align, link URL, clear_formatting. Styles and lists act on whole paragraphs. Order applied: style, list, B/I/U, align, link, then font, size, color, highlight.', {
      text: { type: 'string' }, occurrence, style: { type: 'string', description: STYLE_HINT },
      list: { type: 'string', enum: ['numbered', 'bulleted', 'checklist'] },
      font: { type: 'string', description: 'e.g. "Playfair Display", "Roboto Mono"' }, size: { type: 'number', description: 'Points' },
      color: { type: 'string', description: 'Text color: hex (#1155cc) or CSS name' }, highlight: { type: 'string', description: 'Hex, CSS name, or "none"' },
      bold: { type: 'boolean' }, italic: { type: 'boolean' }, underline: { type: 'boolean' }, strikethrough: { type: 'boolean' },
      align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] }, link: { type: 'string' }, clear_formatting: { type: 'boolean' },
    }),
    fn('gdocs_comment', 'Comments in one call: add one (text = passage to anchor it to, comment = its text), reply to a thread, and/or resolve a thread. thread = words from the thread\'s comment (defaults to the comment added in this call). Each step is checked on the comment card.', {
      text: { type: 'string' }, comment: { type: 'string' }, occurrence,
      thread: { type: 'string' }, reply: { type: 'string' }, resolve: { type: 'boolean' },
    }),
    fn('gdocs_rename', 'Rename the document (checked against the title).', { title: { type: 'string' } }, ['title']),
    fn('gdocs_equation', 'Insert an equation at the cursor, or after a text match, and type it: "E=mc^2", "x_1+x_2", "\\alpha r^2".', {
      equation: { type: 'string' }, after: { type: 'string' }, occurrence,
    }, ['equation']),
    fn('gdocs_mode', 'Switch to editing, suggesting (edits become suggestions) or viewing mode.', {
      mode: { type: 'string', enum: ['editing', 'suggesting', 'viewing'] },
    }, ['mode']),
    fn('gdocs_command', 'Run a Docs menu command by name through the menu search, e.g. "Page break", "Merge cells", "Equation", "Bookmark", "Page numbers", "Header", "Name current version", "Page setup". The result labeled exactly like query (or pick) runs; if none is, the error lists the results — then give pick = the exact label.', {
      query: { type: 'string' }, pick: { type: 'string' },
    }, ['query']),
  ],
  preLabel(name, a = {}) {
    const q = (s) => `“${clip(String(s ?? ''), 36)}”`;
    switch (name) {
      case 'gdocs_read': return 'Reading document';
      case 'gdocs_write': return a.replace ? `Replacing ${q(a.replace)}` : 'Writing to document';
      case 'gdocs_select': return a.text ? `Selecting ${q(a.text)}` : `Cursor to document ${a.cursor === 'doc_end' ? 'end' : 'start'}`;
      case 'gdocs_format': return a.text ? `Formatting ${q(a.text)}` : 'Formatting selection';
      case 'gdocs_comment': return a.comment ? `Commenting on ${q(a.text)}` : a.resolve ? 'Resolving comment' : 'Replying to comment';
      case 'gdocs_rename': return `Renaming to ${q(a.title)}`;
      case 'gdocs_equation': return `Inserting equation ${q(a.equation)}`;
      case 'gdocs_mode': return `Switching to ${a.mode || ''} mode`;
      case 'gdocs_command': return `Running ${q(a.pick || a.query)}`;
    }
    return name;
  },
  // Docs ignores synthetic input, so these tools always use trusted (DevTools) input.
  async exec(name, a, api) {
    const prev = api.agent.trusted;
    api.agent.trusted = true;
    try { return await run(name, a, api); } finally { api.agent.trusted = prev; }
  },
};
