# TuffAgent website

A static site with no build step: plain HTML, one stylesheet and one small script. It follows the system light or dark setting, like the panel.

| Page | File |
| --- | --- |
| Home | `index.html` |
| Features | `features.html` |
| Site packs | `site-packs.html` |
| Models and cost | `models.html` |
| Get started | `install.html` |
| FAQ | `faq.html` |
| Changelog | `changelog.html` |
| Privacy policy | `privacy.html` |
| Terms of use | `terms.html` |
| Not found | `404.html` |

## Before publishing

1. **Store links.** Every "Add to Chrome" and "Add to Firefox" button points at a placeholder. Replace these two strings across all pages once the listings are live:

   ```
   https://chromewebstore.google.com/detail/tuffagent/CHROME_EXTENSION_ID
   https://addons.mozilla.org/firefox/addon/FIREFOX_ADDON_SLUG/
   ```

   The buttons also carry `data-store="chrome"` and `data-store="firefox"`, so they're easy to find.

2. **Link previews.** `og:image` is a relative path (`assets/img/og-dark.png`). Most social sites need an absolute URL, so change it to the full address once you know the domain.

3. **Terms of use.** The terms are a plain-language starting point, not legal advice. Have them reviewed, and add a governing-law clause for your jurisdiction if you want one. The repository has no `LICENSE` file yet; the terms point at "the license in that repository".

4. **Privacy policy URL.** Once the site is live, the store listings can use `privacy.html` here in place of the GitHub link in `STORE.md`.

## Previewing

```bash
python3 -m http.server 4317 -d site
```

Then open <http://localhost:4317>.

## Hosting

Any static host works. For GitHub Pages, publish the `site` folder with a Pages workflow (Pages can only serve the repository root or `/docs` directly). `404.html` is picked up automatically on GitHub Pages and Netlify.

## Editing

The header and footer are repeated in each page, so a nav change means editing every file. Screenshots in `assets/img/` come from `branding/`; see `branding/README.md` to regenerate them.
