// Canva pack. Canva draws a design as HTML inside one page container, sized in
// design pixels and shrunk with transform: scale(…), so these tools read the
// design straight from that DOM. They pick elements from Position › Layers
// (clicks on the canvas often select the page background or start text
// editing), and set size, position, colour and type through Canva's own number
// fields and colour search, reading every value back.
import { toHex } from './gdocs.js';

const MAC = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform);
const M = MAC ? 'Meta' : 'Control';
const SITE_RE = /^https:\/\/www\.canva\.com\//;
const DESIGN_RE = /^https:\/\/www\.canva\.com\/design\/([\w-]+)/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const fn = (name, description, properties = {}, required = []) => ({
  type: 'function', function: { name, description, parameters: { type: 'object', properties, required } },
});

// ── Page-side helpers (run in the tab through chrome.scripting) ──

// A visible control by its accessible name: exactly `name`, or starting with
// `prefix` (and containing `has`). Where to click it, its state, and whether
// something else sits on top of it. focus: focus it and select its text.
function pageControl(q) {
  const SEL = 'button,[role=button],[role=tab],[role=menuitem],[role=option],[role=radio],[role=switch],[role=checkbox],input,textarea,[role=combobox],[role=spinbutton],[role=searchbox],[role=textbox]';
  const roleOf = (e) => e.getAttribute('role') || (e.tagName === 'BUTTON' ? 'button' : e.tagName === 'TEXTAREA' ? 'textbox'
    : e.tagName === 'INPUT' ? ({ number: 'spinbutton', search: 'searchbox', checkbox: 'checkbox', radio: 'radio' }[e.type] || 'textbox') : '');
  const nameOf = (e) => (e.getAttribute('aria-label')
    || (e.getAttribute('aria-labelledby') || '').split(/\s+/).map((i) => document.getElementById(i)?.textContent || '').join(' ')
    || [...(e.labels || [])].map((l) => l.textContent).join(' ')
    || (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' ? e.placeholder : e.innerText)
    || e.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
  let k = 0;
  for (const e of document.querySelectorAll(SEL)) {
    if (e.closest('[id^="accessibility_dom"]')) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    if (getComputedStyle(e).visibility === 'hidden') continue;
    if (q.roles && !q.roles.includes(roleOf(e))) continue;
    const n = nameOf(e);
    if (q.name != null ? n !== q.name : !n.startsWith(q.prefix)) continue;
    if (q.has && !n.toLowerCase().includes(q.has)) continue;
    if (++k < (q.nth || 1)) continue;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    const covered = !!top && !(e.contains(top) || top.contains(e));
    if (q.focus) { e.focus(); try { e.select?.(); } catch {} }
    const value = 'value' in e && e.tagName !== 'BUTTON' ? e.value : e.getAttribute('aria-valuenow') ?? (e.innerText || '').replace(/\s+/g, ' ').trim();
    return {
      x, y, name: n, role: roleOf(e), value, pressed: e.getAttribute('aria-pressed') === 'true', selected: e.getAttribute('aria-selected') === 'true',
      expanded: e.getAttribute('aria-expanded'), disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true',
      covered, cover: covered ? (top.getAttribute('aria-label') || top.innerText || top.tagName).replace(/\s+/g, ' ').trim().slice(0, 60) : '',
    };
  }
  return null;
}

// A side-panel tab by the start of its name ("Layers", "Arrange", "Text").
function pageTab(name) {
  for (const t of document.querySelectorAll('[role=tab]')) {
    const n = (t.getAttribute('aria-label') || t.innerText || '').replace(/\s+/g, ' ').trim();
    if (!new RegExp(`^${name}\\b`).test(n) || !t.getClientRects().length) continue;
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, selected: t.getAttribute('aria-selected') === 'true' };
  }
  return null;
}

// Position › Layers: one row per element, front to back, "Background" last.
// show: scroll that row into view first.
function pageLayers(show) {
  const tab = [...document.querySelectorAll('[role=tab]')].find((t) => /^Layers\b/.test((t.getAttribute('aria-label') || t.innerText || '').trim()) && t.getClientRects().length);
  if (!tab) return null;
  const tr = tab.getBoundingClientRect();
  const out = { selected: tab.getAttribute('aria-selected') === 'true', x: tr.left + tr.width / 2, y: tr.top + tr.height / 2, rows: [] };
  if (!out.selected) return out;
  const id = tab.getAttribute('aria-controls');
  const panel = (id && document.getElementById(id)) || [...document.querySelectorAll('[role=tabpanel]')].find((p) => p.getClientRects().length && p.querySelector('[role=radiogroup]'));
  if (!panel) return out;
  const rows = [...panel.querySelectorAll('button,[role=button]')].filter((b) => {
    const n = (b.getAttribute('aria-label') || b.innerText || '').trim();
    return n && b.getClientRects().length && !/^(Open context menu|Close|Show |Hide |Lock|Unlock)/i.test(n);
  });
  if (show != null && rows[show]) rows[show].scrollIntoView({ block: 'nearest' });
  for (const b of rows) {
    const r = b.getBoundingClientRect();
    out.rows.push({ name: (b.getAttribute('aria-label') || b.innerText || '').replace(/\s+/g, ' ').trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 });
  }
  return out;
}

// The design on screen: page size and background, every element (text boxes,
// shapes, images) in design pixels back to front, and what is selected. Ids
// (c1, c2…) stay with an element's node across calls.
function pageDesign() {
  const reg = (window.__tuffCanva ||= { ids: new WeakMap(), n: 0 });
  const MIRROR = '[id^="accessibility_dom"]';
  let page = null, best = 0;
  for (const d of document.querySelectorAll('div[style*="scale("]')) {
    const m = (d.getAttribute('style') || '').match(/width:\s*([\d.]+)px;\s*height:\s*([\d.]+)px;[^]*?scale\(([\d.]+)\)/);
    if (!m) continue;
    const r = d.getBoundingClientRect();
    const seen = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    if (seen > best) { best = seen; page = { el: d, w: +m[1], h: +m[2], s: +m[3], r }; }
  }
  if (!page) return { err: 'No Canva design page is on screen (is the editor open and loaded?).' };
  const { el: P, s, r: PR } = page;
  const D = (v) => Math.round(v * 10) / 10;
  const toDesign = (r) => ({ x: D((r.left - PR.left) / s), y: D((r.top - PR.top) / s), w: D(r.width / s), h: D(r.height / s) });
  const same = (a, b, tol = 1.5) => Math.abs(a.left - b.left) < tol && Math.abs(a.top - b.top) < tol && Math.abs(a.width - b.width) < tol && Math.abs(a.height - b.height) < tol;
  const color = (c) => {
    const m = String(c).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
    if (!m || (m[4] != null && +m[4] === 0)) return null;
    const hex = '#' + [m[1], m[2], m[3]].map((v) => Math.round(+v).toString(16).padStart(2, '0')).join('');
    return m[4] != null && +m[4] < 1 ? `${hex} (${Math.round(+m[4] * 100)}% alpha)` : hex;
  };
  const textOf = (e) => (e.innerText || e.textContent || '').replace(/﻿/g, '').trim();
  const rootOf = (leaf) => {
    let e = leaf;
    for (let p = e.parentElement; p && p !== P; p = p.parentElement) {
      if (!same(p.getBoundingClientRect(), e.getBoundingClientRect())) break;
      e = p;
    }
    return e;
  };
  const all = [...P.querySelectorAll('*')].filter((e) => !e.closest(MIRROR));
  const full = (r) => same(r, PR, 2);
  let background = null;
  for (const e of all) if (!(e instanceof SVGElement) && full(e.getBoundingClientRect())) background = color(getComputedStyle(e).backgroundColor) || background;

  const roots = new Map();
  for (const p of all) {
    if (p.tagName !== 'P' || !p.getClientRects().length || !textOf(p)) continue;
    const root = rootOf(p.parentElement);
    if (!roots.has(root)) roots.set(root, { root, kind: 'text', leaf: p });
  }
  const texts = [...roots.keys()];
  for (const e of all) {
    if (e.closest('p')) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || full(r)) continue;
    let fill = null;
    if (e instanceof SVGElement) fill = /^(path|rect|circle|ellipse|polygon)$/i.test(e.tagName) ? color(getComputedStyle(e).fill) : null;
    else if (e.tagName === 'IMG') fill = 'image';
    else fill = color(getComputedStyle(e).backgroundColor);
    if (!fill) continue;
    const root = rootOf(e instanceof SVGElement ? e.ownerSVGElement || e : e);
    if (texts.some((t) => t.contains(root))) continue; // a highlight inside a text box
    if (!roots.has(root)) roots.set(root, { root, kind: fill === 'image' ? 'image' : 'shape', leaf: e, fill: fill === 'image' ? null : fill });
  }
  // Text inside a shape belongs to the shape; a box inside another box is part of it.
  for (const root of roots.keys()) {
    for (const [other, o] of roots) if (other !== root && o.kind !== 'text' && other.contains(root)) { roots.delete(root); break; }
  }
  const list = [...roots.values()].sort((a, b) => (a.root.compareDocumentPosition(b.root) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const elements = list.map((it, i) => {
    let id = reg.ids.get(it.root);
    if (!id) { id = 'c' + (++reg.n); reg.ids.set(it.root, id); }
    let opacity = 1;
    for (let e = it.leaf; e && e !== P; e = e.parentElement) opacity *= +getComputedStyle(e).opacity;
    const o = { id, kind: it.kind, ...toDesign(it.root.getBoundingClientRect()), opacity: Math.round(opacity * 100) / 100, z: list.length - i };
    if (it.fill) o.fill = it.fill;
    if (it.kind === 'shape') {
      const lr = it.leaf.getBoundingClientRect(), cs = getComputedStyle(it.leaf), t = it.leaf.tagName.toLowerCase();
      if (t === 'circle' || t === 'ellipse' || /circle|ellipse/.test(cs.clipPath) || parseFloat(cs.borderRadius) >= Math.min(lr.width, lr.height) / 2 - 1) {
        o.shape = Math.abs(lr.width - lr.height) < 1.5 ? 'circle' : 'ellipse';
      }
    }
    const paras = [...it.root.querySelectorAll('p')].filter((p) => !p.closest(MIRROR) && textOf(p));
    if (paras.length) {
      o.text = paras.map(textOf).join('\n');
      const span = [...paras[0].querySelectorAll('span')].find((x) => textOf(x)) || paras[0];
      const cs = getComputedStyle(span);
      // Canva's font size box shows points: 96 design px = 72.
      o.size = Math.round(parseFloat(cs.fontSize) * 0.75 * 10) / 10;
      o.weight = +cs.fontWeight || cs.fontWeight;
      if (cs.fontStyle === 'italic') o.italic = true;
      o.color = color(cs.color);
      o.align = getComputedStyle(paras[0]).textAlign;
    }
    return o;
  }).reverse();

  // The selection: the box drawn by the resize handles, matched to an element.
  let selection = null;
  const hs = [...document.querySelectorAll('[aria-label^="Resize selection"]')].filter((e) => e.getClientRects().length);
  const at = (...names) => {
    for (const n of names) {
      const h = hs.find((e) => e.getAttribute('aria-label').endsWith(n));
      if (h) { const r = h.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
    }
    return null;
  };
  const L = at('left edge', 'top left corner', 'bottom left corner'), R = at('right edge', 'top right corner', 'bottom right corner');
  const T = at('top edge', 'top left corner', 'top right corner'), B = at('bottom edge', 'bottom left corner', 'bottom right corner');
  const active = document.activeElement;
  const editRoot = active?.isContentEditable && P.contains(active) ? [...roots.keys()].find((r) => r.contains(active)) : null;
  if (editRoot) selection = { editing: reg.ids.get(editRoot) };
  else if (L && R && T && B) {
    const box = toDesign({ left: L.x, top: T.y, width: R.x - L.x, height: B.y - T.y });
    const tol = 4 / s;
    const hit = elements.find((o) => Math.abs(o.x - box.x) < tol && Math.abs(o.y - box.y) < tol && Math.abs(o.w - box.w) < tol * 2 && Math.abs(o.h - box.h) < tol * 2);
    selection = { box, id: hit?.id || null };
  } else {
    const label = (e) => e.getAttribute('aria-label') || '';
    const btns = [...document.querySelectorAll('button')].filter((b) => b.getClientRects().length);
    if (btns.some((b) => label(b).startsWith('Current color ')) && !btns.some((b) => label(b).startsWith('Current text color'))) selection = { page: true };
  }
  return {
    title: document.title.replace(/\s*-\s*[\d.]+\s*×\s*[\d.]+\s*\w*\s*$/, ''), w: page.w, h: page.h, scale: s,
    origin: { x: PR.left, y: PR.top }, background, elements, selection,
  };
}

// ── Panel-side helpers ──
async function until(api, id, func, want, ms = 1500, args = []) {
  const end = performance.now() + ms;
  for (;;) {
    const v = await api.page(id, func, args);
    if (want(v)) return v;
    if (performance.now() > end) return null;
    await sleep(60);
  }
}
const ctl = (api, id, q) => api.page(id, pageControl, [q]);
const waitCtl = (api, id, q, ms = 1500) => until(api, id, pageControl, Boolean, ms, [q]);
const said = (q) => (q.name != null ? `"${q.name}"` : `"${q.prefix}…"`);

async function clickAt(api, id, p) {
  await api.mouseEv(id, 'mouseMoved', p.x, p.y, {});
  await api.click(id, p.x, p.y);
  await api.cs(id, 'quiet', 60, 600);
}
// Click a control by name. An open list or menu on top of it is closed first
// (Escape), never clicked through.
async function press(api, id, q, what, wait = 1500) {
  let c = await waitCtl(api, id, q, wait);
  if (!c) throw new Error(`${what || said(q)} is not on screen.`);
  if (c.disabled) throw new Error(`${what || said(q)} is disabled.`);
  if (c.covered) {
    await api.keys(id, 'Escape');
    await sleep(150);
    c = await ctl(api, id, q);
    if (!c || c.covered) throw new Error(`${what || said(q)} is covered by "${c?.cover || 'something'}" and Escape did not clear it.`);
  }
  await clickAt(api, id, c);
  return c;
}
// Put a value in a field the way a careful person does: focus, select all,
// type the whole value, check it, Enter, check it again (Canva adds " px" and
// rounds). Returns what the field shows.
async function setField(api, id, q, value, { enter = true, what = said(q), check = true } = {}) {
  const v = String(value);
  for (let attempt = 0; ; attempt++) {
    const c = await waitCtl(api, id, { ...q, focus: true }, 1500);
    if (!c) throw new Error(`The ${what} field is not on screen.`);
    if (c.disabled) throw new Error(`The ${what} field is disabled for this element.`);
    // Focus handlers reformat the value ("378 px" → "378") and drop the selection.
    await sleep(50);
    await api.keys(id, `${M}+a`);
    await api.insertText(id, v);
    const typed = await ctl(api, id, q);
    if (check && !api.sameValue(typed?.value, v)) {
      if (attempt) throw new Error(`Typed ${v} into ${what}, but it shows "${typed?.value}".`);
      continue;
    }
    if (enter) { await api.keys(id, 'Enter'); await api.cs(id, 'quiet', 80, 700); }
    const after = await ctl(api, id, q);
    if (check && enter && after && !api.sameValue(after.value, v)) throw new Error(`Set ${what} to ${v}, but after Enter it shows "${after.value}".`);
    return after?.value ?? typed?.value ?? v;
  }
}

async function design(api, id) {
  const d = await api.page(id, pageDesign);
  if (!d || d.err) throw new Error(d?.err || 'Could not read the design.');
  return d;
}
const num = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));
function fmtEl(e) {
  const head = `${e.id} ${e.shape || e.kind}${e.layer ? ` "${clip(e.layer, 40)}"` : ''}: ${num(e.w)}×${num(e.h)} at (${num(e.x)}, ${num(e.y)})`;
  const bits = [];
  if (e.text != null) bits.push(`text "${clip(e.text.replace(/\n/g, ' ⏎ '), 80)}"`);
  if (e.text != null) bits.push(`${e.font || 'font ?'} ${e.size}${+e.weight >= 600 ? ' bold' : ''}${e.italic ? ' italic' : ''}, color ${e.color || '?'}, align ${e.align}`);
  if (e.fill) bits.push(`fill ${e.fill}`);
  if (e.opacity !== 1) bits.push(`opacity ${e.opacity}`);
  return `${head}${bits.length ? '; ' + bits.join('; ') : ''}`;
}
function selText(d) {
  const s = d.selection;
  if (!s) return 'Selected: nothing';
  if (s.editing) return `Editing text in ${s.editing} (Escape leaves the text box selected)`;
  if (s.page) return `Selected: page background (${d.background || 'no fill'})`;
  const e = s.id && d.elements.find((x) => x.id === s.id);
  return e ? `Selected: ${fmtEl(e)}` : `Selected: an element ${num(s.box.w)}×${num(s.box.h)} at (${num(s.box.x)}, ${num(s.box.y)})`;
}

// Layer names onto elements: both lists run front to back (Layers ends with "Background").
function attachLayers(d, rows) {
  const list = rows.filter((r) => r.name !== 'Background');
  if (list.length === d.elements.length) d.elements.forEach((e, i) => { e.layer = list[i].name; e.row = rows.indexOf(list[i]); });
  else {
    const free = [...list];
    for (const e of d.elements.filter((x) => x.text)) {
      const r = free.find((x) => norm(x.name) === norm(e.text) || norm(e.text).startsWith(norm(x.name).replace(/…$/, '')));
      if (r) { e.layer = r.name; e.row = rows.indexOf(r); free.splice(free.indexOf(r), 1); }
    }
    for (const e of d.elements.filter((x) => x.row == null)) {
      const r = free.shift();
      if (r) { e.layer = r.name; e.row = rows.indexOf(r); }
    }
  }
  return d;
}

// The page itself selected: click a spot of the page that no element covers.
async function selectPage(api, id, d) {
  const inside = (x, y) => d.elements.some((e) => x >= e.x - 4 && x <= e.x + e.w + 4 && y >= e.y - 4 && y <= e.y + e.h + 4);
  const spots = [[0.03, 0.03], [0.97, 0.03], [0.03, 0.97], [0.97, 0.97], [0.5, 0.02], [0.02, 0.5], [0.98, 0.5], [0.5, 0.98]];
  const spot = spots.map(([fx, fy]) => [d.w * fx, d.h * fy]).find(([x, y]) => !inside(x, y));
  if (!spot) throw new Error('Every part of the page is covered by elements; select one with canva_select instead.');
  await clickAt(api, id, { x: d.origin.x + spot[0] * d.scale, y: d.origin.y + spot[1] * d.scale });
}

// Position panel open on a tab ("Layers" or "Arrange").
async function openTab(api, id, name) {
  let t = await api.page(id, pageTab, [name]);
  if (!t) {
    let pos = await ctl(api, id, { name: 'Position', roles: ['button'] });
    if (!pos) { await selectPage(api, id, await design(api, id)); pos = await waitCtl(api, id, { name: 'Position', roles: ['button'] }, 1200); }
    if (!pos) throw new Error('Canva shows no Position button, so Position › Layers can\'t be opened.');
    await press(api, id, { name: 'Position', roles: ['button'] }, 'The Position button');
    t = await until(api, id, pageTab, Boolean, 1500, [name]);
    if (!t) throw new Error(`The Position panel did not show its ${name} tab.`);
  }
  if (!t.selected) {
    await clickAt(api, id, t);
    if (!(await until(api, id, pageTab, (v) => v?.selected, 1200, [name]))) throw new Error(`Could not switch the Position panel to ${name}.`);
  }
}
async function layers(api, id) {
  await openTab(api, id, 'Layers');
  const L = await until(api, id, pageLayers, (v) => v?.rows?.length, 1500);
  if (!L) throw new Error('The Layers list is empty or did not load.');
  return L;
}

// Select an element through its Layers row and check the selection box is on it.
// which: an id from canva_read (c3), a layer name, the element's text, or "background".
async function selectEl(api, id, which) {
  const L = await layers(api, id);
  const d = attachLayers(await design(api, id), L.rows);
  const w = norm(which);
  if (w === 'background' || w === 'page') {
    const i = L.rows.findIndex((r) => r.name === 'Background');
    if (i < 0) throw new Error('No Background row in the Layers list.');
    const row = (await api.page(id, pageLayers, [i])).rows[i];
    await clickAt(api, id, row);
    const after = await until(api, id, pageDesign, (v) => v?.selection?.page, 1500);
    if (!after) throw new Error(`Clicked the Background layer, but ${selText(await design(api, id)).toLowerCase()}.`);
    return { el: null, d: after };
  }
  const el = /^c\d+$/.test(w) ? d.elements.find((e) => e.id === w)
    : d.elements.find((e) => norm(e.layer) === w) || d.elements.find((e) => e.text && norm(e.text) === w) || d.elements.find((e) => e.text && norm(e.text).includes(w));
  if (!el) throw new Error(`No element "${which}". Elements: ${d.elements.map((e) => `${e.id} ${e.layer || e.kind}`).join(', ') || 'none'}.`);
  if (el.row == null) throw new Error(`${el.id} has no row in the Layers list (rows: ${L.rows.map((r) => r.name).join(', ')}).`);
  const row = (await api.page(id, pageLayers, [el.row])).rows[el.row];
  await clickAt(api, id, row);
  const on = (v) => { const b = v?.selection?.box; return b && Math.abs(b.x - el.x) < 8 / v.scale && Math.abs(b.y - el.y) < 8 / v.scale; };
  const after = await until(api, id, pageDesign, on, 1500);
  if (!after) throw new Error(`Clicked the "${el.layer}" layer, but ${selText(await design(api, id)).toLowerCase()} — not ${el.id}.`);
  attachLayers(after, L.rows);
  return { el: after.elements.find((e) => e.id === el.id) || el, d: after };
}

// Font name and size of the selected text box, as the toolbar shows them.
async function textToolbar(api, id) {
  const f = await ctl(api, id, { prefix: 'Toggle font selector, current font: ', roles: ['button'] });
  const s = await ctl(api, id, { name: 'Font size', roles: ['combobox', 'textbox', 'spinbutton'] });
  return { font: f ? f.name.replace(/^Toggle font selector, current font: /, '') : null, size: s ? parseFloat(s.value) : null };
}

async function setGeometry(api, id, a) {
  await openTab(api, id, 'Arrange');
  const out = [];
  const F = [['w', 'Width'], ['h', 'Height'], ['x', 'X'], ['y', 'Y']].filter(([k]) => a[k] != null);
  if (a.w != null && a.h != null) {
    const ratio = await ctl(api, id, { name: 'Ratio', roles: ['button'] });
    if (ratio?.pressed) { await clickAt(api, id, ratio); out.push('unlocked the aspect ratio'); }
  }
  for (const [k, label] of F) {
    try { out.push(`${label} ${await setField(api, id, { name: label, roles: ['textbox', 'spinbutton'] }, a[k], { what: label })}`); }
    catch (e) { throw new Error(/disabled/.test(e.message) && k === 'h' ? 'Height is disabled for this element (a text box\'s height follows its text).' : e.message); }
  }
  // One field can move another (a locked ratio, text reflow): read them all back.
  for (const [k, label] of F) {
    const c = await ctl(api, id, { name: label, roles: ['textbox', 'spinbutton'] });
    if (c && !api.sameValue(c.value, String(a[k]))) throw new Error(`${label} ended up "${c.value}", not ${a[k]} (setting another field changed it).`);
  }
  return out.join(', ');
}

// Fill or text colour through the colour panel's search: type the hex, click its swatch.
async function setColor(api, id, which, value) {
  const hex = toHex(value);
  const q = which === 'text' ? { prefix: 'Current text color', roles: ['button'] } : { prefix: 'Current color ', roles: ['button'] };
  await press(api, id, q, which === 'text' ? 'The text color button (select a text box first)' : 'The color button (select a shape or the page first)');
  await setField(api, id, { prefix: 'Search', has: 'color', roles: ['searchbox', 'textbox'] }, hex, { what: 'color search' });
  const sw = await waitCtl(api, id, { name: hex, roles: ['button'] }, 2500);
  if (!sw) throw new Error(`Canva's color search showed no swatch named ${hex}.`);
  await clickAt(api, id, sw);
  return `${which === 'text' ? 'text color' : 'fill'} ${hex}`;
}

async function setOpacity(api, id, value) {
  const pct = Math.round(+value <= 1 ? +value * 100 : +value);
  if (!(pct >= 0 && pct <= 100)) throw new Error('opacity: 0–1 (or 0–100)');
  await press(api, id, { name: 'Transparency', roles: ['button'] }, 'The Transparency button');
  const shown = await setField(api, id, { name: 'Transparency', roles: ['spinbutton', 'textbox', 'slider'] }, pct, { what: 'Transparency' });
  const open = await ctl(api, id, { name: 'Transparency', roles: ['button'] });
  if (open?.expanded === 'true') await clickAt(api, id, open);
  return `opacity ${shown}%`;
}

async function setFont(api, id, font) {
  await press(api, id, { prefix: 'Toggle font selector', roles: ['button'] }, 'The font button (select a text box first)');
  const box = (await waitCtl(api, id, { prefix: 'Try', roles: ['searchbox', 'textbox'] }, 1500)) ? { prefix: 'Try', roles: ['searchbox', 'textbox'] } : { prefix: 'Search', has: 'font', roles: ['searchbox', 'textbox', 'combobox'] };
  await setField(api, id, box, font, { what: 'font search', enter: false });
  const hit = await waitCtl(api, id, { name: font, roles: ['button'] }, 3000);
  if (!hit) throw new Error(`"${font}" is not in Canva's font list.`);
  await clickAt(api, id, hit);
  const now = await until(api, id, pageControl, (v) => v && norm(v.name.replace(/^Toggle font selector, current font: /, '')) === norm(font), 1500,
    [{ prefix: 'Toggle font selector, current font: ', roles: ['button'] }]);
  if (!now) throw new Error(`Picked "${font}", but the font button shows "${(await textToolbar(api, id)).font}".`);
  return `font ${font}`;
}

async function setSize(api, id, size) {
  const q = { name: 'Font size', roles: ['combobox', 'textbox', 'spinbutton'] };
  const shown = await setField(api, id, q, +size, { what: 'Font size' });
  if ((await ctl(api, id, q))?.expanded === 'true') await api.keys(id, 'Escape');
  return `size ${shown}`;
}

async function setBold(api, id, on) {
  const q = { name: 'Bold', roles: ['button'] };
  const b = await waitCtl(api, id, q);
  if (!b) throw new Error('No Bold button (select a text box first).');
  if (b.pressed !== !!on) await clickAt(api, id, b);
  if (!(await until(api, id, pageControl, (v) => v?.pressed === !!on, 1000, [q]))) throw new Error(`Bold did not turn ${on ? 'on' : 'off'}.`);
  return on ? 'bold' : 'not bold';
}

// The alignment button cycles left → center → right → justify.
async function setAlign(api, id, align) {
  const want = norm(align) === 'justified' ? 'justify' : norm(align);
  const q = { prefix: 'Toggle text alignment, current alignment: ', roles: ['button'] };
  for (let i = 0; i < 5; i++) {
    const b = await waitCtl(api, id, q);
    if (!b) throw new Error('No text alignment button (select a text box first).');
    const now = norm(b.name.replace(q.prefix, ''));
    if (now === want || (want === 'justify' && now === 'justified')) return `align ${want}`;
    await clickAt(api, id, b);
  }
  throw new Error(`Could not set the alignment to ${align}.`);
}

// Downloads made by canva_download this session, by design id.
const downloaded = new Map();

async function run(name, a, api) {
  let id = await api.resolveTab(a);
  const tab = await chrome.tabs.get(id);
  if (name !== 'canva_create' && !DESIGN_RE.test(tab.url || '')) throw new Error('The current tab is not a Canva design (canva.com/design/…). Open one first, or use canva_create.');
  switch (name) {
    case 'canva_create': {
      const w = Math.round(+a.width), h = Math.round(+a.height);
      if (!(w > 0 && h > 0)) throw new Error('canva_create needs width and height in px.');
      const ready = (v) => v && !v.err;
      await api.exec('navigate', { url: `https://www.canva.com/design?create&width=${w}&height=${h}&units=px`, tab_id: id });
      id = api.agent.tabId;
      let d = await until(api, id, pageDesign, ready, 12000);
      if (!d) {
        // The home page's Custom size form, which opens the design in a new tab.
        await api.exec('navigate', { url: 'https://www.canva.com/', tab_id: id });
        await press(api, id, { prefix: 'Custom size', roles: ['button'] }, 'Custom size on the Canva home page', 6000);
        await setField(api, id, { name: 'Width', roles: ['spinbutton', 'textbox'] }, w, { enter: false });
        await setField(api, id, { name: 'Height', roles: ['spinbutton', 'textbox'] }, h, { enter: false });
        await api.exec('click', { target: 'Create new design', role: 'button', tab_id: id });
        id = api.agent.tabId;
        d = await until(api, id, pageDesign, ready, 20000);
      }
      if (!d) throw new Error('The Canva editor did not open a design page.');
      if (d.w !== w || d.h !== h) throw new Error(`Canva opened a ${d.w}×${d.h} design, not ${w}×${h}.`);
      const t = await chrome.tabs.get(id);
      return { text: `Created a ${w}×${h} px design "${d.title}" — ${t.url} (tab [${id}], now current). Background ${d.background || 'white'}.`, label: `Created ${w}×${h} design` };
    }

    case 'canva_read': {
      let d = await design(api, id);
      let note = '';
      let rows = null;
      try { rows = (await layers(api, id)).rows; } catch (e) { note = `\n(Stacking order from the page, not Position › Layers: ${e.message})`; }
      d = await design(api, id);
      if (rows) attachLayers(d, rows);
      const was = d.selection;
      // Font names live only in the toolbar: select each text box through Layers to read them.
      if (rows && a.fonts !== false) {
        for (const e of d.elements.filter((x) => x.text != null && x.row != null)) {
          try { await selectEl(api, id, e.id); Object.assign(e, Object.fromEntries(Object.entries(await textToolbar(api, id)).filter(([, v]) => v != null))); }
          catch {}
        }
        if (was?.id) await selectEl(api, id, was.id).catch(() => {});
        else if (was?.page) await selectEl(api, id, 'background').catch(() => {});
      }
      const now = await design(api, id);
      const head = `"${d.title}" — ${d.w}×${d.h} px design, background ${d.background || 'none'}`;
      const body = d.elements.length ? d.elements.map((e) => '  ' + fmtEl(e)).join('\n') : '  (no elements)';
      return {
        text: `${head}\nElements, front to back${rows ? ' (Position › Layers order)' : ''}:\n${body}\n${selText(now)}${note}\nSizes and positions are design px read from the page (±1). Font sizes are what Canva's size box shows.`,
        label: `Read “${clip(d.title, 40)}”`,
      };
    }

    case 'canva_select': {
      const { el, d } = await selectEl(api, id, a.id);
      if (el?.text != null) Object.assign(el, await textToolbar(api, id));
      return { text: el ? `Selected: ${fmtEl(el)}` : selText(d), label: `Selected ${el ? el.id : 'background'}` };
    }

    case 'canva_add': {
      const before = new Set((await design(api, id)).elements.map((e) => e.id));
      const kind = norm(a.kind);
      if (kind === 'text') {
        await press(api, id, { name: 'Text', roles: ['tab'] }, 'The Text tab in the side panel');
        await press(api, id, { name: 'Add a text box', roles: ['button'] }, '"Add a text box" in the Text panel');
      } else if (kind === 'shape:rect' || kind === 'shape:circle') {
        const word = kind === 'shape:rect' ? 'Square' : 'Circle';
        await press(api, id, { name: 'Elements', roles: ['tab'] }, 'The Elements tab in the side panel');
        await setField(api, id, { name: 'Search elements', roles: ['textbox', 'searchbox', 'combobox'] }, word.toLowerCase(), { what: 'Search elements' });
        await press(api, id, { name: `Add ${word} graphic to the canvas`, roles: ['button'] }, `"Add ${word} graphic to the canvas" in the Elements results`, 5000);
      } else throw new Error('kind: text, shape:rect or shape:circle');
      let d = await until(api, id, pageDesign, (v) => v?.elements?.some((e) => !before.has(e.id)), 5000);
      if (!d) throw new Error('Nothing new appeared on the page.');
      const newId = d.elements.find((e) => !before.has(e.id)).id;
      if (a.text != null && kind === 'text') {
        await api.exec('type', { target: 'Text editor in Text', role: 'textbox', text: String(a.text), tab_id: id });
        await api.keys(id, 'Escape');
        d = await until(api, id, pageDesign, (v) => v?.elements?.find((e) => e.id === newId)?.text === String(a.text).trim(), 1500) || await design(api, id);
      }
      const el = d.elements.find((e) => e.id === newId);
      if (a.text != null && kind === 'text' && el?.text !== String(a.text).trim()) throw new Error(`Added text box ${newId}, but it reads "${clip(el?.text || '', 80)}".`);
      if (el?.text != null) Object.assign(el, await textToolbar(api, id));
      return { text: `Added ${el ? fmtEl(el) : newId}. It is selected; use its id with canva_set.`, label: `Added ${kind}` };
    }

    case 'canva_set': {
      const target = a.id ?? a.target;
      if (target == null) throw new Error('canva_set needs id (from canva_read), a layer name, or "background".');
      const { el } = await selectEl(api, id, target);
      const isText = el?.text != null;
      if (!el && ['w', 'h', 'x', 'y', 'opacity', 'font', 'size', 'bold', 'color', 'align'].some((k) => a[k] != null)) throw new Error('The page background only takes fill.');
      if (!isText && ['font', 'size', 'bold', 'color', 'align'].some((k) => a[k] != null)) throw new Error(`${el.id} is not a text box: font, size, bold, color and align are for text.`);
      const done = [];
      const step = async (f) => {
        try { done.push(await f()); }
        catch (e) { throw new Error(`${e.message}${done.length ? ` Already done: ${done.join(', ')}.` : ''}`); }
      };
      if (['w', 'h', 'x', 'y'].some((k) => a[k] != null)) await step(() => setGeometry(api, id, a));
      if (a.fill) await step(() => setColor(api, id, 'fill', a.fill));
      if (a.opacity != null) await step(() => setOpacity(api, id, a.opacity));
      if (a.font) await step(() => setFont(api, id, String(a.font)));
      if (a.size != null) await step(() => setSize(api, id, a.size));
      if (a.bold != null) await step(() => setBold(api, id, a.bold));
      if (a.color) await step(() => setColor(api, id, 'text', a.color));
      if (a.align) await step(() => setAlign(api, id, a.align));
      // Check the page itself, not only the controls.
      const d = await design(api, id);
      if (!el) {
        if (a.fill && d.background !== toHex(a.fill)) throw new Error(`The background reads ${d.background}, not ${toHex(a.fill)}. Already done: ${done.join(', ')}.`);
        return { text: `Done: ${done.join(', ')}. Background is ${d.background}.`, label: 'Set background' };
      }
      const now = d.elements.find((e) => e.id === el.id);
      if (!now) return { text: `Done: ${done.join(', ')}. (${el.id} was re-rendered; canva_read for its new id.)`, label: `Set ${el.id}` };
      now.layer = el.layer;
      if (isText) Object.assign(now, await textToolbar(api, id));
      const off = [];
      if (a.fill && now.fill && !now.fill.startsWith(toHex(a.fill))) off.push(`fill reads ${now.fill}`);
      if (a.color && now.color && now.color !== toHex(a.color)) off.push(`text color reads ${now.color}`);
      if (off.length) throw new Error(`After ${done.join(', ')}: ${off.join(', ')}.`);
      return { text: `Done: ${done.join(', ')}.\nNow: ${fmtEl(now)}`, label: `Set ${el.id}` };
    }

    case 'canva_arrange': {
      const where = norm(a.where);
      const label = { front: 'To front', back: 'To back', forward: 'Forward', backward: 'Backward' }[where];
      if (!label) throw new Error('where: front, back, forward or backward');
      const { el } = await selectEl(api, id, a.id);
      if (!el) throw new Error('The background is always at the back.');
      await openTab(api, id, 'Arrange');
      const b = await waitCtl(api, id, { name: label, roles: ['button'] });
      if (!b) throw new Error(`No "${label}" button in Position › Arrange.`);
      const moved = !b.disabled;
      if (moved) await clickAt(api, id, b);
      const rows = (await layers(api, id)).rows;
      const d = attachLayers(await design(api, id), rows);
      const pos = d.elements.findIndex((e) => e.id === el.id);
      const order = d.elements.map((e) => `${e.id} ${e.layer || e.kind}`).join(' › ');
      return { text: `${moved ? `Moved ${el.id} ${label.toLowerCase()}` : `${el.id} was already ${where === 'front' || where === 'forward' ? 'at the front' : 'at the back'}`}: now ${pos + 1} of ${d.elements.length} (1 = front). Layers front to back: ${order} › Background.`, label: `${label}: ${el.id}` };
    }

    case 'canva_rename': {
      const title = String(a.title || '').trim();
      if (!title) throw new Error('canva_rename needs title.');
      await press(api, id, { name: 'File', roles: ['menuitem', 'button'] }, 'The File menu');
      const shown = await setField(api, id, { name: 'Design title', roles: ['textbox'] }, title, { what: 'Design title' });
      if (await ctl(api, id, { name: 'Design title', roles: ['textbox'] })) await api.keys(id, 'Escape');
      const ok = await until(api, id, pageDesign, (v) => v?.title === title, 2000);
      if (!ok) throw new Error(`The title box shows "${shown}", but the page title is "${(await design(api, id)).title}".`);
      return { text: `Renamed the design to “${title}” (checked).`, label: `Renamed to “${clip(title, 30)}”` };
    }

    case 'canva_download': {
      const fmt = String(a.format || 'png').toLowerCase();
      const key = (tab.url.match(DESIGN_RE) || [])[1];
      if (downloaded.has(key) && !a.again) {
        throw new Error(`This design was already downloaded in this session: ${downloaded.get(key)}. Downloading again would make a second file; pass again: true only if the user asked for another.`);
      }
      await press(api, id, { name: 'File', roles: ['menuitem', 'button'] }, 'The File menu');
      await press(api, id, { name: 'Download', roles: ['menuitem'] }, 'Download in the File menu');
      const typeQ = { name: 'File type', roles: ['combobox', 'button'] };
      const type = await waitCtl(api, id, typeQ, 4000);
      if (!type) throw new Error('The download panel did not open (no File type box).');
      if (!new RegExp(`^${fmt}\\b`, 'i').test(type.value || '')) {
        await clickAt(api, id, type);
        const opt = await waitCtl(api, id, { prefix: fmt.toUpperCase(), roles: ['option'] }, 2000);
        if (!opt) { await api.keys(id, 'Escape'); throw new Error(`No ${fmt.toUpperCase()} option under File type.`); }
        await clickAt(api, id, opt);
      }
      // The type list must be shut, or the Download click lands on it.
      if ((await ctl(api, id, typeQ))?.expanded === 'true') { await api.keys(id, 'Escape'); await sleep(150); }
      const now = await ctl(api, id, typeQ);
      if (now && !new RegExp(`^${fmt}\\b`, 'i').test(now.value || '')) throw new Error(`File type shows "${now.value}", not ${fmt.toUpperCase()}.`);
      const btn = await waitCtl(api, id, { name: 'Download', roles: ['button'] }, 2000);
      if (!btn || btn.disabled) throw new Error('The Download button is not available.');
      if (btn.covered) throw new Error(`The Download button is covered by "${btn.cover}".`);
      const t0 = Date.now() - 1000;
      await clickAt(api, id, btn);
      let list = [];
      for (let i = 0; i < 180; i++) {
        await sleep(500);
        list = await api.downloadsSince(t0);
        if (list.some((d) => d.state !== 'in_progress')) break;
      }
      const d = list.find((x) => x.state === 'complete') || list[0];
      if (!d) throw new Error('Clicked Download, but Chrome started no download within 90s. Canva may still be processing: check downloads before trying again, so the file isn\'t saved twice.');
      if (d.state === 'interrupted') throw new Error(`The download failed: ${api.fmtDownload(d)}`);
      downloaded.set(key, api.fmtDownload(d));
      return { text: `Downloaded once${list.length > 1 ? ` (warning: ${list.length} downloads started)` : ''}: ${api.fmtDownload(d)}`, label: `Downloaded ${fmt.toUpperCase()}` };
    }
  }
  throw new Error(`Unknown tool ${name}`);
}

const where = { type: 'string', description: 'Element: id from canva_read (c3), its layer name or text, or "background"' };

export default {
  id: 'canva',
  title: 'Canva',
  match: (url) => SITE_RE.test(url),
  prompt: `Canva tools (canva_*) are on. Canva draws the design as scaled HTML; these tools read and change it in design pixels and check their own work.
- Read with canva_read: every element with its id, kind, text, size and position, fill, opacity, font, size, weight, color, stacking order, plus the title and background. Never measure with run_js or screenshots.
- Pick elements with canva_select (id, layer name or text): it goes through Position › Layers. Don't click shapes on the canvas: a click there often selects the page background or starts editing text.
- Size and place with canva_set w/h/x/y (Position › Arrange number fields). Never drag handles or tap arrow keys to move or size anything.
- canva_set also sets fill and opacity, and for text: font, size, bold, color and align, each read back. Put independent canva_set calls in ONE response.
- The Layers list runs front to back. When the task says what must be on top or behind, set it with canva_arrange; don't infer it.
- Colors go in as hex through Canva's color search. Never click "Change all" (it recolors every element of that color on the page).
- Canva keeps a hidden copy of every text for screen readers. TuffAgent's tools skip it; ignore duplicate text if you meet it elsewhere.
- Typical task: canva_create(width, height) → canva_set id "background" fill → canva_add each element (text with its text, shape:rect, shape:circle) → canva_set each → canva_arrange → canva_rename → canva_download once (then downloads confirms it) → canva_read once to check everything.`,
  finalCheck: 'canva_read',
  icon(name, a) {
    switch (name) {
      case 'canva_create': return 'file-plus';
      case 'canva_read': return 'layer-group';
      case 'canva_select': return 'vector-square';
      case 'canva_add': return { text: 'text', 'shape:rect': 'square', 'shape:circle': 'circle' }[a.kind] || 'shapes';
      case 'canva_set':
        if (a.fill || a.color) return 'fill-drip';
        if (a.opacity != null) return 'droplet-percent';
        if (a.font || a.size || a.bold != null) return 'font';
        if (a.align) return `align-${a.align}`;
        if (a.w != null || a.h != null) return 'expand';
        if (a.x != null || a.y != null) return 'up-down-left-right';
        return 'sliders';
      case 'canva_arrange': return { front: 'bring-front', back: 'send-back', forward: 'bring-forward', backward: 'send-backward' }[a.where] || 'layer-group';
      case 'canva_rename': return 'tag';
      case 'canva_download': return { pdf: 'file-pdf', mp4: 'file-video', svg: 'file-code' }[a.format] || 'file-image';
    }
  },
  tools: [
    fn('canva_create', 'Create a new custom-size Canva design (px) in the current tab and open it in the editor.', {
      width: { type: 'number' }, height: { type: 'number' },
    }, ['width', 'height']),
    fn('canva_read', 'The open design: title, size, background, and every element front to back with id, kind, text, size and position in design px, fill, opacity, font, size, weight, color, align, plus what is selected.', {
      fonts: { type: 'boolean', description: 'Read font names from the toolbar by selecting each text box (default true)' },
    }),
    fn('canva_select', 'Select an element through Position › Layers (never by clicking the canvas) and confirm the selection.', { id: where }, ['id']),
    fn('canva_add', 'Add a text box (with its text) or a shape from the Elements panel. Returns the new element\'s id; it stays selected.', {
      kind: { type: 'string', enum: ['text', 'shape:rect', 'shape:circle'] }, text: { type: 'string', description: 'For text: what it says' },
    }, ['kind']),
    fn('canva_set', 'Set an element\'s properties in one call through Canva\'s own fields, each read back: w, h, x, y (design px), fill (hex), opacity (0–1); text: font, size, bold, color (hex), align. id "background" takes fill only.', {
      id: where, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
      fill: { type: 'string' }, opacity: { type: 'number' }, font: { type: 'string' }, size: { type: 'number' }, bold: { type: 'boolean' },
      color: { type: 'string', description: 'Text color, hex' }, align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
    }, ['id']),
    fn('canva_arrange', 'Change stacking order: front, back, forward or backward. Reports the new Layers order.', {
      id: where, where: { type: 'string', enum: ['front', 'back', 'forward', 'backward'] },
    }, ['id', 'where']),
    fn('canva_rename', 'Rename the design (checked against the title).', { title: { type: 'string' } }, ['title']),
    fn('canva_download', 'Download the design once (File › Download) and confirm the file in Chrome\'s downloads. Refuses a second download of the same design unless again is true.', {
      format: { type: 'string', enum: ['png', 'jpg', 'pdf', 'svg', 'mp4', 'gif'] }, again: { type: 'boolean', description: 'Only when the user asked for another download' },
    }),
  ],
  preLabel(name, a = {}) {
    const q = (s) => `“${clip(String(s ?? ''), 36)}”`;
    switch (name) {
      case 'canva_create': return `Creating ${a.width}×${a.height} design`;
      case 'canva_read': return 'Reading design';
      case 'canva_select': return `Selecting ${q(a.id)}`;
      case 'canva_add': return `Adding ${a.kind || 'element'}`;
      case 'canva_set': return `Setting ${q(a.id)}`;
      case 'canva_arrange': return `Moving ${q(a.id)} ${a.where || ''}`;
      case 'canva_rename': return `Renaming to ${q(a.title)}`;
      case 'canva_download': return `Downloading ${String(a.format || 'png').toUpperCase()}`;
    }
    return name;
  },
  // After a click on the canvas: what got selected.
  async selection(api, tabId) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!DESIGN_RE.test(t?.url || '')) return '';
    const d = await api.page(tabId, pageDesign);
    return d && !d.err ? selText(d) : '';
  },
  // Canva ignores most synthetic input, so these tools always use trusted (DevTools) input.
  async exec(name, a, api) {
    const prev = api.agent.trusted;
    api.agent.trusted = true;
    try { return await run(name, a, api); } finally { api.agent.trusted = prev; }
  },
};
