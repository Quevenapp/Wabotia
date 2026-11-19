import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {mountComponent} from './helpers/component-recovery-harness.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const bundle=await build({stdin:{contents:`
 export * from './web/erp/blocks.ts';
 export {ERP_MODULE_IDS} from './src/erp/parts.ts';
 export {demoApi} from './web/lib/demo.ts';
 export {createWorkApi} from './web/modules/os/work-api.ts';
 export {assistenciaTecnicaTemplate} from './src/area-templates/models/assistencia-tecnica.ts';
 `,resolveDir:root,loader:'ts'},bundle:true,write:false,platform:'node',format:'esm',jsx:'automatic',loader:{'.css':'empty'},define:{'import.meta.env':'{}'},logLevel:'silent'});
const m=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const all=Object.fromEntries(m.ERP_MODULE_IDS.map(id=>[id,true]));
const replacement=Object.keys(m).map(name=>`export const ${name}=r.parts.${name};`).join('\n');
const partsHarness={ports:{parts:m},modules:{'../../blocks':replacement,'../../blocks.ts':replacement}};
test.afterEach(()=>{m.setErpModuleContext(null);m.setErpBlocks(null);});
const summary=()=>({
 data_mode:'erp_native',as_of:'2026-11-19T12:00:00Z',business_date:'2026-11-19',timezone:'America/Sao_Paulo',role:'admin',
 catalog:[{entity:'contacts',active:2,archived:0},{entity:'products',active:3,archived:0},{entity:'warehouses',active:1,archived:0}],
 documents:[{kind:'sales_orders',count:1,statuses:[{status:'open',count:1}]}],
 stock:{positions:4,positive_positions:3,zero_positions:1,products:3,warehouses:1},
 finance:{titles:['receivable','payable'].map(kind=>({kind,buckets:[{bucket:'today',count:1,balance_cents:'12300'}]})),accounts:{active:1,archived:0,opening_pending:0,recorded_balance_cents:'98765'}},
 period:{key:'hoje',from:'2026-11-19',to:'2026-11-19',day_count:1,grain:'day',
  points:[{bucket:'2026-11-19',sales_cents:'5000',receivable_cents:'12300',payable_cents:'45600'}],
  sales:{count:1,statuses:[{status:'open',count:1,total_cents:'5000'}]},
  receivable:{count:1,total_cents:'12300',open_cents:'12300',fee_cents:'0'},
  payable:{count:1,total_cents:'45600',open_cents:'45600'},invoices:null},
});
function homeServer() {
 const pending=[],listeners=new Set();let state={phase:'ready',membership:{user_id:'demo',role:'admin',resources:['contacts','products','sales_orders','purchase_orders','sales_proposals','receivables','payables']}};
 const controller={getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
  home:(path,options)=>new Promise(resolve=>pending.push({path,signal:options.signal,resolve}))};
 return {controller,pending,change(modules){m.setErpModuleContext(modules);state={...state};listeners.forEach(fn=>fn());}};
}
const mountHome=source=>mountComponent('RealHome.tsx',{controller:source.controller},{...partsHarness,location:'/visao-geral',expandChildren:['HomeView','HomeChart']});
const chart=view=>view.nodes().find(node=>typeof node.type==='function'&&node.type.name==='HomeChartCards');

for(const part of ['erp-financeiro','erp-estoque']) test(`visão geral invalida, recarrega e oculta cartões/atalhos de ${part}`,async()=>{
 m.setErpModuleContext(all);const source=homeServer(),view=await mountHome(source);
 try {
  source.pending[0].resolve(summary());await view.flush();
  assert.match(view.text(),/Caixas e bancos/);assert.match(view.text(),/Posições sem saldo/);
  assert.equal(chart(view).props.period.receivable.open_cents,'12300');
  source.change({...all,[part]:false});await view.flush();
  assert.equal(source.pending.length,2);assert.equal(source.pending[0].signal.aborted,true);
  assert.doesNotMatch(view.text(),/Caixas e bancos|Posições sem saldo/); // Sem resumo antigo durante a recarga.
  // Mesmo uma resposta que ainda contenha todos os campos não autoriza a parte desligada.
  source.pending[1].resolve(summary());await view.flush();
  const urls=view.nodes().map(node=>node.props.to).filter(Boolean);
  if(part==='erp-financeiro') {
   assert.doesNotMatch(view.text(),/Caixas e bancos|Pagamentos|Recebimentos|Contas a receber|Contas a pagar/);
   assert.equal(urls.some(url=>url.startsWith('/financeiro-empresa')),false);
   assert.equal(chart(view).props.period.receivable,null);assert.equal(chart(view).props.period.payable,null);
   assert.equal(chart(view).props.period.points[0].receivable_cents,null);assert.equal(chart(view).props.period.points[0].payable_cents,null);
   assert.match(view.text(),/Posições sem saldo/);
  } else {
   assert.doesNotMatch(view.text(),/Posições sem saldo|Lançamentos de estoque|Produtos com posição controlada/);
   assert.equal(urls.some(url=>url.startsWith('/estoque-empresa')||url.includes('cadastro=warehouses')),false);
   assert.match(view.text(),/Caixas e bancos/);
  }
  source.change(all);await view.flush();assert.equal(source.pending.length,3);
  assert.doesNotMatch(view.text(),/Caixas e bancos|Posições sem saldo/);
  source.pending[2].resolve(summary());await view.flush();
  assert.match(view.text(),/Caixas e bancos/);assert.match(view.text(),/Posições sem saldo/);
 } finally {view.unmount();}
});

test('resposta atrasada da geração anterior não recoloca valores e a Base permanece acessível',async()=>{
 m.setErpModuleContext(all);const source=homeServer(),view=await mountHome(source);
 try {
  source.change({erp:true});await view.flush();assert.equal(source.pending.length,2);
  source.pending[1].resolve(summary());await view.flush();
  source.pending[0].resolve({...summary(),catalog:[{entity:'contacts',active:999,archived:0}]});await view.flush();
  assert.doesNotMatch(view.text(),/999|Caixas e bancos|Posições sem saldo|Vendas no período/);
  assert.match(view.text(),/Clientes e fornecedores/);assert.equal(chart(view),undefined);
  assert.equal(source.pending[0].signal.aborted,true);
 } finally {view.unmount();}
});

for(const part of ['erp-cobranca','erp-pdv']) test(`visão geral atualiza atalhos de ${part} sem repetir a consulta de fontes inalteradas`,async()=>{
 m.setErpModuleContext(all);const source=homeServer(),view=await mountHome(source);
 const urls=()=>view.nodes().map(node=>node.props.to).filter(Boolean);
 try {
  assert.equal(source.pending.length,1);
  source.change({...all,[part]:false});await view.flush();
  assert.equal(source.pending.length,1);assert.equal(source.pending[0].signal.aborted,false);
  if(part==='erp-cobranca')assert.equal(urls().includes('/cobranca-empresa'),false);
  // A resposta em voo continua válida: nenhuma fonte do resumo foi suspensa.
  source.pending[0].resolve(summary());await view.flush();
  assert.match(view.text(),/Caixas e bancos/);assert.match(view.text(),/Posições sem saldo/);
  assert.equal(chart(view).props.period.receivable.open_cents,'12300');
  source.change(all);await view.flush();assert.equal(source.pending.length,1);
  assert.match(view.text(),/Caixas e bancos/);assert.match(view.text(),/Posições sem saldo/);
  if(part==='erp-cobranca')assert.equal(urls().includes('/cobranca-empresa'),true);
 } finally {view.unmount();}
});

const work=m.createWorkApi(m.demoApi,'v1/profiles/demo');
test('demonstração: catálogo e detalhe usam o contrato consumido por Trabalhos',async()=>{
 const catalog=await work.types(true);assert.ok(catalog.settings_revision);assert.equal(catalog.data.length,2);
 const type=await work.type('service_order');assert.deepEqual(catalog.data[0],type);
 const allModels=await work.orders({facets:'1'});assert.equal(allModels.data.length,7);
 assert.deepEqual([...new Set(allModels.data.map(row=>row.type_id))].sort(),catalog.data.map(type=>type.id).sort());
 const list=await work.orders({type_id:'service_order',facets:'1'});assert.equal(list.data.length,5);assert.equal(list.facets.types.service_order,5);
 for(const row of list.data) {
  const order=await work.order(row.id);assert.deepEqual(order,row);
  assert.equal(order.type_id,type.id);assert.deepEqual(order.labels,type.labels);assert.deepEqual(order.features,type.features);
  assert.ok(Array.isArray(order.fields));assert.deepEqual(order.extra,{});assert.equal(order.stage_approval,null);
  assert.equal(typeof order.version,'number');assert.equal(order.display_number,String(order.number));
  assert.equal(type.stages.find(stage=>stage.id===order.stage).label,order.stage_label);
  for(const next of order.next_stages) {
   const transition=type.transitions.find(transition=>transition.id===next.transition_id);
   assert.equal(transition.from,order.stage);assert.equal(transition.to,next.stage);assert.ok(next.stage_label);
  }
 }
 const order=await work.order('os-14');assert.equal(order.customer.name,'Mariana Costa');assert.equal(order.quote.total_cents,40500);
 assert.equal(order.history,undefined);
 const legacy=await m.demoApi('v1/profiles/demo/service-orders/os-14');assert.ok(legacy.history.length>0);
});

test('demonstração: lista filtra tipo, etapa, conversa, responsável, prazo e paginação',async()=>{
 assert.deepEqual((await work.orders({type_id:'inexistente'})).data,[]);
 assert.deepEqual((await work.orders({stage:'quoted',conversation_id:'demo-1',assignee:'me',q:'Mariana'})).data.map(row=>row.id),['os-14']);
 assert.deepEqual((await work.orders({conversation_id:'outra'})).data,[]);
 assert.deepEqual((await work.orders({assignee:'unassigned'})).data,[]);
 assert.deepEqual((await work.orders({due_from:String(Date.now()+10*86400000)})).data,[]);
 assert.equal((await work.orders({open:'1'})).data.some(row=>row.status==='delivered'),false);
 const first=await work.orders({limit:'2'}),second=await work.orders({limit:'2',cursor:first.next_cursor});
 assert.equal(first.data.length,2);assert.equal(second.data.length,2);assert.equal(new Set([...first.data,...second.data].map(row=>row.id)).size,4);
});

test('demonstração: todas as leituras auxiliares de Trabalhos têm o formato esperado',async()=>{
 for(const result of await Promise.all([
  work.tasks('os-14',{}),work.people('os-14',{}),work.documents('os-14',{}),work.documents('os-14',{},true),
  work.entries('os-14',{include_archived:true}),work.deadlines({assignee:'me',state:'open'}),
  m.demoApi('v1/profiles/demo/service-orders/os-14/private-tasks'),
 ])) {assert.ok(Array.isArray(result.data));assert.equal(result.next_cursor,null);}
 const history=await work.history('os-14',{});assert.equal(history.data.length,2);assert.equal(history.data[1].to_stage,'quoted');
 const first=await work.history('os-14',{limit:1});assert.ok(first.next_cursor);
 assert.equal((await work.history('os-14',{limit:1,cursor:first.next_cursor})).data.length,1);
 assert.deepEqual(await work.privateFields('os-14'),{id:'os-14',version:1,fields:[],extra:{}});
 const status=await m.demoApi('v1/profiles/demo/status');assert.equal(typeof status.settings,'object');assert.equal(status.settings_revision,(await work.types()).settings_revision);
 assert.ok(Array.isArray((await m.demoApi('v1/profiles/demo/menus')).data));
});

test('demonstração: desconhecidos dão 404 e escritas continuam bloqueadas',async()=>{
 for(const path of ['types/desconhecido','os-99','os-99/entries','os-99/people','os-99/documents','os-99/history','os-14/inexistente','os-14/documents/desconhecido/content'])
  await assert.rejects(m.demoApi('v1/profiles/demo/service-orders/'+path),{status:404,code:'demo_not_found'});
 await assert.rejects(work.stage('os-14',{version:1,transition_id:'quoted_analyzing'}),{status:400,code:'demo'});
});

test('Módulos envia a lista exibida mesmo após atualização e reabre confirmação em conflito',async()=>{
 const base={id:'erp',name:'Cadastro de clientes',enabled:true,requires:[],navigation:[]};
 const products={id:'erp-produtos',name:'Produtos',enabled:true,requires:['erp'],navigation:[]};
 const finance={id:'erp-financeiro',name:'Financeiro',enabled:true,requires:['erp'],navigation:[]};
 const list={data:{data:[base,products]},loaded:true,reload:async()=>{},error:null};
 const calls=[];let fresh=[base,products,finance];
 const app={root:'v1/profiles/demo',isAdmin:true,refresh:async()=>{},api:async(path,method,body)=>{
  if(method==='PUT') {calls.push(structuredClone(body));if(calls.length===1)throw Object.assign(new Error('Mudou'),{code:'module_cascade_conflict'});return {};}
  return {data:fresh};
 }};
 const action={busyKey:null,run:async(fn)=>{try{return await fn();}catch{return undefined;}}};
 const modules={
  '../app/AppContext':'export const useApp=()=>r.app;',
  '../app/hooks':'export const useAction=()=>r.action;',
  './shared':'export const useResource=()=>r.list;',
  '../ui':'export const Confirm="confirm",Empty="empty",Notice="notice",Pill="pill",SkeletonRows="skeleton",Switch="switch";',
  'lucide-react':'export const Blocks="icon",ClipboardList="icon",CreditCard="icon",Puzzle="icon",Ticket="icon";',
 };
 const view=await mountComponent('../../../admin/ModulesPage.tsx',{}, {componentName:'ModulesPage',expandChildren:['ModuleCard'],ports:{app,action,list},modules});
 try {
  view.find(node=>node.type==='switch'&&node.props.label==='Desligar Cadastro de clientes').props.onChange(false);await view.flush();
  let dialog=view.find(node=>node.type==='confirm');assert.match(view.text(),/Também serão desligados: Produtos/);
  list.data={data:fresh};await view.updateProps({});
  assert.doesNotMatch(view.text().slice(view.text().indexOf('Também serão desligados:')),/Produtos, Financeiro/);
  dialog.props.onConfirm();await view.flush();
  assert.deepEqual(calls[0],{enabled:false,cascade:true,confirmed_dependents:['erp-produtos']});
  dialog=view.find(node=>node.type==='confirm');assert.match(view.text(),/Confira esta lista e confirme novamente/);
  assert.match(view.text(),/Também serão desligados: Produtos, Financeiro/);assert.equal(calls.length,1);
  dialog.props.onConfirm();await view.flush();
  assert.deepEqual(calls[1].confirmed_dependents,['erp-produtos','erp-financeiro']);
  assert.equal(view.nodes().some(node=>node.type==='confirm'),false);
 } finally {view.unmount();}
});

const nodeText=value=>Array.isArray(value)?value.map(nodeText).join(''):value&&typeof value==='object'?nodeText(value.props?.children):typeof value==='string'?value:'';
test('modelo mantém Fiscal disponível, desmarcado e visível na prévia quando marcado',async()=>{
 const requests=[],app={root:'v1/profiles/demo',profileName:'Demonstração',modules:{},settings:{}};
 const api={preview:async body=>{requests.push(structuredClone(body));return {
  preview_hash:'demo',can_apply:true,conflicts:[],manual_steps:[],
  changes:body.selection.module_ids.map(id=>({path:'modules.'+id,action:'set',reason:'Ligar módulo selecionado'})),
 };}};
 const action={busy:false,run:async fn=>fn()};
 const view=await mountComponent('../../../admin/area-templates/AreaTemplatesPage.tsx',{template:m.assistenciaTecnicaTemplate,imported:false,onBack(){}},{componentName:'Preview',ports:{app,api,action},modules:{
  '../../app/AppContext':'export const useApp=()=>r.app;',
  '../../app/hooks':'export const useAction=()=>r.action;',
  '../../ui':'export const Button="button",Field="input",Notice="notice";',
  '../../lib/routes':'export const linkProps=()=>({});',
  '../../modules/os/work-hooks':'export const useWorkApi=()=>r.api,ResourceState="resource",useWorkResource=()=>({});',
  '../../modules/os/types/type-draft':'export const downloadJson=()=>{},parseTypeImport=JSON.parse;',
 }});
 try {
  const fiscal=()=>view.find(node=>node.type==='label'&&nodeText(node).startsWith('Fiscal:')).props.children.find(node=>node?.type==='input');
  assert.equal(fiscal().props.checked,false);assert.match(view.text(),/Fiscal: desligado, continua desligado/);
  await view.click('Gerar prévia');assert.equal(requests[0].selection.module_ids.includes('erp-fiscal'),false);
  assert.doesNotMatch(view.text(),/modules.erp-fiscal/);
  fiscal().props.onChange({target:{checked:true}});await view.flush();
  assert.equal(fiscal().props.checked,true);assert.match(view.text(),/Fiscal: desligado → ligar/);
  await view.click('Gerar prévia');assert.equal(requests[1].selection.module_ids.includes('erp-fiscal'),true);
  assert.match(view.text(),/modules.erp-fiscal/);
 } finally {view.unmount();}
});
