// Unit tests for the panel-side modules that don't need a browser:
// node test/unit.mjs
import assert from 'node:assert/strict';

// Just enough of the extension APIs for tools.js to load.
const ev = () => ({ addListener() {}, removeListener() {} });
globalThis.chrome = new Proxy({}, { get: () => new Proxy({}, { get: (_, k) => (/^on[A-Z]/.test(k) ? ev() : () => Promise.resolve()) }) });
globalThis.navigator ??= { platform: 'MacIntel' };

const { parseArgs, preLabel } = await import('../tools.js');
const { complete, apiError } = await import('../llm.js');

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log('ok  ', name); }
  catch (e) { failed++; console.log('FAIL', name, '\n     ', e.message); }
};

// ── Tool arguments ──
await test('parseArgs: plain JSON', () => assert.deepEqual(parseArgs('{"ref":"e1"}'), { ref: 'e1' }));
await test('parseArgs: empty is no arguments', () => assert.deepEqual(parseArgs(''), {}));
await test('parseArgs: double-encoded', () => assert.deepEqual(parseArgs(JSON.stringify('{"a":1}')), { a: 1 }));
await test('parseArgs: trailing comma', () => assert.deepEqual(parseArgs('{"a":1,}'), { a: 1 }));
await test('parseArgs: raw newline in a string', () => assert.deepEqual(parseArgs('{"text":"a\nb"}'), { text: 'a\nb' }));
await test('parseArgs: missing braces', () => assert.deepEqual(parseArgs('"url": "x.com"'), { url: 'x.com' }));
await test('parseArgs: code fence', () => assert.deepEqual(parseArgs('```json\n{"a":2}\n```'), { a: 2 }));
await test('parseArgs: garbage is null', () => assert.equal(parseArgs('{"a": '), null));
await test('parseArgs: arrays are not arguments', () => assert.equal(parseArgs('[1,2]'), null));

// ── Aliases (seen through preLabel, which normalizes like exec) ──
await test('alias: click_element with element index', () => assert.equal(preLabel('click_element', { element: 5 }), 'Clicking'));
await test('alias: go_to_url', () => assert.match(preLabel('go_to_url', { url: 'example.com' }), /^Going to example\.com/));
await test('alias: go_back', () => assert.equal(preLabel('go_back', {}), 'Going back'));
await test('alias: scroll_down', () => assert.equal(preLabel('scroll_down', {}), 'Scrolling down'));
await test('label: click by target', () => assert.equal(preLabel('click', { target: 'Add to cart' }), 'Clicking “Add to cart”'));

// ── Errors ──
await test('apiError: 429 retries', () => assert.equal(apiError('429 · slow down', { status: 429 }).retriable, true));
await test('apiError: 502 retries', () => assert.equal(apiError('502', { status: 502 }).retriable, true));
await test('apiError: 401 does not', () => assert.equal(apiError('401', { status: 401 }).retriable, false));
await test('apiError: 402 does not', () => assert.equal(apiError('402 credits', { status: 402 }).retriable, false));
await test('apiError: dropped connection retries', () => assert.equal(apiError('Connection failed').retriable, true));
await test('apiError: context overflow is flagged, not retried', () => {
  const e = apiError("400 · This endpoint's maximum context length is 200000 tokens", { status: 400 });
  assert.equal(e.overflow, true); assert.equal(e.retriable, false);
});
await test('apiError: Anthropic overflow wording', () => assert.equal(apiError('400 · prompt is too long: 210000 tokens > 200000 maximum', { status: 400 }).overflow, true));

// ── Streaming client against a fake OpenRouter ──
const sse = (...events) => events.map((e) => (typeof e === 'string' ? e : `data: ${JSON.stringify(e)}`) + '\n\n').join('');
const fakeFetch = (respond) => { globalThis.fetch = async (url, init) => respond(url, init); };
const stream = (text, { status = 200, headers = {} } = {}) => new Response(new ReadableStream({
  start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
}), { status, headers });

await test('complete: text and tool calls stream, ready calls fire early', async () => {
  fakeFetch(() => stream(sse(
    ': OPENROUTER PROCESSING',
    { id: 'g1', choices: [{ delta: { content: 'Hi' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'click', arguments: '{"ref":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"e1"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'key', arguments: '{"keys":"Enter"}' } }] }, finish_reason: 'tool_calls' }], usage: { total_tokens: 9, cost: 0.001 } },
    'data: [DONE]',
  )));
  const ready = [];
  const r = await complete({ apiKey: 'k', body: {}, onToolReady: (i) => ready.push(i) });
  assert.equal(r.msg.content, 'Hi');
  assert.deepEqual(r.msg.tool_calls.map((t) => t.function.name), ['click', 'key']);
  assert.deepEqual(ready, [0, 1]);
  assert.equal(r.finish, 'tool_calls');
  assert.equal(r.usage.total_tokens, 9);
});

await test('complete: 429 with Retry-After is retriable', async () => {
  fakeFetch(() => new Response('{"error":{"message":"Rate limited"}}', { status: 429, headers: { 'retry-after': '3' } }));
  const e = await complete({ apiKey: 'k', body: {} }).catch((x) => x);
  assert.equal(e.retriable, true); assert.equal(e.retryAfter, 3); assert.match(e.message, /^429 · Rate limited/);
});

await test('complete: provider error mid-stream keeps the partial reply', async () => {
  fakeFetch(() => stream(sse({ choices: [{ delta: { content: 'part' } }] }, { error: { message: 'Upstream overloaded', code: 502 } })));
  const e = await complete({ apiKey: 'k', body: {} }).catch((x) => x);
  assert.equal(e.retriable, true); assert.equal(e.partial.content, 'part');
});

await test('complete: finish_reason error is an error', async () => {
  fakeFetch(() => stream(sse({ choices: [{ delta: { content: 'x' }, finish_reason: 'error' }] })));
  const e = await complete({ apiKey: 'k', body: {} }).catch((x) => x);
  assert.equal(e.retriable, true);
});

await test('complete: network failure is retriable', async () => {
  fakeFetch(() => { throw new TypeError('Failed to fetch'); });
  const e = await complete({ apiKey: 'k', body: {} }).catch((x) => x);
  assert.equal(e.retriable, true); assert.match(e.message, /Connection to OpenRouter failed/);
});

await test('complete: stopping is an AbortError, not a retry', async () => {
  const ac = new AbortController();
  fakeFetch((_, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))));
  const p = complete({ apiKey: 'k', body: {}, signal: ac.signal }).catch((x) => x);
  ac.abort();
  const e = await p;
  assert.equal(e.name, 'AbortError'); assert.notEqual(e.retriable, true);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
