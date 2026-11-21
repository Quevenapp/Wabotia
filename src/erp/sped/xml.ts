// Leitura dos XML das notas para os arquivos fiscais: NF-e e NFC-e (nfeProc
// ou NFe; cabeçalho, emitente, destinatário, itens com ICMS, ICMS-ST, IPI,
// PIS e COFINS, totais e pagamento) e NFS-e do padrão nacional (tomador,
// serviço, ISS, PIS e COFINS). Só leitura: nada é assinado nem conferido
// contra o governo. Erro sempre com mensagem em português.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import { DOMParser } from "@xmldom/xmldom";
import { emptyTax, emptyTotals, type SpedDocument, type SpedItem, type SpedParty, type SpedService, type SpedTax } from "./model.ts";

export class SpedXmlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const fail = (code: string, message: string): never => { throw new SpedXmlError(code, message); };

type El = { getElementsByTagName(name: string): ArrayLike<El>; textContent: string | null; getAttribute(name: string): string | null; childNodes: ArrayLike<any>; localName?: string | null; nodeName: string };

function first(parent: El | null | undefined, name: string): El | null {
  if (!parent) return null;
  const list = parent.getElementsByTagName(name);
  return list.length ? list[0] : null;
}
function child(parent: El | null | undefined, name: string): El | null {
  if (!parent) return null;
  for (let i = 0; i < parent.childNodes.length; i++) {
    const n = parent.childNodes[i];
    if (n && n.nodeType === 1 && (n.localName ?? n.nodeName) === name) return n as El;
  }
  return null;
}
function children(parent: El | null | undefined, name?: string): El[] {
  const out: El[] = [];
  if (!parent) return out;
  for (let i = 0; i < parent.childNodes.length; i++) {
    const n = parent.childNodes[i];
    if (n && n.nodeType === 1 && (!name || (n.localName ?? n.nodeName) === name)) out.push(n as El);
  }
  return out;
}
const text = (el: El | null | undefined) => { const v = el?.textContent?.trim(); return v ? v : null; };
const at = (parent: El | null | undefined, ...path: string[]) => {
  let el: El | null | undefined = parent;
  for (const name of path) el = child(el, name);
  return text(el);
};

/** Valor em reais do XML → centavos (arredonda a terceira casa). */
export function cents(value: string | null): number {
  if (value === null) return 0;
  if (!/^-?\d{1,15}(\.\d{1,10})?$/.test(value)) fail("xml_invalid_value", `O valor ${value} do XML não é um número válido.`);
  const neg = value.startsWith("-"), [int, frac = ""] = value.replace("-", "").split(".");
  let v = Number(int) * 100 + Number((frac + "00").slice(0, 2));
  if (Number(frac[2] ?? "0") >= 5) v += 1;
  return neg ? -v : v;
}
const decimal = (value: string | null, fallback = "0") => value !== null && /^\d{1,15}(\.\d{1,10})?$/.test(value) ? value : fallback;
const day = (value: string | null) => (value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);
const digits = (value: string | null) => (value ? value.replace(/[^0-9A-Za-z]/g, "").toUpperCase() : null) || null;

function parse(xml: string): El {
  if (typeof xml !== "string" || !xml.trim()) fail("xml_empty", "O XML da nota veio vazio.");
  if (xml.length > 4_194_304) fail("xml_too_large", "O XML da nota passa de 4 MB.");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail("xml_unreadable", "O XML da nota tem uma declaração não aceita.");
  const problems: string[] = [];
  let doc: any;
  try { doc = new DOMParser({ onError: (level: string, message: string) => { if (level !== "warning") problems.push(message); } }).parseFromString(xml, "text/xml"); }
  catch { fail("xml_unreadable", "Não deu para ler o XML da nota."); }
  if (problems.length || !doc?.documentElement) fail("xml_unreadable", "Não deu para ler o XML da nota.");
  return doc.documentElement as El;
}

function party(group: El | null): SpedParty | null {
  if (!group) return null;
  const end = child(group, "enderDest") ?? child(group, "enderEmit") ?? child(group, "end");
  const nac = child(end, "endNac");
  const document = digits(at(group, "CNPJ") ?? at(group, "CPF"));
  const foreign = at(group, "idEstrangeiro") ?? at(group, "NIF");
  const country = at(end, "cPais") ?? (at(end, "endExt", "cPais") ? at(end, "endExt", "cPais") : "1058");
  return {
    document, foreign_id: foreign, name: (at(group, "xNome") ?? "").slice(0, 100), ie: (() => { const ie = at(group, "IE"); return ie && /^[0-9]+$/.test(ie) ? ie : ie === "ISENTO" ? null : ie; })(),
    uf: at(end, "UF"), city_code: at(end, "cMun") ?? at(nac, "cMun"), city: at(end, "xMun"),
    country: country === "1058" || !country ? "1058" : /^\d{1,4}$/.test(country) ? country.padStart(4, "0") : "1058",
    street: at(end, "xLgr"), number: at(end, "nro"), complement: at(end, "xCpl"), district: at(end, "xBairro"),
    postal_code: at(end, "CEP") ?? at(nac, "CEP"), phone: at(end, "fone") ?? at(group, "fone"), suframa: at(group, "ISUF"),
  };
}

/** O grupo de imposto do item (ICMS00, ICMSSN102, IPITrib...), o primeiro filho com elementos. */
const inner = (group: El | null) => children(group).find((n) => children(n).length > 0) ?? null;

function tax(group: El | null, base: string, rate: string, value: string): SpedTax {
  if (!group) return emptyTax();
  const g = inner(group) ?? group;
  return { cst: at(g, "CST"), base: cents(at(g, base)), rate: decimal(at(g, rate)), value: cents(at(g, value)) };
}

function item(det: El): SpedItem {
  const prod = child(det, "prod"), imposto = child(det, "imposto");
  const icmsGroup = inner(child(imposto, "ICMS"));
  const ipiGroup = child(imposto, "IPI");
  const ipiInner = child(ipiGroup, "IPITrib") ?? child(ipiGroup, "IPINT");
  const csosn = at(icmsGroup, "CSOSN");
  const n = Number(det.getAttribute("nItem") ?? "0");
  const gtin = at(prod, "cEANTrib") ?? at(prod, "cEAN");
  return {
    n: Number.isInteger(n) && n > 0 ? n : 0,
    code: (at(prod, "cProd") ?? "").slice(0, 60), description: (at(prod, "xProd") ?? "").slice(0, 120),
    ncm: at(prod, "NCM"), cest: at(prod, "CEST"), gtin: gtin && /^\d{8,14}$/.test(gtin) ? gtin : null, ex_tipi: at(prod, "EXTIPI"),
    unit: (at(prod, "uCom") ?? at(prod, "uTrib") ?? "UN").slice(0, 6), product_id: null,
    cfop: at(prod, "CFOP") ?? "", qty: decimal(at(prod, "qCom")), unit_value: decimal(at(prod, "vUnCom")),
    amount: cents(at(prod, "vProd")), discount: cents(at(prod, "vDesc")), freight: cents(at(prod, "vFrete")), insurance: cents(at(prod, "vSeg")), other: cents(at(prod, "vOutro")),
    origin: at(icmsGroup, "orig") ?? "0", icms_cst: csosn ?? at(icmsGroup, "CST") ?? "90", csosn: csosn !== null,
    icms_base: cents(at(icmsGroup, "vBC")), icms_rate: decimal(at(icmsGroup, "pICMS")), icms: cents(at(icmsGroup, "vICMS")),
    icms_reduction: at(icmsGroup, "pRedBC"),
    st_base: cents(at(icmsGroup, "vBCST")), st_rate: decimal(at(icmsGroup, "pICMSST")), st: cents(at(icmsGroup, "vICMSST")),
    ipi: { cst: at(ipiInner, "CST"), base: cents(at(ipiInner, "vBC")), rate: decimal(at(ipiInner, "pIPI")), value: cents(at(ipiInner, "vIPI")), enq: at(ipiGroup, "cEnq") },
    pis: tax(child(imposto, "PIS"), "vBC", "pPIS", "vPIS"),
    cofins: tax(child(imposto, "COFINS"), "vBC", "pCOFINS", "vCOFINS"),
  };
}

/** IND_PGTO pelo grupo de pagamento: 0 à vista, 1 a prazo, 2 outros. */
function payment(inf: El): string {
  const ind = at(child(inf, "ide"), "indPag");
  if (ind === "0" || ind === "1" || ind === "2") return ind;
  const pag = child(inf, "pag");
  const details = children(pag, "detPag");
  if (!details.length) return "2";
  if (details.every((d) => at(d, "tPag") === "90")) return "9";
  if (child(inf, "cobr") && children(child(inf, "cobr"), "dup").length) return "1";
  return details.some((d) => at(d, "indPag") === "1") ? "1" : "0";
}

/**
 * NF-e ou NFC-e: o documento normalizado do ponto de vista de quem emitiu
 * (emissão própria, destinatário como participante). Para a nota recebida, o
 * chamador usa `asReceived`.
 */
export function parseNfeXml(xml: string): SpedDocument {
  const root = parse(xml);
  const inf = first(root, "infNFe");
  if (!inf) return fail("xml_not_nfe", "O XML não é de uma NF-e ou NFC-e (falta o grupo infNFe).");
  const ide = child(inf, "ide"), total = child(child(inf, "total"), "ICMSTot");
  const model = at(ide, "mod");
  if (model !== "55" && model !== "65") return fail("xml_not_nfe", "O XML não é de uma NF-e (modelo 55) nem de uma NFC-e (modelo 65).");
  const key = (inf.getAttribute("Id") ?? "").replace(/^NFe/, "");
  const status = at(first(root, "protNFe"), "infProt", "cStat");
  const items = children(inf, "det").map(item);
  const t = emptyTotals();
  t.doc = cents(at(total, "vNF")); t.products = cents(at(total, "vProd")); t.discount = cents(at(total, "vDesc")); t.freight = cents(at(total, "vFrete"));
  t.insurance = cents(at(total, "vSeg")); t.other = cents(at(total, "vOutro")); t.icms_base = cents(at(total, "vBC")); t.icms = cents(at(total, "vICMS"));
  t.st_base = cents(at(total, "vBCST")); t.st = cents(at(total, "vST")); t.ipi = cents(at(total, "vIPI")); t.pis = cents(at(total, "vPIS")); t.cofins = cents(at(total, "vCOFINS"));
  const issued = day(at(ide, "dhEmi") ?? at(ide, "dEmi"));
  if (!issued) fail("xml_invalid_date", "O XML da nota não tem a data de emissão.");
  return {
    kind: model === "65" ? "nfce" : "nfe", model, direction: at(ide, "tpNF") === "0" ? "0" : "1", own: true,
    key: /^[0-9A-Z]{44}$/.test(key) ? key : null, series: at(ide, "serie") ?? "0", number: at(ide, "nNF") ?? "0", number_to: null,
    issued_on: issued!, io_on: day(at(ide, "dhSaiEnt") ?? at(ide, "dSaiEnt")),
    situation: status === "110" || status === "301" || status === "302" || status === "303" ? "04" : at(ide, "finNFe") === "2" ? "06" : "00",
    finality: at(ide, "finNFe") ?? "1", nature: at(ide, "natOp"),
    party: party(child(inf, "dest")), payment: payment(inf), freight_mode: at(child(inf, "transp"), "modFrete") ?? "9",
    totals: t, items, service: null, emitter_crt: at(child(inf, "emit"), "CRT"),
  };
}

/** A nota recebida: entrada de terceiros, o emitente como participante, a data da entrada no ERP. */
export function asReceived(doc: SpedDocument, xml: string, entryDay: string): SpedDocument {
  const root = parse(xml);
  const emitter = party(child(first(root, "infNFe"), "emit"));
  return { ...doc, kind: "entrada", own: false, direction: "0", party: emitter, io_on: entryDay };
}

/** Nota cancelada: os geradores levam só a identificação (sem itens nem valores). */
export function cancelled(doc: SpedDocument): SpedDocument {
  return { ...doc, situation: "02" };
}

/** NFS-e do padrão nacional (NFSe/infNFSe/DPS/infDPS): o tomador, o serviço e os tributos. */
export function parseNfseXml(xml: string): SpedDocument {
  const root = parse(xml);
  const infNfse = first(root, "infNFSe");
  const infDps = first(root, "infDPS");
  if (!infDps && !infNfse) return fail("xml_not_nfse", "O XML não é de uma NFS-e do padrão nacional.");
  const serv = child(infDps, "serv"), valores = child(infDps, "valores");
  const vserv = child(valores, "vServPrest"), trib = child(valores, "trib");
  const mun = child(trib, "tribMun"), fed = child(trib, "tribFed"), piscofins = child(fed, "piscofins");
  const amount = cents(at(vserv, "vServ"));
  const discount = cents(at(child(valores, "vDescCondIncond"), "vDescIncond"));
  const issBase = cents(at(child(infNfse, "valores"), "vBC")) || Math.max(0, amount - discount);
  const issRate = decimal(at(child(infNfse, "valores"), "pAliqAplic") ?? at(mun, "pAliq"));
  const iss = cents(at(child(infNfse, "valores"), "vISSQN"));
  const withheld = at(mun, "tpRetISSQN") === "2" || at(mun, "tpRetISSQN") === "3";
  const pisCofinsCst = at(piscofins, "CST");
  const pisCofinsBase = cents(at(piscofins, "vBCPisCofins"));
  const pisWithheld = ["1", "2"].includes(at(piscofins, "tpRetPisCofins") ?? "");
  const service: SpedService = {
    code: at(child(serv, "cServ"), "cTribNac"), description: (at(child(serv, "cServ"), "xDescServ") ?? "Serviço").slice(0, 120), amount, discount,
    iss_base: issBase, iss_rate: issRate, iss, iss_withheld: withheld,
    pis: { cst: pisCofinsCst, base: pisCofinsBase, rate: decimal(at(piscofins, "pAliqPis")), value: cents(at(piscofins, "vPis")) },
    cofins: { cst: pisCofinsCst, base: pisCofinsBase, rate: decimal(at(piscofins, "pAliqCofins")), value: cents(at(piscofins, "vCofins")) },
    pis_withheld: pisWithheld ? cents(at(piscofins, "vPis")) : 0, cofins_withheld: pisWithheld ? cents(at(piscofins, "vCofins")) : 0,
  };
  const issued = day(at(infNfse, "dhProc") ?? at(infDps, "dhEmi") ?? at(infDps, "dCompet"));
  if (!issued) fail("xml_invalid_date", "O XML da NFS-e não tem a data de emissão.");
  const key = (infNfse?.getAttribute("Id") ?? "").replace(/^NFS/, "");
  const t = emptyTotals();
  t.doc = cents(at(child(infNfse, "valores"), "vLiq")) || amount - discount;
  t.products = amount; t.discount = discount; t.pis = service.pis.value; t.cofins = service.cofins.value;
  return {
    kind: "nfse", model: "nfse", direction: "1", own: true, key: key || null, series: at(infDps, "serie") ?? "",
    number: at(infNfse, "nNFSe") ?? at(infDps, "nDPS") ?? "0", number_to: null, issued_on: issued!, io_on: day(at(infDps, "dCompet")),
    situation: "00", finality: "1", nature: service.description, party: party(child(infDps, "toma")), payment: "2", freight_mode: "9",
    totals: t, items: [], service, emitter_crt: null,
  };
}
