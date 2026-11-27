// Regression cases found by independent release review. Synthetic local data only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomic, state, ingest, importInbox } from '../tg-bridge.mjs';

const sandbox = await mkdtemp(join(tmpdir(), 'agent-telegram-release-regressions-'));
const bot = '76123', inbox = join(sandbox, 'inbox', 'alpha'), bridge = join(sandbox, 'projects', 'alpha');
const message = (id, text = 'Synthetic correction') => ({ bot, project: 'alpha', update_id: id, why: 'before_activation', pending_activation: true,
  message: { message_id: id, date: 1800000000, from: { id: 111, is_bot: false }, chat: { id: 111, type: 'private' }, text } });
const append = row => appendFile(join(inbox, 'queue.jsonl'), JSON.stringify(row) + '\n');
const bytes = async () => (await readFile(join(inbox, 'queue.jsonl'))).length;
try {
  await mkdir(inbox, { recursive: true });
  await atomic(join(sandbox, 'offset.json'), { bot, offset: 100 });
  await state(bridge, d => { d.enabled = true; d.imported = { [bot]: true }; });
  await append(message(1, 'Held while alpha was inactive'));
  const firstCursor = await importInbox(bridge, bot, inbox, sandbox);
  let saved = await state(bridge);
  assert.equal(saved.events[bot + ':1'].text, 'Held while alpha was inactive');
  assert.equal(firstCursor, await bytes());
  console.log('PASS  previously imported bridge resumes corrections held during single-project switch');

  await atomic(join(inbox, 'state.json'), { cursor: firstCursor, seen: [] });
  const firstReceipt = saved.events[bot + ':1'].receipt;
  await append(message(2));
  const secondCursor = await importInbox(bridge, bot, inbox, sandbox);
  saved = await state(bridge);
  assert.ok(saved.events[bot + ':2']); assert.equal(saved.events[bot + ':1'].receipt, firstReceipt);
  assert.ok(secondCursor > firstCursor);
  assert.equal(await importInbox(bridge, bot, inbox, sandbox), secondCursor);
  assert.equal(Object.keys((await state(bridge)).events).length, 2);
  console.log('PASS  repeated incremental import delivers new tail without changing existing receipt');

  const partial = JSON.stringify(message(3));
  await appendFile(join(inbox, 'queue.jsonl'), partial.slice(0, 40));
  assert.equal(await importInbox(bridge, bot, inbox, sandbox), secondCursor);
  assert.equal((await state(bridge)).events[bot + ':3'], undefined);
  await appendFile(join(inbox, 'queue.jsonl'), partial.slice(40) + '\n');
  assert.equal(await importInbox(bridge, bot, inbox, sandbox), await bytes());
  assert.ok((await state(bridge)).events[bot + ':3']);
  console.log('PASS  consumer cursor covers only fully imported lines, preserving an incomplete append');

  await append({ ...message(4), bot: '76124' });
  await append(message(5));
  await atomic(join(inbox, 'state.json'), { cursor: 0, seen: [bot + ':5'] });
  await importInbox(bridge, bot, inbox, sandbox);
  saved = await state(bridge);
  assert.equal(saved.events[bot + ':4'], undefined);
  assert.equal(saved.events[bot + ':5'], undefined);
  console.log('PASS  queue import does not rename another bot event or replay string-keyed consumed input');

  const media = message(6, ''); media.why = 'default'; delete media.pending_activation;
  media.message.photo = [{ file_id: 'synthetic-photo' }]; media.attachments = [];
  await ingest(bridge, bot, { ...media, hydrating: true });
  await append(media);
  await importInbox(bridge, bot, inbox, sandbox);
  const photo = (await state(bridge)).events[bot + ':6'];
  assert.equal(photo.hydrating, true); assert.equal(photo.status, 'hydrating');
  assert.equal(photo.source.message.photo[0].file_id, 'synthetic-photo');
  console.log('PASS  empty queued attachment list cannot prematurely complete a pending media download');

  const recovered = join(sandbox, 'projects', 'recovered'), oldInbox = join(sandbox, 'recovered-inbox');
  await mkdir(oldInbox); const row = message(7);
  const raw = JSON.stringify(row) + '\n';
  await writeFile(join(oldInbox, 'queue.jsonl'), raw);
  await atomic(join(oldInbox, 'state.json'), { cursor: Buffer.byteLength(raw), seen: [] });
  await state(recovered, d => { d.imported = { [bot]: true }; });
  await importInbox(recovered, bot, oldInbox, sandbox);
  assert.equal((await state(recovered)).events[bot + ':7'].text, row.message.text);
  console.log('PASS  held unacknowledged activation row recovers even after a stale receiver cursor');

  const cliHub = join(sandbox, 'cli'), cliBot = '76125';
  const cliInbox = name => join(cliHub, 'inbox', name);
  const cliBridge = join(cliHub, 'projects', 'alpha');
  await mkdir(join(cliHub, '.secrets'), { recursive: true });
  for (const name of ['alpha', 'beta']) await mkdir(cliInbox(name), { recursive: true });
  await writeFile(join(cliHub, '.secrets', 'telegram.env'), `TG_BOT_TOKEN=${cliBot}:sandbox\nTG_CHAT_ID=111\n`);
  let registry = { version: 2, mode: 'single', default: 'beta',
    singleActivation: { project: 'beta', previous: 'alpha', pending: true, code: 'synthetic-beta-code' },
    projects: Object.fromEntries(['alpha', 'beta'].map(name => [name, { tag: '#' + name, inbox: cliInbox(name), privateChat: { chat_id: '111', bot_id: cliBot } }])) };
  await atomic(join(cliHub, 'projects.json'), registry);
  await state(cliBridge, d => { d.enabled = true; d.imported = { [cliBot]: true }; });
  const cliEnv = { ...process.env, TG_HUB: cliHub, TG_BRIDGE_HOME: join(sandbox, 'runtime') };
  for (const key of ['TG_PROJECT', 'TG_BOT_TOKEN', 'TG_CHAT_ID', 'TG_RECEIVER_PARENT']) delete cliEnv[key];
  const dm = (id, text) => ({ update_id: id, message: message(id, text).message });
  let invocation = 0;
  async function listen(project, updates, flags = []) {
    const fixture = join(sandbox, `listener-${invocation++}.json`);
    await writeFile(fixture, JSON.stringify(updates));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../tg-listen.mjs', import.meta.url)), '--project', project,
      '--drain', '--no-ack', '--simulate', fixture, ...flags], { cwd: sandbox, env: cliEnv, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result;
  }
  await listen('beta', [dm(60, 'Held alpha correction'), dm(61, '/activate synthetic-beta-code')]);
  registry = JSON.parse(await readFile(join(cliHub, 'projects.json'), 'utf8'));
  assert.equal(registry.singleActivation.pending, false);
  assert.equal((await state(cliBridge)).events[cliBot + ':60'], undefined);
  registry.default = 'alpha';
  registry.singleActivation = { project: 'alpha', previous: 'beta', pending: true, code: 'synthetic-alpha-code' };
  await atomic(join(cliHub, 'projects.json'), registry);
  await listen('alpha', [dm(62, '/activate synthetic-alpha-code')]);
  await listen('alpha', [], ['--bridge-receiver']);
  const replayed = await state(cliBridge);
  assert.equal(replayed.events[cliBot + ':60'].text, 'Held alpha correction');
  assert.deepEqual(Object.keys(replayed.events), [cliBot + ':60']);
  const consumer = JSON.parse(await readFile(join(cliInbox('alpha'), 'state.json'), 'utf8'));
  assert.equal(consumer.cursor, (await readFile(join(cliInbox('alpha'), 'queue.jsonl'))).length);
  console.log('PASS  listener CLI preserves held correction through alpha → beta → alpha activation and receiver restart');
} finally { await rm(sandbox, { recursive: true, force: true }); }
