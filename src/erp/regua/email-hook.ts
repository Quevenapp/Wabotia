// Ponto de encaixe do e-mail na régua de cobrança. O canal de e-mail do ERP
// é de outra frente: quando existir, ela registra aqui a função que envia a
// conta por e-mail (registerReguaEmail, no carregamento do módulo dela). Sem
// função registrada, a régua só usa o WhatsApp e a tela diz que o e-mail
// ainda não está disponível; nenhuma etapa de e-mail é criada.
import type { Actor, Env } from "../../types";

/** A etapa da régua como o envio a recebe (stepView em src/erp/domains/finance/dunning.ts). */
export interface ReguaEmailStep {
  id: string; title_id: string; stage: string; stage_label: string; due_on: string; amount_cents: number;
  contact: { id: string; name: string | null } | null; description: string | null;
}
/** Resultado: ok com a referência do envio, ou o motivo (retry: tentar de novo depois). */
export type ReguaEmailResult = { ok: true; ref?: string } | { ok: false; reason: string; retry?: boolean };
/**
 * Envia a conta a receber por e-mail ao contato, em nome de `actor` (o
 * administrador que ligou a régua), com a mesma forma de pagamento escolhida.
 * Deve ser idempotente pela etapa (step.id): a régua pode repetir depois de
 * uma resposta perdida.
 */
export type ReguaEmailSender = (env: Env, profile: string, actor: Actor, step: ReguaEmailStep, payment: string) => Promise<ReguaEmailResult>;

let sender: ReguaEmailSender | null = null;
export function registerReguaEmail(fn: ReguaEmailSender | null) { sender = fn; }
export const reguaEmailSender = () => sender;
export const reguaEmailReady = () => sender !== null;
