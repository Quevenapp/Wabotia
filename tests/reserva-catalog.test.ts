import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { perform } from "../src/service";
import { uid } from "../src/types";
import {
  defaultReservaConfig,
  depositFor,
  parseDate,
  reservaConfig,
  validateReservaConfig,
} from "../src/modules/reserva/config";
import { api, bearer, configure } from "./service-center-fixture";
import { future, reservaSetup } from "./reserva-fixture";

describe("reserva: módulo desligado", () => {
  it("vem desligado e as rotas e comandos respondem 409 module_disabled", async () => {
    const { f } = await reservaSetup({ enabled: false });
    const token = await bearer(f.admin);
    for (const [method, path, body] of [
      ["GET", "/reserva", undefined],
      ["GET", "/reserva/units", undefined],
      [
        "POST",
        "/reserva/units",
        { name: "Quarto", mode: "daily", price_cents: 1 },
      ],
      ["POST", "/reserva/blocks", { from_date: "2030-01-01" }],
    ] as const) {
      const res = await api(
        token,
        `/profiles/${f.profile}${path}`,
        method,
        body,
      );
      expect(res.status, path).toBe(409);
      expect((await res.json<any>()).error.code).toBe("module_disabled");
    }
    await expect(
      perform(
        env,
        f.admin,
        f.profile,
        "reserva.unit.save",
        { name: "X", mode: "daily", price_cents: 100 },
        uid(),
      ),
    ).rejects.toMatchObject({ code: "module_disabled" });
    const modules = await (
      await api(token, `/profiles/${f.profile}/modules`)
    ).json<any>();
    const reserva = modules.data.find((m: any) => m.id === "reserva");
    expect(reserva).toMatchObject({ enabled: false, default_enabled: false });
    expect(reserva.menu_item_types.map((t: any) => t.type)).toEqual([
      "reserva",
      "reserva_mine",
    ]);
  });
});

describe("reserva: cadastros", () => {
  it("unidades pela API: só administrador altera, com validação", async () => {
    const { f, mar, quadra } = await reservaSetup();
    const admin = await bearer(f.admin);
    const member = await bearer(f.member);
    const overview = await (
      await api(member, `/profiles/${f.profile}/reserva`)
    ).json<any>();
    expect(overview.config).toEqual(defaultReservaConfig);
    expect(overview.units.map((u: any) => u.name)).toEqual([
      "Suíte Mar",
      "Chalé Jardim",
      "Quadra de areia",
    ]);
    expect(mar).toMatchObject({ mode: "daily", capacity: 2, photos: [] });
    expect(quadra).toMatchObject({ mode: "hourly", price_cents: 8000 });

    const denied = await api(
      member,
      `/profiles/${f.profile}/reserva/units`,
      "POST",
      {
        name: "Salão",
        mode: "hourly",
        price_cents: 10000,
      },
    );
    expect(denied.status).toBe(403);

    for (const body of [
      { name: "", mode: "daily", price_cents: 100 },
      { name: "Salão", mode: "semanal", price_cents: 100 },
      { name: "Salão", mode: "hourly", price_cents: -1 },
      { name: "Salão", mode: "hourly", price_cents: 100, capacity: 0 },
      {
        name: "Salão",
        mode: "hourly",
        price_cents: 100,
        photos: ["http://x.test/a.jpg"],
      },
    ]) {
      const res = await api(
        admin,
        `/profiles/${f.profile}/reserva/units`,
        "POST",
        body,
      );
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    const salao = await (
      await api(admin, `/profiles/${f.profile}/reserva/units`, "POST", {
        name: "Salão de festas",
        kind: "hall",
        mode: "hourly",
        capacity: 80,
        price_cents: 25000,
        photos: ["https://fotos.example.com/salao.jpg"],
        description: "Com cozinha e churrasqueira.",
      })
    ).json<any>();
    expect(salao.photos).toEqual(["https://fotos.example.com/salao.jpg"]);
    const edited = await (
      await api(
        admin,
        `/profiles/${f.profile}/reserva/units/${salao.id}`,
        "PUT",
        {
          price_cents: 30000,
          active: false,
        },
      )
    ).json<any>();
    expect(edited).toMatchObject({
      name: "Salão de festas",
      price_cents: 30000,
      active: false,
      capacity: 80,
    });
    const removed = await api(
      admin,
      `/profiles/${f.profile}/reserva/units/${salao.id}`,
      "DELETE",
      {},
    );
    expect(removed.status).toBe(200);
    const units = await (
      await api(admin, `/profiles/${f.profile}/reserva/units`)
    ).json<any>();
    expect(units.data.some((u: any) => u.id === salao.id)).toBe(false);
  });

  it("bloqueios por datas inteiras ou por intervalo", async () => {
    const { f, mar } = await reservaSetup();
    const admin = await bearer(f.admin);
    const day = future(10);
    const block = await (
      await api(admin, `/profiles/${f.profile}/reserva/blocks`, "POST", {
        unit_id: mar.id,
        from_date: day,
        to_date: future(11),
        reason: "Pintura",
      })
    ).json<any>();
    expect(block).toMatchObject({
      unit_id: mar.id,
      from_date: day,
      to_date: future(11),
      reason: "Pintura",
    });
    const list = await (
      await api(
        admin,
        `/profiles/${f.profile}/reserva/blocks?from_date=${future(9)}&to_date=${future(12)}`,
      )
    ).json<any>();
    expect(list.data.map((b: any) => b.id)).toEqual([block.id]);
    const bad = await api(
      admin,
      `/profiles/${f.profile}/reserva/blocks`,
      "POST",
      {
        from_date: future(5),
        to_date: future(4),
      },
    );
    expect(bad.status).toBe(400);
    const gone = await api(
      admin,
      `/profiles/${f.profile}/reserva/blocks/${block.id}`,
      "DELETE",
      {},
    );
    expect(gone.status).toBe(200);
  });

  it("repetir a mesma Idempotency-Key não cria a unidade de novo", async () => {
    const { f } = await reservaSetup();
    const admin = await bearer(f.admin);
    const body = { name: "Quarto Duplo", mode: "daily", price_cents: 20000 };
    const key = uid();
    const first = await (
      await api(
        admin,
        `/profiles/${f.profile}/reserva/units`,
        "POST",
        body,
        key,
      )
    ).json<any>();
    const again = await (
      await api(
        admin,
        `/profiles/${f.profile}/reserva/units`,
        "POST",
        body,
        key,
      )
    ).json<any>();
    expect(again.id).toBe(first.id);
    const units = await (
      await api(admin, `/profiles/${f.profile}/reserva/units`)
    ).json<any>();
    expect(
      units.data.filter((u: any) => u.name === "Quarto Duplo"),
    ).toHaveLength(1);
  });
});

describe("reserva: regras", () => {
  it("validação estrita ao salvar e leitura tolerante", async () => {
    const { f, ctx } = await reservaSetup();
    for (const bad of [
      { min_nights: 0 },
      { checkin_time: "25:00" },
      { deposit_type: "fixed", deposit_cents: 0 },
      { deposit_type: "metade" },
      { min_hours: 5, max_hours: 2 },
      { hourly_open: "22:00", hourly_close: "08:00" },
      { checkin_fields: { rules: true }, house_rules: "" },
      { checkin_questions: ["a", "b", "c", "d", "e", "f"] },
    ])
      expect(() => validateReservaConfig(bad), JSON.stringify(bad)).toThrow();
    await expect(
      configure(f, {
        reserva: { deposit_type: "percent", deposit_percent: 150 },
      }),
    ).rejects.toThrow();
    await configure(f, {
      reserva: {
        deposit_type: "percent",
        deposit_percent: 50,
        min_nights: 2,
        cancellation_policy: "Cancelamento grátis até 7 dias antes.",
        checkin_fields: { rules: true },
        house_rules: "Silêncio depois das 22h.",
      },
    });
    const saved = reservaConfig((await ctx.settings()).reserva);
    expect(saved).toMatchObject({
      deposit_type: "percent",
      deposit_percent: 50,
      min_nights: 2,
      checkin_fields: { document: true, rules: true },
    });
    expect(reservaConfig({ min_nights: -3, checkin_time: "x" })).toMatchObject({
      min_nights: 1,
      checkin_time: "14:00",
    });
    expect(depositFor(saved, 60000)).toBe(30000);
    expect(
      depositFor(
        { ...saved, deposit_type: "fixed", deposit_cents: 90000 },
        60000,
      ),
    ).toBe(60000);
    expect(depositFor({ ...saved, deposit_type: "none" }, 60000)).toBe(0);
  });

  it("datas digitadas pelo cliente", () => {
    expect(parseDate("20/11", "2026-11-15")).toBe("2026-11-20");
    expect(parseDate("10/01", "2026-11-15")).toBe("2027-01-10");
    expect(parseDate("31/02", "2026-11-15")).toBe(null);
    expect(parseDate("5/12/26", "2026-11-15")).toBe("2026-12-05");
    expect(parseDate("2027-03-01", "2026-11-15")).toBe("2027-03-01");
    expect(parseDate("amanhã", "2026-11-15")).toBe(null);
  });
});
