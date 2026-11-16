// Interface interna para os módulos (contrato em docs/MODULOS.md). Uma vertical
// fala com o núcleo só por aqui: contato, enviar mensagem, abrir passo web,
// publicar evento e os ganchos de menu, ação de conversa, configuração e
// conclusão de passo web. Mudanças aqui exigem atualizar docs/MODULOS.md.
import {
  registerCommand,
  registerConversationAction,
  registerHandoffGate,
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
  registerWebStepValidator,
  registerWriteRoute,
  type ModuleWriteRoute,
} from "./hooks";
import { exec, one } from "../db";
import {
  ApiError,
  type Actor,
  type Conversation,
  type Env,
  requireValue,
} from "../types";
import { access } from "../security";
import { activeTicketSql } from "../protocols";
import { verifiedPhone } from "../protocol-lookup";
import { event } from "../events";
import {
  conversation,
  conversationByPhone,
  enqueue,
  handoff as coreHandoff,
  handoffToPerson,
  message as coreMessage,
  settings,
  type HandoffMeta,
  type HandoffSource,
} from "../service";
import {
  cancelModulePayment,
  createPayment,
  paymentsReady,
  type Payment,
} from "../payments";
import { establishment, type Establishment } from "../establishment";
import {
  CONSENT_PURPOSES,
  consentFor,
  recordConsent,
  type ConsentPurpose,
  type ConsentRecord,
} from "../consents";
import {
  interactiveLine,
  interactivePayload,
  sendInteractive as sendInteractiveMessage,
} from "../line-service";
import type { InteractiveSpec } from "../whatsapp-interactive";
import {
  cancelModuleWebSteps,
  openWebStep,
  webStepView,
  type Answers,
  type OpenWebStepInput,
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
export type { ConsentPurpose, ConsentRecord } from "../consents";
export type WebStepRequest = Omit<OpenWebStepInput, "conversation" | "module">;

export type SensitiveKind = "contacts" | "notes";
/** Pessoas da equipe sempre; aplicação só com `<kind>:read`. */
export const mayRead = (actor: Actor, kind: SensitiveKind) =>
  actor.kind !== "app" || actor.scopes.includes(`${kind}:read`);

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
  /**
   * Dado sensível nas leituras do módulo, como no núcleo: pessoas da equipe
   * sempre veem; aplicações só com `contacts:read` (dados pessoais: telefone,
   * e-mail, documento, endereço, respostas de check-in) ou `notes:read`
   * (notas internas e observações da equipe).
   */
  mayRead(actor: Actor, kind: SensitiveKind): boolean;
  /**
   * Filtros de busca seguros para o ator (conferência M6): sem contacts:read,
   * a busca `q` perde os dígitos e somem os filtros `phone` e `document`, para
   * a lista não virar oráculo (documento ou telefone → cliente).
   */
  safeQuery(
    actor: Actor,
    query: Record<string, string>,
  ): Record<string, string>;
  /**
   * Cópia do registro sem os campos que o ator não pode ver (`mayRead`). Os
   * campos somem da resposta; o resto fica igual.
   */
  redact<T extends Record<string, any>>(
    actor: Actor,
    row: T,
    fields: Partial<Record<SensitiveKind, string[]>>,
  ): T;
  /**
   * Telefone autenticado pelo canal (só dígitos), ou null: conversa de grupo
   * ou de integração (`app:<id>`), em que o `external_id` é escolhido por
   * quem chama. Compare ou vincule registros por telefone só com ele.
   */
  verifiedPhone(c: Conversation): string | null;
  /**
   * Nota interna na conversa (só a equipe vê), por exemplo uma pendência.
   * Com `key`, a mesma nota não se repete (gancho repetido, por exemplo).
   */
  note(
    c: Conversation,
    text: string,
    options?: { key?: string },
  ): Promise<void>;
  /** Configurações da área (itens de menu de módulos desligados ocultos). */
  settings(): Promise<any>;
  /**
   * Dados do estabelecimento (nome fantasia, CPF/CNPJ, endereço, telefone,
   * rodapé) para cupom, comanda, recibo e mensagens. Sem cadastro, `name` é o
   * nome da área e `configured` é falso.
   */
  establishment(): Promise<Establishment>;
  conversation(id: string, actor?: Actor): Promise<Conversation>;
  /**
   * Conversa individual da área com o telefone (com e sem o 9 do celular),
   * ou null. Com `open: true`, abre uma na linha oficial (ou na
   * `connection_id` dada) para o cliente que nunca escreveu: sem janela de
   * 24 h, só sai notificação por modelo (`notification: true` + consentimento
   * da finalidade) até ele responder; a resposta cai na mesma conversa.
   */
  conversationByPhone(
    phone: string,
    options?: { open?: boolean; connection_id?: string },
  ): Promise<Conversation | null>;
  /**
   * Protocolo ativo da conversa (não resolvido nem fechado, o mais recente),
   * ou null: `{id, number, status, title, created}`. Para regras como "vale
   * até o protocolo fechar", sem ler a tabela tickets.
   */
  activeTicket(c: Conversation | string): Promise<ActiveTicket | null>;
  /** Contato vinculado à conversa, ou null. */
  contact(c: Conversation | string): Promise<ContactSummary | null>;
  /**
   * Envia mensagem ao cliente pela fila de entrega. `key` torna o envio
   * idempotente; `notification` usa o modelo de notificação quando a janela
   * de 24 horas da linha oficial estiver fechada. Com `purpose`, a
   * notificação fora da janela exige o consentimento dessa finalidade
   * (recordConsent); sem ela, vale o consentimento de protocolo.
   */
  sendMessage(
    c: Conversation,
    message: OutgoingMessage,
    options: SendOptions,
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
    options: SendOptions,
  ): Promise<string>;
  /**
   * Registra o consentimento de notificação de uma finalidade quando o
   * cliente contrata, agenda, pede ou reserva pelo WhatsApp (ou a equipe
   * registra o aceite presencial), com origem e evidência. Fora da janela,
   * as notificações com `purpose` só saem com ele. REVOGAR do cliente
   * revoga todas.
   */
  recordConsent(c: Conversation, record: ConsentRecord): Promise<any>;
  /** Último consentimento que vale para a finalidade, ou null. */
  consent(c: Conversation, purpose: ConsentPurpose): Promise<any>;
  /**
   * Cancela um link aberto do próprio módulo: quem abrir vê "Link
   * indisponível" e não conclui. Já fechado (concluído, vencido, cancelado):
   * devolve como está. De outro módulo ou de outra área: 404.
   */
  cancelWebStep(id: string): Promise<WebStep>;
  /**
   * Cancela todos os links abertos do módulo com o `kind` (e o `ref`) dados,
   * por exemplo os carrinhos quando a loja pausa. Devolve os ids cancelados.
   */
  cancelWebSteps(filter: {
    kind?: string;
    ref?: string | null;
  }): Promise<string[]>;
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
  /**
   * Cancela uma cobrança aberta pelo próprio módulo (reserva cancelada antes
   * do sinal). Já cancelada ou expirada: devolve como está; paga ou
   * estornada: 409 payment_closed. Cobrança de outro módulo: 404.
   */
  cancelCharge(payment: Payment | string): Promise<Payment>;
  /**
   * Se a área pode cobrar agora (módulo Cobrança ligado e conta ativa), para
   * avisar o administrador antes de oferecer pagamento:
   * `{ready, reason: "payments_disabled"|"payments_not_configured"|null, message, methods}`.
   */
  paymentsReady(): ReturnType<typeof paymentsReady>;
  /**
   * Passa a conversa para atendimento humano: um setor, a fila geral da
   * equipe ou uma pessoa. O resumo e os marcadores ("telefone não vinculado")
   * ficam numa nota interna e em `handoff` no detalhe da conversa. Não passa
   * pelos ganchos onHandoffRequest: é assim que um módulo libera a conversa
   * que segurou. Com `key`, repetir a chamada não passa de novo.
   */
  handoff(c: Conversation, request?: HandoffRequest): Promise<Conversation>;
}

export interface ActiveTicket {
  id: string;
  number: string;
  status: string;
  title: string;
  created: number;
}

export interface SendOptions {
  key: string;
  actor?: string;
  notification?: boolean;
  /** Finalidade da notificação: billing, scheduling, order ou booking. */
  purpose?: ConsentPurpose;
}

export interface HandoffRequest {
  /** Sem destino: fila geral da equipe. */
  target?: { department_id?: string | null; user_id?: string };
  /** Até 3000 caracteres: o que o atendente precisa saber. */
  summary?: string;
  /** Até 10 marcadores de até 60 caracteres, ex. "telefone não vinculado". */
  flags?: string[];
  /** Motivo no evento conversation.updated; padrão "Encaminhado pelo módulo …". */
  reason?: string;
  key?: string;
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
  /**
   * false: o núcleo não manda o "Pagamento recebido"; o módulo envia o
   * próprio comprovante no onPaymentUpdated. Padrão true.
   */
  receipt?: boolean;
}

/** consent_purpose no payload da fila, validado. */
function purposeField(purpose: ConsentPurpose | undefined) {
  if (purpose === undefined) return {};
  requireValue(
    CONSENT_PURPOSES.includes(purpose),
    `Finalidade inválida: use ${CONSENT_PURPOSES.join(", ")}.`,
  );
  return { consent_purpose: purpose };
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
    mayRead: (actor, kind) => mayRead(actor, kind),
    safeQuery(actor, query) {
      if (mayRead(actor, "contacts")) return query;
      const { phone: _p, document: _d, ...rest } = query;
      if (typeof rest.q === "string")
        rest.q = rest.q
          .replace(/\d/g, "")
          .replace(/[.\-/()+]/g, " ")
          .trim();
      return rest;
    },
    redact(actor, row, fields) {
      const copy: Record<string, any> = { ...row };
      for (const kind of Object.keys(fields) as SensitiveKind[])
        if (!mayRead(actor, kind))
          for (const field of fields[kind] || []) delete copy[field];
      return copy as typeof row;
    },
    verifiedPhone: (c) => verifiedPhone(c),
    async note(c, text, options = {}) {
      requireValue(c.profile_id === profile, "Conversa de outra área.");
      const value = String(text ?? "").trim();
      requireValue(
        value && value.length <= 3000,
        "Nota de 1 a 3000 caracteres.",
      );
      const external = options.key ? `note:${moduleId}:${options.key}` : null;
      if (
        external &&
        (await one(
          env,
          "SELECT id FROM messages WHERE conversation_id=? AND external_id=? AND direction='note'",
          c.id,
          external,
        ))
      )
        return;
      await coreMessage(
        env,
        c,
        "note",
        `module:${moduleId}`,
        value,
        [],
        external,
      );
    },
    settings: () => settings(env, profile),
    establishment: () => establishment(env, profile),
    conversation: (id, actor) => conversation(env, id, profile, actor),
    conversationByPhone: (phone, options = {}) =>
      conversationByPhone(env, profile, phone, {
        open: options.open,
        connectionId: options.connection_id ?? null,
        module: moduleId,
      }),
    activeTicket(c) {
      return one<ActiveTicket>(
        env,
        `SELECT id,number,status,title,created FROM tickets WHERE conversation_id=? AND profile_id=? AND ${activeTicketSql()} ORDER BY created DESC,id DESC LIMIT 1`,
        typeof c === "string" ? c : c.id,
        profile,
      );
    },
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
          ...purposeField(options.purpose),
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
          interactivePayload(spec, official && open, {
            automation: moduleId,
            ...purposeField(options.purpose),
          }),
          key,
        );
      }
      return sendInteractiveMessage(env, actor, c, spec, key, moduleId);
    },
    recordConsent: (c, record) => {
      requireValue(c.profile_id === profile, "Conversa de outra área.");
      return recordConsent(env, c, moduleId, record);
    },
    consent: (c, purpose) => {
      requireValue(c.profile_id === profile, "Conversa de outra área.");
      return consentFor(env, c.id, purpose);
    },
    async cancelWebStep(id) {
      const row = await one(
        env,
        "SELECT id FROM web_steps WHERE id=? AND profile_id=? AND module_id=?",
        id,
        profile,
        moduleId,
      );
      if (!row)
        throw new ApiError(404, "not_found", "Passo web não encontrado.");
      await cancelModuleWebSteps(env, profile, moduleId, { id });
      return webStepView(
        await one(env, "SELECT * FROM web_steps WHERE id=?", id),
      )!;
    },
    cancelWebSteps: (filter) =>
      cancelModuleWebSteps(env, profile, moduleId, {
        ...(filter.kind !== undefined ? { kind: filter.kind } : {}),
        ...(filter.ref !== undefined ? { ref: filter.ref } : {}),
      }),
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
          receipt: request.receipt,
        })
      ).payment;
    },
    cancelCharge: (payment) =>
      cancelModulePayment(
        env,
        profile,
        moduleId,
        typeof payment === "string" ? payment : payment.id,
      ),
    paymentsReady: () => paymentsReady(env, profile),
    async handoff(c, request = {}) {
      requireValue(c.profile_id === profile, "Conversa de outra área.");
      const summary = String(request.summary ?? "").trim();
      requireValue(
        Array.from(summary).length <= 3000,
        "Resumo da passagem: até 3000 caracteres.",
      );
      const flags = request.flags ?? [];
      requireValue(
        Array.isArray(flags) &&
          flags.length <= 10 &&
          flags.every(
            (f) =>
              typeof f === "string" &&
              f.trim() &&
              Array.from(f.trim()).length <= 60,
          ),
        "Marcadores da passagem: até 10, de 1 a 60 caracteres.",
      );
      const target = request.target || {};
      requireValue(
        !(target.user_id && target.department_id),
        "Passe para um setor ou para uma pessoa, não os dois.",
      );
      const meta: HandoffMeta = {
        module: moduleId,
        summary,
        flags: flags.map((f) => f.trim()),
        at: Date.now(),
      };
      const reason =
        request.reason?.trim() || `Encaminhado pelo módulo ${definition.name}.`;
      // Nota interna com o resumo e os marcadores; com `key`, a mesma passagem
      // repetida (gancho reexecutado) não passa de novo.
      const note = [
        `${definition.name}: ${summary || "encaminhado para a equipe."}`,
        ...(meta.flags.length ? [`Atenção: ${meta.flags.join("; ")}`] : []),
      ].join("\n");
      const inserted = await exec(
        env,
        "INSERT OR IGNORE INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,source_key,created) VALUES(?,?,?,'note',?,?,'[]',?,?)",
        crypto.randomUUID(),
        profile,
        c.id,
        `module:${moduleId}`,
        note,
        request.key
          ? `module:${moduleId}:${c.id}:handoff:${request.key}`
          : null,
        Date.now(),
      );
      if (request.key && !inserted.meta.changes)
        return conversation(env, c.id, profile);
      if (target.user_id)
        await handoffToPerson(env, c, target.user_id, reason, meta);
      else
        await coreHandoff(
          env,
          c,
          reason,
          target.department_id ?? null,
          summary || null,
          true,
          { meta, source: "module" },
        );
      return conversation(env, c.id, profile);
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
 * provedor. Entrega durável (revisão A3): se o gancho lançar, a mudança fica
 * pendente e é repetida até concluir; o gancho precisa ser idempotente.
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
 * Última conferência antes de concluir um passo web do módulo (depois da
 * validação dos campos e do recálculo do carrinho). Devolva um texto para
 * recusar: a página mostra o motivo no lugar de "Pedido enviado!" e o link
 * continua aberto para o cliente ajustar. Nada devolvido conclui. Erro no
 * gancho também recusa (com um aviso genérico) e vai para o log.
 */
export function onWebStepValidate(
  moduleId: string,
  validator: (
    ctx: ModuleContext,
    step: WebStep,
    answers: Answers,
  ) => Promise<string | null | void>,
) {
  registerWebStepValidator(moduleId, (env, profile, step, answers) =>
    validator(modulesApi(env, profile, moduleId), step, answers),
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
 * onRead, onCommand e onConversationAction que passam toda resposta por
 * `filter(ctx, actor, valor)`, por exemplo para tirar dados pessoais e notas
 * de quem não tem contacts:read ou notes:read (ctx.redact). O módulo usa
 * estas no lugar das originais e nenhuma rota fica de fora.
 */
export function filteredHandlers(
  filter: (ctx: ModuleContext, actor: Actor, value: any) => any,
) {
  return {
    onRead: (...[moduleId, path, handler]: Parameters<typeof onRead>) =>
      onRead(moduleId, path, async (ctx, actor, request) =>
        filter(ctx, actor, await handler(ctx, actor, request)),
      ),
    onCommand: (...[moduleId, op, handler]: Parameters<typeof onCommand>) =>
      onCommand(moduleId, op, async (ctx, actor, data, request) =>
        filter(ctx, actor, await handler(ctx, actor, data, request)),
      ),
    onConversationAction: (
      ...[moduleId, action, handler]: Parameters<typeof onConversationAction>
    ) =>
      onConversationAction(moduleId, action, async (ctx, actor, c, data, r) =>
        filter(ctx, actor, await handler(ctx, actor, c, data, r)),
      ),
  };
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
/**
 * Condiciona toda passagem automática para humano: item de menu de
 * atendimento humano ("menu", com `menu_item_id`), palavra-chave
 * ("keyword"), bot de IA que transfere ("bot"), falha do bot ("bot_error"),
 * anexo ("attachment"), carrinho ou Flow sem dono ("structured"). Devolva
 * "hold" para segurar: o núcleo não muda a conversa nem avisa o cliente; o
 * módulo assume o fluxo (oferece o pagamento, por exemplo) e libera depois
 * com ctx.handoff, que não passa por aqui. "allow" (ou nada) deixa seguir.
 *
 * Não passam por aqui: a transferência feita pela equipe e o atendente que
 * assume a conversa. Com mais de um módulo, a ordem é a de `modules` em
 * src/modules/registry.ts; o primeiro "hold" encerra a consulta. Erro no
 * gancho libera a passagem (o cliente nunca fica preso) e vai para o log,
 * a menos que o módulo declare `{failClosed: true}` (quem vende acesso à
 * equipe): aí o erro segura a conversa e deixa uma nota interna para a
 * equipe conferir.
 */
export function onHandoffRequest(
  moduleId: string,
  handler: (
    ctx: ModuleContext,
    c: Conversation,
    request: HandoffGateRequest,
  ) => Promise<"allow" | "hold" | void>,
  options: { failClosed?: boolean } = {},
) {
  if (!moduleById(moduleId))
    throw new Error(`Módulo não registrado: ${moduleId}`);
  registerHandoffGate(
    moduleId,
    async (env, c, request) => {
      const ctx = modulesApi(env, c.profile_id, moduleId);
      if (!(await ctx.enabled())) return "allow";
      return (await handler(ctx, c, request)) === "hold" ? "hold" : "allow";
    },
    options,
  );
}
export interface HandoffGateRequest {
  source: Exclude<HandoffSource, "staff" | "module">;
  /** Motivo do núcleo ("Menu: Humano (pago)", "Bot transferiu…"). */
  reason: string;
  /** Setor pedido (item de menu); null = fila geral. */
  department_id: string | null;
  /** Pedido do cliente ou resumo do bot, quando houver. */
  summary: string | null;
  /** Item de menu escolhido (source "menu"). */
  menu_item_id: string | null;
  /**
   * Evento que pediu a passagem: a mensagem da caixa de entrada (ou a
   * execução do bot). Estável quando a mesma mensagem é reprocessada; use
   * nas chaves (`gate:${rowId}`) no lugar do relógio. Null fora de mensagem.
   */
  row_id: string | null;
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
