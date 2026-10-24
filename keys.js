// Key-sequence parsing shared by the page runtime (synthetic events) and the
// panel (DevTools input). Classic script: loaded as a content script and as a
// side-effect import, so it only sets a global.
globalThis.TuffKeys ??= (() => {
  const NAMED = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    Home: 36, End: 35, PageUp: 33, PageDown: 34, Insert: 45, CapsLock: 20, Shift: 16, Control: 17, Alt: 18, Meta: 91, ContextMenu: 93 };
  for (let i = 1; i <= 12; i++) NAMED['F' + i] = 111 + i;
  const CODE = { Shift: 'ShiftLeft', Control: 'ControlLeft', Alt: 'AltLeft', Meta: 'MetaLeft' };
  const ALIAS = { esc: 'Escape', return: 'Enter', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', del: 'Delete',
    space: ' ', spacebar: ' ', period: '.', dot: '.', fullstop: '.', comma: ',', minus: '-', dash: '-', hyphen: '-', plus: '+', equals: '=',
    slash: '/', backslash: '\\', semicolon: ';', colon: ':', quote: "'", apostrophe: "'", backquote: '`', pgup: 'PageUp', pgdn: 'PageDown',
    ctrl: 'Control', cmd: 'Meta', command: 'Meta', option: 'Alt', win: 'Meta' };
  const CANON = new Map(Object.keys(NAMED).map((k) => [k.toLowerCase(), k]));
  for (const [a, k] of Object.entries(ALIAS)) CANON.set(a, k);

  // US layout: shifted character → its unshifted key, and punctuation key codes.
  const SHIFTED = { '~': '`', '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
    _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/' };
  const UNSHIFT = Object.fromEntries(Object.entries(SHIFTED).map(([s, b]) => [b, s]));
  const PUNCT = { '`': [192, 'Backquote'], '-': [189, 'Minus'], '=': [187, 'Equal'], '[': [219, 'BracketLeft'], ']': [221, 'BracketRight'],
    '\\': [220, 'Backslash'], ';': [186, 'Semicolon'], "'": [222, 'Quote'], ',': [188, 'Comma'], '.': [190, 'Period'], '/': [191, 'Slash'],
    ' ': [32, 'Space'] };

  // Physical key for one printable character; keyCode 0 if there is none (é, —, emoji).
  function charKey(ch) {
    const base = SHIFTED[ch] || ch.toLowerCase();
    const shift = !!SHIFTED[ch] || ch !== ch.toLowerCase();
    if (/^[a-z]$/.test(base)) return { keyCode: base.toUpperCase().charCodeAt(0), code: 'Key' + base.toUpperCase(), shift };
    if (/^\d$/.test(base)) return { keyCode: base.charCodeAt(0), code: 'Digit' + base, shift };
    const p = PUNCT[base];
    return p ? { keyCode: p[0], code: p[1], shift } : { keyCode: 0, code: '', shift: false };
  }

  /**
   * "Meta+a Shift+ArrowRight*5 Enter" → [{ key, keyCode, code, ctrl, meta, alt, shift, n }].
   * A word that isn't a key name ("Hello") comes back as { text } to be typed literally.
   */
  function parse(seq) {
    const out = [];
    for (let tok of String(seq || '').split(/\s+/).filter(Boolean)) {
      let n = 1;
      const rep = tok.length > 2 && tok.match(/^(.+?)\*(\d{1,3})$/);
      if (rep) { tok = rep[1]; n = Math.max(1, Math.min(+rep[2], 200)); }
      const parts = tok === '+' ? ['+'] : tok.endsWith('++') ? [...tok.slice(0, -2).split('+'), '+'] : tok.split('+').filter(Boolean);
      const last = parts.pop() || tok;
      const key = last.length === 1 ? last : CANON.get(last.toLowerCase());
      if (!key) { out.push({ text: tok.repeat(n) }); continue; }
      const k = { key, ctrl: false, meta: false, alt: false, shift: false, n };
      for (const m of parts.map((p) => CANON.get(p.toLowerCase()) || p)) {
        if (m === 'Control') k.ctrl = true;
        else if (m === 'Meta') k.meta = true;
        else if (m === 'Alt') k.alt = true;
        else if (m === 'Shift') k.shift = true;
      }
      if (key.length === 1) {
        // Shift+1 types "!", Shift+a types "A" (shortcuts with Ctrl/Meta keep the base key).
        if (k.shift && !k.ctrl && !k.meta) k.key = UNSHIFT[key] || key.toUpperCase();
        const c = charKey(k.key);
        k.keyCode = c.keyCode; k.code = c.code; k.shift ||= c.shift;
      } else {
        k.keyCode = NAMED[key] || 0; k.code = CODE[key] || key;
      }
      out.push(k);
    }
    return out;
  }

  return { parse, charKey };
})();
