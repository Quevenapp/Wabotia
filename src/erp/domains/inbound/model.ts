// Compra pela nota recebida: o que a nota do fornecedor diz, em funções puras
// usadas pelo Worker (leitura do XML, src/erp/recebidas/xml.ts) e pelo motor
// (conferência e entrada, ./rpc.ts). Dinheiro em centavos (inteiros),
// quantidade em texto com até 6 casas, preço com até 10 casas.

export type InboundEnvironment = "producao" | "homologacao";
export type InboundPurpose = "compra" | "devolucao" | "bonificacao" | "remessa" | "outra";

export interface InboundAddress {
  street: string | null; number: string | null; complement: string | null; district: string | null;
  city: string | null; city_code: string | null; uf: string | null; zip: string | null;
}

export interface InboundItem {
  /** nItem do XML (1..990). */
  position: number;
  /** cProd: o código do produto no cadastro do fornecedor. */
  code: string;
  /** cEAN (GTIN) quando a nota traz um válido; "SEM GTIN" vira null. */
  gtin: string | null;
  description: string;
  ncm: string | null;
  /** CEST, só quando a nota traz (7 dígitos). */
  cest?: string | null;
  cfop: string;
  /** uCom: a unidade em que o fornecedor vendeu (CX, UN, KG...). */
  unit: string;
  /** qCom, com até 6 casas. */
  quantity: string;
  /** vUnCom, com até 10 casas. */
  unit_price: string;
  /** vProd. */
  total_cents: number;
  discount_cents: number;
  freight_cents: number;
  insurance_cents: number;
  other_cents: number;
  /** Impostos destacados no item. */
  ipi_cents: number;
  icms_cents: number;
  icms_st_cents: number;
  fcp_st_cents: number;
  /** rastro (lote e validade), quando o fornecedor informa. */
  lots: { code: string; quantity: string | null; manufactured_on: string | null; expires_on: string | null }[];
  /** xPed e nItemPed: o pedido de compra que o fornecedor citou. */
  order_reference: string | null;
}

export interface InboundDuplicate { number: string | null; due_on: string; amount_cents: number }

export interface InboundNote {
  access_key: string;
  environment: InboundEnvironment;
  model: string;
  series: number;
  number: number;
  issued_on: string;
  /** natOp. */
  nature: string;
  /** finNFe: 1 normal, 2 complementar, 3 ajuste, 4 devolução. */
  finality: string;
  /** tpNF do emitente: 0 entrada, 1 saída. */
  operation: string;
  emitter: { document: string; name: string; trade_name: string | null; ie: string | null; crt: string | null; phone: string | null; address: InboundAddress };
  recipient_document: string | null;
  items: InboundItem[];
  totals: {
    products_cents: number; discount_cents: number; freight_cents: number; insurance_cents: number; other_cents: number;
    ipi_cents: number; icms_cents: number; icms_st_cents: number; fcp_st_cents: number; total_cents: number;
  };
  duplicates: InboundDuplicate[];
  /** detPag: tPag do contrato da NF-e (01 dinheiro, 15 boleto, 17 Pix...). */
  payments: { method: string; amount_cents: number }[];
  /** Protocolo de autorização (nfeProc), quando o XML veio com ele. */
  protocol: string | null;
}

/** CFOP sem ponto. */
const cfopOf = (value: string) => value.replace(/\D/g, "");

/**
 * Para que serve a nota, pela finalidade e pelos CFOPs que o emitente usou
 * (do ponto de vista de quem emitiu: a venda dele é a nossa compra).
 * - devolução: finNFe 4, ou CFOP x201, x202, x208, x209, x210, x410, x411,
 *   x412, x413, x503, x553, x556, x660-x662 (devolução de compra feita a nós
 *   por um cliente);
 * - bonificação, doação ou brinde: x910, x911;
 * - remessa (consignação, demonstração, conserto, industrialização,
 *   armazenagem, comodato, outras saídas): os demais x9xx, x901-x949;
 * - compra: x101-x125, x401-x405, x651-x667 de venda;
 * - o resto: outra.
 * Quando os itens discordam, a nota é da primeira classe na ordem acima.
 */
export function classifyPurpose(finality: string, nature: string, cfops: readonly string[]): InboundPurpose {
  if (finality === "4") return "devolucao";
  const codes = cfops.map(cfopOf).filter(c => c.length === 4);
  const tail = (c: string) => Number(c.slice(1));
  const RETURN = new Set([201, 202, 208, 209, 210, 410, 411, 412, 413, 503, 553, 556, 660, 661, 662]);
  if (codes.some(c => RETURN.has(tail(c)))) return "devolucao";
  if (codes.some(c => [910, 911].includes(tail(c)))) return "bonificacao";
  if (codes.some(c => tail(c) >= 900)) return "remessa";
  if (codes.length && codes.every(c => (tail(c) >= 101 && tail(c) <= 125) || (tail(c) >= 401 && tail(c) <= 405) || (tail(c) >= 651 && tail(c) <= 667))) return "compra";
  const text = nature.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (/devolu/.test(text)) return "devolucao";
  if (/bonifica|brinde|doac/.test(text)) return "bonificacao";
  if (/remessa|consigna|demonstra|conserto|comodato|armazen/.test(text)) return "remessa";
  if (/venda|compra/.test(text)) return "compra";
  return "outra";
}

/** Rótulo em português para a tela. */
export const PURPOSE_LABEL: Record<InboundPurpose, string> = {
  compra: "Compra de mercadoria",
  devolucao: "Devolução de cliente",
  bonificacao: "Bonificação ou brinde",
  remessa: "Remessa (consignação, demonstração, conserto, outras)",
  outra: "Outra operação",
};

// ---------------------------------------------------------------------------
// Números exatos

const SCALE6 = 1_000_000n;
/** Texto decimal → inteiro na escala pedida (sem arredondar: casas a mais são erro). */
export function scaled(value: string, scale: number): bigint | null {
  const m = /^(\d{1,14})(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) return null;
  return BigInt(m[1]) * 10n ** BigInt(scale) + BigInt((frac.slice(0, scale) || "0").padEnd(scale, "0"));
}
/** Inteiro na escala → texto com a escala inteira (como o motor devolve). */
export function unscaled(value: bigint, scale: number): string {
  const neg = value < 0n, v = neg ? -value : value, base = 10n ** BigInt(scale);
  const int = v / base, frac = v % base;
  return `${neg ? "-" : ""}${int}${scale ? "." + frac.toString().padStart(scale, "0") : ""}`;
}
/** Divisão com arredondamento para o mais próximo (meio para cima). */
const divRound = (a: bigint, b: bigint) => (a * 2n + b) / (2n * b);

/**
 * Quantidade que entra no estoque: a da nota vezes o fator da unidade
 * (caixa com 12 → 12). Null quando o resultado passa de 6 casas.
 */
export function stockQuantity(quantity: string, factor: string): string | null {
  const q = scaled(quantity, 6), f = scaled(factor, 6);
  if (q === null || f === null || f === 0n) return null;
  const product = q * f;
  if (product % SCALE6 !== 0n) return null;
  return unscaled(product / SCALE6, 6);
}

/** Valor de um preço por unidade de estoque, com `decimals` casas (até 10). */
function perUnit(cents: bigint, quantity6: bigint, decimals: number): string {
  // reais por unidade = cents/100 ÷ (q6/1e6) = cents * 1e4 / q6; na escala d: * 10^d.
  const v = divRound(cents * 10_000n * 10n ** BigInt(decimals), quantity6);
  return unscaled(v, decimals);
}

export interface CostOptions {
  /** ICMS próprio entra no custo (empresa que não aproveita o crédito, como no Simples Nacional). */
  icms_in_cost: boolean;
  /** Casas do preço de entrada (preferência empresa.decimais_preco_entrada; padrão 10). */
  decimals: number;
}

export interface LineCost {
  position: number;
  /** Valor dos produtos menos o desconto. */
  goods_cents: number;
  freight_cents: number;
  insurance_cents: number;
  other_cents: number;
  /** Impostos não recuperáveis somados ao custo: IPI, ICMS-ST e FCP-ST (e ICMS próprio, com a opção). */
  taxes_cents: number;
  /** Custo total da linha. */
  cost_cents: number;
  /** Preço de compra por unidade de estoque (sem frete nem imposto). */
  unit_price: string;
  /** Custo de entrada por unidade de estoque (com o rateio). */
  unit_cost: string;
}

/**
 * Custo de entrada de cada item. Frete, seguro e outras despesas: o que o
 * fornecedor já rateou no item fica no item; a diferença para o total da nota
 * é rateada pelo valor dos produtos, com o resto de centavos no último item.
 * Impostos não recuperáveis: IPI, ICMS-ST e FCP-ST; ICMS próprio só com a
 * opção. O ERP usa esse custo (unit_cost do lançamento) ou o preço
 * (unit_price) no custo médio, conforme a preferência estoque.custo_medio_base.
 */
export function landedCosts(note: InboundNote, quantities: ReadonlyMap<number, string>, options: CostOptions): LineCost[] {
  const items = note.items;
  const spread = (field: "freight_cents" | "insurance_cents" | "other_cents") => {
    const declared = items.reduce((s, i) => s + i[field], 0);
    const rest = Math.max(0, note.totals[field] - declared);
    const base = items.map(i => Math.max(0, i.total_cents - i.discount_cents));
    const sum = base.reduce((s, v) => s + v, 0);
    const shares = items.map(() => 0);
    if (rest > 0) {
      let given = 0;
      items.forEach((_, n) => {
        const share = sum > 0 ? Math.floor((rest * base[n]) / sum) : Math.floor(rest / items.length);
        shares[n] = share; given += share;
      });
      shares[items.length - 1] += rest - given;
    }
    return items.map((i, n) => i[field] + shares[n]);
  };
  const freight = spread("freight_cents"), insurance = spread("insurance_cents"), other = spread("other_cents");
  const decimals = Math.min(10, Math.max(0, Math.trunc(options.decimals)));
  return items.map((item, n) => {
    const goods = Math.max(0, item.total_cents - item.discount_cents);
    const taxes = item.ipi_cents + item.icms_st_cents + item.fcp_st_cents + (options.icms_in_cost ? item.icms_cents : 0);
    const cost = goods + freight[n] + insurance[n] + other[n] + taxes;
    const qty = quantities.get(item.position);
    const q6 = qty === undefined ? null : scaled(qty, 6);
    return {
      position: item.position,
      goods_cents: goods, freight_cents: freight[n], insurance_cents: insurance[n], other_cents: other[n],
      taxes_cents: taxes, cost_cents: cost,
      unit_price: q6 ? perUnit(BigInt(goods), q6, decimals) : "0",
      unit_cost: q6 ? perUnit(BigInt(cost), q6, decimals) : "0",
    };
  });
}

/** Parcelas das contas a pagar: as duplicatas da nota; sem duplicata, uma só no dia da emissão pelo total. */
export function payableInstallments(note: InboundNote): InboundDuplicate[] {
  const list = note.duplicates.filter(d => d.amount_cents > 0);
  if (list.length) return [...list].sort((a, b) => a.due_on.localeCompare(b.due_on));
  return note.totals.total_cents > 0 ? [{ number: null, due_on: note.issued_on, amount_cents: note.totals.total_cents }] : [];
}

/** Só dígitos e letras maiúsculas do documento (CNPJ alfanumérico preserva as letras). */
export const documentKey = (value: string | null | undefined) => (value ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");

/** Unidade comparável (a mesma regra do estoque: sem espaços nas pontas, maiúsculas). */
export const unitKey = (value: string | null | undefined) => (value ?? "").trim().toUpperCase();

/** Palavras da descrição, para sugerir produto por semelhança. */
export function descriptionWords(text: string): string[] {
  return [...new Set(text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !/^\d+$/.test(w)))];
}

/** Semelhança de 0 a 1 entre duas descrições (palavras em comum sobre a união). */
export function similarity(a: string, b: string): number {
  const x = descriptionWords(a), y = new Set(descriptionWords(b));
  if (!x.length || !y.size) return 0;
  const common = x.filter(w => y.has(w)).length;
  return common / (x.length + y.size - common);
}
