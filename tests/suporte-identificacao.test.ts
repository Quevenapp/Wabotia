import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, one } from "../src/db";
import { conversation } from "../src/service";
import { now, uid } from "../src/types";
import { startFlow } from "../src/modules/suporte/flow";
import { handoffGate } from "../src/modules/suporte/handoff";
import { situationByPhone } from "../src/modules/mensalidade/public";
import {
  api,
  bearer,
  bot,
  claim,
  configure,
  receive,
  drain,
} from "./service-center-fixture";
import { useMercadoPago } from "./mensalidade-mp";
import {
  CNPJ,
  CPF_EM_DIA,
  eventsOf,
  lastText,
  payerEmDia,
  releases,
  setupSuporte,
  talk,
  texts,
  turnModule,
} from "./suporte-fixture";

useMercadoPago();

describe("suporte: módulo desligado", () => {
  it("vem desligado: rotas 409 e o item some do menu", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await configure(f, {
      menus: [
        { id: "atendente", label: "Falar com atendente", type: "submenu" },
        {
          id: "pago",
          label: "Atendimento humano (pago)",
          type: "suporte_humano",
          parent_id: "atendente",
        },
        { id: "humano", label: "Outro assunto", type: "human" },
      ],
    });
    await turnModule(f, "suporte", false);
    const token = await bearer(f.admin);
    const res = await api(token, `/profiles/${f.profile}/suporte/releases`);
    expect(res.status).toBe(409);
    expect((await res.json<any>()).error.code).toBe("module_disabled");
    const c = await talk(f, "oi", "5511970000001");
    const menu = await lastText(c.id);
    expect(menu).toContain("Outro assunto");
    expect(menu).not.toContain("Falar com atendente");
  });
});

describe("suporte: identificação pelo telefone", () => {
  it("Falar com atendente → Atendimento humano (pago): pagador em dia passa para a equipe", async () => {
    const s = await setupSuporte();
    const { f } = s;
    const assistant = await bot(f);
    await configure(f, {
      menus: [
        { id: "atendente", label: "Falar com atendente", type: "submenu" },
        {
          id: "ia",
          label: "Falar com a IA (grátis)",
          type: "bot",
          bot_id: assistant,
          parent_id: "atendente",
        },
        {
          id: "pago",
          label: "Atendimento humano (pago)",
          type: "suporte_humano",
          parent_id: "atendente",
        },
      ],
    });
    const phone = "5511970000002";
    await payerEmDia(s, phone);
    await talk(f, "oi", phone);
    let c = await talk(f, "1", phone);
    const submenu = await lastText(c.id);
    expect(submenu).toContain("Falar com a IA (grátis)");
    const option = /(\d+)\. Atendimento humano \(pago\)/.exec(submenu)![1];
    c = await talk(f, option, phone);
    const [row] = await releases(c.id);
    expect(row).toMatchObject({
      kind: "subscription",
      phone_linked: 1,
      payer_name: "Empresa Alfa",
      actor: "system",
      status: "active",
      until_ticket: 1,
    });
    expect(row.summary).toContain(
      "Suporte pago: Assinatura em dia (Suporte Mensal).",
    );
    expect(row.summary).toContain("Pagador: Empresa Alfa · 529.982.247-25.");
    expect(c.state).toBe("waiting");
    const all_ = (await texts(c.id)).map((m) => m.text).join("\n");
    expect(all_).toContain("Tudo certo! Vamos chamar um atendente para você.");
    expect(await eventsOf(f, "suporte.identified")).toEqual([
      expect.objectContaining({
        matched_by: "phone",
        status: "em_dia",
        phone_linked: true,
      }),
    ]);
    expect(await handoffGate(s.sctx, c, now())).toMatchObject({
      allowed: true,
      reason: "released",
    });
  });
});

describe("suporte: identificação pelo CPF ou CNPJ", () => {
  it("documento inválido conta tentativas e para na terceira", async () => {
    const s = await setupSuporte();
    const { f } = s;
    const phone = "5511970000003";
    let c = await talk(f, "oi", phone);
    await startFlow(s.sctx, c, uid());
    expect(await lastText(c.id)).toContain(
      "digite o CPF ou o CNPJ de quem paga",
    );
    c = await talk(f, "123.456.789-00", phone);
    expect(await lastText(c.id)).toContain(
      "CPF ou CNPJ inválido. Confira os números e envie de novo (tentativa 2 de 3).",
    );
    c = await talk(f, "11.222.333/0001-82", phone);
    expect(await lastText(c.id)).toContain("(tentativa 3 de 3)");
    c = await talk(f, "abc", phone);
    expect(await lastText(c.id)).toContain(
      "Não conseguimos conferir o CPF ou CNPJ.",
    );
    expect(await eventsOf(f, "suporte.identification_failed")).toEqual([
      expect.objectContaining({ attempts: 3 }),
    ]);
    // Sessão encerrada: a próxima mensagem não é do Suporte.
    expect(
      await one(
        env,
        "SELECT status FROM suporte_sessions WHERE conversation_id=?",
        c.id,
      ),
    ).toEqual({ status: "closed" });
    expect(await releases(c.id)).toHaveLength(0);
  });

  it("CPF válido de telefone não vinculado: libera com aviso e o atendente vincula com um toque", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await payerEmDia(s, "5511970000004");
    const phone = "5511970000005";
    let c = await talk(f, "oi", phone);
    await startFlow(s.sctx, c, uid());
    c = await talk(f, "529.982.247-25", phone);
    const [row] = await releases(c.id);
    expect(row).toMatchObject({ kind: "subscription", phone_linked: 0 });
    expect(row.summary).toContain(
      "Atenção: telefone não vinculado ao pagador Empresa Alfa.",
    );
    const token = await bearer(f.member);
    const status = await (
      await api(token, `/profiles/${f.profile}/suporte/conversations/${c.id}`)
    ).json<any>();
    expect(status).toMatchObject({
      allowed: true,
      release: { kind: "subscription", phone_linked: false },
      unlinked_phone: { payer_name: "Empresa Alfa" },
    });
    expect(await situationByPhone(env, f.profile, phone)).toBeNull();
    const key = "vincular-" + uid();
    const linked = await api(
      token,
      `/profiles/${f.profile}/suporte/conversations/${c.id}/link-phone`,
      "POST",
      {},
      key,
    );
    expect(linked.status).toBe(200);
    expect((await linked.json<any>()).unlinked_phone).toBeNull();
    const replay = await api(
      token,
      `/profiles/${f.profile}/suporte/conversations/${c.id}/link-phone`,
      "POST",
      {},
      key,
    );
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await situationByPhone(env, f.profile, phone))?.status).toBe(
      "em_dia",
    );
    expect(await eventsOf(f, "suporte.phone_linked")).toHaveLength(1);
    // Vinculado: sem outro vínculo pendente.
    expect(
      (
        await api(
          token,
          `/profiles/${f.profile}/suporte/conversations/${c.id}/link-phone`,
          "POST",
          {},
        )
      ).status,
    ).toBe(409);
  });

  it("modo só telefone vinculado: vai para a equipe confirmar antes de liberar", async () => {
    const s = await setupSuporte({ identify: "linked_only" });
    const { f } = s;
    await payerEmDia(s, "5511970000006", CNPJ);
    const phone = "5511970000007";
    let c = await talk(f, "oi", phone);
    await startFlow(s.sctx, c, uid());
    c = await talk(f, "11222333000181", phone);
    expect(await releases(c.id)).toHaveLength(0);
    expect(c.state).toBe("waiting");
    expect((await texts(c.id)).map((m) => m.text).join("\n")).toContain(
      "Este número ainda não está autorizado para este CPF/CNPJ.",
    );
    expect(await eventsOf(f, "suporte.awaiting_team")).toHaveLength(1);
    const status = await (
      await api(
        await bearer(f.admin),
        `/profiles/${f.profile}/suporte/conversations/${c.id}`,
      )
    ).json<any>();
    expect(status).toMatchObject({
      allowed: false,
      awaiting_team: true,
      release: null,
    });
    // A equipe confirma: vincula o telefone e libera.
    await claim(f, f.member, c.id);
    const token = await bearer(f.member);
    const confirmed = await (
      await api(
        token,
        `/profiles/${f.profile}/suporte/conversations/${c.id}/confirm`,
        "POST",
        {},
      )
    ).json<any>();
    expect(confirmed).toMatchObject({
      kind: "team",
      phone_linked: true,
      actor: f.member.id,
    });
    expect((await situationByPhone(env, f.profile, phone))?.status).toBe(
      "em_dia",
    );
  });
});

describe("suporte: cortesia e regra de passagem", () => {
  it("atendente libera como cortesia com motivo; repetir a Idempotency-Key devolve a mesma", async () => {
    const s = await setupSuporte();
    const { f } = s;
    const c = await receive(f, f.line, "preciso de ajuda", "5511970000008");
    await drain(f);
    const convo = await conversation(env, c.id, f.profile);
    expect(await handoffGate(s.sctx, convo, now())).toEqual({
      allowed: false,
      reason: "payment_required",
    });
    const token = await bearer(f.member);
    const path = `/profiles/${f.profile}/suporte/conversations/${c.id}/courtesy`;
    // Sem assumir a conversa: recusado.
    expect(
      (await api(token, path, "POST", { reason: "Cliente antigo" })).status,
    ).toBe(403);
    await claim(f, f.member, c.id);
    expect((await api(token, path, "POST", {})).status).toBe(400);
    const key = "cortesia-" + uid();
    const first = await (
      await api(
        token,
        path,
        "POST",
        { reason: "Cliente antigo, falha nossa", hours: 2 },
        key,
      )
    ).json<any>();
    expect(first).toMatchObject({
      kind: "courtesy",
      reason: "Cliente antigo, falha nossa",
      actor: f.member.id,
      until_ticket: false,
    });
    expect(first.valid_until).toBeGreaterThan(now() + 3_500_000);
    const replay = await api(
      token,
      path,
      "POST",
      { reason: "Cliente antigo, falha nossa", hours: 2 },
      key,
    );
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await releases(c.id)).toHaveLength(1);
    expect(
      await handoffGate(
        s.sctx,
        await conversation(env, c.id, f.profile),
        now(),
      ),
    ).toMatchObject({ allowed: true, reason: "released" });
    const list = await (
      await api(token, `/profiles/${f.profile}/suporte/releases?kind=courtesy`)
    ).json<any>();
    expect(list.data.map((r: any) => r.id)).toEqual([first.id]);
    expect(list.counts).toEqual({ courtesy: 1 });
    // Encerrar a liberação: só administrador.
    expect(
      (
        await api(
          token,
          `/profiles/${f.profile}/suporte/releases/${first.id}/end`,
          "POST",
          {},
        )
      ).status,
    ).toBe(403);
    const ended = await (
      await api(
        await bearer(f.admin),
        `/profiles/${f.profile}/suporte/releases/${first.id}/end`,
        "POST",
        {},
      )
    ).json<any>();
    expect(ended.status).toBe("ended");
    expect(CPF_EM_DIA).toBeTruthy();
  });
});
