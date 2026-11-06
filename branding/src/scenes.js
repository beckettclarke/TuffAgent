// Demo data for the panel screenshots. Each scene seeds chrome.storage.local
// (read by stub.js) and can adjust the rendered panel afterwards (after()).
// Sites, products and listings here are made up.
(() => {
  const M = (id, name, ctx, vision, pin, pout, created) =>
    ({ id, name, provider: id.split('/')[0], ctx, vision, reasoning: true, pin: pin / 1e6, pout: pout / 1e6, maxOut: 64000, created });
  const MODELS = [
    M('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5', 1e6, true, 3, 15, 1790000000),
    M('anthropic/claude-haiku-5.5', 'Claude Haiku 5.5', 2e5, true, 1, 5, 1789000000),
    M('anthropic/claude-opus-5.5', 'Claude Opus 5.5', 1e6, true, 5, 25, 1791000000),
    M('openai/gpt-5.6-luna', 'GPT-5.6 Luna', 4e5, true, 1.25, 10, 1788000000),
    M('openai/gpt-5.6-terra', 'GPT-5.6 Terra', 4e5, true, 0.25, 2, 1787000000),
    M('google/gemini-3.8-flash', 'Gemini 3.8 Flash', 1e6, true, 0.3, 2.5, 1786000000),
    M('x-ai/grok-4.7', 'Grok 4.7', 256000, true, 3, 15, 1785000000),
    M('moonshotai/kimi-k3', 'Kimi K3', 256000, false, 0.6, 2.5, 1784000000),
    M('qwen/qwen3.8-flash', 'Qwen3.8 Flash', 128000, false, 0.05, 0.4, 1783000000),
  ];

  // A user prompt, rounds of tool calls ([name, args, label, ms, ok]), and a final answer.
  function convo(prompt, rounds, answer, meta) {
    const msgs = [{ role: 'user', content: prompt, _display: prompt }];
    let n = 0;
    for (const r of rounds) {
      const calls = r.map(([name, args]) => ({ id: `c${++n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }));
      msgs.push({ role: 'assistant', content: '', tool_calls: calls });
      r.forEach(([, , label, ms, ok], i) => msgs.push({ role: 'tool', tool_call_id: calls[i].id, content: label, _label: label, _ms: ms, _ok: ok !== false }));
    }
    if (answer) msgs.push({ role: 'assistant', content: answer, _meta: meta });
    return msgs;
  }

  const CHATS = {
    shop: {
      title: 'Find the best-reviewed 27-inch 4K monitor under $350 and add it to my cart.',
      model: 'anthropic/claude-sonnet-5.5',
      rounds: [
        [['navigate', { url: 'https://lumen.supply' }, 'Opened lumen.supply', 612]],
        [['type', { target: 'Search', text: '27 inch 4K', submit: true }, 'Typed “27 inch 4K” into Search', 438]],
        [['click', { target: 'Top rated' }, 'Clicked “Sort: Top rated”', 391]],
        [['get_text', { query: '$' }, 'Read 24 results · 9 under $350', 96]],
        [['click', { target: 'Add to cart', near: 'Arden 27 UHD' }, 'Clicked “Add to cart” · Cart (1)', 702]],
      ],
      answer: 'Done. The **Arden 27 UHD** ($289) is in your cart.\n\n- It has the highest rating of the 27-inch 4K monitors under $350: 4.8 from 1,204 reviews.\n- Reviewers mention sharp text, a 120Hz panel and a height-adjustable stand.\n- Runner-up was the Pike P27K ($319), rated 4.6.',
      meta: { steps: 5, ms: 18400, tokens: 38200, cost: 0.047 },
    },
    rentals: {
      title: 'Compare the three apartment listings I have open and put them in a table.',
      model: 'anthropic/claude-sonnet-5.5',
      rounds: [
        [['tabs_list', {}, 'Listed 9 tabs', 3]],
        [['tab_switch', { tab: 3 }, 'Switched to “Loft in Alfama”', 41], ['read_page', {}, 'Read nestly.co', 162]],
        [['tab_switch', { tab: 4 }, 'Switched to “Flat in Príncipe Real”', 38], ['read_page', {}, 'Read nestly.co', 147]],
        [['tab_switch', { tab: 5 }, 'Switched to “Studio in Graça”', 36], ['read_page', {}, 'Read nestly.co', 151]],
      ],
      answer: 'Here are the three listings side by side:\n\n| | Alfama | Príncipe Real | Graça |\n|---|---|---|---|\n| Per night | €142 | €168 | €96 |\n| Bedrooms | 1 | 2 | Studio |\n| Rating | 4.91 | 4.84 | 4.77 |\n| To metro | 6 min | 4 min | 11 min |\n\nThe **Alfama loft** has the best reviews for the price. The Graça studio is the cheapest, but it’s the furthest from the metro and has no washing machine.',
      meta: { steps: 7, ms: 21200, tokens: 48200, cost: 0.061 },
    },
    tabs: {
      title: 'Group my tabs by topic.',
      model: 'openai/gpt-5.6-luna',
      rounds: [
        [['tabs_list', {}, 'Listed 14 tabs', 2]],
        [
          ['tab_group', { tabs: [2, 3, 4, 5, 6], name: 'Lisbon trip' }, 'Grouped 5 tabs as “Lisbon trip”', 18],
          ['tab_group', { tabs: [7, 8, 9, 10], name: 'Monitors' }, 'Grouped 4 tabs as “Monitors”', 12],
          ['tab_group', { tabs: [11, 12, 13], name: 'Taxes' }, 'Grouped 3 tabs as “Taxes”', 11],
        ],
      ],
      answer: 'Done. 12 of your 14 tabs are now in three groups: **Lisbon trip**, **Monitors** and **Taxes**. I left your email and calendar tabs on their own.',
      meta: { steps: 4, ms: 6100, tokens: 9800, cost: 0.011 },
    },
    docs: {
      title: 'Turn my meeting notes into a proper doc: title, action items as a checklist, and a table of owners.',
      model: 'anthropic/claude-sonnet-5.5',
      rounds: [
        [['gdocs_read', {}, 'Read the document · 1 page, 31 paragraphs', 284]],
        [['gdocs_write', { at: 'start', replace: true, markdown: '…' }, 'Rewrote the document · 4 headings, 1 table', 1630]],
        [['gdocs_format', { match: 'Q4 launch sync', style: 'Title' }, 'Set “Q4 launch sync” to Title', 512]],
        [['gdocs_format', { match: 'Action items', list: 'checklist' }, 'Made 6 action items a checklist', 488]],
        [['gdocs_comment', { match: 'launch date', text: 'Still waiting on legal sign-off.' }, 'Commented on “launch date”', 702]],
        [['gdocs_read', {}, 'Checked the result · matches the plan', 241]],
      ],
      answer: 'The doc is cleaned up:\n\n- **Q4 launch sync** is the title, with sections for decisions, action items and open questions.\n- The 6 action items are a checklist, and a table below lists each owner and due date.\n- I left a comment on the launch date, since the notes say legal hasn’t signed off.',
      meta: { steps: 6, ms: 24800, tokens: 52600, cost: 0.072 },
    },
  };

  function chatRecord(id, key, ago, now) {
    const c = CHATS[key];
    const messages = convo(c.title, c.rounds, c.answer, c.meta);
    return {
      id, title: c.title, created: now - ago - c.meta.ms, updated: now - ago, model: c.model,
      steps: c.meta.steps, messages, log: [{ t: now - ago, type: 'end', ms: c.meta.ms, cost: c.meta.cost, tokens: c.meta.tokens }], packs: key === 'docs' ? ['gdocs'] : [],
    };
  }

  const H = 3600e3, D = 24 * H;
  const HISTORY = [
    ['Find the best-reviewed 27-inch 4K monitor under $350 and add it to my cart.', 'anthropic/claude-sonnet-5.5', 0.2 * H, 5],
    ['Compare the three apartment listings I have open and put them in a table.', 'anthropic/claude-sonnet-5.5', 1.4 * H, 7],
    ['Group my tabs by topic.', 'openai/gpt-5.6-luna', 3 * H, 4],
    ['Turn my meeting notes into a proper doc: title, action items as a checklist, and a table of owners.', 'anthropic/claude-sonnet-5.5', 1.1 * D, 6],
    ['Find the receipt for my March flight in my downloads and bookmark the airline’s refund page.', 'anthropic/claude-haiku-5.5', 1.3 * D, 9],
    ['Fill in the conference registration form with the details from my notes tab.', 'google/gemini-3.8-flash', 2.5 * D, 14],
    ['Summarize this page in a few bullet points.', 'anthropic/claude-haiku-5.5', 3.2 * D, 2],
    ['Open the top 3 Hacker News stories in background tabs and tell me what each is about.', 'x-ai/grok-4.7', 4.1 * D, 8],
    ['Move every card in the “Review” column to “Done” and add a due date to each.', 'anthropic/claude-opus-5.5', 9 * D, 23],
    ['Find the article I read last week about heat pumps and save it to my Reading folder.', 'openai/gpt-5.6-terra', 12 * D, 6],
  ];

  const favicon = (letter) => 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#2b2b2b"/><text x="8" y="12" font-family="Arial" font-weight="700" font-size="10" text-anchor="middle" fill="#fff">${letter}</text></svg>`);

  function base({ now, theme, model = 'anthropic/claude-sonnet-5.5', key = 'sk-or-v1-3f9a2c7e4b1d8a6f', current, history }) {
    const s = {
      settings: { apiKey: key, model, theme, reasoning: 'auto', fast: true, overlay: true, trusted: true, maxSteps: 100, unlimited: false,
        instructions: '', loader: 'line', recent: ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5'], v: 3 },
      modelCache: { at: now, list: MODELS },
      chats: [],
    };
    if (current) {
      const rec = chatRecord('demo', current, 4 * 60e3, now);
      s['chat:demo'] = rec;
      s.currentChat = 'demo';
      s.chats.push({ id: rec.id, title: rec.title, created: rec.created, updated: rec.updated, model: rec.model, steps: rec.steps });
    }
    if (history) {
      HISTORY.forEach(([title, m, ago, steps], i) => {
        if (current && i === 0) return;
        s.chats.push({ id: 'h' + i, title, created: now - ago, updated: now - ago, model: m, steps });
      });
    }
    return s;
  }

  const SHOP_TAB = { title: '27-inch 4K monitors · Lumen Supply', url: 'https://lumen.supply/s?q=27-inch+4k+monitor', favIconUrl: favicon('L') };
  const RENT_TAB = { title: 'Loft in Alfama with river view · Nestly', url: 'https://nestly.co/l/48213', favIconUrl: favicon('N') };
  const DOC_TAB = { title: 'Q4 launch sync · Docs', url: 'https://docs.google.com/document/d/demo/edit', favIconUrl: favicon('D') };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const icon = (n) => `<i class="fa-sharp fa-regular fa-${n}" aria-hidden="true"></i>`;
  const think = (t) => {
    const d = document.createElement('details');
    d.className = 'think';
    d.style.animation = 'none';
    d.innerHTML = `<summary>${icon('chevron-right')}<span>Thought for ${t}</span></summary><div class="tbody"></div>`;
    return d;
  };
  const blur = () => document.activeElement?.blur?.();

  globalThis.__TUFF_SCENES = {
    // The agent mid-task: three steps done, a click running, the page pill and timer going.
    live: {
      tab: SHOP_TAB,
      storage: (now, theme) => {
        const s = base({ now, theme, current: 'shop' });
        const c = s['chat:demo'];
        c.messages = c.messages.slice(0, 1 + 2 * 4); // prompt + first four rounds
        c.log = [];
        return s;
      },
      async after() {
        const turn = $('.thread .turn:last-of-type');
        const first = turn.querySelector('.steps');
        turn.insertBefore(think('1.2s'), first);
        turn.appendChild(think('640ms'));
        const steps = turn.appendChild(document.createElement('div'));
        steps.className = 'steps';
        const s = steps.appendChild(document.createElement('div'));
        s.className = 'step running';
        s.style.animation = 'none';
        s.innerHTML = `<button class="step-head"><span class="sicon">${icon('arrow-pointer')}</span><span class="slabel">Clicking “Add to cart”</span><span class="stime"></span><span class="sstate"><i class="ring"></i></span></button><div class="step-body"><div></div></div>`;
        document.body.classList.add('running');
        document.body.dataset.phase = 'act';
        $('#status').textContent = 'Acting';
        $('#actLabel').textContent = 'Clicking “Add to cart”';
        $('#actIcon').innerHTML = icon('arrow-pointer');
        $('#actMeter').textContent = '╱╱  ╱╱  ╱╱  ';
        $('#actTime').textContent = '0.4s';
        $('#totals').hidden = false;
        $('#totTime').textContent = '12s';
        $('#totTok').textContent = '21.4k';
        $('#totCost').textContent = '$0.026';
        $('#sendBtn').disabled = false;
        blur();
      },
    },
    shop: { tab: SHOP_TAB, storage: (now, theme) => base({ now, theme, current: 'shop' }), after: blur },
    rentals: { tab: RENT_TAB, storage: (now, theme) => base({ now, theme, current: 'rentals' }), after: blur },
    tabs: {
      tab: { title: 'Rua Augusta · Lisbon guide', url: 'https://example.com', favIconUrl: favicon('W') },
      storage: (now, theme) => base({ now, theme, current: 'tabs', model: 'openai/gpt-5.6-luna' }),
      after: blur,
    },
    docs: { tab: DOC_TAB, storage: (now, theme) => base({ now, theme, current: 'docs' }), after: blur },
    picker: {
      tab: RENT_TAB,
      storage: (now, theme) => base({ now, theme, current: 'rentals' }),
      async after() { $('#modelBtn').click(); await wait(80); blur(); },
    },
    settings: {
      tab: RENT_TAB,
      storage: (now, theme) => base({ now, theme, current: 'rentals', history: true }),
      async after() { $('#settingsBtn').click(); await wait(80); blur(); },
    },
    history: {
      tab: RENT_TAB,
      storage: (now, theme) => base({ now, theme, current: 'shop', history: true }),
      async after() { $('#historyBtn').click(); await wait(80); blur(); },
    },
    empty: { tab: { title: 'New Tab', url: 'chrome://newtab' }, storage: (now, theme) => base({ now, theme }), after: blur },
    onboard: { tab: { title: 'New Tab', url: 'chrome://newtab' }, storage: (now, theme) => base({ now, theme, key: '' }), after: blur },
  };
})();
