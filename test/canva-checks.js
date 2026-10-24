// Checks for the Canva pack (sites/canva.js) against canva.html, a stand-in for
// Canva's editor. Serve this folder (python3 -m http.server), open
// /test/canva.html and run `await runCanvaChecks()` in the console. The page
// functions run in the page itself; clicks and keys are synthetic stand-ins
// for the DevTools input the extension sends.
globalThis.chrome = { tabs: { get: async () => ({ id: 1, url: 'https://www.canva.com/design/DAFAKE123/edit' }) } };
const { default: canva } = await import('../sites/canva.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = window.__tuff;
const api = {
  agent: { trusted: false, tabId: 1 },
  resolveTab: async () => 1,
  page: async (id, func, args = []) => func(...args),
  cs: async (id, method, ...args) => {
    if (method === 'quiet' || method === 'settle') { await sleep(30); return true; }
    return T[method](...args);
  },
  mouseEv: async () => {},
  click: async (id, x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    const ev = (t) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    ev('mousedown');
    (el.closest('input,button,[tabindex],[contenteditable]') || el).focus?.();
    ev('mouseup'); ev('click');
  },
  keys: async (id, keys) => {
    for (const k of TuffKeys.parse(keys)) {
      const a = document.activeElement || document.body;
      if ((k.meta || k.ctrl) && k.key.toLowerCase() === 'a') { if (a.select) a.select(); else document.execCommand('selectAll'); continue; }
      for (let i = 0; i < k.n; i++) {
        a.dispatchEvent(new KeyboardEvent('keydown', { key: k.key, bubbles: true, cancelable: true }));
        a.dispatchEvent(new KeyboardEvent('keyup', { key: k.key, bubbles: true }));
      }
    }
  },
  insertText: async (id, text) => { document.execCommand('insertText', false, text); },
  exec: async (name, a) => {
    if (name === 'type') return { text: await T.type(a) };
    throw new Error(`exec ${name} is not part of the stand-in`);
  },
  sameValue: (s, t, r) => TuffKeys.sameValue(s, t, r),
  downloadsSince: async () => [],
  fmtDownload: (d) => String(d.id),
};

// For poking at single steps from the console.
Object.assign(window, { canvaPack: canva, canvaApi: api });

window.runCanvaChecks = async () => {
  const out = [];
  const check = async (name, fn) => {
    try { const r = await fn(); out.push({ name, pass: r === true, detail: r === true ? '' : String(r?.detail ?? r) }); }
    catch (e) { out.push({ name, pass: false, detail: 'threw: ' + e.message }); }
  };
  const has = (s, ...parts) => {
    const miss = parts.filter((p) => !s.includes(p));
    return miss.length ? { detail: `missing ${JSON.stringify(miss)} in:\n${s}` } : true;
  };
  const run = (name, a = {}) => canva.exec(name, a, api).then((r) => r.text);
  const count = (s) => (s.match(/^\s+c\d+ /gm) || []).length;

  let read = '';
  await check('read: elements, layer names, fonts and background', async () => {
    read = await run('canva_read');
    return has(read, 'background #2b6cb0', 'circle "Shape": 200×200 at (840, 1110); fill #ffd166',
      'text "Harbor Lights Festival": 846×112 at (116, 172)', 'Roboto Condensed 72 bold, color #ffffff, align center',
      'shape "Shape": 980×230 at (50, 113); fill #ffffff; opacity 0.8', 'Position › Layers order');
  });
  await check('read: the screen-reader copy is not an element', () => count(read) === 3 || { detail: read });
  const idOf = (kind) => (read.match(new RegExp(`(c\\d+) ${kind} `)) || [])[1];
  await check('select: by id through Layers', async () => has(await run('canva_select', { id: idOf('circle') }), `Selected: ${idOf('circle')} circle`));
  await check('set: size, position, fill and opacity, read back', async () =>
    has(await run('canva_set', { id: idOf('shape'), x: 60, y: 120, w: 960, h: 240, fill: '#EEEEEE', opacity: 0.5 }), '960×240 at (60, 120); fill #eeeeee; opacity 0.5'));
  await check('set: font, size, bold, color and align of text', async () =>
    has(await run('canva_set', { id: idOf('text'), font: 'Roboto', size: 64, bold: false, color: '#000000', align: 'left' }), 'Roboto 64, color #000000, align left'));
  await check('set: a text box height is refused with the reason', async () => {
    try { return { detail: await run('canva_set', { id: idOf('text'), h: 300 }) }; }
    catch (e) { return has(e.message, 'height follows its text'); }
  });
  await check('arrange: to front, order read back', async () => has(await run('canva_arrange', { id: idOf('shape'), where: 'front' }), 'now 1 of 3'));
  await check('set: page background fill', async () => has(await run('canva_set', { id: 'background', fill: '#123456' }), 'Background is #123456'));
  await check('selection: a click result can say the page is selected', async () => has(await canva.selection(api, 1), 'page background (#123456)'));
  await check('rename: checked against the title', async () => has(await run('canva_rename', { title: 'Harbor Poster' }), 'Harbor Poster'));
  await check('add: a circle from Elements gets a new id', async () => has(await run('canva_add', { kind: 'shape:circle' }), 'circle', '324×324', 'fill #c8d1d9'));
  await check('add: a text box with its text', async () => has(await run('canva_add', { kind: 'text', text: 'Hello there' }), 'text "Hello there"'));
  await check('read: five elements after adding', async () => { const r = await run('canva_read', { fonts: false }); return count(r) === 5 || { detail: r }; });
  return out.sort((a, b) => a.pass - b.pass);
};
