import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID as uid } from "node:crypto";
import { Hono } from "hono";
import { api, fixture, quiet } from "../harness/f3-local.mjs";

async function parts(f, choices) {
  const at = Date.now();
  await api.batch(f.env, [...Object.entries(choices).map(([id, enabled]) => [
    "INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,?,?,?) ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=excluded.enabled,updated=excluded.updated", [f.profile,id,enabled?1:0,at]]),
    ...api.activationStatements(f.profile,Object.entries(choices).map(([module_id,enabled])=>({module_id,enabled})),at)]);
}
async function delivery(f) {
  await parts(f,{entrega:true});
  f.local.prepare("UPDATE module_erp_policy SET config_json=json_set(config_json,'$.consumer_contact_id',?) WHERE profile_id=?").run(f.customer.id,f.profile);
  const account=f.rpc("erp_finance_account_execute",{p_command_id:uid(),p_action:"account_create",p_data:{account_type:"cash",name:"Caixa",start_on:"2020-01-01",opening_cents:"0"}}).record;
  f.local.prepare("UPDATE module_erp_policy SET config_json=json_set(config_json,'$.settlement_accounts.cash',?) WHERE profile_id=?").run(account.id,f.profile);
  const ctx={...api.modulesApi(f.env,f.profile,"entrega"),publish:async()=>1,sendMessage:async()=>"sent",note:async()=>{}};
  const row=await api.createDelivery(ctx,f.actor,{label:"Entrega",source:"manual"},uid());
  await api.updateDeliveryCommercial(ctx,f.actor,{id:row.id,version:0,price_cents:1000,authorize:true},uid());
  const source={profile:f.profile,module:"entrega",source_id:row.id,component:"main"};
  const events=()=>f.local.prepare("SELECT payload_json FROM module_erp_events WHERE source_id=? ORDER BY source_revision,seq").all(row.id).map(e=>JSON.parse(e.payload_json));
  return {ctx,row,source,events};
}

test("segunda revisão: recebimentos humanos obedecem MFA financeiro e política desligada",async t=>{
  const f=await fixture(t),d=await delivery(f),weak={...f.actor,aal:1};await f.pump();
  await assert.rejects(api.receiveDelivery(d.ctx,weak,{id:d.row.id,amount_cents:400,method:"cash"},"paid"),e=>e.code==="mfa_required");
  await assert.rejects(api.markPaid(f.ctx,weak,{id:uid()},"paid"),e=>e.code==="mfa_required");
  await parts(f,{mesas:true});
  const ctx={...api.modulesApi(f.env,f.profile,"mesas"),publish:async()=>1},tab=uid(),table=uid(),at=Date.now();
  f.local.prepare("INSERT INTO mesas_tables(id,profile_id,name,created,updated) VALUES(?,?,'Mesa',?,?)").run(table,f.profile,at,at);
  f.local.prepare("INSERT INTO mesas_tabs(id,profile_id,number,table_id,table_name,status,service,service_permille,opened_by,opened_at,created,updated) VALUES(?,?,1,?,'Mesa','open',0,100,?,?,?,?)").run(tab,f.profile,table,f.actor.id,at,at,at);
  await assert.rejects(api.addPayment(ctx,weak,{id:tab,amount_cents:100,method:"cash"},uid()),e=>e.code==="mfa_required");
  await assert.rejects(api.voidPayment(ctx,weak,{id:uid(),reason:"Erro"}),e=>e.code==="mfa_required");
  await assert.rejects(api.closeTab(ctx,weak,{id:tab,payments:[{amount_cents:100,method:"cash"}]},uid()),e=>e.code==="mfa_required");
  assert.equal(f.local.prepare("SELECT count(*) n FROM module_commercial_receipts").get().n,0);
  await api.receiveDelivery(d.ctx,{...weak,mfa:{factor:false,policy:"off"}},{id:d.row.id,amount_cents:400,method:"cash"},"paid");await f.pump();
  assert.equal(f.lite.prepare("SELECT settled_cents FROM erp_finance__title").get().settled_cents,400);
});

test("segunda revisão: padrão desligado, destino independente e ausência de retroatividade",async t=>{
  const f=await fixture(t,false);
  assert.deepEqual((await api.ensureCommercialPolicy(f.env,f.profile)).auto_post,{stock:false,finance:false});
  let row=await f.quote();
  await api.patchWorkCommercial(f.ctx,f.actor,row.id,{version:row.row_version,authorize_fixed_price:true},uid());
  await api.changeStatus(f.ctx,await api.loadOrder(f.ctx,row.id),"in_progress",f.actor.id,"",quiet);
  await f.pump();
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__title").get().n,0);
  const view=await api.integrationSourceView(f.env,f.actor,f.source);
  assert.equal(view.state,"skipped");assert.equal(view.skipped_reason,"automation_off");assert.deepEqual(view.manual_destinations,["finance"]);
  await api.patchCommercialPolicy(f.env,f.actor,f.profile,{version:1,auto_post:{finance:true}},uid());
  await f.drain(); assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__title").get().n,0);
  const d=await delivery(f);await f.pump();
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__title").get().n,1);
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_stock__document_posting").get().n,0);
  assert.equal((await api.ensureCommercialPolicy(f.env,f.profile)).auto_post.stock,false);
  assert.equal((await api.integrationSourceView(f.env,f.actor,d.source)).state,"done");
});

for (const prepared of [false, true]) test(`segunda revisão: quinze suspensões preservam orçamento (pedido preparado: ${prepared}) e recebimento retoma sem duplicar`,async t=>{
  const f=await fixture(t),d=await delivery(f); await f.pump();
  if (!prepared) await parts(f,{"erp-financeiro":false});
  await api.receiveDelivery(d.ctx,f.actor,{id:d.row.id,amount_cents:400,method:"cash"},"paid");
  const event=d.events().at(-1);
  if (prepared) {
    const token=await api.acquireIntegrationLease(f.env,event.id);
    await api.persistPreparedRequest(f.env,event,await api.prepareErpRequest(f.env,event),token);
    f.local.prepare("UPDATE module_erp_delivery SET state='pending',lease_token=NULL,lease_until_ms=NULL WHERE event_id=?").run(event.id);
    await parts(f,{"erp-financeiro":false});
  }
  for(let n=0;n<15;n++) await f.drain();
  const pending=f.delivery(event);
  assert.equal(pending.state,"pending");assert.equal(pending.error_code,"part_disabled");assert.equal(pending.preparation_attempts,0);assert.equal(pending.attempts,0);assert.equal(pending.lookup_attempts,0);
  await parts(f,{"erp-financeiro":true});await f.pump();await f.pump();
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__settlement").get().n,1);
  assert.equal(f.lite.prepare("SELECT settled_cents FROM erp_finance__title").get().settled_cents,400);
});

test("segunda revisão: lifecycle não apaga execução fechada sem título",async t=>{
  const f=await fixture(t),d=await delivery(f);await f.drain();
  await parts(f,{"erp-financeiro":false});await parts(f,{"erp-financeiro":true});await f.drain();
  await api.batch(f.env,await api.deliveryLifecycleStatements(d.ctx,await api.one(f.env,"SELECT * FROM entrega_deliveries WHERE id=?",d.row.id),f.actor.id,false));await f.drain();
  const view=await api.integrationSourceView(f.env,f.actor,d.source);
  assert.equal(view.state,"blocked");assert.equal(view.reason_code,"epoch_closed");assert.equal(view.pending,true);assert.deepEqual(view.manual_destinations,["finance"]);
  assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_finance__title").get().n,0);
});

test("segunda revisão: cancelamento de Entrega parcial só encerra a obrigação depois da devolução",async t=>{
  const f=await fixture(t),d=await delivery(f);await f.pump();
  const receipt=await api.receiveDelivery(d.ctx,f.actor,{id:d.row.id,amount_cents:400,method:"cash"},"paid");await f.pump();
  await api.cancelDelivery(d.ctx,f.actor,{id:d.row.id,reason:"Cancelamento"});
  assert.equal(d.events().at(-1).seq,null);
  assert.equal((await api.integrationSourceView(f.env,f.actor,d.source)).reason_code,"refund_required");
  await api.reverseCommercialReceipt(f.env,f.actor,f.profile,{id:receipt.receipt_key,reason_code:"refund_confirmed"},"refund");await f.pump();
  assert.equal((await api.integrationSourceView(f.env,f.actor,d.source)).state,"done");
  assert.equal(f.lite.prepare("SELECT cancelled,settled_cents FROM erp_finance__title").get().cancelled,1);
  assert.equal(f.lite.prepare("SELECT status FROM erp_documents__document").get().status,"cancelled");
  assert.deepEqual(d.events().filter(e=>e.seq!==null).map(e=>e.operation),["prepare","execute","receive","reverse","cancel"]);
});

for(const reason of ["payment_evidence_required","obligation_reactivation_required","refund_required"]) test(`segunda revisão: retry preserva fato local ${reason}`,async t=>{
  const f=await fixture(t);await f.quote();await f.pump();
  await api.batch(f.env,await api.pendingPaymentStatements(f.env,f.events().at(-1).snapshot,uid(),"paid",reason));
  const event=f.events().at(-1),before=f.delivery(event),calls=f.calls.length;
  await assert.rejects(api.integrationCommand(f.env,f.actor,f.profile,"integration.retry",{module:"os",id:f.row.id,event_id:event.id},uid()),e=>e.code===reason&&e.status===409);
  assert.deepEqual(f.delivery(event),before);assert.equal(f.calls.length,calls);
});

test("segunda revisão: recusa de papel não reserva origem e comercial de Estoque omite finanças",async t=>{
  const f=await fixture(t);await f.quote();
  const actor={...f.actor,role:"operator",access:["*"]};
  await assert.rejects(api.integrationCommand(f.env,actor,f.profile,"integration.replace",{module:"os",id:f.row.id,event_id:f.events().at(-1).id,reason_code:"commercial_correction"},uid()),e=>e.status===403);
  assert.equal(f.local.prepare("SELECT replacement_key FROM module_erp_sources WHERE source_id=?").get(f.row.id).replacement_key,null);
  const view=await api.workCommercialView(f.ctx,{...actor,access:["*","erp:estoque"]},f.row.id);
  assert(!Object.hasOwn(view,"installments"));assert(!Object.hasOwn(view,"total_cents"));assert(!Object.hasOwn(view.items[0],"unit_cents"));assert(!view.manual_destinations.includes("finance"));
});

test("segunda revisão: recusa definitiva depois da reserva mas antes do transporte libera a origem",async t=>{
  const f=await fixture(t);await f.quote();const event=f.events().at(-1),original=f.env.DB.batch;
  f.env.DB.batch=async statements=>{
    const result=await original(statements);
    if(statements.some(s=>s.sql.includes("SET replacement_key=?"))) f.actor.role="operator";
    return result;
  };
  await assert.rejects(api.integrationCommand(f.env,f.actor,f.profile,"integration.replace",{module:"os",id:f.row.id,event_id:event.id,reason_code:"commercial_correction"},uid()),e=>e.status===403);
  assert.equal(f.calls.length,0);
  assert.equal(f.local.prepare("SELECT replacement_key FROM module_erp_sources WHERE source_id=?").get(f.row.id).replacement_key,null);
  f.actor.role="admin";f.env.DB.batch=original;
  await api.integrationCommand(f.env,f.actor,f.profile,"integration.replace",{module:"os",id:f.row.id,event_id:event.id,reason_code:"commercial_correction"},uid());
  await f.pump();assert.equal(f.lite.prepare("SELECT count(*) n FROM erp_documents__document").get().n,1);
});

for(const reason of ["consumption_requires_classification","refund_confirmed_review_stock"]) test(`segunda revisão: postagem manual genérica não classifica material (${reason})`,async t=>{
  const f=await fixture(t);await f.quote();await f.pump();
  const previous=f.events().at(-1),seq=previous.seq+1,revision=previous.source_revision+1;
  const event={...previous,id:uid(),command_id:api.commandId(f.source,seq),seq,source_revision:revision,event_key:uid(),operation:"cancel",reason_code:reason,
    eligible:{document:true,stock:false,finance:true},snapshot:{...previous.snapshot,source_revision:revision,lifecycle:{...previous.snapshot.lifecycle,base_status:"cancelled"}}};
  await api.batch(f.env,api.integrationStatements({source:f.source,expected_revision:revision-1,events:[event],next_state:{snapshot:event.snapshot}}));
  const calls=f.calls.length;
  await assert.rejects(api.integrationCommand(f.env,f.actor,f.profile,"integration.post",{module:"os",id:f.row.id,event_id:event.id,version:revision,destinations:["stock"]},uid()),e=>e.code===reason);
  assert.equal(f.calls.length,calls);assert.equal(f.local.prepare("SELECT replacement_key FROM module_erp_sources WHERE source_id=?").get(f.row.id).replacement_key,null);
});

test("segunda revisão: estado do módulo pagina origens sem truncar a projeção da página",async t=>{
  const f=await fixture(t);await f.quote();
  for(let i=0;i<2;i++) await api.createOrder(f.ctx,{item:"Outro",problem:"Reparo",customer_name:"Cliente",phone:"5511999999977",source:"panel",sourceKey:uid(),actor:f.actor.id,notify:false});
  const app=new Hono();app.use("*",async(c,next)=>{c.set("actor",f.actor);await next();});api.registerIntegrationRoutes(app,async()=>Response.json({}));
  let cursor="",seen=[];
  do{
    const r=await app.request(`/api/v1/profiles/${f.profile}/integrations/os/status?limit=1&after=${encodeURIComponent(cursor)}`,{},f.env);
    assert.equal(r.status,200);const data=await r.json();assert.equal(data.scope,"page");assert.equal(data.counters.reduce((n,c)=>n+c.count,0),1);
    cursor=data.next_cursor;if(cursor){assert(!seen.includes(cursor));seen.push(cursor);}
  }while(cursor);
  assert.equal(seen.length,2);
});
