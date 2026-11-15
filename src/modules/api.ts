// Interface interna para os módulos (contrato em docs/MODULOS.md). Uma vertical
// fala com o núcleo só por aqui: contato, enviar mensagem, abrir passo web,
// publicar evento e os ganchos de menu, ação de conversa, configuração e
// conclusão de passo web. Mudanças aqui exigem atualizar docs/MODULOS.md.
import {
  registerCommand,
  registerConversationAction,
  registerInboundHandler,
  registerMenuHandler,
  registerPaymentHook,
  registerReadRoute,
  registerMcpTool,
  registerSchedule,
  registerTurnHandler,
  type ModuleMcpTool,
  registerSettingsValidator,
  registerWebStepHook,
  registerWriteRoute,
  type ModuleWriteRoute,
} from "./hooks";
import { one } from "../db";
import {
  ApiError,
  type Actor,
  type Conversation,
  type Env,
  requireValue,
} from "../types";
import { access } from "../security";
import { event } from "../events";
import { conversation, enqueue, settings } from "../service";
import { createPayment, type Payment } from "../payments";
import { establishment, type Establishment } from "../establishment";
import {
  interactiveLine,
  interactivePayload,
  sendInteractive as sendInteractiveMessage,
} from "../line-service";
import type { InteractiveSpec } from "../whatsapp-interactive";
import {
  openWebStep,
  type Answers,
  type OpenWebStepInput,
  type webStepView,
} from "../web-steps";
import {
  moduleById,
  moduleDisabledError,
  moduleEnabled,
  moduleForMenuType,
  type ModuleDefinition,
} from "./registry";

export interface ContactSummary {
  id: string;
  name: string;
  phone: string;
  email: string;
  company: string;
  notes: string;
}
export type WebStep = NonNullable<ReturnType<typeof webStepView>>;
export type { InteractiveSpec } from "../whatsapp-interactive";
export type { Establishment } from "../establishment";
export type WebStepRequest = Omit<OpenWebStepInput, "conversation" | "module">;

export interface OutgoingMessage {
  text: string;
  /** Conteúdo nativo (interactive, location, …), como em enqueue. */
  content?: any;
  /** IDs de mídia da área. */
  attachments?: string[];
}

export interface ModuleContext {
  env: Env;
  /** Área de atendimento. */
  profile: string;
  module: ModuleDefinition;
  enabled(): Promise<boolean>;
  /** 409 module_disabled quando o módulo está desligado na área. */
  requireEnabled(): Promise<void>;
  /** Mesma regra das rotas: área do ator e permissão de aplicação. */
  access(actor: Actor, scope: string): void;
  /** Configurações da área (itens de menu de módulos desligados ocultos). */
  settings(): Promise<any>;
  /**
   * Dados do estabelecimento (nome fantasia, CPF/CNPJ, endereço, telefone,
   * rodapé) para cupom, comanda, recibo e mensagens. Sem cadastro, `name` é o
   * nome da área e `configured` é falso.
   */
  establishment(): Promise<Establishment>;
  conversation(id: string, actor?: Actor): Promise<Conversation>;
  /** Contato vinculado à conversa, ou null. */
  contact(c: Conversation | string): Promise<ContactSummary | null>;
  /**
   * Envia mensagem ao cliente pela fila de entrega. `key` torna o envio
   * idempotente; `notification` usa o modelo de notificação quando a janela
   * de 24 horas da linha oficial estiver fechada.
   */
  sendMessage(
    c: Conversation,
    message: OutgoingMessage,
    options: { key: string; actor?: string; notification?: boolean },
  ): Promise<string>;
  /**
   * Mensagem interativa (botões com URL, lista, Flow, produto…; tipos em
   * src/whatsapp-interactive.ts). Linha oficial: o elemento nativo; QR ou
   * grupo: texto numerado com links. Com a janela de 24 h fechada na linha
   * oficial, `notification: true` envia o texto pelo modelo de notificação.
   * Use ids de opção com o prefixo do módulo ("agenda:confirmar:…").
   */
  sendInteractive(
    c: Conversation,
    spec: InteractiveSpec,
    options: { key: string; actor?: string; notification?: boolean },
  ): Promise<string>;
  /** Abre um passo web em nome do módulo (web_steps.module_id). */
  openWebStep(
    c: Conversation,
    request: WebStepRequest,
  ): ReturnType<typeof openWebStep>;
  /**
   * Publica um evento declarado em `events` do módulo. Com `key`, publicar de
   * novo a mesma chave não gera outro evento (gancho repetido, nova tentativa).
   */
  publish(
    kind: string,
    resourceId: string,
    payload: any,
    options?: { key?: string },
  ): Promise<number>;
  /**
   * Cobra o cliente da conversa (Pix ou link) pela conta da área
   * (docs/COBRANCA.md). A confirmação chega em onPaymentUpdated.
   */
  charge(c: Conversation, request: ChargeRequest): Promise<Payment>;
}

export interface ChargeRequest {
  method: "pix" | "link";
  amount_cents: number;
  description: string;
  /** Registro do módulo pago por esta cobrança (pedido, mensalidade…). */
  ref?: string | null;
  /** Repetir a chave devolve a mesma cobrança, sem cobrar de novo. */
  sourceKey: string;
  /** 30 min a 30 dias; padrão 24 h. */
  expiresMinutes?: number;
  trigger?: "module" | "agent" | "bot" | "menu";
  actor?: string;
  /** Janela de 24 h fechada: envia pelo modelo de notificação. */
  notification?: boolean;
}

export function modulesApi(
  env: Env,
  profile: string,
  moduleId: string,
): ModuleContext {
  const definition = moduleById(moduleId);
  if (!definition) throw new Error(`Módulo não registrado: ${moduleId}`);
  const ctx: ModuleContext = {
    env,
    profile,
    module: definition,
    enabled: () => moduleEnabled(env, profile, moduleId),
    async requireEnabled() {
      if (!(await moduleEnabled(env, profile, moduleId)))
        throw moduleDisabledError(definition);
    },
    access: (actor, scope) => access(actor, profile, scope),
    settings: () => settings(env, profile),
    establishment: () => establishment(env, profile),
    conversation: (id, actor) => conversation(env, id, profile, actor),
    async contact(c) {
      const id = typeof c === "string" ? c : c.id;
      return one<ContactSummary>(
        env,
        "SELECT ct.id,ct.name,ct.phone,ct.email,ct.company,ct.notes FROM conversation_contacts l JOIN contacts ct ON ct.id=l.contact_id AND ct.profile_id=l.profile_id WHERE l.conversation_id=? AND l.profile_id=?",
        id,
        profile,
      );
    },
    async sendMessage(c, outgoing, options) {
      requireValue(c.profile_id === profile, "Conversa de outra área.");
      requireValue(
        typeof outgoing.text === "string" &&
          outgoing.text.trim() &&
          outgoing.text.length <= 3800,
        "Mensagem do módulo: texto de 1 a 3800 caracteres.",
      );
      return enqueue(
        env,
        c,
        options.actor || "system",
        options.notification ? "notification" : "text",
        {
          text: outgoing.text,
          automation: moduleId,
          ...(outgoing.content ? { content: outgoing.content } : {}),
          ...(outgoing.attachments?.length
            ? { attachments: outgoing.attachments }
            : {}),
        },
        // A chave do outbox vale para o sistema todo: leva a conversa.
        `module:${moduleId}:${c.id}:${options.key}`,
      );
    },
    async sendInteractive(c, spec, options) {
      requireValue(c.profile_id === profile, "Conversa de outra área.");
      const key = `module:${moduleId}:${c.id}:${options.key}`;
      const actor = options.actor || "system";
      if (options.notification) {
        // Notificação: com a janela aberta na oficial, o elemento nativo; com
        // ela fechada, o texto numerado pelo modelo de notificação.
        const official = await interactiveLine(env, c);
        const open = Date.now() - c.last_customer < 86400000;
        return enqueue(
          env,
          c,
          actor,
          "notification",
          interactivePayload(spec, official && open, { automation: moduleId }),
          key,
        );
      }
      return sendInteractiveMessage(env, actor, c, spec, key, moduleId);
    },
    openWebStep(c, request) {
      requireValue(c.profile_id === profile, "Conversa de outra área.");
      return openWebStep(env, {
        ...request,
        conversation: c,
        module: moduleId,
        sourceKey: `module:${moduleId}:${c.id}:${request.sourceKey}`,
      });
    },
    async charge(c, request) {
      requireValue(c.profile_id === profile, "Conversa de outra área.");
      return (
        await createPayment(env, {
          conversation: c,
          method: request.method,
          amount_cents: request.amount_cents,
          description: request.description,
          module: moduleId,
          ref: request.ref ?? null,
          trigger: request.trigger || "module",
          actor: request.actor || "system",
          sourceKey: `module:${moduleId}:${c.id}:${request.sourceKey}`,
          expiresMinutes: request.expiresMinutes,
          notification: request.notification,
        })
      ).payment;
    },
    async publish(kind, resourceId, payload, options) {
      if (!definition.events.includes(kind))
        throw new Error(
          `Evento ${kind} não declarado pelo módulo ${moduleId} (events).`,
        );
      return event(
        env,
        profile,
        kind,
        resourceId,
        { ...payload, module_id: moduleId },
        options?.key
          ? `module:${moduleId}:${profile}:${kind}:${options.key}`
          : undefined,
      );
    },
  };
  return ctx;
}

/**
 * Cobrança aberta pelo módulo (ctx.charge) mudou de estado: paid, expired,
 * cancelled ou refunded. Só depois do webhook assinado e da consulta ao
 * provedor; repetições do webhook não chamam de novo.
 */
export function onPaymentUpdated(
  moduleId: string,
  hook: (
    ctx: ModuleContext,
    payment: Payment,
    change: { previous: string },
  ) => Promise<void>,
) {
  registerPaymentHook(moduleId, (env, profile, payment, previous) =>
    hook(modulesApi(env, profile, moduleId), payment, { previous }),
  );
}

/**
 * Reage à conclusão dos passos web abertos pelo módulo. Por padrão o núcleo
 * já mandou o retorno (`return_text`) antes de chamar o gancho. Aberto com
 * `spec.return_message: "module"`, o núcleo não manda nada: a string
 * devolvida aqui vira o retorno ao cliente (com o número da ordem, por
 * exemplo); sem string, só o que o próprio módulo enviar.
 */
export function onWebStepCompleted(
  moduleId: string,
  hook: (
    ctx: ModuleContext,
    step: WebStep,
    answers: Answers,
  ) => Promise<void | string | false>,
) {
  registerWebStepHook(moduleId, (env, profile, step, answers) =>
    hook(modulesApi(env, profile, moduleId), step, answers),
  );
}

/**
 * Trata o item de menu do WhatsApp de um tipo declarado em menu_item_types.
 * O núcleo só chama com o módulo ligado e fora de grupos; `rowId` identifica
 * a mensagem recebida (use em chaves de idempotência).
 */
export function onMenuChoice(
  type: string,
  handler: (
    ctx: ModuleContext,
    c: Conversation,
    item: any,
    turn: { rowId: string },
  ) => Promise<void>,
) {
  const owner = moduleForMenuType(type);
  if (!owner) throw new Error(`Tipo de menu não declarado: ${type}`);
  registerMenuHandler(type, (env, c, item, rowId) =>
    handler(modulesApi(env, c.profile_id, owner.id), c, item, { rowId }),
  );
}

/**
 * Ação de conversa própria do módulo (POST /conversations/:id/actions com
 * action=<nome>). O núcleo já conferiu conversations:write e a visibilidade
 * da conversa; a regra de quem pode agir fica com o módulo.
 */
export function onConversationAction(
  moduleId: string,
  action: string,
  handler: (
    ctx: ModuleContext,
    actor: Actor,
    c: Conversation,
    data: any,
    request: { requestId: string },
  ) => Promise<any>,
) {
  registerConversationAction(action, async (env, actor, c, data, requestId) => {
    const ctx = modulesApi(env, c.profile_id, moduleId);
    await ctx.requireEnabled();
    return handler(ctx, actor, c, data, { requestId });
  });
}

/**
 * Comando de escrita do módulo. Roda no Coordinator da área (serializado),
 * com recibo de idempotência e auditoria; `op` precisa começar por um dos
 * prefixos de `operations`. Com o módulo desligado, o núcleo já respondeu 409.
 */
export function onCommand(
  moduleId: string,
  op: string,
  handler: (
    ctx: ModuleContext,
    actor: Actor,
    data: any,
    request: { requestId: string },
  ) => Promise<any>,
) {
  const definition = moduleById(moduleId);
  if (!definition?.operations.some((prefix) => op.startsWith(prefix)))
    throw new Error(`Operação ${op} fora de operations do módulo ${moduleId}.`);
  registerCommand(op, (env, actor, profile, data, requestId) =>
    handler(modulesApi(env, profile, moduleId), actor, data, { requestId }),
  );
}

const ownsPath = (definition: ModuleDefinition | null, path: string) =>
  !!definition && definition.routes.includes(path.split("/")[0]);

/**
 * Rota de escrita /api/v1/profiles/:profile/<path> → comando `op`. O corpo
 * JSON e o :id do caminho viram `data`; exige Idempotency-Key.
 */
export function onRoute(moduleId: string, route: ModuleWriteRoute) {
  if (!ownsPath(moduleById(moduleId), route.path))
    throw new Error(`Rota ${route.path} fora de routes do módulo ${moduleId}.`);
  registerWriteRoute(route);
}

/**
 * Leitura GET /api/v1/profiles/:profile/<path>, fora do Coordinator. O núcleo
 * já autenticou e conferiu a área; a permissão fica com ctx.access.
 */
export function onRead(
  moduleId: string,
  path: string,
  handler: (
    ctx: ModuleContext,
    actor: Actor,
    request: { params: Record<string, string>; query: Record<string, string> },
  ) => Promise<any>,
) {
  if (!ownsPath(moduleById(moduleId), path))
    throw new Error(`Rota ${path} fora de routes do módulo ${moduleId}.`);
  registerReadRoute({
    path,
    handler: async (env, actor, profile, request) => {
      const ctx = modulesApi(env, profile, moduleId);
      await ctx.requireEnabled();
      return handler(ctx, actor, request);
    },
  });
}

/**
 * Conteúdo estruturado recebido do WhatsApp antes do menu e do bot:
 * "order" (carrinho do catálogo, content.order) ou "flow_reply" (resposta de
 * Flow que não é de um passo web, content.flow_reply). Devolva true quando
 * tratou; o núcleo para ali. Só roda com o módulo ligado.
 */
export function onInboundContent(
  moduleId: string,
  type: "order" | "flow_reply",
  handler: (
    ctx: ModuleContext,
    c: Conversation,
    content: any,
    turn: { rowId: string },
  ) => Promise<boolean>,
) {
  registerInboundHandler(type, async (env, c, content, rowId) => {
    const ctx = modulesApi(env, c.profile_id, moduleId);
    if (!(await ctx.enabled())) return false;
    return handler(ctx, c, content, { rowId });
  });
}

/**
 * Tarefa periódica do módulo (lembretes, vencimentos). Roda no Coordinator
 * de cada área com o módulo ligado, no máximo uma vez por minuto e ao menos a
 * cada 5 minutos (cron do Worker), com o instante da rodada em `now`. Deve ser
 * idempotente: use chaves de envio derivadas do registro e do momento.
 * Uma falha é registrada e não impede os outros módulos.
 */
export function onSchedule(
  moduleId: string,
  handler: (ctx: ModuleContext, tick: { now: number }) => Promise<void>,
) {
  if (!moduleById(moduleId))
    throw new Error(`Módulo não registrado: ${moduleId}`);
  registerSchedule(moduleId, (env, profile, now) =>
    handler(modulesApi(env, profile, moduleId), { now }),
  );
}

/**
 * Próxima mensagem do cliente numa conversa individual, com o módulo ligado:
 * texto digitado (`text`) ou toque em botão/lista (`replyId`). Roda depois da
 * fila de senhas e antes da porta de entrada, dos protocolos, do menu e do
 * bot, com as mesmas regras de automação e sessão. Devolva true só quando a
 * mensagem é do módulo (estado aberto na conversa ou replyId com o prefixo do
 * módulo, "agenda:…"); false deixa seguir. Ao receber MENU/VOLTAR, limpe o
 * estado e devolva false.
 */
export function onConversationTurn(
  moduleId: string,
  handler: (
    ctx: ModuleContext,
    c: Conversation,
    turn: { text: string; replyId: string | null; rowId: string },
  ) => Promise<boolean>,
) {
  if (!moduleById(moduleId))
    throw new Error(`Módulo não registrado: ${moduleId}`);
  registerTurnHandler(moduleId, async (env, c, turn) => {
    const ctx = modulesApi(env, c.profile_id, moduleId);
    if (!(await ctx.enabled())) return false;
    return handler(ctx, c, turn);
  });
}
/** Mesmo gancho, com o nome pedido pela sessão da Ordem de Serviço. */
export function onInboundReply(
  moduleId: string,
  handler: Parameters<typeof onConversationTurn>[1],
) {
  onConversationTurn(moduleId, handler);
}

/**
 * Ferramenta MCP para bots (Hermes e outros clientes MCP), traduzida para uma
 * chamada à API v1 desta instalação com a chave do cliente: permissões,
 * idempotência e 409 module_disabled valem como na API. O nome começa com o
 * id do módulo ("agenda_horarios_livres"); `profile` entra sozinho e, com
 * `write: true`, também `idempotency_key`.
 */
export function onMcpTool(
  moduleId: string,
  tool: Omit<ModuleMcpTool, "module">,
) {
  if (!moduleById(moduleId))
    throw new Error(`Módulo não registrado: ${moduleId}`);
  if (
    !tool.name.startsWith(`${moduleId}_`) ||
    !/^[a-z0-9_]{3,64}$/.test(tool.name)
  )
    throw new Error(`Ferramenta ${tool.name}: use o prefixo ${moduleId}_.`);
  registerMcpTool({ ...tool, module: moduleId });
}

/** Validação estrita de uma chave declarada em `settings` do módulo. */
export function onSettingsSave(
  moduleId: string,
  key: string,
  validate: (value: unknown) => unknown,
) {
  if (!moduleById(moduleId)?.settings.some((s) => s.key === key))
    throw new Error(`Chave ${key} não declarada pelo módulo ${moduleId}.`);
  registerSettingsValidator(key, validate);
}

/** Erro padrão de regra de módulo (texto mostrado ao cliente ou à equipe). */
export const moduleError = (status: number, code: string, message: string) =>
  new ApiError(status, code, message);
