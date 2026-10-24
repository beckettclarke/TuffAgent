// Assertions for the page runtime (content.js) against fixture.html.
// Open fixture.html in Chrome and run `await runChecks()` in the console:
// it returns one row per check, failures first.
window.runChecks = async () => {
  const T = window.__tuff;
  const out = [];
  const check = async (name, fn) => {
    try {
      const r = await fn();
      out.push({ name, pass: r === true || r?.pass === true, detail: r === true ? '' : r?.detail ?? String(r) });
    } catch (e) { out.push({ name, pass: false, detail: 'threw: ' + e.message }); }
  };
  const has = (s, ...parts) => {
    const miss = parts.filter((p) => !s.includes(p));
    return miss.length ? { pass: false, detail: `missing ${JSON.stringify(miss)} in:\n${s.slice(0, 1500)}` } : true;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  scrollTo(0, 0);

  const snap = await T.snapshot({ mode: 'all', maxChars: 60000 });
  await check('snapshot: React-style card is clickable', () => has(snap, 'div "Blue T-shirt $19.99"'));
  await check('snapshot: card listed once, not its spans', () => {
    const n = snap.split('\n').filter((l) => /\] \w+ "Blue T-shirt/.test(l)).length;
    return n === 1 || { pass: false, detail: `${n} lines` };
  });
  await check('snapshot: inline text reads as one block', () => has(snap, 'Price: $19.99'));
  await check('snapshot: icon-only button gets a hint', () => has(snap, 'button "[icon: close]"'));
  await check('snapshot: hidden checkbox via its label', () => has(snap, 'checkbox "I agree to the terms"'));
  await check('snapshot: unlabeled field named by the text before it', () => has(snap, 'textbox "Email"'));
  await check('snapshot: table rows on one line', () => has(snap, '| #1002 | Bob | $35 |'));
  await check('snapshot: shadow DOM control', () => has(snap, 'button "Shadow save"'));
  await check('snapshot: same-origin iframe control', () => has(snap, 'button "Frame button"'));
  await check('snapshot: off-screen text is marked', () => has(snap, 'Footer fact: the answer is 42. ·off'));

  await check('budget: viewport first when scrolled to the bottom', async () => {
    scrollTo(0, document.body.scrollHeight);
    const s = await T.snapshot({ mode: 'all', maxChars: 1500 });
    scrollTo(0, 0);
    if (!s.includes('Footer fact')) return { pass: false, detail: s };
    if (s.includes('Nav link 1"')) return { pass: false, detail: 'kept far-away nav over the footer:\n' + s };
    return has(s, 'not shown');
  });

  await check('target: label with near picks the right row', () => {
    const p = T.point({ target: 'Delete', near: 'Bob' });
    const el = document.elementFromPoint(p.x, p.y);
    return el?.dataset.row === 'bob' || { pass: false, detail: p.desc };
  });
  await check('target: ambiguous label says so', () => has(T.point({ target: 'Delete' }).desc, '3 matches'));
  await check('target: nth picks in page order', () => {
    const p = T.point({ target: 'Delete', nth: 3 });
    return document.elementFromPoint(p.x, p.y)?.dataset.row === 'carol' || { pass: false, detail: p.desc };
  });
  await check('target: a label passed as ref still works', () => has(T.point({ ref: 'Load results' }).desc, 'button "Load results"'));
  await check('target: unknown label suggests close matches', () => {
    try { T.point({ target: 'Load resuls now' }); return { pass: false, detail: 'no error' }; }
    catch (e) { return has(e.message, 'Nothing visible is labeled'); }
  });

  await check('target: several partial matches are refused', () => {
    try { return { pass: false, detail: T.point({ target: 'Save' }).desc }; }
    catch (e) { return has(e.message, 'Nothing is labeled exactly "Save"', 'Save draft'); }
  });
  await check('target: a risky partial match is not clicked', () => {
    try { return { pass: false, detail: T.point({ target: 'Position' }).desc }; }
    catch (e) { return has(e.message, 'Lock position and appearance', 'not clicked'); }
  });
  await check('target: a lone safe partial match says what it used', () => has(T.point({ target: 'Red T-shirt' }).desc, 'used partial match'));
  await check('menu: strict label refuses a loose match', () => {
    $('#strict').scrollIntoView({ block: 'center' });
    try { return { pass: false, detail: T.menuFind({ label: 'Save', strict: true }).desc }; }
    catch (e) { return has(e.message, 'No menu item is labeled exactly'); }
  });
  await check('snapshot: screen-reader mirror is skipped', () => (!snap.includes('Mirror only text')) || { pass: false, detail: 'mirror text listed' });

  await check('click: synthetic click on a handler-only card', async () => {
    await T.click({ target: 'Red T-shirt' });
    return $('#picked').textContent === 'Picked: red' || { pass: false, detail: $('#picked').textContent };
  });
  await check('click: reports text that appeared', async () => has(await T.click({ target: 'Load results' }), 'New text', 'Loaded 3 results'));
  await check('click: reports a control that changed', async () => {
    const r = await T.click({ target: 'I agree to the terms' });
    return $('#agree').checked ? has(r, 'Changed', 'checked') : { pass: false, detail: 'not checked:\n' + r };
  });
  await check('click: coordinates snap to a tiny button', async () => {
    $('#tiny').scrollIntoView({ block: 'center' });
    const r = $('#tiny').getBoundingClientRect();
    const res = await T.click({ x: Math.round(r.right + 6), y: Math.round(r.top + r.height / 2) });
    return $('#tinyCount').textContent === '1' ? has(res, 'snapped') : { pass: false, detail: res };
  });
  await check('click: partly covered button gets an uncovered spot', () => {
    $('#half').style.bottom = '50px';
    const p = T.point({ target: 'Half covered' });
    return (!p.covered && document.elementFromPoint(p.x, p.y) === $('#half')) || { pass: false, detail: JSON.stringify(p) };
  });
  await check('click: fully covered button is flagged', () => {
    const p = T.point({ target: 'Fully covered' });
    return (p.covered && /covered by/.test(p.desc)) || { pass: false, detail: JSON.stringify(p) };
  });

  await check('type: date input takes a spelled-out date', async () => {
    await T.type({ target: 'Arrival', text: 'March 14, 2025' });
    return $('#arrival').value === '2025-03-14' || { pass: false, detail: $('#arrival').value };
  });
  await check('type: time input takes 12-hour time', async () => {
    await T.type({ target: 'Time', text: '1:30 PM' });
    return $('#when').value === '13:30' || { pass: false, detail: $('#when').value };
  });
  await check('type: a select picks the option', async () => {
    await T.type({ target: 'Size', text: 'large' });
    return $('#size').value === 'Large' || { pass: false, detail: $('#size').value };
  });
  await check('type: plain field by its label', async () => {
    const r = await T.type({ target: 'Email', text: 'a@b.co' });
    return $('#email').value === 'a@b.co' || { pass: false, detail: r };
  });
  await check('type: replaces a value the page reformats on focus', async () => {
    await T.type({ target: 'Height', text: '230' });
    return $('#hpx').value.replace(/ px$/, '') === '230' || { pass: false, detail: $('#hpx').value };
  });
  await check('type: a field that ends up different is an error', async () => {
    try { await T.type({ target: 'Eats digits', text: '72' }); return { pass: false, detail: 'no error; field shows ' + $('#eat').value }; }
    catch (e) { return has(e.message, 'but the field shows "2"'); }
  });
  await check('click: an open list over the target is closed, not clicked through', async () => {
    const r = await T.click({ target: 'Download file' });
    return ($('#dlstate').textContent === 'Downloaded' && !$('#typelist')) ? has(r, 'closed an open list') : { pass: false, detail: r };
  });
  await check('type: a named non-field is an error, not a stray type', async () => {
    try { await T.type({ target: 'Products', text: 'x' }); return { pass: false, detail: 'typed somewhere' }; }
    catch (e) { return has(e.message, 'is not a text field'); }
  });
  await check('target: the label beats a container that mentions it', () => has(T.point({ target: 'Arrival' }).desc, 'textbox "Arrival"'));
  await check('prepField: combobox is flagged as suggesting', () => T.prepField({ target: 'City' }).suggest === true);

  await check('select_option by label', async () => {
    await T.selectOption({ target: 'Size', value: 'Medium' });
    return $('#size').value === 'Medium';
  });

  await check('get_text query finds the fact', () => has(T.text({ query: 'answer' }), '» Footer fact: the answer is 42.'));

  await check('modal: snapshot leads with the open dialog', async () => {
    await T.click({ target: 'Open settings' });
    const s = await T.snapshot({ mode: 'all', maxChars: 600 });
    $('#modal')?.remove();
    return has(s, 'A dialog is open', 'Dark mode');
  });

  await check('drag: pointer sortable reorders and is verified', async () => {
    const r = await T.drag({ target: 'Alpha', to_target: 'Gamma', to_position: 'bottom' });
    const order = [...document.querySelectorAll('#sortable li')].map((l) => l.textContent).join(',');
    return order === 'Beta,Gamma,Alpha' ? has(r, 'moved') : { pass: false, detail: order + '\n' + r };
  });
  await check('drag: HTML5 drag-and-drop', async () => {
    $('#native').scrollIntoView({ block: 'center' });
    const r = await T.drag({ target: 'One', to_target: 'Three' });
    const order = [...document.querySelectorAll('#native li')].map((l) => l.textContent).join(',');
    return order === 'Two,Three,One' ? has(r, 'dropped') : { pass: false, detail: order + '\n' + r };
  });

  await check('drag: a drag that moves nothing is an error', async () => {
    try { return { pass: false, detail: await T.drag({ target: 'Static block', dx: 60, dy: 0 }) }; }
    catch (e) { return has(e.message, 'nothing moved'); }
  });

  await check('shadow DOM: click by label', async () => {
    await T.click({ target: 'Shadow save' });
    return $('#host').shadowRoot.getElementById('sb').textContent === 'Shadow saved';
  });
  await check('iframe: click by label', async () => {
    await T.click({ target: 'Frame button' });
    return $('#frame').contentDocument.querySelector('button').textContent === 'Frame clicked';
  });

  await check('scroll: shows what is on screen after', async () => {
    const r = await T.scroll({ direction: 'bottom' });
    scrollTo(0, 0);
    return has(r, 'On screen now', 'Footer fact');
  });
  await check('find: matches text blocks', () => has(T.find({ query: 'answer is 42' }), 'text "Footer fact'));

  await sleep(0);
  return out.sort((a, b) => a.pass - b.pass);
};
