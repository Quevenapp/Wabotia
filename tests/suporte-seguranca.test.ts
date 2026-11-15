// Regressão da revisão de segurança (REVISAO-SEGURANCA.md, casos B a I):
// cada teste refaz o ataque e prova que ele não funciona mais.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { now, uid } from "../src/types";
import { conversation, perform } from "../src/service";
import { startFlow, UNLINKED_REPLY } from "../src/modules/suporte/flow";
import { situationByPhone } from "../src/modules/mensalidade/public";
import { settleReleases } from "../src/modules/suporte/handoff";
import {
  api,
  bearer,
  claim,
  configure,
  tickets,
} from "./service-center-fixture";
import { approve, remoteStatus, useMercadoPago } from "./mensalidade-mp";
import {
  CNPJ,
  CPF_EM_DIA,
  CPF_NOVO,
  lastText,
  paymentFor,
  payerEmAtraso,
  payerEmDia,
  payerSemAssinatura,
  releases,
  setupSuporte,
  talk,
  tap,
  texts,
} from "./suporte-fixture";

useMercadoPago();

const menus = [
  { id: "humano", label: "Falar com atendente", type: "human" },
  { id: "proto", label: "Abrir protocolo", type: "ticket" },
];

const resolve = (f: any, id: string) =>
  perform(
    env,
    f.member,
    f.profile,
    "conversation.action",
    { id, action: "resolve" },
    uid(),
  );

describe("A2: liberação presa ao protocolo e à sessão da conversa", () => {
  it("B: cortesia 'até o protocolo' não revive com um protocolo novo aberto pelo cliente", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, { menus });
    const phone = "5511973000002";
    let c = await talk(f, "oi", phone);
    await claim(f, f.member, c.id);
    const res = await api(
      await bearer(f.member),
      `/profiles/${f.profile}/suporte/conversations/${c.id}/courtesy`,
      "POST",
      { reason: "Cortesia única" },
    );
    expect(res.status).toBe(200);
    // A liberação abriu (ou adotou) o protocolo da conversa e ficou presa a ele.
    const [granted] = await releases(c.id);
    expect(granted.ticket_id).toBeTruthy();
    expect(granted.conv_session).toBe(c.session);
    const [ticket] = await tickets(c.id);
    expect(ticket.id).toBe(granted.ticket_id);
    // Atendimento resolvido e protocolo fechado.
    await resolve(f, c.id);
    await exec(
      env,
      "UPDATE tickets SET status='closed' WHERE conversation_id=?",
      c.id,
    );
    // Dias depois o cliente abre um protocolo novo pelo menu e pede humano.
    await talk(f, "oi", phone);
    await talk(f, "2", phone);
    await talk(f, "minha impressora parou de novo", phone);
    expect(
      (await tickets(c.id)).filter((t: any) => t.status !== "closed").length,
    ).toBeGreaterThan(0);
    await talk(f, "menu", phone);
    c = await talk(f, "1", phone);
    expect(c.state).not.toBe("waiting");
    const rows = await releases(c.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("ended");
  });

  it("protocolo fechado com a conversa ainda aberta também encerra", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, { menus });
    const phone = "5511973000012";
    let c = await talk(f, "oi", phone);
    await claim(f, f.member, c.id);
    await api(
      await bearer(f.member),
      `/profiles/${f.profile}/suporte/conversations/${c.id}/courtesy`,
      "POST",
      { reason: "Teste" },
    );
    await exec(
      env,
      "UPDATE tickets SET status='closed' WHERE conversation_id=?",
      c.id,
    );
    await exec(
      env,
      "UPDATE conversations SET state='ai',owner=NULL WHERE id=?",
      c.id,
    );
    expect(await settleReleases(s.sctx, now())).toBe(1);
    expect((await releases(c.id))[0]).toMatchObject({
      status: "ended",
      ended_by: "system",
    });
    await talk(f, "menu", phone);
    c = await talk(f, "1", phone);
    expect(c.state).not.toBe("waiting");
  });

  it("prazo máximo absoluto: liberação em horas vencida pelo teto não vale", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, { menus });
    const phone = "5511973000022";
    let c = await talk(f, "oi", phone);
    await claim(f, f.member, c.id);
    await api(
      await bearer(f.member),
      `/profiles/${f.profile}/suporte/conversations/${c.id}/courtesy`,
      "POST",
      { reason: "Um mês", hours: 720 },
    );
    const [row] = await releases(c.id);
    expect(row.expires_at).toBeLessThanOrEqual(row.created + 720 * 3_600_000);
    // Passado o teto (simulado), deixa de valer mesmo com valid_until adiante.
    await exec(
      env,
      "UPDATE suporte_releases SET expires_at=?, valid_until=? WHERE id=?",
      now() - 1,
      now() + 3_600_000,
      row.id,
    );
    await exec(
      env,
      "UPDATE conversations SET state='ai',owner=NULL WHERE id=?",
      c.id,
    );
    await talk(f, "menu", phone);
    c = await talk(f, "1", phone);
    expect(c.state).not.toBe("waiting");
    expect((await releases(c.id))[0].status).toBe("ended");
  });

  it("assinatura encerrada: a liberação por assinatura acaba no portão", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, {
      menus: [
        {
          id: "pago",
          label: "Atendimento humano (pago)",
          type: "suporte_humano",
        },
        ...menus,
      ],
    });
    const phone = "5511973000032";
    const sub = await payerEmDia(s, phone);
    await talk(f, "oi", phone);
    let c = await talk(f, "1", phone);
    expect(c.state).toBe("waiting");
    const [row] = await releases(c.id);
    expect(row.kind).toBe("subscription");
    // A assinatura acaba com a conversa ainda aberta: a liberação não vale mais.
    await exec(
      env,
      "UPDATE mensalidade_subscriptions SET status='ended' WHERE id=?",
      sub.id,
    );
    await exec(
      env,
      "UPDATE conversations SET state='ai',owner=NULL WHERE id=?",
      c.id,
    );
    await talk(f, "menu", phone);
    c = await talk(f, "2", phone);
    expect(c.state).not.toBe("waiting");
    expect((await releases(c.id))[0].status).toBe("ended");
  });

  it("estorno da mensalidade que liberou encerra a liberação", async () => {
    const s = await setupSuporte();
    const { f, account } = s;
    const phone = "5511973000042";
    await payerEmAtraso(s, phone);
    let c = await talk(f, "oi", phone);
    await startFlow(s.sctx, c, uid());
    c = await tap(f, phone, "suporte:method:pix", "Pix");
    const session = await one(
      env,
      "SELECT * FROM suporte_sessions WHERE conversation_id=?",
      c.id,
    );
    const payment = await paymentFor(session.installment_id);
    await approve(account.id, payment.id);
    expect((await releases(c.id))[0]).toMatchObject({
      kind: "installment",
      status: "active",
    });
    await remoteStatus(account.id, payment.id, "refunded");
    expect((await releases(c.id))[0]).toMatchObject({
      status: "ended",
      ended_by: "provider",
    });
    c = await conversation(env, c.id, f.profile);
    expect(c.id).toBeTruthy();
  });
});

const paidMenu = [
  { id: "pago", label: "Atendimento humano (pago)", type: "suporte_humano" },
];

describe("A4/M1: documento digitado não identifica nem vincula", () => {
  it("C: CPF de outra pessoa + plano + Pix não vincula o telefone nem mexe no cadastro dela", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, { menus: paidMenu });
    const victim = "5511974000001";
    await payerSemAssinatura(s, victim, CPF_EM_DIA);
    const before = await one(
      env,
      "SELECT count(*) AS n FROM mensalidade_subscriptions WHERE profile_id=?",
      f.profile,
    );
    const attacker = "5511974000009";
    await talk(f, "oi", attacker);
    await talk(f, "1", attacker);
    let c = await talk(f, CPF_EM_DIA, attacker);
    expect(await lastText(c.id)).toBe(UNLINKED_REPLY);
    // As opções de compra não estão disponíveis para essa sessão.
    c = await tap(f, attacker, `suporte:plan:${s.plan.id}`);
    expect(await lastText(c.id)).toContain("não está mais disponível");
    await tap(f, attacker, "suporte:method:pix");
    expect(await situationByPhone(env, f.profile, attacker)).toBeNull();
    const victimNow = await situationByPhone(env, f.profile, victim);
    expect(victimNow!.payer.phones.map((p: any) => p.phone)).toEqual([victim]);
    expect(
      await one(
        env,
        "SELECT count(*) AS n FROM mensalidade_subscriptions WHERE profile_id=?",
        f.profile,
      ),
    ).toEqual(before);
    expect(
      await one(
        env,
        "SELECT count(*) AS n FROM mensalidade_contracts WHERE profile_id=?",
        f.profile,
      ),
    ).toEqual({ n: 0 });
    expect(await s.sctx.consent(c, "billing")).toBeNull();
    expect(c.state).not.toBe("waiting");
  });

  it("D: CNPJ de pagador em atraso de outra pessoa não põe na fila nem mostra a cobrança dela", async () => {
    const s = await setupSuporte({ identify: "linked_only" });
    const { f } = s;
    await configure(f, { menus: paidMenu });
    const sub = await payerEmAtraso(s, "5511975000001", CNPJ);
    const attacker = "5511975000009";
    await talk(f, "oi", attacker);
    await talk(f, "1", attacker);
    const c = await talk(f, CNPJ, attacker);
    expect(c.state).not.toBe("waiting");
    const said = (await texts(c.id)).map((m) => m.text).join("\n");
    expect(said).toContain(UNLINKED_REPLY);
    expect(said).not.toContain("venceu");
    expect(said).not.toContain("R$ 99,00");
    expect(said).not.toContain("Contabilidade Beta");
    expect(
      await one(
        env,
        "SELECT count(*) AS n FROM payments p JOIN mensalidade_installments i ON i.id=p.ref_id WHERE i.subscription_id=?",
        sub.id,
      ),
    ).toEqual({ n: 0 });
  });

  it("E: CPF de pagador em dia vindo de outro telefone não libera (vai para a equipe confirmar)", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, { menus: paidMenu });
    await payerEmDia(s, "5511976000001", CPF_EM_DIA);
    const attacker = "5511976000009";
    await talk(f, "oi", attacker);
    await talk(f, "1", attacker);
    const c = await talk(f, CPF_EM_DIA, attacker);
    expect(c.state).not.toBe("waiting");
    expect(await releases(c.id)).toHaveLength(0);
    const session = await one(
      env,
      "SELECT * FROM suporte_sessions WHERE conversation_id=? ORDER BY created DESC LIMIT 1",
      c.id,
    );
    expect(session).toMatchObject({ status: "awaiting_team", phone_linked: 0 });
  });

  it("F: CPF alheio, protocolo aberto pelo cliente e item humano comum: nada passa", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, {
      menus: [
        ...paidMenu,
        { id: "humano", label: "Falar com atendente", type: "human" },
        { id: "proto", label: "Abrir protocolo", type: "ticket" },
      ],
    });
    const sub = await payerEmDia(s, "5511977000001", CPF_EM_DIA);
    const attacker = "5511977000009";
    await talk(f, "oi", attacker);
    await talk(f, "1", attacker);
    let c = await talk(f, CPF_EM_DIA, attacker);
    expect(c.state).not.toBe("waiting");
    await exec(
      env,
      "UPDATE mensalidade_subscriptions SET status='ended' WHERE id=?",
      sub.id,
    );
    await talk(f, "menu", attacker);
    await talk(f, "3", attacker);
    await talk(f, "preciso de ajuda", attacker);
    await talk(f, "menu", attacker);
    c = await talk(f, "2", attacker);
    expect(c.state).not.toBe("waiting");
    expect(await releases(c.id)).toHaveLength(0);
  });

  it("I: sessão de quem digitou o CNPJ alheio não é liberada quando a vítima paga", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, { menus: paidMenu });
    await payerEmAtraso(s, "5511980000001", CNPJ);
    const attacker = "5511980000009";
    await talk(f, "oi", attacker);
    await talk(f, "1", attacker);
    let c = await talk(f, CNPJ, attacker);
    const session = await one(
      env,
      "SELECT * FROM suporte_sessions WHERE conversation_id=? ORDER BY created DESC LIMIT 1",
      c.id,
    );
    // A sessão nem fica presa à parcela da vítima.
    expect(session.installment_id).toBeNull();
    // Mesmo uma sessão presa à parcela (como as de antes) não é liberada pela
    // baixa: não é a conversa da cobrança nem um telefone autorizado.
    const inst = await one(
      env,
      "SELECT i.id FROM mensalidade_installments i JOIN mensalidade_subscriptions s ON s.id=i.subscription_id WHERE s.phone=? AND i.status='overdue'",
      "5511980000001",
    );
    await exec(
      env,
      "UPDATE suporte_sessions SET status='active',installment_id=?,expires_at=? WHERE id=?",
      inst.id,
      now() + 3_600_000,
      session.id,
    );
    await perform(
      env,
      f.admin,
      f.profile,
      "mensalidade.installment.pay",
      { id: inst.id },
      uid(),
    );
    c = await conversation(env, c.id, f.profile);
    expect(c.state).not.toBe("waiting");
    expect(await releases(c.id)).toHaveLength(0);
  });

  it("limite de documentos diferentes por telefone por dia", async () => {
    const s = await setupSuporte();
    const { f } = s;
    const phone = "5511981000009";
    let c = await talk(f, "oi", phone);
    for (const doc of [CPF_NOVO, CNPJ, CPF_EM_DIA]) {
      await startFlow(s.sctx, c, uid());
      c = await talk(f, doc, phone);
      expect(await lastText(c.id)).not.toContain("hoje");
      await talk(f, "menu", phone);
    }
    await startFlow(s.sctx, c, uid());
    c = await talk(f, "12.ABC.345/01DE-35", phone);
    expect(await lastText(c.id)).toContain(
      "Não é possível conferir outro CPF ou CNPJ por este número hoje.",
    );
    // Um documento já consultado hoje continua aceito.
    await startFlow(s.sctx, c, uid());
    c = await talk(f, CPF_NOVO, phone);
    expect(await lastText(c.id)).not.toContain("hoje");
  });
});
