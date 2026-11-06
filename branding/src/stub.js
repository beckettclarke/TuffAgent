// Stand-in for the extension APIs, so sidepanel.html can be opened from a plain
// web server and rendered with demo data. Injected before any page script by
// render.mjs. The scene comes from the URL: sidepanel.html?scene=done&theme=dark
(() => {
  const q = new URLSearchParams(location.search);
  const scene = (globalThis.__TUFF_SCENES || {})[q.get('scene')];
  if (!scene) return;
  const theme = q.get('theme') || 'dark';
  const now = Date.now();
  const store = scene.storage(now, theme);

  const ev = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
  const pick = (keys) => {
    if (keys == null) return { ...store };
    if (typeof keys === 'string') keys = [keys];
    const out = {};
    if (Array.isArray(keys)) { for (const k of keys) if (k in store) out[k] = structuredClone(store[k]); return out; }
    for (const [k, d] of Object.entries(keys)) out[k] = k in store ? structuredClone(store[k]) : d;
    return out;
  };
  // Any API the scene doesn't define resolves to undefined; any on* is an inert event.
  const ns = (impl = {}) => new Proxy(impl, {
    get(t, p) {
      if (p in t) return t[p];
      if (typeof p === 'string' && /^on[A-Z]/.test(p)) return (t[p] = ev());
      return (t[p] = async () => undefined);
    },
  });
  const tab = { id: 7, windowId: 1, active: true, ...scene.tab };
  const api = {
    storage: {
      local: ns({
        get: async (k) => pick(k),
        set: async (o) => { Object.assign(store, o); },
        remove: async (k) => { for (const x of [].concat(k)) delete store[x]; },
        getBytesInUse: async () => 2516582,
      }),
      onChanged: ev(),
    },
    tabs: ns({ query: async () => [tab], get: async () => tab }),
    windows: ns({ getCurrent: async () => ({ id: 1 }) }),
    runtime: ns({ getManifest: () => ({ version: '1.6.0' }), id: 'tuffagent' }),
    permissions: ns({ contains: async () => true }),
    commands: ns({ getAll: async () => [{ name: '_execute_action', shortcut: '⌘⇧Y' }] }),
    debugger: ns(),
  };
  globalThis.chrome = new Proxy(api, { get: (t, p) => (p in t ? t[p] : (t[p] = ns())) });
})();
