// ASCII field behind the panel. Each cell's brightness is slow drifting noise,
// plus a soft lens under the pointer, plus ripples sent from UI events
// (`field.at(el, 'step')`). One ink colour; brightness only moves the glyph
// along the ramp and its opacity, so the whole thing stays grey on grey.

const RAMP = ' .:-=+*#%@';
const FONT_PX = 11;
const CELL_H = 14;
const LENS_R = 110;

// speed px/s, w ring half-width px, amp crest height, life s, ring how many
// wavelengths trail the crest (higher = tighter, more rings).
const KINDS = {
  key:   { speed: 230, w: 10, amp: .2,  life: .9,  ring: 1 },
  tap:   { speed: 330, w: 20, amp: .42, life: 1.7, ring: 1 },
  pulse: { speed: 170, w: 26, amp: .16, life: 2.4, ring: .8 },
  step:  { speed: 300, w: 18, amp: .32, life: 1.6, ring: 1 },
  ok:    { speed: 240, w: 12, amp: .22, life: 1.2, ring: 1 },
  fail:  { speed: 420, w: 7,  amp: .55, life: 1.1, ring: 1.8 },
  send:  { speed: 520, w: 34, amp: .62, life: 2.6, ring: 1 },
  done:  { speed: 360, w: 56, amp: .42, life: 3.4, ring: .7 },
};
const MAX_RIPPLES = 28;
// Seconds between the ambient pulses from whatever the agent is working on, by phase.
const PULSE_EVERY = { wait: 1.8, think: 2.4, write: 1.2, plan: 1.4, act: .9 };

const reduce = matchMedia('(prefers-reduced-motion: reduce)');
const scheme = matchMedia('(prefers-color-scheme: dark)');

const cv = document.createElement('canvas');
cv.className = 'ascii-field';
cv.setAttribute('aria-hidden', 'true');
document.body.prepend(cv);
const ctx = cv.getContext('2d');

let W = 0, H = 0, dpr = 1, cw = 8, cols = 0, rows = 0, atlas = null, gain = 1;
let ripples = [];
const ptr = { x: -1e4, y: -1e4, a: 0, ta: 0 };
let raf = 0, lastDraw = 0, lastT = 0, tn = Math.random() * 100, nextPulse = 0;

// ── Value noise ──
const P = new Uint8Array(512);
{
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) P[i] = p[i & 255];
}
const fade = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const h3 = (x, y, z) => P[P[P[x & 255] + (y & 255)] + (z & 255)] / 255;
function noise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  return lerp(
    lerp(lerp(h3(xi, yi, zi), h3(xi + 1, yi, zi), u), lerp(h3(xi, yi + 1, zi), h3(xi + 1, yi + 1, zi), u), v),
    lerp(lerp(h3(xi, yi, zi + 1), h3(xi + 1, yi, zi + 1), u), lerp(h3(xi, yi + 1, zi + 1), h3(xi + 1, yi + 1, zi + 1), u), v),
    w);
}

function build() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const css = getComputedStyle(document.documentElement);
  const font = `${FONT_PX}px ${css.getPropertyValue('--mono')}`;
  ctx.font = font;
  cw = Math.round(ctx.measureText('M').width + 1.5);
  cols = Math.ceil(W / cw); rows = Math.ceil(H / CELL_H);

  // One glyph per ramp step, drawn once in the ink colour; frames copy from it.
  atlas = document.createElement('canvas');
  atlas.width = RAMP.length * cw * dpr; atlas.height = CELL_H * dpr;
  const a = atlas.getContext('2d');
  a.scale(dpr, dpr);
  a.font = font; a.textAlign = 'center'; a.textBaseline = 'middle';
  a.fillStyle = css.getPropertyValue('--field-ink').trim() || '#fff';
  gain = parseFloat(css.getPropertyValue('--field-gain')) || 1;
  [...RAMP].forEach((g, i) => a.fillText(g, i * cw + cw / 2, CELL_H / 2 + .5));
  draw(performance.now() / 1000, 0);
}

function draw(t, dt) {
  const running = document.body.classList.contains('running');
  tn += dt * (running ? 2.4 : 1);
  ripples = ripples.filter((r) => t - r.t0 < r.life);
  ptr.a += (ptr.ta - ptr.a) * Math.min(1, dt * 7 || 1);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const sw = cw * dpr, sh = CELL_H * dpr;
  const lift = running ? .03 : 0;
  const z = tn * .08;

  for (let r = 0; r < rows; r++) {
    const y = r * CELL_H + CELL_H / 2;
    for (let c = 0; c < cols; c++) {
      const x = c * cw + cw / 2;
      let n = .65 * noise(c * .07, r * .1, z) + .35 * noise(c * .16 + 40, r * .23, z * 1.7);
      n = Math.max(0, Math.min(1, (n - .3) / .5));
      let v = .05 + lift + .41 * n * n * (3 - 2 * n);

      if (ptr.a > .01) {
        const d = Math.hypot(x - ptr.x, y - ptr.y);
        if (d < LENS_R) { const k = 1 - d / LENS_R; v += .14 * k * k * ptr.a; }
      }
      for (let i = 0; i < ripples.length; i++) {
        const R = ripples[i];
        const age = t - R.t0;
        const d = Math.hypot(x - R.x, y - R.y);
        const u = d - age * R.speed;
        if (u > 3 * R.w || u < -3 * R.w) continue;
        const life = 1 - age / R.life;
        v += R.amp * life * life * Math.exp(-(u * u) / (R.w * R.w)) * Math.cos(u * R.ring * Math.PI / (R.w * 1.6)) / (1 + d / 420);
      }

      if (v < .1) continue;
      if (v > 1) v = 1;
      const g = Math.min(RAMP.length - 1, (v * RAMP.length) | 0);
      if (!g) continue;
      ctx.globalAlpha = (.035 + Math.pow(v, 1.4) * .41) * gain;
      ctx.drawImage(atlas, g * sw, 0, sw, sh, c * sw, r * sh, sw, sh);
    }
  }
  ctx.globalAlpha = 1;
}

// While the agent works, the thing it's working on breathes.
function anchor() {
  const md = document.querySelector('.md.streaming > :last-child');
  return document.querySelector('.step.running .sicon') || document.querySelector('.wait .orb')
    || document.querySelector('.think:not([data-done]) summary') || md;
}

function frame(now) {
  raf = requestAnimationFrame(frame);
  const running = document.body.classList.contains('running');
  const busy = running || ripples.length || ptr.a > .01 || ptr.ta;
  if (now - lastDraw < (busy ? 33 : 90)) return;
  const t = now / 1000;
  const dt = lastT ? Math.min(.1, t - lastT) : 0;
  lastDraw = now; lastT = t;
  if (running && t > nextPulse) {
    const p = document.body.dataset.phase;
    nextPulse = t + (PULSE_EVERY[p] || 1.6);
    field.at(anchor(), p === 'act' ? 'step' : 'pulse');
  }
  draw(t, dt);
}

function start() {
  cancelAnimationFrame(raf);
  raf = 0; lastT = 0;
  if (reduce.matches || document.hidden) return;
  raf = requestAnimationFrame(frame);
}

export const field = {
  ripple(x, y, kind = 'tap') {
    if (reduce.matches || document.hidden) return;
    if (ripples.length >= MAX_RIPPLES) ripples.shift();
    ripples.push({ x, y, t0: performance.now() / 1000, ...KINDS[kind] });
  },
  // Ripple from the centre of an element (or a DOMRect).
  at(target, kind) {
    const b = target?.getBoundingClientRect ? target.getBoundingClientRect() : target;
    if (!b || (!b.width && !b.height)) return;
    field.ripple(b.left + b.width / 2, b.top + b.height / 2, kind);
  },
};

addEventListener('pointermove', (e) => { ptr.x = e.clientX; ptr.y = e.clientY; ptr.ta = 1; }, { passive: true });
addEventListener('pointerdown', (e) => field.ripple(e.clientX, e.clientY, 'tap'), { passive: true });
document.documentElement.addEventListener('pointerleave', () => { ptr.ta = 0; });
addEventListener('blur', () => { ptr.ta = 0; });
addEventListener('resize', () => { build(); });
document.addEventListener('visibilitychange', start);
scheme.addEventListener('change', build);
reduce.addEventListener('change', () => { build(); start(); });

build();
start();
