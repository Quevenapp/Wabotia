// Aceitação transversal: transporte HTTP real + SQLite do motor e evidência D1.
// A montagem de DTOs segue a fixture B2; os cenários abaixo testam a junção.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { build, buildSync } from "esbuild";
import { freshLite, nodeDriver } from "../harness/node-driver.mjs";
import "../../../src/erp/domains/index.ts";
import { callRpc } from "../../../src/erp/engine/registry.ts";
import {
  canonical,
  commandId,
  eventKey,
  hash,
} from "../../../src/integrations/keys.ts";
import {
  verifyModuleTransport,
  moduleSystemUser,
  originAnchor,
} from "../../../src/erp/engine/module-origin.ts";
import {
  encodeIdentity,
  GATE_HEADER,
  IDENTITY_HEADER,
  SYSTEM_HEADER,
} from "../../../src/erp/engine/identity.ts";
import { handleRpc } from "../../../src/erp/engine/rpc-endpoint.ts";
import { normalizeErpParts } from "../../../src/erp/parts.ts";
import { dumpAll, restoreAll } from "../../../src/erp/engine/dump.ts";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const human = {
  user_id: ADMIN,
  erp_role: "admin",
  name: "Pessoa",
  email: null,
  is_agent: false,
  verified_factor: true,
  session_id: "22222222-2222-4222-8222-222222222222",
  aal: "aal2",
};
const at = Date.UTC(2026, 10, 18, 15);
const denied = (error) => error.code === "42501";

test("A4/A8: cortes, política e agendador preservam religamento sem consultas comerciais com Base desligada", async (t) => {
  // Importa na ordem do Worker real. A classe só permite importar o módulo
  // fora do runtime Cloudflare; nenhum Coordinator simulado é instanciado.
  const bundle = await build({
    stdin: {
      contents:
        'export {default as worker} from "./src/index.ts"; export * from "./src/integrations/activation.ts"; export {ensureCommercialPolicy} from "./src/integrations/policy.ts"; export {runModuleSchedules} from "./src/modules/schedule.ts";',
      resolveDir: new URL("../../../", import.meta.url).pathname,
      sourcefile: "offline-worker.ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [
      {
        name: "import-cloudflare",
        setup(b) {
          b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "runtime",
            namespace: "offline",
          }));
          b.onLoad({ filter: /.*/, namespace: "offline" }, () => ({
            contents: "export class DurableObject {}",
          }));
        },
      },
    ],
  });
  const {
    worker,
    readIntegrationActivation,
    activationStatements,
    eventEpochOpen,
    ensureCommercialPolicy,
    runModuleSchedules,
  } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  assert.equal(typeof worker.fetch, "function");
  const local = new DatabaseSync(":memory:");
  t.after(() => local.close());
  const dir = new URL("../../../migrations/", import.meta.url);
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    local.exec(readFileSync(new URL(name, dir), "utf8"));
  const profile = randomUUID(),
    calls = [];
  local
    .prepare(
      "INSERT INTO profiles(id,name,settings,created) VALUES(?,'Teste','{}',1)",
    )
    .run(profile);
  for (const module of [
    "os",
    "erp",
    "erp-produtos",
    "erp-vendas",
    "erp-estoque",
    "erp-financeiro",
  ])
    local
      .prepare(
        "INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,?,1,1) ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=1,updated=excluded.updated",
      )
      .run(profile, module);
  const prepare = (sql, args = []) => ({
    bind: (...next) => prepare(sql, next),
    async all() {
      calls.push(sql);
      return {
        results: local.prepare(sql).all(...args),
        meta: { changes: local.prepare("SELECT changes() n").get().n },
      };
    },
    async first() {
      return (await this.all()).results[0] ?? null;
    },
    async run() {
      return this.all();
    },
  });
  const env = {
    DB: {
      prepare,
      async batch(statements) {
        local.exec("BEGIN");
        try {
          const out = [];
          for (const stmt of statements) out.push(await stmt.all());
          local.exec("COMMIT");
          return out;
        } catch (error) {
          local.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
  const first = await readIntegrationActivation(env, profile, "os");
  assert.equal(first.snapshot.parts.finance, true);
  assert.equal(Object.keys(first.activations).length, 6);
  const count = calls.length;
  const warm = await readIntegrationActivation(env, profile, "os");
  assert.equal(calls.length - count, 1);
  assert.deepEqual(warm.activations, first.activations);
  // Outra chamada inicializa os mesmos cortes entre a leitura e a escrita.
  // O retorno da concorrente precisa conservar todas as épocas persistidas.
  const concurrentProfile = randomUUID();
  local
    .prepare(
      "INSERT INTO profiles(id,name,settings,created) VALUES(?,'Concorrente','{}',1)",
    )
    .run(concurrentProfile);
  let competing;
  const concurrentEnv = {
    DB: {
      ...env.DB,
      async batch(statements) {
        competing = await readIntegrationActivation(
          env,
          concurrentProfile,
          "os",
        );
        return env.DB.batch(statements);
      },
    },
  };
  const afterRace = await readIntegrationActivation(
    concurrentEnv,
    concurrentProfile,
    "os",
  );
  assert.equal(Object.keys(afterRace.activations).length, 6);
  assert.deepEqual(afterRace.activations, competing.activations);
  assert.deepEqual(afterRace.epochs, competing.epochs);
  const event = {
    source: { profile, module: "os" },
    epochs: first.epochs,
    occurred_ms: Date.now() + 1,
  };
  assert.equal(
    eventEpochOpen(event, warm.activations, ["erp-financeiro"]),
    true,
  );
  for (const enabled of [false, true]) {
    await env.DB.batch([
      prepare(
        "UPDATE profile_modules SET enabled=? WHERE profile_id=? AND module_id='erp-financeiro'",
        [Number(enabled), profile],
      ),
      ...activationStatements(
        profile,
        [{ module_id: "erp-financeiro", enabled }],
        Date.now() + 2,
      ).map(([sql, args]) => prepare(sql, args)),
    ]);
  }
  const reopened = await readIntegrationActivation(env, profile, "os");
  assert.equal(
    reopened.activations["erp-financeiro"].epoch,
    first.epochs["erp-financeiro"] + 2,
  );
  assert.equal(
    reopened.activations["erp-financeiro"].first_enabled_ms,
    first.activations["erp-financeiro"].first_enabled_ms,
  );
  assert.equal(
    eventEpochOpen(event, reopened.activations, ["erp-financeiro"]),
    false,
  );
  const policy = await ensureCommercialPolicy(env, profile);
  assert.deepEqual(policy.auto_post, { stock: true, finance: true });
  local
    .prepare(
      "UPDATE module_erp_policy SET version=version+1,config_json=json_set(config_json,'$.auto_post.finance',json('false')),updated_by='person' WHERE profile_id=?",
    )
    .run(profile);
  const saved = await ensureCommercialPolicy(env, profile);
  assert.equal(saved.version, policy.version + 1);
  assert.equal(saved.auto_post.finance, false);
  assert.equal(
    local
      .prepare("SELECT updated_by FROM module_erp_policy WHERE profile_id=?")
      .get(profile).updated_by,
    "person",
  );
  // Área local, sem trabalho pendente: custo básico e conciliação retomada
  // no religamento. Os cursores R2 estão vazios; não há chamada externa.
  env.MEDIA = {
    async get() {
      return null;
    },
    async put() {
      assert.fail("sem cursor a avançar");
    },
  };
  for (const module of [
    "queue",
    "forms",
    "payments",
    "agenda",
    "reserva",
    "pedido",
    "mensalidade",
    "suporte",
    "mesas",
  ])
    local
      .prepare(
        "INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,?,1,1) ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=1,updated=excluded.updated",
      )
      .run(profile, module);
  const reconcileSql = (sql) =>
    sql.includes(
      "SELECT c.* FROM mensalidade_contracts c JOIN module_erp_sources",
    );
  local
    .prepare(
      "UPDATE profile_modules SET enabled=0 WHERE profile_id=? AND module_id='erp'",
    )
    .run(profile);
  calls.length = 0;
  const off = await runModuleSchedules(env, profile, Date.now());
  assert.equal(off.length, 5);
  assert(off.every((outcome) => outcome.ok));
  assert(calls.length <= 24, JSON.stringify(calls));
  assert.equal(calls.filter(reconcileSql).length, 0);
  local
    .prepare(
      "UPDATE profile_modules SET enabled=1 WHERE profile_id=? AND module_id='erp'",
    )
    .run(profile);
  calls.length = 0;
  const on = await runModuleSchedules(env, profile, Date.now());
  assert(on.every((outcome) => outcome.ok));
  assert.equal(calls.filter(reconcileSql).length, 1);
});

test("A3/A4: SQL compacto da saída conserva CAS, rollback, sequência e propriedade do alias", async (t) => {
  const bundle = buildSync({
    entryPoints: [
      new URL("../../../src/integrations/outbox.ts", import.meta.url).pathname,
    ],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { integrationStatements, aliasStatements, findIntegrationEvent } =
    await import(
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
    );
  const f = fixture(t, "pedido"),
    { event } = f.enqueue({
      eligible: { document: false, stock: false, finance: false },
    });
  const local = new DatabaseSync(":memory:");
  t.after(() => local.close());
  local.exec(
    "CREATE TABLE os_orders(id TEXT); CREATE TABLE agenda_appointments(id TEXT); CREATE TABLE entrega_deliveries(id TEXT); CREATE TABLE profile_modules(profile_id TEXT,module_id TEXT,enabled INTEGER)",
  );
  local.exec(
    readFileSync(
      new URL(
        "../../../migrations/0135_module_erp_integration.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  local.exec(
    "CREATE TABLE operational(value INTEGER); INSERT INTO operational VALUES(0)",
  );
  const DB = {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => local.prepare(sql).get(...args) ?? null,
      }),
    }),
  };
  const apply = (statements) => {
    local.exec("BEGIN");
    try {
      for (const [sql, args] of statements) local.prepare(sql).all(...args);
      local.exec("COMMIT");
    } catch (error) {
      local.exec("ROLLBACK");
      throw error;
    }
  };
  const plan = (e, expected) =>
    integrationStatements({
      source: e.source,
      expected_revision: expected,
      events: [e],
      next_state: { snapshot: e.snapshot },
    });
  const state = () => ({
    ...local
      .prepare(
        "SELECT revision,enqueued_seq,applied_seq FROM module_erp_sources",
      )
      .get(),
  });
  const second = {
    ...event,
    id: randomUUID(),
    seq: 1,
    eligible: { document: true, stock: false, finance: false },
    source_revision: 2,
    command_id: commandId(event.source, 1),
    event_key: eventKey(event.source, event.operation, 2),
    snapshot: { ...event.snapshot, source_revision: 2 },
  };
  assert.throws(() => apply(plan(second, 1)), "não recria predecessor ausente");
  assert.equal(
    local.prepare("SELECT count(*) n FROM module_erp_sources").get().n,
    0,
  );
  const first = plan(event, 0);
  const alias = aliasStatements(event.source, "order", event.source.source_id);
  apply([...first, ...alias]);
  assert.deepEqual(state(), { revision: 1, enqueued_seq: 0, applied_seq: 0 });
  assert.equal(local.prepare("SELECT seq FROM module_erp_events").get().seq, null);
  apply(alias);
  assert.throws(() =>
    apply([["UPDATE operational SET value=1", []], ...first]),
  );
  assert.equal(local.prepare("SELECT value FROM operational").get().value, 0);
  assert.throws(() =>
    apply([
      ...plan(second, 1),
      ...aliasStatements(
        { ...event.source, component: "forged" },
        "order",
        event.source.source_id,
      ),
    ]),
  );
  assert.deepEqual(state(), { revision: 1, enqueued_seq: 0, applied_seq: 0 });
  const gap = { ...second, seq: 3, command_id: commandId(event.source, 3) };
  assert.throws(() => apply(plan(gap, 1)));
  assert.throws(() =>
    apply([...plan(second, 1), ["SELECT json('queda_depois_da_saida')", []]]),
  );
  assert.deepEqual(state(), { revision: 1, enqueued_seq: 0, applied_seq: 0 });
  apply(plan(second, 1));
  assert.deepEqual(state(), { revision: 2, enqueued_seq: 1, applied_seq: 0 });
  assert.deepEqual(
    await findIntegrationEvent(
      { DB },
      event.source.profile,
      second.event_key,
      second,
    ),
    second,
  );
  await assert.rejects(
    findIntegrationEvent({ DB }, event.source.profile, second.event_key, {
      ...second,
      occurred_ms: second.occurred_ms + 1,
    }),
  );
  assert.equal(
    local.prepare("SELECT count(*) n FROM module_erp_events").get().n,
    2,
  );
  assert.equal(
    local.prepare("SELECT count(*) n FROM module_erp_delivery").get().n,
    2,
  );
});

function fixture(t, module = "os") {
  const lite = freshLite(),
    db = nodeDriver(lite),
    local = new DatabaseSync(":memory:");
  t.after(() => {
    lite.close();
    local.close();
  });
  local.exec(
    "CREATE TABLE os_orders(id TEXT); CREATE TABLE agenda_appointments(id TEXT); CREATE TABLE entrega_deliveries(id TEXT); CREATE TABLE profile_modules(profile_id TEXT,module_id TEXT,enabled INTEGER)",
  );
  local.exec(
    readFileSync(
      new URL(
        "../../../migrations/0135_module_erp_integration.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const d1 = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => local.prepare(sql).get(...args) ?? null,
            all: async () => ({ results: local.prepare(sql).all(...args) }),
          };
        },
      };
    },
  };
  const source = {
    profile: "area-f3",
    module,
    source_id: randomUUID(),
    component: "main",
  };
  const actor = {
    ...human,
    user_id: moduleSystemUser(module),
    name: `Sistema · ${module}`,
    erp_role: "vendas",
    is_agent: true,
    verified_factor: false,
    session_id: null,
    aal: "aal1",
  };
  const identity = { actor, people: [actor, human] };
  const rpc = (name, args = {}, env = {}) =>
    callRpc(db, name, { p_user_id: ADMIN, ...args }, undefined, {
      identity: { actor: human, people: [actor, human] },
      ...env,
    });
  const catalog = (entity, data) =>
    rpc("erp_catalog_save", {
      p_entity: entity,
      p_id: null,
      p_expected_version: 0,
      p_command_id: randomUUID(),
      p_data: data,
    }).record;
  const contact = catalog("contacts", {
    name: "Cliente",
    person_type: "J",
    roles: ["customer", "supplier"],
  });
  const product = catalog("products", {
    name: "Material",
    unit: "UN",
    kind: "P",
    format: "S",
    price: "10",
  });
  const warehouse = catalog("warehouses", { name: "Depósito" });
  const category = rpc("erp_finance_category_execute", {
    p_command_id: randomUUID(),
    p_action: "category_create",
    p_data: { kind: "receivable", name: "Receita" },
  }).record;
  const account = rpc("erp_finance_account_execute", {
    p_command_id: randomUUID(),
    p_action: "account_create",
    p_data: {
      account_type: "cash",
      name: "Caixa",
      start_on: "2020-01-01",
      opening_cents: "0",
    },
  }).record;
  rpc("erp_stock_post", {
    p_command_id: randomUUID(),
    p_kind: "receipt",
    p_occurred_on: "2026-11-17",
    p_reason: "Saldo inicial de teste",
    p_reference: null,
    p_items: [
      {
        product_id: product.id,
        warehouse_id: warehouse.id,
        quantity: "100",
        expected_version: 0,
      },
    ],
  });
  const policy = {
    profile: source.profile,
    version: 1,
    auto_post: { stock: true, finance: true },
    warehouse_id: warehouse.id,
    revenue_category_id: category.id,
    payment_method_id: null,
    settlement_accounts: { cash: account.id },
    consumer_contact_id: null,
    installment_rule: "single_on_trigger",
  };
  const epochs = Object.fromEntries(
    [
      module,
      "erp",
      "erp-produtos",
      "erp-vendas",
      "erp-estoque",
      "erp-financeiro",
    ].map((id) => [id, 1]),
  );
  for (const id of Object.keys(epochs))
    local
      .prepare("INSERT INTO module_erp_activation VALUES(?,?,1,1,?,?,?)")
      .run(source.profile, id, at - 1000, at - 1000, at - 1000);
  local
    .prepare(
      "INSERT INTO module_erp_sources(profile_id,module_id,source_id) VALUES(?,?,?)",
    )
    .run(source.profile, module, source.source_id);
  let seq = 0,
    last = null;
  let snapshot = {
    schema: 1,
    source,
    source_revision: 1,
    contact_id: contact.id,
    customer_ref: null,
    privacy: "commercial",
    description: "Serviço contratado",
    issued_on: "2026-11-18",
    items: [
      {
        id: randomUUID(),
        description: "Material",
        quantity: "1",
        unit_cents: 1000,
        unit: "UN",
        kind: "material",
        product_id: product.id,
      },
    ],
    total_cents: 1000,
    freight_cents: 0,
    discount_cents: 0,
    installments: [
      {
        key: "main",
        due_on: "2026-11-18",
        amount_cents: 1000,
        payment_method_id: null,
      },
    ],
    policy_version: 1,
    lifecycle: {
      base_status: "in_progress",
      stage_id: null,
      quote_version: 1,
      authorization: "approved_quote",
      authorized_at: at - 100,
      first_execution_at: at,
      delivered_at: null,
      warranty_until: null,
    },
    technical: null,
  };
  function enqueue(options = {}) {
    seq++;
    const operation =
      options.operation ??
      (module === "os" || ["pedido", "mesas", "entrega"].includes(module)
        ? "execute"
        : "recognize");
    snapshot = {
      ...snapshot,
      ...options.snapshot,
      source_revision: seq,
      lifecycle: { ...snapshot.lifecycle, ...options.lifecycle },
    };
    const event = {
      id: randomUUID(),
      command_id: commandId(source, seq),
      event_key: eventKey(source, operation, seq),
      source,
      seq,
      source_revision: seq,
      operation,
      occurred_ms: at + seq,
      epochs,
      eligible: options.eligible ?? {
        document: true,
        stock: true,
        finance: true,
      },
      snapshot,
      receipt_key: options.receipt?.receipt.receipt_key ?? null,
      reverses_receipt_key: options.receipt?.receipt.reverses_key ?? null,
      reason_code: options.reason ?? null,
      actor_id: ADMIN,
    };
    const expected = Object.fromEntries(
      (last?.links ?? [])
        .filter((l) => l.version !== null)
        .map((l) => [
          `${l.kind === "stock_posting" ? "posting" : l.kind}:${l.id}`,
          l.version,
        ]),
    );
    const request = {
      schema: 1,
      command_id: event.command_id,
      actor_id: options.human ? options.human.user_id : actor.user_id,
      source,
      seq,
      event_hash: hash(event),
      expected,
      body: {
        operation,
        route:
          module === "os"
            ? "work"
            : ["pedido", "mesas", "entrega"].includes(module)
              ? "sale"
              : "title",
        snapshot,
        policy: options.policy ?? policy,
        eligible: event.eligible,
        requested: options.requested ?? {
          document: true,
          stock: true,
          finance: true,
        },
        epochs,
        occurred_ms: event.occurred_ms,
        receipt: options.receipt ?? null,
        reason_code: event.reason_code,
        mode: options.human ? "human" : "system",
      },
    };
    if (options.closeOnly)
      request.body = { mode: "system", operation, close_only: true };
    local
      .prepare("INSERT INTO module_erp_events VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        event.id,
        source.profile,
        module,
        source.source_id,
        seq,
        seq,
        event.command_id,
        event.event_key,
        event.occurred_ms,
        hash(event),
        canonical(event),
      );
    if (!options.localSkip)
      local
        .prepare("INSERT INTO module_erp_requests VALUES(?,?,?,?,?,?)")
        .run(
          event.id,
          request.actor_id,
          hash(request),
          canonical(expected),
          canonical(request.body),
          at,
        );
    const evidence = {
      profile: source.profile,
      module,
      source_id: source.source_id,
      seq,
      event_id: event.id,
      command_id: request.command_id,
      event_hash: request.event_hash,
      request_hash: hash(request),
      mode: options.human ? "human" : "system",
    };
    const envelope = {
      ...identity,
      actor: options.human ?? actor,
      people: [actor, human, ...(options.human ? [options.human] : [])],
      module_execution: evidence,
    };
    const args = {
      p_user_id: envelope.actor.user_id,
      p_request: request,
      p_evidence: evidence,
    };
    return { event, request, evidence, identity: envelope, args };
  }
  async function proof(
    input,
    name = input.request.body.mode === "human"
      ? "erp_module_manual_apply"
      : "erp_module_apply",
  ) {
    return verifyModuleTransport(
      d1,
      source.profile,
      name,
      input.args,
      input.identity,
    );
  }
  async function run(
    input,
    parts = {},
    name = input.request.body.mode === "human"
      ? "erp_module_manual_apply"
      : "erp_module_apply",
  ) {
    const moduleProof = await proof(input, name);
    const r = callRpc(db, name, input.args, undefined, {
      identity: input.identity,
      parts,
      gate: true,
      moduleProof,
    });
    if (name.endsWith("apply") || name.endsWith("close")) last = r;
    return r;
  }
  function payment(key, kind = "receive", reverses = null, amount = 1000) {
    const receipt = {
      profile_id: source.profile,
      receipt_key: key,
      owner_module: module,
      source_id: source.source_id,
      kind,
      evidence: "manual",
      reverses_key: reverses,
      amount_cents: amount,
      method: "cash",
      occurred_ms: at + 1000,
      actor_id: ADMIN,
      evidence_hash: hash([key, amount]),
    };
    local
      .prepare(
        `INSERT INTO module_commercial_receipts(${Object.keys(receipt).join()}) VALUES(${Object.keys(
          receipt,
        )
          .map(() => "?")
          .join()})`,
      )
      .run(...Object.values(receipt));
    local
      .prepare("INSERT INTO module_erp_allocations VALUES(?,?,?,?,?,?,?)")
      .run(
        source.profile,
        key,
        key + ":allocation",
        module,
        source.source_id,
        source.component,
        amount,
      );
    return { receipt, amount_cents: amount };
  }
  return {
    lite,
    db,
    local,
    d1,
    actor,
    identity,
    source,
    rpc,
    enqueue,
    run,
    proof,
    payment,
    contact,
    product,
    warehouse,
    category,
    account,
    policy,
    count: (table) => lite.prepare(`SELECT count(*) n FROM ${table}`).get().n,
  };
}

function endpoint(f) {
  const values = new Map();
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    transaction: async (fn) => fn(storage),
    transactionSync: (fn) => f.db.transaction(fn),
    sql: {
      exec(sql, ...params) {
        const result = f.db.exec(sql, ...params);
        return { ...result, toArray: () => result.rows };
      },
    },
  };
  const state = { storage };
  return (name, args, identity = { actor: human, people: [human] }) =>
    handleRpc(
      state,
      f.source.profile,
      name,
      new Request("https://erp.invalid/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [GATE_HEADER]: "1",
          [SYSTEM_HEADER]: "1",
          [IDENTITY_HEADER]: encodeIdentity({
            ...identity,
            parts: normalizeErpParts(),
            partsControl: {
              profile: f.source.profile,
              revision: "1",
              expires_at: Date.now() + 360_000,
            },
          }),
        },
        body: canonical(args),
      }),
      undefined,
      f.d1,
    );
}

async function http(f, input, name = "erp_module_apply", extra = {}) {
  const response = await endpoint(f)(
    name,
    { ...input.args, ...extra },
    input.identity,
  );
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

test("A4: salto local sem ERP exige evento inelegível concluído e ausência de pedido preparado", async (t) => {
  for (const mode of ["local", "eligible", "prepared", "remote"]) {
    const f = fixture(t);
    const first = f.enqueue({
      localSkip: mode !== "prepared",
      operation: "prepare",
      eligible: { document: false, stock: false, finance: mode === "eligible" },
    });
    const skipped = {
      command_id: first.event.command_id,
      seq: 1,
      replayed: false,
      outcome: "skipped",
      links: [],
      effects: { stock: "not_requested", finance: "not_requested" },
      reason_code: "part_disabled",
    };
    f.local
      .prepare(
        "INSERT INTO module_erp_delivery(event_id,state,next_attempt_ms,receipt_json) VALUES(?,'done',0,?)",
      )
      .run(first.event.id, canonical(skipped));
    if (mode === "remote") {
      // Cópias incompatíveis: o ERP possui uma evidência que o D1 chama de salto local.
      f.lite
        .prepare(
          "INSERT INTO erp_documents__command(command_id,actor,request_hash,result,created_at) VALUES(?,?,?,?,?)",
        )
        .run(
          first.event.command_id,
          f.actor.user_id,
          hash(first.request),
          canonical({ policy: "wabotia-module-origin-v1" }),
          String(at),
        );
    }
    const next = f.enqueue();
    if (mode === "local") {
      const result = await http(f, next);
      assert.equal(result.effects.finance, "posted");
      assert.deepEqual(await http(f, next), { ...result, replayed: true });
      assert.equal(f.count("erp_finance__title"), 1);
    } else {
      const response = await endpoint(f)(
        "erp_module_apply",
        next.args,
        next.identity,
      );
      assert.equal(response.status, 409);
      assert.equal((await response.json()).message, "module_sequence_conflict");
      assert.equal(f.count("erp_finance__title"), 0);
    }
  }
});

test("A3: migração 0135 sobre instalação em uso preserva cada coluna antiga e não reconhece passado", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const dir = new URL("../../../migrations/", import.meta.url);
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".sql") && n < "0135")
    .sort())
    db.exec(readFileSync(new URL(name, dir), "utf8"));
  db.exec(`INSERT INTO profiles(id,name,settings,enabled,created) VALUES('legacy','Área antiga','{}',1,1);
    INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES('legacy','os',1,1,'legacy'),('legacy','erp-financeiro',0,1,'legacy');
    INSERT INTO os_orders(id,profile_id,number,status,item,problem,source,created_by,created,updated,quote_items,quote_total_cents)
      VALUES('old-work','legacy',1,'ready','Equipamento','Diagnóstico privado','panel','legacy',1,2,'[{"description":"Reparo","quantity":1,"unit_cents":800}]',800);
    INSERT INTO agenda_appointments(id,profile_id,service_id,professional_id,starts,ends,source,service_name,price_cents,booked_at,created_by,created,updated)
      VALUES('old-appointment','legacy','service','professional',1000,2000,'panel','Serviço',700,1,'legacy',1,2);
    INSERT INTO entrega_deliveries(id,profile_id,source,source_key,label,status,created_by,created,updated)
      VALUES('old-delivery','legacy','manual','legacy-delivery','Entrega','delivered','legacy',1,2);`);
  const tables = [
    "os_orders",
    "agenda_appointments",
    "entrega_deliveries",
    "profile_modules",
  ];
  const before = new Map(
    tables.map((table) => [
      table,
      db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => ({ ...row })),
    ]),
  );
  const start = Date.now();
  db.exec("BEGIN");
  db.exec(
    readFileSync(new URL("0135_module_erp_integration.sql", dir), "utf8"),
  );
  db.exec("COMMIT");
  for (const table of tables) {
    const after = db.prepare(`SELECT * FROM ${table}`).all();
    assert.deepEqual(
      after.map(({ commercial_json, ...row }) => row),
      before.get(table),
    );
    if (table !== "profile_modules")
      assert.equal(after[0].commercial_json, "{}");
  }
  const enabled = db
    .prepare("SELECT * FROM module_erp_activation WHERE module_id='os'")
    .get();
  assert.equal(enabled.epoch, 1);
  assert.equal(enabled.enabled, 1);
  assert.ok(
    enabled.first_enabled_ms >= start - 2 &&
      enabled.first_enabled_ms <= Date.now(),
  );
  assert.equal(
    db
      .prepare(
        "SELECT enabled_since_ms FROM module_erp_activation WHERE module_id='erp-financeiro'",
      )
      .get().enabled_since_ms,
    null,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM module_erp_events").get().n,
    0,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM module_erp_sources").get().n,
    0,
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("Marco 1: sistema conclui assistência, recupera resposta perdida e conserva somente vendas", async (t) => {
  const f = fixture(t),
    execute = f.enqueue();
  const applied = await f.run(execute); // Commit remoto; nenhum recibo confirmado no D1.
  assert.deepEqual(await http(f, execute, "erp_module_origin_get"), {
    receipt: { ...applied, replayed: true },
  });
  assert.deepEqual(await http(f, execute), { ...applied, replayed: true });
  assert.equal(f.count("erp_finance__title"), 1);
  assert.equal(f.count("erp_stock__document_posting"), 1);
  await f.run(
    f.enqueue({ operation: "lifecycle", lifecycle: { base_status: "ready" } }),
  );
  await f.run(
    f.enqueue({
      operation: "lifecycle",
      lifecycle: { base_status: "in_progress" },
      reason: "work_resumed",
    }),
  );
  await f.run(
    f.enqueue({ operation: "lifecycle", lifecycle: { base_status: "ready" } }),
  );
  await f.run(
    f.enqueue({
      operation: "lifecycle",
      lifecycle: { base_status: "delivered", delivered_at: at + 2000 },
    }),
  );
  assert.equal(
    f.lite.prepare("SELECT status FROM erp_documents__document").get().status,
    "finalized",
  );
  assert.equal(f.count("erp_finance__settlement"), 0); // Entregar não confirma dinheiro.
  assert.equal(f.count("erp_finance__title"), 1);
  assert.equal(f.count("erp_stock__document_posting"), 1);
  assert.equal(
    f.lite
      .prepare("SELECT role FROM erp_access__membership WHERE user_id=?")
      .get(f.actor.user_id).role,
    "vendas",
  );
  for (const [name, args] of [
    ["erp_finance_title_page", { p_kind: "receivable" }],
    ["erp_finance_account_page", {}],
    ["erp_preferences_page", { p_page: "vendas-vendas" }],
  ]) {
    const response = await endpoint(f)(
      name,
      { p_user_id: f.actor.user_id, ...args },
      f.identity,
    );
    assert.ok([400, 403].includes(response.status), name); // HTTP legado, SQL 42501.
    assert.equal((await response.json()).code, "42501", name);
  }
});

for (const [milestone, module] of [
  [2, "pedido"],
  [2, "mesas"],
  [2, "mensalidade"],
  [3, "agenda"],
  [3, "reserva"],
  [3, "suporte"],
  [3, "entrega"],
]) {
  test(`Marco ${milestone}: ${module}, HTTP real, repetição e Financeiro desligado`, async (t) => {
    const f = fixture(t, module),
      input = f.enqueue({
        requested: { document: true, stock: false, finance: true },
      });
    const result = await http(f, input);
    assert.equal(result.effects.finance, "posted");
    assert.deepEqual(await http(f, input), { ...result, replayed: true });
    assert.equal(f.count("erp_finance__title"), 1);
    assert.equal(
      f.count("erp_documents__document"),
      ["pedido", "mesas", "entrega"].includes(module) ? 1 : 0,
    );
    const off = fixture(t, module),
      request = off.enqueue();
    const skipped = await off.run(request, { finance: false, stock: false });
    assert.equal(skipped.reason_code, "part_disabled");
    assert.equal(off.count("erp_finance__title"), 0);
    await off.run(request); // Religamento não reinterpreta recibo antigo.
    assert.equal(off.count("erp_finance__title"), 0);
  });
}

test("A4: desligamento em voo recupera commit; fechamento e aplicação disputam a mesma chave", async (t) => {
  for (const first of ["apply", "close"]) {
    const f = fixture(t),
      input = f.enqueue();
    const applied = first === "apply" ? await f.run(input) : null;
    f.local
      .prepare(
        "UPDATE module_erp_activation SET enabled=0,enabled_since_ms=NULL,epoch=epoch+1 WHERE module_id='erp-financeiro'",
      )
      .run();
    const read = await http(f, input, "erp_module_origin_get");
    assert.equal(read.receipt?.outcome ?? null, applied?.outcome ?? null);
    const closed = await http(f, input, "erp_module_command_close", {
      p_reason_code: "epoch_closed",
    });
    assert.equal(closed.outcome, first === "apply" ? "applied" : "closed");
    f.local
      .prepare(
        "UPDATE module_erp_activation SET enabled=1,enabled_since_ms=?,epoch=epoch+1 WHERE module_id='erp-financeiro'",
      )
      .run(at + 3000);
    const replay = await http(f, input);
    assert.equal(replay.outcome, closed.outcome);
    assert.equal(replay.replayed, true);
    assert.equal(f.count("erp_finance__title"), first === "apply" ? 1 : 0);
  }
});

test("A4/A7: venda sem Financeiro conserva recebimento como part_disabled, sem dívida retroativa", async (t) => {
  for (const module of ["pedido", "mesas", "entrega"]) {
    const f = fixture(t, module);
    const options = {
      eligible: { document: true, stock: false, finance: false },
      requested: { document: true, stock: false, finance: false },
    };
    const sale = f.enqueue(options);
    await f.run(sale, { finance: false });
    const receive = f.enqueue({
      ...options,
      operation: "receive",
      receipt: f.payment("local-payment"),
    });
    const result = await f.run(receive, { finance: false });
    assert.equal(result.effects.finance, "skipped");
    assert.equal(result.reason_code, "part_disabled");
    assert.equal(f.count("erp_documents__document"), 1);
    assert.equal(f.count("erp_finance__title"), 0);
    assert.equal(f.count("erp_finance__settlement"), 0);
    assert.deepEqual(await f.run(receive), { ...result, replayed: true });
    assert.equal(f.count("erp_finance__title"), 0);
    assert.equal(
      f.local.prepare("SELECT count(*) n FROM module_commercial_receipts").get()
        .n,
      1,
    );
  }
});

test("A5: origem/ator/alvo falsos e referência textual não concedem poder sobre terceiros", async (t) => {
  const f = fixture(t),
    own = f.enqueue(),
    result = await f.run(own);
  const title = result.links.find((link) => link.kind === "title").id;
  for (const change of [
    (x) => {
      x.args.p_evidence.profile = "outra-area";
    },
    (x) => {
      x.args.p_evidence.module = "pedido";
    },
    (x) => {
      x.args.p_evidence.source_id = randomUUID();
    },
    (x) => {
      x.args.p_request.actor_id = ADMIN;
    },
    (x) => {
      x.args.p_request.expected = { [`title:${randomUUID()}`]: 1 };
    },
    (x) => {
      x.identity.actor = {
        ...x.identity.actor,
        user_id: moduleSystemUser("pedido"),
      };
      x.args.p_user_id = x.identity.actor.user_id;
    },
  ]) {
    const attack = structuredClone(own);
    change(attack);
    const response = await endpoint(f)(
      "erp_module_apply",
      attack.args,
      attack.identity,
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).message, "module_origin_denied");
  }
  const generic = [
    [
      "erp_finance_execute",
      {
        p_action: "reverse",
        p_command_id: randomUUID(),
        p_data: { id: title, settlement_id: randomUUID() },
      },
    ],
    [
      "erp_finance_title_execute",
      {
        p_action: "title_create",
        p_command_id: randomUUID(),
        p_data: { kind: "payable", source_reference: f.source.source_id },
      },
    ],
    ["erp_finance_transfer_post", { p_command_id: randomUUID(), p_data: {} }],
    [
      "erp_finance_reconciliation_execute",
      { p_command_id: randomUUID(), p_action: "reconcile", p_data: {} },
    ],
    [
      "erp_preferences_save",
      { p_command_id: randomUUID(), p_page: "vendas-vendas", p_changes: {} },
    ],
    [
      "erp_document_stock_reverse",
      {
        p_command_id: randomUUID(),
        p_kind: "service_orders",
        p_document_id: result.links.find((l) => l.kind === "document").id,
        p_expected_version: 1,
        p_posting_id: result.links.find((l) => l.kind === "stock_posting").id,
        p_posting_version: 1,
        p_preview_hash: "forged",
        p_occurred_on: "2026-11-18",
        p_reason: "cancel",
      },
    ],
  ];
  for (const [name, args] of generic) {
    const response = await endpoint(f)(
      name,
      { p_user_id: f.actor.user_id, ...args },
      f.identity,
    );
    assert.ok([400, 403].includes(response.status), name);
    assert.equal((await response.json()).code, "42501", name);
  }
  assert.equal(f.count("erp_finance__title"), 1);
  assert.equal(f.count("erp_finance__settlement"), 0);
  assert.equal(
    f.lite.prepare("SELECT state FROM erp_stock__document_posting").get().state,
    "active",
  );
});

test("A5: lançamento manual financeiro não recebe Estoque nem escrita geral em trabalho", async (t) => {
  const f = fixture(t),
    finance = { ...human, user_id: randomUUID(), erp_role: "financeiro" };
  const input = f.enqueue({
    human: finance,
    requested: { document: true, stock: false, finance: true },
  });
  const result = await http(f, input, "erp_module_manual_apply");
  assert.equal(result.effects.finance, "posted");
  assert.equal(f.count("erp_stock__document_posting"), 0);
  assert.equal(
    f.lite
      .prepare("SELECT role FROM erp_access__membership WHERE user_id=?")
      .get(finance.user_id).role,
    "financeiro",
  );
  assert.throws(() =>
    callRpc(
      f.db,
      "erp_document_save",
      {
        p_user_id: finance.user_id,
        p_kind: "service_orders",
        p_id: result.links.find((l) => l.kind === "document").id,
        p_expected_version: 1,
        p_command_id: randomUUID(),
        p_data: {},
      },
      undefined,
      { identity: { actor: finance, people: [finance] }, gate: true },
    ),
  );
  const g = fixture(t),
    both = g.enqueue({ human: finance });
  const denied = await endpoint(g)(
    "erp_module_manual_apply",
    both.args,
    both.identity,
  );
  assert.equal(denied.status, 403);
  assert.equal(g.count("erp_finance__title"), 0);
  assert.equal(g.count("erp_documents__document"), 0);
});

test("A5: backup/restauração preserva todas as âncoras; ERP atrasado recusa sequência D1 adiantada", async (t) => {
  const f = fixture(t);
  const storage = {
    sql: {
      exec(sql, ...params) {
        const result = f.db.exec(sql, ...params);
        return {
          toArray: () => result.rows,
          raw: () => result.rows.map((row) => Object.values(row)),
        };
      },
    },
    transactionSync: (fn) => f.db.transaction(fn),
  };
  const empty = dumpAll(storage),
    input = f.enqueue(),
    applied = await f.run(input),
    dump = dumpAll(storage);
  const commands = () =>
    f.lite
      .prepare("SELECT * FROM erp_documents__command ORDER BY command_id")
      .all();
  const before = commands();
  restoreAll(
    storage,
    dump.manifest,
    new Map(dump.files.map((f) => [f.table, f.body])),
  );
  assert.deepEqual(commands(), before);
  assert.ok(originAnchor(f.db, f.source, "document"));
  assert.deepEqual(await http(f, input), { ...applied, replayed: true });
  const next = f.enqueue({
    operation: "lifecycle",
    lifecycle: { base_status: "ready" },
  });
  restoreAll(
    storage,
    empty.manifest,
    new Map(empty.files.map((f) => [f.table, f.body])),
  );
  const conflict = await endpoint(f)(
    "erp_module_apply",
    next.args,
    next.identity,
  );
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).message, "module_sequence_conflict");
  assert.equal(f.count("erp_documents__document"), 0);
  assert.equal(f.count("erp_finance__title"), 0);
});

test("A4/A7: SQL compacto mantém recibos imutáveis, limites de alocação e rollback integral", async (t) => {
  const bundle = buildSync({
    stdin: {
      contents:
        'export * from "./src/integrations/receipts.ts"; export * from "./src/integrations/payment-evidence.ts"; export {compactReceiptWrites} from "./src/integrations/outbox.ts";',
      resolveDir: new URL("../../../", import.meta.url).pathname,
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const {
    commercialReceiptStatements,
    allocationStatements,
    paymentEvidenceStatements,
    compactReceiptWrites,
  } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const local = new DatabaseSync(":memory:");
  t.after(() => local.close());
  const dir = new URL("../../../migrations/", import.meta.url);
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    local.exec(readFileSync(new URL(name, dir), "utf8"));
  local.exec(
    "CREATE TABLE operational(value INTEGER); INSERT INTO operational VALUES(0)",
  );
  const apply = (statements) => {
    local.exec("BEGIN");
    try {
      for (const [sql, args] of statements) {
        assert(args.length <= 100);
        local.prepare(sql).all(...args);
      }
      local.exec("COMMIT");
    } catch (error) {
      local.exec("ROLLBACK");
      throw error;
    }
  };
  const source = {
    profile: "area",
    module: "mesas",
    source_id: "conta",
    component: "order:pedido",
  };
  local
    .prepare(
      "INSERT INTO module_erp_sources(profile_id,module_id,source_id) VALUES(?,?,?)",
    )
    .run(source.profile, source.module, source.source_id);
  const receipt = {
    profile_id: "area",
    receipt_key: "recebimento",
    owner_module: "mesas",
    source_id: "conta",
    kind: "receive",
    evidence: "manual",
    reverses_key: null,
    amount_cents: 1000,
    method: "cash",
    occurred_ms: at,
    actor_id: ADMIN,
    evidence_hash: hash("recebimento"),
  };
  apply(commercialReceiptStatements(receipt));
  apply(commercialReceiptStatements(receipt));
  for (const changed of [
    { amount_cents: 1001 },
    { actor_id: "outra-pessoa" },
    { source_id: "outra-conta" },
    { occurred_ms: at + 1 },
    { method: "pix" },
    { evidence_hash: hash("outro") },
  ]) {
    assert.throws(() =>
      apply([
        ["UPDATE operational SET value=1", []],
        ...commercialReceiptStatements({ ...receipt, ...changed }),
      ]),
    );
    assert.equal(local.prepare("SELECT value FROM operational").get().value, 0);
  }
  apply(allocationStatements(source, receipt.receipt_key, "a", 600));
  apply(allocationStatements(source, receipt.receipt_key, "a", 600));
  for (const statements of [
    allocationStatements(source, receipt.receipt_key, "b", 401),
    allocationStatements(
      { ...source, source_id: "outra" },
      receipt.receipt_key,
      "a",
      600,
    ),
    allocationStatements(source, "ausente", "x", 1),
  ])
    assert.throws(() =>
      apply([["UPDATE operational SET value=1", []], ...statements]),
    );
  assert.equal(local.prepare("SELECT value FROM operational").get().value, 0);
  apply(
    allocationStatements(
      { ...source, component: "service:1" },
      receipt.receipt_key,
      "b",
      400,
    ),
  );
  assert.equal(
    local
      .prepare("SELECT sum(amount_cents) n FROM module_erp_allocations")
      .get().n,
    1000,
  );
  const reverse = {
    ...receipt,
    receipt_key: "estorno",
    kind: "reverse",
    reverses_key: receipt.receipt_key,
  };
  assert.throws(() =>
    apply(commercialReceiptStatements({ ...reverse, source_id: "outra" })),
  );
  assert.throws(() =>
    apply(commercialReceiptStatements({ ...reverse, reverses_key: "ausente" })),
  );
  apply(commercialReceiptStatements(reverse));
  apply(commercialReceiptStatements(reverse));
  assert.equal(
    local.prepare("SELECT count(*) n FROM module_commercial_receipts").get().n,
    2,
  );
  const evidence = {
    schema: 1,
    evidence: "provider",
    event_key: "payment.evidence:provider:1",
    receipt_key: "provider:1",
    kind: "receive",
    reverses_key: null,
    profile_id: "area",
    provider: "mercadopago",
    account_id: "conta-provedor",
    provider_payment_id: "1",
    payment_id: "pagamento",
    module_id: "pedido",
    ref_id: "pedido",
    amount_cents: 1000,
    currency: "BRL",
    method: "unknown",
    occurred_ms: at,
    time_source: "observed",
    observed_ms: at,
    evidence_hash: hash("fato"),
    original: null,
  };
  assert.throws(() =>
    apply([
      ["UPDATE operational SET value=2 WHERE value=999", []],
      ...paymentEvidenceStatements(evidence, true),
    ]),
  );
  assert.equal(
    local
      .prepare("SELECT count(*) n FROM events WHERE kind='payment.evidence'")
      .get().n,
    0,
  );
  apply([
    ["UPDATE operational SET value=2", []],
    ...paymentEvidenceStatements(evidence, true),
  ]);
  apply(paymentEvidenceStatements(evidence));
  assert.throws(() =>
    apply([
      ["UPDATE operational SET value=3", []],
      ...paymentEvidenceStatements({ ...evidence, amount_cents: 1001 }),
    ]),
  );
  assert.equal(local.prepare("SELECT value FROM operational").get().value, 2);
  const writes = Array.from({ length: 31 }, (_, i) => [
    "INSERT INTO receipts(scope,key,fingerprint,response,status,created) VALUES(?,?,?,?,200,?)",
    ["componentes", String(i), hash(i), canonical({ i }), at],
  ]);
  apply(compactReceiptWrites(writes));
  assert.equal(local.prepare("SELECT count(*) n FROM receipts").get().n, 31);
  assert.throws(() =>
    apply(
      compactReceiptWrites([["UPDATE operational SET value=3", []], ...writes]),
    ),
  );
  assert.equal(local.prepare("SELECT value FROM operational").get().value, 2);
});

// Runtime local: SQL e funções de produção reais; KV/alarmes e provedor sintéticos.
// Não substitui a medição externa no runtime Cloudflare.
test("A4/A7: custos locais, privacidade legada, cortes e repetição de comércio sem rede", async (t) => {
  const root = new URL("../../../", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const bundle = await build({
    stdin: {
      contents: `export {default as worker,Coordinator} from './src/index.ts'; export {perform,inbound,conversation} from './src/service.ts'; export {processInbox} from './src/engine.ts'; export {completeWebStep} from './src/web-steps.ts'; export {refreshFromProvider} from './src/payments.ts'; export {runModuleSchedules} from './src/modules/schedule.ts'; export {defaults,uid,now} from './src/types.ts'; export {visibleEvent} from './src/visibility.ts';`,
      resolveDir: root,
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [
      {
        name: "offline-runtime",
        setup(b) {
          b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "runtime",
            namespace: "offline",
          }));
          b.onLoad({ filter: /.*/, namespace: "offline" }, () => ({
            contents:
              "export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }",
          }));
        },
      },
    ],
  });
  const {
    worker,
    Coordinator,
    perform,
    inbound,
    conversation,
    processInbox,
    completeWebStep,
    refreshFromProvider,
    runModuleSchedules,
    defaults,
    uid,
    now,
    visibleEvent,
  } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  let failBatch = null;
  for (const f of readdirSync(root + "/migrations")
    .filter((x) => x.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(root + "/migrations/" + f, "utf8"));
  let queries = [];
  const prepare = (sql, args = []) => ({
    sql,
    bind(...args) {
      assert(args.length <= 100);
      return prepare(sql, args);
    },
    async all() {
      queries.push(sql.replace(/\s+/g, " "));
      const results = db.prepare(sql).all(...args);
      return {
        results,
        success: true,
        meta: {
          changes: db.prepare("SELECT changes() n").get().n,
          last_row_id: db.prepare("SELECT last_insert_rowid() n").get().n,
        },
      };
    },
    async first(key) {
      const r = (await this.all()).results[0];
      return key ? (r?.[key] ?? null) : (r ?? null);
    },
    async run() {
      return this.all();
    },
    async raw() {
      return (await this.all()).results.map(Object.values);
    },
  });
  const pending = [];
  const instances = new Map();
  const env = {
    MASTER_KEY: "offline-test-key-000000000000000000000000",
    DB: {
      prepare,
      async batch(statements) {
        const failure = statements.some((s) =>
          s.sql.includes("INSERT INTO module_erp_sources"),
        )
          ? failBatch
          : null;
        if (failure) failBatch = null;
        db.exec("BEGIN");
        const out = [];
        try {
          for (const s of statements) out.push(await s.all());
          if (failure && !failure.afterCommit)
            db.exec("SELECT json('interrupcao_simulada')");
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        if (failure?.afterCommit) throw Error("offline_ack_lost");
        return out;
      },
    },
    MEDIA: {
      async get() {
        return null;
      },
      async put() {},
      async delete() {},
      async list() {
        return { objects: [], truncated: false };
      },
    },
    COORDINATOR: {
      idFromName: (name) => name,
      get(name) {
        if (!instances.has(name)) {
          const map = new Map();
          const ctx = {
            id: { name },
            storage: {
              async get(k) {
                return map.get(k);
              },
              async put(k, v) {
                if (typeof k === "object")
                  for (const [a, b] of Object.entries(k)) map.set(a, b);
                else map.set(k, v);
              },
              async delete(k) {
                return map.delete(k);
              },
              async getAlarm() {
                return map.get("alarm");
              },
              async setAlarm(v) {
                map.set("alarm", v);
              },
              async deleteAlarm() {
                map.delete("alarm");
              },
            },
            getWebSockets() {
              return [];
            },
            waitUntil(p) {
              pending.push(p);
            },
            async blockConcurrencyWhile(fn) {
              return fn();
            },
          };
          instances.set(name, new Coordinator(ctx, env));
        }
        const i = instances.get(name);
        return {
          fetch: (r, init) =>
            i.fetch(r instanceof Request ? r : new Request(r, init)),
        };
      },
    },
  };
  const remote = new Map();
  let remoteId = 700000;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    assert.equal(
      url.origin,
      "https://api.mercadopago.com",
      "rede externa proibida",
    );
    const body = init.body ? JSON.parse(init.body) : null;
    const reply = (x, status = 200) => Response.json(x, { status });
    if (init.method === "POST" && url.pathname === "/v1/payments") {
      const id = String(++remoteId);
      remote.set(id, {
        status: "pending",
        amount: body.transaction_amount,
        ref: body.external_reference,
      });
      return reply(
        {
          id: Number(id),
          status: "pending",
          status_detail: "pending_waiting_transfer",
          point_of_interaction: {
            transaction_data: {
              qr_code: "00020126PIX" + id,
              qr_code_base64: "iVBORw0KGgo=",
              ticket_url:
                "https://www.mercadopago.com.br/payments/" + id + "/ticket",
            },
          },
        },
        201,
      );
    }
    const m = /^\/v1\/payments\/(\d+)$/.exec(url.pathname);
    if (m) {
      const r = remote.get(m[1]);
      return reply({
        id: Number(m[1]),
        status: r.status,
        status_detail: "",
        transaction_amount: r.amount,
        currency_id: "BRL",
        external_reference: r.ref,
        date_approved:
          r.status === "approved" ? "2026-11-15T19:00:00.000-03:00" : null,
      });
    }
    throw Error("unexpected mock " + url);
  };
  const sql = (s, ...args) => db.prepare(s).run(...args),
    one = (s, ...args) => db.prepare(s).get(...args);
  const profile = uid(),
    line = uid(),
    second = uid(),
    qr = uid(),
    admin = {
      id: uid(),
      name: "Admin",
      kind: "user",
      role: "admin",
      profiles: [profile],
      scopes: [],
      bots: [],
      rate: 100,
      runLimit: 10,
    },
    member = {
      ...admin,
      id: uid(),
      name: "Pessoa",
      role: "operator",
      access: ["*", "mesas:waiter"],
    };
  sql(
    "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,?,?,1,?)",
    profile,
    "Atendimento",
    JSON.stringify(defaults),
    now(),
  );
  for (const [i, id] of [line, second, qr].entries())
    sql(
      "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,?,'direct','active',?,?)",
      id,
      profile,
      id,
      id === qr ? "qr" : "zernio",
      JSON.stringify({ number: "5511900002222" }),
      now() + i,
    );
  for (const a of [admin, member])
    sql(
      "INSERT INTO users(id,email,name,password,role,profiles,access,created) VALUES(?,?,?,?,?,?,?,?)",
      a.id,
      a.id + "@example.test",
      a.name,
      "test",
      a.role,
      JSON.stringify(a.profiles),
      JSON.stringify(a.access ?? ["*"]),
      now(),
    );
  sql(
    "INSERT INTO instance_settings(key,value,updated) VALUES('public_origin','https://lanchonete.example.com',?)",
    now(),
  );
  const run = (op, data, actor = admin) =>
    perform(env, actor, profile, op, data, uid());
  for (const id of [
    "queue",
    "forms",
    "payments",
    "agenda",
    "os",
    "reserva",
    "pedido",
    "mensalidade",
    "suporte",
    "mesas",
  ])
    await run("module.set", { id, enabled: true });
  await run("settings", {
    menus: [
      { id: "cardapio", label: "Cardápio", type: "pedido_cardapio" },
      { id: "agendar", label: "Agendar", type: "agenda" },
      { id: "reservar", label: "Reservar", type: "reserva" },
      { id: "ordem", label: "Minha ordem", type: "os_track" },
      { id: "segunda", label: "Segunda via", type: "mensalidade_copy" },
      { id: "humano", label: "Atendente", type: "human" },
    ],
    pedido: { payments: { pix: true, cash: true, card: false } },
  });
  const account = await run("payment.account.save", {
    provider: "mercadopago",
    access_token: "APP_USR-token-de-teste",
    webhook_secret: "segredo-do-webhook-de-teste",
    payer_email: "pagamentos@example.com",
  });
  const cat = await run("pedido.category.save", { name: "Bebidas" });
  const suco = await run("pedido.item.save", {
    category_id: cat.id,
    name: "Suco de laranja",
    price_cents: 800,
    max_quantity: 5,
    retailer_id: "SUCO-500",
  });
  const ceilings = {
    inbound: 20,
    motor: 30,
    menu: 43,
    suporte: 37,
    carrinho: 59,
    "webhook Coordinator": 30,
    schedule: 24,
    "fila emitir": 17,
    "fila chamar": 18,
    "mesas enviar": 27,
    "mesas fechar": 21,
    alarme: 71,
  };
  const reports = {};
  const measure = async (name, fn) => {
    queries = [];
    const result = await fn();
    await Promise.all(pending.splice(0));
    reports[name] = [...queries];
    assert(
      queries.length <= ceilings[name],
      `${name}: ${queries.length}/${ceilings[name]}\n${queries.join("\n")}`,
    );
    return result;
  };
  const send = (text, phone = "5511979990001") =>
    inbound(
      env,
      profile,
      { external_id: phone, phone, message_id: uid(), text },
      "channel:" + line,
      line,
    );
  await measure("inbound", () => send("oi"));
  await measure("motor", () => processInbox(env, profile));
  await send("1");
  await measure("menu", () => processInbox(env, profile));
  await send("quero falar com um atendente");
  await measure("suporte", () => processInbox(env, profile));
  const c2 = await send("oi", "5511979990002");
  await processInbox(env, profile);
  await send("1", "5511979990002");
  await processInbox(env, profile);
  const step = one(
    "SELECT id FROM web_steps WHERE conversation_id=? AND status='sent' ORDER BY created DESC LIMIT 1",
    c2.conversation_id,
  );
  await measure("carrinho", () =>
    completeWebStep(env, step.id, {
      ["q_" + suco.id]: ["3"],
      fulfillment: ["pickup"],
      name: ["Lia"],
      payment: ["pix"],
      confirm: ["1"],
    }),
  );
  const order = one(
    "SELECT p.provider_ref FROM pedido_orders o JOIN payments p ON p.id=o.payment_id WHERE o.conversation_id=?",
    c2.conversation_id,
  );
  remote.get(order.provider_ref).status = "approved";
  await measure("webhook Coordinator", () =>
    refreshFromProvider(env, account.id, order.provider_ref),
  );
  await measure("schedule", () => runModuleSchedules(env, profile, now()));
  const queue = await run("queue.save", { name: "Geral", service_minutes: 10 }),
    counter = await run("counter.save", {
      name: "Guichê 1",
      queue_ids: [queue.id],
    });
  await run("counter.state", { id: counter.id, status: "open" }, member);
  const command = async (op, data, actor = admin, key = uid()) => {
    const r = await env.COORDINATOR.get(profile).fetch(
      "https://coordinator/command",
      {
        method: "POST",
        body: JSON.stringify({
          profile,
          actor,
          operation: op,
          data,
          key,
          requestId: uid(),
        }),
      },
    );
    if (!r.ok) throw Error(r.status + " " + (await r.text()));
    return r.json();
  };
  await measure("fila emitir", () =>
    command("queue.issue", { queue_id: queue.id, preferential: false }),
  );
  await measure("fila chamar", () =>
    command("queue.call_next", { id: counter.id }, member),
  );
  const [mesa] = (await run("mesas.table.create", { name: "Mesa 1" })).data;
  const tab = await run("mesas.tab.open", { table_id: mesa.id }, member);
  await measure("mesas enviar", () =>
    command(
      "mesas.order.send",
      { id: tab.id, items: [{ item_id: suco.id, quantity: 2 }] },
      member,
    ),
  );
  const closeKey = uid(),
    closeOperation = uid(),
    closeInput = {
      id: tab.id,
      payments: [{ method: "card", amount_cents: 1760 }],
    };
  const closed = await measure("mesas fechar", () =>
    command("mesas.tab.close", closeInput, member, closeKey),
  );
  await send("2");
  await measure("alarme", () => instances.get(profile).alarm());
  console.info(
    "F3-D1-SQLITE",
    JSON.stringify(
      Object.fromEntries(
        Object.entries(reports).map(([name, sql]) => [name, sql.length]),
      ),
    ),
  );
  const event = {
    kind: "reserva.created",
    resource_id: uid(),
    profile_id: profile,
    payload: JSON.stringify({
      module_id: "reserva",
      conversation_id: c2.conversation_id,
      notes: "hóspede caloteiro",
    }),
  };
  const a = {
    ...admin,
    id: "application",
    kind: "app",
    scopes: ["conversations:read", "events:read", "contacts:read"],
  };
  assert.equal(await visibleEvent(env, a, event), false);
  assert.equal(
    await visibleEvent(
      env,
      { ...a, scopes: [...a.scopes, "notes:read"] },
      event,
    ),
    true,
  );

  assert.equal(
    one("SELECT count(*) n FROM module_erp_events").n,
    0,
    "com Base desligada não há evento elegível",
  );
  const counts = () => ({
    orders: one("SELECT count(*) n FROM pedido_orders").n,
    receipts: one("SELECT count(*) n FROM module_commercial_receipts").n,
    allocations: one("SELECT count(*) n FROM module_erp_allocations").n,
    sources: one("SELECT count(*) n FROM module_erp_sources").n,
    snapshots: one(
      "SELECT count(*) n FROM receipts WHERE scope LIKE 'f3-sale:%'",
    ).n,
  });
  const stable = counts();
  await refreshFromProvider(env, account.id, order.provider_ref);
  assert.deepEqual(
    counts(),
    stable,
    "webhook repetido preserva todas as contagens comerciais",
  );
  assert.equal(
    one(
      "SELECT hook_pending FROM payments WHERE provider_ref=?",
      order.provider_ref,
    ).hook_pending,
    null,
  );
  assert.equal(
    one(
      "SELECT sum(amount_cents) n FROM module_erp_allocations WHERE module_id='mesas'",
    ).n,
    1760,
  );
  assert.deepEqual(
    await command("mesas.tab.close", closeInput, member, closeKey),
    closed,
    "recibo externo repete a resposta exata",
  );
  assert.deepEqual(counts(), stable);
  await assert.rejects(
    perform(
      env,
      member,
      profile,
      "mesas.tab.close",
      { ...closeInput, payments: [] },
      closeOperation,
    ),
    (error) => error.code === "tab_closed",
  );
  // Depois do corte, novos pedidos produzem seus eventos no mesmo lote.
  const enabledAt = now() - 1;
  sql(
    "INSERT INTO profile_erp_revision(profile_id,revision,delivered_revision) VALUES(?,1,1)",
    profile,
  );
  for (const id of [
    "erp",
    "erp-vendas",
    "erp-produtos",
    "erp-estoque",
    "erp-financeiro",
  ]) {
    sql(
      "INSERT INTO profile_modules(profile_id,module_id,enabled,updated) VALUES(?,?,1,?) ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=1,updated=excluded.updated",
      profile,
      id,
      enabledAt,
    );
    sql(
      "UPDATE module_erp_activation SET enabled=1,epoch=epoch+1,first_enabled_ms=coalesce(first_enabled_ms,?),enabled_since_ms=?,updated_ms=? WHERE profile_id=? AND module_id=?",
      enabledAt,
      enabledAt,
      enabledAt,
      profile,
      id,
    );
  }
  const [secondTable] = (await run("mesas.table.create", { name: "Mesa 2" }))
    .data;
  const secondTab = await run(
    "mesas.tab.open",
    { table_id: secondTable.id },
    member,
  );
  const input = {
    id: secondTab.id,
    items: [{ item_id: suco.id, quantity: 1 }],
  };
  const beforeFailure = counts();
  failBatch = { afterCommit: false };
  const firstKey = uid();
  await assert.rejects(
    perform(env, member, profile, "mesas.order.send", input, firstKey),
  );
  assert.deepEqual(
    counts(),
    beforeFailure,
    "queda no lote desfaz pedido, fotografia e eventos",
  );
  const sent = await perform(
    env,
    member,
    profile,
    "mesas.order.send",
    input,
    firstKey,
  );
  const committed = counts();
  assert.equal(
    (await perform(env, member, profile, "mesas.order.send", input, firstKey))
      .order.id,
    sent.order.id,
  );
  assert.deepEqual(counts(), committed);
  const events = db
    .prepare(
      "SELECT payload_json FROM module_erp_events WHERE module_id='mesas' ORDER BY seq",
    )
    .all()
    .map((row) => JSON.parse(row.payload_json));
  assert.deepEqual(
    events.map((e) => e.operation),
    ["prepare", "execute", "prepare", "execute"],
  );
  assert(events.every((e) => e.eligible.document && e.eligible.finance));
  const lostKey = uid();
  failBatch = { afterCommit: true };
  await assert.rejects(
    perform(env, member, profile, "mesas.order.send", input, lostKey),
    /offline_ack_lost/,
  );
  const afterLost = counts();
  assert.equal(afterLost.orders, committed.orders + 1);
  await perform(env, member, profile, "mesas.order.send", input, lostKey);
  assert.deepEqual(counts(), afterLost, "perda do recibo não cria outra venda");
  assert.equal(one("SELECT count(*) n FROM module_erp_events").n, 8);
});
