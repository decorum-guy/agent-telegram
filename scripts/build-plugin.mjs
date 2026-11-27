// Build only reviewed runtime files. Never copy the repository directory itself.
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE_PATH = 'plugins/agent-telegram';
export const PACKAGE_FILES = Object.freeze([
  ['plugin.json', 'plugin.json'],
  ['.codex-plugin/plugin.json', '.codex-plugin/plugin.json'],
  ['LICENSE', 'LICENSE'],
  ['AGENT.md', 'AGENT.md'],
  ['docs/PLUGIN_README.md', 'README.md'],
  ['tg.mjs', 'tg.mjs'],
  ['tg-listen.mjs', 'tg-listen.mjs'],
  ['tg-setup.mjs', 'tg-setup.mjs'],
  ['tg-bridge.mjs', 'tg-bridge.mjs'],
  ['tg-workspace.mjs', 'tg-workspace.mjs'],
  ['skills/agent-telegram/SKILL.md', 'skills/agent-telegram/SKILL.md'],
  ['skills/agent-telegram/agents/openai.yaml', 'skills/agent-telegram/agents/openai.yaml'],
  ['docs/BRIDGE.md', 'docs/BRIDGE.md'],
  ['docs/MIGRATION.md', 'docs/MIGRATION.md'],
].map(([source, target]) => Object.freeze({ source, target })));

async function inspect(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function sourceBytes(root, path) {
  const parts = path.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const entry = await inspect(current);
    if (!entry || entry.isSymbolicLink() || (i === parts.length - 1 ? !entry.isFile() : !entry.isDirectory())) {
      throw new Error(`Package source must be a regular file inside the repository: ${path}`);
    }
  }
  return readFile(current);
}

function allowedEntries() {
  const entries = new Map();
  for (const { target } of PACKAGE_FILES) {
    entries.set(target, 'file');
    const parts = target.split('/');
    for (let i = 1; i < parts.length; i++) entries.set(parts.slice(0, i).join('/'), 'directory');
  }
  return entries;
}

async function checkContents(destination, sources) {
  const allowed = allowedEntries();
  const seen = new Set();
  const rootEntry = await inspect(destination);
  if (!rootEntry?.isDirectory() || rootEntry.isSymbolicLink()) throw new Error('Missing or invalid generated plugin directory; run node scripts/build-plugin.mjs');
  async function walk(path = '') {
    for (const entry of await readdir(join(destination, path), { withFileTypes: true })) {
      const name = path ? `${path}/${entry.name}` : entry.name;
      const kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
      if (allowed.get(name) !== kind) throw new Error(`Unexpected or unsafe packaged entry: ${name}`);
      seen.add(name);
      if (kind === 'directory') await walk(name);
    }
  }
  await walk();
  for (const [name] of allowed) if (!seen.has(name)) throw new Error(`Missing packaged entry: ${name}`);
  for (const { target, bytes } of sources) {
    if (!(await readFile(join(destination, target))).equals(bytes)) {
      throw new Error(`Packaged file differs from its source: ${target}; run node scripts/build-plugin.mjs`);
    }
  }
}

export async function buildPlugin({ root = ROOT, check = false } = {}) {
  root = await realpath(root);
  // Read and validate every input before replacing a previously generated package.
  const sources = [];
  for (const entry of PACKAGE_FILES) sources.push({ ...entry, bytes: await sourceBytes(root, entry.source) });
  const manifest = JSON.parse(sources.find((entry) => entry.target === 'plugin.json').bytes.toString('utf8'));
  const parent = join(root, 'plugins');
  const parentEntry = await inspect(parent);
  if (parentEntry && (!parentEntry.isDirectory() || parentEntry.isSymbolicLink())) throw new Error('plugins must be a regular directory');
  const destination = join(root, PACKAGE_PATH);
  if (check) {
    await checkContents(destination, sources);
    return { version: manifest.version, files: sources.length, checked: true };
  }
  const oldEntry = await inspect(destination);
  if (oldEntry && (!oldEntry.isDirectory() || oldEntry.isSymbolicLink())) throw new Error('Generated plugin destination must be a regular directory');
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.agent-telegram-build-'));
  let backup = null;
  let published = false;
  try {
    for (const { target, bytes } of sources) {
      const output = join(staging, target);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, bytes, { mode: 0o644, flag: 'wx' });
    }
    await checkContents(staging, sources);
    if (oldEntry) {
      backup = await mkdtemp(join(parent, '.agent-telegram-old-'));
      await rm(backup, { recursive: true });
      await rename(destination, backup);
    }
    try { await rename(staging, destination); published = true; }
    catch (error) { if (backup) { await rename(backup, destination); backup = null; } throw error; }
    if (backup) { await rm(backup, { recursive: true }); backup = null; }
    return { version: manifest.version, files: sources.length, checked: false };
  } finally {
    if (!published) await rm(staging, { recursive: true, force: true });
    // A failed restoration keeps the backup for recovery rather than deleting it.
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/build-plugin.mjs [--check]\nBuild plugins/agent-telegram from the explicit runtime allowlist.\n--check verifies exact contents without changing any files.');
  } else if (args.some((arg) => arg !== '--check') || args.length > 1) {
    console.error('Usage: node scripts/build-plugin.mjs [--check]');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await buildPlugin({ check: args.includes('--check') }))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
