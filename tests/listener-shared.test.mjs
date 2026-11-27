// Синтетические Telegram-обновления и локальные процессы; настоящая сеть не используется.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceKey } from '../tg-workspace.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(join(tmpdir(), 'agent-telegram-shared-listener-'));
const HUB = join(TMP, 'hub'), BOT = String(900000000 + process.pid);
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ': ' + detail : ''}`); };
const parse = async (file, fallback = null) => JSON.parse(await readFile(file, 'utf8').catch(() => JSON.stringify(fallback)));
const rows = async file => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const stateHub = name => join(HUB, 'projects', name);
const inbox = name => join(HUB, 'inbox', name);
await mkdir(join(HUB, '.secrets'), { recursive: true });
for (const name of ['alpha', 'beta', 'gamma']) await mkdir(inbox(name), { recursive: true });
await writeFile(join(HUB, '.secrets', 'telegram.env'), `TG_BOT_TOKEN=${BOT}:sandbox\nTG_CHAT_ID=111\n`);
const env = { ...process.env, TG_HUB: HUB };
for (const key of ['TG_PROJECT', 'TG_BOT_TOKEN', 'TG_CHAT_ID', 'TG_RECEIVER_PARENT']) delete env[key];
const registry = {
  version: 2, mode: 'parallel', default: 'alpha',
  group: { chat_id: '-100777', forum: true, title: 'Synthetic group', topics: { 8: 'alpha', 9: 'beta' } },
  projects: {
    alpha: { tag: '#alpha', inbox: inbox('alpha'), topic: 8 },
    beta: { tag: '#beta', inbox: inbox('beta'), topic: 9 },
    gamma: { tag: '#gamma', inbox: inbox('gamma') },
  },
};
const save = async reg => writeFile(join(HUB, 'projects.json'), JSON.stringify(reg));
await save(registry);
const G = { id: -100777, type: 'supergroup', is_forum: true };
const me = { id: 111, is_bot: false }, bot = { id: Number(BOT), is_bot: true };
const msg = (id, text, thread = null, extra = {}) => ({ message_id: id, date: 1800000000, from: me, chat: G, text, ...(thread != null && { message_thread_id: thread, is_topic_message: true }), ...extra });
const update = (id, text, thread, extra) => ({ update_id: id, message: msg(id, text, thread, extra) });
const result = r => ({ code: r.status, out: r.stdout || '', err: r.stderr || '' });
const run = (name, args, extraEnv = {}) => result(spawnSync(process.execPath, [join(ROOT, 'tg-listen.mjs'), '--project', name, ...args], { cwd: TMP, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15000 }));
let serial = 0;
async function simulate(name, updates, flags = []) {
  const file = join(TMP, `updates-${serial++}.json`); await writeFile(file, JSON.stringify(updates));
  return run(name, ['--drain', '--no-ack', '--simulate', file, ...flags]);
}
const received = text => [...text.matchAll(/\[TG входящее #(\d+)/g)].map(match => Number(match[1]));

try {
  await writeFile(join(inbox('beta'), 'sent.jsonl'), JSON.stringify({ chat_id: G.id, message_id: 700, thread: null, kind: 'question', head: 'Synthetic question' }) + '\n');
  const input = [
    update(1, 'alpha only', 8), update(2, 'beta only', 9), update(3, '#beta general'),
    update(4, 'reply beta', null, { reply_to_message: { message_id: 700, from: bot, text: '#beta · вопрос' } }),
    update(5, '#beta contradictory', 8), update(6, '#unknown reject', 8), update(7, 'ambiguous general'),
    update(8, 'private ignored', null, { chat: { id: 111, type: 'private' } }),
    update(9, 'other owner', 8, { from: { id: 222, is_bot: false } }),
    update(10, 'other group', 8, { chat: { ...G, id: -100888 } }),
    update(11, 'contradictory reply', 8, { reply_to_message: { message_id: 700, from: bot, text: '#beta · вопрос' } }),
    update(12, '#beta suffix unknown?', 9),
    update(13, '#beta-suffix invalid tag', 9),
    { update_id: 14, edited_message: msg(2, 'beta edit', 9, { edit_date: 1800000010 }) },
  ];
  let r = await simulate('alpha', input);
  check('общий приёмщик печатает только свой проект', r.code === 0 && JSON.stringify(received(r.out)) === '[1]', r.err + r.out);
  const betaRows = await rows(join(inbox('beta'), 'queue.jsonl'));
  check('общий приёмщик сохраняет сообщения других проектов в их очередях', JSON.stringify(betaRows.map(row => row.update_id)) === '[2,3,4,12,14]', JSON.stringify(betaRows.map(row => row.update_id)));
  check('конфликт темы/тега/ответа и неизвестный хештег отклоняются', r.err.includes('конфликт') && r.err.includes('неизвестный'), r.err);
  check('один offset относится к общему боту', (await parse(join(HUB, 'offset.json')))?.offset === 15 && (await parse(join(HUB, 'offset.json')))?.bot === BOT);
  r = await simulate('beta', []);
  check('второй потребитель читает сохранённую очередь и правки своего проекта', r.code === 0 && JSON.stringify(received(r.out)) === '[2,3,4,12,2]' && r.out.includes('изменено'), r.out + r.err);
  r = await simulate('alpha', input);
  const again = await simulate('beta', []);
  check('повтор Telegram-обновлений не дублирует вывод', r.code === 0 && !received(r.out).length && !received(again.out).length, r.out + again.out);

  r = await simulate('alpha', [update(20, '#gamma', 10), update(21, 'gamma only', 10), update(22, '#gamma', 11), update(23, '#alpha', 9)]);
  const bound = await parse(join(HUB, 'projects.json'));
  check('одна тема и один хештег остаются за проектом без молчаливого переноса', bound.projects.gamma.topic === 10 && bound.projects.alpha.topic === 8 && bound.projects.beta.topic === 9);
  const gammaRows = await rows(join(inbox('gamma'), 'queue.jsonl'));
  check('после привязки другой проект получает обычный текст своей темы', gammaRows.length === 1 && gammaRows[0].message.text === 'gamma only');

  r = await simulate('alpha', [update(24, '', null, { media_group_id: 'synthetic-album', photo: [{ file_id: 'test-photo-1' }] })]);
  r = await simulate('alpha', [update(25, '', null, { caption: '#beta album', media_group_id: 'synthetic-album', photo: [{ file_id: 'test-photo-2' }] })]);
  r = await simulate('beta', []);
  check('альбом из разных пачек сохраняет кадр до прихода хештега', JSON.stringify(received(r.out)) === '[24,25]', r.out + r.err);

  const question = msg(800, '#beta · вопрос', 9, { from: bot, reply_markup: { inline_keyboard: [[{ text: 'Да', callback_data: 'at:0' }, { text: 'Нет', callback_data: 'at:1' }]] } });
  const cb = (id, data, changes = {}) => ({ update_id: id, callback_query: { id: `synthetic-${id}`, from: me, message: question, data, ...changes } });
  r = await simulate('alpha', [cb(30, 'at:0'), cb(31, 'at:1'), cb(32, 'at:7'), cb(33, 'at:0', { from: { id: 999 } })]);
  r = await simulate('beta', []);
  const choices = (await rows(join(inbox('beta'), 'queue.jsonl'))).filter(row => row.why === 'button');
  check('кнопки чужого проекта сохраняются в его очередь, первый выбор устойчив', choices.length === 1 && choices[0].button === 'Да' && r.out.includes('КНОПКА') && !r.out.includes('│ Нет'), r.out + r.err);

  const alphaState = stateHub('alpha'), betaState = stateHub('beta');
  await mkdir(betaState, { recursive: true });
  await writeFile(join(betaState, 'bridge.json'), JSON.stringify({ enabled: true, active: null, sessions: {}, events: {}, questions: {}, choices: {} }));
  r = await simulate('alpha', [update(40, 'bridge beta route', 9)]);
  const betaBridge = await parse(join(betaState, 'bridge.json'));
  check('приёмщик передаёт событие мосту целевого проекта', !!betaBridge.events[`${BOT}:40`] && !(await parse(join(alphaState, 'bridge.json')))?.events?.[`${BOT}:40`], r.err);
  check('журнал ответа мосту записывается в папке целевого проекта', (await rows(join(inbox('beta'), 'messages.jsonl'))).some(row => row.text === 'bridge beta route') && !(await rows(join(inbox('alpha'), 'messages.jsonl'))).some(row => row.text === 'bridge beta route'));
  const blocked = await simulate('beta', []);
  check('обычный потребитель не забирает события включённого моста', blocked.code === 0 && blocked.out.includes('Фоновая доставка') && !received(blocked.out).length);
  const mediaMock = join(TMP, 'mock-media-fetch.mjs');
  const mediaInput = [update(41, '', 9, { photo: [{ file_id: 'synthetic-photo' }] })];
  await writeFile(mediaMock, `globalThis.fetch=async(url)=>{const address=String(url),method=address.split('/').at(-1);if(address.includes('/file/bot'))return {ok:true,arrayBuffer:async()=>new TextEncoder().encode('synthetic-photo-bytes').buffer};if(method==='getFile')return {ok:true,status:200,json:async()=>({ok:true,result:{file_path:'photos/test.jpg',file_size:21}})};if(method==='getUpdates')return {ok:true,status:200,json:async()=>({ok:true,result:process.argv.includes('--bridge-receiver')?[]:${JSON.stringify(mediaInput)}})};throw Error('Unexpected mocked API '+method);};\n`);
  const mediaRun = (name, extra = []) => result(spawnSync(process.execPath, ['--import', mediaMock, join(ROOT, 'tg-listen.mjs'), '--project', name, '--drain', '--no-ack', ...extra], { cwd: TMP, env, encoding: 'utf8', timeout: 10000 }));
  const mediaPoller = mediaRun('alpha'), mediaReceiver = mediaRun('beta', ['--bridge-receiver']);
  const mediaBridge = await parse(join(betaState, 'bridge.json'));
  const photoFile = mediaBridge.events[`${BOT}:41`]?.attachments?.[0]?.file;
  check('файл другого проекта скачивается только в его папку и готовится его мостом', mediaPoller.code === 0 && mediaReceiver.code === 0 && photoFile?.startsWith(join(inbox('beta'), 'files')) && await readFile(photoFile, 'utf8').catch(() => '') === 'synthetic-photo-bytes', JSON.stringify({ mediaPoller, mediaReceiver, photoFile, event: mediaBridge.events[`${BOT}:41`] }));
  await rm(join(betaState, 'bridge.json'));

  const single = structuredClone(registry); single.mode = 'single'; delete single.group;
  single.projects.alpha.privateChat = { chat_id: '111', bot_id: BOT };
  await save(single);
  r = await simulate('alpha', [
    update(50, 'single dm', null, { chat: { id: 111, type: 'private' } }),
    update(51, 'single group ignored', 8),
    update(52, '#beta inactive', null, { chat: { id: 111, type: 'private' } }),
    update(53, 'topic dm ignored', 8, { chat: { id: 111, type: 'private' } }),
  ]);
  check('single принимает только обычную личку активного проекта', JSON.stringify(received(r.out)) === '[50]', r.out + r.err);
  r = await simulate('beta', []);
  check('single блокирует неактивный проект до чтения бота', r.code === 1 && r.err.includes('не активен'), r.out + r.err);
  const changing = structuredClone(single); changing.default = 'beta';
  changing.projects.beta.privateChat = { chat_id: '111', bot_id: BOT };
  changing.singleActivation = { project: 'beta', previous: 'alpha', code: 'synthetic-activation-code', pending: true };
  await save(changing);
  const dm = (id, text, extra = {}) => update(id, text, null, { chat: { id: 111, type: 'private' }, ...extra });
  r = await simulate('beta', [dm(60, 'old untagged backlog'), dm(61, '#beta historical hashtag'), dm(62, '/activate wrong-code'), dm(63, '/activate synthetic-activation-code', { forward_origin: { type: 'hidden_user' } })]);
  const withheld = await rows(join(inbox('alpha'), 'queue.jsonl'));
  check('переключение сохраняет старый текст и исторический новый хештег прежнему проекту', !received(r.out).length && [60,61].every(id => withheld.some(row => row.update_id === id)) && !(await rows(join(inbox('beta'), 'queue.jsonl'))).some(row => [60,61].includes(row.update_id)), r.out + r.err);
  check('неверный и пересланный nonce не подтверждают активацию', (await parse(join(HUB, 'projects.json'))).singleActivation.pending === true);
  r = await simulate('beta', [dm(64, '/activate synthetic-activation-code'), dm(65, 'new project instruction')]);
  const activated = await parse(join(HUB, 'projects.json'));
  check('точный nonce задаёт устойчивую границу и пропускает только последующие сообщения', !activated.singleActivation.pending && activated.singleActivation.boundary.update_id === 64 && received(r.out).includes(65) && !received(r.out).some(id => id >= 60 && id <= 64), r.out + r.err);
  r = await simulate('beta', [dm(60, 'old untagged backlog'), dm(61, '#beta historical hashtag')]);
  check('повтор обновления до nonce не переезжает в новый проект', !received(r.out).length && !(await rows(join(inbox('beta'), 'queue.jsonl'))).some(row => [60,61].includes(row.update_id)), r.out + r.err);
  const quarantine = structuredClone(changing); quarantine.singleActivation.previous = null;
  await save(quarantine);
  r = await simulate('beta', [dm(66, 'unknown previous context')]);
  check('при переходе из parallel старое сообщение сохраняется в карантин', (await rows(join(HUB, 'quarantine', 'single-activation.jsonl'))).some(row => row.update_id === 66) && !received(r.out).length, r.out + r.err);
  const invalid = structuredClone(single); invalid.mode = 'unexpected'; await save(invalid);
  r = await simulate('alpha', []);
  check('неизвестный режим не превращается в режим по умолчанию', r.code === 1 && r.err.includes('single/parallel'));
  const duplicate = structuredClone(registry); duplicate.projects.beta.tag = '#alpha'; await save(duplicate);
  r = await simulate('alpha', []);
  check('дублирующиеся маршруты в реестре отклоняются до приёма', r.code === 1 && r.err.includes('неоднозначен'));

  const firstChat = '01234567-0000-4000-8000-000000000001';
  const secondChat = '01234567-0000-4000-8000-000000000002';
  const poll = async (updates, chat = firstChat) => {
    const fixture = join(TMP, `checkpoint-${serial++}.json`);
    await writeFile(fixture, JSON.stringify(updates));
    return run('alpha', ['--checkpoint', '--simulate', fixture], { CODEX_THREAD_ID: chat });
  };
  const confirm = (receipt, chat) => run('alpha', ['--received', receipt, '--no-ack'], { CODEX_THREAD_ID: chat });
  registry.projects.alpha.workspace = await workspaceKey(TMP);
  await save(registry);
  await simulate('alpha', []);
  r = await poll([update(88, 'правка для A', 8), update(89, 'ещё одна правка', 8)]);
  const pending = JSON.parse(r.out);
  const replay = await poll([]);
  check('правка остаётся доступной в том же чате после перезапуска, до подтверждения',
    r.code === 0 && pending.messageId === 88 && JSON.parse(replay.out).receipt === pending.receipt);
  const otherChat = await poll([], secondChat);
  check('другому чату и прежнему режиму drain не видна неподтверждённая правка', otherChat.code === 1 && !otherChat.out &&
    confirm(pending.receipt, secondChat).code === 1 && (await simulate('alpha', [])).code === 1);
  const confirmed = confirm(pending.receipt, firstChat);
  const following = await poll([]);
  check('подтверждение переживает перезапуск и открывает только следующую правку',
    JSON.parse(confirmed.out).type === 'telegram_received' && JSON.parse(following.out).messageId === 89 && confirm(pending.receipt, firstChat).code === 1);
  confirm(JSON.parse(following.out).receipt, firstChat);
  delete registry.projects.alpha.workspace;
  await save(registry);
  r = await simulate('alpha', [], []);
  r = run('alpha', ['--drain'], { TG_BOT_TOKEN: '2:conflict' });
  check('проект не может подменить общего бота переменной окружения', r.code === 1 && r.err.includes('конфликтуют') && !r.err.includes('conflict'));

  // Локальная заглушка fetch пишет интервалы вызовов. Настоящие HTTP-запросы невозможны.
  const calls = join(TMP, 'fetch-calls.jsonl'), mock = join(TMP, 'mock-fetch.mjs');
  await writeFile(mock, `import { appendFile } from 'node:fs/promises';\nconst file=${JSON.stringify(calls)};\nglobalThis.fetch=async(url,options)=>{const method=String(url).split('/').at(-1);if(method!=='getUpdates')throw Error('Unexpected mocked API '+method);await appendFile(file,JSON.stringify({event:'start',pid:process.pid,at:Date.now()})+'\\n');await new Promise(resolve=>setTimeout(resolve,180));await appendFile(file,JSON.stringify({event:'end',pid:process.pid,at:Date.now()})+'\\n');return {ok:true,status:200,json:async()=>({ok:true,result:[]})};};\n`);
  const start = name => new Promise(resolveDone => {
    const proc = spawn(process.execPath, ['--import', mock, join(ROOT, 'tg-listen.mjs'), '--project', name, '--once', '--max-wait', '0.25', '--no-ack'], { cwd: TMP, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; proc.stdout.on('data', data => { out += data; }); proc.stderr.on('data', data => { err += data; });
    proc.on('close', code => resolveDone({ code, out, err }));
  });
  await writeFile(join(HUB, 'poller.lock'), JSON.stringify({ pid: process.pid, at: 0, project: 'alpha' }));
  r = result(spawnSync(process.execPath, ['--import', mock, join(ROOT, 'tg-listen.mjs'), '--project', 'beta', '--drain', '--no-ack'], { cwd: TMP, env, encoding: 'utf8', timeout: 10000 }));
  check('истёкший heartbeat живого процесса не даёт захватить бота', r.code === 0 && !(await rows(calls)).length, r.out + r.err);
  await rm(join(HUB, 'poller.lock'));
  const concurrent = await Promise.all([start('alpha'), start('beta')]);
  const events = await rows(calls); let concurrentCount = 0, peak = 0;
  for (const e of events) { concurrentCount += e.event === 'start' ? 1 : -1; peak = Math.max(peak, concurrentCount); }
  check('два проекта используют ровно одного одновременно опрашивающего бота', concurrent.every(r => r.code === 0) && peak === 1 && concurrentCount === 0, JSON.stringify({ events, concurrent }));

  await writeFile(calls, '');
  const same = await Promise.all([start('alpha'), start('alpha')]);
  check('один проект имеет только одного потребителя при одновременном запуске', same.every(r => r.code === 0) && same.some(r => r.out.includes('уже запущен') || r.out.includes('другой экземпляр')), JSON.stringify(same));
} finally {
  await rm(TMP, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
