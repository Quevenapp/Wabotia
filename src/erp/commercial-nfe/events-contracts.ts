/** Depois da NF-e autorizada: carta de correção (CC-e), inutilização de
 * numeração e devolução de venda. Tipos e regras compartilhados pelo motor
 * (domains/fiscal/comnfe/events.ts), pelo serviço (events-service.ts) e pelo
 * painel. Nada aqui faz I/O. */
import type { FiscalEnvironment, FiscalMessage, JsonObject } from "./contracts.ts";

/** Prazo nacional para cancelar a NF-e, contado da autorização. */
export const NFE_CANCEL_HOURS = 24;
export const CORRECTION_TEXT_MIN = 15;
export const CORRECTION_TEXT_MAX = 1000;
/** A SEFAZ aceita até 20 cartas por nota. */
export const CORRECTION_LIMIT = 20;
export const VOID_JUSTIFICATION_MIN = 15;
export const VOID_JUSTIFICATION_MAX = 255;
/** Faixa máxima de uma inutilização num pedido só (o cofre e a SEFAZ conferem o resto). */
export const VOID_RANGE_MAX = 10_000;

/** Aviso legal mostrado antes de enviar a carta (art. 7º, § 1º-A, do Convênio SINIEF s/nº de 1970). */
export const CORRECTION_LEGAL_NOTICE =
  "A carta de correção serve só para corrigir dados escritos da nota. Ela não pode corrigir: valores e impostos (base de cálculo, alíquota, preço, quantidade, desconto ou valor da operação); dados do destinatário ou do emitente que troquem quem compra ou quem vende (CNPJ, CPF, razão social); nem a data de emissão ou de saída. Para esses casos, cancele a nota dentro do prazo ou faça uma nota de devolução ou complementar. Cada carta nova substitui as anteriores: escreva nela todas as correções, inclusive as que já foram enviadas.";

export type NfeEventState = "enviando" | "incerto" | "recusado" | "registrado";
export type ReturnStatus = "preparada" | "enviando" | "processando" | "incerta" | "rejeitada" | "denegada" | "autorizada" | "cancelada";
export type ReturnFinanceOption = "credito" | "pagar";
export type ReturnEffectState = "pendente" | "aplicado" | "pulado";

export interface CorrectionView {
  id: string; emission_id: string; command_id: string; person_id: string;
  text: string; state: NfeEventState; expected_sequence: number; sequence: number | null;
  protocol: string | null; event_at: string | null; messages: FiscalMessage[];
  xml_available: boolean; created_at: string; updated_at: string;
}

export interface VoidRangeView {
  id: string; command_id: string; person_id: string; model: "nfe" | "nfce"; environment: FiscalEnvironment;
  series: number; first: number; last: number; justification: string; state: NfeEventState;
  provider_ref: string | null; protocol: string | null; repeated: boolean; messages: FiscalMessage[];
  created_at: string; updated_at: string;
}

export interface ReturnItemInput { item: number; quantity: string }
/** Item da nota original com o que já foi devolvido (devoluções autorizadas ou em andamento). */
export interface ReturnLine {
  item: number; code: string; description: string; unit: string; cfop: string; return_cfop: string | null;
  quantity: string; returned: string; remaining: string; unit_price: string;
}
export interface ReturnItemView { item: number; code: string; description: string; unit: string; cfop: string; quantity: string; amount_cents: string }
export interface ReturnEffectView { state: ReturnEffectState; result: JsonObject | null }
export interface ReturnView {
  id: string; emission_id: string; command_id: string; person_id: string; environment: FiscalEnvironment; reference: string;
  items: ReturnItemView[]; finance_option: ReturnFinanceOption; total: string; status: ReturnStatus;
  provider_id: string | null; series: number | null; number: number | null; access_key: string | null; protocol: string | null;
  authorized_at: string | null; messages: FiscalMessage[]; stock: ReturnEffectView; finance: ReturnEffectView;
  created_at: string; updated_at: string;
}

/** O que a nota ainda permite, em palavras (o painel mostra o motivo e o que fazer). */
export interface NfeEventRule { allowed: boolean; code: string | null; reason: string | null }
export interface NfeEventsView {
  emission: { id: string; model: "nfe" | "nfce" | "nfse"; status: string; environment: FiscalEnvironment; number: number | null; series: number | null;
    access_key: string | null; authorized_at: string | null; cancel_until: string | null };
  rules: { cancel: NfeEventRule; correction: NfeEventRule; return: NfeEventRule };
  corrections: CorrectionView[];
  returns: ReturnView[];
  lines: ReturnLine[];
}

/** CFOP de devolução de venda pela CFOP da saída (tabela do Convênio SINIEF s/nº).
 * Sem correspondência conhecida, a devolução fica bloqueada com o motivo. */
const RETURN_CFOP: Readonly<Record<string, string>> = Object.freeze({
  "5101": "1201", "5102": "1202", "5103": "1203", "5104": "1204", "5105": "1201", "5106": "1202",
  "5401": "1410", "5402": "1410", "5403": "1411", "5405": "1411",
  "5501": "1503", "5502": "1504",
  "6101": "2201", "6102": "2202", "6103": "2203", "6104": "2204", "6105": "2201", "6106": "2202", "6107": "2201", "6108": "2202",
  "6401": "2410", "6402": "2410", "6403": "2411", "6404": "2411",
  "6501": "2503", "6502": "2504",
  "7101": "3201", "7102": "3202",
});
export const returnCfop = (cfop: string): string | null => RETURN_CFOP[cfop] ?? null;

/** Prazos e impedimentos em palavras, a partir da situação da nota. `now` em microssegundos. */
export function nfeEventRules(input: { model: string; status: string; authorized_at: string | null; cancellation_state?: string | null;
  corrections_registered: number; corrections_in_flight: boolean; returnable: boolean; now: bigint }): { cancel: NfeEventRule; correction: NfeEventRule; return: NfeEventRule; cancel_until: string | null } {
  const ok: NfeEventRule = { allowed: true, code: null, reason: null };
  const no = (code: string, reason: string): NfeEventRule => ({ allowed: false, code, reason });
  const until = input.authorized_at && /^\d+$/.test(input.authorized_at) ? BigInt(input.authorized_at) + BigInt(NFE_CANCEL_HOURS) * 3_600_000_000n : null;
  if (input.model !== "nfe") {
    const other = no("nfe_event_model", input.model === "nfce"
      ? "Carta de correção e devolução por esta tela valem só para a NF-e de venda (modelo 55). O cupom fiscal (NFC-e) não aceita carta de correção; a devolução do balcão é feita pelo caixa."
      : "Carta de correção e devolução por esta tela valem só para a NF-e de venda (modelo 55).");
    return { cancel: ok, correction: other, return: other, cancel_until: null };
  }
  if (input.status === "cancelada") {
    return {
      cancel: no("nfe_already_cancelled", "A nota já está cancelada."),
      correction: no("nfe_correction_cancelled", "A nota está cancelada: a SEFAZ não aceita carta de correção em nota cancelada. Se a venda continua valendo, emita uma nota nova pelo pedido."),
      return: no("nfe_return_cancelled", "A nota está cancelada: não há o que devolver, porque ela não vale mais. Se a mercadoria voltou, confira o estoque e as contas do pedido na compensação do cancelamento."),
      cancel_until: until === null ? null : String(until),
    };
  }
  if (input.status !== "autorizada") {
    const pending = no("nfe_not_authorized", "A nota ainda não foi autorizada pela SEFAZ. Carta de correção, cancelamento e devolução só valem para nota autorizada.");
    return { cancel: pending, correction: pending, return: pending, cancel_until: null };
  }
  let cancel = ok;
  if (input.cancellation_state && ["pedido", "enviando", "incerto"].includes(input.cancellation_state))
    cancel = no("nfe_cancel_in_flight", "O cancelamento já foi pedido e ainda não tem resposta. Use \"Retomar cancelamento\" para conferir.");
  else if (until !== null && input.now > until)
    cancel = no("nfe_cancel_deadline", `O prazo de ${NFE_CANCEL_HOURS} horas para cancelar esta NF-e terminou. A SEFAZ recusa o cancelamento depois disso (alguns estados aceitam um pedido fora do prazo, feito ao fisco, com multa). O que fazer: se a mercadoria voltou, emita a devolução; se só um dado escrito está errado, envie uma carta de correção; em dúvida, fale com o contador.`);
  let correction = ok;
  if (input.cancellation_state && ["pedido", "enviando", "incerto"].includes(input.cancellation_state))
    correction = no("nfe_cancel_in_flight", "O cancelamento desta nota está em andamento. Espere a resposta antes de enviar carta de correção.");
  else if (input.corrections_in_flight)
    correction = no("nfe_correction_in_flight", "Uma carta de correção desta nota ainda está sem resposta. Consulte essa carta antes de enviar outra.");
  else if (input.corrections_registered >= CORRECTION_LIMIT)
    correction = no("nfe_correction_limit", `Esta nota já tem ${CORRECTION_LIMIT} cartas de correção, o limite da SEFAZ. Para corrigir mais, fale com o contador sobre cancelar (se ainda houver prazo) ou fazer uma nota complementar.`);
  let ret = ok;
  if (input.cancellation_state && ["pedido", "enviando", "incerto"].includes(input.cancellation_state))
    ret = no("nfe_cancel_in_flight", "O cancelamento desta nota está em andamento. Espere a resposta antes de registrar uma devolução.");
  else if (!input.returnable) ret = no("nfe_return_nothing_left", "Todos os itens desta nota já foram devolvidos (ou estão numa devolução em andamento).");
  return { cancel, correction, return: ret, cancel_until: until === null ? null : String(until) };
}
