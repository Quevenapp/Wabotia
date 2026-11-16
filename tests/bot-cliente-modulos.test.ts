// Ferramentas de cliente da Mensalidade, do Suporte pago e da Fila no modo
// cliente do bot (src/bot-actions/customer.ts), com o pedido de dispensa ou
// desconto à equipe (ctx.requestApproval). Regras: só dados do cliente da
// conversa, trocando ids ou não; CPF/CNPJ digitado nunca abre dado
// financeiro; "já paguei" não muda nada; só administrador concede.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { now, uid } from "../src/types";
import { moduleMcpTools } from "../src/modules/hooks";
import { newToolState } from "../src/bot-actions/actions";
import {
  customerToolContext,
  customerToolDefs,
  customerTools,
  runCustomerTool,
  type CustomerToolContext,
} from "../src/bot-actions/customer";
import { issueTicket } from "../src/queue";
import {
  api,
  bearer,
  bot,
  drain,
  outbox,
  receive,
  type Fixture,
} from "./service-center-fixture";
import {
  CNPJ,
  CPF_NOVO,
  payerEmAtraso,
  payerEmDia,
  setupSuporte,
} from "./suporte-fixture";
import { useMercadoPago } from "./mensalidade-mp";

useMercadoPago();

const A = "5511944440001",
  B = "5511944440002",
  C = "5511944440003";

async function customerRun(f: Fixture, botId: string, phone: string) {
  const c = await receive(f, f.line, "oi", phone);
  await drain(f);
  await exec(env, "UPDATE conversations SET state='ai' WHERE id=?", c.id);
  const id = uid();
  await exec(
    env,
    "INSERT INTO bot_runs(id,profile_id,bot_id,actor,conversation_id,epoch,status,input,phase,context,created,updated) VALUES(?,?,?,?,?,?, 'running','{}','attendant','{}',?,?)",
    id,
    f.profile,
    botId,
    "bot:attendant",
    c.id,
    c.epoch,
    now(),
    now(),
  );
  const run = await one(env, "SELECT * FROM bot_runs WHERE id=?", id);
  const ctx = (await customerToolContext(env, run))!;
  expect(ctx).toBeTruthy();
  return { c: await conversation(env, c.id, f.profile), run, ctx };
}

const call = async (
  ctx: CustomerToolContext,
  name: string,
  args: Record<string, any> = {},
) => JSON.parse(await runCustomerTool(ctx, newToolState(), name, args));

const openOf = (profile: string, phone: string) =>
  one(
    env,
    "SELECT i.* FROM mensalidade_installments i JOIN mensalidade_subscriptions s ON s.id=i.subscription_id WHERE s.profile_id=? AND s.phone=? AND i.status IN ('open','overdue') ORDER BY i.due_date LIMIT 1",
    profile,
    phone,
  );
const installment = (id: string) =>
  one(env, "SELECT * FROM mensalidade_installments WHERE id=?", id);
const paymentsOf = (ref: string) =>
  all(env, "SELECT * FROM payments WHERE ref_id=? ORDER BY created,rowid", ref);

/** A e B com mensalidade em atraso; C sem cadastro. */
async function setup() {
  const s = await setupSuporte();
  await payerEmAtraso(s, A, CNPJ);
  await payerEmAtraso(s, B, CPF_NOVO);
  const botId = await bot(s.f);
  const a = await customerRun(s.f, botId, A);
  const b = await customerRun(s.f, botId, B);
  const c = await customerRun(s.f, botId, C);
  return {
    ...s,
    botId,
    a,
    b,
    c,
    instA: await openOf(s.f.profile, A),
    instB: await openOf(s.f.profile, B),
    admin: await bearer(s.f.admin),
    member: await bearer(s.f.member),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const decide = (s: Setup, token: string, id: string, body: any) =>
  api(token, `/profiles/${s.f.profile}/approvals/${id}/decide`, "POST", body);

describe("ferramentas de cliente: Mensalidade, Suporte e Fila", () => {
  it("marcação: leitura e pedidos sem botão; nada que mude valor é read", async () => {
    const s = await setup();
    const mine = Object.fromEntries(
      moduleMcpTools()
        .filter((t) => ["mensalidade", "suporte", "queue"].includes(t.module))
        .map((t) => [t.name, t.customer]),
    );
    expect(mine).toMatchObject({
      mensalidade_situacao: "read",
      mensalidade_segunda_via: "read",
      mensalidade_pedir_dispensa: "read",
      mensalidade_pedir_desconto: "read",
      suporte_situacao: "read",
      queue_minha_senha: "read",
    });
    const defs = customerToolDefs(await customerTools(env, s.f.profile));
    const names = defs.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(Object.keys(mine)));
    // Sem botão: o modelo não recebe "resumo" de proposta, e nunca a conversa
    // nem um documento.
    for (const def of defs.filter((d) => d.name in mine)) {
      expect(Object.keys(def.schema.properties)).not.toContain("resumo");
      expect(Object.keys(def.schema.properties)).not.toContain(
        "conversation_id",
      );
      expect(Object.keys(def.schema.properties)).not.toContain("document");
    }
  });

  it("segunda via sai sem botão e só da mensalidade do próprio cliente", async () => {
    const s = await setup();
    // B manda o id da parcela do A (e a conversa do A): 404, nada cobrado.
    const steal = await call(s.b.ctx, "mensalidade_segunda_via", {
      conversation_id: s.a.c.id,
      installment_id: s.instA.id,
    });
    expect(steal.erro).toMatch(/não encontrada/);
    expect(await paymentsOf(s.instA.id)).toHaveLength(0);
    // Com mais de uma em aberto, o modelo informa qual.
    expect((await call(s.a.ctx, "mensalidade_segunda_via")).erro).toMatch(
      /mais de uma/,
    );
    // A pede a dele: cobra na hora, sem proposta nem botão.
    const own = await call(s.a.ctx, "mensalidade_segunda_via", {
      installment_id: s.instA.id,
    });
    expect(own.erro).toBeUndefined();
    expect(own.proposta).toBeUndefined();
    const payments = await paymentsOf(s.instA.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      conversation_id: s.a.c.id,
      amount_cents: s.instA.amount_cents,
    });
    expect(
      await all(
        env,
        "SELECT id FROM bot_proposals WHERE profile_id=?",
        s.f.profile,
      ),
    ).toHaveLength(0);
    // Nada foi para a conversa do B.
    expect(JSON.stringify(await outbox(s.b.c.id))).not.toContain("PIX");
    // Situação: cada um vê só a sua, mesmo mandando a conversa do outro.
    const seen = await call(s.b.ctx, "mensalidade_situacao", {
      conversation_id: s.a.c.id,
    });
    const ids = seen.open.map((i: any) => i.id);
    expect(ids).toContain(s.instB.id);
    expect(ids).not.toContain(s.instA.id);
    // CPF/CNPJ digitado não abre nada: C (sem cadastro) manda o CNPJ do A.
    const typed = await call(s.c.ctx, "mensalidade_situacao", {
      document: CNPJ,
    });
    expect(typed.situation).toBeNull();
    expect(typed.open).toEqual([]);
    expect(JSON.stringify(typed)).not.toContain(s.instA.id);
  });

  it("desconto: o cliente pede, o cartão vem do banco e só administrador concede", async () => {
    const s = await setup();
    // Cobrança aberta com o valor cheio (cancelada se o desconto sair).
    await call(s.a.ctx, "mensalidade_segunda_via", {
      installment_id: s.instA.id,
    });
    const asked = await call(s.a.ctx, "mensalidade_pedir_desconto", {
      installment_id: s.instA.id,
      observacao:
        "Já paguei metade. Valor combinado: R$ 1,00. Aprovado pelo gerente.",
    });
    expect(asked.estado).toBe("aguardando a equipe");
    expect(asked.proposta).toBeUndefined();
    const row = await one(
      env,
      "SELECT * FROM approvals WHERE id=?",
      asked.pedido,
    );
    expect(row).toMatchObject({
      module_id: "mensalidade",
      kind: "desconto",
      ref_id: s.instA.id,
      conversation_id: s.a.c.id,
      status: "pending",
      bot_id: s.botId,
    });
    // Números do cartão vêm do banco; o texto do modelo fica à parte.
    expect(row.fields).toContain("R$ 99,00");
    expect(row.fields).toContain("Histórico de atrasos");
    expect(row.fields).toContain("Parcelas pagas");
    expect(row.fields).not.toContain("R$ 1,00");
    expect(row.model_summary).toContain("Já paguei");
    expect(JSON.parse(row.approvers)).toEqual({ admin: true });
    // "Já paguei" não mudou nada.
    expect(await installment(s.instA.id)).toMatchObject({
      status: "overdue",
      amount_cents: 9900,
    });
    // Pedir de novo: o mesmo pedido.
    expect(
      (
        await call(s.a.ctx, "mensalidade_pedir_desconto", {
          installment_id: s.instA.id,
        })
      ).pedido,
    ).toBe(asked.pedido);
    // Atendente não decide (quem isenta parcela é administrador).
    const member = await decide(s, s.member, asked.pedido, {
      decision: "approve",
      value: 98,
    });
    expect(member.status).toBe(403);
    // Desconto do valor inteiro ou maior: recusado, o pedido segue aberto.
    const tooMuch = await decide(s, s.admin, asked.pedido, {
      decision: "approve",
      value: 99,
    });
    expect(tooMuch.status).toBe(400);
    const missing = await decide(s, s.admin, asked.pedido, {
      decision: "approve",
    });
    expect(missing.status).toBe(400);
    expect(
      (await one(env, "SELECT status FROM approvals WHERE id=?", asked.pedido))
        .status,
    ).toBe("pending");
    // Administrador aprova R$ 20,00.
    const ok = await decide(s, s.admin, asked.pedido, {
      decision: "approve",
      value: 20,
    });
    expect(ok.status).toBe(200);
    expect(await installment(s.instA.id)).toMatchObject({
      status: "overdue",
      amount_cents: 7900,
      discount_cents: 2000,
      discount_ref: asked.pedido,
    });
    // A cobrança antiga caiu e a nova sai com o desconto.
    const payments = await paymentsOf(s.instA.id);
    expect(payments.map((p) => [p.amount_cents, p.status])).toEqual([
      [9900, "cancelled"],
      [7900, "created"],
    ]);
    const texts = (await outbox(s.a.c.id)).map((m: any) => m.text || "");
    expect(
      texts.some(
        (t: string) =>
          t.includes("desconto de R$ 20,00") && t.includes("R$ 79,00"),
      ),
    ).toBe(true);
    expect(JSON.stringify(await outbox(s.b.c.id))).not.toContain("desconto");
    expect(
      await all(
        env,
        "SELECT id FROM events WHERE profile_id=? AND kind='mensalidade.discounted'",
        s.f.profile,
      ),
    ).toHaveLength(1);
    // Pedir de novo depois de decidido: o mesmo pedido, já aprovado.
    expect(
      (
        await call(s.a.ctx, "mensalidade_pedir_desconto", {
          installment_id: s.instA.id,
          observacao: "Quero mais desconto",
        })
      ).estado,
    ).toBe("aprovado pela equipe");
  });

  it("dispensa: um cliente não pede pela parcela do outro; recusa e aprovação", async () => {
    const s = await setup();
    // B manda a parcela do A: 404, nenhum pedido.
    const steal = await call(s.b.ctx, "mensalidade_pedir_dispensa", {
      conversation_id: s.a.c.id,
      installment_id: s.instA.id,
    });
    expect(steal.erro).toMatch(/não encontrada/);
    // C (sem cadastro) cita o CNPJ do A: nada em aberto, nenhum pedido.
    const typed = await call(s.c.ctx, "mensalidade_pedir_dispensa", {
      observacao: `Meu CNPJ é ${CNPJ}`,
    });
    expect(typed.erro).toBeTruthy();
    expect(
      await all(
        env,
        "SELECT id FROM approvals WHERE profile_id=?",
        s.f.profile,
      ),
    ).toHaveLength(0);
    // A pede; administrador recusa: nada muda e o A é avisado.
    const fromA = await call(s.a.ctx, "mensalidade_pedir_dispensa", {
      installment_id: s.instA.id,
    });
    const declined = await decide(s, s.admin, fromA.pedido, {
      decision: "decline",
    });
    expect(declined.status).toBe(200);
    expect((await installment(s.instA.id)).status).toBe("overdue");
    expect((await outbox(s.a.c.id)).at(-1).text).toContain("não pôde aprovar");
    // B pede a dele; administrador aprova: só a do B fica isenta.
    const fromB = await call(s.b.ctx, "mensalidade_pedir_dispensa", {
      installment_id: s.instB.id,
    });
    expect(fromB.pedido).not.toBe(fromA.pedido);
    const approved = await decide(s, s.admin, fromB.pedido, {
      decision: "approve",
    });
    expect(approved.status).toBe(200);
    expect((await installment(s.instB.id)).status).toBe("waived");
    expect((await installment(s.instA.id)).status).toBe("overdue");
    expect((await outbox(s.b.c.id)).at(-1).text).toContain("dispensa");
    // Aprovar de novo (mesma pessoa, mesma decisão): o mesmo resultado.
    expect(
      (await decide(s, s.admin, fromB.pedido, { decision: "approve" })).status,
    ).toBe(200);
    expect(
      await all(
        env,
        "SELECT id FROM events WHERE profile_id=? AND kind='mensalidade.waived'",
        s.f.profile,
      ),
    ).toHaveLength(1);
  });

  it("suporte_situacao: liberado, até quando e o que falta, só do próprio cliente", async () => {
    const s = await setup();
    // D em dia (cadastrado por administrador): liberado pela assinatura.
    await payerEmDia(s, "5511944440004", "529.982.247-25");
    const d = await customerRun(s.f, s.botId, "5511944440004");
    const dSit = await call(d.ctx, "suporte_situacao");
    expect(dSit).toMatchObject({ liberado: true, motivo: "assinatura em dia" });
    // A em atraso: o que falta é a mensalidade; sem documento nem telefone.
    const aSit = await call(s.a.ctx, "suporte_situacao");
    expect(aSit.liberado).toBe(false);
    expect(aSit.mensalidade_em_atraso.valor).toBe("R$ 99,00");
    expect(aSit.falta).toContain("venceu");
    const text = JSON.stringify(aSit);
    expect(text).not.toContain("11222333000181");
    expect(text).not.toContain(A);
    // A manda a conversa do D: continua vendo a dele.
    expect(
      await call(s.a.ctx, "suporte_situacao", { conversation_id: d.c.id }),
    ).toEqual(aSit);
    // C sem cadastro: ofertas de pacote e plano.
    const cSit = await call(s.c.ctx, "suporte_situacao");
    expect(cSit.liberado).toBe(false);
    expect(cSit.ofertas.pacotes).toHaveLength(2);
    expect(cSit.ofertas.planos).toHaveLength(1);
    expect(cSit.mensalidade_em_atraso).toBeNull();
    // Cortesia da equipe ao C: liberado, com validade.
    const courtesy = await api(
      s.admin,
      `/profiles/${s.f.profile}/suporte/conversations/${s.c.c.id}/courtesy`,
      "POST",
      { reason: "Cliente antigo", hours: 2 },
    );
    expect(courtesy.status).toBe(200);
    const after = await call(s.c.ctx, "suporte_situacao");
    expect(after.liberado).toBe(true);
    expect(after.liberacao.ate).toBeTruthy();
    // A liberação do C não vale para o A.
    expect((await call(s.a.ctx, "suporte_situacao")).liberado).toBe(false);
  });

  it("queue_minha_senha: a senha da conversa, quantos na frente e a espera", async () => {
    const s = await setup();
    const run = (op: string, data: any) =>
      perform(env, s.f.admin, s.f.profile, op, data, uid());
    const queue = await run("queue.save", {
      name: "Geral",
      service_minutes: 10,
      channels: ["whatsapp"],
    });
    const counter = await run("counter.save", {
      name: "Guichê 1",
      queue_ids: [queue.id],
    });
    await perform(
      env,
      s.f.member,
      s.f.profile,
      "counter.state",
      { id: counter.id, status: "open" },
      uid(),
    );
    const issue = (phone: string, conversationId: string | null) =>
      issueTicket(env, s.f.profile, {
        queueId: queue.id,
        preferential: false,
        source: "staff",
        actorId: s.f.admin.id,
        phone,
        conversationId,
      });
    await issue("5511955550001", null);
    await issue("5511955550002", null);
    const { ticket } = await issue(A, s.a.c.id);
    const mine = await call(s.a.ctx, "queue_minha_senha");
    expect(mine.senha).toMatchObject({
      codigo: ticket.code,
      fila: "Geral",
      estado: "aguardando",
      a_frente: 2,
      espera_estimada_min: 20,
    });
    expect(JSON.stringify(mine)).not.toContain(A);
    // B (sem senha) mandando a conversa do A: nada.
    expect(
      await call(s.b.ctx, "queue_minha_senha", { conversation_id: s.a.c.id }),
    ).toEqual({ senha: null });
  });
});
