#!/usr/bin/env node
// tg-setup.mjs — настройка связи агента проекта с владельцем через Telegram (набор agent-telegram). Без зависимостей,
// нужен Node 20+. Запускать из папки репозитория проекта. Один бот обслуживает все проекты. Проект задаёт файл
// .agent-telegram.json в корне его репозитория (project, tag, title); ключ бота, номер владельца, очередь и учёт
// хранятся на этом компьютере, вне репозиториев: ~/.agent-telegram/ (общие ключи — .secrets/telegram.env).
//
//   node ~/.agent-telegram/kit/tg-setup.mjs --check     проверка в начале сессии: ничего не ждёт
//   node ~/.agent-telegram/kit/tg-setup.mjs             настройка: проверить ключ; если номера владельца ещё нет —
//                                                       дождаться, пока он нажмёт «Запустить» у бота
//   node ~/.agent-telegram/kit/tg-setup.mjs --init --project <имя> --tag "#хештег" --title "Название"
//                                                       создать .agent-telegram.json в корне git-репозитория проекта
//   Параметры: --project <имя> [--tag "#…" --title "…"]  другой проект в этом же репозитории (например, вторая роль:
//                                                       исполнитель и аудитор — у каждой свой топик и хештег);
//              --wait <минуты>    сколько ждать владельца (по умолчанию 10);
//              --chat-id <номер>  записать номер владельца без ожидания;
//              --group-id <номер> явно выбрать единственную группу, если бот добавлен в несколько;
//              --topic <номер>    использовать существующий топик (также при --init);
//              --mode single|parallel  один проект в личке или параллельные проекты в одной группе;
//              --activate         явно сделать этот проект активным в режиме single;
//              --token-file <файл> прочитать общий токен из локального файла, не из чата/аргументов;
//              --migrate          явно перенести совместимые старые проекты без удаления истории;
//              --pair-code <код>  код привязки первого владельца (обычно создаётся автоматически);
//   --bridge install|status|stop|uninstall    собственная служба и интеграция клиентов на этом компьютере.
//              --here             для --init: папка проекта без git — создать файл в текущей папке;
//              --simulate <файл>  отладка: ответы Telegram берутся из файла, сеть не трогается.
//   Имя проекта — строчная латиница, цифры и дефис (control-center); хештег — «#», буквы, цифры и «_», без дефиса.
//
// Коды выхода: 0 — связь настроена (топик может быть ещё не закреплён — см. «Следующий шаг»);
// 2 — нет ключа, ключ не подходит или (при --check) нет номера владельца; 3 — не дождались владельца;
// 5 — нет связи с Telegram, но ключ и номер владельца записаны: ставьте приём, он сам повторяет попытки; 1 — прочее.
// Токен никогда не печатается.

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { workspaceKey } from './tg-workspace.mjs';

const args = process.argv.slice(2);
if (args[0] === '--bridge') {
  const {spawnSync} = await import('node:child_process');
  const bridge = fileURLToPath(new URL('./tg-bridge.mjs',import.meta.url));
  const run = spawnSync(process.execPath,[bridge,'service',args[1] || 'status'],{stdio:'inherit'});
  process.exit(run.status ?? 1);
}

const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
if (args.includes('-h') || args.includes('--help')) {
  // Справка — только верхний блок комментариев файла.
  const lines = (await readFile(fileURLToPath(import.meta.url), 'utf8')).split(/\r?\n/).slice(1);
  console.log(lines.slice(0, Math.max(0, lines.findIndex((l) => !l.startsWith('//')))).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}
const check = args.includes('--check');
if (check && ['--init', '--migrate', '--activate', '--token-file', '--chat-id'].some(flag => args.includes(flag))) {
  console.error('--check только проверяет подключение. Параметры настройки используйте отдельным вызовом.');
  process.exit(1);
}
const waitMinutes = Number(value('--wait') ?? 10);
const simulate = value('--simulate');
if (!Number.isFinite(waitMinutes) || waitMinutes <= 0 || waitMinutes > 60) { console.error('--wait: больше 0 и не больше 60 минут'); process.exit(1); }

const say = (text) => console.log(text);
const fail = (code, text) => {
  console.log(`[TG настройка] ${text}`);
  process.exit(code);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const BOM = String.fromCharCode(0xfeff);
const stripBom = (s) => (s.startsWith(BOM) ? s.slice(1) : s);
const readJson = async (file, fallback = null) => { try { return JSON.parse(stripBom(await readFile(file, 'utf8'))); } catch { return fallback; } };
const unix = (p) => p.split('\\').join('/');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const placeFrom = (base, p) => (p ? resolve(base, String(p).replace(/^~(?=$|[\\/])/, homedir())) : null);
const inside = (child, parent) => { const rel = relative(parent, child); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
async function findUp(name) {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const file = resolve(dir, name);
    let raw = null;
    try { raw = await readFile(file, 'utf8'); } catch { /* файла нет */ }
    if (raw !== null) { try { return { dir, file, json: JSON.parse(stripBom(raw)) }; } catch { return { dir, file, json: null, broken: true }; } }
    // Выше корня репозитория не поднимаемся: файл из папки выше не должен подхватить чужой проект.
    try { await stat(resolve(dir, '.git')); return null; } catch { /* это не корень репозитория */ }
    if (dirname(dir) === dir) return null;
  }
}
const SELF = unix(fileURLToPath(import.meta.url));
const KEY_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const TAG_RE = /^#[\p{L}\p{N}_]{2,32}$/u;
const sharedHome = placeFrom(process.cwd(), process.env.TG_HUB) || resolve(homedir(), '.agent-telegram');

function topicNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(n)) fail(1, 'topic: нужен положительный целый номер топика');
  return n;
}

function modeName(value) {
  if (!['single', 'parallel'].includes(value)) fail(1, '--mode: выберите single (один активный проект в личке) или parallel (одна группа с темами).');
  return value;
}
const askedMode = args.includes('--mode') ? modeName(value('--mode') ?? '') : null;
async function saveMode(file, project, mode) {
  const data = await readJson(file);
  if (data?.project !== project) fail(1, 'Файл проекта изменился; повторите настройку.');
  if (data.mode === mode) return;
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...data, mode }, null, 2) + '\n');
  await rename(tmp, file);
}

async function saveTopic(file, project, tag, topic, confirmed = false) {
  const data = await readJson(file);
  if (data?.project !== project || data?.tag !== tag) fail(1, `Файл проекта изменился: проверьте ${file}.`);
  if (topicNumber(data.topic) === topic) return;
  if (data.topic != null && !confirmed) fail(1, `В ${file} и на компьютере закреплены разные топики. Сверьте их перед настройкой.`);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...data, topic }, null, 2) + '\n');
  await rename(tmp, file);
  say(`Номер топика сохранён в ${file}. Закоммитьте файл по правилам проекта.`);
}

// ---- --init: файл проекта в корне его репозитория -----------------------------------------------------
if (args.includes('--init')) {
  const project = value('--project'), title = value('--title') || project;
  const tag = value('--tag') || (project && '#' + project.replaceAll('-', '_'));
  if (!project || !KEY_RE.test(project)) fail(1, '--init: нужен --project <имя> — строчная латиница, цифры, дефис (например control-center)');
  if (!tag || !TAG_RE.test(tag)) fail(1, '--init: нужен --tag "#хештег" — «#», буквы, цифры и «_», без дефиса (Telegram обрывает хештег на дефисе)');
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const inGit = top.status === 0 && !!top.stdout.trim();
  if (!inGit && !args.includes('--here')) fail(1, '--init: текущая папка не в git-репозитории. Перейдите в папку репозитория проекта; для проекта без git добавьте --here.');
  const root = await realpath(inGit ? top.stdout.trim() : process.cwd());
  const home = await realpath(homedir());
  const kitDir = resolve(home, '.agent-telegram');
  if (inside(home, root) || dirname(root) === root) fail(1, `--init: ${root} — домашняя папка, папка выше неё или корень диска; файл проекта кладётся только в папку самого проекта`);
  if (inside(root, await realpath(kitDir).catch(() => kitDir))) fail(1, `--init: ${root} — папка самого инструмента; запускайте из папки репозитория проекта`);
  const file = resolve(root, '.agent-telegram.json');
  const local = (await readJson(resolve(sharedHome, 'projects.json')))?.projects?.[project];
  const prior = await readJson(file);
  const mode = askedMode ? (askedMode === 'single' ? 'private' : 'topic') : prior?.mode ?? local?.mode;
  if (askedMode === 'single' && args.includes('--topic')) fail(1, 'Для single номер топика не используется.');
  const topic = topicNumber(value('--topic') ?? local?.topic);
  if (local?.topic && topic !== topicNumber(local.topic)) fail(1, 'У проекта уже закреплён другой топик. Сверьте номер.');
  let raw = null;
  try { raw = await readFile(file, 'utf8'); } catch { /* файла нет */ }
  if (raw !== null) {
    let existing = null;
    try { existing = JSON.parse(stripBom(raw)); } catch { fail(1, `${file} уже есть, но это не JSON — поправьте его вручную`); }
    if (existing?.project !== project || existing?.tag !== tag) fail(1, `${file} уже есть и задаёт другой проект (${existing?.project}, ${existing?.tag}) — поправьте его вручную, если так и задумано`);
    if (mode) await saveMode(file, project, mode);
    if (topic) await saveTopic(file, project, tag, topic, topic === local?.topic && args.includes('--topic'));
    say(`[TG настройка] ${file} уже есть. Теперь запустите tg-setup.mjs --check.`);
    process.exit(0);
  }
  await writeFile(file, JSON.stringify({ project, tag, title, ...(mode && { mode }), ...(topic && { topic }) }, null, 2) + '\n', { flag: 'wx' });
  say(`[TG настройка] создан ${file}${inGit ? ' — закоммитьте его по правилам репозитория (секретов в нём нет)' : ''}. Теперь запустите node "${SELF}" для настройки.`);
  process.exit(0);
}

// ---- какой проект настраиваем -------------------------------------------------------------------------
const found = await findUp('.agent-telegram.json');
if (found?.broken) fail(1, `${found.file} есть, но это не JSON — поправьте его`);
const asked = value('--project');
// Файл проекта берётся, только если он про тот же проект: --project другой роли не наследует чужой хештег.
const cfg = found?.json && (!asked || asked === found.json.project) ? found.json : {};
const PROJECT = asked || cfg.project;
if (!PROJECT) {
  fail(1, [
    'не найден .agent-telegram.json (ищется от текущей папки вверх, не выше корня репозитория) — запускайте из папки репозитория проекта.',
    'Если вы в репозитории проекта, проверьте по порядку (подробно — AGENT.md, пункт «не найден .agent-telegram.json»):',
    '1) правила проекта или ваши общие правила уже описывают свою связь с владельцем через Telegram — работайте по ним, набор не нужен;',
    '2) файл есть в другой ветке: git fetch, затем git log --all --source --oneline -- .agent-telegram.json — возьмите его оттуда,',
    '   новый проект не заводите;',
    '3) иначе проект ещё не подключён: имя и хештег возьмите из задания или спросите у владельца хештег (предложите свой, например',
    `   #my_project) и создайте файл: node "${SELF}" --init --project <имя-латиницей> --tag "#хештег" --title "Название".`,
  ].join('\n'));
}
if (!KEY_RE.test(PROJECT)) fail(1, `имя проекта «${PROJECT}» не подходит: строчная латиница, цифры, дефис`);
const HUB = sharedHome;
const legacyHub = cfg.hub && placeFrom(found?.dir || process.cwd(), cfg.hub) !== HUB ? placeFrom(found?.dir || process.cwd(), cfg.hub) : null;
if (legacyHub && legacyHub !== resolve(HUB, 'projects', PROJECT)) fail(1, 'Автоматический перенос нестандартного каталога hub не реализован. Исходная установка сохранена; для неё нужен отдельный аудит переноса.');
if (legacyHub && !args.includes('--migrate')) fail(1, 'Поле hub указывает на старый отдельный каталог проекта. Выполните --migrate --mode single|parallel: путь будет снят только после успешного переноса.');
const SECRETS = resolve(HUB, '.secrets', 'telegram.env');
const REGISTRY = resolve(HUB, 'projects.json');
const OFFSET = resolve(HUB, 'offset.json');
const CONFIG = resolve(HUB, 'config.json');
if (!check) await mkdir(HUB, { recursive: true, mode: 0o700 });
if (args.includes('--migrate')) await migrateLegacy();
const initialRegistry = await readJson(REGISTRY);
if (legacyHub && initialRegistry?.version === 2 && initialRegistry.projects?.[PROJECT]?.tag === cfg.tag) {
  const portable = await readJson(found.file);
  if (portable?.project !== PROJECT || portable?.hub !== cfg.hub) fail(1, 'Файл проекта изменился во время переноса.');
  delete portable.hub;
  const tmp = `${found.file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(portable, null, 2) + '\n'); await rename(tmp, found.file);
  delete cfg.hub;
}
if (initialRegistry && initialRegistry.version !== 2) fail(1, 'Старый реестр: требуется явный перенос --migrate.');
if (!initialRegistry && !args.includes('--migrate') && (await legacyRoots()).length) fail(1, 'Найдены старые проекты с отдельными ботами. Сначала выполните --migrate --mode single|parallel; автоматического объединения ключей нет.');
const SHARED_MODE = askedMode || initialRegistry?.mode;
if (!SHARED_MODE) fail(2, 'Будете вести один проект за раз или несколько параллельно? Один бот нужен в обоих случаях. Повторите настройку с --mode single (личка) или --mode parallel (одна группа с темами).');
modeName(SHARED_MODE);
const MODE = SHARED_MODE === 'single' ? 'private' : 'topic';
const known = initialRegistry?.projects?.[PROJECT];
const workspace = await workspaceKey(found?.dir);
if (known?.workspace && known.workspace !== workspace) fail(1, 'Проект уже закреплён за другой рабочей папкой или веткой.');
if (MODE === 'private' && args.includes('--topic')) fail(1, 'Для single номер топика не используется.');
const TAG = value('--tag') || cfg.tag || known?.tag;
const TITLE = value('--title') || cfg.title || known?.title || PROJECT;
if (!TAG) fail(1, `для проекта «${PROJECT}» при первой настройке на этом компьютере нужен --tag "#хештег" — у второй роли он есть в задании владельца (или запуск из репозитория, где .agent-telegram.json описывает этот проект). .agent-telegram.json главной роли не меняйте.`);
// Явный --project, отличный от проекта репозитория (.agent-telegram.json или своя связь в tools/), — обычно вторая
// роль: общий бот и отдельный топик. Файл главной роли может лежать и в другой ветке, поэтому без видимого проекта
// репозитория подсказка называет оба случая.
const mainProject = found?.json?.project || null;
const separate = !!asked && asked !== mainProject;
const topicWhere = !separate ? 'в топике проекта'
  : mainProject ? 'в новом отдельном топике этой роли (не в топике главной роли)'
    : 'в отдельном топике этого проекта (если это вторая роль — в новом, не в топике главной роли)';
const RERUN = `node "${SELF}"${asked ? ` --project ${PROJECT}` : ''}`;
if (!TAG_RE.test(TAG)) fail(1, `хештег ${TAG} не подходит: «#», буквы, цифры и «_» (Telegram обрывает хештег на дефисе)`);
if (check && (!known || initialRegistry.mode !== SHARED_MODE)) fail(2, `Этот проект ещё не подключён в выбранном режиме. Выполните обычную настройку: ${RERUN}.`);

// ---- общая папка проекта и список проектов ---------------------------------------------------------
// Запись реестра — под той же локальной блокировкой, что и общий приёмник.
async function withLock(fn) {
  const { holdRegistry } = await import('./tg-bridge.mjs');
  let release;
  try { release = await holdRegistry(HUB); } catch { fail(1, 'Общий реестр занят, повторите настройку.'); }
  try { return await fn(); } finally { await release(); }
}

async function ensureRegistry(group = null, edit = null) {
  if (check) {
    validateProjects(initialRegistry);
    if (String(known.tag).toLowerCase() !== TAG.toLowerCase() || SHARED_MODE === 'single' && initialRegistry.default !== PROJECT)
      fail(1, 'Рабочая привязка или активный проект не совпадает. Сверьте настройку.');
    if (group && String(initialRegistry.group?.chat_id) !== String(group.id)) fail(2, 'Группа ещё не закреплена. Выполните обычную настройку.');
    if (edit) edit(structuredClone(known));
    return initialRegistry;
  }
  await mkdir(resolve(HUB, 'inbox', PROJECT), { recursive: true });
  return withLock(async () => {
    let existing;
    try { existing = JSON.parse(stripBom(await readFile(REGISTRY, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') fail(1, `Не удалось прочитать ${REGISTRY}. Восстановите реестр перед настройкой.`); }
    const reg = existing || { version: 2, mode: SHARED_MODE, default: PROJECT, projects: {} };
    if (reg.version !== 2 || !['single', 'parallel'].includes(reg.mode)) fail(1, 'Общий реестр изменился или повреждён. Повторите проверку.');
    if (existing && reg.mode !== SHARED_MODE && !askedMode) fail(1, 'Режим изменился во время настройки. Повторите команду с актуальными настройками.');
    reg.projects ||= {};
    let changed = !existing;
    if (reg.mode !== SHARED_MODE || args.includes('--activate') && reg.default !== PROJECT) {
      if (reg.singleActivation?.pending) fail(2, 'Сначала подтвердите уже начатую смену проекта кодом /activate в личке бота.');
      for (const p of Object.values(reg.projects)) for (const name of ['consumer.lock', 'listener.lock']) {
        const lock = await readJson(resolve(p.inbox, name));
        if (lock?.pid && alive(lock.pid)) fail(1, 'Сначала остановите действующий приём перед сменой режима или активного проекта.');
      }
      const lock = await readJson(resolve(HUB, 'poller.lock'));
      if (lock?.pid && alive(lock.pid)) fail(1, 'Сначала остановите действующий общий приём перед сменой режима или активного проекта.');
      if (reg.mode !== SHARED_MODE && SHARED_MODE === 'single' && reg.default !== PROJECT && !args.includes('--activate'))
        fail(1, 'Для перехода в single укажите --activate у выбранного проекта.');
      if (SHARED_MODE === 'single') reg.singleActivation = { project: PROJECT, previous: reg.mode === 'single' ? reg.default : null, code: randomBytes(12).toString('hex'), pending: true };
      else delete reg.singleActivation;
      reg.mode = SHARED_MODE;
      for (const p of Object.values(reg.projects)) p.mode = MODE;
      if (args.includes('--activate')) reg.default = PROJECT;
      changed = true;
    }
    if (SHARED_MODE === 'single' && reg.default && reg.default !== PROJECT && !args.includes('--activate'))
      fail(1, `В single активен проект «${reg.default}». Для последовательной смены повторите с --activate; для параллельной работы выберите --mode parallel.`);
    if (!Object.hasOwn(reg.projects, PROJECT)) { reg.projects[PROJECT] = { title: TITLE, tag: TAG, mode: MODE, inbox: unix(resolve(HUB, 'inbox', PROJECT)) }; changed = true; }
    else if (String(reg.projects[PROJECT].tag).toLowerCase() !== TAG.toLowerCase()) fail(1, `в ${REGISTRY} у проекта «${PROJECT}» другой хештег (${reg.projects[PROJECT].tag}) — проверьте .agent-telegram.json и --tag`);
    if (reg.projects[PROJECT].workspace && reg.projects[PROJECT].workspace !== workspace) fail(1, 'Проект уже закреплён за другой рабочей папкой или веткой.');
    if (!check && !reg.projects[PROJECT].workspace) { reg.projects[PROJECT].workspace = workspace; changed = true; }
    if (reg.projects[PROJECT].mode !== MODE) { reg.projects[PROJECT].mode = MODE; changed = true; }
    if (!reg.default || !reg.projects[reg.default]) { reg.default = PROJECT; changed = true; }
    if (group) {
      if (reg.group?.chat_id && String(reg.group.chat_id) !== String(group.id)) fail(1, 'У проекта и компьютера разные группы. Проверьте настройки.');
      if (!reg.group?.chat_id) {
        reg.group = { chat_id: String(group.id), title: group.title || '', forum: true, topics: {} };
        changed = true;
      }
    }
    if (edit && edit(reg.projects[PROJECT])) changed = true;
    validateProjects(reg);
    if (changed) {
      const { atomic } = await import('./tg-bridge.mjs');
      await atomic(REGISTRY, reg);
    }
    return reg;
  });
}

function validateProjects(reg) {
  const tags = new Set(), topics = new Set(), inboxes = new Set();
  for (const [key, p] of Object.entries(reg.projects)) {
    if (!KEY_RE.test(key) || !TAG_RE.test(p.tag || '') || typeof p.inbox !== 'string' || !inside(resolve(p.inbox), HUB)) fail(1, 'Неверный проект, хештег или путь входящих в общем реестре.');
    const inbox = resolve(p.inbox);
    if (p.aliases != null && !Array.isArray(p.aliases)) fail(1, 'Неверные псевдонимы хештега в реестре.');
    for (const tag of [p.tag, ...(p.aliases || [])]) {
      if (!TAG_RE.test(tag) || tags.has(tag.toLowerCase())) fail(1, 'Хештеги и псевдонимы должны быть уникальны для каждого проекта.');
      tags.add(tag.toLowerCase());
    }
    if (inboxes.has(inbox) || p.topic && topics.has(topicNumber(p.topic))) fail(1, 'Хештег, топик и папка входящих должны быть уникальны для каждого проекта.');
    inboxes.add(inbox); if (p.topic) topics.add(topicNumber(p.topic));
  }
}

async function legacyRoots() {
  const dirs = await readdir(resolve(HUB, 'projects'), { withFileTypes: true }).catch(() => []);
  const roots = [];
  for (const d of dirs) if (d.isDirectory() && KEY_RE.test(d.name)) {
    const root = resolve(HUB, 'projects', d.name);
    if (await stat(resolve(root, 'projects.json')).catch(() => null)) roots.push(root);
  }
  return roots;
}

async function migrateLegacy() {
  return withLock(async () => {
  const existing = await readJson(REGISTRY);
  if (existing?.version === 2) { say('[TG настройка] общий реестр уже перенесён.'); return; }
  if (!askedMode) fail(1, '--migrate требует --mode single или --mode parallel.');
  const roots = await legacyRoots();
  if (existing) roots.unshift(HUB);
  if (!roots.length) { say('[TG настройка] старых проектов для переноса нет.'); return; }
  const reg = { version: 2, mode: askedMode, default: PROJECT, projects: {} };
  let token, owner, groupId;
  const offsets = [];
  for (const root of roots) {
    const old = await readJson(resolve(root, 'projects.json'));
    if (!old?.projects || typeof old.projects !== 'object') fail(1, 'Старый реестр повреждён; перенос остановлен без удаления данных.');
    for (const lockFile of [resolve(root, 'poller.lock'), ...Object.values(old.projects).flatMap(p => [resolve(p.inbox, 'consumer.lock'), resolve(p.inbox, 'listener.lock')])]) {
      const lock = await readJson(lockFile);
      if (lock?.pid && alive(lock.pid)) fail(1, 'Остановите старые приёмники перед переносом. Живые процессы не останавливаются автоматически.');
    }
    const raw = await readFile(resolve(root, '.secrets', 'telegram.env')).catch(() => null);
    const values = raw ? parseSecrets(raw) : {};
    if (token && values.TG_BOT_TOKEN && token !== values.TG_BOT_TOKEN) fail(1, 'В старых проектах разные боты. Автоматическое объединение запрещено: выберите одного бота и отдельную безопасную миграцию. Данные не удалены.');
    if (owner && values.TG_CHAT_ID && owner !== values.TG_CHAT_ID) fail(1, 'В старых проектах разные владельцы; перенос остановлен.');
    if (groupId && old.group?.chat_id && groupId !== String(old.group.chat_id)) fail(1, 'В старых проектах разные группы; перенос остановлен.');
    token ||= values.TG_BOT_TOKEN; owner ||= values.TG_CHAT_ID; groupId ||= old.group?.chat_id && String(old.group.chat_id);
    if (old.group) reg.group ||= old.group;
    for (const [key, p] of Object.entries(old.projects)) {
      if (Object.hasOwn(reg.projects, key)) fail(1, 'В старых реестрах повторяется проект; перенос остановлен.');
      reg.projects[key] = { ...p, mode: askedMode === 'single' ? 'private' : 'topic' };
    }
    const offset = await readJson(resolve(root, 'offset.json'));
    if (offset?.bot && token && String(offset.bot) === token.split(':')[0] && Number.isSafeInteger(offset.offset)) offsets.push(offset.offset);
  }
  if (!Object.hasOwn(reg.projects, PROJECT)) fail(1, '--migrate: выберите существующий старый проект через --project.');
  if (askedMode === 'single' && Object.keys(reg.projects).length > 1)
    reg.singleActivation = { project: PROJECT, previous: null, code: randomBytes(12).toString('hex'), pending: true };
  validateProjects(reg);
  const current = await readSecrets();
  if (current.token && token && current.token !== token || current.chat && owner && current.chat !== owner) fail(1, 'Общий ключ или владелец конфликтуют со старой настройкой; перенос остановлен.');
  if (token) await writeSecrets(Object.entries({ TG_BOT_TOKEN: token, ...(owner && { TG_CHAT_ID: owner }) }), true);
  if (offsets.length) await writeFile(OFFSET, JSON.stringify({ bot: token.split(':')[0], offset: Math.min(...offsets) }));
  const tmp = `${REGISTRY}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 }); await rename(tmp, REGISTRY);
  say('[TG настройка] совместимые проекты перенесены в общий реестр; старые файлы, очереди и привязки сохранены.');
  });
}

// ---- ключи --------------------------------------------------------------------------------------------
// Файл ключей мог быть записан как угодно: UTF-16 (PowerShell 5.1), с BOM, с «export», в кавычках.
// Если ключ нашёлся в таком виде, файл переписывается простыми строками UTF-8 — их понимают tg.mjs и tg-listen.mjs.
async function writeSecrets(entries, locked = false) {
  const write = async () => {
    const raw = await readFile(SECRETS).catch(() => null);
    const previous = raw ? parseSecrets(raw) : {};
    const next = Object.fromEntries(entries);
    for (const key of ['TG_BOT_TOKEN', 'TG_CHAT_ID']) if (previous[key] && next[key] && previous[key] !== next[key])
      fail(1, `Общая настройка ${key} уже задана другим значением. Автоматическая замена запрещена.`);
    const values = { ...previous, ...next };
    await mkdir(dirname(SECRETS), { recursive: true, mode: 0o700 });
    const tmp = `${SECRETS}.${process.pid}.tmp`;
    await writeFile(tmp, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    await rename(tmp, SECRETS);
  };
  return locked ? write() : withLock(write);
}
function parseSecrets(buf) {
  const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || buf.includes(0);
  const raw = stripBom(buf.toString(utf16 ? 'utf16le' : 'utf8'));
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}
async function readSecrets() {
  let buf = null;
  try { buf = await readFile(SECRETS); } catch { /* файла ещё нет */ }
  const values = buf ? parseSecrets(buf) : {};
  for (const key of ['TG_BOT_TOKEN', 'TG_CHAT_ID']) {
    if (process.env[key] && values[key] && process.env[key] !== values[key]) fail(1, `Переменная ${key} не совпадает с общей настройкой. Замена бота или владельца не выполняется автоматически.`);
  }
  return { values, token: values.TG_BOT_TOKEN || process.env.TG_BOT_TOKEN || null, chat: values.TG_CHAT_ID || process.env.TG_CHAT_ID || null };
}
async function writeSecret(key, val) {
  const { values } = await readSecrets();
  values[key] = val;
  await writeSecrets(Object.entries(values));
}

// ---- Telegram -----------------------------------------------------------------------------------------
let fixture = null;
const fixtureCalls = {};
async function api(token, method, body = {}, timeoutMs = 30000) {
  if (simulate) {
    // Файл отладки: { "getMe": {...}, "getUpdates*": [[...], [...]], "sendMessage": {...}, "getChatMember": {...} };
    // «*» — по ответу на каждый вызов по очереди; { "error_code": 401 } — ошибка.
    fixture ||= await readJson(resolve(simulate), {});
    for (const [key, expected] of Object.entries(fixture.expect?.[method] || {})) {
      if (body[key] !== expected) throw new Error(`Проверка запроса ${method}: неверное поле ${key}`);
    }
    const n = (fixtureCalls[method] = (fixtureCalls[method] ?? -1) + 1);
    const answer = Array.isArray(fixture[`${method}*`]) ? fixture[`${method}*`][n] : fixture[method];
    if (answer === undefined) return method === 'getUpdates' ? [] : true;
    if (answer?.error_code) throw Object.assign(new Error(answer.description || 'ошибка'), { code: answer.error_code });
    if (answer?.network) throw Object.assign(new Error('сеть недоступна или истекло время (проверка)'), { network: true });
    // Как Telegram: обновления с номером меньше offset считаются подтверждёнными и не возвращаются.
    if (method === 'getUpdates' && Array.isArray(answer)) return answer.filter((u) => u.update_id >= (body.offset || 0) && body.allowed_updates.some((type) => u[type]));
    return answer;
  }
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // Текст сетевой ошибки может содержать адрес с ключом — наружу только её вид.
    // Код причины (ENOTFOUND, ECONNREFUSED, EACCES…) ключа не содержит и помогает отличить запрет песочницы от сбоя.
    throw Object.assign(new Error(`сеть недоступна или истекло время (${[error?.name, error?.cause?.code].filter(Boolean).join(': ') || 'ошибка'})`), { network: true });
  }
  const data = await response.json().catch(() => null);
  if (!data?.ok) throw Object.assign(new Error(String(data?.description || `HTTP ${response.status}`).replaceAll(token, '[скрыто]')), { code: data?.error_code || response.status });
  return data.result;
}

async function machineConfig() {
  try {
    const cfg = JSON.parse(stripBom(await readFile(CONFIG, 'utf8')));
    if (/^[1-9]\d*$/.test(cfg.owner_id) && (cfg.group_id == null || /^-[1-9]\d*$/.test(cfg.group_id))) return cfg;
  } catch (error) { if (error.code === 'ENOENT') return null; }
  fail(1, `Проверьте owner_id и group_id в ${CONFIG}.`);
}

// Два первых проекта могут настраиваться одновременно. Готовая пара появляется целиком и только один раз.
async function rememberMachine(owner, group) {
  return withLock(async () => {
    const saved = await machineConfig();
    if (saved?.owner_id && String(saved.owner_id) !== owner || saved?.group_id && group && String(saved.group_id) !== String(group.id)) fail(1, 'На компьютере уже настроены другой владелец или группа. Проверьте config.json.');
    const tmp = `${CONFIG}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...saved, owner_id: owner, ...(group && { group_id: String(group.id) }) }, null, 2) + '\n', { mode: 0o600 });
    await rename(tmp, CONFIG);
  });
}

// ---- шаги ---------------------------------------------------------------------------------------------
let reg = await ensureRegistry();
if (!check && cfg.project && askedMode) await saveMode(found.file, PROJECT, MODE);
let { token, chat } = await readSecrets();
if (value('--token-file')) {
  const path = resolve(value('--token-file'));
  let raw; try { raw = await readFile(path); } catch { fail(1, 'Не удалось прочитать --token-file.'); }
  const supplied = parseSecrets(raw).TG_BOT_TOKEN || stripBom(raw.toString('utf8')).trim();
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(supplied)) fail(1, '--token-file: нужен токен BotFather или env-файл с TG_BOT_TOKEN.');
  if (token && supplied !== token) fail(1, 'Уже настроен один общий бот. Другой токен не заменяет его автоматически.');
  token = supplied;
}
if (token && !/^\d+:[A-Za-z0-9_-]+$/.test(token)) fail(2, 'Некорректный формат общего токена. Проверьте локальный файл ключа.');
if (chat && !/^[1-9]\d*$/.test(String(chat))) fail(1, 'Некорректный номер владельца в общей настройке.');
if (token && !check) await writeSecrets(Object.entries({ TG_BOT_TOKEN: token, ...(chat && { TG_CHAT_ID: chat }) }));
const machine = await machineConfig();
if (!token) {
  if (!check) await mkdir(dirname(SECRETS), { recursive: true, mode: 0o700 });
  fail(2, [
    `НЕТ КЛЮЧА БОТА. Для всех проектов используется один бот.`,
    'Если бот уже есть, используйте его; иначе один раз создайте его у @BotFather (/newbot). Ключ: /mybots → бот → API Token.',
    MODE === 'private' ? 'Режим single: один активный проект в личке, группа не нужна.' : 'Режим parallel: добавьте этого же бота администратором в одну группу с темами и правом управления темами.',
    `Сохраните ключ локально в ${unix(SECRETS)} строкой TG_BOT_TOKEN=<ключ> либо используйте --token-file <локальный-файл>.`,
    'Ключ не отправляйте в чат, не печатайте и не коммитьте. Проверка ничего не отправляет и не забирает входящие:',
    `${RERUN} --check`,
    'Проверьте имя общего бота. Для привязки владельца запустите настройку и отправьте боту предложенный одноразовый код:',
    RERUN,
    'Ключ не печатать, не коммитить и не пересказывать в отчётах.',
  ].join('\n'));
}

let me;
try { me = await api(token, 'getMe'); }
catch (error) {
  if (error.code === 401 || error.code === 404) fail(2, `Telegram не принял ключ (${error.code}). Проверьте строку TG_BOT_TOKEN в ${SECRETS} — нужен ключ от @BotFather целиком.`);
  // Ключ и номер уже записаны — значит, связь настроена, а сбоит сеть: приём сам повторяет попытки.
  if (chat) {
    if (MODE === 'private') fail(reg.projects[PROJECT].privateChat ? 5 : 1, `не удалось связаться с Telegram: ${error.message}. Режим single; повторите проверку связи позже.`);
    const pinned = !!(await readJson(REGISTRY))?.projects?.[PROJECT]?.topic;
    fail(5, `Не удалось связаться с Telegram: ${error.message}. Сохранённая привязка ${pinned ? 'есть' : 'не завершена'}, но текущая доставка не проверена. Повторите проверку при восстановлении сети.`);
  }
  fail(1, `не удалось связаться с Telegram: ${error.message}`);
}
const at = me.username ? ` @${me.username}` : '';
const botName = `${me.first_name || 'бот'}${me.username ? ` (@${me.username})` : ''}`;
if (MODE === 'private' && me.has_topics_enabled) fail(2, 'Режим single использует обычную личку. Отключите темы в личных чатах этого бота через @BotFather.');

if (machine) {
  if (chat && String(machine.owner_id) !== chat) fail(1, 'В настройках проекта и компьютера разные владельцы.');
  if (!chat) {
    chat = String(machine.owner_id);
    if (!check) await writeSecret('TG_CHAT_ID', chat);
  }
}
if (!chat && value('--chat-id')) {
  const given = String(value('--chat-id'));
  if (!/^\d{3,15}$/.test(given)) fail(1, '--chat-id: нужен числовой номер пользователя Telegram');
  await writeSecret('TG_CHAT_ID', given);
  chat = given;
  say('[TG настройка] номер владельца записан (из --chat-id)');
}
if (!chat && check) fail(2, `Ключ есть (бот ${botName}), но владелец ещё не привязан. Запустите ${RERUN}, затем отправьте боту предложенный код /start. --check входящие не забирает.`);
let taggedTopic;
let group = MODE === 'topic' && (reg.group?.chat_id || machine?.group_id) ? { id: reg.group?.chat_id || machine.group_id, title: reg.group?.title } : null;
if (value('--group-id')) {
  const id = value('--group-id');
  if (MODE !== 'topic' || !/^-[1-9]\d*$/.test(id)) fail(1, '--group-id допустим только в parallel: нужен отрицательный номер группы.');
  if (group && String(group.id) !== id || machine?.group_id && String(machine.group_id) !== id) fail(1, 'Уже закреплена другая единственная группа. Автоматическая замена запрещена.');
  group = { id };
}
if (!check && (!chat || (MODE === 'topic' && !group))) {
  const lock = await readJson(resolve(HUB, 'poller.lock'));
  if (lock?.pid && lock.pid !== process.pid && alive(lock.pid)) fail(1, `бота уже читает слушатель (pid ${lock.pid}) — остановите его и запустите настройку снова`);
  // Приём этого проекта держит прежний ключ в памяти (а после 409 отпускает poller.lock) — сначала его остановить.
  const consumer = await readJson(resolve(reg.projects[PROJECT]?.inbox || resolve(HUB, 'inbox', PROJECT), 'consumer.lock'));
  if (consumer?.pid && consumer.pid !== process.pid && alive(consumer.pid)) fail(1, `приём этого проекта уже запущен (pid ${consumer.pid}) — остановите его перед настройкой`);
  // offset.json другого бота (ключ сменили) не годится: номера обновлений у каждого бота свои. Файл без номера бота
  // (прежние версии) тоже не доверяем: начать с нуля безопасно — подтверждённое Telegram больше не отдаст.
  const BOT = String(token).split(':')[0].trim();
  const { holdBot } = await import('./tg-bridge.mjs');
  let releaseBot; try { releaseBot = await holdBot(BOT); } catch { fail(1, 'Общего бота уже читает другой процесс. Остановите его перед настройкой.'); }
  const pairCode = value('--pair-code') || randomBytes(12).toString('hex');
  if (!/^[A-Za-z0-9_-]{12,64}$/.test(pairCode)) fail(1, '--pair-code: 12–64 латинских букв, цифр, _ или -.');
  if (!chat) say(`[TG настройка] бот: ${botName}. Отправьте ему в личку /start ${pairCode}. Ожидание — до ${waitMinutes} мин.`);
  const saved = await readJson(OFFSET, {});
  let offset = saved?.bot && String(saved.bot) === BOT ? Number(saved.offset) || 0 : 0;
  const until = Date.now() + waitMinutes * 60000;
  // Добавление в группу может прийти раньше личного сообщения. Выбираем группу только после проверки отправителя.
  const candidates = [];
  while (Date.now() < until) {
    let updates;
    try { updates = await api(token, 'getUpdates', { offset, timeout: chat ? 0 : Math.max(1, Math.min(50, Math.ceil((until - Date.now()) / 1000))), allowed_updates: ['message', 'edited_message', 'my_chat_member', 'callback_query'] }, 75000); }
    catch (error) {
      if (error.code === 409) fail(1, 'этого бота уже читает кто-то ещё (409): приём этого проекта идёт в другом месте — на другом компьютере или в другой сессии. Его нужно остановить там (чужие процессы не трогайте — попросите владельца) и запустить настройку снова; новый бот для этого не нужен. Используйте прежнего общего бота; второго создавать не нужно.');
      if (error.code === 401) fail(2, 'Telegram не принял ключ (401)');
      if (chat) fail(1, `не удалось проверить группу: ${error.message}`);
      await sleep(3000);
      continue;
    }
    const wasWaitingForOwner = !chat;
    for (const update of updates) {
      const m = update.message;
      const member = update.my_chat_member;
      const event = member?.new_chat_member?.user?.id === me.id && ['administrator', 'member'].includes(member.new_chat_member.status) ? member : m;
      if (MODE === 'topic' && event?.chat?.type === 'supergroup' && event.chat.is_forum && event.chat.id < 0 && event.from?.id && !event.from.is_bot) {
        const tagged = m?.is_topic_message && m.text?.trim().toLowerCase() === TAG.toLowerCase();
        candidates.push({ owner: String(event.from.id), chat: event.chat, message: event === m, topic: tagged ? m.message_thread_id : null });
      }
      if (!chat) {
        offset = update.update_id + 1;
        if (m?.chat?.type === 'private' && m.from?.id && m.from.id === m.chat.id && !m.from.is_bot && m.text?.trim() === `/start ${pairCode}`) {
          chat = String(m.from.id);
          await writeSecret('TG_CHAT_ID', chat);
          say('[TG настройка] владелец подтвердил привязку. Номер сохранён локально.');
        }
      }
    }
    // После первого личного сообщения очередь остаётся слушателю, в том числе сообщение с хештегом.
    await writeFile(OFFSET, JSON.stringify({ bot: BOT, offset }));
    if (chat) {
      if (MODE === 'private') break;
      const own = candidates.filter((entry) => entry.owner === chat);
      if (!group && new Set(own.map(entry => String(entry.chat.id))).size > 1) fail(1, 'Найдено несколько групп владельца. Явно выберите одну через --group-id; привязка не изменена.');
      const groupMessage = own.find((entry) => entry.message);
      if (!group && groupMessage) group = groupMessage.chat;
      if (!group && new Set(own.map((entry) => entry.chat.id)).size === 1) group = own[0].chat;
      taggedTopic = own.find((entry) => entry.topic && entry.chat.id === group?.id)?.topic;
      if (!group && wasWaitingForOwner) continue; // смотрим следующую порцию, не подтверждая сообщения после /start
      break;
    }
    if (simulate && !updates.length) break;
  }
  await releaseBot();
  if (!chat) fail(3, `Код привязки владельца не получен. Повторите ${RERUN} и отправьте новый код боту${at}.`);
}
if (MODE === 'private') {
  const bot = String(token).split(':')[0];
  if (!/^[1-9]\d*$/.test(chat)) fail(1, 'Для single нужен номер проверенного владельца.');
  const saved = reg.projects[PROJECT].privateChat;
  if (check && (saved?.chat_id !== chat || saved?.bot_id !== bot))
    fail(2, `Личный чат этого бота еще не проверен. Откройте бота${at}, нажмите «Запустить», затем ${RERUN}.`);
  if (!check) {
    let dm;
    try { dm = await api(token, 'getChat', { chat_id: chat }); }
    catch (error) { fail(2, `Личный чат недоступен: ${error.message}. Откройте бота${at}, нажмите «Запустить» (или разблокируйте его), затем ${RERUN}.`); }
    if (dm?.type !== 'private' || String(dm.id) !== chat) fail(1, 'Telegram вернул другой чат. Привязка лички не сохранена.');
    await ensureRegistry(null, p => {
      if (p.privateChat?.chat_id === chat && p.privateChat?.bot_id === bot) return false;
      p.privateChat = { chat_id: chat, bot_id: bot }; return true;
    });
    await rememberMachine(chat, null);
  }
  say(`[TG настройка] проект «${TITLE}», хештег ${TAG} · бот ${botName} · номер владельца: записан`);
  say('  режим: single — один активный проект в личке общего бота');
  const pending = (await readJson(REGISTRY))?.singleActivation;
  if (pending?.pending) fail(2, `Для безопасной смены проекта отправьте боту /activate ${pending.code}, затем запустите tg-listen.mjs --once. ${pending.previous ? 'Старые входящие сохраняются прежнему проекту' : 'Старые неоднозначные входящие сохраняются отдельно без назначения проекту'}; новый агент их не получит. После подтверждения повторите --check.`);
  say('[TG настройка] привязка проверена; доставка ещё не проверена. Отправьте тестовый отчёт и ответьте из Telegram, затем проверьте получение агентом.');
  process.exit(0);
}
if (chat && group) {
  let verified;
  try { verified = await api(token, 'getChat', { chat_id: String(group.id) }); }
  catch (error) { fail(2, `Не удалось проверить группу: ${error.message}`); }
  if (verified?.type !== 'supergroup' || !verified.is_forum || String(verified.id) !== String(group.id)) fail(2, 'Для parallel нужна одна супергруппа с включёнными темами.');
  group = { ...verified, id: String(verified.id) };
  if (!check) await rememberMachine(chat, group);
  reg = await ensureRegistry(group);
}

// ---- топик -------------------------------------------------------------------------------------------
const portableTopic = topicNumber(value('--topic') ?? cfg.topic ?? taggedTopic);
const confirmedTopic = args.includes('--topic') && portableTopic === topicNumber(reg.projects[PROJECT].topic);
if (cfg.topic != null && topicNumber(cfg.topic) !== portableTopic && !confirmedTopic) fail(1, 'В файле проекта уже закреплён другой топик. Сверьте номера.');
if (portableTopic) {
  reg = await ensureRegistry(null, (p) => {
    if (p.topic && topicNumber(p.topic) !== portableTopic) fail(1, `В репозитории и на компьютере закреплены разные топики. Если владелец перенёс привязку вручную, проверьте топик и запустите ${RERUN} --topic ${p.topic}.`);
    if (p.topic) return false;
    p.topic = portableTopic;
    delete p.creatingTopic;
    return true;
  });
}
let member;
if (group) {
  try { member = await api(token, 'getChatMember', { chat_id: group.id, user_id: me.id }); }
  catch (error) { fail(1, `Не удалось проверить права бота${at} в группе: ${error.message}. Добавьте бота администратором с правом управления темами и повторите ${RERUN}.`); }
}
const admin = member?.status === 'administrator' || member?.status === 'creator';
const canCreate = member?.status === 'creator' || (admin && member.can_manage_topics === true);
const manual = `Для ручной привязки бот должен быть администратором группы. Попросите владельца написать ${TAG} ${topicWhere}. Запустите tg-listen.mjs${asked ? ` --project ${PROJECT}` : ''} --once --max-wait 300, затем ${RERUN}.`;
if (!check && canCreate && !reg.projects[PROJECT].topic) {
  // После обрыва связи Telegram уже мог создать тему. Запоминаем попытку до запроса, в том числе для параллельной настройки.
  let reserved = false;
  reg = await ensureRegistry(null, (p) => {
    if (p.topic || p.creatingTopic) return false;
    p.creatingTopic = true;
    reserved = true;
    return true;
  });
  if (reserved) {
    let created;
    try { created = await api(token, 'createForumTopic', { chat_id: group.id, name: TITLE }); }
    catch (error) {
      if (error.code >= 400 && error.code < 500) {
        await ensureRegistry(null, (p) => delete p.creatingTopic);
        fail(1, `Telegram отклонил создание топика: ${error.message}. Проверьте право управления темами. ${manual}`);
      }
      fail(1, `Исход создания топика неизвестен. Проверьте группу. ${manual}`);
    }
    const topic = topicNumber(created?.message_thread_id);
    if (!topic) fail(1, `Telegram не вернул номер созданного топика. ${manual}`);
    reg = await ensureRegistry(null, (p) => {
      if (p.topic && p.topic !== topic) fail(1, 'Во время настройки закрепили другой топик. Сверьте топики в группе.');
      delete p.creatingTopic;
      Object.assign(p, { topic, topicName: created.name || TITLE, introPending: true });
      return true;
    });
  }
}
const mine = reg.projects[PROJECT];
if (!check && mine.topic && cfg.project) await saveTopic(found.file, PROJECT, TAG, topicNumber(mine.topic), confirmedTopic);
if (!check && group && mine.topic && mine.introPending) {
  try { await api(token, 'sendMessage', { chat_id: group.id, message_thread_id: mine.topic, text: `${TAG} · этот топик — проект «${TITLE}»` }); }
  catch (error) { fail(1, `Топик сохранён. Первое сообщение не подтверждено: ${error.message}. Повторите ${RERUN}.`); }
  await ensureRegistry(null, (p) => p.topic === mine.topic && delete p.introPending);
}
say(`[TG настройка] проект «${TITLE}», хештег ${TAG} · бот ${botName} · номер владельца: записан`);
say(mine.topic ? `  топик: «${mine.topicName || mine.topic}» — закреплён` : '  топик: не закреплён');
if (!group) fail(2, `Группа пока неизвестна. Напишите в одной группе с темами и запустите ${RERUN}. Сообщение останется приёмнику.`);
else if (mine.topic && !admin) fail(2, `Бот${at} не администратор группы. Сделайте его администратором; хештег писать заново не нужно.`);
else if (mine.topic && check && mine.introPending) fail(2, `Первое сообщение в тему ещё не подтверждено. Выполните ${RERUN}.`);
else if (mine.topic) say('[TG настройка] настройки сохранены; доставку отчёта и обратной правки подтвердите отдельным тестом.');
else if (mine.creatingTopic) fail(1, `Создание топика уже началось. Если оно прервалось, проверьте группу. ${manual}`);
else if (canCreate) fail(2, `Запустите ${RERUN} для создания топика.`);
else fail(2, `Сделайте бота администратором с правом управления темами и повторите ${RERUN}. ${manual}`);
