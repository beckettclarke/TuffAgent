// Builds the store uploads: dist/tuffagent-<version>-chrome.zip and -firefox.zip.
// The source is what ships (no bundling or minifying). Each zip gets a manifest
// trimmed for its browser, so neither store warns about the other's keys.
//
//   node scripts/pack.mjs            both
//   node scripts/pack.mjs chrome     one
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const { version } = manifest;

// Everything the extension loads at runtime, and nothing else.
const FILES = [
  ...readdirSync(root).filter((f) => f.endsWith('.js')),
  'sidepanel.html', 'sidepanel.css', 'icons', 'sites',
];

const TARGETS = {
  chrome(m) {
    delete m.browser_specific_settings;
    delete m.sidebar_action;
    m.background = { service_worker: m.background.service_worker, type: m.background.type };
    if (!m.background.type) delete m.background.type;
    return m;
  },
  firefox(m) {
    delete m.side_panel;
    delete m.minimum_chrome_version;
    m.background = { scripts: m.background.scripts, type: m.background.type };
    if (!m.background.type) delete m.background.type;
    // Firefox has neither; the code checks for them before use (compat.js, background.js).
    m.permissions = m.permissions.filter((p) => p !== 'sidePanel' && p !== 'debugger');
    return m;
  },
};

const want = process.argv.slice(2);
const targets = want.length ? want : Object.keys(TARGETS);
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

for (const t of targets) {
  if (!TARGETS[t]) { console.error(`Unknown target "${t}". Use: ${Object.keys(TARGETS).join(', ')}`); process.exit(1); }
  const stage = join(dist, `stage-${t}`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const f of FILES) cpSync(join(root, f), join(stage, f), { recursive: true });
  const m = TARGETS[t](structuredClone(manifest));
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  const zip = join(dist, `tuffagent-${version}-${t}.zip`);
  rmSync(zip, { force: true });
  // -X: no extra file attributes, -D: no directory entries, so the zip is reproducible-ish.
  execFileSync('zip', ['-qrXD', zip, '.', '-x', '.*', '*/.*'], { cwd: stage });
  rmSync(stage, { recursive: true, force: true });
  console.log(`${t.padEnd(8)} ${zip.replace(root + '/', '')}`);
}
