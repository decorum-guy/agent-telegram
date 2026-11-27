// Проверки договорённостей и ссылок публичных инструкций; скан возможных секретов. Без сети.
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
let fails=0;
const check=(name,ok,extra='')=>{if(!ok)fails++;console.log(`${ok?'PASS':'FAIL'}  ${name}${!ok&&extra?' ['+extra+']':''}`);};
const read=file=>readFile(resolve(ROOT,file),'utf8');
const prompt=await read('PROMPT.md'),agent=await read('AGENT.md'),readme=await read('README.md'),skill=await read('skills/agent-telegram/SKILL.md');
const blocks=[...prompt.matchAll(/^```text\r?\n([\s\S]*?)^```/gm)];
check('короткий PROMPT содержит один переносимый блок',blocks.length===1&&blocks[0][1].includes('AGENT.md')&&blocks[0][1].includes('https://github.com/decorum-guy/agent-telegram'));
check('инструкции различают два режима и единый бот', [agent,readme,skill].every(t=>t.includes('single')&&t.includes('parallel')&&/одного|один|Один/.test(t)));
check('основные инструкции не требуют бота для каждого проекта',![agent,prompt,readme,skill].some(t=>/У каждого проекта свой Telegram|создать отдельного бота|у тебя свой бот и|у каждой свой бот/.test(t)));
check('в документации отделены имитации от живой доставки',readme.includes('--simulate')||readme.includes('имитац'));
check('skill использует установленный корень, не только фиксированный клон',skill.includes('по расположению этого файла')&&skill.includes('абсолютным путём'));
check('запрос представлен отдельным кратким описанием', (await read('docs/requests/2026-11-27-single-bot-plugin.md')).includes('Требования к первому выпуску'));
const files=[];
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){if(['.git','node_modules'].includes(e.name))continue;const p=resolve(dir,e.name);if(e.isDirectory())await walk(p);else if(e.isFile())files.push(p);}}
await walk(ROOT);
const broken=[],leaked=[],personal=[];
for(const file of files){
 const buf=await readFile(file);const text=buf.includes(0)?buf.toString('utf16le'):buf.toString('utf8');
 if(/\d{6,}:[A-Za-z0-9_-]{30,}/.test(text))leaked.push(relative(ROOT,file));
 if(file.endsWith('.md')&&(/\/(?:Users|home)\/[^/\\\s`"<>)]+/m.test(text)||/[A-Z]:\\Users\\[^\\\s`"<>]+/i.test(text)||/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(text)||/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)))personal.push(relative(ROOT,file));
 if(file.endsWith('.md'))for(const m of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)){
  const target=m[1].split('#')[0];if(!target||/^([a-z]+:|\/)/i.test(target)||target.includes('<'))continue;
  const path=resolve(dirname(file),target);if(!(await stat(path).catch(()=>null)))broken.push(relative(ROOT,file)+' → '+target);
 }
}
check('локальные Markdown-ссылки ведут к существующим файлам',broken.length===0,broken.join('; '));
check('в исходниках и документах нет похожих на настоящий Telegram-токен значений',leaked.length===0,leaked.join(', '));
check('публичные Markdown-файлы не содержат личных путей, адресов и идентификаторов диалогов',personal.length===0,personal.join(', '));
process.exitCode=fails?1:0;
