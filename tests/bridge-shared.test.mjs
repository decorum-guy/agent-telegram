// Общий транспорт и изоляция диалогов. Telegram и runtime Codex здесь имитируются.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { atomic, state, register, ingest, question, ack, codexStep, importInbox,
  projectContext, projectStateHub, verifyRoute, supervisedProjects, holdConsumer } from '../tg-bridge.mjs';

const sandbox = await mkdtemp(join(tmpdir(), 'tg-shared-bridge-'));
const transportHub = join(sandbox, 'shared hub');
const previousRoot = process.env.TG_BRIDGE_HOME;
const previousToken = process.env.TG_BOT_TOKEN, previousOwner = process.env.TG_CHAT_ID;
process.env.TG_BRIDGE_HOME = join(sandbox, 'integration-test');
delete process.env.TG_BOT_TOKEN;
delete process.env.TG_CHAT_ID;
let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.message}`); }
}
try {
  await mkdir(join(transportHub, '.secrets'), { recursive: true });
  await writeFile(join(transportHub, '.secrets/telegram.env'), 'TG_BOT_TOKEN=9:sandbox\nTG_CHAT_ID=123\n');
  const projects = {};
  for (const [project, topic] of [['alpha', 11], ['bravo', 22]]) {
    const cwd = join(sandbox, project); await mkdir(cwd);
    await atomic(join(cwd, '.agent-telegram.json'), { project, tag: '#' + project });
    projects[project] = { tag: '#' + project, mode: 'topic', topic, inbox: join(transportHub, 'inbox', project),
      privateChat: { bot_id: '9', chat_id: '123' } };
  }
  const registry = { version: 2, mode: 'parallel', default: 'alpha',
    group: { chat_id: '-123', forum: true, topics: {} }, projects };
  const save = () => atomic(join(transportHub, 'projects.json'), registry);
  await save();
  const alpha = await projectContext('alpha', join(sandbox, 'alpha'), transportHub);
  const bravo = await projectContext('bravo', join(sandbox, 'bravo'), transportHub);
  const aSession = { id: randomUUID(), client: 'codex-cli', cwd: alpha.cwd, endpoint: '/tmp/mock-codex-a', unverified: false };
  const bSession = { id: randomUUID(), client: 'codex-cli', cwd: bravo.cwd, endpoint: '/tmp/mock-codex-b', unverified: false };
  const incoming = (ctx, update, text, extra = {}) => ({ update_id: update, message: {
    message_id: update, chat: { id: Number(ctx.chat) }, message_thread_id: ctx.topic, text, ...extra
  } });

  await test('shared bot contexts separate transport paths and project journals', async () => {
    assert.equal(alpha.bot, '9'); assert.equal(bravo.bot, '9');
    assert.equal(alpha.transportHub, transportHub); assert.equal(bravo.transportHub, transportHub);
    assert.equal(alpha.hub, resolve(transportHub, 'projects/alpha'));
    assert.equal(bravo.hub, resolve(transportHub, 'projects/bravo'));
    assert.notEqual(alpha.hub, bravo.hub);
    assert.throws(() => projectStateHub(transportHub, '../outside'));
    await register(alpha, aSession); await register(bravo, bSession);
    assert.equal((await state(alpha.hub)).active, aSession.id);
    assert.equal((await state(bravo.hub)).active, bSession.id);
    await assert.rejects(register(bravo, { ...aSession, cwd: bravo.cwd }), /другим проектом/);
  });

  await test('per-process environment cannot select another bot or owner over shared credentials', async () => {
    try {
      process.env.TG_BOT_TOKEN = '88:sandbox';
      await assert.rejects(projectContext('alpha', alpha.cwd, transportHub), /не совпадают/);
      delete process.env.TG_BOT_TOKEN;
      process.env.TG_CHAT_ID = '456';
      await assert.rejects(projectContext('alpha', alpha.cwd, transportHub), /не совпадают/);
    } finally { delete process.env.TG_BOT_TOKEN; delete process.env.TG_CHAT_ID; }
  });

  let aEvent, bEvent;
  await test('two projects keep distinct incoming events and question ownership', async () => {
    await question(alpha.hub, '9', { chat_id: '-123' }, 100, aSession.id, 'Вопрос alpha');
    aEvent = await ingest(alpha.hub, '9', incoming(alpha, 1, 'Правка alpha'));
    bEvent = await ingest(bravo.hub, '9', incoming(bravo, 2, 'Правка bravo', { reply_to_message: { message_id: 100 } }));
    assert.equal(aEvent.session, aSession.id); assert.equal(bEvent.session, bSession.id);
    assert.equal(bEvent.question, null);
    assert.deepEqual(Object.keys((await state(alpha.hub)).events), ['9:1']);
    assert.deepEqual(Object.keys((await state(bravo.hub)).events), ['9:2']);
  });

  await test('shared-bot messages reach only the matching simulated Codex runtime', async () => {
    for (const [ctx, binding, event, text] of [[alpha, aSession, aEvent, 'Правка alpha'], [bravo, bSession, bEvent, 'Правка bravo']]) {
      const sent = [];
      const rpc = { subscribedThread: binding.id, call: async (method, params) => {
        assert.equal(params.threadId, binding.id);
        if (method === 'thread/read') return { thread: { id: binding.id, cwd: ctx.cwd, status: { type: 'idle' }, turns: [] } };
        if (method === 'thread/queue/list') return { data: [] };
        assert.equal(method, 'thread/queue/add');
        sent.push(params.input[0].text);
        return { queuedSubmission: { id: ctx.project + '-queue', clientUserMessageId: params.clientUserMessageId } };
      } };
      await codexStep(ctx, rpc);
      assert.equal(sent.length, 1); assert.ok(sent[0].includes(text));
      assert.equal((await state(ctx.hub)).events[event.id].queueId, ctx.project + '-queue');
    }
    await assert.rejects(ack(bravo.hub, aEvent.id, aEvent.receipt, aSession.id, alpha.cwd), /ACK/);
    await ack(alpha.hub, aEvent.id, aEvent.receipt, aSession.id, alpha.cwd);
    assert.equal((await state(alpha.hub)).events[aEvent.id].status, 'acked');
    assert.equal((await state(bravo.hub)).events[bEvent.id].status, 'sent');
  });

  await test('supervisor selects enabled shared-registry projects and drops removed ones', async () => {
    assert.deepEqual((await supervisedProjects(transportHub)).map(ctx => ctx.project).sort(), ['alpha', 'bravo']);
    await state(bravo.hub, d => { d.enabled = false; });
    assert.deepEqual((await supervisedProjects(transportHub)).map(ctx => ctx.project), ['alpha']);
    await state(bravo.hub, d => { d.enabled = true; });
    const removed = registry.projects.bravo; delete registry.projects.bravo; await save();
    assert.deepEqual((await supervisedProjects(transportHub)).map(ctx => ctx.project), ['alpha']);
    registry.projects.bravo = removed; await save();
  });

  await test('single activation prevents stale parallel and inactive runtimes from dispatching', async () => {
    registry.mode = 'single'; registry.default = 'bravo';
    registry.projects.alpha.mode = registry.projects.bravo.mode = 'private'; await save();
    await assert.rejects(verifyRoute(alpha), /не активен/);
    await assert.rejects(verifyRoute(bravo), /изменился/);
    const currentA = await projectContext('alpha', alpha.cwd, transportHub);
    const currentB = await projectContext('bravo', bravo.cwd, transportHub);
    assert.equal(currentB.chat, '123'); assert.equal(currentB.topic, null); assert.equal(currentB.mode, 'private');
    await verifyRoute(currentB);
    await assert.rejects(codexStep(currentB, { call: () => assert.fail('Stale binding reached runtime') }), /Привязка диалога/);
    await assert.rejects(codexStep(currentA, { call: () => assert.fail('Inactive project reached runtime') }), /не активен/);
    assert.deepEqual((await supervisedProjects(transportHub)).map(ctx => ctx.project), ['bravo']);
    registry.mode = 'parallel'; registry.default = 'alpha';
    registry.projects.alpha.mode = registry.projects.bravo.mode = 'topic'; await save();
  });

  await test('journal import checks shared transport bot identity before accepting old queue', async () => {
    const inbox = join(sandbox, 'old-inbox'); await mkdir(inbox);
    await writeFile(join(inbox, 'queue.jsonl'), JSON.stringify(incoming(alpha, 333, 'Старое сообщение')) + '\n');
    await atomic(join(transportHub, 'offset.json'), { bot: '88', offset: 1 });
    await importInbox(projectStateHub(transportHub, 'import-test'), '9', inbox, transportHub);
    assert.deepEqual(Object.keys((await state(projectStateHub(transportHub, 'import-test'))).events), []);
  });

  await test('pending single activation never registers or dispatches a native runtime', async () => {
    registry.mode = 'single'; registry.default = 'alpha';
    registry.projects.alpha.mode = registry.projects.bravo.mode = 'private';
    registry.singleActivation = { project: 'alpha', previous: 'bravo', code: 'fixture-activation', pending: true };
    await save();
    const pending = await projectContext('alpha', alpha.cwd, transportHub);
    assert.equal(pending.activationPending, true);
    assert.deepEqual(await supervisedProjects(transportHub), []);
    await assert.rejects(verifyRoute(pending), /Активация single/);
    await assert.rejects(register(pending, aSession), /Активация single/);
    await assert.rejects(codexStep(pending, { call: () => assert.fail('Pending activation reached runtime') }), /Активация single/);
    registry.mode = 'parallel'; registry.default = 'alpha';
    registry.projects.alpha.mode = registry.projects.bravo.mode = 'topic';
    delete registry.singleActivation; await save();
  });

  await test('consumer exclusion is atomic per inbox and independent across projects', async () => {
    const releaseAlpha = await holdConsumer(projects.alpha.inbox);
    let releaseBravo;
    try {
      await assert.rejects(holdConsumer(projects.alpha.inbox), { code: 'EADDRINUSE' });
      releaseBravo = await holdConsumer(projects.bravo.inbox);
    } finally { await releaseBravo?.(); await releaseAlpha(); }
    const reacquired = await holdConsumer(projects.alpha.inbox); await reacquired();
  });
} finally {
  for (const [name, value] of [['TG_BRIDGE_HOME', previousRoot], ['TG_BOT_TOKEN', previousToken], ['TG_CHAT_ID', previousOwner]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await rm(sandbox, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
