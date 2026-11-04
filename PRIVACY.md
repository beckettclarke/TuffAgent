# TuffAgent privacy policy

_Last updated: November 4, 2026_

TuffAgent is a browser extension that carries out tasks in your browser using an AI model you choose through OpenRouter. This policy explains what data it handles, where that data goes, and what stays on your device.

## The short version

- TuffAgent has no servers, accounts, analytics or tracking. The developer never receives your data.
- Your OpenRouter key, settings and chats are stored only in your browser.
- While the agent works on a task you gave it, the content it needs (your request, page text, screenshots, tab titles and URLs) is sent to OpenRouter, which passes it to the model provider you picked.
- Nothing is sold, shared for advertising, or used for anything other than doing the task you asked for.

## What is stored on your device

All of this lives in the extension's local storage (`chrome.storage.local` / `browser.storage.local`) and never leaves your browser unless you export it:

| Data | Why |
| --- | --- |
| Your OpenRouter API key | To call the model you chose |
| Settings (model, theme, reasoning effort, custom instructions and so on) | To remember your preferences |
| Chat history: your messages, the agent's replies, tool calls and results, timings, token counts and cost | So you can reopen or export a chat |
| Your last 50 prompts | So ↑ in the composer can bring them back |
| A cached list of OpenRouter models | So the model picker opens instantly |

You can delete chats one at a time from **History**, or all at once from **Settings › Chat history › Delete all**. Disconnecting your key in **Settings** removes it. Removing the extension deletes everything it stored.

## What is sent, and to whom

**OpenRouter (openrouter.ai).** When you send a task, TuffAgent sends OpenRouter:

- your message and the conversation so far;
- information the agent collects to do the task: text and structure of web pages it reads, screenshots of the visible tab when the model asks for one, the titles and URLs of your open tabs, and results from your bookmarks, history or downloads when the task calls for them;
- your custom instructions, if you set any.

OpenRouter forwards the request to the provider of the model you selected (for example Anthropic, OpenAI or Google). Their handling of that data is covered by [OpenRouter's privacy policy](https://openrouter.ai/privacy) and the provider's own terms. You can control which providers are used, and whether they may store or train on prompts, in your OpenRouter account settings.

TuffAgent only sends this while it is working on a task you started. It does not read or send anything in the background.

TuffAgent also asks OpenRouter for the list of available models and checks your key when you connect it.

**Icon stylesheet.** The side panel loads its icon font stylesheet from `beckettclarke.ca`. That request carries nothing about you or your tasks, but like any web request it shows that server your IP address and browser.

**Websites you ask it to use.** When the agent clicks, types or navigates on a site, that site sees those actions the same way it would see yours, signed in as you.

## Exports

**Export** in History saves a JSON file of a chat's messages, tool calls, results and timings to your computer. API keys are never included. What you do with that file is up to you.

## Permissions

TuffAgent asks for broad permissions (access to all sites, tabs, history, bookmarks, downloads and, in Chrome, the debugger) because it acts as a general browser assistant. It uses them only to carry out tasks you give it. See [STORE.md](STORE.md) for what each permission is used for.

## Children

TuffAgent is not directed at children under 13 and does not knowingly collect their data.

## Changes

If this policy changes, the new version will be published here with a new date.

## Contact

Questions or requests: open an issue at [github.com/beckettclarke/TuffAgent](https://github.com/beckettclarke/TuffAgent/issues) or visit [beckettclarke.ca](https://beckettclarke.ca).
