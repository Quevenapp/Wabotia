import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all } from "../src/db";
import { settings } from "../src/service";
import {
  PEDIDO_DEFAULTS,
  hoursText,
  pedidoConfig,
  storeState,
  validatePedidoConfig,
  whenLabel,
} from "../src/modules/pedido/model";
import { api, bearer, brasilia, configure } from "./service-center-fixture";
import { pedidoSetup, run } from "./pedido-fixture";

// Seg a sex 18:00–23:00; sábado 18:00–02:00 (passa da meia-noite); domingo
// almoço e jantar; 15/11/2026 é um domingo.
const hours = [
  ...[1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    start: "18:00",
    end: "23:00",
  })),
  { weekday: 6, start: "18:00", end: "02:00" },
  { weekday: 0, start: "11:00", end: "15:00" },
  { weekday: 0, start: "18:00", end: "00:00" },
];

describe("pedido: regras da loja", () => {
  it("valida a configuração estritamente", () => {
    expect(() => validatePedidoConfig({ cor: "azul" })).toThrow(
      /chave desconhecida cor/,
    );
    expect(() =>
      validatePedidoConfig({
        payments: { pix: false, link: false, cash: false, card: false },
      }),
    ).toThrow(/ao menos uma forma/);
    expect(() => validatePedidoConfig({ payments: { boleto: true } })).toThrow(
      /desconhecida boleto/,
    );
    expect(() =>
      validatePedidoConfig({
        hours: [{ weekday: 1, start: "8h", end: "18:00" }],
      }),
    ).toThrow(/HH:MM/);
    expect(() =>
      validatePedidoConfig({
        hours: [{ weekday: 7, start: "08:00", end: "18:00" }],
      }),
    ).toThrow(/dia da semana/);
    expect(() => validatePedidoConfig({ pickup: false })).toThrow(
      /retirada, entrega/,
    );
    expect(() => validatePedidoConfig({ delivery_fee_cents: 7.5 })).toThrow(
      /centavos/,
    );
    expect(() => validatePedidoConfig({ payment_minutes: 10 })).toThrow(
      /30 a 1440/,
    );
    const ok = validatePedidoConfig({
      hours,
      delivery: true,
      delivery_fee_cents: 700,
      payments: { pix: true, cash: true },
      texts: { preparing: "  Já estamos fazendo o pedido {numero}.  " },
    });
    expect(ok.payments).toEqual({
      pix: true,
      link: false,
      cash: true,
      card: true,
    });
    expect(ok.texts).toEqual({
      preparing: "Já estamos fazendo o pedido {numero}.",
    });
    expect(ok.hours![0]).toEqual({ weekday: 0, start: "11:00", end: "15:00" });
    const cfg = pedidoConfig({ pedido: ok });
    expect(cfg.texts.received).toBe(PEDIDO_DEFAULTS.texts.received);
    expect(cfg.alerts).toEqual(PEDIDO_DEFAULTS.alerts);
  });

  it("horário de funcionamento em Brasília, com faixa que passa da meia-noite", () => {
    const cfg = pedidoConfig({ pedido: { hours } });
    // Domingo 15/11 às 12:00: almoço aberto até 15:00.
    const lunch = storeState(cfg, brasilia(2026, 11, 15, 12));
    expect(lunch).toMatchObject({ open: true, reason: "open" });
    expect(lunch.closes_at).toBe(brasilia(2026, 11, 15, 15));
    // Domingo 16:00: fechado, abre hoje às 18:00.
    const between = storeState(cfg, brasilia(2026, 11, 15, 16));
    expect(between).toMatchObject({ open: false, reason: "closed" });
    expect(between.opens_at).toBe(brasilia(2026, 11, 15, 18));
    expect(whenLabel(between.opens_at!, brasilia(2026, 11, 15, 16))).toBe(
      "hoje às 18:00",
    );
    // Domingo 23:59 aberto (fim 00:00 é meia-noite); segunda 00:30 fechado.
    expect(storeState(cfg, brasilia(2026, 11, 15, 23, 59)).open).toBe(true);
    const monday = storeState(cfg, brasilia(2026, 11, 16, 0, 30));
    expect(monday.open).toBe(false);
    expect(whenLabel(monday.opens_at!, brasilia(2026, 11, 16, 0, 30))).toBe(
      "hoje às 18:00",
    );
    // Sábado 21/11 às 23:30 e domingo 22/11 à 01:30: a faixa de sábado vale.
    expect(storeState(cfg, brasilia(2026, 11, 21, 23, 30)).open).toBe(true);
    const late = storeState(cfg, brasilia(2026, 11, 22, 1, 30));
    expect(late.open).toBe(true);
    expect(late.closes_at).toBe(brasilia(2026, 11, 22, 2));
    expect(storeState(cfg, brasilia(2026, 11, 22, 2, 30)).open).toBe(false);
    // Sexta 23:10: fechado até sábado 18:00 ("amanhã").
    const friday = storeState(cfg, brasilia(2026, 11, 20, 23, 10));
    expect(whenLabel(friday.opens_at!, brasilia(2026, 11, 20, 23, 10))).toBe(
      "amanhã às 18:00",
    );
    // Pausa manual vence o horário; sem horário, aberta.
    expect(storeState(cfg, brasilia(2026, 11, 15, 12), true)).toMatchObject({
      open: false,
      reason: "paused",
    });
    expect(storeState(pedidoConfig({}), brasilia(2026, 11, 15, 4)).open).toBe(
      true,
    );
    expect(hoursText(cfg)).toBe(
      "Seg a sex: 18:00 às 23:00\nSáb: 18:00 às 02:00\nDom: 11:00 às 15:00 e 18:00 às 00:00",
    );
  });

  it("regras salvas em PUT /settings, situação da loja e pausa pela equipe", async () => {
    const { f } = await pedidoSetup();
    const member = await bearer(f.member);
    const first = await (
      await api(member, `/profiles/${f.profile}/pedido`)
    ).json<any>();
    expect(first.config).toEqual(PEDIDO_DEFAULTS);
    expect(first.store).toMatchObject({
      open: true,
      reason: "open",
      paused: false,
    });
    // Sem Cobrança configurada, só dinheiro e maquininha.
    expect(first.payments).toEqual({
      online_ready: false,
      offered: ["cash", "card"],
    });

    await configure(f, {
      pedido: {
        store_name: "Lanchonete da Ana",
        delivery: true,
        delivery_fee_cents: 700,
        minimum_cents: 2000,
        payments: { pix: true, link: true, cash: true, card: false },
      },
    });
    expect((await settings(env, f.profile)).pedido.store_name).toBe(
      "Lanchonete da Ana",
    );
    // Configuração inválida não é salva.
    const bad = await api(
      await bearer(f.admin),
      `/profiles/${f.profile}/settings`,
      "PUT",
      { pedido: { delivery_fee_cents: -1 } },
    );
    expect(bad.status).toBe(400);
    // Cobrança configurada: Pix e link passam a ser oferecidos.
    await run(f, f.admin, "payment.account.save", {
      provider: "mercadopago",
      access_token: "APP_USR-token-de-teste",
      webhook_secret: "segredo-do-webhook",
      payer_email: "pagamentos@loja.example.com",
    });
    const ready = await (
      await api(member, `/profiles/${f.profile}/pedido`)
    ).json<any>();
    expect(ready.payments).toEqual({
      online_ready: true,
      offered: ["pix", "link", "cash"],
    });

    // Pausa: qualquer pessoa da equipe.
    const paused = await api(
      member,
      `/profiles/${f.profile}/pedido/store/pause`,
      "POST",
      { paused: true, message: "Voltamos às 19h." },
    );
    expect(paused.status).toBe(200);
    expect(await paused.json<any>()).toMatchObject({
      open: false,
      reason: "paused",
      paused: true,
      pause_message: "Voltamos às 19h.",
      paused_by: f.member.id,
    });
    const view = await (
      await api(member, `/profiles/${f.profile}/pedido`)
    ).json<any>();
    expect(view.store.message).toContain("não estamos recebendo pedidos");
    expect(view.store.message).toContain("Voltamos às 19h.");
    await run(f, f.member, "pedido.store.pause", { paused: false });
    expect(
      await all(
        env,
        "SELECT id FROM events WHERE profile_id=? AND kind='pedido.store_changed'",
        f.profile,
      ),
    ).toHaveLength(2);
  });
});
