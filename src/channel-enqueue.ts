// Enfileiramento de saída dos canais sociais e das extensões de canal.
//
// As duas funções vivem no motor (src/engine.ts), que as instala aqui ao ser
// carregado. Quem precisa enfileirar (src/service.ts, src/line-service.ts)
// chama por este módulo, sem importar o motor: o motor importa o serviço, e o
// caminho inverso arrastava o motor, as ações de bot e o ponto de entrada do
// Worker para qualquer pacote que só precisasse do serviço (os testes do ERP
// em Node, por exemplo).
import type { Env } from "./types";
import type { ChannelDeliveryPlan, ChannelOperationContext, ServerChannelAction } from "./channel-c2-contracts";

export type ChannelEnqueue = (
  env: Env, conversation: any, actor: string, kind: string, payload: any, dedupe: string,
) => Promise<string>;
export type ChannelPlanEnqueue = (
  ctx: ChannelOperationContext, plan: ChannelDeliveryPlan, action: ServerChannelAction,
) => Promise<string>;
type Handlers = { social: ChannelEnqueue; automation: ChannelEnqueue; plan: ChannelPlanEnqueue };

let handlers: Handlers | null = null;

/** Chamado uma vez pelo motor, na carga do módulo. Só memória; sem I/O. */
export function installChannelEnqueue(next: Handlers): void {
  handlers = next;
}

function installed() {
  // No Worker o motor é sempre carregado pelo ponto de entrada. Chegar aqui sem
  // ele é erro de composição (um teste que importou o serviço sem o motor).
  if (!handlers) throw new Error("Motor de canais não carregado: importe src/engine antes de enviar por canal social.");
  return handlers;
}

/** Mensagem direta do Instagram e do Facebook (primeira leva). */
export const enqueueSocialDeliveries: ChannelEnqueue = (env, conversation, actor, kind, payload, dedupe) =>
  installed().social(env, conversation, actor, kind, payload, dedupe);

/** Plano já preparado por um descritor de canal (ação humana, menu, comentário, avaliação). */
export const enqueueChannelPlan: ChannelPlanEnqueue = (ctx, plan, action) => installed().plan(ctx, plan, action);

/** Canais por extensão (segunda leva): Telegram, e-mail, TikTok. */
export const enqueueChannelAutomation: ChannelEnqueue = (env, conversation, actor, kind, payload, dedupe) =>
  installed().automation(env, conversation, actor, kind, payload, dedupe);
