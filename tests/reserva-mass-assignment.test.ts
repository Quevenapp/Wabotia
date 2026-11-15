// Revisão de segurança B8: reserva.book e reserva.change repassavam o corpo
// inteiro, inclusive `at` (o relógio do comando): reserva retroativa e prazo
// do sinal forjado.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { one } from "../src/db";
import { future, reservaSetup } from "./reserva-fixture";

describe("reserva só aceita os campos dela (revisão B8)", () => {
  it("`at` no corpo não muda o relógio da reserva nem o prazo do sinal", async () => {
    const s = await reservaSetup({
      rules: { deposit_type: "percent", deposit_percent: 30 },
    });
    const past = Date.now() - 400 * 86400000;
    const b = await s.run("reserva.book", {
      unit_id: s.jardim.id,
      start_date: future(7),
      nights: 1,
      customer_name: "Hóspede",
      at: past,
    });
    const row = await one(
      env,
      "SELECT created,payment_due_at FROM reserva_bookings WHERE id=?",
      b.id,
    );
    expect(row.created).toBeGreaterThan(Date.now() - 60_000);
    if (row.payment_due_at)
      expect(row.payment_due_at).toBeGreaterThan(Date.now() - 60_000);
    // Data já passada continua recusada, mesmo com `at` antigo.
    await expect(
      s.run("reserva.book", {
        unit_id: s.mar.id,
        start_date: "2020-01-10",
        nights: 1,
        customer_name: "Retroativa",
        at: Date.UTC(2020, 0, 1),
      }),
    ).rejects.toMatchObject({ status: expect.any(Number) });
    await expect(
      s.run("reserva.change", {
        id: b.id,
        start_date: "2020-01-10",
        at: Date.UTC(2020, 0, 1),
      }),
    ).rejects.toMatchObject({ status: expect.any(Number) });
  });
});
