import { describe, expect, it } from "vitest";
import { api, bearer } from "./service-center-fixture";
import { future, reservaSetup } from "./reserva-fixture";

// Achado da instalação de teste: o id da reserva era "cmd-" + a
// Idempotency-Key, sem credencial nem área. Agora o identificador da operação
// é derivado de credencial, área, operação e chave.
const book = (token: string, profile: string, body: any, key: string) =>
  api(token, `/profiles/${profile}/reserva/bookings`, "POST", body, key);

describe("Idempotency-Key: credencial, área e corpo", () => {
  it("mesma credencial e corpo repetem; corpo diferente dá conflito; outra credencial é outra operação", async () => {
    const s = await reservaSetup();
    const member = await bearer(s.f.member);
    const admin = await bearer(s.f.admin);
    const key = "reserva-balcao-1";
    const body = (unit: string, name: string) => ({
      unit_id: unit,
      start_date: future(20),
      nights: 1,
      customer_name: name,
    });
    const first = await book(member, s.f.profile, body(s.mar.id, "Ana"), key);
    expect(first.status).toBe(200);
    const ana = await first.json<any>();

    // Mesma credencial, mesma chave e mesmo corpo: a mesma resposta.
    const again = await book(member, s.f.profile, body(s.mar.id, "Ana"), key);
    expect(again.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await again.json<any>()).id).toBe(ana.id);

    // Mesma credencial, mesma chave e outro corpo: conflito.
    const changed = await book(
      member,
      s.f.profile,
      body(s.jardim.id, "Ana"),
      key,
    );
    expect(changed.status).toBe(409);
    expect((await changed.json<any>()).error.code).toBe("idempotency_conflict");

    // Outra credencial com a mesma chave: outra reserva, criada de verdade.
    const other = await book(
      admin,
      s.f.profile,
      body(s.jardim.id, "Bruno"),
      key,
    );
    expect(other.status).toBe(200);
    expect(other.headers.get("Idempotency-Replayed")).toBeNull();
    const bruno = await other.json<any>();
    expect(bruno.id).not.toBe(ana.id);
    expect(bruno).toMatchObject({
      customer_name: "Bruno",
      unit_id: s.jardim.id,
    });
  });

  it("a mesma chave em outra área e uma chave com barra funcionam", async () => {
    const one = await reservaSetup();
    const two = await reservaSetup();
    // O administrador alcança as duas áreas.
    const admin = await bearer(one.f.admin);
    const key = "pedido/2026/11/15";
    const body = (unit: string) => ({
      unit_id: unit,
      start_date: future(21),
      nights: 1,
      customer_name: "Carla",
    });
    const a = await book(admin, one.f.profile, body(one.mar.id), key);
    const b = await book(admin, two.f.profile, body(two.mar.id), key);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const first = await a.json<any>();
    const second = await b.json<any>();
    expect(first.id).not.toBe(second.id);
    // O id serve na URL.
    expect(first.id).toMatch(/^[\w-]+$/);
    const read = await api(
      admin,
      `/profiles/${one.f.profile}/reserva/bookings/${first.id}`,
    );
    expect(read.status).toBe(200);
    expect((await read.json<any>()).id).toBe(first.id);
  });
});
