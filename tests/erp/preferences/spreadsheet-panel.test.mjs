import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batches, importBatchBytes, IMPORT_BATCH_PAYLOAD_BYTES, SCREEN_TEMPLATES, readSpreadsheet, autoMapping, spreadsheetImportPlan } from '../../../web/erp/app/lib/spreadsheet-import.ts';
import { jsonbText } from '../../../src/erp/engine/json.ts';

const row=(n,data)=>({row:n,lines:[n],data,problems:[]});
test('planilha: modelo CSV/XLSX, leitura e normalização são os mesmos usados pela tela', async()=>{
  for(const kind of Object.keys(SCREEN_TEMPLATES).filter(kind=>kind!=='nfe')){
    const template=SCREEN_TEMPLATES[kind];
    const csv=await readSpreadsheet('modelo.csv',new TextEncoder().encode(template.model('csv')));
    const xlsx=await readSpreadsheet('modelo.xlsx',template.model('xlsx'));
    assert.deepEqual(xlsx,csv,kind);
    assert.ok(csv[0].length>0,kind);
  }
  const template=SCREEN_TEMPLATES.products,cells=await readSpreadsheet('produtos.csv',new TextEncoder().encode('Código;Descrição;Preço\nA;Produto;12,50'));
  const parsed=template.parse(cells,autoMapping(template,cells[0]),{types:[]});
  assert.deepEqual(parsed.items[0].data,{code:'A',name:'Produto',price:'12.5'});
  assert.deepEqual(parsed.items[0].problems,[]);
});

test('planilha: 10 mil linhas em 200 lotes; textos UTF-8 repartem também por bytes',()=>{
  const rows=Array.from({length:10000},(_,i)=>row(i+2,{code:`P-${i}`,name:'Produto'}));
  assert.deepEqual(batches(rows).map(batch=>batch.length),Array(200).fill(50));
  const large=Array.from({length:50},(_,i)=>row(i+2,{code:`P-${i}`,name:'Produto',description:'ç'.repeat(4000),notes:'x'.repeat(2000)}));
  const split=batches(large);
  assert.ok(split.length>1);
  for(const batch of split){
    assert.ok(importBatchBytes(batch)<=IMPORT_BATCH_PAYLOAD_BYTES);
    const payload=batch.map(({row,lines,data})=>({row,lines,data}));
    assert.equal(importBatchBytes(batch),new TextEncoder().encode(jsonbText(payload)).length);
  }
  assert.throws(()=>batches([row(2,{items:Array.from({length:250},()=>({field:'Campo',value:'ç'.repeat(4000)}))})]),/registro.*256 KB/);
});

test('planilha: reabrir o mesmo arquivo retoma job e comandos; área/pessoa/família/conteúdo isolados',async()=>{
  const rows=[row(2,{code:'A',name:'Produto'})];
  const plan=()=>spreadsheetImportPlan('/profiles/a/erp','pessoa','products','produtos.csv',rows,rows);
  const first=await plan();
  assert.deepEqual(await plan(),first);
  const reordered=[row(2,{name:'Produto',code:'A'})];
  assert.deepEqual(await spreadsheetImportPlan('/profiles/a/erp','pessoa','products','produtos.csv',reordered,reordered),{...first,batches:[{...first.batches[0],items:reordered}]});
  for(const [scope,user,kind,file] of [['/profiles/b/erp','pessoa','products','produtos.csv'],['/profiles/a/erp','outra','products','produtos.csv'],['/profiles/a/erp','pessoa','contacts','produtos.csv'],['/profiles/a/erp','pessoa','products','outra.csv']]){
    assert.notEqual((await spreadsheetImportPlan(scope,user,kind,file,rows,rows)).id,first.id);
  }
  const changed=[row(2,{code:'A',name:'Produto alterado'})];
  assert.notEqual((await spreadsheetImportPlan('/profiles/a/erp','pessoa','products','produtos.csv',changed,changed)).id,first.id);
  // Novas linhas válidas não criam outra importação da mesma planilha: o motor
  // conserva o job e recusa alteração do total, sem duplicar o que confirmou.
  assert.equal((await spreadsheetImportPlan('/profiles/a/erp','pessoa','products','produtos.csv',rows,[])).id,first.id);
});
