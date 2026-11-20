// Provedor NFapi: repetição e idempotência com respostas perdidas, versões do
// documento, rejeição, mapeamento de erros e emissor não configurado.
// Regra central: nunca duas notas para o mesmo documento do ERP.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createNfapiProvider, fiscalReference } from "../../../src/erp/emissor/nfapi-provider.ts";
import { fiscalProviderFor } from "../../../src/erp/emissor/index.ts";
import { FiscalError, REGISTRATION_REJECTIONS } from "../../../src/erp/emissor/provider.ts";
import { uid } from "../../../src/types";
import { requestExample } from "./schema";
import { example, vaultArea } from "./helpers";

const provider = createNfapiProvider({ delays: [0, 0, 0] });
const nfce = () => example(requestExample("POST", "/v1/nfce"));
const nfe = () => example(requestExample("POST", "/v1/nfe"));
const doc = (version = 1) => ({ document_id: uid(), version });

/** Notas válidas no governo para o documento (inclui autorizadas que o cofre não soube). */
const notesFor = (vault: Awaited<ReturnType<typeof vaultArea>>["vault"], documentId: string) =>
  vault.authorizedAtSefaz.filter((id) => vault.emissions.get(id)?.referencia?.includes(documentId)).length;

describe("referência derivada do documento", () => {
  it("é estável e recusa chave inválida", () => {
    const key = { document_id: "0b5c3f0e-3c6a-4bb0-9a1e-7d1f2b3c4d5e", version: 2 };
    expect(fiscalReference(key)).toBe("wb.0b5c3f0e-3c6a-4bb0-9a1e-7d1f2b3c4d5e.v2");
    expect(fiscalReference({ ...key })).toBe(fiscalReference(key));
    for (const bad of [
      { document_id: "", version: 1 },
      { document_id: "a b", version: 1 },
      { document_id: "x", version: 0 },
      { document_id: "x", version: 1.5 },
    ])
      expect(() => fiscalReference(bad)).toThrow(FiscalError);
  });
});

describe("emissão", () => {
  it("emite e devolve o resultado neutro", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    const r = await provider.emit(ctx, "nfce", nfce(), key);
    expect(r).toMatchObject({
      kind: "nfce",
      status: "authorized",
      reference: fiscalReference(key),
      environment: "homologacao",
      series: "1",
      number: 1,
      replayed: false,
      xml_available: true,
    });
    expect(r.access_key).toHaveLength(44);
    expect(r.qr_code).toBeTruthy();
    expect(vault.calls.filter((c) => c.method === "POST")[0].body.referencia).toBe(fiscalReference(key));
  });

  it("repetir a mesma chave devolve a mesma nota (replayed)", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    const first = await provider.emit(ctx, "nfe", nfe(), key);
    const second = await provider.emit(ctx, "nfe", nfe(), key);
    expect(second).toMatchObject({ provider_ref: first.provider_ref, status: "authorized", replayed: true });
    expect(notesFor(vault, key.document_id)).toBe(1);
  });

  it("resposta perdida: procura a referência e não reenvia", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    vault.plan.push("lose");
    const r = await provider.emit(ctx, "nfce", nfce(), key);
    expect(r).toMatchObject({ status: "authorized", replayed: true });
    expect(vault.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/cofre", "GET /v1/nfce", "POST /v1/nfce", "GET /v1/nfce"]);
    expect(notesFor(vault, key.document_id)).toBe(1);
  });

  it("página de erro da Cloudflare depois de emitir: mesma coisa", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    vault.plan.push("gateway");
    const r = await provider.emit(ctx, "nfe", nfe(), key);
    expect(r.status).toBe("authorized");
    expect(vault.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(notesFor(vault, key.document_id)).toBe(1);
  });

  it("pedido que não chegou: não acha a referência e reenvia uma vez", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    vault.plan.push("drop");
    const r = await provider.emit(ctx, "nfce", nfce(), key);
    expect(r).toMatchObject({ status: "authorized", replayed: false });
    expect(vault.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/cofre", "GET /v1/nfce", "POST /v1/nfce", "GET /v1/nfce", "POST /v1/nfce"]);
    expect(notesFor(vault, key.document_id)).toBe(1);
  });

  it("502 sem resposta conclusiva: consulta antes de repetir; autorizada no governo, para aí", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    vault.plan.push("inconclusive");
    const r = await provider.emit(ctx, "nfce", nfce(), key);
    expect(r).toMatchObject({ status: "authorized", replayed: true });
    expect(vault.calls.map((c) => `${c.method} ${c.path.replace(/nfc_\w+/, "{id}")}`)).toEqual([
      "GET /v1/cofre",
      "GET /v1/nfce",
      "POST /v1/nfce",
      "POST /v1/nfce/{id}/consultar",
    ]);
    expect(notesFor(vault, key.document_id)).toBe(1);
  });

  it("502 e o governo não recebeu: a consulta fecha como rejeitada e só então repete", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    vault.sefaz.set(fiscalReference(key), "absent");
    vault.plan.push("inconclusive");
    const r = await provider.emit(ctx, "nfce", nfce(), key);
    // A consulta encerra a primeira tentativa como rejeitada (217); a
    // referência rejeitada pode ser reenviada e vira a nota.
    expect(r.status).toBe("rejected");
    expect(r.messages[0].code).toBe("217");
    const again = await provider.emit(ctx, "nfce", nfce(), key);
    expect(again).toMatchObject({ status: "authorized", provider_ref: r.provider_ref, number: r.number });
    expect(vault.calls.filter((c) => c.method === "POST" && c.path === "/v1/nfce")).toHaveLength(2);
    expect(notesFor(vault, key.document_id)).toBe(1);
  });

  it("governo mudo em todas as tentativas: devolve indefinida, sem segunda nota", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    vault.sefaz.set(fiscalReference(key), "unknown");
    vault.plan.push("inconclusive", "inconclusive", "inconclusive");
    const r = await provider.emit(ctx, "nfce", nfce(), key);
    expect(r).toMatchObject({ status: "undetermined", reference: fiscalReference(key) });
    // Versão do cofre conferida uma vez; cada repetição foi precedida de consulta.
    const seq = vault.calls.map((c) => (c.path.endsWith("/consultar") ? "C" : c.method === "POST" ? "P" : "G"));
    expect(seq.join("")).toBe("GGPCPCPC");
    expect(vault.emissions.size).toBe(1);
    // Depois o governo responde: a mesma chave fecha a nota.
    vault.sefaz.set(fiscalReference(key), "authorized");
    const later = await provider.reconcile(ctx, "nfce", r.provider_ref);
    expect(later.status).toBe("authorized");
    expect((await provider.emit(ctx, "nfce", nfce(), key)).provider_ref).toBe(r.provider_ref);
    expect(vault.emissions.size).toBe(1);
  });

  it("respostas perdidas em sequência, em várias ordens: no máximo uma nota", async () => {
    const plans: string[][] = [
      ["lose", "lose", "lose"],
      ["drop", "lose"],
      ["inconclusive", "lose"],
      ["drop", "drop", "inconclusive"],
      ["gateway", "drop"],
      ["inconclusive", "inconclusive", "lose"],
    ];
    for (const plan of plans) {
      const { ctx, vault } = await vaultArea();
      const key = doc();
      vault.plan.push(...(plan as any));
      const r = await provider.emit(ctx, "nfce", nfce(), key).catch((e) => e);
      // Repetir de novo (o ERP faria numa próxima rodada) também não duplica.
      await provider.emit(ctx, "nfce", nfce(), key).catch(() => null);
      expect(notesFor(vault, key.document_id), plan.join(",")).toBeLessThanOrEqual(1);
      expect(vault.emissions.size, plan.join(",")).toBe(1);
      if (!(r instanceof Error)) expect(["authorized", "undetermined"], plan.join(",")).toContain(r.status);
    }
  });

  it("409 referência com conteúdo diferente nunca é repetido", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    await provider.emit(ctx, "nfce", nfce(), key);
    const changed = { ...nfce(), troco: 10 };
    const error = await provider.emit(ctx, "nfce", changed, key).catch((e) => e);
    expect(error).toBeInstanceOf(FiscalError);
    expect(error).toMatchObject({ status: 409, code: "fiscal_reference_conflict" });
    expect(error.details).toMatchObject({ provider_code: "referencia_com_conteudo_diferente", retryable: false });
    expect(vault.calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("rejeição volta como resultado, com cStat e xMotivo; corrigida, a mesma chave emite", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    vault.plan.push("reject");
    const r = await provider.emit(ctx, "nfe", nfe(), key);
    expect(r).toMatchObject({ status: "rejected", messages: [{ code: "539", description: expect.any(String) }] });
    const fixed = await provider.emit(ctx, "nfe", { ...nfe(), naturezaOperacao: "Venda corrigida" }, key);
    expect(fixed).toMatchObject({ status: "authorized", provider_ref: r.provider_ref });
    expect(notesFor(vault, key.document_id)).toBe(1);
  });

  it("rejeição de cadastro (245, 181) vira erro próprio, com cStat e xMotivo, sem repetir", async () => {
    const cases = [
      ["245", "fiscal_issuer_not_accredited", /credenciar na SEFAZ/],
      ["181", "fiscal_recipient_not_registered", /destinatário na Receita Federal/],
    ] as const;
    for (const [cstat, code, text] of cases) {
      const { ctx, vault } = await vaultArea();
      const key = doc();
      vault.plan.push(`reject:${cstat}`);
      const error = await provider.emit(ctx, "nfce", nfce(), key).catch((e) => e);
      expect(error, cstat).toBeInstanceOf(FiscalError);
      expect(error, cstat).toMatchObject({ status: 422, code });
      expect(error.message, cstat).toMatch(text);
      expect(error.details, cstat).toMatchObject({
        provider_code: "nfe_rejeitada",
        retryable: false,
        messages: [{ code: cstat, description: expect.stringMatching(/^Rejeição: /) }],
        emission: { status: "rejected", reference: fiscalReference(key) },
      });
      expect(vault.calls.filter((c) => c.method === "POST"), cstat).toHaveLength(1);
    }
    expect(Object.keys(REGISTRATION_REJECTIONS).sort()).toEqual(["181", "245"]);
  });

  it("denegada volta como resultado", async () => {
    const { ctx, vault } = await vaultArea();
    vault.plan.push("deny");
    const r = await provider.emit(ctx, "nfe", nfe(), doc());
    expect(r).toMatchObject({ status: "denied", messages: [{ code: "302" }] });
  });

  it("contingência só na NFC-e; sem pedir, a nota vem sem contingência", async () => {
    const { ctx, vault } = await vaultArea();
    expect(provider.contingency).toEqual(["automatic", "forced"]);
    expect("transmitContingency" in provider).toBe(false);
    const error = await provider.emit(ctx, "nfe", nfe(), doc(), { contingency: "automatic" }).catch((e) => e);
    expect(error).toMatchObject({ status: 422, code: "fiscal_contingency_not_supported" });
    const invalid = await provider.emit(ctx, "nfce", nfce(), doc(), { contingency: "offline" as never }).catch((e) => e);
    expect(invalid).toMatchObject({ status: 400, code: "fiscal_invalid_request", details: { field: "contingency" } });
    expect(vault.calls).toHaveLength(0);
    const plain = await provider.emit(ctx, "nfce", nfce(), doc());
    expect(plain.contingency).toBeNull();
    expect(vault.calls.at(-1)!.body).not.toHaveProperty("contingencia");
    await provider.emit(ctx, "nfce", nfce(), doc(), { contingency: "never" });
    expect(vault.calls.at(-1)!.body.contingencia).toBe("nunca");
  });

  it("dataEmissao sai do pedido por padrão; keep_issue_date a mantém", async () => {
    const { ctx, vault } = await vaultArea();
    const dated = { ...nfe(), dataEmissao: "2026-11-16T10:00:00-03:00" };
    await provider.emit(ctx, "nfe", dated, doc());
    expect(vault.calls.at(-1)!.body).not.toHaveProperty("dataEmissao");
    // Repetir com outra data na mesma chave não vira conteúdo diferente.
    const key = doc();
    await provider.emit(ctx, "nfe", dated, key);
    expect((await provider.emit(ctx, "nfe", { ...dated, dataEmissao: "2026-11-16T10:05:00-03:00" }, key)).replayed).toBe(true);
    await provider.emit(ctx, "nfe", dated, doc(), { keep_issue_date: true });
    expect(vault.calls.at(-1)!.body.dataEmissao).toBe("2026-11-16T10:00:00-03:00");
  });

  it("500 erro_interno depois de emitir: procura a referência, sem segunda nota", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    vault.plan.push("internal");
    const r = await provider.emit(ctx, "nfce", nfce(), key);
    expect(r).toMatchObject({ status: "authorized", replayed: true });
    expect(vault.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(vault.calls.at(-1)!.path).toBe("/v1/nfce");
    expect(notesFor(vault, key.document_id)).toBe(1);
  });

  it("referência do pedido diferente da derivada é recusada antes de chamar o cofre", async () => {
    const { ctx, vault } = await vaultArea();
    const error = await provider.emit(ctx, "nfce", { ...nfce(), referencia: "outra" }, doc()).catch((e) => e);
    expect(error).toMatchObject({ code: "fiscal_invalid_request", details: { field: "referencia" } });
    expect(vault.calls).toHaveLength(0);
  });
});

describe("versões do documento", () => {
  it("rejeitada: reenvia na mesma versão; versão nova só depois de cancelar", async () => {
    const { ctx, vault } = await vaultArea();
    const id = uid();
    vault.plan.push("reject");
    expect((await provider.emit(ctx, "nfe", nfe(), { document_id: id, version: 1 })).status).toBe("rejected");
    // v2 com a v1 rejeitada: recusado, sem POST (a v1 aceita o pedido corrigido).
    const posts = () => vault.calls.filter((c) => c.method === "POST").length;
    const before = posts();
    const reuse = await provider
      .emit(ctx, "nfe", { ...nfe(), naturezaOperacao: "Venda v2" }, { document_id: id, version: 2 })
      .catch((e) => e);
    expect(reuse).toMatchObject({ status: 409, code: "fiscal_previous_version_reusable" });
    expect(reuse.details.emission).toMatchObject({ status: "rejected", reference: `wb.${id}.v1` });
    expect(posts()).toBe(before);
    const v1 = await provider.emit(ctx, "nfe", { ...nfe(), naturezaOperacao: "Venda corrigida" }, { document_id: id, version: 1 });
    expect(v1).toMatchObject({ status: "authorized", reference: `wb.${id}.v1` });
    // v2 com a v1 autorizada: recusado.
    const open = await provider.emit(ctx, "nfe", nfe(), { document_id: id, version: 2 }).catch((e) => e);
    expect(open).toMatchObject({ status: 409, code: "fiscal_previous_version_open" });
    expect(open.details.emission).toMatchObject({ status: "authorized", provider_ref: v1.provider_ref });
    // Cancelada a v1, a v2 sai.
    await provider.cancel(ctx, "nfe", v1.provider_ref, { justification: "Dados do destinatário errados" });
    expect((await provider.emit(ctx, "nfe", nfe(), { document_id: id, version: 2 })).status).toBe("authorized");
    expect(notesFor(vault, id)).toBe(2);
    expect(vault.validNotes(`wb.${id}.`)).toHaveLength(1);
  });

  it("denegada consome o número: a versão nova sai sem cancelamento", async () => {
    const { ctx, vault } = await vaultArea();
    const id = uid();
    vault.plan.push("deny");
    expect((await provider.emit(ctx, "nfe", nfe(), { document_id: id, version: 1 })).status).toBe("denied");
    expect((await provider.emit(ctx, "nfe", nfe(), { document_id: id, version: 2 })).status).toBe("authorized");
  });

  it("versão anterior de outro ambiente não bloqueia", async () => {
    const { ctx } = await vaultArea({
      series: [
        { modelo: "nfce", ambiente: "homologacao", serie: 1, proximoNumero: 1 },
        { modelo: "nfce", ambiente: "producao", serie: 1, proximoNumero: 1 },
      ],
    });
    const id = uid();
    await provider.emit(ctx, "nfce", nfce(), { document_id: id, version: 1 });
    expect(
      (await provider.emit(ctx, "nfce", { ...nfce(), ambiente: "producao" }, { document_id: id, version: 2 })).status,
    ).toBe("authorized");
  });

  it("versão anterior indefinida é consultada; autorizada no governo, bloqueia a nova", async () => {
    const { ctx, vault } = await vaultArea();
    const id = uid();
    vault.sefaz.set(`wb.${id}.v1`, "unknown");
    vault.plan.push("inconclusive", "inconclusive", "inconclusive");
    expect((await provider.emit(ctx, "nfce", nfce(), { document_id: id, version: 1 })).status).toBe("undetermined");
    vault.sefaz.set(`wb.${id}.v1`, "authorized");
    const error = await provider.emit(ctx, "nfce", nfce(), { document_id: id, version: 2 }).catch((e) => e);
    expect(error).toMatchObject({ code: "fiscal_previous_version_open" });
    expect(error.details.emission.status).toBe("authorized");
    expect(notesFor(vault, id)).toBe(1);
  });
});

describe("erros do cofre → erros do ERP", () => {
  it("série não cadastrada", async () => {
    const { ctx } = await vaultArea({ series: [] });
    const error = await provider.emit(ctx, "nfce", nfce(), doc()).catch((e) => e);
    expect(error).toMatchObject({ status: 422, code: "fiscal_series_not_registered" });
    expect(error.details.provider_code).toBe("serie_nao_cadastrada");
  });

  it("UF não atendida (NFC-e fora de SP)", async () => {
    const { ctx } = await vaultArea();
    const pedido = nfce();
    pedido.emitente.endereco.uf = "RJ";
    pedido.emitente.endereco.codigoMunicipio = "3304557";
    const error = await provider.emit(ctx, "nfce", pedido, doc()).catch((e) => e);
    expect(error).toMatchObject({ status: 422, code: "fiscal_uf_not_supported" });
  });

  it("inutilização extinta em SP, AC e BA (BA nem é atendida)", async () => {
    const { ctx } = await vaultArea();
    const base = { kind: "nfe" as const, series: 1, first: 15, last: 15, justification: "Número pulado por falha no sistema anterior" };
    for (const uf of ["SP", "AC"]) {
      const error = await provider.voidRange(ctx, { ...base, uf }).catch((e) => e);
      expect(error, uf).toMatchObject({ status: 422, code: "fiscal_void_range_abolished" });
      expect(error.message).toContain("deixou de existir");
    }
    expect(await provider.voidRange(ctx, { ...base, uf: "BA" }).catch((e) => e)).toMatchObject({
      code: "fiscal_uf_not_supported",
    });
    expect(await provider.voidRange(ctx, { ...base, uf: "RJ" })).toMatchObject({ protocol: expect.any(String), first: 15 });
  });

  it("validação preserva o campo; chave recusada e só homologação", async () => {
    const { ctx } = await vaultArea({ scope: "homologacao" });
    const bad = { ...nfce(), naturezaOperacao: "" };
    expect(await provider.emit(ctx, "nfce", bad, doc()).catch((e) => e)).toMatchObject({
      status: 422,
      code: "fiscal_invalid_request",
      details: { field: "naturezaOperacao", provider_code: "requisicao_invalida" },
    });
    expect(await provider.emit(ctx, "nfce", { ...nfce(), ambiente: "producao" }, doc()).catch((e) => e)).toMatchObject({
      code: "fiscal_key_homologation_only",
    });
  });

  it("erro 1042 vira fiscal_provider_same_zone, sem repetir", async () => {
    const { ctx, vault } = await vaultArea();
    vault.plan.push("same-zone");
    const error = await provider.emit(ctx, "nfce", nfce(), doc()).catch((e) => e);
    expect(error).toMatchObject({ status: 502, code: "fiscal_provider_same_zone" });
    expect(vault.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("cofre fora do ar em todas as tentativas: 503 que pode ser repetido", async () => {
    const { ctx, vault } = await vaultArea();
    vault.plan.push("drop", "drop", "drop");
    const error = await provider.emit(ctx, "nfce", nfce(), doc()).catch((e) => e);
    expect(error).toMatchObject({ status: 503, code: "fiscal_provider_unreachable", details: { retryable: true } });
    expect(vault.emissions.size).toBe(0);
  });
});

describe("eventos e leituras", () => {
  it("CC-e repetida confirmada mantém a sequência sem transformar cancelamento inconclusivo em sucesso", async () => {
    const { ctx, vault } = await vaultArea();
    const emitted = await provider.emit(ctx, "nfe", nfe(), doc());
    let registered: Record<string, unknown> | null = null;
    ctx.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (init?.method === "POST" && url.pathname.endsWith("/carta-correcao")) {
        if (registered) return Response.json({ ...registered, repetido: true });
        const response = await vault.fetch(input, init);
        registered = await response.clone().json() as Record<string, unknown>;
        return response;
      }
      if (init?.method === "POST" && url.pathname.endsWith("/cancelar"))
        return Response.json({ ...registered, situacao: "autorizada", repetido: true });
      return vault.fetch(input, init);
    };
    const text = "Endereço de entrega: Rua das Acácias, 45";
    expect(await provider.correct(ctx, emitted.provider_ref, text)).toMatchObject({ corrections: 1, event_repeated: false });
    expect(await provider.correct(ctx, emitted.provider_ref, text)).toMatchObject({ corrections: 1, event_repeated: true });
    expect(vault.calls.filter(call => call.method === "POST" && call.path.endsWith("/carta-correcao"))).toHaveLength(1);
    await expect(provider.cancel(ctx, "nfe", emitted.provider_ref, { justification: "Pedido cancelado pelo cliente." }))
      .rejects.toMatchObject({ code: "fiscal_no_conclusive_answer", details: { emission: { status: "authorized" } } });
    expect(vault.emissions.get(emitted.provider_ref)?.situacao).toBe("autorizada");
  });

  it("event_repeated traz o repetido do cofre no cancelamento e na carta", async () => {
    const { ctx } = await vaultArea();
    const r = await provider.emit(ctx, "nfe", nfe(), doc());
    expect(r.event_repeated).toBeNull();
    const carta = await provider.correct(ctx, r.provider_ref, "Endereço de entrega: Rua das Acácias, 45");
    expect(carta.event_repeated).toBe(false);
    const first = await provider.cancel(ctx, "nfe", r.provider_ref, { justification: "Pedido cancelado pelo cliente" });
    expect(first).toMatchObject({ status: "cancelled", event_repeated: false });
    const again = await provider.cancel(ctx, "nfe", r.provider_ref, { justification: "Pedido cancelado pelo cliente" });
    expect(again).toMatchObject({ status: "cancelled", event_repeated: true });
  });

  it("resposta do cancelamento perdida: estado lido depois, event_repeated desconhecido", async () => {
    const { ctx, vault } = await vaultArea();
    const r = await provider.emit(ctx, "nfce", nfce(), doc());
    vault.plan.push("lose");
    const c = await provider.cancel(ctx, "nfce", r.provider_ref, { justification: "Venda desfeita no caixa 1" });
    expect(c).toMatchObject({ status: "cancelled", replayed: true, event_repeated: null });
  });

  it("cancelamento sem resposta conclusiva: confere e repete uma vez", async () => {
    const { ctx, vault } = await vaultArea();
    const r = await provider.emit(ctx, "nfce", nfce(), doc());
    vault.plan.push("inconclusive");
    const c = await provider.cancel(ctx, "nfce", r.provider_ref, { justification: "Venda desfeita no caixa 1" });
    expect(c.status).toBe("cancelled");
    vault.plan.push("lose");
    const r2 = await provider.emit(ctx, "nfce", nfce(), doc());
    vault.plan.push("lose");
    expect((await provider.cancel(ctx, "nfce", r2.provider_ref, { justification: "Venda desfeita no caixa 1" })).status).toBe(
      "cancelled",
    );
  });

  it("carta de correção, XML, consulta, séries, estado e SEFAZ", async () => {
    const { ctx } = await vaultArea({ version: "0.8.0", published: "0.8.1" });
    const r = await provider.emit(ctx, "nfe", nfe(), doc());
    expect((await provider.correct(ctx, r.provider_ref, "Endereço de entrega: Rua das Acácias, 45")).corrections).toBe(1);
    expect(await provider.xml(ctx, "nfe", r.provider_ref)).toContain(r.access_key);
    expect((await provider.get(ctx, "nfe", r.provider_ref)).status).toBe("authorized");
    expect(await provider.find(ctx, "nfe", { document_id: "nunca", version: 1 })).toBeNull();
    expect(await provider.series(ctx)).toContainEqual({
      kind: "nfce",
      environment: "homologacao",
      series: 1,
      next_number: 1,
      description: null,
      cnpj: "99888777000166",
    });
    expect(await provider.state(ctx)).toMatchObject({
      version: "0.8.0",
      update: { published: "0.8.1", pending: true },
      certificate: { holder: "EMPRESA EXEMPLO LTDA", document: { kind: "cnpj", id: "99888777000166" } },
      documents: { nfse: true, nfce: ["SP"] },
    });
    expect(await provider.sefazStatus(ctx, { uf: "SP", kind: "nfce" })).toMatchObject({ in_operation: true, authorizer: "SP" });
    expect(await provider.reconcile(ctx, "nfse", "x").catch((e) => e)).toMatchObject({ code: "fiscal_not_supported" });
    expect(await provider.get(ctx, "nfe", "nfe_inexistente").catch((e) => e)).toMatchObject({
      status: 404,
      code: "fiscal_document_not_found",
    });
  });
});

describe("emissor não configurado", () => {
  it("fiscal_provider_not_configured, sem chamada de rede", async () => {
    const ctx = { env, profile: uid(), fetch: () => Promise.reject(new Error("não deveria chamar")) };
    expect(await fiscalProviderFor(ctx).catch((e) => e)).toMatchObject({ status: 409, code: "fiscal_provider_not_configured" });
    expect(await provider.emit(ctx, "nfce", nfce(), doc()).catch((e) => e)).toMatchObject({
      code: "fiscal_provider_not_configured",
    });
  });

  it("com o cofre configurado, o provedor registrado é a NFapi", async () => {
    const { ctx } = await vaultArea();
    expect((await fiscalProviderFor(ctx)).id).toBe("nfapi");
  });
});

describe("retomada isolada e evidência fiscal", () => {
  it("isola a mesma referência nos dois ambientes; assinatura antiga só aceita resultado não ambíguo", async () => {
    const { ctx, vault } = await vaultArea({ series: [
      { modelo: "nfe", ambiente: "homologacao", serie: 1, proximoNumero: 1 },
      { modelo: "nfe", ambiente: "producao", serie: 1, proximoNumero: 1 },
    ] });
    const key = doc();
    const homologation = await provider.emit(ctx, "nfe", { ...nfe(), ambiente: "homologacao" }, key);
    expect(await provider.find(ctx, "nfe", key)).toMatchObject({ provider_ref: homologation.provider_ref });
    const production = await provider.emit(ctx, "nfe", { ...nfe(), ambiente: "producao" }, key);
    expect(production.provider_ref).not.toBe(homologation.provider_ref);
    for (const result of [homologation, production]) {
      expect(await provider.find(ctx, "nfe", key, result.environment)).toMatchObject({
        provider_ref: result.provider_ref, reference: fiscalReference(key), environment: result.environment,
      });
      expect(vault.calls.at(-1)!.query).toContain(`ambiente=${result.environment}`);
    }
    await expect(provider.find(ctx, "nfe", key)).rejects.toMatchObject({ code: "fiscal_environment_required" });
  });

  it("busca com envelope inválido não libera revisão nem versão fiscal nova", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    const known = await provider.emit(ctx, "nfe", nfe(), key);
    const posts = vault.calls.filter(call => call.method === "POST" && call.path === "/v1/nfe").length;
    ctx.fetch = async (input, init) => {
      const response = await vault.fetch(input, init);
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      return init?.method === "GET" && url.pathname === "/v1/nfe"
        ? Response.json({})
        : response;
    };
    await expect(provider.find(ctx, "nfe", key, "homologacao")).rejects.toMatchObject({
      code: "fiscal_provider_unreachable",
    });
    for (const version of [1, 2]) {
      await expect(provider.emit(ctx, "nfe", { ...nfe(), naturezaOperacao: "Venda corrigida" }, { ...key, version }))
        .rejects.toMatchObject({ code: "fiscal_provider_unreachable" });
      expect(vault.calls.filter(call => call.method === "POST" && call.path === "/v1/nfe")).toHaveLength(posts);
    }
    expect(vault.emissions.size).toBe(1);
    expect(vault.emissions.get(known.provider_ref)?.situacao).toBe("autorizada");
    expect(notesFor(vault, key.document_id)).toBe(1);
  });

  it("busca não aproveita modelo, ambiente, referência ou identificador inválido", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    await provider.emit(ctx, "nfe", nfe(), key);
    for (const mutation of [
      { modelo: "nfce" }, { ambiente: "producao" }, { referencia: "wb.outro.v1" }, { id: "" },
    ]) {
      ctx.fetch = async (input, init) => {
        const response = await vault.fetch(input, init);
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.pathname === "/v1/nfe") {
          // A listagem do contrato envolve as emissões em { nfe: [...] }.
          const body = await response.json() as { nfe: Record<string, unknown>[] };
          return Response.json({ ...body, nfe: body.nfe.map(item => ({ ...item, ...mutation })) }, { status: response.status });
        }
        return response;
      };
      await expect(provider.find(ctx, "nfe", key, "homologacao")).rejects.toMatchObject({
        code: "fiscal_response_identity_mismatch", details: { emission: null, unverified_emission: mutation },
      });
    }
  });

  it("get e reconcile conferem o identificador e a identidade congelada", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    const result = await provider.emit(ctx, "nfe", nfe(), key);
    const identity = { environment: "homologacao" as const, reference: fiscalReference(key) };
    for (const method of ["get", "reconcile"] as const) {
      for (const mutation of [{ id: "nfe_outro" }, { referencia: "outra" }, { ambiente: "producao" }, { modelo: "nfce" }]) {
        ctx.fetch = async (input, init) => {
          const response = await vault.fetch(input, init);
          const body = await response.json() as Record<string, unknown>;
          return Response.json({ ...body, ...mutation }, { status: response.status });
        };
        await expect(provider[method](ctx, "nfe", result.provider_ref, identity)).rejects.toMatchObject({
          code: "fiscal_response_identity_mismatch", details: { emission: null, unverified_emission: mutation },
        });
      }
    }
  });

  it("erro indefinido não libera corpo corrigido nem versão fiscal nova", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    vault.plan.push("error");
    const error = await provider.emit(ctx, "nfe", nfe(), key).catch(error => error);
    expect(error).toMatchObject({ details: { emission: { status: "error", reference: fiscalReference(key) } } });
    const posts = () => vault.calls.filter(call => call.method === "POST" && call.path === "/v1/nfe").length;
    expect(posts()).toBe(1);
    await expect(provider.emit(ctx, "nfe", { ...nfe(), naturezaOperacao: "Venda corrigida" }, key)).rejects.toMatchObject({
      code: "fiscal_emission_not_revisable", details: { emission: { status: "error" } },
    });
    await expect(provider.emit(ctx, "nfe", nfe(), { ...key, version: 2 })).rejects.toMatchObject({
      code: "fiscal_previous_version_open", details: { emission: { status: "error" } },
    });
    expect(posts()).toBe(1);
    expect(vault.emissions.size).toBe(1);
  });

  it("emissão incerta não reenvia um corpo corrigido antes da rejeição conclusiva", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    vault.sefaz.set(fiscalReference(key), "unknown");
    vault.plan.push("inconclusive", "inconclusive", "inconclusive");
    const first = await provider.emit(ctx, "nfe", nfe(), key);
    const posts = vault.calls.filter(call => call.method === "POST" && call.path === "/v1/nfe").length;
    const uncertain = await provider.emit(ctx, "nfe", { ...nfe(), naturezaOperacao: "Venda corrigida" }, key);
    expect(uncertain).toMatchObject({ status: "undetermined", provider_ref: first.provider_ref });
    expect(vault.calls.filter(call => call.method === "POST" && call.path === "/v1/nfe")).toHaveLength(posts);
    vault.sefaz.set(fiscalReference(key), "absent");
    const fixed = await provider.emit(ctx, "nfe", { ...nfe(), naturezaOperacao: "Venda corrigida" }, key);
    expect(fixed).toMatchObject({ status: "authorized", provider_ref: first.provider_ref, reference: first.reference });
    expect(vault.emissions.size).toBe(1);
  });

  it("preserva autorização recebida dentro de 500 mesmo sem listagem posterior", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    vault.plan.push("internal-evidence");
    let writes = 0;
    ctx.fetch = async (input, init) => {
      if (init?.method === "POST") writes++;
      else if (writes) throw new TypeError("Listagem indisponível após o aceite.");
      return vault.fetch(input, init);
    };
    expect(await provider.emit(ctx, "nfe", nfe(), key)).toMatchObject({ status: "authorized", reference: fiscalReference(key) });
    expect(writes).toBe(1);
    expect(notesFor(vault, key.document_id)).toBe(1);
  });

  it("NFS-e indefinida retoma pela mesma referência e recusa conteúdo diferente", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    const body = example(requestExample("POST", "/v1/nfse"));
    vault.sefaz.set(fiscalReference(key), "unknown");
    vault.plan.push("inconclusive", "inconclusive", "inconclusive");
    const first = await provider.emit(ctx, "nfse", body, key);
    expect(first.status).toBe("undetermined");
    await expect(provider.emit(ctx, "nfse", { ...body, servico: { ...body.servico, descricao: "Serviço corrigido" } }, key))
      .rejects.toMatchObject({ code: "fiscal_reference_conflict" });
    vault.sefaz.set(fiscalReference(key), "authorized");
    expect(await provider.emit(ctx, "nfse", body, key)).toMatchObject({ status: "authorized", provider_ref: first.provider_ref });
    expect(vault.emissions.size).toBe(1);
    expect(vault.calls.some(call => call.path.endsWith("/consultar") || call.path.endsWith("/conferir"))).toBe(false);
  });

  it("evidência no erro com outro identificador não substitui a nota conhecida", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    const known = await provider.emit(ctx, "nfe", nfe(), key);
    ctx.fetch = async (input, init) => {
      const response = await vault.fetch(input, init);
      if (init?.method === "POST") {
        const emission = await response.json() as Record<string, unknown>;
        return Response.json({ erro: { codigo: "erro_interno", mensagem: "Falha após aceite." }, nfe: { ...emission, id: "nfe_outro" } }, { status: 500 });
      }
      return response;
    };
    await expect(provider.emit(ctx, "nfe", nfe(), key)).rejects.toMatchObject({
      code: "fiscal_response_identity_mismatch", details: { emission: null, unverified_emission: { id: "nfe_outro" } },
    });
    expect(vault.emissions.has(known.provider_ref)).toBe(true);
    expect(notesFor(vault, key.document_id)).toBe(1);
  });

  it("resposta tardia não rebaixa autorização nem troca a chave confirmada", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    const known = await provider.emit(ctx, "nfe", nfe(), key);
    for (const mutation of [{ situacao: "rejeitada" }, { chaveAcesso: "9".repeat(44) }]) {
      ctx.fetch = async (input, init) => {
        const response = await vault.fetch(input, init);
        if (init?.method === "POST") {
          const emission = await response.json() as Record<string, unknown>;
          return Response.json({ ...emission, ...mutation }, { status: response.status });
        }
        return response;
      };
      const error = await provider.emit(ctx, "nfe", nfe(), key).catch(error => error);
      expect(error).toBeInstanceOf(FiscalError);
      expect(error.details.unverified_emission).toMatchObject(mutation);
      if ("situacao" in mutation)
        expect(error).toMatchObject({ code: "fiscal_response_state_conflict", details: { emission: { status: "authorized" } } });
      else expect(error).toMatchObject({ code: "fiscal_response_identity_mismatch", details: { emission: null } });
    }
    expect(vault.emissions.get(known.provider_ref)?.chaveAcesso).toBe(known.access_key);
    expect(notesFor(vault, key.document_id)).toBe(1);
  });

  it("cancelamento inconclusivo preserva evidência e nunca se torna cancelado", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    const emitted = await provider.emit(ctx, "nfe", nfe(), key);
    vault.plan.push("inconclusive", "inconclusive");
    await expect(provider.cancel(ctx, "nfe", emitted.provider_ref, { justification: "Pedido cancelado pelo cliente." }, {
      environment: emitted.environment, reference: fiscalReference(key),
    })).rejects.toMatchObject({ code: "fiscal_no_conclusive_answer", details: { emission: { status: "authorized" } } });
    expect(vault.emissions.get(emitted.provider_ref)?.situacao).toBe("autorizada");
  });
});
