/** Carta de correção eletrônica (CC-e): leitura do XML do evento que o cofre
 * devolve e o PDF montado no servidor. O cofre NFapi não gera o PDF da carta
 * (só o XML, procEventoNFe), então o documento impresso sai daqui, com o
 * escritor de PDF do painel (sem rede, sem imagens). */
import { DOMParser } from "@xmldom/xmldom";
import { PdfPage, pdfDocument, wrapText } from "../../../web/erp/app/lib/pdf-writer.ts";
import { CommercialNfeError, COMMERCIAL_FILE_LIMIT } from "./artifacts.ts";

const NS = "http://www.portalfiscal.inf.br/nfe";
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
/** Texto padrão das condições de uso da CC-e (leiaute do evento 110110). */
export const CORRECTION_CONDITIONS = "A Carta de Correção é disciplinada pelo § 1º-A do art. 7º do Convênio S/N, de 15 de dezembro de 1970 e pode ser utilizada para regularização de erro ocorrido na emissão de documento fiscal, desde que o erro não esteja relacionado com: I - as variáveis que determinam o valor do imposto tais como: base de cálculo, alíquota, diferença de preço, quantidade, valor da operação ou da prestação; II - a correção de dados cadastrais que implique mudança do remetente ou do destinatário; III - a data de emissão ou de saída.";

export interface CorrectionEvent { access_key: string; sequence: number; protocol: string; event_at: string; text: string; environment: "homologacao" | "producao" }
const invalid = (): never => { throw new CommercialNfeError(409, "fiscal_artifact_mismatch", "O XML da carta de correção do cofre não corresponde a esta nota."); };

/** Confere a carta (chave, ambiente, tipo 110110, sequência, cStat 135/136) e lê protocolo, data e texto. */
export function parseCorrectionXml(xml: string, expected: { access_key: string | null; environment: string; sequence?: number }): CorrectionEvent {
  if (typeof xml !== "string" || !xml.length || new TextEncoder().encode(xml).byteLength > COMMERCIAL_FILE_LIMIT || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) invalid();
  let doc: Document;
  try { doc = new DOMParser({ onError: () => invalid() }).parseFromString(xml, "application/xml") as unknown as Document; }
  catch { return invalid(); }
  const single = (parent: Element | Document, name: string): string => {
    const nodes = parent.getElementsByTagNameNS(NS, name);
    if (nodes.length !== 1) invalid();
    return nodes.item(0)!.textContent?.trim() ?? "";
  };
  const returns = doc.getElementsByTagNameNS(NS, "retEvento"), events = doc.getElementsByTagNameNS(NS, "evento");
  if (returns.length !== 1 || events.length !== 1) invalid();
  const ret = returns.item(0)!.getElementsByTagNameNS(NS, "infEvento").item(0), sent = events.item(0)!.getElementsByTagNameNS(NS, "infEvento").item(0);
  if (!ret || !sent) return invalid();
  const key = single(ret, "chNFe"), environment = single(ret, "tpAmb") === "1" ? "producao" : "homologacao";
  const sequence = Number(single(ret, "nSeqEvento"));
  if ((expected.access_key && key !== expected.access_key) || environment !== expected.environment || single(ret, "tpEvento") !== "110110" ||
      !["135", "136"].includes(single(ret, "cStat")) || !Number.isInteger(sequence) || sequence < 1 || sequence > 20 ||
      (expected.sequence !== undefined && sequence !== expected.sequence)) invalid();
  const protocol = single(ret, "nProt"), instant = single(ret, "dhRegEvento"), text = single(sent, "xCorrecao");
  if (!/^\d{1,100}$/.test(protocol) || !INSTANT.test(instant) || !Number.isFinite(Date.parse(instant)) || !text) invalid();
  return { access_key: key, sequence, protocol, event_at: String(BigInt(Date.parse(instant)) * 1000n), text, environment };
}

const brDate = (micros: string | null) => {
  if (!micros || !/^\d+$/.test(micros)) return "";
  return new Date(Number(BigInt(micros) / 1000n)).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
};
const documentText = (value: string) => {
  const d = value.replace(/[.\-/\s]/g, "").toUpperCase();
  if (/^[0-9A-Z]{12}\d{2}$/.test(d)) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  if (/^\d{11}$/.test(d)) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  return value;
};

/** PDF A4 da carta: emitente, destinatário, nota, protocolo, a correção e as condições de uso. */
export function correctionPdf(input: {
  issuer: { name: string; document: string }; recipient: { name: string; document: string };
  emission: { number: number | null; series: number | null; access_key: string | null; environment: string };
  event: { sequence: number; protocol: string | null; event_at: string | null; text: string };
}): Uint8Array {
  const page = new PdfPage(), left = 15, width = 180;
  let y = 20;
  page.text(105, y, "CARTA DE CORREÇÃO ELETRÔNICA (CC-e)", { size: 14, font: "bold", align: "center" });
  y += 6;
  page.text(105, y, "Representação impressa do evento registrado na SEFAZ", { size: 8, align: "center", gray: 0.35 });
  if (input.emission.environment !== "producao") page.rotated(40, 200, "SEM VALOR FISCAL - HOMOLOGAÇÃO", 35, { size: 34 });
  y += 8;
  const field = (label: string, value: string, x: number, w: number, top: number, h = 11) => {
    page.rect(x, top, w, h);
    page.text(x + 1.5, top + 3.5, label.toUpperCase(), { size: 6, gray: 0.35 });
    const lines = wrapText(value || "-", (w - 3) * 72 / 25.4, 9);
    lines.slice(0, Math.max(1, Math.floor((h - 4) / 4))).forEach((line, index) => page.text(x + 1.5, top + 8 + index * 4, line, { size: 9, font: index === 0 ? "bold" : "regular" }));
  };
  field("Emitente", input.issuer.name, left, 125, y); field("CNPJ/CPF do emitente", documentText(input.issuer.document), left + 125, 55, y); y += 11;
  field("Destinatário", input.recipient.name, left, 125, y); field("CNPJ/CPF do destinatário", documentText(input.recipient.document), left + 125, 55, y); y += 11;
  field("NF-e", `${input.emission.number ?? "-"}`, left, 30, y); field("Série", `${input.emission.series ?? "-"}`, left + 30, 20, y);
  field("Chave de acesso", (input.emission.access_key ?? "").replace(/(\d{4})(?=\d)/g, "$1 "), left + 50, 130, y); y += 11;
  field("Sequência da carta", String(input.event.sequence), left, 35, y); field("Protocolo do evento", input.event.protocol ?? "-", left + 35, 70, y);
  field("Registrado em", brDate(input.event.event_at), left + 105, 75, y); y += 15;
  page.text(left, y, "CORREÇÃO", { size: 9, font: "bold" }); y += 2;
  const correction = wrapText(input.event.text, (width - 4) * 72 / 25.4, 10);
  const boxHeight = Math.max(30, correction.length * 5 + 6);
  page.rect(left, y, width, boxHeight);
  correction.forEach((line, index) => page.text(left + 2, y + 6 + index * 5, line, { size: 10 }));
  y += boxHeight + 8;
  page.text(left, y, "CONDIÇÕES DE USO", { size: 8, font: "bold" }); y += 1;
  const conditions = wrapText(CORRECTION_CONDITIONS, (width - 4) * 72 / 25.4, 7.5);
  page.rect(left, y, width, conditions.length * 3.6 + 4);
  conditions.forEach((line, index) => page.text(left + 2, y + 4.5 + index * 3.6, line, { size: 7.5 }));
  page.text(105, 287, "Esta carta substitui as anteriores da mesma nota. O arquivo oficial é o XML do evento.", { size: 7, align: "center", gray: 0.35 });
  return pdfDocument([page], { title: `CC-e ${input.emission.number ?? ""} seq ${input.event.sequence}` });
}
