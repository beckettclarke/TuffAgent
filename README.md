# TuffAgent

A Chrome side-panel browser agent that works with any model through OpenRouter.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `TuffAgent` folder.
3. Click the toolbar icon (or press ⌘⇧Y) and paste your OpenRouter key.

## What it can do

Tabs (list, open, switch, close, group), navigation, page snapshots with element refs, find, click, drag, type, keys, scroll, hover, native selects, labeled screenshots (vision models), JavaScript in the page, bookmarks (search, tree, create, remove) and history search.

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
- `drag`, shift-click and triple-click for selecting ranges. `run_js` runs through the DevTools protocol first, so strict CSP and Trusted Types pages work.
- Old tool output is trimmed in steps of 10, so earlier messages stay byte-identical and provider prompt caches keep hitting. Older screenshots are dropped. The system prompt has no clock time. Anthropic gets a cache breakpoint on the newest message. Requests can be routed to the highest-throughput provider (setting).

## History and logs

The clock button opens your chat history. Click a chat to reopen it, use the download icon to export that chat's log, or use **Export all**. An export is a JSON file containing every message, tool call (input and result), the page URL after each action, model timings (time to first token and total), token use and cost, errors, plus the settings and system prompt that were in effect. API keys are never included.

## Settings

Model picker (any OpenRouter model that supports tools), reasoning effort, fastest-provider routing, page highlight, **Trusted input** (on by default: real mouse and keyboard events through the DevTools protocol, so Chrome shows a debugging bar while the agent acts), a step limit you can turn off, and custom instructions.
