/** Mapa único das situações do Bling para a fatia B2 (documentos e contas).
 *
 * "Em aberto" é o que ainda admite ação no Bling: vira documento ou título do
 * ERP. "Encerrado" (atendido, cancelado, faturado, pago...) fica no espelho
 * histórico, só para consulta. Situação que este mapa não reconhece não é
 * adivinhada: vira pendência para a pessoa decidir.
 *
 * Origem das regras (sistema de onde o ERP foi portado, só leitura):
 * - propostas: origin_proposal_import aceitava só "Rascunho", "Pendente" e
 *   "Aguardando" (202610160052/55); a listagem agrupa também "Em aberto".
 * - pedidos de compra: origin_purchase_readiness exigia situacao.valor = 0
 *   (Em aberto); 1 Atendido, 2 Cancelado, 3 Em andamento, como no Bling.
 * - pedidos de venda: situações padrão do Bling (id 6 Em aberto, 9 Atendido,
 *   12 Cancelado, 15 Em andamento, 18 Venda agenciada, 21 Em digitação,
 *   24 Verificado; valor 0..3 como nos de compra) e os rótulos de
 *   system_frameworks/situations_reports_labels (202610200148/230).
 * - contas: erp_cutover.status_label e financial_status (202610160020/38):
 *   1 Aberto (só este é "em aberto"), 2 Pago, 3 Parcial, 4 Devolvido,
 *   5 Cancelado, 6 Devolvido parcial, 7 Confirmado. */

export type BlingDocumentEntity = "sales_proposals" | "sales_orders" | "purchase_orders";
export type BlingAccountEntity = "receivables" | "payables";
/** Por que um registro ficou no espelho histórico. */
export type BlingHistoryScope = "fulfilled" | "cancelled" | "paid" | "partial" | "returned" | "deleted" | "other";

export const BLING_HISTORY_SCOPES: Readonly<Record<BlingHistoryScope, string>> = Object.freeze({
  fulfilled: "Já encerrado no Bling (atendido, concluído, aprovado ou faturado)",
  cancelled: "Cancelado no Bling",
  paid: "Já pago ou recebido no Bling",
  partial: "Com baixa parcial no Bling: o acerto do financeiro vem na próxima etapa",
  returned: "Devolvido no Bling",
  deleted: "Excluído no Bling",
  other: "Em outra situação encerrada no Bling",
});

export interface BlingDocumentSituation {
  /** open: vira documento do ERP; closed: espelho histórico; unknown: pendência. */
  scope: "open" | "closed" | "unknown";
  /** Situação do ERP em que o documento entra (sem efeitos). */
  native: string | null;
  /** Por que ficou no histórico (só para closed). */
  history: BlingHistoryScope | null;
  /** Rótulo como o Bling mostra (ou o código recebido). */
  label: string;
}

const fold = (v: string) => v.toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
const scalar = (v: unknown): string | null => typeof v === "string" ? (v.trim() || null) : typeof v === "number" && Number.isFinite(v) ? String(v) : null;

type Entry = Omit<BlingDocumentSituation, "label"> & { label: string };
const open = (label: string, native: string): Entry => ({ scope: "open", native, history: null, label });
const closed = (label: string, history: BlingHistoryScope): Entry => ({ scope: "closed", native: null, history, label });

/** Propostas: a situação chega como texto. Pedidos de venda e compra entram
 * sempre "Em aberto" no ERP: as outras situações do ERP disparam lançamentos
 * configurados (estoque e contas), e adotar não pode ter efeito. A situação do
 * Bling fica escrita nas observações internas do documento. */
const BY_NAME: Readonly<Record<BlingDocumentEntity, Readonly<Record<string, Entry>>>> = Object.freeze({
  sales_proposals: {
    "rascunho": open("Rascunho", "draft"), "em aberto": open("Em aberto", "open"), "pendente": open("Pendente", "pending"),
    "aguardando": open("Aguardando", "waiting"), "em andamento": open("Em andamento", "open"),
    "aprovado": closed("Aprovado", "fulfilled"), "aprovada": closed("Aprovado", "fulfilled"), "concluido": closed("Concluído", "fulfilled"),
    "concluida": closed("Concluído", "fulfilled"), "atendido": closed("Atendido", "fulfilled"), "faturado": closed("Faturado", "fulfilled"),
    "nao aprovado": closed("Não aprovado", "cancelled"), "nao aprovada": closed("Não aprovado", "cancelled"),
    "cancelado": closed("Cancelado", "cancelled"), "cancelada": closed("Cancelado", "cancelled"),
  },
  sales_orders: {
    "em aberto": open("Em aberto", "open"), "em andamento": open("Em andamento", "open"), "em digitacao": open("Em digitação", "open"),
    "verificado": open("Verificado", "open"), "aguardando": open("Aguardando", "open"),
    "atendido": closed("Atendido", "fulfilled"), "atendido parcialmente": closed("Atendido parcialmente", "fulfilled"),
    "faturado": closed("Faturado", "fulfilled"), "faturado parcialmente": closed("Faturado parcialmente", "fulfilled"),
    "venda agenciada": closed("Venda agenciada", "fulfilled"), "cancelado": closed("Cancelado", "cancelled"),
  },
  purchase_orders: {
    "em aberto": open("Em aberto", "open"), "em andamento": open("Em andamento", "open"), "aguardando": open("Aguardando", "open"),
    "atendido": closed("Atendido", "fulfilled"), "atendido parcialmente": closed("Atendido parcialmente", "fulfilled"),
    "cancelado": closed("Cancelado", "cancelled"),
  },
});
/** Situações padrão dos pedidos de venda do Bling, pelo id. */
const SALES_IDS: Readonly<Record<string, string>> = Object.freeze({ "6": "em aberto", "9": "atendido", "12": "cancelado", "15": "em andamento", "18": "venda agenciada", "21": "em digitacao", "24": "verificado" });
/** situacao.valor dos pedidos (venda e compra): o módulo do Bling. */
const ORDER_VALUES: Readonly<Record<string, string>> = Object.freeze({ "0": "em aberto", "1": "atendido", "2": "cancelado", "3": "em andamento" });

/** Situação de uma proposta ou pedido do Bling, pelo payload coletado. */
export function blingDocumentSituation(entity: BlingDocumentEntity, payload: Record<string, unknown>): BlingDocumentSituation {
  const raw = payload.situacao;
  const object = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const name = object ? scalar(object.nome) ?? scalar(object.descricao) : scalar(raw);
  const table = BY_NAME[entity];
  const named = name && table[fold(name)];
  if (named) return { ...named };
  if (object) {
    const id = scalar(object.id), value = scalar(object.valor);
    if (entity === "sales_orders" && id && SALES_IDS[id]) return { ...table[SALES_IDS[id]] };
    if (entity !== "sales_proposals" && value !== null && ORDER_VALUES[value]) return { ...table[ORDER_VALUES[value]] };
  }
  const shown = name ?? (object ? [scalar(object.id) && `id ${scalar(object.id)}`, scalar(object.valor) && `valor ${scalar(object.valor)}`].filter(Boolean).join(", ") : null);
  return { scope: "unknown", native: null, history: null, label: shown ? shown.slice(0, 120) : "sem situação" };
}

export interface BlingAccountSituation {
  /** open: em aberto e inteira (vira título); os demais ficam no histórico. */
  scope: "open" | "unknown" | Exclude<BlingHistoryScope, "fulfilled" | "deleted">;
  code: string | null;
  label: string;
}
const ACCOUNT: Readonly<Record<string, { scope: BlingAccountSituation["scope"]; label: string }>> = Object.freeze({
  "1": { scope: "open", label: "Em aberto" }, "2": { scope: "paid", label: "Pago" }, "3": { scope: "partial", label: "Parcial" },
  "4": { scope: "returned", label: "Devolvido" }, "5": { scope: "cancelled", label: "Cancelado" }, "6": { scope: "partial", label: "Devolvido parcial" },
  "7": { scope: "other", label: "Confirmado" },
});

/** Situação de uma conta a receber ou a pagar. Em aberto com saldo menor que
 * o valor já teve baixa parcial: fica no histórico nesta fatia. */
export function blingAccountSituation(payload: Record<string, unknown>, amountCents: bigint | null, balanceCents: bigint | null): BlingAccountSituation {
  const raw = payload.situacao;
  const code = scalar(raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).id ?? (raw as Record<string, unknown>).valor : raw);
  const known = code ? ACCOUNT[code] : undefined;
  if (!known) return { scope: "unknown", code, label: code ? `código ${code.slice(0, 20)}` : "sem situação" };
  if (known.scope === "open" && amountCents !== null && balanceCents !== null && balanceCents !== amountCents)
    return { scope: "partial", code, label: "Em aberto com baixa parcial" };
  return { scope: known.scope, code, label: known.label };
}
