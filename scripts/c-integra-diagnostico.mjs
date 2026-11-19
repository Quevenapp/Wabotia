// Diagnóstico offline com SQLite local. Não substitui o Worker/D1/Vitest.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';

globalThis.fetch = async () => { throw Error('Rede proibida no diagnóstico'); };
const generated = new URL('./.c-integra-diagnostico.generated.mjs', import.meta.url);
const bundle = await build({ stdin: { contents: `
export * from './src/db';
export * from './src/service';
export * from './src/engine';
export * from './src/customer/history';
export * from './src/customer/identity';
export * from './src/customer/ports';
export * from './src/customer/http';
export * from './src/customer/sync';
export * from './src/customer/erp-bridge';
export * from './src/queue';
export * from './src/types';
export * from './src/modules/api';
export * from './src/modules/os/store';
export * from './src/modules/os/public';
export * from './src/modules/os/reminders';
export * from './src/modules/os/tasks/reminders';
export * from './src/modules/schedule';
export * from './src/security';
export { canOpenPage, accessAllows } from './web/workspace-navigation';
export { MANAGEMENT_ITEMS, managementContext, nativeTargetState, resolveManagement } from './web/management/registry';
export { nativeReadAllows } from './web/management/native-access';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'offline-workers', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'offline' }));
    b.onLoad({ filter: /.*/, namespace: 'offline' }, () => ({ contents: 'export const DurableObject = Object; export const env = {}; export const exports = {};' }));
  } }], logLevel: 'silent' });
await writeFile(generated, bundle.outputFiles[0].contents);
try {
  const api = await import(generated.href);
  const sqlite = new DatabaseSync(':memory:');
  for (const name of (await readdir('migrations')).filter(n => n.endsWith('.sql')).sort())
    sqlite.exec(await readFile(`migrations/${name}`, 'utf8'));
  const count = { statements: 0, sql: [] };
  const clean = value => JSON.parse(JSON.stringify(value));
  const DB = {
    prepare(sql) {
      let args = [];
      const execute = () => {
        count.statements++; count.sql.push(sql);
        const stmt = sqlite.prepare(sql);
        const results = stmt.all(...args);
        const meta = sqlite.prepare('SELECT changes() changes,last_insert_rowid() last_row_id').get();
        return { results: clean(results), success: true, meta: clean(meta) };
      };
      return { bind(...values) { args = values; return this; },
        async first() { return execute().results[0] ?? null; },
        async all() { return execute(); }, async run() { return execute(); },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const result = []; for (const stmt of statements) result.push(await stmt.all()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const objects = new Map();
  const env = { DB, MASTER_KEY: 'test-master-key-00000000000000000000', MEDIA: {
    async get(key) { const text = objects.get(key); return text === undefined ? null : { async json() { return JSON.parse(text); }, async text() { return text; } }; },
    async put(key, value) { objects.set(key, value); },
  } };
  const { exec, one, all, batch, now, uid, defaults } = api;
  let cases = 0;
  const check = async (name, run) => { try { await run(); cases++; console.log('OK', name); } catch (error) { console.error('FALHOU', name, error); process.exitCode = 1; } };
  const fixture = async () => {
    const profile = uid(), line = uid(), second = uid();
    await exec(env, 'INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,?,?,1,?)', profile, 'Diagnóstico', JSON.stringify(defaults), now());
    for (const [i, id] of [line, second].entries()) await exec(env, "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'zernio','direct','active','{}',?)", id, profile, id, now() + i);
    const actor = { id: uid(), name: 'Pessoa', kind: 'user', role: 'admin', profiles: [profile], scopes: [], bots: [], rate: 100, runLimit: 10 };
    await exec(env, 'INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,?,?,?,?,?)', actor.id, actor.id+'@example.test', actor.name, 'test', 'admin', JSON.stringify([profile]), now());
    return { profile, line, second, actor };
  };
  const receive = async (f, text = 'oi', phone = '5511999998888', line = f.line) => {
    const result = await api.inbound(env, f.profile, { external_id: phone, phone, message_id: uid(), text }, `channel:${line}`, line);
    return api.conversation(env, result.conversation_id, f.profile);
  };
  const contact = async (f, phone = '', source = 'automatic') => {
    const id = uid(); await exec(env, "INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'team','Ana',?,'',?,'test','test',?,?)", id, f.profile, phone, source, now()-20000, now()-20000); return id;
  };
  await check('rotas publicadas de extensão', async () => {
    for (const page of ['ensino','juridico']) {
      assert.equal(api.canOpenPage(page, 'admin', undefined, null), false);
      assert.equal(api.canOpenPage(page, 'admin', { [page]: true }, null), true);
    }
  });
  await check('casa exige papéis privados mesmo com navegação legada', async () => {
    for (const role of ['admin','agent']) for (const access of [null,[],['*'],['ensino'],['ensino:secretaria'],['ensino:professor'],['juridico'],['os:sensitive'],['juridico:lawyer'],['juridico:curator'],['os:sensitive','juridico:lawyer'],['os:sensitive','juridico:curator']]) {
      const c=api.managementContext({statusLoaded:true,role,access,modules:{ensino:true,juridico:true}});
      for (const page of ['ensino','juridico']) {
        const allowed=page==='ensino' ? !!access?.some(p=>['ensino:secretaria','ensino:professor'].includes(p))
          : !!access?.includes('os:sensitive') && access.some(p=>['juridico:lawyer','juridico:curator'].includes(p));
        assert.equal(api.canOpenPage(page,role,c.modules,access),role==='admin'||!access||allowed);
        assert.equal(api.resolveManagement(api.MANAGEMENT_ITEMS,c).some(item=>item.module===page),allowed,`${page}/${role}/${JSON.stringify(access)}`);
        assert.equal(api.nativeTargetState(page,c),allowed?'allowed':'denied');
        assert.equal(api.nativeTargetState(page,{...c,statusLoaded:false}),'loading');
      }
      assert.equal(api.nativeReadAllows('juridico.deadlines',access),!!access?.includes('os:sensitive')&&access.includes('juridico:lawyer'));
    }
  });
  await check('ambiguidade mantém pendência; restrição e exclusão encerram a pendência', async () => {
    for (const state of ['blocked','excluded','ambiguous']) for (const explicit of [true,false]) {
      const f=await fixture(),c=await receive(f),ref=await api.resolveCustomer(env,c);
      if (explicit) await exec(env,"INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'test',?) ON CONFLICT DO NOTHING",c.id,f.profile,ref.contactId,now());
      else await exec(env,'DELETE FROM conversation_contacts WHERE conversation_id=?',c.id);
      await exec(env,'UPDATE conversations SET customer_link_state=? WHERE id=?',state,c.id);
      const history=()=>api.customerHistory.read(env,f.actor,f.profile,{conversationId:c.id},{});
      assert.deepEqual(await history(),{items:[],nextCursor:null,incomplete:state==='ambiguous'},`${state}/${explicit}`);
      await exec(env,"UPDATE contacts SET identity_state='erasing' WHERE id=?",ref.contactId);
      assert.deepEqual(await history(),{items:[],nextCursor:null,incomplete:false});
    }
  });
  await check('histórico de mensagem real e veto à restrição', async () => {
    const f = await fixture(), c = await receive(f, 'Texto público');
    const history = await api.customerTextHistory(env, c);
    assert(history.some(m => m.text === 'Texto público'));
    const ref = await api.resolveCustomer(env, c);
    await exec(env, "UPDATE contacts SET identity_state='restricted' WHERE id=?", ref.contactId);
    assert.deepEqual(await api.customerTextHistory(env, c), []);
  });
  await check('sessões antigas, filtro privado e troca de titular', async () => {
    const f = await fixture(), a = await contact(f), b = await contact(f), cid = uid(), session = uid(), at = now()-10000;
    await exec(env, "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,verified_phone,customer_link_state,session,last_customer,created,updated) VALUES(?,?,?,?,?,'5511999990001','5511999990001','ready',?,?,?,?)", cid, f.profile, f.line, `channel:${f.line}`, cid, session, at, at, at);
    await exec(env, "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'test',?)", cid, f.profile, a, at-1);
    for (const [module, kind, time] of [['core','conversation',at-100],['conversations','session',at]]) await exec(env, "INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at) VALUES(?,?,?,?,?,?,'test',?)", f.profile,module,kind,`${cid}:${session}`,a,cid,time);
    for (let i=0;i<17;i++) await exec(env, "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,content,created) VALUES(?,?,?,'in','test',?,?,?)", uid(),f.profile,cid,i ? 'SEGREDO' : 'Texto permitido',JSON.stringify({customerSession:session,...(i ? {metadata:{module_id:'forms'}} : {})}),at+i);
    assert.deepEqual(await api.customerTextHistory(env,{id:cid,profile_id:f.profile}),[{direction:'in',text:'Texto permitido'}]);
    const history=await api.customerHistory.read(env,f.actor,f.profile,{conversationId:cid},{});
    assert.equal(history.items.length,1); assert.equal(history.items[0].occurredAt,at-100);
    await exec(env,'UPDATE conversation_contacts SET contact_id=? WHERE conversation_id=?',b,cid);
    assert.deepEqual(await api.customerTextHistory(env,{id:cid,profile_id:f.profile}),[]);
  });
  await check('contato explícito panel conserva API publicada', async () => {
    const f=await fixture(), c=await receive(f), ctx=api.modulesApi(env,f.profile,'forms');
    assert.equal(await ctx.contact(c),null);
    const id=uid(); await exec(env,"INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'panel','Ana','5511999998888','','panel','test','test',1,1)",id,f.profile);
    await exec(env,"INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'test',?)",c.id,f.profile,id,now());
    assert.equal((await ctx.contact(c.id))?.id,id);
    assert.notEqual((await ctx.customer(c)).contactId,id);
    const unrelated=await receive(f,'oi','5511990000000');
    assert.equal(await ctx.contact(unrelated),null);
    await exec(env,"UPDATE contacts SET namespace='app:outra' WHERE id=?",id);
    assert.equal(await ctx.contact(c),null);
    await exec(env,"UPDATE contacts SET namespace='panel',identity_state='restricted' WHERE id=?",id);
    assert.equal(await ctx.contact(c),null);
  });
  await check('M10: prova de duas linhas, consulta única e troca persistida de titular', async () => {
    const f=await fixture(),id=await contact(f,'5511987654321','manual'),queue=uid();
    await exec(env,"UPDATE connections SET kind='qr' WHERE profile_id=?",f.profile);
    const rows=[];
    for(const [line,phone] of [[f.line,'5511987654321'],[f.second,'551187654321']]) {
      const cid=uid();
      await exec(env,"INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,verified_phone,customer_link_state,session,last_customer,created,updated) VALUES(?,?,?,?,?,?,?,'ready',?,1,1,1)",cid,f.profile,line,`channel:${line}`,phone,phone,phone,uid());
      await exec(env,"INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'identity',1)",cid,f.profile,id);
      await exec(env,"INSERT INTO customer_phones(profile_id,namespace,phone,contact_id,state) VALUES(?,'team',?,?,'ready')",f.profile,phone,id);
      const c=await api.conversation(env,cid,f.profile);
      assert.equal((await api.resolveCustomer(env,c)).state,'pending');
      const plan=await api.customerIdentity.prepareInbound(env,c,{provider:'qr',phone:c.phone,phoneJid:`${c.phone}@s.whatsapp.net`});
      await batch(env,plan.statements);
      assert.equal((await api.resolveCustomer(env,c)).contactId,id);
      rows.push(c);
    }
    const [a,b]=rows;
    await exec(env,"INSERT INTO queues(id,profile_id,name,created,updated) VALUES(?,?,'Fila',1,1)",queue,f.profile);
    const issue=c=>api.issueTicket(env,f.profile,{queueId:queue,preferential:false,source:'whatsapp',actorId:'customer',conversationId:c.id,sourceKey:uid()});
    const first=await issue(a),second=await issue(b);
    assert.equal(second.created,false);assert.equal(second.ticket.id,first.ticket.id);assert.equal(second.ticket.conversation_id,a.id);
    count.statements=0;count.sql=[];
    assert.equal((await api.activeTicketForConversation(env,f.profile,b.id))?.id,first.ticket.id);
    assert.equal(count.statements,1);
    const next=await contact(f,'5511990000000','manual');
    await batch(env,[
      ["UPDATE customer_phone_proofs SET revoked=1 WHERE profile_id=? AND phone=? AND contact_id=?",[f.profile,a.phone,id]],
      ["INSERT INTO customer_phone_proofs(profile_id,namespace,phone,contact_id,conversation_id,created) VALUES(?,'team',?,?,?,?)",[f.profile,a.phone,next,a.id,now()]],
      ["UPDATE customer_phones SET contact_id=?,state='ready' WHERE profile_id=? AND namespace='team' AND phone=?",[next,f.profile,a.phone]],
      ...api.conversationIdentityStatements(f.profile,[a.id]),
    ]);
    assert.equal((await api.resolveCustomer(env,a)).contactId,next);
    assert.equal(await api.activeTicketForConversation(env,f.profile,a.id),null);
    assert.equal((await api.activeTicketForConversation(env,f.profile,b.id))?.id,first.ticket.id);
    assert.deepEqual(await one(env,"SELECT contact_id,conversation_id FROM customer_records WHERE profile_id=? AND module_id='queue' AND kind='ticket' AND record_id=?",f.profile,first.ticket.id),{contact_id:id,conversation_id:a.id});
  });
  await check('senha inexistente e custo da consulta', async () => {
    const f=await fixture(), c=await receive(f);
    assert.deepEqual(await api.conversationTicket(env,f.profile,uid()),{senha:null});
    count.statements=0; count.sql=[];
    await api.activeTicketForConversation(env,f.profile,c.id);
    assert.equal(count.statements,1);
  });
  await check('senha de balcão: variante, app, transferência e bloqueio', async () => {
    const f=await fixture(), queue=uid(), phone='5511960000004';
    await exec(env,"INSERT INTO queues(id,profile_id,name,created,updated) VALUES(?,?,'Fila',1,1)",queue,f.profile);
    const {ticket}=await api.issueTicket(env,f.profile,{queueId:queue,source:'staff',actorId:f.actor.id,phone,preferential:false});
    const c=await receive(f,'SENHA',phone), second=await receive(f,'SENHA','551160000004',f.second);
    for(const linked of [c,second]) assert.equal((await api.conversationTicket(env,f.profile,linked.id)).senha.codigo,ticket.code);
    const app=await api.inbound(env,f.profile,{external_id:phone,phone,text:'SENHA',message_id:uid()},'app:fake',null);
    assert.deepEqual(await api.conversationTicket(env,f.profile,app.conversation_id),{senha:null});
    await exec(env,'UPDATE queue_tickets SET conversation_id=? WHERE id=?',second.id,ticket.id);
    assert.deepEqual(await api.conversationTicket(env,f.profile,c.id),{senha:null});
    await exec(env,"UPDATE queue_tickets SET conversation_id=NULL,source='kiosk' WHERE id=?",ticket.id);
    assert.deepEqual(await api.conversationTicket(env,f.profile,c.id),{senha:null});
    await exec(env,"UPDATE queue_tickets SET source='staff' WHERE id=?",ticket.id);
    await exec(env,"UPDATE conversations SET customer_link_state='blocked' WHERE id=?",c.id);
    assert.deepEqual(await api.conversationTicket(env,f.profile,c.id),{senha:null});
  });
  await check('procedência observada vem do canal e conserva sessão', async () => {
    const f=await fixture(), id=await contact(f,'5511999998888','manual'), c=await receive(f);
    const identity=await one(env,'SELECT * FROM customer_phones WHERE profile_id=?',f.profile);
    assert.equal(identity.contact_id,id);
    const resolved=await api.resolvePhone(env,f.actor,f.profile,{namespace:'team',phone:identity.phone,contactId:id,expectedVersion:identity.version,reason:'Continuidade do canal'},uid());
    assert.equal(resolved.state,'ready');assert.equal(resolved.contactId,id);
    assert.equal((await one(env,'SELECT contact_id FROM customer_records WHERE conversation_id=?',c.id)).contact_id,id);
  });
  for(const candidate of [false,true]) await check(`checkpoint completo, 1000 contatos, candidato ${candidate}`, async () => {
    const f=await fixture(), phone='5511987654321';
    await exec(env,`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1000)
      INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated)
      SELECT ?||printf('-complete-%04d',i),?,'team','Ana',printf('55119777%04d',i),'','import','test','test',1,1 FROM n`,f.profile,f.profile);
    await exec(env,"INSERT INTO customer_phone_candidates(profile_id,namespace,phone,contact_id,origin) SELECT profile_id,namespace,phone,id,'local' FROM contacts WHERE profile_id=?",f.profile);
    if(candidate) {
      const id=await contact(f,phone,'import');
      await batch(env,await api.customerIdentity.indexContact(env,{profileId:f.profile,namespace:'team',contactId:id,phones:[phone],origin:'local'}));
    }
    await exec(env,"INSERT INTO customer_progress(profile_id,namespace,task,cursor_json,complete,updated) VALUES(?,'team',?,'{}',1,?)",f.profile,api.CONTACT_TASK,now());
    const c=await api.conversationByPhone(env,f.profile,phone,{open:true});
    const plan=await api.customerIdentity.prepareInbound(env,c,{provider:'zernio',phone});
    assert.equal(plan.state,candidate?'pending':'ready');assert(JSON.stringify(plan.statements).length<40000);
    await batch(env,plan.statements);
    assert.equal((await one(env,'SELECT count(*) n FROM contacts WHERE profile_id=?',f.profile)).n,1001);
  });
  for(const mask of [undefined,true,false]) await check(`motor real, histórico e máscara ${mask}`, async () => {
    const f=await fixture(), ai=uid(), bot=uid(), cpf='123.456.789-09';
    await exec(env,"INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,'IA','ai','direct','active',?,?)",ai,f.profile,JSON.stringify({provider:'anthropic',model:'claude-haiku-5-5',text_only:true,verified_at:now(),bot_options:{default:{mask_personal:mask}}}),now());
    await exec(env,"INSERT INTO bots(id,profile_id,connection_id,remote_profile,name,enabled) VALUES(?,?,?,'default','IA',1)",bot,f.profile,ai);
    await api.setSecret(env,`connection:${ai}`,{api_key:'test-key'});
    await exec(env,'UPDATE profiles SET settings=? WHERE id=?',JSON.stringify({...defaults,attendant_bot:bot}),f.profile);
    await exec(env,'UPDATE connections SET config=? WHERE id=?',JSON.stringify({service:{menu_mode:'manual'}}),f.line);
    await exec(env,"INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,'os',1,1)",f.profile);
    const c=await receive(f,`Meu CPF ${cpf}`);
    await api.processInbox(env,f.profile);
    const run=await one(env,'SELECT * FROM bot_runs WHERE conversation_id=?',c.id);
    assert(run);assert(run.input.includes(cpf));
    const calls=[], original=globalThis.fetch, marker=mask===false?cpf:'[CPF_1]';
    globalThis.fetch=async(input,init)=> {
      assert(String(input).startsWith('https://api.anthropic.com/'));
      calls.push(JSON.parse(init.body));
      return Response.json({id:'msg_'+uid(),type:'message',role:'assistant',model:'claude-haiku-5-5',stop_reason:calls.length===1?'tool_use':'end_turn',stop_sequence:null,
        content:calls.length===1?[{type:'tool_use',id:'t1',name:'os_situacao',input:{cpf:marker}}]:[{type:'text',text:JSON.stringify({action:'clarify',text:`Seu CPF ${marker} foi registrado`,citations:[],capability_id:null,menu_id:null,protocol_number:null,category_id:null})}],usage:{input_tokens:1,output_tokens:1}});
    };
    try {await api.processRun(env,run);} finally {globalThis.fetch=original;}
    assert.equal(calls.length,2);
    const input=JSON.parse(calls[0].messages[0].content.at(-1).text);
    assert(input.history.some(m=>m.text.includes(marker)));
    if(mask!==false) for(const body of calls) assert(!JSON.stringify(body).includes(cpf));
    assert((await all(env,'SELECT payload FROM outbox WHERE conversation_id=?',c.id)).some(r=>JSON.parse(r.payload).text===`Seu CPF ${cpf} foi registrado`));
  });
  await check('OS: aviso vinculado e documento por telefone', async () => {
    const f=await fixture(), c=await receive(f), ctx=api.modulesApi(env,f.profile,'os');
    await exec(env,"INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,'os',1,1)",f.profile);
    const {order}=await api.createOrder(ctx,{conversation:c,phone:'5511960010203',item:'Objeto',problem:'Conferir',source:'panel',actor:f.actor.id,notify:false,sourceKey:uid()});
    await api.notify(ctx,order,'ready','ready');
    assert.equal((await all(env,"SELECT id FROM outbox WHERE conversation_id=? AND kind!='team'",c.id)).length,1);
    assert.equal(await api.workCustomerAllows(ctx,c,order,true),false);
    const {order:legacy}=await api.createOrder(ctx,{phone:'5511960010203',item:'Objeto',problem:'Conferir',source:'panel',actor:f.actor.id,notify:false,sourceKey:uid()});
    const old=await receive(f,'oi','5511960010203'), current=await receive(f,'oi','5511960010999');
    await exec(env,'UPDATE os_orders SET conversation_id=?,phone=? WHERE id=?',old.id,current.phone,legacy.id);
    assert.equal(await api.workCustomerAllows(ctx,old,legacy,true),false);
    assert.equal(await api.workCustomerAllows(ctx,current,legacy,true),true);
  });
  await check('OS: repetição do lembrete tenta transporte e isola falha', async () => {
    const f=await fixture(), c=await receive(f), ctx=api.modulesApi(env,f.profile,'os');
    await exec(env,"INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,'os',1,1)",f.profile);
    for(let i=0;i<2;i++) {
      const {order}=await api.createOrder(ctx,{conversation:c,item:'Objeto',problem:'Conferir',source:'panel',actor:f.actor.id,notify:false,sourceKey:uid()});
      await exec(env,"UPDATE os_orders SET status='ready',stage='ready',ready_at=? WHERE id=?",now()-40*86400000,order.id);
    }
    await api.runDue(ctx,now());
    assert.equal((await all(env,'SELECT id FROM os_orders WHERE profile_id=? AND pickup_reminded_at IS NOT NULL',f.profile)).length,2);
    await exec(env,'UPDATE os_orders SET pickup_reminded_at=NULL WHERE profile_id=?',f.profile);
    let sends=0;
    await api.runDue({...ctx,wake:async()=>{},sendMessage:async (...args)=> { if(++sends===1) throw Error('Transporte indisponível'); return ctx.sendMessage(...args); }},now());
    assert.equal(sends,2);
    assert.equal((await all(env,'SELECT id FROM os_orders WHERE profile_id=? AND pickup_reminded_at IS NULL',f.profile)).length,1);
  });
  await check('ponte ERP: resposta perdida, lease vencida e orçamento 40', async () => {
    const f=await fixture(), id=await contact(f,'5511998765432','manual');
    await exec(env,"INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,'erp',1,1)",f.profile);
    let record=null, fail=true, creates=0;
    const bridgeEnv={...env,COORDINATOR:{idFromName:name=>name,get:()=>({fetch:async(url,init)=>{
      const name=new URL(url).pathname.split('/').at(-1), args=JSON.parse(init.body);
      if(name==='erp_catalog_contact_page') return Response.json({items:record?[record]:[],total:record?1:0});
      if(name==='erp_catalog_contact_check') return Response.json({warnings:[]});
      if(name==='erp_catalog_contact_save') {
        if(!record) {record={...args.p_data,id:uid(),version:1}; creates++;}
        if(fail) {fail=false;throw Error('Resposta perdida depois do save');}
        return Response.json({record,replayed:true});
      }
      if(name==='erp_catalog_contact_get') return Response.json({record});
      throw Error('RPC inesperada: '+name);
    }})}};
    const input={profileId:f.profile,namespace:'team',contactId:id,commandId:uid(),requestHash:uid(),actor:f.actor,operation:'promote',erpId:null,expectedErpVersion:null,patch:{}};
    await assert.rejects(api.customerErpBridge.apply(bridgeEnv,input));
    await exec(env,"UPDATE customer_jobs SET state='running',retry_at=0,lease_until=? WHERE profile_id=?",now()-1,f.profile);
    count.statements=0;count.sql=[];
    const short=await api.maintainErpCustomers(bridgeEnv,f.profile,{remainingItems:1,remainingStatements:5});
    assert.equal(short.statements,count.statements);assert(short.statements<=5);
    count.statements=0;count.sql=[];
    const full=await api.maintainErpCustomers(bridgeEnv,f.profile,{remainingItems:1,remainingStatements:40});
    assert.equal(full.statements,count.statements);assert(full.statements<=40);
    const state=await one(env,'SELECT state FROM customer_jobs WHERE profile_id=?',f.profile);
    if(state.state!=='done') console.log('PONTE',full,state,count.sql.map((sql,i)=>[i+1,sql.replace(/\s+/g,' ').slice(0,180)]));
    assert.equal(state.state,'done');assert.equal(creates,1);
    console.log('Ponte retomada:',full.statements,'instruções');
  });
  console.log(`${cases} cenários aprovados; Worker/D1, ERP remoto e R2 real não exercitados.`);
  sqlite.close();
} finally { await rm(generated, { force: true }); }
