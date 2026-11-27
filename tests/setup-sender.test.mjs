// Поведенческие проверки общего бота. Только локальные фикстуры; Telegram и модели не вызываются.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { holdBot } from '../tg-bridge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(resolve(tmpdir(), 'agent-telegram-shared-setup-'));
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` [${extra}]` : ''}`); };
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const put = async (path, data) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(data)); };
const BASE = { getMe: { id: 71, is_bot: true, username: 'test_bot', first_name: 'Test' }, getChat: { id: 111, type: 'private' } };
const GROUP = { id: -100777, type: 'supergroup', is_forum: true, title: 'Projects' };
let serial = 0;
async function sandbox(name, projects = ['alpha']) {
  const base = resolve(TMP, name), hub = resolve(base, 'hub'), repos = {};
  for (const project of projects) {
    const repo = resolve(base, project); await mkdir(repo, { recursive: true });
    await put(resolve(repo, '.agent-telegram.json'), { project, tag: '#' + project.replaceAll('-', '_'), title: project }); repos[project] = repo;
  }
  await mkdir(hub, { recursive: true });
  const token = resolve(base, 'token.txt'); await writeFile(token, '71:sandbox\n', { mode: 0o600 });
  return { base, hub, repos, token };
}
async function run(s, project, file, args, fixture = BASE, extraEnv = {}) {
  const fixturePath = resolve(s.base, `fixture-${serial++}.json`); await put(fixturePath, fixture);
  const env = { ...process.env, TG_HUB: s.hub, ...extraEnv };
  for (const key of ['TG_PROJECT', 'TG_BOT_TOKEN', 'TG_CHAT_ID', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE']) if (!Object.hasOwn(extraEnv, key)) delete env[key];
  const result = spawnSync(process.execPath, [resolve(ROOT, file), ...args, ...(file === 'tg-setup.mjs' ? ['--simulate', fixturePath] : [])],
    { cwd: s.repos[project], env, encoding: 'utf8', timeout: 10000 });
  return { code: result.status, out: (result.stdout || '') + (result.stderr || ''), error: result.error };
}

try {
  const one = await sandbox('single', ['alpha', 'beta']);
  const gitInit = spawnSync('git', ['init', '-q', '-b', 'audit-main'], { cwd: one.repos.alpha });
  let r = await run(one, 'alpha', 'tg-setup.mjs', ['--check']);
  check('первая настройка спрашивает single/parallel и не создаёт реестр без выбора', r.code === 2 && r.out.includes('параллельно') && !await readFile(resolve(one.hub, 'projects.json')).catch(() => null), r.out);
  r = await run(one, 'alpha', 'tg-setup.mjs', ['--mode', 'single', '--token-file', one.token, '--chat-id', '111']);
  let registry = await read(resolve(one.hub, 'projects.json'));
  check('single создаёт общий реестр и проверенную личку без группы', r.code === 0 && registry.version === 2 && registry.mode === 'single' && registry.default === 'alpha' && !registry.group && registry.projects.alpha.privateChat.chat_id === '111', r.out);
  check('токен записан один раз вне проекта и не выведен', (await readFile(resolve(one.hub, '.secrets/telegram.env'), 'utf8')).includes('71:sandbox') && !r.out.includes('71:sandbox') && !await readFile(resolve(one.hub, 'projects/alpha/.secrets/telegram.env')).catch(() => null));
  r = await run(one, 'alpha', 'tg.mjs', ['--dry-run', 'Первый отчёт']);
  check('single отчёт направляется в личку и содержит хештег', r.code === 0 && r.out.includes('личные сообщения') && r.out.includes('#alpha'));
  r = await run(one, 'alpha', 'tg.mjs', ['--dry-run', '--final', 'Проверки прошли.']);
  check('итоговый отчёт содержит хештег, завершение и приглашение в чат', r.code === 0 &&
    ['#alpha', 'работа завершена', 'Проверки прошли', 'откройте этот чат агента в ChatGPT'].every(value => r.out.includes(value)));
  r = await run(one, 'beta', 'tg.mjs', ['--project', 'alpha', '--dry-run', 'Чужой отчёт']);
  check('другая рабочая папка не может отправить отчёт от имени уже подключённого проекта', r.code === 1 && r.out.includes('другой рабочей папкой'));
  const beforeCheck = await readFile(resolve(one.hub, 'projects.json'), 'utf8');
  r = await run(one, 'alpha', 'tg-setup.mjs', ['--check', '--mode', 'parallel']);
  check('проверка с другим режимом не изменяет привязку', r.code === 2 && beforeCheck === await readFile(resolve(one.hub, 'projects.json'), 'utf8'));
  const gitSwitch = spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/audit-second'], { cwd: one.repos.alpha });
  check('переключение на независимую ветку блокирует прежний рабочий контекст', gitInit.status === 0 && gitSwitch.status === 0 &&
    (await run(one, 'alpha', 'tg.mjs', ['--dry-run', 'После смены ветки'])).code === 1);
  spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/audit-main'], { cwd: one.repos.alpha });
  r = await run(one, 'beta', 'tg-setup.mjs', []);
  check('второй проект в single требует явной активации', r.code === 1 && r.out.includes('--activate'));
  r = await run(one, 'beta', 'tg-setup.mjs', ['--activate']);
  registry = await read(resolve(one.hub, 'projects.json'));
  check('смена проекта переиспользует бота, но требует свежий код границы', r.code === 2 && registry.default === 'beta' && Object.keys(registry.projects).length === 2 && registry.projects.beta.privateChat.bot_id === '71' && registry.singleActivation.previous === 'alpha' && /^[a-f0-9]{24}$/.test(registry.singleActivation.code), r.out);
  r = await run(one, 'beta', 'tg.mjs', ['--dry-run', 'До подтверждения']);
  check('sender не отправляет от нового проекта до подтверждения границы', r.code === 1 && r.out.includes('/activate'));
  // Фикстура подтверждённой границы для sender; настоящий разбор nonce проверяется тестами listener.
  registry.singleActivation.pending = false; await put(resolve(one.hub, 'projects.json'), registry);
  r = await run(one, 'alpha', 'tg.mjs', ['--dry-run', 'Старый отчёт']);
  check('неактивный проект не может отправлять в single', r.code === 1 && r.out.includes('активному'));
  await put(resolve(registry.projects.beta.inbox, 'consumer.lock'), { pid: process.pid, at: 0 });
  r = await run(one, 'alpha', 'tg-setup.mjs', ['--activate']);
  check('активация не отбирает живой приём даже с устаревшим heartbeat', r.code === 1 && r.out.includes('остановите'));
  await rm(resolve(registry.projects.beta.inbox, 'consumer.lock'));
  const other = resolve(one.base, 'other-token.txt'); await writeFile(other, '2:different');
  r = await run(one, 'beta', 'tg-setup.mjs', ['--token-file', other]);
  check('другой токен не заменяет общего бота', r.code === 1 && r.out.includes('не заменяет') && !r.out.includes('2:different'));
  r = await run(one, 'beta', 'tg.mjs', ['--text-file', one.token], BASE, { TG_BOT_TOKEN: '2:different' });
  check('sender отказывает конфликтующей переменной токена до сети', r.code === 1 && r.out.includes('конфликтуют') && !r.out.includes('71:sandbox'));

  const many = await sandbox('parallel', ['alpha', 'beta', 'gamma']);
  const groupFixture = { ...BASE, getChat: GROUP, getChatMember: { status: 'administrator', can_manage_topics: true }, createForumTopic: { message_thread_id: 8, name: 'alpha' }, sendMessage: { message_id: 50 } };
  r = await run(many, 'alpha', 'tg-setup.mjs', ['--mode', 'parallel', '--token-file', many.token, '--chat-id', '111', '--group-id', String(GROUP.id)], groupFixture);
  registry = await read(resolve(many.hub, 'projects.json'));
  check('parallel создаёт одну группу и первую тему', r.code === 0 && registry.mode === 'parallel' && registry.group.chat_id === String(GROUP.id) && registry.projects.alpha.topic === 8, r.out);
  r = await run(many, 'beta', 'tg-setup.mjs', [], { ...groupFixture, createForumTopic: { message_thread_id: 9, name: 'beta' } });
  registry = await read(resolve(many.hub, 'projects.json'));
  check('второй проект переиспользует ключ и группу, создаёт отдельную тему', r.code === 0 && registry.projects.beta.topic === 9 && registry.projects.alpha.topic === 8, r.out);
  r = await run(many, 'beta', 'tg.mjs', ['--dry-run', 'Отчёт второй темы']);
  check('parallel sender адресует тему выбранного проекта', r.code === 0 && r.out.includes('топик «beta»') && r.out.includes('#beta'), r.out);
  r = await run(many, 'beta', 'tg.mjs', ['--dry-run', '--dm', 'Неверный маршрут']);
  check('parallel не позволяет обойти тему через --dm', r.code === 1 && r.out.includes('--dm недоступен'));
  await writeFile(resolve(registry.projects.beta.inbox, 'sent.jsonl'), JSON.stringify({ message_id: 65, chat_id: '111', thread: null }) + '\n');
  r = await run(many, 'beta', 'tg.mjs', ['--dry-run', '--reply-to', '65', 'Старый ответ']);
  check('parallel не отвечает на старую личку вместо группы', r.code === 1 && r.out.includes('другого чата'));
  const cleanRegistry = structuredClone(registry); registry.projects.beta.topic = 8; await put(resolve(many.hub, 'projects.json'), registry);
  r = await run(many, 'beta', 'tg.mjs', ['--dry-run', 'Неоднозначная тема']);
  check('sender отклоняет дублирующую тему до отправки', r.code === 1 && r.out.includes('ровно одному'));
  registry = cleanRegistry; await put(resolve(many.hub, 'projects.json'), registry);
  r = await run(many, 'gamma', 'tg-setup.mjs', ['--tag', '#BETA'], groupFixture);
  check('повторный хештег отклоняется без учёта регистра', r.code === 1 && r.out.includes('уникальны'));
  r = await run(many, 'gamma', 'tg-setup.mjs', ['--topic', '8'], groupFixture);
  check('повторный топик не привязывается второму проекту', r.code === 1 && r.out.includes('уникальны'));
  r = await run(many, 'alpha', 'tg-setup.mjs', ['--group-id', '-100888'], groupFixture);
  check('другая группа не подменяет единственную настроенную', r.code === 1 && r.out.includes('другая'));
  r = await run(many, 'alpha', 'tg-setup.mjs', ['--check'], { ...groupFixture, getChat: { id: GROUP.id, type: 'supergroup', is_forum: false } });
  check('группа без тем не выдаётся за готовую parallel-привязку', r.code === 2 && r.out.includes('включёнными темами'));
  r = await run(many, 'alpha', 'tg-setup.mjs', ['--mode', 'single', '--activate']);
  registry = await read(resolve(many.hub, 'projects.json'));
  check('parallel→single требует новую границу без автоматического адресата старой лички', r.code === 2 && registry.singleActivation.pending && registry.singleActivation.previous === null);
  registry.singleActivation.pending = false; await put(resolve(many.hub, 'projects.json'), registry);
  r = await run(many, 'alpha', 'tg.mjs', ['--dry-run', 'После перехода']);
  check('переход в single игнорирует сохранённую группу и топик', r.code === 0 && r.out.includes('личные сообщения') && !r.out.includes('группа «'));

  const pair = await sandbox('pair');
  const code = 'pairing_test_012345';
  const privateMessage = (id, text) => ({ update_id: id, message: { message_id: id, chat: { id: id === 1 ? 999 : 111, type: 'private' }, from: { id: id === 1 ? 999 : 111, is_bot: false }, text } });
  r = await run(pair, 'alpha', 'tg-setup.mjs', ['--mode', 'single', '--token-file', pair.token, '--pair-code', code], { ...BASE, 'getUpdates*': [[privateMessage(1, '/start'), privateMessage(2, '/start ' + code), privateMessage(3, 'первая правка')]] });
  check('первый случайный DM не захватывает владельца, код привязывает правильного', r.code === 0 && (await readFile(resolve(pair.hub, '.secrets/telegram.env'), 'utf8')).includes('TG_CHAT_ID=111'), r.out);
  check('сообщение после кода остаётся в Telegram для приёмника', (await read(resolve(pair.hub, 'offset.json'))).offset === 3);
  const busy = await sandbox('busy');
  const release = await holdBot('71');
  try {
    r = await run(busy, 'alpha', 'tg-setup.mjs', ['--mode', 'single', '--token-file', busy.token, '--pair-code', code]);
    check('setup не запускает getUpdates при существующем общем poller', r.code === 1 && r.out.includes('другой процесс'), r.out);
  } finally { await release(); }

  const legacy = await sandbox('migration');
  const legacyRoot = resolve(legacy.hub, 'projects', 'alpha'), inbox = resolve(legacyRoot, 'inbox/alpha');
  await put(resolve(legacyRoot, 'projects.json'), { default: 'alpha', projects: { alpha: { tag: '#alpha', title: 'alpha', inbox, mode: 'private', privateChat: { chat_id: '111', bot_id: '71' } } } });
  await mkdir(resolve(legacyRoot, '.secrets'), { recursive: true });
  await writeFile(resolve(legacyRoot, '.secrets/telegram.env'), 'TG_BOT_TOKEN=71:sandbox\nTG_CHAT_ID=111\n');
  await put(resolve(inbox, 'state.json'), { seen: [7] });
  await put(resolve(legacyRoot, 'offset.json'), { bot: '71', offset: 8 });
  r = await run(legacy, 'alpha', 'tg-setup.mjs', ['--mode', 'single', '--check']);
  check('старые проекты не мигрируют молча', r.code === 1 && r.out.includes('--migrate'));
  r = await run(legacy, 'alpha', 'tg-setup.mjs', ['--mode', 'single', '--migrate']);
  registry = await read(resolve(legacy.hub, 'projects.json'));
  check('явная миграция сохраняет очередь, старые ключи и offset', r.code === 0 && registry.projects.alpha.inbox === inbox && (await read(resolve(inbox, 'state.json'))).seen[0] === 7 && (await read(resolve(legacy.hub, 'offset.json'))).offset === 8 && !!await readFile(resolve(legacyRoot, '.secrets/telegram.env')), r.out);
  const conflict = await sandbox('migration-conflict', ['alpha', 'beta']);
  for (const [project, token] of [['alpha', '71:sandbox'], ['beta', '2:another']]) {
    const dir = resolve(conflict.hub, 'projects', project);
    await put(resolve(dir, 'projects.json'), { projects: { [project]: { tag: '#' + project, inbox: resolve(dir, 'inbox', project) } } });
    await mkdir(resolve(dir, '.secrets'), { recursive: true });
    await writeFile(resolve(dir, '.secrets/telegram.env'), `TG_BOT_TOKEN=${token}\nTG_CHAT_ID=111\n`);
  }
  r = await run(conflict, 'alpha', 'tg-setup.mjs', ['--mode', 'parallel', '--migrate']);
  check('разные старые токены отклоняются до записи общего реестра', r.code === 1 && r.out.includes('разные боты') && !await readFile(resolve(conflict.hub, 'projects.json')).catch(() => null) && !await readFile(resolve(conflict.hub, '.secrets/telegram.env')).catch(() => null));
  const sharedLegacy = await sandbox('migration-shared-token', ['alpha', 'beta']);
  for (const project of ['alpha', 'beta']) {
    const dir = resolve(sharedLegacy.hub, 'projects', project);
    await put(resolve(dir, 'projects.json'), { default: project, projects: { [project]: { tag: '#' + project, inbox: resolve(dir, 'inbox', project), mode: 'private' } } });
    await mkdir(resolve(dir, '.secrets'), { recursive: true });
    await writeFile(resolve(dir, '.secrets/telegram.env'), 'TG_BOT_TOKEN=71:sandbox\nTG_CHAT_ID=111\n');
  }
  const migration = await run(sharedLegacy, 'alpha', 'tg-setup.mjs', ['--mode', 'single', '--migrate']);
  const migrated = await read(resolve(sharedLegacy.hub, 'projects.json'));
  const blockedSender = await run(sharedLegacy, 'alpha', 'tg.mjs', ['--dry-run', 'До границы миграции']);
  const backlog = resolve(sharedLegacy.base, 'backlog.json');
  await put(backlog, [privateMessage(7, '#alpha старая неоднозначная правка')]);
  const received = await run(sharedLegacy, 'alpha', 'tg-listen.mjs', ['--drain', '--no-ack', '--simulate', backlog]);
  const quarantine = await readFile(resolve(sharedLegacy.hub, 'quarantine', 'single-activation.jsonl'), 'utf8').catch(() => '');
  const targetQueue = await readFile(resolve(migrated.projects.alpha.inbox, 'queue.jsonl'), 'utf8').catch(() => '');
  check('миграция нескольких проектов одного бота в single блокирует sender и сохраняет старую личку без назначения до nonce', migration.code === 2 && migrated.singleActivation?.pending && migrated.singleActivation.previous === null && /^[a-f0-9]{24}$/.test(migrated.singleActivation.code) && blockedSender.code === 1 && received.code === 0 && quarantine.includes('старая неоднозначная правка') && !targetQueue.includes('старая неоднозначная правка') && !received.out.includes('[TG входящее'), migration.out + received.out);
} finally {
  await rm(TMP, { recursive: true, force: true });
}
process.exitCode = fails ? 1 : 0;
