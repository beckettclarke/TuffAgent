// TuffAgent page runtime. Lives in the extension's isolated world, so refs
// survive between tool calls without touching the page's own JS.
(() => {
  if (window.__tuff) return;

  const HOST_ID = '__tuff_host';
  const refs = new Map();
  const ids = new WeakMap();
  let seq = 0;

  const refOf = (el) => {
    let r = ids.get(el);
    if (!r) { r = 'e' + (++seq); ids.set(el, r); refs.set(r, new WeakRef(el)); }
    return r;
  };
  const byRef = (r) => {
    const el = refs.get(String(r).replace(/^\[|\]$/g, ''))?.deref();
    return el && el.isConnected ? el : null;
  };

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const tag = (el) => el.tagName.toLowerCase();

  const ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'listbox', 'treeitem', 'file']);
  const TEXT_TAGS = new Set(['p', 'li', 'td', 'th', 'dt', 'dd', 'blockquote', 'pre', 'figcaption', 'caption', 'label', 'legend', 'summary']);
  const INPUT_ROLE = { checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button',
    reset: 'button', image: 'button', search: 'searchbox', file: 'file', number: 'spinbutton' };

  function isEditable(el) {
    const ce = el.getAttribute('contenteditable');
    return ce === '' || ce === 'true' || ce === 'plaintext-only';
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
    }
    if (isEditable(el)) return 'textbox';
    return null;
  }

  function isInteractive(el, role) {
    if (role && ROLES.has(role)) return true;
    if (el.hasAttribute('onclick') || (el.tabIndex >= 0 && el.hasAttribute('tabindex') && role !== 'heading')) return true;
    return false;
  }

  function nameOf(el, role) {
    let n = el.getAttribute('aria-label') || '';
    if (!n) {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) n = lb.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent || '').join(' ');
    }
    const field = role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton';
    if (!n && el.labels?.length) n = [...el.labels].map((l) => l.textContent).join(' ');
    if (!n) n = el.getAttribute('alt') || '';
    if (!n && !field && tag(el) !== 'select') n = el.innerText || '';
    if (!n && tag(el) === 'input' && /^(submit|button|reset)$/.test(el.type)) n = el.value;
    if (!n) n = el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
    if (!n && !field) {
      const img = el.querySelector?.('img[alt], svg[aria-label], [title]');
      if (img) n = img.getAttribute('alt') || img.getAttribute('aria-label') || img.getAttribute('title') || '';
    }
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
      x += fr.left; y += fr.top;
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

  const within = (anc, n) => { while (n) { if (n === anc) return true; n = n.parentNode || n.host; } return false; };

  // Topmost element at a viewport point, descending into shadow roots and same-origin frames.
  function hitDeep(x, y) {
    let doc = document, lx = x, ly = y, el = doc.elementFromPoint(lx, ly);
    for (;;) {
      while (el?.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(lx, ly); if (!inner || inner === el) break; el = inner; }
      if (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) {
        let d = null;
        try { d = el.contentDocument; } catch {}
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
        let d = null;
        try { d = a.contentDocument; } catch {}
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
      if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT' || t === 'TEMPLATE' || t === 'SVG' || t === 'svg') {
        node = nextSkipping(walker, node); continue;
      }
      yield node;
      if (node.shadowRoot) yield* elements(node.shadowRoot);
      if (t === 'IFRAME' || t === 'FRAME') {
        try { const d = node.contentDocument; if (d?.body) yield* elements(d.body); } catch {}
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
    return name ? `${role} "${name}"` : role;
  }

  function line(el, role, name) {
    let s = `[${refOf(el)}] ${role}`;
    if (name) s += ` "${name}"`;
    const t = tag(el);
    if (t === 'input' || t === 'textarea') {
      if (el.type === 'checkbox' || el.type === 'radio') s += el.checked ? ' checked' : '';
      else if (el.type === 'password') s += el.value ? ' value=•••' : '';
      else {
        if (el.value) s += ` value="${clip(clean(el.value), 60)}"`;
        else if (el.placeholder && el.placeholder !== name) s += ` placeholder="${clip(el.placeholder, 40)}"`;
        if (el.type && el.type !== 'text' && el.type !== 'textarea' && role === 'textbox') s += ` type=${el.type}`;
      }
    } else if (t === 'select') {
      const opts = [...el.options].slice(0, 12).map((o) => clip(clean(o.text), 30));
      s += ` value="${clip(clean(el.selectedOptions[0]?.text || ''), 40)}" options=[${opts.join(' | ')}${el.options.length > 12 ? ' …' : ''}]`;
    } else if (role === 'link') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:') && href !== '#') {
        let h = href;
        try { const u = new URL(href, location.href); h = u.origin === location.origin ? u.pathname + u.search : u.href; } catch {}
        s += ` → ${clip(h, 70)}`;
      }
    } else if (isEditable(el)) {
      const v = clean(el.innerText);
      if (v) s += ` value="${clip(v, 60)}"`;
    }
    const aria = (a) => el.getAttribute(a);
    if (aria('aria-checked') === 'true') s += ' checked';
    if (aria('aria-selected') === 'true') s += ' selected';
    if (aria('aria-expanded')) s += ` expanded=${aria('aria-expanded')}`;
    if (aria('aria-pressed') === 'true') s += ' pressed';
    if (el.disabled || aria('aria-disabled') === 'true') s += ' disabled';
    if (role === 'heading') s = s.replace('heading', 'h' + (t.match(/h(\d)/)?.[1] || aria('aria-level') || ''));
    return s;
  }

  function snapshot({ mode = 'interactive', maxChars = 24000, viewportOnly = false } = {}) {
    const out = [];
    let size = 0, truncated = false, below = 0, above = 0;
    const vh = innerHeight, vw = innerWidth;
    const seenText = new WeakSet();
    for (const el of elements(document.body || document.documentElement)) {
      const role = roleOf(el);
      const interactive = isInteractive(el, role);
      const isText = !interactive && mode === 'all' && (role === 'heading' || TEXT_TAGS.has(tag(el)) || role === 'img');
      if (!interactive && !isText) continue;
      if (isText && el.closest('a,button,[role=button],[role=link]')) continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const off = r.bottom < 0 ? 'above' : r.top > vh ? 'below' : (r.right < 0 || r.left > vw) ? 'side' : '';
      if (off === 'above') above++;
      if (off === 'below') below++;
      if (viewportOnly && off) continue;
      let s;
      if (isText) {
        if (role === 'img') {
          const alt = clean(el.getAttribute('alt'));
          if (!alt) continue;
          s = `img "${clip(alt, 80)}"`;
        } else if (role === 'heading') {
          s = line(el, role, nameOf(el, role));
        } else {
          let p = el.parentElement, dup = false;
          while (p) { if (seenText.has(p)) { dup = true; break; } p = p.parentElement; }
          if (dup) continue;
          const txt = clean(el.innerText);
          if (!txt || txt.length < 2) continue;
          seenText.add(el);
          s = clip(txt, 220);
        }
      } else {
        s = line(el, role || tag(el), nameOf(el, role));
      }
      if (off) s += ' ·off';
      if (size + s.length > maxChars) { truncated = true; break; }
      out.push(s); size += s.length + 1;
    }
    const se = document.scrollingElement || document.documentElement;
    const head = [
      `${document.title || '(untitled)'} — ${location.href}`,
      `viewport ${vw}×${vh}, scroll ${Math.round(se.scrollTop)}/${Math.max(0, se.scrollHeight - vh)}` +
        (above || below ? `, ${above} elements above / ${below} below viewport (·off)` : ''),
      '',
    ];
    if (truncated) out.push(`… truncated at ${maxChars} chars. Use find() or scroll + viewport_only.`);
    if (!out.length) out.push('(no elements found — page may still be loading, or content is in a canvas/cross-origin frame)');
    return head.concat(out).join('\n');
  }

  function find({ query, limit = 25 }) {
    const q = clean(query).toLowerCase();
    if (!q) throw new Error('Empty query');
    const words = q.split(' ');
    const hits = [];
    for (const el of elements(document.body)) {
      const role = roleOf(el);
      const interactive = isInteractive(el, role);
      if (!interactive && role !== 'heading' && !TEXT_TAGS.has(tag(el))) continue;
      const name = nameOf(el, role);
      const hay = (name + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.id || '') + ' ' + (interactive ? '' : clean(el.innerText).slice(0, 300))).toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
      if (!visible(el)) continue;
      const score = (interactive ? 2 : 0) + (name.toLowerCase() === q ? 3 : 0) + (hay.startsWith(q) ? 1 : 0);
      hits.push({ score, s: interactive ? line(el, role || tag(el), name) : `[${refOf(el)}] ${role || tag(el)} "${clip(clean(el.innerText), 120)}"` });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.length ? hits.slice(0, limit).map((h) => h.s).join('\n') : `No matches for "${query}".`;
  }

  function resolve(t = {}) {
    if (t.ref) {
      const el = byRef(t.ref);
      if (!el) throw new Error(`Ref ${t.ref} is stale or unknown — call read_page/find again.`);
      return el;
    }
    if (t.selector) {
      const el = document.querySelector(t.selector);
      if (!el) throw new Error(`No element matches selector ${t.selector}`);
      return el;
    }
    return null;
  }

  // Wait until the DOM goes quiet (or a cap). Keeps actions fast but stable.
  function settle(quiet = 80, cap = 700) {
    return new Promise((res) => {
      let timer = setTimeout(done, quiet);
      const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, quiet); });
      const capT = setTimeout(done, cap);
      function done() { mo.disconnect(); clearTimeout(timer); clearTimeout(capT); res(); }
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    });
  }

  // ── What an action changed: interactive elements that came on screen ──
  // Lets the model chain menu → submenu → dialog clicks without re-reading the page.
  function onScreen(budget = 60) {
    const set = new Set(), t0 = performance.now();
    let n = 0;
    for (const el of elements(document.body || document.documentElement)) {
      if ((++n & 255) === 0 && performance.now() - t0 > budget) return null;
      if (!isInteractive(el, roleOf(el)) || !visible(el) || !viewRect(el)) continue;
      set.add(el);
    }
    return set;
  }
  let watch = null;
  function begin() { watch = onScreen(); return true; }
  function changes() {
    const before = watch;
    watch = null;
    if (!before) return '';
    const after = onScreen();
    if (!after) return '';
    const added = [...after].filter((e) => !before.has(e));
    let gone = 0;
    for (const e of before) if (!after.has(e)) gone++;
    let s = '';
    for (let i = 0; i < added.length; i++) {
      const role = roleOf(added[i]);
      const l = line(added[i], role || tag(added[i]), nameOf(added[i], role));
      if (i >= 50 || s.length + l.length > 3500) { s += `\n… ${added.length - i} more (read_page for all)`; break; }
      s += '\n' + l;
    }
    return (added.length ? `\n\nNew on screen:${s}` : '') + (gone ? `\n(${gone} element${gone === 1 ? '' : 's'} left the screen)` : '');
  }
  async function finish(quiet, cap) { await settle(quiet, cap); return changes(); }

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

  // Click target + local (frame) coords for a ref/selector or a viewport x/y.
  function aim(t) {
    const el = resolve(t);
    if (el) {
      const r = focusTarget(el);
      return { el, x: r.cx, y: r.cy, lx: r.cx - r.ox, ly: r.cy - r.oy, desc: describe(el) };
    }
    if (t.x == null || t.y == null) throw new Error('needs ref, selector, or x/y');
    const x = +t.x, y = +t.y;
    const h = hitDeep(x, y);
    if (!h.el) throw new Error(`Nothing at (${x}, ${y}) — outside the viewport?`);
    fx.cursor(x, y);
    return { el: h.el, x, y, lx: h.lx, ly: h.ly, desc: `(${x}, ${y}) on ${describe(h.el)}` };
  }

  async function click(t = {}) {
    const a = aim(t);
    begin();
    let { el } = a, note = '';
    const doc = el.ownerDocument;
    let target = el;
    const top = doc.elementFromPoint(a.lx, a.ly);
    if (top && top !== el) {
      if (within(el, top)) target = top;
      else if (!within(top, el) && top.id !== HOST_ID) note = ` (warning: covered by ${describe(top)})`;
    }
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
    return `Clicked ${a.desc}${note}` + await finish();
  }

  // Coordinates for trusted (CDP) input; the panel dispatches the real events.
  function point(t = {}) {
    const a = aim(t);
    begin();
    if (!t.hover) fx.ripple(a.x, a.y);
    return { x: a.x, y: a.y, desc: a.desc };
  }

  function dragEnds(t = {}) {
    const from = aim(t);
    let to;
    const toEl = t.to_ref ? resolve({ ref: t.to_ref }) : null;
    if (toEl) { const r = viewRect(toEl) || rectOf(toEl); to = { x: r.cx, y: r.cy, desc: describe(toEl) }; }
    else if (t.to_x != null && t.to_y != null) to = { x: +t.to_x, y: +t.to_y, desc: `(${t.to_x}, ${t.to_y})` };
    else throw new Error('drag needs to_ref or to_x/to_y');
    begin();
    return { from, to };
  }
  function dragPoints(t) {
    const { from, to } = dragEnds(t);
    return { x1: from.x, y1: from.y, x2: to.x, y2: to.y, desc: `${from.desc} to ${to.desc}` };
  }
  async function drag(t) {
    const { from, to } = dragEnds(t);
    const mods = MODS(t.modifiers);
    mouse(from.el, 'pointerdown', from.lx, from.ly, mods); mouse(from.el, 'mousedown', from.lx, from.ly, { detail: 1, ...mods });
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const x = from.x + (to.x - from.x) * i / steps, y = from.y + (to.y - from.y) * i / steps;
      const h = hitDeep(x, y);
      fx.cursor(x, y);
      if (h.el) { mouse(h.el, 'pointermove', h.lx, h.ly, { buttons: 1, ...mods }); mouse(h.el, 'mousemove', h.lx, h.ly, { buttons: 1, ...mods }); }
    }
    const end = hitDeep(to.x, to.y);
    if (end.el) { mouse(end.el, 'pointerup', end.lx, end.ly, mods); mouse(end.el, 'mouseup', end.lx, end.ly, { detail: 1, ...mods }); }
    return `Dragged ${from.desc} to ${to.desc}` + await finish();
  }

  function setNative(el, v) {
    const proto = tag(el) === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  }

  // Pick the field to type into. A ref to a non-editable wrapper (e.g. a canvas
  // editor's "Document content" box) types where the caret already is, so focus
  // and selection aren't thrown away. Without a ref: the focused element, as is.
  function prepField(t) {
    const active = deepActive();
    let el = resolve(t);
    let own = !!el;
    if (el && !isField(el)) {
      const inner = el.querySelector?.('input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]');
      if (inner) el = inner;
      else if (isField(active)) { el = active; own = false; }
    }
    el ||= active;
    if (!el || el === document.body && !el.isContentEditable) throw new Error('Nothing is focused — pass a ref, or click into the field first.');
    if (own) {
      const r = focusTarget(el);
      fx.ripple(r.cx, r.cy);
      if (deepActive() !== el) el.focus({ preventScroll: true });
    }
    begin();
    let cleared = false;
    const clear = t.clear ?? own;
    if (clear) {
      if (tag(el) === 'input' || tag(el) === 'textarea') { el.select?.(); cleared = !!el.value; }
      else if (el.isContentEditable) {
        const sel = el.ownerDocument.getSelection(); const range = el.ownerDocument.createRange();
        range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
        cleared = !!clean(el.innerText);
      }
    } else if (own && (tag(el) === 'input' || tag(el) === 'textarea')) {
      try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
    }
    return { el, cleared, desc: own ? describe(el) : 'the focused element' };
  }

  async function type(t = {}) {
    const text = String(t.text ?? '');
    const { el, cleared, desc } = prepField(t);
    const doc = el.ownerDocument;
    if (tag(el) === 'select') return selectOption({ ref: refOf(el), value: text });
    const isInput = tag(el) === 'input' || tag(el) === 'textarea';
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
    let tail = '';
    if (t.submit) { press(deepActive() || el, TuffKeys.parse('Enter')[0]); tail = ' and pressed Enter'; }
    return `Typed "${clip(text, 60)}" into ${desc}${tail}` + await finish(60, t.submit ? 700 : 400);
  }

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
    if (t.ref) prepField({ ref: t.ref, clear: false });
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
    if (t.ref) prepField({ ref: t.ref, clear: false });
    else begin();
    return true;
  }

  function scrollerAt(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el !== document.body && el !== document.documentElement) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  async function scroll(t = {}) {
    begin();
    if (t.ref || t.selector) {
      const el = resolve(t);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      focusTarget(el);
      return `Scrolled ${describe(el)} into view` + await finish(60, 300);
    }
    const dir = t.direction || 'down';
    const sc = scrollerAt(innerWidth / 2, innerHeight / 2);
    const amt = +t.amount || Math.round(innerHeight * 0.85);
    const opts = { behavior: 'instant' };
    if (dir === 'top') sc.scrollTo({ top: 0, ...opts });
    else if (dir === 'bottom') sc.scrollTo({ top: sc.scrollHeight, ...opts });
    else if (dir === 'up') sc.scrollBy({ top: -amt, ...opts });
    else if (dir === 'left') sc.scrollBy({ left: -amt, ...opts });
    else if (dir === 'right') sc.scrollBy({ left: amt, ...opts });
    else sc.scrollBy({ top: amt, ...opts });
    const diff = await finish(80, 500);
    const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
    return `Scrolled ${dir}; position ${Math.round(sc.scrollTop)}/${max}${sc.scrollTop >= max - 2 ? ' (at bottom)' : ''}` + diff;
  }

  async function hover(t = {}) {
    const a = aim(t);
    begin();
    for (const ty of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) mouse(a.el, ty, a.lx, a.ly, { bubbles: !ty.endsWith('enter') });
    return `Hovered ${a.desc}` + await finish();
  }

  async function selectOption(t = {}) {
    const el = resolve(t);
    if (!el || tag(el) !== 'select') throw new Error('select_option needs a <select> ref — for custom dropdowns, click them instead');
    focusTarget(el);
    begin();
    const want = String(t.value).toLowerCase().trim();
    const opt = [...el.options].find((o) => o.value.toLowerCase() === want || clean(o.text).toLowerCase() === want)
      || [...el.options].find((o) => clean(o.text).toLowerCase().includes(want));
    if (!opt) throw new Error(`No option "${t.value}". Options: ${[...el.options].map((o) => clean(o.text)).join(' | ')}`);
    el.value = opt.value;
    opt.selected = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return `Selected "${clean(opt.text)}" in ${describe(el)}` + await finish();
  }

  function text({ maxChars = 15000, selector } = {}) {
    let root = selector ? document.querySelector(selector) : null;
    if (selector && !root) throw new Error(`No element matches ${selector}`);
    root ||= document.body;
    let t = (root.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const total = t.length;
    if (t.length > maxChars) t = t.slice(0, maxChars) + `\n… (${total - maxChars} more chars; pass a selector or larger max_chars)`;
    return `${document.title} — ${location.href}\n\n${t}`;
  }

  async function waitFor({ text: txt, selector, timeout = 5000 } = {}) {
    const test = () => (selector ? !!document.querySelector(selector) : (document.body.innerText || '').toLowerCase().includes(String(txt).toLowerCase()));
    if (test()) return `Found ${selector || `"${txt}"`}`;
    return new Promise((res) => {
      const mo = new MutationObserver(() => { if (test()) finish(true); });
      const timer = setTimeout(() => finish(false), Math.min(timeout, 20000));
      function finish(ok) { mo.disconnect(); clearTimeout(timer); res(ok ? `Found ${selector || `"${txt}"`}` : `Timed out waiting for ${selector || `"${txt}"`}`); }
      mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    });
  }

  function viewport() {
    return { w: innerWidth, h: innerHeight, dpr: devicePixelRatio };
  }

  // ── Screenshot labels: a ref tag on every clickable element in view ──
  function markable(max = 90) {
    const out = [], t0 = performance.now();
    let n = 0;
    for (const el of elements(document.body || document.documentElement)) {
      if ((++n & 255) === 0 && performance.now() - t0 > 80) break;
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
        if (legend.length + l.length > 4500) { legend += '\n…'; break; }
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
    snapshot, find, click, point, type, key, keyPrep, scroll, hover, selectOption, drag, dragPoints,
    prepField: (t) => { const { cleared, desc } = prepField(t); return { cleared, desc }; },
    text, waitFor, viewport, begin, settle: () => finish(),
    capturePrep, captureDone,
    overlay: (on, label) => fx.show(on, label),
  };
})();
