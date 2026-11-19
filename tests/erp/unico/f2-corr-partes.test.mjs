// Esta entrada precisa carregar antes de domains/index, como no harness e na semeadura.
import { fold } from '../../../src/erp/domains/catalog/internal.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshLite, nodeDriver } from '../harness/node-driver.mjs';
import '../../../src/erp/domains/index.ts';
import { extensionKeys } from '../../../src/erp/domains/documents/normalize.ts';
import { erpDocumentConversionPreview } from '../../../src/erp/domains/documents/rpc/reads-proposal.ts';
import { normalizeErpParts } from '../../../src/erp/parts.ts';
import { callRpc } from '../../../src/erp/engine/registry.ts';
import { documentsResponse, documentsOperation, documentsRoute } from '../../../src/erp/fagoo/workers/erp-api/src/documents.mjs';
import { catalogResponse } from '../../../src/erp/fagoo/workers/erp-api/src/catalog.mjs';
import { contactResponse, contactOperation, contactRoute } from '../../../src/erp/fagoo/workers/erp-api/src/contacts.mjs';
import { parseFinanceRoute, executeFinanceRoute } from '../../../src/erp/fagoo/workers/erp-api/src/finance.mjs';

const admin = '11111111-1111-4111-8111-111111111111';
const actor = { user_id: admin, erp_role: 'admin', is_agent: false, verified_factor: false, aal: 'aal1', session_id: null, name: 'Admin', email: null };
const baseOnly = { products:false, sales:false, purchases:false, stock:false, finance:false, fiscal:false, billing:false, pos:false };
const command = (data, record) => ({ p_id:record?.id??null, p_expected_version:record?.version??0, p_command_id:randomUUID(), p_data:data });
const method = { description:'Dinheiro', payment_type:'01', condition:'30', destination:'contas', account_id:null, business_days:false, applicable:'ambos', interest_rate:null, fine_rate:null, card_brand:null, card_integration:null, card_cnpj:null, auto_settle:false, pix_integration:null, pix_cnpj:null, fee_type:'aliquota', fee_rate:null, fee_fixed:null, settlement_days:null };
const sellerSettings = { user_id:admin, allow_unregistered_products:true, view_stock:true, access_hours_enabled:false, access_windows:[], modules:{}, commission_rule:'parcial', commission_mode:'fixa', commission_rate:'3', commission_bands:[], discount_limit:'0', notes:null };
const absent = (value, keys) => keys.forEach(key => assert.equal(Object.hasOwn(value,key),false,key));
function fixture(t) {
 const lite=freshLite(), driver=nodeDriver(lite), queries=[];
 const db={...driver,exec(sql,...args){queries.push(sql);return driver.exec(sql,...args);}};
 t.after(()=>lite.close());
 const rpc=(name,args={},parts={})=>callRpc(db,name,{p_user_id:admin,...args},undefined,{identity:{actor,people:[actor]},parts});
 const contact=(data={})=>rpc('erp_catalog_contact_save',command({name:'Contato',person_type:'J',...data})).record;
 const product=(data={})=>rpc('erp_catalog_product_save',command({name:'Produto',kind:'P',format:'S',unit:'UN',price:'10',...data})).record;
 const account=()=>rpc('erp_finance_account_execute',{p_command_id:randomUUID(),p_action:'account_create',p_data:{account_type:'cash',name:'Caixa',start_on:'2020-01-01',opening_cents:'0'}}).record;
 const category=()=>rpc('erp_finance_category_execute',{p_command_id:randomUUID(),p_action:'category_create',p_data:{kind:'receivable',name:'Receitas'}}).record;
 const saveSeller=(settings=sellerSettings,previous)=>rpc('erp_catalog_seller_save',{p_id:previous?.seller.id??null,p_expected_version:previous?.seller.version??0,p_contact_expected_version:previous?.contact.version??0,p_command_id:randomUUID(),p_contact:{name:'Vendedor'},p_settings:settings});
 return {lite,queries,rpc,contact,product,account,category,saveSeller};
}

test('núcleo do catálogo pode ser importado antes do registro de RPCs',()=>{
 assert.equal(fold('AÇÃO'), 'acao');
});

test('3 e 9: acesso e pagamento continuam válidos nas combinações de partes, com vendedor e métodos reais',t=>{
 const f=fixture(t);f.saveSeller();f.rpc('erp_catalog_payment_method_save',command(method));
 for(const parts of [{},{stock:false},{finance:false},{stock:false,finance:false},baseOnly]) {
  const raw=f.rpc('erp_document_access',{},parts), parsed=documentsResponse(raw,{}, {type:'access'});
  assert.deepEqual(parsed.settings,raw.settings);assert.deepEqual(parsed.seller,raw.seller);
  if(parts.stock===false)absent(parsed.settings,['cross_docking_days','stock_launch_date']);
  if(parts.sales===false)continue;
  const payments=f.rpc('erp_document_payment_options',{p_kind:'sales_orders'},parts);
  assert.ok(payments.methods.length);
  const response=documentsResponse(payments,{kind:'sales_orders'},{type:'payment_options'});
  assert.deepEqual(response.methods,payments.methods);
  if(parts.finance===false){absent(response,['accounts']);absent(response.methods[0],['account_id']);}
 }
 const access=f.rpc('erp_document_access');
 for(const key of ['cross_docking_days']){const bad=structuredClone(access);delete bad.settings[key];assert.throws(()=>documentsResponse(bad,{}, {type:'access'}));}
 const bad=structuredClone(access);delete bad.seller.view_stock;assert.throws(()=>documentsResponse(bad,{}, {type:'access'}));
 const payments=f.rpc('erp_document_payment_options',{p_kind:'sales_orders'});delete payments.methods[0].account_id;
 assert.throws(()=>documentsResponse(payments,{kind:'sales_orders'},{type:'payment_options'}));
 const partial=f.rpc('erp_document_payment_options',{p_kind:'sales_orders'},{finance:false});delete partial.methods[0].description;
 assert.throws(()=>documentsResponse(partial,{kind:'sales_orders'},{type:'payment_options'}));
});

test('4 e 7: contato, pagamento e vendedor ocultam Financeiro na leitura e no replay, preservando a escrita',t=>{
 const f=fixture(t), category=f.category(), account=f.account();
 const cargs=command({name:'Contato',credit_limit_mode:'value',credit_limit:'100',finance_category_id:category.id});
 const c=f.rpc('erp_catalog_contact_save',cargs).record;
 const margs=command({...method,account_id:account.id,fee_rate:'2'}),m=f.rpc('erp_catalog_payment_method_save',margs).item;
 const sargs={p_id:null,p_expected_version:0,p_contact_expected_version:0,p_command_id:randomUUID(),p_contact:{name:'Vendedor'},p_settings:sellerSettings};
 const s=f.rpc('erp_catalog_seller_save',sargs);
 const contactKeys=['credit_limit','credit_limit_mode','finance_category_id','finance_category_name'];
 const methodKeys=['account_id','account_name','fee_rate','fee_type','fee_fixed','fine_rate','interest_rate','auto_settle','settlement_days'];
 const sellerKeys=['commission_rule','commission_mode','commission_rate','commission_bands'];
 for(const parts of [{finance:false},baseOnly]) {
  for(const raw of [f.rpc('erp_catalog_contact_get',{p_id:c.id},parts),f.rpc('erp_catalog_contact_save',cargs,parts)]) {
   absent(raw.record,contactKeys);
   const parsed=contactResponse(raw,{id:c.id},{type:'contact-record',args:{}});absent(parsed.record,contactKeys);
   assert.ok(parsed.record.unavailable_parts.includes('finance'));
  }
  for(const raw of [f.rpc('erp_catalog_payment_method_get',{p_id:m.id},parts),f.rpc('erp_catalog_payment_method_save',margs,parts)]) {
   absent(raw.item,methodKeys);
   const parsed=contactResponse(raw,{id:m.id},{type:raw.can_write===undefined?'payment-method-save':'payment-method',args:{}});absent(parsed.item,methodKeys);
  }
  for(const raw of [f.rpc('erp_catalog_seller_get',{p_id:s.seller.id},parts),f.rpc('erp_catalog_seller_save',sargs,parts)]) {
   absent(raw.seller,sellerKeys);absent(raw.contact,contactKeys);
   const parsed=contactResponse(raw,{id:s.seller.id},{type:'seller',args:raw.can_write===undefined?{}:{p_id:s.seller.id}});absent(parsed.seller,sellerKeys);
  }
 }
 const before=f.lite.prepare('SELECT * FROM erp_catalog__contact_profile WHERE record_id=?').get(c.id);
 f.rpc('erp_catalog_contact_save',command({name:'Novo nome'},c),baseOnly);
 assert.deepEqual(f.lite.prepare('SELECT * FROM erp_catalog__contact_profile WHERE record_id=?').get(c.id),before);
 const common={...method,description:'Nova descrição'};for(const key of methodKeys)delete common[key];
 f.rpc('erp_catalog_payment_method_save',command(common,m),baseOnly);
 assert.equal(f.rpc('erp_catalog_payment_method_get',{p_id:m.id}).item.fee_rate,'2.0000');
 assert.equal(f.rpc('erp_catalog_payment_method_get',{p_id:m.id}).item.account_id,account.id);
 assert.equal(f.rpc('erp_catalog_contact_get',{p_id:c.id}).record.credit_limit,'100.00');
 const replay=f.rpc('erp_catalog_contact_save',cargs,baseOnly);assert.equal(replay.replayed,true);assert.equal(replay.record.version,c.version);
});

test('5 e 7: produto completo projeta Compras/Estoque na leitura, escrita e replay sem apagar fornecedores',t=>{
 const f=fixture(t), supplier=f.contact({types:['supplier']});
 const args=command({name:'Produto',kind:'P',format:'S',unit:'UN',price:'10',stock_min:'2',lot_control:true,suppliers:[{supplier_id:supplier.id,is_default:true,purchase_price:'7',cost_price:'8'}]});
 const p=f.rpc('erp_catalog_product_save',args).record;
 const before=f.lite.prepare('SELECT * FROM erp_catalog__product_supplier WHERE record_id=?').all(p.id);
 for(const parts of [{purchases:false},{stock:false},{purchases:false,stock:false}]) {
  for(const raw of [f.rpc('erp_catalog_product_get',{p_id:p.id},parts),f.rpc('erp_catalog_product_save',args,parts)]) {
   absent(raw.record,['suppliers','cost_price']);if(parts.stock===false)absent(raw.record,['stock_min','stock_max','location','lot_control']);
   const parsed=catalogResponse(raw,{entity:'products',product:'complete',id:p.id},{type:'record'});
   absent(parsed.record,['suppliers','cost_price']);if(parts.stock===false)absent(parsed.record,['stock_min','stock_max','location','lot_control']);
  }
 }
 const saved=f.rpc('erp_catalog_product_save',command({name:'Renomeado'},p),{purchases:false,stock:false});absent(saved.record,['suppliers','cost_price']);
 assert.deepEqual(f.lite.prepare('SELECT * FROM erp_catalog__product_supplier WHERE record_id=?').all(p.id),before);
 assert.equal(f.rpc('erp_catalog_product_get',{p_id:p.id}).record.suppliers[0].cost_price,'8.0000');
});

test('6 e 7: documento conserva parcelas comerciais e flags, oculta contas, tarifas e lotes inclusive no recibo',async t=>{
 const f=fixture(t),c=f.contact(),p=f.product(),account=f.account(),category=f.category();
 const details={account_id:account.id,payment_type:null,card_brand:null,integration_type:null,acquirer_cnpj:null,authorization_code:null,received_amount:null,fee_amount:'1.00',commission_fee_amount:'0.50'};
 const args={p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-15',contact_id:c.id,category_id:category.id,payment_account_id:account.id,
  items:[{product_id:p.id,description:p.name,unit:'UN',quantity:'1',unit_price:'10'}],installments:[{due_date:'2026-11-20',amount:'10',details}]}};
 const saved=f.rpc('erp_document_save',args),doc=saved.document;
 // Representa um lote histórico já vinculado, sem produzir nova movimentação.
 const item=f.lite.prepare('SELECT id,data FROM erp_documents__item WHERE document_id=?').get(doc.id);
 const lots=[{lot_id:randomUUID(),quantity:'1.000000'}];
 f.lite.prepare('UPDATE erp_documents__item SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(item.data),lots}),item.id);
 const receipt=JSON.parse(f.lite.prepare('SELECT result FROM erp_documents__command WHERE command_id=?').get(args.p_command_id).result);
 receipt.document.items[0].lots=lots;
 f.lite.prepare('UPDATE erp_documents__command SET result=? WHERE command_id=?').run(JSON.stringify(receipt),args.p_command_id);
 const stored=()=>({body:f.lite.prepare('SELECT body FROM erp_documents__document WHERE id=?').get(doc.id).body,item:f.lite.prepare('SELECT data FROM erp_documents__item WHERE id=?').get(item.id).data});
 const before=stored();
 for(const parts of [{stock:false},{finance:false},{stock:false,finance:false}]) {
  for(const raw of [f.rpc('erp_document_get',{p_kind:doc.kind,p_id:doc.id},parts),f.rpc('erp_document_save',args,parts)]) {
   const parsed=documentsResponse(raw,{kind:doc.kind,id:doc.id},{type:'document',rpc:'erp_document_save'});
   for(const value of [raw.document,parsed.document]) {
    if(parts.stock===false){absent(value,['warehouse_id']);absent(value.items[0],['lots']);}
    if(parts.finance===false){absent(value,['category_id','category_name','payment_account_id','payment_account_name','payment_account_names']);absent(value.installments[0].details,['account_id','fee_amount','commission_fee_amount']);}
    assert.equal(value.installments[0].amount,'10.00');assert.equal(value.installments[0].due_date,'2026-11-20');
    assert.deepEqual(value.effect_flags,doc.effect_flags);
   }
  }
 }
 assert.deepEqual(stored(),before);
 const projected=f.rpc('erp_document_get',{p_kind:doc.kind,p_id:doc.id},{stock:false,finance:false}).document;
 const editable={date:projected.date,contact_id:c.id,internal_notes:'Nota comercial',items:projected.items.map(i=>({id:i.id,product_id:i.product_id,description:i.description,unit:i.unit,quantity:i.quantity,unit_price:i.unit_price})),installments:projected.installments.map(({position,...row})=>row)};
 for(const key of extensionKeys())if(Object.hasOwn(projected,key))editable[key]=projected[key];
 editable.installments.forEach(row=>{row.payment_method_id??=null;});
 const url=`https://erp.invalid/v1/documentos/${doc.kind}/${doc.id}`;
 const operation=await documentsOperation(new Request(url,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({command_id:randomUUID(),expected_version:doc.version,data:editable})}),documentsRoute(new URL(url).pathname),new URLSearchParams());
 absent(operation.args.p_body.installments[0].details,['account_id','fee_amount','commission_fee_amount']);
 f.rpc(operation.rpc,operation.args,{stock:false,finance:false});
 const reread=f.rpc('erp_document_get',{p_kind:doc.kind,p_id:doc.id}).document;
 assert.equal(reread.payment_account_id,account.id);assert.equal(reread.category_id,category.id);
 assert.equal(reread.installments[0].details.fee_amount,'1.00');assert.deepEqual(reread.items[0].lots,lots);
});

test('irmãos: pendências fiscais e componentes ausentes só são aceitos com a parte suspensa',t=>{
 const f=fixture(t),c=f.contact(),p=f.product();
 const doc=f.rpc('erp_document_save',{p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-15',contact_id:c.id,items:[{product_id:p.id,description:p.name,unit:'UN',quantity:'1',unit_price:'10'}]}}).document;
 for(const [rpc,type,parts,field] of [['erp_document_pendencies','pendencies',{fiscal:false},'pendencies'],['erp_document_structures','structures',{stock:false},'items']]) {
  const args={p_kind:doc.kind,[type==='structures'?'p_document_id':'p_id']:doc.id},route={kind:doc.kind,id:doc.id};
  const raw=f.rpc(rpc,args,parts),parsed=documentsResponse(raw,route,{type,args});absent(parsed,[field]);
  const invalid={...raw};delete invalid.unavailable_parts;assert.throws(()=>documentsResponse(invalid,route,{type,args}));
 }
});

test('8: Financeiro sem Cobrança não consulta nem devolve o detalhe do boleto',async t=>{
 const f=fixture(t),c=f.contact();
 const title=f.rpc('erp_finance_execute',{p_action:'title_create_group',p_command_id:randomUUID(),p_data:{kind:'receivable',contact_id:c.id,description:'Parcela',issued_on:'2026-10-15',total_cents:'1000',installments:[{amount_cents:'1000',due_on:'2026-11-20'}]}}).items[0];
 const route=await parseFinanceRoute(new Request(`https://erp.invalid/v1/financeiro/titles/${title.id}/detalhe`));
 const account=f.account(),profile=randomUUID(),remittance=randomUUID(),billing=randomUUID(),at=Date.now()*1000;
 f.lite.prepare('INSERT INTO erp_cnab__profile(id,account_id,identity,settings,account_scope,next_sequence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(profile,account.id,'{}','{}','teste',2,at,at);
 f.lite.prepare('INSERT INTO erp_cnab__remittance(id,profile_id,sequence,generated_on,state,snapshot,actor,created_at) VALUES(?,?,?,?,?,?,?,?)').run(remittance,profile,1,'2026-10-15','reserved','{}',admin,at);
 f.lite.prepare('INSERT INTO erp_cnab__billing_title(id,title_id,profile_id,remittance_id,control,document_number,our_number,snapshot) VALUES(?,?,?,?,?,?,?,?)').run(billing,title.id,profile,remittance,'controle','DOC-1','123456','{}');
 const stored=f.lite.prepare('SELECT * FROM erp_cnab__billing_title WHERE id=?').get(billing);
 const full=f.rpc('erp_finance_title_detail',{p_id:title.id});assert.equal(full.billing.our_number,'123456');assert.equal(full.billing.remittance_id,remittance);
 f.queries.length=0;
 const raw=f.rpc('erp_finance_title_detail',{p_id:title.id},{billing:false});absent(raw,['billing']);assert.ok(raw.unavailable_parts.includes('billing'));
 assert.equal(f.queries.some(sql=>/erp_cnab__/.test(sql)),false);
 const parsed=await executeFinanceRoute(route,{userId:admin,rpc:()=>raw});absent(parsed,['billing']);assert.deepEqual(parsed.unavailable_parts,['billing']);
 const invalid={...raw};delete invalid.unavailable_parts;
 await assert.rejects(()=>executeFinanceRoute(route,{userId:admin,rpc:()=>invalid}));
 assert.deepEqual(f.lite.prepare('SELECT * FROM erp_cnab__billing_title WHERE id=?').get(billing),stored);
});

test('2: atividade filtra o dono antes de contar/paginar e recusa detalhe oculto; eventos da Base são projetados',t=>{
 const f=fixture(t),category=f.category(),account=f.account();
 const c=f.contact({credit_limit_mode:'value',credit_limit:'100',finance_category_id:category.id});
 const product=f.product();
 const m=f.rpc('erp_catalog_payment_method_save',command({...method,account_id:account.id,fee_rate:'2'})).item;
 const seller=f.saveSeller();
 f.rpc('erp_document_save',{p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{date:'2026-10-15',contact_id:c.id,payment_account_id:account.id,category_id:category.id,items:[{product_id:product.id,description:product.name,unit:'UN',quantity:'1',unit_price:'10'}]}});
 const pref=f.rpc('erp_preferences_page',{p_page:'vendas-vendas'}).items.find(i=>i.key==='vendas.contas_automaticas_pedido');
 f.rpc('erp_preferences_save',{p_command_id:randomUUID(),p_page:'vendas-vendas',p_changes:[{key:pref.key,expected_version:pref.version,value:!pref.value}]});
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
 const args={p_from:today,p_to:today,p_limit:100,p_offset:0,p_module:null,p_operation:null,p_actor:null,p_query:null};
 const all=f.rpc('erp_activity_list',args),only=f.rpc('erp_activity_list',args,baseOnly);
 assert.ok(all.items.some(i=>i.source==='finance'));assert.ok(all.items.some(i=>i.source==='documents'));assert.ok(all.items.some(i=>i.source==='preferences'));
 assert.equal(only.total,only.items.length);assert.ok(only.total<all.total);
 assert.equal(only.items.some(i=>['finance','documents','preferences'].includes(i.source)),false);
 const hidden=all.items.filter(i=>!only.items.some(j=>j.source===i.source&&j.id===i.id));assert.ok(hidden.length>=4);
 for(const item of hidden)assert.throws(()=>f.rpc('erp_activity_detail',{p_source:item.source,p_entry_id:item.id},baseOnly),e=>e.code==='module_disabled');
 const audit=(table,where,id)=>String(f.lite.prepare(`SELECT id FROM ${table} WHERE ${where}=? ORDER BY id LIMIT 1`).get(id).id);
 for(const [source,id,keys] of [
  ['catalog',audit('erp_catalog__audit','record_id',c.id),['credit_limit','credit_limit_mode','finance_category_id','finance_category_name']],
  ['auxiliary',audit('erp_catalog__auxiliary_audit','subject_id',m.id),['account_id','account_name','fee_rate','fee_type']],
  ['auxiliary',audit('erp_catalog__auxiliary_audit','subject_id',seller.seller.id),['commission_rule','commission_mode','commission_rate','commission_bands']],
 ]) {
  assert.ok(only.items.some(i=>i.source===source&&i.id===id));
  const detail=f.rpc('erp_activity_detail',{p_source:source,p_entry_id:id},baseOnly);absent(detail.after,keys);
 }
 const pages=[];
 for(let offset=0;offset<only.total;offset++){
  const page=f.rpc('erp_activity_list',{...args,p_limit:1,p_offset:offset},baseOnly);assert.equal(page.total,only.total);assert.equal(page.has_more,offset+1<only.total);pages.push(...page.items);
 }
 assert.deepEqual(pages,only.items);
 // Alterar só o limite de crédito não deixa um evento vazio visível na Base.
 f.rpc('erp_catalog_contact_save',command({credit_limit:'200'},c));
 const last=String(f.lite.prepare('SELECT max(id) id FROM erp_catalog__audit WHERE record_id=?').get(c.id).id);
 assert.equal(f.rpc('erp_activity_list',args,baseOnly).items.some(i=>i.source==='catalog'&&i.id===last),false);
 assert.throws(()=>f.rpc('erp_activity_detail',{p_source:'catalog',p_entry_id:last},baseOnly),e=>e.code==='module_disabled');
 assert.equal(f.rpc('erp_activity_detail',{p_source:'catalog',p_entry_id:last}).after.credit_limit,'200.00');
});

test('irmãos do catálogo: listas, exportação e atualização de preços projetam dados de Compras/Estoque',t=>{
 const f=fixture(t),supplier=f.contact({types:['supplier']}),p=f.product({stock_min:'2',stock_max:'5',location:'Prateleira',suppliers:[{supplier_id:supplier.id,is_default:true,purchase_price:'7',cost_price:'8'}]});
 for(const parts of [{stock:false},{purchases:false},{stock:false,purchases:false}]) {
  const args={p_page:1,p_size:20,p_sort:'created_desc',p_situation:'latest',p_warehouse_id:null};
  const raw=f.rpc('erp_catalog_product_page_v2',args,parts),parsed=catalogResponse(raw,{entity:'products'},{type:'page',args});
  absent(raw.items[0],['cost_price']);absent(parsed.items[0],['cost_price']);
  if(parts.stock===false){absent(raw.items[0],['stock_min','stock_max','location']);absent(parsed.items[0],['stock_min','stock_max','location']);}
  const eargs={p_offset:0,p_limit:250,p_include_deleted:false},exported=f.rpc('erp_catalog_product_export',eargs,parts);
  const safe=catalogResponse(exported,{entity:'products',product:'export'},{type:'export',args:eargs});
  absent(safe.items[0],['cost_price','supplier']);
  if(parts.stock===false)absent(safe.items[0],['stock_min','stock_max','location','lot_control']);
 }
 const args={p_command_id:randomUUID(),p_supplier_id:supplier.id,p_items:[{product_id:p.id,expected_version:p.version,price:'20.0000',cost_price:'8.0000'}]};
 f.rpc('erp_catalog_product_prices_update',args);
 const replay=f.rpc('erp_catalog_product_prices_update',args,{stock:false});
 const safe=catalogResponse(replay,{entity:'products',product:'prices'},{type:'prices',args});
 absent(replay,['supplier_id']);absent(safe,['supplier_id']);absent(replay.items[0],['cost_price']);absent(safe.items[0],['cost_price']);
});

test('HTTP: formas de pagamento e vendedor aceitam omissão suspensa sem fabricar valores na gravação',async t=>{
 const f=fixture(t),account=f.account(),m=f.rpc('erp_catalog_payment_method_save',command({...method,account_id:account.id,fee_rate:'2'})).item,s=f.saveSeller();
 const request=(path,data)=>new Request(`https://erp.invalid${path}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
 const data={...method,description:'Nova forma'};
 const financeKeys=['account_id','interest_rate','fine_rate','auto_settle','fee_type','fee_rate','fee_fixed','settlement_days'];financeKeys.forEach(key=>delete data[key]);
 const path=`/v1/cadastros/formas-pagamento/${m.id}`;
 const op=await contactOperation(request(path,{command_id:randomUUID(),expected_version:m.version,data}),contactRoute(path),new URLSearchParams());
 absent(op.args.p_data,financeKeys);f.rpc(op.rpc,op.args,baseOnly);
 assert.equal(f.rpc('erp_catalog_payment_method_get',{p_id:m.id}).item.account_id,account.id);
 assert.equal(f.rpc('erp_catalog_payment_method_get',{p_id:m.id}).item.fee_rate,'2.0000');
 const settings={...sellerSettings,notes:'Observação nova'};
 const commissionKeys=['commission_rule','commission_mode','commission_rate','commission_bands'];commissionKeys.forEach(key=>delete settings[key]);
 const spath=`/v1/cadastros/vendedores/${s.seller.id}`;
 const sop=await contactOperation(request(spath,{command_id:randomUUID(),expected_version:s.seller.version,contact_expected_version:s.contact.version,contact:{name:'Novo vendedor'},settings}),contactRoute(spath),new URLSearchParams());
 absent(sop.args.p_settings,commissionKeys);f.rpc(sop.rpc,sop.args,baseOnly);
 assert.equal(f.rpc('erp_catalog_seller_get',{p_id:s.seller.id}).seller.commission_rate,'3.0000');
});

test('2: preços, PDV, relatórios e preferências de campos mistos são classificados; atalhos compartilhados são recortados',t=>{
 const f=fixture(t),at=Date.now()*1000;
 for(const [table,columns,values] of [
  ['erp_pos__audit','actor,command_id,action,after_data,created_at',[admin,randomUUID(),'settings_save','{"account_id":"oculto"}',at]],
  ['erp_pricing__audit','actor,command_id,list_id,action,after_data,created_at',[admin,randomUUID(),randomUUID(),'create','{"name":"Lista histórica"}',at]],
 ]) f.lite.prepare(`INSERT INTO ${table}(${columns}) VALUES(${values.map(()=>'?').join(',')})`).run(...values);
 f.rpc('erp_preferences_report_save',{p_report:null,p_expected_version:0,p_command_id:randomUUID(),p_data:{base:'contas_receber',title:'Receitas',columns:['contato'],filters:[],view_limit:20,with_totals:false,users:[]}});
 const contact='/cadastros-reais?cadastro=contacts',finance='/financeiro-empresa?area=contas-financeiras';
 f.rpc('erp_home_shortcuts_save',{p_command_id:randomUUID(),p_expected_version:0,p_shortcuts:[contact,finance],p_labels:{[finance]:'Financeiro reservado'}});
 const pref=f.rpc('erp_preferences_page',{p_page:'vendas-vendas'}).items.find(i=>i.key==='vendas.contas_automaticas_pedido');
 f.rpc('erp_preferences_save',{p_command_id:randomUUID(),p_page:'vendas-vendas',p_changes:[{key:pref.key,expected_version:pref.version,value:!pref.value}]});
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date()),args={p_from:today,p_to:today,p_limit:100,p_offset:0,p_module:null,p_operation:null,p_actor:null,p_query:null};
 const all=f.rpc('erp_activity_list',args);
 for(const [source,parts] of [['pos',{pos:false}],['pricing',{products:false}],['frameworks',{finance:false}],['preferences',{finance:false}]]) {
  const event=all.items.find(i=>i.source===source);assert.ok(event,source);
  assert.equal(f.rpc('erp_activity_list',args,parts).items.some(i=>i.source===source&&i.id===event.id),false);
  assert.throws(()=>f.rpc('erp_activity_detail',{p_source:source,p_entry_id:event.id},parts),e=>e.code==='module_disabled');
 }
 const home=all.items.find(i=>i.source==='home');assert.ok(home);
 const detail=f.rpc('erp_activity_detail',{p_source:'home',p_entry_id:home.id},{finance:false});
 assert.deepEqual(detail.after.shortcuts,[contact]);assert.deepEqual(detail.after.labels,{});
 assert.ok(f.rpc('erp_activity_detail',{p_source:'home',p_entry_id:home.id}).after.shortcuts.includes(finance));
});

test('6: listagem e prévia de conversão também retiram os vínculos suspensos',async t=>{
 const f=fixture(t),c=f.contact(),p=f.product(),account=f.account(),category=f.category();
 const warehouse=f.rpc('erp_catalog_save',{p_entity:'warehouses',...command({name:'Depósito'})}).record;
 const body={date:'2026-10-15',contact_id:c.id,warehouse_id:warehouse.id,items:[{product_id:p.id,description:p.name,unit:'UN',quantity:'1',unit_price:'10'}]};
 const sale=f.rpc('erp_document_save',{p_kind:'sales_orders',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:{...body,category_id:category.id,payment_account_id:account.id}}).document;
 const url=new URL('https://erp.invalid/v1/documentos/sales_orders'),route=documentsRoute(url.pathname),op=await documentsOperation(new Request(url),route,url.searchParams);
 const listed=f.rpc(op.rpc,op.args,{stock:false});assert.ok(listed.items.some(i=>i.id===sale.id));
 for(const value of [listed,documentsResponse(listed,route,op)])absent(value.items.find(i=>i.id===sale.id),['warehouse_id','warehouse_name']);
 const proposal=f.rpc('erp_document_save',{p_kind:'sales_proposals',p_id:null,p_expected_version:0,p_command_id:randomUUID(),p_body:body}).document;
 const stored=JSON.parse(f.lite.prepare('SELECT body FROM erp_documents__document WHERE id=?').get(proposal.id).body);
 f.lite.prepare('UPDATE erp_documents__document SET body=? WHERE id=?').run(JSON.stringify({...stored,category_id:category.id,payment_account_id:account.id}),proposal.id);
 // O portão atual confunde p_kind (destino) com o tipo da proposta; a correção
 // desse portão pertence a outra tarefa. Aqui se verifica o leitor e seu parser.
 const preview=erpDocumentConversionPreview({db:nodeDriver(f.lite),parts:normalizeErpParts({stock:false,finance:false})},{p_user_id:admin,p_kind:'sales_orders',p_proposal_id:proposal.id});
 const parsed=documentsResponse(preview,{kind:'sales_orders',proposal:proposal.id},{type:'from_proposal'});
 for(const value of [preview,parsed])absent(value.data,['warehouse_id','category_id','payment_account_id']);
});

test('2: preferências de listagem compartilhada não expõem colunas e filtros da parte desligada',t=>{
 const f=fixture(t),category=f.category();
 f.rpc('erp_list_preferences_save',{p_list_id:'cadastros.contatos',p_command_id:randomUUID(),p_expected_version:0,p_columns:['name','credit_limit'],p_filters:{name:'Cliente',finance_category_id:category.id}});
 const id=String(f.lite.prepare('SELECT max(id) id FROM erp_list_preferences__audit').get().id);
 const detail=f.rpc('erp_activity_detail',{p_source:'list_preferences',p_entry_id:id},baseOnly);
 assert.deepEqual(detail.after.columns,['name']);assert.deepEqual(detail.after.filters,{name:'Cliente'});
 assert.equal(f.rpc('erp_activity_detail',{p_source:'list_preferences',p_entry_id:id}).after.filters.finance_category_id,category.id);
});

test('projetar cadastros não permite limpar campos suspensos nem gravar recibos de alterações recusadas',t=>{
 const f=fixture(t),account=f.account(),category=f.category();
 const c=f.contact({credit_limit_mode:'value',credit_limit:'100',finance_category_id:category.id});
 const supplier=f.contact({types:['supplier']});
 const p=f.product({stock_min:'2',lot_control:true,suppliers:[{supplier_id:supplier.id,is_default:true,cost_price:'8'}]});
 const m=f.rpc('erp_catalog_payment_method_save',command({...method,account_id:account.id,fee_rate:'2'})).item;
 const s=f.saveSeller();
 const snapshot=()=>Object.fromEntries([
  'erp_catalog__record','erp_catalog__contact_profile','erp_catalog__product','erp_catalog__product_detail',
  'erp_catalog__product_supplier','erp_catalog__product_cost_history','erp_catalog__payment_method',
  'erp_catalog__seller','erp_catalog__command','erp_catalog__audit','erp_catalog__auxiliary_audit',
 ].map(table=>[table,f.lite.prepare(`SELECT * FROM ${table}`).all()]));
 const before=snapshot();
 for(const data of [{finance_category_id:null},{credit_limit:'200'}])
  assert.throws(()=>f.rpc('erp_catalog_contact_save',command(data,c),baseOnly),e=>e.code==='module_disabled');
 for(const data of [{suppliers:[]},{stock_min:null},{lot_control:false}])
  assert.throws(()=>f.rpc('erp_catalog_product_save',command(data,p),{stock:false,purchases:false}),e=>e.code==='module_disabled');
 for(const data of [{...method,account_id:null,fee_rate:'2'},{...method,account_id:account.id,fee_rate:null}])
  assert.throws(()=>f.rpc('erp_catalog_payment_method_save',command(data,m),baseOnly),e=>e.code==='module_disabled');
 assert.throws(()=>f.rpc('erp_catalog_seller_save',{
  p_id:s.seller.id,p_expected_version:s.seller.version,p_contact_expected_version:s.contact.version,
  p_command_id:randomUUID(),p_contact:{name:'Vendedor'},p_settings:{...sellerSettings,commission_rate:null},
 },baseOnly),e=>e.code==='module_disabled');
 assert.deepEqual(snapshot(),before);
 absent(f.rpc('erp_catalog_contact_get',{p_id:c.id},baseOnly).record,['credit_limit','finance_category_id']);
 absent(f.rpc('erp_catalog_product_get',{p_id:p.id},{stock:false,purchases:false}).record,['suppliers','stock_min','lot_control']);
 assert.equal(f.rpc('erp_catalog_contact_get',{p_id:c.id}).record.credit_limit,'100.00');
 assert.equal(f.rpc('erp_catalog_product_get',{p_id:p.id}).record.suppliers[0].cost_price,'8.0000');
});

test('5: listas por cursor também ocultam limites e localização de Estoque no motor e no HTTP',t=>{
 const f=fixture(t),p=f.product({stock_min:'2',stock_max:'5',location:'Prateleira reservada'});
 for(const rpc of ['erp_catalog_list','erp_catalog_product_list']) {
  const args={...(rpc==='erp_catalog_list'?{p_entity:'products'}:{}),p_limit:25},route={entity:'products'},operation={type:'list',args};
  const full=f.rpc(rpc,args),on=catalogResponse(full,route,operation);
  assert.equal(on.items[0].stock_min,'2.000000');
  assert.equal(on.items[0].location,'Prateleira reservada');
  const raw=f.rpc(rpc,args,{stock:false});
  for(const value of [raw,catalogResponse(raw,route,operation)]) {
   assert.equal(value.items[0].id,p.id);
   absent(value.items[0],['stock_min','stock_max','location']);
   assert.ok(value.items[0].unavailable_parts.includes('stock'));
   assert.equal(value.items[0].price,'10.0000');
  }
  assert.deepEqual(f.rpc(rpc,args),full);
 }
});

test('6: omissão e reenvio idêntico preservam vínculos e lotes no banco; limpeza não deixa efeitos', t => {
 const f = fixture(t), c = f.contact(), p = f.product({lot_control:true}), account = f.account(), category = f.category();
 const warehouse = f.rpc('erp_catalog_save', {p_entity:'warehouses', ...command({name:'Depósito'})}).record;
 const lot = f.rpc('erp_stock_lot_save', {p_command_id:randomUUID(), p_product_id:p.id, p_lot_id:null, p_expected_version:0, p_code:'L-1'}).lot;
 const details = {account_id:account.id, payment_type:null, card_brand:null, integration_type:null,
  acquirer_cnpj:null, authorization_code:null, received_amount:null, fee_amount:'1.00', commission_fee_amount:'0.50'};
 const parts = {stock:false, finance:false};
 let doc = f.rpc('erp_document_save', {p_kind:'sales_orders', p_id:null, p_expected_version:0, p_command_id:randomUUID(), p_body:{
  date:'2026-10-15', contact_id:c.id, warehouse_id:warehouse.id, category_id:category.id, payment_account_id:account.id,
  items:[{product_id:p.id, description:p.name, unit:'UN', quantity:'1', unit_price:'10', lots:[{lot_id:lot.id, quantity:'1'}]}],
  installments:[{due_date:'2026-11-20', amount:'10', payment_method_id:null, details}],
 }}).document;
 const stored = () => ({
  body:JSON.parse(f.lite.prepare('SELECT body FROM erp_documents__document WHERE id=?').get(doc.id).body),
  item:JSON.parse(f.lite.prepare('SELECT data FROM erp_documents__item WHERE document_id=?').get(doc.id).data),
 });
 const editable = () => {
  const {body, item} = stored();
  delete body.totals;
  body.installments = body.installments.map(({position, ...row}) => row);
  for (const key of ['total','position','gross','discount']) delete item[key];
  return {...body, items:[item]};
 };
 const save = body => f.rpc('erp_document_save', {p_kind:doc.kind, p_id:doc.id, p_expected_version:doc.version, p_command_id:randomUUID(), p_body:body}, parts).document;
 const original = stored();
 const assertPreserved = () => {
  const current = stored();
  for (const key of ['warehouse_id','category_id','payment_account_id']) assert.equal(current.body[key], original.body[key]);
  assert.deepEqual(current.body.installments[0].details, original.body.installments[0].details);
  assert.deepEqual(current.item.lots, original.item.lots);
  absent(doc, ['warehouse_id','category_id','payment_account_id']);
  absent(doc.installments[0].details, ['account_id','fee_amount','commission_fee_amount']);
  absent(doc.items[0], ['lots']);
 };
 const omitted = editable();
 for (const key of ['warehouse_id','category_id','payment_account_id']) delete omitted[key];
 for (const key of ['account_id','fee_amount','commission_fee_amount']) delete omitted.installments[0].details[key];
 delete omitted.items[0].lots;
 omitted.installments[0].due_date = '2026-12-01';
 f.queries.length = 0;
 doc = save(omitted);
 assert.equal(f.queries.some(sql => /FROM "erp_stock__lot"/.test(sql)), false);
 assertPreserved();
 assert.equal(doc.installments[0].due_date, '2026-12-01');
 const equal = editable(); equal.installments[0].details.fee_amount = '1'; equal.items[0].lots[0].quantity = '1';
 doc = save(equal); assertPreserved();
 const withoutPlan = editable(); delete withoutPlan.installments;
 doc = save(withoutPlan); assertPreserved();
 const snapshot = () => Object.fromEntries(['erp_documents__document','erp_documents__item','erp_documents__command','erp_documents__audit',
  'erp_stock__movement','erp_stock__lot'].map(table => [table, f.lite.prepare(`SELECT * FROM ${table}`).all()]));
 const beforeRejected = snapshot();
 const rejected = [];
 for (const key of ['warehouse_id','category_id','payment_account_id']) for (const value of [null, randomUUID()])
  rejected.push({...editable(), [key]:value});
 for (const key of ['account_id','fee_amount','commission_fee_amount']) {
  const body = editable(); body.installments[0].details[key] = null; rejected.push(body);
 }
 for (const lots of [null, [], [{lot_id:randomUUID(), quantity:'1'}]]) {
  const body = editable(); body.items[0].lots = lots; rejected.push(body);
 }
 for (const installments of [null, []]) rejected.push({...editable(), installments});
 for (const body of rejected) assert.throws(() => save(body), e => e.code === 'module_disabled');
 assert.deepEqual(snapshot(), beforeRejected);
 const restored = f.rpc('erp_document_get', {p_kind:doc.kind, p_id:doc.id}).document;
 assert.equal(restored.payment_account_id, account.id);
 assert.deepEqual(restored.installments[0].details, original.body.installments[0].details);
 assert.deepEqual(restored.items[0].lots, original.item.lots);
});

test('4, 5 e 7: reenvio dos valores suspensos preserva cadastro e custo sem expô-los no recibo', t => {
 const f = fixture(t), category = f.category(), account = f.account(), supplier = f.contact({types:['supplier']});
 const contactData = {name:'Contato', finance_category_id:category.id, credit_limit_mode:'value', credit_limit:'100'};
 let c = f.contact(contactData);
 const suppliers = [{supplier_id:supplier.id, is_default:true, purchase_price:'7', cost_price:'8'}];
 const p = f.product({suppliers, lot_control:true, stock_min:'2'});
 let m = f.rpc('erp_catalog_payment_method_save', command({...method, account_id:account.id, fee_rate:'2'})).item;
 const s = f.saveSeller();
 const snapshot = () => ({
  ...Object.fromEntries(['erp_catalog__contact_profile','erp_catalog__product_supplier','erp_catalog__product_cost_history',
   'erp_catalog__product_detail','erp_catalog__seller'].map(table => [table, f.lite.prepare(`SELECT * FROM ${table}`).all()])),
  // Versão e data da forma mudam no salvamento legado; os campos suspensos não podem mudar.
  payment_finance:f.lite.prepare('SELECT id,account_id,interest_rate,fine_rate,auto_settle,fee_type,fee_rate,fee_fixed,settlement_days FROM erp_catalog__payment_method').all(),
 });
 const before = snapshot();
 c = f.rpc('erp_catalog_contact_save', command(contactData, c), baseOnly).record;
 const product = f.rpc('erp_catalog_product_save', command({suppliers, lot_control:true, stock_min:'2'}, p), {stock:false,purchases:false}).record;
 m = f.rpc('erp_catalog_payment_method_save', command({...method, account_id:account.id, fee_rate:'2'}, m), baseOnly).item;
 const seller = f.rpc('erp_catalog_seller_save', {p_id:s.seller.id, p_expected_version:s.seller.version,
  p_contact_expected_version:s.contact.version, p_command_id:randomUUID(), p_contact:{name:'Vendedor'}, p_settings:sellerSettings}, baseOnly);
 assert.deepEqual(snapshot(), before);
 absent(c, ['credit_limit','finance_category_id']); absent(product, ['suppliers','cost_price','lot_control','stock_min']);
 absent(m, ['account_id','fee_rate']); absent(seller.seller, ['commission_rate']);
 for (const parts of [{stock:false}, {purchases:false}]) {
  const current = f.rpc('erp_catalog_product_get', {p_id:p.id}).record;
  const args = {p_command_id:randomUUID(), p_supplier_id:supplier.id,
   p_items:[{product_id:p.id, expected_version:current.version, price:'20', cost_price:'8'}]};
  const result = f.rpc('erp_catalog_product_prices_update', args, parts);
  absent(result, ['supplier_id']); absent(result.items[0], ['cost_price']);
  assert.deepEqual(snapshot(), before);
  const receipts = f.lite.prepare('SELECT * FROM erp_catalog__command').all();
  assert.deepEqual(f.rpc('erp_catalog_product_prices_update', args, parts), {...result, replayed:true});
  assert.deepEqual(f.lite.prepare('SELECT * FROM erp_catalog__command').all(), receipts);
 }
 assert.equal(f.rpc('erp_catalog_product_get', {p_id:p.id}).record.suppliers[0].cost_price, '8.0000');
});

test('6: documentos novos e cópias sem integrações mantêm referências nulas apenas no armazenamento', t => {
 const f = fixture(t), c = f.contact(), p = f.product(), parts = {stock:false,finance:false};
 const body = {date:'2026-10-15', contact_id:c.id,
  items:[{product_id:p.id, description:p.name, unit:'UN', quantity:'1', unit_price:'10'}],
  installments:[{due_date:'2026-11-20', amount:'10'}]};
 const check = doc => {
  absent(doc, ['warehouse_id','category_id','payment_account_id']);
  const stored = JSON.parse(f.lite.prepare('SELECT body FROM erp_documents__document WHERE id=?').get(doc.id).body);
  assert.equal(stored.warehouse_id, null);
  for (const key of ['category_id','payment_account_id']) assert.equal(stored[key] ?? null, null);
  assert.equal(f.lite.prepare('SELECT count(*) n FROM erp_finance__document_posting WHERE document_id=?').get(doc.id).n, 0);
 };
 for (const kind of ['sales_orders','sales_proposals','purchase_orders','service_orders']) {
  const saved = f.rpc('erp_document_save', {p_kind:kind, p_id:null, p_expected_version:0, p_command_id:randomUUID(), p_body:body}, parts);
  check(saved.document);
  if (kind !== 'sales_orders') continue;
  const preview = f.rpc('erp_document_copy_preview', {p_kind:kind, p_source_id:saved.document.id}, parts);
  const copy = f.rpc('erp_document_copy', {p_kind:kind, p_source_id:saved.document.id, p_expected_source_version:saved.document.version,
   p_command_id:randomUUID(), p_body:preview.data}, parts);
  check(copy.document);
 }
});

test('6 e 7: fotografias de produtos no documento e no replay também ocultam campos de Estoque', t => {
 const f = fixture(t), c = f.contact(), p = f.product({stock_min:'2', stock_max:'5', location:'Local reservado'});
 const args = {p_kind:'sales_orders', p_id:null, p_expected_version:0, p_command_id:randomUUID(), p_body:{date:'2026-10-15', contact_id:c.id,
  items:[{product_id:p.id, description:p.name, unit:'UN', quantity:'1', unit_price:'10'}]}};
 const doc = f.rpc('erp_document_save', args).document;
 assert.equal(doc.items[0].product_snapshot.location, 'Local reservado');
 assert.equal(doc.items[0].product_snapshot.stock_min, '2.000000');
 const snapshot = () => ({
  items:f.lite.prepare('SELECT * FROM erp_documents__item WHERE document_id=?').all(doc.id),
  receipt:f.lite.prepare('SELECT * FROM erp_documents__command WHERE command_id=?').get(args.p_command_id),
 });
 const before = snapshot();
 for (const raw of [f.rpc('erp_document_get', {p_kind:doc.kind,p_id:doc.id}, {stock:false}), f.rpc('erp_document_save', args, {stock:false})]) {
  const parsed = documentsResponse(raw, {kind:doc.kind,id:doc.id}, {type:'document',rpc:'erp_document_save'});
  for (const result of [raw, parsed]) {
   const product = result.document.items[0].product_snapshot;
   absent(product, ['stock_min','stock_max','location','lot_control']);
   assert.equal(product.name, p.name); assert.equal(product.price, '10.0000');
   assert.ok(product.unavailable_parts.includes('stock'));
  }
 }
 assert.deepEqual(snapshot(), before);
 assert.equal(f.rpc('erp_document_get', {p_kind:doc.kind,p_id:doc.id}).document.items[0].product_snapshot.location, 'Local reservado');
});
