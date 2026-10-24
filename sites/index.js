// Site packs: extra tools and prompt notes for one site, offered to the model
// only once a matching page is open in the chat, so other sites keep a lean
// tool list. A pack is { id, title, match(url), prompt, tools, icon(name, args), preLabel(name, args), exec(name, args, api) },
// plus optional finalCheck (a read tool run once before the agent's final answer)
// and selection(api, tabId) (what a click on the page selected, for canvas apps).
import gdocs from './gdocs.js';
import canva from './canva.js';

export const PACKS = [gdocs, canva];

const byTool = new Map(PACKS.flatMap((p) => p.tools.map((t) => [t.function.name, p])));
export const packOf = (toolName) => byTool.get(toolName);
export const packsForUrl = (url) => PACKS.filter((p) => p.match(String(url || '')));
