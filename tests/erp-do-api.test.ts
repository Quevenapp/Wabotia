// Fase 0 do ERP, prova 6: a costura. Requisição ao Worker
// (/api/v1/profiles/:p/erp/…) → erp-api do Fagoo sem alteração
// (createHandler) → fetchImpl local → objeto erp:<área> → motor.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { uid } from "../src/types";
import { erpFetch, erpStub } from "../src/erp/hub";
import { ERP_TABLES } from "../src/erp/schema/columns.generated";
import { bearer, fixture } from "./service-center-fixture";

/** INSERT com os NOT NULL sem padrão preenchidos por tipo (só para o teste). */
function insert(sql: SqlStorage, table: string, values: Record<string, unknown>) {
  const now = String(BigInt(Date.now()) * 1000n);
  const spec = ERP_TABLES[table].columns;
  const row: Record<string, unknown> = { ...values };
  for (const c of sql.exec(`PRAGMA table_info("${table}")`).toArray() as any[]) {
    if (c.name in row || !c.notnull || c.dflt_value !== null || c.pk) continue;
    const s = spec[c.name];
    row[c.name] =
      s.default === "now" || s.codec === "timestamp_us"
        ? now
        : s.default === "uuid" || s.codec === "uuid"
          ? crypto.randomUUID()
          : s.codec === "bool" || ["int", "int53", "dec", "dec_i64"].includes(s.codec)
            ? 0
            : s.codec === "json"
              ? "{}"
              : s.codec.startsWith("array:")
                ? "[]"
                : s.codec === "date"
                  ? "2026-10-15"
                  : "x";
  }
  const cols = Object.keys(row);
  sql.exec(
    `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
    ...cols.map((c) => row[c]),
  );
}

describe("ERP fase 0: costura da erp-api até o objeto", () => {
  it("rota real do Worker serve leitura e escrita pelo motor", async () => {
    const f = await fixture();
    const token = await bearer(f.admin);
    const base = `https://test/api/v1/profiles/${f.profile}/erp`;
    const get = (path: string, t = token) => SELF.fetch(base + path, { headers: { Authorization: "Bearer " + t } });
    // Instância criada e vínculo do administrador no ERP (o Fagoo exige
    // erp_access.membership; o sincronismo com Pessoas vem na fase 3).
    await erpFetch(env, f.profile, "/erp-ping");
    const ids = await runInDurableObject(erpStub(env, f.profile), (_i: any, state: DurableObjectState) => {
      const sql = state.storage.sql;
      insert(sql, "erp_access__membership", { user_id: f.admin.id, role: "admin", active: 1 });
      const product = crypto.randomUUID(),
        warehouse = crypto.randomUUID();
      insert(sql, "erp_catalog__record", { id: product, entity: "products", name: "Produto da costura", active: 1, created_by: f.admin.id, updated_by: f.admin.id });
      insert(sql, "erp_catalog__product", { record_id: product, unit: "UN", kind: "P", format: "S" });
      insert(sql, "erp_catalog__record", { id: warehouse, entity: "warehouses", name: "Depósito da costura", active: 1, created_by: f.admin.id, updated_by: f.admin.id });
      insert(sql, "erp_catalog__warehouse", { record_id: warehouse });
      return { product, warehouse };
    });

    // Leitura: tabela oficial (erp_reference_search) pela rota HTTP do Fagoo.
    const t0 = Date.now();
    const cnae = await get("/v1/plataforma/referencias/cnae?q=4744");
    const firstMs = Date.now() - t0;
    expect(cnae.status).toBe(200);
    const body = await cnae.json<any>();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i: any) => i.code.replace(/\D/g, "").startsWith("4744"))).toBe(true);
    const city = await (await get("/v1/plataforma/referencias/municipios?uf=RO&q=alta floresta doeste")).json<any>();
    expect(city.items.map((i: any) => i.code)).toEqual(["1100015"]);
    expect((await get("/v1/plataforma/referencias/paises?uf=SP")).status).toBe(400);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const s = Date.now();
      expect((await get("/v1/plataforma/referencias/paises?q=alemanha")).status).toBe(200);
      times.push(Date.now() - s);
    }
    times.sort((a, b) => a - b);

    // Escrita: lançamento de estoque (erp_stock_post) pela rota do Fagoo.
    const post = await SELF.fetch(base + "/v1/estoque/movimentos", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        command_id: uid(),
        kind: "receipt",
        occurred_on: "2026-10-15",
        reason: "Entrada pela costura",
        items: [{ product_id: ids.product, warehouse_id: ids.warehouse, quantity: "2.5", expected_version: 0 }],
      }),
    });
    const posted = await post.json<any>();
    expect(post.status, JSON.stringify(posted)).toBeLessThan(300);
    expect(JSON.stringify(posted)).toContain("2.500000");
    const balance = await runInDurableObject(erpStub(env, f.profile), (_i: any, state: DurableObjectState) =>
      state.storage.sql
        .exec('SELECT CAST(quantity AS TEXT) q, version FROM "erp_stock__balance" WHERE product_id=?', ids.product)
        .toArray(),
    );
    expect(balance).toEqual([{ q: "2500000", version: 1 }]);

    // Sem vínculo no ERP: o motor recusa (42501 → 403 da erp-api).
    const outsider = await get("/v1/plataforma/referencias/cnae?q=4744", await bearer(f.member));
    expect(outsider.status).toBe(403);
    console.log(
      "ERP_API " + JSON.stringify({ first_ms: firstMs, p50_ms: times[10], p95_ms: times[18], max_ms: times[19] }),
    );
  });
});
