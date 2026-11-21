// Peças comuns aos geradores do SPED Fiscal e da EFD-Contribuições: o
// escritor que conta as linhas por bloco e fecha o bloco 9, os cadastros do
// bloco 0 (participantes, unidades, itens e naturezas, só os citados), as
// conversões de código (CSOSN para CST, CFOP e CST da entrada) e o valor da
// operação de cada item.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.
import { clean, onlyDigits, spedLine } from "./format.ts";
import type { SpedDocument, SpedInput, SpedItem, SpedParty } from "./model.ts";

/** Escritor: guarda as linhas e conta por registro e por bloco. */
export class SpedWriter {
  readonly lines: string[] = [];
  readonly counts = new Map<string, number>();
  private readonly blocks = new Map<string, number>();
  add(fields: readonly (string | number | null | undefined)[]): void {
    const reg = String(fields[0]);
    this.lines.push(spedLine(fields));
    this.counts.set(reg, (this.counts.get(reg) ?? 0) + 1);
    this.blocks.set(reg[0], (this.blocks.get(reg[0]) ?? 0) + 1);
  }
  /** Fecha o bloco com o x990 (a quantidade inclui o próprio x990). */
  close(block: string): void { this.add([`${block}990`, (this.blocks.get(block) ?? 0) + 1]); }
  /** Bloco 9: 9001, um 9900 por registro (inclusive os do próprio bloco 9), 9990 e 9999. */
  finish(): string[] {
    this.add(["9001", "0"]);
    const regs = [...this.counts.keys(), "9900", "9990", "9999"];
    const unique = [...new Set(regs)];
    const final = new Map(this.counts);
    final.set("9900", unique.length);
    final.set("9990", 1);
    final.set("9999", 1);
    for (const reg of unique) this.add(["9900", reg, final.get(reg) ?? 0]);
    const nine = (this.blocks.get("9") ?? 0) + 2; // + 9990 e 9999
    this.add(["9990", nine]);
    this.add(["9999", this.lines.length + 1]);
    return this.lines;
  }
}

/** CSOSN do Simples → CST do regime normal, para quem escritura a entrada (tabela de conversão usual). */
export const CSOSN_TO_CST: Readonly<Record<string, string>> = Object.freeze({
  "101": "90", "102": "90", "103": "40", "201": "10", "202": "10", "203": "30", "300": "41", "400": "41", "500": "60", "900": "90",
});
/** CST do ICMS com a origem (3 dígitos). */
export function cstIcms(item: SpedItem): string {
  const origin = /^[0-8]$/.test(item.origin) ? item.origin : "0";
  const cst = item.csosn ? (CSOSN_TO_CST[item.icms_cst] ?? "90") : item.icms_cst.padStart(2, "0").slice(-2);
  return origin + cst;
}

/** CFOP de saída do fornecedor → CFOP da entrada (5→1, 6→2, 7→3; trocas usuais). */
const ENTRY_CFOP: Readonly<Record<string, string>> = Object.freeze({ "405": "403", "656": "652", "655": "652", "667": "653", "401": "401", "403": "403", "910": "910", "949": "949" });
export function entryCfop(cfop: string): string {
  if (!/^[5-7]\d{3}$/.test(cfop)) return cfop;
  const head = { "5": "1", "6": "2", "7": "3" }[cfop[0]]!;
  const tail = ENTRY_CFOP[cfop.slice(1)] ?? cfop.slice(1);
  return head + tail;
}
/** CST do IPI de saída (50 a 99) → o de entrada (00 a 49). */
export const entryCstIpi = (cst: string | null) => cst && /^\d{2}$/.test(cst) && Number(cst) >= 50 ? String(Number(cst) - 50).padStart(2, "0") : cst;

/** Valor da operação do item (VL_OPR): produto − desconto + frete + seguro + outras + ST + IPI. */
export const itemOperation = (i: SpedItem) => i.amount - i.discount + i.freight + i.insurance + i.other + i.st + i.ipi.value;

/** Código do participante: o documento; estrangeiro, EX + o identificador; sem documento, SD + o nome. */
export function partyCode(p: SpedParty): string {
  const doc = p.document ? p.document.replace(/[^0-9A-Z]/gi, "").toUpperCase() : "";
  if (doc) return doc;
  if (p.foreign_id) return `EX${clean(p.foreign_id, 40)}`;
  return `SD${hash(clean(p.name).toUpperCase())}`;
}
/** Resumo curto e estável de um texto (código sem colisão prática). */
export function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0").toUpperCase();
}

export interface ItemEntry { code: string; description: string; unit: string; gtin: string | null; ncm: string | null; ex_tipi: string | null; cest: string | null; type: string; rate: string | null }

/** Cadastros do bloco 0, só o que é citado nos outros blocos, na ordem de chegada. */
export class Registry {
  readonly parties = new Map<string, SpedParty>();
  readonly units = new Map<string, string>();
  readonly items = new Map<string, ItemEntry>();
  readonly natures = new Map<string, string>();
  party(p: SpedParty | null): string {
    if (!p) return "";
    const code = partyCode(p);
    if (!this.parties.has(code)) this.parties.set(code, p);
    return code;
  }
  unit(u: string | null): string {
    const unit = clean(u, 6).toUpperCase() || "UN";
    if (!this.units.has(unit)) this.units.set(unit, UNIT_NAMES[unit] ?? `Unidade ${unit}`);
    return unit;
  }
  item(entry: ItemEntry): string {
    if (!this.items.has(entry.code)) { this.unit(entry.unit); this.items.set(entry.code, entry); }
    return entry.code;
  }
  nature(description: string | null): string {
    const d = clean(description, 200);
    if (!d) return "";
    for (const [code, text] of this.natures) if (text === d) return code;
    const code = String(this.natures.size + 1).padStart(3, "0");
    this.natures.set(code, d);
    return code;
  }
}

const UNIT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  UN: "Unidade", UND: "Unidade", PC: "Peça", PCT: "Pacote", CX: "Caixa", KG: "Quilograma", G: "Grama", L: "Litro", LT: "Litro", ML: "Mililitro",
  M: "Metro", M2: "Metro quadrado", M3: "Metro cúbico", CM: "Centímetro", DZ: "Dúzia", FD: "Fardo", SC: "Saco", PAR: "Par", KIT: "Kit", JG: "Jogo",
  RL: "Rolo", GL: "Galão", FR: "Frasco", TON: "Tonelada", H: "Hora", SV: "Serviço",
});

/** O item como entra no 0200: o cadastro do produto quando a entrada o ligou, senão o que veio no XML. */
export function itemEntry(input: SpedInput, item: SpedItem, prefix: string): ItemEntry {
  const product = input.products[item.code];
  if (product && item.product_id) {
    return { code: item.code, description: clean(product.description, 200) || clean(item.description, 200), unit: product.unit || item.unit,
      gtin: product.gtin, ncm: onlyDigits(product.ncm) || onlyDigits(item.ncm) || null, ex_tipi: item.ex_tipi, cest: onlyDigits(product.cest) || null, type: "00", rate: null };
  }
  return { code: `${prefix}${item.code}`.slice(0, 60), description: clean(item.description, 200) || "Item sem descrição", unit: item.unit, gtin: item.gtin,
    ncm: onlyDigits(item.ncm) || null, ex_tipi: item.ex_tipi, cest: onlyDigits(item.cest) || null, type: "00", rate: null };
}

/** Prefixo do código do item de terceiro sem produto ligado (evita colisão entre fornecedores). */
export const supplierPrefix = (doc: SpedDocument) => doc.own ? "" : `${(doc.party?.document ?? "").slice(0, 8)}-`;

/** Situações que levam valores (regular, extemporâneo, complementar, regime especial). */
export const withValues = (doc: SpedDocument) => ["00", "01", "06", "07", "08"].includes(doc.situation);

/** IND_PGTO do SPED Fiscal: 0, 1 ou 2. */
export const paymentIndicator = (value: string) => (value === "0" || value === "1" ? value : "2");

/** Inscrição estadual só com letras e dígitos (ou vazia). */
export const ieOf = (ie: string | null) => (ie ? ie.replace(/[^0-9A-Za-z]/g, "").toUpperCase() : "");
