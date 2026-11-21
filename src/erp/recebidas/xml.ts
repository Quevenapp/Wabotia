// Leitura do XML da NF-e recebida (nfeProc ou NFe, modelo 55), no Worker:
// cabeçalho, emitente, destinatário, itens (com rastro de lote), totais,
// duplicatas e pagamentos. O XML vem do cofre ou do arquivo que o fornecedor
// mandou; aqui só se lê, nada é assinado nem validado contra a SEFAZ. O
// resultado vai ao motor (src/erp/domains/inbound/rpc.ts), que confere chave e
// SHA-256 contra o índice antes de usar.
import { DOMParser } from "@xmldom/xmldom";
import { classifyPurpose, documentKey, type InboundItem, type InboundNote, type InboundPurpose } from "../domains/inbound/model.ts";

export class InboundXmlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/** Tamanho máximo aceito (o XML de uma NF-e grande fica bem abaixo disso). */
export const INBOUND_XML_MAX_BYTES = 1_048_576;

type El = { getElementsByTagName(name: string): ArrayLike<El>; textContent: string | null; getAttribute(name: string): string | null; childNodes: ArrayLike<any>; localName?: string | null; nodeName: string };

const fail = (code: string, message: string): never => { throw new InboundXmlError(code, message); };

function first(parent: El | null | undefined, name: string): El | null {
  if (!parent) return null;
  const list = parent.getElementsByTagName(name);
  return list.length ? list[0] : null;
}
/** Filho direto (evita pegar, por exemplo, o CNPJ do transportador). */
function child(parent: El | null | undefined, name: string): El | null {
  if (!parent) return null;
  for (let i = 0; i < parent.childNodes.length; i++) {
    const n = parent.childNodes[i];
    if (n && n.nodeType === 1 && (n.localName ?? n.nodeName) === name) return n as El;
  }
  return null;
}
const text = (el: El | null | undefined) => {
  const v = el?.textContent?.trim();
  return v ? v : null;
};
const at = (parent: El | null | undefined, ...path: string[]) => {
  let el: El | null | undefined = parent;
  for (const name of path) el = child(el, name);
  return text(el);
};

/** Valor em reais do XML → centavos (até 2 casas; mais casas são arredondadas). */
function cents(value: string | null): number {
  if (value === null) return 0;
  if (!/^\d{1,13}(\.\d{1,10})?$/.test(value)) fail("xml_invalid_value", `O valor ${value} do XML não é um número válido.`);
  const [int, frac = ""] = value.split(".");
  const base = Number(int) * 100 + Number((frac + "00").slice(0, 2));
  return Number(frac[2] ?? "0") >= 5 ? base + 1 : base;
}
/** Quantidade do XML (qCom até 4 casas; aceita até 6). */
function quantity(value: string | null): string {
  if (value === null || !/^\d{1,11}(\.\d{1,6})?$/.test(value)) fail("xml_invalid_quantity", `A quantidade ${value ?? "vazia"} do XML não é válida.`);
  return value!;
}
function price(value: string | null): string {
  if (value === null || !/^\d{1,14}(\.\d{1,10})?$/.test(value)) fail("xml_invalid_price", `O preço ${value ?? "vazio"} do XML não é válido.`);
  return value!;
}
const day = (value: string | null) => (value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);

/** Soma o campo em todos os grupos de imposto do item com aquele nome (ICMS00, ICMS10...). */
function taxSum(imposto: El | null, group: string, field: string): number {
  const g = child(imposto, group);
  if (!g) return 0;
  let total = 0;
  for (let i = 0; i < g.childNodes.length; i++) {
    const n = g.childNodes[i];
    if (n && n.nodeType === 1) total += cents(at(n as El, field));
  }
  return total;
}

export interface ParsedInbound {
  note: InboundNote;
  purpose: InboundPurpose;
  /** O que o índice do motor guarda. */
  summary: {
    access_key: string; environment: "producao" | "homologacao"; emitter_document: string | null; emitter_name: string | null;
    series: number | null; number: number | null; issued_on: string | null; total_cents: number | null; nature: string | null;
    cfops: string[]; finality: string; recipient_document: string | null;
  };
}

/** Lê o XML da NF-e. Erro sempre com código e mensagem em português. */
export function parseInboundXml(xml: string): ParsedInbound {
  if (new TextEncoder().encode(xml).length > INBOUND_XML_MAX_BYTES) fail("xml_too_large", "O arquivo passa de 1 MB. Confira se é o XML de uma NF-e.");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail("xml_not_nfe", "O arquivo não é o XML de uma NF-e.");
  let doc: any;
  const problems: string[] = [];
  try {
    doc = new DOMParser({ onError: (level: string, message: string) => { if (level !== "warning") problems.push(message); } }).parseFromString(xml, "text/xml");
  } catch {
    fail("xml_unreadable", "Não deu para ler o arquivo como XML. Confira se ele é o XML da nota, não o PDF (DANFE).");
  }
  if (problems.length || !doc?.documentElement) fail("xml_unreadable", "Não deu para ler o arquivo como XML. Confira se ele é o XML da nota, não o PDF (DANFE).");
  const root = doc.documentElement as El;
  const inf = first(root, "infNFe");
  if (!inf) fail("xml_not_nfe", "O arquivo não é o XML de uma NF-e (falta o grupo infNFe).");
  const id = (inf!.getAttribute("Id") ?? "").replace(/^NFe/, "");
  const ide = child(inf, "ide"), emit = child(inf, "emit"), dest = child(inf, "dest"), total = child(child(inf, "total"), "ICMSTot");
  if (!/^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/.test(id)) fail("xml_access_key_invalid", "A chave de acesso do XML não é válida.");
  const model = at(ide, "mod");
  if (model !== "55") fail("xml_not_nfe", model === "65" ? "Este XML é de uma NFC-e (cupom), não de uma NF-e de compra." : "O arquivo não é o XML de uma NF-e modelo 55.");
  if (!emit || !total) fail("xml_not_nfe", "O XML não tem emitente ou totais da nota.");
  const environment = at(ide, "tpAmb") === "1" ? "producao" : "homologacao";
  const protocol = at(first(root, "protNFe"), "infProt", "nProt");
  const items: InboundItem[] = [];
  const dets = inf!.getElementsByTagName("det");
  for (let i = 0; i < dets.length; i++) {
    const det = dets[i];
    const prod = child(det, "prod"), imposto = child(det, "imposto");
    if (!prod) fail("xml_item_invalid", `O item ${i + 1} do XML não tem os dados do produto.`);
    const gtin = at(prod, "cEAN");
    const lots: InboundItem["lots"] = [];
    for (let k = 0; k < prod!.childNodes.length; k++) {
      const n = prod!.childNodes[k];
      if (n?.nodeType === 1 && (n.localName ?? n.nodeName) === "rastro") {
        const code = at(n as El, "nLote");
        if (code) lots.push({ code: code.slice(0, 60), quantity: at(n as El, "qLote"), manufactured_on: day(at(n as El, "dFab")), expires_on: day(at(n as El, "dVal")) });
      }
    }
    const position = Number(det.getAttribute("nItem") ?? i + 1);
    if (!Number.isSafeInteger(position) || position < 1 || position > 990) fail("xml_item_invalid", `O número do item ${i + 1} do XML não é válido.`);
    items.push({
      position,
      code: (at(prod, "cProd") ?? fail("xml_item_invalid", `O item ${position} do XML não tem código do produto.`)).slice(0, 60),
      gtin: gtin && /^([0-9]{8}|[0-9]{12,14})$/.test(gtin) ? gtin : null,
      description: (at(prod, "xProd") ?? "").slice(0, 120) || `Item ${position}`,
      ncm: at(prod, "NCM"),
      cfop: at(prod, "CFOP") ?? "",
      unit: (at(prod, "uCom") ?? "UN").slice(0, 6),
      quantity: quantity(at(prod, "qCom")),
      unit_price: price(at(prod, "vUnCom")),
      total_cents: cents(at(prod, "vProd")),
      discount_cents: cents(at(prod, "vDesc")),
      freight_cents: cents(at(prod, "vFrete")),
      insurance_cents: cents(at(prod, "vSeg")),
      other_cents: cents(at(prod, "vOutro")),
      ipi_cents: cents(at(child(imposto, "IPI"), "IPITrib", "vIPI")),
      icms_cents: taxSum(imposto, "ICMS", "vICMS"),
      icms_st_cents: taxSum(imposto, "ICMS", "vICMSST"),
      fcp_st_cents: taxSum(imposto, "ICMS", "vFCPST"),
      lots,
      order_reference: at(prod, "xPed"),
    });
  }
  if (!items.length) fail("xml_item_invalid", "O XML não tem itens.");
  const duplicates: InboundNote["duplicates"] = [];
  const cobr = child(inf, "cobr");
  if (cobr) for (let i = 0; i < cobr.childNodes.length; i++) {
    const n = cobr.childNodes[i];
    if (n?.nodeType === 1 && (n.localName ?? n.nodeName) === "dup") {
      const due = day(at(n as El, "dVenc"));
      if (due) duplicates.push({ number: at(n as El, "nDup"), due_on: due, amount_cents: cents(at(n as El, "vDup")) });
    }
  }
  const payments: InboundNote["payments"] = [];
  const pag = child(inf, "pag");
  if (pag) for (let i = 0; i < pag.childNodes.length; i++) {
    const n = pag.childNodes[i];
    if (n?.nodeType === 1 && (n.localName ?? n.nodeName) === "detPag") payments.push({ method: at(n as El, "tPag") ?? "99", amount_cents: cents(at(n as El, "vPag")) });
  }
  const address = child(emit, "enderEmit");
  const emitterDocument = documentKey(at(emit, "CNPJ") ?? at(emit, "CPF"));
  if (!emitterDocument) fail("xml_emitter_invalid", "O XML não traz o CNPJ ou CPF do fornecedor.");
  const issuedOn = day(at(ide, "dhEmi") ?? at(ide, "dEmi"));
  if (!issuedOn) fail("xml_date_invalid", "O XML não traz a data de emissão.");
  const nature = (at(ide, "natOp") ?? "").slice(0, 120);
  const finality = at(ide, "finNFe") ?? "1";
  const note: InboundNote = {
    access_key: id, environment, model: "55",
    series: Number(at(ide, "serie") ?? 0), number: Number(at(ide, "nNF") ?? 0), issued_on: issuedOn!,
    nature, finality, operation: at(ide, "tpNF") ?? "1",
    emitter: {
      document: emitterDocument, name: (at(emit, "xNome") ?? "Fornecedor").slice(0, 200), trade_name: at(emit, "xFant"), ie: at(emit, "IE"),
      crt: at(emit, "CRT"), phone: at(address, "fone"),
      address: {
        street: at(address, "xLgr"), number: at(address, "nro"), complement: at(address, "xCpl"), district: at(address, "xBairro"),
        city: at(address, "xMun"), city_code: at(address, "cMun"), uf: at(address, "UF"), zip: at(address, "CEP"),
      },
    },
    recipient_document: documentKey(at(dest, "CNPJ") ?? at(dest, "CPF")) || null,
    items,
    totals: {
      products_cents: cents(at(total, "vProd")), discount_cents: cents(at(total, "vDesc")), freight_cents: cents(at(total, "vFrete")),
      insurance_cents: cents(at(total, "vSeg")), other_cents: cents(at(total, "vOutro")), ipi_cents: cents(at(total, "vIPI")),
      icms_cents: cents(at(total, "vICMS")), icms_st_cents: cents(at(total, "vST")), fcp_st_cents: cents(at(total, "vFCPST")), total_cents: cents(at(total, "vNF")),
    },
    duplicates, payments, protocol,
  };
  const cfops = [...new Set(items.map((i) => i.cfop).filter((c) => /^\d{4}$/.test(c)))];
  return {
    note,
    purpose: classifyPurpose(finality, nature, cfops),
    summary: {
      access_key: id, environment, emitter_document: emitterDocument, emitter_name: note.emitter.name, series: note.series, number: note.number,
      issued_on: issuedOn, total_cents: note.totals.total_cents, nature: nature || null, cfops, finality, recipient_document: note.recipient_document,
    },
  };
}

/** SHA-256 do XML em hexadecimal (Web Crypto: roda no Worker e no Node). */
export async function xmlSha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Chave do XML no R2 da área: o hash é o nome (o mesmo arquivo nunca é gravado duas vezes). */
export const inboundXmlKey = (profile: string, sha256: string) => `erp/${profile}/recebidas/xml/${sha256}.xml`;
