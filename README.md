# TuffAgent

A Chrome side-panel browser agent that works with any model through OpenRouter.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `TuffAgent` folder.
3. Click the toolbar icon (or press ⌘⇧Y) and paste your OpenRouter key.

## What it can do

Tabs (list, open, switch, close, group), navigation, page snapshots with element refs, find, click, drag, type, keys, paste (text, markdown or HTML), menu paths, scroll, hover, native selects, labeled screenshots (vision models), JavaScript in the page or any iframe, bookmarks (search, tree, create, remove), history search, and a requirements checklist for long tasks.

## Site packs

Some sites get extra tools. A pack's tools and prompt notes are only sent to the model once a matching page is open in the chat, so every other site keeps the lean core tool list. Once on, a pack stays on for the rest of that chat so the tool list (and the provider's prompt cache) doesn't change mid-task. Packs live in `sites/`; add one to `sites/index.js`.

**Google Docs** (`docs.google.com/document/...`):

- `gdocs_write` pastes markdown or HTML (inline font-family, font-size, color and background-color carry over) at the cursor, at the start or end, after or before a text match, or over a match. One call can hold a whole document body: headings, lists, links, bold and italic, tables with merged cells (`||` in markdown, or HTML colspan/rowspan) and colored cells, images by URL, and `\pagebreak` lines.
- `gdocs_select` finds text with Docs' find bar and selects it, or puts the cursor before or after it.
- `gdocs_format` sets, in one call, the paragraph style (Title, Subtitle, Heading 1–6, Normal), list type (numbered, bulleted, checklist), bold, italic, underline, font (any Google font; ones missing from the menu are added from More fonts), size, text color, highlight, alignment and links on a text match. Bold, italic and underline are set to the value you ask for, not toggled. Each call closes leftover menus and waits for the find bar to report the new match, so a batch of format calls can't land on the previous match.
- `gdocs_comment` adds a comment to a text match, replies to a thread and resolves it, checking each step on the comment card. `gdocs_mode` switches between editing, suggesting and viewing.
- `gdocs_rename` renames the document and checks the title took. `gdocs_equation` inserts an equation and types it with real keystrokes, paced so the equation box doesn't drop keys.
- `gdocs_command` runs any menu command by name through Docs' menu search (for example Merge cells, Equation, Page numbers, Name current version).
- `gdocs_read` returns the document's structure, read from Docs' own HTML export: page size and margins, each paragraph's style, alignment and inline formatting (every font and size run, not just the main one), tables with merged cells and colors, images, links, bookmarks, page breaks, header and footer, open comments with replies, plus the comment and suggestion cards on screen, save status and mode.

## Why it's fast

- The agent loop runs in the side panel itself, so there are no hops through the service worker.
- Streaming responses. Tool steps show up the moment the model names them.
- Several tool calls in one response run back to back.
- Actions wait for the DOM to go quiet (about 90ms), not a fixed delay. Navigations wait for DOMContentLoaded, not full load.
- Navigating, opening a tab, or a click that loads a new page returns the new page snapshot right away, which saves a model round trip.
- Tool calls start the moment their arguments finish streaming, so the browser works while the model is still writing the next call.
- Clicks, typing, keys and hovers report the elements that appeared on screen (menus, submenus, dialogs, suggestions) with refs, so the model chains through menus without re-reading the page.
- Screenshots tag every clickable element with its ref and add 100px edge rulers. The model clicks by ref instead of guessing coordinates.
- Text goes in with one `type` call. Without a ref it types at the caret, which is what rich editors like Google Docs need. `key` takes repeats (`Shift+ArrowRight*5`) and handles punctuation, shifted characters and macOS editing shortcuts (⌘A/C/V/X/Z).
- `paste` puts a whole formatted block in with one call. It sends a paste event first, which leaves your clipboard alone. If the page ignores that, it falls back to the real clipboard and ⌘V/Ctrl+V.
- `menu` clicks through menu, submenu and item by their visible labels in one call.
- A ref whose element was re-rendered (same role and name) is found again instead of failing as stale.
- Waiting for the page to settle ignores blinking carets and spinners, so actions in editors don't always wait the full 700ms.
- `drag` does real drag-and-drop (kanban cards, sortable lists, drop zones) as well as plain mouse drags. With trusted input it catches Chrome's native drag and replays it as drag events. `to_position` drops before or after a list item, and `hold` covers long-press-to-drag. Shift-click and triple-click also select ranges. `run_js` runs through the DevTools protocol first, so strict CSP and Trusted Types pages work.
- Old plain reasoning text is dropped from the history at the same step-of-10 cut-off as tool output. On long runs it was most of the prompt (about 120k tokens by round 200), slowing time to first token and inviting the model to re-argue settled steps. Signed or encrypted reasoning, which providers need back, is kept.
- When a tool call fails, the rest of that response is skipped instead of typing or clicking into a page that no longer matches the model's plan.
- Google Docs tools check their own work (toolbar state, title, comment cards) and fail loudly, so the model doesn't spend rounds re-reading and redoing steps that already worked.
- Old tool output is trimmed in steps of 10, so earlier messages stay byte-identical and provider prompt caches keep hitting. Older screenshots are dropped. The system prompt has no clock time. Anthropic gets a cache breakpoint on the newest message. Requests can be routed to the lowest-latency provider (setting): agent turns are short, so time to first token matters more than throughput.

## History and logs

The line under the composer shows totals for the whole chat: time the agent spent working (time waiting on you doesn't count), tokens and cost. While a run is going, the numbers update live.

The clock button opens your chat history. Click a chat to reopen it, use the download icon to export that chat's log, or use **Export all**. An export is a JSON file containing every message, tool call (input and result), the page URL after each action, model timings (time to first token and total), token use and cost, errors, plus the settings and system prompt that were in effect. API keys are never included.

## Settings

Model picker (any OpenRouter model that supports tools), reasoning effort, fastest-provider routing, page highlight, **Trusted input** (on by default: real mouse and keyboard events through the DevTools protocol, so Chrome shows a debugging bar while the agent acts), a step limit you can turn off, and custom instructions.
