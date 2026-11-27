// Отдельный живой запуск с обычным входом Codex. Telegram целиком подменён.
// Один согласованный прогон, максимум два новых диалога. Его manifest нельзя использовать повторно.
// node tests/codex-live.test.mjs --live --manifest /absolute/run.json [--matrix|--edges|--approval|--recover [--sent-only]|--long] [--shared]
// node tests/codex-live.test.mjs --cleanup /absolute/run.json
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { atomic, codexBinary, codexRPC, codexStep, ingest, register, state, verifyThread, projectStateHub } from '../tg-bridge.mjs';

export const LIVE_POLICY = Object.freeze({ model: 'gpt-6-luna', reasoningEffort: 'low' });
// Codex также записывает созданные через App Server диалоги с источником vscode.
const liveSources = ['appServer', 'vscode'];
const liveConfig = { model_reasoning_effort: 'low', 'agents.enabled': false, 'features.multi_agent': false, 'features.multi_agent_v2': false };
const runtimeArgs = endpoint => [...Object.entries({ model: LIVE_POLICY.model, ...liveConfig }).flatMap(([key, value]) => ['-c', key + '=' + JSON.stringify(value)]), 'app-server', '--listen', 'unix://' + endpoint];
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function parseLiveArgs(args) {
  if (args[0] === '--cleanup' && args.length === 2 && args[1] && !args[1].startsWith('--')) return { cleanup: resolve(args[1]) };
  const flags = new Set(['--live', '--shared', '--matrix', '--edges', '--approval', '--recover', '--sent-only', '--long']);
  const at = args.indexOf('--manifest'), manifest = at >= 0 && args[at + 1];
  if (!args.includes('--live') || !manifest || manifest.startsWith('--')) throw Error('Нужны --live --manifest <path>; для незавершённого прогона используйте --cleanup <path>.');
  const rest = args.filter((_, i) => i !== at && i !== at + 1);
  if (new Set(rest).size !== rest.length || rest.some(v => !flags.has(v))) throw Error('Неизвестный или повторный параметр live-runner.');
  const selected = rest.filter(v => ['--matrix', '--edges', '--approval', '--recover', '--long'].includes(v));
  if (selected.length > 1) throw Error('Один согласованный сценарий на manifest, без серии прогонов.');
  if (rest.includes('--sent-only') && !rest.includes('--recover')) throw Error('--sent-only требует --recover.');
  if (rest.includes('--shared') && rest.includes('--recover')) throw Error('Сбой допускается только у своего runtime.');
  return { manifest: resolve(manifest), shared: rest.includes('--shared'), flags: new Set(rest), timeoutMs: rest.includes('--long') ? 25 * 60_000 : 10 * 60_000 };
}
export function assertLiveModel(result) {
  if (result.model !== LIVE_POLICY.model || result.reasoningEffort !== LIVE_POLICY.reasoningEffort) throw Error('Модель теста не подтверждена: требуется gpt-6-luna / low, получено ' + JSON.stringify({ model: result.model, reasoningEffort: result.reasoningEffort }) + '. Ввод запрещён.');
}
export async function requireLiveModel(rpc) {
  let cursor;
  const seen = new Set();
  do {
    const page = await rpc.call('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data)) throw Error('model/list не вернул каталог моделей.');
    const model = page.data.find(v => v.model === LIVE_POLICY.model);
    if (model) {
      if (!model.supportedReasoningEfforts?.some(v => v.reasoningEffort === LIVE_POLICY.reasoningEffort)) throw Error('gpt-6-luna не объявляет поддержку low; тест остановлен.');
      return;
    }
    cursor = page.nextCursor;
    if (cursor && (seen.has(cursor) || seen.size >= 20)) throw Error('Не удалось полностью проверить model/list.');
    seen.add(cursor);
  } while (cursor);
  throw Error('gpt-6-luna отсутствует в model/list; автоматическая замена модели запрещена.');
}
export async function createLiveManifest(path, run) {
  await mkdir(dirname(path), { recursive: true });
  const fd = await open(path, 'wx', 0o600);
  try { await fd.writeFile(JSON.stringify(run)); await fd.sync(); } finally { await fd.close(); }
}
export function assertCleanupRunnerStopped(run, alive = pid => {
  try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}) {
  if (!Number.isSafeInteger(run.runnerPid) || run.runnerPid <= 1 || alive(run.runnerPid)) throw Error('Исходный live-runner ещё жив или его остановка не подтверждена. Сначала завершите его; параллельный cleanup запрещён.');
}
export async function acquireLiveRunLock(path) {
  // Блокировка живёт в ядре: SIGKILL не оставляет stale lockfile.
  const port = 16000 + createHash('sha256').update('codex-live:' + await realpath(path)).digest().readUInt16BE() % 40000;
  const server = createServer(socket => socket.destroy());
  try { await new Promise((ok, fail) => server.once('error', fail).listen({ host: '127.0.0.1', port, exclusive: true }, ok)); }
  catch (e) { throw Error('Manifest уже занят другим runner/cleanup: ' + path + ' (' + e.code + ')'); }
  return () => new Promise(done => server.close(done));
}
export async function reserveLiveInput(run, save) {
  if (run.stopping) throw Error('Прогон уже остановлен; новый ввод запрещён.');
  if (run.submissions >= 30) throw Error('Исчерпан лимит 30 тестовых входящих/RPC submissions.');
  run.submissions++; await save();
}
export async function startLiveThread(rpc, run, save, params) {
  if (run.stopping || run.startsRequested >= 2) throw Error('Нельзя создавать дополнительные тестовые диалоги.');
  const label = run.startsRequested++ === 0 ? 'A' : 'B';
  run.creationPending = label; await save();
  const result = await rpc.call('thread/start', { ...params, model: LIVE_POLICY.model, config: { ...liveConfig }, allowProviderModelFallback: false });
  if (!uuid.test(result.thread?.id)) throw Error('thread/start не вернул точный UUID.');
  // Сохраняем A до запроса B, включая случай неверной модели в ответе.
  run.threads.push({ id: result.thread.id, label, cwd: run.dir, source: result.thread.source, model: result.model, reasoningEffort: result.reasoningEffort });
  delete run.creationPending; await save();
  if (resolve(result.thread.cwd) !== run.dir || !liveSources.includes(result.thread.source)) throw Error('thread/start вернул другую папку или источник диалога.');
  assertLiveModel(result);
  return result.thread;
}
async function pages(rpc, method, params) {
  const rows = [], seen = new Set();
  let cursor;
  do {
    const page = await rpc.call(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page.data)) throw Error(method + ': неизвестный формат ответа.');
    rows.push(...page.data); cursor = page.nextCursor;
    if (cursor && (seen.has(cursor) || seen.size >= 100)) throw Error(method + ': незавершённая пагинация.');
    seen.add(cursor);
  } while (cursor);
  return rows;
}
export async function archiveLiveThread(rpc, run, entry, save) {
  const archived = async () => (await pages(rpc, 'thread/list', { archived: true, sourceKinds: liveSources, modelProviders: [], cwd: run.dir })).some(t => t.id === entry.id && resolve(t.cwd) === run.dir);
  const unloaded = async () => !(await pages(rpc, 'thread/loaded/list', {})).includes(entry.id);
  if (!await archived()) {
    await verifyThread(rpc, entry.id, run.dir);
    const end = Date.now() + 30_000;
    let loaded;
    for (;;) {
      const queued = await pages(rpc, 'thread/queue/list', { threadId: entry.id });
      entry.cleanupQueueIds = [...new Set([...(entry.cleanupQueueIds || []), ...queued.map(v => v.id)])]; await save();
      // Все записи принадлежат отдельному тестовому UUID/cwd, включая FOREIGN_ENTRY fixture.
      for (const q of queued) await rpc.call('thread/queue/delete', { threadId: entry.id, queuedSubmissionId: q.id });
      const current = await verifyThread(rpc, entry.id, run.dir);
      if (!['idle', 'active', 'notLoaded'].includes(current.status.type)) throw Error('Состояние диалога не подтверждает остановку: ' + current.status.type);
      loaded = current.status.type !== 'notLoaded';
      // После crash в истории бывает незавершённый ход, но unloaded runtime его не исполняет.
      const active = loaded ? current.turns.filter(t => t.status === 'inProgress') : [];
      entry.cleanupTurnIds = [...new Set([...(entry.cleanupTurnIds || []), ...active.map(v => v.id)])]; await save();
      for (const turn of active) await rpc.call('turn/interrupt', { threadId: entry.id, turnId: turn.id });
      if (!queued.length && !active.length && current.status.type !== 'active') break;
      if (Date.now() >= end) throw Error('Не удалось остановить очередь/ход ' + entry.id);
      await delay(150);
    }
    // queue/list/delete работают со stored thread, backgroundTerminals/clean требует loaded.
    if (loaded) await rpc.call('thread/backgroundTerminals/clean', { threadId: entry.id });
    entry.archiveRequestedAt = Date.now(); await save();
    await rpc.call('thread/archive', { threadId: entry.id });
  }
  const end = Date.now() + 20_000;
  while (!await archived() || !await unloaded()) {
    if (Date.now() >= end) throw Error('Архивация/выгрузка не подтверждена для ' + entry.id);
    await delay(150);
  }
  entry.archivedAt = Date.now(); delete entry.cleanupError; await save();
}

// PID сам по себе не доказывает владение: сверяем время создания процесса перед сигналом.
function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) throw Error('Недопустимый PID cleanup.');
  try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return null; throw e; }
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$proc = Get-CimInstance Win32_Process -Filter "ProcessId = ' + pid + '"; if ($proc) { @{identity=$proc.CreationDate.ToString("o");command=$proc.CommandLine} | ConvertTo-Json -Compress }'], { encoding: 'utf8', timeout: 3000 });
    if (r.status !== 0) throw Error('Не удалось проверить владельца PID ' + pid);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  }
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'stat=', '-o', 'args='], { encoding: 'utf8', timeout: 3000 });
  if (r.status === 1 && !r.stdout.trim()) return null;
  const text = r.stdout.trim(), rest = text.slice(24).trim();
  if (r.status !== 0 || !rest || !text.slice(0, 24).includes(':')) throw Error('Не удалось проверить владельца PID ' + pid);
  return rest.startsWith('Z') ? null : { identity: text.slice(0, 24), command: rest.replace(/^\S+\s+/, '') };
}
const children = new Map();
async function launchRecorded(run, save, role, exe, args, env) {
  const record = { role, exe, args, cwd: run.dir, endpoint: run.endpoint, requestedAt: Date.now() };
  run.processes.push(record); await save();
  const child = spawn(exe, args, { cwd: run.dir, env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.failureOutput = '';
  child.stderr.on('data', b => { child.failureOutput = (child.failureOutput + b).slice(-8000); process.stderr.write(b); });
  child.once('error', error => { child.launchError = error; });
  await new Promise((ok, fail) => child.once('spawn', ok).once('error', fail));
  record.pid = child.pid; children.set(child.pid, child);
  const identity = processIdentity(child.pid); Object.assign(record, identity || {}, { startedAt: Date.now() }); await save();
  return child;
}
async function stopRecorded(record, save, signal = 'SIGTERM') {
  if (!record.pid) { record.stoppedAt = Date.now(); await save(); return; }
  const child = children.get(record.pid);
  let current = child && (child.exitCode !== null || child.signalCode !== null) ? null : processIdentity(record.pid);
  const same = () => current && current.identity === record.identity && current.command === record.command;
  if (current && (!record.identity || current.identity === record.identity && current.command !== record.command)) throw Error('Не подтверждён владелец PID ' + record.pid);
  if (same()) {
    try { process.kill(record.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    const end = Date.now() + 3000;
    do { await delay(100); current = processIdentity(record.pid); } while (same() && Date.now() < end);
    if (same()) {
      try { process.kill(record.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
      await delay(150); current = processIdentity(record.pid);
      if (same()) throw Error('Свой процесс не завершился: ' + record.pid);
    }
    if (current && current.identity === record.identity) throw Error('Процесс изменился во время cleanup: ' + record.pid);
  }
  record.stoppedAt = Date.now(); await save();
}
function validateManifest(run) {
  if (run.kind !== 'agent-telegram-codex-live' || ![1, 2].includes(run.version) || !uuid.test(run.runId) || !isAbsolute(run.dir) || run.integrationHome !== join(run.dir, 'integration-test')) throw Error('Неподдерживаемый manifest или пути fixture.');
  if (run.version === 1 ? run.hub !== join(run.dir, 'fixture') :
    run.project !== 'bridge-test' || run.transportHub !== join(run.dir, 'fixture') || run.hub !== projectStateHub(run.transportHub, run.project))
    throw Error('Неподдерживаемый manifest или пути fixture.');
  if (!run.shared && run.endpoint !== join(run.dir, 'runtime.sock')) throw Error('Неизвестный dedicated endpoint.');
  if (!Array.isArray(run.threads) || run.threads.length > 2 || new Set(run.threads.map(t => t.id)).size !== run.threads.length || run.threads.some(t => !uuid.test(t.id) || t.cwd !== run.dir)) throw Error('Недопустимые тестовые UUID/cwd.');
  if (!Array.isArray(run.processes) || run.processes.some(p => !['receiver', 'runtime'].includes(p.role) || p.cwd !== run.dir || p.endpoint !== run.endpoint)) throw Error('Недопустимые записи собственных процессов.');
}
async function discoverManagedRuntime(run, save) {
  if (run.shared) return;
  const data = await state(run.hub);
  for (const entry of run.threads) {
    const session = data?.sessions[entry.id], managed = session?.managedRuntime;
    if (!managed || managed.kind !== 'dedicated' || managed.endpoint !== run.endpoint || session.cwd !== run.dir || run.processes.some(p => p.pid === managed.pid)) continue;
    const identity = processIdentity(managed.pid);
    if (!identity) continue;
    if (!identity.command.includes('app-server') || !identity.command.includes('--listen') || !identity.command.includes(run.endpoint)) throw Error('Восстановленный runtime не совпал с собственным endpoint.');
    run.processes.push({ role: 'runtime', pid: managed.pid, cwd: run.dir, endpoint: run.endpoint, ...identity, recovered: true }); await save();
  }
}
async function disableFixture(run) {
  const ids = new Set(run.threads.map(t => t.id));
  await state(run.hub, d => {
    if (d.active && !ids.has(d.active) || d.cwd && d.cwd !== run.dir || [...ids].some(id => d.sessions[id] && (d.sessions[id].cwd !== run.dir || d.sessions[id].endpoint !== run.endpoint))) throw Error('Fixture теперь закреплена за чужим UUID/cwd/endpoint; cleanup остановлен.');
    d.enabled = false; d.paused = true; d.active = null;
    for (const id of ids) if (d.sessions[id]) d.sessions[id].released = true;
    for (const e of Object.values(d.events)) if (ids.has(e.session) && ['waiting', 'hydrating', 'sending', 'sent', 'uncertain'].includes(e.status)) e.status = 'cancelled';
    for (const q of Object.values(d.questions || {})) if (ids.has(q.session)) q.closed = true;
  });
}
async function connectCleanup(run, save) {
  try { return await codexRPC(run.endpoint, run.dir); }
  catch (error) {
    if (run.shared || run.processes.some(p => { const live = p.role === 'runtime' && p.pid && processIdentity(p.pid); return live && live.identity === p.identity; })) throw error;
    // Только RPC-сервер для архивации сохранённых UUID: никаких resume/start/enqueue.
    await launchRecorded(run, save, 'runtime', codexBinary(), runtimeArgs(run.endpoint), process.env);
    const end = Date.now() + 15_000;
    do { try { return await codexRPC(run.endpoint, run.dir); } catch { await delay(150); } } while (Date.now() < end);
    throw Error('Сервер cleanup недоступен; архивирование не подтверждено.');
  }
}
export async function cleanupLiveRun(run, { save, connect = () => connectCleanup(run, save), stopProcess = p => stopRecorded(p, save), disable = () => disableFixture(run), discover = () => discoverManagedRuntime(run, save) }) {
  validateManifest(run);
  run.stopping = true; run.cleanup = { status: 'running', startedAt: Date.now(), errors: [] }; await save();
  const attempt = async (step, fn) => { try { await fn(); } catch (e) { run.cleanup.errors.push({ step, message: e.message }); await save(); } };
  await attempt('disable binding', disable);
  if (run.cleanup.errors.length) {
    run.cleanup.status = 'blocked'; run.cleanup.finishedAt = Date.now(); await save();
    throw Error('Cleanup остановлен до мутаций runtime: ' + JSON.stringify(run.cleanup.errors));
  }
  for (const p of run.processes.filter(p => p.role === 'receiver')) await attempt('stop receiver ' + p.pid, () => stopProcess(p));
  await attempt('record recovered runtime', discover);
  let rpc;
  try {
    if (run.threads.length) {
      rpc = await connect();
      for (const entry of run.threads) await attempt('archive ' + entry.id, async () => {
        try { await archiveLiveThread(rpc, run, entry, save); } catch (e) { entry.cleanupError = e.message; throw e; }
      });
    }
  } catch (e) { run.cleanup.errors.push({ step: 'connect for archive', message: e.message }); }
  finally {
    rpc?.close();
    if (!run.shared) for (const p of run.processes.filter(p => p.role === 'runtime')) await attempt('stop runtime ' + p.pid, () => stopProcess(p));
  }
  if (run.creationPending) run.cleanup.errors.push({ step: 'thread/start ' + run.creationPending, message: 'Ответ с UUID не получен; отсутствие нового диалога не доказано.' });
  run.cleanup.finishedAt = Date.now();
  run.cleanup.status = run.cleanup.errors.length || run.threads.some(t => !t.archivedAt) ? 'blocked' : 'complete'; await save();
  if (run.cleanup.status !== 'complete') throw Error('Cleanup не завершён: ' + JSON.stringify(run.cleanup.errors));
}

export async function main(args = process.argv.slice(2)) {
const options = parseLiveArgs(args);
if (options.cleanup) {
  options.cleanup = await realpath(options.cleanup);
  const unlock = await acquireLiveRunLock(options.cleanup);
  try {
    const run = JSON.parse(await readFile(options.cleanup, 'utf8'));
    validateManifest(run); assertCleanupRunnerStopped(run); process.env.TG_BRIDGE_HOME = run.integrationHome;
    await cleanupLiveRun(run, { save: () => atomic(options.cleanup, run) });
    console.log('CLEANUP COMPLETE', options.cleanup); return;
  } finally { await unlock(); }
}
const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = await realpath(await mkdtemp(join(tmpdir(), 'tg-live-')));
process.env.TG_BRIDGE_HOME = join(dir, 'integration-test');
const shared = options.shared;
const bot = String(1000 + process.pid);
let socket = join(dir, 'runtime.sock');
if (shared) {
  const version = spawnSync(codexBinary(), ['app-server', 'daemon', 'version'], { encoding: 'utf8', timeout: 6000 });
  if (version.status !== 0) throw Error('Штатный daemon недоступен: ' + (version.stderr || version.error?.message || 'код ' + version.status).trim());
  const info = JSON.parse(version.stdout);
  if (info.status !== 'running' || !info.socketPath) throw Error('Штатный daemon не запущен: ' + version.stdout.trim());
  socket = info.socketPath;
}
const project = 'bridge-test', transportHub = join(dir, 'fixture'), hub = projectStateHub(transportHub, project), inbox = join(hub, 'inbox');
const run = { kind: 'agent-telegram-codex-live', version: 2, runId: randomUUID(), createdAt: Date.now(), runnerPid: process.pid,
  dir, hub, transportHub, integrationHome: process.env.TG_BRIDGE_HOME, endpoint: socket, shared, project, bot,
  ...LIVE_POLICY, scenario: [...options.flags], startsRequested: 0, submissions: 0, threads: [], processes: [], phase: 'setup' };
await createLiveManifest(options.manifest, run);
options.manifest = await realpath(options.manifest);
const unlock = await acquireLiveRunLock(options.manifest);
try {
console.log('MANIFEST', options.manifest, 'MODEL', LIVE_POLICY.model, LIVE_POLICY.reasoningEffort, 'MAX_THREADS', 2, 'MAX_SUBMISSIONS', 30);
let writing = Promise.resolve();
const save = () => { const snapshot = structuredClone(run); return writing = writing.catch(() => {}).then(() => atomic(options.manifest, snapshot)); };
await mkdir(inbox, { recursive: true });
spawnSync('git', ['init', '-q', dir]);
const ctx = { hub, transportHub, project, bot, mode: 'topic', chat: '-701', topic: 7, cwd: dir };
await writeFile(join(dir, '.agent-telegram.json'), JSON.stringify({ project, hub: transportHub }));
await writeFile(join(transportHub, 'projects.json'), JSON.stringify({ version: 2, mode: 'parallel', default: project, group: { chat_id: '-701', forum: true }, projects: { [project]: { mode: 'topic', tag: '#bridge_test', topic: 7, inbox } } }));
await mkdir(join(transportHub, '.secrets'), { recursive: true });
await writeFile(join(transportHub, '.secrets', 'telegram.env'), 'TG_BOT_TOKEN=' + bot + ':sandbox\nTG_CHAT_ID=100\n');
const updates = join(dir, 'updates.json'), mock = join(dir, 'telegram.mjs');
await writeFile(updates, '[]');
await writeFile(mock, `
import {readFile,appendFile} from 'node:fs/promises';
const real = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if(!String(url).startsWith('https://api.telegram.org/')) return real(url,opts);
  const method=String(url).split('/').at(-1), p=JSON.parse(opts.body);
  let result=true;
  if(method==='getUpdates'){
    await new Promise(r=>setTimeout(r,150));
    result=JSON.parse(await readFile(process.env.TEST_UPDATES,'utf8')).filter(u=>u.update_id >= (p.offset||0));
  } else await appendFile(process.env.TEST_UPDATES+'.log',JSON.stringify({method,params:p})+'\\n');
  return Response.json({ok:true,result});
};`);
let runtime, service, rpc;
const controller = new AbortController();
const check = () => controller.signal.throwIfAborted();
const sleep = ms => delay(ms, undefined, { signal: controller.signal });
const abort = reason => {
  if (controller.signal.aborted) return;
  run.stopping = true; run.stopReason = reason; controller.abort(Error(reason));
  for (const entry of run.processes.filter(p => p.role === 'receiver')) {
    const child = children.get(entry.pid);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
};
const signals = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
  process.exitCode = signal === 'SIGINT' ? 130 : 143; abort(signal);
}]));
for (const [signal, handler] of signals) process.on(signal, handler);
const deadline = setTimeout(() => abort('Исчерпан лимит времени live-runner.'), options.timeoutMs);
async function connectRun() {
  check();
  const connection = await codexRPC(socket, dir);
  return { close: () => connection.close(), call: async (method, params) => {
    check();
    if (['turn/start', 'turn/steer', 'thread/queue/add'].includes(method)) { await reserveLiveInput(run, save); check(); }
    return connection.call(method, method === 'turn/start' ? { ...params, model: LIVE_POLICY.model, effort: LIVE_POLICY.reasoningEffort } : params);
  } };
}
async function stop(p, signal = 'SIGTERM') {
  if (!p) return;
  const record = run.processes.find(v => v.pid === p.pid);
  if (!record) throw Error('Процесс отсутствует в manifest.');
  await stopRecorded(record, save, signal);
}
async function until(fn, seconds = 140) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) { check(); const v = await fn(); if (v) return v; await sleep(350); }
  throw Error('Тайм-аут проверки, временные файлы: ' + dir);
}
const serviceEnv = { ...process.env, TG_PROJECT: project, TG_HUB: transportHub, TG_BOT_TOKEN: bot + ':sandbox', TG_CHAT_ID: '100', TEST_UPDATES: updates, NODE_OPTIONS: '--import ' + pathToFileURL(mock).href };
const startService = async () => { check(); return launchRecorded(run, save, 'receiver', process.execPath, [join(kit, 'tg-bridge.mjs'), 'serve', '--project', project], serviceEnv); };
let seq = 0;
async function incoming(text) {
  check(); await reserveLiveInput(run, save); check();
  const n = ++seq;
  const u = { update_id: n, message: { message_id: n, from: { id: 100 }, date: Math.floor(Date.now() / 1000), chat: { id: -701, type: 'supergroup', is_forum: true }, message_thread_id: 7, is_topic_message: true, text } };
  await writeFile(updates, JSON.stringify([u]));
  return bot + ':' + n;
}
async function evidence(id) {
  const e = await until(async () => { const row = (await state(hub))?.events?.[id]; return row?.status === 'acked' && row; });
  console.log('ACK', e.id, e.session, e.turn || 'command'); return e;
}
// Останавливаем только свой receiver. Перед реальным RPC точно воспроизводим
// границу, на которой другой клиент успевает открыть или закончить ход.
async function saved(text) {
  await incoming(text);
  const [update] = JSON.parse(await readFile(updates, 'utf8'));
  return ingest(hub, bot, { ...update, why: 'topic' });
}
const input = text => [{ type: 'text', text, text_elements: [] }];
async function enqueueBehindTurn(id) {
  const row = await saved('Проверка гонки двух клиентов. Напиши RACE_OK и явный текстовый ACK без инструментов.');
  const bridge = await connectRun();
  let terminal;
  try {
    await codexStep(ctx, { call: async (method, params) => {
      if (method === 'thread/queue/add') {
        terminal = await rpc.call('turn/start', { threadId: id, input: input('Выполни sleep 25, затем ответь HOLD_DONE.') });
      }
      return bridge.call(method, params);
    } });
  } finally { bridge.close(); }
  const entry = (await state(hub)).events[row.id];
  assert.ok(terminal && entry.queueId && !entry.turn && entry.status === 'sent');
  const queue = await rpc.call('thread/queue/list', { threadId: id });
  assert.ok(queue.data.some(item => item.id === entry.queueId && item.clientUserMessageId === row.receipt));
  return { row, turn: terminal.turn.id };
}
try {
  if (!shared) runtime = await launchRecorded(run, save, 'runtime', codexBinary(), runtimeArgs(socket), process.env);
  rpc = await until(async () => {
    if (runtime && (runtime.launchError || runtime.exitCode !== null || runtime.signalCode !== null)) {
      throw Error('Выделенный Codex завершился до initialize: ' + (runtime.failureOutput.trim() || runtime.launchError?.message || 'код ' + runtime.exitCode));
    }
    try { return await connectRun(); }
    catch (error) {
      if (shared) throw error;
      if (runtime.exitCode !== null || runtime.launchError) throw Error('Выделенный Codex не запущен: ' + (runtime.failureOutput.trim() || runtime.launchError?.message || error.message));
      return false;
    }
  }, 20);
  await requireLiveModel(rpc);
  const approval = options.flags.has('--approval');
  const start = () => startLiveThread(rpc, run, save, { cwd: dir, historyMode: 'legacy', developerInstructions: 'This is a delivery acceptance test. Never spawn agents, create another conversation, run another live test, or start any Codex/Claude CLI or model API. Only perform exactly the requested minimal test action. When an incoming owner message contains NO_RECEIPT, reply with exactly NO_RECEIPT, without tools or any acknowledgement marker. Otherwise acknowledge using the explicit final text marker requested by the bridge.', sandbox: 'read-only', approvalPolicy: approval ? 'untrusted' : 'never' });
  const A = await start();
  const B = await start();
  run.phase = 'testing'; await save();
  console.log('PROJECT', dir, 'A', A.id, 'B', B.id);
  await register(ctx, { id: A.id, cwd: dir, client: 'codex-cli', endpoint: socket, testPolicy: { ...LIVE_POLICY },
    ...(!shared ? { managedRuntime: { kind: 'dedicated', endpoint: socket, pid: runtime.pid, startedAt: Date.now() } } : {}) });
  service = await startService();
  const first = await incoming('Проверка связи. Не используй инструменты. Дай явный ACK строкой TG_ACK с идентификаторами из сообщения. Напиши ALPHA.');
  await evidence(first);
  const thread = id => verifyThread(rpc, id, dir);
  await until(async () => (await thread(A.id)).status.type === 'idle');
  const b = await rpc.call('thread/read', { threadId: B.id });
  assert.equal(b.thread.preview, '');
  console.log('PASS A/B адресация');
  await archiveLiveThread(rpc, run, run.threads.find(t => t.id === B.id), save);
  console.log('ARCHIVED B', B.id);
  if (approval) {
    rpc.close(); rpc = await connectRun(); // На запрос отвечает соединение моста.
    const id = await incoming('Проверка окна разрешения Codex. Сначала один раз выполни в shell команду node -e "console.log(108+13)". Используй обычные параметры и оставь текущие ограничения. При отказе не повторяй команду.');
    const request = await until(async () => (await state(hub)).sessions[A.id].runtimeRequestError);
    assert.equal(request.method, 'item/commandExecution/requestApproval');
    assert.equal(request.threadId, A.id);
    await until(async () => (await thread(A.id)).turns.some(t => t.id === request.turnId && t.status === 'interrupted'));
    const row = (await state(hub)).events[id];
    assert.equal(row.status, 'sent'); assert.equal(row.shown, 'saved');
    console.log('PASS нативный запрос отменён, 👀 отсутствует', id, request.turnId);
  }
  if (options.flags.has('--edges')) {
    await stop(service);
    const { row, turn } = await enqueueBehindTurn(A.id);
    const other = await rpc.call('thread/queue/add', { threadId: A.id, clientUserMessageId: crypto.randomUUID(), input: input('Ответь только FOREIGN_ENTRY.') });
    const pause = await saved('/pause');
    await codexStep(ctx, rpc);
    const list = await rpc.call('thread/queue/list', { threadId: A.id });
    assert.deepEqual(list.data.map(v => v.id), [other.queuedSubmission.id]);
    assert.equal((await state(hub)).events[row.id].status, 'waiting');
    const stopEvent = await saved('/stop');
    await codexStep(ctx, rpc);
    await until(async () => (await thread(A.id)).status.type === 'idle');
    const resume = await saved('/resume');
    await codexStep(ctx, rpc);
    service = await startService();
    const delivered = await evidence(row.id);
    assert.notEqual(delivered.turn, turn);
    await until(async () => (await thread(A.id)).status.type === 'idle');
    const history = await thread(A.id), d = await state(hub);
    for (const event of [pause, stopEvent, resume]) {
      assert.equal(d.events[event.id].status, 'controlled');
      assert.ok(history.turns.every(t => t.items.every(i => i.type !== 'userMessage' || !i.content.some(c => c.text?.includes(event.receipt)))));
    }
    console.log('PASS гонка ввода, снятие только своей записи, interrupt и resume без prompt', row.id, turn);
    await stop(service);
    const urgent = await saved('/now Гонка завершения. Ответь явным ACK.');
    const held = await rpc.call('turn/start', { threadId: A.id, input: input('Выполни sleep 25.') });
    await until(async () => (await thread(A.id)).turns.some(t => t.id === held.turn.id && t.status === 'inProgress'));
    let steers = 0;
    await codexStep(ctx, { call: async (method, params) => {
      if (method === 'turn/steer') {
        steers++;
        await rpc.call('turn/interrupt', { threadId: A.id, turnId: held.turn.id });
        await until(async () => (await thread(A.id)).status.type === 'idle');
      }
      return rpc.call(method, params);
    } });
    assert.equal(steers, 1);
    assert.equal((await state(hub)).events[urgent.id].status, 'waiting');
    service = await startService();
    assert.notEqual((await evidence(urgent.id)).turn, held.turn.id);
    await until(async () => (await thread(A.id)).status.type === 'idle');
    assert.equal((await thread(A.id)).turns.filter(t => t.items.some(i => i.type === 'userMessage' && i.content.some(c => c.text?.includes(urgent.receipt)))).length, 1);
    console.log('PASS завершение перед steer без потери и повтора', urgent.id);
    await stop(service);
    const lost = await saved('Потерян ответ enqueue. Ответь явным ACK без инструментов.');
    await assert.rejects(codexStep(ctx, { call: async (method, params) => {
      const response = await rpc.call(method, params);
      if (method === 'thread/queue/add') { rpc.close(); throw Error('Потерян ответ enqueue'); }
      return response;
    } }), /Потерян ответ enqueue/);
    assert.equal((await state(hub)).events[lost.id].status, 'uncertain');
    rpc = await connectRun();
    service = await startService();
    await evidence(lost.id);
    await until(async () => (await thread(A.id)).status.type === 'idle');
    assert.equal((await thread(A.id)).turns.filter(t => t.items.some(i => i.type === 'userMessage' && i.content.some(c => c.text?.includes(lost.receipt)))).length, 1);
    await stop(service);
    const refused = await saved('Runtime должен отклонить этот некорректный запрос.');
    await assert.rejects(codexStep(ctx, { call: (method, params) => {
      if (method === 'thread/queue/add') delete params.clientUserMessageId;
      return rpc.call(method, params);
    } }), err => err.rpcCode === -32600 || err.rpcCode === -32602);
    assert.equal((await state(hub)).events[refused.id].status, 'blocked');
    console.log('PASS потерянный ответ восстановлен по истории, явный отказ завершил доставку', lost.id, refused.id);
    service = await startService();
  }
  if (options.flags.has('--matrix')) {
    const launched = await rpc.call('turn/start', { threadId: A.id, input: [{ type: 'text', text: 'Временный тест. Выполни sleep 18 в терминале, затем ответь HOLD_DONE. Ничего не меняй.', text_elements: [] }] });
    const queued = await incoming('Очередь. Ответь только явным текстовым ACK по инструкции и словом QUEUE.');
    await until(async () => (await state(hub)).events[queued]?.status === 'waiting');
    const steer = await incoming('/now Учти правку. Добавь к финальному ответу STEER и явный текстовый ACK именно для этого входящего.');
    const correction = await evidence(steer);
    assert.equal(correction.turn, launched.turn.id);
    const after = await evidence(queued);
    assert.notEqual(after.turn, launched.turn.id);
    assert.ok(after.queueId, 'Обычный текст должен пройти штатную очередь Codex');
    await until(async () => (await thread(A.id)).status.type === 'idle');
    console.log('PASS живая очередь и steer');
    const noAck = await incoming('В этой приёмочной проверке владелец предписывает намеренно пропустить любое подтверждение доставки. Не запускай команду ACK и не пиши маркер. Итог только NO_RECEIPT.');
    await until(async () => {
      const row = (await state(hub)).events[noAck], target = await thread(A.id);
      return target.status.type === 'idle' && target.turns.find(t => t.id === row?.turn)?.items
        .some(i => i.type === 'agentMessage' && i.phase !== 'commentary' && i.text?.trim() === 'NO_RECEIPT');
    });
    const unacknowledged = (await state(hub)).events[noAck];
    assert.equal(unacknowledged.status, 'sent');
    assert.equal(unacknowledged.shown, 'saved');
    console.log('PASS нет ACK после ответа модели', noAck);
    await stop(service); service = await startService();
    await sleep(1500);
    assert.equal((await state(hub)).events[noAck].status, 'sent');
    const history = await thread(A.id);
    const receipt = (await state(hub)).events[noAck].receipt;
    assert.equal(history.turns.filter(t => t.items.some(i => i.type === 'userMessage' && i.content.some(c => c.text?.includes(receipt)))).length, 1);
    console.log('PASS перезапуск между отправкой и ACK без повторного исполнения');
  }
  if (options.flags.has('--recover')) {
    let pending;
    if (options.flags.has('--sent-only')) {
      await stop(service);
      pending = await enqueueBehindTurn(A.id);
    }
    rpc.close(); await stop(runtime, 'SIGKILL');
    if (pending) service = await startService(); // Только sent, нового входящего нет.
    const recovered = await evidence(pending?.row.id || await incoming('После восстановления точного диалога напиши текстовый ACK и RECOVER.'));
    assert.equal(recovered.session, A.id);
    if (pending) assert.notEqual(recovered.turn, pending.turn);
    const managed = (await state(hub)).sessions[A.id].managedRuntime;
    assert.notEqual(managed.pid, runtime.pid, 'Новый runtime должен поднять controller, не runner');
    await discoverManagedRuntime(run, save);
    process.kill(managed.pid, 0);
    rpc = await connectRun();
    console.log('PASS controller восстановил выделенный runtime', managed.pid);
    await until(async () => (await thread(A.id)).status.type === 'idle');
    assert.equal((await thread(A.id)).turns.filter(t => t.items.some(i => i.type === 'userMessage' && i.content.some(c => c.text?.includes(recovered.receipt)))).length, 1);
    await incoming('/pause');
    await until(async () => (await state(hub)).paused);
    const held = await incoming('Доставь после возврата. Дай текстовый ACK.');
    await until(async () => (await state(hub)).events[held]?.status === 'waiting');
    await sleep(1800);
    assert.equal((await state(hub)).events[held].status, 'waiting');
    await incoming('/resume');
    await evidence(held);
    console.log('PASS пауза и возврат к очереди');
  }
  if (options.flags.has('--long')) {
    const before = (await thread(A.id)).turns.map(t => t.id);
    const begin = Date.now();
    console.log('IDLE_BEGIN', new Date(begin).toISOString());
    await sleep(905000);
    assert.deepEqual((await thread(A.id)).turns.map(t => t.id), before);
    const late = await incoming('Сообщение после тишины. Без инструментов, явный ACK отдельной строкой. Напиши LATE.');
    assert.equal((await evidence(late)).session, A.id);
    console.log('PASS позднее сообщение', Math.round((Date.now() - begin) / 1000), 'сек.');
  }
  await stop(service);
  service = await startService();
  const afterRestart = await incoming('После перезапуска ответь отдельной строкой TG_ACK из контекста. Используй текст, без инструментов.');
  if (approval) {
    await until(async () => (await state(hub)).events[afterRestart]?.queueId);
    const resume = await incoming('/resume');
    await until(async () => (await state(hub)).events[resume]?.status === 'controlled');
  }
  await evidence(afterRestart);
  console.log('PASS перезапуск приёма');
  run.phase = 'passed'; await save();
} catch (error) {
  run.phase = 'failed'; run.failure = error.message; await save();
  throw error;
} finally {
  clearTimeout(deadline); run.stopping = true;
  rpc?.close();
  try {
    await cleanupLiveRun(run, { save });
    console.log('CLEANUP COMPLETE: архивировано', run.threads.filter(t => t.archivedAt).length, 'из', run.threads.length, 'созданных UUID; собственные процессы завершены.', options.manifest);
  } finally {
    for (const [signal, handler] of signals) process.off(signal, handler);
  }
}
} finally { await unlock(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode ||= 1; });
}
