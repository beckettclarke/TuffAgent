// Markdown → plain HTML for pasting into rich editors (Google Docs, Notion,
// Gmail). Unlike md.js (the panel renderer) it keeps raw HTML lines, so
// styled tables or aligned paragraphs can be mixed in. Extras: "||" (no space)
// merges a table cell into the one before it, ![alt](url =300x200) sizes an
// image, and a line "\pagebreak" becomes <!--pagebreak--> for callers to split on.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s) {
  const keep = [];
  const stash = (h) => `\u0000${keep.push(h) - 1}\u0000`;
  s = s.replace(/`([^`\n]+)`/g, (_, c) => stash(`<code>${esc(c)}</code>`));
  // Inline HTML tags pass through untouched.
  s = s.replace(/<\/?[a-z][^<>]*>/gi, (t) => stash(t));
  s = s.replace(/!\[([^\]]*)\]\((\S+?)(?:\s+"([^"]*)")?(?:\s+=(\d*)x(\d*))?\)/g, (_, alt, src, title, w, h) =>
    stash(`<img src="${esc(src)}" alt="${esc(alt)}"${title ? ` title="${esc(title)}"` : ''}${w ? ` width="${w}"` : ''}${h ? ` height="${h}"` : ''}>`));
  s = s.replace(/\[([^\]]+)\]\((\S+?)\)/g, (_, t, u) => stash(`<a href="${esc(u)}">`) + t + stash('</a>'));
  s = esc(s)
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_]+)__/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/==([^=]+)==/g, '<mark>$1</mark>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[i]);
}

// "| a || b |" → [{ text: 'a', span: 2 }, { text: 'b', span: 1 }]
function cells(row) {
  let r = row.trim();
  if (r.startsWith('|')) r = r.slice(1);
  if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
  const out = [];
  for (const part of r.split(/(?<!\\)\|/)) {
    if (part === '' && out.length) { out[out.length - 1].span++; continue; }
    out.push({ text: part.trim().replace(/\\\|/g, '|'), span: 1 });
  }
  return out;
}

const isTableSep = (l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && l.includes('|');
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function mdToHtml(src) {
  const lines = String(src ?? '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^\s*\\pagebreak\s*$/.test(l)) { out.push('<!--pagebreak-->'); i++; continue; }
    const fence = l.match(/^\s*```/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    // Raw HTML block: through the next blank line.
    if (/^\s*<(\/?[a-z][\w-]*|!--)/i.test(l)) {
      const buf = [];
      while (i < lines.length && lines[i].trim()) buf.push(lines[i++]);
      out.push(buf.join('\n'));
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${mdToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c.text) ? 'center' : /-:$/.test(c.text) ? 'right' : ''));
      const row = (r, tagName) => {
        let col = 0;
        return '<tr>' + cells(r).map((c) => {
          const a = align[col];
          col += c.span;
          const attrs = (c.span > 1 ? ` colspan="${c.span}"` : '') + (a ? ` style="text-align:${a}"` : '');
          return `<${tagName}${attrs}>${tagName === 'th' ? `<b>${inline(c.text)}</b>` : inline(c.text)}</${tagName}>`;
        }).join('') + '</tr>';
      };
      const body = [row(l, 'th')];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) body.push(row(lines[i++], 'td'));
      out.push(`<table border="1" style="border-collapse:collapse">${body.join('')}</table>`);
      continue;
    }
    if (LIST.test(l)) {
      // Nested lists by indentation.
      const stack = [];
      let html = '';
      while (i < lines.length && (LIST.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && stack.length))) {
        const m = lines[i].match(LIST);
        if (!m) { html += ' ' + inline(lines[i].trim()); i++; continue; }
        const ind = m[1].replace(/\t/g, '    ').length;
        const kind = /\d/.test(m[2]) ? 'ol' : 'ul';
        while (stack.length && ind < stack[stack.length - 1].ind) html += `</li></${stack.pop().kind}>`;
        let top = stack[stack.length - 1];
        // Same level, other list type ("- a" then "1. b"): start a new list.
        if (top && ind === top.ind && kind !== top.kind) { html += `</li></${stack.pop().kind}>`; top = stack[stack.length - 1]; }
        if (!top || ind > top.ind) { html += `<${kind}>`; stack.push({ ind, kind }); }
        else html += '</li>';
        const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
        html += `<li>${task ? (task[1] === ' ' ? '☐ ' : '☑ ') + inline(task[2]) : inline(m[3])}`;
        i++;
      }
      while (stack.length) html += `</li></${stack.pop().kind}>`;
      out.push(html);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*>|\s*<[a-z!])/i.test(lines[i]) && !LIST.test(lines[i]) &&
      !/^\s*\\pagebreak\s*$/.test(lines[i]) && !(lines[i].includes('|') && isTableSep(lines[i + 1] || ''))) buf.push(lines[i++]);
    out.push(`<p>${buf.map((b) => inline(b.trim())).join(b2br(buf))}</p>`);
  }
  return out.join('\n');
}
// Hard breaks: lines ending in two spaces or a backslash; otherwise soft-wrap with a space.
const b2br = (buf) => (buf.some((b) => / {2}$|\\$/.test(b)) ? '<br>' : ' ');

const BLOCK = /^(P|DIV|H[1-6]|LI|TR|TABLE|UL|OL|PRE|BLOCKQUOTE|HR|SECTION|ARTICLE|HEADER|FOOTER)$/;
// Plain-text flavor of an HTML fragment, for the clipboard's text/plain.
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  let s = '';
  const walk = (n) => {
    if (n.nodeType === 3) { s += n.nodeValue.replace(/\s+/g, ' '); return; }
    if (n.nodeType !== 1) return;
    const t = n.tagName;
    if (t === 'BR') { s += '\n'; return; }
    if (t === 'IMG') { s += n.getAttribute('alt') ? `[${n.getAttribute('alt')}]` : ''; return; }
    if (t === 'LI') s += (s && !s.endsWith('\n') ? '\n' : '') + '• ';
    for (const c of n.childNodes) walk(c);
    if (t === 'TD' || t === 'TH') s += '\t';
    else if (BLOCK.test(t)) s += '\n';
  };
  walk(doc.body);
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
