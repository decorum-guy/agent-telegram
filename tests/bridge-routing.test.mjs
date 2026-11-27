// Прямой контракт доверенного маршрутизатора -> мост; никакой сети/модельных вызовов.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { state, ingest } from '../tg-bridge.mjs';
const dir=await mkdtemp(join(tmpdir(),'agent-telegram-route-'));
let fails=0,id=0;
const check=(name,ok)=>{if(!ok)fails++;console.log(`${ok?'PASS':'FAIL'}  ${name}`);};
try{
 await state(dir,d=>{d.active='synthetic-session';d.sessions[d.active]={project:'alpha',bot:'86423',chat:'-100777',topic:8};});
 const event=async(overrides={},message={})=>ingest(dir,overrides.bot||'86423',{
  project:'alpha',why:'tag',update_id:++id,...overrides,
  message:{message_id:id,date:1800000000,from:{id:111},chat:{id:-100777,type:'supergroup'},text:'#alpha правка из общей темы',...message}
 });
 let e=await event();check('явный проверенный хештег из General направляется правильному мосту',e.status==='waiting'&&e.session==='synthetic-session'&&e.topic===null);
 e=await event({project:'beta'});check('указатель другого проекта не проходит межтемную проверку',e.status==='blocked');
 e=await event({project:undefined});check('отсутствие подтверждённого проектного маршрута не ослабляет проверку',e.status==='blocked');
 e=await event({bot:'86424'});check('хештег не разрешает другого бота',e.status==='blocked');
 e=await event({}, {chat:{id:-100888,type:'supergroup'}});check('хештег не разрешает другую группу',e.status==='blocked');
 e=await event({}, {message_thread_id:9,is_topic_message:true});check('другая именованная тема не становится General',e.status==='blocked');
 e=await event({why:'default'});check('обычный неадресованный текст General не получает разрешение тега',e.status==='blocked');
 e=await event({why:'topic'}, {message_thread_id:8,is_topic_message:true,text:'своя тема'});check('обычный текст своей темы сохраняет рабочее поведение',e.status==='waiting');
}finally{await rm(dir,{recursive:true,force:true});}
process.exitCode=fails?1:0;
