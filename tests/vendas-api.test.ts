import { describe, expect, it } from "vitest";
import { openapi } from "../src/openapi";
import { moduleRoutes } from "../src/modules/hooks";

const toSpec = (path: string) =>
  "/profiles/{profile}/" + path.replace(/:(\w+)/g, "{$1}");

describe("vendas e caixa: contrato da API", () => {
  it("toda rota está no OpenAPI, nos grupos Vendas e Caixa, com esquemas que existem", () => {
    const spec = openapi("https://test");
    const mine = (p: string) => p.startsWith("vendas") || p.startsWith("caixa");
    const routes = [
      ...moduleRoutes().read.filter((r) => mine(r.path)).map((r) => ["get", r.path]),
      ...moduleRoutes()
        .write.filter((r) => mine(r.path))
        .map((r) => [r.method.toLowerCase(), r.path]),
    ];
    expect(routes.length).toBeGreaterThan(40);
    for (const [method, path] of routes) {
      const entry = spec.paths[toSpec(path)]?.[method];
      expect(entry, `${method} ${path}`).toBeTruthy();
      expect(entry.tags).toEqual([path.startsWith("caixa") ? "Caixa" : "Vendas"]);
    }
    const refs = new Set<string>();
    const walk = (value: any) => {
      if (!value || typeof value !== "object") return;
      if (typeof value.$ref === "string") refs.add(value.$ref);
      for (const child of Object.values(value)) walk(child);
    };
    for (const [path, methods] of Object.entries<any>(spec.paths))
      if (path.includes("/vendas") || path.includes("/caixa")) walk(methods);
    for (const name of Object.keys(spec.components.schemas))
      if (name.startsWith("Vendas") || name.startsWith("Caixa"))
        walk(spec.components.schemas[name]);
    for (const ref of refs)
      expect(
        spec.components.schemas[ref.replace("#/components/schemas/", "")],
        ref,
      ).toBeTruthy();
    // Documentadas e não registradas também falham.
    const documented = Object.keys(spec.paths).filter(
      (p) => p.startsWith("/profiles/{profile}/vendas") || p.startsWith("/profiles/{profile}/caixa"),
    );
    const registered = new Set(routes.map(([, p]) => toSpec(p)));
    for (const p of documented) expect(registered.has(p), p).toBe(true);
  });
});
