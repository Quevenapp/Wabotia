// NF-e recebidas (cofre 0.9.0) pelo provedor: leitura por cursor (a mesma
// nota reaparece), resumo antes da manifestação, manifestação do destinatário
// (evento fiscal; repetir não envia nada), consulta por chave com a cota de 18
// por hora, estado da distribuição e os códigos novos. Só cofre simulado:
// nada aqui fala com o Ambiente Nacional.
import { describe, expect, it } from "vitest";
import { createNfapiProvider, retryAtOf } from "../../../src/erp/emissor/nfapi-provider.ts";
import { FiscalError } from "../../../src/erp/emissor/provider.ts";
import { FAKE_PDF } from "./fake-vault";
import { vaultArea } from "./helpers";

const provider = createNfapiProvider({ delays: [0, 0, 0] });

describe("NF-e recebidas", () => {
  it("leitura por cursor: guarda last_sequence; a nota que muda reaparece com a mesma ref", async () => {
    const { ctx, vault } = await vaultArea();
    const a = vault.addReceived({ papel: "destinatario" });
    const b = vault.addReceived({ papel: "terceiro" });
    const first = await provider.received(ctx);
    expect(first.items.map((n) => [n.provider_ref, n.role, n.xml_available])).toEqual([
      [a.id, "recipient", false],
      [b.id, "third_party", false],
    ]);
    expect(first).toMatchObject({ last_sequence: b.sequencia, has_more: false });
    expect(first.items[0]).toMatchObject({
      access_key: a.chaveAcesso,
      environment: "homologacao",
      issuer: { name: "FORNECEDOR SINTETICO LTDA" },
      status: "authorized",
      manifestation: null,
      manifestations: [],
      repeated: null,
    });
    // Nada novo: a mesma sequência volta, sem itens.
    expect(await provider.received(ctx, { after: first.last_sequence })).toEqual({ items: [], last_sequence: first.last_sequence, has_more: false });
    // A nota a recebe o XML completo: reaparece depois do cursor, com a mesma ref.
    vault.deliverXml(a.id);
    const next = await provider.received(ctx, { after: first.last_sequence });
    expect(next.items.map((n) => [n.provider_ref, n.xml_available])).toEqual([[a.id, true]]);
    // Página menor que o total: has_more.
    expect(await provider.received(ctx, { limit: 1 })).toMatchObject({ has_more: true, last_sequence: b.sequencia });
    expect(await provider.received(ctx, { after: -1 }).catch((e) => e)).toMatchObject({ status: 400, code: "fiscal_invalid_request" });
    // Ler não consulta o governo.
    expect(vault.sefazSends.size).toBe(0);
  });

  it("antes da manifestação só há resumo: XML e DANFE dão fiscal_xml_unavailable", async () => {
    const { ctx, vault } = await vaultArea();
    const n = vault.addReceived();
    for (const run of [() => provider.receivedXml(ctx, n.id), () => provider.receivedDanfe(ctx, n.id)])
      expect(await run().catch((e) => e)).toMatchObject({ status: 409, code: "fiscal_xml_unavailable", details: { provider_code: "xml_indisponivel" } });
    vault.deliverXml(n.id);
    expect(await provider.receivedXml(ctx, n.id)).toContain(n.chaveAcesso);
    expect((await provider.receivedDanfe(ctx, n.id)).body).toEqual(FAKE_PDF);
    expect(await provider.receivedGet(ctx, "rec_naoexiste").catch((e) => e)).toMatchObject({ status: 404, code: "fiscal_document_not_found" });
  });

  it("manifestação: registra uma vez; repetir devolve repeated sem enviar nada", async () => {
    const { ctx, vault } = await vaultArea();
    const n = vault.addReceived();
    const done = await provider.manifest(ctx, { ref: n.id }, { type: "ciencia" });
    expect(done).toMatchObject({
      repeated: false,
      manifestation: { type: "ciencia", sequence: 1, protocol: expect.any(String), xml_available: true },
      manifestations: [{ type: "ciencia" }],
    });
    expect(done.sequence).toBeGreaterThan(n.sequencia - 1);
    const again = await provider.manifest(ctx, { ref: n.id }, { type: "ciencia" });
    expect(again).toMatchObject({ repeated: true, manifestations: [{ type: "ciencia" }] });
    expect(vault.sefazSends.get(n.id)).toBe(1);
    expect(await provider.manifestationXml(ctx, n.id, "ciencia", 1)).toContain("procEventoNFe");
    // Confirmação depois da ciência: vale; ciência depois de outra: 409.
    expect((await provider.manifest(ctx, { ref: n.id }, { type: "confirmacao" })).manifestation).toMatchObject({ type: "confirmacao" });
    expect(await provider.manifest(ctx, { ref: n.id }, { type: "ciencia" }).catch((e) => e)).toMatchObject({
      status: 409,
      code: "fiscal_manifestation_already_registered",
      details: { provider_code: "manifestacao_ja_registrada", retryable: false },
    });
    expect(vault.sefazSends.get(n.id)).toBe(2);
  });

  it("manifestação: justificativa, limite, sem resposta conclusiva e pela chave", async () => {
    const { ctx, vault } = await vaultArea();
    const n = vault.addReceived();
    expect(await provider.manifest(ctx, { ref: n.id }, { type: "nao_realizada" }).catch((e) => e)).toMatchObject({
      status: 422,
      code: "fiscal_justification_required",
    });
    const why = "Mercadoria recusada na entrega por avaria";
    await provider.manifest(ctx, { ref: n.id }, { type: "nao_realizada", justification: why });
    await provider.manifest(ctx, { ref: n.id }, { type: "desconhecimento" });
    await provider.manifest(ctx, { ref: n.id }, { type: "nao_realizada", justification: `${why} (retificada)` });
    expect(await provider.manifest(ctx, { ref: n.id }, { type: "desconhecimento" }).then(() => provider.manifest(ctx, { ref: n.id }, { type: "nao_realizada", justification: `${why} de novo` })).catch((e) => e)).toMatchObject({
      status: 422,
      code: "fiscal_manifestation_limit",
    });
    // 502: não repete sozinho (evento fiscal); quem chama decide, e repetir é seguro.
    const other = vault.addReceived();
    vault.plan.push("inconclusive");
    expect(await provider.manifest(ctx, { ref: other.id }, { type: "ciencia" }).catch((e) => e)).toMatchObject({
      status: 503,
      code: "fiscal_no_conclusive_answer",
      details: { retryable: true },
    });
    // As 6 manifestações acima chegaram ao cofre (as recusadas também), mais esta.
    expect(vault.calls.filter((c) => c.method === "POST")).toHaveLength(7);
    // Pela chave de acesso (nota que o cofre ainda não baixou).
    const byKey = await provider.manifest(ctx, { access_key: "35261144555666000181550010000001011876543213" }, { type: "ciencia" });
    expect(byKey).toMatchObject({ access_key: "35261144555666000181550010000001011876543213", manifestation: { type: "ciencia" } });
    expect(vault.calls.at(-1)).toMatchObject({ path: "/v1/nfe-recebidas/manifestar", body: { tipo: "ciencia", chaveAcesso: byKey.access_key } });
    expect(await provider.manifest(ctx, { ref: n.id }, { type: "outro" as never }).catch((e) => e)).toMatchObject({ status: 400 });
  });

  it("consulta por chave: cota de 18 por hora com retry_at; bloqueio do Ambiente Nacional; nota não localizada", async () => {
    const { ctx, vault } = await vaultArea();
    const n = vault.addReceived();
    expect(await provider.queryAccessKey(ctx, { access_key: n.chaveAcesso })).toMatchObject({ provider_ref: n.id });
    expect(await provider.queryAccessKey(ctx, { access_key: "35261144555666000181550010000009991876543219" }).catch((e) => e)).toMatchObject({
      status: 422,
      code: "fiscal_received_note_not_found",
      details: { messages: [{ code: "137" }] },
    });
    expect(await provider.queryAccessKey(ctx, { access_key: "35261144555666000181650010000009991876543219" }).catch((e) => e)).toMatchObject({
      code: "fiscal_invalid_access_key",
    });
    for (let i = 2; i < 18; i++) await provider.queryAccessKey(ctx, { access_key: n.chaveAcesso });
    const limit = await provider.queryAccessKey(ctx, { access_key: n.chaveAcesso }).catch((e) => e);
    expect(limit).toBeInstanceOf(FiscalError);
    expect(limit).toMatchObject({ status: 429, code: "fiscal_query_limit", details: { retryable: true, retry_at: "2026-11-16T13:00:00.000Z" } });
    // Sem nova tentativa automática: cada consulta gasta a cota.
    const posts = vault.calls.filter((c) => c.path === "/v1/distribuicao/consultar-chave").length;
    // 18 aceitas (uma delas sem nota), uma com chave inválida e a recusada pelo limite.
    expect(posts).toBe(20);
    vault.state.blockedUntil = "2026-11-16T14:00:00.000Z";
    expect(await provider.queryAccessKey(ctx, { access_key: n.chaveAcesso }).catch((e) => e)).toMatchObject({
      status: 429,
      code: "fiscal_queries_blocked",
      details: { retry_at: "2026-11-16T14:00:00.000Z" },
    });
    expect(retryAtOf("Tente depois de 2026-11-17T15:00:00.000Z.")).toBe("2026-11-17T15:00:00.000Z");
    expect(retryAtOf("Tente mais tarde.")).toBeNull();
  });

  it("estado da distribuição; sem configuração no cofre, 409 próprio", async () => {
    const { ctx } = await vaultArea();
    expect(await provider.distribution(ctx)).toEqual([
      expect.objectContaining({ cnpj: "99888777000166", environment: "homologacao", uf: "SP", blocked: false, key_queries: { last_hour: 0, limit: 18 }, recovering_documents: 0 }),
    ]);
    const behind = await vaultArea({ recovering: 7 });
    expect(await provider.distribution(behind.ctx)).toEqual([expect.objectContaining({ recovering_documents: 7 })]);
    const bare = await vaultArea({ distribution: false });
    expect(await provider.distribution(bare.ctx)).toEqual([]);
    const n = bare.vault.addReceived();
    for (const run of [
      () => provider.manifest(bare.ctx, { ref: n.id }, { type: "ciencia" }),
      () => provider.queryAccessKey(bare.ctx, { access_key: n.chaveAcesso }),
    ])
      expect(await run().catch((e) => e)).toMatchObject({ status: 409, code: "fiscal_distribution_not_configured" });
  });

  it("chave só de homologação não manifesta nota de produção (403)", async () => {
    const { ctx, vault } = await vaultArea({ scope: "homologacao" });
    const n = vault.addReceived();
    n.ambiente = "producao";
    expect(await provider.manifest(ctx, { ref: n.id }, { type: "ciencia" }).catch((e) => e)).toMatchObject({
      status: 409,
      code: "fiscal_key_homologation_only",
    });
    expect(vault.sefazSends.size).toBe(0);
  });

  it("cofre 0.8.0: notas recebidas dão vault_outdated com a mínima 0.9.0", async () => {
    const { ctx, vault } = await vaultArea({ version: "0.8.0" });
    for (const run of [() => provider.received(ctx), () => provider.distribution(ctx), () => provider.manifest(ctx, { ref: "rec_1" }, { type: "ciencia" })])
      expect(await run().catch((e) => e)).toMatchObject({ status: 409, code: "vault_outdated", details: { min_version: "0.9.0" } });
    expect(vault.sefazSends.size).toBe(0);
  });
});

describe("inutilização repetida", () => {
  it("cofre 0.4.1 em diante: resposta perdida, repete uma vez e recebe repeated", async () => {
    const { ctx, vault } = await vaultArea();
    const base = { kind: "nfe" as const, series: 1, first: 15, last: 15, justification: "Número pulado por falha no sistema anterior", uf: "RJ" };
    vault.plan.push("lose");
    const r = await provider.voidRange(ctx, base);
    expect(r).toMatchObject({ repeated: true, xml_available: true, justification: base.justification, first: 15 });
    expect(vault.voids).toHaveLength(1);
    expect([...vault.sefazSends.values()]).toEqual([1]);
    expect(await provider.voidRanges(ctx, { kind: "nfe" })).toHaveLength(1);
    expect(await provider.voidRangeXml(ctx, r.provider_ref)).toContain("procInutNFe");
  });

  it("cofre anterior à 0.4.1: resposta perdida não repete (a SEFAZ recusaria a faixa)", async () => {
    const { ctx, vault } = await vaultArea({ version: "0.4.0" });
    vault.plan.push("lose");
    const error = await provider
      .voidRange(ctx, { kind: "nfe", series: 1, first: 16, last: 16, justification: "Número pulado por falha no sistema anterior", uf: "RJ" })
      .catch((e) => e);
    expect(error).toMatchObject({ status: 503, code: "fiscal_provider_unreachable" });
    expect(vault.calls.filter((c) => c.path === "/v1/inutilizacoes")).toHaveLength(1);
  });
});
