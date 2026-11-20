import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ERP_DDL } from "../../../src/erp/schema/ddl.ts";
import { nodeDriver } from "../harness/node-driver.mjs";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { createArchiveQueries } from "../../../src/erp/bling/queries.ts";
import { createArchive } from "../../../src/erp/bling/archive.ts";
import { BLING_OPERATIONS, authorizeBlingOperation } from "../../../src/erp/bling/schema.ts";
import { guardCollectionDriver, operationalSnapshot, assertOperationalUnchanged, assertCollectionWrite } from "./contract-checks.mjs";
import { FakeBling, FakeClock } from "./fake-bling.mjs";
import { observedDecimal, unknownValue, projectRecord, parseHistoricalPayload, validateCapture, explicitOrderReference, resolveOrderReference, coverageFromPasses, fiscalIndex } from "../../../src/erp/bling/projection.ts";
import { createXmlArchive, xmlFingerprint, validateXmlBytes, selectXmlCandidates, blingXmlObjectKey, hasPendingXmlWrite } from "../../../src/erp/bling/xml.ts";
import { createArchivePurge, archiveDeleteTransaction, ARCHIVE_PURGE_DELETE_TRIGGERS } from "../../../src/erp/bling/purge.ts";

const now = Date.UTC(2026,10,19,15), profile = "area-acervo";
const sha = value => createHash("sha256").update(value).digest("hex");
const allScopes = ["public","personal","sensitive","raw","xml"];
function context(bot = false) {
  return { profile, clock:{now:()=>now},origin:"app",identity:{
    actor:{user_id:"pessoa",name:null,email:null,erp_role:"admin",session_id:"sessao",aal:"aal2",verified_factor:true,is_agent:bot},people:[],
    parts:normalizeErpParts({sales:false,stock:false,finance:false,fiscal:false}),partsControl:{profile,revision:"1",expires_at:now+600000},
  }};
}
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const sql of ERP_DDL) sqlite.exec(sql);
  const db = nodeDriver(sqlite);
  db.exec("INSERT INTO origin_sync__account(id,created_at) VALUES(1,?)",now);
  db.exec("INSERT INTO wb_bling_control(id,account_id,updated_at) VALUES(1,'conta',?)",now);
  const queries = createArchiveQueries({db:guardCollectionDriver(db),profile});
  function seed(entity,id,version,payload,current = true) {
    const text = typeof payload === "string" ? payload : JSON.stringify(payload), hash = sha(text + "[]");
    db.exec("INSERT OR IGNORE INTO origin_sync__resource_state(resource,updated_at) VALUES(?,?)",entity,now);
    if (current) {
      const extra = !["sales_orders","products","nfe","nfce","contacts","stock_balances","receivables"].includes(entity);
      db.exec(`INSERT INTO ${extra ? "wb_bling_extra_raw" : "origin_sync__raw_record"}(entity,source_id,last_resource,payload,version_hash,version,first_seen_at,last_seen_at,changed_at${extra ? ",generation" : ""}) VALUES(?,?,?,?,?,?,?,?,?${extra ? ",1" : ""})`,entity,id,entity,text,hash,version,now,now,now);
    } else db.exec("INSERT INTO erp_document_mirror__source_version(entity,source_id,source_version,source_hash,payload,document_links,observed_at) VALUES(?,?,?,?,?,'[]',?)",entity,id,version,hash,text,now);
    db.exec("INSERT INTO wb_bling_record_version(entity,source_id,version,generation,semantic_hash,size_bytes,first_seen_at,last_seen_at) VALUES(?,?,?,1,?,?,?,?)",entity,id,version,hash,new TextEncoder().encode(text).length,now,now);
    return {profile,account_id:"conta",entity,source_id:id};
  }
  return {sqlite,db,queries,seed,ctx:context()};
}

test("resolver corrente/histórico: A→B→A, IDs exatos, extras e nenhuma escrita operacional", () => {
  const f = fixture();
  try {
    f.seed("sales_orders","9007199254740993123",1,'{"id":"9007199254740993123","total":12345678901234567890.123456789}',false);
    f.seed("sales_orders","9007199254740993123",2,{total:"2"},false);
    const identity = f.seed("sales_orders","9007199254740993123",3,'{"id":"9007199254740993123","total":12345678901234567890.123456789}');
    const extra = f.seed("contracts","7",1,{id:"7",campo:"Sem destino"});
    const baseline = operationalSnapshot(f.sqlite);
    const before = f.sqlite.prepare("SELECT count(*) AS n FROM erp_document_mirror__source_version").get().n;
    const current = f.queries.readVersion(f.ctx,identity), first = f.queries.readVersion(f.ctx,identity,"1");
    assert.equal(current.version,"3"); assert.equal(first.version,"1");
    assert.equal(first.payload_text,current.payload_text); assert.equal(first.semantic_hash,current.semantic_hash);
    assert.equal(f.queries.readVersion(f.ctx,identity,"2").payload_text,'{"total":"2"}');
    assert.equal(f.queries.readVersion(f.ctx,identity,"4"),null);
    assert.equal(f.queries.readVersion(f.ctx,extra).identity.entity,"contracts");
    const firstPage = f.queries.listVersions(f.ctx,{entity:"sales_orders",id:identity.source_id,limit:2});
    assert.deepEqual(firstPage.items.map(v=>v.version),["1","2"]);
    assert.deepEqual(f.queries.listVersions(f.ctx,{entity:"sales_orders",id:identity.source_id,limit:2,cursor:firstPage.next_cursor}).items.map(v=>v.version),["3"]);
    assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM erp_document_mirror__source_version").get().n,before);
    assertOperationalUnchanged(f.sqlite,baseline);
  } finally { f.sqlite.close(); }
});

test("paginação é limitada, por identidade e vinculada à consulta/área/geração", () => {
  const f = fixture();
  try {
    for (let i=1;i<=53;i++) f.seed("products",String(i),1,{id:String(i)});
    const page = f.queries.listRecords(f.ctx,{entity:"products",limit:50});
    assert.equal(page.items.length,50);
    const next = f.queries.listRecords(f.ctx,{entity:"products",limit:50,cursor:page.next_cursor});
    assert.equal(next.items.length,3); assert.equal(next.next_cursor,null);
    assert.equal(new Set([...page.items,...next.items].map(r=>r.identity.source_id)).size,53);
    assert.throws(()=>f.queries.listRecords(f.ctx,{entity:"products",limit:51}),{code:"BLING_RESPONSE_INVALID"});
    assert.throws(()=>f.queries.listRecords(f.ctx,{entity:"nfe",cursor:page.next_cursor}),{code:"BLING_RESPONSE_INVALID"});
    assert.throws(()=>f.queries.listRecords({...f.ctx,profile:"outra-area"},{entity:"products"}),{code:"BLING_ACCOUNT_MISMATCH"});
    f.db.exec("UPDATE wb_bling_control SET generation=2 WHERE id=1");
    assert.throws(()=>f.queries.listRecords(f.ctx,{entity:"products",cursor:page.next_cursor}),{code:"BLING_RESPONSE_INVALID"});
    // Acervo preservado por purge parcial não some quando a geração é aposentada.
    assert.equal(f.queries.listRecords(f.ctx,{entity:"products",limit:50}).items.length,50);
  } finally { f.sqlite.close(); }
});

test("consulta segue Base, concessão por pessoa ∩ bot e teto de origem", () => {
  const f=fixture();
  try {
    const identity=f.seed("contacts","1",1,{id:"1",nome:"Pessoa de teste"});
    const bot=context(true);
    bot.authorization={bot:{id:"bot",allowed_operations:["erp_bling_record_get","erp_bling_records_list","erp_bling_versions_list"],allowed_entities:["contacts"],data_scopes:allScopes,allow_sensitive:false}};
    assert.equal(f.queries.readVersion(bot,identity).identity.source_id,"1");
    assert.equal(f.queries.listRecords(bot,{entity:"contacts"}).items.length,1);
    assert.equal(f.queries.listVersions(bot,{entity:"contacts",id:"1"}).items.length,1);
    assert.throws(()=>f.queries.readVersion(context(true),identity),{code:"BLING_SCOPE_REQUIRED"});
    assert.throws(()=>f.queries.readVersion({...bot,origin:"external"},identity),{code:"BLING_ADMIN_REQUIRED"});
    const insufficient={...bot,authorization:{bot:{...bot.authorization.bot,data_scopes:["public","raw"]}}};
    assert.throws(()=>f.queries.readVersion(insufficient,identity),{code:"BLING_SCOPE_REQUIRED"});
    const baseOff={...f.ctx,identity:{...f.ctx.identity,parts:{...f.ctx.identity.parts,customers:false}}};
    assert.throws(()=>f.queries.readVersion(baseOff,identity),{code:"BLING_DISABLED"});
    assert.equal(f.queries.readVersion(f.ctx,identity).identity.source_id,"1");
  } finally {f.sqlite.close();}
});

test("cada operação de acervo mantém configuração para bots e recusa origem externa", () => {
  const names=["erp_bling_records_list","erp_bling_record_get","erp_bling_versions_list","erp_bling_xml_list","erp_bling_xml_get","erp_bling_purge_preview","erp_bling_purge_apply"];
  for (const name of names) {
    const ctx=context(true), input={entity:"nfe",command_id:"apagar"};
    ctx.authorization={bot:{id:"bot",allowed_operations:[name],allowed_entities:["nfe","nfce"],data_scopes:allScopes,allow_sensitive:true}};
    assert.equal(BLING_OPERATIONS[name].bot.configurable,true);
    assert.doesNotThrow(()=>authorizeBlingOperation(ctx,name,input));
    assert.throws(()=>authorizeBlingOperation(context(true),name,input),{code:"BLING_SCOPE_REQUIRED"});
    assert.throws(()=>authorizeBlingOperation({...ctx,origin:"external"},name,input),{code:"BLING_ADMIN_REQUIRED"});
  }
});

test("consultar acervo desligado não chama a API de dados; não há efeito operacional", () => {
  const f=fixture(), clock=new FakeClock(), remote=new FakeBling({clock});
  try {
    const identity=f.seed("products","1",1,{id:"1",preco:"0"});
    const unavailable=()=>{throw new Error("Porta não utilizada nesta consulta");};
    const archive=createArchive({db:guardCollectionDriver(f.db),profile,xml:{archiveXml:unavailable,listXml:unavailable,readXml:unavailable},purge:{purge:unavailable,purgePreview:unavailable}});
    const baseline=operationalSnapshot(f.sqlite);
    const view=archive.getRecord(f.ctx,{entity:identity.entity,id:identity.source_id});
    assert.equal(view.historical.label,"Consulta histórica — não opera no ERP");
    assert.equal(view.existing_links.length,0); assert.equal(view.raw.payload_text,'{"id":"1","preco":"0"}');
    assert.equal(remote.callCount,0); assert.equal(remote.mutations,0); remote.assertReadOnly();
    assertOperationalUnchanged(f.sqlite,baseline);
  } finally {f.sqlite.close();}
});

function raw(entity,payload) {
  const payload_text=typeof payload==="string"?payload:JSON.stringify(payload);
  return {identity:{profile,account_id:"conta",entity,source_id:"1"},version:"1",semantic_hash:sha(payload_text),payload_text,document_links:[],observed_at:new Date(now).toISOString(),source_updated_at:null,source_time_quality:"unknown",deleted:false,deletion_evidence:null,capture:null};
}

test("DTOs conservam precisão, lacunas, valores líquidos e cobertura incompleta", () => {
  assert.equal(observedDecimal(undefined).state,"absent");
  assert.equal(observedDecimal(null).state,"null");
  assert.equal(observedDecimal("inválido").state,"invalid");
  assert.equal(observedDecimal("0").value,"0");
  assert.equal(unknownValue().state,"unknown");
  const record=raw("sales_orders",'{"id":9007199254740993123,"total":999.1234567890123,"itens":[{"valor":3.1234567890123456789,"quantidade":2,"desconto":10}],"campoNovo":"preservado"}');
  const dto=projectRecord(record);
  assert.equal(parseHistoricalPayload(record.payload_text).payload.id,"9007199254740993123");
  assert.equal(dto.fields.total_observed.value,"999.1234567890123");
  assert.equal(dto.fields.items[0].unit_price.value,"3.1234567890123456789");
  assert.equal(dto.fields.items[0].discount_reapplied,false);
  assert.deepEqual(dto.fields.reconciliation,{state:"unknown",calculated_total:null,difference:null,commercial_math_reconciled:false});
  assert.ok(dto.unmapped_fields.includes("campoNovo")); assert.equal(dto.coverage.complete,false);
  assert.throws(()=>parseHistoricalPayload('{"a":1,"a":2}'),{code:"BLING_RESPONSE_INVALID"});
  const stock=projectRecord(raw("stock_balances",{produto:{id:"1"},depositos:[{id:"2",saldoFisico:"0",saldoVirtual:null}]}));
  assert.equal(stock.fields.positions[0].physical.value,"0");
  assert.equal(stock.fields.positions[0].virtual.state,"null");
  assert.equal(stock.fields.positions[0].reserved.state,"unknown");
  assert.equal(projectRecord(raw("receivables",{valor:"10"})).fields.open_balance.state,"absent");
  const pass={key:"recent",started_at:"2026-11-18T00:00:00Z",completed_at:"2026-11-19T00:00:00Z"};
  assert.equal(coverageFromPasses(["recent","history"],[pass]).freshness_at,null);
  assert.equal(coverageFromPasses(["recent","history"],[pass,{key:"history",started_at:"2026-11-17T00:00:00Z",completed_at:pass.completed_at}]).freshness_at,"2026-11-17T00:00:00Z");
});

test("captura lexical exige hash dos bytes, identidade, paths completos e vínculo da versão", () => {
  const text='{"data":{"id":"1","preco":12.34567890123456789}}', bytes=new TextEncoder().encode(text);
  const record=raw("products",'{"id":"1","preco":12.34567890123456789}');
  record.capture={revision:"1",profile:"origin-price-json-v1",source:"detail",bytes_sha256:sha(bytes),semantic_hash:record.semantic_hash,semantic_version:"1",values:[{path:"/preco",lexeme:"12.34567890123456789"}]};
  assert.deepEqual(validateCapture(record,bytes),record.capture);
  for (const change of [{semantic_version:"2"},{values:[]},{values:[record.capture.values[0],record.capture.values[0]]},{bytes_sha256:"a".repeat(64)}]) {
    assert.throws(()=>validateCapture({...record,capture:{...record.capture,...change}},bytes),{code:"BLING_RESPONSE_INVALID"});
  }
  assert.throws(()=>validateCapture(record,new TextEncoder().encode(text.replace('"1"','"2"'))),{code:"BLING_RESPONSE_INVALID"});
});

test("pedido–nota só resolve referência explícita da mesma área/conta; modelo/ambiente não se mesclam", () => {
  const order=raw("sales_orders",{notaFiscal:{id:"1"}}), reference=explicitOrderReference(order);
  const nfe=raw("nfe",{ambiente:1}), nfce=raw("nfce",{ambiente:2});
  assert.equal(resolveOrderReference(reference,[nfe]).state,"resolved");
  assert.equal(resolveOrderReference(reference,[nfe,nfce]).state,"ambiguous");
  assert.equal(resolveOrderReference(reference,[{...nfe,identity:{...nfe.identity,profile:"outra"}}]).state,"unresolved");
  assert.equal(explicitOrderReference(raw("sales_orders",{notaFiscal:{id:"1x"}})),null);
  assert.equal(explicitOrderReference(raw("sales_orders",{})),null);
  assert.equal(fiscalIndex(nfe).environment,"production");
  assert.equal(fiscalIndex(nfce).environment,"test");
  assert.equal(fiscalIndex(raw("nfe",{ambiente:1,tpAmb:2})).environment,"unknown");
});

function xmlDocument(entity="nfe",environment="1") {
  const model=entity==="nfe"?"55":"65";
  const prefix=`35261112345678000195${model}001000000001112345678`;
  let sum=0,weight=2;
  for(let i=prefix.length-1;i>=0;i--) {sum+=Number(prefix[i])*weight;weight=weight===9?2:weight+1;}
  const digit=11-(sum%11),key=prefix+String(digit>=10?0:digit);
  const text=`<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${key}"><ide><tpAmb>${environment}</tpAmb><mod>${model}</mod><cUF>35</cUF><serie>1</serie><nNF>1</nNF><tpEmis>1</tpEmis><cNF>12345678</cNF><cDV>${key[43]}</cDV><dhEmi>2026-11-19T12:00:00-03:00</dhEmi></ide><emit><CNPJ>12345678000195</CNPJ></emit></infNFe></NFe>`;
  return {key,model,text,bytes:new TextEncoder().encode(text)};
}
function mediaStore() {
  const objects=new Map(),calls=[];
  return {objects,calls,failPut:false,failDelete:false,
    async put(key,bytes) {calls.push({kind:"put",key});objects.set(key,Uint8Array.from(bytes));if(this.failPut){this.failPut=false;throw new Error("Falha simulada");}},
    async get(key) {calls.push({kind:"get",key});const bytes=objects.get(key);return bytes?{arrayBuffer:async()=>Uint8Array.from(bytes).buffer}:null;},
    async delete(key) {calls.push({kind:"delete",key});if(this.failDelete){this.failDelete=false;throw new Error("Falha simulada");}objects.delete(key);},
  };
}
function xmlHarness(f,media=mediaStore()) {
  let sequence=0;
  const randomId=()=>`acervo-${++sequence}`;
  f.db.exec("UPDATE wb_bling_control SET collect_enabled=1,state='ready',approved_by='pessoa',approved_at=?,approval_hash=? WHERE id=1",now,sha("aprovado"));
  const revalidate=async(ctx)=>{if(!ctx.identity.parts.customers)throw Object.assign(new Error("Base desligada"),{code:"BLING_DISABLED"});};
  const xml=createXmlArchive({profile,db:guardCollectionDriver(f.db),media,hash:async bytes=>sha(bytes),randomId,revalidate});
  async function prepare(entity="nfe",environment="1",id="1",seed=true) {
    const doc=xmlDocument(entity,environment),payload=JSON.stringify({id,chaveAcesso:doc.key,situacao:"6",valorNota:"10"});
    if(seed)f.seed(entity,id,1,payload);
    const work=randomId(),attempt=randomId(),command=randomId();
    const expected={generation:"1",authorization_revision:"0",credential_revision:"0",configuration_revision:"0",account_id:"conta",parts_revision:"1"};
    const unit={work_id:work,attempt_id:attempt,command_id:command,request_hash:sha(command),kind:"xml_fetch",entity,source_id:id,resource_key:null,phase:"reserved",expected,checkpoint:{revision:"0",cursor:{},pass_started_at:null,pass_completed_at:null},lease:{owner:"worker",fence:randomId(),expires_at:now+600000},not_before:now,plan:{},page:null,progress:{}};
    f.db.exec("INSERT INTO wb_bling_unit(id,attempt_id,command_id,request_hash,generation,authorization_revision,credential_revision,configuration_revision,account_id,parts_revision,kind,entity,source_id,phase,owner,fence,lease_until,not_before,created_at,updated_at) VALUES(?,?,?,?,1,0,0,0,'conta','1','xml_fetch',?,?,'reserved',?,?,?,?,?,?)",work,attempt,command,unit.request_hash,entity,id,unit.lease.owner,unit.lease.fence,unit.lease.expires_at,now,now,now);
    return {unit,identity:{profile,account_id:"conta",entity,source_id:id},access_key:doc.key,model:doc.model,fingerprint:await xmlFingerprint(payload,async bytes=>sha(bytes)),bytes:doc.bytes,expected_sha256:sha(doc.bytes)};
  }
  return {xml,media,prepare,randomId};
}

test("XML inválido, DTD, hash/modelo divergente são recusados; URL não muda fingerprint",async()=>{
  const doc=xmlDocument(),hash=async bytes=>sha(bytes),input={bytes:doc.bytes,entity:"nfe",access_key:doc.key,model:"55",expected_sha256:sha(doc.bytes)};
  assert.equal((await validateXmlBytes(input,hash)).metadata.environment,"1");
  for(const bytes of [new TextEncoder().encode("<xml>incompleto"),new TextEncoder().encode(`<!DOCTYPE NFe [<!ENTITY dado "valor">]>${doc.text}`)])
    await assert.rejects(validateXmlBytes({...input,bytes,expected_sha256:sha(bytes)},hash),{code:"BLING_RESPONSE_INVALID"});
  await assert.rejects(validateXmlBytes({...input,expected_sha256:"a".repeat(64)},hash),{code:"BLING_RESPONSE_INVALID"});
  await assert.rejects(validateXmlBytes({...input,entity:"nfce",model:"65"},hash),{code:"BLING_RESPONSE_INVALID"});
  assert.equal(await xmlFingerprint('{"numero":1,"link":"anterior"}',hash),await xmlFingerprint('{"numero":1,"link":"novo"}',hash));
  assert.notEqual(await xmlFingerprint('{"valorNota":12345678901234567890.1}',hash),await xmlFingerprint('{"valorNota":12345678901234567890.2}',hash));
  const candidate=(entity,direction,id)=>({entity,direction,source_id:id,fingerprint:"novo",last_fingerprint:null,last_checked_at:null,next_attempt_at:null,verified_manifest:false});
  const candidates=[...Array.from({length:8},(_,i)=>candidate("nfe","input",String(i))),candidate("nfce","output","9"),candidate("nfe","unknown","10"),{...candidate("nfce","input","11"),next_attempt_at:now+1000}];
  assert.deepEqual(selectXmlCandidates(candidates,{now,limit:3}).items.map(v=>v.source_id),["0","9","10"]);
});

test("XML recupera PUT sem metadados, confirma bytes, replay não duplica manifesto nem checkpoint",async()=>{
  const f=fixture(),h=xmlHarness(f);
  try {
    const input=await h.prepare(),baseline=operationalSnapshot(f.sqlite),checkpoints=f.db.exec("SELECT * FROM origin_sync__resource_state").rows;
    h.media.failPut=true;
    await assert.rejects(h.xml.archiveXml(f.ctx,input),{code:"BLING_RETRY_WAIT"});
    assert.equal(h.media.objects.size,1);assert.equal(f.db.exec("SELECT * FROM origin_fiscal__object").rows.length,0);
    const summary=await h.xml.resumeXml(f.ctx,input.unit);
    assert.equal(summary.available,true);assert.equal(summary.environment,"production");
    const calls=h.media.calls.length;
    assert.deepEqual(await h.xml.archiveXml(f.ctx,input),summary);
    assert.deepEqual(await h.xml.resumeXml(f.ctx,input.unit),summary);
    assert.equal(h.media.calls.length,calls);
    assert.equal(f.db.exec("SELECT * FROM origin_fiscal__revision").rows.length,1);
    assert.equal(f.db.exec("SELECT * FROM origin_fiscal__object").rows.length,1);
    assert.deepEqual(f.db.exec("SELECT * FROM origin_sync__resource_state").rows,checkpoints);
    const another=await h.prepare("nfe","1","1",false);
    await assert.rejects(h.xml.archiveXml(f.ctx,another),{code:"BLING_RETRY_WAIT"});
    const repeatedManifest=await h.xml.resumeXml(f.ctx,another.unit);
    assert.equal(repeatedManifest.version,summary.version);assert.equal(repeatedManifest.object_id,summary.object_id);
    assert.equal(f.db.exec("SELECT * FROM origin_fiscal__revision").rows.length,1);
    assert.deepEqual((await h.xml.readXml(f.ctx,summary.object_id)).bytes,input.bytes);
    h.media.objects.set(blingXmlObjectKey(profile,summary.sha256),new TextEncoder().encode("alterado"));
    await assert.rejects(h.xml.readXml(f.ctx,summary.object_id),{code:"BLING_RESPONSE_INVALID"});
    assertOperationalUnchanged(f.sqlite,baseline);
  } finally {f.sqlite.close();}
});

test("XML mantém NF-e/NFC-e de mesmo ID e produção/homologação disponíveis",async()=>{
  const f=fixture(),h=xmlHarness(f);
  try {
    for(const [entity,environment,seed] of [["nfe","1",true],["nfe","2",false],["nfce","1",true]]) {
      const input=await h.prepare(entity,environment,"1",seed);
      await assert.rejects(h.xml.archiveXml(f.ctx,input),{code:"BLING_RETRY_WAIT"});
      await h.xml.resumeXml(f.ctx,input.unit);
    }
    const items=h.xml.listXml(f.ctx,{}).items;
    assert.equal(items.length,3);
    assert.deepEqual(items.map(v=>`${v.entity}:${v.environment}`).sort(),["nfce:production","nfe:production","nfe:test"]);
    const bot=context(true);
    bot.authorization={bot:{id:"bot",allowed_operations:["erp_bling_xml_list","erp_bling_xml_get"],allowed_entities:["nfe","nfce"],data_scopes:allScopes,allow_sensitive:false}};
    assert.equal(h.xml.listXml(bot,{}).items.length,3);
    assert.ok((await h.xml.readXml(bot,items[0].object_id)).bytes.length>0);
    assert.throws(()=>h.xml.listXml(context(true),{}),{code:"BLING_SCOPE_REQUIRED"});
    await assert.rejects(h.xml.readXml({...bot,origin:"external"},items[0].object_id),{code:"BLING_ADMIN_REQUIRED"});
    assert.throws(()=>h.xml.listXml({...bot,origin:"external"},{}),{code:"BLING_ADMIN_REQUIRED"});
  } finally {f.sqlite.close();}
});

const triggerSnapshot=db=>db.exec("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").rows;
function purgeHarness(f,media=mediaStore()) {
  let i=0;
  const checked={transaction:fn=>f.db.transaction(fn),exec(sql,...params){
    const ddl=/^(?:CREATE|DROP) TRIGGER "?([a-zA-Z0-9_]+)/.exec(sql);
    if(ddl)assert.ok(Object.hasOwn(ARCHIVE_PURGE_DELETE_TRIGGERS,ddl[1]));else assertCollectionWrite(sql);
    return f.db.exec(sql,...params);
  }};
  const purge=createArchivePurge({db:checked,profile,media,randomId:()=>`purge-${++i}`,requireBase:async()=>{}});
  const internal={...f.ctx,origin:"internal"};
  return {purge,media,internal,async finish(workId){for(let n=0;n<150;n++){const out=await purge.runPurgeStep(internal,workId);if(out.done)return out.receipt;}assert.fail("Purge não terminou");}};
}
test("purge parcial é confirmado, retomável e conserva gatilhos idênticos",async()=>{
  const f=fixture(),h=purgeHarness(f);
  try {
    f.seed("products","1",1,{id:"1"},false);f.seed("products","1",2,{id:"1",nome:"novo"});
    f.seed("contacts","2",1,{id:"2"});
    const scope={all:false,entities:["products"]},triggers=triggerSnapshot(f.db),baseline=operationalSnapshot(f.sqlite);
    const preview=h.purge.purgePreview(f.ctx,{scope,generation:"1"});
    assert.equal(preview.blocked_references,0);assert.equal(preview.counts.origin_sync__raw_record,1);
    const input={scope,generation:"1",expected_revision:"0",command_id:"apagar-produtos",preview_hash:preview.preview_hash,confirmed:true};
    const nonAdmin={...f.ctx,identity:{...f.ctx.identity,actor:{...f.ctx.identity.actor,erp_role:"consulta"}}};
    await assert.rejects(h.purge.purge(nonAdmin,input),{code:"BLING_ADMIN_REQUIRED"});
    await assert.rejects(h.purge.purge(f.ctx,{...input,preview_hash:"a".repeat(64)}),{code:"BLING_REVISION_CONFLICT"});
    const work=await h.purge.purge(f.ctx,input);
    assert.equal(f.db.exec("SELECT generation FROM wb_bling_control").rows[0].generation,2);
    await h.purge.runPurgeStep(h.internal,work.work_id);
    assert.deepEqual(await h.purge.purge(f.ctx,input),work);
    const result=await h.finish(work.work_id);
    assert.equal(result.references.retired_generation,"1");
    assert.equal(f.db.exec("SELECT * FROM origin_sync__raw_record WHERE entity='products'").rows.length,0);
    assert.equal(f.queries.listRecords(f.ctx,{entity:"contacts"}).items.length,1);
    assert.equal(f.db.exec("SELECT state FROM wb_bling_control").rows[0].state,"off");
    assert.deepEqual(triggerSnapshot(f.db),triggers);
    assert.equal((await h.purge.purge(f.ctx,input)).receipt.command_id,input.command_id);
    assertOperationalUnchanged(f.sqlite,baseline);
  } finally {f.sqlite.close();}
});

test("exceção e FK impeditiva fazem rollback sem mudar um único gatilho",()=>{
  const f=fixture();
  try {
    f.seed("products","1",1,{id:"1"},false);
    const triggers=triggerSnapshot(f.db);
    assert.throws(()=>archiveDeleteTransaction(f.db,()=>{f.db.exec("DELETE FROM erp_document_mirror__source_version");throw new Error("queda simulada");}),/queda simulada/);
    assert.equal(f.db.exec("SELECT * FROM erp_document_mirror__source_version").rows.length,1);
    assert.deepEqual(triggerSnapshot(f.db),triggers);
    f.db.exec("INSERT INTO erp_document_mirror__source_dependency(entity,source_id,source_version,ref_entity,ref_source_id) VALUES('products','1',1,'contacts','2')");
    assert.throws(()=>archiveDeleteTransaction(f.db,()=>f.db.exec("DELETE FROM erp_document_mirror__source_version")));
    assert.deepEqual(triggerSnapshot(f.db),triggers);
    const h=purgeHarness(f),preview=h.purge.purgePreview(f.ctx,{scope:{all:false,entities:["products"]},generation:"1"});
    assert.ok(preview.blocked_references>0);
    // A dependência também protege o alvo, embora o legado não tenha FK nele.
    assert.ok(h.purge.purgePreview(f.ctx,{scope:{all:false,entities:["contacts"]},generation:"1"}).blocked_references>0);
  } finally {f.sqlite.close();}
});

test("leitura legada conserva prova lexical vinculada e exclusão explícita sem índice novo",()=>{
  const f=fixture();
  try {
    const payload='{"id":"1","preco":1.2300,"_brufap_source":{"deleted":true,"detail_available":false}}',hash=sha(payload);
    const capture={profile:"origin-price-json-v1",source:"list_fallback",response_sha256:sha("resposta"),source_hash:hash,source_version:"1",tokens:[{path:"/preco",lexeme:"1.2300"}]};
    f.db.exec("INSERT INTO origin_sync__resource_state(resource,updated_at) VALUES('products',?)",now);
    f.db.exec("INSERT INTO origin_sync__raw_record(entity,source_id,last_resource,payload,version_hash,version,first_seen_at,last_seen_at,changed_at,price_capture) VALUES('products','1','products',?,?,1,?,?,?,?)",payload,hash,now,now,now,JSON.stringify(capture));
    const record=f.queries.readVersion(f.ctx,{profile,account_id:"conta",entity:"products",source_id:"1"});
    assert.equal(record.deleted,true);assert.ok(record.deletion_evidence);
    assert.equal(record.capture.source,"deleted_without_detail");assert.equal(record.capture.values[0].lexeme,"1.2300");
    assert.equal(f.queries.listRecords(f.ctx,{entity:"products",deleted:true}).items.length,1);
    const sql=[];
    const query=createArchiveQueries({profile,db:{transaction:fn=>f.db.transaction(fn),exec(statement,...params){sql.push(statement);return f.db.exec(statement,...params);}}});
    query.listRecords(f.ctx,{entity:"products"});query.listVersions(f.ctx,{entity:"products",id:"1"});
    assert.ok(sql.every(statement=>!statement.includes("r.payload,r.document_links")&&!statement.includes("m.capture,")));
  }finally{f.sqlite.close();}
});

test("manifesto com nota e evento grava/verifica um objeto por passo e confirma tudo junto",async()=>{
  const f=fixture(),h=xmlHarness(f);
  try{
    const one=await h.prepare();
    const event=`<evento xmlns="http://www.portalfiscal.inf.br/nfe"><infEvento Id="ID110111${one.access_key}01"><chNFe>${one.access_key}</chNFe><tpAmb>1</tpAmb><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento></infEvento></evento>`;
    const eventBytes=new TextEncoder().encode(event),request={...one,documents:[{bytes:one.bytes,expected_sha256:one.expected_sha256},{bytes:eventBytes,expected_sha256:sha(eventBytes)},{bytes:one.bytes,expected_sha256:one.expected_sha256}]};
    for(let i=0;i<2;i++){
      const before=h.media.calls.length;
      await assert.rejects(h.xml.archiveXmlManifest(f.ctx,request),{code:"BLING_RETRY_WAIT"});
      assert.equal(h.media.calls.length-before,1);
      assert.equal(f.db.exec("SELECT * FROM origin_fiscal__revision").rows.length,0);
    }
    await assert.rejects(h.xml.resumeXmlManifest(f.ctx,one.unit),{code:"BLING_RETRY_WAIT"});
    assert.equal(f.db.exec("SELECT * FROM origin_fiscal__revision").rows.length,0);
    const summaries=await h.xml.resumeXmlManifest(f.ctx,one.unit);
    assert.equal(summaries.length,2);assert.equal(f.db.exec("SELECT * FROM origin_fiscal__revision").rows.length,1);
    assert.equal(f.db.exec("SELECT * FROM origin_fiscal__object").rows.length,2);
    const calls=h.media.calls.length;
    assert.deepEqual(await h.xml.archiveXmlManifest(f.ctx,request),summaries);
    assert.equal(h.media.calls.length,calls);
    const journal=String(f.db.exec("SELECT progress FROM wb_bling_unit WHERE id=?",one.unit.work_id).rows[0].progress);
    assert.ok(!journal.includes("<NFe")&&!journal.includes("<evento")&&!journal.includes(Buffer.from(one.bytes).toString("base64")));
    await assert.rejects(h.xml.archiveXmlManifest(f.ctx,{...request,documents:request.documents.slice(0,1)}),{code:"BLING_COMMAND_CONFLICT"});
  }finally{f.sqlite.close();}
});

test("XML sem objeto volta à busca; posse tomada e desligamento recusam commits atrasados",async()=>{
  const f=fixture(),h=xmlHarness(f);
  try{
    const input=await h.prepare();
    await assert.rejects(h.xml.archiveXml(f.ctx,input),{code:"BLING_RETRY_WAIT"});
    h.media.objects.clear();
    await assert.rejects(h.xml.resumeXml(f.ctx,input.unit),{code:"BLING_RETRY_WAIT"});
    assert.equal(JSON.parse(f.db.exec("SELECT progress FROM wb_bling_unit WHERE id=?",input.unit.work_id).rows[0].progress).xml.phase,"needs_fetch");
    const taken={...input.unit,lease:{...input.unit.lease,owner:"worker-2",fence:"fence-novo"}};
    f.db.exec("UPDATE wb_bling_unit SET owner=?,fence=? WHERE id=?",taken.lease.owner,taken.lease.fence,taken.work_id);
    await assert.rejects(h.xml.resumeXml(f.ctx,input.unit),{code:"BLING_LEASE_LOST"});
    await assert.rejects(h.xml.archiveXml(f.ctx,{...input,unit:taken}),{code:"BLING_RETRY_WAIT"});
    assert.equal((await h.xml.resumeXml(f.ctx,taken)).available,true);
    const late=await h.prepare("nfce");
    const originalPut=h.media.put.bind(h.media);
    h.media.put=async(key,bytes)=>{await originalPut(key,bytes);f.db.exec("UPDATE wb_bling_control SET collect_enabled=0,state='off',authorization_revision=1 WHERE id=1");};
    await assert.rejects(h.xml.archiveXml(f.ctx,late),{code:"BLING_DISABLED"});
    assert.equal(f.db.exec("SELECT * FROM origin_fiscal__object").rows.length,1);
    const calls=h.media.calls.length;
    await assert.rejects(h.xml.resumeXml(f.ctx,late.unit),{code:"BLING_DISABLED"});
    assert.equal(h.media.calls.length,calls);
  }finally{f.sqlite.close();}
});

test("purge recupera exclusão R2 e órfão de PUT, conserva outra área e aposenta comandos XML",async()=>{
  const f=fixture(),clock=new FakeClock(now);f.ctx.clock=clock;
  const media=mediaStore(),xml=xmlHarness(f,media),purge=purgeHarness(f,media);
  try{
    const saved=await xml.prepare();
    await assert.rejects(xml.xml.archiveXml(f.ctx,saved),{code:"BLING_RETRY_WAIT"});
    await xml.xml.resumeXml(f.ctx,saved.unit);
    const orphan=await xml.prepare("nfce");media.failPut=true;
    await assert.rejects(xml.xml.archiveXml(f.ctx,orphan),{code:"BLING_RETRY_WAIT"});
    const outside=blingXmlObjectKey("outra-area",sha("fora"));media.objects.set(outside,new TextEncoder().encode("fora"));
    const baseline=operationalSnapshot(f.sqlite),triggers=triggerSnapshot(f.db),scope={all:true,entities:[]};
    const preview=purge.purge.purgePreview(f.ctx,{scope,generation:"1"});assert.equal(preview.files,2);
    const work=await purge.purge.purge(f.ctx,{scope,generation:"1",expected_revision:"0",command_id:"apagar-tudo",preview_hash:preview.preview_hash,confirmed:true});
    let sawFailure=false,done=false;media.failDelete=true;
    for(let i=0;i<150;i++){
      const calls=media.calls.length;
      try{const out=await purge.purge.runPurgeStep(purge.internal,work.work_id);if(out.done){done=true;break;}}
      catch(error){assert.equal(error.code,"BLING_RETRY_WAIT");sawFailure=true;clock.advance(30000);}
      assert.ok(media.calls.length-calls<=1,"uma operação R2 por unidade");
    }
    assert.ok(done&&sawFailure);assert.deepEqual([...media.objects.keys()],[outside]);
    assert.equal(f.db.exec("SELECT * FROM origin_fiscal__object").rows.length,0);
    assert.equal(f.db.exec("SELECT * FROM wb_bling_receipt WHERE operation='xml_archive'").rows.length,0);
    assert.equal(f.db.exec("PRAGMA foreign_key_check").rows.length,0);assert.deepEqual(triggerSnapshot(f.db),triggers);
    await assert.rejects(xml.xml.resumeXml(f.ctx,saved.unit),{code:"BLING_GENERATION_RETIRED"});
    assertOperationalUnchanged(f.sqlite,baseline);
  }finally{f.sqlite.close();}
});

test("purge recusa vínculo adotado, bot sem concessão/escopo e proposta externa",async()=>{
  const f=fixture(),h=purgeHarness(f);
  try{
    f.seed("products","1",1,{id:"1"});
    const scope={all:false,entities:["products"]},bot=context(true);
    bot.authorization={bot:{id:"bot",allowed_operations:["erp_bling_purge_preview","erp_bling_purge_apply"],allowed_entities:["products"],data_scopes:["public"],allow_sensitive:true}};
    const preview=h.purge.purgePreview(bot,{scope,generation:"1"});
    const input={scope,generation:"1",expected_revision:"0",command_id:"bot-apagar",preview_hash:preview.preview_hash,confirmed:true};
    assert.throws(()=>h.purge.purgePreview(context(true),{scope,generation:"1"}),{code:"BLING_SCOPE_REQUIRED"});
    await assert.rejects(h.purge.purge(context(true),input),{code:"BLING_SCOPE_REQUIRED"});
    assert.throws(()=>h.purge.purgePreview({...bot,origin:"external"},{scope,generation:"1"}),{code:"BLING_ADMIN_REQUIRED"});
    await assert.rejects(h.purge.purge({...bot,origin:"external"},input),{code:"BLING_ADMIN_REQUIRED"});
    assert.throws(()=>h.purge.purgePreview(bot,{scope:{all:false,entities:["contacts"]},generation:"1"}),{code:"BLING_SCOPE_REQUIRED"});
    f.db.exec("INSERT INTO erp_sync__link(entity,record_id,origin_id,created_at,updated_at) VALUES('products','adotado','1',?,?)",now,now);
    const blocked=h.purge.purgePreview(bot,{scope,generation:"1"});assert.ok(blocked.blocked_references>0);
    await assert.rejects(h.purge.purge(bot,{...input,preview_hash:blocked.preview_hash}),{code:"BLING_ARCHIVE_REFERENCED"});
    // A autorização do bot também é exercitada até a criação do trabalho durável.
    f.db.exec("DELETE FROM erp_sync__link WHERE record_id='adotado'");
    const fresh=h.purge.purgePreview(bot,{scope,generation:"1"});
    assert.ok((await h.purge.purge(bot,{...input,preview_hash:fresh.preview_hash})).work_id);
  }finally{f.sqlite.close();}
});

test("reserva XML antecede GET simulado; resposta perdida retoma sem duplicar tentativa",async()=>{
  const f=fixture(),h=xmlHarness(f),remote=new FakeBling();
  try{
    const input=await h.prepare();
    const first=await h.xml.beginXml(f.ctx,input);
    assert.equal(first.stored,false);
    assert.equal(f.db.exec("SELECT phase FROM wb_bling_unit WHERE id=?",input.unit.work_id).rows[0].phase,"fetching");
    assert.equal(f.db.exec("SELECT * FROM origin_fiscal__attempt").rows.length,1);
    const get=async()=>{
      remote.queue({body:input.bytes,headers:{"content-type":"application/xml"}});
      return new Uint8Array(await(await remote.fetch(`${remote.baseUrl}/nfe/documento/${input.access_key}?formato=xml`,{method:"GET"})).arrayBuffer());
    };
    await get(); // Queda depois da resposta, antes da gravação.
    assert.deepEqual(await h.xml.beginXml(f.ctx,input),first);
    const bytes=await get();
    await assert.rejects(h.xml.archiveXml(f.ctx,{...input,bytes}),{code:"BLING_RETRY_WAIT"});
    await h.xml.resumeXml(f.ctx,input.unit);
    h.xml.failXml(f.ctx,input.unit,{blocked:true,retry_at:now,code:"XML_INVALID"});
    assert.equal(f.db.exec("SELECT state FROM origin_fiscal__attempt").rows[0].state,"stored");
    assert.equal(f.db.exec("SELECT * FROM origin_fiscal__attempt").rows.length,1);
    assert.equal(remote.callCount,2);remote.assertReadOnly();assert.equal(remote.mutations,0);
    const before=remote.callCount;
    f.db.exec("UPDATE wb_bling_control SET collect_enabled=0,state='off' WHERE id=1");
    const pending=await h.prepare("nfce");
    await assert.rejects(h.xml.beginXml(f.ctx,pending),{code:"BLING_DISABLED"});
    assert.equal(remote.callCount,before);
  }finally{f.sqlite.close();}
});

test("purge aguarda PUT em voo mesmo após vencer a posse, sem ressurgimento R2",async()=>{
  const f=fixture(),clock=new FakeClock(now);f.ctx.clock=clock;
  const media=mediaStore(),h=xmlHarness(f,media),purge=purgeHarness(f,media);
  let release;
  try{
    const input=await h.prepare();
    const started=new Promise(resolve=>{
      media.put=async(key,bytes)=>{
        media.calls.push({kind:"put",key});resolve();
        await new Promise(done=>{release=done;});
        media.objects.set(key,Uint8Array.from(bytes));
      };
    });
    const writing=assert.rejects(h.xml.archiveXml(f.ctx,input),{code:"BLING_GENERATION_RETIRED"});
    await started;
    const scope={all:true,entities:[]},preview=purge.purge.purgePreview(f.ctx,{scope,generation:"1"});
    const work=await purge.purge.purge(f.ctx,{scope,generation:"1",expected_revision:"0",command_id:"apagar-em-voo",preview_hash:preview.preview_hash,confirmed:true});
    await assert.rejects(purge.purge.runPurgeStep(purge.internal,work.work_id),{code:"BLING_RETRY_WAIT"});
    clock.advance(700000);
    await assert.rejects(purge.purge.runPurgeStep(purge.internal,work.work_id),{code:"BLING_RETRY_WAIT"});
    release();await writing;
    const result=await purge.finish(work.work_id);
    assert.equal(result.state,"committed");assert.equal(media.objects.size,0);
  }finally{release?.();f.sqlite.close();}
});

test("ficha resolve pedido–nota sem vínculo nativo e projeção aceita fonte ainda não persistida",()=>{
  const f=fixture();
  try{
    const order=f.seed("sales_orders","1",1,{notaFiscal:{id:"1"}});f.seed("nfe","1",1,{id:"1"});
    const unused=()=>{throw new Error("Porta não usada");};
    const archive=createArchive({db:guardCollectionDriver(f.db),profile,xml:{archiveXml:unused,listXml:unused,readXml:unused},purge:{purge:unused,purgePreview:unused}});
    assert.equal(archive.getRecord(f.ctx,{entity:order.entity,id:order.source_id}).historical.unresolved_references[0].state,"resolved");
    f.seed("nfce","1",1,{id:"1"});
    assert.equal(archive.getRecord(f.ctx,{entity:order.entity,id:order.source_id}).historical.unresolved_references[0].state,"ambiguous");
    const unpublished=raw("sales_orders",{total:"5"});unpublished.version="2";
    assert.equal(archive.project({...f.ctx,origin:"internal"},unpublished).metadata.version,"2");
    assert.throws(()=>archive.project({...f.ctx,origin:"external"},unpublished),{code:"BLING_ADMIN_REQUIRED"});
    assert.equal(f.db.exec("SELECT * FROM erp_sync__link").rows.length,0);
    const large=raw("sales_orders",JSON.stringify({id:"1",itens:Array.from({length:1800},()=>({valor:1}))}));
    const bytes=new TextEncoder().encode(large.payload_text);
    large.capture={revision:"1",profile:"origin-sales-price-json-v1",source:"detail",bytes_sha256:sha(bytes),semantic_hash:large.semantic_hash,semantic_version:large.version,values:Array.from({length:1800},(_,i)=>({path:`/itens/${i}/valor`,lexeme:"1"}))};
    assert.ok(validateCapture(large,bytes));
    assert.throws(()=>archive.validateCapture({...f.ctx,origin:"internal"},{record:large,bytes}),{code:"BLING_CAPACITY_STOP"});
  }finally{f.sqlite.close();}
});

test("orçamento R2 libera a acordada em quatro segundos simulados e conserva barreira de PUT",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const f=fixture(),clock=new FakeClock(now);f.ctx.clock=clock;
  const h=xmlHarness(f);let release;
  try{
    const input=await h.prepare();
    const started=new Promise(resolve=>{
      h.media.put=async(key,bytes)=>{resolve();await new Promise(done=>{release=done;});h.media.objects.set(key,Uint8Array.from(bytes));};
    });
    const writing=assert.rejects(h.xml.archiveXml(f.ctx,input),{code:"BLING_RETRY_WAIT"});
    await started;clock.advance(4000);t.mock.timers.tick(4000);await writing;
    assert.equal(hasPendingXmlWrite(profile,input.unit.work_id),true);
    assert.equal(f.db.exec("SELECT * FROM origin_fiscal__revision").rows.length,0);
    await assert.rejects(h.xml.resumeXml(f.ctx,input.unit),{code:"BLING_RETRY_WAIT"});
    release();await new Promise(setImmediate);
    assert.equal(hasPendingXmlWrite(profile,input.unit.work_id),false);
    assert.equal((await h.xml.resumeXml(f.ctx,input.unit)).available,true);
  }finally{release?.();f.sqlite.close();}
});

test("DELETE R2 vencido não permite finalizar purge enquanto a exclusão antiga segue viva",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const f=fixture(),clock=new FakeClock(now);f.ctx.clock=clock;
  const media=mediaStore(),xml=xmlHarness(f,media),purge=purgeHarness(f,media);let release;
  try{
    const input=await xml.prepare();await assert.rejects(xml.xml.archiveXml(f.ctx,input),{code:"BLING_RETRY_WAIT"});await xml.xml.resumeXml(f.ctx,input.unit);
    const originalDelete=media.delete.bind(media);let first=true;
    media.delete=async key=>{
      if(first){first=false;clock.advance(4000);t.mock.timers.tick(4000);await new Promise(done=>{release=done;});}
      return originalDelete(key);
    };
    const scope={all:true,entities:[]},preview=purge.purge.purgePreview(f.ctx,{scope,generation:"1"});
    const work=await purge.purge.purge(f.ctx,{scope,generation:"1",expected_revision:"0",command_id:"apagar-timeout",preview_hash:preview.preview_hash,confirmed:true});
    let timedOut=false;
    for(let i=0;i<100&&!timedOut;i++)try{await purge.purge.runPurgeStep(purge.internal,work.work_id);}catch(error){assert.equal(error.code,"BLING_RETRY_WAIT");timedOut=true;}
    assert.equal(timedOut,true);clock.advance(30000);
    await assert.rejects(purge.purge.runPurgeStep(purge.internal,work.work_id),{code:"BLING_RETRY_WAIT"});
    assert.equal(f.db.exec("SELECT state FROM wb_bling_control").rows[0].state,"purging");
    release();await new Promise(setImmediate);
    assert.equal((await purge.finish(work.work_id)).state,"committed");assert.equal(media.objects.size,0);
  }finally{release?.();f.sqlite.close();}
});
