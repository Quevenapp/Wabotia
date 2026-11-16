// Rotas /erp-emissor montadas no src/index.ts (src/erp/emissor/README.md,
// "Rotas para o painel"): pessoa da área, módulos erp e erp-fiscal ligados
// (409 module_disabled), escrita só de administrador.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bearer, fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";

describe("ERP: rotas do emissor fiscal", () => {
  it("módulos, leitura do estado e escrita só de administrador", async () => {
    const f = await fixture();
    const admin = await bearer(f.admin),
      member = await bearer(f.member);
    const base = `https://test/api/v1/profiles/${f.profile}/erp-emissor`;
    const call = (path: string, token: string, init: RequestInit = {}) =>
      SELF.fetch(base + path, { ...init, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } });
    // Módulos desligados de fábrica.
    let r = await call("", admin);
    expect(r.status).toBe(409);
    expect((await r.json<any>()).error.code).toBe("module_disabled");
    await setModule(f.profile, "erp", true, f.admin.id);
    r = await call("", admin);
    expect(r.status).toBe(409);
    await setModule(f.profile, "erp-fiscal", true, f.admin.id);
    r = await call("", admin);
    expect(r.status).toBe(200);
    expect((await r.json<any>()).configured).toBe(false);
    // Quem tem acesso à área lê o estado; só o administrador grava.
    expect((await call("", member)).status).toBe(200);
    r = await call("", member, { method: "PUT", body: JSON.stringify({ url: "https://cofre.example.test", api_key: "x".repeat(32) }) });
    expect(r.status).toBe(403);
    expect((await call("", member, { method: "DELETE" })).status).toBe(403);
    expect((await call("/test", member, { method: "POST" })).status).toBe(403);
    expect((await call("/nada", admin)).status).toBe(404);
    // Outra área, para quem não tem acesso a ela: 404.
    const other = await fixture();
    expect((await SELF.fetch(`https://test/api/v1/profiles/${other.profile}/erp-emissor`, { headers: { Authorization: "Bearer " + member } })).status).toBe(404);
  }, 60_000);
});
