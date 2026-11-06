// Renders the branding images: real side-panel screenshots (the actual
// sidepanel.html with demo data from scenes.js), then the store images,
// social cards and icons built from compose.html around them.
//
// Needs Playwright with a Chromium build:
//   npm i --no-save playwright && npx playwright install chromium
//   node branding/src/render.mjs            everything
//   node branding/src/render.mjs panels     just the panel shots
//   node branding/src/render.mjs compose    just the composed images
// Set CHROME=/path/to/chrome to use a browser other than Playwright's.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const out = join(root, 'branding');
const site = join(root, 'site', 'assets', 'img');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const init = (await readFile(join(here, 'scenes.js'), 'utf8')) + '\n' + (await readFile(join(here, 'stub.js'), 'utf8'));
const THEMES = ['dark', 'light'];
const what = process.argv[2] || 'all';

// ── Panel screenshots ──
// name: [scene, width, height]. Sizes are CSS px; output is 2x.
const PANELS = {
  live: ['live', 380, 562], shop: ['shop', 380, 562], rentals: ['rentals', 380, 562], tabs: ['tabs', 380, 562],
  picker: ['picker', 380, 562], settings: ['settings', 380, 562], docs: ['docs', 380, 562],
  'live-tall': ['live', 400, 760], 'shop-tall': ['shop', 400, 760], 'rentals-tall': ['rentals', 400, 760],
  'tabs-tall': ['tabs', 400, 760], 'docs-tall': ['docs', 400, 760], 'picker-tall': ['picker', 400, 760],
  'settings-tall': ['settings', 400, 760], 'history-tall': ['history', 400, 760], 'empty-tall': ['empty', 400, 760],
  'onboard-tall': ['onboard', 400, 760],
};

async function panel(name, [scene, w, h], theme) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' });
  await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.warn(`  [${name}/${theme}] ${e.message}`));
  await page.goto(`${origin}/sidepanel.html?scene=${scene}&theme=${theme}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.evaluate((s) => globalThis.__TUFF_SCENES[s].after?.(), scene);
  // Sheets slide in; let them land, and let the ASCII field settle.
  await page.waitForTimeout(900);
  const file = join(out, 'panel', `${name}-${theme}.png`);
  await page.screenshot({ path: file });
  await ctx.close();
  return file;
}

if (what === 'all' || what === 'panels') {
  await mkdir(join(out, 'panel'), { recursive: true });
  const only = process.argv[3];
  for (const [name, spec] of Object.entries(PANELS)) {
    if (only && !name.startsWith(only)) continue;
    for (const theme of THEMES) await panel(name, spec, theme);
    console.log('panel   ', name);
  }
}

// ── Composed images (store screenshots, promo tiles, social cards, icons) ──
// [output path relative to branding/, compose.html query, width, height, scale]
const SHOTS = [1, 2, 3, 4, 5];
const COMPOSE = [
  ...THEMES.flatMap((t) => [
    ...SHOTS.map((n) => [`chrome-web-store/${t}/screenshot-${n}-1280x800.png`, `shot=${n}&theme=${t}`, 1280, 800, 1]),
    ...SHOTS.map((n) => [`chrome-web-store/${t}/screenshot-${n}-640x400.png`, `shot=${n}&theme=${t}`, 1280, 800, 0.5]),
    [`chrome-web-store/${t}/promo-small-440x280.png`, `tile=small&theme=${t}`, 440, 280, 1],
    [`chrome-web-store/${t}/promo-marquee-1400x560.png`, `tile=marquee&theme=${t}`, 1400, 560, 1],
    [`social/og-1200x630-${t}.png`, `tile=og&theme=${t}`, 1200, 630, 1],
    [`social/github-1280x640-${t}.png`, `tile=github&theme=${t}`, 1280, 640, 1],
  ]),
  ['chrome-web-store/icon-128.png', 'icon=store', 128, 128, 1],
  ['logo/mark-1024.png', 'icon=mark', 1024, 1024, 1],
  ['logo/mark-512.png', 'icon=mark', 512, 512, 1],
  ['logo/mark-inverse-512.png', 'icon=mark-inverse', 512, 512, 1],
  ['logo/wordmark-dark.png', 'icon=wordmark&theme=dark', 960, 200, 1],
  ['logo/wordmark-light.png', 'icon=wordmark&theme=light', 960, 200, 1],
  ['logo/apple-touch-icon-180.png', 'icon=touch', 180, 180, 1],
  ['logo/favicon-32.png', 'icon=mark', 32, 32, 1],
  // Window-only scenes for the website, at 2x.
  ...THEMES.flatMap((t) => [1, 2, 3, 4, 5].map((n) => [`scenes/scene-${n}-${t}.png`, `scene=${n}&theme=${t}`, 1152, 640, 2])),
];

async function compose([file, query, w, h, scale]) {
  const transparent = /icon=(store|mark|touch|mark-inverse)/.test(query) || query.startsWith('scene=');
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale, colorScheme: query.includes('light') ? 'light' : 'dark' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.warn(`  [${file}] ${e.message}`));
  await page.goto(`${origin}/branding/src/compose.html?${query}&w=${w}&h=${h}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  const path = join(out, file);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, omitBackground: transparent });
  await ctx.close();
  console.log('compose ', file);
}

if (what === 'all' || what === 'compose') {
  const only = process.argv[3];
  for (const c of COMPOSE) if (!only || c[0].includes(only)) await compose(c);
}

// ── Copies the website uses ──
// Screenshots go to the site as WebP (encoded by the browser), the rest as-is.
if (what === 'all' || what === 'site') {
  await mkdir(site, { recursive: true });
  const webp = [
    ...THEMES.flatMap((t) => [
      ...['live', 'shop', 'rentals', 'tabs', 'docs', 'picker', 'settings', 'history', 'empty', 'onboard']
        .map((n) => [`panel/${n}-tall-${t}.png`, `panel-${n}-${t}.webp`]),
      ...[1, 2, 3, 4, 5].map((n) => [`scenes/scene-${n}-${t}.png`, `scene-${n}-${t}.webp`]),
    ]),
  ];
  const copies = [
    ...THEMES.map((t) => [`social/og-1200x630-${t}.png`, `og-${t}.png`]),
    ['logo/apple-touch-icon-180.png', 'apple-touch-icon.png'],
    ['logo/favicon-32.png', 'favicon-32.png'],
  ];
  const page = await browser.newPage();
  await page.goto(`${origin}/branding/src/compose.html?icon=none`);
  for (const [from, to] of webp) {
    const data = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = Object.assign(document.createElement('canvas'), { width: img.naturalWidth, height: img.naturalHeight });
      c.getContext('2d').drawImage(img, 0, 0);
      return c.toDataURL('image/webp', 0.88).split(',')[1];
    }, `/branding/${from}`);
    await writeFile(join(site, to), Buffer.from(data, 'base64'));
  }
  await page.close();
  for (const [from, to] of copies) await copyFile(join(out, from), join(site, to)).catch((e) => console.warn('  copy', from, e.message));
  console.log('site     wrote', webp.length + copies.length, 'files');
}

await browser.close();
server.close();
