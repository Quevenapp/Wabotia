import makeWASocket,{useMultiFileAuthState,downloadMediaMessage,DisconnectReason,normalizeMessageContent} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,writeFile,readFile,unlink} from 'node:fs/promises';
import path from 'node:path';
const base=new URL(process.env.WABOTIA_URL||'');
if(base.protocol!=='https:'||!process.env.WABOTIA_CONNECTION_ID||!process.env.WABOTIA_CONNECTOR_TOKEN)throw Error('Preencha a URL HTTPS, ID e chave do conector no .env.');
const root=path.resolve(process.env.WABOTIA_DATA||'./data');await mkdir(root,{recursive:true,mode:0o700});
const lock=path.join(root,'process.lock');
try{await writeFile(lock,String(process.pid),{flag:'wx',mode:0o600})}catch{const pid=Number(await readFile(lock,'utf8'));let running=true;try{process.kill(pid,0)}catch{running=false}if(running)throw Error('Já existe um conector utilizando estes dados.');await unlink(lock);await writeFile(lock,String(process.pid),{flag:'wx',mode:0o600})}
const db=new DatabaseSync(path.join(root,'journal.sqlite'));
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS incoming(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending'); CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,status TEXT NOT NULL,external_id TEXT,error TEXT,reported INTEGER DEFAULT 0);");
db.prepare("UPDATE commands SET status='unknown',error='Processo interrompido durante envio' WHERE status='sending'").run();
const prefix=`${base.origin}/internal/v1/connectors/${encodeURIComponent(process.env.WABOTIA_CONNECTION_ID)}`;
async function api(route,body,method=body===undefined?'GET':'POST'){
 const r=await fetch(prefix+route,{method,headers:{Authorization:'Bearer '+process.env.WABOTIA_CONNECTOR_TOKEN,...(body instanceof FormData?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw Error('Wabotia HTTP '+r.status);return r;
}
const logger=pino({level:'silent'});let socket,online=false,stopped=false,lastHeartbeat=0;
async function connect(){
 const {state,saveCreds}=await useMultiFileAuthState(path.join(root,'session'));
 socket=makeWASocket({auth:state,logger,markOnlineOnConnect:false,syncFullHistory:false});
 socket.ev.on('creds.update',saveCreds);
 socket.ev.on('connection.update',async update=>{
  try{
   if(update.qr){console.log('QR disponível em Conexões no painel Wabotia.');await api('/status',{state:'awaiting_qr',qr:await QRCode.toDataURL(update.qr,{width:300})})}
   if(update.connection==='open'){online=true;console.log('WhatsApp conectado.');await api('/status',{state:'connected',qr:null})}
   if(update.connection==='close'){online=false;if(update.lastDisconnect?.error?.output?.statusCode===DisconnectReason.loggedOut){console.error('Sessão desconectada no WhatsApp. Preserve o diário; renomeie apenas a pasta session para parear novamente.');stopped=true}else if(!stopped)setTimeout(()=>connect().catch(()=>console.error('Falha ao reconectar')),5000)}
  }catch{console.error('Não foi possível atualizar estado no Wabotia.')}
 });
 socket.ev.on('messages.upsert',async ({messages})=>{for(const m of messages){
  try{
   if(m.key.fromMe||!m.key.id||!m.message||m.key.remoteJid?.endsWith('@g.us')||m.key.remoteJid==='status@broadcast')continue;
   const dest=m.key.remoteJidAlt||m.key.remoteJid,id=dest+':'+m.key.id;
   if(db.prepare('SELECT id FROM incoming WHERE id=?').get(id))continue;
   const content=normalizeMessageContent(m.message),media=content.imageMessage||content.audioMessage||content.videoMessage||content.documentMessage;
   const payload={external_id:dest,phone:dest.split('@')[0],message_id:m.key.id,text:content.conversation||content.extendedTextMessage?.text||media?.caption||'',attachments:[]};
   if(media){
    if(Number(media.fileLength||0)>20*1024*1024)payload.text+='\n[Anexo maior que 20 MB. Necessita revisão humana.]';
    else {const bytes=await downloadMediaMessage(m,'buffer',{}, {logger,reuploadRequest:socket.updateMediaMessage});if(bytes.length>20*1024*1024)throw Error('Arquivo grande');const name=Buffer.from(id).toString('hex');await writeFile(path.join(root,name),bytes,{mode:0o600});payload.local_media={path:name,name:media.fileName||'anexo',type:media.mimetype||'application/octet-stream'}}
   }
   db.prepare('INSERT OR IGNORE INTO incoming(id,payload) VALUES(?,?)').run(id,JSON.stringify(payload));
  }catch{console.error('Falha ao registrar entrada; confira o diário local antes de reiniciar.');}
 }});
}
async function tick(){
 for(const row of db.prepare("SELECT * FROM incoming WHERE status='pending' ORDER BY rowid LIMIT 10").all()){
  const payload=JSON.parse(row.payload);
  if(payload.local_media&&!payload.attachments.length){const m=payload.local_media,form=new FormData();form.set('file',new Blob([await readFile(path.join(root,m.path))],{type:m.type}),m.name);payload.attachments=[(await (await api('/media',form)).json()).id];db.prepare('UPDATE incoming SET payload=? WHERE id=?').run(JSON.stringify(payload),row.id)}
  await api('/events',payload);db.prepare("UPDATE incoming SET status='done' WHERE id=?").run(row.id);
  if(payload.local_media)await unlink(path.join(root,payload.local_media.path)).catch(()=>{});
 }
 if(!online)return;
 if(Date.now()-lastHeartbeat>30000){await api('/status',{state:'connected',qr:null});lastHeartbeat=Date.now()}
 const {commands}=await (await api('/commands')).json();
 for(const cmd of commands){
  const old=db.prepare('SELECT * FROM commands WHERE id=?').get(cmd.id);
  if(old){await api('/receipts',old);continue}
  const check=await (await api(`/commands/${cmd.id}/check`,{})).json();if(!check.valid)continue;
  db.prepare("INSERT INTO commands(id,status) VALUES(?,'sending')").run(cmd.id);
  try{
   let content={text:cmd.payload.text};
   if(cmd.payload.media_id){const r=await api('/media/'+encodeURIComponent(cmd.payload.media_id));content={document:Buffer.from(await r.arrayBuffer()),mimetype:r.headers.get('Content-Type'),fileName:decodeURIComponent(r.headers.get('X-Filename')||'anexo')}}
   // A second check follows downloads, immediately before transport accepts a send.
   if(!(await (await api(`/commands/${cmd.id}/check`,{})).json()).valid){db.prepare("UPDATE commands SET status='cancelled' WHERE id=?").run(cmd.id);continue}
   const sent=await socket.sendMessage(cmd.destination,content);if(!sent?.key?.id)throw Error('Sem recibo');
   db.prepare("UPDATE commands SET status='sent',external_id=? WHERE id=?").run(sent.key.id,cmd.id);
  }catch{db.prepare("UPDATE commands SET status='unknown',error='Envio sem confirmação; confira no WhatsApp antes de reconciliar' WHERE id=?").run(cmd.id)}
  await api('/receipts',db.prepare('SELECT * FROM commands WHERE id=?').get(cmd.id));
 }
 // Deliver positive receipts lost after the provider confirmed the message.
 for(const row of db.prepare("SELECT * FROM commands WHERE status IN ('sent','unknown') AND reported=0 LIMIT 20").all()){
  await api('/receipts',row);db.prepare("UPDATE commands SET reported=1 WHERE id=?").run(row.id);
 }
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{stopped=true;online=false;socket?.end(undefined);db.close();await unlink(lock).catch(()=>{});process.exit(0)});
await connect();
while(!stopped){try{await tick()}catch{console.error('Conexão indisponível. Diário preservado; tentando novamente em 3 segundos.')}await new Promise(r=>setTimeout(r,3000))}
