# Branding and store images

Everything here is rendered from the real side panel (`sidepanel.html` with demo data) and the HTML layouts in [`src/`](src). The shops, listings and articles shown inside the browser window are made up.

## What to upload where

### Chrome Web Store

| Slot | File | Notes |
| --- | --- | --- |
| Store icon | `chrome-web-store/icon-128.png` | 96×96 artwork centred in 128×128, transparent padding |
| Screenshots (up to 5) | `chrome-web-store/dark/screenshot-{1..5}-1280x800.png` | Light versions in `light/`. 640×400 copies are next to each one |
| Small promo tile (required) | `chrome-web-store/dark/promo-small-440x280.png` | |
| Marquee (optional) | `chrome-web-store/dark/promo-marquee-1400x560.png` | |

All store images are 24-bit PNG with no alpha, as the store asks. Pick one theme and use it for every slot; dark stands out more on the store's white page.

### Firefox Add-ons (AMO)

AMO takes the icon from the zip. Use the same `screenshot-*-1280x800.png` files; it accepts up to 10.

### Elsewhere

| Use | File |
| --- | --- |
| Link previews (Open Graph) | `social/og-1200x630-{dark,light}.png` |
| GitHub social preview | `social/github-1280x640-{dark,light}.png` (Settings › Social preview) |
| Logo mark | `logo/mark.svg`, `logo/mark-inverse.svg`, PNGs at 512 and 1024 |
| Wordmark | `logo/wordmark-light.png` (ink, for light backgrounds), `logo/wordmark-dark.png` (paper, for dark backgrounds) |
| Favicon | `logo/favicon.svg` (switches to the inverse mark in dark mode), `logo/favicon-32.png`, `logo/apple-touch-icon-180.png` |
| Panel screenshots | `panel/<scene>-{dark,light}.png` (380×562) and `panel/<scene>-tall-{dark,light}.png` (400×760), all at 2x |
| Browser window shots | `scenes/scene-{1..5}-{dark,light}.png`, transparent background, 2x |

The screenshot captions:

1. Describe a task, and TuffAgent does it in your browser.
2. See every step it took, how long it took and what it cost.
3. Your tabs, bookmarks, history and downloads are tools too.
4. Use Claude, GPT, Gemini or any of 300+ models.
5. No account, no servers, no analytics.

The mark in these files is drawn as filled shapes so the stem of the T doesn't poke above the bar at large sizes. The extension's own `icons/` and the `#i-mark` symbol in `sidepanel.html` still use the stroked version, which looks the same at toolbar size.

## Regenerating

You need Playwright and its Chromium:

```bash
npm i --no-save playwright && npx playwright install chromium
```

Then, from the repository root:

```bash
node branding/src/render.mjs
```

That renders the panel shots, then everything composed around them, then copies WebP versions into `site/assets/img/`. Pass `panels`, `compose` or `site` to run one stage, optionally followed by a filter (`node branding/src/render.mjs compose screenshot-2`).

| File | What it holds |
| --- | --- |
| `src/scenes.js` | Demo chats, models and tab info for each panel scene |
| `src/stub.js` | A stand-in for the `chrome.*` APIs, so the panel runs from a plain web server |
| `src/compose.html` | Layouts for store screenshots, tiles, social cards, icons, and the made-up web pages |
| `src/render.mjs` | Serves the repository, drives Chromium and writes the files |

Change a caption or scene in `compose.html` or `scenes.js` and re-run.
