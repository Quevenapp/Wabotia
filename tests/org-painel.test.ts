import {describe,it,expect,vi} from 'vitest';
import {createReceiveBlingClient,BlingCommandSession,safeBlingFailure,resourceSelectable,dateMeaning} from '../web/erp/app/lib/receive-bling.ts';
import {BLING_OPERATIONS,authorizeBlingOperation,resourceDescriptorSchema} from '../src/erp/bling/schema.ts';
import {BlingError,type BlingContext,type BlingOperationName,type BlingReceipt} from '../src/erp/bling/contracts.ts';
import {normalizeErpParts} from '../src/erp/parts.ts';
import {erpDestinationRequirement} from '../src/erp/parts-requirements.ts';
// @ts-ignore Simuladores puros da fatia; não abrem conexão.
import {FakeBling,FakeClock} from './erp/org/fake-bling.mjs';
// @ts-ignore Guarda compartilhada: só permite DML da coleta e do acervo.
import {guardCollectionDriver,assertCollectionWrite,assertNoSecrets} from './erp/org/contract-checks.mjs';

const time=Date.UTC(2026,10,19,12), hash='a'.repeat(64),actor='b6000000-0000-4000-8000-000000000001',session='b6000000-0000-4000-8000-000000000002';
const parts=normalizeErpParts({products:false,sales:false,purchases:false,stock:false,finance:false,fiscal:false,billing:false,pos:false});
function context({admin=true,bot=false,external=false}={}):BlingContext{return{
 profile:'painel',origin:external?'external':'app',clock:{now:()=>time},identity:{actor:{user_id:actor,name:'Pessoa',email:null,erp_role:admin?'admin':'consulta',verified_factor:true,session_id:session,aal:'aal2',is_agent:bot},people:[],parts,partsControl:{profile:'painel',revision:'1',expires_at:time+120000}},
};}
const command=(id='pedido-1')=>({command_id:id,expected_revision:'1',resource_keys:['products']});

/** Porta do servidor simulada: prova o protocolo do painel, não o motor paralelo. */
function simulatedService({enabled=true,loss='none' as 'none'|'before_commit'|'after_commit',admin=true}={}){
 const clock=new FakeClock(time),bling=new FakeBling({clock}).resource('/produtos',[{id:'9007199254740993123',nome:'Produto simulado'}]);
 const calls:{method:string;path:string;body:any}[]=[],writes:{table:string;operation:string}[]=[],receipts=new Map<string,BlingReceipt>(),pending=new Map<string,any>();
 const operational={customers:[{id:'cliente-existente',name:'Sem alteração'}],titles:[{id:'titulo-existente',amount:'12.34'}],stock:[{id:'produto-existente',quantity:'9'}]};
 const baseline=structuredClone(operational);let checkpoint=0;
 const driver=guardCollectionDriver({exec:()=>({}),transaction:(fn:()=>unknown)=>fn()},writes);
 function commit(input:any){
  if(receipts.has(input.command_id))return receipts.get(input.command_id)!;
  const receipt:BlingReceipt={command_id:input.command_id,request_hash:hash,generation:'1',operation:'erp_bling_collect_request',state:'committed',committed_at:clock.iso(),references:{run_id:'rodada-1'},counts:{observed:1},error:null};
  driver.transaction(()=>{driver.exec('INSERT INTO wb_bling_receipt (command_id) VALUES (?)',input.command_id);driver.exec('UPDATE origin_sync__resource_state SET checkpoint_revision = ?',String(checkpoint+1));receipts.set(input.command_id,receipt);checkpoint++;});return receipt;
 }
 const fetcher:typeof fetch=async(input,init={})=>{
  const url=new URL(String(input),'https://painel.invalid'),path=url.pathname.replace('/api/v1/profiles/painel/erp/v1/receber-bling',''),method=init.method??'GET',body=typeof init.body==='string'?JSON.parse(init.body):undefined;
  calls.push({method,path,body:structuredClone(body)});
  if(path.startsWith('/comandos/')){const id=decodeURIComponent(path.slice('/comandos/'.length));return Response.json({phase:receipts.has(id)?'committed':'fetching',receipt:receipts.get(id)??null});}
  if(path!=='/coletar')throw new Error('Rota fora do contrato simulado.');
  try{authorizeBlingOperation(context({admin}),'erp_bling_collect_request',body);BLING_OPERATIONS.erp_bling_collect_request.input.parse(body);if(!enabled)throw new BlingError('BLING_DISABLED');}catch(error){const failure=error instanceof BlingError?error:new BlingError('BLING_RESPONSE_INVALID');return Response.json({error:failure.toJSON()},{status:failure.status});}
  let receipt=receipts.get(body.command_id);
  if(!receipt){pending.set(body.command_id,body);await bling.fetch(bling.baseUrl+'/produtos',{method:'GET'});if(loss==='before_commit'){loss='none';throw new TypeError('Resposta interrompida.');}receipt=commit(body);if(loss==='after_commit'){loss='none';throw new TypeError('Resposta interrompida.');}}
  return Response.json({run_id:'rodada-1',next_wake:null,receipt});
 };
 const client=createReceiveBlingClient({apiUrl:'/api/v1/profiles/painel/erp',fetch:fetcher});
 return{client,calls,bling,writes,operational,baseline,receipts,checkpoint:()=>checkpoint,async recover(){for(const input of pending.values())if(!receipts.has(input.command_id)){await bling.fetch(bling.baseUrl+'/produtos',{method:'GET'});commit(input);}}};
}

describe('Receber dados do Bling: contrato de interação do painel',()=>{
 it('repetição concorrente não duplica comando, chamada nem avanço de checkpoint',async({task})=>{
  const server=simulatedService(),commands=new BlingCommandSession(server.client),input=command();
  const results=await Promise.all([commands.run('erp_bling_collect_request',input),commands.run('erp_bling_collect_request',input)]);
  expect(results[0]).toEqual(results[1]);expect(server.calls.filter(call=>call.method==='POST')).toHaveLength(1);expect(server.checkpoint()).toBe(1);expect(server.receipts.size).toBe(1);
  await commands.run('erp_bling_collect_request',input);expect(server.calls.filter(call=>call.method==='POST')).toHaveLength(1);
  await expect(commands.run('erp_bling_collect_request',{...input,resource_keys:['contacts']})).rejects.toThrow();
  expect(server.operational).toEqual(server.baseline);expect(server.writes.every(write=>['wb_bling_receipt','origin_sync__resource_state'].includes(write.table))).toBe(true);
  expect(()=>assertCollectionWrite('UPDATE erp_catalog__product SET name = ?')).toThrow();
  server.bling.assertReadOnly();expect(server.bling.mutationAttempts).toBe(0);expect(server.bling.mutations).toBe(0);
  task.meta.orgPainel={calls:server.bling.callCount,mutations:server.bling.mutations,checkpoint:server.checkpoint(),operationalUnchanged:true};
 });
 it('resposta perdida depois do commit consulta recibo sem repetir comando ou GET remoto',async()=>{
  const server=simulatedService({loss:'after_commit'}),commands=new BlingCommandSession(server.client);
  await expect(commands.run('erp_bling_collect_request',command())).rejects.toThrow();expect(commands.pending?.command_id).toBe('pedido-1');
  await commands.resume();expect(commands.pending).toBeNull();expect(server.calls.filter(call=>call.method==='POST')).toHaveLength(1);expect(server.bling.callCount).toBe(1);expect(server.checkpoint()).toBe(1);
 });
 it('queda entre HTTP e gravação mantém tentativa; consulta não avança e retomada usa o mesmo recibo',async()=>{
  const server=simulatedService({loss:'before_commit'}),commands=new BlingCommandSession(server.client);
  await expect(commands.run('erp_bling_collect_request',command())).rejects.toThrow();expect(server.checkpoint()).toBe(0);
  await commands.resume();expect(commands.pending?.command_id).toBe('pedido-1');expect(server.checkpoint()).toBe(0);expect(server.bling.callCount).toBe(1);
  await expect(commands.run('erp_bling_collect_request',command('pedido-2'))).rejects.toThrow();
  await server.recover();await commands.resume();expect(commands.pending).toBeNull();expect(server.checkpoint()).toBe(1);expect(server.receipts.size).toBe(1);expect(server.calls.filter(call=>call.method==='POST')).toHaveLength(1);
  server.bling.assertReadOnly();expect(server.bling.callCount).toBe(2);expect(server.operational).toEqual(server.baseline);
 });
 it('função desligada e pessoa sem administrador não provocam chamada ao Bling',async()=>{
  for(const options of [{enabled:false},{admin:false}]){const server=simulatedService(options),commands=new BlingCommandSession(server.client);await expect(commands.run('erp_bling_collect_request',command())).rejects.toThrow();expect(server.bling.callCount).toBe(0);expect(server.checkpoint()).toBe(0);expect(server.writes).toEqual([]);expect(server.operational).toEqual(server.baseline);}
 });
 it('Base desligada é recusada antes do despacho do navegador',async()=>{
  let dispatched=0;const denied=context();denied.identity.parts={...parts,customers:false};
  const client=createReceiveBlingClient({apiUrl:'/api/v1/profiles/painel/erp',assertAccess:name=>authorizeBlingOperation(denied,name,{}),fetch:async()=>{dispatched++;return Response.json({});}});
  await expect(client.execute('erp_bling_status',{})).rejects.toMatchObject({code:'BLING_DISABLED'});expect(dispatched).toBe(0);
 });
 it('novo destino depende somente da Base, inclusive consulta de XML',()=>{expect(erpDestinationRequirement('/receber-bling')?.requirement.all).toEqual(['erp']);expect(parts.customers).toBe(true);expect(parts.fiscal).toBe(false);expect(parts.finance).toBe(false);});
 for(const operation of Object.values(BLING_OPERATIONS).filter(operation=>operation.name!=='erp_bling_oauth_callback')){
  it(`${operation.name}: bot configurado alcança, sem configuração e origem externa são recusados`,()=>{
   const ctx=context({bot:true});ctx.authorization={request_hash:hash,read_granted:true,bot:{id:'bot-equipe',allowed_operations:[operation.name],allowed_entities:['products','nfe','nfce'],data_scopes:['public','personal','sensitive','raw','xml'],allow_sensitive:true}};
   const input={entity:'products',command_id:'pedido-1'};
   expect(()=>authorizeBlingOperation(ctx,operation.name,input)).not.toThrow();expect(()=>authorizeBlingOperation(context({bot:true}),operation.name,input)).toThrow();expect(()=>authorizeBlingOperation({...ctx,origin:'external'},operation.name,input)).toThrow();
   if(operation.permission==='admin'){expect(()=>authorizeBlingOperation({...ctx,identity:context({bot:true,admin:false}).identity},operation.name,input)).toThrow();}
  });
 }
 it('categoria sensível pode passar por proposta confirmada com hash e ator exatos',()=>{
  const ctx=context({bot:true}),name:BlingOperationName='erp_bling_purge_apply';ctx.authorization={request_hash:hash,bot:{id:'bot-equipe',allowed_operations:[name],allowed_entities:['products'],data_scopes:['public'],allow_sensitive:false}};
  const input={command_id:'apagar-1'};expect(()=>authorizeBlingOperation(ctx,name,input)).toThrow();
  ctx.authorization.confirmation={operation:name,command_id:'apagar-1',request_hash:hash,confirmed_by:actor,expires_at:time+60000};expect(()=>authorizeBlingOperation(ctx,name,input)).not.toThrow();
  ctx.authorization.confirmation.request_hash='b'.repeat(64);expect(()=>authorizeBlingOperation(ctx,name,input)).toThrow();
 });
 it('mensagem remota e campos extras de resposta não revelam segredo nem entram em log',async()=>{
  const privateValue=crypto.randomUUID(),logs=vi.spyOn(console,'error').mockImplementation(()=>{}),warnings=vi.spyOn(console,'warn').mockImplementation(()=>{});
  try{
   const client=createReceiveBlingClient({apiUrl:'/api/v1/profiles/painel/erp',fetch:async()=>Response.json({error:{code:'BLING_RETRY_WAIT',message:privateValue,client_secret:privateValue}},{status:503})});
   let caught:unknown;try{await client.execute('erp_bling_status',{});}catch(error){caught=error;}
   assertNoSecrets(safeBlingFailure(caught),[privateValue]);assertNoSecrets(String(caught),[privateValue]);
   const malformed=createReceiveBlingClient({apiUrl:'/api/v1/profiles/painel/erp',fetch:async()=>Response.json({phase:'fetching',receipt:null,client_secret:privateValue})});
   await expect(malformed.execute('erp_bling_command_get',{id:'pedido-1'})).rejects.toMatchObject({code:'BLING_RESPONSE_INVALID'});
   expect(logs).not.toHaveBeenCalled();expect(warnings).not.toHaveBeenCalled();
  }finally{logs.mockRestore();warnings.mockRestore();}
 });
 it('recurso não confirmado não é selecionável e filtro U não promete recorte temporal',()=>{
  const resource=resourceDescriptorSchema.parse({key:'contracts',entity:'contracts',path:null,pagination:null,detail:null,dateFilter:null,variants:[],deletedEvidence:null,identityRule:{kind:'unconfirmed',parent_entity:null},parser:null,scopeRequirements:[],confirmation:'nao_confirmado',officialEvidence:null,defaultSelected:false});
  expect(resourceSelectable(resource)).toBe(false);expect(dateMeaning({...resource,dateFilter:{kind:'U',from:null,to:null,time_zone:'America/Sao_Paulo',overlap_minutes:15}})).toMatch(/sem filtro temporal/i);
 });
});

describe('cliente tipado e custódia no navegador',()=>{
 it('resposta XML confere hash e preserva o arquivo, sem certificar assinatura',async()=>{
  const bytes=new TextEncoder().encode('<NFe>Somente estrutura simulada</NFe>'),digest=await crypto.subtle.digest('SHA-256',bytes),sha=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  let tampered=false;const calls:{url:string;method:string}[]=[];
  const client=createReceiveBlingClient({apiUrl:'/api/v1/profiles/painel/erp',fetch:async(input,init)=>{calls.push({url:String(input),method:init?.method??'GET'});return new Response(tampered?new TextEncoder().encode('<NFe>Alterado</NFe>'):bytes,{headers:{'Content-Type':'application/xml','X-Content-SHA256':sha,'Content-Disposition':'attachment; filename="nota.xml"'}});}});
  const value=await client.execute('erp_bling_xml_get',{object_id:'objeto-1'});expect(value.bytes).toEqual(bytes);expect(value.sha256).toBe(sha);expect(value.filename).toBe('nota.xml');
  tampered=true;await expect(client.execute('erp_bling_xml_get',{object_id:'objeto-1'})).rejects.toThrow();expect(calls.every(call=>call.method==='GET'&&call.url==='/api/v1/profiles/painel/erp/v1/receber-bling/xml/objeto-1')).toBe(true);
 });
 it('aplicativo perdido mantém só a identidade do comando no journal e não repete segredo ao retomar',async()=>{
  const clientId=crypto.randomUUID(),clientSecret=crypto.randomUUID(),saved:any[]=[],sent:any[]=[];
  const client=createReceiveBlingClient({apiUrl:'/api/v1/profiles/painel/erp',fetch:async(input,init)=>{sent.push({url:String(input),method:init?.method??'GET'});if(init?.method==='POST')throw new TypeError('Conexão interrompida.');return Response.json({phase:'fetching',receipt:null});}});
  const commands=new BlingCommandSession(client,{read:()=>null,write:value=>saved.push(structuredClone(value))});
  await expect(commands.run('erp_bling_app_save',{command_id:'aplicativo-1',expected_revision:'1',client_id:clientId,client_secret:clientSecret})).rejects.toThrow();
  await commands.resume();assertNoSecrets(saved,[clientId,clientSecret]);assertNoSecrets(commands.pending,[clientId,clientSecret]);expect(sent.map(call=>call.method)).toEqual(['POST','GET']);expect(saved[0]).toEqual({operation:'erp_bling_app_save',command_id:'aplicativo-1',expected_revision:'1'});
 });
 it('perda de permissão depois do despacho conserva comando até consultar seu recibo',async()=>{
  let allowed=true;const calls:string[]=[],input=command('permissao-1');
  const receipt:BlingReceipt={command_id:input.command_id,request_hash:hash,generation:'1',operation:'erp_bling_collect_request',state:'committed',committed_at:new Date(time).toISOString(),references:{},counts:{},error:null};
  const client=createReceiveBlingClient({apiUrl:'/api/v1/profiles/painel/erp',assertAccess:()=>{if(!allowed)throw new BlingError('BLING_ADMIN_REQUIRED');},fetch:async(url,init)=>{calls.push(init?.method??'GET');if(String(url).endsWith('/coletar')){allowed=false;return Response.json({run_id:'rodada-1',next_wake:null,receipt});}return Response.json({phase:'committed',receipt});}});
  const commands=new BlingCommandSession(client);await expect(commands.run('erp_bling_collect_request',input)).rejects.toThrow();
  expect(commands.pending?.command_id).toBe(input.command_id);allowed=true;await commands.resume();expect(commands.pending).toBeNull();expect(calls).toEqual(['POST','GET']);
 });
 it('recusa administrativa antes de qualquer despacho não deixa comando pendente',async()=>{
  let calls=0;const client=createReceiveBlingClient({apiUrl:'/api/v1/profiles/painel/erp',assertAccess:()=>{throw new BlingError('BLING_ADMIN_REQUIRED');},fetch:async()=>{calls++;return Response.json({});}}),commands=new BlingCommandSession(client);
  await expect(commands.run('erp_bling_collect_request',command())).rejects.toThrow();expect(commands.pending).toBeNull();expect(calls).toBe(0);
 });
 it('mudança de área ou sessão descarta resposta atrasada sem expor os dados',async()=>{
  let current=true;const client=createReceiveBlingClient({apiUrl:'/api/v1/profiles/painel/erp',isCurrent:()=>current,fetch:async()=>{current=false;return Response.json({phase:'fetching',receipt:null});}});
  await expect(client.execute('erp_bling_command_get',{id:'pedido-1'})).rejects.toMatchObject({name:'AbortError'});
 });
});
