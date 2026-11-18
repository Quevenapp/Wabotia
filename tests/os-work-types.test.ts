import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { perform, settingsRevision } from "../src/service";
import { json, now, uid, type Env as AppEnv } from "../src/types";
import type { WorkField } from "../src/modules/os/contracts";
import { osModule } from "../src/modules/os/definition";
import { MOTOR_EVENTS } from "../src/modules/os/motor-routes";
import { authorizedOrder, commitChild } from "../src/modules/os/public";
import { projectOrderForBot, projectOrderForCustomer, projectOrderForStaff, projectPrivateFields } from "../src/modules/os/privacy";
import { validateExtra, validateVocabulary, validateWorkType, validateWorkTypeChanges, validateWorkTypes } from "../src/modules/os/validation";
import { changeStatus, createOrder, customMessage, handleQuoteReply, listOrders, loadOrder, orderView, publicOrderValues, saveQuote, sendQuote, decide, updateOrder } from "../src/modules/os/store";
import { changeStage, decideStageApproval, requestStageApproval } from "../src/modules/os/stages";
import { handleStageReply } from "../src/modules/os/stage-replies";
import { customOpenForm, openingAnswers } from "../src/modules/os/forms";
import { runDue } from "../src/modules/os/reminders";
import { api, application, configure, drain, outbox, quietCoordinator, receive } from "./service-center-fixture";
import { MOTOR_SENTINEL, motorFixture, motorOrder, motorWorkType } from "./os-motor-fixture";

// Tipagem local para checagem avulsa; os bindings reais vêm de tests/setup.ts.
declare global {
  namespace Cloudflare { interface Env extends AppEnv {} }
}

// Simula exclusivamente as linhas de registro destinadas a I, neste isolado.
beforeAll(() => { for (const e of MOTOR_EVENTS) if (!osModule.events.includes(e)) osModule.events.push(e); });
const base = (id: string, kind: WorkField["kind"], rest: Record<string, unknown> = {}): WorkField => ({ id, kind, label: id, help: "", required: false, client_visible: true, sensitive: false, ...rest } as WorkField);
async function setup(type = motorWorkType()) {
  const f = await motorFixture();
  await configure(f, { os_work_types: [type], settings_revision: await settingsRevision(env, f.profile) });
  return { ...f, type };
}
const input = (type_id = "projeto") => ({ type_id, phone: "5511960010203", item: "Objeto", problem: "Escopo", source: "panel" as const, actor: "teste", notify: false, sourceKey: uid() });

function quoteApprovalType() {
  const type = motorWorkType();
  type.stages.push(
    { id: "analise", label: "Análise", base_status: "analyzing", message: "" },
    { id: "orcamento", label: "Proposta", base_status: "quoted", message: "" },
    { id: "aceito", label: "Aceito", base_status: "approved", message: "" },
    { id: "recusado", label: "Recusado", base_status: "declined", message: "" },
  );
  type.features.quote = { default_valid_days: 3, source_stages: ["entrada", "analise", "orcamento", "recusado"], sent_stage: "orcamento", approved_stage: "aceito", declined_stage: "recusado", edited_stage: "analise" };
  for (const from of ["analise", "aceito", "recusado"]) {
    type.transitions.push({ id: `iniciar_${from}`, from, to: "execucao", label: "Iniciar", kind: "manual" });
    type.transitions.push({ id: `cancelar_${from}`, from, to: "cancelado", label: "Cancelar", kind: "manual" });
  }
  type.transitions.push({ id: "cancelar_orcamento", from: "orcamento", to: "cancelado", label: "Cancelar", kind: "customer_approval", valid_hours: 1, request_text: "Autoriza cancelar {identificador}?" });
  return type;
}

async function pendingQuoteAndStage() {
  const f = await setup(quoteApprovalType());
  const c = await receive(f, f.line, "oi"); await drain(f);
  const { order } = await createOrder(f.ctx, { ...input(), conversation: c });
  const saved = await saveQuote(f.ctx, order, { items: [{ description: "Trabalho", unit_cents: 100 }] }, f.member.id);
  const quoted = await sendQuote(f.ctx, saved, f.member.id, { notify: false });
  const pending = await requestStageApproval(f.ctx, quoted, { transition_id: "cancelar_orcamento", version: quoted.row_version }, f.member.id);
  return { f, c, pending };
}

describe("M: regressões da revisão do motor", () => {
  it.each(["APROVAR", "RECUSAR", "1", "2", "APROVAR NUMERO"])("não decide orçamento/etapa simultâneos com %s", async command => {
    const { f, c, pending } = await pendingQuoteAndStage();
    const before = await all(env, "SELECT id FROM os_history WHERE profile_id=? AND order_id=?", f.profile, pending.id);
    const turn = { text: command.replace("NUMERO", String(pending.number)), rowId: uid() };
    expect(await handleStageReply(f.ctx, c, turn)).toBe(true);
    expect(await loadOrder(f.ctx, pending.id)).toMatchObject({ status: "quoted", row_version: pending.row_version, stage_approval_json: pending.stage_approval_json });
    expect(await all(env, "SELECT id FROM os_history WHERE profile_id=? AND order_id=?", f.profile, pending.id)).toEqual(before);
    expect(JSON.stringify((await outbox(c.id)).at(-1))).toContain("ETAPA");
  });

  it.each(["APROVAR ETAPA", "APROVAR ETAPA NUMERO", "botão etapa", "botão orçamento"])("identifica o fluxo explicitamente: %s", async command => {
    const { f, c, pending } = await pendingQuoteAndStage();
    const quote = command === "botão orçamento";
    const turn = { text: command.replace("NUMERO", String(pending.number)), rowId: uid(), replyId: command.startsWith("botão") ? quote ? `os:${pending.id}:${pending.quote_version}:approve` : `os:stage:${pending.id}:${json(pending.stage_approval_json).version}:approve` : undefined };
    const handled = await handleStageReply(f.ctx, c, turn);
    expect(handled).toBe(!quote);
    if (!handled) expect(await handleQuoteReply(f.ctx, c, turn)).toBe(true);
    expect((await loadOrder(f.ctx, pending.id)).status).toBe(quote ? "approved" : "cancelled");
  });

  it.each(["declined", "cancelled", "expired", "approved"])("aprovação de etapa %s não captura resposta numerada do orçamento", async state => {
    const { f, c, pending } = await pendingQuoteAndStage();
    await decideStageApproval(f.ctx, pending, { version: pending.row_version, approval_version: json(pending.stage_approval_json).version, decision: "decline" }, f.member.id);
    if (state !== "declined") await exec(env, "UPDATE os_orders SET stage_approval_json=json_set(stage_approval_json,'$.state',?) WHERE profile_id=? AND id=?", state, f.profile, pending.id);
    const turn = { text: `APROVAR ${pending.number}`, rowId: uid() };
    expect(await handleStageReply(f.ctx, c, turn)).toBe(false);
    expect(await handleQuoteReply(f.ctx, c, turn)).toBe(true);
    expect((await loadOrder(f.ctx, pending.id)).status).toBe("approved");
  });

  it("decisão por aplicação sem atendimento não envia mensagem, inclusive ao recuperar recibo", async () => {
    const type = motorWorkType();
    type.transitions[0] = { ...type.transitions[0], kind: "customer_approval", valid_hours: 1, request_text: "Autoriza?" };
    type.stages[1].message = "Etapa autorizada";
    const f = await setup(type), c = await receive(f, f.line, "oi"); await drain(f);
    const { order } = await createOrder(f.ctx, { ...input(), conversation: c });
    const pending = await requestStageApproval(f.ctx, order, { transition_id: "iniciar", version: 1 }, f.member.id);
    const app = await application(f, ["conversations:read", "conversations:write"]);
    const before = await outbox(c.id), key = uid();
    const path = `/profiles/${f.profile}/service-orders/${order.id}/stage-approval/decision`;
    const body = { version: pending.row_version, approval_version: json(pending.stage_approval_json).version, decision: "approve" };
    const first = await api(app.token, path, "POST", body, key);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ stage: "execucao", version: 3 });
    await quietCoordinator(f.profile);
    const scope = `app:${app.id}:${f.profile}:os.stage.decision`;
    expect((await one(env, "SELECT response FROM receipts WHERE scope=? AND key=?", scope, key))?.response).toBeTruthy();
    await exec(env, "UPDATE receipts SET response=NULL WHERE scope=? AND key=?", scope, key);
    const replay = await api(app.token, path, "POST", body, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ stage: "execucao", version: 3 });
    expect(await outbox(c.id)).toEqual(before);
  });

  it("recupera os.stage por HTTP com recibo incompleto sem duplicar histórico ou mensagem", async () => {
    const type = motorWorkType(); type.stages[1].message = "Execução iniciada";
    const f = await setup(type), c = await receive(f, f.line, "oi"); await drain(f);
    const { order } = await createOrder(f.ctx, { ...input(), conversation: c });
    const path = `/profiles/${f.profile}/service-orders/${order.id}/stage`, key = uid(), body = { transition_id: "iniciar", version: 1 };
    expect((await api(f.token, path, "POST", body, key)).status).toBe(200);
    await quietCoordinator(f.profile);
    const history = await all(env, "SELECT * FROM os_history WHERE profile_id=? AND order_id=?", f.profile, order.id);
    const messages = await outbox(c.id);
    const scope = `${f.member.id}:${f.profile}:os.stage`;
    expect((await one(env, "SELECT response FROM receipts WHERE scope=? AND key=?", scope, key))?.response).toBeTruthy();
    await exec(env, "UPDATE receipts SET response=NULL WHERE scope=? AND key=?", scope, key);
    await exec(env, "DELETE FROM events WHERE profile_id=? AND resource_id=? AND kind='os.stage_changed'", f.profile, order.id);
    const replay = await api(f.token, path, "POST", body, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ version: 2, stage: "execucao" });
    expect(await all(env, "SELECT * FROM os_history WHERE profile_id=? AND order_id=?", f.profile, order.id)).toEqual(history);
    expect(await all(env, "SELECT id FROM events WHERE profile_id=? AND resource_id=? AND kind='os.stage_changed'", f.profile, order.id)).toHaveLength(1);
    expect(await outbox(c.id)).toEqual(messages);
  });

  it.each(["a", "😀"])("limita expansão de mensagem com %s, preservando Unicode e um único envio", async character => {
    const type = motorWorkType();
    type.fields[0] = base("referencia", "text", { multiline: true, max_length: 2000 });
    type.stages[1].message = "{campo_referencia}{campo_referencia}";
    const f = await setup(type), c = await receive(f, f.line, "oi"); await drain(f);
    const { order } = await createOrder(f.ctx, { ...input(), conversation: c, extra: { referencia: character.repeat(2000) } });
    const before = (await outbox(c.id)).length;
    const moved = await changeStage(f.ctx, order, { transition_id: "iniciar", version: 1 }, f.member.id);
    expect(moved.stage).toBe("execucao");
    const messages = await outbox(c.id);
    expect(messages).toHaveLength(before + 1);
    const expected = character.repeat(character === "a" ? 3799 : 1899) + "…";
    expect(customMessage(type.stages[1].message, moved)).toBe(expected);
    expect(JSON.stringify(messages.at(-1))).toContain(expected);
  });

  it("lembrete expandido não impede o envio aos demais trabalhos", async () => {
    const type = motorWorkType();
    type.fields[0] = base("referencia", "text", { multiline: true, max_length: 2000 });
    type.stages[1].base_status = "ready";
    type.features.pickup_reminder_days = 1;
    type.pickup_reminder_text = "{campo_referencia}{campo_referencia}";
    const f = await setup(type), c = await receive(f, f.line, "oi"); await drain(f);
    for (const referencia of ["a".repeat(2000), "Retire seu trabalho"]) {
      const { order } = await createOrder(f.ctx, { ...input(), conversation: c, extra: { referencia } });
      await changeStage(f.ctx, order, { transition_id: "iniciar", version: 1 }, f.member.id, { notify: false });
    }
    const before = (await outbox(c.id)).length, at = now() + 2 * 86400000;
    expect(await runDue(f.ctx, at)).toEqual({ reminded: 2, stale: 0 });
    expect(await outbox(c.id)).toHaveLength(before + 2);
    expect(await runDue(f.ctx, at)).toEqual({ reminded: 0, stale: 0 });
    expect(await outbox(c.id)).toHaveLength(before + 2);
  });

  it("pedido de aprovação também limita os marcadores expandidos ao corpo interativo", async () => {
    const type = motorWorkType();
    type.fields[0] = base("referencia", "text", { multiline: true, max_length: 2000 });
    type.transitions[0] = { ...type.transitions[0], kind: "customer_approval", valid_hours: 1, request_text: "{campo_referencia}{campo_referencia}" };
    const f = await setup(type), c = await receive(f, f.line, "oi"); await drain(f);
    const { order } = await createOrder(f.ctx, { ...input(), conversation: c, extra: { referencia: "a".repeat(2000) } });
    const pending = await requestStageApproval(f.ctx, order, { transition_id: "iniciar", version: 1 }, f.member.id);
    expect(json(pending.stage_approval_json).state).toBe("pending");
    expect(JSON.stringify((await outbox(c.id)).at(-1))).toContain("a".repeat(1023) + "…");
  });
});

describe("M: validação declarativa", () => {
  it("normaliza texto Unicode, rejeita chaves desconhecidas em todos os níveis e limita listas", () => {
    const t = motorWorkType(); t.labels.singular = "  " + "😀".repeat(80) + "  ";
    expect(validateWorkType(t).labels.singular).toHaveLength(160);
    t.labels.singular += "x";
    expect(() => validateWorkType(t)).toThrow();
    for (const path of ["", "labels", "features", "fields", "stages", "transitions"]) {
      const bad: any = motorWorkType();
      (path ? Array.isArray(bad[path]) ? bad[path][0] : bad[path] : bad).unknown = true;
      expect(() => validateWorkType(bad)).toThrow();
    }
    expect(() => validateWorkTypes(Array.from({ length: 21 }, (_, i) => ({ ...motorWorkType(), id: `type_${i}` })))).toThrow();
    expect(() => validateWorkTypes([motorWorkType(), motorWorkType()])).toThrow();
    expect(() => validateVocabulary({ collection_label: "X", customer_singular: "Y", customer_plural: "Z", extra: 1 })).toThrow();
    for (const badId of ["service_order", "A", "a-b", "__proto__", "a".repeat(65)]) expect(() => validateWorkType({ ...motorWorkType(), id: badId })).toThrow();
    const huge = motorWorkType(); huge.stages.forEach(s => s.message = "界".repeat(900));
    expect(() => validateWorkType(huge)).toThrow();
    const duplicate = motorWorkType(); duplicate.fields.push(duplicate.fields[0]);
    expect(() => validateWorkType(duplicate)).toThrow();
    const many = motorWorkType(); many.fields = Array.from({ length: 25 }, (_, i) => base(`f_${i}`, "boolean"));
    expect(() => validateWorkType(many)).toThrow();
  });
  it("confere grafo, terminais, estados reservados, marcadores e classificação", () => {
    for (const change of [
      (t: any) => t.stages.push({ id: "isolada", label: "Isolada", base_status: "analyzing", message: "" }),
      (t: any) => t.transitions.push({ id: "reabrir", from: "entregue", to: "entrada", label: "X", kind: "manual" }),
      (t: any) => t.transitions = t.transitions.filter((x: any) => x.id !== "cancelar_revisao"),
      (t: any) => t.initial_stage = "execucao",
      (t: any) => t.stages[1].base_status = "quoted",
      (t: any) => t.stages[0].message = "{campo_segredo}",
      (t: any) => t.pickup_reminder_text = "{desconhecido}",
      (t: any) => t.fields[1].required = true,
      (t: any) => t.fields[1].client_visible = true,
      (t: any) => { t.fields[0].required = true; t.fields[0].client_visible = false; },
      (t: any) => t.labels.item = "<script>alert(1)</script>",
      (t: any) => t.features.pickup_reminder_days = 1,
    ]) { const t = motorWorkType(); change(t); expect(() => validateWorkType(t)).toThrow(); }
    const t = motorWorkType(); t.stages[0].message = "{tipo} {etapa} {identificador} {campo_referencia}";
    expect(validateWorkType(t)).toEqual(t);
  });
  it("revisões, arquivamento, aposentadoria e sigilo são monotônicos", () => {
    const old = motorWorkType(), changed = motorWorkType();
    const run = (t: any) => validateWorkTypeChanges({ os_work_types: [old] }, { os_work_types: [t] });
    expect(() => run(old)).not.toThrow();
    changed.labels.item = "Novo";
    expect(() => run(changed)).toThrow();
    changed.revision = 2; expect(() => run(changed)).not.toThrow();
    expect(() => validateWorkTypeChanges({ os_work_types: [old] }, { os_work_types: [] })).toThrow();
    changed.archived = true; expect(() => run(changed)).not.toThrow();
    changed.fields = changed.fields.filter(f => f.id !== "segredo");
    expect(() => run(changed)).toThrow();
    changed.retired_field_ids = ["segredo"]; expect(() => run(changed)).not.toThrow();
    const again = { ...motorWorkType(), revision: 3 };
    expect(() => validateWorkTypeChanges({ os_work_types: [changed] }, { os_work_types: [again] })).toThrow();
    const less = motorWorkType(); less.revision = 2; less.fields[1].sensitive = false;
    expect(() => run(less)).toThrow();
    expect(() => validateWorkTypeChanges({}, { os_work_types: [{ ...old, revision: 2 }] })).toThrow();
  });
  it("valores distinguem ausência, falso, zero e nulo; não arredondam", () => {
    const fields = [base("texto", "text", { max_length: 2, multiline: false }), base("inteiro", "integer", { min: 0, max: Number.MAX_SAFE_INTEGER, required: true }), base("decimal", "decimal", { min: -10, max: 10, scale: 2 }), base("booleano", "boolean", { required: true }), base("data", "date", { min: "2024-01-01", max: "2024-12-31" }), base("opcao", "choice", { options: [{ id: "a", label: "Primeiro" }] })];
    const good = { inteiro: 0, booleano: false, texto: " 😀😀 ", decimal: 0.29, data: "2024-02-29", opcao: "a" };
    expect(validateExtra(fields, good)).toMatchObject({ inteiro: 0, booleano: false, texto: "😀😀", decimal: 0.29 });
    for (const patch of [{ inteiro: Number.MAX_SAFE_INTEGER + 1 }, { decimal: 0.291 }, { decimal: Infinity }, { data: "2024-02-30" }, { opcao: "Primeiro" }, { desconhecido: "x" }, { booleano: null }, { texto: "😀😀😀" }, { inteiro: undefined }]) expect(() => validateExtra(fields, { ...good, ...patch })).toThrow();
    expect(() => validateExtra(fields, {})).toThrow();
    expect(() => validateExtra([base("privado", "text", { sensitive: true, client_visible: false, max_length: 80, multiline: false })], { privado: MOTOR_SENTINEL })).toThrow();
  });
});

describe("M: persistência, API e snapshots", () => {
  it("mantém contadores por área/tipo, preserva contador antigo e trata concorrência/repetição", async () => {
    const f = await setup();
    await exec(env, "INSERT INTO os_counters(profile_id,last) VALUES(?,40)", f.profile);
    const first = await createOrder(f.ctx, input());
    expect(orderView(first.order)).toMatchObject({ number: 41, type_number: 1, display_number: "PROJ-1", stage: "entrada" });
    const builtin = await createOrder(f.ctx, input("service_order"));
    expect(orderView(builtin.order)).toMatchObject({ number: 42, type_number: 41, display_number: "42" });
    const same = input();
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => createOrder(f.ctx, same)));
    expect(new Set(concurrent.map(x => x.order.id)).size).toBe(1);
    const independent = await Promise.all(Array.from({ length: 5 }, () => createOrder(f.ctx, input())));
    expect(new Set(independent.map(x => x.order.type_number)).size).toBe(5);
    const other = await setup();
    expect((await createOrder(other.ctx, same)).order.number).toBe(1);
    expect((await createOrder(f.ctx, same)).order.id).toBe(concurrent[0].order.id);
    await exec(env, "UPDATE os_type_counters SET last=2147483647 WHERE profile_id=? AND type_id='projeto'", f.profile);
    const before = await one(env, "SELECT last FROM os_counters WHERE profile_id=?", f.profile);
    await expect(createOrder(f.ctx, input())).rejects.toMatchObject({ code: "sequence_exhausted" });
    expect(await one(env, "SELECT last FROM os_counters WHERE profile_id=?", f.profile)).toEqual(before);
  });
  it("fixa definição na ordem, permite operar arquivadas e mantém counts globais", async () => {
    const f = await setup();
    const created = await createOrder(f.ctx, { ...input(), extra: { referencia: "A" } });
    await createOrder(f.ctx, input("service_order"));
    const changed = motorWorkType(); changed.revision = 2; changed.labels.singular = "Novo projeto"; changed.archived = true;
    await configure(f, { os_work_types: [changed], settings_revision: await settingsRevision(env, f.profile) });
    const fixed = await authorizedOrder(f.ctx, f.member, created.order.id);
    expect(fixed.type.labels.singular).toBe("Projeto");
    await expect(createOrder(f.ctx, input())).rejects.toMatchObject({ code: "type_archived" });
    const moved = await changeStage(f.ctx, fixed.row, { transition_id: "iniciar", version: 1 }, f.member.id, { notify: false });
    expect(moved).toMatchObject({ status: "in_progress", stage: "execucao", row_version: 2 });
    const page = await listOrders(f.ctx, { type_id: "projeto", stage: "execucao", facets: "1" });
    expect(page.data).toHaveLength(1);
    expect(page.counts).toEqual({ received: 1, in_progress: 1 });
    expect(page.facets).toEqual({ types: { projeto: 1, service_order: 1 }, stages: { execucao: 1 } });
    await expect(listOrders(f.ctx, { stage: "entrada" })).rejects.toMatchObject({ code: "invalid_filter" });
    const catalog = await api(f.token, `/profiles/${f.profile}/service-orders/types`);
    expect((await catalog.json<any>()).data.map((t: any) => t.id)).toEqual(["service_order"]);
    const detail = await api(f.token, `/profiles/${f.profile}/service-orders/${created.order.id}?history=none`);
    expect((await detail.json<any>()).history).toBeUndefined();
  });
  it("recusa /status ambíguo, aceita etapa do mesmo estado e protege CAS", async () => {
    const type = motorWorkType(); type.transitions.push({ id: "pular", from: "entrada", to: "revisao", kind: "manual", label: "Pular" });
    const f = await setup(type), { order } = await createOrder(f.ctx, input());
    expect(orderView(order).next_statuses).toEqual(["cancelled"]);
    await expect(changeStatus(f.ctx, order, "in_progress", f.member.id, "")).rejects.toMatchObject({ code: "stage_required" });
    const next = await changeStage(f.ctx, order, { transition_id: "iniciar", version: 1 }, f.member.id, { notify: false });
    await expect(updateOrder(f.ctx, order, { version: 1, item: "Antigo" }, f.member.id)).rejects.toMatchObject({ code: "version_conflict" });
    const revised = await changeStage(f.ctx, next, { transition_id: "revisar", version: 2 }, f.member.id, { notify: false });
    expect(revised).toMatchObject({ status: "in_progress", stage: "revisao", row_version: 3 });
    expect((await all(env, "SELECT * FROM os_history WHERE profile_id=?", f.profile))).toHaveLength(3);
    await expect(updateOrder(f.ctx, revised, { type_id: "service_order" }, f.member.id)).rejects.toMatchObject({ code: "immutable_field" });
    await expect(saveQuote(f.ctx, revised, { items: [{ description: "X", unit_cents: 1 }] }, f.member.id)).rejects.toMatchObject({ code: "feature_disabled" });
  });
  it("recupera publicação após confirmação e não repete mutação", async () => {
    const f = await setup(), { order } = await createOrder(f.ctx, input());
    const key = uid();
    const publish = vi.spyOn(f.ctx, "publish").mockRejectedValueOnce(new Error("falha depois do D1"));
    await expect(updateOrder(f.ctx, order, { item: "Novo" }, f.member.id, key)).rejects.toThrow("falha depois do D1");
    const retry = await updateOrder(f.ctx, order, { item: "Novo" }, f.member.id, key);
    expect(retry.row_version).toBe(2);
    expect(await all(env, "SELECT id FROM os_history WHERE profile_id=? AND mutation_key=?", f.profile, key)).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(2);
  });
  it("salvar uma revisão antiga ou menu ativo arquivado não grava configuração parcial", async () => {
    const f = await setup(); const revision = await settingsRevision(env, f.profile);
    await configure(f, { os_vocabulary: { collection_label: "Trabalhos", customer_singular: "Pessoa", customer_plural: "Pessoas" }, settings_revision: revision });
    await expect(configure(f, { os_work_types: [motorWorkType()], settings_revision: revision })).rejects.toMatchObject({ code: "settings_conflict" });
    const t = motorWorkType(); t.revision = 2; t.archived = true;
    const before = await settingsRevision(env, f.profile);
    await expect(configure(f, { settings_revision: before, os_work_types: [t], menus: [{ id: "abrir", type: "os_open", type_id: t.id, label: "Abrir" }] })).rejects.toMatchObject({ status: 400 });
    expect(await settingsRevision(env, f.profile)).toBe(before);
  });
});

describe("M: sigilo, aprovações e abertura fixada", () => {
  it("sentinela privada só sai pela projeção privada humana com grant explícito", async () => {
    const type = motorWorkType(); type.fields.push(base("interno", "text", { client_visible: false, max_length: 80, multiline: false }));
    const f = await setup(type), { order } = await createOrder(f.ctx, { ...input(), extra: { referencia: "Pública", interno: "Equipe" } });
    await exec(env, "UPDATE os_orders SET extra_json=? WHERE profile_id=? AND id=?", JSON.stringify({ referencia: "Pública", interno: "Equipe", segredo: MOTOR_SENTINEL }), f.profile, order.id);
    const fixed = await authorizedOrder(f.ctx, f.member, order.id);
    const human = { ...f.admin, access: ["os:sensitive"] };
    expect(JSON.stringify(projectOrderForStaff(f.ctx, human, fixed))).not.toContain(MOTOR_SENTINEL);
    expect(projectOrderForStaff(f.ctx, human, fixed).extra.interno).toBe("Equipe");
    expect(projectOrderForCustomer(f.ctx, human, fixed).extra).toEqual({ referencia: "Pública" });
    expect(projectOrderForBot(f.ctx, human, fixed).extra).toEqual({ referencia: "Pública" });
    expect((await projectPrivateFields(f.ctx, human, fixed)).extra).toEqual({ segredo: MOTOR_SENTINEL });
    for (const actor of [f.admin, { ...human, kind: "app" as const }, { ...human, id: "bot:test" }, { ...human, via: { kind: "bot" as const, bot_id: "b", run_id: "r", masked: false } }]) await expect(projectPrivateFields(f.ctx, actor, fixed)).rejects.toMatchObject({ code: "sensitive_forbidden" });
    expect(JSON.stringify(publicOrderValues(fixed.row))).not.toContain(MOTOR_SENTINEL);
    await expect(updateOrder(f.ctx, fixed.row, { extra: { segredo: MOTOR_SENTINEL } }, human.id)).rejects.toMatchObject({ code: "invalid_fields" });
    const events = await all(env, "SELECT payload FROM events WHERE profile_id=?", f.profile);
    const history = await all(env, "SELECT * FROM os_history WHERE profile_id=?", f.profile);
    expect(JSON.stringify([events, history])).not.toContain(MOTOR_SENTINEL);
  });
  it("aprovação confere titular, versão, prazo, recusa sem transição e cancela ao editar", async () => {
    const type = motorWorkType(); type.transitions[0] = { ...type.transitions[0], kind: "customer_approval", valid_hours: 1, request_text: "Autoriza {identificador}?" };
    const f = await setup(type), c = await receive(f, f.line, "oi", "5511960010300"); await drain(f);
    const { order } = await createOrder(f.ctx, { ...input(), conversation: c });
    await expect(changeStage(f.ctx, order, { transition_id: "iniciar", version: 1 }, f.member.id)).rejects.toMatchObject({ code: "approval_required" });
    const pending = await requestStageApproval(f.ctx, order, { transition_id: "iniciar", version: 1 }, f.member.id);
    const approval = json(pending.stage_approval_json);
    const stranger = await receive(f, f.line, "oi", "5511960010301"); await drain(f);
    await handleStageReply(f.ctx, stranger, { text: "", replyId: `os:stage:${order.id}:${approval.version}:approve`, rowId: uid() });
    expect((await loadOrder(f.ctx, order.id)).stage).toBe("entrada");
    const declined = await decideStageApproval(f.ctx, pending, { version: 2, approval_version: approval.version, decision: "decline" }, f.member.id);
    expect(declined.stage).toBe("entrada"); expect(json(declined.stage_approval_json).state).toBe("declined");
    const again = await requestStageApproval(f.ctx, declined, { transition_id: "iniciar", version: 3 }, f.member.id);
    const edited = await updateOrder(f.ctx, again, { item: "Mudou" }, f.member.id);
    expect(json(edited.stage_approval_json).state).toBe("cancelled");
    await expect(decideStageApproval(f.ctx, edited, { version: edited.row_version, approval_version: 4, decision: "approve" }, f.member.id)).rejects.toMatchObject({ code: "approval_not_pending" });
    const fresh = await requestStageApproval(f.ctx, edited, { transition_id: "iniciar", version: edited.row_version }, f.member.id);
    await exec(env, "UPDATE os_orders SET stage_approval_json=json_set(stage_approval_json,'$.expires_at',1) WHERE profile_id=? AND id=?", f.profile, order.id);
    const expired = await loadOrder(f.ctx, order.id);
    await expect(decideStageApproval(f.ctx, expired, { version: expired.row_version, approval_version: json(fresh.stage_approval_json).version, decision: "approve" }, f.member.id)).rejects.toMatchObject({ code: "approval_expired" });
    const afterExpiry = await loadOrder(f.ctx, order.id);
    const last = await requestStageApproval(f.ctx, afterExpiry, { transition_id: "iniciar", version: afterExpiry.row_version }, f.member.id);
    const version = json(last.stage_approval_json).version;
    await handleStageReply(f.ctx, c, { text: "", replyId: `os:stage:${order.id}:${approval.version}:approve`, rowId: uid() });
    expect((await loadOrder(f.ctx, order.id)).stage).toBe("entrada");
    const turn = { text: "", replyId: `os:stage:${order.id}:${version}:approve`, rowId: uid() };
    await handleStageReply(f.ctx, c, turn);
    await handleStageReply(f.ctx, c, turn);
    const approved = await loadOrder(f.ctx, order.id);
    expect(approved.stage).toBe("execucao");
    expect(approved.row_version).toBe(last.row_version + 1);
    expect(json(approved.stage_approval_json).state).toBe("approved");
  });
  it("formulário fixa revisão, omite campos privados e recusa arquivamento antes de concluir", async () => {
    const f = await setup(), c = await receive(f, f.line, "oi", "5511960010302"); await drain(f);
    await exec(env, "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://atendimento.example.com',?)", now());
    const opened = await customOpenForm(f.ctx, c, f.type, { trigger: "menu", actor: "system", sourceKey: uid() });
    const stored = await one(env, "SELECT * FROM web_steps WHERE id=?", opened.step.id);
    expect(stored.spec).not.toContain("segredo"); expect(stored.ref_id).not.toContain("segredo");
    const changed = motorWorkType(); changed.revision = 2; changed.labels.item = "Alterado";
    await configure(f, { os_work_types: [changed], settings_revision: await settingsRevision(env, f.profile) });
    const fixed = await openingAnswers(f.ctx, opened.step, { item: "A", problem: "B", extra_referencia: "C" });
    expect(fixed!.snapshot.type.revision).toBe(1);
    const created = await createOrder(f.ctx, { ...input(), ...fixed!, source: "customer", conversation: c });
    expect(orderView(created.order).type_revision).toBe(1);
    changed.revision = 3; changed.archived = true;
    await configure(f, { os_work_types: [changed], settings_revision: await settingsRevision(env, f.profile) });
    await expect(openingAnswers(f.ctx, opened.step, { item: "A", problem: "B" })).rejects.toMatchObject({ code: "type_archived" });
  });
});

describe("M: política de orçamento, datas e filhos", () => {
  it("etapas do orçamento usam o protocolo e duas etapas ready conservam datas e lembrete", async () => {
    const type = motorWorkType();
    type.stages.push(
      { id: "analise", label: "Análise", base_status: "analyzing", message: "" },
      { id: "orcamento", label: "Proposta", base_status: "quoted", message: "Não duplicar" },
      { id: "aceito", label: "Aceito", base_status: "approved", message: "" },
      { id: "recusado", label: "Recusado", base_status: "declined", message: "" },
      { id: "pronto", label: "Pronto", base_status: "ready", message: "" },
      { id: "conferido", label: "Conferido", base_status: "ready", message: "" },
    );
    type.features.quote = { default_valid_days: 3, source_stages: ["entrada", "analise", "orcamento", "recusado"], sent_stage: "orcamento", approved_stage: "aceito", declined_stage: "recusado", edited_stage: "analise" };
    type.features.pickup_reminder_days = 2; type.features.warranty_days = 12;
    for (const from of ["analise", "aceito", "recusado"]) {
      type.transitions.push({ id: `iniciar_${from}`, from, to: "execucao", label: "Iniciar", kind: "manual" });
      type.transitions.push({ id: `cancelar_${from}`, from, to: "cancelado", label: "Cancelar", kind: "manual" });
    }
    type.transitions.push({ id: "cancelar_orcamento", from: "orcamento", to: "cancelado", label: "Cancelar", kind: "manual" });
    type.transitions.push({ id: "preparar", from: "revisao", to: "pronto", label: "Preparar", kind: "manual" });
    type.transitions.push({ id: "conferir", from: "pronto", to: "conferido", label: "Conferir", kind: "manual" });
    for (const from of ["pronto", "conferido"]) {
      type.transitions.push({ id: `entregar_${from}`, from, to: "entregue", label: "Entregar", kind: "manual" });
      type.transitions.push({ id: `cancelar_${from}`, from, to: "cancelado", label: "Cancelar", kind: "manual" });
    }
    const f = await setup(type), { order } = await createOrder(f.ctx, input());
    await expect(changeStatus(f.ctx, order, "quoted", f.member.id, "")).rejects.toMatchObject({ code: "invalid_transition" });
    const saved = await saveQuote(f.ctx, order, { items: [{ description: "Trabalho", unit_cents: 100 }] }, f.member.id);
    const sent = await sendQuote(f.ctx, saved, f.member.id, { notify: false });
    expect(sent).toMatchObject({ stage: "orcamento", status: "quoted", quote_version: 1 });
    const edited = await saveQuote(f.ctx, sent, { items: [{ description: "Trabalho", unit_cents: 200 }] }, f.member.id);
    expect(edited).toMatchObject({ stage: "analise", status: "analyzing" });
    const approved = await decide(f.ctx, await sendQuote(f.ctx, edited, f.member.id, { notify: false }), "approve", f.member.id, "panel");
    expect(approved).toMatchObject({ stage: "aceito", status: "approved" });
    let row = approved;
    for (const transition_id of ["iniciar_aceito", "revisar", "preparar"]) row = await changeStage(f.ctx, row, { transition_id, version: row.row_version }, f.member.id, { notify: false });
    const readyAt = row.ready_at;
    await exec(env, "UPDATE os_orders SET pickup_reminded_at=? WHERE profile_id=? AND id=?", now(), f.profile, row.id);
    row = await loadOrder(f.ctx, row.id);
    const checked = await changeStage(f.ctx, row, { transition_id: "conferir", version: row.row_version }, f.member.id, { notify: false });
    expect(checked.ready_at).toBe(readyAt); expect(checked.pickup_reminded_at).toBe(row.pickup_reminded_at);
    const delivered = await changeStage(f.ctx, checked, { transition_id: "entregar_conferido", version: checked.row_version }, f.member.id, { notify: false });
    expect(delivered.warranty_until).toBeGreaterThan(delivered.delivered_at + 11 * 86400000);
    expect(await runDue(f.ctx, now() + 400 * 86400000)).toEqual({ reminded: 0, stale: 0 });
  });
  it("commitChild reverte CAS falho e recupera publicação sem mudar versão do pai", async () => {
    const f = await setup(), { order } = await createOrder(f.ctx, input());
    // Fixture local, compatível com 0101 quando a tarefa T for integrada.
    await exec(env, "CREATE TABLE IF NOT EXISTS os_tasks(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,order_id TEXT NOT NULL,title TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL)");
    const parent = await authorizedOrder(f.ctx, f.member, order.id), id = uid(), key = uid();
    const mutation = { entity_kind: "task" as const, id, expected_version: null, mutation_key: key, changed_fields: ["title"], event: "os.updated", statements: [["INSERT INTO os_tasks(id,profile_id,order_id,title,version,created_by,created,updated) VALUES(?,?,?,?,1,?,?,?)", [id, f.profile, order.id, MOTOR_SENTINEL, f.member.id, now(), now()]]] as [string, unknown[]][] };
    const publish = vi.spyOn(f.ctx, "publish").mockRejectedValueOnce(new Error("evento indisponível"));
    await expect(commitChild(f.ctx, f.member, parent, mutation)).rejects.toThrow("evento indisponível");
    expect(await commitChild(f.ctx, f.member, parent, mutation)).toEqual({ id, order_id: order.id, version: 1 });
    expect(publish).toHaveBeenCalledTimes(2);
    expect((await loadOrder(f.ctx, order.id)).row_version).toBe(1);
    const failed = { ...mutation, expected_version: 1, mutation_key: uid(), statements: [["UPDATE os_tasks SET title='alterado',version=version+1 WHERE profile_id=? AND order_id=? AND id=? AND version=0", [f.profile, order.id, id]], ["UPDATE os_orders SET item='efeito indevido' WHERE profile_id=? AND id=?", [f.profile, order.id]]] as [string, unknown[]][] };
    await expect(commitChild(f.ctx, f.member, parent, failed)).rejects.toMatchObject({ code: "version_conflict" });
    expect((await loadOrder(f.ctx, order.id)).item).toBe("Objeto");
    expect(await all(env, "SELECT id FROM os_history WHERE profile_id=? AND mutation_key=?", f.profile, failed.mutation_key)).toEqual([]);
    expect(JSON.stringify(await all(env, "SELECT * FROM os_history WHERE profile_id=?", f.profile))).not.toContain(MOTOR_SENTINEL);
    expect(JSON.stringify(await all(env, "SELECT payload FROM events WHERE profile_id=?", f.profile))).not.toContain(MOTOR_SENTINEL);
  });
  it("página de histórico valida área, ordem e cursor; acesso sensível é conferido no comando", async () => {
    const f = await setup(), order = await motorOrder(f, { type_id: "projeto" });
    const moved = await perform(env, f.member, f.profile, "os.stage", { id: order.id, transition_id: "iniciar", version: order.version }, uid());
    expect(moved.stage).toBe("execucao");
    const url = `/profiles/${f.profile}/service-orders/${order.id}`;
    const page = await (await api(f.token, `${url}/history?limit=1`)).json<any>();
    expect(page.data).toHaveLength(1); expect(typeof page.next_cursor).toBe("string");
    const next = await (await api(f.token, `${url}/history?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`)).json<any>();
    expect(next.data).toHaveLength(1); expect(next.next_cursor).toBeNull();
    expect((await api(f.token, `${url}/history?cursor=invalid`)).status).toBe(400);
    await expect(perform(env, f.admin, f.profile, "os.private.update", { id: order.id, version: moved.version, extra: { segredo: MOTOR_SENTINEL } }, uid())).rejects.toMatchObject({ code: "sensitive_forbidden" });
    const human = { ...f.admin, access: ["os:sensitive"] };
    const written = await perform(env, human, f.profile, "os.private.update", { id: order.id, version: moved.version, extra: { segredo: MOTOR_SENTINEL } }, uid());
    expect(written).toEqual({ id: order.id, version: moved.version + 1, changed_fields: ["segredo"] });
    expect(JSON.stringify(written)).not.toContain(MOTOR_SENTINEL);
    const other = await motorFixture();
    await expect(authorizedOrder(other.ctx, other.member, order.id)).rejects.toMatchObject({ code: "not_found" });
  });
});
