import test from 'node:test';
import assert from 'node:assert/strict';
import {financeOriginOrigin} from '../app/lib/finance-origin-origin.ts';
import {mountComponent, AccessError} from './helpers/component-recovery-harness.mjs';
globalThis.document = {activeElement:null};
const id='10000000-0000-4000-8000-000000000001', other='10000000-0000-4000-8000-000000000002';
const title={id,kind:'receivable',version:1,group_id:id,installment:1,installments:1,contact_id:other,contact_name:'Contato sintético',category_id:null,category_name:null,description:'Título sintético',source_reference:'0000123',issued_on:'2026-10-01',due_on:'2026-10-20',amount_cents:'101',settled_cents:'0',balance_cents:'101',cancelled:false,status:'open',overdue:false,document_linked:false};
const envelope=(origin=true,titleId=id)=>({data_mode:'erp_native',read_only:true,title_id:titleId,origin:origin?{system:'origin',entity:'receivables',source_id:'000000123',batch_id:other,imported_at:'2026-10-16T09:00:00.123456+00:00',source_hash:'a'.repeat(64),source_version:'9007199254740993',core_fields_locked:true,cnab_reservation_blocked:true}:null});
const field=(ui,label)=>ui.input(ui.find(n=>n.type==='label'&&n.props.children===label).props.htmlFor);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('039 provenance binds exact title and direction, preserves large versions and strips excess data',()=>{
 const source=envelope();source.origin.raw_payload={secret:'never project'};
 const value=financeOriginOrigin(source,id,'receivable');assert.equal(value.source_id,'000000123');assert.equal(value.source_version,'9007199254740993');assert.equal(Object.hasOwn(value,'raw_payload'),false);
 assert.equal(financeOriginOrigin(envelope(false),id,'receivable'),null);
 for(const mutate of[v=>v.title_id=other,v=>v.origin.entity='payables',v=>v.read_only=false,v=>v.origin.core_fields_locked=false,v=>v.origin.cnab_reservation_blocked=false,v=>v.origin.source_version=9007199254740993,v=>v.origin.source_version='9223372036854775808',v=>v.origin.source_id='0',v=>v.origin.imported_at='invalid',v=>delete v.origin]){const v=envelope();mutate(v);assert.throws(()=>financeOriginOrigin(v,id,'receivable'));}
});
// Wabotia: a importação financeira do Origin saiu (item 17) e o motor responde 404 em /v1/importacao-financeira-origin;
// a conferência de origem do título fica desligada (RealFinance, ORIGIN_FINANCE_IMPORT). Os testes 039 da tela saíram com ela.
test('Wabotia: o título abre sem pedir a origem do Origin e a edição fica liberada',async()=>{
 let reads=0;const controller={async financialImportOrigin(){reads++;return envelope();},async finance(){throw Error('No mutation');}};
 const ui=await mountComponent('RealFinance.tsx',{controller,entity:'titles',record:title,writable:true,onClose(){},onEdit(){}},{componentName:'FinanceDetail'});
 try{assert.equal(reads,0);assert.equal(ui.button('Editar título').disabled,false);assert.doesNotMatch(ui.text(),/Importado do Origin|Conferindo a origem/);}finally{ui.unmount();}
});
