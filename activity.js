// What the agent is doing right now. A strip at the top of the composer shows
// an ASCII meter whose pattern follows the phase, the phase's (or the tool's)
// icon and label, and how long the phase has run. The phase is also mirrored to
// the header status and to body[data-phase], which the composer ring and the
// field key off.
import { fa } from './icons.js';

const NAMES = { wait: 'Waiting', think: 'Thinking', write: 'Writing', plan: 'Planning', act: 'Acting' };
const ICONS = { wait: 'hourglass-half', think: 'brain', write: 'pen-nib', plan: 'route', act: 'bolt' };
const W = 12;
const BRAILLE = '⠁⠂⠄⡀⢀⠠⠐⠈⠃⠅⠘⠨⠰⡁⢁⠑⠡⠊⠌⡂⢂⠆⠰⠔';
const BARS = '▁▂▃▄▅▆▇█';
const cells = (f) => Array.from({ length: W }, (_, i) => f(i)).join('');

const METERS = {
  // A head sweeping back and forth.
  wait: (f) => {
    const p = W - 1 - Math.abs((f % (2 * W - 2)) - (W - 1));
    return cells((i) => ['█', '▓', '░'][Math.abs(i - p)] || '·');
  },
  // Sparse braille that never settles.
  think: (f) => cells((i) => (Math.random() < .55 + .45 * Math.sin(i * .7 + f * .35)
    ? BRAILLE[(Math.random() * BRAILLE.length) | 0] : ' ')),
  // A level meter rolling left to right.
  write: (f) => cells((i) => BARS[Math.round((Math.sin(f * .45 - i * .8) * .5 + .5) * (Math.random() * .3 + .7) * (BARS.length - 1))]),
  // Cells filling in as the call is written out.
  plan: (f) => { const n = f % (W + 4); return cells((i) => (i < n ? '▰' : '▱')); },
  // Hatching sliding right.
  act: (f) => cells((i) => ((i - f) % 4 + 4) % 4 < 2 ? '╱' : ' '),
};
const FPS = { wait: 14, think: 10, write: 14, plan: 9, act: 16 };

const $ = (s) => document.querySelector(s);
const reduce = matchMedia('(prefers-reduced-motion: reduce)');
let kind = '', key = '', t0 = 0, frame = 0, tick = 0;

function paint() {
  $('#actMeter').textContent = METERS[kind](reduce.matches ? 0 : frame++);
  const s = (performance.now() - t0) / 1000;
  $('#actTime').textContent = s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;
}

export const activity = {
  // kind: wait | think | write | plan | act. label replaces the phase name;
  // iconHtml replaces the phase icon (a tool's own icon while it runs).
  set(next, label = '', iconHtml = '') {
    const k = `${next}|${label}|${iconHtml}`;
    if (k === key) return;
    key = k;
    if (next !== kind) { t0 = performance.now(); frame = 0; }
    kind = next;
    document.body.dataset.phase = kind;
    $('#status').textContent = NAMES[kind];
    $('#actLabel').textContent = label || NAMES[kind];
    $('#actIcon').innerHTML = iconHtml || fa(ICONS[kind]);
    clearInterval(tick);
    paint();
    if (!reduce.matches) tick = setInterval(paint, 1000 / FPS[kind]);
  },
  stop() {
    clearInterval(tick);
    kind = key = '';
    delete document.body.dataset.phase;
    $('#status').textContent = 'idle';
  },
};
