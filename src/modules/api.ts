// Interface interna para os módulos (contrato em docs/MODULOS.md). Uma vertical
// fala com o núcleo só por aqui: contato, enviar mensagem, abrir passo web,
// publicar evento e os ganchos de menu, ação de conversa, configuração e
// conclusão de passo web. Mudanças aqui exigem atualizar docs/MODULOS.md.
import {
  registerCommand,
  registerConversationAction,
  registerInboundHandler,
  registerMenuHandler,
  registerReadRoute,
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
  /** Abre um passo web em nome do módulo (web_steps.module_id). */
  openWebStep(
    c: Conversation,
    request: WebStepRequest,
  ): ReturnType<typeof openWebStep>;
  /** Publica um evento declarado em `events` do módulo. */
  publish(kind: string, resourceId: string, payload: any): Promise<number>;
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
    openWebStep(c, request) {
      requireValue(c.profile_id === profile, "Conversa de outra área.");
      return openWebStep(env, {
        ...request,
        conversation: c,
        module: moduleId,
        sourceKey: `module:${moduleId}:${c.id}:${request.sourceKey}`,
      });
    },
    async publish(kind, resourceId, payload) {
      if (!definition.events.includes(kind))
        throw new Error(
          `Evento ${kind} não declarado pelo módulo ${moduleId} (events).`,
        );
      return event(env, profile, kind, resourceId, {
        ...payload,
        module_id: moduleId,
      });
    },
  };
  return ctx;
}

/** Reage à conclusão dos passos web abertos pelo módulo. */
export function onWebStepCompleted(
  moduleId: string,
  hook: (ctx: ModuleContext, step: WebStep, answers: Answers) => Promise<void>,
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
