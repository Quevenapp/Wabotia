import { describe, expect, it } from "vitest";
import { openapi } from "../src/openapi";
import { api, bearer } from "./service-center-fixture";
import { reservaSetup } from "./reserva-fixture";

describe("reserva: OpenAPI e capacidades", () => {
  it("documenta as rotas do módulo no grupo Reserva", () => {
    const spec = openapi("https://test");
    const base = "/profiles/{profile}/reserva";
    for (const [path, method] of [
      [base, "get"],
      [`${base}/units`, "post"],
      [`${base}/units/{id}`, "delete"],
      [`${base}/blocks`, "post"],
      [`${base}/availability`, "get"],
      [`${base}/calendar`, "get"],
      [`${base}/bookings`, "post"],
      [`${base}/bookings/{id}`, "patch"],
      [`${base}/bookings/{id}/cancel`, "post"],
      [`${base}/bookings/{id}/confirm`, "post"],
      [`${base}/bookings/{id}/deposit`, "post"],
      [`${base}/bookings/{id}/checkin`, "post"],
    ]) {
      const entry = spec.paths[path]?.[method];
      expect(entry, `${method} ${path}`).toBeTruthy();
      expect(entry.tags).toEqual(["Reserva"]);
    }
    const post = spec.paths[`${base}/bookings`].post;
    expect(post.parameters.map((p: any) => p.name)).toContain(
      "Idempotency-Key",
    );
    expect(post.description).toContain("unit_unavailable");
    expect(
      spec.components.schemas.ReservaBooking.properties.status.enum,
    ).toEqual([
      "pending_payment",
      "confirmed",
      "cancelled",
      "expired",
      "completed",
    ]);
  });

  it("a rota de capacidades lista o módulo ligado", async () => {
    const s = await reservaSetup();
    const token = await bearer(s.f.member);
    const caps = await (
      await api(token, `/profiles/${s.f.profile}/capabilities`)
    ).json<any>();
    expect(caps.modules).toContainEqual({
      id: "reserva",
      name: "Reserva e check-in",
      version: "1.0.0",
    });
    await s.run("module.set", { id: "reserva", enabled: false });
    const off = await (
      await api(token, `/profiles/${s.f.profile}/capabilities`)
    ).json<any>();
    expect(off.modules.map((m: any) => m.id)).not.toContain("reserva");
  });
});
