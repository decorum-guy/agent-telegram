#!/usr/bin/env node
// tg-listen.mjs — приём сообщений владельца из Telegram в сессию агента. Node 20+, без зависимостей.
//
// Набор agent-telegram: один бот для всех проектов, инструкция — AGENT.md. Запуск из папки проекта:
//   node ~/.agent-telegram/kit/tg-listen.mjs           наблюдение: ждёт и печатает каждое новое сообщение блоком
//                                                      строк. Один приёмщик бота распределяет сообщения всем проектам.
//   node ~/.agent-telegram/kit/tg-listen.mjs --once    ждёт первое сообщение (или закрепление темы этого проекта),
//                                                      печатает его и завершается
//   node ~/.agent-telegram/kit/tg-listen.mjs --drain   печатает накопившееся и сразу завершается (пусто — нового нет)
//   ... tg-listen.mjs --checkpoint                   показывает одну правку в текущем чате Codex
//   ... tg-listen.mjs --checkpoint --once --max-wait 30   ждёт ответ на вопрос в текущем чате Codex
//   ... tg-listen.mjs --received <квитанция>          подтверждает прочтение правки из того же чата
//   Параметры: --project <имя> (если запуск не из репозитория проекта), --max-wait <сек> (для --once),
//              --no-ack (без реакции о сохранении), --simulate <файл.json> (синтетические обновления, без Telegram).
//
// Что печатается на каждое сообщение:
//   [TG входящее #<id> · <дата время>] ОТВЕТ на наш «<вид>» #<id> («<начало того сообщения>»)
//   │ <текст, строка за строкой>
//   │ вложение: <тип> → <путь к скачанному файлу>
// либо «СООБЩЕНИЕ (не ответ)», либо «ОТВЕТ на сообщение не из наших отчётов». Пометки в заголовке: «изменено» —
// владелец исправил сообщение; «из общего топика группы»; «в личных сообщениях»; «без хештега» — активный проект.
// Принимаются только сообщения владельца (TG_CHAT_ID): single — обычная личка и один активный проект;
// parallel — только настроенная группа с темами. Конфликт темы, хештега или ответа отклоняется.
//
// 👍 означает сохранение входящего. 👀 означает явное подтверждение чтения из чата агента.

import { appendFile, mkdir, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, extname, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { workspaceKey } from './tg-workspace.mjs';

// Папка входящих берётся из списка проектов — см. ниже, после чтения projects.json.
const POLL_SECONDS = 50, IDLE_MS = 2000, MAX_DOWNLOAD = 20 * 1024 * 1024;
const KIND_TITLES = { report: 'отчёт', review: 'НУЖЕН ПРОСМОТР', question: 'нужен ответ', blocked: 'остановка' };

const args = process.argv.slice(2);
const received = args.includes('--received');
const checkpoint = received || args.includes('--checkpoint');
const mode = args.includes('--once') ? 'once' : checkpoint || args.includes('--drain') ? 'drain' : 'watch';
const receiver = args.includes('--bridge-receiver');
const ack = !args.includes('--no-ack');
const maxWait = args.includes('--max-wait') ? Number(args[args.indexOf('--max-wait') + 1]) * 1000 : checkpoint ? 30000 : Infinity;
const simulate = args.includes('--simulate') ? args[args.indexOf('--simulate') + 1] : null;
if (args.includes('-h') || args.includes('--help')) {
  // Справка — только верхний блок комментариев файла.
  const lines = (await readFile(fileURLToPath(import.meta.url), 'utf8')).split(/\r?\n/).slice(1);
  console.log(lines.slice(0, Math.max(0, lines.findIndex((l) => !l.startsWith('//')))).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

const note = (text) => console.error('tg-listen: ' + text);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const thread = process.env.CODEX_THREAD_ID;
const receipt = received ? args[args.indexOf('--received') + 1] : null;
if (checkpoint && (!uuid.test(thread || '') || receiver || received && (!uuid.test(receipt || '') || mode !== 'drain') ||
    !Number.isFinite(maxWait) || maxWait <= 0 || maxWait > 30000)) {
  note('Используйте --checkpoint или --received <квитанция> из действующего чата Codex. Ожидание ответа: до 30 секунд.');
  process.exit(1);
}
const chatCwd = checkpoint ? await realpath(process.cwd()) : null;
const say = (text) => new Promise((done) => process.stdout.write(text + '\n', done));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const pad = (n) => String(n).padStart(2, '0');
const stamp = (seconds) => { const d = new Date(seconds * 1000); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const snippet = (text, n = 90) => { const s = String(text || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const readJson = async (file, fallback) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } };
const alive = (pid) => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const fresh = (lock) => !!lock && lock.pid !== process.pid && alive(lock.pid);

// ---- проект и общая папка ---------------------------------------------------------
const placeFrom = (base, p) => (p ? resolve(base, String(p).replace(/^~(?=$|[\\/])/, homedir())) : null);
async function findUp(name) {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const file = resolve(dir, name);
    let raw = null;
    try { raw = await readFile(file, 'utf8'); } catch { /* файла нет */ }
    if (raw !== null) { try { return { dir, file, json: JSON.parse(raw.replace(/^﻿/, '')) }; } catch { return { dir, file, json: null, broken: true }; } }
    // Выше корня репозитория не поднимаемся: файл из папки выше не должен подхватить чужой проект.
    try { await stat(resolve(dir, '.git')); return null; } catch { /* это не корень репозитория */ }
    if (dirname(dir) === dir) return null;
  }
}
const found = await findUp('.agent-telegram.json');
if (found?.broken) { console.error(`Не удалось прочитать ${found.file}`); process.exit(1); }
const PROJECT = (args.includes('--project') ? args[args.indexOf('--project') + 1] : null) || process.env.TG_PROJECT || found?.json?.project;
if (!PROJECT || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(PROJECT)) { console.error('Не задан проект. Запустите tg-setup.mjs из корня репозитория или укажите --project.'); process.exit(1); }
const ownHub = found?.json?.project === PROJECT && found.json.hub;
const HUB = placeFrom(process.cwd(), process.env.TG_HUB) || resolve(homedir(), '.agent-telegram');
if (ownHub && placeFrom(found.dir, ownHub) !== HUB) { console.error('Локальный hub проекта устарел. Выполните явный перенос через tg-setup.mjs.'); process.exit(1); }
const SECRET = resolve(HUB, '.secrets', 'telegram.env');
let registry = await readJson(resolve(HUB, 'projects.json'));
function registryError(reg) {
  if (reg?.version !== 2 || !['single', 'parallel'].includes(reg.mode) || !reg.projects?.[reg.default]) return 'Нужен общий реестр версии 2 и режим single/parallel. Запустите tg-setup.mjs.';
  if (!reg.projects[PROJECT]) return 'Проект не зарегистрирован в общем реестре. Запустите tg-setup.mjs.';
  if (reg.mode === 'single' && reg.default !== PROJECT) return 'В режиме single этот проект не активен. Переключите проект явно через tg-setup.mjs --activate.';
  if (reg.mode === 'parallel' && (!reg.group?.chat_id || !reg.group.forum)) return 'Для parallel настройте одну группу с темами через tg-setup.mjs.';
  const activation = reg.singleActivation;
  if (activation?.pending && (reg.mode !== 'single' || activation.project !== reg.default || !/^[a-z0-9_-]{12,64}$/i.test(activation.code || '') || activation.previous != null && !reg.projects[activation.previous])) return 'Повреждена ожидающая смена проекта. Повторите явную настройку.';
  const tags = new Set(), topics = new Set(), inboxes = new Set();
  for (const [key, p] of Object.entries(reg.projects)) {
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(key) || !/^#[\p{L}\p{N}_]{2,32}$/u.test(p?.tag) || typeof p?.inbox !== 'string') return 'Некорректная запись проекта в общем реестре.';
    const inside = relative(HUB, resolve(p.inbox));
    if (!isAbsolute(p.inbox) || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || isAbsolute(inside)) return 'Папка входящих должна находиться внутри общего каталога.';
    if (inboxes.has(resolve(p.inbox))) return 'Разные проекты не могут делить папку входящих.';
    inboxes.add(resolve(p.inbox));
    if (p.aliases != null && !Array.isArray(p.aliases)) return 'Некорректный список хештегов проекта.';
    for (const tag of [p.tag, ...(p.aliases || [])]) { if (typeof tag !== 'string' || !/^#[\p{L}\p{N}_]{2,32}$/u.test(tag) || tags.has(tag.toLowerCase())) return 'Хештег неоднозначен: он принадлежит нескольким проектам.'; tags.add(tag.toLowerCase()); }
    if (p.topic != null) { if (!Number.isSafeInteger(p.topic) || p.topic <= 0 || topics.has(p.topic)) return 'Тема должна принадлежать ровно одному проекту.'; topics.add(p.topic); }
  }
  return null;
}
const initialError = registryError(registry);
if (initialError) { console.error(initialError); process.exit(1); }
const ME = registry?.projects?.[PROJECT];
if (checkpoint && !ME.workspace) {
  note('Для привязки рабочей папки и ветки выполните обычный tg-setup.mjs из этого проекта.');
  process.exit(1);
}
if (ME.workspace && ME.workspace !== await workspaceKey(found?.dir)) {
  note('Проект закреплён за другой рабочей папкой или веткой.');
  process.exit(1);
}
const MODE = registry.mode;
const INBOX = resolve(ME.inbox);
const STATE = resolve(INBOX, 'state.json'), CONSUMER_LOCK = resolve(INBOX, 'consumer.lock');
const QUEUE = resolve(INBOX, 'queue.jsonl'), FILES = resolve(INBOX, 'files');
const OFFSET = resolve(HUB, 'offset.json'), POLLER_LOCK = resolve(HUB, 'poller.lock');

async function keys() {
  const raw = await readFile(SECRET, 'utf8').catch(() => '');
  const storedToken = raw.match(/^TG_BOT_TOKEN=([^\r\n]+)/m)?.[1], storedChat = raw.match(/^TG_CHAT_ID=([^\r\n]+)/m)?.[1];
  if ((process.env.TG_BOT_TOKEN && storedToken && process.env.TG_BOT_TOKEN !== storedToken) || (process.env.TG_CHAT_ID && storedChat && process.env.TG_CHAT_ID !== storedChat)) { note('Переменные окружения конфликтуют с общим ботом или владельцем.'); process.exit(1); }
  const token = process.env.TG_BOT_TOKEN || storedToken, chat = process.env.TG_CHAT_ID || storedChat;
  if (!token || !chat) { note('нет ключей: .secrets/telegram.env должен содержать TG_BOT_TOKEN и TG_CHAT_ID'); process.exit(1); }
  if (MODE === 'single' && (ME.privateChat?.chat_id !== String(chat) || ME.privateChat?.bot_id !== String(token).split(':')[0])) {
    note('Личный чат этого владельца и бота не проверен. Запустите tg-setup.mjs.'); process.exit(1);
  }
  return { token, chat: String(chat) };
}

const bridge = await import('./tg-bridge.mjs');
const stateHub = (project) => resolve(HUB, 'projects', project);
const BRIDGE_HUB = stateHub(PROJECT);
const bridgeMode = await readJson(resolve(BRIDGE_HUB, 'bridge.json'), null);
if (bridgeMode?.enabled && !receiver && !registry.singleActivation?.pending) {
  const pending=Object.values(bridgeMode.events || {}).filter(e=>['hydrating','waiting','sending','uncertain','blocked','sent'].includes(e.status));
  console.log('[TG мост] Фоновая доставка. ' + pending.length + ' входящих ожидают доставки, разбора или ACK. tg-bridge.mjs status --project ' + PROJECT);
  process.exit(checkpoint ? 1 : 0);
}
const { token, chat } = await keys();
const BOT = String(token).split(':')[0]; // номер бота — начало ключа; сам ключ не печатается и не сохраняется
let releaseBot;
let boundOwn = false; // --once также завершается после привязки темы или подтверждения активации
await mkdir(FILES, { recursive: true });
await mkdir(HUB, { recursive: true });

// ---- один слушатель на проект -------------------------------------------------------
const consumer = await readJson(CONSUMER_LOCK, null);
if (fresh(consumer)) {
  // Наблюдение этого проекта уже идёт: сообщения придут через него.
  // У набора agent-telegram говорим и при --drain: иначе пустой вывод не отличить от «нового нет». Обычно это
  // собственный приём сессии — тогда всё в порядке; чтение моделью подтверждает только отдельный ACK.
  if (mode === 'drain') await say(`[TG слушатель] приём этого проекта уже запущен (pid ${consumer.pid}, режим ${consumer.mode}); сообщения получает тот процесс. Если это другая сессия, сначала проверьте её состояние.`);
  else if (mode !== 'drain') await say(`[TG слушатель] уже работает другой экземпляр (pid ${consumer.pid}, режим ${consumer.mode}) — этот завершён, сообщения придут через него.`);
  process.exit(checkpoint ? 1 : 0);
}
let releaseConsumer;
try { releaseConsumer = await bridge.holdConsumer(INBOX); }
catch (error) { if (error.code !== 'EADDRINUSE') throw error; await say('[TG слушатель] приём этого проекта уже запущен; второй потребитель не создан.'); process.exit(checkpoint ? 1 : 0); }
const beatConsumer = () => bridge.atomic(CONSUMER_LOCK, { pid: process.pid, at: Date.now(), mode });
await beatConsumer();
if (receiver) await bridge.state(BRIDGE_HUB, d => { d.receiver = { pid: process.pid, at: Date.now() }; });

// ---- дежурный: кто читает бота --------------------------------------------------------
let amPoller = false, pollPausedUntil = 0, conflictSince = 0, conflictWarned = false;
async function pollerState() {
  const held = await readJson(POLLER_LOCK, null);
  if (fresh(held)) return 'other';
  // Слушатели прежней версии (до 17.11) читают бота сами и держат listener.lock в своей папке входящих.
  for (const project of Object.values(registry.projects)) if (fresh(await readJson(resolve(project.inbox, 'listener.lock'), null))) return 'legacy';
  return held?.pid === process.pid ? 'mine' : 'free';
}
async function becomePoller() {
  try { releaseBot = await bridge.holdBot(BOT); }
  catch (error) { if (error.code === 'EADDRINUSE') return false; throw error; }
  // Мьютекс живёт в ОС и общий для токена даже при ошибочно разных TG_HUB.
  // PID-файл дополнительно защищает от ещё работающего слушателя прежней версии.
  const held = await readJson(POLLER_LOCK, null);
  if (fresh(held)) { await releaseBot(); releaseBot = null; return false; }
  await beatPoller();
  return true;
}
const beatPoller = () => bridge.atomic(POLLER_LOCK, { pid: process.pid, at: Date.now(), project: PROJECT, v: 3 });
async function releasePoller() {
  amPoller = false;
  if ((await readJson(POLLER_LOCK, null))?.pid === process.pid) await rm(POLLER_LOCK, { force: true });
  const unlock = releaseBot; releaseBot = null;
  if (unlock) await unlock();
}
async function release() {
  await releasePoller().catch(() => {});
  if ((await readJson(CONSUMER_LOCK, null))?.pid === process.pid) await rm(CONSUMER_LOCK, { force: true });
  const unlock = releaseConsumer; releaseConsumer = null;
  if (unlock) await unlock();
}
const stopping = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => stopping.abort());

// ---- Telegram -----------------------------------------------------------------------
async function api(method, body, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.any?.([stopping.signal, timeout]) || timeout,
  });
  const data = await response.json().catch(() => null);
  if (!data?.ok) { const error = new Error(String(data?.description || `HTTP ${response.status}`).replaceAll(token, '[скрыто]')); error.code = data?.error_code || response.status; error.retryAfter = data?.parameters?.retry_after; throw error; }
  return data.result;
}

async function download(fileId, name, files = FILES) {
  if (simulate) return null; // проверка без Telegram
  try {
    const info = await api('getFile', { file_id: fileId }, 30000);
    if (!info.file_path || (info.file_size || 0) > MAX_DOWNLOAD) return null;
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) return null;
    await mkdir(files, { recursive: true, mode: 0o700 });
    const target = resolve(files, name + (extname(name) ? '' : extname(info.file_path)));
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD) return null;
    const file = await open(target, 'w', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    if (receiver && process.platform !== 'win32') {
      const dir = await open(files, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
    return target;
  } catch { return null; }
}

// ---- разбор: чьё сообщение --------------------------------------------------------------
const textOf = (message) => String(message?.text || message?.caption || '');
const tagsOf = (project) => [project.tag, ...(project.aliases || [])].filter(Boolean).sort((a, b) => b.length - a.length);
function startsWithTag(text, project) {
  const start = text.trimStart().toLowerCase();
  return tagsOf(project).some((tag) => start.startsWith(tag.toLowerCase()) && !/[\p{L}\p{N}_-]/u.test(start.charAt(tag.length)));
}
const startsWithLegacy = (text, project) => !!project.legacyPrefix && text.trimStart().startsWith(project.legacyPrefix);
async function sentIds(inbox) {
  // Ключ — «чат:номер»: номера сообщений в личке и в группе независимы и могут совпадать.
  const ids = new Map();
  let raw = '';
  try { raw = await readFile(resolve(inbox, 'sent.jsonl'), 'utf8'); } catch { return ids; }
  for (const line of raw.split('\n')) { try { const row = JSON.parse(line); ids.set(`${row.chat_id ?? chat}:${row.message_id}`, row); } catch { /* пустая строка */ } }
  return ids;
}

// ---- группа с топиками ------------------------------------------------------------------
// Сообщение в топике, если оно не ответ на что-то, приходит как «ответ» на служебное сообщение о создании топика.
const isTopicRoot = (message) => !!message?.reply_to_message && (!!message.reply_to_message.forum_topic_created || (!!message.is_topic_message && message.reply_to_message.message_id === message.message_thread_id));
const explicitReply = (message) => (isTopicRoot(message) ? null : message?.reply_to_message || null);
const topicOf = (message, inGroup) => (inGroup && message.is_topic_message && Number.isSafeInteger(message.message_thread_id) ? message.message_thread_id : null);
let registryStamp = 0;
// Новый проект в projects.json подхватывается без перезапуска (файл перечитывается не чаще раза в 5 секунд;
// перед показом сообщения — всегда: его топик мог закрепиться уже после запуска этого слушателя).
async function refreshRegistry(force = false) {
  if (!force && Date.now() - registryStamp < 5000) return;
  registryStamp = Date.now();
  const next = await readJson(resolve(HUB, 'projects.json'), null);
  const error = registryError(next) || (next.mode !== MODE && 'Режим изменился. Перезапустите приём после настройки.') ||
    (resolve(next.projects[PROJECT].inbox) !== INBOX && 'Папка входящих изменилась. Перезапустите приём.') ||
    (next.projects[PROJECT].workspace !== ME.workspace && 'Рабочая привязка изменилась. Перезапустите приём.');
  if (error) throw Object.assign(new Error(error), { fatal: true });
  registry = next;
}
// Изменить projects.json: прочитать свежий, поправить, записать через временный файл. mutate → false: без записи.
// Общая с настройкой блокировка: никогда не записываем без неё и не отнимаем её по возрасту.
async function withRegistryLock(fn) {
  const unlock = await bridge.holdRegistry(HUB);
  try { return await fn(); } finally { await unlock(); }
}
async function updateRegistry(mutate) {
  const file = resolve(HUB, 'projects.json');
  await withRegistryLock(async () => {
    const next = await readJson(file, null);
    const error = registryError(next);
    if (error) throw Object.assign(new Error(error), { fatal: true });
    if (mutate(next) === false) { registry = next; return; }
    await bridge.atomic(file, next);
    registry = next; registryStamp = Date.now();
  });
}

async function bindTopic(project, thread, topicName) {
  let changed = false;
  await updateRegistry((reg) => {
    const p = reg.projects[project];
    if (p.topic === thread) return false;
    if (p.topic != null || Object.values(reg.projects).some(other => other.topic === thread)) return false;
    p.topic = thread;
    p.topicName = topicName || String(thread);
    delete p.creatingTopic;
    changed = true;
  });
  if (changed) {
    if (project === PROJECT) { boundOwn = true; await say(`[TG слушатель] топик ${topicName ? `«${topicName}»` : thread} закреплён за этим проектом`); }
  }
  return changed;
}

async function confirmBinding(project, chatId, thread) {
  const text = `${registry.projects[project].tag} · этот топик закреплён за проектом «${project}». Сообщения в нём получает этот проект; хештег писать не обязательно.`;
  if (simulate) { note(`[проверка] в топик ${thread}: ${text}`); return; }
  await api('sendMessage', { chat_id: chatId, message_thread_id: thread, text, disable_web_page_preview: true }, 30000).catch((error) => note('не удалось подтвердить привязку топика: ' + error.message));
}
const react = (chatId, messageId) => {
  if (!ack || simulate) return;
  api('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji: '👍' }] }, 15000).catch(() => {});
};

async function route(message, inGroup) {
  const text = textOf(message);
  const thread = topicOf(message, inGroup);
  const entries = Object.entries(registry.projects);
  const tagged = entries.filter(([, p]) => startsWithTag(text, p)).map(([key]) => key);
  if (/^\s*#[\p{L}\p{N}_-]+/u.test(text) && tagged.length !== 1) { note('неизвестный или неоднозначный хештег: сообщение ' + message.message_id); return null; }
  const topics = thread == null ? [] : entries.filter(([, p]) => p.topic === thread).map(([key]) => key);
  const target = explicitReply(message);
  const replies = [];
  if (target) for (const [key, p] of entries) {
    if ((await sentIds(p.inbox)).has(`${message.chat.id}:${target.message_id}`) || (String(target.from?.id) === BOT && startsWithTag(textOf(target), p))) replies.push(key);
  }
  const candidates = new Set([...tagged, ...topics, ...replies]);
  if (candidates.size > 1) { note('конфликт темы, хештега или ответа: сообщение ' + message.message_id); return null; }
  const project = candidates.size ? [...candidates][0] : (MODE === 'single' ? registry.default : null);
  if (!project || (MODE === 'single' && project !== registry.default)) { note('нет однозначного активного проекта: сообщение ' + message.message_id); return null; }
  const p = registry.projects[project];
  if (thread !== null && tagged.length && tagsOf(p).some(tag => tag.toLowerCase() === text.trim().toLowerCase()) && !message.edit_date && !message.photo && !message.video && !message.document) {
    const name = message.reply_to_message?.forum_topic_created?.name || registry.group?.topics?.[thread];
    if (p.topic != null && p.topic !== thread) { note('тема уже закреплена; перенос требует явной настройки: ' + project); return null; }
    if (await bindTopic(project, thread, name)) await confirmBinding(project, message.chat.id, thread);
    react(message.chat.id, message.message_id);
    return null;
  }
  return { project, why: topics.length ? 'topic' : tagged.length ? 'tag' : replies.length ? 'reply' : 'default' };
}

const SERVICE = ['forum_topic_created', 'forum_topic_edited', 'forum_topic_closed', 'forum_topic_reopened', 'general_forum_topic_hidden', 'general_forum_topic_unhidden', 'new_chat_members', 'left_chat_member', 'pinned_message', 'new_chat_title', 'new_chat_photo', 'delete_chat_photo', 'group_chat_created', 'supergroup_chat_created', 'channel_chat_created', 'migrate_to_chat_id', 'migrate_from_chat_id', 'message_auto_delete_timer_changed', 'video_chat_scheduled', 'video_chat_started', 'video_chat_ended', 'video_chat_participants_invited', 'write_access_allowed', 'chat_shared', 'users_shared', 'boost_added', 'chat_background_set'];

// Альбом приходит несколькими сообщениями, подпись (и хештег) — у одного из них: все снимки идут туда же, куда этот.
const albumRoutes = new Map();

async function routeButton(update) {
  const q = update.callback_query, m = q.message;
  let label, destination, targetBridge;
  if (!q.from?.is_bot && String(q.from?.id) === chat && String(m?.from?.id) === BOT && /^at:(0|[1-9]\d*)$/.test(q.data)) {
    if (MODE === 'single' && m.chat?.type === 'private' && String(m.chat.id) === chat && m.message_thread_id == null && beforeActivation(update, m)) {
      const button = m.reply_markup?.inline_keyboard?.flat().find(entry => entry.callback_data === q.data)?.text;
      if (button) await holdBeforeActivation(update, m, { why: 'button', button, received_at: Date.now() });
      if (!simulate) await api('answerCallbackQuery', { callback_query_id: q.id, text: button ? 'Сохранено до смены проекта' : 'Кнопка недоступна' }, 10000).catch(() => {});
      return;
    }
    const dm = MODE === 'single' && m.chat?.type === 'private' && String(m.chat.id) === chat && m.message_thread_id == null;
    const group = MODE === 'parallel' && m.chat?.type === 'supergroup' && String(m.chat.id) === String(registry.group?.chat_id);
    const thread = m.message_thread_id ?? null;
    const matching = [];
    for (const [key, p] of Object.entries(registry.projects)) {
      const sent = (await sentIds(p.inbox)).get(`${m.chat?.id}:${m.message_id}`);
      if (group && Object.entries(registry.projects).some(([other, dest]) => other !== key && dest.topic === thread)) continue;
      if (startsWithTag(textOf(m), p) && (dm ? key === registry.default : group && (thread === p.topic || (sent && sent.thread === thread)))) matching.push(key);
    }
    if (matching.length === 1) {
      // Telegram предупреждает, что callback_data может не соответствовать ни одной кнопке сообщения.
      label = m.reply_markup?.inline_keyboard?.flat().find((button) => button.callback_data === q.data)?.text;
      destination = matching[0];
    }
  }
  let chosen;
  if (label) {
    const queue = resolve(registry.projects[destination].inbox, 'queue.jsonl');
    await mkdir(dirname(queue), { recursive: true });
    // Очередь хранит первый выбор и переживает перезапуск между записью ответа и правкой вопроса.
    let raw = '';
    try { raw = await readFile(queue, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      if ((!item.bot || item.bot === BOT) && item.why === 'button' && item.message?.chat?.id === m.chat.id && item.message.message_id === m.message_id) { chosen = item; break; }
    }
    if (!chosen) {
      chosen = { bot: BOT, project: destination, update_id: update.update_id, why: 'button', button: label, message: m, received_at: Date.now() };
      await appendSaved(queue, chosen);
    }
    targetBridge = await bridge.state(stateHub(destination));
  }
  if (targetBridge?.enabled && chosen) {
    const selected = await bridge.ingest(stateHub(destination), BOT, chosen);
    chosen.button = selected.text;
  }
  if (simulate) return;
  await api('answerCallbackQuery', { callback_query_id: q.id, text: chosen ? 'Выбор сохранён' : 'Кнопка недоступна' }, 10000).catch(() => {});
  if (chosen && !targetBridge?.enabled) {
    const edit = { chat_id: m.chat.id, message_id: m.message_id, text: textOf(chosen.message) + '\n\nВыбрано: ' + chosen.button, reply_markup: { inline_keyboard: [] } };
    try { await api('editMessageText', edit, 15000); }
    catch (error) {
      if (error.code === 400 || error.code === 403) {
        if (!/message is not modified/i.test(error.message)) note('ответ сохранён, Telegram не разрешил изменить исходный вопрос: ' + error.message);
      } else throw error; // повтор опроса обновит кнопки без повторной доставки выбора
    }
  }
}

function beforeActivation(update, message) {
  const activation = registry.singleActivation;
  return MODE === 'single' && activation?.project === registry.default && (activation.pending || activation.boundary?.bot === BOT && (update.update_id <= activation.boundary.update_id || (message.edit_date && message.message_id < activation.boundary.message_id)));
}

async function holdBeforeActivation(update, message, extra = {}) {
  let previous = registry.singleActivation.previous;
  const matches = [];
  for (const [key, p] of Object.entries(registry.projects)) {
    const saved = await readFile(resolve(p.inbox, 'queue.jsonl'), 'utf8').catch(() => '');
    if (saved.split('\n').some(line => { try { const row = JSON.parse(line); return row.bot === BOT && row.message?.chat?.id === message.chat.id && row.message?.message_id === message.message_id; } catch { return false; } })) matches.push(key);
  }
  if (matches.length === 1) previous = matches[0];
  else if (matches.length > 1 || update.edited_message) previous = null;
  const dir = previous ? registry.projects[previous].inbox : resolve(HUB, 'quarantine');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = resolve(dir, previous ? 'queue.jsonl' : 'single-activation.jsonl');
  await appendSaved(file, { bot: BOT, project: previous || null, update_id: update.update_id, edited: !!update.edited_message,
    why: 'before_activation', pending_activation: true, activation_project: registry.default, message, ...extra });
  note(previous ? 'сообщение до переключения сохранено прежнему проекту: ' + previous : 'сообщение до переключения сохранено в карантин без назначения проекту');
  if (!update.edited_message && extra.why !== 'button') react(message.chat.id, message.message_id);
}

async function routeUpdate(update, batch, replayingAlbum = false) {
  await refreshRegistry(true);
  if (update.callback_query) return routeButton(update);
  const message = update.message || update.edited_message;
  const fromMe = !!message && !message.from?.is_bot && String(message.from?.id) === chat;
  const inDm = fromMe && message.chat?.type === 'private' && String(message.chat.id) === chat;
  const inGroup = fromMe && (message.chat?.type === 'supergroup' || message.chat?.type === 'group');
  if (MODE === 'single' && (!inDm || message.message_thread_id != null)) { note('пропущено обновление вне личного чата ' + update.update_id); return; }
  if (MODE === 'parallel' && (!inGroup || message.chat.type !== 'supergroup' || String(message.chat.id) !== String(registry.group.chat_id))) { note('пропущено обновление вне рабочей группы ' + update.update_id); return; }
  if (!inDm && !inGroup) { note('пропущено чужое обновление ' + update.update_id); return; }
  if (MODE === 'single' && inDm && /^\s*\/activate(?:\s|$)/.test(textOf(message))) {
    const activation = registry.singleActivation;
    const clean = !update.edited_message && !message.edit_date && !message.forward_origin && !message.forward_date && !message.reply_to_message && !message.caption && !message.photo && !message.document && !message.video && !message.video_note && !message.animation && !message.voice && !message.audio && !message.sticker && !message.contact && !message.location && !message.poll;
    if (activation?.pending && clean && textOf(message).trim() === `/activate ${activation.code}`) {
      await updateRegistry(reg => {
        if (!reg.singleActivation?.pending || reg.singleActivation.code !== activation.code) return false;
        reg.singleActivation = { project: reg.default, previous: activation.previous ?? null, pending: false,
          boundary: { bot: BOT, update_id: update.update_id, message_id: message.message_id } };
      });
      boundOwn = true;
      await say('[TG слушатель] смена активного проекта подтверждена владельцем; следующие сообщения относятся к ' + registry.default);
      react(message.chat.id, message.message_id);
    } else note('неподходящее подтверждение смены проекта: сообщение ' + message.message_id);
    return;
  }
  if (MODE === 'single' && inDm && beforeActivation(update, message)) { await holdBeforeActivation(update, message); return; }
  if (inGroup) {
    if (String(registry.group.chat_id) !== String(message.chat.id)) { note('пропущено сообщение из другой группы ' + update.update_id); return; }
    const service = SERVICE.find((key) => message[key]);
    if (service) {
      const name = message.forum_topic_created?.name || message.forum_topic_edited?.name;
      if (name && message.message_thread_id) {
        await updateRegistry((reg) => {
          reg.group.topics ||= {};
          reg.group.topics[message.message_thread_id] = name;
          for (const p of Object.values(reg.projects)) if (p.topic === message.message_thread_id) p.topicName = name;
        });
      }
      return;
    }
  }
  if (!inGroup && SERVICE.some((key) => message[key])) return;
  let to;
  if (message.media_group_id) {
    for (const [id, v] of albumRoutes) if (Date.now() - v.at > 120000) albumRoutes.delete(id);
    const albumKey = `${message.chat.id}:${message.from.id}:${message.message_thread_id ?? ''}:${message.media_group_id}`;
    const known = albumRoutes.get(albumKey);
    if (known) to = known.to;
    else {
      const lead = (batch || []).map((u) => u.message || u.edited_message).find((m) => m?.media_group_id === message.media_group_id && m?.chat?.id === message.chat.id && m?.from?.id === message.from.id && !m.from.is_bot && (m.message_thread_id ?? null) === (message.message_thread_id ?? null) && textOf(m)) || message;
      to = await route(lead, inGroup);
      // «Не наше» по снимку без подписи не запоминаем: подпись (и хештег) может прийти со следующим снимком.
      if (to || textOf(lead)) albumRoutes.set(albumKey, { to, at: Date.now() });
    }
    const pending = resolve(HUB, 'pending-albums', Buffer.from(albumKey).toString('hex') + '.jsonl');
    if (!to && !textOf(message)) {
      await mkdir(dirname(pending), { recursive: true, mode: 0o700 });
      await appendSaved(pending, update);
      note('кадр альбома сохранён до появления подписи: обновление ' + update.update_id);
      return;
    }
    if (to && !replayingAlbum) {
      const saved = await readFile(pending, 'utf8').catch(() => '');
      if (saved) {
        // Убираем файл только после сохранения всех кадров в очереди целевого проекта.
        // Повтор после сбоя безопасен: update_id сохраняется, потребитель отсеет дубликат.
        const deferred = saved.split('\n').filter(Boolean).map(line => JSON.parse(line));
        for (const item of deferred) await routeUpdate(item, batch, true);
        await rm(pending, { force: true });
      }
    }
  } else to = await route(message, inGroup);
  if (!to) return;
  const inbox = registry.projects[to.project].inbox;
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  const item = { bot: BOT, project: to.project, update_id: update.update_id, edited: !!update.edited_message, why: to.why, message };
  const destination = stateHub(to.project), targetBridge = await bridge.state(destination);
  if (targetBridge?.enabled) {
    // Текст и команды не ждут скачивания предыдущего сообщения; media готовы только после hydration.
    const files = !!(message.photo?.length || message.document || message.video);
    const saved = await bridge.ingest(destination, BOT, { ...item, hydrating: files, attachments: ['voice', 'audio', 'video_note'].filter(type => message[type]).map(type => ({ type })) });
    item.attachments = saved.attachments;
    if (saved.hydrating) item.hydrating = true;
    if (saved.hydrating && to.project === PROJECT && receiver) void hydratePending().catch(error => note('вложения: ' + error.message));
    else if (!files) await render(item, to.project);
  }
  await appendSaved(resolve(inbox, 'queue.jsonl'), item);
  if (!targetBridge?.enabled && !item.edited) react(message.chat.id, message.message_id);
}

async function appendSaved(file, item) {
  const handle = await open(file, 'a', 0o600);
  try { await handle.writeFile(JSON.stringify(item) + '\n'); await handle.sync(); } finally { await handle.close(); }
}

// offset.json другого бота (ключ сменили) не годится: номера обновлений у каждого бота свои, и чужой номер молча
// «подтвердил» бы входящие этого бота, а новые, с меньшими номерами, не приходили бы вовсе. Файлу без номера бота
// (прежние версии) тоже не доверяем: начать с нуля безопасно — подтверждённое Telegram больше не отдаст, а повтор
// последней пачки отсеет учёт доставленного (state.json → seen).
async function loadOffset() {
  const saved = await readJson(OFFSET, {});
  return saved?.bot && String(saved.bot) === BOT ? Number(saved.offset) || 0 : 0;
}
const saveOffset = (offset) => bridge.atomic(OFFSET, {bot:BOT, offset});

async function pollOnce(timeoutSeconds) {
  let offset = await loadOffset();
  const updates = await api('getUpdates', { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'edited_message', 'callback_query'] }, (timeoutSeconds + 20) * 1000);
  for (const update of updates) {
    if (stopping.signal.aborted) break;
    await routeUpdate(update, updates);
    // Номер сохраняется только после раскладки: при обрыве обновление придёт повторно, но не потеряется.
    offset = update.update_id + 1;
    await saveOffset(offset);
  }
}

// ---- одно сообщение → блок строк ------------------------------------------------------------
async function render(item, project = PROJECT) {
  await refreshRegistry(true);
  const me = registry.projects[project], inbox = resolve(me.inbox), log = resolve(inbox, 'messages.jsonl'), files = resolve(inbox, 'files');
  const message = item.message, edited = item.edited, id = message.message_id, lines = [], attachments = [];
  const filePrefix = `${BOT}_${message.chat.id}_${id}_${item.update_id}`;
  if (item.why === 'button') {
    const sent = (await sentIds(inbox)).get(`${message.chat.id}:${id}`);
    const reply = { id, ours: true, kind: sent?.kind || 'question', snippet: snippet(sent?.head || textOf(message)) };
    await appendFile(log, JSON.stringify({ message_id: id, routed: 'button', reply, text: item.button, received_at: new Date(item.received_at).toISOString() }) + '\n', { mode: 0o600 });
    return `[TG входящее #${id} · ${stamp(item.received_at / 1000)}] КНОПКА на вопрос #${id} («${reply.snippet}»)\n│ ${item.button}`;
  }
  let head = `[TG входящее #${id} · ${stamp(edited ? message.edit_date : message.date)}${edited ? ' · изменено' : ''}] `;
  let reply = null;
  const target = explicitReply(message);
  if (target) {
    const ours = (await sentIds(inbox)).get(`${message.chat.id}:${target.message_id}`);
    const quoted = textOf(target);
    const isOurs = !!ours || (String(target.from?.id) === BOT && (startsWithTag(quoted, me) || startsWithLegacy(quoted, me)));
    const body = quoted.replace(/^\s*[^\n]*\n+/, (first) => (startsWithTag(first, me) || startsWithLegacy(first, me) ? '' : first));
    reply = { id: target.message_id, ours: isOurs, kind: ours?.kind || null, snippet: snippet(ours?.head || body) };
    head += isOurs ? `ОТВЕТ на наш «${KIND_TITLES[reply.kind] || 'сообщение'}» #${reply.id} («${reply.snippet}»)`
      : `ОТВЕТ на сообщение не из наших отчётов #${reply.id} («${reply.snippet}»)`;
  } else head += 'СООБЩЕНИЕ (не ответ)';
  // Откуда: топик этого проекта — обычный случай; другой топик или общий топик группы — помечается.
  if (message.chat?.type !== 'private') {
    const thread = message.is_topic_message ? message.message_thread_id : null;
    const own = me.topic;
    const name = registry.group?.topics?.[thread] || Object.values(registry.projects).find((p) => p.topic === thread)?.topicName
      || message.reply_to_message?.forum_topic_created?.name || thread;
    if (thread && thread !== own) head += ` · из топика «${name}»`;
    else if (!thread) head += ' · из общего топика группы';
  } else if (registry.group?.chat_id) head += ' · в личных сообщениях';
  if (item.why === 'default') head += ' · без хештега';
  const forwarded = !!(message.forward_origin || message.forward_date);
  if (forwarded) head += ' · пересланное сообщение';
  lines.push(head);
  if (message.quote?.text) lines.push('│ цитата из того сообщения: «' + snippet(message.quote.text, 200) + '»');
  const text = textOf(message);
  for (const row of text.split('\n')) lines.push('│ ' + row);
  if (message.photo?.length) {
    const best = message.photo.at(-1), file = await download(best.file_id, `${filePrefix}_photo`, files);
    attachments.push({ type: 'photo', file, ...(!file && !simulate ? { error: 'Не удалось скачать фото. Отправьте его ещё раз.' } : {}) }); lines.push('│ вложение: фото → ' + (file || 'не удалось скачать'));
  }
  if (message.document) {
    const name = `${filePrefix}_${(message.document.file_name || 'file').replace(/[^\w.\-а-яА-ЯёЁ]+/g, '_')}`, file = await download(message.document.file_id, name, files);
    attachments.push({ type: 'document', file, name: message.document.file_name, ...(!file && !simulate ? { error: 'Не удалось скачать файл (лимит 20 МБ). Отправьте его ещё раз.' } : {}) }); lines.push('│ вложение: файл → ' + (file || 'не удалось скачать (больше 20 МБ?)'));
  }
  if (message.video) { const file = await download(message.video.file_id, `${filePrefix}_video`, files); attachments.push({ type: 'video', file, ...(!file && !simulate ? { error: 'Не удалось скачать видео (лимит 20 МБ). Отправьте его ещё раз.' } : {}) }); lines.push('│ вложение: видео → ' + (file || 'не удалось скачать (больше 20 МБ?)')); }
  for (const kind of ['voice', 'audio', 'video_note']) if (message[kind]) { attachments.push({ type: kind }); lines.push(`│ вложение: ${kind === 'voice' ? 'голосовое' : kind === 'audio' ? 'аудио' : 'видеокружок'} — прослушать нельзя, попросите владельца написать текстом`); }
  if (message.sticker) lines.push('│ стикер ' + (message.sticker.emoji || ''));
  if (!text && !attachments.length && !message.sticker) lines.push('│ (сообщение без текста и вложений неподдерживаемого вида)');
  item.attachments = attachments;
  await appendFile(log, JSON.stringify({ message_id: id, date: message.date, edited: !!edited, forwarded, routed: item.why, reply, text, attachments, received_at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  return lines.join('\n');
}

// Один download за раз. source записан до offset, поэтому восстановление не зависит от redelivery Telegram.
let hydration;
function hydratePending() {
  if (hydration) return hydration;
  hydration = (async () => {
    for (;;) {
      const saved = Object.values((await bridge.state(BRIDGE_HUB))?.events || {}).find(e => e.bot === BOT && e.hydrating && e.source);
      if (!saved) break;
      const item = saved.source;
      try {
        if (saved.status !== 'cancelled') await render(item);
        await bridge.ingest(BRIDGE_HUB, BOT, item);
      } catch (error) {
        await bridge.state(BRIDGE_HUB, d => {
          const e = d.events[saved.id]; delete e.hydrating;
          e.hydrationError = 'Не удалось подготовить вложение: ' + error.message;
          if (e.status === 'hydrating') { e.status = 'blocked'; e.error = e.hydrationError; }
        });
      }
    }
  })().finally(() => { hydration = null; });
  return hydration;
}

// ---- очередь проекта → вывод -------------------------------------------------------------------
let delivered = 0;
async function deliver() {
  if (registry.singleActivation?.pending && registry.singleActivation.project === PROJECT) return 0;
  if (receiver) {
    const cursor = await bridge.importInbox(BRIDGE_HUB, BOT, INBOX, HUB);
    void hydratePending().catch(error => note('вложения: ' + error.message));
    if (Number.isSafeInteger(cursor)) {
      const prev=await readJson(STATE,{});
      if(prev.cursor!==cursor) await bridge.atomic(STATE,{...prev,cursor});
    }
    return 0;
  }
  let raw;
  try { raw = await readFile(QUEUE); } catch { return 0; }
  const state = await readJson(STATE, {});
  const currentBridge = await bridge.state(BRIDGE_HUB);
  if (currentBridge?.enabled) return 0;
  if (state.checkpoint) {
    const pending = state.checkpoint;
    if (!checkpoint || !ownsCheckpoint(pending)) {
      note('Следующая правка ожидает подтверждения в чате, который её получил.');
      process.exitCode = 1;
      return 0;
    }
    return showCheckpoint(pending);
  }
  let cursor = Number.isSafeInteger(state.cursor) && state.cursor <= raw.length ? state.cursor : 0;
  const end = raw.subarray(cursor).lastIndexOf(10);
  if (end < 0) return 0;
  const seen = new Set(Array.isArray(state.seen) ? state.seen : []);
  let got = 0;
  const next = cursor + end + 1;
  for (const line of raw.subarray(cursor, next).toString('utf8').split('\n')) {
    const afterLine = cursor + Buffer.byteLength(line) + 1;
    const beforeLine = cursor;
    cursor = afterLine;
    if (!line) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    const key = `${item.bot || BOT}:${item.update_id}`;
    if (item.project && item.project !== PROJECT) { note('пропущена запись очереди другого проекта'); continue; }
    if (item.bot && item.bot !== BOT) { note('пропущена запись очереди прежнего бота'); continue; }
    if (seen.has(key) || currentBridge?.events?.[BOT+':'+item.update_id]) continue;
    const content = await render(item);
    if (checkpoint) {
      const pending = { bot: BOT, project: PROJECT, thread, cwd: chatCwd, receipt: randomUUID(), key, cursor, content,
        chatId: item.message.chat.id, messageId: item.message.message_id, telegramTime: item.message.edit_date || item.received_at / 1000 || item.message.date,
        react: !item.edited && item.why !== 'button' };
      await bridge.atomic(STATE, { ...state, bot: BOT, cursor: beforeLine, checkpoint: pending });
      return showCheckpoint(pending);
    }
    await say(content);
    seen.add(key); got++; delivered++;
    await bridge.atomic(STATE, { ...state, bot: BOT, cursor, seen: [...seen].slice(-300) });
  }
  await bridge.atomic(STATE, { ...state, bot: BOT, cursor: next, seen: [...seen].slice(-300) });
  return got;
}

function ownsCheckpoint(pending) {
  return pending.thread === thread && pending.cwd === chatCwd && pending.project === PROJECT && pending.bot === BOT;
}

async function showCheckpoint(pending) {
  await say(JSON.stringify({ type: 'telegram_checkpoint', project: PROJECT, receipt: pending.receipt,
    messageId: pending.messageId, telegramTime: pending.telegramTime, shownAt: new Date().toISOString(), content: pending.content }));
  delivered++;
  return 1;
}

async function acknowledgeCheckpoint() {
  await refreshRegistry(true);
  if (registry.singleActivation?.pending) throw Error('Дождитесь подтверждения смены проекта.');
  const current = await readJson(STATE, {});
  const pending = current.checkpoint;
  if (!pending || !ownsCheckpoint(pending) || pending.receipt !== receipt) throw Error('У этого чата нет ожидающей правки с такой квитанцией.');
  const seen = new Set(Array.isArray(current.seen) ? current.seen : []);
  seen.add(pending.key);
  delete current.checkpoint;
  await bridge.atomic(STATE, { ...current, cursor: pending.cursor, seen: [...seen].slice(-300) });
  await say(JSON.stringify({ type: 'telegram_received', project: PROJECT, messageId: pending.messageId, acknowledgedAt: new Date().toISOString() }));
  if (ack && pending.react && !simulate) {
    await api('setMessageReaction', { chat_id: pending.chatId, message_id: pending.messageId, reaction: [{ type: 'emoji', emoji: '👀' }] }, 4000)
      .catch(() => note('Получение подтверждено локально. Реакция Telegram недоступна, сообщите владельцу текстом.'));
  }
}

// Разовое объявление проекту (например, о смене правил) — текст берётся из projects.json.
async function announce() {
  if (!ME.notice || !ME.noticeId) return;
  const state = await readJson(STATE, {});
  if (state.notice === ME.noticeId) return;
  await say(`[TG слушатель] ${ME.notice}`);
  await bridge.atomic(STATE, { ...(await readJson(STATE, {})), notice: ME.noticeId });
}

// ---- один шаг: при возможности прочитать бота, затем выдать своё ---------------------------------
let failingSince = 0, warned = false, lastHeartbeat=0;
async function step(waitSeconds) {
  try { await refreshRegistry(true); }
  catch (error) { note(error.message); process.exitCode = 1; return 'stop'; }
  if (!receiver && !simulate && !registry.singleActivation?.pending && (await bridge.state(BRIDGE_HUB))?.enabled) return 'stop';
  if (receiver && Date.now() - lastHeartbeat > 12000) {
    lastHeartbeat = Date.now();
    await bridge.state(BRIDGE_HUB, d => { d.receiver = { pid: process.pid, at: lastHeartbeat }; });
  }
  const state = Date.now() < pollPausedUntil ? 'paused' : await pollerState();
  if (state === 'mine' || (state === 'free' && await becomePoller())) {
    amPoller = true;
    await beatPoller();
    try {
      await pollOnce(waitSeconds);
      failingSince = 0; warned = false; conflictSince = 0; conflictWarned = false;
    } catch (error) {
      if (stopping.signal.aborted) return 'stop';
      if (error.fatal) { note(error.message); process.exitCode = 1; return 'stop'; }
      if (error.code === 401) { await say('[TG слушатель] Telegram отверг ключ бота (401). Проверьте .secrets/telegram.env.'); process.exitCode = 1; return 'stop'; }
      if (error.code === 409) {
        // Бота читает кто‑то ещё: тот же ключ работает в другом месте (другой компьютер, слушатель прежней версии)
        // или включён webhook. Не спорим: отходим и ждём.
        await releasePoller(); pollPausedUntil = Date.now() + 60000; conflictSince ||= Date.now();
        if (!conflictWarned && Date.now() - conflictSince > 2 * 60000) {
          conflictWarned = true;
          await say('[TG слушатель] общего бота читает другое устройство или включён webhook. Приём может не работать. Оставьте один общий приёмщик и сообщите владельцу в чате.');
        }
        note('конфликт опроса (409): отхожу на минуту');
      } else {
        failingSince ||= Date.now();
        if (!warned && Date.now() - failingSince > 5 * 60000) { warned = true; await say('[TG слушатель] нет связи с Telegram уже 5 минут; продолжаю попытки. Входящие сообщения могут задержаться.'); }
        note('ошибка опроса: ' + (error.name === 'TimeoutError' ? 'истекло время' : error.message) + (error.cause?.code ? ` (${error.cause.code})` : ''));
        if (!checkpoint) await sleep(5000);
      }
      if (checkpoint) process.exitCode = 1;
    }
  } else {
    amPoller = false;
    if (waitSeconds > 0) await sleep(IDLE_MS);
  }
  await deliver();
  return 'ok';
}

let refreshing = false;
const feedbackTimer = receiver && !simulate && setInterval(async () => {
  if (refreshing) return;
  refreshing = true;
  try {
    void hydratePending().catch(error => note('вложения: ' + error.message));
    await bridge.feedback(BRIDGE_HUB, BOT, (method, body) => api(method, body, 15000));
  }
  catch (e) { note('обновление статуса: ' + e.message); }
  finally { refreshing = false; }
}, 1000);
if(receiver && process.env.TG_RECEIVER_PARENT){
  const parent=Number(process.env.TG_RECEIVER_PARENT);
  setInterval(()=>{if(process.ppid!==parent || !alive(parent)) stopping.abort();},1000).unref();
}
const started = Date.now();
try {
  if (receiver) {
    await bridge.importInbox(BRIDGE_HUB, BOT, INBOX, HUB);
    void hydratePending().catch(error => note('вложения: ' + error.message));
  }
  if (received) {
    await acknowledgeCheckpoint();
  } else if (simulate) {
    await announce();
    note(`отладка: начальный номер обновлений: ${await loadOffset()}`);
    if (await becomePoller()) {
      const updates = JSON.parse(await readFile(resolve(simulate), 'utf8'));
      for (const update of updates) await routeUpdate(update, updates);
      if (updates.length) await saveOffset(Math.max(await loadOffset(), ...updates.map(update => update.update_id + 1)));
    } else note('общий приёмщик уже работает; синтетические обновления не добавлены');
    await deliver();
  } else if (mode === 'drain') {
    await announce();
    if (!checkpoint || !await deliver() && !process.exitCode) await step(0);
  } else {
    await announce();
    note(`запущен, режим ${mode}, проект ${PROJECT}`);
    while (!stopping.signal.aborted) {
      await beatConsumer();
      if (checkpoint && (await deliver() || process.exitCode)) break;
      const wait = mode === 'once' && Number.isFinite(maxWait) ? Math.max(0, Math.min(POLL_SECONDS, Math.ceil((maxWait - (Date.now() - started)) / 1000))) : POLL_SECONDS;
      if ((await step(wait)) === 'stop') break;
      if (mode === 'once' && (delivered || boundOwn)) { if (!checkpoint) await step(0); break; }
      if (checkpoint && process.exitCode) break;
      if (mode === 'once' && Date.now() - started >= maxWait) break;
    }
  }
} catch (error) {
  note(String(error.message).replaceAll(token, '[скрыто]'));
  process.exitCode = 1;
} finally {
  if (receiver) await hydratePending();
  clearInterval(feedbackTimer); await release();
}
