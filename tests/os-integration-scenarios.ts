import assert from "node:assert/strict";
import { all, exec, one, withReadCache } from "../src/db";
import { json, now, uid, type Actor } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { scheduledModules } from "../src/modules/hooks";
import { runExtensionsDue } from "../src/modules/os/extension-runtime";
import { runModuleSchedules } from "../src/modules/schedule";
import { authorizedOrder, commitChild } from "../src/modules/os/public";
import { fullCatalog } from "../src/bot-actions/catalog";
import { createWorkApi } from "../web/modules/os/work-api";
import { motorWorkType, MOTOR_SENTINEL } from "./os-motor-fixture";
import { measure } from "./d1-counter";
import {
  applyRegisteredTemplate,
  customerConversation,
  grantSensitive,
  integrationFixture,
  messages,
  type IntegrationHarness,
} from "./os-integration-fixture";

export async function integratedWork(h: IntegrationHarness) {
  const f = await applyRegisteredTemplate(h, "assistencia_tecnica");
  const catalog = await f.call(
    "/service-orders/types",
    "GET",
    undefined,
    uid(),
    200,
    "catálogo",
  );
  const type = motorWorkType();
  type.stages.find((s) => s.id === "execucao")!.message =
    "{identificador}: {etapa} — {campo_referencia}";
  type.stages.find((s) => s.id === "revisao")!.message =
    "{identificador}: etapa {etapa}";
  type.transitions = type.transitions.map((t) =>
    t.id === "revisar"
      ? {
          ...t,
          kind: "customer_approval",
          valid_hours: 24,
          request_text: "Autoriza {identificador} para revisão?",
        }
      : t,
  );
  const settings = json(
    (await one(h.env, "SELECT settings FROM profiles WHERE id=?", f.profile))!
      .settings,
  );
  await f.call("/settings", "PUT", {
    os_work_types: [...settings.os_work_types, type],
    settings_revision: catalog.settings_revision,
  });
  const conversation = await customerConversation(h, f);
  const create = {
    conversation_id: conversation,
    type_id: type.id,
    item: "Projeto de integração",
    problem: "Conferir entrega",
    extra: { referencia: "PUBLICO-I" },
    notify: false,
  };
  const createKey = uid();
  let order = await f.call(
    "/service-orders",
    "POST",
    create,
    createKey,
    200,
    "criação de ordem",
  );
  const id = order.id,
    path = `/service-orders/${id}`;
  assert.equal(order.status, "received");
  assert.equal(order.stage, "entrada");
  assert.equal(order.number, 1);
  assert.equal(order.type_number, 1);
  assert.equal(order.display_number, "PROJ-1");
  assert.deepEqual(
    await f.call(
      "/service-orders",
      "POST",
      create,
      createKey,
      200,
      "repetição de criação",
    ),
    order,
  );
  const builtin = await f.call("/service-orders", "POST", {
    phone: "5511960099999",
    item: "Equipamento",
    problem: "Conferir",
    notify: false,
  });
  assert.equal(builtin.type_id, "service_order");
  assert.equal(builtin.number, 2);
  assert.equal(builtin.status, "received");
  assert.equal(builtin.status_label, "Recebida");
  assert.deepEqual(builtin.extra, {});
  assert.equal(builtin.stage, "received");
  assert.equal(
    (
      await f.call(
        `/service-orders/${builtin.id}/tasks`,
        "GET",
        undefined,
        uid(),
        409,
      )
    ).error.code,
    "feature_disabled",
  );
  await grantSensitive(h, f);
  assert(
    (await f.call("/grants")).data.some((g: any) => g.id === "os:sensitive"),
  );
  const privateResult = await f.call(path + "/private-fields", "PATCH", {
    version: order.version,
    extra: { segredo: MOTOR_SENTINEL },
  });
  assert(!JSON.stringify(privateResult).includes(MOTOR_SENTINEL));
  order = await f.call(path + "?history=none");
  assert(!JSON.stringify(order).includes(MOTOR_SENTINEL));
  assert(
    order.fields.some(
      (field: any) => field.id === "segredo" && field.sensitive,
    ),
  );
  assert.equal(
    (await f.call(path + "/private-fields")).extra.segredo,
    MOTOR_SENTINEL,
  );
  const stageBody = { transition_id: "iniciar", version: order.version },
    stageKey = uid();
  order = await f.call(
    path + "/stage",
    "POST",
    stageBody,
    stageKey,
    200,
    "etapa",
  );
  assert.equal(order.status, "in_progress");
  assert.equal(order.stage, "execucao");
  assert.equal(order.next_statuses.includes("in_progress"), false);
  assert.deepEqual(
    await f.call(
      path + "/stage",
      "POST",
      stageBody,
      stageKey,
      200,
      "repetição de etapa",
    ),
    order,
  );
  assert.equal(
    (
      await f.call(
        path + "/stage",
        "POST",
        stageBody,
        uid(),
        409,
        "conflito de etapa",
      )
    ).error.code,
    "version_conflict",
  );
  assert.equal(
    (await messages(h, f)).filter((m) =>
      JSON.stringify(m.payload).includes("PUBLICO-I"),
    ).length,
    1,
  );
  order = await f.call(
    path + "/stage-approval",
    "POST",
    { transition_id: "revisar", version: order.version },
    uid(),
    200,
    "pedido de aprovação",
  );
  order = await f.call(
    path + "/stage-approval/decision",
    "POST",
    {
      decision: "approve",
      approval_version: order.stage_approval.version,
      version: order.version,
    },
    uid(),
    200,
    "decisão de aprovação",
  );
  assert.equal(order.stage, "revisao");
  assert.equal(order.status, "in_progress");
  const parentVersion = order.version;
  const task = await f.call(
    path + "/tasks",
    "POST",
    {
      id: "ignorar-corpo",
      profile: "ignorar-area",
      title: "Conferir prazo",
      audience: "customer",
      due_at: now() + 60000,
      remind_at: now() - 1,
      client_visible: true,
      sensitive: false,
    },
    uid(),
    200,
    "escrita de tarefa",
  );
  assert.equal(task.order_id, id);
  await f.call(path + "/private-tasks", "POST", {
    title: MOTOR_SENTINEL,
    audience: "staff",
    client_visible: false,
    sensitive: true,
  });
  await f.call(path + "/people", "POST", {
    role: "restrito",
    name: MOTOR_SENTINEL + "_PESSOA",
    client_visible: false,
    sensitive: true,
  });
  const restricted = await f.call(path + "/private-documents", "POST", {
    name: MOTOR_SENTINEL + "_DOCUMENTO.txt",
    mime_type: "text/plain",
    expected_bytes: 1,
    client_visible: false,
    sensitive: true,
  });
  assert.equal(
    (
      await f.call(
        path + `/documents/${restricted.id}/content`,
        "GET",
        undefined,
        uid(),
        404,
      )
    ).error.code,
    "not_found",
  );
  assert.equal(
    (
      await f.call(
        path + `/documents/${restricted.id}/send`,
        "POST",
        { version: 1 },
        uid(),
        403,
      )
    ).error.code,
    "document_not_shareable",
  );
  await f.call(path + "/tasks", "POST", {
    title: "Prazo da equipe",
    assignee: f.actor.id,
    audience: "staff",
    due_at: now() - 1000,
    client_visible: false,
    sensitive: false,
  });
  const mine = await f.call(
    "/service-orders/my-tasks?assignee=me&period=overdue&state=open",
    "GET",
    undefined,
    uid(),
    200,
    "meus prazos",
  );
  assert.equal(mine.data.length, 1);
  assert.equal(mine.data[0].display_number, "PROJ-1");
  assert.equal(mine.data[0].stage_label, "Revisão");
  const linked = await f.call(
    path + "/people",
    "POST",
    {
      role: "responsavel",
      name: "Pessoa ligada",
      phone: "5511960088888",
      client_visible: false,
      sensitive: false,
    },
    uid(),
    200,
    "escrita de pessoa",
  );
  assert.equal(linked.version, 1);
  const outsider = await customerConversation(h, f, "5511960088888");
  assert.equal(
    (
      await f.call(
        `/service-orders/conversation/${outsider}/orders/${id}`,
        "GET",
        undefined,
        uid(),
        404,
      )
    ).error.code,
    "not_found",
  );
  const bytes = new TextEncoder().encode("Documento público I");
  const document = await f.call(
    path + "/documents",
    "POST",
    {
      name: "entrega.txt",
      mime_type: "text/plain",
      expected_bytes: bytes.length,
      client_visible: true,
      sensitive: false,
    },
    uid(),
    200,
    "reserva de documento",
  );
  const contentPath = path + `/documents/${document.id}/content`;
  assert.equal(
    (await f.call(contentPath, "GET", undefined, uid(), 409)).error.code,
    "document_not_ready",
  );
  const uploadKey = uid();
  const uploadRequest = () =>
    new Request(`https://test${f.root}${contentPath}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${f.token}`,
        "Content-Type": "text/plain",
        "Idempotency-Key": uploadKey,
        "Upload-Version": "1",
      },
      body: bytes,
    });
  const uploaded = await h.fetch(uploadRequest(), "upload de documento");
  assert.equal(uploaded.status, 200, await uploaded.clone().text());
  const transport: any = await uploaded.json();
  const uploadReceipts = await all(
    h.env,
    "SELECT response FROM receipts WHERE key=? AND scope IN (?,?)",
    uploadKey,
    `${f.actor.id}:${f.profile}:os.document.upload.begin`,
    `${f.actor.id}:${f.profile}:os.document.upload.record`,
  );
  assert.equal(uploadReceipts.length, 2);
  assert(
    uploadReceipts.every((receipt) => typeof receipt.response === "string"),
  );
  const replay = await h.fetch(uploadRequest(), "repetição de upload");
  assert.deepEqual(await replay.json(), transport);
  assert.equal(transport.byte_length, bytes.length);
  assert.match(transport.sha256, /^[a-f0-9]{64}$/);
  const completed = await f.call(
    path + `/documents/${document.id}/complete`,
    "POST",
    { version: transport.version, upload_attempt: transport.upload_attempt },
    uid(),
    200,
    "confirmação de documento",
  );
  const download = await h.fetch(
    f.request(contentPath),
    "download de documento",
  );
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
  const delivered = await f.call(
    path + `/documents/${document.id}/send`,
    "POST",
    { version: completed.version },
    uid(),
    200,
    "envio de documento",
  );
  assert(delivered.message_id);
  assert.equal(
    (
      await f.call(path + `/documents/${document.id}/send`, "POST", {
        version: completed.version,
      })
    ).message_id,
    delivered.message_id,
  );
  const sent = (await one(
    h.env,
    "SELECT * FROM outbox WHERE profile_id=? AND id=?",
    f.profile,
    delivered.message_id,
  ))!;
  assert.equal(sent.conversation_id, conversation);
  const copies = await all(
    h.env,
    "SELECT m.* FROM media m JOIN outbox o ON o.profile_id=m.profile_id AND json_extract(o.payload,'$.media_id')=m.id WHERE m.profile_id=? AND m.name=? AND o.conversation_id=?",
    f.profile,
    "entrega.txt",
    conversation,
  );
  assert.equal(copies.length, 1);
  const media = copies[0];
  assert.equal(media.name, "entrega.txt");
  assert.equal(media.type, "text/plain");
  assert.equal(media.size, bytes.length);
  assert.equal(media.actor, f.actor.id);
  assert.equal(media.object_key, `${f.profile}/${media.id}`);
  const shared = await h.env.MEDIA.get(media.object_key);
  assert(shared);
  assert.equal(shared.httpMetadata?.contentType, "text/plain");
  assert.deepEqual(new Uint8Array(await shared.arrayBuffer()), bytes);
  assert.equal(
    (await one(
      h.env,
      "SELECT COUNT(*) n FROM media WHERE profile_id=? AND id=?",
      f.profile,
      media.id,
    ))!.n,
    1,
  );
  assert.equal(
    (await one(
      h.env,
      "SELECT COUNT(*) n FROM outbox WHERE profile_id=? AND dedupe=?",
      f.profile,
      sent.dedupe,
    ))!.n,
    1,
  );
  const entryInput = {
    kind: "horas",
    text: "Trabalho realizado",
    quantity_milli: 1250,
    unit: "h",
    occurred_at: now(),
    client_visible: true,
    sensitive: false,
  };
  const entry = await f.call(
    path + "/entries",
    "POST",
    entryInput,
    uid(),
    200,
    "escrita de lançamento",
  );
  await f.call(path + "/entries", "POST", {
    ...entryInput,
    text: MOTOR_SENTINEL + "_LANCAMENTO",
    client_visible: false,
    sensitive: true,
  });
  const corrected = await f.call(
    path + `/entries/${entry.id}/revisions`,
    "POST",
    { ...entryInput, version: entry.version, quantity_milli: 1500 },
    uid(),
    200,
    "retificação de lançamento",
  );
  assert.equal(
    (await one(
      h.env,
      "SELECT archived_at FROM os_entries WHERE id=?",
      entry.id,
    ))!.archived_at !== null,
    true,
  );
  assert.equal(
    (await one(
      h.env,
      "SELECT replaces_id FROM os_entries WHERE id=?",
      corrected.id,
    ))!.replaces_id,
    entry.id,
  );
  assert.equal((await f.call(path + "?history=none")).version, parentVersion);
  const ctx = modulesApi(withReadCache(h.env), f.profile, "os");
  const due = await measure(h.env, (e) =>
    runExtensionsDue(modulesApi(withReadCache(e), f.profile, "os"), now()),
  );
  assert.equal(due.result.processed >= 1, true);
  assert(due.count.statements <= 200);
  assert(
    (await one(h.env, "SELECT notified_at FROM os_tasks WHERE id=?", task.id))!
      .notified_at,
  );
  const after = await messages(h, f);
  assert.equal(
    after.filter((m) =>
      JSON.stringify(m.payload).includes("Lembrete: Conferir prazo"),
    ).length,
    1,
  );
  await runExtensionsDue(ctx, now());
  assert.equal((await messages(h, f)).length, after.length);
  assert.equal(scheduledModules().filter(([id]) => id === "os").length, 1);
  assert(
    (await runModuleSchedules(h.env, f.profile, now())).every(
      (result) => result.ok,
    ),
  );
  const bot: Actor = {
    ...f.actor,
    id: "bot:integration",
    via: {
      kind: "bot",
      bot_id: "integration",
      run_id: "integration",
      masked: false,
    },
  };
  const publicPath = `service-orders/conversation/${conversation}/orders/${id}`;
  for (const suffix of ["", "/tasks", "/documents", "/entries"]) {
    const customer = await f.call("/" + publicPath + suffix);
    assert(!JSON.stringify(customer).includes(MOTOR_SENTINEL));
    const botView = await ctx.read(bot, publicPath + suffix);
    assert(!JSON.stringify(botView).includes(MOTOR_SENTINEL));
    if (suffix === "/tasks")
      assert.deepEqual(
        customer.data.map((t: any) => t.id),
        [task.id],
      );
  }
  await assert.rejects(
    () => ctx.read(bot, `service-orders/${id}/private-fields`),
    (e: any) => e.code === "sensitive_forbidden",
  );
  for (const route of fullCatalog().filter((route) => route.module === "os")) {
    assert(!route.path.includes("private-"));
    assert(
      !/^(os\.private|os\.person\.|os\.entry\.|os\.document\.upload)/.test(
        route.name,
      ),
    );
  }
  for (const [suffix, label] of [
    ["types", "catálogo"],
    ["", "lista"],
    ["?facets=1", "lista com facetas"],
    [`${id}?history=none`, "detalhe sem histórico"],
    [id, "detalhe legado"],
    [`${id}/history`, "histórico"],
  ])
    await f.call(
      "/service-orders" +
        (suffix && !suffix.startsWith("?") ? "/" : "") +
        suffix,
      "GET",
      undefined,
      uid(),
      200,
      label,
    );
  for (const collection of ["tasks", "people", "documents", "entries"])
    await f.call(
      `${path}/${collection}`,
      "GET",
      undefined,
      uid(),
      200,
      `coleção ${collection}`,
    );
  const history = await f.call(path + "/history");
  for (const kind of [
    "os.stage_changed",
    "os.task.created",
    "os.person.created",
    "os.document_reserved",
    "os.document_ready",
    "os.entry.created",
    "os.entry.revised",
  ])
    assert(
      history.data.some((entry: any) => entry.kind === kind),
      kind,
    );
  for (const table of ["os_history", "events", "outbox", "media"])
    assert(
      !JSON.stringify(
        await all(
          h.env,
          `SELECT * FROM ${table} WHERE profile_id=?`,
          f.profile,
        ),
      ).includes(MOTOR_SENTINEL),
      table,
    );
  const page = await f.call("/service-orders");
  assert.equal(page.data.length, 2);
  assert.deepEqual(page.counts, { received: 1, in_progress: 1 });
  assert.equal(
    (await f.call(`/service-orders/${builtin.id}`)).status,
    "received",
  );
  const legacy = `/service-orders/${builtin.id}`;
  await f.call(legacy + "/quote", "PUT", {
    items: [{ description: "Peça", quantity: 1, unit_cents: 1200 }],
  });
  const quoted = await f.call(legacy + "/quote/send", "POST", {
    notify: false,
  });
  assert.equal(quoted.status, "quoted");
  assert.equal(quoted.quote.total_cents, 1200);
  const approved = await f.call(legacy + "/decision", "POST", {
    decision: "approve",
  });
  assert.equal(approved.decision.decision, "approved");
  for (const status of ["in_progress", "ready", "delivered"]) {
    const changed = await f.call(legacy + "/status", "POST", { status });
    assert.equal(changed.status, status);
    assert.equal(changed.stage, status);
    assert.equal(changed.number, 2);
  }
  const finished = await f.call(legacy);
  assert(finished.warranty_until > finished.delivered_at);
  assert.deepEqual(
    finished.history.map((h: any) => h.kind),
    ["opened", "quote", "quote", "status", "status", "status", "status"],
  );
  return { f, order, path, task, entryInput, due: due.count };
}

export async function recoveredChild(h: IntegrationHarness) {
  await workClientRouting();
  const scenario = await integratedWork(h),
    { f, path, entryInput } = scenario;
  const key = uid(),
    body = { ...entryInput, text: "Recuperação durável" };
  const first = await f.call(path + "/entries", "POST", body, key);
  // Estado durável equivalente à interrupção após a mutação e antes de publicar/fechar.
  await exec(
    h.env,
    "UPDATE receipts SET response=NULL WHERE scope=? AND key=?",
    `${f.actor.id}:${f.profile}:os.entry.create`,
    key,
  );
  const history = (await one(
    h.env,
    "SELECT id FROM os_history WHERE profile_id=? AND entity_id=?",
    f.profile,
    first.id,
  ))!;
  // Não apagar histórico/filho: só retiramos a publicação para simular a fronteira D1/evento.
  await exec(
    h.env,
    "DELETE FROM events WHERE profile_id=? AND resource_id=? AND kind='os.entry.created'",
    f.profile,
    first.id,
  );
  const replay = await f.call(
    path + "/entries",
    "POST",
    body,
    key,
    200,
    "recuperação após interrupção",
  );
  assert.deepEqual(replay, first);
  assert.equal(
    (
      await all(
        h.env,
        "SELECT id FROM os_history WHERE profile_id=? AND entity_id=?",
        f.profile,
        first.id,
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await all(
        h.env,
        "SELECT id FROM os_entries WHERE profile_id=? AND id=?",
        f.profile,
        first.id,
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await all(
        h.env,
        "SELECT id FROM events WHERE profile_id=? AND resource_id=? AND kind='os.entry.created'",
        f.profile,
        first.id,
      )
    ).length,
    1,
    history.id,
  );
  const ctx = modulesApi(h.env, f.profile, "os");
  const parent = await authorizedOrder(ctx, f.actor, first.order_id, {
    write: true,
  });
  const before = await one(
    h.env,
    "SELECT * FROM os_entries WHERE id=?",
    first.id,
  );
  await assert.rejects(
    () =>
      commitChild(ctx, f.actor, parent, {
        entity_kind: "entry",
        id: first.id,
        expected_version: 1,
        mutation_key: uid(),
        changed_fields: ["archived_at"],
        event: "os.entry.archived",
        statements: [
          [
            "UPDATE os_entries SET archived_at=?,version=version+1 WHERE profile_id=? AND order_id=? AND id=? AND version=1",
            [now(), f.profile, first.order_id, first.id],
          ],
          ["SELECT json('I_INTERRUPTED_BATCH')", []],
        ],
      }),
    (error: any) => error.code === "version_conflict",
  );
  assert.deepEqual(
    await one(h.env, "SELECT * FROM os_entries WHERE id=?", first.id),
    before,
  );
  assert.equal(
    (
      await all(
        h.env,
        "SELECT id FROM os_history WHERE profile_id=? AND entity_id=?",
        f.profile,
        first.id,
      )
    ).length,
    1,
  );
  const outsider = await integrationFixture(h);
  await outsider.call(path, "GET", undefined, uid(), 409); // módulo desligado antes da leitura
  await outsider.call("/modules/os", "PUT", { enabled: true });
  await outsider.call(path, "GET", undefined, uid(), 404);
  return scenario;
}

async function workClientRouting() {
  const calls: string[] = [];
  const api = createWorkApi(async (path: string) => {
    calls.push(path);
    return {} as any;
  }, "v1/profiles/i");
  await api.deadlines({ assignee: "me", state: "open", period: "today" });
  assert(calls.pop()!.startsWith("v1/profiles/i/service-orders/my-tasks?"));
  await api.createTask("o", {
    title: "Restrita",
    audience: "staff",
    client_visible: false,
    sensitive: true,
  });
  assert(calls.pop()!.endsWith("/o/private-tasks"));
  await api.updateTask("o", "t", { version: 1, state: "done" }, true);
  assert(calls.pop()!.endsWith("/o/private-tasks/t"));
  await api.reserveDocument("o", {
    name: "Restrito.txt",
    mime_type: "text/plain",
    expected_bytes: 1,
    client_visible: false,
    sensitive: true,
  });
  assert(calls.pop()!.endsWith("/o/private-documents"));
  await api.completeDocument(
    "o",
    "d",
    { version: 1, upload_attempt: "attempt" },
    true,
  );
  assert(calls.pop()!.endsWith("/o/private-documents/d/complete"));
  assert(
    api.documentUrl("o", "d", true).endsWith("/o/private-documents/d/content"),
  );
  await api.archive("o", "documents", "d", 2, true);
  assert(calls.pop()!.endsWith("/o/private-documents/d/archive"));
}

export async function deadlinesRegression(h: IntegrationHarness) {
  const f = await integrationFixture(h);
  await exec(
    h.env,
    "UPDATE users SET access=? WHERE id=?",
    JSON.stringify(["*", "os:technician"]),
    f.actor.id,
  );
  await f.call("/modules/os", "PUT", { enabled: true });
  const catalog = await f.call("/service-orders/types");
  const type = motorWorkType();
  await f.call("/settings", "PUT", {
    os_work_types: [type],
    settings_revision: catalog.settings_revision,
  });
  const open = () =>
    f.call("/service-orders", "POST", {
      type_id: type.id,
      phone: "5511960010203",
      item: "Projeto",
      problem: "Conferir",
      notify: false,
    });
  const first = await open(),
    second = await open();
  await f.call(`/service-orders/${second.id}/stage`, "POST", {
    transition_id: "iniciar",
    version: second.version,
  });
  const task = (
    order: string,
    due_at?: number,
    assignee: string | null = f.actor.id,
  ) =>
    f.call(`/service-orders/${order}/tasks`, "POST", {
      title: "Conferir",
      audience: "staff",
      assignee,
      due_at,
      client_visible: false,
      sensitive: false,
    });
  const late = await task(first.id, 30),
    early = await task(second.id, 10),
    tied = await task(first.id, 10);
  const done = await task(first.id, 5);
  await f.call(`/service-orders/${first.id}/tasks/${done.id}`, "PATCH", {
    version: done.version,
    state: "done",
  });
  await task(first.id, 1, null);
  const undated = await task(first.id);
  const mine = "/service-orders/my-tasks";
  const page = await f.call(mine + "?limit=1");
  const next = await f.call(
    mine + "?cursor=" + encodeURIComponent(page.next_cursor),
  );
  assert.deepEqual(
    [...page.data, ...next.data].map((t) => t.id),
    [early.id, tied.id].sort().concat(late.id),
  );
  assert.equal(next.next_cursor, null);
  const rows = new Map([...page.data, ...next.data].map((t) => [t.id, t]));
  assert.equal(rows.get(early.id).stage_label, "Execução");
  assert.equal(rows.get(tied.id).stage_label, "Entrada");
  assert.equal(rows.get(early.id).display_number, "PROJ-2");
  assert.deepEqual(
    (await f.call(mine + "?state=done")).data.map((t: any) => t.id),
    [done.id],
  );
  assert.deepEqual(
    (await f.call(mine + "?period=undated")).data.map((t: any) => t.id),
    [undated.id],
  );
  assert.equal(
    (
      await f.call(
        mine + "?assignee=" + f.memberId,
        "GET",
        undefined,
        uid(),
        400,
      )
    ).error.code,
    "invalid_filter",
  );
  assert.equal(
    (
      await f.call(
        mine + "?state=done&cursor=" + encodeURIComponent(page.next_cursor),
        "GET",
        undefined,
        uid(),
        400,
      )
    ).error.code,
    "invalid_cursor",
  );
  // Uma linha inconsistente não vira 500 nem ganha o rótulo da etapa inicial.
  for (const stage of ["ausente", "execucao"]) {
    await exec(
      h.env,
      "UPDATE os_orders SET stage=? WHERE profile_id=? AND id=?",
      stage,
      f.profile,
      first.id,
    );
    assert.equal(
      (await f.call(mine, "GET", undefined, uid(), 409)).error.code,
      "invalid_snapshot",
    );
  }
  await exec(
    h.env,
    "UPDATE os_orders SET stage=? WHERE profile_id=? AND id=?",
    first.stage,
    f.profile,
    first.id,
  );
  assert.equal((await f.call(mine)).data.length, 3);
}

export async function outgoingAttachmentRegression(h: IntegrationHarness) {
  const f = await integrationFixture(h);
  await f.call("/modules/os", "PUT", { enabled: true });
  const conversation = await customerConversation(h, f);
  const ctx = modulesApi(h.env, f.profile, "os");
  const c = await ctx.conversation(conversation, f.actor);
  const input = (bytes: Uint8Array, key = uid()) => ({
    name: "saida.txt",
    mime_type: "text/plain",
    byte_length: 3,
    body: new Response(bytes as Uint8Array<ArrayBuffer>).body!,
    key,
    client_visible: true,
    sensitive: false,
  });
  const before = await all(
    h.env,
    "SELECT * FROM media WHERE profile_id=?",
    f.profile,
  );
  const objects = await h.env.MEDIA.list({ prefix: `${f.profile}/` });
  for (const bytes of [new Uint8Array([1, 2]), new Uint8Array([1, 2, 3, 4])])
    await assert.rejects(
      () => ctx.outgoingAttachment(f.actor, c, input(bytes)),
      (error: any) => error.code === "content_mismatch",
    );
  await assert.rejects(
    () =>
      ctx.outgoingAttachment(
        f.actor,
        c,
        input(new Uint8Array(10 * 1024 * 1024 + 1)),
      ),
    (error: any) => error.code === "document_too_large",
  );
  assert.deepEqual(
    await all(h.env, "SELECT * FROM media WHERE profile_id=?", f.profile),
    before,
  );
  assert.deepEqual(
    (await h.env.MEDIA.list({ prefix: `${f.profile}/` })).objects.map(
      (o) => o.key,
    ),
    objects.objects.map((o) => o.key),
  );
  const key = uid(),
    bytes = new Uint8Array([1, 2, 3]);
  const id = await ctx.outgoingAttachment(f.actor, c, input(bytes, key));
  assert.equal(await ctx.outgoingAttachment(f.actor, c, input(bytes, key)), id);
  await assert.rejects(
    () =>
      ctx.outgoingAttachment(f.actor, c, {
        ...input(bytes, key),
        name: "outro.txt",
      }),
    (error: any) => error.code === "idempotency_conflict",
  );
}

export const D1_CEILINGS: Record<string, number> = {
  catálogo: 15,
  lista: 20,
  "lista com facetas": 25,
  "detalhe sem histórico": 15,
  "detalhe legado": 20,
  histórico: 20,
  "coleção tasks": 20,
  "coleção people": 20,
  "coleção documents": 20,
  "coleção entries": 20,
  "meus prazos": 20,
  "criação de ordem": 60,
  "repetição de criação": 60,
  etapa: 50,
  "repetição de etapa": 50,
  "conflito de etapa": 50,
  "pedido de aprovação": 50,
  "decisão de aprovação": 50,
  "escrita de tarefa": 45,
  "escrita de pessoa": 45,
  "escrita de lançamento": 45,
  "retificação de lançamento": 45,
  "reserva de documento": 45,
  "confirmação de documento": 45,
  "prévia de modelo": 25,
  "aplicação de modelo": 80,
  "repetição de modelo": 80,
};
export async function budgetScenario(h: IntegrationHarness) {
  const { f, order, path, due } = await integratedWork(h);
  // Página cheia: nenhuma leitura de filho/responsável por ordem.
  const original = (await one(
    h.env,
    "SELECT * FROM os_orders WHERE profile_id=? AND id=?",
    f.profile,
    order.id,
  ))!;
  const columns = Object.keys(original);
  for (let i = 0; i < 50; i++) {
    const row = {
      ...original,
      id: uid(),
      number: i + 3,
      type_number: i + 2,
      source_key: null,
      conversation_id: null,
    };
    await exec(
      h.env,
      `INSERT INTO os_orders(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      ...columns.map((k) => row[k]),
    );
  }
  const page = await f.call(
    "/service-orders?limit=50",
    "GET",
    undefined,
    uid(),
    200,
    "lista",
  );
  assert.equal(page.data.length, 50);
  assert.equal(typeof page.next_cursor, "string");
  await f.call(
    "/service-orders?facets=1&limit=50",
    "GET",
    undefined,
    uid(),
    200,
    "lista com facetas",
  );
  // Quatro abas cheias continuam sendo quatro invocações, sem joins por linha.
  for (const collection of ["tasks", "people", "documents", "entries"]) {
    const table = "os_" + collection;
    const seed = (await one(
      h.env,
      `SELECT * FROM ${table} WHERE profile_id=? AND order_id=? AND archived_at IS NULL AND sensitive=0 LIMIT 1`,
      f.profile,
      order.id,
    ))!;
    const keys = Object.keys(seed);
    for (let i = 0; i < 51; i++) {
      const copy = {
        ...seed,
        id: uid(),
        ...(collection === "tasks"
          ? { remind_at: null, notified_at: null }
          : {}),
        ...(collection === "documents"
          ? {
              state: "pending",
              r2_key: null,
              byte_length: null,
              sha256: null,
              source_media_id: null,
            }
          : {}),
      };
      await exec(
        h.env,
        `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
        ...keys.map((key) => copy[key]),
      );
    }
    const children = await f.call(
      `${path}/${collection}?limit=50`,
      "GET",
      undefined,
      uid(),
      200,
      `coleção ${collection}`,
    );
    assert.equal(children.data.length, 50);
    assert.equal(typeof children.next_cursor, "string");
  }
  const taskDueAt = now() - 100;
  for (let i = 0; i < 12; i++)
    await f.call(
      path + "/tasks",
      "POST",
      {
        title: `Prazo ${i}`,
        audience: "staff",
        assignee: f.actor.id,
        due_at: taskDueAt,
        remind_at: taskDueAt,
        client_visible: false,
        sensitive: false,
      },
      uid(),
      200,
      "escrita de tarefa",
    );
  await f.call(
    "/service-orders/my-tasks?assignee=me&period=overdue&state=open",
    "GET",
    undefined,
    uid(),
    200,
    "meus prazos",
  );
  // Mede orçamento compartilhado dos filhos, incluindo as chamadas internas.
  const children = await measure(h.env, (e) =>
    runExtensionsDue(modulesApi(withReadCache(e), f.profile, "os"), now()),
  );
  assert(children.count.statements <= 200, JSON.stringify(children.count));
  assert(children.result.processed > 0 && children.result.processed <= 10);
  assert.equal(children.result.has_more, true);
  const pending = await one(
    h.env,
    "SELECT COUNT(*) n FROM os_tasks WHERE profile_id=? AND remind_at IS NOT NULL AND notified_at IS NULL",
    f.profile,
  );
  assert(pending!.n > 0);
  // Alarme completo: manutenção, todos os módulos, 50 eventos de paralisação,
  // documentos pendentes expirados e continuação dos prazos. Sem destinos de rede.
  for (const module of [
    "queue",
    "forms",
    "agenda",
    "payments",
    "mensalidade",
    "suporte",
    "reserva",
    "pedido",
    "mesas",
    "entrega",
  ])
    await f.call("/modules/" + module, "PUT", { enabled: true });
  const snapshot = JSON.parse(original.type_snapshot_json);
  snapshot.type.features.stale_days = 1;
  await exec(
    h.env,
    "UPDATE os_orders SET type_snapshot_json=?,updated=?,stale_notified_at=NULL WHERE profile_id=? AND type_id='projeto' AND id<>?",
    JSON.stringify(snapshot),
    now() - 2 * 86400000,
    f.profile,
    order.id,
  );
  for (let i = 0; i < 3; i++) {
    const doc = await f.call(path + "/documents", "POST", {
      name: "Expirado.txt",
      mime_type: "text/plain",
      expected_bytes: 1,
      client_visible: false,
      sensitive: false,
    });
    await exec(
      h.env,
      "UPDATE os_documents SET upload_expires_at=? WHERE id=?",
      now() - 1,
      doc.id,
    );
  }
  // Entregas destes comandos já são verificadas no fluxo; evita tentar um provedor externo.
  await exec(
    h.env,
    "UPDATE outbox SET status='cancelled' WHERE profile_id=?",
    f.profile,
  );
  const alarm = await h.alarm(f.profile);
  assert(alarm.statements <= 800, JSON.stringify(alarm));
  assert.equal(
    (await one(
      h.env,
      "SELECT COUNT(*) n FROM os_orders WHERE profile_id=? AND stale_notified_at IS NOT NULL",
      f.profile,
    ))!.n,
    50,
  );
  assert.equal(
    (await one(
      h.env,
      "SELECT COUNT(*) n FROM os_tasks WHERE profile_id=? AND remind_at IS NOT NULL AND notified_at IS NULL",
      f.profile,
    ))!.n,
    0,
  );
  assert.equal(
    (await one(
      h.env,
      "SELECT COUNT(*) n FROM os_documents WHERE profile_id=? AND state='aborted'",
      f.profile,
    ))!.n,
    3,
  );
  const report: Record<
    string,
    { worker: number; coordinator: number; ceiling: number }
  > = {};
  for (const [name, ceiling] of Object.entries(D1_CEILINGS)) {
    const invocations = h.report.filter((r) => r.name === name);
    assert(invocations.length, `Cenário não medido: ${name}`);
    const worker = Math.max(...invocations.map((r) => r.worker.statements));
    const coordinator = Math.max(
      0,
      ...invocations.flatMap((r) => r.coordinators.map((c) => c.statements)),
    );
    for (const invocation of invocations) {
      assert(
        invocation.worker.statements <= ceiling,
        `${name} Worker: ${JSON.stringify(invocation.worker)}`,
      );
      for (const count of invocation.coordinators)
        assert(
          count.statements <= ceiling,
          `${name} Coordinator: ${JSON.stringify(count)}`,
        );
    }
    report[name] = { worker, coordinator, ceiling };
  }
  return {
    routes: report,
    children: Math.max(children.count.statements, due.statements),
    alarm: alarm.statements,
  };
}
