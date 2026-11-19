import assert from "node:assert/strict";
import { randomUUID as uid } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { build } from "esbuild";
import { freshLite, nodeDriver } from "./node-driver.mjs";
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
  export {batch,one,all} from './src/db.ts';
  export {registerPaymentHook,paymentHook} from './src/modules/hooks.ts';
  export {paymentView,deliverPaymentHooks,refreshFromProvider,providers} from './src/payments.ts';
  export * from './src/integrations/payment-evidence.ts';
  export * from './src/payments-commercial-evidence.ts';
  export {mercadoPago} from './src/payments-mercadopago.ts';
  export {createOrder as createSale,paymentUpdated as pedidoPaid} from './src/modules/pedido/orders.ts';
  export {createBooking} from './src/modules/reserva/bookings.ts';
  export {agendaTrigger,manualBookingReceipt} from './src/modules/agenda/integration.ts';
  export {paymentUpdated as reservaPaid,expireBooking} from './src/modules/reserva/deposit.ts';
  export {saveUnit} from './src/modules/reserva/units.ts';
  export {reservaConfig,addDays,brasiliaDate,atClock} from './src/modules/reserva/config.ts';
  export {purchasePaymentUpdated} from './src/modules/suporte/store.ts';
  export {supportIntegrationStatements,supportIntegrationStatus} from './src/modules/suporte/integration.ts';
  export {createPlan,createSubscription} from './src/modules/mensalidade/store.ts';
  export {generateInstallments} from './src/modules/mensalidade/installments.ts';
  export {paymentUpdated as mensalidadePaid} from './src/modules/mensalidade/billing.ts';
  export {today} from './src/modules/mensalidade/model.ts';

` }, bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", plugins: [{ name: "offline-runtime", setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "runtime", namespace: "offline" }));
  b.onLoad({ filter: /.*/, namespace: "offline" }, () => ({ contents: "export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }" }));
} }] });
// Arquivo temporário no workspace evita stacks contendo o bundle inteiro.
const runtimeDir = mkdtempSync(root + ".f3-runtime-");
process.on("exit", () => rmSync(runtimeDir, { recursive: true, force: true }));
writeFileSync(runtimeDir + "/runtime.mjs", built.outputFiles[0].text);
export const api = await import(runtimeDir + "/runtime.mjs");
export const quiet = { notify: false };
export async function fixture(t) {
  const local = new DatabaseSync(":memory:"), lite = freshLite(), driver = nodeDriver(lite);
  t.after(() => { local.close(); lite.close(); });
  for (const name of readdirSync(root + "migrations").filter(n => n.endsWith(".sql")).sort()) local.exec(readFileSync(root + "migrations/" + name, "utf8"));
  const prepare = (sql, args = []) => ({ sql, args, bind: (...params) => prepare(sql, params),
    async all() { return execute(this); }, async run() { return execute(this); },
    async first(key) { const row = execute(this).results[0] ?? null; return key ? row?.[key] ?? null : row; },
  });
  const execute = ({sql,args}) => ({ results: local.prepare(sql).all(...args).map(row => ({ ...row })), success: true, meta: { changes: local.prepare("SELECT changes() n").get().n } });
  const profile = uid(), actor = { id: uid(), kind: "user", name: "Pessoa", role: "admin", profiles: [profile], access: [], scopes: [], bots: [], rate: 0, runLimit: 0, aal: 2, mfa: { factor: true, policy: "financial" }, sessionId: uid() };
  const human = { user_id: actor.id, erp_role: "admin", name: "Pessoa", email: null, is_agent: false, verified_factor: true, session_id: actor.sessionId, aal: "aal2" };
  const rpc = (name, args) => callRpc(driver, name, { p_user_id: actor.id, ...args }, undefined, { identity: { actor: human, people: [human] } });
  const values = new Map(), storage = { async get(k) { return values.get(k); }, async put(k,v) { if (typeof k === "object") for (const [key,value] of Object.entries(k)) values.set(key,value); else values.set(k,v); }, async transaction(fn) { return fn(storage); }, transactionSync: fn => driver.transaction(fn), sql: { exec(sql,...params) { const r = driver.exec(sql,...params); return { ...r, toArray: () => r.rows }; } } };
  const calls = [];
  let intercept = null;
  const env = { DB: { prepare, async batch(statements) { assert(statements.length, "D1_ERROR: No SQL statements detected."); local.exec("BEGIN"); try { const result = statements.map(execute); local.exec("COMMIT"); return result; } catch(e) { local.exec("ROLLBACK"); throw e; } } },
    COORDINATOR: { idFromName: n => n, get(name) { return { async fetch(url, init) {
      const req = new Request(url, init), path = new URL(url).pathname;
      if (!path.startsWith("/erp-rpc/")) return Response.json({ ok: true });
      const rpcName = path.slice("/erp-rpc/".length); calls.push(rpcName);
      const run = () => handleRpc({ storage }, profile, rpcName, req, undefined, env.DB);
      return intercept ? intercept(rpcName, req, run) : run();
    } }; } }, MEDIA: { async get() { return null; }, async put() {}, async delete() {} }, MASTER_KEY: "offline-f3-test-key-000000000000000000000000" };
  local.prepare("INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,'Área',?,1,?)").run(profile, JSON.stringify(api.defaults), Date.now());
  local.prepare("INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,'Pessoa','test','admin',?,?)").run(actor.id, `${actor.id}@example.test`, JSON.stringify([profile]), Date.now());
  for (const id of ["os","erp","erp-produtos","erp-estoque","erp-financeiro","erp-vendas"]) local.prepare("INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,?,1,?) ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=excluded.enabled,updated=excluded.updated").run(profile,id,Date.now()-1000);
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
  return {env,local,lite,driver,profile,actor,ctx,row,source,events,delivery,due,drain,calls,rpc,localId,customer, intercept(fn){intercept=fn;},
    async quote() { return api.saveQuote(ctx, await api.loadOrder(ctx,row.id),{items:[{description:"Reparo",quantity:1,unit_cents:1000,kind:"free"}]},actor.id,uid()); },
    async pump() { for(let i=0;i<20;i++) { await drain(); const pending=local.prepare("SELECT * FROM module_erp_delivery WHERE state<>'done'").all(); if(!pending.length)return; assert(!pending.some(d=>["failed","blocked","waiting_manual","uncertain"].includes(d.state)),JSON.stringify(pending)); } assert.fail("fila não concluiu"); },
  };
}

