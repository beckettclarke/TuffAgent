// Font Awesome icon for each tool step, picked from the tool and, where it
// changes what the step does, its arguments. Site packs answer for their own
// tools through `pack.icon(name, args)`.
import { normalize } from './tools.js';
import { packOf } from './sites/index.js';

export const fa = (name) => `<i class="fa-sharp fa-regular fa-${name}" aria-hidden="true"></i>`;

const KEY = [
  [/^(enter|return)$/i, 'arrow-turn-down-left'],
  [/^(escape|esc)$/i, 'xmark'],
  [/^tab$/i, 'arrow-right-to-line'],
  [/^(backspace|delete)$/i, 'delete-left'],
  [/^(arrow)?up$/i, 'arrow-up'],
  [/^(arrow)?down$/i, 'arrow-down'],
  [/^(arrow)?left$/i, 'arrow-left'],
  [/^(arrow)?right$/i, 'arrow-right'],
  [/^(page_?up|page_?down|home|end)$/i, 'arrows-up-down'],
  [/^space$/i, 'square-dashed'],
];

const SCROLL = { up: 'angles-up', down: 'angles-down', left: 'angles-left', right: 'angles-right', top: 'arrow-up-to-line', bottom: 'arrow-down-to-line' };
const NAV = { back: 'arrow-left', forward: 'arrow-right', reload: 'arrow-rotate-right' };
const BOOKMARK = { search: 'book-bookmark', recent: 'bookmark', tree: 'folder-tree', create: 'bookmark', remove: 'trash-can' };

function forKey(keys) {
  const k = String(keys || '').trim();
  if (/[+\s]/.test(k) && /(cmd|meta|ctrl|control|alt|option|shift)/i.test(k)) return 'command';
  return KEY.find(([re]) => re.test(k))?.[1] || 'keyboard-brightness';
}

export function toolIcon(name, a = {}) {
  [name, a] = normalize(name, a || {});
  switch (name) {
    case 'tabs_list': return 'browsers';
    case 'tab_open': return 'arrow-up-right-from-square';
    case 'tab_switch': return 'arrow-right-arrow-left';
    case 'tab_close': return 'rectangle-xmark';
    case 'tab_group': return a.ungroup ? 'object-ungroup' : 'object-group';
    case 'navigate': return NAV[String(a.url).toLowerCase()] || 'compass';
    case 'read_page': return a.mode === 'interactive' ? 'list-radio' : 'file-lines';
    case 'get_text': return a.query ? 'text-size' : 'paragraph';
    case 'find': return 'magnifying-glass';
    case 'click': return a.x != null && !(a.ref || a.target) ? 'crosshairs' : a.clicks > 1 ? 'computer-mouse' : 'arrow-pointer';
    case 'type': return a.submit ? 'paper-plane' : 'keyboard';
    case 'key': return forKey(a.keys);
    case 'paste': return a.html || a.markdown ? 'clipboard-list' : 'paste';
    case 'menu': return 'bars-staggered';
    case 'drag': return a.dx != null || a.dy != null ? 'sliders-simple' : 'arrows-up-down-left-right';
    case 'scroll': return (a.ref || a.target) && !a.direction ? 'arrows-to-eye' : SCROLL[a.direction] || SCROLL.down;
    case 'hover': return 'hand-pointer';
    case 'select_option': return 'square-caret-down';
    case 'screenshot': return a.labels ? 'camera-viewfinder' : 'camera';
    case 'run_js': return 'code';
    case 'bookmarks': return BOOKMARK[a.action] || 'bookmark';
    case 'downloads': return 'download';
    case 'history_search': return 'clock-rotate-left';
    case 'checklist': return a.failed ? 'square-xmark' : a.done ? 'square-check' : a.note ? 'note-sticky' : 'list-check';
    case 'wait': return a.gone ? 'hourglass-end' : a.text || a.selector ? 'hourglass-half' : 'hourglass-start';
    default: return packOf(name)?.icon?.(name, a) || 'terminal';
  }
}
