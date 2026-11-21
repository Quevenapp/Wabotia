// Expedição: contas puras (sem banco), usadas pelo motor (./rpc.ts), pelas
// rotas e pelos testes. Quantidades na escala 6 dos itens do pedido (bigint);
// medidas em milímetros e pesos em gramas (inteiros); o cadastro do produto
// guarda peso em kg e medidas em m, cm ou mm, também na escala 6.
// Só sintaxe TypeScript apagável: os testes do Node importam este arquivo.

export const SHIPPING_STATUSES = ["to_pick", "picking", "picked", "packed", "shipped"] as const;
export type ShippingStatus = (typeof SHIPPING_STATUSES)[number];
export const SHIPPING_STATUS_LABEL: Readonly<Record<ShippingStatus, string>> = Object.freeze({
  to_pick: "A separar", picking: "Em separação", picked: "Separado", packed: "Embalado", shipped: "Expedido",
});
/** O estado de cada item que voltou: volta ao estoque, avariado ou descarte. */
export const RETURN_CONDITIONS = ["restock", "damaged", "discard"] as const;
export type ReturnCondition = (typeof RETURN_CONDITIONS)[number];
export const RETURN_CONDITION_LABEL: Readonly<Record<ReturnCondition, string>> = Object.freeze({
  restock: "Volta ao estoque", damaged: "Avariado", discard: "Descarte",
});
/** Modalidades de frete da nota em que a própria empresa leva (por conta do remetente ou do destinatário). */
export const OWN_DELIVERY_FREIGHT = ["3", "4"] as const;

const SCALE = 1_000_000n;
const DECIMAL = /^(-?)(\d{1,12})(?:[.,](\d{1,6}))?$/;

/** Texto decimal ("2", "2,5", "2.500000") na escala 6; null se vazio; undefined se inválido. */
export function scaled6(value: unknown): bigint | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value.trim() : "";
  const m = DECIMAL.exec(text);
  if (!m) return undefined;
  const v = BigInt(m[2]) * SCALE + BigInt((m[3] ?? "").padEnd(6, "0"));
  return m[1] ? -v : v;
}
/** Escala 6 em texto com seis casas ("2.500000"), como o pedido guarda. */
export function text6(v: bigint): string {
  const neg = v < 0n, abs = neg ? -v : v;
  return `${neg ? "-" : ""}${abs / SCALE}.${(abs % SCALE).toString().padStart(6, "0")}`;
}
/** Escala 6 em texto curto para a tela ("2", "2,5"). */
export function shortQuantity(v: bigint): string {
  const t = text6(v).replace(/\.?0+$/, "");
  return t.replace(".", ",");
}
const roundDiv = (n: bigint, d: bigint) => (n >= 0n ? (n * 2n + d) / (2n * d) : -((-n * 2n + d) / (2n * d)));

/** Centímetros digitados ("30", "30,5") em milímetros; null se vazio; undefined se inválido ou fora de 0,1 cm a 100 m. */
export function cmToMm(value: unknown): number | null | undefined {
  const v = scaled6(value);
  if (v === null || v === undefined) return v;
  const mm = Number(roundDiv(v * 10n, SCALE));
  return mm >= 1 && mm <= 100000 ? mm : undefined;
}
/** Quilos digitados ("1,250") em gramas; null se vazio; undefined se inválido ou acima de 100 t. */
export function kgToGrams(value: unknown): number | null | undefined {
  const v = scaled6(value);
  if (v === null || v === undefined) return v;
  const g = Number(roundDiv(v * 1000n, SCALE));
  return g >= 0 && g <= 100000000 ? g : undefined;
}
export const mmToCm = (mm: number | null) => (mm === null ? null : (mm / 10).toLocaleString("pt-BR", { maximumFractionDigits: 1 }));
export const gramsToKg = (g: number | null) => (g === null ? null : (g / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 }));
/** Gramas em quilos com três casas, como o transporte do pedido guarda (escala 6: "12.345000"). */
export const gramsToKg6 = (g: number) => text6(BigInt(g) * 1000n);

/** Medida do cadastro do produto (escala 6, na unidade dele) em milímetros. */
export function productMeasureMm(value: bigint | null, unit: string | null): number | null {
  if (value === null || value <= 0n) return null;
  const factor = unit === "m" ? 1000n : unit === "mm" ? 1n : 10n;
  const mm = Number(roundDiv(value * factor, SCALE));
  return mm >= 1 ? Math.min(mm, 100000) : 1;
}
/** Quantidade (escala 6) vezes peso em kg (escala 6) em gramas. */
export function lineGrams(quantity: bigint, weightKg6: bigint | null): number {
  if (weightKg6 === null || weightKg6 <= 0n || quantity <= 0n) return 0;
  return Number(roundDiv(quantity * weightKg6, 1_000_000_000n));
}

export interface WeightSource { quantity: bigint; net_kg6: bigint | null; gross_kg6: bigint | null }
/**
 * Pesos do volume: líquido = soma do peso líquido dos itens; bruto = soma do
 * peso bruto dos itens (ou o líquido, se o bruto não estiver no cadastro) mais
 * o peso da embalagem vazia. O bruto digitado (balança) vence a conta.
 */
export function volumeWeights(items: readonly WeightSource[], emptyGrams: number | null, typedGross: number | null) {
  let net = 0, gross = 0, missing = 0;
  for (const i of items) {
    if (i.net_kg6 === null && i.gross_kg6 === null) missing++;
    net += lineGrams(i.quantity, i.net_kg6 ?? i.gross_kg6);
    gross += lineGrams(i.quantity, i.gross_kg6 ?? i.net_kg6);
  }
  const computed = gross + (emptyGrams ?? 0);
  return { net_g: net, gross_g: typedGross ?? computed, computed_gross_g: computed, items_without_weight: missing };
}

export interface PickLine { id: string; document_id: string; number: number; product_id: string | null; warehouse_id: string | null; location: string | null;
  description: string; code: string | null; gtin: string | null; unit: string | null; quantity: bigint; picked: bigint }
/** Chave da linha consolidada: o mesmo produto no mesmo depósito e endereço (sem produto, a descrição). */
export const consolidatedKey = (l: Pick<PickLine, "product_id" | "warehouse_id" | "location" | "description" | "unit">) =>
  `${l.product_id ?? `texto:${l.description.trim().toLowerCase()}:${l.unit ?? ""}`}|${l.warehouse_id ?? ""}|${(l.location ?? "").trim().toLowerCase()}`;

export interface ConsolidatedRow {
  key: string; product_id: string | null; warehouse_id: string | null; location: string | null; description: string; code: string | null;
  gtin: string | null; unit: string | null; quantity: bigint; picked: bigint; orders: { document_id: string; number: number; quantity: bigint; picked: bigint }[];
}
/**
 * Itens somados por produto e endereço/depósito, na ordem de caminhada:
 * depósito, endereço (vazio por último), descrição.
 */
export function consolidate(lines: readonly PickLine[]): ConsolidatedRow[] {
  const rows = new Map<string, ConsolidatedRow>();
  for (const l of lines) {
    const key = consolidatedKey(l);
    const row = rows.get(key) ?? { key, product_id: l.product_id, warehouse_id: l.warehouse_id, location: l.location, description: l.description, code: l.code,
      gtin: l.gtin, unit: l.unit, quantity: 0n, picked: 0n, orders: [] };
    row.quantity += l.quantity;
    row.picked += l.picked;
    const order = row.orders.find((o) => o.document_id === l.document_id);
    if (order) { order.quantity += l.quantity; order.picked += l.picked; }
    else row.orders.push({ document_id: l.document_id, number: l.number, quantity: l.quantity, picked: l.picked });
    rows.set(key, row);
  }
  const text = (v: string | null) => (v ?? "").trim().toLowerCase();
  return [...rows.values()]
    .map((r) => ({ ...r, orders: r.orders.sort((a, b) => a.number - b.number) }))
    .sort((a, b) => text(a.warehouse_id).localeCompare(text(b.warehouse_id)) || (a.location ? 0 : 1) - (b.location ? 0 : 1) ||
      text(a.location).localeCompare(text(b.location), "pt-BR", { numeric: true }) || text(a.description).localeCompare(text(b.description), "pt-BR") || a.key.localeCompare(b.key));
}
/**
 * Divide o total separado de uma linha consolidada entre os itens dos
 * pedidos, do pedido mais antigo para o mais novo, sem passar da quantidade
 * de cada item. Devolve o separado de cada linha (mesma ordem da entrada).
 */
export function distribute(lines: readonly Pick<PickLine, "number" | "quantity">[], total: bigint): bigint[] {
  const order = lines.map((l, index) => ({ index, number: l.number, quantity: l.quantity })).sort((a, b) => a.number - b.number || a.index - b.index);
  const out = lines.map(() => 0n);
  let left = total < 0n ? 0n : total;
  for (const o of order) {
    const take = left < o.quantity ? left : o.quantity;
    out[o.index] = take;
    left -= take;
  }
  return out;
}

/** O código lido (câmera ou leitor) acha a linha consolidada pelo GTIN ou pelo código do produto. */
export function rowForCode<T extends Pick<ConsolidatedRow, "gtin" | "code" | "quantity" | "picked">>(rows: readonly T[], code: string): T | null {
  const c = code.trim().toLowerCase();
  if (!c) return null;
  const found = rows.filter((r) => (r.gtin ?? "").trim().toLowerCase() === c || (r.code ?? "").trim().toLowerCase() === c);
  return found.find((r) => r.picked < r.quantity) ?? found[0] ?? null;
}

/** Código de barras da etiqueta: pedido e volume ("PV000123-02"), legível pelo Code 128. */
export const volumeBarcode = (orderNumber: number, volume: number) => `PV${String(orderNumber).padStart(6, "0")}-${String(volume).padStart(2, "0")}`;
