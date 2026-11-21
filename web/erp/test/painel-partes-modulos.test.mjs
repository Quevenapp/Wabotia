// Vinki: Gestão → Módulos diz as dependências em palavras (falta de dois, cartão
// "Depende de" ligado ou desligado e aviso que fica depois de desligar em cascata).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mountComponent} from './helpers/component-recovery-harness.mjs';
import {ERP_PART_NAMES} from '../../../src/erp/parts.ts';

const row=(id,enabled,requires=[])=>({id,name:ERP_PART_NAMES[id],description:'',version:'0.1.0',enabled,requires,navigation:[]});
async function page(rows,put=async()=>({})){
 const list={data:{data:rows},loaded:true,reload:async()=>{},error:null};
 const app={root:'v1/profiles/demo',isAdmin:true,refresh:async()=>{},api:async(path,method,body)=>method==='PUT'?put(path,body):{data:rows}};
 const action={busyKey:null,run:async(fn)=>{try{return await fn();}catch{return undefined;}}};
 const modules={
  '../app/AppContext':'export const useApp=()=>r.app;',
  '../app/hooks':'export const useAction=()=>r.action;',
  './shared':'export const useResource=()=>r.list;',
  '../ui':'export const Confirm="confirm",Empty="empty",Notice="notice",Pill="pill",SkeletonRows="skeleton",Switch="switch";',
  'lucide-react':'export const Blocks="icon",ClipboardList="icon",CreditCard="icon",Puzzle="icon",Ticket="icon";',
 };
 return mountComponent('../../../admin/ModulesPage.tsx',{}, {componentName:'ModulesPage',expandChildren:['ModuleCard'],ports:{app,action,list},modules});
}

test('o módulo base se chama Cadastros', () => {
 assert.equal(ERP_PART_NAMES.erp,'Cadastros');
});

test('faltando dois módulos, o cartão diz "Ligue antes" com os dois e a cadeia', async () => {
 const view=await page([row('erp',true),row('erp-produtos',false,['erp']),row('erp-vendas',false,['erp-produtos']),row('erp-estoque',false,['erp-produtos']),row('erp-financeiro',false,['erp']),row('erp-pdv',false,['erp-vendas','erp-financeiro','erp-estoque'])]);
 try {
  assert.match(view.text(),/Ligue antes Produtos e serviços, Vendas, Estoque e Financeiro: este módulo depende deles\./);
  assert.match(view.text(),/Ligue antes Produtos e serviços: este módulo depende dele\./);
 } finally {view.unmount();}
});

test('"Depende de" aparece no cartão ligado e no desligado', async () => {
 const view=await page([row('erp',true),row('erp-produtos',true,['erp']),row('erp-vendas',false,['erp-produtos'])]);
 try {
  const facts=view.nodes().filter(node=>node.type==='dt'&&node.props.children==='Depende de');
  assert.equal(facts.length,2);
  assert.match(view.text(),/Depende deCadastros/);
  assert.match(view.text(),/Depende deProdutos e serviços/);
 } finally {view.unmount();}
});

test('depois de desligar em cascata, um aviso fica na tela com o que saiu junto e de quem dependia', async () => {
 const rows=[row('erp',true),row('erp-produtos',true,['erp']),row('erp-vendas',true,['erp-produtos']),row('erp-financeiro',true,['erp']),row('erp-estoque',true,['erp-produtos']),row('erp-pdv',true,['erp-vendas','erp-financeiro','erp-estoque'])];
 const view=await page(rows,async(path,body)=>({id:'erp-produtos',enabled:false,also_disabled:body.confirmed_dependents}));
 try {
  view.find(node=>node.type==='switch'&&node.props.label==='Desligar Produtos e serviços').props.onChange(false);await view.flush();
  assert.match(view.text(),/Também serão desligados: Vendas, Estoque, Caixa \/ PDV, que dependem de Produtos e serviços\./);
  view.find(node=>node.type==='confirm').props.onConfirm();await view.flush();
  const notice=view.find(node=>node.type==='notice'&&typeof node.props.children==='string');
  assert.equal(notice.props.children,'Vendas, Estoque e Caixa / PDV foram desligados junto, porque dependem de Produtos e serviços. Os dados deles continuam guardados.');
  await view.flush();
  assert.ok(view.nodes().some(node=>node===notice||node.type==='notice'&&node.props.children===notice.props.children),'o aviso continua depois de recarregar a lista');
 } finally {view.unmount();}
});

test('um só dependente: singular', async () => {
 const rows=[row('erp',true),row('erp-produtos',true,['erp']),row('erp-vendas',true,['erp-produtos'])];
 const view=await page(rows,async(path,body)=>({id:'erp-produtos',enabled:false,also_disabled:body.confirmed_dependents}));
 try {
  view.find(node=>node.type==='switch'&&node.props.label==='Desligar Produtos e serviços').props.onChange(false);await view.flush();
  view.find(node=>node.type==='confirm').props.onConfirm();await view.flush();
  assert.match(view.text(),/Vendas foi desligado junto, porque depende de Produtos e serviços\. Os dados dele continuam guardados\./);
 } finally {view.unmount();}
});
