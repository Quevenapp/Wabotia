import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { perform } from "../src/service";
import { json, now, uid } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { createOrder, quoteReplies } from "../src/modules/os/store";
import {
  endOfDayAfter,
  money,
  nextStatuses,
  phoneDigits,
  validateOsSettings,
} from "../src/modules/os/model";
import {
  api,
  application,
  bearer,
  configure,
  drain,
  fixture,
  latest,
  receive,
  type Fixture,
} from "./service-center-fixture";

const root = (f: Fixture) => `/profiles/${f.profile}/service-orders`;
const turn = (f: Fixture, enabled: boolean) =>
  perform(env, f.admin, f.profile, "module.set", { id: "os", enabled }, uid());

async function setup() {
  const f = await fixture();
  await turn(f, true);
  const c = await receive(f, f.line, "bom dia", "5511960000001");
  await drain(f);
  const token = await bearer(f.member);
  return { f, c, token };
}
async function open(token: string, f: Fixture, body: any, key = uid()) {
  const res = await api(token, root(f), "POST", body, key);
  return { res, body: await res.json<any>() };
}
const events = (f: Fixture, kind: string) =>
  all(
    env,
    "SELECT payload FROM events WHERE profile_id=? AND kind=? ORDER BY id",
    f.profile,
    kind,
  ).then((rows) => rows.map((r) => json(r.payload)));

describe("ordem de serviço: módulo desligado", () => {
  it("vem desligado; rotas respondem 409 e o menu esconde os itens", async () => {
    const f = await fixture();
    const token = await bearer(f.member);
    const list = await api(token, root(f));
    expect(list.status).toBe(409);
    expect((await list.json<any>()).error.code).toBe("module_disabled");
    const create = await api(token, root(f), "POST", {
      phone: "11999990000",
      item: "Celular",
      problem: "Tela quebrada",
    });
    expect(create.status).toBe(409);
    await turn(f, true);
    await configure(f, {
      menus: [
        { id: "abrir", label: "Abrir ordem de serviço", type: "os_open" },
        { id: "acompanhar", label: "Acompanhar ordem", type: "os_track" },
        { id: "humano", label: "Falar com atendente", type: "human" },
      ],
    });
    await turn(f, false);
    const c = await receive(f, f.line, "oi", "5511960000002");
    await drain(f);
    const menu = (await latest(c.id)).text as string;
    expect(menu).toContain("Falar com atendente");
    expect(menu).not.toContain("ordem");
    // Religado, os itens voltam.
    await turn(f, true);
    const again = await receive(f, f.line, "menu", "5511960000002");
    await drain(f);
    expect((await latest(again.id)).text).toContain("Abrir ordem de serviço");
    // Ação da conversa também responde 409 com o módulo desligado.
    await turn(f, false);
    const action = await api(
      token,
      `/profiles/${f.profile}/conversations/${c.id}/actions`,
      "POST",
      { action: "service_order", item: "X", problem: "Y" },
    );
    expect(action.status).toBe(409);
  });
});

describe("ordem de serviço: abertura e numeração", () => {
  it("abre pelo painel com telefone e pela conversa; repetir a Idempotency-Key devolve a mesma ordem", async () => {
    const { f, c, token } = await setup();
    const key = "abrir-" + uid();
    const payload = {
      customer_name: "João",
      phone: "(11) 98888-7777",
      item: "Notebook Dell",
      problem: "Não liga",
      notes: "Veio sem carregador",
    };
    const first = await open(token, f, payload, key);
    expect(first.res.status).toBe(200);
    expect(first.body).toMatchObject({
      number: 1,
      status: "received",
      status_label: "Recebida",
      source: "panel",
      customer: { name: "João", phone: "5511988887777", conversation_id: null },
      notes: "Veio sem carregador",
      next_statuses: ["analyzing", "in_progress", "cancelled"],
    });
    const replay = await api(token, root(f), "POST", payload, key);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await replay.json<any>()).id).toBe(first.body.id);
    expect(
      await all(env, "SELECT id FROM os_orders WHERE profile_id=?", f.profile),
    ).toHaveLength(1);

    // Pela conversa: ação "Abrir ordem de serviço", com aviso ao cliente.
    const action = await api(
      token,
      `/profiles/${f.profile}/conversations/${c.id}/actions`,
      "POST",
      {
        action: "service_order",
        item: "Celular Moto G",
        problem: "Tela quebrada",
      },
    );
    expect(action.status).toBe(200);
    const order = await action.json<any>();
    expect(order).toMatchObject({
      number: 2,
      source: "agent",
      customer: { conversation_id: c.id, phone: "5511960000001" },
    });
    const sent = await latest(c.id);
    expect(sent.text).toContain(
      "Ordem de serviço nº 2 aberta para Celular Moto G",
    );
    expect(sent.automation).toBe("os");
    expect((await events(f, "os.opened")).map((e) => e.number)).toEqual([1, 2]);

    // Detalhe com histórico.
    const detail = await (
      await api(token, `${root(f)}/${order.id}`)
    ).json<any>();
    expect(detail.history).toEqual([
      expect.objectContaining({
        kind: "opened",
        to_status: "received",
        actor: f.member.id,
      }),
    ]);
    // Validação.
    expect((await open(token, f, { item: "Só item" })).res.status).toBe(400);
    expect(
      (await open(token, f, { phone: "123", item: "a", problem: "b" })).res
        .status,
    ).toBe(400);
  });

  it("numera em sequência por área sob pedidos simultâneos", async () => {
    const { f } = await setup();
    const other = await fixture();
    await turn(other, true);
    const ctx = modulesApi(env, f.profile, "os");
    const created = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        createOrder(ctx, {
          phone: "5511970000" + String(i).padStart(3, "0"),
          item: "Item " + i,
          problem: "Problema",
          source: "api",
          sourceKey: "concorrente:" + uid(),
          actor: "app:teste",
        }),
      ),
    );
    const numbers = created.map((r) => r.order.number).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    // Outra área começa do 1.
    const first = await createOrder(modulesApi(env, other.profile, "os"), {
      phone: "5511970000999",
      item: "Bicicleta",
      problem: "Corrente",
      source: "api",
      sourceKey: "outra:" + uid(),
      actor: "app:teste",
    });
    expect(first.order.number).toBe(1);
    // Mesma chave em paralelo: uma ordem só.
    const key = "mesma:" + uid();
    const twice = await Promise.all(
      [1, 2].map(() =>
        createOrder(ctx, {
          phone: "5511970001000",
          item: "Relógio",
          problem: "Parado",
          source: "api",
          sourceKey: key,
          actor: "app:teste",
        }),
      ),
    );
    expect(new Set(twice.map((r) => r.order.id)).size).toBe(1);
  });

  it("lista com filtro por estado e busca", async () => {
    const { f, token } = await setup();
    const a = (
      await open(token, f, {
        phone: "11911112222",
        customer_name: "Ana Souza",
        item: "Geladeira",
        problem: "Não gela",
      })
    ).body;
    await open(token, f, {
      phone: "11933334444",
      item: "Bicicleta",
      problem: "Freio",
    });
    await api(token, `${root(f)}/${a.id}/status`, "POST", {
      status: "analyzing",
    });
    const byStatus = await (
      await api(token, `${root(f)}?status=analyzing`)
    ).json<any>();
    expect(byStatus.data.map((o: any) => o.id)).toEqual([a.id]);
    expect(byStatus.counts).toEqual({ analyzing: 1, received: 1 });
    const byName = await (await api(token, `${root(f)}?q=souza`)).json<any>();
    expect(byName.data.map((o: any) => o.number)).toEqual([1]);
    const byNumber = await (await api(token, `${root(f)}?q=2`)).json<any>();
    expect(byNumber.data.map((o: any) => o.number)).toEqual([2]);
    const byPhone = await (
      await api(token, `${root(f)}?phone=11933334444`)
    ).json<any>();
    expect(byPhone.data.map((o: any) => o.number)).toEqual([2]);
    const paged = await (await api(token, `${root(f)}?limit=1`)).json<any>();
    expect(paged).toMatchObject({ next_cursor: "2" });
    expect((await api(token, `${root(f)}?status=nada`)).status).toBe(400);
    expect((await api(token, `${root(f)}/nada`)).status).toBe(404);
  });
});

describe("ordem de serviço: estados e orçamento", () => {
  // Simula o gancho de resposta do núcleo (botões Aprovar/Recusar).
  beforeEach(() => {
    quoteReplies.wired = true;
  });
  afterEach(() => {
    quoteReplies.wired = false;
  });
  it("aceita transições válidas, recusa inválidas e guarda o histórico", async () => {
    const { f, c, token } = await setup();
    const action = await api(
      token,
      `/profiles/${f.profile}/conversations/${c.id}/actions`,
      "POST",
      { action: "service_order", item: "Celular", problem: "Bateria" },
    );
    const order = await action.json<any>();
    const status = (to: string, note?: string) =>
      api(token, `${root(f)}/${order.id}/status`, "POST", { status: to, note });
    // Inválidas.
    for (const to of ["delivered", "ready", "approved", "quoted", "nada"]) {
      const res = await status(to);
      expect(res.status, to).toBe(to === "nada" ? 400 : 409);
    }
    expect((await (await status("delivered")).json<any>()).error.code).toBe(
      "invalid_transition",
    );
    // Orçamento.
    expect(
      (await api(token, `${root(f)}/${order.id}/quote/send`, "POST", {}))
        .status,
    ).toBe(400);
    const quote = await api(token, `${root(f)}/${order.id}/quote`, "PUT", {
      items: [
        { description: "Bateria nova", unit_cents: 18000 },
        { description: "Película", quantity: 2, unit_cents: 2500 },
      ],
      valid_days: 3,
      note: "Peça original.",
    });
    expect(quote.status).toBe(200);
    expect((await quote.json<any>()).quote).toMatchObject({
      total_cents: 23000,
      valid_days: 3,
      sent_at: null,
      version: 0,
    });
    expect(
      (await api(token, `${root(f)}/${order.id}/quote`, "PUT", { items: [] }))
        .status,
    ).toBe(400);
    const sent = await (
      await api(token, `${root(f)}/${order.id}/quote/send`, "POST", {})
    ).json<any>();
    expect(sent).toMatchObject({ status: "quoted", quote: { version: 1 } });
    expect(sent.quote.valid_until).toBe(endOfDayAfter(sent.quote.sent_at, 3));
    const message = await latest(c.id);
    expect(message.text).toContain("Orçamento da ordem de serviço nº 1");
    expect(message.text).toContain("• 2 x Película: R$ 50,00 (R$ 25,00 cada)");
    expect(message.text).toContain("Total: R$ 230,00");
    expect(message.text).toContain("Peça original.");
    // Linha oficial: botões Aprovar e Recusar com a versão do orçamento.
    expect(
      message.content.interactive.action.buttons.map((b: any) => b.reply),
    ).toEqual([
      { id: `os:${order.id}:1:approve`, title: "Aprovar" },
      { id: `os:${order.id}:1:decline`, title: "Recusar" },
    ]);
    // Alterar o orçamento enviado volta para análise.
    const changed = await (
      await api(token, `${root(f)}/${order.id}/quote`, "PUT", {
        items: [{ description: "Bateria nova", unit_cents: 17000 }],
      })
    ).json<any>();
    expect(changed).toMatchObject({
      status: "analyzing",
      quote: { total_cents: 17000 },
    });
    await api(token, `${root(f)}/${order.id}/quote/send`, "POST", {});
    // Aprovação pela equipe (cliente ligou).
    const approved = await (
      await api(token, `${root(f)}/${order.id}/decision`, "POST", {
        decision: "approve",
        note: "Aprovou por telefone",
      })
    ).json<any>();
    expect(approved).toMatchObject({
      status: "approved",
      decision: { decision: "approved", by: f.member.id, via: "panel" },
    });
    expect((await status("ready")).status).toBe(409);
    for (const to of ["in_progress", "ready"])
      expect((await status(to)).status, to).toBe(200);
    expect((await latest(c.id)).text).toContain("está pronto para retirada");
    const delivered = await (
      await status("delivered", "Retirado pelo cliente")
    ).json<any>();
    expect(delivered.warranty_until).toBe(
      endOfDayAfter(delivered.delivered_at, 90),
    );
    expect((await latest(c.id)).text).toContain("entregue. Garantia: até ");
    expect((await status("in_progress")).status).toBe(409);
    const detail = await (
      await api(token, `${root(f)}/${order.id}`)
    ).json<any>();
    expect(
      detail.history.map((h: any) => [h.kind, h.from_status, h.to_status]),
    ).toEqual([
      ["opened", null, "received"],
      ["quote", "received", "received"],
      ["quote", "received", "quoted"],
      ["quote", "quoted", "analyzing"],
      ["quote", "analyzing", "quoted"],
      ["status", "quoted", "approved"],
      ["status", "approved", "in_progress"],
      ["status", "in_progress", "ready"],
      ["status", "ready", "delivered"],
    ]);
    expect(detail.history.at(-1)).toMatchObject({
      actor: f.member.id,
      note: "Retirado pelo cliente",
    });
    expect((await events(f, "os.status_changed")).map((e) => e.to)).toEqual([
      "quoted",
      "analyzing",
      "quoted",
      "approved",
      "in_progress",
      "ready",
      "delivered",
    ]);
    expect(await events(f, "os.quoted")).toHaveLength(2);
    expect(await events(f, "os.approved")).toHaveLength(1);
    expect(await events(f, "os.delivered")).toHaveLength(1);
    // Encerrada: só observações.
    expect(
      (await api(token, `${root(f)}/${order.id}`, "PATCH", { item: "Outro" }))
        .status,
    ).toBe(400);
    expect(
      (
        await (
          await api(token, `${root(f)}/${order.id}`, "PATCH", {
            notes: "Cliente satisfeito",
          })
        ).json<any>()
      ).notes,
    ).toBe("Cliente satisfeito");
  });

  it("orçamento vencido não pode ser aprovado", async () => {
    const { f, c, token } = await setup();
    const order = await (
      await api(
        token,
        `/profiles/${f.profile}/conversations/${c.id}/actions`,
        "POST",
        {
          action: "service_order",
          item: "TV",
          problem: "Sem imagem",
        },
      )
    ).json<any>();
    await api(token, `${root(f)}/${order.id}/quote`, "PUT", {
      items: [{ description: "Placa", unit_cents: 50000 }],
    });
    await api(token, `${root(f)}/${order.id}/quote/send`, "POST", {});
    await exec(
      env,
      "UPDATE os_orders SET quote_valid_until=? WHERE id=?",
      now() - 1000,
      order.id,
    );
    const late = await api(token, `${root(f)}/${order.id}/decision`, "POST", {
      decision: "approve",
    });
    expect(late.status).toBe(409);
    expect((await late.json<any>()).error.code).toBe("quote_expired");
    const detail = await (
      await api(token, `${root(f)}/${order.id}`)
    ).json<any>();
    expect(detail).toMatchObject({
      status: "quoted",
      quote: { expired: true },
    });
    // Novo envio renova a validade.
    await api(token, `${root(f)}/${order.id}/quote/send`, "POST", {});
    expect(
      (
        await api(token, `${root(f)}/${order.id}/decision`, "POST", {
          decision: "decline",
        })
      ).status,
    ).toBe(200);
  });

  it("permissões: aplicação precisa de conversations:write; outra área não alcança", async () => {
    const { f, token } = await setup();
    const reader = await application(f, ["conversations:read"]);
    expect((await api(reader.token, root(f))).status).toBe(200);
    expect(
      (
        await api(reader.token, root(f), "POST", {
          phone: "11999990000",
          item: "a",
          problem: "b",
        })
      ).status,
    ).toBe(403);
    const writer = await application(f, [
      "conversations:read",
      "conversations:write",
    ]);
    const made = await api(writer.token, root(f), "POST", {
      phone: "11999990000",
      item: "a",
      problem: "b",
    });
    expect(made.status).toBe(200);
    expect((await made.json<any>()).source).toBe("api");
    const outsider = await fixture();
    await turn(outsider, true);
    expect((await api(await bearer(outsider.member), root(f))).status).toBe(
      404,
    );
    expect(token).toBeTruthy();
  });
});

describe("ordem de serviço: regras puras", () => {
  it("dinheiro, telefone, próximos estados e configurações", () => {
    expect(money(123456)).toBe("R$ 1.234,56");
    expect(money(5)).toBe("R$ 0,05");
    expect(phoneDigits("(11) 98888-7777")).toBe("5511988887777");
    expect(phoneDigits("+55 11 98888-7777")).toBe("5511988887777");
    expect(nextStatuses("quoted", true)).toEqual([
      "analyzing",
      "cancelled",
      "quoted",
      "approved",
      "declined",
    ]);
    expect(nextStatuses("received", false)).toEqual([
      "analyzing",
      "in_progress",
      "cancelled",
    ]);
    expect(
      validateOsSettings({ warranty_days: 0, texts: { ready: " Pronto! " } }),
    ).toEqual({
      warranty_days: 0,
      texts: { ready: "Pronto!" },
    });
    expect(() => validateOsSettings({ outra: 1 })).toThrow(/desconhecida/);
    expect(() => validateOsSettings({ quote_valid_days: 0 })).toThrow(/1 a 90/);
    expect(() => validateOsSettings({ texts: { nada: "x" } })).toThrow(
      /desconhecida/,
    );
  });

  it("configuração salva em PUT /settings com validação estrita", async () => {
    const { f } = await setup();
    await configure(f, {
      service_orders: { quote_valid_days: 10, warranty_days: 30 },
    });
    const saved = await one(
      env,
      "SELECT settings FROM profiles WHERE id=?",
      f.profile,
    );
    expect(json(saved.settings).service_orders).toEqual({
      quote_valid_days: 10,
      warranty_days: 30,
    });
    await expect(
      configure(f, { service_orders: { stale_days: 0 } }),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
  });
});
