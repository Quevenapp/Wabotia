import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {mountComponent} from './helpers/component-recovery-harness.mjs';

// Um único módulo conserva a mesma fotografia entre componentes, modelos e transporte.
const result=await build({stdin:{contents:`
 export * from './web/erp/blocks.ts';
 export * from './web/erp/fetch-port.ts';
 export {acquireErpHost} from './web/erp/host-runtime.tsx';
 export {createAccessController,AccessError} from './web/erp/app/lib/real-access.ts';
 export * from './web/erp/app/lib/home-model.ts';
 export * from './web/erp/app/lib/preferences-model.ts';
 export {availableTransitionActions} from './web/erp/app/lib/real-documents-model.ts';
 export {readMaintenance,maintenanceChoices,maintenanceArgs} from './web/erp/app/components/ErpEffectMaintenance.tsx';
 export {ERP_MODULE_IDS,erpRequirement} from './src/erp/parts.ts';
 export {ERP_MANAGEMENT_ITEMS} from './src/modules/erp/panel-menu.ts';
 export {MANAGEMENT_ITEMS,managementContext,managementEntryState,managementLanding,resolveManagement} from './web/management/registry.ts';
 export {portedTargetState} from './web/management/ported-policy.ts';
 export {resolvePreferences} from './web/erp/app/lib/origin-menu.ts';
 export {storedPreferencePage} from './packages/erp-domain/src/preferences/catalog.mjs';
 export {storedFields} from './packages/erp-domain/src/preferences/core.mjs';
 export {pageSituationKinds} from './packages/erp-domain/src/preferences/dto.mjs';
 `,resolveDir:fileURLToPath(new URL('../../../',import.meta.url)),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic',logLevel:'silent',define:{'import.meta.env':'{}'},loader:{'.css':'empty'},footer:{js:'//# sourceURL=f2-parts-bundle.mjs'}});
const m=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const all=Object.fromEntries(m.ERP_MODULE_IDS.map(id=>[id,true]));
const id='a0000000-0000-4000-8000-000000000001',posting='a0000000-0000-4000-8000-000000000002';
const blocks=['blockEnabled','entityEnabled','operationEnabled','fieldEnabled','targetEnabled','requirementEnabled','blockOf','ERP_BLOCK_LABELS','hiddenInWabotia','REENABLED_AUTOMATION_NOTICE','withoutUnavailableParts','availablePayload'];
const replacement=blocks.map(name=>`export const ${name}=r.parts.${name};`).join('\n');
const harness={ports:{parts:m},modules:{'../../blocks':replacement,'../../blocks.ts':replacement}};
test.afterEach(()=>{m.setErpModuleContext(null);m.setErpBlocks(null);});

test('hospedeiro renova contexto encerrado e revoga pedidos ao mudar uma das nove partes',async()=>{
 const previous=Object.fromEntries(['location','window','document','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const leases=[];
 try {
  globalThis.location=new URL('https://painel.invalid/app/erp/acesso');
  globalThis.window=new EventTarget();globalThis.document=Object.assign(new EventTarget(),{hidden:false});
  let reads=0,finish;
  globalThis.fetch=async(path)=>{
   reads++;
   if(String(path).endsWith('/v1/me'))return Response.json({user_id:id,role:'consulta',resources:['contacts','products'],data_mode:'staging_readonly'});
   if(String(path).endsWith('/v1/sistema/permissoes'))return Response.json({scope:'access_permissions',data_mode:'erp_native',user_id:id,role:'consulta',user_type:'normal',permissions:['suprimentos.controle_estoque'],access:{open:true,until:null}});
   return new Promise(resolve=>{finish=resolve;});
  };
  const context=modules=>({profile:'aceite-runtime',actor:id,demo:false,management:m.managementContext({statusLoaded:true,modules,role:'operator',access:['erp:consulta']}),onModules(){},onPeople(){},onLeave(){},onExpired(){}});
  // A casca anterior já saiu: o runtime deve estabelecer sua própria posse.
  m.setPanelPartsContext('/api/v1/profiles/aceite-runtime/erp',all)();
  const lease=m.acquireErpHost(context(all));leases.push(lease);
  const runtime=await lease.ready;
  const ready=async()=>{for(let attempt=0;attempt<100&&runtime.controller.getSnapshot().phase!=='ready';attempt++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(runtime.controller.getSnapshot().phase,'ready');};
  await ready();await runtime.controller.verifyPermissions();
  assert.equal(runtime.controller.getSnapshot().permissions.phase,'ready');
  assert.equal(runtime.allowed('/estoque-empresa'),true);
  let responsePending=runtime.ports.fetch('/api/v1/profiles/aceite-runtime/erp/v1/estoque/saldos');
  const rejected=assert.rejects(responsePending,{name:'AbortError'});
  for(let attempt=0;attempt<100&&!finish;attempt++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(typeof finish,'function');
  lease.update(context({...all,'erp-estoque':false}));finish(Response.json({items:[]}));await rejected;
  await ready();
  for(let attempt=0;attempt<100&&runtime.controller.getSnapshot().permissions?.phase!=='ready';attempt++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(runtime.controller.getSnapshot().permissions.phase,'ready');assert.equal(runtime.allowed('/estoque-empresa'),false);
  const before=reads,denied=await runtime.ports.fetch('/api/v1/profiles/aceite-runtime/erp/v1/estoque/saldos');
  assert.equal(denied.status,409);assert.equal(reads,before);
  lease.update(context(all));await ready();await runtime.controller.verifyPermissions();
  for(let attempt=0;attempt<100&&runtime.controller.getSnapshot().permissions?.phase==='checking';attempt++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(runtime.controller.getSnapshot().permissions.phase,'ready');assert.equal(runtime.allowed('/estoque-empresa'),true);
 } finally {
  leases.reverse().forEach(lease=>lease.dispose());
  for(const [key,descriptor] of Object.entries(previous)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
 }
});

test('hospedeiro despacha antes de suspender e ignora 401 da geração anterior',async()=>{
 const previous=Object.fromEntries(['location','window','document','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 let lease,late,lateSignal,permissionSignal,delayPermission=false,finishPermission,expired=0;
 const calls=[];
 try {
  globalThis.location=new URL('https://painel.invalid/app/erp/acesso');
  globalThis.window=new EventTarget();globalThis.document=Object.assign(new EventTarget(),{hidden:false});
  const permissions=()=>Response.json({scope:'access_permissions',data_mode:'erp_native',user_id:id,role:'consulta',user_type:'normal',permissions:[],access:{open:true,until:null}});
  globalThis.fetch=(path,init)=>{
   calls.push(path);
   if(String(path).endsWith('/v1/me'))return Promise.resolve(Response.json({user_id:id,role:'consulta',resources:['contacts'],data_mode:'staging_readonly'}));
   if(String(path).endsWith('/v1/sistema/permissoes')){
    permissionSignal=init.signal;
    return delayPermission?new Promise(resolve=>{finishPermission=resolve;}):Promise.resolve(permissions());
   }
   lateSignal=init.signal;return new Promise(resolve=>{late=resolve;});
  };
  const context={profile:'aceite-suspensao',actor:id,demo:false,management:m.managementContext({statusLoaded:true,modules:all,role:'operator',access:['erp:consulta']}),onModules(){},onPeople(){},onLeave(){},onExpired(){expired++;}};
  lease=m.acquireErpHost(context);const runtime=await lease.ready;
  const ready=async()=>{for(let attempt=0;attempt<100&&runtime.controller.getSnapshot().phase!=='ready';attempt++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(runtime.controller.getSnapshot().phase,'ready');};
  await ready();
  const read=runtime.controller.catalog('/v1/cadastros/contatos/antigo');
  const rejected=assert.rejects(read,{name:'AbortError'});
  assert.ok(lateSignal,'a requisição chega ao transporte antes de devolver controle');
  delayPermission=true;permissionSignal=undefined;
  const check=runtime.controller.verifyPermissions();
  assert.ok(permissionSignal,'a verificação fina também despacha sem esperar import');
  lease.update({...context,suspended:true});
  assert.equal(lateSignal.aborted,true);assert.equal(permissionSignal.aborted,true);
  const before=calls.length;
  await assert.rejects(runtime.ports.fetch('/api/v1/profiles/aceite-suspensao/erp/v1/me'),{name:'AbortError'});
  assert.equal(calls.length,before);
  delayPermission=false;lease.update(context);
  for(let attempt=0;attempt<100&&runtime.controller.getSnapshot().permissions?.phase!=='ready';attempt++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(runtime.controller.getSnapshot().permissions.phase,'ready');
  late(Response.json({},{status:401}));finishPermission(permissions());await rejected;await check;
  assert.equal(expired,0);assert.equal(runtime.controller.getSnapshot().phase,'ready');assert.equal(runtime.allowed('/acesso'),true);
 } finally {
  late?.(Response.json({}));finishPermission?.(Response.json({}));
  lease?.dispose();
  for(const [key,descriptor] of Object.entries(previous)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
 }
});

test('resposta antecipada perde corpo e sucesso após revogação',async()=>{
 const controller=new AbortController();
 const response=await m.contextBoundResponse(Response.json({private:'anterior'}),controller.signal);
 assert.equal(response.ok,true);controller.abort();assert.equal(response.ok,false);
 await assert.rejects(response.json(),{name:'AbortError'});
});

test('nova identidade assume o hospedeiro sem aceitar a resposta ou o descarte anteriores',async()=>{
 const previous=Object.fromEntries(['location','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 const leases=[];let person=id,finish,signal;
 try {
  globalThis.location=new URL('https://painel.invalid/app/erp/acesso');
  globalThis.fetch=(path,init)=>String(path).endsWith('/v1/me')
   ?Promise.resolve(Response.json({user_id:person,role:'admin',resources:['contacts'],data_mode:'staging_readonly'}))
   :new Promise(resolve=>{finish=resolve;signal=init.signal;});
  const host=()=>({profile:'aceite-identidade',actor:person,demo:false,management:m.managementContext({statusLoaded:true,modules:all,role:'admin',access:null}),onModules(){},onPeople(){},onLeave(){},onExpired(){}});
  const ready=async runtime=>{for(let attempt=0;attempt<100&&runtime.controller.getSnapshot().phase!=='ready';attempt++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(runtime.controller.getSnapshot().phase,'ready');};
  const a=m.acquireErpHost(host());leases.push(a);const old=await a.ready;await ready(old);
  const pending=old.controller.catalog('/v1/cadastros/contatos/erp-42'),rejected=assert.rejects(pending,{name:'AbortError'});
  assert.ok(signal);person=posting;
  const b=m.acquireErpHost(host());leases.push(b);const current=await b.ready;await ready(current);
  assert.equal(signal.aborted,true);finish(Response.json({record:{id:'erp-42'}}));await rejected;
  assert.equal(old.controller.getSnapshot().membership,null);assert.equal(old.allowed('/acesso'),false);
  a.dispose();assert.equal(current.controller.getSnapshot().membership.user_id,posting);assert.equal(current.allowed('/acesso'),true);
  const c=m.acquireErpHost(host());leases.push(c);assert.equal(await c.ready,current);
  b.dispose();assert.equal(current.allowed('/acesso'),true);
  c.dispose();assert.equal(current.allowed('/acesso'),false);
 } finally {
  finish?.(Response.json({}));leases.reverse().forEach(lease=>lease.dispose());
  for(const [key,descriptor] of Object.entries(previous)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
 }
});

test('suspensão após cabeçalhos revoga também o corpo da resposta',async()=>{
 const previous=globalThis.location;globalThis.location=new URL('https://painel.invalid');
 const api='/api/v1/profiles/f2-response-generation/erp',release=m.setPanelPartsContext(api,all),generation=new AbortController();
 try {
  const fetcher=m.createFetchPort({apiUrl:api,fetchImpl:async()=>Response.json({private:'anterior'})});
  const response=await fetcher(api+'/v1/cadastros/contacts',{signal:generation.signal});
  assert.equal(response.ok,true);generation.abort();assert.equal(response.ok,false);
  await assert.rejects(response.json(),{name:'AbortError'});
 } finally {release();globalThis.location=previous;}
});

test('Base oferece manutenção nas preferências mesmo com origens desligadas',()=>{
 m.setErpModuleContext({erp:true});
 const entries=m.resolvePreferences({role:'admin',resources:['contacts']}).flatMap(category=>category.sections.flatMap(section=>section.entries));
 assert.ok(entries.some(entry=>entry.to==='/manutencao-efeitos'));
 m.setErpModuleContext({});
 assert.equal(m.targetEnabled('/manutencao-efeitos'),false);
});

test('todos os destinos e nove partes: desligar qualquer requisito impede o destino',()=>{
 for(const item of m.ERP_MANAGEMENT_ITEMS){
  const resolved=m.requirementOf(item.target.to);assert.ok(resolved,item.id);
  assert.deepEqual(new Set(resolved.requirement.all),new Set(m.erpRequirement(item.module,...(item.requires??[])).all),item.id);
  for(const part of resolved.requirement.all){m.setErpModuleContext({...all,[part]:false});assert.equal(m.targetEnabled(item.target.to),false,`${item.id}/${part}`);}
 }
 for(const target of ['/cadastros-reais?cadastro=outro','/documentos-empresa?tipo=outro','/inexistente','/cadastros-reais?cadastro=contacts&cadastro=products'])assert.equal(m.requirementOf(target),null,target);
 m.setErpModuleContext({erp:true});assert.equal(m.targetEnabled('/cadastros-reais?cadastro=contacts'),true);
 for(const target of ['/financeiro-empresa','/estoque-empresa','/cadastros-reais?cadastro=products','/frente-caixa-empresa'])assert.equal(m.targetEnabled(target),false,target);
});

test('destinos A5 mantêm proprietário, incluindo contêineres, preferências e exceções compostas',()=>{
 const destinations={
  erp:['/acesso','/preferencias','/empresa-configuracoes','/ajuda','/cadastros-reais?cadastro=contacts','/tipos-contatos-empresa','/vendedores-empresa','/funcionarios-empresa','/formas-pagamento-empresa','/tags','/grupos-tags','/preferencias/sistema/gerenciador-arquivos','/manutencao-efeitos'],
  'erp-produtos':['/cadastros-reais?cadastro=products','/categorias-produtos','/grupos-produtos','/exportacao-produtos','/listas-precos','/campos-customizados'],
  'erp-vendas':['/documentos-empresa?tipo=sales_orders','/documentos-empresa?tipo=sales_proposals','/documentos-empresa?tipo=service_orders','/meu-negocio'],
  'erp-compras':['/documentos-empresa?tipo=purchase_orders'],
  'erp-estoque':['/cadastros-reais?cadastro=warehouses','/estoque-empresa','/estoque-abertura','/conferencia-estoque-empresa','/relatorios-estoque','/painel-produtos-empresa'],
  'erp-financeiro':['/financeiro-empresa','/relatorio-vencimentos','/financeiro-empresa?area=borderos','/financeiro-empresa?area=faturamento-agrupado'],
  'erp-cobranca':['/financeiro-empresa?area=remessas','/financeiro-empresa?area=retornos','/cobranca-empresa','/cobranca-operacional','/retornos-operacionais'],
  'erp-fiscal':['/historico-fiscal','/notas-entrada','/notas-recebidas','/numeracao-fiscal','/naturezas-operacao','/inutilizacoes-nfe','/cartas-correcao','/certificado-a1','/conexao-sefaz','/emissor-fiscal','/checkin-recebimentos'],
  'erp-pdv':['/frente-caixa-empresa'],
 };
 for(const [owner,targets] of Object.entries(destinations))for(const target of targets)assert.equal(m.blockOf(target),owner,target);
 for(const [target,required] of [['/checkin-recebimentos?order_id='+id,'erp-compras'],['/painel-produtos-empresa?painel=sugestao','erp-compras'],['/meu-negocio?painel=margem-pedido','erp-compras'],['/meu-negocio?painel=previsao-estoque','erp-estoque'],['/documentos-empresa?tipo=purchase_orders&acao=recebimentos','erp-estoque'],['/documentos-empresa?tipo=sales_orders&acao=reservas','erp-estoque']])assert.ok(m.requirementOf(target).requirement.all.includes(required),target);
});

test('entrada única abre Clientes na Base, destinos nativos isolados e estado vazio sem gestão',()=>{
 const context=(modules,role='admin',access=null)=>m.managementContext({statusLoaded:true,modules,role,access});
 const base=context({erp:true}),items=m.resolveManagement(m.MANAGEMENT_ITEMS,base,true);
 assert.equal(m.managementLanding(items),'/app/erp/cadastros-reais?cadastro=contacts');
 assert.ok(items.every(item=>item.module==='erp'));
 assert.equal(m.managementLanding(m.resolveManagement(m.MANAGEMENT_ITEMS,context(all),true)),'/app/erp/visao-geral');
 const native=m.resolveManagement(m.MANAGEMENT_ITEMS,context({os:true,juridico:true}),true);
 assert.ok(native.length>0);assert.ok(native.every(item=>item.target.kind==='native'));assert.ok(m.managementLanding(native));
 assert.equal(m.managementEntryState(context({}),[]),'empty');
 assert.deepEqual(m.resolveManagement(m.MANAGEMENT_ITEMS,{...base,statusLoaded:false},true),[]);
 for(const path of ['/documentos-empresa?tipo=sales_orders','/cadastros-reais?cadastro=products','/preferencias/importacoes/produtos','/financeiro-empresa?area=remessas','/frente-caixa-empresa'])assert.equal(m.portedTargetState(path,base,true),'disabled',path);
 assert.equal(m.portedTargetState('/manutencao-efeitos',base,true),'allowed');
 assert.equal(m.portedTargetState('/financeiro-empresa',context(all,'member',['erp:vendas']),true),'denied');
 const renamed=m.MANAGEMENT_ITEMS.map(item=>({...item,label:'Rótulo traduzido'}));
 assert.deepEqual(m.resolveManagement(renamed,context(all),true).map(item=>item.id),m.resolveManagement(m.MANAGEMENT_ITEMS,context(all),true).map(item=>item.id));
});

test('transição ignora postagem nova suspensa e conserva a autorização de estorno histórico',()=>{
 const actions=['reverse_stock','reverse_finance','post_stock','post_finance'];
 m.setErpModuleContext({...all,'erp-estoque':false,'erp-financeiro':false});
 assert.deepEqual(m.availableTransitionActions(actions,{stock:false,finance:false}),[]);
 assert.deepEqual(m.availableTransitionActions(actions,{stock:true,finance:true}),['reverse_stock','reverse_finance']);
 assert.deepEqual(actions,['reverse_stock','reverse_finance','post_stock','post_finance']);
 m.setErpModuleContext(all);assert.deepEqual(m.availableTransitionActions(actions,{stock:true,finance:true}),actions);
});

test('zero chamadas de rede e de simulação para famílias suspensas, desconhecidas ou externas',async()=>{
 const previous=globalThis.location;globalThis.location=new URL('https://painel.invalid/app/erp');
 let network=0,simulated=0;const api='/api/v1/profiles/f2-network/erp';
 const release=m.setPanelPartsContext(api,{erp:true});
 const fetcher=m.createFetchPort({apiUrl:api,fetchImpl:async()=>{network++;return Response.json({ok:true});},simulate:()=>{simulated++;return null;}});
 try{
  for(const path of ['/v1/cadastros/products','/v1/documentos/sales_orders','/v1/documentos/purchase_orders','/v1/estoque/saldos','/v1/financeiro','/v1/notas-fiscais','/v1/cnab','/v1/frente-caixa','/v1/system/updates','/v1/nao-existe']){
   const response=await fetcher(api+path);assert.equal(response.status,409,path);assert.equal((await response.json()).error.code,'module_disabled');
  }
  assert.equal(network,0);assert.equal(simulated,0);
  assert.equal((await fetcher(api+'/v1/cadastros/contacts')).status,200);assert.equal(network,1);
 }finally{release();globalThis.location=previous;}
});

test('controlador preserva os erros originais e só aplica o portão de partes com contexto explícito',async()=>{
 const session={access_token:'synthetic-token',user:{id}};
 const auth={getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})};
 const calls=[];
 const controller=m.createAccessController(auth,'https://api.invalid',async(url)=>{
  if(url.endsWith('/v1/me'))return Response.json({user_id:id,role:'admin',resources:['contacts','products'],data_mode:'staging_readonly'});
  calls.push(url);return Response.json({ok:true});
 });
 const stop=controller.start();
 try{
  for(let tries=0;tries<100&&controller.getSnapshot().phase!=='ready';tries++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(controller.getSnapshot().phase,'ready');
  // O controlador sem hospedeiro continua utilizável com a API original.
  assert.deepEqual(await controller.documents('/v1/documentos/retido'),{ok:true});
  m.setErpModuleContext(all);
  for(const path of ['/v1/documentos/retido','/v1/documentos/desconhecido'])await assert.rejects(()=>controller.documents(path),e=>e instanceof m.AccessError&&e.status===409&&e.code==='module_disabled');
  m.setErpModuleContext({erp:true});
  for(const path of ['https://foreign.invalid/v1/documentos','/v1/documentos/../financeiro','/v1/documentos/%2e%2e/financeiro','/v1/financeiro'])await assert.rejects(()=>controller.documents(path),e=>e instanceof m.AccessError&&e.status===400);
  await assert.rejects(()=>controller.documents('/v1/documentos/sales_orders'),e=>e instanceof m.AccessError&&e.status===409&&e.code==='module_disabled');
  assert.equal(calls.length,1);
  await controller.logout();
  await assert.rejects(()=>controller.documents('/v1/documentos/sales_orders'),e=>e instanceof m.AccessError&&e.status===401);
  assert.equal(calls.length,1);
 }finally{stop();}
});

test('troca de área/partes revoga resposta pendente, corpo já recebido e callbacks antigos',async()=>{
 const previous=globalThis.location;globalThis.location=new URL('https://painel.invalid');
 const api='/api/v1/profiles/f2-generation/erp';let resolve,started;
 const dispatched=new Promise(done=>{started=done;});
 const release=m.setPanelPartsContext(api,all);
 const fetcher=m.createFetchPort({apiUrl:api,fetchImpl:()=>{started();return new Promise(done=>{resolve=done;});}});
 try{
  const pending=fetcher(api+'/v1/cadastros/products');await dispatched;
  const next=m.setPanelPartsContext(api,{erp:true});resolve(Response.json({secret:'old'}));await assert.rejects(pending,{name:'AbortError'});
  next();await assert.rejects(fetcher(api+'/v1/cadastros/contacts'),{name:'AbortError'});
  const abort=new AbortController();let stream;
  const response=await m.contextBoundResponse(new Response(new ReadableStream({start(c){stream=c;}})),abort.signal);
  const body=response.text();abort.abort();await assert.rejects(body,{name:'AbortError'});assert.equal(response.ok,false);
  void stream;
 }finally{release();globalThis.location=previous;}
});

test('formulário conserva os valores ocultos; envio omite vínculos, sem null ou zero inventado',()=>{
 const draft={name:'Cliente',account_id:id,category_id:id,finance_category_id:id,warehouse_id:id,credit_limit_mode:'value',credit_limit:'100.00',commission_rate:'5',installments:[{amount:'50.00',due_date:'2026-12-01',payment_method_id:id,details:{account_id:id,fee_amount:'2.00'}}]};
 const before=structuredClone(draft);m.setErpModuleContext({erp:true,'erp-produtos':true,'erp-vendas':true});
 const sent=m.availablePayload(draft);assert.deepEqual(draft,before);
 assert.equal(Object.hasOwn(sent,'account_id'),false);assert.equal(Object.hasOwn(sent,'warehouse_id'),false);assert.equal(Object.hasOwn(sent,'credit_limit'),false);
 for(const key of ['finance_category_id','credit_limit_mode','operation_nature_id']){assert.equal(m.fieldEnabled(key),false,key);assert.equal(Object.hasOwn(sent,key),false,key);}
 assert.deepEqual(sent.installments,[{amount:'50.00',due_date:'2026-12-01',payment_method_id:id,details:{}}]);
 assert.deepEqual(m.availablePayload({category_id:id},'erp-produtos'),{category_id:id});
 m.setErpModuleContext(all);assert.deepEqual(m.availablePayload(draft),before);
});

test('preferências parciais validam campos presentes e não criam mudanças para campos ocultos',()=>{
 m.setErpModuleContext({...all,'erp-financeiro':false,'erp-cobranca':false});
 const page=m.storedPreferencePage('vendas-vendas'),fields=m.storedFields(page),shown=fields.filter(f=>m.preferenceFieldEnabled(page.id,f.key));
 const raw={scope:'preferences_page',data_mode:'erp_native',page:page.id,owner:page.scope,role:'admin',can_manage:true,items:shown.map(f=>({key:f.key,value:structuredClone(f.default),version:0,updated_at:null})),directory:null,...(m.pageSituationKinds(page).length?{situations:[]}:{}),unavailable_parts:['finance','billing']};
 if(fields.some(f=>f.kind==='users')&&shown.some(f=>f.kind==='users'))raw.directory=[];
 const view=m.parsePreferencesPage(raw,page.id),draft=m.draftOf(view);
 assert.equal(view.items.length,shown.length);assert.ok(shown.length<fields.length);
 for(const f of fields.filter(f=>!shown.includes(f)))draft[f.key]=null;
 assert.deepEqual(m.draftState(page,view,draft),{changes:[],invalid:[],dirty:false});
 assert.throws(()=>m.parsePreferencesPage({...raw,items:[]},page.id));
 assert.throws(()=>m.parsePreferencesPage({...raw,unavailable_parts:['desconhecida']},page.id));
 if(!m.pageSituationKinds(page).length)assert.throws(()=>m.parsePreferencesPage({...raw,situations:[]},page.id));
});

test('contato salva campos cadastrais com financeiro suspenso e conserva o rascunho oculto ao religar',async()=>{
 const oldDocument=globalThis.document;globalThis.document={getElementById:()=>null};
 const record={id,entity:'contacts',version:4,active:true,name:'Cliente',person_type:'F',situation:'A',types:[],persons:[],credit_limit_mode:'value',credit_limit:'100.00',finance_category_id:id};
 let financialReads=0,saved;const writes=[];
 const controller={getSnapshot:()=>({phase:'ready',membership:{user_id:id,role:'admin'}}),
  preferences:async()=>({items:[{key:'contatos.campos_obrigatorios',value:['limite_credito'],version:1}]}),
  finance:async()=>{financialReads++;return {items:[]};},fiscalInvoices:async()=>({items:[]}),
  catalog:async(path,options={})=>{
   if(path==='/v1/cadastros/tipos-contato')return {items:[]};
   if(path.endsWith('/conferir'))return {entity:'contacts',warnings:[],data_mode:'erp_native'};
   if(options.method)writes.push(options.body);
   return {entity:'contacts',record:{...record,version:5},data_mode:'erp_native',replayed:false};
  }};
 m.setErpModuleContext(all);
 const ui=await mountComponent('ContactEditor.tsx',{controller,record,writable:true,onClose(){},onSaved(value){saved=value;}},{...harness,componentName:'ContactForm'});
 try{
  assert.equal(financialReads,2);
  await ui.change('contact-credit_limit','inválido');
  m.setErpModuleContext({erp:true});await ui.updateProps({writable:true});
  assert.equal(ui.nodes().some(n=>n.props.id==='contact-credit_limit'),false);
  await ui.change('contact-name','Cliente atualizado');await ui.submit();
  assert.equal(writes.length,1);assert.equal(saved.id,id);assert.equal(writes[0].data.name,'Cliente atualizado');
  for(const key of ['credit_limit_mode','credit_limit','finance_category_id'])assert.equal(Object.hasOwn(writes[0].data,key),false,key);
  assert.equal(financialReads,2);
  m.setErpModuleContext(all);await ui.updateProps({writable:true});
  assert.equal(ui.input('contact-credit_limit').props.value,'inválido');assert.equal(financialReads,4);
  assert.equal(record.finance_category_id,id);assert.equal(record.credit_limit,'100.00');
 }finally{ui.unmount();globalThis.document=oldDocument;}
});

test('ausência de vendas/estoque/financeiro não vira número zero nos modelos',()=>{
 const period={key:'hoje',from:'2026-11-19',to:'2026-11-19',day_count:1,grain:'day',sales:null,receivable:null,payable:null,invoices:null,points:[{bucket:'2026-11-19',sales_cents:null,receivable_cents:null,payable_cents:null}]};
 assert.equal(m.homeChartValues(period),null);assert.deepEqual(m.homeSalesLines(null),[]);
 const chart=m.homeChart(period);assert.deepEqual(chart.series,[]);assert.deepEqual(chart.groups[0].bars,[]);
 assert.throws(()=>m.responseModules({unavailable_parts:['stock','stock']}));
});

test('favorito indisponível fica salvo, não é exibido, e reaparece ao religar',async()=>{
 const shortcuts=['/cadastros-reais?cadastro=contacts','/cadastros-reais?cadastro=products'];const calls=[];
 const controller={home:async(path,options)=>{calls.push({path,options});return {scope:'home_shortcuts',data_mode:'erp_native',role:'admin',version:1,customized:true,shortcuts,available:shortcuts};}};
 m.setErpModuleContext({erp:true});
 const ui=await mountComponent('HomeFavorites.tsx',{controller,access:null},{...harness,componentName:'HomeFavorites'});
 try{assert.equal(ui.nodes().filter(n=>n.type==='test-router-link').length,1);assert.deepEqual(shortcuts,['/cadastros-reais?cadastro=contacts','/cadastros-reais?cadastro=products']);assert.equal(calls.filter(c=>c.options?.method==='POST').length,0);
  m.setErpModuleContext(all);await ui.updateProps({access:{role:'admin',resources:['contacts','products']}});
  assert.equal(ui.nodes().filter(n=>n.type==='test-router-link').length,2);
 }finally{ui.unmount();}
});

test('histórico comercial e produtos próximos da validade não consultam partes desligadas',async()=>{
 m.setErpModuleContext({erp:true});let calls=0;const controller={catalog:async()=>{calls++;throw new Error('não deve consultar');},system:async()=>{calls++;throw new Error('não deve consultar');},getSnapshot:()=>({phase:'ready',membership:{user_id:id,role:'admin'}})};
 const history=await mountComponent('ContactSalesHistory.tsx',{controller,contactId:id,role:'admin'},{...harness,componentName:'ContactSalesHistory'});
 const expiry=await mountComponent('HomeExpiring.tsx',{controller,role:'admin'},{...harness,componentName:'HomeExpiring'});
 try{assert.equal(calls,0);}finally{history.unmount();expiry.unmount();}
});

test('manutenção só prepara ações liberadas, exige versões e reaproveita a prévia original',()=>{
 const origin={type:'sales_orders',id};
 const view=m.readMaintenance({origin,origin_version:4,links:{stock:[{id:posting,version:2,state:'active'}]},blockers:[{kind:'stock',count:1}],operations:['document_stock_reverse','document_stock_reverse_preview']},origin);
 const choices=m.maintenanceChoices(view);assert.equal(choices.length,1);
 const input={reason:'Cancelamento solicitado',day:'2026-11-19'};
 const args=m.maintenanceArgs(view,choices[0],input,{preview_hash:'a'.repeat(64)});
 assert.deepEqual(args,{p_document_id:id,p_expected_version:4,p_kind:'sales_orders',p_posting_id:posting,p_posting_version:2,p_occurred_on:input.day,p_reason:input.reason,p_preview_hash:'a'.repeat(64)});
 assert.throws(()=>m.maintenanceArgs({...view,origin_version:undefined},choices[0],input),/versão/);
 assert.throws(()=>m.maintenanceArgs({...view,operations:[]},choices[0],input),/liberada/);
 assert.throws(()=>m.maintenanceArgs(view,choices[0],input,{preview_hash:'inventado'}),/Prévia/);
 assert.throws(()=>m.readMaintenance({...view,operations:['erp_document_stock_post']},origin));
 assert.deepEqual(m.maintenanceChoices({...view,operations:[]}),[]);
});

test('manutenção usa versões dos títulos da nota e a sequência da remessa consultada',()=>{
 const input={reason:'Compensação solicitada',day:'2026-11-19'};
 const invoice=m.readMaintenance({origin:{type:'nfe',id},origin_version:3,links:{finance:[{id:posting,version:2,state:'active',titles:[{id,version:7}]}]},blockers:[],operations:['invoice_finance_reverse']},{type:'nfe',id});
 const invoiceChoice=m.maintenanceChoices(invoice)[0];
 assert.deepEqual(m.maintenanceArgs(invoice,invoiceChoice,input).p_data,{invoice_id:id,posting_id:posting,expected_version:2,titles:[{id,version:7}],reason:input.reason});
 assert.throws(()=>m.maintenanceArgs(invoice,{...invoiceChoice,target:{...invoiceChoice.target,titles:[]}},input),/versões/);
 const remittance=m.readMaintenance({origin:{type:'remittance',id},links:{remittances:[{id,sequence:'42'}]},blockers:[],operations:['remittance_exclude']},{type:'remittance',id});
 assert.deepEqual(m.maintenanceArgs(remittance,m.maintenanceChoices(remittance)[0],input),{p_data:{id,sequence:'42'}});
 assert.deepEqual(m.maintenanceChoices({...remittance,links:{remittances:[]}}),[]);
});

test('manutenção pede prévia, apresenta alvo e bloqueadores e só escreve após confirmação concreta',async()=>{
 m.setErpModuleContext({erp:true});const calls=[];let last;
 const controller={maintenance:async(path,options={})=>{calls.push({path,...options});if(options.method!=='POST')return {origin:{type:'sales_orders',id},origin_version:4,links:{stock:[{id:posting,version:2,state:'active'}]},blockers:[{kind:'stock',count:1}],operations:['document_stock_reverse','document_stock_reverse_preview']};
  if(options.body.action.endsWith('_preview'))return {data_mode:'erp_native',preview:{preview_hash:'a'.repeat(64),positions:[{product_name:'Produto',quantity:'1',balance_before:'2',balance_after:'3'}]}};
  last=options.body;return {data_mode:'erp_native',action:'reverse',replayed:false,document_id:id};}};
 const ui=await mountComponent('ErpEffectMaintenance.tsx',{controller},{...harness,location:`/manutencao-efeitos?tipo=sales_orders&id=${id}&versao=4`});
 try{
  await ui.click('Consultar vínculos');assert.match(ui.text(),/Impedimentos/);assert.equal(calls.length,1);
  ui.find(n=>n.type==='textarea').props.onChange({target:{value:'Cancelamento solicitado'}});await ui.flush();
  await ui.click('Estornar estoque do documento');assert.equal(calls.length,2);assert.equal(calls[1].body.action,'document_stock_reverse_preview');assert.match(ui.text(),new RegExp(posting));assert.equal(last,undefined);
  await ui.click('Confirmar esta operação');assert.equal(last.action,'document_stock_reverse');assert.match(last.args.p_command_id,/^[0-9a-f-]{36}$/);assert.equal(last.args.p_preview_hash,'a'.repeat(64));assert.match(ui.text(),/Operação confirmada/);
 }finally{ui.unmount();}
});
