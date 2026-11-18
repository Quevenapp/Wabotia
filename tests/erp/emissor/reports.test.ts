// Relatórios e exportação (cofre 0.11.0) pelo provedor: notas emitidas com
// filtros e totais do filtro inteiro, relatório do período com notasPorLer
// (quem chama repete até zerar) e o aviso de IBS/CBS da NFS-e, exportação
// que fica pronta a cada consulta, links repassados como vieram (só da origem
// do cofre; o cliente nunca baixa nem monta o endereço) e cofre antigo.
// Só cofre simulado.
import { describe, expect, it } from "vitest";
import { createNfapiProvider } from "../../../src/erp/emissor/nfapi-provider.ts";
import { BROWSER_ONLY_OPERATIONS, CLIENT_OPERATIONS } from "../../../src/erp/emissor/nfapi.ts";
import { uid } from "../../../src/types";
import { requestExample } from "./schema";
import { example, VAULT_URL, vaultArea } from "./helpers";

const provider = createNfapiProvider({ delays: [0, 0, 0] });
const nfe = () => example(requestExample("POST", "/v1/nfe"));
const nfce = () => example(requestExample("POST", "/v1/nfce"));
const doc = () => ({ document_id: uid(), version: 1 });
const DAY = "2026-11-16";
const period = { environment: "homologacao" as const, from: DAY, to: DAY };

describe("notas emitidas", () => {
  it("lista com filtros; total e amount somam o filtro inteiro, não a página", async () => {
    const { ctx, vault } = await vaultArea();
    const a = await provider.emit(ctx, "nfe", nfe(), doc());
    await provider.emit(ctx, "nfce", nfce(), doc());
    await provider.emit(ctx, "nfce", nfce(), doc());
    const page = await provider.issued(ctx, { per_page: 2 });
    expect(page.items).toHaveLength(2);
    expect(page).toMatchObject({ total: 3, page: 1, per_page: 2 });
    expect(page.amount).toBe([...vault.emissions.values()].reduce((s, e) => s + e.valor, 0));
    const only = await provider.issued(ctx, { kind: "nfe", status: "authorized", from: DAY, to: DAY, environment: "homologacao" });
    expect(only.items).toEqual([
      expect.objectContaining({ provider_ref: a.provider_ref, kind: "nfe", status: "authorized", access_key: a.access_key, xml_available: true }),
    ]);
    expect(vault.calls.at(-1)!.query).toContain("situacao=autorizada");
    for (const bad of [{ per_page: 0 }, { per_page: 201 }, { page: 0 }, { from: "16/11/2026" }, { status: "x" as never }])
      expect(await provider.issued(ctx, bad).catch((e) => e)).toMatchObject({ status: 400, code: "fiscal_invalid_request" });
  });
});

describe("relatório do período", () => {
  it("notasPorLer > 0: incompleto, com aviso e retry_after_ms; repetir até zerar", async () => {
    const { ctx, vault } = await vaultArea();
    await provider.emit(ctx, "nfe", nfe(), doc());
    vault.state.notesToRead = 400;
    const first = await provider.report(ctx, period);
    expect(first).toMatchObject({ pending_reads: 250, complete: false, retry_after_ms: 1500 });
    expect(first.warnings.map((w) => w.code)).toEqual(["pending_reads"]);
    expect((await provider.report(ctx, period)).pending_reads).toBe(100);
    const done = await provider.report(ctx, period);
    expect(done).toMatchObject({ pending_reads: 0, complete: true, retry_after_ms: null, warnings: [] });
    expect(done.issued.authorized).toMatchObject({ count: 1, taxes: { ibs: 0, cbs: 0, is: 0 } });
    expect(done.issued.by_status).toEqual([expect.objectContaining({ kind: "nfe", status: "authorized", count: 1 })]);
    expect(done.issued.by_cfop[0]).toMatchObject({ cfop: "5102", count: 1 });
    // Quem repete é quem chama: uma chamada, um pedido.
    expect(vault.reports).toHaveLength(3);
  });

  it("recebidas: só as com XML completo nos impostos; terceiro fora dos totais", async () => {
    const { ctx, vault } = await vaultArea();
    const a = vault.addReceived({ valor: 100 });
    vault.addReceived({ valor: 50 });
    vault.addReceived({ papel: "terceiro" });
    vault.deliverXml(a.id);
    const r = await provider.report(ctx, period);
    expect(r.received.authorized).toMatchObject({ count: 2, amount: 150, with_xml: 1, taxes: { total: 100 } });
    expect(r.received.as_third_party).toBe(1);
  });

  it("período validado antes do cofre: datas, ordem e 366 dias", async () => {
    const { ctx, vault } = await vaultArea();
    for (const bad of [
      { ...period, from: "2026-02-30" },
      { ...period, from: "2026-11-17" },
      { ...period, from: "2025-11-15" },
      { ...period, environment: "teste" as never },
    ])
      expect(await provider.report(ctx, bad).catch((e) => e)).toMatchObject({ status: 400, code: "fiscal_invalid_request" });
    expect(vault.calls).toHaveLength(0);
    expect((await provider.report(ctx, { ...period, from: "2025-11-16" })).complete).toBe(true);
  });

  it("chave só de homologação pedindo produção: 409 fiscal_key_homologation_only", async () => {
    const { ctx } = await vaultArea({ scope: "homologacao" });
    expect(await provider.report(ctx, { ...period, environment: "producao" }).catch((e) => e)).toMatchObject({
      status: 409,
      code: "fiscal_key_homologation_only",
    });
  });
});

describe("exportação", () => {
  it("preparando → pronta a cada consulta; links repassados como vieram, da origem do cofre", async () => {
    const { ctx, vault } = await vaultArea();
    await provider.emit(ctx, "nfe", nfe(), doc());
    vault.state.exportPolls = 2;
    const created = await provider.exportCreate(ctx, { ...period, include: ["nfe", "events"] });
    expect(created).toMatchObject({ status: "preparing", parts: [], spreadsheet: null, retry_after_ms: 1500, include: ["nfe", "events"] });
    expect(vault.calls.at(-1)!.body).toMatchObject({ incluir: ["nfe", "eventos"] });
    expect((await provider.exportGet(ctx, created.provider_ref)).status).toBe("preparing");
    const ready = await provider.exportGet(ctx, created.provider_ref);
    expect(ready).toMatchObject({ status: "ready", retry_after_ms: null, files: 1, links_valid_until: "2026-11-16T12:30:00.000Z" });
    const raw = `${VAULT_URL}/exportacoes/${created.provider_ref}/parte-1?expira=1794969000&assinatura=abc123`;
    expect(ready.parts).toEqual([{ part: 1, name: `nfapi-${DAY}-${DAY}-parte-1.zip`, url: raw }]);
    expect(ready.spreadsheet!.url).toBe(raw.replace("parte-1", "planilha"));
    expect(await provider.exports(ctx)).toHaveLength(1);
    // O servidor nunca baixa o arquivo: nenhuma chamada ao endereço do download.
    expect(vault.calls.filter((c) => c.path.startsWith("/exportacoes/"))).toHaveLength(0);
    expect(BROWSER_ONLY_OPERATIONS).toEqual(["GET /exportacoes/{id}/{arquivo}"]);
    expect(CLIENT_OPERATIONS).not.toContain("GET /exportacoes/{id}/{arquivo}");
  });

  it("link fora da origem do cofre é recusado (502), não repassado", async () => {
    const { ctx, vault } = await vaultArea();
    vault.state.linkOrigin = "https://outro-host.example";
    expect(await provider.exportCreate(ctx, period).catch((e) => e)).toMatchObject({ status: 502, code: "fiscal_provider_error" });
  });

  it("exportação que sumiu (24 h): 404 fiscal_export_not_found; pedido inválido não chega ao cofre", async () => {
    const { ctx, vault } = await vaultArea();
    expect(await provider.exportGet(ctx, "exp_nao_existe").catch((e) => e)).toMatchObject({ status: 404, code: "fiscal_export_not_found" });
    const before = vault.calls.length;
    for (const bad of [{ ...period, include: [] }, { ...period, include: ["pdf" as never] }, { ...period, to: "2026-11-15" }])
      expect(await provider.exportCreate(ctx, bad).catch((e) => e)).toMatchObject({ status: 400, code: "fiscal_invalid_request" });
    expect(vault.calls.length).toBe(before);
  });
});

describe("cofre anterior à 0.11.0", () => {
  it("notas, relatório e exportação: 409 vault_outdated com a mínima 0.11.0", async () => {
    const { ctx } = await vaultArea({ version: "0.9.1" });
    for (const run of [
      () => provider.issued(ctx),
      () => provider.report(ctx, period),
      () => provider.exportCreate(ctx, period),
      () => provider.exportGet(ctx, "exp_1"),
      () => provider.exports(ctx),
    ])
      expect(await run().catch((e) => e)).toMatchObject({ status: 409, code: "vault_outdated", details: { min_version: "0.11.0" } });
  });
});
