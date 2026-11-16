// Centro de preferências (migração 115): workers/erp-api/test/preferences-sql.test.mjs do Fagoo na fixture dupla.
// Adaptações: a validação de valores compara o oráculo com o porte em TS (valueValid) pelo f.dual, com os candidatos
// do original sobre as páginas do pacote do Fagoo (src/erp/fagoo); updates diretos de membership passam pela cópia;
// o "other" do original (outro administrador) entra no oráculo e passa pela cópia.
// Fora, declarados: "115 committed definitions are exactly the generated block…" (o gerador e o pacote são do Fagoo;
// o oráculo já tem as definições finais) e "115 tables and helpers are private…" (GRANT e os gatilhos acionados por SQL
// direto; no motor os valores só mudam pelo comando).
import test from'node:test';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
import{dualFixture}from'../harness/dual-fixture.mjs';import{inTransaction}from'../../../src/erp/engine/registry.ts';import{valueValid,definition}from'../../../src/erp/domains/preferences/center.ts';
// Fixture dupla com os auxiliares da preferences-fixture do Fagoo; "other" (outro administrador do original) é o consulta.
// Fixture dupla com os auxiliares da preferences-fixture do Fagoo.
async function preferencesFixture(){
 const f=await dualFixture();const other=randomUUID();
 await f.db.query("insert into auth.users(id,email) values($1,'other@sintetico.test')",[other]);
 await f.db.query("insert into erp_access.membership(user_id,role,active) values($1,'admin',true)",[other]);
 await f.db.query("insert into erp_access.profile(user_id,name,version,updated_by,updated_at) values($1,'Pessoa sintética other',1,$1,now())",[other]);
 await f.sync();const users={...f.users,other};
 const page=(pageId,user=users.admin)=>f.rpc('erp_preferences_page',{p_user_id:user,p_page:pageId});
 const save=(pageId,changes,{user=users.admin,command=randomUUID()}={})=>f.rpc('erp_preferences_save',{p_user_id:user,p_command_id:command,p_page:pageId,p_changes:changes});
 const command=(id,user=users.admin)=>f.rpc('erp_preferences_command',{p_user_id:user,p_command_id:id});
 const write=async(sql,args=[])=>{await f.db.query(sql,args);await f.sync();};
 return{...f,users,page,save,command,write};
}
const fails=(assert,fn,code,message)=>assert.rejects(fn,e=>e.code===code&&(!message||e.message===message));
import{STORED_PREFERENCE_PAGES}from'../../../src/erp/fagoo/packages/erp-domain/src/preferences/catalog.mjs';
import{storedFields}from'../../../src/erp/fagoo/packages/erp-domain/src/preferences/core.mjs';


const ADMIN_ONLY_SAMPLE=[{key:'empresa.decimais_quantidade',expected_version:0,value:4}];
// This fixture applies the migrations through 152; keys added later (field `since`, wave C) are checked by preferences-c-sql.
const applied=p=>storedFields(p);


// Candidate values per kind, compared one by one between erp_preferences.value_valid and valueValid (TS).
const CPF='52998224725',CNPJ='11222333000181',ALNUM='12ABC34501DE35';
function candidates(field){
 const common=[null,true,false,0,1,-1,'','x',[],{},'0','1.5',[field.default]];
 switch(field.kind){
  case'choice':return[...common,...field.options.map(o=>o[0]),field.options[0][0]+' ','OUTRO'];
  case'multi':{const v=field.options.map(o=>o[0]);return[...common,v,[...v].reverse(),[v[0],v[0]],v.slice(0,1),[...v,'extra'],[1]];}
  case'integer':return[...common,field.min,field.max,field.min-1,field.max+1,1.5,1e9,2.0];
  case'decimal':return[...common,'0','12.5','12.55','12.555','99999','99999.01','100000','01','-1','1.','1.0'];
  case'text':return[...common,'a'.repeat(field.maxLength),'a'.repeat(field.maxLength+1),' a','a ','a\u0001','a\u007f','aé','fulano@sintetico.test','fulano@sintetico','a@b.c, d@e.f','a@b.c,,d@e.f','a@b.c,d@e.f,g@h.i,j@k.l,m@n.o,p@q.r','fu lano@x.y'];
  case'textarea':return[...common,'linha 1\nlinha 2','\nlinha','linha\n','linha\t','a'.repeat(field.maxLength+1),' a'];
  case'users':return[...common,['10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001'],['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'],['10000000-0000-4000-8000-00000000000A'],['x']];
  case'keymap':{const d=field.default,swap={...d,cliente:d.pagamento};const missing={...d};delete missing.cliente;return[...common,d,swap,missing,{...d,extra:'X'},{...d,cliente:'1'},{...d,cliente:'c'}];}
  case'documents':return[...common,[{document:CPF,name:'Contador sintético'}],[{document:CNPJ,name:''}],[{document:ALNUM,name:'Alfanumérico'}],[{document:'52998224724',name:''}],
   [{document:CPF,name:''},{document:CPF,name:'Duplicado'}],[{document:CPF}],[{document:CPF,name:' x'}],Array.from({length:field.maxItems+1},()=>({document:CPF,name:''}))];
  default:return common;
 }
}
test('115 value validation is identical in SQL and in the shared schema for every definition',async()=>{
 const f=await preferencesFixture();try{
  const fields=STORED_PREFERENCE_PAGES.flatMap(p=>applied(p));let compared=0;
  // Função pura: o oráculo responde todos os candidatos numa consulta só e o porte, um a um na mesma ordem.
  const pairs=fields.flatMap(field=>candidates(field).map(value=>[field.key,value]));
  const sql=(await f.db.query('select erp_preferences.value_valid(d,x.v::jsonb) v from unnest($1::text[],$2::text[]) with ordinality x(k,v,n) join erp_preferences.definition d on d.key=x.k order by x.n',
   [pairs.map(p=>p[0]),pairs.map(p=>p[1]===null?null:JSON.stringify(p[1]))])).rows.map(r=>r.v);
  assert.equal(sql.length,pairs.length);
  inTransaction(f.driver,ctx=>{for(const [i,[key,value]] of pairs.entries()){
   assert.equal(valueValid(definition(ctx.db,key),value),sql[i],`${key} ${JSON.stringify(value)}`);compared++;
  }});
  assert.ok(compared>4000);
 }finally{await f.close();}
});

test('115 reads follow the page roles; company writes are administrador-only; inactive and unknown users are refused',async()=>{
 const f=await preferencesFixture();try{
  const p=await f.page('notas-nfe',f.users.fiscal);assert.equal(p.role,'fiscal');assert.equal(p.can_manage,false);assert.equal(p.items.length,50);
  await fails(assert,()=>f.page('notas-nfe',f.users.financeiro),'42501');
  await fails(assert,()=>f.page('financas-receber',f.users.vendas),'42501');
  await fails(assert,()=>f.page('empresa-geral',f.users.inactive),'42501');
  await fails(assert,()=>f.page('empresa-geral',randomUUID()),'42501');
  await fails(assert,()=>f.page('inexistente'),'P0002');
  for(const role of['consulta','vendas','financeiro','estoque','fiscal'])await fails(assert,()=>f.save('empresa-geral',ADMIN_ONLY_SAMPLE,{user:f.users[role]}),'42501');
  assert.equal(await f.scalar('select count(*)::int v from erp_preferences.command'),0);
  const saved=await f.save('empresa-geral',ADMIN_ONLY_SAMPLE);assert.equal(saved.replayed,false);assert.equal(saved.page.items[0].value,4);
  const seen=await f.page('empresa-geral',f.users.vendas);assert.equal(seen.items[0].value,4);assert.equal(seen.items[0].version,1);assert.equal(seen.can_manage,false);
 }finally{await f.close();}
});

test('115 user pages keep one value per user and any member saves only their own',async()=>{
 const f=await preferencesFixture();try{
  const mine=await f.save('sistema-interface',[{key:'sistema.tema_escuro',expected_version:0,value:true}],{user:f.users.vendas});
  assert.equal(mine.page.owner,'user');assert.equal(mine.page.items[0].value,true);
  assert.equal((await f.page('sistema-interface',f.users.admin)).items[0].value,false);
  assert.equal((await f.page('sistema-interface',f.users.vendas)).items[0].version,1);
  assert.deepEqual(await f.scalar("select erp_preferences.get('sistema.tema_escuro',$1) v",[f.users.vendas]),true);
  assert.deepEqual(await f.scalar("select erp_preferences.get('sistema.tema_escuro',$1) v",[f.users.consulta]),false);
  assert.equal(await f.scalar("select owner::text v from erp_preferences.audit where key='sistema.tema_escuro'"),f.users.vendas);
  await fails(assert,()=>f.command(mine.receipt.command_id,f.users.admin),'42501');
  assert.equal((await f.command(mine.receipt.command_id,f.users.vendas)).replayed,true);
 }finally{await f.close();}
});

test('115 CAS per key refuses the whole command, an unchanged value is refused and nothing partial is written',async()=>{
 const f=await preferencesFixture();try{
  await f.save('vendas-vendas',[{key:'vendas.gerar_nfe',expected_version:0,value:true}]);
  await fails(assert,()=>f.save('vendas-vendas',[{key:'vendas.editar_numero',expected_version:0,value:true},{key:'vendas.gerar_nfe',expected_version:0,value:false}]),'40001','erp_preferences_version_conflict');
  assert.equal((await f.page('vendas-vendas')).items.find(i=>i.key==='vendas.editar_numero').version,0);
  await fails(assert,()=>f.save('vendas-vendas',[{key:'vendas.gerar_nfe',expected_version:1,value:true}]),'22023','erp_preferences_unchanged');
  const two=await f.save('vendas-vendas',[{key:'vendas.editar_numero',expected_version:0,value:true},{key:'vendas.gerar_nfe',expected_version:1,value:false}]);
  assert.deepEqual(two.receipt.changes.map(c=>[c.key,c.from_version,c.to_version,c.before,c.after]),[['vendas.editar_numero',0,1,false,true],['vendas.gerar_nfe',1,2,true,false]]);
  const audit=(await f.db.query("select key,from_version,to_version,before_value,after_value,actor::text actor from erp_preferences.audit order by id")).rows;
  assert.deepEqual(audit.map(a=>[a.key,a.from_version,a.to_version,a.before_value,a.after_value,a.actor]),[['vendas.gerar_nfe',0,1,false,true,f.users.admin],['vendas.editar_numero',0,1,false,true,f.users.admin],['vendas.gerar_nfe',1,2,true,false,f.users.admin]]);
  await fails(assert,()=>f.save('vendas-vendas',[{key:'empresa.decimais_peso',expected_version:0,value:2}]),'22023','erp_preferences_input_invalid');
  await fails(assert,()=>f.save('vendas-vendas',[{key:'vendas.gerar_nfe',expected_version:2,value:'sim'}]),'22023','erp_preferences_input_invalid');
  await fails(assert,()=>f.save('vendas-vendas',[{key:'vendas.gerar_nfe',expected_version:2,value:true,extra:1}]),'22023','erp_preferences_input_invalid');
  await fails(assert,()=>f.save('vendas-vendas',[{key:'vendas.gerar_nfe',expected_version:2,value:true},{key:'vendas.gerar_nfe',expected_version:2,value:true}]),'22023','erp_preferences_input_invalid');
  await fails(assert,()=>f.save('vendas-vendas',[]),'22023');
 }finally{await f.close();}
});

test('115 the same command replays its receipt once; a different body, actor or page under the same id conflicts',async()=>{
 const f=await preferencesFixture();try{
  const command=randomUUID(),body=[{key:'compras.observacao_padrao',expected_version:0,value:'Entrega até as 17h.\nConferir notas.'}];
  const first=await f.save('suprimentos-compras',body,{command});const again=await f.save('suprimentos-compras',body,{command});
  assert.equal(first.replayed,false);assert.equal(again.replayed,true);assert.deepEqual(again.receipt,first.receipt);
  assert.equal(await f.scalar('select count(*)::int v from erp_preferences.audit'),1);
  await fails(assert,()=>f.save('suprimentos-compras',[{...body[0],value:'Outro texto'}],{command}),'40001','erp_preferences_command_conflict');
  await fails(assert,()=>f.save('suprimentos-compras',body,{command,user:f.users.other}),'40001','erp_preferences_command_conflict');
  const lookup=await f.command(command);assert.equal(lookup.replayed,true);assert.deepEqual(lookup.receipt,first.receipt);assert.equal(lookup.page.items.find(i=>i.key==='compras.observacao_padrao').version,1);
  await fails(assert,()=>f.command(command,f.users.other),'42501');
  await fails(assert,()=>f.command(randomUUID()),'P0002');
  // Losing the role keeps the receipt readable only while the author can still read the page.
  await f.write("update erp_access.membership set role='vendas' where user_id=$1",[f.users.admin]);
  await fails(assert,()=>f.command(command),'42501');
 }finally{await f.close();}
});

test('115 users fields accept only active members in canonical order; the directory is administrador-only',async()=>{
 const f=await preferencesFixture();try{
  const ids=[f.users.vendas,f.users.financeiro].sort();
  const ok=await f.save('vendas-vendas',[{key:'vendas.exibir_totais_usuarios',expected_version:0,value:ids}]);
  assert.deepEqual(ok.page.items.find(i=>i.key==='vendas.exibir_totais_usuarios').value,ids);
  await fails(assert,()=>f.save('vendas-vendas',[{key:'vendas.exibir_totais_usuarios',expected_version:1,value:[f.users.inactive]}]),'22023','erp_preferences_user_invalid');
  await fails(assert,()=>f.save('vendas-vendas',[{key:'vendas.exibir_totais_usuarios',expected_version:1,value:[randomUUID()]}]),'22023','erp_preferences_user_invalid');
  if(ids[0]!==ids[1])await fails(assert,()=>f.save('vendas-vendas',[{key:'vendas.exibir_totais_usuarios',expected_version:1,value:[...ids].reverse()}]),'22023','erp_preferences_input_invalid');
  const admin=await f.page('vendas-vendas');assert.ok(Array.isArray(admin.directory));
  assert.deepEqual(admin.directory.map(d=>d.user_id).sort(),Object.entries(f.users).filter(([k])=>k!=='inactive').map(([,v])=>v).sort());
  assert.equal((await f.page('vendas-vendas',f.users.consulta)).directory,null);
  assert.equal((await f.page('empresa-geral')).directory,null);
 }finally{await f.close();}
});

test('115 keymaps and authorized XML documents keep their structure',async()=>{
 const f=await preferencesFixture();try{
  const page=await f.page('vendas-frente-caixa');const keys=page.items.find(i=>i.key==='pdv.teclas_atalho');
  assert.equal(keys.value.cliente,'C');
  await fails(assert,()=>f.save('vendas-frente-caixa',[{key:'pdv.teclas_atalho',expected_version:0,value:{...keys.value,cliente:'B'}}]),'22023');
  const changed=await f.save('vendas-frente-caixa',[{key:'pdv.teclas_atalho',expected_version:0,value:{...keys.value,cliente:'K'}}]);
  assert.equal(changed.receipt.changes[0].after.cliente,'K');
  const docs=[{document:'52998224725',name:'Contabilidade sintética'},{document:'11222333000181',name:''}];
  const saved=await f.save('notas-nfe',[{key:'nfe.autxml_pessoas',expected_version:0,value:docs},{key:'nfe.markup',expected_version:0,value:'35.5'}]);
  assert.deepEqual(saved.page.items.find(i=>i.key==='nfe.autxml_pessoas').value,docs);
  assert.equal(await f.scalar("select erp_preferences.get('nfe.markup')#>>'{}' v"),'35.5');
  assert.equal(await f.scalar("select erp_preferences.get('nao.existe') v"),null);
 }finally{await f.close();}
});


test('115 a marked user who is later deactivated never locks the users field: others can still be added or removed',async()=>{
 const f=await preferencesFixture();try{
  const key='vendas.exibir_totais_usuarios',value=v=>[...v].sort();
  await f.save('vendas-vendas',[{key,expected_version:0,value:value([f.users.vendas,f.users.financeiro])}]);
  await f.write('update erp_access.membership set active=false where user_id=$1',[f.users.vendas]);
  const kept=await f.save('vendas-vendas',[{key,expected_version:1,value:value([f.users.vendas,f.users.financeiro,f.users.estoque])}]);
  assert.deepEqual(kept.page.items.find(i=>i.key===key).value,value([f.users.vendas,f.users.financeiro,f.users.estoque]));
  // Adding someone without active access is still refused.
  await fails(assert,()=>f.save('vendas-vendas',[{key,expected_version:2,value:value([f.users.vendas,f.users.financeiro,f.users.estoque,f.users.inactive])}]),'22023','erp_preferences_user_invalid');
  const removed=await f.save('vendas-vendas',[{key,expected_version:2,value:value([f.users.financeiro,f.users.estoque])}]);
  assert.deepEqual(removed.page.items.find(i=>i.key===key).value,value([f.users.financeiro,f.users.estoque]));
 }finally{await f.close();}
});
