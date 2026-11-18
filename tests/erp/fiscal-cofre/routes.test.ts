// Relatórios e exportação pelo cofre (F6b do Fiscal): rotas /erp-fiscal-cofre.
// Papel fiscal ou administrador; o relatório repassa notasPorLer e quem chama
// repete; a exportação reaproveita o mesmo pedido ainda válido (clique duplo)
// e só gera outra com "nova"; os links vão como vieram e nunca para a
// auditoria. Só cofre simulado.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all } from "../../../src/db";
import { erpFiscalVaultRoute } from "../../../src/erp/fiscal-cofre/routes.ts";
import { uid, type Actor } from "../../../src/types";
import { setModule } from "../../erp-module-helper";
import { requestExample } from "../emissor/schema";
import { actor, example, member, vaultArea } from "../emissor/helpers";
import { createNfapiProvider } from "../../../src/erp/emissor/nfapi-provider.ts";

const DAY = "2026-11-16";
const url = (profile: string, sub: string) => `https://wabotia.test/api/v1/profiles/${profile}/erp-fiscal-cofre${sub}`;
const provider = createNfapiProvider({ delays: [0, 0, 0] });

async function area(options: Parameters<typeof vaultArea>[0] = {}) {
  const a = await vaultArea(options);
  await setModule(a.profile, "erp", true, "teste");
  await setModule(a.profile, "erp-fiscal", true, "teste");
  await provider.emit(a.ctx, "nfe", example(requestExample("POST", "/v1/nfe")), { document_id: uid(), version: 1 });
  const call = (who: Actor, method: string, sub: string, body?: unknown) =>
    erpFiscalVaultRoute(
      env,
      new Request(url(a.profile, sub), { method, body: body === undefined ? undefined : JSON.stringify(body) }),
      a.profile,
      who,
      { fetch: a.vault.fetch },
    );
  const audits = () =>
    all<{ operation: string; resource_id: string }>(env, "SELECT operation, resource_id FROM audit WHERE profile_id=? ORDER BY rowid", a.profile);
  return { ...a, call, audits };
}

const report = `/relatorio?ambiente=homologacao&de=${DAY}&ate=${DAY}`;

describe("quem pode", () => {
  it("papel fiscal e administrador; consulta, vendas, sem papel e bot, não", { timeout: 45_000 }, async () => {
    const { profile, call, vault } = await area();
    const fiscal = await member("operator", profile, ["erp:fiscal"]);
    const admin = await member("admin", profile);
    for (const who of [fiscal, admin]) expect((await call(who, "GET", report)).status).toBe(200);
    for (const access of [["erp:consulta"], ["erp:vendas"]]) {
      const other = await member("operator", profile, access);
      expect(await call(other, "GET", report).catch((e) => e)).toMatchObject({ status: 403, code: "erp_fiscal_role_required" });
    }
    expect(await call(actor("operator", [profile]), "GET", report).catch((e) => e)).toMatchObject({ status: 403, code: "erp_role_required" });
    const viaBot: Actor = { ...fiscal, via: { kind: "internal_bot", bot_id: "b", run_id: "r" } as any };
    expect(await call(viaBot, "POST", "/exportacoes", { ambiente: "homologacao", de: DAY, ate: DAY }).catch((e) => e)).toMatchObject({
      status: 403,
      code: "erp_fiscal_bot_not_allowed",
    });
    expect(vault.calls.filter((c) => c.path.startsWith("/v1/exportacoes"))).toHaveLength(0);
  });

  it("módulo erp-fiscal desligado: 409 module_disabled", async () => {
    const { profile, call } = await area();
    await setModule(profile, "erp-fiscal", false, "teste");
    expect(await call(actor("admin", [profile]), "GET", report).catch((e) => e)).toMatchObject({ status: 409, code: "module_disabled" });
  });
});

describe("relatório", () => {
  it("notasPorLer > 0: repassa incompleto com retry_after_ms; audita só a resposta completa", { timeout: 45_000 }, async () => {
    const { profile, call, vault, audits } = await area();
    const fiscal = await member("operator", profile, ["erp:fiscal"]);
    vault.state.notesToRead = 200;
    const first = await call(fiscal, "GET", report);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await first.json()).toMatchObject({ pending_reads: 50, complete: false, retry_after_ms: 1500, warnings: [{ code: "pending_reads" }] });
    expect(await audits()).toEqual([]);
    const done = await (await call(fiscal, "GET", report)).json<any>();
    expect(done).toMatchObject({ pending_reads: 0, complete: true, issued: { authorized: { count: 1 } } });
    expect(await audits()).toEqual([{ operation: "erp_fiscal.vault_report", resource_id: `homologacao ${DAY}..${DAY}` }]);
    // Período inválido não chega ao cofre.
    const before = vault.calls.length;
    const bad = await call(fiscal, "GET", `/relatorio?ambiente=homologacao&de=${DAY}&ate=2026-11-15`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "fiscal_invalid_request" } });
    expect(vault.calls.length).toBe(before);
  });
});

describe("exportação", () => {
  it("cria, reaproveita o mesmo pedido, gera outra com nova; links como vieram e fora da auditoria", { timeout: 45_000 }, async () => {
    const { profile, call, vault, audits } = await area();
    const fiscal = await member("operator", profile, ["erp:fiscal"]);
    vault.state.exportPolls = 1;
    const ask = { ambiente: "homologacao", de: DAY, ate: DAY, incluir: ["nfe", "events"] };
    const created = await call(fiscal, "POST", "/exportacoes", ask);
    expect(created.status).toBe(201);
    const first = await created.json<any>();
    expect(first).toMatchObject({ reused: false, export: { status: "preparing", parts: [], include: ["nfe", "events"] } });
    const ref = first.export.provider_ref;

    // Clique duplo (mesmo pedido, incluir em outra ordem): reaproveita, com links novos.
    const again = await call(fiscal, "POST", "/exportacoes", { ...ask, incluir: ["events", "nfe"] });
    expect(again.status).toBe(200);
    const reused = await again.json<any>();
    expect(reused).toMatchObject({ reused: true, export: { provider_ref: ref, status: "ready" } });
    expect(reused.export.parts[0].url).toContain(`/exportacoes/${ref}/parte-1?expira=`);
    expect(vault.calls.filter((c) => c.path === "/v1/exportacoes" && c.method === "POST")).toHaveLength(1);

    // "nova": outra exportação; outro período também.
    expect((await call(fiscal, "POST", "/exportacoes", { ...ask, nova: true })).status).toBe(201);
    expect((await call(fiscal, "POST", "/exportacoes", { ...ask, incluir: ["nfe"] })).status).toBe(201);
    expect(vault.calls.filter((c) => c.path === "/v1/exportacoes" && c.method === "POST")).toHaveLength(3);

    const list = await (await call(fiscal, "GET", "/exportacoes")).json<any>();
    expect(list.exports).toHaveLength(3);
    const got = await call(fiscal, "GET", `/exportacoes/${ref}`);
    expect(got.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await got.json()).toMatchObject({ provider_ref: ref, status: "ready" });

    // O servidor nunca baixa o arquivo; a auditoria guarda id, ambiente, período e incluir, nunca a url.
    expect(vault.calls.filter((c) => c.path.startsWith("/exportacoes/"))).toHaveLength(0);
    const rows = await audits();
    expect(rows.map((r) => r.operation)).toEqual([
      "erp_fiscal.vault_export_create",
      "erp_fiscal.vault_export_links",
      "erp_fiscal.vault_export_create",
      "erp_fiscal.vault_export_create",
      "erp_fiscal.vault_export_links",
    ]);
    expect(rows[0].resource_id).toBe(`${ref} homologacao ${DAY}..${DAY} nfe,events`);
    for (const r of rows) expect(r.resource_id).not.toMatch(/https?:|assinatura|expira/);
  });

  it("pedido inválido não chega ao cofre; exportação que sumiu: 404", { timeout: 45_000 }, async () => {
    const { profile, call, vault } = await area();
    const fiscal = await member("operator", profile, ["erp:fiscal"]);
    const before = vault.calls.length;
    for (const body of [
      { ambiente: "homologacao", de: DAY, ate: DAY, incluir: [] },
      { ambiente: "homologacao", de: DAY, ate: DAY, incluir: ["pdf"] },
      { ambiente: "homologacao", de: DAY, ate: "2026-11-15" },
      { ambiente: "teste", de: DAY, ate: DAY },
    ]) {
      const r = await call(fiscal, "POST", "/exportacoes", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await r.json()).toMatchObject({ error: { code: "fiscal_invalid_request" } });
    }
    expect(await call(fiscal, "POST", "/exportacoes", [1]).catch((e) => e)).toMatchObject({ status: 400, code: "invalid_json" });
    // Só o GET /v1/exportacoes do reaproveitamento pode ter saído: nenhum POST.
    expect(vault.calls.slice(before).filter((c) => c.method === "POST")).toHaveLength(0);
    const gone = await call(fiscal, "GET", "/exportacoes/exp_nao_existe");
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error: { code: "fiscal_export_not_found" } });
    expect((await call(fiscal, "GET", "/exportacoes/..%2F..")).status).toBe(404);
  });

  it("cofre anterior à 0.11.0: 409 vault_outdated com a mínima", { timeout: 45_000 }, async () => {
    const { profile, call } = await area({ version: "0.9.1" });
    const fiscal = await member("operator", profile, ["erp:fiscal"]);
    const r = await call(fiscal, "GET", report);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: { code: "vault_outdated", min_version: "0.11.0" } });
  });
});
