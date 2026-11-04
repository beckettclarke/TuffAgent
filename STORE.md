# Store submission kit

Everything needed to submit TuffAgent to the Chrome Web Store and addons.mozilla.org (AMO): the uploads, the listing copy, permission justifications, the privacy answers, and the review risks to expect.

## 1. Build the uploads

```bash
node scripts/pack.mjs
```

This writes `dist/tuffagent-<version>-chrome.zip` and `dist/tuffagent-<version>-firefox.zip`. Each has the source as-is (no bundling or minifying, so AMO doesn't need a separate source upload) and a manifest trimmed for its browser:

| | Chrome zip | Firefox zip |
| --- | --- | --- |
| Removed keys | `browser_specific_settings`, `sidebar_action`, `background.scripts` | `side_panel`, `minimum_chrome_version`, `background.service_worker` |
| Removed permissions | none | `sidePanel`, `debugger` (Firefox has neither; the code checks before using them) |

Bump `version` in `manifest.json` before each upload. Both stores reject a version they've already seen.

## 2. Listing copy

**Name:** TuffAgent

**Summary** (Chrome: 132 characters max; AMO: 250):

> A fast browser agent in your sidebar. It reads pages, clicks, types and works your tabs, with any model on OpenRouter.

**Category:** Chrome: Productivity › Tools. AMO: Other (or Tabs).

**Description:**

> TuffAgent is a browser agent that lives in your sidebar. Tell it what to do in plain words and it does the clicking, typing and tab-juggling for you: fill out forms, compare products across tabs, summarize a page, clean up your tabs into groups, pull a table into a list, or work through a long multi-step task while you watch.
>
> BRING ANY MODEL
> Connect one OpenRouter key and pick from 300+ models: Claude, GPT, Gemini, Grok, Qwen, Kimi and more. Switch models from the composer at any time.
>
> SEES PAGES LIKE YOU DO
> TuffAgent reads pages in order, finds buttons by their labels, works inside pop-ups, frames and shadow DOM, and checks that every action actually did something.
>
> FAST
> Tools start while the model is still writing, independent steps run in parallel, and prompts are cached, so tasks finish in fewer, quicker rounds.
>
> YOU STAY IN CONTROL
> A frame and cursor show which page the agent is working on and what it's doing. Press Esc to stop at any time. It asks before purchases, sending messages, or deleting things.
>
> PRIVATE BY DESIGN
> No account, no servers, no analytics. Your key and chats stay in your browser. Page content goes only to the model you chose, and only while a task is running.
>
> Works in Chrome 121+ and Firefox 128+. Requires an OpenRouter account (openrouter.ai); you pay OpenRouter directly for what you use.

**Homepage:** https://github.com/beckettclarke/TuffAgent
**Support:** https://github.com/beckettclarke/TuffAgent/issues
**Privacy policy URL:** https://github.com/beckettclarke/TuffAgent/blob/main/PRIVACY.md

## 3. Images still needed

| Asset | Chrome Web Store | AMO |
| --- | --- | --- |
| Icon | 128×128 PNG (in the zip already; the store prefers ~96×96 artwork centred with transparent padding) | Taken from the zip |
| Screenshots | 1–5 at 1280×800 or 640×400 | Up to 10, any size, 1280×800 recommended |
| Small promo tile | 440×280, **required** | — |
| Marquee | 1400×560, optional | — |

The panel shots in `.github/assets/` are a good starting point, but need re-cropping to these sizes.

## 4. Single purpose (Chrome)

> TuffAgent is an AI browser assistant: it carries out tasks the user types in the side panel by reading and operating web pages, tabs, bookmarks and history on the user's behalf.

## 5. Permission justifications

Paste these into the Chrome developer dashboard's Privacy tab. AMO reviewers read the same reasoning from the listing's notes to reviewer.

| Permission | Justification |
| --- | --- |
| `sidePanel` | The whole UI is a side panel, so the agent can work on the page next to it. |
| `tabs` | Read tab titles and URLs and open, switch and close tabs when a task needs it ("open the top 3 results"). |
| `tabGroups` | Group and name tabs when the user asks the agent to organize them. |
| `bookmarks` | Search, read and create bookmarks when the user's task involves them. |
| `history` | Search browsing history when the user's task asks for it ("find the article I read yesterday about…"). |
| `scripting` | Inject the page runtime that reads page content and performs clicks, typing and scrolling for the user's task. |
| `storage`, `unlimitedStorage` | Keep settings and chat history (including screenshots) on the device. Long agent logs exceed the default quota. |
| `webNavigation` | Know when a navigation the agent triggered has finished loading, and follow single-page-app route changes, before taking the next step. |
| `webRequest` | Wait for network requests an action started (search results, form posts) to finish before reading the page. Observation only; no requests are blocked or changed. |
| `debugger` | Send real mouse and keyboard input through the DevTools protocol on sites that ignore synthetic events, answer page dialogs that would otherwise freeze the task, and drive Google Docs and Canva. Attached only to the tab the agent is working on, only during a task, and can be turned off in Settings › Trusted input. |
| `downloads` | List recent downloads so the agent can confirm a file it was asked to download arrived (and didn't download twice). |
| Host permission `<all_urls>` | The user can ask the agent to work on any site, so it needs to read and act on whichever page is open. It only touches pages while a task is running. |
| Optional `clipboardRead`, `clipboardWrite` (Firefox) | Fallback for pasting formatted text into editors that ignore paste events. Requested once, at the user's first message. |

**Remote code:** No. All extension code is in the package. (See the `run_js` note under review risks.)

## 6. Data usage answers (Chrome Privacy tab)

Data **collected** (sent off the device), all only while a task the user started is running, and only to OpenRouter and the model provider the user picked:

- [x] Website content (page text, screenshots)
- [x] Web history (only when a task searches history)
- [x] User activity (the user's requests to the agent)
- [ ] Personally identifiable information, health, financial, authentication, personal communications, location: not collected. The OpenRouter key is stored locally and sent only to OpenRouter to authenticate the user's own requests.

Certify all three:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**AMO:** `manifest.json` already declares `data_collection_permissions` (`websiteContent`, `browsingActivity`) under `browser_specific_settings.gecko`, which Firefox shows to users at install.

## 7. Review risks

These are the things most likely to slow review or draw questions. None needs changing to submit, but it helps to know about them.

1. **`debugger` and `<all_urls>`** put the Chrome submission into in-depth review (days to a few weeks). The justifications above are written for it. If it's rejected over `debugger`, the fallback is to move it to `optional_permissions` and request it when the user turns on Trusted input.
2. **`run_js` evaluates model-written JavaScript in the page** (`tools.js`, `new Function` in the page's main world, or `Runtime.evaluate` through the debugger). It runs in the web page, not in the extension, and never with extension privileges, but reviewers on both stores may read it as executing remote code. AMO's linter flags it as `DANGEROUS_EVAL`. If a reviewer objects, the low-effort fix is a settings switch that removes `run_js` from the tool list, defaulting to off for store builds. In the AMO notes to reviewer, explain that the code is generated per task by the user's chosen model to read or act on the current page, and that it's equivalent to the user running it in DevTools.
3. **AMO `innerHTML` warnings** (`UNSAFE_VAR_ASSIGNMENT`, ~17). The values passed in are escaped (`esc()`) or come from the extension's own markdown renderer, but AMO reviewers check each one by hand. Expect questions, not rejection.
4. **Icon stylesheet is remote** (`beckettclarke.ca/css/fontawesome.css`). Stylesheets aren't code, so neither store forbids it, but icons disappear offline. Font Awesome Pro's license doesn't allow putting its files in a public package, so switching to bundled icons would mean a free icon set.
5. **Firefox minimum version.** `strict_min_version` is 128, but tab groups need 138, and `data_collection_permissions` is only read from 140. The linter notes both; neither blocks submission. Raising it to `140.0` silences them.

## 8. Lint before submitting

```bash
node scripts/pack.mjs firefox
mkdir -p /tmp/tuff-ff && unzip -oq dist/tuffagent-*-firefox.zip -d /tmp/tuff-ff
npx web-ext lint --source-dir /tmp/tuff-ff
```

At v1.6.0 this reports 0 errors; the warnings are the ones listed above.
