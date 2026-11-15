import { describe, expect, it } from "vitest";
import { all } from "../src/db";
import { env } from "cloudflare:test";
import {
  addDays,
  atClock,
  brasiliaDate,
  reservaConfig,
} from "../src/modules/reserva/config";
import {
  firstDay,
  hourlyPeriod,
  hourlySlots,
  ruleRefusal,
} from "../src/modules/reserva/availability";
import { createBooking } from "../src/modules/reserva/bookings";
import { getUnit } from "../src/modules/reserva/units";
import { api, bearer, brasilia, configure } from "./service-center-fixture";
import { future, reservaSetup } from "./reserva-fixture";

const book = async (s: any, body: any, key?: string) =>
  api(
    await bearer(s.f.admin),
    `/profiles/${s.f.profile}/reserva/bookings`,
    "POST",
    body,
    key,
  );

describe("reserva: disponibilidade por diária", () => {
  it("sobreposição recusada; a saída e a próxima entrada no mesmo dia convivem", async () => {
    const s = await reservaSetup();
    const first = await book(s, {
      unit_id: s.mar.id,
      start_date: future(10),
      end_date: future(13),
      customer_name: "Ana",
    });
    expect(first.status).toBe(200);
    const created = await first.json<any>();
    expect(created).toMatchObject({
      number: 1,
      status: "confirmed",
      nights: 3,
      price_cents: 90000,
      start_date: future(10),
      end_date: future(13),
      arrival_time: "14:00",
      departure_time: "12:00",
    });
    expect(created.arrival_at).toBe(atClock(future(10), "14:00"));

    const clash = await book(s, {
      unit_id: s.mar.id,
      start_date: future(12),
      end_date: future(14),
      customer_name: "Bia",
    });
    expect(clash.status).toBe(409);
    expect((await clash.json<any>()).error.code).toBe("unit_unavailable");

    // Virada de dia: entra no dia em que o anterior sai.
    const turnover = await book(s, {
      unit_id: s.mar.id,
      start_date: future(13),
      nights: 2,
      customer_name: "Bia",
    });
    expect(turnover.status).toBe(200);
    expect((await turnover.json<any>()).number).toBe(2);
    // E sai no dia em que o primeiro entra.
    const before = await book(s, {
      unit_id: s.mar.id,
      start_date: future(8),
      end_date: future(10),
      customer_name: "Caio",
    });
    expect(before.status).toBe(200);

    // A outra unidade segue livre no mesmo período.
    const token = await bearer(s.f.member);
    const free = await (
      await api(
        token,
        `/profiles/${s.f.profile}/reserva/availability?start_date=${future(11)}&end_date=${future(12)}`,
      )
    ).json<any>();
    expect(free.units.map((u: any) => [u.name, u.available, u.reason])).toEqual(
      [
        ["Suíte Mar", false, "booked"],
        ["Chalé Jardim", true, null],
      ],
    );
    const calendar = await (
      await api(
        token,
        `/profiles/${s.f.profile}/reserva/calendar?from_date=${future(9)}&to_date=${future(13)}`,
      )
    ).json<any>();
    const mar = calendar.units.find((u: any) => u.unit_id === s.mar.id);
    expect(mar.cells.map((c: any) => c.state)).toEqual([
      "confirmed",
      "confirmed",
      "confirmed",
      "confirmed",
      "confirmed",
    ]);
    const jardim = calendar.units.find((u: any) => u.unit_id === s.jardim.id);
    expect(jardim.cells.every((c: any) => c.state === "free")).toBe(true);
  });

  it("estadia mínima, antecedência e capacidade valem para o cliente; a equipe passa por cima", async () => {
    const s = await reservaSetup({
      rules: { min_nights: 2, min_notice_hours: 24 },
    });
    const config = reservaConfig((await s.ctx.settings()).reserva);
    const customer = (body: any) =>
      createBooking(s.ctx, config, {
        unit_id: s.mar.id,
        source: "whatsapp",
        actor: "customer",
        customer_name: "Cliente",
        ...body,
      });
    await expect(
      customer({ start_date: future(5), nights: 1 }),
    ).rejects.toMatchObject({
      code: "outside_rules",
      message: expect.stringContaining("2 diárias"),
    });
    await expect(
      customer({ start_date: brasiliaDate(Date.now()), nights: 2 }),
    ).rejects.toMatchObject({ code: "outside_rules" });
    await expect(
      customer({ start_date: future(5), nights: 2, guests: 3 }),
    ).rejects.toMatchObject({
      code: "outside_rules",
      message: expect.stringContaining("2 pessoas"),
    });
    const ok = await customer({ start_date: future(5), nights: 2, guests: 2 });
    expect(ok.booking.nights).toBe(2);
    // Pela API (equipe), uma diária só é aceita.
    const staff = await book(s, {
      unit_id: s.jardim.id,
      start_date: future(5),
      nights: 1,
      customer_name: "Balcão",
    });
    expect(staff.status).toBe(200);
  });

  it("bloqueio manual tira a unidade; encaixe da equipe com force passa", async () => {
    const s = await reservaSetup();
    await s.run("reserva.block.save", {
      unit_id: s.mar.id,
      from_date: future(20),
      to_date: future(21),
      reason: "Manutenção",
    });
    const blocked = await book(s, {
      unit_id: s.mar.id,
      start_date: future(19),
      end_date: future(21),
      customer_name: "Ana",
    });
    expect(blocked.status).toBe(409);
    expect((await blocked.json<any>()).error.code).toBe("unit_blocked");
    // Saída no primeiro dia bloqueado: a noite anterior está livre.
    const okBefore = await book(s, {
      unit_id: s.mar.id,
      start_date: future(18),
      end_date: future(20),
      customer_name: "Ana",
    });
    expect(okBefore.status).toBe(200);
    // Bloqueio de toda a casa vale para as outras unidades.
    await s.run("reserva.block.save", { from_date: future(30) });
    const house = await book(s, {
      unit_id: s.jardim.id,
      start_date: future(30),
      nights: 1,
      customer_name: "Bia",
    });
    expect((await house.json<any>()).error.code).toBe("unit_blocked");
    const forced = await book(s, {
      unit_id: s.jardim.id,
      start_date: future(30),
      nights: 1,
      customer_name: "Bia",
      force: true,
    });
    expect(forced.status).toBe(200);
    const calendar = await (
      await api(
        await bearer(s.f.admin),
        `/profiles/${s.f.profile}/reserva/calendar?from_date=${future(20)}&to_date=${future(21)}&unit_id=${s.mar.id}`,
      )
    ).json<any>();
    expect(calendar.units[0].cells.map((c: any) => c.state)).toEqual([
      "blocked",
      "blocked",
    ]);
  });

  it("virada de dia no horário de Brasília", async () => {
    const s = await reservaSetup();
    const config = reservaConfig({ min_notice_hours: 0 });
    const unit = await getUnit(s.ctx, s.quadra.id);
    // 23:30 de 15/11 em Brasília já é 16/11 em UTC.
    const late = brasilia(2026, 11, 15, 23, 30);
    expect(new Date(late).toISOString().slice(0, 10)).toBe("2026-11-16");
    expect(brasiliaDate(late)).toBe("2026-11-15");
    expect(firstDay(config, late)).toBe("2026-11-15");
    expect(firstDay({ ...config, min_notice_hours: 1 }, late)).toBe(
      "2026-11-16",
    );
    // Às 18:30, a quadra ainda tem 19:00 a 21:00 hoje.
    const evening = brasilia(2026, 11, 15, 18, 30);
    expect(
      ruleRefusal(
        config,
        unit,
        hourlyPeriod(unit, brasilia(2026, 11, 15, 18), 60),
        evening,
      ),
    ).toBe("past");
    expect(
      ruleRefusal(
        config,
        unit,
        hourlyPeriod(unit, brasilia(2026, 11, 15, 21), 60),
        evening,
      ),
    ).toBe(null);
    expect(
      ruleRefusal(
        config,
        unit,
        hourlyPeriod(unit, brasilia(2026, 11, 15, 21), 120),
        evening,
      ),
    ).toBe("hours");
    expect(
      ruleRefusal(
        config,
        unit,
        hourlyPeriod(unit, brasilia(2026, 11, 15, 19, 30), 60),
        evening,
      ),
    ).toBe("step");
  });
});

describe("reserva: disponibilidade por hora", () => {
  it("horários livres descontam reservas e respeitam o funcionamento", async () => {
    const s = await reservaSetup({ rules: { min_hours: 1, max_hours: 3 } });
    const day = future(4);
    const taken = await book(s, {
      unit_id: s.quadra.id,
      starts: atClock(day, "18:00"),
      duration_minutes: 120,
      customer_name: "Time A",
      guests: 10,
    });
    expect(taken.status).toBe(200);
    expect(await taken.json<any>()).toMatchObject({
      mode: "hourly",
      duration_minutes: 120,
      price_cents: 16000,
      start_date: day,
      end_date: day,
      arrival_time: "18:00",
      departure_time: "20:00",
    });
    const config = reservaConfig((await s.ctx.settings()).reserva);
    const unit = await getUnit(s.ctx, s.quadra.id);
    const slots = await hourlySlots(s.ctx, config, unit, day, 120, Date.now());
    const times = slots.map(
      (x) =>
        brasiliaDate(x.starts) +
        " " +
        new Date(x.starts - 3 * 3600000).toISOString().slice(11, 16),
    );
    expect(times).toEqual(
      [
        "08:00",
        "09:00",
        "10:00",
        "11:00",
        "12:00",
        "13:00",
        "14:00",
        "15:00",
        "16:00",
        "20:00",
      ].map((t) => `${day} ${t}`),
    );
    const api2 = await (
      await api(
        await bearer(s.f.member),
        `/profiles/${s.f.profile}/reserva/availability?date=${day}&duration_minutes=60`,
      )
    ).json<any>();
    expect(api2.units).toHaveLength(1);
    expect(api2.units[0].slots.map((x: any) => x.time)).not.toContain("19:00");
    expect(api2.units[0].slots.map((x: any) => x.time)).toContain("20:00");
    const overlap = await book(s, {
      unit_id: s.quadra.id,
      starts: atClock(day, "19:00"),
      duration_minutes: 60,
      customer_name: "Time B",
    });
    expect((await overlap.json<any>()).error.code).toBe("unit_unavailable");
    const after = await book(s, {
      unit_id: s.quadra.id,
      starts: atClock(day, "20:00"),
      duration_minutes: 60,
      customer_name: "Time B",
    });
    expect(after.status).toBe(200);
    const outside = await book(s, {
      unit_id: s.quadra.id,
      starts: atClock(day, "21:30"),
      duration_minutes: 60,
      customer_name: "Time C",
    });
    expect((await outside.json<any>()).error.code).toBe("outside_rules");
  });
});

describe("reserva: pedidos simultâneos", () => {
  it("pela API, só um de dois pedidos ao mesmo tempo fica com a unidade", async () => {
    const s = await reservaSetup();
    const body = (name: string) => ({
      unit_id: s.mar.id,
      start_date: future(40),
      end_date: future(42),
      customer_name: name,
    });
    const responses = await Promise.all([
      book(s, body("Ana")),
      book(s, body("Bia")),
      book(s, {
        ...body("Caio"),
        start_date: future(41),
        end_date: future(43),
      }),
    ]);
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409]);
    const rows = await all(
      env,
      "SELECT * FROM reserva_bookings WHERE profile_id=? AND status='confirmed'",
      s.f.profile,
    );
    expect(rows).toHaveLength(1);
  });

  it("sem o Coordinator, a gravação condicionada ainda impede a dupla reserva", async () => {
    const s = await reservaSetup();
    const config = reservaConfig({});
    const attempts = await Promise.allSettled(
      ["Ana", "Bia", "Caio", "Davi", "Eva"].map((name) =>
        createBooking(s.ctx, config, {
          unit_id: s.jardim.id,
          start_date: future(50),
          nights: 3,
          customer_name: name,
          source: "whatsapp",
          actor: "customer",
        }),
      ),
    );
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    for (const a of attempts.filter((a) => a.status === "rejected"))
      expect((a as PromiseRejectedResult).reason.code).toBe("unit_unavailable");
    const numbers = await all(
      env,
      "SELECT number FROM reserva_bookings WHERE profile_id=?",
      s.f.profile,
    );
    expect(numbers).toHaveLength(1);
  });
});

describe("reserva: equipe altera e cancela", () => {
  it("alterar respeita a ocupação; cancelar libera; a mesma Idempotency-Key não duplica", async () => {
    const s = await reservaSetup();
    const token = await bearer(s.f.admin);
    const key = "reserva-teste-" + Date.now();
    const body = {
      unit_id: s.mar.id,
      start_date: future(60),
      end_date: future(62),
      customer_name: "Ana",
      customer_phone: "+55 11 98888-7777",
      guests: 2,
    };
    const one = await (await book(s, body, key)).json<any>();
    const again = await (await book(s, body, key)).json<any>();
    expect(again.id).toBe(one.id);
    expect(one.customer_phone).toBe("5511988887777");
    const other = await (
      await book(s, {
        ...body,
        start_date: future(62),
        end_date: future(64),
        customer_name: "Bia",
      })
    ).json<any>();
    const base = `/profiles/${s.f.profile}/reserva/bookings`;
    const clash = await api(token, `${base}/${one.id}`, "PATCH", {
      end_date: future(63),
    });
    expect(clash.status).toBe(409);
    const moved = await (
      await api(token, `${base}/${one.id}`, "PATCH", {
        unit_id: s.jardim.id,
        end_date: future(63),
      })
    ).json<any>();
    expect(moved).toMatchObject({
      unit_id: s.jardim.id,
      unit_name: "Chalé Jardim",
      nights: 3,
      price_cents: 135000,
      changes: 1,
    });
    const cancelled = await (
      await api(token, `${base}/${other.id}/cancel`, "POST", {
        reason: "Desistiu",
      })
    ).json<any>();
    expect(cancelled).toMatchObject({
      status: "cancelled",
      cancel_reason: "Desistiu",
    });
    const again2 = await api(token, `${base}/${other.id}/cancel`, "POST", {});
    expect((await again2.json<any>()).error.code).toBe("booking_closed");
    const reuse = await book(s, {
      ...body,
      start_date: future(62),
      end_date: future(64),
      customer_name: "Caio",
    });
    expect(reuse.status).toBe(200);
    const list = await (
      await api(token, `${base}?status=cancelled`)
    ).json<any>();
    expect(list.data.map((b: any) => b.id)).toEqual([other.id]);
    const search = await (await api(token, `${base}?q=88887777`)).json<any>();
    expect(search.data).toHaveLength(3);
    const byName = await (await api(token, `${base}?q=Ana`)).json<any>();
    expect(byName.data.map((b: any) => b.id)).toEqual([one.id]);
    const events = await all(
      env,
      "SELECT kind FROM events WHERE profile_id=? AND kind LIKE 'reserva.%' ORDER BY id",
      s.f.profile,
    );
    expect(events.map((e) => e.kind)).toEqual([
      "reserva.created",
      "reserva.confirmed",
      "reserva.created",
      "reserva.confirmed",
      "reserva.changed",
      "reserva.cancelled",
      "reserva.created",
      "reserva.confirmed",
    ]);
    expect(addDays(future(60), 3)).toBe(future(63));
  });
});
