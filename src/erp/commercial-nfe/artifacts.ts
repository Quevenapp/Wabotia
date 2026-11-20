import { DOMParser } from "@xmldom/xmldom";
import type { FiscalContext, FiscalProvider, FiscalResult, FiscalLookupIdentity } from "../emissor/provider.ts";
import type { StoredEmission } from "./contracts.ts";

export const COMMERCIAL_FILE_LIMIT = 10 * 1024 * 1024;
/** Erro compartilhado com o motor node:test, sem dependências do Worker. */
export class CommercialNfeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CommercialNfeError";
    this.status = status;
    this.code = code;
  }
}
export interface CommercialVaultSession {
  provider: FiscalProvider;
  context: FiscalContext;
  fingerprint: string;
}

const invalidFile = (): never => { throw new CommercialNfeError(409, "fiscal_artifact_mismatch", "O arquivo do cofre não corresponde à emissão vinculada."); };
export function requireVaultBinding(emission: StoredEmission, vault: CommercialVaultSession): void {
  if (!emission.connection_fingerprint || emission.connection_fingerprint !== vault.fingerprint)
    throw new CommercialNfeError(409, "fiscal_connection_changed", "Esta emissão pertence a outro cofre. Restabeleça a conexão original para consultar o resultado.");
}

/** Verifica a identidade também nas leituras: nunca usar a referência como ID do provedor. */
export function matchesCommercialResult(emission: StoredEmission, result: FiscalResult | null): boolean {
  return !!result && result.kind === "nfe" && result.environment === emission.environment &&
    result.reference === emission.reference && typeof result.provider_ref === "string" && !!result.provider_ref &&
    (!emission.provider_id || result.provider_ref === emission.provider_id) &&
    (!emission.access_key || result.access_key === emission.access_key);
}

export function commercialLookupIdentity(emission: StoredEmission): FiscalLookupIdentity {
  return { environment: emission.environment, reference: emission.reference,
    ...(emission.access_key ? { access_key: emission.access_key } : {}) };
}

function parseXml(xml: string) {
  if (typeof xml !== "string" || !xml.length || new TextEncoder().encode(xml).byteLength > COMMERCIAL_FILE_LIMIT || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) invalidFile();
  try {
    return new DOMParser({ onError: () => invalidFile() }).parseFromString(xml, "application/xml");
  } catch { return invalidFile(); }
}

/** Só extrai metadados do retorno do evento; nunca usa o protocolo de autorização. */
export function parseCancellationXml(xml: string, emission: StoredEmission): { protocol: string; event_at: string } {
  const doc = parseXml(xml);
  const returns = doc.getElementsByTagNameNS("http://www.portalfiscal.inf.br/nfe", "retEvento");
  if (returns.length !== 1) invalidFile();
  const infos = returns.item(0)!.getElementsByTagNameNS("http://www.portalfiscal.inf.br/nfe", "infEvento");
  if (infos.length !== 1) invalidFile();
  const info = infos.item(0)!;
  const value = (name: string) => {
    const nodes = info.getElementsByTagNameNS("http://www.portalfiscal.inf.br/nfe", name);
    if (nodes.length !== 1) invalidFile();
    return nodes.item(0)!.textContent?.trim() ?? "";
  };
  if (value("chNFe") !== emission.access_key || value("tpAmb") !== (emission.environment === "producao" ? "1" : "2") ||
    value("tpEvento") !== "110111" || value("nSeqEvento") !== "1" || !["135", "155"].includes(value("cStat"))) invalidFile();
  const protocol = value("nProt"), instant = value("dhRegEvento");
  if (!/^\d{1,100}$/.test(protocol) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(instant) || !Number.isFinite(Date.parse(instant))) invalidFile();
  return { protocol, event_at: String(BigInt(Date.parse(instant)) * 1000n) };
}

export function privateFiscalFile(emissionId: string, kind: "danfe" | "xml" | "cancelamento", bytes: Uint8Array<ArrayBuffer>): Response {
  if (!bytes.byteLength || bytes.byteLength > COMMERCIAL_FILE_LIMIT || !/^[0-9a-f-]{36}$/i.test(emissionId)) invalidFile();
  const extension = kind === "danfe" ? "pdf" : "xml";
  return new Response(bytes, { headers: {
    "Content-Type": kind === "danfe" ? "application/pdf" : "application/xml; charset=utf-8",
    "Content-Length": String(bytes.byteLength),
    "Content-Disposition": `attachment; filename="${kind}-${emissionId}.${extension}"`,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } });
}

export async function commercialArtifact(emission: StoredEmission, vault: CommercialVaultSession, kind: "danfe" | "xml"): Promise<Response> {
  requireVaultBinding(emission, vault);
  if (!emission.provider_id || !emission.environment_confirmed || !["autorizada", "cancelada"].includes(emission.status))
    throw new CommercialNfeError(409, "fiscal_artifact_unavailable", "O arquivo aguarda a confirmação da emissão no cofre.");
  const current = await vault.provider.get(vault.context, "nfe", emission.provider_id, commercialLookupIdentity(emission));
  if (!matchesCommercialResult(emission, current) || !["authorized", "cancelled"].includes(current.status)) invalidFile();
  if (kind === "danfe") {
    const file = await vault.provider.danfe(vault.context, emission.provider_id);
    if (!(file.body instanceof Uint8Array) || file.size !== file.body.byteLength || !/^application\/pdf(?:\s*;|$)/i.test(file.content_type) ||
      new TextDecoder().decode(file.body.subarray(0, 5)) !== "%PDF-") invalidFile();
    return privateFiscalFile(emission.id, kind, file.body);
  }
  const xml = await vault.provider.xml(vault.context, "nfe", emission.provider_id);
  const doc = parseXml(xml), ns = "http://www.portalfiscal.inf.br/nfe";
  const invoices = doc.getElementsByTagNameNS(ns, "infNFe"), environments = doc.getElementsByTagNameNS(ns, "tpAmb");
  if (invoices.length !== 1 || invoices.item(0)!.getAttribute("Id") !== `NFe${emission.access_key}` || !environments.length) invalidFile();
  for (let i = 0; i < environments.length; i++)
    if (environments.item(i)!.textContent?.trim() !== (emission.environment === "producao" ? "1" : "2")) invalidFile();
  return privateFiscalFile(emission.id, kind, new TextEncoder().encode(xml));
}
