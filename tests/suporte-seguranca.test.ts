// Regressão da revisão de segurança (REVISAO-SEGURANCA.md, casos B a I):
// cada teste refaz o ataque e prova que ele não funciona mais.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { now, uid, type Actor, type Conversation } from "../src/types";
import { conversation, handoff, perform } from "../src/service";
import { gateFailsClosed, handoffGatesList } from "../src/modules/hooks";
import { GROUP_REPLY } from "../src/modules/suporte/suporte";
import { startFlow, UNLINKED_REPLY } from "../src/modules/suporte/flow";
import { situationByPhone } from "../src/modules/mensalidade/public";
import { handoffGate } from "../src/modules/suporte/handoff";
import { modulesApi } from "../src/modules/api";
import { runDue } from "../src/modules/mensalidade/due";
import {
  api,
  application,
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
    // A lista do painel já mostra encerrada, com o motivo, sem gravar.
    const list = await (
      await api(
        await bearer(f.admin),
        `/profiles/${f.profile}/suporte/releases`,
      )
    ).json<any>();
    expect(list.data[0]).toMatchObject({
      status: "ended",
      ended_reason: "Protocolo fechado.",
    });
    // O pedido de humano seguinte segura e grava o fim.
    await talk(f, "menu", phone);
    c = await talk(f, "1", phone);
    expect(c.state).not.toBe("waiting");
    expect((await releases(c.id))[0]).toMatchObject({
      status: "ended",
      ended_by: "system",
    });
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

describe("conferência N-5: documentos digitados têm prazo", () => {
  it("consultas de mais de um dia e contratos não pagos de mais de 30 dias perdem o documento", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, { menus: paidMenu });
    const day = 86_400_000;
    const old = now() - 2 * day;
    await exec(
      env,
      "INSERT INTO suporte_lookups(id,profile_id,phone,conversation_id,document,created) VALUES(?,?,?,?,?,?)",
      "consulta-antiga",
      f.profile,
      "5511982000001",
      "conversa-antiga",
      CPF_EM_DIA,
      old,
    );
    const contract = (id: string, status: string, age: number) =>
      exec(
        env,
        "INSERT INTO mensalidade_contracts(id,profile_id,plan_id,conversation_id,phone,document,document_type,name,amount_cents,status,actor,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id,
        f.profile,
        s.plan.id,
        "conversa-antiga",
        "5511982000001",
        "52998224725",
        "cpf",
        "Terceiro",
        9900,
        status,
        "suporte",
        now() - age,
        now() - age,
      );
    await contract("contrato-antigo", "expired", 40 * day);
    await contract("contrato-recente", "cancelled", 5 * day);
    // Segunda conferência N-5: o documento também fica na sessão e na compra.
    const session = (id: string, status: string, age: number) =>
      exec(
        env,
        "INSERT INTO suporte_sessions(id,profile_id,conversation_id,phone,status,step,document,expires_at,created,updated) VALUES(?,?,?,?,?,'ask_document',?,?,?,?)",
        id,
        f.profile,
        "conversa-antiga",
        "5511982000001",
        status,
        CPF_EM_DIA,
        now() - age,
        now() - age,
        now() - age,
      );
    await session("sessao-encerrada", "closed", 2 * day);
    await session("sessao-aguardando", "awaiting_team", 2 * day);
    await session("sessao-velha", "awaiting_team", 8 * day);
    await exec(
      env,
      "INSERT INTO suporte_purchases(id,profile_id,conversation_id,document,name,package_id,package_name,price_cents,mode,method,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      "compra-antiga",
      f.profile,
      "conversa-antiga",
      CPF_EM_DIA,
      "Terceiro",
      "avulso",
      "Avulso",
      5000,
      "ticket",
      "pix",
      "expired",
      now() - 40 * day,
      now() - 40 * day,
    );
    const phone = "5511982000009";
    const c = await talk(f, "oi", phone);
    await startFlow(s.sctx, c, uid());
    await talk(f, CPF_NOVO, phone);
    await tap(f, phone, `suporte:plan:${s.plan.id}`, "Suporte Mensal");
    await talk(f, "Maria Souza", phone);
    await tap(f, phone, "suporte:method:pix", "Pix");
    expect(
      await one(
        env,
        "SELECT id FROM suporte_lookups WHERE id='consulta-antiga'",
      ),
    ).toBeNull();
    const rows = await all(
      env,
      "SELECT id,document,name FROM mensalidade_contracts WHERE profile_id=? ORDER BY created",
      f.profile,
    );
    // O contrato novo nasceu (e foi ele que limpou os antigos).
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      id: "contrato-antigo",
      document: null,
      name: "",
    });
    expect(rows[1]).toMatchObject({
      id: "contrato-recente",
      document: "52998224725",
    });
    const docs = Object.fromEntries(
      (
        await all(
          env,
          "SELECT id,document FROM suporte_sessions WHERE id LIKE 'sessao-%'",
        )
      ).map((r) => [r.id, r.document]),
    );
    expect(docs).toEqual({
      "sessao-encerrada": null,
      // Ainda dentro dos 7 dias da confirmação pela equipe.
      "sessao-aguardando": CPF_EM_DIA,
      "sessao-velha": null,
    });
    expect(
      await one(
        env,
        "SELECT document,name FROM suporte_purchases WHERE id='compra-antiga'",
      ),
    ).toEqual({ document: null, name: "" });
  });
});

describe("M5: vincular pelo Suporte exige quem está atendendo", () => {
  it("atendente que não assumiu a conversa não vincula o telefone", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await payerEmDia(s, "5511983000001");
    const phone = "5511983000009";
    let c = await talk(f, "oi", phone);
    await startFlow(s.sctx, c, uid());
    c = await talk(f, CPF_EM_DIA, phone);
    const path = `/profiles/${f.profile}/suporte/conversations/${c.id}/link-phone`;
    const denied = await api(await bearer(f.member), path, "POST", {});
    expect(denied.status).toBe(403);
    expect(await situationByPhone(env, f.profile, phone)).toBeNull();
    await claim(f, f.member, c.id);
    expect((await api(await bearer(f.member), path, "POST", {})).status).toBe(
      200,
    );
    expect((await situationByPhone(env, f.profile, phone))?.status).toBe(
      "em_dia",
    );
  });
});

describe("B1: regra de grupos", () => {
  it("em grupo o pedido de humano é segurado, avisado uma vez e liberado só pela equipe", async () => {
    const s = await setupSuporte();
    const { f } = s;
    const first = await talk(f, "oi", "grupo-clientes");
    await exec(
      env,
      "UPDATE conversations SET chat_type='group',title='Clientes' WHERE id=?",
      first.id,
    );
    let c = await conversation(env, first.id, f.profile);
    // Mesmo com um pagador em dia no grupo, ninguém se identifica por todos.
    await payerEmDia(s, "5511984000001");
    for (let i = 0; i < 2; i++)
      await handoff(env, c, "Cliente pediu atendente.", null, undefined, true, {
        source: "keyword",
      });
    c = await conversation(env, c.id, f.profile);
    expect(c.state).not.toBe("waiting");
    expect(
      (await texts(c.id)).filter((m) => m.text === GROUP_REPLY),
    ).toHaveLength(1);
    const token = await bearer(f.admin);
    const pending = await (
      await api(token, `/profiles/${f.profile}/suporte/pending`)
    ).json<any>();
    expect(pending.data).toEqual([
      expect.objectContaining({ conversation_id: c.id, group: true }),
    ]);
    const status = await (
      await api(token, `/profiles/${f.profile}/suporte/conversations/${c.id}`)
    ).json<any>();
    expect(status).toMatchObject({ allowed: false, group_held: true });
    // A equipe libera o grupo como cortesia: a passagem segue.
    const res = await api(
      token,
      `/profiles/${f.profile}/suporte/conversations/${c.id}/courtesy`,
      "POST",
      { reason: "Grupo do contrato da Empresa Alfa", hours: 2 },
    );
    expect(res.status).toBe(200);
    c = await conversation(env, c.id, f.profile);
    expect(c.state).toBe("waiting");
    await exec(
      env,
      "UPDATE conversations SET state='ai',owner=NULL WHERE id=?",
      c.id,
    );
    c = await conversation(env, c.id, f.profile);
    await handoff(env, c, "Cliente pediu atendente.", null, undefined, true, {
      source: "keyword",
    });
    expect((await conversation(env, c.id, f.profile)).state).toBe("waiting");
  });
});

describe("M3, M6 e M7 no Suporte (base do núcleo)", () => {
  it("M3: chave só de mensagens não libera como cortesia nem encerra liberação", async () => {
    const s = await setupSuporte();
    const { f } = s;
    const c = await talk(f, "oi", "5511986000001");
    const path = `/profiles/${f.profile}/suporte/conversations/${c.id}/courtesy`;
    const chat = await application(f, [
      "conversations:read",
      "conversations:write",
    ]);
    const denied = await api(chat.token, path, "POST", { reason: "Bot pediu" });
    expect(denied.status).toBe(403);
    expect((await denied.json<any>()).error.code).toBe("missing_scope");
    expect(await releases(c.id)).toHaveLength(0);
    const erp = await application(f, [
      "conversations:read",
      "conversations:write",
      "billing:write",
    ]);
    const granted = await api(erp.token, path, "POST", {
      reason: "Contrato no ERP",
      hours: 2,
    });
    expect(granted.status).toBe(200);
    const end = `/profiles/${f.profile}/suporte/releases/${(await granted.json<any>()).id}/end`;
    expect((await api(chat.token, end, "POST", {})).status).toBe(403);
    expect((await api(erp.token, end, "POST", {})).status).toBe(200);
  });

  it("M6: aplicação sem contacts:read e notes:read não vê documento, telefone nem resumo", async () => {
    const s = await setupSuporte();
    const { f } = s;
    const phone = "5511986000002";
    let c = await talk(f, "oi", phone);
    await startFlow(s.sctx, c, uid());
    c = await talk(f, CPF_NOVO, phone);
    await tap(f, phone, "suporte:pkg:avulso", "Atendimento avulso");
    await talk(f, "Maria Souza", phone);
    await tap(f, phone, "suporte:method:pix", "Pix");
    await claim(f, f.member, c.id);
    await api(
      await bearer(f.member),
      `/profiles/${f.profile}/suporte/conversations/${c.id}/courtesy`,
      "POST",
      { reason: "Cliente antigo", hours: 1 },
    );
    const reader = await application(f, ["conversations:read"]);
    for (const path of [
      "purchases",
      "releases",
      "pending",
      `conversations/${c.id}`,
    ]) {
      const body = JSON.stringify(
        await (
          await api(reader.token, `/profiles/${f.profile}/suporte/${path}`)
        ).json<any>(),
      );
      expect(body, path).not.toContain("11144477735");
      expect(body, path).not.toContain(phone);
      expect(body, path).not.toContain("Cliente antigo");
      expect(body, path).not.toContain('"summary"');
    }
    const full = await application(f, [
      "conversations:read",
      "contacts:read",
      "notes:read",
    ]);
    const purchases = await (
      await api(full.token, `/profiles/${f.profile}/suporte/purchases`)
    ).json<any>();
    expect(purchases.data[0]).toMatchObject({
      document: "11144477735",
      phone,
    });
  });

  it("M7: conversa de integração com o telefone de um pagador em dia não passa nem se identifica", async () => {
    const s = await setupSuporte();
    const { f } = s;
    const payerPhone = "5511986000003";
    await payerEmDia(s, payerPhone);
    const appActor: Actor = {
      id: "app-integra",
      kind: "app",
      name: "Integração",
      role: "operator",
      profiles: [f.profile],
      scopes: ["conversations:read", "conversations:write"],
      bots: [],
      rate: 60,
      runLimit: 3,
    };
    await perform(
      env,
      appActor,
      f.profile,
      "conversation.create",
      { external_id: payerPhone, phone: payerPhone, text: "oi" },
      uid(),
    );
    const c = (await one(
      env,
      "SELECT * FROM conversations WHERE profile_id=? AND external_namespace=?",
      f.profile,
      "app:app-integra",
    )) as Conversation;
    expect(await handoffGate(s.sctx, c, now())).toMatchObject({
      allowed: false,
      reason: "payment_required",
    });
    await startFlow(s.sctx, c, uid());
    expect(await releases(c.id)).toHaveLength(0);
    expect(await lastText(c.id)).toContain("digite o CPF ou o CNPJ");
  });
});

describe("segunda conferência M5 e N2-5: datas da assinatura", () => {
  it("fim e início fora de hoje só por gerente; fim passado não deixa em dia", async () => {
    const s = await setupSuporte();
    const { f } = s;
    const root = `/profiles/${f.profile}/mensalidade`;
    const member = await bearer(f.member);
    const admin = await bearer(f.admin);
    const phone = "5511986000031";
    const created = await (
      await api(admin, `${root}/subscriptions`, "POST", {
        plan_id: s.plan.id,
        customer_name: "Prazo fixo",
        phone,
      })
    ).json<any>();
    // Atendente não põe fim (nem na criação, nem depois).
    expect(
      (
        await api(member, `${root}/subscriptions/${created.id}`, "PATCH", {
          end_date: "2099-01-01",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(member, `${root}/subscriptions`, "POST", {
          plan_id: s.plan.id,
          customer_name: "Outro",
          phone: "5511986000032",
          end_date: "2099-01-01",
        })
      ).status,
    ).toBe(403);
    // N2-5: integração com conversations:write não cria assinatura
    // retroativa no pagador de outra pessoa.
    const integration = await application(f, [
      "conversations:read",
      "conversations:write",
    ]);
    const payer = await one(
      env,
      "SELECT payer_id FROM mensalidade_subscriptions WHERE id=?",
      created.id,
    );
    expect(
      (
        await api(integration.token, `${root}/subscriptions`, "POST", {
          plan_id: s.plan.id,
          customer_name: "Retroativa",
          payer_id: payer.payer_id,
          start_date: "2025-01-01",
        })
      ).status,
    ).toBe(403);
    // Com uma parcela paga, em dia; com o fim já passado, não mais.
    await runDue(modulesApi(env, f.profile, "mensalidade"), now());
    const inst = await one(
      env,
      "SELECT id FROM mensalidade_installments WHERE subscription_id=?",
      created.id,
    );
    await perform(
      env,
      f.admin,
      f.profile,
      "mensalidade.installment.pay",
      { id: inst.id },
      uid(),
    );
    const c = await talk(f, "oi", phone);
    expect(await handoffGate(s.sctx, c, now())).toMatchObject({
      allowed: true,
    });
    await exec(
      env,
      "UPDATE mensalidade_subscriptions SET start_date='2025-01-01',end_date='2025-06-30' WHERE id=?",
      created.id,
    );
    expect((await situationByPhone(env, f.profile, phone))?.status).not.toBe(
      "em_dia",
    );
    expect(await handoffGate(s.sctx, c, now())).toMatchObject({
      allowed: false,
    });
  });
});

describe("conferência M5 e N-2", () => {
  it("M5: assinatura sem parcela paga criada por atendente com o telefone de um conhecido não libera", async () => {
    const s = await setupSuporte();
    const { f } = s;
    const friend = "5511986000021";
    const member = await bearer(f.member);
    const root = `/profiles/${f.profile}/mensalidade`;
    const plan = s.plan;
    const future = new Date(Date.now() + 365 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    // Início no futuro por atendente: recusado (segunda conferência, M5).
    const future_ = await api(member, `${root}/subscriptions`, "POST", {
      plan_id: plan.id,
      customer_name: "Conhecido",
      phone: friend,
      start_date: future,
    });
    expect(future_.status).toBe(403);
    // Começando hoje, sem parcela paga: o portão segura.
    const created = await api(member, `${root}/subscriptions`, "POST", {
      plan_id: plan.id,
      customer_name: "Conhecido",
      phone: friend,
    });
    expect(created.status).toBe(200);
    expect((await situationByPhone(env, f.profile, friend))?.status).toBe(
      "em_dia",
    );
    const c = await talk(f, "oi", friend);
    expect(await handoffGate(s.sctx, c, now())).toMatchObject({
      allowed: false,
      reason: "payment_required",
    });
    // A mesma assinatura cadastrada pelo administrador libera.
    const byAdmin = await api(
      await bearer(f.admin),
      `${root}/subscriptions`,
      "POST",
      {
        plan_id: plan.id,
        customer_name: "Cliente do administrador",
        phone: "5511986000022",
      },
    );
    expect(byAdmin.status).toBe(200);
    const ok = await talk(f, "oi", "5511986000022");
    expect(await handoffGate(s.sctx, ok, now())).toMatchObject({
      allowed: true,
    });
  });

  it("N-2: confirmar quem digitou o documento de pagador em atraso não vincula o telefone", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, { menus: paidMenu });
    await payerEmAtraso(s, "5511986000031", CNPJ);
    const attacker = "5511986000039";
    await talk(f, "oi", attacker);
    await talk(f, "1", attacker);
    const c = await talk(f, CNPJ, attacker);
    await claim(f, f.member, c.id);
    const res = await api(
      await bearer(f.member),
      `/profiles/${f.profile}/suporte/conversations/${c.id}/confirm`,
      "POST",
      { link: true },
    );
    expect(res.status).toBe(409);
    expect(await situationByPhone(env, f.profile, attacker)).toBeNull();
  });
});

describe("conferência N-4: repetição do gancho conclui a liberação", () => {
  it("falha depois de gravar a liberação: a repetição publica, avisa e passa uma vez", async () => {
    const s = await setupSuporte();
    const { f, account } = s;
    const phone = "5511973000044";
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
    // O evento da liberação falha uma vez: sessão já "released", sem aviso.
    await exec(
      env,
      "CREATE TRIGGER IF NOT EXISTS falha_teste BEFORE INSERT ON events WHEN NEW.kind='suporte.released' BEGIN SELECT RAISE(ABORT,'falha simulada'); END",
    );
    try {
      await approve(account.id, payment.id);
    } finally {
      await exec(env, "DROP TRIGGER IF EXISTS falha_teste");
    }
    expect(
      (
        await one(
          env,
          "SELECT status FROM suporte_sessions WHERE id=?",
          session.id,
        )
      ).status,
    ).toBe("released");
    expect((await conversation(env, c.id, f.profile)).state).not.toBe(
      "waiting",
    );
    // Reenvio do webhook: o núcleo repete o gancho e a passagem conclui.
    await approve(account.id, payment.id);
    const released = await releases(c.id);
    expect(released).toHaveLength(1);
    expect(
      (
        await one(
          env,
          "SELECT COUNT(*) AS n FROM events WHERE profile_id=? AND kind='suporte.released'",
          f.profile,
        )
      ).n,
    ).toBe(1);
    expect(["waiting", "human"]).toContain(
      (await conversation(env, c.id, f.profile)).state,
    );
    expect(
      (
        await one(
          env,
          "SELECT COUNT(*) AS n FROM outbox WHERE conversation_id=? AND instr(dedupe,?)>0",
          c.id,
          `liberado:${released[0].id}`,
        )
      ).n,
    ).toBe(1);
  });
});

describe("B1: portão fail-closed e chave pela mensagem", () => {
  it("o Suporte declara failClosed e reprocessar a mesma mensagem não repete a pergunta", async () => {
    expect(gateFailsClosed("suporte")).toBe(true);
    const s = await setupSuporte();
    const { f } = s;
    const c = await talk(f, "oi", "5511986000004");
    const gate = handoffGatesList().find(([id]) => id === "suporte")![1];
    const request = {
      source: "keyword",
      reason: "Cliente pediu atendente.",
      department_id: null,
      summary: null,
      menu_item_id: null,
      row_id: "inbox-123",
    };
    expect(await gate(env, c, request)).toBe("hold");
    expect(await gate(env, c, request)).toBe("hold");
    const asked = (await texts(c.id)).filter((m) =>
      String(m.text).includes("digite o CPF ou o CNPJ"),
    );
    expect(asked).toHaveLength(1);
  });
});

describe("B10: LIKE escapado e listas IN dentro do D1", () => {
  it("filtros com % ou _, listas longas e limit fracionário não quebram nem casam tudo", async () => {
    const s = await setupSuporte();
    const { f } = s;
    const c = await talk(f, "oi", "5511987000001");
    await claim(f, f.member, c.id);
    await api(
      await bearer(f.member),
      `/profiles/${f.profile}/suporte/conversations/${c.id}/courtesy`,
      "POST",
      { reason: "Teste", hours: 1 },
    );
    const token = await bearer(f.admin);
    const base = `/profiles/${f.profile}/suporte`;
    const many = Array.from({ length: 150 }, (_, i) => `k${i}`).join(",");
    for (const path of [
      `releases?q=${encodeURIComponent("%")}`,
      `purchases?q=${encodeURIComponent("_")}`,
      `releases?kind=${many}&conversation_id=${many}&limit=2.5`,
      `purchases?status=${many}&limit=abc`,
    ]) {
      const res = await api(token, `${base}/${path}`);
      expect(res.status, path).toBe(200);
      expect((await res.json<any>()).data, path).toEqual([]);
    }
    const ok = await (
      await api(token, `${base}/releases?kind=courtesy,courtesy&limit=1.7`)
    ).json<any>();
    expect(ok.data).toHaveLength(1);
  });
});
