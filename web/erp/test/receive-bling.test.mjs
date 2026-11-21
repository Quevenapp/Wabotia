import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {BLING_OPERATIONS, statusSchema, resourceDescriptorSchema, recordViewSchema} from '../../../src/erp/bling/schema.ts';
import {erpDestinationRequirement} from '../../../src/erp/parts-requirements.ts';
import {createHash} from 'node:crypto';
import {STATE_LABELS} from '../app/lib/receive-bling.ts';
import {BlingError} from '../../../src/erp/bling/contracts.ts';

const now='2026-11-19T12:00:00.000Z', hash='a'.repeat(64), copy=value=>structuredClone(value);
const coverage={complete:false,observed:2,changed:1,pending:1,last_pass_started_at:now,last_pass_completed_at:null,freshness_at:null,limitations:['Referências de anexos não são arquivos arquivados.']};
const selection={key:'products',selected:true,from:'2026-01-01',to:null};
const configuration={revision:'1',generation:'1',authorization_revision:'1',collect_enabled:false,account:{id:'empresa-1',name:'Empresa de teste',confirmed_at:now},selections:[selection],daily_call_limit:20000,min_interval_ms:700,access:{reader_user_ids:[],bots:[],customer_delivery:{enabled:false,entities:[],require_verified_identity:true}},approval:null,credential:{configured:true,authorized:true,revision:'1',expires_at:null,scopes:['leitura-conferida'],uncertain:false}};
const status={state:'off',configuration, next_wake:null,capabilities:{configured:true,collect:true,archive:true,xml:true,purge:true},coverage,occupancy:{database_bytes:123456,archive_estimated_bytes:4000,xml_bytes:2000,ceiling_bytes:10000000000,warning_ratio:0.7,stop_ratio:0.8,projected_bytes:null},last_error:null};
const resource={key:'products',entity:'products',path:'/produtos',pagination:{strategy:'page',page_size:10,limit_parameter:true,short_page_ends:true},detail:{path:'/produtos/{id}',required:true},dateFilter:{kind:'M',from:'dataAlteracaoInicial',to:'dataAlteracaoFinal',time_zone:'America/Sao_Paulo',overlap_minutes:15},variants:[],deletedEvidence:'explicit_deleted_variant',identityRule:{kind:'global',parent_entity:null},parser:'price',scopeRequirements:['leitura-conferida'],confirmation:'oficial_confirmado',officialEvidence:{url:'https://documentacao.invalid/recurso-conferido',checked_at:now,scopes_checked:true,identity_checked:true,limits_checked:true},defaultSelected:false};
const unconfirmed={...resource,key:'contracts',entity:'contracts',path:null,pagination:null,detail:null,dateFilter:null,deletedEvidence:null,identityRule:{kind:'unconfirmed',parent_entity:null},parser:null,scopeRequirements:[],confirmation:'nao_confirmado',officialEvidence:null};
const metadata={identity:{profile:'area-teste',account_id:'empresa-1',entity:'products',source_id:'9007199254740993123'},version:'2',semantic_hash:hash,payload_bytes:67,first_observed_at:now,last_observed_at:now,source_updated_at:null,source_time_quality:'unknown',deleted:false,mapper_version:null,capture_revision:null};
const record={raw:{identity:metadata.identity,version:'2',semantic_hash:hash,payload_text:'{"id":"9007199254740993123","preco":12345678901234567890.123456789}',document_links:[],observed_at:now,source_updated_at:null,source_time_quality:'unknown',deleted:false,deletion_evidence:null,capture:null},metadata,historical:{label:'Consulta histórica — não opera no ERP',kind:'products',fields:{nome:'Produto de teste',preco:'12345678901234567890.123456789'},unresolved_references:[{entity:'contacts',source_id:'7'}],unmapped_fields:['campo_sem_destino'],coverage},existing_links:[]};
const previousMetadata={...metadata,version:'1',semantic_hash:'b'.repeat(64)};
const previousRecord={...record,metadata:previousMetadata,raw:{...record.raw,version:'1',semantic_hash:previousMetadata.semantic_hash,payload_text:'{"id":"9007199254740993123","preco":7.000000001}'},historical:{...record.historical,fields:{nome:'Produto anterior',preco:'7.000000001'}}};
const xmlBytes=new TextEncoder().encode('<NFe>Arquivo simulado</NFe>'),xmlHash=createHash('sha256').update(xmlBytes).digest('hex');
const xml={object_id:'objeto-xml',entity:'nfe',source_id:'1',access_key:'1'.repeat(44),model:'55',environment:'production',version:'1',sha256:xmlHash,bytes:xmlBytes.length,available:true,coverage:['Estrutura conferida; assinatura criptográfica não certificada.']};
const receipt=(operation,input)=>({command_id:input.command_id,request_hash:hash,generation:'1',operation,state:'committed',committed_at:now,references:{},counts:{},error:null});
const controller={getSnapshot:()=>({phase:'ready',membership:{user_id:'pessoa-teste',role:'admin',resources:[]}}),subscribe:()=>()=>{}};
function service({initial=status,blocked=0,fail=null,xmlItems=[xml]}={}){
 const state=copy(initial),calls=[],receipts=new Map(),waiting=new Map();
 const client={async execute(name,input){
  BLING_OPERATIONS[name].input.parse(input);calls.push({name,input:copy(input)});waiting.get(name)?.();waiting.delete(name);if(fail)throw fail;
  let value;
  if(name==='erp_bling_status')value=state;
  else if(name==='erp_bling_resources')value={version:'1',resources:[resource,unconfirmed],selections:state.configuration.selections,limitations:['Cobertura incompleta.']};
  else if(name==='erp_bling_records_list')value={items:[metadata],next_cursor:null};
  else if(name==='erp_bling_versions_list')value={items:[metadata,previousMetadata],next_cursor:null};
  else if(name==='erp_bling_record_get')value=input.version==='1'?previousRecord:record;
  else if(name==='erp_bling_xml_list')value={items:xmlItems,next_cursor:null};
  else if(name==='erp_bling_xml_get')value={bytes:xmlBytes,sha256:xmlHash,filename:'nota.xml',content_type:'application/xml'};
  else if(name==='erp_bling_purge_preview')value={generation:'1',preview_hash:hash,counts:{records:2,versions:1},files:1,blocked_references:blocked};
  else if(name==='erp_bling_command_get')value={phase:'committed',receipt:receipts.get(input.id)??null};
  else if(name==='erp_bling_purge_apply'){value={work_id:'apagamento-1',receipt:receipt(name,input)};receipts.set(input.command_id,value.receipt);state.state='purging';}
  else if(name==='erp_bling_collect_request'){value={run_id:'rodada-1',next_wake:null,receipt:receipt(name,input)};receipts.set(input.command_id,value.receipt);}
  else if(name==='erp_bling_oauth_start')value={authorization_url:'https://autorizacao.invalid/conta',expires_at:Date.parse(now)+600000};
  else if(name==='erp_bling_app_save'){value={configured:true,revision:'2',callback_url:'https://instalacao.invalid/api/public/erp-bling/area-teste/callback',receipt:receipt(name,input)};receipts.set(input.command_id,value.receipt);}
  else {if(name==='erp_bling_configure'){state.configuration={...state.configuration,selections:input.selections,daily_call_limit:input.daily_call_limit,access:input.access};}value={configuration:state.configuration,receipt:receipt(name,input),...(name==='erp_bling_disconnect'?{revocation_guidance:'Revogue no aplicativo autorizado no Bling.'}:{})};receipts.set(input.command_id,value.receipt);}
  return copy(BLING_OPERATIONS[name].output.parse(value));
 }};
 return{client,calls,state,when(name){return calls.some(call=>call.name===name)?Promise.resolve():new Promise(resolve=>waiting.set(name,resolve));}};
}
const mount=(server,administrator=true)=>mountComponent('ReceiveBling.tsx',{client:server.client,controller,administrator},{componentName:'ReceiveBling',expandChildren:true});
const administrative=new Set(Object.values(BLING_OPERATIONS).filter(operation=>operation.permission==='admin').map(operation=>operation.name));

test('fixtures do painel obedecem aos DTOs da base e conservam precisão lexical',()=>{
 statusSchema.parse(status);resourceDescriptorSchema.parse(resource);resourceDescriptorSchema.parse(unconfirmed);recordViewSchema.parse(record);recordViewSchema.parse(previousRecord);
 assert.match(record.raw.payload_text,/12345678901234567890\.123456789/);
 assert.equal(record.raw.identity.source_id,'9007199254740993123');
});

test('quatro abas são acessíveis e só consultam dados pela operação do sistema',async()=>{
 const server=service(),view=await mount(server);
 try{
  for(const name of ['Configuração','Progresso e cobertura','Acervo','Histórico fiscal']){
   const tab=view.button(name);assert.equal(tab.props.role,'tab');assert.ok(tab.props['aria-controls']);
   await view.click(name);assert.equal(view.button(name).props['aria-selected'],true);
   assert.ok(view.nodes().some(node=>node.props.role==='tabpanel'));
  }
  assert.ok(server.calls.some(call=>call.name==='erp_bling_xml_list'));
  assert.equal(server.calls.filter(call=>administrative.has(call.name)).length,0);
  assert.doesNotMatch(view.text(),/Fagoo|Origin/);
  assert.match(view.text(),/Consulta histórica — não opera no ERP/);
 }finally{view.unmount();}
});

test('Base ligada conserva o destino com todas as partes operacionais desligadas',()=>{
 const requirement=erpDestinationRequirement('/receber-bling');
 assert.deepEqual(requirement.requirement.all,['erp']);
 const menu=readFileSync(new URL('../../../src/modules/erp/panel-menu.ts',import.meta.url),'utf8');
 assert.match(menu,/Receber dados do Bling/);assert.match(menu,/receber-bling/);
});

test('pessoa sem administrador vê consultas e não despacha controles administrativos',async()=>{
 const server=service(),view=await mount(server,false);
 try{
  for(const node of view.nodes().filter(node=>node.type==='button')){
   const text=typeof node.props.children==='string'?node.props.children:'';
   if(/Ligar|Desligar|Autorizar|Desconectar|Apagar|Salvar|Pedir.*coleta/i.test(text))assert.equal(node.disabled,true);
  }
  await view.click('Acervo');await view.click('Histórico fiscal');
  assert.equal(server.calls.filter(call=>administrative.has(call.name)).length,0);
 }finally{view.unmount();}
});

test('recurso não confirmado permanece visível e desabilitado; a data explicita alteração e ausência de filtro',async()=>{
 const server=service(),view=await mount(server);
 try{
  assert.match(view.text(),/Contratos/);assert.match(view.text(),/conferir|confirmad/i);assert.match(view.text(),/alteração/i);
  const resourceInputs=view.nodes().filter(node=>node.type==='input'&&node.props.type==='checkbox'&&String(node.props.id).includes('contracts'));
  assert.equal(resourceInputs.length,1);assert.equal(resourceInputs[0].disabled,true);
  assert.match(view.text(),/sem filtro temporal/i);
  assert.equal(server.calls.filter(call=>administrative.has(call.name)).length,0);
 }finally{view.unmount();}
});

test('estimativas sem evidência e capacidade são anunciadas sem percentual de migração concluída',async()=>{
 const server=service({initial:{...status,state:'blocked_capacity',next_wake:Date.parse(now)+60000}}),view=await mount(server);
 try{
  await view.click('Progresso e cobertura');
  assert.match(view.text(),/desconhecid|não disponíve|sem evidência/i);
  assert.match(view.text(),/70%/);assert.match(view.text(),/80%/);
  assert.ok(view.nodes().some(node=>node.props.role==='status'||node.props.role==='alert'));
  assert.doesNotMatch(view.text(),/migração concluída|100% concluído/i);
 }finally{view.unmount();}
});

test('manifesto declara cada arquivo próprio do painel e o teste novo',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../ORIGEM.json',import.meta.url),'utf8'));
 for(const path of ['web/erp/app/components/ReceiveBling.tsx','web/erp/app/components/receive-bling.css','web/erp/app/lib/receive-bling.ts','web/erp/app/components/RealAccess.tsx','web/erp/app/components/native-modules.ts','web/erp/app/lib/integration-capabilities.ts','web/erp/test/receive-bling.test.mjs'])assert.ok(manifest.local[path],path);
});

test('apagamento exige prévia e confirmação do hash exato antes do comando',{timeout:120000},async()=>{
 const server=service(),view=await mount(server);
 try{
  assert.equal(server.calls.filter(call=>call.name==='erp_bling_purge_apply').length,0);
  await view.click('Preparar prévia de apagamento');
  const preview=server.calls.find(call=>call.name==='erp_bling_purge_preview');
  assert.equal(preview.input.generation,'1');assert.deepEqual(preview.input.scope,{all:true,entities:[]});
  assert.match(view.text(),new RegExp(hash));assert.equal(view.button('Apagar conteúdo da prévia').disabled,true);
  await view.change('bling-purge-confirm',true);await view.change('bling-purge-hash','b'.repeat(64));
  assert.equal(view.button('Apagar conteúdo da prévia').disabled,true);
  await view.change('bling-purge-hash',hash);await view.click('Apagar conteúdo da prévia');
  await server.when('erp_bling_purge_apply');await view.flush();
  const applied=server.calls.filter(call=>call.name==='erp_bling_purge_apply');assert.equal(applied.length,1);
  assert.equal(applied[0].input.preview_hash,hash);assert.equal(applied[0].input.generation,preview.input.generation);assert.deepEqual(applied[0].input.scope,preview.input.scope);assert.equal(applied[0].input.confirmed,true);
 }finally{view.unmount();}
});

test('referência operacional impeditiva mantém apagamento bloqueado apesar da confirmação',async()=>{
 const server=service({blocked:1}),view=await mount(server);
 try{
  await view.click('Preparar prévia de apagamento');
  assert.match(view.text(),/referênc/i);assert.equal(view.button('Apagar conteúdo da prévia').disabled,true);
  assert.equal(server.calls.filter(call=>call.name==='erp_bling_purge_apply').length,0);
 }finally{view.unmount();}
});

test('falhas arbitrárias não são repetidas na tela nem permitem ações durante indisponibilidade',async()=>{
 const privateValue=globalThis.crypto.randomUUID(),server=service({fail:new Error(privateValue)}),view=await mount(server);
 try{
  assert.ok(!view.text().includes(privateValue));assert.ok(view.nodes().some(node=>node.props.role==='alert'));
  assert.equal(server.calls.filter(call=>administrative.has(call.name)).length,0);
 }finally{view.unmount();}
});


test('todos os estados globais têm descrição anunciada e mantêm o acervo separado do ERP',async()=>{
 const server=service(),view=await mount(server);
 try{
  for(const [state,label] of Object.entries(STATE_LABELS)){
   server.state.state=state;await view.click('Atualizar dados');
   assert.ok(view.text().includes(label),state);
   assert.ok(view.nodes().some(node=>node.props.role==='status'||node.props.role==='alert'),state);
   assert.match(view.text(),/Consulta histórica — não opera no ERP/);
  }
  assert.equal(server.calls.filter(call=>administrative.has(call.name)).length,0);
 }finally{view.unmount();}
});


test('ficha separa bruto lexical, espelho, campos sem destino e consulta da versão anterior',async()=>{
 const server=service(),view=await mount(server);
 try{
  await view.click('Acervo');await view.change('bling-entity','products');await view.submit();
  const listing=server.calls.filter(call=>call.name==='erp_bling_records_list').at(-1);
  assert.equal(listing.input.entity,'products');assert.equal(listing.input.limit,50);
  await view.click(`Ver bruto e espelho ${metadata.identity.source_id}`);
  assert.match(view.text(),/Espelho histórico/);assert.match(view.text(),/Bruto recebido/);
  const preserved=view.nodes().filter(node=>node.type==='pre').map(node=>node.props.children);
  assert.ok(preserved.includes(record.raw.payload_text));
  assert.ok(preserved.some(text=>text.includes('"preco": "12345678901234567890.123456789"')));
  assert.match(view.text(),/Campos sem destino/);assert.match(view.text(),/campo_sem_destino/);
  assert.match(view.text(),/Referências não resolvidas/);assert.match(view.text(),/Consulta histórica — não opera no ERP/);
  assert.equal(view.button('Mais versões').disabled,true);
  await view.click('Consultar versão 1');
  const historical=server.calls.filter(call=>call.name==='erp_bling_record_get').at(-1);
  assert.deepEqual(historical.input,{entity:'products',id:metadata.identity.source_id,version:'1'});
  assert.ok(view.nodes().some(node=>node.type==='pre'&&node.props.children===previousRecord.raw.payload_text));
  assert.match(view.text(),/Produto anterior/);
  assert.equal(server.calls.filter(call=>administrative.has(call.name)).length,0);
  assert.ok(view.nodes().filter(node=>node.type==='button').every(node=>!['Editar','Faturar','Baixar','Receber compra','Abrir estoque','Emitir','Adotar'].includes(node.props.children)));
 }finally{view.unmount();}
});

test('XML indisponível é anunciado, mantém identidade e impede download',async()=>{
 const server=service({xmlItems:[{...xml,available:false}]}),view=await mount(server);
 try{
  await view.click('Histórico fiscal');
  assert.match(view.text(),/NF-e · modelo 55 · Produção/);assert.match(view.text(),new RegExp(xml.access_key));
  assert.match(view.text(),/XML: Indisponível/);assert.equal(view.button('Baixar XML 1').disabled,true);
  assert.match(view.text(),/não certifica assinatura criptográfica nem autorização fiscal/);
  assert.equal(server.calls.filter(call=>call.name==='erp_bling_xml_get').length,0);
 }finally{view.unmount();}
});

test('falha DTO comum mostra mensagem local do código e próximo horário, sem confiar em texto arbitrário',async()=>{
 const failure=new BlingError('BLING_SCOPE_REQUIRED',{retry_at:Date.parse(now)+60000}).toJSON();
 const server=service({initial:{...status,state:'blocked_scope',next_wake:failure.retry_at,last_error:failure}}),view=await mount(server);
 try{
  await view.click('Progresso e cobertura');assert.ok(view.text().includes(failure.message));
  assert.match(view.text(),/Próxima tentativa:/);assert.match(view.text(),/19\/11\/2026/);
  assert.equal(server.calls.filter(call=>administrative.has(call.name)).length,0);
 }finally{view.unmount();}
});


test('salvar aplicativo limpa os campos privados e apresenta somente o retorno público copiável',{timeout:120000},async()=>{
 const server=service(),view=await mount(server),clientId=globalThis.crypto.randomUUID(),clientSecret=globalThis.crypto.randomUUID();
 try{
  assert.equal(view.button('Copiar retorno').disabled,true);
  await view.change('bling-client-id',clientId);await view.change('bling-client-secret',clientSecret);await view.submit();
  await server.when('erp_bling_app_save');await view.flush();
  assert.equal(view.input('bling-client-id').props.value,'');assert.equal(view.input('bling-client-secret').props.value,'');
  assert.equal(view.input('bling-callback').props.value,'https://instalacao.invalid/api/public/erp-bling/area-teste/callback');
  assert.equal(view.button('Copiar retorno').disabled,false);assert.ok(!view.text().includes(clientId));assert.ok(!view.text().includes(clientSecret));
  assert.equal(server.calls.filter(call=>call.name==='erp_bling_app_save').length,1);
 }finally{view.unmount();}
});

// Achado 5: o formulário do aplicativo produz "configurado"; não pode exigi-lo.
const unconfigured=({account=null,revision='0'}={})=>{const s=copy(status);s.configuration={...s.configuration,revision,authorization_revision:revision,collect_enabled:false,account,selections:[],approval:null,credential:{configured:false,authorized:false,revision,expires_at:null,scopes:[],uncertain:false}};s.capabilities={configured:false,collect:false,archive:true,xml:true,purge:true};return statusSchema.parse(s);};
for(const [scenario,initial] of [['área nova',unconfigured()],['depois de desconectar',unconfigured({account:configuration.account,revision:'4'})],['depois de restaurar',unconfigured({account:configuration.account,revision:'7'})]]){
 test(`achado 5: administrador cadastra o aplicativo ${scenario}, sem aplicativo já configurado`,{timeout:120000},async()=>{
  const server=service({initial}),view=await mount(server),clientId=globalThis.crypto.randomUUID(),clientSecret=globalThis.crypto.randomUUID();
  try{
   assert.match(view.text(),/Ainda não configurado/);
   assert.equal(view.input('bling-client-id').disabled,false);assert.equal(view.input('bling-client-secret').disabled,false);
   await view.change('bling-client-id',clientId);await view.change('bling-client-secret',clientSecret);
   assert.equal(view.button('Salvar aplicativo').disabled,false);
   await view.submit();await server.when('erp_bling_app_save');await view.flush();
   const saved=server.calls.filter(call=>call.name==='erp_bling_app_save');
   assert.equal(saved.length,1);assert.equal(saved[0].input.expected_revision,initial.configuration.revision);
   assert.equal(view.input('bling-callback').props.value,'https://instalacao.invalid/api/public/erp-bling/area-teste/callback');
   assert.ok(!view.text().includes(clientId));assert.ok(!view.text().includes(clientSecret));
  }finally{view.unmount();}
 });
}
test('achado 5: o formulário do aplicativo continua bloqueado com operação pendente ou apagamento em curso',async()=>{
 const purging=service({initial:{...unconfigured(),state:'purging'}}),view=await mount(purging);
 try{assert.equal(view.input('bling-client-id').disabled,true);assert.equal(view.input('bling-client-secret').disabled,true);}finally{view.unmount();}
 const pending=service({initial:unconfigured()});
 pending.client.journal={read:()=>({operation:'erp_bling_disable',command_id:'comando-pendente',expected_revision:'0'}),write(){}};
 const other=await mount(pending);
 try{assert.match(other.text(),/Há uma solicitação sem resultado confirmado/);assert.equal(other.input('bling-client-id').disabled,true);}finally{other.unmount();}
 assert.equal([...purging.calls,...pending.calls].filter(call=>call.name==='erp_bling_app_save').length,0);
});

// Achado 6: recusa por revisão antiga tem recibo terminal; a aba sai do pendente e recarrega.
test('achado 6: recusa por revisão antiga sai do estado pendente, recarrega o estado e libera os comandos',{timeout:120000},async()=>{
 const enabled={...copy(status),configuration:{...copy(configuration),collect_enabled:true}};
 const server=service({initial:enabled}),execute=server.client.execute.bind(server.client),refused=new Map();
 server.client.execute=async(name,input,signal)=>{
  if(name==='erp_bling_disable'){server.calls.push({name,input:copy(input)});refused.set(input.command_id,{command_id:input.command_id,request_hash:hash,generation:'1',operation:name,state:'rejected',committed_at:now,references:{},counts:{},error:new BlingError('BLING_REVISION_CONFLICT').toJSON()});throw new BlingError('BLING_REVISION_CONFLICT');}
  if(name==='erp_bling_command_get'){server.calls.push({name,input:copy(input)});return BLING_OPERATIONS[name].output.parse(refused.has(input.id)?{phase:'blocked',receipt:refused.get(input.id)}:{phase:'absent',receipt:null});}
  return execute(name,input,signal);
 };
 const view=await mount(server);
 try{
  const loads=()=>server.calls.filter(call=>call.name==='erp_bling_status').length,before=loads();
  await view.click('Desligar recebimento');await view.flush();
  assert.equal(server.calls.filter(call=>call.name==='erp_bling_disable').length,1);
  assert.ok(server.calls.some(call=>call.name==='erp_bling_command_get'),'consulta o recibo do próprio comando');
  assert.doesNotMatch(view.text(),/Há uma solicitação sem resultado confirmado/);
  assert.ok(loads()>before,'recarrega o estado atual');
  assert.ok(view.nodes().some(node=>node.props.role==='alert'));
  assert.equal(view.button('Desligar recebimento').disabled,false);assert.equal(view.button('Desconectar conta').disabled,false);
 }finally{view.unmount();}
});

test('achado 6: outra falha HTTP sem recibo terminal conserva a pendência',{timeout:120000},async()=>{
 const enabled={...copy(status),configuration:{...copy(configuration),collect_enabled:true}};
 const server=service({initial:enabled}),execute=server.client.execute.bind(server.client);
 server.client.execute=async(name,input,signal)=>{
  if(name==='erp_bling_disable'){server.calls.push({name,input:copy(input)});throw new BlingError('BLING_REVISION_CONFLICT');}
  if(name==='erp_bling_command_get'){server.calls.push({name,input:copy(input)});return BLING_OPERATIONS[name].output.parse({phase:'absent',receipt:null});}
  return execute(name,input,signal);
 };
 const view=await mount(server);
 try{
  await view.click('Desligar recebimento');await view.flush();
  assert.match(view.text(),/Há uma solicitação sem resultado confirmado/);
  assert.equal(view.button('Desconectar conta').disabled,true);
 }finally{view.unmount();}
});

test('Preferências › Integrações › Mão dupla do Bling abre direto na aba Mão dupla',async()=>{
 const server=service(),adoption={calls:[],async execute(name){adoption.calls.push(name);throw new Error('simulado: sem rede');}};
 const view=await mountComponent('ReceiveBling.tsx',{client:server.client,controller,administrator:true,adoptionClient:adoption,initialTab:'mao-dupla'},{componentName:'ReceiveBling',expandChildren:true});
 try{
  assert.equal(view.button('Mão dupla').props['aria-selected'],true);
  assert.equal(view.button('Configuração').props['aria-selected'],false);
 }finally{view.unmount();}
 const plain=await mount(server);
 try{assert.equal(plain.button('Configuração').props['aria-selected'],true);}finally{plain.unmount();}
});
