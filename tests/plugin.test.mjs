// Проверки комплектации плагина. Они не устанавливают плагин и не вызывают Telegram.
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildPlugin, PACKAGE_FILES, PACKAGE_PATH } from '../scripts/build-plugin.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGED = resolve(ROOT, PACKAGE_PATH);
const json = async (path) => JSON.parse(await readFile(resolve(ROOT, path), 'utf8'));
let failures = 0;
async function test(name, run) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.message}`); }
}

// Небольшой строгий разбор используемого здесь подмножества YAML:
// отображения со строками в кавычках, простыми именами и boolean. Неподдерживаемый
// синтаксис отклоняется; проверки не выдают regex-совпадение за полноценный YAML.
function yamlMappings(text) {
  const output = {}, stack = [{ indent: -1, value: output }];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^( *)([a-z_]+):(?: (.*))?$/.exec(line);
    assert.ok(match, `Unsupported or invalid YAML line: ${line}`);
    const indent = match[1].length;
    assert.equal(indent % 2, 0, 'YAML indentation must use pairs of spaces');
    while (stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1);
    assert.ok(parent && (indent === 0 || indent === parent.indent + 2), 'Invalid YAML nesting');
    assert.ok(!Object.hasOwn(parent.value, match[2]), `Duplicate YAML key ${match[2]}`);
    let value;
    if (match[3] === undefined) value = {};
    else if (match[3].startsWith('"')) value = JSON.parse(match[3]);
    else if (match[3] === 'true' || match[3] === 'false') value = match[3] === 'true';
    else { assert.match(match[3], /^[a-z0-9-]+$/); value = match[3]; }
    parent.value[match[2]] = value;
    if (match[3] === undefined) stack.push({ indent, value });
  }
  return output;
}

async function contained(path, root = ROOT) {
  assert.ok(path.startsWith('./'), `Packaged path must start with ./: ${path}`);
  const target = await realpath(resolve(root, path));
  const rel = relative(await realpath(root), target);
  assert.ok(!rel.startsWith('..') && !isAbsolute(rel), `Path escapes plugin: ${path}`);
  return target;
}

await test('portable manifest and Codex overlay share identity and presentation', async () => {
  const portable = await json('plugin.json'), overlay = await json('.codex-plugin/plugin.json');
  assert.equal(portable.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(portable.name, 'agent-telegram');
  assert.match(portable.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(portable.license, 'MIT');
  for (const field of ['name', 'version', 'description', 'author', 'repository']) {
    assert.deepEqual(portable[field], overlay[field], field);
  }
  assert.ok(!Object.hasOwn(portable, 'skills') && !Object.hasOwn(portable, 'mcpServers'));
  const extension = portable.extensions['com.openai'];
  assert.deepEqual(extension.interface, overlay.interface);
  assert.equal(extension.onboardingSkill, overlay.onboardingSkill);
  assert.ok(extension.interface.shortDescription.length <= 30);
  assert.equal(extension.interface.category, 'Developer Tools');
  assert.ok(Array.isArray(extension.interface.capabilities));
  assert.ok((await stat(await contained(extension.onboardingSkill))).isFile());
  assert.ok((await stat(await contained(overlay.skills))).isDirectory());
});

await test('marketplace selects the isolated package instead of the repository root', async () => {
  const marketplace = await json('.agents/plugins/marketplace.json');
  const manifest = await json('plugin.json');
  assert.equal(marketplace.name, 'agent-telegram');
  assert.equal(marketplace.plugins.length, 1);
  const entry = marketplace.plugins[0];
  assert.equal(entry.name, manifest.name);
  assert.equal(entry.category, manifest.extensions['com.openai'].interface.category);
  assert.deepEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_INSTALL' });
  assert.equal(entry.source.source, 'local');
  assert.equal(entry.source.path, './plugins/agent-telegram');
  assert.equal(await contained(entry.source.path), await realpath(PACKAGED));
  assert.notEqual(await realpath(PACKAGED), await realpath(ROOT));
  assert.deepEqual(JSON.parse(await readFile(resolve(PACKAGED, 'plugin.json'), 'utf8')), manifest);
});

await test('skill metadata is valid and root-relative references exist', async () => {
  const path = resolve(PACKAGED, 'skills/agent-telegram/SKILL.md');
  const text = await readFile(path, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, 'Missing skill frontmatter');
  const metadata = yamlMappings(match[1]);
  assert.deepEqual(Object.keys(metadata).sort(), ['description', 'name']);
  assert.equal(metadata.name, 'agent-telegram');
  assert.equal(typeof metadata.description, 'string');
  assert.ok(metadata.description.length > 20);
  const refs = [...text.matchAll(/\]\((\.\.\/[^)]+)\)/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2);
  for (const ref of refs) {
    const target = await realpath(resolve(dirname(path), ref));
    const rel = relative(await realpath(PACKAGED), target);
    assert.ok(!rel.startsWith('..') && !isAbsolute(rel), ref);
    assert.ok((await stat(target)).isFile(), ref);
  }
});

await test('skill interface uses typed YAML with implicit invocation enabled', async () => {
  const metadata = yamlMappings(await readFile(resolve(PACKAGED, 'skills/agent-telegram/agents/openai.yaml'), 'utf8'));
  assert.equal(metadata.interface.display_name, 'Agent Telegram');
  assert.equal(typeof metadata.interface.short_description, 'string');
  assert.equal(typeof metadata.interface.default_prompt, 'string');
  assert.equal(metadata.policy.allow_implicit_invocation, true);
  assert.deepEqual(Object.keys(metadata.policy), ['allow_implicit_invocation']);
});

await test('committed plugin package exactly matches its reviewed source allowlist', async () => {
  const result = await buildPlugin({ check: true });
  assert.equal(result.checked, true);
  assert.equal(result.version, (await json('plugin.json')).version);
  assert.ok((await readFile(resolve(PACKAGED, 'LICENSE'), 'utf8')).includes('MIT License'));
});

async function fixture(run) {
  const root = await mkdtemp(resolve(tmpdir(), 'agent-telegram-package-'));
  try {
    for (const { source } of PACKAGE_FILES) {
      const destination = resolve(root, source);
      await mkdir(dirname(destination), { recursive: true });
      await cp(resolve(ROOT, source), destination);
    }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

await test('package builds exclude repository history, project bindings and private reports', async () => {
  await fixture(async (root) => {
    const excluded = ['.git/objects/fixture', '.agent-telegram.json', '.secrets/telegram.env', 'docs/LOCAL_ACCEPTANCE_REPORT.md', 'docs/requests/private.md', 'tests/private-fixture.txt'];
    for (const name of excluded) {
      const file = resolve(root, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, 'synthetic-private-marker');
    }
    const packageRoot = resolve(root, PACKAGE_PATH);
    await mkdir(resolve(packageRoot, '.git'), { recursive: true });
    await writeFile(resolve(packageRoot, '.git/old-history'), 'synthetic-old-history');
    await buildPlugin({ root });
    for (const name of excluded.concat('.git')) {
      assert.equal(await lstat(resolve(packageRoot, name)).catch(() => null), null, name);
    }
    for (const { target } of PACKAGE_FILES) {
      assert.ok(!(await readFile(resolve(packageRoot, target), 'utf8')).includes('synthetic-private-marker'), target);
    }
    const before = await Promise.all(PACKAGE_FILES.map(({ target }) => readFile(resolve(packageRoot, target))));
    await buildPlugin({ root });
    const after = await Promise.all(PACKAGE_FILES.map(({ target }) => readFile(resolve(packageRoot, target))));
    assert.deepEqual(after, before, 'Rebuild must be deterministic');
    await buildPlugin({ root, check: true });
  });
});

await test('package verification rejects stale bytes and unlisted entries without modifying them', async () => {
  await fixture(async (root) => {
    await buildPlugin({ root });
    const script = resolve(root, PACKAGE_PATH, 'tg.mjs');
    await writeFile(script, 'stale fixture');
    await assert.rejects(buildPlugin({ root, check: true }), /differs from its source/);
    assert.equal(await readFile(script, 'utf8'), 'stale fixture');
    await buildPlugin({ root });
    await mkdir(resolve(root, PACKAGE_PATH, '.git'));
    await assert.rejects(buildPlugin({ root, check: true }), /Unexpected or unsafe packaged entry: \.git/);
    assert.ok((await stat(resolve(root, PACKAGE_PATH, '.git'))).isDirectory());
  });
});

await test('package build refuses linked sources and destinations outside the reviewed tree', async () => {
  await fixture(async (root) => {
    const outside = resolve(root, 'outside.txt');
    await writeFile(outside, 'synthetic-outside-marker');
    await rm(resolve(root, 'tg.mjs'));
    await symlink(outside, resolve(root, 'tg.mjs'));
    await assert.rejects(buildPlugin({ root }), /regular file inside the repository/);
    assert.equal(await lstat(resolve(root, PACKAGE_PATH)).catch(() => null), null);
  });
  await fixture(async (root) => {
    const outside = resolve(root, 'outside');
    await mkdir(outside);
    await writeFile(resolve(outside, 'keep.txt'), 'keep fixture');
    await symlink(outside, resolve(root, 'plugins'), 'dir');
    await assert.rejects(buildPlugin({ root }), /plugins must be a regular directory/);
    assert.equal(await readFile(resolve(outside, 'keep.txt'), 'utf8'), 'keep fixture');
  });
});

await test('packaged Markdown links stay inside the package and resolve', async () => {
  for (const { target } of PACKAGE_FILES.filter(({ target }) => target.endsWith('.md'))) {
    const file = resolve(PACKAGED, target);
    for (const match of (await readFile(file, 'utf8')).matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const link = match[1].split('#')[0];
      if (!link || /^[a-z]+:/i.test(link)) continue;
      const actual = await realpath(resolve(dirname(file), link));
      const rel = relative(await realpath(PACKAGED), actual);
      assert.ok(!rel.startsWith('..') && !isAbsolute(rel), `${target}: ${link}`);
      assert.ok((await stat(actual)).isFile());
    }
  }
});

await test('packaged runtime entrypoints work from a detached installed-like copy', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'agent-telegram-installed-'));
  try {
    const installed = resolve(temporary, 'cache/agent-telegram/0.1.2');
    const project = resolve(temporary, 'project');
    await cp(PACKAGED, installed, { recursive: true });
    await mkdir(project);
    assert.equal(await lstat(resolve(installed, '.git')).catch(() => null), null);
    assert.ok(!(await readdir(installed)).includes('.agent-telegram.json'));
    for (const name of ['tg.mjs', 'tg-listen.mjs', 'tg-setup.mjs', 'tg-bridge.mjs']) {
      const entrypoint = await contained(`./${name}`, installed);
      const result = spawnSync(process.execPath, [entrypoint, '--help'], { cwd: project, encoding: 'utf8', timeout: 10000, env: { ...process.env, TG_HUB: resolve(temporary, 'hub') } });
      assert.equal(result.status, 0, `${name}: ${result.stderr || result.error || ''}`);
      assert.ok(result.stdout.length > 100, `${name}: empty help`);
      if (name === 'tg-listen.mjs') {
        assert.match(result.stdout, /--checkpoint/);
        assert.match(result.stdout, /--received/);
      }
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

process.exitCode = failures ? 1 : 0;
