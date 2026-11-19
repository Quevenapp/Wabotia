import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshLite, nodeDriver } from '../harness/node-driver.mjs';
import '../../../src/erp/domains/index.ts';
import { callRpc } from '../../../src/erp/engine/registry.ts';
import { normalizeErpParts } from '../../../src/erp/parts.ts';
import { homeResponse, homeShortcutsResponse } from '../../../src/erp/fagoo/workers/erp-api/src/home.mjs';
import { documentsResponse } from '../../../src/erp/fagoo/workers/erp-api/src/documents.mjs';
import { businessRouter } from '../../../src/erp/fagoo/workers/erp-api/src/business.mjs';
import { preferencesPageResponse, preferencesResultResponse, parsePreferencesRoute, executePreferencesRoute } from '../../../src/erp/fagoo/workers/erp-api/src/preferences.mjs';

const admin='11111111-1111-4111-8111-111111111111';
const actor={user_id:admin,erp_role:'admin',is_agent:false,verified_factor:false,aal:'aal1',session_id:null,name:'Admin',email:null};
function fixture(t) {
 const lite=freshLite(),driver=nodeDriver(lite),queries=[];
 const db={...driver,exec(sql,...args){queries.push(sql);return driver.exec(sql,...args);}};
 t.after(()=>lite.close());
 const rpc=(name,args={},parts={},extra={})=>callRpc(db,name,{p_user_id:admin,...args},undefined,{identity:{actor,people:[actor]},parts:normalizeErpParts(parts),...extra});
 return {lite,queries,rpc};
}
const disabled=e=>e.code==='module_disabled';
const off={products:false,sales:false,purchases:false,stock:false,finance:false,fiscal:false,billing:false,pos:false};

test('home: Base não consulta domínios suspensos; ausência difere de zero; DTO completo permanece igual',t=>{
 const f=fixture(t),args={p_period:'hoje',p_from:null,p_to:null};
 const full=f.rpc('erp_home_overview',args);
 assert.equal(full.finance.accounts.active,0);assert.equal(full.stock.positions,0);
 assert.equal('unavailable_parts' in full,false);assert.deepEqual(homeResponse(full,{args}),full);
 f.queries.length=0;
 const partial=f.rpc('erp_home_overview',args,off);
 assert.equal(partial.stock,null);assert.equal(partial.finance,null);assert.equal(partial.period.sales,null);
 assert.equal(partial.period.receivable,null);assert.equal(partial.period.invoices,null);
 assert.deepEqual(partial.catalog.map(x=>x.entity),['contacts']);assert.deepEqual(partial.documents,[]);
 assert.ok(!f.queries.some(q=>/erp_stock__|erp_finance__|erp_fiscal_drafts__|FROM "erp_documents__document"/.test(q)));
 assert.deepEqual(homeResponse(partial,{args}),partial);
 for(const metadata of [[],null,['bad'],['stock','stock'],'stock',[false]])assert.throws(()=>homeResponse({...partial,unavailable_parts:metadata},{args}));
 assert.throws(()=>homeResponse({...partial,unavailable_parts:['stock']},{args}));
 assert.throws(()=>homeResponse({...partial,stock:{positions:0,positive_positions:0,zero_positions:0,products:0,warehouses:0}},{args}));
 assert.throws(()=>homeResponse({...partial,finance:undefined},{args}));
});

test('painéis: custo e saldo ausentes; margem e previsão barradas antes de ler fontes',async t=>{
 const f=fixture(t),url=new URL('https://erp.invalid/v1/meu-negocio/mensal?situacoes=verified&de=2026-10-01&ate=2026-10-02');
 const route=await businessRouter.parse(new Request(url),'mensal',url);
 const partial=f.rpc(route.rpc,route.args,{purchases:false,stock:false});
 assert.equal(partial.cost_visible,false);assert.equal(partial.stock_visible,false);assert.equal(partial.indicators.cost,null);
 assert.deepEqual(businessRouter.result(route,route.args,partial),partial);
 assert.throws(()=>businessRouter.result(route,route.args,{...partial,indicators:{...partial.indicators,cost:'0.00'}}));
 for(const panel of ['margem-pedido','previsao-estoque']) {
  f.queries.length=0;assert.throws(()=>f.rpc('erp_home_business_panel',{p_panel:panel,p_args:{}},{stock:false}),disabled);
  assert.ok(!f.queries.some(q=>/erp_stock__|item_cost_applied/.test(q)));
 }
});

test('relatório salvo prevalece sobre corpo e verifica base, colunas e filtros persistidos',t=>{
 const f=fixture(t),save=base=>f.rpc('erp_preferences_report_save',{p_report:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{base,title:base,columns:[base==='contas_receber'?'contato':'nome'],filters:[],view_limit:20,with_totals:false,users:[]}}).receipt.target;
 const id=save('contas_receber');save('contatos');
 const args={p_base:'contatos',p_columns:['nome'],p_filters:[],p_view_limit:20,p_page:20,p_offset:0};
 const extra={partsReference:{kind:'report',id}};
 assert.throws(()=>f.rpc('erp_preferences_report_run',args,{finance:false},extra),disabled);
 const storedResult=f.rpc('erp_preferences_report_run',args,{},extra);
 assert.equal(storedResult.base,'contas_receber');assert.deepEqual(storedResult.columns,['contato']);
 const list=f.rpc('erp_preferences_reports',{}, {finance:false});assert.deepEqual(list.reports.map(x=>x.base),['contatos']);
 assert.equal(f.lite.prepare('SELECT count(*) n FROM erp_preferences__report').get().n,2);
 for(const [columns,filters] of [['["margin"]','[]'],['["nome"]','[{"column":"cost","value":"1"}]']]){
  f.lite.prepare('UPDATE erp_preferences__report SET base=?,columns=?,filters=? WHERE id=?').run('contatos',columns,filters,id);
  assert.throws(()=>f.rpc('erp_preferences_report_run',args,{purchases:false},extra),disabled);
 }
});

test('preferência parcial conserva campo financeiro, aceita reenvio idêntico e recusa alteração/limpeza',t=>{
 const f=fixture(t),page='vendas-vendas';
 const original=f.rpc('erp_preferences_page',{p_page:page}),hidden=original.items.find(x=>x.key==='vendas.contas_automaticas_pedido');assert.ok(hidden);
 const partial=f.rpc('erp_preferences_page',{p_page:page},{finance:false});
 assert.ok(!partial.items.some(x=>x.key===hidden.key));assert.deepEqual(preferencesPageResponse(partial,page),partial);
 const editable=partial.items.find(x=>typeof x.value==='boolean');assert.ok(editable);
 const changes=[{key:editable.key,expected_version:editable.version,value:!editable.value},{key:hidden.key,expected_version:hidden.version,value:hidden.value}];
 const command=randomUUID(),result=f.rpc('erp_preferences_save',{p_page:page,p_command_id:command,p_changes:changes},{finance:false});
 assert.equal(result.receipt.changes.length,1);
 assert.deepEqual(preferencesResultResponse(result,{commandId:command,pageId:page,input:{command_id:command,changes}}),result);
 for(const value of [null,typeof hidden.value==='boolean'?!hidden.value:'invalid'])assert.throws(()=>f.rpc('erp_preferences_save',{p_page:page,p_command_id:randomUUID(),p_changes:[{key:hidden.key,expected_version:hidden.version,value}]},{finance:false}),disabled);
 const noopCommand=randomUUID(),noopChanges=[{key:hidden.key,expected_version:hidden.version,value:hidden.value}];
 const noop=f.rpc('erp_preferences_save',{p_page:page,p_command_id:noopCommand,p_changes:noopChanges},{finance:false});
 assert.deepEqual(preferencesResultResponse(noop,{commandId:noopCommand,pageId:page,input:{command_id:noopCommand,changes:noopChanges}}),noop);
 const lookup=f.rpc('erp_preferences_command',{p_command_id:noopCommand},{finance:false});
 assert.deepEqual(preferencesResultResponse(lookup,{commandId:noopCommand,lookup:true}),lookup);
 const onLookup=f.rpc('erp_preferences_command',{p_command_id:noopCommand});
 assert.deepEqual(preferencesResultResponse(onLookup,{commandId:noopCommand,lookup:true}),onLookup);
 const restored=f.rpc('erp_preferences_page',{p_page:page});assert.deepEqual(restored.items.find(x=>x.key===hidden.key),hidden);
 assert.throws(()=>preferencesPageResponse({...partial,items:partial.items.slice(1)},page));
});

test('favoritos ocultos e rótulos sobrevivem a edição e replay; religamento só lê',t=>{
 const f=fixture(t),sales='/documentos-empresa?tipo=sales_orders',contact='/cadastros-reais?cadastro=contacts';
 const save=(version,shortcuts,labels,parts={})=>{const args={p_command_id:randomUUID(),p_expected_version:version,p_shortcuts:shortcuts,p_labels:labels};return {args,result:f.rpc('erp_home_shortcuts_save',args,parts)};};
 save(0,[sales,contact],{[sales]:'Minhas vendas'});
 const partial=f.rpc('erp_home_shortcuts_get',{},off);assert.deepEqual(partial.shortcuts,[contact]);homeShortcutsResponse(partial,{});
 const changed=save(1,[contact],{[contact]:'Clientes'},off);homeShortcutsResponse(changed.result,{type:'save',args:changed.args});
 const replay=f.rpc('erp_home_shortcuts_save',changed.args,off);assert.equal(replay.replayed,true);assert.deepEqual(replay.shortcuts,[contact]);
 f.queries.length=0;const restored=f.rpc('erp_home_shortcuts_get');
 assert.deepEqual(restored.shortcuts,[sales,contact]);assert.equal(restored.labels[sales],'Minhas vendas');
 homeShortcutsResponse(f.rpc('erp_home_shortcuts_save',changed.args),{type:'save',args:changed.args});
 assert.ok(!f.queries.some(q=>/^\s*(INSERT|UPDATE|DELETE)/i.test(q)&&!/erp_access__/.test(q)));
});

test('notificações antigas suspensas ficam salvas e não são marcadas como lidas',t=>{
 const f=fixture(t);f.rpc('erp_home_summary');
 f.lite.prepare("INSERT INTO erp_home__notification(user_id,type,day,quantity,amount,created_at) VALUES(?,?,?,?,?,?)").run(admin,'contas_pagar_atrasadas','2026-10-01',1,100,'1700000000000000');
 const result=f.rpc('erp_home_notifications_read',{p_command_id:randomUUID(),p_ids:null},{finance:false});
 assert.equal(result.receipt.marked,0);assert.equal(result.view.unread,0);assert.deepEqual(result.view.items,[]);
 assert.equal(f.lite.prepare('SELECT read_at FROM erp_home__notification').get().read_at,null);
});


test('gráficos e transições preservam configurações ocultas através da API',async t=>{
 const f=fixture(t);
 const charts=await parsePreferencesRoute(new Request('https://erp.invalid/v1/sistema/graficos-inicio'));
 const partial=await executePreferencesRoute(charts,{userId:admin,rpc:(name,args)=>f.rpc(name,args,off)});
 assert.deepEqual(partial.available,['resumo']);assert.deepEqual(partial.charts,['resumo']);
 const body={command_id:randomUUID(),expected_version:0,charts:[]};
 const save=await parsePreferencesRoute(new Request('https://erp.invalid/v1/sistema/graficos-inicio',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
 const result=await executePreferencesRoute(save,{userId:admin,rpc:(name,args)=>f.rpc(name,args,off)});
 assert.deepEqual(result.charts,[]);assert.equal(f.rpc('erp_home_charts_get').charts.length,4);
 assert.equal((await executePreferencesRoute(save,{userId:admin,rpc:(name,args)=>f.rpc(name,args)})).replayed,true);
 f.lite.prepare("INSERT OR IGNORE INTO erp_preferences__situation_adoption(kind,migration) VALUES('purchase_orders','202610200160')").run();
 const args={p_command_id:randomUUID(),p_kind:'purchase_orders',p_from:'in_progress',p_to:'fulfilled',p_expected_version:0,p_data:{active:true,actions:['post_finance','post_stock']}};
 f.rpc('erp_preferences_transition_save',args);
 const before=f.rpc('erp_preferences_situations',{p_kind:'purchase_orders'}).transitions.find(x=>x.from===args.p_from&&x.to===args.p_to);
 const partialPage=f.rpc('erp_preferences_situations',{p_kind:'purchase_orders'},{finance:false,stock:false});
 assert.deepEqual(partialPage.transitions.find(x=>x.from===args.p_from&&x.to===args.p_to).actions,[]);
 f.rpc('erp_preferences_transition_save',{...args,p_command_id:randomUUID(),p_expected_version:before.version,p_data:{active:false,actions:[]}},{finance:false,stock:false});
 const restored=f.rpc('erp_preferences_situations',{p_kind:'purchase_orders'}).transitions.find(x=>x.from===args.p_from&&x.to===args.p_to);
 assert.deepEqual(restored.actions,before.actions);assert.equal(restored.active,false);
 const route=await parsePreferencesRoute(new Request('https://erp.invalid/v1/sistema/situacoes?tipo=purchase_orders'));
 await executePreferencesRoute(route,{userId:admin,rpc:(name,args)=>f.rpc(name,args,{finance:false,stock:false})});
});

test('arquivos operacionais não consultam donos desligados; backup administrativo continua acessível',t=>{
 const f=fixture(t),args={p_query:null,p_from:null,p_to:null,p_order:'data',p_origin:null,p_limit:100,p_offset:0};
 f.rpc('erp_home_summary');f.queries.length=0;
 const files=f.rpc('erp_files_list_v2',args,off);assert.deepEqual(files.items,[]);
 assert.ok(!f.queries.some(q=>/erp_finance__file|erp_attachments__attachment|erp_catalog__product_stored_image/.test(q)));
 assert.deepEqual(f.rpc('erp_platform_exports',{},off),f.rpc('erp_platform_exports'));
});

test('leitura de painel com produto não busca custo nem recompõe efeitos após religar',async t=>{
 const f=fixture(t),command=()=>randomUUID();
 const contact=f.rpc('erp_catalog_save',{p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:command(),p_data:{name:'Cliente'}}).record;
 const product=f.rpc('erp_catalog_save',{p_entity:'products',p_id:null,p_expected_version:0,p_command_id:command(),p_data:{name:'Produto',unit:'UN',kind:'P',format:'S',price:'10'}}).record;
 const doc=f.rpc('erp_document_save',{p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:command(),p_body:{date:'2026-10-01',contact_id:contact.id,items:[{product_id:product.id,description:'Produto',unit:'UN',quantity:'1',unit_price:'10'}]}}).document;
 const url=new URL('https://erp.invalid/v1/meu-negocio/mensal?situacoes=open&de=2026-10-01&ate=2026-10-02');
 const route=await businessRouter.parse(new Request(url),'mensal',url);
 f.queries.length=0;
 const partial=f.rpc(route.rpc,route.args,{purchases:false,stock:false});
 assert.equal(partial.kpis.current.orders,1);assert.equal(partial.top_skus[0].stock,null);
 assert.ok(!f.queries.some(q=>/item_cost_applied|erp_stock__|erp_catalog__product_cost|kind='purchase_orders'/.test(q)));
 businessRouter.result(route,route.args,partial);
 f.queries.length=0;f.rpc(route.rpc,route.args);
 assert.ok(!f.queries.some(q=>/^\s*(INSERT|UPDATE|DELETE)/i.test(q)&&!/erp_access__/.test(q)));
 assert.equal(f.lite.prepare('SELECT version FROM erp_documents__document WHERE id=?').get(doc.id).version,doc.version);
});


test('parser comercial: histórico financeiro ausente, flags históricas e recibos part_disabled',t=>{
 const f=fixture(t);
 const contact=f.rpc('erp_catalog_save',{p_entity:'contacts',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{name:'Cliente'}}).record;
 const route={kind:'sales_orders',id:null},args={p_kind:'sales_orders',p_contact_id:contact.id,p_product_id:null,p_query:null,p_limit:20};
 const full=f.rpc('erp_document_history',args);
 const partial={...full,finance:null,invoices_included:false,unavailable_parts:['finance','fiscal']};
 assert.equal(documentsResponse(partial,route,{type:'history',args}).finance,null);
 assert.throws(()=>documentsResponse({...partial,unavailable_parts:['fiscal']},route,{type:'history',args}));
 assert.throws(()=>documentsResponse({...partial,finance:full.finance},route,{type:'history',args}));
 const saved=f.rpc('erp_document_save',{p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-01',contact_id:contact.id,items:[{description:'Serviço',unit:'UN',quantity:'1',unit_price:'10'}]}});
 const value={...saved,unavailable_parts:['stock','finance'],effects:[{action:'post_stock',outcome:'skipped',reason:'part_disabled'}],auto_finance:{outcome:'skipped',reason:'part_disabled'},document:{...saved.document,effect_flags:{...saved.document.effect_flags,stock_active:true,finance_active:true}}};
 const parsed=documentsResponse(value,route,{type:'document',rpc:'erp_document_transition'});
 assert.equal(parsed.document.effect_flags.stock_active,true);assert.equal(parsed.document.effect_flags.finance_active,true);
 assert.equal(parsed.effects[0].reason,'part_disabled');assert.equal(parsed.auto_finance.reason,'part_disabled');
 assert.throws(()=>documentsResponse({...value,effects:[{action:'post_stock',outcome:'done',reason:'part_disabled'}]},route,{type:'document',rpc:'erp_document_transition'}));
 assert.throws(()=>documentsResponse({...value,effects:[{action:'post_stock',outcome:'skipped',reason:'unknown'}]},route,{type:'document',rpc:'erp_document_transition'}));
});
