import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { defaults, json, now, uid } from "../src/types";
import { conversation, openTicket, perform, settings } from "../src/service";
import { protocolDueAt, formatBrasilia } from "../src/business-time";
import { lookupProtocols, sendProtocolLookup } from "../src/protocol-lookup";
import {
  defaultProtocolConfirmation,
  protocolConfirmation,
  renderProtocolConfirmation,
} from "../src/protocols";
import {
  api,
  bearer,
  brasilia,
  claim,
  configure,
  fixture,
  latest,
  receive,
  type Fixture,
} from "./service-center-fixture";

const categories = [
  { id: "printher", name: "Printher" },
  { id: "nfse-leve", name: "NFS-e Leve", enabled: true },
  { id: "antigo", name: "Aplicativo antigo", enabled: false },
];
async function claimed(f: Fixture) {
  const c = await receive(f, f.line, "pedido");
  await claim(f, f.member, c.id);
  return conversation(env, c.id, f.profile);
}
const create = (f: Fixture, body: any) =>
  perform(env, f.member, f.profile, "ticket.create", body, uid());
const update = (f: Fixture, id: string, body: any) =>
  perform(env, f.member, f.profile, "ticket.update", { id, ...body }, uid());

describe("mensagem de confirmação do protocolo", () => {
  const values = {
    numero: "WA-ABC123-1A2B",
    assunto: "Erro ao emitir nota",
    aplicativo: "NFS-e Leve",
    prazo: "17/11/2026 às 09:00",
  };
  it("preenche os quatro marcadores do texto padrão", () => {
    expect(renderProtocolConfirmation(defaultProtocolConfirmation, values))
      .toBe(`Sua solicitação foi registrada.

Protocolo: WA-ABC123-1A2B
Aplicativo: NFS-e Leve
Assunto: Erro ao emitir nota

Primeira resposta da equipe: até 17/11/2026 às 09:00, no horário de Brasília.

Vamos analisar o que você informou. Se precisarmos de mais detalhes, entraremos em contato por este atendimento. A previsão de solução será informada após a análise.

Para acompanhar, envie MEUS PROTOCOLOS.`);
  });
  it("omite inteira a linha cujo marcador não tem valor, sem deixar buracos", () => {
    const text = renderProtocolConfirmation(defaultProtocolConfirmation, {
      ...values,
      aplicativo: "",
      prazo: "",
    });
    expect(text).toBe(`Sua solicitação foi registrada.

Protocolo: WA-ABC123-1A2B
Assunto: Erro ao emitir nota

Vamos analisar o que você informou. Se precisarmos de mais detalhes, entraremos em contato por este atendimento. A previsão de solução será informada após a análise.

Para acompanhar, envie MEUS PROTOCOLOS.`);
    expect(text).not.toMatch(/\n{3}/);
  });
  it("aceita texto próprio, marcador repetido e mantém chaves desconhecidas", () => {
    expect(
      renderProtocolConfirmation(
        "Recebemos {numero} ({aplicativo}).\r\n{numero}: {assunto}\nPrazo {prazo} | {setor}\nAté logo {nome}!",
        { ...values, prazo: "" },
      ),
    ).toBe(
      "Recebemos WA-ABC123-1A2B (NFS-e Leve).\nWA-ABC123-1A2B: Erro ao emitir nota\nAté logo {nome}!",
    );
    // Blank or missing text falls back to the default.
    for (const blank of ["", "   ", undefined, null])
      expect(renderProtocolConfirmation(blank, values)).toContain(
        "Sua solicitação foi registrada.",
      );
  });
  it("monta os valores do protocolo: nome da categoria, id quando ela foi removida e prazo em Brasília", () => {
    const ticket = {
      number: "WA-1",
      title: "Assunto",
      category: "printher",
      response_due_at: brasilia(2026, 11, 17, 9),
    };
    const text = protocolConfirmation(
      { ...defaults, ticket_categories: categories },
      ticket,
    );
    expect(text).toContain("Aplicativo: Printher");
    expect(text).toContain("até 17/11/2026 às 09:00, no horário de Brasília.");
    expect(protocolConfirmation(defaults, ticket)).toContain(
      "Aplicativo: printher",
    );
    const bare = protocolConfirmation(defaults, {
      ...ticket,
      category: null,
      response_due_at: null,
    });
    expect(bare).not.toContain("Aplicativo");
    expect(bare).not.toContain("Primeira resposta");
  });
});

describe("configurações da central", () => {
  it("mantém os padrões da 0.13 para quem não usa os recursos novos", async () => {
    const f = await fixture();
    expect(await settings(env, f.profile)).toMatchObject({
      protocol_response_unit: "hours",
      protocol_response_hours: 24,
      protocol_response_days: 3,
      business_hours: {
        days: [1, 2, 3, 4, 5],
        start: "09:00",
        end: "18:00",
        holidays: [],
      },
      ticket_categories: [],
      protocol_confirmation: defaultProtocolConfirmation,
    });
    // An area saved by 0.13 has none of the new keys stored.
    await exec(
      env,
      "UPDATE profiles SET settings=? WHERE id=?",
      JSON.stringify({ menus: [], apps: [], protocol_response_hours: 48 }),
      f.profile,
    );
    const saved = await configure(f, { surveys_enabled: true });
    expect(saved).toMatchObject({
      protocol_response_unit: "hours",
      protocol_response_hours: 48,
      ticket_categories: [],
    });
    const c = await claimed(f);
    const ticket = await openTicket(env, c, f.member.id, "Pedido");
    expect(ticket.response_due_at).toBe(ticket.created + 48 * 3600000);
  });
  it("valida unidade, dias, horário, categorias e confirmação", async () => {
    const f = await fixture();
    const wrong: any[] = [
      { protocol_response_unit: "weeks" },
      { protocol_response_days: 0 },
      { protocol_response_days: 61 },
      { protocol_response_days: 2.5 },
      { protocol_response_days: "3" },
      { business_hours: "09:00-18:00" },
      { business_hours: { days: [] } },
      { business_hours: { days: [0, 7] } },
      { business_hours: { start: "19:00" } },
      { business_hours: { end: "9h" } },
      { business_hours: { holidays: ["2026-13-01"] } },
      {
        business_hours: {
          holidays: Array.from(
            { length: 101 },
            (_, i) => `2027-01-${String((i % 28) + 1).padStart(2, "0")}`,
          ),
        },
      },
      { ticket_categories: "printher" },
      { ticket_categories: [{ id: "com espaço", name: "X" }] },
      { ticket_categories: [{ id: "a", name: "" }] },
      {
        ticket_categories: [
          { id: "a", name: "A" },
          { id: "a", name: "B" },
        ],
      },
      { ticket_categories: [{ id: "a", name: "A", enabled: "sim" }] },
      {
        ticket_categories: Array.from({ length: 51 }, (_, i) => ({
          id: "c" + i,
          name: "C" + i,
        })),
      },
      { protocol_confirmation: "x".repeat(1501) },
      { protocol_confirmation: 5 },
    ];
    for (const body of wrong)
      await expect(configure(f, body), JSON.stringify(body)).rejects.toThrow();
    expect((await settings(env, f.profile)).ticket_categories).toEqual([]);
  });
  it("salva horário parcial preservando o restante e restaura a confirmação em branco", async () => {
    const f = await fixture();
    await configure(f, {
      protocol_response_unit: "business_days",
      protocol_response_days: 5,
      business_hours: { days: [6, 1, 2], holidays: ["2026-12-25"] },
      ticket_categories: categories,
      protocol_confirmation: "Protocolo {numero} aberto.",
    });
    let saved = await configure(f, { business_hours: { start: "08:00" } });
    expect(saved.business_hours).toEqual({
      days: [1, 2, 6],
      start: "08:00",
      end: "18:00",
      holidays: ["2026-12-25"],
    });
    expect(saved).toMatchObject({
      protocol_response_unit: "business_days",
      protocol_response_days: 5,
      protocol_confirmation: "Protocolo {numero} aberto.",
    });
    expect(saved.ticket_categories).toEqual([
      { id: "printher", name: "Printher", enabled: true },
      { id: "nfse-leve", name: "NFS-e Leve", enabled: true },
      { id: "antigo", name: "Aplicativo antigo", enabled: false },
    ]);
    saved = await configure(f, { protocol_confirmation: "  " });
    expect(saved.protocol_confirmation).toBe(defaultProtocolConfirmation);
    // Only an administrator changes the settings.
    await expect(
      perform(
        env,
        f.member,
        f.profile,
        "settings",
        { protocol_response_days: 9 },
        uid(),
      ),
    ).rejects.toThrow("administradores");
  });
  it("a abertura usa dias úteis e mudar a configuração não recalcula protocolos abertos", async () => {
    const f = await fixture();
    const config = {
      protocol_response_unit: "business_days",
      protocol_response_days: 2,
      business_hours: {
        days: [1, 2, 3, 4, 5],
        start: "09:00",
        end: "18:00",
        holidays: [],
      },
    };
    await configure(f, config);
    const c = await claimed(f);
    const ticket = await openTicket(env, c, f.member.id, "Pedido");
    expect(ticket.response_due_at).toBe(protocolDueAt(ticket.created, config));
    expect(ticket.response_due_at - ticket.created).toBeGreaterThanOrEqual(
      2 * 86400000,
    );
    // The deadline never falls outside the configured days and hours.
    const local = new Date(ticket.response_due_at - 3 * 3600000);
    expect([1, 2, 3, 4, 5]).toContain(local.getUTCDay());
    expect(local.getUTCHours()).toBeGreaterThanOrEqual(9);
    expect(local.getUTCHours()).toBeLessThan(18);
    await configure(f, {
      protocol_response_unit: "hours",
      protocol_response_hours: 1,
    });
    expect(
      (
        await one(
          env,
          "SELECT response_due_at d FROM tickets WHERE id=?",
          ticket.id,
        )
      ).d,
    ).toBe(ticket.response_due_at);
    const next = await openTicket(env, c, f.member.id, "Outro");
    expect(next.response_due_at).toBe(next.created + 3600000);
    await configure(f, { protocol_response_hours: null });
    expect(
      (await openTicket(env, c, f.member.id, "Sem prazo")).response_due_at,
    ).toBeNull();
  });
});

describe("categoria do protocolo", () => {
  it("POST aceita categoria habilitada ou nula e recusa desconhecida ou desabilitada", async () => {
    const f = await fixture();
    await configure(f, { ticket_categories: categories });
    const c = await claimed(f);
    const body = { conversation_id: c.id, title: "Pedido" };
    expect((await create(f, { ...body, category: "printher" })).category).toBe(
      "printher",
    );
    expect((await create(f, { ...body, category: null })).category).toBeNull();
    expect((await create(f, body)).category).toBeNull();
    for (const category of ["outro", "antigo", "", 7, ["printher"]])
      await expect(create(f, { ...body, category })).rejects.toMatchObject({
        status: 400,
        message: "Categoria de protocolo desconhecida.",
      });
    const created = await one(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='ticket.created' ORDER BY id LIMIT 1",
      f.profile,
    );
    expect(json(created.payload).category).toBe("printher");
  });
  it("PATCH troca, remove e valida a categoria, e o evento informa a mudança", async () => {
    const f = await fixture();
    await configure(f, { ticket_categories: categories });
    const c = await claimed(f);
    const ticket = await create(f, { conversation_id: c.id, title: "Pedido" });
    expect(
      (await update(f, ticket.id, { category: "nfse-leve" })).category,
    ).toBe("nfse-leve");
    const changed = await one(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='ticket.updated' ORDER BY id DESC LIMIT 1",
      f.profile,
    );
    expect(json(changed.payload)).toMatchObject({
      category: "nfse-leve",
      previous_category: null,
      status: "open",
    });
    // Other updates keep it; unknown and disabled values are refused.
    expect(
      (await update(f, ticket.id, { status: "in_progress" })).category,
    ).toBe("nfse-leve");
    for (const category of ["outro", "antigo", ""])
      await expect(update(f, ticket.id, { category })).rejects.toMatchObject({
        status: 400,
      });
    expect(
      (await update(f, ticket.id, { category: null })).category,
    ).toBeNull();
  });
  it("remover a categoria das configurações não altera protocolos antigos", async () => {
    const f = await fixture();
    await configure(f, { ticket_categories: categories });
    const c = await claimed(f);
    const ticket = await create(f, {
      conversation_id: c.id,
      title: "Etiqueta cortada",
      category: "printher",
    });
    await sendProtocolLookup(env, c, undefined, uid());
    expect((await latest(c.id)).text).toContain(
      `${ticket.number} · Recebido\nAplicativo: Printher\nEtiqueta cortada`,
    );
    await configure(f, { ticket_categories: [] });
    expect(
      (await one(env, "SELECT category FROM tickets WHERE id=?", ticket.id))
        .category,
    ).toBe("printher");
    expect((await lookupProtocols(env, c))[0].category).toBe("printher");
    // The customer sees the stored id; resending it in a PATCH is accepted.
    await sendProtocolLookup(env, c, undefined, uid());
    expect((await latest(c.id)).text).toContain("Aplicativo: printher");
    expect(
      (await update(f, ticket.id, { category: "printher", status: "resolved" }))
        .status,
    ).toBe("resolved");
    await expect(
      create(f, { conversation_id: c.id, title: "Novo", category: "printher" }),
    ).rejects.toThrow("Categoria");
  });
  it("as rotas HTTP gravam, devolvem e filtram a categoria", async () => {
    const f = await fixture();
    await configure(f, { ticket_categories: categories });
    const c = await claimed(f),
      token = await bearer(f.member),
      base = `/profiles/${f.profile}/tickets`;
    const refused = await api(token, base, "POST", {
      conversation_id: c.id,
      title: "Pedido",
      category: "outro",
    });
    expect(refused.status).toBe(400);
    const opened = await api(token, base, "POST", {
      conversation_id: c.id,
      title: "Pedido",
      category: "printher",
    });
    expect(opened.status).toBe(200);
    const ticket = await opened.json<any>();
    expect(ticket.category).toBe("printher");
    const patched = await api(token, `${base}/${ticket.id}`, "PATCH", {
      category: "nfse-leve",
      status: "waiting_third",
    });
    expect(await patched.json<any>()).toMatchObject({
      category: "nfse-leve",
      status: "waiting_third",
    });
    const detail = await (await api(token, `${base}/${ticket.id}`)).json<any>();
    expect(detail.ticket).toMatchObject({
      category: "nfse-leve",
      status: "waiting_third",
    });
    const filtered = await (
      await api(token, `${base}?category=nfse-leve&active=1`)
    ).json<any>();
    expect(filtered.data.map((row: any) => row.id)).toEqual([ticket.id]);
    expect(
      (await (await api(token, `${base}?category=printher`)).json<any>()).data,
    ).toEqual([]);
    expect(
      await all(env, "SELECT id FROM outbox WHERE conversation_id=?", c.id),
    ).toHaveLength(0);
    expect(formatBrasilia(now())).toMatch(
      /^\d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}$/,
    );
  });
});
