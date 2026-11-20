// Wabotia: telas do ERP com só a base (Cadastros) ligada. Parte desligada nunca vira
// "Não foi possível concluir a operação": o dado auxiliar some, sem aviso de erro.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {mountComponent,AccessError} from './helpers/component-recovery-harness.mjs';
import {HOME_SHORTCUTS,homePeriodBuckets,homePeriodRange} from './upstream/workers/erp-api/src/home.mjs';

const blocks=fileURLToPath(new URL('../blocks.ts',import.meta.url));
// Só a base ligada, como o hospedeiro publica (setPanelPartsContext → setErpModuleContext).
const onlyBase={'../../blocks':`export * from ${JSON.stringify(blocks)};import {setErpModuleContext} from ${JSON.stringify(blocks)};setErpModuleContext({erp:true});`};

test('/receber-bling abre a tela Receber dados do Bling, não o Dashboard geral', async () => {
 const view=await mountComponent('../App.tsx',{}, {location:'/receber-bling',modules:{
  react:'export const lazy=()=>"real-access";',
  'react-router-dom':'export const Navigate="navigate",useLocation=r.useLocation;',
  './components/NativeModuleBoundary':'export default "boundary";',
  './components/RealAccess':'export default "real-access";',
 }});
 try {
  assert.equal(view.nodes().some(node=>node.type==='navigate'),false,'não redireciona para /acesso (Dashboard geral)');
  assert.ok(view.nodes().some(node=>node.type==='boundary'));
 } finally {view.unmount();}
});

test('Clientes: com Produtos e serviços desligado, o filtro Lista de preço some, sem aviso de erro', async () => {
 const options={tags:[],groups:[],loaded:true,failed:false,lists:null,listsState:'off'};
 const view=await mountComponent('ContactTags.tsx',{options,tag:'',priceList:'',onTag(){},onPriceList(){}},{componentName:'ContactTagFilters',modules:onlyBase});
 try {
  assert.match(view.text(),/Tags/);
  assert.doesNotMatch(view.text(),/Lista de preço/);
  assert.doesNotMatch(view.text(),/Não foi possível/);
 } finally {view.unmount();}
});

test('recusa por parte desligada (409 module_disabled) não vira conflito nem "Não foi possível concluir a operação"', async () => {
 // A cópia portada importa sem extensão; o pacote em memória junta as duas pontas com a mesma classe AccessError.
 const {build}=await import('esbuild');
 const dir=fileURLToPath(new URL('../app/',import.meta.url));
 const out=await build({stdin:{contents:"export {errorText,partDisabled} from './components/catalog-shared.ts';export {AccessError} from './lib/real-access.ts';",resolveDir:dir,loader:'ts'},bundle:true,write:false,format:'esm',logLevel:'silent',resolveExtensions:['.ts','.tsx','.mjs','.js'],loader:{'.css':'empty'}});
 const shared=await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`),Refusal=shared.AccessError;
 const failure=new Refusal(409,'module_disabled');
 assert.equal(shared.partDisabled(failure),true);
 assert.doesNotMatch(shared.errorText(failure),/Não foi possível concluir a operação|alterado por outra operação/);
 assert.equal(shared.partDisabled(new Refusal(409)),false);
});

const uid='a0000000-0000-4000-8000-000000000001',today='2026-10-19';
function summary(path){
 const params=new URL(path,'https://synthetic.invalid').searchParams,key=params.get('periodo')??'hoje';
 const [from,to]=homePeriodRange(key,today,params.get('de'),params.get('ate')),{grain,buckets}=homePeriodBuckets(from,to);
 return {data_mode:'erp_native',as_of:'2026-10-19T12:00:00Z',business_date:today,timezone:'America/Sao_Paulo',role:'admin',
  catalog:[{entity:'contacts',active:1,archived:0}],documents:[],stock:null,finance:null,
  period:{key,from,to,day_count:(Date.parse(to)-Date.parse(from))/86400000+1,grain,
   points:buckets.map(bucket=>({bucket,sales_cents:null,receivable_cents:null,payable_cents:null})),sales:null,receivable:null,payable:null,invoices:null}};
}
test('Dashboard geral com só a base: estado vazio amigável, atalhos carregam e nenhum erro', async () => {
 const calls=[],snapshot={phase:'ready',membership:{user_id:uid,role:'admin',resources:['contacts','products','sales_orders','purchase_orders','sales_proposals','receivables','payables','nfe','nfce']}};
 const controller={getSnapshot:()=>snapshot,subscribe:()=>()=>{},async platform(){throw new AccessError(409,'module_disabled');},async sales(){throw new AccessError(409,'module_disabled');},async system(){throw new AccessError(409,'module_disabled');},
  async home(path,options={}){calls.push(path);
   if(path==='/v1/inicio/atalhos')return {scope:'home_shortcuts',data_mode:'erp_native',role:'admin',version:0,customized:false,shortcuts:[],available:Object.keys(HOME_SHORTCUTS).filter(item=>HOME_SHORTCUTS[item].includes('admin')&&/cadastros-reais\?cadastro=contacts|vendedores|funcionarios/.test(item))};
   assert.equal(options.method,undefined);return summary(path);}};
 const view=await mountComponent('RealHome.tsx',{controller},{location:'/visao-geral',modules:onlyBase,expandChildren:['HomeView','HomeFavorites','HomeChartCards','HomeChart','HomeNewInvoices','HomeExpiring']});
 try {
  assert.deepEqual(calls.sort(),['/v1/inicio/atalhos','/v1/inicio?periodo=hoje']);
  const text=view.text();
  assert.doesNotMatch(text,/Não foi possível carregar o resumo/);
  assert.doesNotMatch(text,/Não foi possível carregar os atalhos favoritos/);
  assert.match(text,/Com só Cadastros ligado, este painel mostra os atalhos e os cadastros\./);
  assert.doesNotMatch(text,/Vendas no período|A receber no período|A pagar no período/);
 } finally {view.unmount();}
});
