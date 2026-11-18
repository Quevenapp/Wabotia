// Contingência da NFC-e (cofre 0.4.0 em diante; contrato 0.9.0): a emissão
// cai em contingência offline quando o governo não responde, a nota em
// contingência conta como nota válida, e o /consultar força a transmissão.
// Regra central: a mesma referência, repetida durante a espera da
// contingência, nunca gera segunda nota nem reenvia ao governo.
import { describe, expect, it } from "vitest";
import { createNfapiProvider, fiscalReference } from "../../../src/erp/emissor/nfapi-provider.ts";
import { CONTINGENCY_MIN_WRITE_TIMEOUT_MS, CONTINGENCY_WAIT_MS, NfapiClient } from "../../../src/erp/emissor/nfapi.ts";
import { uid } from "../../../src/types";
import { requestExample } from "./schema";
import { example, VAULT_URL, vaultArea } from "./helpers";
import { createFakeVault } from "./fake-vault";

const provider = createNfapiProvider({ delays: [0, 0, 0] });
const nfce = () => example(requestExample("POST", "/v1/nfce"));
const doc = (version = 1) => ({ document_id: uid(), version });

describe("contingência da NFC-e", () => {
  it("automática: sem resposta do governo, nota em contingência com número novo, transmitida no /consultar", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    vault.plan.push("inconclusive");
    const r = await provider.emit(ctx, "nfce", nfce(), key, { contingency: "automatic" });
    expect(vault.calls.at(-1)!.body).toMatchObject({ contingencia: "automatica", referencia: fiscalReference(key) });
    expect(r).toMatchObject({
      status: "contingency",
      replayed: false,
      protocol: null,
      xml_available: true,
      contingency: { pending: true, reason: expect.any(String), transmission_attempts: 0, normal_note_cancelled: null },
    });
    // Número novo: a tentativa normal consumiu o 1.
    expect(r.number).toBe(2);
    expect(r.access_key!.charAt(34)).toBe("9");
    expect((await provider.state(ctx)).contingency).toEqual({ pending_notes: 1 });

    // SEFAZ ainda fora: o /consultar tenta e a nota segue pendente.
    const still = await provider.reconcile(ctx, "nfce", r.provider_ref);
    expect(still).toMatchObject({ status: "contingency", contingency: { pending: true, transmission_attempts: 1 } });
    // SEFAZ de volta: o /consultar transmite.
    vault.state.sefazOnline = true;
    const sent = await provider.reconcile(ctx, "nfce", r.provider_ref);
    expect(sent).toMatchObject({ status: "authorized", contingency: { pending: false, transmission_attempts: 2 }, protocol: expect.any(String) });
    expect((await provider.state(ctx)).contingency).toEqual({ pending_notes: 0 });
  });

  it("forçada: emite direto em contingência, sem tentar o governo", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    const r = await provider.emit(ctx, "nfce", nfce(), key, { contingency: "forced" });
    expect(r).toMatchObject({ status: "contingency", contingency: { pending: true } });
    expect(vault.calls.at(-1)!.body.contingencia).toBe("forcada");
    expect(vault.sefazSends.get(fiscalReference(key)) ?? 0).toBe(0);
  });

  it("a mesma referência repetida durante a espera não gera segunda nota nem reenvia", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    const reference = fiscalReference(key);
    // 1ª chamada: o governo não responde, o cofre espera (até 20 s) e o caixa
    // desiste de esperar; a resposta se perde.
    vault.plan.push("contingency-wait");
    const first = await provider.emit(ctx, "nfce", nfce(), key, { contingency: "automatic" });
    // O provedor achou a referência em processamento: devolve, sem repetir o POST.
    expect(first).toMatchObject({ status: "processing", replayed: true, reference });
    expect(vault.calls.filter((c) => c.method === "POST")).toHaveLength(1);

    // O ERP (ou o caixa) repete a mesma emissão enquanto o cofre ainda espera.
    const during = await provider.emit(ctx, "nfce", nfce(), key, { contingency: "automatic" });
    expect(during).toMatchObject({ status: "processing", replayed: true, provider_ref: first.provider_ref });
    // Repete de novo, com outro modo de contingência: o modo não entra na comparação.
    const otherMode = await provider.emit(ctx, "nfce", nfce(), key, { contingency: "never" });
    expect(otherMode).toMatchObject({ status: "processing", provider_ref: first.provider_ref });

    // A espera termina: o cofre emite em contingência.
    vault.finishWait();
    const after = await provider.emit(ctx, "nfce", nfce(), key, { contingency: "automatic" });
    expect(after).toMatchObject({ status: "contingency", replayed: true, provider_ref: first.provider_ref });
    expect(await provider.find(ctx, "nfce", key)).toMatchObject({ status: "contingency", provider_ref: first.provider_ref });

    // Uma emissão só, um envio só ao governo (a tentativa normal), uma nota válida.
    expect([...vault.emissions.values()].filter((e) => e.referencia === reference)).toHaveLength(1);
    expect(vault.sefazSends.get(reference)).toBe(1);
    expect(vault.validNotes(reference)).toHaveLength(1);
  });

  it("resposta perdida depois da contingência: acha a nota, não repete o POST", async () => {
    const { ctx, vault } = await vaultArea();
    const key = doc();
    vault.plan.push("inconclusive");
    // A resposta da nota em contingência se perde no caminho (rede): o cofre emitiu.
    const lose = vault.fetch;
    let dropped = false;
    ctx.fetch = async (input, init) => {
      const response = await lose(input, init);
      if (!dropped && (init?.method ?? "GET") === "POST") {
        dropped = true;
        throw new TypeError("network connection lost");
      }
      return response;
    };
    const r = await provider.emit(ctx, "nfce", nfce(), key, { contingency: "automatic" });
    expect(r).toMatchObject({ status: "contingency", replayed: true });
    expect(vault.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(vault.sefazSends.get(fiscalReference(key))).toBe(1);
  });

  it("nota em contingência conta como nota válida na regra das versões", async () => {
    const { ctx } = await vaultArea();
    const key = doc(1);
    await provider.emit(ctx, "nfce", nfce(), key, { contingency: "forced" });
    const error = await provider.emit(ctx, "nfce", nfce(), { ...key, version: 2 }).catch((e) => e);
    expect(error).toMatchObject({ status: 409, code: "fiscal_previous_version_open", details: { emission: { status: "contingency" } } });
  });

  it("cofre anterior à 0.8.0: a emissão dá vault_outdated antes de enviar, com ou sem contingência", async () => {
    for (const version of ["0.3.2", "0.7.0"]) {
      const { ctx, vault } = await vaultArea({ version });
      for (const options of [{ contingency: "automatic" as const }, {}]) {
        const error = await provider.emit(ctx, "nfce", nfce(), doc(), options).catch((e) => e);
        expect(error).toMatchObject({ status: 409, code: "vault_outdated", details: { min_version: "0.8.0" } });
      }
      expect(vault.calls.filter((c) => c.method === "POST")).toHaveLength(0);
      expect(vault.emissions.size).toBe(0);
    }
    const { ctx } = await vaultArea({ version: "0.8.0" });
    expect((await provider.emit(ctx, "nfce", nfce(), doc(), { contingency: "automatic" })).status).toBe("authorized");
  });

  it("o tempo-limite de escrita cobre a espera de 20 s do cofre", async () => {
    expect(CONTINGENCY_MIN_WRITE_TIMEOUT_MS).toBeGreaterThan(CONTINGENCY_WAIT_MS + 10_000);
    const vault = createFakeVault();
    // Cofre que demora 40 ms (a "espera"); tempo-limite configurado de 10 ms.
    const slow: typeof fetch = (input, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(vault.fetch(input, init)), 40);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal!.reason);
        });
      });
    const api = new NfapiClient({ url: VAULT_URL, apiKey: vault.apiKey, fetch: slow, writeTimeoutMs: 10 });
    const pedido = requestExample("POST", "/v1/nfce");
    expect(await api.emitir("nfce", { ...pedido, contingencia: "nunca" }).catch((e) => e)).toMatchObject({ kind: "timeout" });
    const ok = await api.emitir("nfce", { ...pedido, referencia: "caixa1-venda-5002", contingencia: "automatica" });
    expect(ok.status).toBe(201);
  });
});
