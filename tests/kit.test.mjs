// Регрессии публичных команд: реальные дочерние Node-процессы, вымышленные данные, fetch полностью подменён.
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = await mkdtemp(join(tmpdir(), 'agent-telegram-kit-v2-'));
const hub = join(TMP, 'hub'), repo = join(TMP, 'project with spaces'), calls = join(TMP, 'calls.jsonl');
const mock = join(TMP, 'mock-network.mjs');
let fails = 0;
const check = (name, ok, detail = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' [' + detail + ']' : ''}`); };
const put = async (path, data) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(data)); };
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const requests = async () => (await readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(JSON.parse);
const env = { ...process.env, TG_HUB: hub, TG_TEST_CALLS: calls };
for (const k of ['TG_PROJECT','TG_BOT_TOKEN','TG_CHAT_ID','CODEX_THREAD_ID','CLAUDE_CODE_SESSION_ID','TG_RECEIVER_PARENT']) delete env[k];
const run = (file, args, options = {}) => {
  const r = spawnSync(process.execPath, ['--import', mock, join(ROOT, file), ...args], {
    cwd: options.cwd || repo, env: { ...env, ...(options.env || {}) }, input: options.input,
    encoding: 'utf8', timeout: 15000,
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', error: r.error };
};
const all = r => r.out + r.err;
const clear = () => writeFile(calls, '');
try {
  await mkdir(repo, { recursive: true });
  await mkdir(join(hub, '.secrets'), { recursive: true });
  await writeFile(mock, `
import { appendFile } from 'node:fs/promises';
let n=810;
globalThis.fetch=async(url,options={})=>{
 const method=String(url).split('/').at(-1);
 if(process.env.TG_TEST_NETWORK_ERROR)throw Error('Never print '+String(url));
 const body=typeof options.body==='string'?JSON.parse(options.body):Object.fromEntries([...options.body.entries()].map(([k,v])=>[k,typeof v==='string'?v:'<synthetic file>']));
 await appendFile(process.env.TG_TEST_CALLS,JSON.stringify({method,body})+'\\n');
 if(!['sendMessage','sendDocument','sendPhoto','sendVideo','sendMediaGroup','editMessageText','setMessageReaction','answerCallbackQuery'].includes(method))throw Error('Unexpected API '+method);
 const result=method==='sendMediaGroup'?JSON.parse(body.media).map(()=>({message_id:++n})): {message_id:++n};
 return {ok:true,status:200,json:async()=>({ok:true,result})};
};`);
  for (const file of ['tg.mjs','tg-setup.mjs','tg-listen.mjs','tg-bridge.mjs']) {
    const r = run(file, ['--help']);
    check(file + ': справка доступна без настройки и обращения к сети', r.code === 0 && all(r).length > 30 && !(await requests()).length, all(r));
  }
  let r = run('tg-setup.mjs', ['--init','--project','demo-app']);
  check('init вне git требует явный --here', r.code === 1 && all(r).includes('--here'));
  r = run('tg-setup.mjs', ['--init','--here','--project','demo-app','--mode','single']);
  const portable = await json(join(repo,'.agent-telegram.json'));
  check('init создаёт переносимый проект, выводит хештег, не пишет секреты', r.code === 0 && portable.project === 'demo-app' && portable.tag === '#demo_app' && portable.mode === 'private' && !portable.owner_id && !portable.chat_id);
  const original = await readFile(join(repo,'.agent-telegram.json'),'utf8');
  r = run('tg-setup.mjs', ['--init','--here','--project','other-app']);
  check('init не перезаписывает чужой проект', r.code === 1 && original === await readFile(join(repo,'.agent-telegram.json'),'utf8'));
  r = run('tg-setup.mjs', ['--init','--here','--project','demo-app','--tag','#bad-tag']);
  check('init отклоняет хештег с дефисом', r.code === 1 && all(r).includes('без дефиса'));
  r = run('tg-setup.mjs', ['--init','--here','--project','demo-app','--mode','single']);
  check('повтор init идемпотентен', r.code === 0 && original === await readFile(join(repo,'.agent-telegram.json'),'utf8'));
  r = run('tg-setup.mjs', ['--init','--here','--project','demo-app'], {cwd:homedir()});
  check('init отказывается от домашней папки без записи', r.code === 1 && all(r).includes('домашняя папка'));
  const broken = join(TMP,'broken'), outer=join(TMP,'outer'), child=join(outer,'repo');
  await mkdir(broken); await writeFile(join(broken,'.agent-telegram.json'),'{oops');
  r = run('tg-setup.mjs',['--check'],{cwd:broken});
  check('повреждённая конфигурация не заменяется новой',r.code===1 && await readFile(join(broken,'.agent-telegram.json'),'utf8')==='{oops');
  await mkdir(join(child,'src'),{recursive:true}); await mkdir(join(child,'.git')); await put(join(outer,'.agent-telegram.json'),{project:'other-app',tag:'#other_app'});
  r=run('tg-setup.mjs',['--check'],{cwd:join(child,'src')});
  check('поиск проекта не переходит через git-корень к чужой конфигурации',r.code===1&&all(r).includes('не найден'));

  const inbox=join(hub,'inbox','demo-app'); await mkdir(inbox,{recursive:true});
  const registry={version:2,mode:'single',default:'demo-app',projects:{'demo-app':{tag:'#demo_app',title:'Demo',mode:'private',inbox,privateChat:{chat_id:'111',bot_id:'1'}}}};
  await put(join(hub,'projects.json'),registry); await writeFile(join(hub,'.secrets/telegram.env'),'TG_BOT_TOKEN=1:sandbox\nTG_CHAT_ID=111\n');
  const literal='Кириллица: $HOME $(not_a_command) `не команда` "кавычки"\nВторая строка.';
  r=run('tg.mjs',['-'],{input:literal});let sent=await requests();
  check('stdin сохраняет кириллицу и буквальные shell-символы без исполнения',r.code===0&&sent[0]?.body.text.includes(literal),all(r));
  check('single отправляет без thread_id и автоматически добавляет хештег',sent[0]?.body.chat_id==='111'&&!('message_thread_id' in sent[0].body)&&sent[0].body.text.startsWith('#demo_app'));
  const sentLog=(await readFile(join(inbox,'sent.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  check('успешная отправка записана с chat_id, но без токена',sentLog[0]?.chat_id==='111'&&!JSON.stringify(sentLog).includes('sandbox'));
  await clear();r=run('tg.mjs',['--dry-run','Проверка']);
  check('dry-run не вызывает API',r.code===0&&!(await requests()).length&&r.out.includes('#demo_app'));
  const textFile=join(TMP,'utf8.txt');await writeFile(textFile,'\ufeffТекст UTF-8 с BOM');
  r=run('tg.mjs',['--text-file',textFile]);sent=await requests();
  check('text-file UTF-8 снимает BOM и сохраняет русский текст',r.code===0&&sent[0]?.body.text.includes('Текст UTF-8 с BOM')&&!sent[0].body.text.includes('\ufeff'));
  await clear();r=run('tg.mjs',['-'],{input:'Длинный текст '.repeat(1000)});sent=await requests();
  check('длинный отчёт разбит на сообщения с хештегом и допустимой длиной',r.code===0&&sent.length>2&&sent.every(c=>c.body.text.startsWith('#demo_app')&&c.body.text.length<=4096));
  await clear();r=run('tg.mjs',['--question','--option','Да','--option','Нет','Продолжить?']);sent=await requests();
  check('вопрос с вариантами сохраняет существующие inline-кнопки',r.code===0&&sent[0]?.body.reply_markup.inline_keyboard.flat().map(v=>v.text).join(',')==='Да,Нет');
  await clear();r=run('tg.mjs',['--question','--option','Да','--option','Да','Неверно']);
  check('повторные варианты вопроса отклоняются до API',r.code===1&&!(await requests()).length);
  r=run('tg.mjs',['--unknown','text']);check('неизвестный параметр отправки не игнорируется',r.code===1&&!(await requests()).length);
  r=run('tg.mjs',[]);check('пустая отправка отклоняется',r.code===1&&!(await requests()).length);
  const attachment=join(TMP,'note.txt');await writeFile(attachment,'synthetic attachment');
  r=run('tg.mjs',['--file',attachment,'--caption','Вложение']);sent=await requests();
  check('вложение отправляется в личку с хештегом и без темы',r.code===0&&sent.some(c=>c.method==='sendDocument'&&c.body.chat_id==='111'&&!('message_thread_id'in c.body)&&c.body.caption.startsWith('#demo_app')));
  await clear();r=run('tg.mjs',['--file',join(TMP,'missing.txt')]);check('отсутствующий файл не создаёт отправку',r.code===1&&!(await requests()).length);
  const updates=join(TMP,'inbound.json');await put(updates,[{update_id:1,message:{message_id:22,date:1800000000,from:{id:111,is_bot:false},chat:{id:111,type:'private'},text:'Ответ владельца'}}]);
  r=run('tg-listen.mjs',['--drain','--no-ack','--simulate',updates]);check('входящее сохраняется для корректного ответа в ветку',r.code===0&&r.out.includes('Ответ владельца'),all(r));
  await clear();r=run('tg.mjs',['--reply-to','22','Принято']);sent=await requests();
  check('ответ адресует исходное сообщение в том же личном чате',r.code===0&&sent[0]?.body.reply_parameters?.message_id===22&&sent[0].body.chat_id==='111');
  await writeFile(join(inbox,'sent.jsonl'),JSON.stringify({message_id:33,chat_id:'-100777',thread:8})+'\n',{flag:'a'});
  await clear();r=run('tg.mjs',['--reply-to','33','Отчёт']);sent=await requests();
  check('старый групповой номер не используется для цитирования в личке',r.code===0&&sent[0]?.body.chat_id==='111'&&!sent[0].body.reply_parameters);
  await clear();r=run('tg.mjs',['Тест ошибки'],{env:{TG_TEST_NETWORK_ERROR:'1'}});
  check('сетевая ошибка не раскрывает токен из URL',r.code===1&&!all(r).includes('1:sandbox')&&!all(r).includes('bot1:')&&!(await requests()).length);
  await writeFile(join(hub,'.secrets/telegram.env'),'TG_BOT_TOKEN=2:changed\nTG_CHAT_ID=111\n');
  r=run('tg.mjs',['Другой бот']);check('сменённый бот не использует старую проверку лички',r.code===1&&!(await requests()).length);
  await writeFile(join(hub,'.secrets/telegram.env'),'TG_BOT_TOKEN=1:sandbox\nTG_CHAT_ID=111\n');
  const parallel=structuredClone(registry);parallel.mode='parallel';parallel.projects['demo-app'].mode='topic';parallel.projects['demo-app'].topic=8;parallel.group={chat_id:'-100777',forum:true,title:'Projects',topics:{8:'Demo'}};
  await put(join(hub,'projects.json'),parallel);
  await put(join(repo,'.agent-telegram.json'),{...portable,mode:'topic',topic:8});
  await clear();r=run('tg.mjs',['Отчёт темы']);sent=await requests();
  check('parallel отправляет в закреплённую тему группы',r.code===0&&sent[0]?.body.chat_id==='-100777'&&sent[0].body.message_thread_id===8);
  await clear();r=run('tg.mjs',['--dm','Скрытая личка']);check('parallel не допускает обход маршрута через --dm',r.code===1&&!(await requests()).length,all(r));
  delete parallel.projects['demo-app'].topic;await put(join(hub,'projects.json'),parallel);
  r=run('tg.mjs',['Без темы']);check('parallel без темы останавливается без отправки в личку',r.code===1&&!(await requests()).length);
  check('временные данные записаны только в тестовую установку', (await stat(join(hub,'projects.json'))).isFile());
} finally {await rm(TMP,{recursive:true,force:true});}
process.exitCode=fails?1:0;
