import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID as uid } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { build } from "esbuild";
import { Hono } from "hono";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import "../../../src/erp/domains/index.ts";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import { handleRpc } from "../../../src/erp/engine/rpc-endpoint.ts";

// Só o suporte de runtime é substituído. Produtor, SQL D1, consumidor,
// adaptador, identidade, endpoint HTTP e motor SQLite são os de produção.
const root = new URL("../../../", import.meta.url).pathname;
const built = await build({ stdin: { resolveDir: root, contents: `
  export {default as worker, Coordinator} from './src/index.ts';
  export * from './src/integrations/outbox.ts';
  export * from './src/integrations/consumer.ts';
  export * from './src/integrations/erp-adapter.ts';
  export * from './src/integrations/policy.ts';
  export * from './src/integrations/routes.ts';
  export * from './src/integrations/activation.ts';
  export * from './src/integrations/keys.ts';
  export * from './src/integrations/state.ts';
  export {modulesApi} from './src/modules/api.ts';
  export {createOrder,saveQuote,loadOrder,changeStatus,sendQuote,decide} from './src/modules/os/store.ts';
  export {patchWorkCommercial,workCommercialView} from './src/modules/os/commercial/routes.ts';
  export {readWorkIntegration} from './src/modules/os/commercial/projection.ts';
  export {runModuleSchedules} from './src/modules/schedule.ts';
  export {defaults} from './src/types.ts';
` }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", plugins: [{ name: "offline-runtime", setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "runtime", namespace: "offline" }));
  b.onLoad({ filter: /.*/, namespace: "offline" }, () => ({ contents: "export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }" }));
} }] });
const api = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const quiet = { notify: false };
async function fixture(t) {
  const local = new DatabaseSync(":memory:"), lite = freshLite(), driver = nodeDriver(lite);
  t.after(() => { local.close(); lite.close(); });
  for (const name of readdirSync(root + "migrations").filter(n => n.endsWith(".sql")).sort()) local.exec(readFileSync(root + "migrations/" + name, "utf8"));
  const prepare = (sql, args = []) => ({ sql, args, bind: (...params) => prepare(sql, params),
    async all() { return execute(this); }, async run() { return execute(this); },
    async first(key) { const row = execute(this).results[0] ?? null; return key ? row?.[key] ?? null : row; },
  });
  const execute = ({sql,args}) => ({ results: local.prepare(sql).all(...args), success: true, meta: { changes: local.prepare("SELECT changes() n").get().n } });
  const profile = uid(), actor = { id: uid(), kind: "user", name: "Pessoa", role: "admin", profiles: [profile], access: [], scopes: [], bots: [], rate: 0, runLimit: 0, aal: 2, mfa: { factor: true, policy: "financial" }, sessionId: uid() };
  const human = { user_id: actor.id, erp_role: "admin", name: "Pessoa", email: null, is_agent: false, verified_factor: true, session_id: actor.sessionId, aal: "aal2" };
  const rpc = (name, args) => callRpc(driver, name, { p_user_id: actor.id, ...args }, undefined, { identity: { actor: human, people: [human] } });
  const values = new Map(), storage = { async get(k) { return values.get(k); }, async put(k,v) { if (typeof k === "object") for (const [key,value] of Object.entries(k)) values.set(key,value); else values.set(k,v); }, async transaction(fn) { return fn(storage); }, transactionSync: fn => driver.transaction(fn), sql: { exec(sql,...params) { const r = driver.exec(sql,...params); return { ...r, toArray: () => r.rows }; } } };
  const calls = [];
  let intercept = null;
  const env = { DB: { prepare, async batch(statements) { local.exec("BEGIN"); try { const result = statements.map(execute); local.exec("COMMIT"); return result; } catch(e) { local.exec("ROLLBACK"); throw e; } } },
    COORDINATOR: { idFromName: n => n, get(name) { return { async fetch(url, init) {
      const req = new Request(url, init), path = new URL(url).pathname;
      if (!path.startsWith("/erp-rpc/")) return Response.json({ ok: true });
      const rpcName = path.slice("/erp-rpc/".length); calls.push(rpcName);
      const run = () => handleRpc({ storage }, profile, rpcName, req, undefined, env.DB);
      return intercept ? intercept(rpcName, req, run) : run();
    } }; } }, MEDIA: { async get() { return null; }, async put() {}, async delete() {} }, MASTER_KEY: "offline-f3-test-key-000000000000000000000000" };
  local.prepare("INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,'Área',?,1,?)").run(profile, JSON.stringify(api.defaults), Date.now());
  local.prepare("INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,'Pessoa','test','admin',?,?)").run(actor.id, `${actor.id}@example.test`, JSON.stringify([profile]), Date.now());
  for (const id of ["os","erp","erp-produtos","erp-estoque","erp-financeiro","erp-vendas"]) local.prepare("INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,?,1,?)").run(profile,id,Date.now()-1000);
  await api.readIntegrationActivation(env,profile,"os");
  const catalog = (entity,data) => rpc("erp_catalog_save",{ p_entity: entity,p_id:null,p_expected_version:0,p_command_id:uid(),p_data:data }).record;
  const customer = catalog("contacts",{name:"Cliente",person_type:"J",roles:["customer"]});
  const category = rpc("erp_finance_category_execute",{p_command_id:uid(),p_action:"category_create",p_data:{kind:"receivable",name:"Serviços"}}).record;
  const localId = uid();
  local.prepare("INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,erp_contact_id,erp_version,created_by,updated_by,created,updated) VALUES(?,?,'team','Cliente','cliente','manual',?,1,?,?,?,?)").run(localId,profile,customer.id,actor.id,actor.id,Date.now(),Date.now());
  const policy = await api.ensureCommercialPolicy(env,profile); policy.revenue_category_id=category.id;
  const {profile:_,version:__,...config}=policy;
  local.prepare("UPDATE module_erp_policy SET config_json=? WHERE profile_id=?").run(api.canonical(config),profile);
  const ctx = {...api.modulesApi(env,profile,"os"),publish:async()=>1,sendMessage:async()=>"sent",sendInteractive:async()=>"sent",note:async()=>undefined};
  const opened=(await api.createOrder(ctx,{item:"Notebook",problem:"Não liga",customer_name:"Cliente",phone:"5511999999988",source:"panel",sourceKey:uid(),actor:actor.id,notify:false})).order;
  await api.patchWorkCommercial(ctx,actor,opened.id,{version:opened.row_version,customer_ref:localId},uid());
  const row = await api.loadOrder(ctx,opened.id);
  const source={profile,module:"os",source_id:row.id,component:"main"};
  const events = () => local.prepare("SELECT * FROM module_erp_events WHERE source_id=? ORDER BY source_revision,seq").all(row.id).map(e=>JSON.parse(e.payload_json));
  const delivery = event => local.prepare("SELECT * FROM module_erp_delivery WHERE event_id=?").get(event.id);
  const due = () => local.prepare("UPDATE module_erp_delivery SET next_attempt_ms=0").run();
  const drain = async (options) => { due(); await api.drainIntegrationOutbox(env,profile,options); };
  return {env,local,lite,driver,profile,actor,ctx,row,source,events,delivery,due,drain,calls,rpc, intercept(fn){intercept=fn;},
    async quote() { return api.saveQuote(ctx, await api.loadOrder(ctx,row.id),{items:[{description:"Reparo",quantity:1,unit_cents:1000,kind:"free"}]},actor.id,uid()); },
    async pump() { for(let i=0;i<20;i++) { await drain(); const pending=local.prepare("SELECT * FROM module_erp_delivery WHERE state<>'done'").all(); if(!pending.length)return; assert(!pending.some(d=>["failed","blocked","waiting_manual","uncertain"].includes(d.state)),JSON.stringify(pending)); } assert.fail("fila não concluiu"); },
  };
}

test("fatos locais não consomem sequência: trabalho sem orçamento, preço autorizado e execução no motor real", async t => {
  const f=await fixture(t);
  assert(f.events().every(e=>e.seq===null));
  assert.equal(f.local.prepare("SELECT enqueued_seq,applied_seq FROM module_erp_sources WHERE source_id=?").get(f.row.id).enqueued_seq,0);
  await f.drain(); assert.equal(f.calls.length,0);
  let row=await f.quote();
  await api.patchWorkCommercial(f.ctx,f.actor,row.id,{version:row.row_version,authorize_fixed_price:true},uid());
  row=await api.changeStatus(f.ctx,await api.loadOrder(f.ctx,row.id),"in_progress",f.actor.id,"",quiet);
  await f.pump();
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_documents__document").get().n,1);
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__title").get().n,1);
  assert.deepEqual(f.events().filter(e=>e.seq!==null).map(e=>e.seq),[1,2,3]);
  await f.drain();
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__title").get().n,1);
});

test("trabalho sem orçamento, orçamento enviado, aprovação e execução concluem no motor real", async t => {
  const f = await fixture(t);
  assert(f.events().every(event => event.seq === null));
  let row = await f.quote();
  row = await api.sendQuote(f.ctx, row, f.actor.id, quiet);
  row = await api.decide(f.ctx, row, "approve", f.actor.id, "panel", "", quiet);
  await api.changeStatus(f.ctx, row, "in_progress", f.actor.id, "", quiet);
  assert.deepEqual(f.events().filter(event => event.seq !== null).map(event => event.seq), [1, 2, 3, 4]);
  await f.pump();
  assert(f.events().every(event => f.delivery(event).state === "done"));
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_documents__document").get().n, 1);
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__title").get().n, 1);
  await f.drain();
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__title").get().n, 1);
});

test("fato inelegível é terminal mesmo com predecessor pendente, e lote misto compacta a sequência",async t=>{
  const f=await fixture(t); await f.quote();
  const original=f.events().at(-1), revision=original.source_revision+1;
  const local={...original,id:uid(),command_id:api.commandId(f.source,2),event_key:uid(),seq:2,source_revision:revision,snapshot:{...original.snapshot,source_revision:revision},eligible:{document:false,stock:false,finance:false}};
  const remote={...local,id:api.commandId(f.source,3),command_id:api.commandId(f.source,3),event_key:uid(),seq:3,eligible:original.eligible};
  await f.env.DB.batch(api.integrationStatements({source:f.source,expected_revision:revision-1,events:[local,remote],next_state:{snapshot:remote.snapshot}}).map(([sql,args])=>f.env.DB.prepare(sql).bind(...args)));
  const facts=f.events(); assert.equal(facts.at(-2).seq,null); assert.equal(f.delivery(facts.at(-2)).state,"done"); assert.equal(facts.at(-1).seq,2);
  await f.pump(); assert.equal(f.calls.filter(c=>c==="erp_module_apply").length,2);
});

test("automação desligada no nascimento exige pessoa mesmo se religada antes da drenagem",async t=>{
  const f=await fixture(t); const row=await f.quote();
  await api.patchWorkCommercial(f.ctx,f.actor,row.id,{version:row.row_version,authorize_fixed_price:true},uid());
  await f.pump();
  await api.patchCommercialPolicy(f.env,f.actor,f.profile,{version:1,auto_post:{finance:false}},uid());
  await api.changeStatus(f.ctx,await api.loadOrder(f.ctx,row.id),"in_progress",f.actor.id,"",quiet);
  const event=f.events().at(-1), auth=JSON.parse(f.local.prepare("SELECT authorization_json FROM module_erp_event_automation WHERE event_id=?").get(event.id).authorization_json);
  assert.equal(auth.finance,0);
  await api.patchCommercialPolicy(f.env,f.actor,f.profile,{version:2,auto_post:{finance:true}},uid());
  await f.pump();
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__title").get().n,0);
  const view=await api.integrationSourceView(f.env,f.actor,f.source);
  assert.equal(view.state,"skipped"); assert.equal(view.skipped_reason,"automation_off"); assert.deepEqual(view.manual_destinations,["finance"]);
});

test("falhas de consulta antes do envio contam, recuam e ficam visíveis",async t=>{
  const f=await fixture(t); await f.quote(); const e=f.events().at(-1);
  const token=await api.acquireIntegrationLease(f.env,e.id);
  await api.persistPreparedRequest(f.env,e,await api.prepareErpRequest(f.env,e),token);
  f.local.prepare("UPDATE module_erp_delivery SET lease_until_ms=0 WHERE event_id=?").run(e.id);
  f.intercept(name=>{assert.equal(name,"erp_module_origin_get");return Response.json({code:"error"},{status:503});});
  for(let i=1;i<=12;i++){ const before=Date.now(); await f.drain(); const d=f.delivery(e); assert.equal(d.lookup_attempts,i); assert(d.next_attempt_ms>=before+api.retryDelay(i)); }
  assert.equal(f.delivery(e).state,"failed"); assert.equal(f.delivery(e).attempts,0);
  const count=f.calls.length; await f.drain(); assert.equal(f.calls.length,count);
});

for (const phase of ["ausente", "preparado", "incerto"]) {
  test(`falha ao ler pedido ${phase} tem limite sem perder a recuperação do recibo`, async t => {
    const f = await fixture(t); await f.quote();
    const event = f.events().at(-1);
    if (phase === "preparado") {
      const token = await api.acquireIntegrationLease(f.env, event.id);
      await api.persistPreparedRequest(f.env, event, await api.prepareErpRequest(f.env, event), token);
      f.local.prepare("UPDATE module_erp_delivery SET lease_until_ms=0 WHERE event_id=?").run(event.id);
    } else if (phase === "incerto") {
      f.local.prepare("UPDATE module_erp_delivery SET attempts=11 WHERE event_id=?").run(event.id);
      f.intercept(async (name, req, run) => {
        const response = await run();
        if (name === "erp_module_apply") { assert.equal(response.status, 200); throw Error("resposta perdida"); }
        return response;
      });
      await f.drain();
      assert.equal(f.delivery(event).state, "uncertain");
    }
    const prepare = f.env.DB.prepare, calls = f.calls.length;
    let reads = 0;
    f.env.DB.prepare = sql => {
      if (sql === "SELECT * FROM module_erp_requests WHERE event_id=?") {
        reads++; throw Error("leitura local temporariamente indisponível");
      }
      return prepare(sql);
    };
    for (let n = 1; n <= 12; n++) {
      const before = Date.now(); await f.drain();
      const delivery = f.delivery(event);
      assert.equal(delivery[phase === "ausente" ? "preparation_attempts" : "lookup_attempts"], n);
      assert.equal(delivery.attempts, phase === "incerto" ? 12 : 0);
      assert(delivery.next_attempt_ms >= before + api.retryDelay(n));
    }
    assert.equal(f.delivery(event).state, phase === "incerto" ? "uncertain" : "failed");
    assert.equal(f.calls.length, calls);
    await f.drain(); assert.equal(reads, 12);
    f.env.DB.prepare = prepare;
    await api.integrationCommand(f.env, f.actor, f.profile, "integration.retry", {
      module: "os", id: f.row.id, event_id: event.id,
    }, uid());
    await f.pump();
    assert.equal(f.delivery(event).state, "done");
    assert.equal(f.calls.filter(name => name === "erp_module_apply").length, 1);
    assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_documents__document").get().n, 1);
  });
}

test("último envio com resposta perdida é recuperado por recibo sem reaplicar",async t=>{
  const f=await fixture(t); await f.quote(); const e=f.events().at(-1);
  f.local.prepare("UPDATE module_erp_delivery SET attempts=11 WHERE event_id=?").run(e.id);
  f.intercept(async(name,req,run)=>{const response=await run(); if(name==="erp_module_apply") {assert.equal(response.status,200);throw Error("resposta perdida");}return response;});
  await f.drain(); assert.equal(f.delivery(e).state,"uncertain"); assert.equal(f.delivery(e).attempts,12);
  await f.drain(); assert.equal(f.delivery(e).state,"done"); assert.equal(f.calls.filter(c=>c==="erp_module_apply").length,1);
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_documents__document").get().n,1);
});

test("prazo global termina uma chamada em curso mesmo se o transporte ignorar o aborto",async t=>{
  const f=await fixture(t); await f.quote(); f.intercept(()=>new Promise(()=>{}));
  const before=Date.now(); await f.drain({budget_ms:40}); assert(Date.now()-before<1000);
  const d=f.delivery(f.events().at(-1)); assert.equal(d.state,"pending"); assert.equal(d.unresolved,1); assert.equal(d.lease_token,null);
});

test("corrigir com sucessores recusa antes de fechar o original",async t=>{
  const f=await fixture(t); const row=await f.quote(), old=f.events().at(-1);
  await api.patchWorkCommercial(f.ctx,f.actor,row.id,{version:row.row_version,authorize_fixed_price:true},uid());
  await assert.rejects(api.integrationCommand(f.env,f.actor,f.profile,"integration.replace",{module:"os",id:row.id,event_id:old.id,reason_code:"correction"},uid()),{code:"replacement_successors"});
  assert.equal(f.calls.length,0); assert.equal(f.delivery(old).state,"pending");
});

test("substituição reserva antes do fechamento e retoma queda com a mesma chave",async t=>{
  const f=await fixture(t); await f.quote(); const old=f.events().at(-1), key=uid(), data={module:"os",id:f.row.id,event_id:old.id,reason_code:"correction"};
  let lost=false;
  f.intercept(async(name,req,run)=>{if(name==="erp_module_command_close") {assert(f.local.prepare("SELECT replacement_key FROM module_erp_sources WHERE source_id=?").get(f.row.id).replacement_key);const result=await run();if(!lost){lost=true;throw Error("resposta perdida");}return result;}return run();});
  await assert.rejects(api.integrationCommand(f.env,f.actor,f.profile,"integration.replace",data,key));
  assert.equal(f.delivery(old).state,"pending");
  for (const view of [await api.integrationSourceView(f.env, f.actor, f.source), await api.workCommercialView(f.ctx, f.actor, f.row.id)]) {
    assert.equal(view.state, "blocked"); assert.equal(view.reason_code, "correction_in_progress"); assert.equal(view.pending, true);
    assert.equal(view.blocked_reason, "Uma correção está reservada para esta origem. Retome a mesma solicitação.");
  }
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("actor", f.actor); await next(); });
  api.registerIntegrationRoutes(app, () => { throw Error("somente leitura"); });
  const response = await app.request(`http://local/api/v1/profiles/${f.profile}/integrations/os/status`, undefined, f.env);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).counters, [{ state: "blocked", count: 1 }]);
  const result=await api.integrationCommand(f.env,f.actor,f.profile,"integration.replace",data,key);
  assert(result.accepted); assert.equal(f.delivery(old).state,"done");
  assert.equal(f.local.prepare("SELECT replacement_key FROM module_erp_sources WHERE source_id=?").get(f.row.id).replacement_key,null);
  await f.pump(); assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_documents__document").get().n,1);
});

test("restauração ERP sem predecessor bloqueia a origem sem relançar",async t=>{
  const f=await fixture(t); let row=await f.quote(); await f.pump();
  f.lite.exec("DELETE FROM erp_documents__command");
  await api.patchWorkCommercial(f.ctx,f.actor,row.id,{version:row.row_version,authorize_fixed_price:true},uid());
  await f.drain(); const e=f.events().at(-1), d=f.delivery(e);
  assert.equal(d.state,"blocked"); assert.equal(d.error_message,"ERP e fila divergentes (restauração?)");
  const count=f.calls.length; await f.drain(); assert.equal(f.calls.length,count);
  await assert.rejects(api.integrationCommand(f.env,f.actor,f.profile,"integration.retry",{module:"os",id:row.id,event_id:e.id},uid()),{code:"integration_divergent"});
});

test("manutenção não envia contato ou auto_post; política de Estoque omite referências financeiras",async t=>{
  const f=await fixture(t); await f.quote(); await f.pump();
  const previous=f.events().at(-1), seq=previous.seq+1, revision=previous.source_revision+1;
  const event={...previous,id:uid(),command_id:api.commandId(f.source,seq),seq,source_revision:revision,event_key:uid(),operation:"cancel",reason_code:"cancelled",snapshot:{...previous.snapshot,source_revision:revision,lifecycle:{...previous.snapshot.lifecycle,base_status:"cancelled"}}};
  await f.env.DB.batch(api.integrationStatements({source:f.source,expected_revision:revision-1,events:[event],next_state:{snapshot:event.snapshot}}).map(([sql,args])=>f.env.DB.prepare(sql).bind(...args)));
  const request=await api.prepareErpRequest(f.env,event);
  assert.equal(request.body.snapshot.contact_id,null); assert(!Object.hasOwn(request.body.policy,"auto_post"));
  const stock={...f.actor,role:"operator",access:["erp:estoque"]};
  const policy=api.commercialPolicyView(await api.ensureCommercialPolicy(f.env,f.profile),stock);
  for(const key of ["revenue_category_id","payment_method_id","settlement_accounts","consumer_contact_id"])assert(!Object.hasOwn(policy,key));
  assert.deepEqual(Object.keys(policy.auto_post),["stock"]);
});

test("projeção distingue ausência, salto local, espera e confirmação remota",()=>{
  assert.equal(api.effectiveSourceState([]).state,"none");
  assert.equal(api.effectiveSourceState([{state:"done",error_code:"part_disabled"}]).state,"skipped");
  assert.equal(api.effectiveSourceState([{state:"sending"}]).state,"pending");
  assert.equal(api.effectiveSourceState([{state:"uncertain"}]).state,"uncertain");
  assert.equal(api.effectiveSourceState([{state:"done",receipt_json:JSON.stringify({outcome:"applied",links:[{kind:"document"}],effects:{finance:"posted",stock:"not_requested"}})}]).state,"done");
});

test("rodada agenda drenagem em waitUntil e retorna enquanto o ERP está suspenso",async t=>{
  const f=await fixture(t); await f.quote();
  let release,entered; const gate=new Promise(resolve=>{release=resolve;}); const seen=new Promise(resolve=>{entered=resolve;});
  f.intercept(async(name,req,run)=>{entered();await gate;return run();});
  const background=[]; let timer;
  try {
    await Promise.race([api.runModuleSchedules(f.env,f.profile,Date.now(),work=>background.push(work)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("rodada esperou ERP")),1500);})]);
    assert.equal(background.length,1); await seen;
    assert.equal(f.delivery(f.events().at(-1)).state,"sending");
  } finally { clearTimeout(timer); release(); await Promise.all(background); }
  assert.equal(f.delivery(f.events().at(-1)).state,"done");
});

test("falhas reais de preparação têm recuo e limite, sem envio",async t=>{
  const f=await fixture(t);await f.quote(); const e=f.events().at(-1),prepare=f.env.DB.prepare;
  f.env.DB.prepare=sql=>{if(sql.includes("SELECT id,name,version,erp_contact_id"))throw Error("falha transitória de leitura");return prepare(sql);};
  for(let n=1;n<=12;n++){await f.drain();assert.equal(f.delivery(e).preparation_attempts,n);}
  assert.equal(f.delivery(e).state,"failed");assert.equal(f.delivery(e).attempts,0);assert.equal(f.calls.length,0);
});

test("D1 restaurado reutilizando sequência de outro fato bloqueia sem duplicar efeito",async t=>{
  const f=await fixture(t); await f.quote();const first=f.events().at(-1);
  // O ERP confirma e só a resposta é perdida. O retrato D1 em seguida é o
  // anterior ao fato: simulação isolada de restauração, nunca reparo da fila.
  const before=f.local.prepare("SELECT * FROM module_erp_sources WHERE source_id=?").get(f.row.id);
  await f.pump(); const after=f.local.prepare("SELECT * FROM module_erp_sources WHERE source_id=?").get(f.row.id);
  f.local.exec("DROP TRIGGER module_erp_events_no_delete; DROP TRIGGER module_erp_requests_no_delete; DROP TRIGGER module_erp_automation_no_delete;");
  f.local.prepare("DELETE FROM module_erp_requests WHERE event_id=?").run(first.id);
  f.local.prepare("DELETE FROM module_erp_event_automation WHERE event_id=?").run(first.id);
  f.local.prepare("DELETE FROM module_erp_delivery WHERE event_id=?").run(first.id);
  f.local.prepare("DELETE FROM module_erp_events WHERE id=?").run(first.id);
  f.local.prepare("UPDATE module_erp_sources SET revision=?,enqueued_seq=0,applied_seq=0,links_json='[]',confirmed_ms=NULL WHERE source_id=?").run(before.revision-1,f.row.id);
  const changed={...first,id:uid(),event_key:uid(),occurred_ms:first.occurred_ms+1};
  await f.env.DB.batch(api.integrationStatements({source:f.source,expected_revision:changed.source_revision-1,events:[changed],next_state:{snapshot:changed.snapshot}}).map(([sql,args])=>f.env.DB.prepare(sql).bind(...args)));
  await f.drain(); assert.equal(f.delivery(changed).error_code,"integration_divergent");assert.equal(f.delivery(changed).state,"blocked");
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_documents__document").get().n,1);assert.equal(after.applied_seq,1);
});

test("consumidores concorrentes preservam sequência compacta e efeito único",async t=>{
  const f=await fixture(t);await f.quote();
  await Promise.all([f.drain(),f.drain()]);
  assert.equal(f.delivery(f.events().at(-1)).state,"done");
  assert.equal(f.calls.filter(c=>c==="erp_module_apply").length,1);
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_documents__document").get().n,1);
});

test("fato local usa identidade isolada por área e origem",()=>{
  const source={profile:"a",module:"os",source_id:"source",component:"main"};
  assert.notEqual(api.localEventId(source,"mesma-chave"),api.localEventId({...source,profile:"b"},"mesma-chave"));
});

test("queda na última consulta não deixa concessão vencida eternamente em sending",async t=>{
  const f=await fixture(t);await f.quote();const e=f.events().at(-1);
  const token=await api.acquireIntegrationLease(f.env,e.id);
  await api.persistPreparedRequest(f.env,e,await api.prepareErpRequest(f.env,e),token);
  f.local.prepare("UPDATE module_erp_delivery SET lookup_attempts=12,lease_until_ms=0,unresolved=1,attempts=12 WHERE event_id=?").run(e.id);
  await f.drain(); assert.equal(f.delivery(e).state,"uncertain"); assert.equal(f.delivery(e).lease_token,null); assert.equal(f.calls.length,0);
});

test("consulta de recibo bem-sucedida não zera falhas locais posteriores ao preparo",async t=>{
  const f=await fixture(t);await f.quote();const e=f.events().at(-1),token=await api.acquireIntegrationLease(f.env,e.id);
  await api.persistPreparedRequest(f.env,e,await api.prepareErpRequest(f.env,e),token);
  f.local.prepare("UPDATE module_erp_delivery SET lease_until_ms=0 WHERE event_id=?").run(e.id);
  const prepare=f.env.DB.prepare;
  f.env.DB.prepare=sql=>{if(sql.includes("SELECT a.authorization_json"))throw Error("política temporariamente indisponível");return prepare(sql);};
  for(let n=1;n<=12;n++){await f.drain();assert.equal(f.delivery(e).preparation_attempts,n);}
  assert.equal(f.delivery(e).state,"failed");assert.equal(f.delivery(e).attempts,0);assert.equal(f.calls.filter(c=>c==="erp_module_apply").length,0);
});

test("resposta inválida após último commit conserva incerteza e recupera o recibo",async t=>{
  const f=await fixture(t);await f.quote();const e=f.events().at(-1);
  f.local.prepare("UPDATE module_erp_delivery SET attempts=11 WHERE event_id=?").run(e.id);
  f.intercept(async(name,req,run)=>{const response=await run();if(name!=="erp_module_apply")return response;const body=await response.json();body.links[0].id=null;return Response.json(body);});
  await f.drain();assert.equal(f.delivery(e).state,"uncertain");await f.drain();assert.equal(f.delivery(e).state,"done");
  assert.equal(f.calls.filter(c=>c==="erp_module_apply").length,1);
});

test("reserva de correção impede mutação comercial concorrente até instalar substituto",async t=>{
  const f=await fixture(t);await f.quote();const e=f.events().at(-1);
  let raced=false;
  f.intercept(async(name,req,run)=>{if(name==="erp_module_command_close"){
    const before=await api.loadOrder(f.ctx,f.row.id);raced=true;
    await assert.rejects(api.saveQuote(f.ctx,before,{items:[{description:"Não confirmar",quantity:1,unit_cents:2000,kind:"free"}]},f.actor.id,uid()));
    assert.equal((await api.loadOrder(f.ctx,f.row.id)).quote_total_cents,before.quote_total_cents);
  }return run();});
  await api.integrationCommand(f.env,f.actor,f.profile,"integration.replace",{module:"os",id:f.row.id,event_id:e.id,reason_code:"correction"},uid());
  assert(raced);await f.pump();assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_documents__document").get().n,1);
});

for (const field of ["warehouse_id", "revenue_category_id", "payment_method_id"]) {
  test(`referência inválida ${field} vira pendência corrigível sem reescrever o pedido`, async t => {
    const f = await fixture(t);
    const config = f.local.prepare("SELECT config_json FROM module_erp_policy WHERE profile_id=?").get(f.profile).config_json;
    const invalid = { ...JSON.parse(config), [field]: uid() };
    f.local.prepare("UPDATE module_erp_policy SET config_json=? WHERE profile_id=?").run(api.canonical(invalid), f.profile);
    await f.quote();
    const old = f.events().at(-1);
    await f.drain();
    assert.equal(f.delivery(old).state, "blocked");
    assert.equal(f.delivery(old).error_code, "default_inactive");
    assert.equal(f.delivery(old).error_message, "O padrão comercial não está ativo.");
    assert.equal(f.delivery(old).unresolved, 0);
    const request = await api.readPreparedRequest(f.env, old);
    assert(request);
    assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_documents__document").get().n, 0);
    f.local.prepare("UPDATE module_erp_policy SET config_json=? WHERE profile_id=?").run(config, f.profile);
    const key = uid(), data = { module: "os", id: f.row.id, event_id: old.id, reason_code: "correction" };
    const result = await api.integrationCommand(f.env, f.actor, f.profile, "integration.replace", data, key);
    assert.notEqual(result.event_id, old.id);
    await f.pump();
    assert.deepEqual(await api.readPreparedRequest(f.env, old), request);
    assert.equal(JSON.parse(f.delivery(old).receipt_json).outcome, "closed");
    assert.deepEqual(await api.integrationCommand(f.env, f.actor, f.profile, "integration.replace", data, key), result);
    assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_documents__document").get().n, 1);
    assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__title").get().n, 0);
  });
}

test("mudança de etapa de documento vinculado não depende de promover novamente o cliente", async t => {
  const f = await fixture(t);
  await f.quote(); await f.pump();
  await api.sendQuote(f.ctx, await api.loadOrder(f.ctx, f.row.id), f.actor.id, quiet);
  const event = f.events().at(-1);
  assert.equal(event.operation, "lifecycle");
  f.local.prepare("UPDATE contacts SET name='' WHERE profile_id=?").run(f.profile);
  const request = await api.prepareErpRequest(f.env, event);
  assert.equal(request.body.snapshot.contact_id, null);
  assert(!Object.hasOwn(request.body.policy, "auto_post"));
  assert.equal(f.delivery(event).state, "pending");
});

test("eventos locais de trabalho legado são lidos pela revisão sem criar lançamento retroativo", async t => {
  const f = await fixture(t);
  f.local.prepare("UPDATE os_orders SET status='ready',stage='ready',commercial_json='{}' WHERE id=?").run(f.row.id);
  const row = await api.changeStatus(f.ctx, await api.loadOrder(f.ctx, f.row.id), "in_progress", f.actor.id, "Revisão de trabalho antigo", quiet);
  assert.equal(JSON.parse(row.commercial_json).historical_execution, true);
  const integration = await api.readWorkIntegration(f.ctx, row);
  const events = integration.events.map(e => JSON.parse(e.payload_json));
  assert.deepEqual(events.map(e => e.source_revision), [1, 2, 3]);
  assert(events.every(e => e.seq === null));
  assert.equal(events.at(-1).operation, "lifecycle");
  await f.drain();
  assert.equal(f.calls.length, 0);
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_documents__document").get().n, 0);
});
