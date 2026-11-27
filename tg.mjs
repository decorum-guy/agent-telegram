#!/usr/bin/env node
// tg.mjs — отчёты владельцу в Telegram. Без зависимостей, нужен Node 20+.
//
// Набор agent-telegram (один бот для всех проектов; инструкция — AGENT.md). Запускать из папки репозитория проекта
// (или с --project <имя>); в командах ниже tg.mjs = node ~/.agent-telegram/kit/tg.mjs:
//   tg.mjs --text-file отчёт.txt                    текст из файла UTF-8 — надёжнее всего для длинного текста и кириллицы
//   tg.mjs "Короткий текст"                         текст прямо в команде
//   tg.mjs --review  --photo a.png --text-file …    пометка «НУЖЕН ПРОСМОТР» (картинки — до 10 штук)
//   tg.mjs --question --option Да --option Нет "Продолжить?"   кнопки под вопросом; можно ответить текстом
//   tg.mjs --question --text-file …                 пометка «нужен ответ»
//   tg.mjs --blocked --text-file …                  пометка «остановка»
//   tg.mjs --final --text-file …                    итог с инструкцией вернуться в чат ChatGPT
//   tg.mjs --photo a.png --photo b.jpg --caption "Было / стало"
//   tg.mjs --video clip.mp4 --caption "…"           tg.mjs --file bench.json --caption "…"
//   tg.mjs --reply-to 128 --text-file …             ответ «в ветку» на сообщение владельца #128 (туда же, где оно лежит)
//   tg.mjs --silent …                               без звука (ночные промежуточные отчёты)
//   tg.mjs --dry-run …                              показать, куда и что ушло бы, ничего не отправляя
//   tg.mjs --dm …                                   сразу в личку, а не в топик
//   tg.mjs - …                                      текст из stdin
//
// Куда: в режиме single — в личку владельца, только от активного проекта. В режиме parallel — в тему проекта.
// При ошибке темы доставка останавливается до исправления привязки. Хештег проекта ставится сам — в текст, в продолжения длинного текста
// и в подписи к вложениям. Каждое отправленное сообщение записывается в sent.jsonl проекта — по нему слушатель
// (tg-listen.mjs) понимает, на какое наше сообщение владелец ответил. Токен никогда не печатается.
//
// Первая настройка — tg-setup.mjs.

import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { basename, dirname, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { workspaceKey } from './tg-workspace.mjs';

const rawArgs = process.argv.slice(2);
const readJson = async (file) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };
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
const helpText = async () => {
  // Справка — только верхний блок комментариев файла.
  const lines = (await readFile(fileURLToPath(import.meta.url), 'utf8')).split(/\r?\n/).slice(1);
  return lines.slice(0, Math.max(0, lines.findIndex((l) => !l.startsWith('//')))).map((l) => l.slice(3)).join('\n');
};
const found = await findUp('.agent-telegram.json');
if (found?.broken) { console.error(`Не удалось прочитать ${found.file}`); process.exit(1); }
const PROJECT = (rawArgs.includes('--project') ? rawArgs[rawArgs.indexOf('--project') + 1] : null) || process.env.TG_PROJECT || found?.json?.project;
if (rawArgs.includes('-h') || rawArgs.includes('--help')) { console.log(await helpText()); process.exit(0); }
if (!PROJECT || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(PROJECT)) { console.error('Не задан проект. Запустите tg-setup.mjs из корня репозитория или укажите --project.'); process.exit(1); }
const ownHub = found?.json?.project === PROJECT && found.json.hub;
const HUB = placeFrom(process.cwd(), process.env.TG_HUB) || resolve(homedir(), '.agent-telegram');
if (ownHub && placeFrom(found.dir, ownHub) !== HUB) { console.error('Старый отдельный hub проекта: выполните миграцию перед отправкой.'); process.exit(1); }
const SECRET = resolve(HUB, '.secrets', 'telegram.env');
const REGISTRY = await readJson(resolve(HUB, 'projects.json'));
const ME = REGISTRY?.projects?.[PROJECT];
if (REGISTRY?.version !== 2 || !['single', 'parallel'].includes(REGISTRY.mode) || !Object.hasOwn(REGISTRY.projects || {}, PROJECT) || !ME?.tag || !ME?.inbox) { console.error('Нужен общий реестр версии 2. Выполните tg-setup.mjs (--migrate для старой установки).'); process.exit(1); }
if (ME.workspace && ME.workspace !== await workspaceKey(found?.dir)) fail('Проект закреплён за другой рабочей папкой или веткой.');
const tags = new Set(), topics = new Set(), inboxes = new Set();
for (const [key, p] of Object.entries(REGISTRY.projects)) {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(key) || !/^#[\p{L}\p{N}_]{2,32}$/u.test(p?.tag) || typeof p.inbox !== 'string') fail('Некорректный общий реестр проектов.');
  const rel = relative(HUB, resolve(p.inbox));
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || inboxes.has(resolve(p.inbox))) fail('Папки входящих должны быть разными и находиться внутри общего каталога.');
  inboxes.add(resolve(p.inbox));
  if (p.aliases != null && !Array.isArray(p.aliases)) fail('Некорректные псевдонимы хештега.');
  for (const tag of [p.tag, ...(p.aliases || [])]) { if (!/^#[\p{L}\p{N}_]{2,32}$/u.test(tag) || tags.has(tag.toLowerCase())) fail('Хештеги разных проектов не должны совпадать.'); tags.add(tag.toLowerCase()); }
  if (p.topic != null) { if (!Number.isSafeInteger(p.topic) || p.topic <= 0 || topics.has(p.topic)) fail('Тема должна принадлежать ровно одному проекту.'); topics.add(p.topic); }
}
const MODE = REGISTRY.mode === 'single' ? 'private' : 'topic';
if (MODE === 'private' && REGISTRY.default !== PROJECT) { console.error('В single отчёты разрешены только активному проекту. Для последовательной смены используйте tg-setup.mjs --activate.'); process.exit(1); }
if (MODE === 'private' && REGISTRY.singleActivation?.pending) fail('Смена проекта ещё не подтверждена кодом /activate в Telegram. Отправка от нового проекта запрещена.');
if (MODE === 'topic' && (!/^-[1-9]\d*$/.test(REGISTRY.group?.chat_id || '') || REGISTRY.group?.forum !== true || !Number.isSafeInteger(ME.topic) || ME.topic <= 0)) { console.error('Для parallel сначала закрепите единственную группу и отдельную тему проекта через tg-setup.mjs.'); process.exit(1); }
const sessionId = process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_THREAD_ID;
const BRIDGE_HUB = resolve(HUB, 'projects', PROJECT);
const bridgeState = await readJson(resolve(BRIDGE_HUB, 'bridge.json'));
const binding = bridgeState?.sessions?.[sessionId];
const client = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDECODE ? 'Claude' : process.env.CODEX_THREAD_ID ? 'Codex' : binding?.client === 'claude' ? 'Claude' : null;
const signature = client ? '\nclient: ' + client : '';
const SENT = resolve(ME.inbox, 'sent.jsonl');
async function remember(messageId, kind, head, target) {
  try {
    await mkdir(dirname(SENT), { recursive: true });
    await appendFile(SENT, JSON.stringify({ message_id: messageId, chat_id: target?.chat_id ?? null, thread: target?.message_thread_id ?? null, kind, at: new Date().toISOString(), head: String(head || '').replace(/\s+/g, ' ').trim().slice(0, 140) }) + '\n', { mode: 0o600 });
  } catch { /* учёт не должен ломать отправку */ }
  if (bridgeState?.enabled && kind === 'question') {
    const {token} = await loadKeys();
    const {question} = await import('./tg-bridge.mjs');
    await question(BRIDGE_HUB,token.split(':')[0],target,messageId,sessionId,head);
  }
}

const TAG = ME.tag;
const HEADERS = {
  report: `${TAG} · отчёт`,
  review: `${TAG} · НУЖЕН ПРОСМОТР`,
  question: `${TAG} · нужен ответ`,
  blocked: `${TAG} · остановка`,
  final: `${TAG} · работа завершена`,
};
const TEXT_LIMIT = 4000, CAPTION_LIMIT = 950, MAX_PHOTO = 10 * 1024 * 1024, MAX_FILE = 50 * 1024 * 1024;

function fail(message) { console.error('tg: ' + message); process.exit(1); }

function parseArgs(argv) {
  const out = { kind: 'report', texts: [], options: [], photos: [], video: null, file: null, caption: '', textFile: null, stdin: false, dryRun: false, replyTo: null, silent: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) fail(`после ${a} нужно значение`); return argv[++i]; };
    if (a === '--review' || a === '--question' || a === '--blocked' || a === '--final') out.kind = a.slice(2);
    else if (a === '--reply-to') { out.replyTo = Number(next()); if (!Number.isSafeInteger(out.replyTo) || out.replyTo <= 0) fail('--reply-to: нужен номер сообщения'); }
    else if (a === '--option') {
      const label = next().trim();
      if (!label || label.startsWith('--') || /[\r\n]/.test(label) || out.options.includes(label)) fail('--option: нужна непустая однострочная подпись без повторов');
      out.options.push(label);
    }
    else if (a === '--photo') out.photos.push(next());
    else if (a === '--video') out.video = next();
    else if (a === '--file') out.file = next();
    else if (a === '--caption') out.caption = next();
    else if (a === '--text-file') out.textFile = next();
    else if (a === '--project') next();
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--silent') out.silent = true;
    else if (a === '--dm') out.dm = true;
    else if (a === '-') out.stdin = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('--')) fail(`неизвестный параметр ${a}`);
    else out.texts.push(a);
  }
  return out;
}

async function loadKeys() {
  let token, chat;
  {
    let raw = null;
    try { raw = await readFile(SECRET, 'utf8'); } catch { /* ключ ещё не записан */ }
    for (const line of (raw || '').split(/\r?\n/)) {
      const m = /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (!m) continue;
      if (m[1] === 'TG_BOT_TOKEN' && !token) token = m[2];
      if (m[1] === 'TG_CHAT_ID' && !chat) chat = m[2];
    }
  }
  if (process.env.TG_BOT_TOKEN && token && process.env.TG_BOT_TOKEN !== token || process.env.TG_CHAT_ID && chat && process.env.TG_CHAT_ID !== chat) fail('Переменные окружения конфликтуют с общим ботом или владельцем. Отправка отменена.');
  token ||= process.env.TG_BOT_TOKEN; chat ||= process.env.TG_CHAT_ID;
  if (!token || !chat) fail('в .secrets/telegram.env нужны TG_BOT_TOKEN и TG_CHAT_ID');
  if (MODE === 'private' && (ME.privateChat?.chat_id !== String(chat) || ME.privateChat?.bot_id !== String(token).split(':')[0]))
    fail('Личный чат этого владельца и бота не проверен. Запустите tg-setup.mjs.');
  return { token, chat };
}

// Режет длинный текст по абзацам, затем по строкам, в крайнем случае по символам.
function chunks(text, limit) {
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

// soft — вместо выхода бросить ошибку (для попытки отправить в группу с запасным путём в личку).
async function call(token, method, body, timeoutMs, soft = false) {
  const stop = (text, extra = {}) => { if (soft) throw Object.assign(new Error(text), extra); fail(text); };
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body),
      headers: body instanceof FormData ? undefined : { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Сообщение ошибки может содержать адрес с токеном — наружу отдаём только её вид.
    // Код причины (ENOTFOUND, ECONNREFUSED, EACCES…) ключа не содержит и помогает отличить запрет песочницы от сбоя.
    stop(`${method}: сеть недоступна или истекло время (${[error?.name, error?.cause?.code].filter(Boolean).join(': ') || 'ошибка'})`, { network: true });
  }
  let data = null;
  try { data = await response.json(); } catch { /* не JSON */ }
  if (!response.ok || !data?.ok) {
    const why = String(data?.description || `HTTP ${response.status}`).replaceAll(token, '[скрыто]');
    const hint = /can't initiate conversation|chat not found/i.test(why) ? ' — откройте бота в Telegram и нажмите «Start»' : '';
    stop(`${method}: ${why}${hint}`, { code: data?.error_code || response.status, retryAfter: data?.parameters?.retry_after || 0 });
  }
  return data.result;
}

async function blobOf(path, max, what) {
  const full = resolve(path);
  let info;
  try { info = await stat(full); } catch { fail(`файл не найден: ${path}`); }
  if (!info.isFile()) fail(`это не файл: ${path}`);
  if (info.size > max) fail(`${what} больше допустимого для бота (${(info.size / 1048576).toFixed(1)} МБ): ${path}`);
  return { blob: await openAsBlob(full), name: basename(full) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(await helpText()); return; }
  if (MODE === 'topic' && args.dm) fail('В parallel отчёты и ответы идут в группу, чтобы обратная правка попала в ту же тему. --dm недоступен.');

  let text = args.texts.join(' ');
  if (args.textFile) { try { text = (await readFile(resolve(args.textFile), 'utf8')).replace(/^﻿/, ''); } catch { fail(`не удалось прочитать ${args.textFile}`); } }
  if (args.stdin) { const parts = []; for await (const chunk of process.stdin) parts.push(chunk); text = Buffer.concat(parts).toString('utf8'); }
  text = text.replace(/\r\n/g, '\n').trim();
  const media = args.photos.length + (args.video ? 1 : 0) + (args.file ? 1 : 0);
  if (!text && !args.caption && !media) fail('нечего отправлять (см. --help)');
  if (args.photos.length > 10) fail('не больше 10 фото за раз');

  if (args.options.length && !text) fail('Для кнопок нужен текст вопроса.');
  if (args.kind === 'final') {
    if (!text || args.options.length) fail('--final: нужен текст итогового отчёта без кнопок.');
    text += '\n\nДля продолжения откройте этот чат агента в ChatGPT. Пока работа завершена, новые сообщения могут ожидать в Telegram до следующей проверки входящих агентом.';
  }
  if (args.options.length && args.kind === 'report') args.kind = 'question';
  const keyboard = [];
  for (const [index, label] of args.options.entries()) {
    if (index % 2 === 0) keyboard.push([]);
    keyboard.at(-1).push({ text: label, callback_data: `at:${index}` });
  }
  if (bridgeState?.enabled && args.kind === 'question' && (!binding || binding.released || bridgeState.active !== sessionId))
    fail('Сначала зарегистрируйте этот диалог в мосте.');
  const header = HEADERS[args.kind] + signature;
  // Правило проекта: с хештега начинается каждое сообщение — и продолжение длинного текста, и подпись.
  const tagged = (parts) => parts.map((part, i) => (i === 0 ? part : `${TAG} · продолжение${signature}\n\n${part}`));
  const continuation = `${TAG} · продолжение${signature}\n\n`;
  const longest = args.options.reduce((size, label) => Math.max(size, label.length), 0);
  const partLimit = longest ? Math.min(TEXT_LIMIT, 4096 - continuation.length - '\n\nВыбрано: \nОтвет принят агентом'.length - longest) : TEXT_LIMIT;
  if (partLimit <= header.length + 2) fail('Подпись не помещается в ответ Telegram. Напишите варианты в тексте, на кнопках оставьте буквы.');
  const messages = text ? tagged(chunks(`${header}\n\n${text}`, partLimit)) : [];
  const questionPart = messages.length - 1;
  let caption = args.caption.trim();
  if (caption.length > CAPTION_LIMIT) { messages.push(...tagged(chunks(`${header}\n\n${caption}`, TEXT_LIMIT))); caption = ''; }
  if (media) caption = caption ? `${text ? TAG + signature : header}\n${caption}` : TAG + signature;

  // Куда: в топик проекта в группе владельца, если топик закреплён (projects.json: group и topic проекта);
  // иначе или с --dm — в личные сообщения.
  const group = MODE === 'topic' ? REGISTRY?.group : null;
  let groupTarget = !args.dm && group?.chat_id && Number.isSafeInteger(ME.topic) ? { chat_id: String(group.chat_id), message_thread_id: ME.topic } : null;
  // Ответ на сообщение: найти, в каком чате и топике оно лежит (входящие проекта и наши отправленные; свежее — главнее).
  let replyIn = null; // 'dm' | 'group' | null — неизвестно
  if (args.replyTo) {
    const rows = [];
    for (const name of ['queue.jsonl', 'sent.jsonl']) {
      let raw = '';
      try { raw = await readFile(resolve(ME.inbox, name), 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (name === 'queue.jsonl' && row.message?.message_id === args.replyTo) rows.push({ chat: String(row.message.chat?.id), thread: row.message.is_topic_message ? row.message.message_thread_id : null });
        if (name === 'sent.jsonl' && row.message_id === args.replyTo) rows.push({ chat: row.chat_id == null ? null : String(row.chat_id), thread: row.thread ?? null });
      }
    }
    if (new Set(rows.map(row => `${row.chat}:${row.thread}`)).size > 1) fail('Номер ответа неоднозначен: он есть в разных чатах или темах. Отправьте новый отчёт без --reply-to.');
    const found = rows.at(-1);
    if (found) {
      if (MODE === 'topic' && found.chat !== String(group.chat_id)) fail('Старый ответ из другого чата не переносится в параллельную группу. Отправьте новый отчёт в тему.');
      if (MODE === 'topic' && found.thread && Object.entries(REGISTRY.projects).some(([key, p]) => key !== PROJECT && p.topic === found.thread)) fail('Ответ относится к теме другого проекта. Отправка отменена.');
      const inGroup = MODE === 'private' ? found.chat != null && found.chat !== ME.privateChat?.chat_id
        : !!group?.chat_id && found.chat === String(group.chat_id);
      replyIn = inGroup ? 'group' : 'dm';
      if (inGroup && !args.dm && group) groupTarget = { chat_id: String(group.chat_id), ...(found.thread ? { message_thread_id: found.thread } : {}) };
      if (!inGroup) groupTarget = null;
    }
  }
  const where = groupTarget ? `группа «${group.title || group.chat_id}», ${groupTarget.message_thread_id ? `топик «${groupTarget.message_thread_id === ME.topic ? ME.topicName || ME.topic : (group.topics?.[groupTarget.message_thread_id] || groupTarget.message_thread_id)}»` : 'общий топик'}` : 'личные сообщения';

  if (args.dryRun) {
    // Вложения проверяются и «вхолостую»: существование и допустимый размер.
    for (const p of args.photos) await blobOf(p, MAX_PHOTO, 'фото');
    if (args.video) await blobOf(args.video, MAX_FILE, 'видео');
    if (args.file) await blobOf(args.file, MAX_FILE, 'файл');
    console.log(`--- куда: ${where}`);
    for (const row of keyboard) console.log('--- кнопки: ' + row.map((b) => b.text).join(' | '));
    for (const m of messages) console.log('--- сообщение ---\n' + m);
    if (media) console.log(`--- вложения: фото ${args.photos.length}, видео ${args.video ? 1 : 0}, файл ${args.file ? 1 : 0}; подпись: ${caption || '(нет)'}`);
    return;
  }

  const { token, chat } = await loadKeys();
  const dmTarget = { chat_id: String(chat) };
  let target = groupTarget || dmTarget;
  // Ответ «в ветку»: если исходное сообщение удалено или оно в другом чате, Telegram всё равно отправит наше.
  const reply = args.replyTo ? { message_id: args.replyTo, allow_sending_without_reply: true } : null;
  const head = [text,args.caption].filter(Boolean).join('\n');
  const base = (t) => ({
    chat_id: t.chat_id,
    ...(t.message_thread_id ? { message_thread_id: t.message_thread_id } : {}),
    ...(args.silent ? { disable_notification: true } : {}),
    // Номер для ответа имеет смысл только в своём чате: при запасной отправке в личку ответ на сообщение группы не ставим.
    ...(reply && (replyIn === null || (replyIn === 'dm') === (t === dmTarget)) ? { reply_parameters: reply } : {}),
  });
  const formFor = (t) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(base(t))) form.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    return form;
  };
  // Ошибка адресата не меняет маршрут: обратный ответ должен остаться в теме проекта.
  async function post(method, build, timeoutMs) {
    if (target !== dmTarget) {
      for (let attempt = 0; ; attempt++) {
        try { return await call(token, method, build(target), timeoutMs, true); }
        catch (error) {
          if (error.code === 429 && attempt === 0) { await new Promise((done) => setTimeout(done, Math.min(error.retryAfter || 5, 60) * 1000)); continue; }
          fail(`${error.message}. Доставка в тему не подтверждена; маршрут не изменён. Проверьте тему и права бота перед повтором.`);
        }
      }
    }
    return call(token, method, build(target), timeoutMs);
  }
  const dest = () => (target === dmTarget ? 'личные сообщения' : 'топик');
  for (const [i, m] of messages.entries()) {
    const markup = i === questionPart && keyboard.length ? { reply_markup: { inline_keyboard: keyboard } } : {};
    const sent = await post('sendMessage', (t) => ({ ...base(t), ...markup, text: m, disable_web_page_preview: true }), 60000);
    await remember(sent.message_id, args.kind, head, target);
    console.log(`tg: текст отправлен, message_id=${sent.message_id} · ${dest()}${sent.text === m ? '' : ' (внимание: текст в ответе Telegram отличается от исходного — проверьте кодировку)'}`);
  }
  if (args.photos.length === 1) {
    const { blob, name } = await blobOf(args.photos[0], MAX_PHOTO, 'фото');
    const sent = await post('sendPhoto', (t) => { const form = formFor(t); if (caption) form.set('caption', caption); form.set('photo', blob, name); return form; }, 300000);
    await remember(sent.message_id, args.kind, head || 'фото', target);
    console.log(`tg: фото отправлено, message_id=${sent.message_id} · ${dest()}`);
  } else if (args.photos.length > 1) {
    const files = [];
    for (const p of args.photos) files.push(await blobOf(p, MAX_PHOTO, 'фото'));
    const sent = await post('sendMediaGroup', (t) => {
      const form = formFor(t);
      const group = files.map((f, i) => { form.set(`p${i}`, f.blob, f.name); return { type: 'photo', media: `attach://p${i}`, ...(i === 0 && caption ? { caption } : {}) }; });
      form.set('media', JSON.stringify(group));
      return form;
    }, 300000);
    for (const item of sent) await remember(item.message_id, args.kind, head || 'альбом', target);
    console.log(`tg: альбом из ${sent.length} фото отправлен, message_id=${sent.map((item) => item.message_id).join(',')} · ${dest()}`);
  }
  if (args.video) {
    const { blob, name } = await blobOf(args.video, MAX_FILE, 'видео');
    const sent = await post('sendVideo', (t) => { const form = formFor(t); form.set('caption', args.photos.length ? TAG + signature : caption); form.set('supports_streaming', 'true'); form.set('video', blob, name); return form; }, 600000);
    await remember(sent.message_id, args.kind, head || 'видео', target);
    console.log(`tg: видео отправлено, message_id=${sent.message_id} · ${dest()}`);
  }
  if (args.file) {
    const { blob, name } = await blobOf(args.file, MAX_FILE, 'файл');
    const sent = await post('sendDocument', (t) => { const form = formFor(t); form.set('caption', args.photos.length || args.video ? TAG + signature : caption); form.set('document', blob, name); return form; }, 600000);
    await remember(sent.message_id, args.kind, head || 'файл', target);
    console.log(`tg: файл отправлен, message_id=${sent.message_id} · ${dest()}`);
  }
}

await main();
