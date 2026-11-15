import { describe, expect, it } from "vitest";
import { openapi } from "../src/openapi";
import { moduleRoutes } from "../src/modules/hooks";
import { validateSuporteSettings } from "../src/modules/suporte/model";
import { api, bearer, configure } from "./service-center-fixture";
import { useMercadoPago } from "./mensalidade-mp";
import { setupSuporte } from "./suporte-fixture";

useMercadoPago();

describe("suporte: regras", () => {
  it("valida pacotes, modo de identificação e formas de pagamento", async () => {
    expect(
      validateSuporteSettings({
        identify: "linked_only",
        packages: [
          { id: "a", name: "Avulso", price_cents: 4900 },
          { id: "b", name: "Dia", price_cents: 9000, mode: "hours", hours: 24 },
        ],
        methods: ["pix"],
      }),
    ).toEqual({
      identify: "linked_only",
      packages: [
        {
          id: "a",
          name: "Avulso",
          price_cents: 4900,
          mode: "ticket",
          active: true,
        },
        {
          id: "b",
          name: "Dia",
          price_cents: 9000,
          mode: "hours",
          hours: 24,
          active: true,
        },
      ],
      methods: ["pix"],
    });
    for (const bad of [
      { identify: "qualquer" },
      { packages: [{ id: "a", name: "A", price_cents: 49.9 }] },
      { packages: [{ id: "a", name: "A", price_cents: 4900, mode: "hours" }] },
      {
        packages: [
          { id: "a", name: "A", price_cents: 4900 },
          { id: "a", name: "B", price_cents: 4900 },
        ],
      },
      { methods: [] },
      { methods: ["boleto"] },
      { max_attempts: 9 },
      { outra: true },
    ])
      expect(() => validateSuporteSettings(bad), JSON.stringify(bad)).toThrow();
    const s = await setupSuporte();
    const res = await configure(s.f, {
      suporte: { methods: ["pix"], max_attempts: 2 },
    });
    expect(res).toBeTruthy();
    const offers = await (
      await api(
        await bearer(s.f.member),
        `/profiles/${s.f.profile}/suporte/offers`,
      )
    ).json<any>();
    expect(offers).toMatchObject({
      methods: ["pix"],
      mensalidade: true,
      payments_ready: true,
    });
    expect(offers.plans.map((p: any) => p.name)).toEqual(["Suporte Mensal"]);
  });

  it("documenta no OpenAPI todas as rotas registradas pelo módulo", () => {
    const spec = openapi("https://test");
    const routes = moduleRoutes();
    const own = [
      ...routes.write.map((r) => [r.method, r.path] as const),
      ...routes.read.map((r) => ["GET", r.path] as const),
    ].filter(([, path]) => path.startsWith("suporte/"));
    expect(own.length).toBe(9);
    for (const [method, path] of own)
      expect(
        spec.paths[
          "/profiles/{profile}/" + path.replace(/:([a-z_]+)/g, "{$1}")
        ]?.[method.toLowerCase()],
        `${method} ${path}`,
      ).toBeTruthy();
    expect(spec.components.schemas.SuporteRelease).toBeTruthy();
  });
});
