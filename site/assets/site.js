// Small enhancements; every page works without this file.

// Mobile menu
const header = document.querySelector('.top');
const menuBtn = document.querySelector('.menu-btn');
if (header && menuBtn) {
  menuBtn.addEventListener('click', () => {
    const open = header.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && header.classList.contains('open')) { header.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false'); menuBtn.focus(); }
  });
}

// ASCII fields: the same dashes and pluses as the side panel's backdrop.
// <div class="field" data-field="seed"></div> inside a positioned element.
function ascii(cols, rows, seed) {
  let s = seed || 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const G = 9, gx = Math.ceil(cols / G) + 2, gy = Math.ceil(rows / 4) + 2;
  const grid = Array.from({ length: gx * gy }, rnd);
  const at = (x, y) => grid[y * gx + x];
  const sm = (t) => t * t * (3 - 2 * t);
  let out = '';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const fx = x / G, fy = y / 4, ix = Math.floor(fx), iy = Math.floor(fy), tx = sm(fx - ix), ty = sm(fy - iy);
      const a = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * tx;
      const b = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * tx;
      const n = a + (b - a) * ty;
      out += n > .8 ? '+' : n > .68 ? '=' : n > .54 ? '-' : n > .47 ? '·' : ' ';
    }
    out += '\n';
  }
  return out;
}
const fields = [...document.querySelectorAll('[data-field]')];
function paintFields() {
  for (const f of fields) {
    const pre = f.querySelector('pre') || f.appendChild(document.createElement('pre'));
    const cs = getComputedStyle(pre);
    const cw = parseFloat(cs.fontSize) * 0.6, lh = parseFloat(cs.lineHeight);
    const text = ascii(Math.ceil(f.clientWidth / cw) + 1, Math.ceil(f.clientHeight / lh) + 1, +f.dataset.field || 7);
    pre.textContent = text;
    pre.setAttribute('aria-hidden', 'true');
    // A brighter copy under the pointer, like the lens in the panel.
    if (f.hasAttribute('data-lens')) {
      const hot = f.querySelector('pre.hot') || f.appendChild(Object.assign(document.createElement('pre'), { className: 'hot' }));
      hot.textContent = text;
      hot.setAttribute('aria-hidden', 'true');
    }
  }
}
if (fields.length) {
  paintFields();
  let t;
  addEventListener('resize', () => { clearTimeout(t); t = setTimeout(paintFields, 150); });
  if (matchMedia('(hover: hover)').matches) {
    addEventListener('pointermove', (e) => {
      for (const f of fields) {
        if (!f.hasAttribute('data-lens')) continue;
        const r = f.getBoundingClientRect();
        f.style.setProperty('--mx', `${e.clientX - r.left}px`);
        f.style.setProperty('--my', `${e.clientY - r.top}px`);
      }
    }, { passive: true });
  }
}

// Tabs (Chrome / Firefox instructions)
for (const list of document.querySelectorAll('[role="tablist"]')) {
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  const select = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    }
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      const next = tabs[(i + d + tabs.length) % tabs.length];
      select(next);
      next.focus();
    });
  });
  // Open on the reader's browser.
  if (/firefox/i.test(navigator.userAgent)) { const ff = tabs.find((t) => t.dataset.browser === 'firefox'); if (ff) select(ff); }
}
