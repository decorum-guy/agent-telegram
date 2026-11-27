import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { atomic, state, register, registerAppQueue, ingest, ack, feedback, question, codexStep, dispatch, claudeHook, monitorStep, claudeBackground, releaseSession, integrationFiles, serviceFile, importInbox, holdBot, projectStateHub, monitorOwner, canOpenThread, hookThread } from '../tg-bridge.mjs';

const hub = await mkdtemp(join(tmpdir(), 'tg-bridge-'));
process.env.TG_BRIDGE_HOME = join(hub, 'integration-test');
const ctx = { hub, project: 'test-bridge', cwd: hub, chat: '-123', topic: 8 };
const session = { id: randomUUID(), client: 'codex-cli', cwd: hub, endpoint: '/tmp/test-socket' };
try {
  {
    const fs = (await import('node:fs/promises')).default;
    const { syncBuiltinESMExports } = await import('node:module');
    const original = fs.rename, platform = Object.getOwnPropertyDescriptor(process, 'platform');
    const journal = join(hub, 'busy-journal.json');
    await atomic(journal, { value: 'old' });
    const attempts = [];
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      fs.rename = async (tmp, target) => {
        attempts.push(tmp);
        if (attempts.length === 1) {
          assert.deepEqual(JSON.parse(await readFile(target)), { value: 'old' });
          throw Object.assign(Error('Файл занят читателем'), { code: 'EPERM' });
        }
        return original(tmp, target);
      };
      syncBuiltinESMExports();
      await atomic(journal, { value: 'new' });
    } finally {
      fs.rename = original; syncBuiltinESMExports();
      Object.defineProperty(process, 'platform', platform);
    }
    assert.equal(attempts.length, 2); assert.equal(attempts[0], attempts[1]);
    assert.deepEqual(JSON.parse(await readFile(journal)), { value: 'new' });
    console.log('PASS  при занятом файле Windows повторяется только атомарная замена того же журнала');
  }
  {
    // Проходим через публичные команды. Подмены принимают только контракт этого TUI и runtime.
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath, pathToFileURL } = await import('node:url');
    const dir = join(await realpath(hub), 'cli-project'); await mkdir(dir);
    const fixture = { ...ctx, cwd: dir, hub: projectStateHub(dir, ctx.project), bot: '9' };
    const id = randomUUID(), endpoint = 'ws://127.0.0.1:1';
    const bridge = fileURLToPath(new URL('../tg-bridge.mjs', import.meta.url));
    const mock = join(dir, 'cli.mjs');
    await atomic(join(dir, 'projects.json'), { version: 2, mode: 'parallel', default: ctx.project, group: { chat_id: ctx.chat, forum: true }, projects: { [ctx.project]: { mode: 'topic', tag: '#test_bridge', topic: ctx.topic, inbox: dir } } });
    await writeFile(mock, String.raw`
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { EventEmitter } from 'node:events';
      import { appendFileSync } from 'node:fs';
      import assert from 'node:assert/strict';
      const id = process.env.FIXTURE_ID || ${JSON.stringify(id)}, endpoint = ${JSON.stringify(endpoint)};
      cp.spawn = (bin, args, opts) => {
        assert.equal(bin, process.env.TG_CODEX_BIN);
        assert.deepEqual(args, ['--remote', endpoint, 'resume', id]);
        assert.equal(opts.env.TG_MANAGED_CODEX_THREAD, id);
        assert.equal(opts.cwd, process.cwd());
        appendFileSync('opens', id + '\n');
        const tui = new EventEmitter(); queueMicrotask(() => tui.emit('close', 0)); return tui;
      };
      syncBuiltinESMExports();
      globalThis.WebSocket = class extends EventTarget {
        static OPEN = 1; readyState = 1;
        constructor(url) { super(); assert.equal(url, endpoint); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
        send(body) {
          const req = JSON.parse(body);
          if (req.method === 'initialized') return;
          let result = {};
          if (req.method === 'thread/start' || req.method === 'thread/read') {
            if (req.method === 'thread/read') assert.equal(req.params.threadId, id);
            else assert.equal(req.params.cwd, process.cwd());
            result.thread = { id, cwd: process.env.FIXTURE_CWD || process.cwd(), status: { type: 'idle' }, turns: [] };
          } else assert.equal(req.method, 'initialize');
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: req.id, result }) }));
        }
        close() {}
      };
    `);
    const env = { ...process.env, TG_CODEX_BIN: join(dir, 'fake-codex'), TG_CODEX_SOCKET: endpoint,
      TG_PROJECT: ctx.project, TG_HUB: dir, TG_BOT_TOKEN: '9:sandbox', CODEX_THREAD_ID: id };
    delete env.CLAUDE_CODE_SESSION_ID;
    const run = (args, extra) => spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, bridge, ...args],
      { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', timeout: 8000 });
    const ok = args => { const r = run(args); assert.equal(r.status, 0, r.stderr); return r.stdout; };
    const status = () => JSON.parse(ok(['status']));
    const openCLI = ['open', '--client', 'codex-cli'];
    const openLog = () => readFile(join(dir, 'opens'), 'utf8');
    ok(openCLI);
    assert.equal(status().active, id); assert.equal(status().cwd, dir);
    assert.equal(status().runtimeOwnerVerified, true);
    const incoming = (update_id, text) => ingest(fixture.hub, '9', { update_id, message: { message_id: update_id,
      chat: { id: Number(ctx.chat) }, message_thread_id: ctx.topic, text } });
    const runtime = { subscribedThread: id, call: async (method, p) => {
      assert.equal(p.threadId, id);
      if (method === 'thread/read') return { thread: { id, cwd: dir, status: { type: 'idle' }, turns: [] } };
      if (method === 'thread/queue/list') return { data: [] };
      if (method === 'thread/queue/add') return { queuedSubmission: { id: 'cli-entry', clientUserMessageId: p.clientUserMessageId } };
      if (method === 'thread/queue/start') return {};
      assert.fail(method);
    } };
    const step = () => codexStep(fixture, runtime);
    await incoming(1, '/pause'); await step();
    const row = await incoming(2, 'Тест CLI'); await step();
    assert.equal(status().paused, true); assert.equal((await state(fixture.hub)).events[row.id].status, 'waiting');
    await incoming(3, '/resume'); await step(); await step();
    assert.equal((await state(fixture.hub)).events[row.id].queueId, 'cli-entry'); assert.equal(status().acknowledged, false);
    assert.notEqual(run(['release', '--session', id]).status, 0);
    ok(['ack', row.id, row.receipt]); assert.equal(status().acknowledged, true);
    ok(openCLI); ok(['release', '--session', id]); assert.equal(status().active, null);
    assert.equal(await openLog(), (id + '\n').repeat(2));
    console.log('PASS  управляемый CLI: open → статус UUID/cwd → пауза → очередь → ACK → возврат в TUI → release на подменённом runtime');

    await register(fixture, { id, client: 'codex-cli', cwd: dir, endpoint, unverified: true });
    assert.equal(status().runtimeOwnerVerified, false);
    await releaseSession(fixture, id);
    const unsupported = run(['open', '--client', 'codex-app']);
    assert.notEqual(unsupported.status, 0); assert.match(unsupported.stderr, /codex-cli.*claude/);
    for (const args of [openCLI, ['register', '--client', 'codex-cli'], ['register', '--client', 'codex-app']]) {
      const refusedCheck = run([...args, '--check-only']);
      assert.notEqual(refusedCheck.status, 0); assert.match(refusedCheck.stderr, /--check-only доступен только/);
    }
    assert.equal(status().active, null);
    const wrong = run(openCLI, { FIXTURE_CWD: await realpath(hub) });
    assert.notEqual(wrong.status, 0); assert.equal(status().active, null);
    for (const unverified of [true, false]) {
      const appId = randomUUID();
      await register(fixture, { id: appId, client: 'codex-app', cwd: dir, endpoint, unverified });
      assert.equal(status().runtimeOwnerVerified, !unverified);
      const refused = run(openCLI, { FIXTURE_ID: appId });
      assert.notEqual(refused.status, 0); assert.match(refused.stderr, /Проект уже занят/);
      assert.equal(status().active, appId);
      await releaseSession(fixture, appId);
    }
    assert.equal(await openLog(), (id + '\n').repeat(2));
    console.log('PASS  CLI не открывает TUI для другого cwd или уже привязанного App');

    // Те же публичные команды без группы/топика; runtime и входящие полностью имитируются Node.
    const dmDir = join(await realpath(hub), 'private-project'); await mkdir(dmDir);
    const dmId = randomUUID(), dmProject = 'test-private';
    const dmCtx = { hub: projectStateHub(dmDir, dmProject), project: dmProject, cwd: dmDir, bot: '9', chat: '111', topic: null, mode: 'private' };
    const dmConfig = { project: dmProject, mode: 'private' };
    await atomic(join(dmDir, '.agent-telegram.json'), dmConfig);
    await atomic(join(dmDir, 'projects.json'), { version: 2, mode: 'single', default: dmProject, projects: { [dmProject]: {
      mode: 'private', tag: '#test_private', inbox: dmDir, privateChat: { chat_id: '111', bot_id: '9' }
    } } });
    const dmEnv = { ...env, TG_PROJECT: dmProject, TG_HUB: dmDir, TG_CHAT_ID: '111', FIXTURE_ID: dmId, CODEX_THREAD_ID: dmId };
    const dmRun = (args, extra) => spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, bridge, ...args],
      { cwd: dmDir, env: { ...dmEnv, ...extra }, encoding: 'utf8', timeout: 8000 });
    const dmOk = args => { const r = dmRun(args); assert.equal(r.status, 0, r.stderr); return r.stdout; };
    dmOk(openCLI);
    const dmStatus = JSON.parse(dmOk(['status'])), dmBinding = (await state(dmCtx.hub)).sessions[dmId];
    assert.equal(dmStatus.telegramMode, 'private'); assert.equal(dmStatus.active, dmId);
    assert.equal(dmBinding.chat, '111'); assert.equal(dmBinding.topic, null); assert.equal(dmBinding.cwd, dmDir);
    assert.notEqual(dmRun(['status'], { TG_CHAT_ID: '222' }).status, 0);
    assert.notEqual(dmRun(['status'], { TG_BOT_TOKEN: '8:other' }).status, 0);
    await atomic(join(dmDir, '.agent-telegram.json'), { ...dmConfig, mode: 'topic' });
    assert.notEqual(dmRun(['status']).status, 0);
    await atomic(join(dmDir, '.agent-telegram.json'), dmConfig);
    console.log('PASS  private: CLI регистрирует точный диалог без топика; другой владелец, бот и конфликт режима отклоняются');

    const dmInput = (n, text, extra = {}) => ({ update_id: n, message: { message_id: n, date: 1,
      from: { id: 111 }, chat: { id: 111, type: 'private' }, text, ...extra } });
    const dmUpdates = join(dmDir, 'updates.json');
    await atomic(dmUpdates, [dmInput(1, 'Входящее из лички'), dmInput(2, 'Чужой', { from: { id: 222 } }),
      dmInput(3, '#test_private', { chat: { id: -123, type: 'supergroup', is_forum: true }, message_thread_id: 8 })]);
    const receiver = spawnSync(process.execPath, [fileURLToPath(new URL('../tg-listen.mjs', import.meta.url)),
      '--bridge-receiver', '--drain', '--simulate', dmUpdates], { cwd: dmDir, env: dmEnv, encoding: 'utf8', timeout: 8000 });
    assert.equal(receiver.status, 0, receiver.stderr);
    let dmState = await state(dmCtx.hub);
    assert.deepEqual(Object.keys(dmState.events), ['9:1']);
    const dmRow = dmState.events['9:1']; assert.equal(dmRow.status, 'waiting'); assert.equal(dmRow.session, dmId);
    const reactions = [], api = async (method, body) => { reactions.push({ method, body }); return true; };
    await feedback(dmCtx.hub, '9', api);
    const dmRuntime = { subscribedThread: dmId, call: async (method, p) => {
      assert.equal(p.threadId, dmId);
      if (method === 'thread/read') return { thread: { id: dmId, cwd: dmDir, status: { type: 'idle' }, turns: [] } };
      if (method === 'thread/queue/list') return { data: [] };
      if (method === 'thread/queue/add') return { queuedSubmission: { id: 'private-' + p.clientUserMessageId, clientUserMessageId: p.clientUserMessageId } };
      if (method === 'turn/start') return { turn: { id: 'private-answer-turn' } };
      assert.fail(method);
    } };
    await codexStep(dmCtx, dmRuntime); await feedback(dmCtx.hub, '9', api);
    assert.equal((await state(dmCtx.hub)).events[dmRow.id].status, 'sent');
    assert.deepEqual(reactions.map(r => r.body.reaction?.[0]?.emoji), ['👍']);
    await assert.rejects(ack(dmCtx.hub, dmRow.id, dmRow.receipt, id, dmDir), /ACK/);
    dmOk(['ack', dmRow.id, dmRow.receipt]); await feedback(dmCtx.hub, '9', api);
    assert.deepEqual(reactions.map(r => r.body.reaction?.[0]?.emoji), ['👍', '👀']);
    assert.ok(reactions.every(r => r.body.chat_id === 111 && !('message_thread_id' in r.body)));
    console.log('PASS  private: приемник → native queue точного Codex → явный ACK; 👍 предшествует 👀, чужие входящие не сохраняются');

    await question(dmCtx.hub, '9', { chat_id: '111' }, 20, dmId, 'Личный вопрос');
    const answer = await ingest(dmCtx.hub, '9', { ...dmInput(20, 'Личный вопрос'), why: 'button', button: 'Да' });
    assert.equal(answer.mode, 'answer'); assert.equal(answer.session, dmId); assert.equal(answer.status, 'waiting');
    await feedback(dmCtx.hub, '9', api);
    await codexStep(dmCtx, dmRuntime); dmOk(['ack', answer.id, answer.receipt]); await feedback(dmCtx.hub, '9', api);
    assert.ok(reactions.some(r => r.method === 'editMessageText' && r.body.chat_id === 111 && r.body.message_id === 20 && r.body.text.includes('Ответ принят агентом')));
    dmOk(['release', '--session', dmId]);
    console.log('PASS  private: ответ кнопкой адресован исходному вопросу и получает подтверждение после ACK');

    const dmClaude = randomUUID(), dmHook = { session_id: dmClaude, cwd: dmDir, hook_event_name: 'SessionStart' };
    await claudeHook(dmCtx, dmHook, dmClaude);
    const claudeRow = await ingest(dmCtx.hub, '9', dmInput(30, 'Личное сообщение Claude'));
    const dmOutput = [];
    await monitorStep(dmCtx, dmClaude, async t => dmOutput.push(JSON.parse(t)), async () =>
      [{ kind: 'interactive', sessionId: dmClaude, cwd: dmDir, pid: process.pid, status: 'idle' }]);
    assert.equal(dmOutput[0].delivery_id, claudeRow.id); assert.equal(dmOutput[0].session_id, dmClaude);
    await claudeHook(dmCtx, { ...dmHook, hook_event_name: 'Stop', last_assistant_message: 'TG_ACK ' + claudeRow.id + ' ' + claudeRow.receipt }, dmClaude);
    assert.equal((await state(dmCtx.hub)).events[claudeRow.id].status, 'acked');
    await claudeHook(dmCtx, { ...dmHook, hook_event_name: 'SessionEnd' }, dmClaude);
    await releaseSession(dmCtx, dmClaude);
    console.log('PASS  private: общий маршрут Claude и явный ACK проверены Node-фикстурой без запуска клиента');
  }
  await register(ctx, session);
  await Promise.all(Array.from({ length: 12 }, () => state(hub, d => { d.count = (d.count || 0) + 1; })));
  assert.equal((await state(hub)).count, 12);
  await assert.rejects(register(ctx, { ...session, id: randomUUID() }), /владелец/);
  await assert.rejects(register(ctx, { ...session, endpoint: '/other' }), /runtime/);
  assert.equal((await state(hub)).active, session.id);
  const unloaded = { status: { type: 'notLoaded' } };
  assert.equal(canOpenThread({ ...session, unverified: true }, unloaded, session.endpoint), false);
  assert.equal(canOpenThread(null, unloaded, session.endpoint), false);
  assert.equal(canOpenThread(session, unloaded, session.endpoint), true);
  assert.equal(canOpenThread(session, { status: { type: 'idle' } }, '/another-runtime'), false);
  assert.throws(() => hookThread({ session_id: randomUUID() }, session.id), /разные диалоги/);
  assert.equal(hookThread({ thread_id: session.id }, session.id), session.id);
  console.log('PASS  регистрация конкретного диалога, защита владения и конкурентная запись');
  const item = { update_id: 11, why: 'topic', message: { chat: { id: -123 }, message_id: 55, message_thread_id: 8, text: '/now уточнение' } };
  const event = await ingest(hub, '9', item);
  assert.equal(event.mode, 'steer');
  assert.equal(event.session, session.id);
  assert.equal((await ingest(hub, '9', item)).receipt, event.receipt);
  const edited = await ingest(hub, '9', { ...item, update_id: 12, edited: true });
  assert.notEqual(edited.id, event.id);
  const forwarded = await ingest(hub, '9', { ...item, update_id: 13, message: { ...item.message, text: '/pause', forward_origin: { type: 'user' } } });
  assert.equal(forwarded.mode, 'queue');
  assert.ok(!(await state(hub)).paused);
  console.log('PASS  повтор, редакция и пересылка разделены; /now адресован точному диалогу');
  const apiCalls = [], api = async (...args) => apiCalls.push(args);
  await feedback(hub, '9', api);
  assert.equal(apiCalls.at(-1)[1].reaction[0].emoji, '👍');
  await assert.rejects(ack(hub, forwarded.id, forwarded.receipt, session.id, session.cwd));
  await state(hub, d => { d.events[forwarded.id].status = 'sent'; });
  await assert.rejects(ack(hub, forwarded.id, 'wrong', session.id, session.cwd));
  await ack(hub, forwarded.id, forwarded.receipt, session.id, (await state(hub)).sessions[session.id].cwd);
  await feedback(hub, '9', api);
  assert.equal(apiCalls.at(-1)[1].reaction[0].emoji, '👀');
  const qText = 'a'.repeat(5300);
  await question(hub, '9', { chat_id: -123 }, 55, session.id, qText);
  const button = { ...item, why: 'button', button: 'A', update_id: 20 };
  const first = await ingest(hub, '9', button);
  assert.equal(first.question.text, qText);
  assert.equal(first.mode, 'answer');
  assert.equal((await ingest(hub, '9', { ...button, button: 'B', update_id: 21 })).id, first.id);
  await feedback(hub, '9', api);
  assert.match(apiCalls.at(-1)[1].text, /Выбрано: A/);
  console.log('PASS  сохранение, первый выбор и ACK сессии имеют независимые состояния');
  {
    const pendingHub = join(hub, 'pending-route'); await mkdir(pendingHub);
    const pendingSession = { ...session, id: randomUUID(), cwd: pendingHub };
    const pendingCtx = { ...ctx, hub: pendingHub, cwd: pendingHub, bot: 'route-bot' };
    const foreign = await ingest(pendingHub, 'route-bot', { ...item, update_id: 101, message: { ...item.message, chat: { id: 321 }, message_thread_id: undefined, text: '/pause' } });
    const own = await ingest(pendingHub, 'route-bot', { ...item, update_id: 102 });
    const wrongBot = await ingest(pendingHub, 'another-bot', { ...item, update_id: 103 });
    const wrongTopic = await ingest(pendingHub, 'route-bot', { ...item, update_id: 105, message: { ...item.message, message_thread_id: 99 } });
    assert.ok(!(await state(pendingHub)).paused);
    await register(pendingCtx, pendingSession);
    const bound = await state(pendingHub);
    assert.equal(bound.events[foreign.id].status, 'blocked');
    assert.equal(bound.events[wrongBot.id].status, 'blocked');
    assert.equal(bound.events[wrongTopic.id].status, 'blocked');
    assert.equal(bound.events[own.id].status, 'waiting');
    assert.equal(bound.events[own.id].session, pendingSession.id);
    assert.ok(!bound.paused, 'Команда вне маршрута не должна менять очередь до регистрации');
    const after = await ingest(pendingHub, 'route-bot', { ...item, update_id: 104, message: { ...item.message, chat: { id: 321 }, message_thread_id: undefined, text: '/pause' } });
    assert.equal(bound.events[foreign.id].error, after.error);
    console.log('PASS  поздняя регистрация проверяет bot/chat/topic и не исполняет чужую команду');
  }
  {
    const statusHub = join(hub, 'status-isolation'); await mkdir(statusHub);
    const statusSession = { ...session, id: randomUUID(), cwd: statusHub };
    await register({ ...ctx, hub: statusHub }, statusSession);
    const broken = await ingest(statusHub, '9', { ...item, update_id: 201, message: { ...item.message, message_id: 201 } });
    const healthy = await ingest(statusHub, '9', { ...item, update_id: 202, message: { ...item.message, message_id: 202 } });
    const notices = [];
    await assert.rejects(feedback(statusHub, '9', async (method, body) => {
      notices.push({ method, body });
      if ((body.message_id || body.reply_parameters?.message_id) === 201)
        throw Object.assign(Error(method === 'setMessageReaction' ? 'message not found' : 'bot was blocked'), { code: method === 'setMessageReaction' ? 400 : 403 });
    }), /message not found.*bot was blocked/);
    const partial = await state(statusHub);
    assert.equal(partial.events[healthy.id].shown, 'saved');
    assert.equal(partial.events[broken.id].shown, undefined);
    assert.match(partial.events[broken.id].feedbackError.message, /message not found.*bot was blocked/);
    assert.ok(partial.events[broken.id].feedbackRetryAt > Date.now());
    assert.equal(notices.find(call => call.method === 'sendMessage').body.reply_parameters.allow_sending_without_reply, true);
    await state(statusHub, d => { d.events[broken.id].feedbackRetryAt = 0; });
    await feedback(statusHub, '9', async (method, body) => {
      if (method === 'setMessageReaction') throw Object.assign(Error('message not found'), { code: 400 });
      assert.equal(body.reply_parameters.allow_sending_without_reply, true);
    });
    assert.equal((await state(statusHub)).events[broken.id].feedbackError, undefined);
    const controlled = await ingest(statusHub, '9', { ...item, update_id: 203, message: { ...item.message, message_id: 203, text: '/stop' } });
    await state(statusHub, d => { Object.assign(d.events[controlled.id], { status: 'controlled', controlResult: 'Остановка запрошена' }); });
    const controlCalls = [], controlApi = async (method, body) => controlCalls.push({ method, body });
    await feedback(statusHub, '9', controlApi); await feedback(statusHub, '9', controlApi);
    assert.equal(controlCalls[0].body.reaction[0].emoji, '👍');
    assert.equal(controlCalls[1].method, 'sendMessage');
    assert.match(controlCalls[1].body.text, /Мост: Остановка запрошена/);
    assert.equal((await state(statusHub)).events[controlled.id].shown, 'controlled');
    await assert.rejects(ack(statusHub, controlled.id, controlled.receipt, statusSession.id, statusHub));
    console.log('PASS  ошибка одного статуса не блокирует остальные; fallback, retry и control без ложного ACK');
  }
  {
    const questionHub = join(hub, 'question-races'); await mkdir(questionHub);
    const questionSession = { ...session, id: randomUUID(), cwd: questionHub };
    await register({ ...ctx, hub: questionHub }, questionSession);
    const early = await ingest(questionHub, '9', { ...button, update_id: 301 });
    assert.equal(early.status, 'blocked');
    await question(questionHub, '9', { chat_id: -123 }, 55, questionSession.id, 'Первый вопрос');
    assert.equal((await state(questionHub)).events[early.id].status, 'waiting');
    await state(questionHub, d => { d.questions['9:-123:55'].closed = true; });
    await question(questionHub, '9', { chat_id: -123 }, 55, questionSession.id, 'Повтор');
    assert.equal((await state(questionHub)).questions['9:-123:55'].closed, true);
    assert.equal((await state(questionHub)).questions['9:-123:55'].text, 'Первый вопрос');
    const reply = { ...item, update_id: 302, hydrating: true, message: { ...item.message, message_id: 302, text: 'Ответ с файлом', reply_to_message: { message_id: 300 } } };
    const pending = await ingest(questionHub, '9', reply);
    assert.equal(pending.status, 'hydrating');
    assert.equal(pending.source.message.reply_to_message.message_id, 300);
    await question(questionHub, '9', { chat_id: -123 }, 300, questionSession.id, 'Поздно записанный вопрос');
    assert.equal((await state(questionHub)).events[pending.id].status, 'hydrating');
    const ready = await ingest(questionHub, '9', { ...reply, hydrating: false, attachments: [{ type: 'document', file: '/fixture/ready' }] });
    assert.equal(ready.status, 'waiting'); assert.equal(ready.receipt, pending.receipt);
    assert.equal(ready.source, undefined);
    assert.equal((await ingest(questionHub, '9', { ...reply, hydrating: false, attachments: [] })).attachments[0].file, '/fixture/ready');
    const revoked = await ingest(questionHub, '9', { ...reply, update_id: 303 });
    await ingest(questionHub, '9', { ...item, update_id: 304, message: { ...item.message, text: '/revoke' } });
    const finished = await ingest(questionHub, '9', { ...reply, update_id: 303, hydrating: false, attachments: [] });
    assert.equal(finished.status, 'cancelled'); assert.equal(finished.receipt, revoked.receipt);
    const legacyInbox = join(questionHub, 'legacy-inbox'); await mkdir(legacyInbox);
    await writeFile(join(legacyInbox, 'queue.jsonl'), JSON.stringify({ ...item, update_id: 305, message: { ...item.message, photo: [{ file_id: 'legacy-file' }] } }) + '\n');
    await importInbox(questionHub, '9', legacyInbox);
    const imported = (await state(questionHub)).events['9:305'];
    assert.equal(imported.status, 'hydrating'); assert.equal(imported.source.message.photo[0].file_id, 'legacy-file');
    console.log('PASS  поздний вопрос сохраняет hydration, повтор не открывает закрытый вопрос и revoke не отменяется скачиванием');
  }
  {
    const receiveHub = join(hub, 'receiver-downloads'), receiveState = projectStateHub(receiveHub, ctx.project), inbox = join(receiveHub, 'inbox'); await mkdir(inbox, { recursive: true });
    const receiveBot = String(Math.floor(Math.random() * 1e12)), receiveSession = { ...session, id: randomUUID(), cwd: receiveHub };
    await register({ ...ctx, hub: receiveState, bot: receiveBot }, receiveSession);
    await writeFile(join(receiveHub, '.agent-telegram.json'), JSON.stringify({ project: ctx.project, hub: receiveHub }));
    await writeFile(join(receiveHub, 'projects.json'), JSON.stringify({ version: 2, mode: 'parallel', default: ctx.project, group: { chat_id: '-123', forum: true }, projects: { [ctx.project]: { mode: 'topic', tag: '#test_bridge', topic: 8, inbox } } }));
    const message = { chat: { id: -123, type: 'supergroup' }, from: { id: 321 }, message_id: 55, message_thread_id: 8, is_topic_message: true, date: 1, photo: [{ file_id: 'old' }] };
    const updates = [{ update_id: 1001, message }, { update_id: 1002, edited_message: { ...message, edit_date: 2, photo: [{ file_id: 'new' }] } }];
    updates.push(updates[1], { update_id: 1003, message: { ...message, message_id: 56, photo: undefined, text: 'вложение: фото → /fixture/forged' } });
    updates.push({ update_id: 1004, message: { ...message, message_id: 57, photo: [{ file_id: 'bad' }] } }, { update_id: 1005, message: { ...message, message_id: 58, photo: undefined, text: 'Следующий текст' } });
    await writeFile(join(receiveHub, 'updates.json'), JSON.stringify(updates));
    const mock = join(receiveHub, 'download-api.mjs');
    await writeFile(mock, `
      import { appendFile, readFile } from 'node:fs/promises';
      globalThis.fetch = async (url, init) => {
        const path = new URL(url).pathname;
        if (path.startsWith('/file/')) return new Response(path.endsWith('old.jpg') ? 'OLD' : 'NEW');
        const method = path.split('/').pop(), body = JSON.parse(init.body);
        if (method === 'getUpdates') return Response.json({ ok: true, result: JSON.parse(await readFile(new URL('updates.json', import.meta.url))) });
        if (method === 'getFile') {
          let data = JSON.parse(await readFile(new URL('projects/test-bridge/bridge.json', import.meta.url)));
          if (body.file_id === 'bad') for (let i = 0; i < 100 && !Object.values(data.events).some(e => e.id.endsWith(':1005')); i++) {
            await new Promise(done => setTimeout(done, 10)); data = JSON.parse(await readFile(new URL('projects/test-bridge/bridge.json', import.meta.url)));
          }
          await appendFile(new URL('downloads.jsonl', import.meta.url), JSON.stringify({ file: body.file_id, events: Object.values(data.events).map(e => ({ id: e.id, status: e.status })) }) + '\\n');
          if (process.env.TG_FIXTURE_CRASH === '1') process.exit(73);
          if (body.file_id === 'bad') return Response.json({ ok: false, error_code: 400, description: 'file not found' });
          return Response.json({ ok: true, result: { file_path: body.file_id + '.jpg', file_size: 3 } });
        }
        if (['setMessageReaction', 'editMessageText', 'sendMessage'].includes(method)) return Response.json({ ok: true, result: true });
        throw Error('Unexpected fixture API: ' + method);
      };
    `);
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath, pathToFileURL } = await import('node:url');
    const env = { ...process.env, TG_PROJECT: ctx.project, TG_HUB: receiveHub, TG_BOT_TOKEN: receiveBot + ':sandbox', TG_CHAT_ID: '321' };
    const runReceiver = extra => spawnSync(process.execPath, ['--import', pathToFileURL(mock).href, fileURLToPath(new URL('../tg-listen.mjs', import.meta.url)), '--bridge-receiver', '--drain'], { cwd: receiveHub, env: { ...env, ...extra }, encoding: 'utf8', timeout: 8000 });
    const crash = runReceiver({ TG_FIXTURE_CRASH: '1' }); assert.equal(crash.status, 73, crash.stderr);
    const interrupted = (await state(receiveState)).events[receiveBot + ':1001'];
    assert.equal(interrupted.status, 'hydrating');
    await writeFile(join(receiveHub, 'updates.json'), JSON.stringify(updates.slice(1)));
    const completed = runReceiver({ TG_FIXTURE_CRASH: '0' }); assert.equal(completed.status, 0, completed.stderr || completed.error?.message);
    const received = await state(receiveState), original = received.events[receiveBot + ':1001'], revision = received.events[receiveBot + ':1002'];
    assert.equal(original.receipt, interrupted.receipt); assert.equal(original.status, 'waiting');
    assert.notEqual(original.attachments[0].file, revision.attachments[0].file);
    assert.equal(await readFile(original.attachments[0].file, 'utf8'), 'OLD');
    assert.equal(await readFile(revision.attachments[0].file, 'utf8'), 'NEW');
    assert.deepEqual(received.events[receiveBot + ':1003'].attachments, []);
    assert.equal(received.events[receiveBot + ':1004'].status, 'blocked');
    assert.match(received.events[receiveBot + ':1004'].error, /Не удалось скачать/);
    assert.equal(received.events[receiveBot + ':1004'].source.message.photo[0].file_id, 'bad');
    assert.equal(received.events[receiveBot + ':1005'].status, 'waiting');
    const downloads = (await readFile(join(receiveHub, 'downloads.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(downloads.length, 4, 'Готовый повтор обновления не должен снова скачивать файл');
    assert.ok(downloads.every(row => row.events.find(e => e.id.endsWith(':' + ({ old: 1001, new: 1002, bad: 1004 }[row.file]))).status === 'hydrating'), 'Входящее должно быть durable до getFile');
    assert.equal(downloads.find(row => row.file === 'bad').events.find(e => e.id.endsWith(':1005'))?.status, 'waiting', 'Текст должен сохраниться, пока предыдущее скачивание ещё ждёт');
    console.log('PASS  receiver восстанавливает media без redelivery, не заменяет файлы и принимает текст во время сбоя download');
  }
  await state(hub, d => { for (const e of Object.values(d.events)) e.status = 'acked'; });
  const fresh = await ingest(hub, '9', { ...item, update_id: 29, message: { ...item.message, text: 'Первое входящее' } });
  const firstCalls = [];
  await codexStep(ctx, { call: async (method, p) => {
    firstCalls.push(method);
    if (method === 'thread/read' && p.includeTurns) throw Error('not materialized yet; includeTurns is unavailable before first user message');
    if (method === 'thread/read') return { thread: { id: session.id, cwd: hub, status: { type: 'idle' } } };
    if (method === 'thread/queue/list') return { data: [] };
    if (method === 'thread/queue/add') return { queuedSubmission: { id: 'first-entry', clientUserMessageId: p.clientUserMessageId } };
    throw Error('У нового диалога ещё нет истории для ' + method);
  } });
  assert.equal((await state(hub)).events[fresh.id].queueId, 'first-entry');
  assert.deepEqual(firstCalls, ['thread/read', 'thread/read', 'thread/queue/list', 'thread/queue/add']);
  await state(hub, d => { d.events[fresh.id].status = 'acked'; });
  console.log('PASS  первое входящее в новый диалог попадает в native queue до появления истории');
  {
    const pinHub = join(hub, 'test-model-pin'); await mkdir(pinHub);
    const pinSession = { ...session, id: randomUUID(), cwd: pinHub, testPolicy: { model: 'gpt-6-luna', reasoningEffort: 'low' } };
    const pinCtx = { ...ctx, hub: pinHub, cwd: pinHub };
    await register(pinCtx, pinSession);
    let loaded = false, expectedPin = true;
    const calls = [], reply = { model: 'gpt-6-luna', reasoningEffort: 'low' };
    const pinRPC = { call: async (method, params) => {
      calls.push([method, params]);
      if (method === 'thread/read') return { thread: { id: pinSession.id, cwd: pinHub, status: { type: loaded ? 'idle' : 'notLoaded' }, turns: [] } };
      if (method === 'thread/resume') {
        assert.equal(params.model, expectedPin ? 'gpt-6-luna' : undefined);
        assert.deepEqual(params.config, expectedPin ? { model_reasoning_effort: 'low',
          'agents.enabled': false, 'features.multi_agent': false, 'features.multi_agent_v2': false } : undefined);
        loaded = true; return { thread: { id: pinSession.id, cwd: pinHub }, ...reply };
      }
      if (method === 'thread/queue/list') return { data: [] };
      if (method === 'thread/queue/add') return { queuedSubmission: { id: 'pin-queue', clientUserMessageId: params.clientUserMessageId } };
      if (method === 'turn/start') return { turn: { id: 'pin-turn' } };
      throw Error('Неожиданный pin RPC: ' + method);
    } };
    const pending = await ingest(pinHub, '9', { ...item, update_id: 290, message: { ...item.message, text: 'Cold resume' } });
    await codexStep(pinCtx, pinRPC);
    assert.equal((await state(pinHub)).events[pending.id].status, 'sent');
    await state(pinHub, d => { d.events[pending.id].status = 'acked'; });
    const urgent = await ingest(pinHub, '9', { ...item, update_id: 291 });
    await codexStep(pinCtx, pinRPC);
    assert.equal(calls.at(-1)[0], 'turn/start');
    assert.equal(calls.at(-1)[1].model, 'gpt-6-luna'); assert.equal(calls.at(-1)[1].effort, 'low');
    await state(pinHub, d => { d.events[urgent.id].status = 'acked'; });
    const refused = await ingest(pinHub, '9', { ...item, update_id: 292, message: { ...item.message, text: 'Неверная модель' } });
    for (const response of [{ model: 'gpt-6.2-astra', reasoningEffort: 'low' }, { model: 'gpt-6-luna', reasoningEffort: 'high' }, {}]) {
      delete reply.model; delete reply.reasoningEffort; Object.assign(reply, response);
      loaded = false; pinRPC.subscribedThread = null; calls.length = 0;
      await assert.rejects(codexStep(pinCtx, pinRPC), /не подтвердил тестовую модель/);
      assert.ok(!calls.some(([method]) => ['thread/queue/add', 'thread/queue/start', 'turn/start', 'turn/steer'].includes(method)));
      assert.equal((await state(pinHub)).events[refused.id].status, 'waiting');
    }
    expectedPin = false;
    await state(pinHub, d => { delete d.sessions[pinSession.id].testPolicy; d.events[refused.id].status = 'acked'; });
    await ingest(pinHub, '9', { ...item, update_id: 293 });
    await codexStep(pinCtx, pinRPC);
    assert.equal(calls.at(-1)[0], 'turn/start');
    assert.equal(calls.at(-1)[1].model, undefined); assert.equal(calls.at(-1)[1].effort, undefined);
    console.log('PASS  testPolicy закрепляет Luna/low при resume и start, отклоняет mismatch и не меняет рабочие модели');
  }
  {
    const { LIVE_POLICY, parseLiveArgs, requireLiveModel, createLiveManifest, reserveLiveInput, startLiveThread,
      cleanupLiveRun, assertCleanupRunnerStopped, acquireLiveRunLock } = await import('./codex-live.test.mjs');
    const runnerRoot = join(hub, 'runner-safety'); await mkdir(runnerRoot);
    const makeRun = async count => {
      const dir = await realpath(await mkdtemp(join(runnerRoot, 'run-')));
      return { kind: 'agent-telegram-codex-live', version: 1, runId: randomUUID(), runnerPid: 99999999,
        dir, hub: join(dir, 'fixture'), integrationHome: join(dir, 'integration-test'), endpoint: join(dir, 'runtime.sock'), shared: false,
        ...LIVE_POLICY, startsRequested: count, submissions: 0, threads: Array.from({ length: count }, (_, i) => ({ id: randomUUID(), label: i ? 'B' : 'A', cwd: dir, source: 'appServer' })), processes: [] };
    };
    const noSave = async () => {};
    const mutation = method => ['thread/queue/delete', 'turn/interrupt', 'thread/backgroundTerminals/clean', 'thread/archive'].includes(method);
    // Fake server enforces the external contract: no archive while work remains, no background cleanup for unloaded threads.
    const fixture = (run, options = {}) => {
      const calls = [], flow = [], rows = new Map(run.threads.map((entry, i) => [entry.id, {
        id: entry.id, cwd: run.dir, loaded: !options.cold, active: i === 0, archived: false,
        queue: i === 0 ? [{ id: 'queued-' + entry.id, clientUserMessageId: 'fixture-receipt' }] : []
      }]));
      const rpc = { close: () => flow.push('close'), call: async (method, params) => {
        calls.push({ method, params }); flow.push(method + ':' + (params.threadId || ''));
        if (method === 'thread/list') {
          assert.equal(params.archived, true); assert.equal(params.cwd, run.dir);
          if (options.verifyError && [...rows.values()].some(r => r.archived)) throw Error('fixture archive verification unavailable');
          return { data: run.threads.filter(t => rows.get(t.id).archived && params.sourceKinds.includes(t.source)) };
        }
        if (method === 'thread/loaded/list') return { data: [...rows.values()].filter(r => r.loaded).map(r => r.id) };
        const row = rows.get(params.threadId);
        if (!row) throw Error('fixture unknown thread');
        if (method === 'thread/read') return { thread: {
          id: options.wrongId || row.id, cwd: options.wrongCwd || row.cwd, source: 'appServer',
          status: { type: !row.loaded ? 'notLoaded' : row.active ? 'active' : 'idle' },
          turns: row.active ? [{ id: 'turn-' + row.id, status: 'inProgress', items: [] }] : []
        } };
        if (method === 'thread/queue/list') return { data: [...row.queue] };
        if (method === 'thread/queue/delete') { row.queue = row.queue.filter(q => q.id !== params.queuedSubmissionId); return { deleted: true }; }
        if (method === 'turn/interrupt') { assert.equal(row.loaded, true); row.active = false; return {}; }
        if (method === 'thread/backgroundTerminals/clean') { assert.equal(row.loaded, true); return {}; }
        if (method === 'thread/archive') {
          assert.equal(row.queue.length, 0); assert.ok(!row.loaded || !row.active);
          if (options.failArchive === row.id) throw Error('fixture archive refused');
          row.archived = true; row.loaded = false; return {};
        }
        throw Error('Cleanup attempted forbidden RPC: ' + method);
      } };
      const cleanup = () => cleanupLiveRun(run, { save: noSave,
        disable: async () => { flow.push('disable'); if (options.disableError) throw Error('Чужой активный UUID'); },
        discover: async () => { flow.push('discover'); }, connect: async () => { flow.push('connect'); return rpc; },
        stopProcess: async p => { flow.push('stop-' + p.role); }
      });
      return { calls, flow, rows, cleanup };
    };

    const catalogCalls = [];
    for (const data of [[], [{ model: LIVE_POLICY.model, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }]]) {
      await assert.rejects(requireLiveModel({ call: async method => { catalogCalls.push(method); return { data }; } }), /отсутствует|поддержку low/);
    }
    assert.ok(catalogCalls.every(method => method === 'model/list'));
    const partial = await makeRun(0), creationCalls = [], saved = [];
    await assert.rejects(startLiveThread({ call: async (method, params) => {
      creationCalls.push(method); assert.equal(params.model, LIVE_POLICY.model); assert.equal(params.allowProviderModelFallback, false);
      assert.deepEqual(params.config, { model_reasoning_effort: 'low', 'agents.enabled': false, 'features.multi_agent': false, 'features.multi_agent_v2': false });
      return { thread: { id: randomUUID(), cwd: partial.dir, source: 'appServer' }, model: 'gpt-6.2-astra', reasoningEffort: 'low' };
    } }, partial, async () => { saved.push(structuredClone(partial)); }, { cwd: partial.dir }), /Модель теста не подтверждена/);
    assert.deepEqual(creationCalls, ['thread/start']); assert.equal(partial.threads.length, 1);
    assert.equal(saved.at(-1).threads[0].id, partial.threads[0].id);
    console.log('PASS  live safety: отсутствие Luna/low или неверная модель останавливает ввод и сохраняет UUID для cleanup');

    const legacy = await makeRun(0);
    await startLiveThread({ call: async () => ({
      thread: { id: randomUUID(), cwd: legacy.dir, source: 'vscode' }, ...LIVE_POLICY
    }) }, legacy, noSave, { cwd: legacy.dir });
    const legacyFixture = fixture(legacy);
    await legacyFixture.cleanup();
    assert.ok(legacy.threads[0].archivedAt);
    console.log('PASS  live safety: собственный диалог с источником vscode попадает в проверенный архив');

    const capped = await makeRun(0), manifest = join(capped.dir, 'run.json');
    await createLiveManifest(manifest, capped);
    let starts = 0;
    const starter = { call: async method => {
      assert.equal(method, 'thread/start'); starts++;
      return { thread: { id: randomUUID(), cwd: capped.dir, source: 'appServer' }, ...LIVE_POLICY };
    } };
    await startLiveThread(starter, capped, noSave, { cwd: capped.dir });
    await startLiveThread(starter, capped, noSave, { cwd: capped.dir });
    await assert.rejects(startLiveThread(starter, capped, noSave, {}), /дополнительные/);
    assert.equal(starts, 2);
    await assert.rejects(createLiveManifest(manifest, { ...capped, runId: randomUUID() }), { code: 'EEXIST' });
    assert.equal(JSON.parse(await readFile(manifest, 'utf8')).runId, capped.runId);
    for (let i = 0; i < 30; i++) await reserveLiveInput(capped, noSave);
    await assert.rejects(reserveLiveInput(capped, noSave), /лимит 30/);
    assert.throws(() => parseLiveArgs(['--live', '--manifest', manifest, '--matrix', '--recover']), /Один согласованный сценарий/);
    console.log('PASS  live safety: два thread/start, ограниченный ввод и один сценарий на непереиспользуемый manifest');

    const partialFixture = fixture(partial); await partialFixture.cleanup();
    assert.equal(partial.cleanup.status, 'complete'); assert.ok(partial.threads[0].archivedAt);
    const unknown = await makeRun(1); unknown.creationPending = 'B'; unknown.startsRequested = 2;
    const unknownFixture = fixture(unknown);
    await assert.rejects(unknownFixture.cleanup(), /UUID не получен/);
    assert.ok(unknown.threads[0].archivedAt); assert.equal(unknown.cleanup.status, 'blocked');
    assert.ok(!unknownFixture.calls.some(call => ['thread/start', 'thread/resume', 'thread/queue/add', 'turn/start'].includes(call.method)));
    console.log('PASS  live safety: partial setup архивирует известный A, неизвестный результат B остаётся blocked без новых диалогов');

    capped.processes = ['receiver', 'runtime'].map((role, i) => ({ role, pid: 900001 + i, cwd: capped.dir, endpoint: capped.endpoint }));
    const ordered = fixture(capped); await ordered.cleanup();
    assert.equal(capped.cleanup.status, 'complete'); assert.ok(capped.threads.every(t => t.archivedAt));
    const methods = ordered.calls.map(call => call.method);
    assert.ok(methods.indexOf('thread/queue/delete') < methods.indexOf('turn/interrupt'));
    assert.ok(methods.indexOf('turn/interrupt') < methods.indexOf('thread/archive'));
    for (const entry of capped.threads) assert.ok(ordered.calls.some(call => call.method === 'thread/archive' && call.params.threadId === entry.id));
    assert.ok(methods.lastIndexOf('thread/list') > methods.lastIndexOf('thread/archive'));
    assert.ok(methods.lastIndexOf('thread/loaded/list') > methods.lastIndexOf('thread/archive'));
    assert.ok(ordered.flow.indexOf('stop-receiver') < ordered.flow.indexOf('connect'));
    assert.ok(ordered.flow.indexOf('stop-runtime') > ordered.flow.indexOf('close'));
    console.log('PASS  live safety: cleanup удаляет очередь, прерывает ход, архивирует A/B и проверяет archive+unloaded');

    const cold = await makeRun(1), coldFixture = fixture(cold, { cold: true });
    await coldFixture.cleanup();
    assert.equal(cold.cleanup.status, 'complete');
    assert.ok(coldFixture.calls.some(call => call.method === 'thread/queue/delete'));
    assert.ok(!coldFixture.calls.some(call => ['thread/resume', 'turn/interrupt', 'thread/backgroundTerminals/clean'].includes(call.method)));
    console.log('PASS  live safety: cold cleanup снимает stored queue и архивирует без resume и исполнения старого inProgress');

    const foreignCwd = join(runnerRoot, 'foreign'); await mkdir(foreignCwd);
    for (const options of [{ wrongId: randomUUID() }, { wrongCwd: foreignCwd }]) {
      const foreign = await makeRun(1), rejected = fixture(foreign, options);
      await assert.rejects(rejected.cleanup(), /не совпали|Неверный диалог/);
      assert.ok(!rejected.calls.some(call => mutation(call.method)));
      assert.equal(foreign.cleanup.status, 'blocked'); assert.equal(foreign.threads[0].archivedAt, undefined);
    }
    const ownership = await makeRun(1), untouched = fixture(ownership, { disableError: true });
    ownership.processes = [{ role: 'receiver', pid: 900003, cwd: ownership.dir, endpoint: ownership.endpoint }];
    await assert.rejects(untouched.cleanup(), /Чужой активный UUID/);
    assert.deepEqual(untouched.flow, ['disable']); assert.deepEqual(untouched.calls, []);
    console.log('PASS  live safety: чужой ID/cwd и ошибка владения запрещают мутации runtime и остановку процессов');

    const retry = await makeRun(2), failures = { failArchive: retry.threads[0].id }, retryFixture = fixture(retry, failures);
    await assert.rejects(retryFixture.cleanup(), /fixture archive refused/);
    assert.equal(retry.cleanup.status, 'blocked'); assert.ok(retry.threads[1].archivedAt); assert.ok(retry.threads[0].cleanupError);
    delete failures.failArchive; await retryFixture.cleanup();
    assert.equal(retry.cleanup.status, 'complete'); assert.equal(retry.threads[0].cleanupError, undefined);
    const archivedCalls = retryFixture.calls.filter(call => call.method === 'thread/archive').length;
    await retryFixture.cleanup();
    assert.equal(retryFixture.calls.filter(call => call.method === 'thread/archive').length, archivedCalls);
    const unverified = await makeRun(1), unavailable = { verifyError: true }, verifyFixture = fixture(unverified, unavailable);
    await assert.rejects(verifyFixture.cleanup(), /verification unavailable/);
    assert.equal(unverified.cleanup.status, 'blocked'); assert.equal(unverified.threads[0].archivedAt, undefined);
    unavailable.verifyError = false; await verifyFixture.cleanup();
    assert.equal(unverified.cleanup.status, 'complete');
    assert.equal(verifyFixture.calls.filter(call => call.method === 'thread/archive').length, 1);
    console.log('PASS  live safety: ошибка A не мешает cleanup B, неподтверждённый archive остаётся blocked, повтор не дублирует работу');

    assert.throws(() => assertCleanupRunnerStopped(capped, () => true), /параллельный cleanup запрещён/);
    assert.throws(() => assertCleanupRunnerStopped({ ...capped, runnerPid: undefined }, () => false), /остановка не подтверждена/);
    assert.throws(() => assertCleanupRunnerStopped(capped, () => { throw Error('identity unavailable'); }), /identity unavailable/);
    assert.doesNotThrow(() => assertCleanupRunnerStopped(capped, () => false));
    const unlockRun = await acquireLiveRunLock(manifest);
    try { await assert.rejects(acquireLiveRunLock(manifest), /Manifest уже занят/); } finally { await unlockRun(); }
    const unlockAgain = await acquireLiveRunLock(manifest); await unlockAgain();
    console.log('PASS  live safety: живой или неизвестный runner блокирует standalone cleanup, manifest исключает параллельный запуск');
  }
  {
    const dir = await realpath(await mkdtemp(join(hub, 'app-queue-')));
    const project = { ...ctx, cwd: dir, hub: join(dir, 'bridge') }, id = randomUUID(), other = randomUUID();
    const home = join(dir, 'profile'), endpoint = join(dir, 'daemon.sock'), database = join(home, 'queue_1.sqlite');
    await mkdir(join(home, 'sessions'), { recursive: true });
    const path = join(home, 'sessions', 'rollout-' + id + '.jsonl');
    for (const f of [database, endpoint, path]) await writeFile(f, '');
    const identity = await stat(endpoint, { bigint: true });
    const bootstrap = { id: 'bootstrap', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Проверка App' }] }] };
    const thread = { id, cwd: dir, path, status: { type: 'notLoaded' }, turns: [bootstrap] };
    const app = { loaded: true, read: [], consume() {
      if (this.loaded && queue.length) this.read.push(structuredClone(queue[0]));
    } };
    const queue = [], calls = [];
    let loseReply = false, noApi = false, repeatCursor = false, legacyHistory = false, stopAfterEnqueue;
    const daemon = { codexHome: home, endpoint, appSocket: [identity.dev, identity.ino, identity.birthtimeNs].join(':'),
      async call(method, params) {
        calls.push(method); assert.equal(params.threadId, id);
        if (method === 'thread/read') {
          if (legacyHistory && params.includeTurns) throw Error('list_turns is not supported yet');
          return { thread: structuredClone(thread) };
        }
        if (method === 'thread/queue/list') {
          if (noApi) throw Object.assign(Error('unknown method thread/queue/list'), { rpcCode: -32601 });
          if (!params.cursor || repeatCursor) return { data: [], nextCursor: 'second' };
          assert.equal(params.cursor, 'second');
          return { data: structuredClone(queue), nextCursor: null };
        }
        if (method === 'thread/queue/add') {
          assert.deepEqual(Object.keys(params).sort(), ['clientUserMessageId', 'input', 'threadId']);
          assert.equal(params.input[0].type, 'text');
          const row = { id: randomUUID(), clientUserMessageId: params.clientUserMessageId, input: params.input };
          queue.push(row);
          if (loseReply) throw Error('lost enqueue response');
          stopAfterEnqueue?.abort();
          return { queuedSubmission: structuredClone(row) };
        }
        throw Error('Неожиданный RPC внешней очереди: ' + method);
      }
    };
    let holders = 'p11\np22', candidate = '/App.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
    const processes = { platform: 'darwin', parents: () => [11, 33], inspect(exe, args) {
      if (exe.endsWith('/lsof')) {
        if (args.includes('-Fn')) return 'n' + database;
        if (args.includes('-U')) { assert.equal(args.at(-1), endpoint); return 'p22'; }
        assert.equal(args.at(-1), database); return holders;
      }
      if (args.includes('command=')) return 'codex app-server --managed-daemon';
      return args.includes('ppid=') ? '33 ' + candidate : '/App.app/Contents/MacOS/App';
    } };
    const enroll = (options = {}) => registerAppQueue(project, id, daemon, { nativeId: id, profile: home, processes, ...options });
    await assert.rejects(enroll({ nativeId: other }), /UUID/);
    await assert.rejects(enroll(), /истории/);
    await writeFile(path, [
      { type: 'session_meta', payload: { id, cwd: dir } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: bootstrap.id } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: bootstrap.items[0].content } }
    ].map(r => JSON.stringify(r)).join('\n'));
    thread.turns = []; await assert.rejects(enroll(), /пользовательский ход/); thread.turns = [bootstrap];
    holders = 'p11'; await assert.rejects(enroll(), /файл очереди/);
    holders = 'p22'; await assert.rejects(enroll(), /Общий файл/);
    holders = 'p11\np22'; const appExe = candidate; candidate = '/cli/bin/codex';
    await assert.rejects(enroll(), /Общий файл/); candidate = appExe;
    await assert.rejects(enroll({ profile: dir }), /ENOENT|профиль/);
    thread.id = other; await assert.rejects(enroll(), /не совпали/); thread.id = id;
    thread.cwd = hub; await assert.rejects(enroll(), /не совпали/); thread.cwd = dir;
    thread.path = null; await assert.rejects(enroll(), /истории/); thread.path = path;
    thread.archived = true; await assert.rejects(enroll(), /истории/); delete thread.archived;
    thread.status.type = 'idle'; await assert.rejects(enroll(), /производящем runtime/); thread.status.type = 'notLoaded';
    noApi = true; await assert.rejects(enroll(), /unknown method/); noApi = false;
    repeatCursor = true; await assert.rejects(enroll(), /страница/); repeatCursor = false;
    assert.equal(await state(project.hub), null);
    const ownerFile = join(process.env.TG_BRIDGE_HOME, 'integration', 'owners', id + '.json');
    const checked = await enroll({ checkOnly: true });
    assert.equal(checked.id, id); assert.equal(checked.unverified, true);
    await assert.rejects(readFile(join(project.hub, 'bridge.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(ownerFile), { code: 'ENOENT' });
    holders = 'p11'; await assert.rejects(enroll({ checkOnly: true }), /файл очереди/); holders = 'p11\np22';
    legacyHistory = true; await enroll(); legacyHistory = false;
    const startInput = { type: 'functionCallOutput', namespace: 'codex_app', name: 'create_thread',
      output: `<codex_delegation>\n  <source_thread_id>${other}</source_thread_id>\n  <input>Покажи статус</input>\n</codex_delegation>` };
    thread.turns = [{ id: bootstrap.id, items: [startInput] }];
    const beforeCheck = await readFile(join(project.hub, 'bridge.json'), 'utf8');
    const ownerBeforeCheck = await readFile(ownerFile, 'utf8');
    await enroll({ checkOnly: true });
    assert.equal(await readFile(join(project.hub, 'bridge.json'), 'utf8'), beforeCheck);
    assert.equal(await readFile(ownerFile, 'utf8'), ownerBeforeCheck);
    assert.ok(calls.every(method => ['thread/read', 'thread/queue/list'].includes(method)));
    console.log('PASS  App: check-only проверяет общий backend, не создает и не меняет привязку, журнал или очередь');
    await enroll();
    for (const change of [{ namespace: 'other' }, { name: 'read_thread' }, { type: 'agentMessage' },
      { output: 'Чат создан' }, { output: startInput.output.replace('Покажи статус', ' ') }]) {
      thread.turns[0].items = [{ ...startInput, ...change }];
      await assert.rejects(enroll(), /пользовательский ход/);
    }
    thread.turns = [{ id: 'empty', items: [] }, { id: 'later', items: [startInput] }];
    await assert.rejects(enroll(), /пользовательский ход/);

    legacyHistory = true;
    const raw = [
      { type: 'session_meta', payload: { id, cwd: dir } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: bootstrap.id } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'AGENTS.md' },
        { type: 'input_text', text: 'cwd' }], internal_chat_message_metadata_passthrough: {
          content_item_kinds: ['agents_md.instructions', 'environments.environment_context'] } } }
    ];
    const history = rows => writeFile(path, rows.map(r => JSON.stringify(r)).join('\n'));
    await history(raw); await assert.rejects(enroll(), /пользовательский ход/);
    await history([...raw, { type: 'response_item', payload: { ...startInput, type: 'function_call_output' } }]);
    await enroll(); legacyHistory = false; thread.turns = [bootstrap];
    assert.equal((await state(project.hub)).active, id);
    assert.deepEqual(Object.keys((await state(project.hub)).events), []);
    assert.ok(calls.every(method => ['thread/read', 'thread/queue/list'].includes(method)));
    console.log('PASS  App: начальный ввод create_thread распознаётся в API и rollout, служебный контекст и посторонние результаты отвергаются');
    const binding = (await state(project.hub)).sessions[id];
    assert.equal(binding.unverified, true); assert.equal(canOpenThread(binding, { status: { type: 'idle' } }, endpoint), false);
    await assert.rejects(register(project, { ...binding, unverified: false }), /только внешняя очередь/);
    console.log('PASS  App: регистрация из адресного App по UUID, cwd, незакрытой истории, профилю, файлу очереди и процессу владельца socket');

    let update = 0;
    const message = text => ingest(project.hub, '91', { update_id: ++update, message: {
      message_id: update, chat: { id: project.chat }, message_thread_id: project.topic, text } });
    const event = async row => (await state(project.hub)).events[row.id];
    const step = () => codexStep(project, daemon);
    const reactions = [];
    const show = () => feedback(project.hub, '91', async (method, params) => {
      if (method === 'setMessageReaction') reactions.push(params.reaction[0].emoji);
    });
    const first = await message('Обычное сообщение');
    const adds = () => calls.filter(m => m === 'thread/queue/add').length;
    for (const [key, bad] of [['appSocket', 'другой inode'], ['endpoint', dir], ['codexHome', dir]]) {
      const original = daemon[key]; daemon[key] = bad; await assert.rejects(step(), /профиль/); daemon[key] = original;
    }
    await rename(database, database + '.old'); await writeFile(database, '');
    await assert.rejects(step(), /backend/); await rename(database + '.old', database);
    thread.id = other; await assert.rejects(step(), /не совпали/); thread.id = id;
    thread.cwd = hub; await assert.rejects(step(), /не совпали/); thread.cwd = dir;
    noApi = true; await assert.rejects(step(), /очередь Codex недоступна/); noApi = false;
    assert.equal((await event(first)).status, 'waiting'); assert.equal(adds(), 0);
    loseReply = true; await assert.rejects(step(), /lost enqueue response/); loseReply = false;
    assert.equal((await event(first)).status, 'uncertain');
    await step(); assert.equal((await event(first)).queueId, queue[0].id); assert.equal(adds(), 1);
    assert.equal(queue[0].clientUserMessageId, first.receipt);
    console.log('PASS  App: смена адресата, endpoint, профиля и файла очереди блокирует ввод; после потери ответа receipt найден на второй странице без повтора');

    // App снял копию до межпроцессного delete. Положительный ответ не отзывает эту копию.
    app.consume();
    const externalDelete = queuedId => { const at = queue.findIndex(r => r.id === queuedId);
      if (at < 0) return { deleted: false };
      queue.splice(at, 1); return { deleted: true };
    };
    assert.deepEqual(externalDelete((await event(first)).queueId), { deleted: true });
    const pause = await message('/pause'), waiting = await message('После паузы');
    await step(); assert.equal((await event(waiting)).status, 'waiting');
    assert.match((await event(pause)).controlResult, /переданное может исполниться/);
    await show(); await show(); assert.ok(!reactions.includes('👀'));
    assert.equal(app.read[0].clientUserMessageId, first.receipt);
    thread.turns = [{ id: 'app-turn', status: 'completed', items: [
      { type: 'userMessage', clientId: first.receipt }, { type: 'agentMessage', text: 'Обычный ответ' }
    ] }];
    await step(); await show(); assert.equal((await event(first)).status, 'sent'); assert.ok(!reactions.includes('👀'));
    await assert.rejects(ack(project.hub, first.id, first.receipt, other, dir), /ACK/);
    await assert.rejects(ack(project.hub, first.id, randomUUID(), id, dir), /ACK/);
    thread.turns[0].items.push({ type: 'agentMessage', phase: 'final_answer', text: 'TG_ACK ' + first.id + ' ' + first.receipt });
    await step(); await show(); assert.equal((await event(first)).status, 'acked'); assert.ok(reactions.includes('👀'));
    assert.equal(adds(), 1);
    console.log('PASS  App: deleted:true после чтения не возвращает задание в очередь; исчезновение записи и ответ без адресного ACK не дают 👀');

    assert.equal((await message('/now Срочно')).status, 'blocked');
    assert.match((await message('/stop')).controlResult, /Остановка хода App недоступна/);
    app.loaded = false; await message('/resume'); await step(); app.consume(); await step();
    assert.equal((await event(waiting)).status, 'sent'); assert.equal(app.read.length, 1);
    assert.equal(queue.length, 1); assert.equal(adds(), 2);
    const lost = await message('Исход неизвестен');
    loseReply = true; await assert.rejects(step(), /lost enqueue response/); loseReply = false;
    externalDelete(queue.find(r => r.clientUserMessageId === lost.receipt).id);
    await step(); await step(); assert.equal((await event(lost)).status, 'uncertain'); assert.equal(adds(), 3);
    const behind = await message('Следующее'); await step(); assert.equal((await event(behind)).status, 'waiting');
    assert.ok(calls.every(m => ['thread/read', 'thread/queue/list', 'thread/queue/add'].includes(m)));
    console.log('PASS  App: закрытый адресат, /now, /stop и пауза не создают второго исполнителя; недоказанный enqueue не повторяется');

    thread.turns.push({ id: 'late-turn', status: 'completed', items: [
      { type: 'userMessage', clientId: lost.receipt }, { type: 'agentMessage', text: 'TG_ACK ' + lost.id + ' ' + lost.receipt }
    ] });
    noApi = true; await assert.rejects(step(), /очередь Codex недоступна/); noApi = false;
    assert.equal((await event(lost)).status, 'acked');
    stopAfterEnqueue = new AbortController();
    let closed = false;
    const timeout = setTimeout(() => stopAfterEnqueue.abort(), 4000);
    try {
      await dispatch(project, stopAfterEnqueue.signal, async (address, cwd) => {
        assert.equal(address, endpoint); assert.equal(cwd, dir);
        return { ...daemon, close: () => { closed = true; } };
      });
    } finally { clearTimeout(timeout); }
    assert.ok(closed); assert.equal((await event(behind)).status, 'sent');
    assert.equal(adds(), 4); assert.equal((await state(project.hub)).sessions[id].unverified, true);
    assert.ok(calls.every(m => ['thread/read', 'thread/queue/list', 'thread/queue/add'].includes(m)));
    console.log('PASS  App: поздний адресный ACK из истории при недоступной очереди, затем обычный dispatcher отправляет только следующее входящее');
  }
  const turns = [{ id: 'busy', status: 'inProgress', items: [] }], nativeQueue = [];
  let busy = true, loaded = true, resumes = 0, race = false, idleRace = false, queueSupported = true, sent = 0, last;
  let deleteRace = false, deleteFails = false, addError, queueStarts = 0;
  const rpc = {
    call: async (m, p) => {
      if (m === 'thread/read') return { thread: { id: session.id, cwd: hub, status: { type: !loaded ? 'notLoaded' : busy ? 'active' : 'idle' }, turns: busy ? turns : [] } };
      if (m === 'thread/resume') { loaded = true; resumes++; return { thread: { id: session.id, cwd: hub } }; }
      if (m === 'thread/queue/list') {
        if (!queueSupported) throw Object.assign(Error('unknown method thread/queue/list'), { rpcCode: -32601 });
        const at = Number(p.cursor || 0);
        return { data: nativeQueue.slice(at, at + 1), nextCursor: at + 1 < nativeQueue.length ? String(at + 1) : null };
      }
      if (m === 'turn/steer' && race) { busy = false; throw Object.assign(Error('no active turn'), { rpcCode: -32600 }); }
      last = [m, p];
      if (m === 'thread/queue/delete') {
        if (deleteFails) throw Error('fixture delete timeout');
        const at = nativeQueue.findIndex(row => row.id === p.queuedSubmissionId);
        if (at < 0) return { deleted: false };
        const [row] = nativeQueue.splice(at, 1);
        if (deleteRace) {
          deleteRace = false; busy = true;
          turns.splice(0, turns.length, { id: 'native-race-turn', status: 'inProgress', items: [{ type: 'userMessage', clientId: row.clientUserMessageId }] });
          return { deleted: false };
        }
        return { deleted: true };
      }
      if (m === 'thread/queue/start') { queueStarts++; return { turn: { id: 'resumed-native-turn' } }; }
      if (m === 'thread/queue/add') {
        if (addError) throw addError;
        if (idleRace) busy = true; // TUI начал другой ход после чтения idle.
        const queuedSubmission = { id: randomUUID(), clientUserMessageId: p.clientUserMessageId, input: p.input };
        nativeQueue.push(queuedSubmission); sent++; return { queuedSubmission };
      }
      if (['turn/start', 'turn/steer'].includes(m)) { sent++; return { turn: { id: busy ? 'busy' : 'next' }, turnId: 'busy' }; }
      if (m === 'turn/interrupt') { busy = false; return {}; }
      throw Error('Неожиданный RPC: ' + m);
    }
  };
  const q = await ingest(hub, '9', { ...item, update_id: 30, message: { ...item.message, text: 'Потом' } });
  await codexStep(ctx, rpc);
  assert.equal(sent, 0);
  const immediate = await ingest(hub, '9', { ...item, update_id: 31 });
  race = true; await codexStep(ctx, rpc);
  assert.equal((await state(hub)).events[immediate.id].status, 'waiting');
  await codexStep(ctx, rpc); assert.equal(last[0], 'turn/start'); assert.equal(sent, 1);
  await codexStep(ctx, rpc); assert.equal(sent, 2); assert.equal(last[0], 'thread/queue/add');
  assert.ok((await state(hub)).events[q.id].queueId);
  await assert.rejects(releaseSession(ctx, session.id), /очереди runtime/);
  loaded = false; rpc.subscribedThread = null;
  const beforeResume = resumes;
  await codexStep(ctx, rpc);
  assert.equal(resumes, beforeResume + 1); assert.equal(sent, 2);
  assert.equal(nativeQueue.length, 1); // Только ранее sent: durable queue ждёт resume после crash.
  await state(hub, d => { d.events[q.id].status = 'sending'; });
  await codexStep(ctx, rpc); assert.equal((await state(hub)).events[q.id].status, 'sent');
  assert.equal(sent, 2); // Квитанция осталась в штатной очереди: не отправляем второй раз.
  nativeQueue.length = 0;
  await state(hub, d => { d.events[q.id].status = 'sending'; });
  await codexStep(ctx, rpc); assert.equal((await state(hub)).events[q.id].status, 'uncertain');
  await codexStep(ctx, rpc); assert.equal(sent, 2);
  await state(hub, d => { d.events[q.id].status = 'cancelled'; });
  await assert.rejects(releaseSession(ctx, session.id), /очереди runtime/);
  await state(hub, d => { d.events[q.id].status = 'acked'; }); // Убираем эту фикстуру из следующих сценариев.
  const raced = await ingest(hub, '9', { ...item, update_id: 32, message: { ...item.message, text: 'Обычная очередь на границе нового хода' } });
  idleRace = true; await codexStep(ctx, rpc);
  assert.equal(last[0], 'thread/queue/add'); assert.equal(busy, true);
  assert.equal((await state(hub)).events[raced.id].turn, undefined);
  assert.equal(nativeQueue[0].clientUserMessageId, raced.receipt);
  const codexUnsupported = await ingest(hub, '9', { ...item, update_id: 33, message: { ...item.message, text: 'Без queue API' } });
  busy = false; rpc.queueAvailable = false; queueSupported = false;
  await assert.rejects(codexStep(ctx, rpc), /Штатная очередь Codex недоступна/);
  assert.equal((await state(hub)).events[codexUnsupported.id].status, 'waiting'); assert.equal(sent, 3);
  queueSupported = true; idleRace = false;
  const foreignQueue = { id: 'ui-submission', clientUserMessageId: 'ui-client', input: [] };
  nativeQueue.unshift(foreignQueue); // Наш receipt находится на второй странице.
  const codexPause = await ingest(hub, '9', { ...item, update_id: 340, message: { ...item.message, text: '/pause' } });
  loaded = false; rpc.subscribedThread = null;
  const beforePauseResume = resumes;
  await codexStep(ctx, rpc);
  assert.equal(resumes, beforePauseResume); assert.equal(sent, 3);
  assert.deepEqual(nativeQueue, [foreignQueue]);
  assert.equal((await state(hub)).events[raced.id].status, 'waiting');
  assert.equal((await state(hub)).events[raced.id].nativeQueueAttempt, false);
  assert.equal((await state(hub)).events[codexPause.id].status, 'controlled');
  const codexResume = await ingest(hub, '9', { ...item, update_id: 341, message: { ...item.message, text: '/resume' } });
  await codexStep(ctx, rpc);
  assert.equal(sent, 3); assert.equal((await state(hub)).events[codexResume.id].status, 'controlled');
  await codexStep(ctx, rpc);
  assert.equal(sent, 4); assert.equal(queueStarts, 1); // После interrupt/resume queue может оставаться на паузе.
  assert.equal((await state(hub)).sessions[session.id].resumeQueue, false);
  const codexStop = await ingest(hub, '9', { ...item, update_id: 342, message: { ...item.message, text: '/stop' } });
  deleteRace = true; await codexStep(ctx, rpc);
  assert.equal(last[0], 'turn/interrupt'); assert.equal(last[1].turnId, 'native-race-turn');
  assert.equal((await state(hub)).events[codexStop.id].status, 'controlled');
  assert.equal((await state(hub)).events[raced.id].turn, 'native-race-turn');
  assert.deepEqual(nativeQueue, [foreignQueue]); assert.equal(sent, 4);
  const codexRevoke = await ingest(hub, '9', { ...item, update_id: 343, message: { ...item.message, text: '/revoke' } });
  busy = true; await codexStep(ctx, rpc);
  assert.equal((await state(hub)).events[codexRevoke.id].status, 'controlled'); assert.equal(sent, 4);
  await ingest(hub, '9', { ...item, update_id: 344, message: { ...item.message, text: '/resume' } });
  await codexStep(ctx, rpc); busy = false;
  await codexStep(ctx, rpc); // Ранее waiting сообщение codexUnsupported теперь попало в native queue.
  const codexPauseRetry = await ingest(hub, '9', { ...item, update_id: 345, message: { ...item.message, text: '/pause' } });
  deleteFails = true;
  await assert.rejects(codexStep(ctx, rpc), /Пауза очереди Codex не подтверждена/);
  assert.equal((await state(hub)).events[codexUnsupported.id].status, 'uncertain');
  assert.equal((await state(hub)).events[codexPauseRetry.id].status, 'waiting');
  deleteFails = false;
  const lostNative = nativeQueue.pop();
  await assert.rejects(codexStep(ctx, rpc), /исход native доставки ещё неизвестен/);
  assert.equal((await state(hub)).events[codexPauseRetry.id].status, 'waiting');
  nativeQueue.push(lostNative); await codexStep(ctx, rpc);
  assert.equal((await state(hub)).events[codexPauseRetry.id].status, 'controlled');
  await ingest(hub, '9', { ...item, update_id: 346, message: { ...item.message, text: '/resume' } });
  await codexStep(ctx, rpc);
  addError = Object.assign(Error('fixture invalid queue input'), { rpcCode: -32602 });
  await assert.rejects(codexStep(ctx, rpc), /fixture invalid queue input/);
  assert.equal((await state(hub)).events[codexUnsupported.id].status, 'blocked');
  assert.equal((await state(hub)).events[codexUnsupported.id].nativeQueueAttempt, false);
  for (const [update, active] of [[348, false], [349, true]]) {
    busy = active; race = false;
    const urgent = await ingest(hub, '9', { ...item, update_id: update });
    const method = active ? 'turn/steer' : 'turn/start';
    await assert.rejects(codexStep(ctx, { call: (m, p) => {
      if (m === method) throw Object.assign(Error('Invalid request: missing field input'), { rpcCode: -32600 });
      return rpc.call(m, p);
    } }), /missing field input/);
    assert.equal((await state(hub)).events[urgent.id].status, 'blocked');
  }
  busy = false;
  console.log('PASS  явный отказ turn/start и turn/steer завершает доставку /now');
  const codexTimeout = await ingest(hub, '9', { ...item, update_id: 347, message: { ...item.message, text: 'Неопределённый enqueue' } });
  addError = Error('fixture enqueue timeout');
  await assert.rejects(codexStep(ctx, rpc), /fixture enqueue timeout/);
  assert.equal((await state(hub)).events[codexTimeout.id].status, 'uncertain');
  assert.equal((await state(hub)).events[codexTimeout.id].nativeQueueAttempt, true);
  await assert.rejects(releaseSession(ctx, session.id), /очереди runtime/);
  await state(hub, d => { d.paused = false; for (const e of Object.values(d.events)) e.status = 'acked'; });
  console.log('PASS  native queue, busy/idle races, pause/delete/resume, controller ACK и неопределённый enqueue');
  // Codex audit: server requests и восстановление только своего runtime, без модели.
  {
    const { codexRPC, connectCodex } = await import('../tg-bridge.mjs');
    const { existsSync } = await import('node:fs');
    const { setTimeout: sleep } = await import('node:timers/promises');
    const realWS = globalThis.WebSocket, originalBinary = process.env.TG_CODEX_BIN;
    const bin = join(hub, 'fake-codex'), ready = join(hub, 'runtime-ready'), calls = join(hub, 'runtime-calls');
    let socket, failOpen = false, startedPid;
    const wire = [];
    class FixtureWS extends EventTarget {
      static OPEN = 1;
      readyState = 0;
      constructor() {
        super(); socket = this;
        queueMicrotask(() => {
          if (failOpen && !existsSync(ready)) this.dispatchEvent(new Event('error'));
          else { this.readyState = 1; this.dispatchEvent(new Event('open')); }
        });
      }
      send(raw) {
        const m = JSON.parse(raw); wire.push(m);
        if (m.method === 'initialize') queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: m.id, result: {} }) })));
      }
      close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
    }
    globalThis.WebSocket = FixtureWS;
    try {
      const connection = await codexRPC('ws://127.0.0.1:9', hub);
      for (const [id, method] of [[901, 'item/commandExecution/requestApproval'], [902, 'item/tool/requestUserInput']]) {
        socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, method, params: { threadId: session.id, turnId: 'busy' } }) }));
      }
      assert.equal(wire.find(m => m.id === 901)?.result?.decision, 'cancel');
      assert.equal(wire.find(m => m.id === 902)?.error?.code, -32601);
      assert.equal(connection.requestError.method, 'item/tool/requestUserInput');
      connection.close();
      failOpen = true;
      await state(hub, d => { d.sessions[session.id].managedRuntime = { kind: 'dedicated', endpoint: session.endpoint, pid: process.pid }; });
      await assert.rejects(connectCodex(ctx, (await state(hub)).sessions[session.id]), /ещё жив/);
      await assert.rejects(connectCodex(ctx, { ...(await state(hub)).sessions[session.id], client: 'codex-app' }), /подключиться/);
      assert.equal(existsSync(calls), false);
      if (process.platform !== 'win32') {
        await mkdir(bin);
        await writeFile(join(bin, 'codex'), '#!' + process.execPath + '\n' +
          'const fs=require("node:fs");fs.appendFileSync(' + JSON.stringify(calls) + ',JSON.stringify(process.argv.slice(2))+"\\n");' +
          'if(process.argv.includes("proxy")){console.error("fixture proxy exit");process.exit(23);}' +
          'fs.writeFileSync(' + JSON.stringify(ready) + ',"ready");setInterval(()=>{},1000);', { mode: 0o700 });
        process.env.TG_CODEX_BIN = join(bin, 'codex');
        for (const testPolicy of [undefined, { model: 'gpt-6-luna', reasoningEffort: 'low' }]) {
          if (startedPid) { process.kill(startedPid); await sleep(100); await rm(ready, { force: true }); }
          await state(hub, d => {
            d.sessions[session.id].managedRuntime.pid = 99999999;
            if (testPolicy) d.sessions[session.id].testPolicy = testPolicy;
          });
          const restored = await connectCodex(ctx, (await state(hub)).sessions[session.id]);
          const policy = (await state(hub)).sessions[session.id].managedRuntime;
          startedPid = policy.pid;
          assert.ok(Number.isInteger(startedPid) && startedPid !== 99999999);
          process.kill(startedPid, 0);
          const overrides = testPolicy ? ['-c', 'model="gpt-6-luna"', '-c', 'model_reasoning_effort="low"',
            '-c', 'agents.enabled=false', '-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2=false'] : [];
          assert.deepEqual(JSON.parse((await readFile(calls, 'utf8')).trim().split('\n').at(-1)), [...overrides, 'app-server', '--listen', 'unix://' + session.endpoint]);
          restored.close();
        }
        if (typeof realWS === 'function') {
          globalThis.WebSocket = realWS;
          const platform = Object.getOwnPropertyDescriptor(process, 'platform');
          try {
            Object.defineProperty(process, 'platform', { value: 'win32' });
            await assert.rejects(codexRPC(session.endpoint, hub), /подключиться|соединение|закрыт/i);
          } finally { Object.defineProperty(process, 'platform', platform); }
          assert.deepEqual(JSON.parse((await readFile(calls, 'utf8')).trim().split('\n').at(-1)), ['app-server', 'proxy', '--sock', session.endpoint]);
        }
      }
    } finally {
      globalThis.WebSocket = realWS;
      if (originalBinary) process.env.TG_CODEX_BIN = originalBinary; else delete process.env.TG_CODEX_BIN;
      if (startedPid) { try { process.kill(startedPid); } catch { } await sleep(100); }
      await state(hub, d => { delete d.sessions[session.id].managedRuntime; delete d.sessions[session.id].testPolicy; });
    }
    console.log('PASS  Codex не теряет server requests, не запускает второй runtime и восстанавливает только управляемый');
  }
  const unlockBot = await holdBot('offline-' + session.id);
  await assert.rejects(holdBot('offline-' + session.id), { code: 'EADDRINUSE' });
  await unlockBot();
  await releaseSession(ctx, session.id);
  const lateAnswer = await ingest(hub, '9', { ...button, update_id: 39, why: 'reply', message: { ...item.message, text: 'Да', reply_to_message: { message_id: 55 } } });
  assert.equal(lateAnswer.status, 'blocked');
  console.log('PASS  второй читатель исключён, старое согласие не переносится на новую сессию');
  const claudeId = randomUUID(), hook = { session_id: claudeId, cwd: hub, hook_event_name: 'SessionStart' };
  let claudePhase = 'busy';
  const inspectClaude = async () => [{ kind: 'interactive', sessionId: claudeId, pid: process.pid, cwd: hub, status: claudePhase }];
  const processes=[{kind:'interactive',sessionId:claudeId,pid:42,cwd:hub},{kind:'interactive',sessionId:randomUUID(),pid:43,cwd:hub}];
  assert.equal(monitorOwner(processes,new Set([42,56]),hub),claudeId);
  assert.equal(monitorOwner(processes,new Set([56]),hub),null);
  await claudeHook(ctx, hook, claudeId);
  const c = await ingest(hub, '9', { ...item, update_id: 40, message: { ...item.message, text: 'Очередь Claude' } });
  await claudeHook(ctx, { ...hook, hook_event_name: 'UserPromptSubmit' }, claudeId);
  const output = [];
  await monitorStep(ctx, claudeId, async t => output.push(JSON.parse(t)), inspectClaude);
  assert.equal(output.length, 0);
  await claudeHook(ctx, { ...hook, hook_event_name: 'Stop' }, claudeId);
  claudePhase = 'idle';
  await monitorStep(ctx, claudeId, async t => output.push(JSON.parse(t)), inspectClaude);
  assert.equal(output[0].session_id, claudeId); assert.equal(output[0].delivery_id, c.id);
  await claudeHook(ctx, { ...hook, hook_event_name: 'SessionEnd' }, claudeId);
  const b = await ingest(hub, '9', { ...item, update_id: 41, message: { ...item.message, text: 'Фоновое продолжение' } });
  const { spawn } = await import('node:child_process');
  const stub = (exe, argv, opts) => {
    assert.equal(exe, 'claude'); assert.equal(argv[argv.indexOf('--resume') + 1], claudeId);
    const code = `let out=x=>console.log(JSON.stringify(x)); const id=process.argv[1];
    out({type:'system',subtype:'init',session_id:id});process.stdin.once('data',data=>{
    let msg=JSON.parse(data);if(msg.session_id!==id)process.exit(2);
    let receipt=msg.message.content.match(/TG_ACK [^ ]+ [a-f0-9-]+/)[0];
    out({type:'result',subtype:'success',session_id:id,result:receipt});});`;
    return spawn(process.execPath, ['-e', code, claudeId], opts);
  };
  await claudeBackground(ctx, (await state(hub)).sessions[claudeId], stub, async () => []);
  assert.equal((await state(hub)).events[b.id].status, 'acked');
  console.log('PASS  Claude на фикстуре Node: hooks, отложенный Monitor, точный --resume и явный ACK');
  const { openClaude } = await import('../tg-bridge.mjs');
  const { setTimeout: delay } = await import('node:timers/promises');
  const settleClaude = () => state(hub, d => {
    for (const e of Object.values(d.events)) if (e.session === claudeId) e.status = 'acked';
  });
  const incomingClaude = (update_id, text) => ingest(hub, '9', { ...item, update_id, message: { ...item.message, message_id: update_id, text } });
  await settleClaude();
  await claudeHook(ctx, hook, claudeId);
  await claudeHook(ctx, { ...hook, hook_event_name: 'UserPromptSubmit' }, claudeId);
  // Interrupt не вызывает Stop: свежий штатный статус должен исправить сохранённый busy.
  const afterInterrupt = await incomingClaude(42, 'Продолжи после прерывания');
  claudePhase = 'idle';
  await monitorStep(ctx, claudeId, async () => {}, inspectClaude);
  assert.equal((await state(hub)).events[afterInterrupt.id].status, 'sent');
  await claudeHook(ctx, { ...hook, hook_event_name: 'UserPromptSubmit' }, claudeId);
  await claudeHook(ctx, { ...hook, hook_event_name: 'StopFailure', error: 'rate_limit' }, claudeId);
  const afterFailure = await incomingClaude(43, 'Продолжи после ошибки');
  await monitorStep(ctx, claudeId, async () => {}, inspectClaude);
  assert.equal((await state(hub)).events[afterFailure.id].status, 'sent');
  console.log('PASS  Claude: interrupt и StopFailure не оставляют очередь навсегда в busy');

  await settleClaude();
  const unavailable = await incomingClaude(44, 'Дождись подтверждённого состояния');
  let unexpectedLaunches = 0;
  const noLaunch = () => { unexpectedLaunches++; throw Error('Нельзя запускать клиента'); };
  const badStatus = async () => { throw Error('fixture status unavailable'); };
  await monitorStep(ctx, claudeId, async () => { throw Error('Нельзя выдавать при unknown'); }, badStatus);
  assert.equal((await state(hub)).sessions[claudeId].phase, 'unknown');
  await assert.rejects(claudeBackground(ctx, (await state(hub)).sessions[claudeId], noLaunch, badStatus), /fixture status unavailable/);
  await assert.rejects(claudeBackground(ctx, (await state(hub)).sessions[claudeId], noLaunch, async () => ({})), /неверный список/);
  await assert.rejects(claudeBackground(ctx, (await state(hub)).sessions[claudeId], noLaunch, async () => [{ pid: 42, cwd: hub }]), /без точного UUID/);
  claudePhase = 'waiting';
  await monitorStep(ctx, claudeId, async () => { throw Error('QUEUE не проходит waiting'); }, inspectClaude);
  assert.equal((await state(hub)).events[unavailable.id].status, 'waiting');
  await assert.rejects(openClaude(ctx, claudeId, noLaunch, inspectClaude), /уже открыт/);
  assert.equal(unexpectedLaunches, 0);
  console.log('PASS  Claude: unknown, неверный список и живой waiting не дают ложного idle или второго процесса');

  // Ни SessionEnd, ни finally launcher не успели выполниться. Inspect явно подтверждает отсутствие владельца.
  await state(hub, d => { d.sessions[claudeId].ended = false; d.sessions[claudeId].managed = false; d.sessions[claudeId].monitorPid = 2147483647; });
  await claudeBackground(ctx, (await state(hub)).sessions[claudeId], stub, async () => []);
  assert.equal((await state(hub)).events[unavailable.id].status, 'acked');
  console.log('PASS  Claude: исчезнувший TTY без SessionEnd возобновляется по точному UUID');

  for (const withResultIds of [true, false]) {
    await settleClaude();
    const a = await incomingClaude(withResultIds ? 50 : 52, '/now Первое входящее');
    const z = await incomingClaude(withResultIds ? 51 : 53, '/now Второе входящее');
    const streamed = (exe, argv, opts) => {
      assert.equal(exe, 'claude');
      const code = `const {createInterface}=require('node:readline');const id=process.argv[1],ids=process.argv[2]==='true';
        const out=x=>console.log(JSON.stringify(x));out({type:'system',subtype:'init',session_id:id});let n=0;
        createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.type!=='user')return;
          if(!m.uuid)process.exit(2);const marker=m.message.content.match(/TG_ACK [^ ]+ [a-f0-9-]+/)[0];
          setTimeout(()=>out({type:'result',subtype:'success',session_id:id,result:marker,...(ids?{user_message_uuids:[m.uuid]}:{})}),++n===1?450:800);
        });`;
      return spawn(process.execPath, ['-e', code, claudeId, String(withResultIds)], opts);
    };
    await claudeBackground(ctx, (await state(hub)).sessions[claudeId], streamed, async () => []);
    const d = await state(hub);
    assert.equal(d.events[a.id].status, 'acked'); assert.equal(d.events[z.id].status, 'acked');
  }
  console.log('PASS  Claude: два входящих и раздельные result/ACK не теряют второе подтверждение, с UUID и без него');

  await settleClaude();
  const noAck = await incomingClaude(54, 'Не подтверждай получение');
  const withoutAck = (_exe, _argv, opts) => spawn(process.execPath, ['-e', `const id=process.argv[1];
    const out=x=>console.log(JSON.stringify(x));out({type:'system',subtype:'init',session_id:id});
    process.stdin.once('data',()=>out({type:'result',subtype:'success',session_id:id,result:'Ответ без ACK'}));`, claudeId], opts);
  await claudeBackground(ctx, (await state(hub)).sessions[claudeId], withoutAck, async () => []);
  assert.equal((await state(hub)).events[noAck.id].status, 'sent');
  console.log('PASS  Claude: результат без ACK не превращается в подтверждение агента');

  await settleClaude();
  await incomingClaude(55, 'Закончи перед передачей терминалу');
  let workerClosed = false, reopened = false;
  const slowWorker = (_exe, _argv, opts) => {
    const child = spawn(process.execPath, ['-e', `const id=process.argv[1];const out=x=>console.log(JSON.stringify(x));
      out({type:'system',subtype:'init',session_id:id});process.stdin.once('data',data=>{const m=JSON.parse(data);
        setTimeout(()=>out({type:'result',subtype:'success',session_id:id,user_message_uuids:[m.uuid],result:m.message.content.match(/TG_ACK [^ ]+ [a-f0-9-]+/)[0]}),450);});`, claudeId], opts);
    child.once('close', () => { workerClosed = true; }); return child;
  };
  const working = claudeBackground(ctx, (await state(hub)).sessions[claudeId], slowWorker, async () => []);
  for (let n = 0; n < 100 && !(await state(hub)).sessions[claudeId].workerPid; n++) await delay(10);
  assert.ok((await state(hub)).sessions[claudeId].workerPid);
  const opening = openClaude(ctx, claudeId, (exe, argv, opts) => {
    assert.equal(exe, 'claude'); assert.ok(workerClosed); assert.equal(argv[argv.indexOf('--resume') + 1], claudeId);
    reopened = true; return spawn(process.execPath, ['-e', ''], opts);
  }, async () => []);
  for (let n = 0; n < 100 && !(await state(hub)).sessions[claudeId].handoff; n++) await delay(10);
  const duringHandoff = await incomingClaude(56, '/now После передачи');
  await Promise.all([working, opening]);
  assert.ok(reopened); assert.equal((await state(hub)).events[duringHandoff.id].status, 'waiting');
  await settleClaude();
  console.log('PASS  Claude: handoff ждёт выхода worker перед открытием истории и не выдаёт ему новые входящие');
  const nestedCwd = join(hub, 'nested-cli');
  await mkdir(nestedCwd);
  const registeredCwd = await realpath(hub);
  await openClaude({ ...ctx, cwd: nestedCwd }, claudeId, (_exe, _argv, opts) => {
    assert.equal(opts.cwd, registeredCwd); return spawn(process.execPath, ['-e', ''], opts);
  }, async () => []);
  let ownershipChecks = 0;
  await assert.rejects(openClaude(ctx, claudeId, noLaunch, async () => {
    if (++ownershipChecks === 1) return [];
    await claudeHook(ctx, hook, claudeId);
    return inspectClaude();
  }), /Владелец Claude изменился/);
  const otherOwner = (await state(hub)).sessions[claudeId];
  assert.equal(otherOwner.ended, false); assert.equal(otherOwner.interactive, true);
  assert.equal(unexpectedLaunches, 0);
  await claudeHook(ctx, { ...hook, hook_event_name: 'SessionEnd' }, claudeId);
  console.log('PASS  Claude: reopen сохраняет рабочую папку, а неудачный handoff не закрывает нового владельца');
  const stopTask = await incomingClaude(57, 'Работай до остановки');
  const interruptible = (_exe, _argv, opts) => spawn(process.execPath, ['-e', `const {createInterface}=require('node:readline');
    const id=process.argv[1],out=x=>console.log(JSON.stringify(x));let first,users=0;
    const deadline=setTimeout(()=>process.exit(3),3000);out({type:'system',subtype:'init',session_id:id});
    createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
      if(m.type==='user'){if(++users>1)process.exit(2);first=m;}
      if(m.type==='control_request'&&m.request.subtype==='interrupt'){
        out({type:'control_response',response:{subtype:'success',request_id:m.request_id}});
        out({type:'result',subtype:'error_during_execution',is_error:true,session_id:id,user_message_uuids:[first.uuid],result:'Interrupted'});
      }
    });process.stdin.on('end',()=>clearTimeout(deadline));`, claudeId], opts);
  const interruptedWork = claudeBackground(ctx, (await state(hub)).sessions[claudeId], interruptible, async () => []);
  for (let n = 0; n < 100 && (await state(hub)).events[stopTask.id].status !== 'sent'; n++) await delay(10);
  assert.equal((await state(hub)).events[stopTask.id].status, 'sent');
  const stopWorker = await incomingClaude(58, '/stop');
  await interruptedWork;
  const stopped = (await state(hub)).events[stopWorker.id];
  assert.equal(stopped.status, 'controlled'); assert.match(stopped.controlResult, /Запрос остановки/);
  assert.equal((await state(hub)).events[stopTask.id].status, 'sent');
  const resumeWithoutTurn = await incomingClaude(59, '/resume');
  await claudeBackground(ctx, (await state(hub)).sessions[claudeId], noLaunch, badStatus);
  assert.equal((await state(hub)).events[resumeWithoutTurn.id].status, 'controlled');
  assert.equal((await state(hub)).paused, false); assert.equal(unexpectedLaunches, 0);
  await claudeHook(ctx, hook, claudeId); claudePhase = 'busy';
  const stopInteractive = await incomingClaude(60, '/stop');
  await monitorStep(ctx, claudeId, async () => { throw Error('/stop не должен быть model input'); }, inspectClaude);
  const claudeStopUnsupported = (await state(hub)).events[stopInteractive.id];
  assert.equal(claudeStopUnsupported.status, 'controlled'); assert.match(claudeStopUnsupported.controlResult, /не поддерживается/);
  await incomingClaude(61, '/resume');
  await monitorStep(ctx, claudeId, async () => { throw Error('/resume не должен быть model input'); }, badStatus);
  await claudeHook(ctx, { ...hook, hook_event_name: 'SessionEnd' }, claudeId);
  await settleClaude();
  console.log('PASS  Claude: /stop worker — отдельный interrupt без нового user input; Monitor честно сообщает unsupported; /resume не вызывает модель');
  const guardWorker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const guardWorkerClosed = new Promise(done => guardWorker.once('close', done));
  try {
    await state(hub, d => Object.assign(d.sessions[claudeId], { workerPid: guardWorker.pid, phase: 'busy', ended: false, interactive: false }));
    const priorOwner = (await state(hub)).sessions[claudeId];
    await assert.rejects(claudeHook(ctx, { ...hook, source: 'resume' }, ''), /Закройте эту сессию/);
    assert.equal((await state(hub)).sessions[claudeId].needsReopen, true);
    const promptGuard = await claudeHook(ctx, { ...hook, hook_event_name: 'UserPromptSubmit' }, '');
    const toolGuard = await claudeHook(ctx, { ...hook, hook_event_name: 'PreToolUse', tool_name: 'Bash' }, '');
    assert.equal(promptGuard.decision, 'block'); assert.match(promptGuard.reason, /свежей истории/);
    assert.equal(toolGuard.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(toolGuard.hookSpecificOutput.permissionDecision, 'deny');
    for (const name of ['Stop', 'StopFailure', 'SessionEnd']) await claudeHook(ctx, { ...hook, hook_event_name: name }, '');
    const heldOwner = (await state(hub)).sessions[claudeId];
    for (const key of ['workerPid', 'phase', 'ended', 'interactive', 'runtimeEpoch']) assert.equal(heldOwner[key], priorOwner[key]);
    process.kill(guardWorker.pid, 0);
    // Проверяем stdout настоящего Node hook entry point, не запуская Claude.
    const hookTransport = join(hub, 'hook-transport'), hookState = projectStateHub(hookTransport, ctx.project);
    await mkdir(hookState, { recursive: true });
    await atomic(join(hookState, 'bridge.json'), await state(hub));
    await atomic(join(hookTransport, 'projects.json'), { version: 2, mode: 'parallel', default: ctx.project, group: { chat_id: '-123', forum: true }, projects: { [ctx.project]: { mode: 'topic', tag: '#test_bridge', topic: 8, inbox: join(hub, 'inbox') } } });
    const { spawnSync: runHookFixture } = await import('node:child_process');
    const { fileURLToPath: hookFilePath } = await import('node:url');
    for (const name of ['UserPromptSubmit', 'PreToolUse']) {
      const response = runHookFixture(process.execPath, [hookFilePath(new URL('../tg-bridge.mjs', import.meta.url)), 'claude-hook', '--project', ctx.project], {
        cwd: hub, env: { ...process.env, TG_HUB: hookTransport, TG_BOT_TOKEN: '9:sandbox', TG_CHAT_ID: '321', TG_CLAUDE_WORKER: '', TG_INTERACTIVE_SESSION: '' },
        input: JSON.stringify({ ...hook, hook_event_name: name, tool_name: 'Bash' }), encoding: 'utf8', timeout: 5000
      });
      assert.equal(response.status, 0, response.stderr);
      const decision = JSON.parse(response.stdout);
      assert.equal(name === 'UserPromptSubmit' ? decision.decision : decision.hookSpecificOutput.permissionDecision, name === 'UserPromptSubmit' ? 'block' : 'deny');
    }
  } finally { guardWorker.kill(); await guardWorkerClosed; }
  await state(hub, d => { delete d.sessions[claudeId].workerPid; });
  assert.equal((await claudeHook(ctx, { ...hook, hook_event_name: 'UserPromptSubmit' }, '')).decision, 'block');
  await assert.rejects(claudeHook(ctx, { ...hook, source: 'compact' }, claudeId), /свежей истории/);
  await claudeHook(ctx, { ...hook, source: 'resume' }, claudeId);
  assert.equal((await state(hub)).sessions[claudeId].needsReopen, undefined);
  assert.equal(await claudeHook(ctx, { ...hook, hook_event_name: 'UserPromptSubmit' }, claudeId), undefined);
  await claudeHook(ctx, { ...hook, hook_event_name: 'SessionEnd' }, claudeId);
  console.log('PASS  Claude: raw resume конфликт блокирует prompt/tool, не меняет worker и требует управляемого reopen');
  const home = join(hub, 'mock-home');
  await mkdir(join(home, '.claude'), { recursive: true });
  const settingsPath = join(home, '.claude', 'settings.json');
  await writeFile(settingsPath, JSON.stringify({ language: 'ru', enabledPlugins: { example: true } }));
  await integrationFiles(false, 'darwin', home); await integrationFiles(false, 'darwin', home);
  const hookFile = JSON.parse(await readFile(join(home, '.codex', 'hooks.json')));
  assert.equal(hookFile.hooks.SessionStart.length, 1);
  const claudeHooks = JSON.parse(await readFile(join(process.env.TG_BRIDGE_HOME, 'integration', 'claude', 'hooks', 'hooks.json')));
  assert.equal(claudeHooks.hooks.StopFailure.length, 1);
  const merged = JSON.parse(await readFile(settingsPath)); assert.ok(merged.enabledPlugins.example);
  await integrationFiles(true, 'darwin', home);
  assert.deepEqual(JSON.parse(await readFile(settingsPath)), { language: 'ru', enabledPlugins: { example: true } });
  assert.match(serviceFile('win32', home, 'C:/Node/node.exe', 'C:/kit path/tg.mjs').text, /LeastPrivilege/);
  assert.match(serviceFile('linux', home, '/usr/bin/node', '/kit path/tg.mjs').text, /ExecStart="[^"]+" "\/kit path\/tg.mjs"/);
  console.log('PASS  установка и снятие hooks сохраняют настройки; служебные команды Windows и Linux');
  process.env.TG_CODEX_BIN = join(home, 'Каталог Codex', 'codex.exe');
  const winHome = join(process.env.TG_BRIDGE_HOME, 'service-home');
  const winTask = await integrationFiles(false, 'win32', winHome);
  const network = JSON.parse(await readFile(join(process.env.TG_BRIDGE_HOME, 'integration', 'service-env.json')));
  assert.equal(network.TG_CODEX_BIN, process.env.TG_CODEX_BIN);
  delete process.env.TG_CODEX_BIN;
  const winXml = await readFile(winTask.path);
  assert.deepEqual([...winXml.subarray(0, 2)], [0xff, 0xfe]);
  assert.match(winXml.toString('utf16le'), /^\ufeff<\?xml version="1.0" encoding="UTF-16"\?>/);
  await integrationFiles(false, 'win32', winHome);
  const uninstall = new URL('../tg-bridge.mjs', import.meta.url);
  const schedulerCheck = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { fileURLToPath } from 'node:url';
    globalThis.WebSocket ||= class {};
    Object.defineProperty(process, 'platform', { value: 'win32' });
    childProcess.spawnSync = (exe, args) => {
      if (exe === 'schtasks.exe' && args[0] === '/Query') return { status: 1 };
      if (exe === 'powershell.exe' && args.at(-1).includes('Get-CimInstance')) return { status: Number(process.env.CIM_RESULT) };
      throw Error('Неожиданная команда ' + exe);
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, fileURLToPath(process.argv[1]), 'service', 'uninstall'];
    await import(${JSON.stringify(uninstall.href)});
  `;
  const { spawnSync: checkRemoval } = await import('node:child_process');
  for (const code of [1, 0]) {
    const r = checkRemoval(process.execPath, ['--input-type=module', '-e', schedulerCheck, uninstall.href], {
      env: { ...process.env, CIM_RESULT: String(code) }, encoding: 'utf8'
    });
    assert.equal(r.status, code, r.stderr);
    if (code) assert.deepEqual(await readFile(winTask.path), winXml);
  }
  await assert.rejects(readFile(winTask.path), { code: 'ENOENT' });
  console.log('PASS  XML Планировщика задач записывается в UTF-16LE с BOM и снимается после повторной установки');
  console.log('PASS  при недоступном Планировщике установочные файлы остаются до подтверждения отсутствия задачи');
  const conflict = { language: 'ru', extraKnownMarketplaces: { 'agent-telegram-local': { source: { source: 'directory', path: '/existing-market' } } } };
  await writeFile(settingsPath, JSON.stringify(conflict));
  await assert.rejects(integrationFiles(false, 'linux', home), /уже занято/);
  await integrationFiles(true, 'linux', home);
  assert.deepEqual(JSON.parse(await readFile(settingsPath)), conflict);
  await assert.rejects(readFile(join(home, '.codex', 'hooks.json')), { code: 'ENOENT' });
  await assert.rejects(integrationFiles(false, 'linux', home), /уже занято/);
  await writeFile(settingsPath, JSON.stringify({ language: 'ru' }));
  await integrationFiles(false, 'linux', home);
  await integrationFiles(true, 'linux', home);
  assert.deepEqual(JSON.parse(await readFile(settingsPath)), { language: 'ru' });
  await assert.rejects(readFile(join(home, '.codex', 'hooks.json')), { code: 'ENOENT' });
  console.log('PASS  прерванная установка: удаление и повтор не оставляют hook и сохраняют чужой marketplace');
  await releaseSession(ctx, claudeId);
  const migrated = join(hub, 'old');
  await mkdir(migrated);
  await writeFile(join(migrated, 'queue.jsonl'), JSON.stringify({ ...item, update_id: 91 }) + '\n');
  await importInbox(hub, '91', migrated);
  assert.equal((await state(hub)).events['91:91'].status, 'waiting');
  await importInbox(hub, '91', migrated);
  console.log('PASS  перенос непрочитанной очереди прежнего слушателя');
} finally { await rm(hub, { recursive: true, force: true }); }
