// Rotas /erp-emissor montadas no src/index.ts (src/erp/emissor/README.md,
// "Rotas para o painel"): módulos erp e erp-fiscal ligados (409
// module_disabled); leitura só para quem tem papel erp:* (o administrador do
// Wabotia vale erp:admin); configuração (salvar, remover, testar) só do
// administrador, pelo portão do ERP: fora do horário ou, com a política de
// segundo fator ligada, sessão sem aal2 recebe 403 com o código da erp-api.
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec } from "../src/db";
import { now } from "../src/types";
import { sha } from "../src/security";
import { erpFetch, erpStub } from "../src/erp/hub";
import { bearer, fixture } from "./service-center-fixture";
import { setModule } from "./erp-module-helper";

describe("ERP: rotas do emissor fiscal", () => {
  it("módulos, leitura com papel do ERP e configuração só de administrador", async () => {
    const f = await fixture();
    const admin = await bearer(f.admin);
    let member = await bearer(f.member);
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
    // Pessoa da área sem papel no ERP: não lê nem grava.
    r = await call("", member);
    expect(r.status).toBe(403);
    expect((await r.json<any>()).error.code).toBe("erp_role_required");
    // Com papel de consulta: lê; configurar continua só do administrador.
    await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(["erp:consulta"]), f.member.id);
    // Sessão nova: o ator da sessão anterior fica em cache por um instante.
    member = await bearer(f.member);
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

  it("configuração pelo portão do ERP: segundo fator ligado pede aal2", async () => {
    const f = await fixture();
    const admin = await bearer(f.admin);
    await setModule(f.profile, "erp", true, f.admin.id);
    await setModule(f.profile, "erp-fiscal", true, f.admin.id);
    await erpFetch(env, f.profile, "/erp-ping");
    const base = `https://test/api/v1/profiles/${f.profile}/erp-emissor`;
    const remove = () => SELF.fetch(base, { method: "DELETE", headers: { Authorization: "Bearer " + admin } });
    // Política desligada: o administrador remove (nada configurado, continua sem emissor).
    let r = await remove();
    expect(r.status).toBe(200);
    expect((await r.json<any>()).configured).toBe(false);
    // Política ligada, sessão aal1: recusa antes de mexer no segredo.
    const t = String(BigInt(Date.now()) * 1000n);
    await runInDurableObject(erpStub(env, f.profile), (_i: any, state: DurableObjectState) => {
      state.storage.sql.exec(
        `INSERT INTO "erp_access__security_policy"(singleton, mfa_required, version, updated_at, updated_by) VALUES(1, 1, 1, ?, ?)`,
        t,
        f.admin.id,
      );
    });
    r = await remove();
    expect(r.status).toBe(403);
    expect((await r.json<any>()).error.code).toBe("ERP_MFA_REQUIRED");
    // A leitura não passa pelo portão.
    expect((await SELF.fetch(base, { headers: { Authorization: "Bearer " + admin } })).status).toBe(200);
    // Depois do código (a sessão sobe para aal2), passa.
    await exec(env, "UPDATE sessions SET aal=2,mfa_at=? WHERE hash=?", now(), await sha(admin));
    expect((await remove()).status).toBe(200);
  }, 60_000);
});
