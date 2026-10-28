// Firefox: `browser` is the promise-based namespace. Use it as `chrome` so every
// call below returns a promise, as it does in Chrome. Imported first.
if (globalThis.browser?.runtime && globalThis.chrome !== globalThis.browser) {
  try { Object.defineProperty(globalThis, 'chrome', { value: globalThis.browser, configurable: true, writable: true }); } catch {}
}

// Chrome's DevTools protocol (trusted input, the Docs and Canva packs). Firefox has none.
export const CAN_DEBUG = !!globalThis.chrome?.debugger;
export const FIREFOX = !!globalThis.browser?.runtime;
