// TuffAgent page runtime. Lives in the extension's isolated world, so refs
// survive between tool calls without touching the page's own JS.
(() => {
  if (window.__tuff) return;

  const HOST_ID = '__tuff_host';
  const refs = new Map();
  const ids = new WeakMap();
  let seq = 0;

  // role + name are kept so a ref whose element was re-rendered can be found again.
  const refOf = (el, role, name) => {
    let r = ids.get(el);
    if (!r) { r = 'e' + (++seq); ids.set(el, r); refs.set(r, { w: new WeakRef(el) }); }
    if (role && name) Object.assign(refs.get(r), { role, name });
    return r;
  };
  const isRef = (s) => /^e\d+$/.test(s);
  const byRef = (r) => {
    const id = String(r).trim().replace(/^\[|\]$/g, '');
    const e = refs.get(id);
    const el = e?.w.deref();
    if (el && el.isConnected) return el;
    return e?.name ? refind(id, e) : null;
  };
  // Frameworks swap nodes on re-render: take the one visible element with the same role and name.
  function refind(id, e) {
    let hit = null;
    for (const el of elements(document.body || document.documentElement)) {
      if ((roleOf(el) || tag(el)) !== e.role || nameOf(el, e.role) !== e.name || !visible(el)) continue;
      if (hit) return null;
      hit = el;
    }
    if (hit) { ids.set(hit, id); e.w = new WeakRef(hit); }
    return hit;
  }

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const tag = (el) => el.tagName.toLowerCase();
  const styleOf = (el) => el.ownerDocument.defaultView.getComputedStyle(el);

  const ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'listbox', 'treeitem', 'file']);
  // Inline elements: their text belongs to the block around them.
  const INLINE = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM', 'FONT', 'I', 'INS', 'KBD',
    'LABEL', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR']);
  const INPUT_ROLE = { checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button',
    reset: 'button', image: 'button', search: 'searchbox', file: 'file', number: 'spinbutton' };
  // Controls whose text is their name: text inside them isn't listed again.
  const CONTROL_SEL = 'a[href],button,select,textarea,[role=button],[role=link],[role=menuitem],[role=option],[role=tab],[role=checkbox],[role=radio],[role=switch]';

  function isEditable(el) {
    const ce = el.getAttribute('contenteditable');
    return ce === '' || ce === 'true' || ce === 'plaintext-only';
  }

  // The checkbox/radio a <label> stands in for, when the input itself is hidden
  // (custom-styled checkboxes): clicking the label is the only way to toggle it.
  function labelControl(el) {
    const c = el.control;
    return c && (c.type === 'checkbox' || c.type === 'radio') && !visible(c) ? c : null;
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    switch (tag(el)) {
      case 'a': return el.hasAttribute('href') ? 'link' : null;
      case 'button': case 'summary': return 'button';
      case 'select': return el.multiple ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'input': {
        const t = (el.type || 'text').toLowerCase();
        return t === 'hidden' ? null : INPUT_ROLE[t] || 'textbox';
      }
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'img': return 'img';
      case 'label': { const c = labelControl(el); return c ? INPUT_ROLE[c.type] : null; }
    }
    if (isEditable(el)) return 'textbox';
    return null;
  }

  // Clickable by styling alone: React/Vue click handlers leave no attribute, but
  // the element gets cursor:pointer. Children inherit the cursor, so only the
  // outermost element with it counts.
  const NO_POINTER = new Set(['HTML', 'BODY', 'IFRAME', 'FRAME', 'CANVAS', 'VIDEO']);
  function pointer(el) {
    if (NO_POINTER.has(el.tagName)) return false;
    if (styleOf(el).cursor !== 'pointer') return false;
    const p = el.parentElement || el.parentNode?.host;
    return !p || styleOf(p).cursor !== 'pointer';
  }

  function isInteractive(el, role) {
    if (role && ROLES.has(role)) return true;
    if (el.hasAttribute('onclick') || (el.tabIndex >= 0 && el.hasAttribute('tabindex') && role !== 'heading')) return true;
    return role !== 'heading' && pointer(el);
  }

  // A field's label when the page didn't link one: the short text right before it.
  function nearLabel(el) {
    for (let n = el, hops = 0; n && hops < 3; n = n.parentElement, hops++) {
      const s = n.previousElementSibling;
      if (s && !s.matches('input,select,textarea,button')) {
        const t = clean(s.innerText);
        if (t) return t.length <= 60 ? t : '';
      }
      const p = n.parentElement;
      if (!p || p.querySelectorAll('input,select,textarea').length > 1) break;
    }
    return '';
  }

  // Icon-only buttons with no label: words from their classes, test ids and icon
  // names ("close", "trash", "chevron right") beat an empty name.
  const HINT_SKIP = /^(icon|icons|ico|svg|btn|button|img|image|css|jsx|styled|material|symbols|outlined|rounded|filled|sharp|fas|far|fab|glyphicon|component|wrapper|container|root|inner|default|small|large|medium|primary|secondary|tertiary|ghost|base|item|wrap|text|label|style|styles|module|active|hover|focus|disabled|true|false|null|undefined)$/;
  function iconHint(el) {
    const words = [];
    const from = [el, el.querySelector?.('svg, i, use, [class*="icon" i], [data-icon]')].filter(Boolean);
    for (const n of from) {
      const cls = typeof n.className === 'string' ? n.className : n.getAttribute('class') || '';
      const raw = [n.getAttribute('data-testid'), n.getAttribute('data-test-id'), n.getAttribute('data-icon'), n.id, cls,
        (n.getAttribute('href') || n.getAttribute('xlink:href') || '').split('#')[1]].filter(Boolean).join(' ');
      for (const w of raw.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z]+/)) {
        const x = w.toLowerCase();
        if (x.length >= 3 && x.length <= 14 && !HINT_SKIP.test(x) && !words.includes(x)) words.push(x);
      }
    }
    return words.length ? `[icon: ${words.slice(0, 3).join(' ')}]` : '';
  }

  function nameOf(el, role) {
    let n = el.getAttribute('aria-label') || '';
    if (!n) {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) n = lb.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent || '').join(' ');
    }
    const field = role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton' || role === 'slider';
    if (!n && el.labels?.length) n = [...el.labels].map((l) => l.textContent).join(' ');
    if (!n) n = el.getAttribute('alt') || '';
    if (!n && !field && tag(el) !== 'select') n = el.innerText || '';
    if (!n && tag(el) === 'input' && /^(submit|button|reset)$/.test(el.type)) n = el.value;
    if (!n) n = el.getAttribute('title') || el.getAttribute('placeholder') || '';
    if (!n && field) n = nearLabel(el);
    if (!n) n = el.getAttribute('name') || '';
    if (!n && !field) {
      const img = el.querySelector?.('img[alt], svg[aria-label], [title], svg title');
      if (img) n = img.getAttribute('alt') || img.getAttribute('aria-label') || img.getAttribute('title') || img.textContent || '';
    }
    if (!clean(n) && !field && el.tagName !== 'IMG') n = iconHint(el);
    return clip(clean(n), 80);
  }

  function visible(el) {
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  // Rect in top-level viewport coordinates (adds same-origin iframe offsets).
  function rectOf(el) {
    const r = el.getBoundingClientRect();
    let x = r.left, y = r.top;
    let win = el.ownerDocument.defaultView;
    while (win && win !== window && win.frameElement) {
      const fr = win.frameElement.getBoundingClientRect();
      x += fr.left + win.frameElement.clientLeft; y += fr.top + win.frameElement.clientTop;
      win = win.parent;
    }
    return { x, y, w: r.width, h: r.height, cx: x + r.width / 2, cy: y + r.height / 2, ox: x - r.left, oy: y - r.top };
  }

  // Part of the element inside the viewport (top-level coords), or null.
  function viewRect(el) {
    const r = rectOf(el);
    const x1 = Math.max(0, r.x), y1 = Math.max(0, r.y), x2 = Math.min(innerWidth, r.x + r.w), y2 = Math.min(innerHeight, r.y + r.h);
    if (x2 - x1 < 1 || y2 - y1 < 1) return null;
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, ox: r.ox, oy: r.oy, full: r };
  }

  const frameDoc = (f) => { try { return f.contentDocument; } catch { return null; } };
  const within = (anc, n) => { while (n) { if (n === anc) return true; n = n.parentNode || n.host; } return false; };

  // Topmost element at a viewport point, descending into shadow roots and same-origin frames.
  function hitDeep(x, y) {
    let doc = document, lx = x, ly = y, el = doc.elementFromPoint(lx, ly);
    for (;;) {
      while (el?.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(lx, ly); if (!inner || inner === el) break; el = inner; }
      if (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) {
        const d = frameDoc(el);
        if (!d) break;
        const fr = el.getBoundingClientRect();
        lx -= fr.left + el.clientLeft; ly -= fr.top + el.clientTop;
        doc = d; el = d.elementFromPoint(lx, ly);
        continue;
      }
      break;
    }
    return { el, lx, ly };
  }

  // Not hidden behind a dialog, sticky header, etc.
  function onTop(el, r) {
    const hit = el.ownerDocument.elementFromPoint(r.cx - r.ox, r.cy - r.oy);
    return !hit || within(el, hit) || within(hit, el);
  }

  // The element that really has keyboard focus (through shadow roots and frames).
  function deepActive() {
    let a = document.activeElement;
    for (;;) {
      if (a?.shadowRoot?.activeElement) { a = a.shadowRoot.activeElement; continue; }
      if (a && (a.tagName === 'IFRAME' || a.tagName === 'FRAME')) {
        const d = frameDoc(a);
        if (d?.activeElement) { a = d.activeElement; continue; }
      }
      return a;
    }
  }
  const isField = (el) => !!el && (tag(el) === 'input' || tag(el) === 'textarea' || tag(el) === 'select' || el.isContentEditable);

  function* elements(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    if (node.nodeType !== 1) node = walker.nextNode();
    while (node) {
      if (node.id === HOST_ID) { node = nextSkipping(walker, node); continue; }
      const t = node.tagName;
      if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT' || t === 'TEMPLATE' || t === 'SVG' || t === 'svg' || t === 'HEAD') {
        node = nextSkipping(walker, node); continue;
      }
      yield node;
      if (node.shadowRoot) yield* elements(node.shadowRoot);
      if (t === 'IFRAME' || t === 'FRAME') {
        const d = frameDoc(node);
        if (d?.body) yield* elements(d.body);
      }
      node = walker.nextNode();
    }
  }
  function nextSkipping(walker, node) {
    let n = node;
    while (n) {
      walker.currentNode = n;
      const sib = walker.nextSibling();
      if (sib) return sib;
      walker.currentNode = n;
      n = walker.parentNode();
    }
    return null;
  }

  function describe(el) {
    const role = roleOf(el) || tag(el);
    const name = nameOf(el, role);
    return `[${refOf(el, role, name)}] ${role}${name ? ` "${name}"` : ''}`;
  }

  function line(el, role, name) {
    let s = `[${refOf(el, role, name)}] ${role}`;
    if (name) s += ` "${name}"`;
    const t = tag(el);
    if (t === 'input' || t === 'textarea') {
      if (el.type === 'checkbox' || el.type === 'radio') s += el.checked ? ' checked' : '';
      else if (el.type === 'password') s += el.value ? ' value=•••' : '';
      else {
        if (el.value) s += ` value="${clip(clean(el.value), 60)}"`;
        else if (el.placeholder && el.placeholder !== name) s += ` placeholder="${clip(el.placeholder, 40)}"`;
        if (el.type && el.type !== 'text' && el.type !== 'textarea' && (role === 'textbox' || role === 'slider')) s += ` type=${el.type}`;
        if (el.type === 'range') s += ` min=${el.min || 0} max=${el.max || 100}`;
      }
      if (el.required) s += ' required';
    } else if (t === 'select') {
      const opts = [...el.options].slice(0, 12).map((o) => clip(clean(o.text), 30));
      s += ` value="${clip(clean(el.selectedOptions[0]?.text || ''), 40)}" options=[${opts.join(' | ')}${el.options.length > 12 ? ` …+${el.options.length - 12}` : ''}]`;
    } else if (t === 'label') {
      if (el.control?.checked) s += ' checked';
    } else if (role === 'link') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:') && href !== '#') {
        let h = href;
        try { const u = new URL(href, location.href); h = u.origin === location.origin ? u.pathname + u.search : u.href; } catch {}
        s += ` → ${clip(h, 70)}`;
      }
      if (el.target === '_blank') s += ' (new tab)';
    } else if (isEditable(el)) {
      const v = clean(el.innerText);
      if (v) s += ` value="${clip(v, 60)}"`;
    }
    const aria = (a) => el.getAttribute(a);
    if (aria('aria-checked') === 'true') s += ' checked';
    else if (aria('aria-checked') === 'mixed') s += ' mixed';
    if (aria('aria-selected') === 'true') s += ' selected';
    if (aria('aria-current') && aria('aria-current') !== 'false') s += ' current';
    if (aria('aria-expanded')) s += ` expanded=${aria('aria-expanded')}`;
    if (aria('aria-pressed') === 'true') s += ' pressed';
    if (aria('aria-invalid') === 'true') s += ' invalid';
    if (el.disabled || aria('aria-disabled') === 'true') s += ' disabled';
    if (role === 'slider' && t !== 'input' && aria('aria-valuenow') != null) s += ` value=${aria('aria-valuetext') || aria('aria-valuenow')}`;
    if (role === 'heading') s = s.replace('heading', 'h' + (t.match(/h(\d)/)?.[1] || aria('aria-level') || ''));
    return s;
  }

  // ── Reading text the way a person sees it ──

  // Hidden elements (display:none, visibility, sr-only clips) don't count.
  const shown = (el) => !el.checkVisibility || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });

  // A block's own words: its text and inline children's, but not nested blocks
  // (listed on their own) or controls (listed with refs).
  // With links (an array), links inside the text are written inline as
  // [text](ref) and collected, so prose reads as prose in snapshots.
  function ownText(el, links) {
    let s = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) s += n.data;
      else if (n.nodeType === 1) {
        if (n.tagName === 'BR') s += ' ';
        else if (!INLINE.has(n.tagName) || !shown(n)) continue;
        else if (links && n.tagName === 'A' && n.hasAttribute('href')) {
          const name = nameOf(n, 'link');
          // Footnote markers ("[12]") stay plain text.
          if (!name || /^\[[^\]]{1,4}\]$/.test(name)) { s += name; (links.notes ||= []).push(n); continue; }
          s += `[${name}](${refOf(n, 'link', name)})`;
          links.push(n);
        } else if (!n.matches(CONTROL_SEL) && !isInteractive(n, roleOf(n))) s += ownText(n, links);
      }
    }
    return s;
  }

  // Visible text under root, minus what sits inside controls.
  function plainText(root, max = 600) {
    const w = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const skip = new Map();
    const blocked = (p) => {
      if (!p || p === root) return false;
      if (skip.has(p)) return skip.get(p);
      const v = /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName) || !shown(p) || isInteractive(p, roleOf(p)) || blocked(p.parentElement);
      skip.set(p, v);
      return v;
    };
    let s = '';
    for (let n = w.nextNode(), i = 0; n && s.length < max && i < 3000; n = w.nextNode(), i++) {
      if (!n.data.trim() || blocked(n.parentElement)) continue;
      s += ' ' + n.data;
    }
    return clip(clean(s), max);
  }

  const ROW_ROLES = new Set(['row']);
  // A table row on one line: "| cell | cell |".
  function rowText(tr) {
    // A row holding whole tables is page layout (old-school sites): its inner rows speak for it.
    if (tr.querySelector('table, [role=grid], [role=table]')) return '';
    const cells = [...tr.children].filter((c) => /^(TD|TH)$/.test(c.tagName) || /^(cell|gridcell|columnheader|rowheader)$/.test(c.getAttribute('role')));
    if (!cells.length) return '';
    const parts = cells.map((c) => clip(clean(c.innerText), 80));
    return parts.some(Boolean) ? clip(`| ${parts.join(' | ')} |`, 400) : '';
  }

  // The open modal, if any: everything else is behind it.
  function openModal() {
    for (const d of document.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]')) {
      if (!visible(d)) continue;
      if (d.matches('dialog') ? d.matches(':modal') : d.getAttribute('aria-modal') === 'true' || d.getAttribute('role') === 'alertdialog') return d;
    }
    return null;
  }

  // Wait for the page to have something to show: DOM ready, quiet, and past the
  // near-empty shell that client-rendered apps paint first.
  async function ready(cap = 2500) {
    if (document.readyState === 'loading') {
      await new Promise((r) => { document.addEventListener('DOMContentLoaded', r, { once: true }); setTimeout(r, cap); });
    }
    await settle(120, 1000);
    const sparse = () => (document.body?.innerText || '').trim().length < 150 || !!document.querySelector('body > [aria-busy=true], main[aria-busy=true]');
    const t0 = performance.now();
    while (sparse() && performance.now() - t0 < cap) await settle(150, 500);
  }

  // The page in reading order: text blocks, headings, table rows and controls
  // with refs. When it doesn't fit, what's on screen (and an open dialog) wins,
  // then whatever is nearest to the viewport.
  async function snapshot({ mode = 'all', maxChars = 24000, viewportOnly = false, wait = false } = {}) {
    if (wait) await ready();
    const all = mode !== 'interactive';
    const items = [];
    let above = 0, below = 0, capped = false;
    const vh = innerHeight, vw = innerWidth;
    const modal = openModal();
    const doneText = new WeakSet();
    const listed = new WeakMap();
    // Links already written inside a text line.
    const inlined = new WeakSet();
    for (const el of elements(document.body || document.documentElement)) {
      if (items.length > 5000) { capped = true; break; }
      const t = el.tagName;
      const role = roleOf(el);
      const interactive = isInteractive(el, role);
      let s = null;
      if (!interactive) {
        if ((t === 'IFRAME' || t === 'FRAME') && !frameDoc(el) && visible(el)) {
          const r = el.getBoundingClientRect();
          if (r.width > 40 && r.height > 20) {
            let host = '';
            try { host = new URL(el.src, location.href).host; } catch {}
            s = `[${refOf(el)}] frame (cross-origin${host ? ' ' + host : ''}: contents hidden; run_js frame:"${host}" or screenshot)`;
          }
        } else if (role === 'heading') {
          if (visible(el)) s = line(el, role, nameOf(el, role));
          if (s) doneText.add(el);
        } else if (all) {
          if (t === 'TR' || ROW_ROLES.has(el.getAttribute('role'))) {
            if (visible(el)) { s = rowText(el); if (s) doneText.add(el); }
          } else if (role === 'img') {
            const alt = clean(el.getAttribute('alt'));
            if (alt.length > 2 && !el.closest(CONTROL_SEL) && visible(el)) s = `img "${clip(alt, 80)}"`;
          } else if (!INLINE.has(t)) {
            let p = el.parentElement, dup = false;
            for (let k = 0; p && k < 40; p = p.parentElement, k++) if (doneText.has(p) && (p.tagName === 'TR' || p.matches('[role=row]'))) { dup = true; break; }
            if (!dup && !el.closest(CONTROL_SEL)) {
              const links = [];
              const txt = clean(ownText(el, links));
              // A lone link is a control, not prose: it keeps its own line (with its URL).
              const lone = links.length === 1 && txt === `[${nameOf(links[0], 'link')}](${refOf(links[0])})`;
              if (txt.length > 1 && !lone && visible(el)) {
                s = (t === 'LI' ? '- ' : '') + clip(txt, 700);
                // Links cut off by the clip keep their own lines.
                for (const a of links) if (s.includes(`(${refOf(a)})`)) inlined.add(a);
                for (const a of links.notes || []) inlined.add(a);
              }
            }
          }
        }
      } else if (!inlined.has(el) && visible(el)) {
        const name = nameOf(el, role);
        // Skip a control that just repeats the control around it (div[tabindex] > button).
        let p = el.parentElement, dup = false;
        for (let k = 0; p && k < 3; p = p.parentElement, k++) if (listed.get(p) === name && name) { dup = true; break; }
        if (!dup) { s = line(el, role || tag(el), name); listed.set(el, name); }
      }
      if (!s) continue;
      const r = rectOf(el);
      const off = r.y + r.h < 0 ? 'above' : r.y > vh ? 'below' : (r.x + r.w < 0 || r.x > vw) ? 'side' : '';
      if (off === 'above') above++;
      if (off === 'below') below++;
      if (viewportOnly && off) continue;
      const dist = modal && within(modal, el) ? -1 : off === 'above' ? -(r.y + r.h) : off === 'below' ? r.y - vh : off ? vw : 0;
      items.push({ s: off ? s + ' ·off' : s, dist });
    }

    // Fit the budget: keep the lines nearest the viewport, print them in page order.
    let size = items.reduce((n, it) => n + it.s.length + 1, 0);
    let keep = null;
    if (size > maxChars) {
      keep = new Uint8Array(items.length);
      const order = items.map((_, i) => i).sort((a, b) => items[a].dist - items[b].dist || a - b);
      size = 0;
      for (const i of order) {
        const l = items[i].s.length + 1;
        if (size + l > maxChars) break;
        keep[i] = 1; size += l;
      }
    }
    const out = [];
    let gap = 0;
    items.forEach((it, i) => {
      if (keep && !keep[i]) { gap++; return; }
      if (gap) { out.push(`… ${gap} line${gap === 1 ? '' : 's'} not shown (scroll there, or find / get_text query)`); gap = 0; }
      out.push(it.s);
    });
    if (gap) out.push(`… ${gap} line${gap === 1 ? '' : 's'} not shown (scroll there, or find / get_text query)`);
    if (capped) out.push('… page too large; stopped listing. Use find, get_text with query, or scroll + viewport_only.');
    if (!out.length) out.push('(nothing found — page may still be loading, or content is in a canvas/cross-origin frame: try screenshot)');

    const se = document.scrollingElement || document.documentElement;
    const focus = deepActive();
    const head = [
      `${document.title || '(untitled)'} — ${location.href}`,
      `viewport ${vw}×${vh}, scroll ${Math.round(se.scrollTop)}/${Math.max(0, se.scrollHeight - vh)}` +
        (above || below ? `, ${above} lines above / ${below} below viewport (·off)` : ''),
    ];
    if (focus && focus !== document.body && focus !== document.documentElement && isField(focus)) head.push(`focused: ${line(focus, roleOf(focus) || tag(focus), nameOf(focus, roleOf(focus)))}`);
    if (modal) head.push(`A dialog is open: ${describe(modal)} — its contents are listed first; the page behind it is blocked.`);
    return head.concat('', out).join('\n');
  }

  // ── Finding elements by what they say ──

  // Submenu arrows ("Roboto ►") and quotes don't count toward a label.
  const norm = (s) => clean(s).toLowerCase().replace(/[‘’'"“”…►▸▶]|\.\.\.$/g, '').replace(/\s+/g, ' ').trim();

  // Words in a descriptive query ("Roboto option in the font list") that say
  // what kind of thing to look for, not what its label says.
  const FILLER = new Set(['the', 'a', 'an', 'in', 'on', 'of', 'to', 'for', 'with', 'and', 'or', 'not', 'at', 'from', 'that', 'this', 'its',
    'exact', 'exactly', 'named', 'labeled', 'labelled', 'called', 'item', 'items', 'element', 'entry', 'list', 'menu', 'dialog', 'panel',
    'toolbar', 'dropdown', 'field', 'box', 'icon', 'control', 'section', 'area', 'popup', 'window', 'page', 'visible', 'only', 'one']);
  const ROLE_WORDS = new Set([...ROLES, 'heading', 'img', 'image', 'menuitem', 'input']);

  // Label text of an element, for matching: a control's name (plus placeholder
  // and value for fields), or a text block's own words.
  function labelOf(el, role, interactive) {
    if (interactive) {
      const extra = isField(el) ? ' ' + (el.getAttribute('placeholder') || '') : '';
      return nameOf(el, role) + extra;
    }
    if (role === 'heading') return nameOf(el, role);
    return clean(ownText(el)).slice(0, 300);
  }

  function find({ query, limit = 25 }) {
    const q = clean(query).toLowerCase();
    if (!q) throw new Error('Empty query');
    const words = q.split(' ');
    // Quoted phrases are the label; otherwise drop filler and (asides).
    const quoted = [...q.matchAll(/["'“‘]([^"'”’]{2,})["'”’]/g)].map((m) => m[1].trim());
    const loose = (quoted.length ? quoted.join(' ') : q.replace(/\([^)]*\)/g, ' '))
      .split(/[^\p{L}\p{N}#@.+$-]+/u).filter((w) => w && !FILLER.has(w));
    const roleWant = q.split(/[^a-z]+/).filter((w) => ROLE_WORDS.has(w)).map((w) => (w === 'image' ? 'img' : w === 'input' ? 'textbox' : w));
    const label = loose.filter((w) => !ROLE_WORDS.has(w));
    const phrase = (quoted[0] || label.join(' ')).trim();
    const hits = [], near = [];
    for (const el of elements(document.body)) {
      const role = roleOf(el);
      const interactive = isInteractive(el, role);
      if (!interactive && role !== 'heading' && (INLINE.has(el.tagName) || el.closest(CONTROL_SEL))) continue;
      const name = labelOf(el, role, interactive);
      if (!name) continue;
      const hay = (name + ' ' + (el.id || '')).toLowerCase();
      const exact = words.every((w) => hay.includes(w));
      const got = exact ? 0 : label.filter((w) => hay.includes(w)).length;
      if (!exact && (!label.length || got < Math.max(1, Math.ceil(label.length * 0.5)))) continue;
      if (!visible(el)) continue;
      const nm = name.toLowerCase().replace(/[►▸▶]/g, '').trim();
      const off = viewRect(el) ? '' : ' ·off';
      const s = (interactive ? line(el, role || tag(el), nameOf(el, role)) : `[${refOf(el)}] ${role === 'heading' ? line(el, role, name).split('] ')[1] : `text "${clip(name, 120)}"`}`) + off;
      if (exact) hits.push({ score: (interactive ? 2 : 0) + (nm === q ? 3 : 0) + (hay.startsWith(q) ? 1 : 0) + (off ? 0 : 0.5), s });
      else near.push({ score: got / label.length * 4 + (nm === phrase ? 6 : nm.startsWith(phrase) ? 2 : label.includes(nm) ? 3 : 0) + (roleWant.includes(role) ? 2 : 0) + (interactive ? 1 : 0), s });
    }
    const top = (list) => list.sort((a, b) => b.score - a.score).slice(0, limit).map((h) => h.s).join('\n');
    if (hits.length) return top(hits);
    if (near.length) return `No exact match for "${query}"; closest by label words:\n${top(near)}`;
    return `No matches for "${query}". find matches visible label text — query with the words on the element, e.g. "Playfair Display".`;
  }

  // Rows, list items and cards: the unit "near" means "in the same one as".
  const GROUP_SEL = 'tr, [role=row], li, [role=listitem], article, [role=article], fieldset, form, section';

  // The element a label names, so the model can say target:"Add to cart",
  // near:"Blue T-shirt" instead of reading refs or guessing coordinates.
  // Exact name beats starts-with beats contains; controls beat text; near picks
  // the match closest to an anchor text (same row, list item or card first);
  // nth picks among equally good matches in page order.
  function byLabel({ target, role, near, nth }) {
    const want = norm(target);
    if (!want) throw new Error('Empty target');
    const words = want.split(' ');
    const roleWant = role ? String(role).toLowerCase() : null;
    const cands = [];
    for (const el of elements(document.body || document.documentElement)) {
      const r = roleOf(el);
      const interactive = isInteractive(el, r);
      if (!interactive && r !== 'heading' && ((INLINE.has(el.tagName) && el.tagName !== 'LABEL') || el.closest(CONTROL_SEL))) continue;
      if (roleWant && r !== roleWant && tag(el) !== roleWant && !(roleWant === 'textbox' && isField(el))) continue;
      const name = norm(labelOf(el, r, interactive));
      if (!name) continue;
      let s = name === want ? 100 : name.startsWith(want) ? 60 : new RegExp(`\\b${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(name) ? 45
        : name.includes(want) ? 30 : words.length > 1 && words.every((w) => name.includes(w)) ? 15 : 0;
      if (!s || !visible(el)) continue;
      if (interactive) s += 20;
      if (viewRect(el)) s += 3;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') s -= 40;
      cands.push({ el, s });
    }
    // A control and the text inside it are one match; so are a container whose
    // words include the label and the element that is the label. Keep the better
    // one (ties: the outer control, or the inner text when the outer isn't one).
    const score = new Map(cands.map((c) => [c.el, c]));
    const up = (el) => el.parentElement || el.parentNode?.host;
    const uniq = cands.filter((c) => {
      for (let p = up(c.el); p; p = up(p)) {
        const o = score.get(p);
        if (o && (o.s > c.s || (o.s === c.s && isInteractive(p, roleOf(p))))) return false;
        if (o) o.beaten = true;
      }
      return true;
    }).filter((c) => !c.beaten);
    if (!uniq.length) {
      const hint = find({ query: target, limit: 6 });
      throw new Error(`Nothing visible is labeled "${target}"${roleWant ? ` (role ${roleWant})` : ''}. ${/^No matches/.test(hint) ? 'Read the page for the exact label.' : `Closest:\n${hint}`}`);
    }
    const best = Math.max(...uniq.map((c) => c.s));
    let tier = uniq.filter((c) => c.s >= best - 5);
    if (near) {
      const anchors = byLabelAnchors(near);
      if (!anchors.length) throw new Error(`near: nothing visible says "${near}"`);
      const d = (el) => Math.min(...anchors.map((a) => {
        const g = a.closest(GROUP_SEL);
        if (g && within(g, el)) return 0;
        const ra = rectOf(a), re = rectOf(el);
        return Math.hypot(ra.cx - re.cx, (ra.cy - re.cy) * 2) + 1;
      }));
      // Near outranks a slightly better label: "Edit" in the right row beats "Edit profile" elsewhere.
      tier = uniq.filter((c) => c.s >= best - 45).map((c) => ({ ...c, d: d(c.el) })).sort((a, b) => a.d - b.d || b.s - a.s);
      return { el: tier[0].el, note: '' };
    }
    if (nth) {
      const c = tier[Math.max(0, Math.min(tier.length, +nth) - 1)];
      return { el: c.el, note: tier.length > 1 ? ` (match ${Math.min(tier.length, +nth)} of ${tier.length})` : '' };
    }
    const pick = tier.find((c) => viewRect(c.el)) || tier[0];
    const others = tier.filter((c) => c !== pick).slice(0, 6).map((c) => refOf(c.el));
    return { el: pick.el, note: others.length ? ` (${tier.length} matches for "${target}"; also ${others.join(', ')} — pass near or nth to choose)` : '' };
  }
  function byLabelAnchors(text) {
    const want = norm(text);
    const out = [];
    for (const el of elements(document.body || document.documentElement)) {
      if (INLINE.has(el.tagName) && !el.matches(CONTROL_SEL)) continue;
      const r = roleOf(el);
      const own = norm(isInteractive(el, r) ? nameOf(el, r) : ownText(el));
      if (own && own.includes(want) && visible(el)) out.push(el);
      if (out.length > 30) break;
    }
    return out;
  }

  // ref, a label (target, or a non-ref string passed as ref), or a CSS selector.
  let lastNote = '';
  function resolve(t = {}) {
    lastNote = '';
    const ref = t.ref != null ? String(t.ref).trim().replace(/^\[|\]$/g, '') : '';
    if (ref && isRef(ref)) {
      const el = byRef(ref);
      if (el) return el;
      if (!t.target) throw new Error(`Ref ${ref} is stale or unknown — the element is gone or was re-rendered. Use target (its label) or read_page again.`);
    }
    const label = t.target || (ref && !isRef(ref) ? ref : '');
    if (label) {
      const { el, note } = byLabel({ target: label, role: t.role, near: t.near, nth: t.nth });
      lastNote = note;
      return el;
    }
    if (t.selector) {
      const el = document.querySelector(t.selector);
      if (!el) throw new Error(`No element matches selector ${t.selector}`);
      return el;
    }
    return null;
  }

  // ── Waiting for the page ──

  // A style/class flip on a caret-sized or hidden node (blinking cursors, spinners).
  function trivial(m) {
    if (m.type !== 'attributes' || (m.attributeName !== 'style' && m.attributeName !== 'class')) return false;
    const r = m.target.getBoundingClientRect?.();
    return !!r && (r.width < 4 || r.height < 4);
  }

  // Wait until the DOM goes quiet (or a cap). Keeps actions fast but stable.
  function settle(quiet = 80, cap = 700) {
    return new Promise((res) => {
      let timer = setTimeout(done, quiet);
      const mo = new MutationObserver((muts) => {
        if (muts.length < 12 && muts.every(trivial)) return;
        clearTimeout(timer); timer = setTimeout(done, quiet);
      });
      const capT = setTimeout(done, cap);
      function done() { mo.disconnect(); clearTimeout(timer); clearTimeout(capT); res(); }
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    });
  }

  // ── What an action changed ──
  // Controls that came on screen or changed state, and text that appeared
  // (errors, toasts, results), so the model can chain menu → submenu → dialog
  // and see what happened without re-reading the page.
  function onScreen(budget = 150) {
    const map = new Map(), t0 = performance.now();
    let n = 0;
    for (const el of elements(document.body || document.documentElement)) {
      if ((++n & 255) === 0 && performance.now() - t0 > budget) return null;
      const role = roleOf(el);
      if (!isInteractive(el, role) || !visible(el) || !viewRect(el)) continue;
      map.set(el, line(el, role || tag(el), nameOf(el, role)));
    }
    return map;
  }
  let watch = null, added = null, mo = null;
  function begin() {
    watch = onScreen();
    added = new Set();
    mo?.disconnect();
    mo = new MutationObserver((ms) => record(ms));
    mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    return true;
  }
  function record(ms) {
    for (const m of ms) {
      if (added.size > 2000) return;
      if (m.type === 'childList') m.addedNodes.forEach((n) => added.add(n));
      else added.add(m.target);
    }
  }
  // Text nodes and inline bits belong to the block around them.
  const blockOf = (n) => {
    let e = n.nodeType === 1 ? n : n.parentElement;
    while (e && INLINE.has(e.tagName) && e.parentElement) e = e.parentElement;
    return e;
  };
  function newText() {
    if (!mo) return '';
    record(mo.takeRecords());
    mo.disconnect(); mo = null;
    const els = new Set();
    for (const n of added) {
      const e = blockOf(n);
      if (e?.isConnected && !within(document.getElementById(HOST_ID), e) && !/^(SCRIPT|STYLE|NOSCRIPT|HEAD|TITLE)$/.test(e.tagName)) els.add(e);
    }
    added = null;
    const top = [...els].filter((e) => { for (let p = e.parentElement; p; p = p.parentElement) if (els.has(p)) return false; return true; });
    const out = [];
    let size = 0;
    for (const e of top) {
      if (out.length >= 12 || size > 1200) break;
      if (!shown(e) || !viewRect(e) && !e.closest('[role=alert],[role=status],[aria-live]')) continue;
      const s = plainText(e, 300);
      if (s.length < 2 || out.includes(s)) continue;
      out.push(s); size += s.length;
    }
    return out.length ? `\n\nNew text:\n${out.map((s) => '· ' + s).join('\n')}` : '';
  }
  function changes() {
    const before = watch;
    watch = null;
    const text = newText();
    if (!before) return text;
    const after = onScreen();
    if (!after) return text;
    const fresh = [], changed = [];
    for (const [el, l] of after) {
      const was = before.get(el);
      if (was == null) fresh.push(l);
      else if (was !== l) changed.push(`${l}  (was: ${was.replace(/^\[e\d+\] /, '')})`);
    }
    let gone = 0;
    for (const el of before.keys()) if (!after.has(el)) gone++;
    const list = (title, ls, max) => {
      if (!ls.length) return '';
      let s = '';
      for (let i = 0; i < ls.length; i++) {
        if (i >= max || s.length + ls[i].length > 3500) { s += `\n… ${ls.length - i} more (read_page for all)`; break; }
        s += '\n' + ls[i];
      }
      return `\n\n${title}:${s}`;
    };
    return list('New on screen', fresh, 50) + list('Changed', changed, 15) + text +
      (gone ? `\n(${gone} element${gone === 1 ? '' : 's'} left the screen)` : '');
  }
  async function finish(quiet, cap) { await settle(quiet, cap); return changes(); }

  // ── Aiming ──

  // Bring an element into view only if it isn't already (scrolling can close
  // menus or drop a selection), and return the visible part's rect.
  function focusTarget(el) {
    let r = viewRect(el);
    const f = r?.full;
    if (!r || (r.w * r.h < 0.5 * f.w * f.h && f.w <= innerWidth && f.h <= innerHeight)) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      r = viewRect(el) || rectOf(el);
    }
    fx.cursor(r.cx, r.cy);
    return r;
  }

  // A point inside the element that the element itself receives: the center,
  // else another spot (a badge, sticky header or cookie banner may cover part of
  // it). covered = what sits on top when every spot is taken.
  const SPOTS = [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7], [0.15, 0.5], [0.85, 0.5], [0.2, 0.2], [0.8, 0.8], [0.8, 0.2], [0.2, 0.8]];
  function clickPoint(el, r) {
    let cover = null;
    for (const [fx_, fy] of SPOTS) {
      const x = r.x + r.w * fx_, y = r.y + r.h * fy;
      const hit = hitDeep(x, y).el;
      if (!hit || hit.id === HOST_ID || within(el, hit) || within(hit, el)) return { x, y };
      cover ||= hit;
    }
    return { x: r.cx, y: r.cy, cover };
  }

  // The control a viewport point means: the interactive element under it, or one
  // within a few pixels when the point lands on padding, a gap or an icon's edge.
  // Text, editors and canvases keep the exact point (caret placement, drawings).
  function snapAt(x, y) {
    const h = hitDeep(x, y);
    if (!h.el) return null;
    for (let e = h.el, k = 0; e && e.nodeType === 1 && k < 8; e = e.parentElement || e.parentNode?.host, k++) {
      if (isInteractive(e, roleOf(e))) return { el: e, x, y, lx: h.lx, ly: h.ly, snapped: 0 };
    }
    if (h.el.tagName === 'CANVAS' || h.el.isContentEditable || clean(ownText(h.el)).length > 1) return null;
    let best = null, bd = 25;
    for (const el of elements(document.body || document.documentElement)) {
      const role = roleOf(el);
      if (!isInteractive(el, role)) continue;
      const r = viewRect(el);
      if (!r) continue;
      const d = Math.hypot(Math.max(r.x - x, 0, x - r.x - r.w), Math.max(r.y - y, 0, y - r.y - r.h));
      if (d < bd && visible(el)) { best = { el, r }; bd = d; }
    }
    if (!best) return null;
    const p = clickPoint(best.el, best.r);
    return { el: best.el, x: p.x, y: p.y, lx: p.x - best.r.ox, ly: p.y - best.r.oy, snapped: Math.round(bd) };
  }

  // Click target + top-level and local (frame) coords for a ref/label/selector or a viewport x/y.
  function aim(t) {
    const el = resolve(t);
    if (el) {
      let r = focusTarget(el);
      let p = clickPoint(el, r);
      if (p.cover) {
        // Under a sticky header, footer or banner: centered, it may be in the clear.
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        r = viewRect(el) || rectOf(el);
        p = clickPoint(el, r);
        fx.cursor(p.x, p.y);
      }
      const cover = p.cover && p.cover.id !== HOST_ID ? ` (warning: covered by ${describe(p.cover)})` : '';
      return { el, x: p.x, y: p.y, lx: p.x - r.ox, ly: p.y - r.oy, covered: !!cover, desc: describe(el) + lastNote + cover };
    }
    if (t.x == null || t.y == null) throw new Error('needs ref, target (visible label), selector, or x/y');
    const x = +t.x, y = +t.y;
    if (!(x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight)) throw new Error(`(${x}, ${y}) is outside the ${innerWidth}×${innerHeight} viewport`);
    const s = snapAt(x, y);
    fx.cursor(s?.x ?? x, s?.y ?? y);
    if (s) return { el: s.el, x: s.x, y: s.y, lx: s.lx, ly: s.ly, desc: s.snapped ? `${describe(s.el)} (snapped ${s.snapped}px from (${x}, ${y}))` : `${describe(s.el)} at (${x}, ${y})` };
    const h = hitDeep(x, y);
    if (!h.el) throw new Error(`Nothing at (${x}, ${y})`);
    return { el: h.el, x, y, lx: h.lx, ly: h.ly, desc: `(${x}, ${y}) on ${describe(h.el)}` };
  }

  const MODS = (s) => {
    const m = String(s || '').toLowerCase();
    return { shiftKey: /shift/.test(m), ctrlKey: /ctrl|control/.test(m), altKey: /alt|option/.test(m), metaKey: /meta|cmd|command/.test(m) };
  };

  function mouse(target, type, x, y, extra = {}) {
    const view = target.ownerDocument.defaultView;
    const init = { bubbles: true, cancelable: true, composed: true, view, clientX: x, clientY: y, button: 0, buttons: type.endsWith('down') ? 1 : 0, ...extra };
    const E = type.startsWith('pointer') ? view.PointerEvent : view.MouseEvent;
    return target.dispatchEvent(new E(type, type.startsWith('pointer') ? { pointerId: 1, pointerType: 'mouse', isPrimary: true, ...init } : init));
  }

  // A native <select> opens a popup that clicks and keys can't reach.
  const selectHint = (el) => (tag(el) === 'select' ? '\nThis is a native <select>: use select_option (or type) with the option text instead of clicking.' : '');

  // Synthetic click: the event sequence a mouse makes, dispatched on the element.
  async function click(t = {}) {
    const a = aim(t);
    begin();
    let { el } = a;
    const doc = el.ownerDocument;
    let target = el;
    const top = doc.elementFromPoint(a.lx, a.ly);
    if (top && top !== el && within(el, top)) target = top;
    fx.ripple(a.x, a.y);
    const n = Math.max(1, Math.min(3, +t.clicks || (t.double ? 2 : 1)));
    const mods = MODS(t.modifiers);
    for (let i = 0; i < n; i++) {
      mouse(target, 'pointerover', a.lx, a.ly, mods); mouse(target, 'mouseover', a.lx, a.ly, mods);
      mouse(target, 'pointerdown', a.lx, a.ly, mods); mouse(target, 'mousedown', a.lx, a.ly, { detail: i + 1, ...mods });
      if (target.focus && doc.activeElement !== target) (target.closest('input,textarea,select,button,a,[tabindex],[contenteditable]') || target).focus({ preventScroll: true });
      mouse(target, 'pointerup', a.lx, a.ly, mods); mouse(target, 'mouseup', a.lx, a.ly, { detail: i + 1, ...mods });
      mouse(target, 'click', a.lx, a.ly, { detail: i + 1, ...mods });
    }
    if (n >= 2) mouse(target, 'dblclick', a.lx, a.ly, { detail: 2, ...mods });
    return `Clicked ${a.desc}${a.covered ? ' — sent the click to the element itself' : ''}${selectHint(el)}` + await finish();
  }

  // Coordinates for trusted (CDP) input; the panel dispatches the real events.
  function point(t = {}) {
    const a = aim(t);
    begin();
    if (!t.hover) fx.ripple(a.x, a.y);
    return { x: a.x, y: a.y, desc: a.desc + selectHint(a.el), covered: a.covered };
  }

  // ── Drag ──
  let dragged = null;
  function dragEnds(t = {}) {
    const from = aim(t);
    let to;
    const toEl = t.to_ref || t.to_target ? resolve({ ref: t.to_ref, target: t.to_target, near: t.to_near }) : null;
    if (toEl) {
      // An edge instead of the center: drops before/after an item in sortable lists.
      const r = viewRect(toEl) || rectOf(toEl);
      const ins = (n) => Math.min(8, n / 4);
      const pos = t.to_position || 'center';
      const x = pos === 'left' ? r.x + ins(r.w) : pos === 'right' ? r.x + r.w - ins(r.w) : r.cx;
      const y = pos === 'top' ? r.y + ins(r.h) : pos === 'bottom' ? r.y + r.h - ins(r.h) : r.cy;
      to = { x, y, desc: describe(toEl) + lastNote + (pos === 'center' ? '' : ` (${pos})`) };
    } else if (t.to_x != null && t.to_y != null) to = { x: +t.to_x, y: +t.to_y, desc: `(${t.to_x}, ${t.to_y})` };
    else if (t.dx != null || t.dy != null) {
      // Relative moves: sliders, resize handles, panning.
      const x = from.x + (+t.dx || 0), y = from.y + (+t.dy || 0);
      to = { x, y, desc: `(${Math.round(x)}, ${Math.round(y)}), ${+t.dx || 0}/${+t.dy || 0}px away` };
    } else throw new Error('drag needs a destination: to_ref, to_target, to_x/to_y, or dx/dy');
    const r = rectOf(from.el);
    dragged = { el: from.el, ref: refOf(from.el), x: r.x, y: r.y, parent: from.el.parentElement, index: [...(from.el.parentElement?.children || [])].indexOf(from.el) };
    begin();
    return { from, to };
  }
  function dragPoints(t) {
    const { from, to } = dragEnds(t);
    return { x1: from.x, y1: from.y, x2: to.x, y2: to.y, desc: `${from.desc} to ${to.desc}` };
  }
  // Did the dragged element move? Sortable lists re-render, so a vanished
  // element is looked up again by its ref.
  function dragCheck() {
    const d = dragged;
    dragged = null;
    if (!d) return '';
    const el = d.el.isConnected ? d.el : byRef(d.ref);
    if (!el) return ' (the dragged element was re-rendered; check the result)';
    const r = rectOf(el);
    const idx = [...(el.parentElement?.children || [])].indexOf(el);
    if (el.parentElement !== d.parent) return ` (moved to a new container: now inside ${describe(el.parentElement)})`;
    if (idx !== d.index) return ` (moved from position ${d.index + 1} to ${idx + 1} in its list)`;
    if (Math.abs(r.x - d.x) > 3 || Math.abs(r.y - d.y) > 3) return ` (moved by ${Math.round(r.x - d.x)}, ${Math.round(r.y - d.y)} px)`;
    return ' (the dragged element did not move — check the result)';
  }
  // Native HTML5 drag source: draggable="true", a link, an image, or selected text.
  function dragSource(el) {
    const d = el.closest?.('[draggable]');
    if (d) return d.draggable ? d : null;
    if (el.closest?.('a[href], img')) return el.closest('a[href], img');
    const sel = el.ownerDocument.getSelection();
    return sel && !sel.isCollapsed && sel.containsNode(el, true) ? el : null;
  }
  async function drag(t) {
    const { from, to } = dragEnds(t);
    const mods = MODS(t.modifiers);
    mouse(from.el, 'pointerdown', from.lx, from.ly, mods); mouse(from.el, 'mousedown', from.lx, from.ly, { detail: 1, ...mods });
    if (+t.hold > 0) await new Promise((r) => setTimeout(r, Math.min(+t.hold, 3000)));
    // HTML5 drag-and-drop runs on drag events, not mouse moves.
    const src = dragSource(from.el);
    let dt = null, over = null, accepted = false, dropped = false;
    const dragEv = (target, type, x, y) => {
      const view = target.ownerDocument.defaultView;
      return target.dispatchEvent(new view.DragEvent(type, { bubbles: true, cancelable: type !== 'dragleave' && type !== 'dragend', composed: true, view, clientX: x, clientY: y, dataTransfer: dt, ...mods }));
    };
    if (src) {
      dt = new DataTransfer();
      if (src.matches('a[href]')) { dt.setData('text/uri-list', src.href); dt.setData('text/plain', src.href); }
      else if (src.matches('img')) dt.setData('text/uri-list', src.currentSrc || src.src);
      else if (!src.draggable) dt.setData('text/plain', String(src.ownerDocument.getSelection()));
      if (!dragEv(src, 'dragstart', from.lx, from.ly)) dt = null;
    }
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const x = from.x + (to.x - from.x) * i / steps, y = from.y + (to.y - from.y) * i / steps;
      const h = hitDeep(x, y);
      fx.cursor(x, y);
      if (!h.el) continue;
      if (dt) {
        if (h.el !== over) {
          if (over) dragEv(over, 'dragleave', h.lx, h.ly);
          dragEv(h.el, 'dragenter', h.lx, h.ly);
          over = h.el;
        }
        accepted = !dragEv(h.el, 'dragover', h.lx, h.ly);
        if (src.draggable) dragEv(src, 'drag', from.lx, from.ly);
      } else {
        mouse(h.el, 'pointermove', h.lx, h.ly, { buttons: 1, ...mods }); mouse(h.el, 'mousemove', h.lx, h.ly, { buttons: 1, ...mods });
      }
      // A frame's pause between moves; none in background tabs, where frames never come.
      await new Promise((r) => (document.hidden ? r() : (requestAnimationFrame(r), setTimeout(r, 50))));
    }
    const end = hitDeep(to.x, to.y);
    if (dt) {
      if (end.el && accepted) { dragEv(end.el, 'drop', end.lx, end.ly); dropped = true; }
      else if (over) dragEv(over, 'dragleave', end.lx, end.ly);
      dragEv(src, 'dragend', end.lx, end.ly);
    } else if (end.el) { mouse(end.el, 'pointerup', end.lx, end.ly, mods); mouse(end.el, 'mouseup', end.lx, end.ly, { detail: 1, ...mods }); }
    const how = dt ? (dropped ? ' (drag-and-drop: dropped)' : ' (drag-and-drop: target did not accept the drop)') : '';
    const diff = await finish(100, 900);
    return `Dragged ${from.desc} to ${to.desc}${how}${dragCheck()}` + diff;
  }

  // ── Fields ──

  function setNative(el, v) {
    const proto = tag(el) === 'textarea' ? HTMLTextAreaElement.prototype : tag(el) === 'select' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  }

  // Inputs whose value is set, not typed: the browser's own pickers.
  const VALUE_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);
  let lastField = null;

  // Pick the field to type into. A ref to a non-editable wrapper (e.g. a canvas
  // editor's "Document content" box) types where the caret already is, so focus
  // and selection aren't thrown away. Without a ref: the focused element, as is.
  function prepField(t) {
    const active = deepActive();
    let el = resolve(t);
    let own = !!el;
    if (el && tag(el) === 'label' && el.control) el = el.control;
    if (el && !isField(el)) {
      const inner = el.querySelector?.('input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]');
      // A wrapper that calls itself a text box (canvas editors) types at the caret.
      const box = /^(textbox|searchbox|combobox|document|application)$/.test(roleOf(el) || '') || within(el, active);
      if (inner) el = inner;
      else if (box && isField(active)) { el = active; own = false; }
      // Keys go to whatever element was named (a button, a list, a grid).
      else if (!t.anyElement) throw new Error(`${describe(el)}${lastNote} is not a text field. Pass the field's ref, or its label as target.`);
    }
    el ||= active;
    if (!el || el === document.body && !el.isContentEditable) throw new Error('Nothing is focused — pass a ref or target, or click into the field first.');
    const desc = (own ? describe(el) : 'the focused element') + lastNote;
    if (own) {
      const r = focusTarget(el);
      fx.ripple(r.cx, r.cy);
      if (deepActive() !== el) el.focus({ preventScroll: true });
    }
    lastField = el;
    begin();
    const kind = tag(el) === 'select' ? 'select' : tag(el) === 'input' && VALUE_TYPES.has(el.type) ? 'value'
      : tag(el) === 'input' || tag(el) === 'textarea' ? 'plain' : 'rich';
    let cleared = false;
    const clear = t.clear ?? own;
    if (kind === 'plain' || kind === 'rich') {
      if (clear) {
        if (kind === 'plain') { el.select?.(); cleared = !!el.value; }
        else if (el.isContentEditable) {
          const sel = el.ownerDocument.getSelection(); const range = el.ownerDocument.createRange();
          range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
          cleared = !!clean(el.innerText);
        }
      } else if (own && kind === 'plain') {
        try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
      }
    }
    // Fields that suggest as you type need longer to show their list.
    const suggest = roleOf(el) === 'combobox' || el.getAttribute('aria-autocomplete') || el.hasAttribute('list') ||
      el.type === 'search' || /listbox|menu|dialog|grid|tree/.test(el.getAttribute('aria-haspopup') || '');
    return { el, cleared, kind, plain: kind === 'plain', suggest: !!suggest, ref: refOf(el), password: el.type === 'password', desc };
  }

  // date/time/color/range inputs take a value string; accept common spellings.
  function valueFor(el, v) {
    v = String(v).trim();
    const d = new Date(v);
    const pad = (n) => String(n).padStart(2, '0');
    const ymd = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
    switch (el.type) {
      case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(d) ? v : ymd(d);
      case 'datetime-local': return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) || isNaN(d) ? v.replace(' ', 'T') : `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      case 'month': return /^\d{4}-\d{2}$/.test(v) || isNaN(d) ? v : ymd(d).slice(0, 7);
      case 'time': {
        const m = v.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])\.?m?\.?$/i);
        if (!m) return v;
        let h = +m[1] % 12;
        if (/p/i.test(m[4])) h += 12;
        return `${pad(h)}:${m[2]}${m[3] ? ':' + m[3] : ''}`;
      }
    }
    return v;
  }
  function setValue({ value } = {}) {
    const el = lastField;
    if (!el) throw new Error('No field prepared');
    const v = valueFor(el, value);
    setNative(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // Range inputs snap to their step and colors come back lowercase; neither is a rejection.
    if (el.type !== 'range' && el.value.toLowerCase() !== v.toLowerCase() && String(value) !== '') {
      const fmt = { date: 'YYYY-MM-DD', time: 'HH:MM', 'datetime-local': 'YYYY-MM-DDTHH:MM', month: 'YYYY-MM', week: 'YYYY-W##', color: '#rrggbb' }[el.type];
      throw new Error(`The ${el.type} input rejected "${value}"${fmt ? ` (format: ${fmt})` : ''}${el.min || el.max ? `, allowed ${el.min || '…'} to ${el.max || '…'}` : ''}.`);
    }
    return `Set ${describe(el)} to "${el.value}"`;
  }
  // After typing: does the field hold what was typed? Masks and pickers reformat,
  // and some scripts reject or eat input.
  function fieldCheck(expect) {
    const el = lastField;
    if (!el || !('value' in el) || tag(el) === 'select' || !expect) return '';
    const v = el.value;
    if (v.includes(expect)) return '';
    if (el.type === 'password') return v.length === expect.length ? '' : ` (note: the field holds ${v.length} characters, not ${expect.length})`;
    return ` (note: the field now shows "${clip(v, 80)}")`;
  }

  async function type(t = {}) {
    const text = String(t.text ?? '');
    const { el, cleared, desc, kind } = prepField(t);
    const doc = el.ownerDocument;
    if (kind === 'select') return selectOption({ ref: refOf(el), value: text });
    if (kind === 'value') return setValue({ value: text }) + await finish();
    const isInput = kind === 'plain';
    const before = isInput ? el.value : el.innerText;
    let ok = false;
    if (text) ok = doc.execCommand('insertText', false, text);
    else if (cleared) ok = doc.execCommand('delete');
    if (isInput) {
      const expect = cleared ? text : before + text;
      if (!ok || (text && !el.value.includes(text))) {
        setNative(el, expect);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (!ok && el.isContentEditable) {
      if (cleared) el.textContent = text; else el.textContent += text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    }
    const check = t.submit ? '' : fieldCheck(text);
    let tail = '';
    if (t.submit) { press(deepActive() || el, TuffKeys.parse('Enter')[0]); tail = ' and pressed Enter'; }
    return `Typed "${clip(text, 60)}" into ${desc}${tail}${check}` + await finish(60, t.submit ? 700 : 400);
  }

  // Paste text/HTML at the caret as a ClipboardEvent, the way editors (Docs,
  // Notion, Gmail, ProseMirror) expect rich content. If no page handler takes
  // it, insert it ourselves; { unhandled } tells the panel to use the real clipboard.
  async function paste(t = {}) {
    const { el, desc } = prepField({ ref: t.ref, target: t.target, near: t.near, nth: t.nth, selector: t.selector, clear: false });
    const target = deepActive() || el;
    const doc = target.ownerDocument;
    const dt = new DataTransfer();
    if (t.html) dt.setData('text/html', t.html);
    dt.setData('text/plain', t.text || '');
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
    if (target.dispatchEvent(ev)) {
      const isInput = tag(target) === 'input' || tag(target) === 'textarea';
      if (isInput) {
        if (!doc.execCommand('insertText', false, t.text)) {
          const v = target.value, a = target.selectionStart ?? v.length, b = target.selectionEnd ?? v.length;
          setNative(target, v.slice(0, a) + t.text + v.slice(b));
          target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertFromPaste', data: t.text }));
        }
      } else if (!target.isContentEditable || !(t.html ? doc.execCommand('insertHTML', false, t.html) : doc.execCommand('insertText', false, t.text))) {
        return { unhandled: true, desc };
      }
    }
    return { text: `Pasted ${t.html ? 'formatted ' : ''}text (${(t.text || '').length} chars) into ${desc}` + await finish(80, 900) };
  }

  // ── Menus: find a visible item by its label, preferring open popups ──
  const MENU_ROLES = new Set(['menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'treeitem', 'button', 'link', 'combobox', 'listbox']);
  // offscreen: also items scrolled out of view inside a long menu (they get scrolled in).
  function menuFind({ label, roles, offscreen } = {}) {
    const want = norm(label);
    if (!want) throw new Error('Empty menu label');
    const ok = roles ? new Set(roles) : MENU_ROLES;
    const words = want.split(' ');
    let best = null, bestScore = 0;
    const popupNames = [];
    for (const el of elements(document.body || document.documentElement)) {
      const role = roleOf(el);
      const pointerItem = !roles && !role && el.closest('[role=menu],[role=listbox]') && isInteractive(el, role);
      if ((!role || !ok.has(role)) && !pointerItem) continue;
      if (!visible(el) || (!offscreen && !viewRect(el))) continue;
      const raw = nameOf(el, role);
      const name = norm(raw);
      const popup = !!el.closest('[role=menu],[role=listbox],[role=dialog],[role=tree]');
      if (popup && name && popupNames.length < 40 && !popupNames.includes(raw)) popupNames.push(raw);
      if (!name) continue;
      let s = name === want ? 100 : name.startsWith(want) ? 60 : name.includes(want) ? 30 : words.every((w) => name.includes(w)) ? 15 : 0;
      if (!s) continue;
      if (role?.startsWith('menuitem') || role === 'option') s += 10;
      if (popup) s += 5;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') s -= 50;
      if (s >= bestScore) { best = el; bestScore = s; } // ties: later in the DOM (popups render last)
    }
    if (!best || bestScore <= 0) {
      throw new Error(`No visible menu item matching "${label}".` + (popupNames.length ? ` Open menu has: ${popupNames.join(' | ')}` : ''));
    }
    const r = focusTarget(best);
    const p = clickPoint(best, r);
    begin();
    const on = (a) => best.getAttribute(a) === 'true';
    return { x: p.x, y: p.y, ref: refOf(best), desc: describe(best), expanded: best.getAttribute('aria-expanded'), sub: best.getAttribute('aria-haspopup'),
      checked: on('aria-checked') || on('aria-selected') || on('aria-pressed'), exact: norm(nameOf(best, roleOf(best))) === want };
  }

  // ── Keys ──

  function focusables(doc) {
    return [...doc.querySelectorAll('a[href],button,input,select,textarea,[tabindex],[contenteditable]')]
      .filter((e) => e.tabIndex >= 0 && !e.disabled && visible(e));
  }

  // One synthetic key press (keydown/keypress/keyup plus the default action).
  function press(target, k) {
    const init = { key: k.key, code: k.code, keyCode: k.keyCode, which: k.keyCode, ctrlKey: k.ctrl, metaKey: k.meta, altKey: k.alt, shiftKey: k.shift,
      bubbles: true, cancelable: true, composed: true };
    const proceed = target.dispatchEvent(new KeyboardEvent('keydown', init));
    if (proceed && (k.key.length === 1 || k.key === 'Enter') && !k.ctrl && !k.meta) target.dispatchEvent(new KeyboardEvent('keypress', { ...init, charCode: k.key === 'Enter' ? 13 : k.key.charCodeAt(0) }));
    if (proceed && !k.ctrl && !k.meta && !k.alt) {
      const editable = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (k.key === 'Enter' && target.tagName === 'INPUT' && target.form) target.form.requestSubmit();
      else if (k.key === 'Enter' && (target.tagName === 'TEXTAREA' || target.isContentEditable)) target.ownerDocument.execCommand(target.isContentEditable ? 'insertParagraph' : 'insertText', false, '\n');
      else if (k.key.length === 1 && editable) target.ownerDocument.execCommand('insertText', false, k.key);
      else if (k.key === 'Backspace' && editable) target.ownerDocument.execCommand('delete');
      else if (k.key === 'Delete' && editable) target.ownerDocument.execCommand('forwardDelete');
      else if (k.key === 'Tab') {
        const list = focusables(target.ownerDocument);
        const i = list.indexOf(target);
        list[(i + (k.shift ? -1 : 1) + list.length) % list.length]?.focus();
      } else if (k.key === 'Enter' && (target.tagName === 'A' || target.tagName === 'BUTTON')) target.click();
    }
    if (proceed && (k.ctrl || k.meta) && k.key.toLowerCase() === 'a' && (target.select || target.isContentEditable)) {
      target.select ? target.select() : target.ownerDocument.execCommand('selectAll');
    }
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  async function key(t = {}) {
    if (t.ref || t.target) prepField({ ref: t.ref, target: t.target, near: t.near, nth: t.nth, clear: false, anyElement: true });
    else begin();
    for (const k of TuffKeys.parse(t.keys)) {
      if (k.text) {
        const target = deepActive() || document.body;
        if (!target.ownerDocument.execCommand('insertText', false, k.text)) for (const ch of k.text) press(target, TuffKeys.parse(ch === ' ' ? 'Space' : ch)[0]);
        continue;
      }
      for (let i = 0; i < k.n; i++) press(deepActive() || document.body, k);
    }
    return `Pressed ${String(t.keys).trim()}` + await finish();
  }

  // Trusted key path: focus the ref (if any) and start watching for changes.
  function keyPrep(t = {}) {
    if (t.ref || t.target) prepField({ ref: t.ref, target: t.target, near: t.near, nth: t.nth, clear: false, anyElement: true });
    else begin();
    return true;
  }

  // ── Scrolling ──

  const scrollable = (el) => {
    const s = styleOf(el);
    return (/(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4) ||
      (/(auto|scroll|overlay)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 4);
  };
  function scrollerFrom(el) {
    for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement || el.parentNode?.host) {
      if (el.nodeType === 1 && scrollable(el)) return el;
    }
    return document.scrollingElement || document.documentElement;
  }

  async function scroll(t = {}) {
    const el = t.ref || t.target || t.selector ? resolve(t) : null;
    if (el && !t.direction) {
      begin();
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      focusTarget(el);
      return `Scrolled ${describe(el)}${lastNote} into view` + await finish(60, 300);
    }
    const dir = t.direction || 'down';
    // Inside the given element, else the scrollable area under the screen's center
    // (an open dialog's list scrolls, not the page behind it).
    const sc = el ? scrollerFrom(el) : scrollerFrom(hitDeep(innerWidth / 2, innerHeight / 2).el);
    const page = sc === document.scrollingElement || sc === document.documentElement;
    const amt = +t.amount || Math.round((page ? innerHeight : sc.clientHeight) * 0.85);
    const opts = { behavior: 'instant' };
    const y0 = sc.scrollTop, x0 = sc.scrollLeft;
    if (dir === 'top') sc.scrollTo({ top: 0, ...opts });
    else if (dir === 'bottom') sc.scrollTo({ top: sc.scrollHeight, ...opts });
    else if (dir === 'up') sc.scrollBy({ top: -amt, ...opts });
    else if (dir === 'left') sc.scrollBy({ left: -amt, ...opts });
    else if (dir === 'right') sc.scrollBy({ left: amt, ...opts });
    else sc.scrollBy({ top: amt, ...opts });
    // Infinite lists load more when they reach the bottom.
    await settle(120, 900);
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    const moved = sc.scrollTop !== y0 || sc.scrollLeft !== x0;
    const where = page ? 'the page' : describe(sc);
    const head = `Scrolled ${where} ${dir}; position ${Math.round(sc.scrollTop)}/${max}${sc.scrollTop >= max - 2 ? ' (at bottom)' : ''}` +
      (moved ? '' : ' — it did not move (nothing more that way, or the wrong scroll area: pass ref of the list to scroll it)');
    // What is on screen now, so the model can read on without a read_page.
    const view = await snapshot({ mode: 'all', viewportOnly: true, maxChars: 5000 });
    return `${head}\n\nOn screen now:\n${view.split('\n').slice(2).join('\n').trim()}`;
  }

  async function hover(t = {}) {
    const a = aim(t);
    begin();
    for (const ty of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) mouse(a.el, ty, a.lx, a.ly, { bubbles: !ty.endsWith('enter') });
    return `Hovered ${a.desc}` + await finish();
  }

  async function selectOption(t = {}) {
    let el = resolve(t);
    if (el && tag(el) !== 'select') el = el.querySelector?.('select') || (tag(el) === 'label' ? el.control : null) || el;
    if (!el || tag(el) !== 'select') throw new Error('select_option needs a native <select> — for custom dropdowns, click to open them, then click the option (target: its label).');
    focusTarget(el);
    begin();
    const want = String(t.value).toLowerCase().trim();
    const opts = [...el.options];
    const opt = opts.find((o) => o.value.toLowerCase() === want || clean(o.text).toLowerCase() === want)
      || opts.find((o) => clean(o.text).toLowerCase().startsWith(want)) || opts.find((o) => clean(o.text).toLowerCase().includes(want));
    if (!opt) throw new Error(`No option "${t.value}". Options: ${opts.map((o) => clean(o.text)).join(' | ')}`);
    if (opt.disabled) throw new Error(`Option "${clean(opt.text)}" is disabled.`);
    setNative(el, opt.value);
    opt.selected = true;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return `Selected "${clean(opt.text)}" in ${describe(el)}` + await finish();
  }

  // ── Reading ──

  function text({ maxChars = 15000, selector, query } = {}) {
    let root = selector ? document.querySelector(selector) : null;
    if (selector && !root) throw new Error(`No element matches ${selector}`);
    root ||= document.body;
    let t = (root.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const head = `${document.title} — ${location.href}`;
    if (query) return `${head}\n\n${grep(t, query, maxChars)}`;
    const total = t.length;
    if (t.length > maxChars) t = t.slice(0, maxChars) + `\n… (${total - maxChars} more chars; pass query, a selector, or a larger max_chars)`;
    return `${head}\n\n${t}`;
  }
  // Lines that mention the query, best first, each with a line of context.
  function grep(t, query, maxChars) {
    const lines = t.split('\n').map((l) => l.trim());
    const terms = norm(query).split(' ').filter((w) => w.length > 1 || /\d/.test(w));
    if (!terms.length) throw new Error('Empty query');
    const score = (l) => { const x = l.toLowerCase(); return terms.filter((w) => x.includes(w)).length; };
    const scored = lines.map((l, i) => ({ i, n: l ? score(l) : 0 })).filter((x) => x.n);
    if (!scored.length) return `No lines mention "${query}". Try other words, or read the page.`;
    const top = Math.max(...scored.map((x) => x.n));
    const need = top === terms.length ? top : Math.max(1, Math.ceil(terms.length / 2));
    const hits = scored.filter((x) => x.n >= need).sort((a, b) => b.n - a.n || a.i - b.i).slice(0, 30).sort((a, b) => a.i - b.i);
    const out = [];
    let last = -2, size = 0;
    for (const h of hits) {
      const from = Math.max(0, h.i - 1), to = Math.min(lines.length - 1, h.i + 1);
      if (from > last + 1 && out.length) out.push('---');
      for (let k = Math.max(from, last + 1); k <= to; k++) {
        if (!lines[k]) continue;
        const l = (k === h.i ? '» ' : '  ') + clip(lines[k], 500);
        out.push(l); size += l.length;
      }
      last = to;
      if (size > maxChars) { out.push('…'); break; }
    }
    const note = top < terms.length ? ` (no line has every word; showing lines with ${need}+ of ${terms.length})` : '';
    return `${hits.length} matching line${hits.length === 1 ? '' : 's'} for "${query}"${note}:\n${out.join('\n')}`;
  }

  async function waitFor({ text: txt, selector, timeout = 5000, gone = false } = {}) {
    const present = () => (selector ? !!document.querySelector(selector) : (document.body.innerText || '').toLowerCase().includes(String(txt).toLowerCase()));
    const test = () => present() !== !!gone;
    const what = selector || `"${txt}"`;
    const okMsg = gone ? `${what} is gone` : `Found ${what}`;
    if (test()) return okMsg;
    return new Promise((res) => {
      const mo = new MutationObserver(() => { if (test()) end(true); });
      const timer = setTimeout(() => end(false), Math.min(timeout, 20000));
      function end(ok) { mo.disconnect(); clearTimeout(timer); res(ok ? okMsg : `Timed out waiting for ${what}${gone ? ' to disappear' : ''}`); }
      mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    });
  }

  function viewport() {
    return { w: innerWidth, h: innerHeight, dpr: devicePixelRatio };
  }

  // ── Screenshot labels: a ref tag on every clickable element in view ──
  function markable(max = 120) {
    const out = [], t0 = performance.now();
    let n = 0;
    for (const el of elements(document.body || document.documentElement)) {
      if ((++n & 255) === 0 && performance.now() - t0 > 120) break;
      const role = roleOf(el);
      if (!isInteractive(el, role) || !visible(el)) continue;
      const r = viewRect(el);
      if (!r || r.w < 4 || r.h < 4 || !onTop(el, r)) continue;
      // Skip a child that just repeats its interactive parent's box.
      const p = out[out.length - 1];
      if (p && within(p.el, el) && Math.abs(p.r.x - r.x) < 5 && Math.abs(p.r.y - r.y) < 5 && Math.abs(p.r.w - r.w) < 8 && Math.abs(p.r.h - r.h) < 8) continue;
      out.push({ el, role, r });
      if (out.length >= max) break;
    }
    return out;
  }

  async function capturePrep({ labels = true } = {}) {
    let legend = '';
    if (labels) {
      const list = markable();
      fx.marks(list.map((m) => ({ r: m.r, ref: refOf(m.el) })));
      for (const m of list) {
        const l = line(m.el, m.role || tag(m.el), nameOf(m.el, m.role));
        if (legend.length + l.length > 6000) { legend += '\n…'; break; }
        legend += (legend ? '\n' : '') + l;
      }
    }
    await fx.capture(true);
    return { vp: viewport(), legend };
  }
  function captureDone() { fx.capture(false); return true; }

  // ── Visual feedback: glow frame + ghost cursor, all pointer-events: none ──
  const fx = (() => {
    let host, root, cursorEl, frame, pill, marksEl, hideT, shown = false;
    const css = `
      :host { all: initial; }
      .frame { position: fixed; inset: 0; pointer-events: none; border-radius: 0; opacity: 0;
        box-shadow: inset 0 0 0 2px rgba(255,112,67,.85), inset 0 0 36px 2px rgba(255,112,67,.28);
        transition: opacity .28s ease; }
      .frame.on { opacity: 1; animation: breathe 2.6s ease-in-out infinite; }
      @keyframes breathe { 50% { box-shadow: inset 0 0 0 2px rgba(255,150,90,.95), inset 0 0 52px 4px rgba(255,112,67,.38); } }
      .pill { position: fixed; left: 50%; bottom: 18px; transform: translate(-50%, 12px); opacity: 0; pointer-events: none;
        font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; letter-spacing: .01em;
        color: #fff; background: rgba(20,20,22,.82); backdrop-filter: blur(12px) saturate(1.4);
        padding: 8px 12px 8px 10px; border-radius: 999px; display: flex; gap: 8px; align-items: center;
        box-shadow: 0 8px 30px rgba(0,0,0,.25), 0 0 0 1px rgba(255,255,255,.08);
        transition: opacity .25s ease, transform .35s cubic-bezier(.2,.9,.25,1.15); }
      .pill.on { opacity: 1; transform: translate(-50%, 0); }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #ff7043; box-shadow: 0 0 0 0 rgba(255,112,67,.7); animation: ping 1.4s ease-out infinite; }
      @keyframes ping { 70% { box-shadow: 0 0 0 7px rgba(255,112,67,0); } 100% { box-shadow: 0 0 0 0 rgba(255,112,67,0); } }
      .cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none; opacity: 0;
        transform: translate(var(--x), var(--y)); transition: transform .2s cubic-bezier(.2,.8,.2,1), opacity .2s ease;
        filter: drop-shadow(0 2px 4px rgba(0,0,0,.35)); }
      .cursor.on { opacity: 1; }
      :host(.cap) .frame, :host(.cap) .pill, :host(.cap) .cursor, :host(.cap) .ripple { visibility: hidden; transition: none; animation: none; }
      .marks { position: fixed; inset: 0; pointer-events: none; }
      .mk { position: absolute; box-sizing: border-box; border: 1.5px solid var(--c); border-radius: 2px; }
      .mk b { position: absolute; left: -1.5px; top: -15px; padding: 0 3px; height: 14px; font: 700 11px/14px ui-monospace, Menlo, monospace;
        color: #fff; background: var(--c); border-radius: 2px; white-space: nowrap; }
      .mk.in b { top: -1.5px; }
      .rule { position: absolute; font: 600 9px/1 ui-monospace, Menlo, monospace; color: #c2185b; text-shadow: 0 0 2px #fff, 0 0 2px #fff; }
      .rule.x { top: 1px; transform: translateX(-50%); }
      .rule.y { left: 1px; transform: translateY(-50%); }
      .rule::before { content: ''; position: absolute; background: #c2185b; }
      .rule.x::before { left: 50%; top: 10px; width: 1px; height: 5px; }
      .rule.y::before { top: 50%; left: 100%; margin-left: 2px; width: 5px; height: 1px; }
      .ripple { position: fixed; width: 36px; height: 36px; margin: -18px 0 0 -18px; border-radius: 50%; pointer-events: none;
        border: 2px solid rgba(255,112,67,.9); animation: rip .5s cubic-bezier(.2,.7,.3,1) forwards; }
      @keyframes rip { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
      @media (prefers-reduced-motion: reduce) { .frame.on, .dot { animation: none; } .cursor { transition: none; } }`;
    function ensure() {
      if (host?.isConnected) return;
      host = document.createElement('div');
      host.id = HOST_ID;
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${css}</style><div class="frame"></div>
        <div class="pill"><span class="dot"></span><span class="label">TuffAgent is working</span></div>
        <svg class="cursor" viewBox="0 0 24 24" style="--x:-40px;--y:-40px"><path d="M4 2.5l15 8.2-6.6 1.6-3.1 6.3z" fill="#ff7043" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>
        <div class="marks"></div>`;
      marksEl = root.querySelector('.marks');
      frame = root.querySelector('.frame');
      pill = root.querySelector('.pill');
      cursorEl = root.querySelector('.cursor');
      document.documentElement.appendChild(host);
    }
    return {
      show(on, label) {
        clearTimeout(hideT);
        shown = !!on;
        if (on) {
          ensure();
          if (label) root.querySelector('.label').textContent = label;
          requestAnimationFrame(() => { frame.classList.add('on'); pill.classList.add('on'); });
        } else if (host) {
          frame.classList.remove('on'); pill.classList.remove('on'); cursorEl.classList.remove('on');
          hideT = setTimeout(() => host?.remove(), 400);
        }
        return true;
      },
      cursor(x, y) {
        if (!host?.isConnected) return;
        cursorEl.style.setProperty('--x', x - 4 + 'px');
        cursorEl.style.setProperty('--y', y - 3 + 'px');
        cursorEl.classList.add('on');
      },
      ripple(x, y) {
        if (!host?.isConnected) return;
        const r = document.createElement('div');
        r.className = 'ripple'; r.style.left = x + 'px'; r.style.top = y + 'px';
        root.appendChild(r);
        setTimeout(() => r.remove(), 520);
      },
      // Ref tags (plus 100px rulers on the top/left edges) drawn only for screenshots.
      marks(list) {
        ensure();
        const COLORS = ['#d32f2f', '#1565c0', '#2e7d32', '#6a1b9a', '#e65100', '#00838f', '#ad1457', '#4e342e'];
        const f = document.createDocumentFragment();
        list.forEach(({ r, ref }, i) => {
          const m = document.createElement('div');
          m.className = 'mk' + (r.y < 15 ? ' in' : '');
          m.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;--c:${COLORS[i % COLORS.length]}`;
          m.appendChild(document.createElement('b')).textContent = ref;
          f.appendChild(m);
        });
        const tick = (cls, v, prop) => {
          const t = document.createElement('div');
          t.className = 'rule ' + cls; t.style[prop] = v + 'px'; t.textContent = v;
          f.appendChild(t);
        };
        for (let x = 100; x < innerWidth; x += 100) tick('x', x, 'left');
        for (let y = 100; y < innerHeight; y += 100) tick('y', y, 'top');
        marksEl.replaceChildren(f);
      },
      // Hide the glow/pill/cursor (but keep marks) while the tab is captured.
      capture(on) {
        if (on) {
          ensure();
          host.classList.add('cap');
          const frames = new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))));
          return Promise.race([frames, new Promise((r) => setTimeout(() => r(true), 120))]);
        }
        if (!host) return true;
        marksEl.replaceChildren();
        host.classList.remove('cap');
        if (!shown) host.remove();
        return true;
      },
    };
  })();

  window.__tuff = {
    snapshot, find, click, point, type, key, keyPrep, scroll, hover, selectOption, drag, dragPoints, dragCheck, paste, menuFind,
    prepField: (t) => { const info = prepField(t); delete info.el; return info; },
    setValue, fieldCheck,
    text, waitFor, viewport, begin, changes,
    settle: (q, c) => finish(q, c),
    quiet: (q, c) => settle(q, c).then(() => true),
    capturePrep, captureDone,
    overlay: (on, label) => fx.show(on, label),
  };
})();
