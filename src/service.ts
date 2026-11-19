import { syncErpParts } from "./modules/erp/parts-state";
import {
  all,
  one,
  exec,
  batch,
  cachedOne,
  PROFILE_SETTINGS_SQL,
  withReadCache,
} from "./db";
import {
  ApiError,
  type Env,
  type Actor,
  type Conversation,
  uid,
  now,
  json,
  defaults,
  requireValue,
} from "./types";
import {
  access,
  admin,
  isEngineActor,
  random,
  refuseEngineActor,
  sha,
  canonical,
  setSecret,
  publicUrl,
  passwordHash,
} from "./security";
import { event, audit, eventStatement, fanOut } from "./events";
import { appErpRoleInput } from "./modules/erp/identity";
import { boundAllows, visibleConversation } from "./visibility";
import { probe, telegramRemoved } from "./integrations";
import { aiConfig, aiKey } from "./ai-provider";
import { secret } from "./security";
import { validateJevSettings } from "./jev-client";
import { contactCommand } from "./contacts";
import { installIdentityPort, identityPort } from "./customer/ports";
import { customerIdentity, inboundConnection, evidencePhone } from "./customer/identity";
import { normalizeCustomerPhone, customerPhoneVariants, customerPhoneInputMode } from "./customer/phone";
import type { InboundEvidence } from "./customer/contracts";
installIdentityPort(customerIdentity, { default: true });
import { authorizedMedia, mediaKind, uploadCommand } from "./media";
import {
  outgoingContent,
  messageAction,
  channelEvent,
  applyChannelEvents,
  syncGroup,
  needCapability,
} from "./whatsapp";
import { callCommand } from "./calls";
import { groupCommand } from "./groups";
import { zernioAccountCommand } from "./zernio-accounts";
import { resolveZernioProfile } from "./zernio-profile-resolution";
import { removeConnection } from "./connection-removal";
import { removeIntegration } from "./integration-removal";
import { routerCommand, managedAppAllowed } from "./number-router";
import { queueWithNumberQuota } from "./number-quota";
import {
  saveLine,
  validateLineIds,
  botAllowsLine,
  serviceForLine,
  lineService,
  sendMenu,
  availableMenus,
} from "./line-service";
import { askBotInChat, internalCommand } from "./team";
import {
  validateDepartments,
  departmentFor,
  assertDepartmentAccess,
  presentInDepartment,
} from "./departments";
import { chunkWrites, documentText, searchKnowledge } from "./knowledge";
import { sendProtocolLookup } from "./protocol-lookup";
import {
  protocolDueAt,
  businessHours,
  validateBusinessHours,
  validResponseDays,
  responseUnits,
} from "./business-time";
import {
  ticketStatuses,
  isActiveTicket,
  activeTicketSql,
  validateTicketCategories,
  enabledCategory,
  protocolConfirmation,
  defaultProtocolConfirmation,
} from "./protocols";
import { applyServiceTemplate } from "./service-templates";
import { queueCommand, validateQueueSettings } from "./queue";
import { validateEstablishment } from "./establishment";
import { requireOperationAccess, validateAccess } from "./access";
import { requireFinancialAal, validateSchedule } from "./mfa";
import { issueAccountLink } from "./auth-tokens";
import { alertAccount, mailAccountLink } from "./email";
import {
  hiddenMenuTypes,
  moduleById,
  moduleCommand,
  moduleForMenuType,
  moduleMenuTypes,
  moduleStates,
  planModuleStates,
  configuredModuleStates,
  requireOperation,
  resolveStates,
  modules as registeredModules,
} from "./modules/registry";
import {
  conversationAction,
  gateFailsClosed,
  handoffGatesList,
  moduleCommandHandler,
  settingsValidator,
  validateSettingsChange,
} from "./modules/hooks";
import { cancelWebStep } from "./web-steps";
// Ganchos dos módulos embutidos (ações de conversa, chaves de configuração).
import "./modules/runtime";
import {
  assertNumberDelivery,
  getNumberPolicy,
  numberPolicyError,
} from "./number-permissions";
/** Conexões antigas permanecem legíveis e removíveis, sem poder voltar ao serviço. */
async function requireCurrentConnection(env: Env, connection: { id?: string; kind: string; config?: string }) {
  if (json(connection.config).remove_pending)
    throw new ApiError(409, "connection_removing", "Esta conexão está sendo removida.");
  const retired = await one(env,
    "SELECT 1 FROM (SELECT ? AS kind) WHERE kind IN ('hermes','hermes-whatsapp')",
    connection.kind || "");
  requireValue(!retired, "Hermes retirado: escolha um bot interno.");
}

/** Escopos internos nunca são aceitos de uma requisição de chave. */
function rejectInternalScopes(value: unknown) {
  if (Array.isArray(value) && value.some((scope) => ["conversations:bound", "conversations:all"].includes(scope)))
    throw new ApiError(400, "scope_internal", "Escopos de conversa internos não podem ser emitidos em chaves de API.");
}

export const scopes = [
  "routing:read",
  "routing:send",
  "routing:paid",
  "calls:read",
  "calls:write",
  "groups:manage",
  "conversations:read",
  "conversations:write",
  "contacts:read",
  "contacts:write",
  "notes:read",
  // Operações financeiras dos módulos (baixa manual, isenção, planos, valores).
  // Nunca vai para aparelhos pareados de mensagens (Vinki, Fagoo).
  "billing:write",
  "tickets:read",
  "tickets:write",
  "knowledge:read",
  "knowledge:write",
  "media:read",
  "media:write",
  "reports:read",
  "presence:read",
  "presence:write",
  "bots:read",
  "bots:invoke",
  "events:read",
  "webhooks:manage",
  "queue:read",
  "queue:issue",
  "queue:operate",
  // ERP da área (src/modules/erp/identity.ts): leitura (GET da erp-api,
  // papel consulta) e escrita.
  "erp:read",
  "erp:write",
];
export const eventTypes = [
  "conversation.created",
  "conversation.updated",
  "message.received",
  "message.sent",
  "message.updated",
  "call.updated",
  "ticket.created",
  "ticket.updated",
  "bot.run.completed",
  "bot.run.failed",
  "queue.issued",
  "queue.called",
  "queue.recalled",
  "queue.started",
  "queue.finished",
  "queue.no_show",
  "queue.cancelled",
  "queue.transferred",
  "queue.counter",
  "queue.changed",
  "module.changed",
  "web_step.sent",
  "web_step.opened",
  "web_step.completed",
  "web_step.expired",
  "web_step.cancelled",
  "form.submitted",
  "payment.created",
  "payment.paid",
  "payment.expired",
  "payment.cancelled",
  "payment.refunded",
  "payment.duplicate",
  "payment.duplicate_refunded",
  "payment.hook_failed",
];
const text = (value: any, max = 3800) => {
  requireValue(
    typeof value === "string" && value.trim().length > 0 && value.length <= max,
    `Informe um texto de até ${max} caracteres.`,
  );
  return value.trim();
};
async function profileWithModules(env: Env, profile: string) {
  const row = await cachedOne(env, PROFILE_SETTINGS_SQL, profile);
  if (!row)
    throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  return { row, states: resolveStates(json(row.module_states)) };
}
/**
 * Configurações da área como o atendimento as vê: itens de menu de módulos
 * desligados ficam de fora (somem do WhatsApp e do editor de menus). O que
 * está salvo não muda; o comando "settings" devolve esses itens ao gravar.
 */
export async function settings(env: Env, profile: string) {
  const { row, states } = await profileWithModules(env, profile);
  const cfg = { ...defaults, ...json(row.settings) };
  const hidden = hiddenMenuTypes(states);
  if (hidden.size && Array.isArray(cfg.menus))
    cfg.menus = cfg.menus.filter((item: any) => !hidden.has(item?.type));
  return cfg;
}
/**
 * Especialistas e itens de menu do tipo bot: o bot precisa ser da área. Um
 * especialista interno só consulta os dados do cliente da conversa (ferramentas de
 * leitura dos módulos, src/engine.ts "Especialista"), sem escrita.
 */
async function requireToolBot(
  env: Env,
  profile: string,
  botId: string,
  use: "menu" | "specialist",
) {
  const bot = await one(
    env,
    "SELECT b.id,c.kind FROM bots b JOIN connections c ON c.id=b.connection_id WHERE b.id=? AND b.profile_id=?",
    botId,
    profile,
  );
  requireValue(
    bot?.kind === "ai",
    use === "menu"
      ? "Escolha um bot interno desta área para o menu."
      : "Escolha um bot interno desta área para a ação.",
  );
  // Especialista interno: um bot do provedor de IA direto responde na fase
  // specialist só com as consultas da conversa (src/engine.ts, aiRun) e o
  // JSON do especialista; o JEV continua decidindo a rota.
}
export async function conversation(
  env: Env,
  id: string,
  profile: string,
  actor?: Actor,
) {
  const row = await one<Conversation>(
    env,
    "SELECT * FROM conversations WHERE id=? AND profile_id=?",
    id,
    profile,
  );
  if (
    !row ||
    (actor &&
      (!visibleConversation(actor, row) ||
        !(await boundAllows(env, actor, row))))
  )
    throw new ApiError(404, "not_found", "Conversa não encontrada.");
  return row;
}
export async function mediaIds(env: Env, profile: string, ids: any) {
  requireValue(Array.isArray(ids) && ids.length <= 10, "Use até 10 anexos.");
  for (const id of ids)
    requireValue(
      await one(
        env,
        "SELECT id FROM media WHERE id=? AND profile_id=?",
        id,
        profile,
      ),
      "Anexo não encontrado nesta área de atendimento.",
    );
  return ids;
}
export async function enqueue(
  env: Env,
  c: Conversation,
  actor: string,
  kind: string,
  payload: any,
  dedupe: string,
) {
  await assertNumberDelivery(env, c.connection_id, actor, kind, payload);
  if (
    kind !== "team" &&
    !c.connection_id &&
    (c.external_namespace.startsWith("channel:") || c.recipient_id)
  )
    throw new ApiError(
      410,
      "connection_removed",
      "Este telefone foi excluído. Conecte uma linha e inicie uma nova conversa.",
    );
  if (payload.attachments?.length) {
    const ids: string[] = [];
    const firstMedia = await one(
      env,
      "SELECT type FROM media WHERE id=?",
      payload.attachments[0],
    );
    const firstKind =
      payload.content?.type && payload.content.type !== "text"
        ? payload.content.type
        : mediaKind(firstMedia?.type || "application/octet-stream");
    const caption =
      !!payload.content && ["image", "video", "document"].includes(firstKind);
    if (payload.text && !caption)
      ids.push(
        await enqueue(
          env,
          c,
          actor,
          kind,
          {
            ...payload,
            attachments: [],
            content: payload.content
              ? { ...payload.content, type: "text" }
              : undefined,
          },
          dedupe + ":text",
        ),
      );
    for (const [index, attachment] of payload.attachments.entries())
      ids.push(
        await enqueue(
          env,
          c,
          actor,
          kind,
          {
            ...payload,
            text: caption && index === 0 ? payload.text : "",
            attachments: [],
            media_id: attachment,
            content: {
              ...payload.content,
              type:
                !payload.content?.type || payload.content.type === "text"
                  ? mediaKind(
                      (
                        await one(
                          env,
                          "SELECT type FROM media WHERE id=?",
                          attachment,
                        )
                      )?.type || "application/octet-stream",
                    )
                  : payload.content.type,
            },
          },
          dedupe + ":media:" + index,
        ),
      );
    return ids[0];
  }
  const id = uid();
  const managed =
    kind !== "team" &&
    c.connection_id &&
    (await cachedOne(
      env,
      "SELECT connection_id FROM meta_numbers WHERE connection_id=?",
      c.connection_id,
    ));
  if (
    managed &&
    !(await managedAppAllowed(
      env,
      actor,
      c.connection_id!,
      payload.router_source,
      !!payload.template_message,
    ))
  )
    throw new ApiError(
      403,
      "source_not_allowed",
      "Aplicação sem autorização para este número do roteador.",
    );
  if (managed && payload.template_message)
    requireValue(
      payload.paid_authorization?.actor === actor && payload.router_source,
      "Modelo pago exige autorização individual pelo roteador.",
    );
  const category =
    kind === "team" || payload.content?.type === "read"
      ? "action"
      : kind === "template" ||
          (!managed &&
            kind === "notification" &&
            now() - c.last_customer >= 86400000)
        ? "template"
        : "service";
  const inserted = await queueWithNumberQuota(
    env,
    [
      id,
      c.profile_id,
      c.id,
      c.connection_id,
      c.epoch,
      kind,
      actor,
      JSON.stringify(payload),
      dedupe,
      now(),
      now(),
    ],
    category,
  );
  // Repetição (mesma chave dedupe): devolve a linha que já estava na fila.
  return (
    inserted ??
    (await one(env, "SELECT id FROM outbox WHERE dedupe=?", dedupe)).id
  );
}
export async function message(
  env: Env,
  c: Conversation,
  direction: string,
  actor: string,
  value: string,
  attachments: string[] = [],
  external: string | null = null,
) {
  const id = uid();
  await exec(
    env,
    `INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,external_id,created,content)
     SELECT ?,?,?,?,?,?,?,?,?,json_object('customerSession',session) FROM conversations WHERE id=? AND profile_id=?`,
    id,
    c.profile_id,
    c.id,
    direction,
    actor,
    value,
    JSON.stringify(attachments),
    external,
    now(),
    c.id,
    c.profile_id,
  );
  return id;
}
export interface TicketOptions {
  /** Reuse the conversation's active protocol (automatic opening only). */
  dedupe?: boolean;
  /** Category id already checked against the settings, or null. */
  category?: string | null;
  /** Overrides the conversation owner; null opens it without a responsible person. */
  owner?: string | null;
  /** Makes a replayed inbox row or bot run find the protocol it already opened. */
  sourceKey?: string;
  /** Full request, stored as the first public update. */
  description?: string;
  descriptionActor?: string;
}
/** Opens a protocol and tells whether it is new or one that already existed. */
export async function createTicket(
  env: Env,
  c: Conversation,
  title: string,
  options: TicketOptions = {},
): Promise<{ ticket: any; created: boolean }> {
  if (options.dedupe) {
    const old = await one(
      env,
      `SELECT * FROM tickets WHERE conversation_id=? AND ${activeTicketSql()} ORDER BY created DESC,id DESC LIMIT 1`,
      c.id,
    );
    if (old) return { ticket: old, created: false };
  }
  const config = await settings(env, c.profile_id);
  const id = uid(),
    at = now();
  const writes: [string, any[]][] = [
    [
      // Protocol numbers are short sequential digits (10001, 10002...), easy to
      // type on a phone. The next number is taken inside the INSERT, which D1
      // runs serialized. Older protocols keep their WA-... numbers.
      `INSERT INTO tickets(id,number,profile_id,conversation_id,title,owner,response_due_at,created,updated,category,source_key)
       VALUES(?,(SELECT CAST(max(10000,coalesce(max(CAST(number AS INTEGER)),0))+1 AS TEXT) FROM tickets WHERE number!='' AND number NOT GLOB '*[^0-9]*'),?,?,?,?,?,?,?,?,?)
       ON CONFLICT(source_key) WHERE source_key IS NOT NULL DO NOTHING`,
      [
        id,
        c.profile_id,
        c.id,
        title,
        options.owner === undefined ? c.owner : options.owner,
        protocolDueAt(at, config),
        at,
        at,
        options.category || null,
        options.sourceKey || null,
      ],
    ],
  ];
  // Written only when this call created the protocol (the SELECT finds no row
  // after a source-key conflict).
  if (options.description)
    writes.push([
      "INSERT OR IGNORE INTO ticket_updates(id,ticket_id,actor,text,internal,created) SELECT ?,id,?,?,0,? FROM tickets WHERE id=?",
      [
        "request:" + id,
        options.descriptionActor || "customer",
        options.description,
        at,
        id,
      ],
    ]);
  writes.push(...(identityPort.recordLink?.(c, {
    profileId: c.profile_id, moduleId: "tickets", kind: "ticket", recordId: id,
    conversationId: c.id, linkedBy: "identity", occurredAt: at,
  }) ?? []));
  await batch(env, writes);
  const ticket = options.sourceKey
    ? await one(
        env,
        "SELECT * FROM tickets WHERE source_key=?",
        options.sourceKey,
      )
    : await one(env, "SELECT * FROM tickets WHERE id=?", id);
  // ticket.created is source-keyed by the protocol id: emitting it again for a
  // protocol found by its source key repairs an interruption without a duplicate.
  await event(env, c.profile_id, "ticket.created", ticket.id, {
    id: ticket.id,
    number: ticket.number,
    conversation_id: c.id,
    ...(ticket.category ? { category: ticket.category } : {}),
  });
  return { ticket, created: ticket.id === id };
}
export async function openTicket(
  env: Env,
  c: Conversation,
  actor: string,
  title: string,
  dedupe = false,
  options: TicketOptions = {},
) {
  return (await createTicket(env, c, title, { ...options, dedupe })).ticket;
}
/** Records the automatic return to in_progress caused by a customer message. */
export async function ticketResumedEvent(
  env: Env,
  profile: string,
  ticketId: string,
  messageId: string,
) {
  const ticket = await one(
    env,
    "SELECT * FROM tickets WHERE id=? AND profile_id=?",
    ticketId,
    profile,
  );
  if (!ticket) return;
  await event(
    env,
    profile,
    "ticket.updated",
    ticket.id,
    {
      status: "in_progress",
      previous_status: "waiting_customer",
      owner: ticket.owner,
      previous_owner: ticket.owner,
      text_added: false,
      actor: "system",
      number: ticket.number,
      reason: "customer_message",
      conversation_id: ticket.conversation_id,
      message_id: messageId,
    },
    `${profile}:ticket.resumed:${ticket.id}:${messageId}`,
  );
}
export async function requestSurvey(
  env: Env,
  c: Conversation,
  key: string,
  actor = "system",
  question?: string,
) {
  requireValue(
    c.chat_type !== "group",
    "Peça uma avaliação em uma conversa individual.",
  );
  const pending = await one(
    env,
    "SELECT id FROM surveys WHERE conversation_id=? AND app_id IS NULL AND status='pending' AND created>? ORDER BY created DESC LIMIT 1",
    c.id,
    now() - 86400000,
  );
  const id = pending?.id || `survey:${key}`;
  const delivery = await enqueue(
    env,
    c,
    actor,
    "text",
    {
      text: `${question || "Como você avalia este atendimento?"}\nResponda de 1 a 5 e, se desejar, escreva um comentário. Para sair da avaliação, envie MENU.`,
    },
    key,
  );
  if (!pending)
    await exec(
      env,
      "INSERT OR IGNORE INTO surveys(id,profile_id,conversation_id,created) VALUES(?,?,?,?)",
      id,
      c.profile_id,
      c.id,
      now(),
    );
  // The latest question wins: the next "3 ..." is a rating, not a protocol description.
  await clearTicketPrompt(env, c.id);
  return { survey_id: id, delivery_id: delivery, status: "pending" };
}
/** Leaves the "awaiting the protocol description" state, if the conversation is in it. */
export async function clearTicketPrompt(env: Env, conversationId: string) {
  await exec(
    env,
    "UPDATE conversations SET ticket_prompt_expires_at=NULL,ticket_prompt_category=NULL,ticket_prompt_session=NULL,ticket_prompt_source=NULL WHERE id=? AND ticket_prompt_expires_at IS NOT NULL",
    conversationId,
  );
}
export const CONSENT_GRANT_REPLY = "wconsent:granted";
export const CONSENT_DENY_REPLY = "wconsent:revoked";
/**
 * After a protocol is opened, asks once per conversation whether the customer
 * accepts protocol notifications. Only where notifications are enabled, since
 * the answer has no other use. Idempotent for the same protocol.
 */
export async function offerProtocolConsent(
  env: Env,
  c: Conversation,
  cfg: any,
  ticketId: string,
) {
  if (
    cfg.protocol_consent_prompt === false ||
    !cfg.notifications?.enabled ||
    c.chat_type === "group" ||
    !c.connection_id ||
    // Só a pergunta de protocolo: consentimentos de módulos não contam.
    (await one(
      env,
      "SELECT id FROM consents WHERE conversation_id=? AND purpose IN ('protocol','*') LIMIT 1",
      c.id,
    ))
  )
    return;
  const line = await cachedOne(
    env,
    "SELECT kind FROM connections WHERE id=?",
    c.connection_id,
  );
  const question =
    "Você autoriza receber notificações sobre seu protocolo pelo WhatsApp?";
  const revoke = "Para revogar depois, envie REVOGAR.";
  const id = "offer:" + ticketId;
  await exec(
    env,
    "INSERT OR IGNORE INTO consents(id,profile_id,conversation_id,status,evidence,created) VALUES(?,?,?,?,?,?)",
    id,
    c.profile_id,
    c.id,
    "pending",
    JSON.stringify({ actor: "system", ticket_id: ticketId }),
    now(),
  );
  await enqueue(
    env,
    c,
    "system",
    "text",
    {
      text: `${question} Responda AUTORIZO ou NÃO AUTORIZO. ${revoke}`,
      automation: "protocols",
      // Reply buttons where the channel has them; the words keep working.
      ...(["meta", "zernio"].includes(line?.kind)
        ? {
            content: {
              type: "interactive",
              interactive: {
                type: "button",
                body: { text: `${question} ${revoke}` },
                action: {
                  buttons: [
                    {
                      type: "reply",
                      reply: { id: CONSENT_GRANT_REPLY, title: "Autorizo" },
                    },
                    {
                      type: "reply",
                      reply: { id: CONSENT_DENY_REPLY, title: "Não autorizo" },
                    },
                  ],
                },
              },
            },
          }
        : {}),
    },
    `consent:${id}`,
  );
}
/** Assunto do protocolo aberto com a equipe ausente quando o motivo da
 * transferência é interno (falha do bot, resposta sem fonte): o resumo escrito
 * pelo bot ou, sem ele, o pedido do cliente. O motivo continua no evento. */
async function requestTitle(env: Env, c: Conversation, request?: string) {
  const text =
    request?.trim() ||
    (
      await one(
        env,
        "SELECT text FROM messages WHERE conversation_id=? AND direction='customer' AND trim(coalesce(text,''))!='' ORDER BY created DESC,rowid DESC LIMIT 1",
        c.id,
      )
    )?.text?.trim() ||
    "";
  if (!text) return null;
  const line = text.replace(/\s+/g, " ");
  return line.length > 120 ? line.slice(0, 117).trimEnd() + "..." : line;
}

/**
 * De onde veio a passagem para humano. "staff" (transferência da equipe) e
 * "module" (ctx.handoff) não passam pelos ganchos onHandoffRequest; as demais
 * são automáticas e passam.
 */
export type HandoffSource =
  | "menu"
  | "keyword"
  | "bot"
  | "bot_error"
  | "attachment"
  | "structured"
  | "system"
  /** Linha em atendimento por pessoa (service.mode "human"), sem bot. */
  | "line"
  | "staff"
  | "module";

/** Algum módulo ligado na área tem gancho onHandoffRequest. */
async function gatedArea(env: Env, profile: string) {
  const gates = handoffGatesList();
  if (!gates.length) return false;
  const states = await moduleStates(env, profile);
  return gates.some(([module]) => states[module]);
}

/**
 * Ganchos dos módulos ligados, na ordem de `modules`: o primeiro que segura
 * a conversa encerra a consulta. Erro num gancho não prende o cliente: a
 * passagem segue e o erro vai para o log.
 */
async function handoffHeld(
  env: Env,
  c: Conversation,
  request: {
    source: HandoffSource;
    reason: string;
    department_id: string | null;
    summary: string | null;
    menu_item_id: string | null;
    row_id: string | null;
  },
) {
  const gates = handoffGatesList();
  if (!gates.length) return null;
  const order = new Map(registeredModules.map((m, i) => [m.id, i]));
  gates.sort(([a], [b]) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
  for (const [module, gate] of gates) {
    try {
      if ((await gate(env, c, request)) === "hold") return module;
    } catch (error) {
      console.error(
        JSON.stringify({
          component: "handoff-gate",
          module,
          error: error instanceof ApiError ? error.code : String(error),
        }),
      );
      // Módulo que vende acesso à equipe (failClosed): o erro segura a
      // conversa e avisa a equipe numa nota interna (revisão B1).
      if (gateFailsClosed(module)) {
        await message(
          env,
          c,
          "note",
          "system",
          `Passagem para a equipe segurada: o módulo ${moduleById(module)?.name || module} não conseguiu decidir (${error instanceof ApiError ? error.message : "erro interno"}). Confira a conversa e transfira se for o caso.`,
        );
        return module;
      }
    }
  }
  return null;
}

/** Dados de uma passagem para humano feita por um módulo (ctx.handoff). */
export interface HandoffMeta {
  module: string;
  summary: string;
  flags: string[];
  at: number;
}

export async function handoff(
  env: Env,
  c: Conversation,
  reason: string,
  departmentId: string | null = null,
  /** Pedido do cliente ou resumo do bot. Informado (mesmo vazio), o motivo é
   * interno e o protocolo de ausência leva o pedido como assunto. */
  request?: string | null,
  /** false when the bot itself failed: sending it back would fail again. */
  botMayContinue = true,
  /**
   * Passagem pedida por um módulo (ctx.handoff): resumo e marcadores que o
   * atendente vê. Sem ela, os de uma passagem anterior são limpos.
   */
  options: {
    meta?: HandoffMeta | null;
    source?: HandoffSource;
    menuItemId?: string | null;
    /** Mensagem da caixa de entrada (ou execução do bot) que pediu. */
    rowId?: string | null;
  } = {},
) {
  const source = options.source || "system";
  // Um módulo pode segurar a passagem automática (Suporte pago: oferece o
  // pagamento antes) e liberar depois por ctx.handoff.
  if (source !== "staff" && source !== "module") {
    const held = await handoffHeld(env, c, {
      source,
      reason,
      department_id: departmentId,
      summary: request ?? null,
      menu_item_id: options.menuItemId ?? null,
      row_id: options.rowId ?? null,
    });
    if (held) {
      await event(env, c.profile_id, "conversation.updated", c.id, {
        state: c.state,
        handoff_held: { module: held, source, reason },
      });
      return;
    }
  }
  const department = await departmentFor(env, c.profile_id, departmentId);
  requireValue(
    !departmentId || department,
    "Setor de atendimento indisponível.",
  );
  const policy = await getNumberPolicy(env, c.connection_id);
  // Already waiting for the same team: a repeated handoff (the customer asks
  // again, the bot fails again) must not repeat the notice. Any other handoff
  // is a new one and the customer has to be told, even in the same session:
  // a person may have answered and returned the conversation to the bot.
  const repeated =
    c.state === "waiting" && (c.department_id || null) === departmentId;
  await batch(env, [
    [
      "UPDATE conversations SET state='waiting',owner=NULL,assigned_bot_id=NULL,department_id=?,menu_active=0,epoch=epoch+1,handoff=?,updated=? WHERE id=?",
      [
        departmentId,
        options.meta ? JSON.stringify(options.meta) : null,
        now(),
        c.id,
      ],
    ],
    [
      `UPDATE tickets SET owner=NULL WHERE conversation_id=? AND ${activeTicketSql()}`,
      [c.id],
    ],
  ]);
  c = await conversation(env, c.id, c.profile_id);
  const present = await presentInDepartment(env, c.profile_id, departmentId);
  const cfg = await settings(env, c.profile_id);
  let reply = department
    ? `Vou encaminhar sua solicitação para o setor ${department.name}.`
    : "Vou encaminhar sua solicitação para nossa equipe.";
  let opened: any = null,
    returned = false;
  if (!present) {
    const absent = department
      ? `O setor ${department.name} está sem atendentes disponíveis.\n`
      : "";
    if (cfg.absence_ticket === false) {
      // Protocol with the team absent is switched off: never claim one exists.
      reply = `${absent}Nossa equipe está ausente no momento. Sua mensagem ficou registrada e responderemos assim que possível.`;
    } else {
      // One active protocol per conversation in this automatic opening. A new
      // protocol gets the configured confirmation; a reused one is only cited.
      const title =
        request === undefined
          ? reason
          : (await requestTitle(env, c, request ?? undefined)) ||
            "Solicitação de atendimento";
      const summary = request?.trim();
      const { ticket, created } = await createTicket(env, c, title, {
        dedupe: true,
        // The bot's full summary when the title had to be shortened.
        ...(summary && summary.replace(/\s+/g, " ") !== title
          ? { description: summary.slice(0, 20000) }
          : {}),
      });
      if (created) opened = ticket;
      else if (summary) {
        // One active protocol per conversation: the new request (the bot's
        // summary or the customer's message) goes into the existing one as
        // an internal note, so the team sees it. The same text is kept once.
        const at = now();
        await batch(env, [
          [
            "INSERT OR IGNORE INTO ticket_updates(id,ticket_id,actor,text,internal,created) VALUES(?,?,?,?,1,?)",
            [
              `request:${ticket.id}:${await sha(summary)}`,
              ticket.id,
              "system",
              `Nova solicitação nesta conversa: ${summary.slice(0, 20000)}`,
              at,
            ],
          ],
          [
            "UPDATE tickets SET updated=? WHERE id=? AND changes()>0",
            [at, ticket.id],
          ],
        ]);
      }
      reply = `${absent}${cfg.absence_instructions}\n${
        created
          ? "\n" + protocolConfirmation(cfg, ticket)
          : `Protocolo: ${ticket.number}. Para acompanhar, envie CONSULTAR PROTOCOLO ou o número completo.`
      }`;
      // "Devolver ao bot": the protocol is the team's record and the
      // conversation leaves the queue, back with the Bot Atendente.
      if (
        cfg.absence_return_to_bot === true &&
        botMayContinue &&
        policy.bots &&
        (await attendantAvailable(env, c, cfg))
      ) {
        await exec(
          env,
          "UPDATE conversations SET state='ai',owner=NULL,assigned_bot_id=NULL,department_id=NULL,handoff=NULL,updated=? WHERE id=? AND epoch=?",
          now(),
          c.id,
          c.epoch,
        );
        c = await conversation(env, c.id, c.profile_id);
        if (c.state === "ai") {
          returned = true;
          reply +=
            "\n\nEnquanto isso, sigo por aqui se precisar de mais alguma coisa.";
        }
      }
    }
  }
  const key = `handoff:${c.id}:${c.session}:${departmentId || "general"}`;
  // Nothing new to say to someone already waiting and already told in this
  // session, unless a protocol was opened just now.
  const told =
    repeated &&
    !opened &&
    !!(await one(
      env,
      "SELECT 1 AS x FROM outbox WHERE substr(dedupe,1,?)=? LIMIT 1",
      key.length,
      key,
    ));
  if (policy.human && policy.service && (policy.menu || policy.bots) && !told) {
    await enqueue(
      env,
      c,
      "system",
      "text",
      { text: reply },
      // One notice per entry into the queue: the epoch was just advanced.
      `${key}:${c.epoch}`,
    );
    if (opened) {
      await offerProtocolConsent(env, c, cfg, opened.id);
      // Team absent: the protocol closes this part of the service, so the
      // customer can rate it now instead of only when a person concludes it.
      if (cfg.absence_survey === true && c.chat_type !== "group")
        await requestSurvey(env, c, `absence-survey:${opened.id}`);
    }
  }
  await event(env, c.profile_id, "conversation.updated", c.id, {
    state: returned ? "ai" : "waiting",
    department_id: returned ? null : departmentId,
    reason,
    ...(returned ? { returned_to_bot: true } : {}),
  });
}

/**
 * Passagem direta para uma pessoa (ctx.handoff com user_id): como a
 * transferência da equipe, a conversa fica com ela em atendimento humano.
 */
export async function handoffToPerson(
  env: Env,
  c: Conversation,
  userId: string,
  reason: string,
  meta: HandoffMeta | null,
) {
  const target = await one(
    env,
    "SELECT id,role,profiles FROM users WHERE id=? AND disabled=0",
    userId,
  );
  requireValue(
    target &&
      (target.role === "admin" ||
        json(target.profiles, []).includes(c.profile_id)),
    "Atendente não autorizado.",
  );
  await assertDepartmentAccess(
    env,
    {
      id: target.id,
      kind: "user",
      name: "",
      role: target.role,
      profiles: json(target.profiles, []),
      scopes: [],
      bots: [],
      rate: 0,
      runLimit: 0,
    },
    c,
  );
  await exec(
    env,
    "UPDATE conversations SET owner=?,state='human',assigned_bot_id=NULL,menu_active=0,epoch=epoch+1,handoff=?,updated=? WHERE id=?",
    target.id,
    meta ? JSON.stringify(meta) : null,
    now(),
    c.id,
  );
  await clearTicketPrompt(env, c.id);
  c = await conversation(env, c.id, c.profile_id);
  const policy = await getNumberPolicy(env, c.connection_id);
  if (policy.human && policy.service && (policy.menu || policy.bots))
    await enqueue(
      env,
      c,
      "system",
      "text",
      { text: "Vou encaminhar sua solicitação para nossa equipe." },
      `handoff:${c.id}:${c.session}:person:${c.epoch}`,
    );
  await event(env, c.profile_id, "conversation.updated", c.id, {
    state: "human",
    owner: target.id,
    reason,
  });
}

/** The line's attendant bot can take the conversation back right now. */
async function attendantAvailable(env: Env, c: Conversation, cfg: any) {
  if (c.chat_type === "group") return false;
  const line = await serviceForLine(env, c.connection_id);
  if (line.mode === "human") return false;
  const botId = line.mode === "bot" ? line.bot_id : cfg.attendant_bot;
  return (
    !!botId && (await botAllowsLine(env, botId, c.profile_id, c.connection_id))
  );
}
/**
 * Telefone em dígitos e, no Brasil, também com e sem o 9 do celular: o
 * WhatsApp às vezes identifica o mesmo número das duas formas.
 * A busca por variantes só recebe prova do canal ou pedido autorizado da equipe.
 */
export function phoneVariants(phone: unknown) {
  const variants = typeof phone === "string" ? customerPhoneVariants(phone, customerPhoneInputMode(phone)) : [];
  requireValue(variants.length, "Telefone inválido: use DDI, DDD e número (ex.: 5511999990000).");
  return variants;
}

/**
 * Conversa individual da área com o telefone (a de contato mais recente).
 * Com `open`, abre uma na linha oficial (Zernio) quando não existe, para o
 * cliente que nunca escreveu: ela nasce sem janela de 24 h, então só
 * notificações por modelo saem até o cliente responder.
 */
export async function conversationByPhone(
  env: Env,
  profile: string,
  phone: unknown,
  options: {
    open?: boolean;
    connectionId?: string | null;
    module?: string | null;
  } = {},
): Promise<Conversation | null> {
  requireValue(normalizeCustomerPhone(phone, "international"), "Telefone inválido: use DDI, DDD e número.");
  const digits = phoneVariants(phone)[0];
  const variants = JSON.stringify(customerPhoneVariants(digits, "international", true));
  const found = await one<Conversation>(
    env,
    `SELECT c.* FROM conversations c
      WHERE c.profile_id=? AND c.chat_type='direct'
        AND c.customer_link_state NOT IN ('blocked','excluded','ambiguous')
        AND c.phone IN (SELECT value FROM json_each(?))
        AND (c.last_customer=0 OR c.customer_identity_proof IS NOT NULL OR EXISTS
          (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.profile_id=c.profile_id
           AND m.direction='customer' AND instr(m.author,'customer:'||c.external_namespace||':')=1))
        AND c.connection_id IS NOT NULL AND c.external_namespace='channel:'||c.connection_id${options.connectionId ? " AND c.connection_id=?" : ""}
      ORDER BY c.last_customer DESC,c.updated DESC LIMIT 1`,
    profile,
    variants,
    ...(options.connectionId ? [options.connectionId] : []),
  );
  if (found || !options.open) return found;
  // Em empate de milissegundo, preservar a ordem de cadastro das linhas;
  // o UUID não representa antiguidade e pode escolher a segunda conexão.
  const line = await one(
    env,
    options.connectionId
      ? "SELECT * FROM connections WHERE id=? AND profile_id=? AND status='active'"
      : "SELECT * FROM connections WHERE profile_id=? AND status='active' AND kind='zernio' ORDER BY created,rowid LIMIT 1",
    ...(options.connectionId ? [options.connectionId, profile] : [profile]),
  );
  requireValue(
    line,
    "Nenhuma linha oficial ativa nesta área para abrir a conversa.",
  );
  requireValue(
    line.kind === "zernio",
    "Conversa nova pelo telefone só em linha oficial (Zernio), que envia modelos aprovados.",
  );
  const namespace = `channel:${line.id}`;
  const id = uid();
  const created = await exec(
    env,
    "INSERT OR IGNORE INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,session,last_customer,created,updated) VALUES(?,?,?,?,?,?,?,0,?,?)",
    id,
    profile,
    line.id,
    namespace,
    digits,
    digits,
    uid(),
    now(),
    now(),
  );
  const c = await one<Conversation>(
    env,
    "SELECT * FROM conversations WHERE profile_id=? AND external_namespace=? AND external_id=?",
    profile,
    namespace,
    digits,
  );
  // Uma colisão com conversa bloqueada/ambígua não contorna a resolução.
  // Legado que já recebeu mensagem exige origem autenticada no mesmo canal.
  if (!created.meta?.changes && c &&
      (c.chat_type !== "direct" || c.connection_id !== line.id ||
       ["blocked", "excluded", "ambiguous"].includes(c.customer_link_state || "pending"))) return null;
  if (!created.meta?.changes && c && c.last_customer > 0) {
    const received = await one(env, `SELECT 1 FROM messages WHERE conversation_id=? AND profile_id=? AND direction='customer'
      AND instr(author,?)=1 LIMIT 1`, c.id, profile, `customer:${namespace}:`);
    if (!received) return null;
  }
  if (created.meta?.changes)
    await event(env, profile, "conversation.created", id, {
      id,
      external_id: digits,
      opened_by: options.module ? `module:${options.module}` : "system",
    });
  return c;
}

export async function inbound(
  env: Env,
  profile: string,
  data: any,
  namespace: string,
  connectionId: string | null,
) {
  env = withReadCache(env);
  requireValue(
    typeof data.external_id === "string" && data.external_id.length <= 200,
    "Informe o identificador externo.",
  );
  requireValue(
    typeof data.message_id === "string" && data.message_id.length <= 250,
    "Informe message_id.",
  );
  requireValue(
    typeof data.text === "string" && data.text.length <= 20000,
    "Texto inválido.",
  );
  const attachments = await mediaIds(env, profile, data.attachments || []);
  if (namespace.startsWith("app:")) {
    const appId = namespace.slice(4);
    for (const id of attachments)
      requireValue(
        (await one(env, "SELECT actor FROM media WHERE id=?", id))?.actor ===
          appId,
        "Anexo não pertence a esta aplicação.",
      );
  }
  const content =
    data.content && typeof data.content === "object" ? { ...data.content } : {};
  delete content.customerSession;
  const isGroup = data.chat_type === "group" || data.external_id.endsWith("@g.us");
  const key = `${profile}:${namespace}:${data.external_id}:${data.message_id}`;
  const receivedAt = now();
  const customerAt =
    connectionId && Object.prototype.hasOwnProperty.call(data, "customer_at")
      ? Number.isFinite(data.customer_at) &&
        data.customer_at > 0 &&
        data.customer_at <= receivedAt + 300000
        ? Math.min(receivedAt, data.customer_at)
        : 0
      : receivedAt;
  const old = await one(
    env,
    "SELECT conversation_id FROM inbox WHERE event_key=?",
    key,
  );
  if (old) return { conversation_id: old.conversation_id, duplicate: true };
  const channel = connectionId ? await inboundConnection(env, connectionId) : null;
  requireValue(
    !connectionId || (channel?.profile_id === profile && namespace === `channel:${connectionId}` &&
      ["qr", "zernio", "meta"].includes(channel.kind)),
    "Origem do canal inválida.",
  );
  // Entradas legadas sem conexão podem manter uma conversa e associação humana.
  // Sem canal autenticado, prepareInbound não lhes concede prova telefônica.
  // Compatibilidade do transporte anterior: QR já normalizado (somente dígitos)
  // e Meta identificavam o remetente no external_id. JIDs/LIDs nunca passam por
  // esse caminho; os conectores atuais enviam phone explicitamente, inclusive null.
  const legacyPhone = normalizeCustomerPhone(data.external_id, "international");
  const qrLegacy = channel?.kind === "qr" && data.phone_jid === undefined &&
    /^[1-9][0-9]{7,14}$/.test(data.external_id) &&
    (data.phone === undefined || data.phone === legacyPhone);
  const evidence: InboundEvidence = {
    provider: channel?.kind === "qr" ? "qr" : channel?.kind === "meta" ? "meta" : "zernio",
    phone: connectionId && !isGroup ? data.phone ?? (data.phone === undefined && (qrLegacy || channel?.kind === "meta") ? legacyPhone : null) : null,
    ...(channel?.kind === "qr" ? { phoneJid: data.phone_jid ?? (qrLegacy ? `${legacyPhone}@s.whatsapp.net` : data.external_id) } : {}),
  };
  const authenticatedPhone = connectionId && !isGroup ? evidencePhone(evidence) : null;
  if (isGroup) {
    requireValue(
      !!connectionId && namespace.startsWith("channel:"),
      "Grupos precisam de um canal autenticado.",
    );
    requireValue(
      typeof content.participant === "string" && content.participant.length > 0,
      "Informe o participante do grupo.",
    );
    await syncGroup(env, channel, {
      external_id: data.external_id,
      title: data.title,
    });
  }
  // Afinidade e ID exato têm precedência. O fallback só usa encaminhamento
  // persistido do canal; dois destinos equivalentes exigem revisão.
  const routePhones = JSON.stringify(authenticatedPhone ? customerPhoneVariants(authenticatedPhone, "international", true) : []);
  const phoneIdentifier = !!normalizeCustomerPhone(data.external_id, "international") || !!data.external_id.match(/^[0-9]+(?::[0-9]+)?@s\.whatsapp\.net$/);
  let c = await one<Conversation & { inbound_match: number; route_count?: number }>(env,
    `WITH candidates AS (
       SELECT conversation_id id,0 priority FROM router_affinities WHERE connection_id=? AND recipient=?
       UNION ALL SELECT id,1 FROM conversations WHERE profile_id=? AND external_namespace=? AND external_id=?
       UNION ALL SELECT id,2 FROM conversations
         WHERE profile_id=? AND connection_id=? AND external_namespace=? AND chat_type='direct'
           AND customer_link_state NOT IN ('blocked','excluded','ambiguous')
           AND phone IN (SELECT value FROM json_each(?))
           AND (last_customer=0 OR external_id IN (SELECT value FROM json_each(?)) OR ?=1)
           AND (last_customer=0 OR customer_identity_proof IS NOT NULL OR EXISTS
             (SELECT 1 FROM messages m WHERE m.conversation_id=conversations.id AND m.profile_id=conversations.profile_id
               AND m.direction='customer' AND instr(m.author,'customer:'||conversations.external_namespace||':')=1))
     ) SELECT c.*,k.priority inbound_match,
       (SELECT count(DISTINCT id) FROM candidates WHERE priority=2) route_count FROM candidates k
       JOIN conversations c ON c.id=k.id AND c.profile_id=?
       ORDER BY k.priority,c.created DESC LIMIT 1`,
    isGroup ? null : connectionId, data.external_id, profile, namespace, data.external_id,
    profile, connectionId, namespace, routePhones, routePhones, phoneIdentifier ? 1 : 0, profile);
  if (c?.inbound_match === 2 && (c.route_count || 0) > 1)
    throw new ApiError(409, "customer_phone_ambiguous", "Há mais de uma conversa para este telefone. Revise o vínculo.");
  requireValue(
    !c?.connection_id || !!connectionId,
    "Mensagens de cliente em um canal real devem chegar pelo webhook autenticado.",
  );
  // Primeira resposta de quem recebeu uma conversa aberta pelo telefone
  // (conversationByPhone) com outro identificador do WhatsApp: a mesma
  // conversa passa a usar o identificador do canal.
  const createdConversation = !c;
  if (!c) {
    const id = uid();
    // A sessão nasce na época 1 uma única vez. O avanço da mensagem fica
    // no lote da inbox: repetir após uma queda não avança a criação de novo.
    c = await one<Conversation & { inbound_match: number }>(
      env,
      "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,epoch,session,last_customer,created,updated) VALUES(?,?,?,?,?,?,1,?,?,?,?) RETURNING *,1 AS inbound_match",
      id,
      profile,
      connectionId,
      namespace,
      data.external_id,
      authenticatedPhone,
      uid(),
      0,
      now(),
      now(),
    );
  }
  requireValue(c, "Conversa não encontrada.");
  const ratingReply =
    /^[1-5](?:\s|$)/.test(data.text) &&
    (await one(
      env,
      "SELECT id FROM surveys WHERE conversation_id=? AND status='pending' AND created>?",
      c.id,
      now() - 86400000,
    ));
  const previous = c;
  const reopened = c.state === "closed" && !ratingReply;
  const changedPhone = !!authenticatedPhone && !!c.verified_phone &&
    !customerPhoneVariants(authenticatedPhone, "international", true).includes(c.verified_phone);
  if (reopened || changedPhone) c = { ...c, session: uid(),
    ...(reopened ? { state: "ai", owner: null, epoch: c.epoch + 1 } : {}),
    customer_link_state: c.customer_link_state === "ready" ? "pending" : c.customer_link_state };
  if (c.inbound_match === 2 && c.last_customer === 0) c = { ...c, external_id: data.external_id };
  const line = lineService(json(channel?.config));
  // Only the message that opens a session on a human line queues it; the
  // engine uses this to offer the main menu once (front door without a bot).
  const humanFrontDoor =
    line.mode === "human" && c.state === "ai" && !c.assigned_bot_id;
  // Com um módulo que segura passagens (Suporte pago), a linha não põe na
  // fila direto: o motor passa a mensagem pelo menu e pelos fluxos dos
  // módulos e, se for para a equipe, pelo portão com a origem "line"
  // (revisão M2).
  const lineGate = humanFrontDoor && (await gatedArea(env, profile));
  const queuedByLine = humanFrontDoor && !lineGate;
  if (queuedByLine) c = { ...c, state: "waiting", owner: null, epoch: c.epoch + 1 };
  const advanceEpoch =
    c.state === "ai" &&
    (c.chat_type !== "group" ||
      c.bot_policy === "all" ||
      (c.bot_policy === "mentions" &&
        (content.mentioned || /^\/bot(?:\s|$)/i.test(data.text))));
  // A época da mensagem é confirmada junto com a inbox; uma queda antes
  // do lote não cancela entregas da época anterior sem salvar a entrada.
  if (advanceEpoch) c = { ...c, epoch: c.epoch + 1 };
  const msgId = uid();
  // A protocol waiting for the customer goes back to analysis when they write.
  const resumed = createdConversation ? [] : (
    await all(
      env,
      "SELECT id FROM tickets WHERE conversation_id=? AND status='waiting_customer'",
      c.id,
    )
  ).map((ticket) => ticket.id as string);
  const identity = await identityPort.prepareInbound(env, { ...c, session: previous.session }, evidence);
  // O plano pode descobrir outro proprietário até com o mesmo telefone.
  if ((identity as typeof identity & { sessionChanged?: boolean }).sessionChanged && c.session === previous.session)
    c = { ...c, session: uid(), epoch: c.epoch + (advanceEpoch ? 0 : 1) };
  content.customerSession = c.session;
  const entryEvents = [
    ...(createdConversation || (previous.last_customer === 0 && previous.epoch === 1)
      ? [{ kind: "conversation.created", id: c.id, payload: { id: c.id, external_id: c.external_id } }] : []),
    ...(queuedByLine ? [{ kind: "conversation.updated", id: c.id, payload: { action: "waiting", state: "waiting" } }] : []),
    { kind: "message.received", id: msgId, payload: { conversation_id: c.id, message_id: msgId, text: data.text, attachments } },
  ];
  const committed = await batch(env, [
    ["UPDATE conversations SET state=?,owner=?,epoch=?,session=?,external_id=?,last_customer=max(last_customer,?),updated=? WHERE id=? AND profile_id=?",
      [c.state, c.owner, c.epoch, c.session, c.external_id, customerAt, receivedAt, c.id, profile]],
    ...identity.statements,
    [
      "INSERT INTO inbox(id,profile_id,event_key,conversation_id,payload,created) VALUES(?,?,?,?,?,?)",
      [
        uid(),
        profile,
        key,
        c.id,
        JSON.stringify({
          ...data,
          content,
          message_record_id: msgId,
          attachments,
          epoch: c.epoch,
          session: c.session,
          ...(queuedByLine ? { queued_by_line: true } : {}),
          ...(lineGate ? { line_gate: true } : {}),
          ...(resumed.length ? { resumed_tickets: resumed } : {}),
        }),
        now(),
      ],
    ],
    ...(resumed.length ? [[
      "UPDATE tickets SET status='in_progress',updated=? WHERE status='waiting_customer' AND id IN (SELECT value FROM json_each(?))",
      [now(), JSON.stringify(resumed)],
    ] as [string, any[]]] : []),
    [
      "INSERT INTO messages(id,profile_id,conversation_id,direction,author,text,attachments,external_id,created,content) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [
        msgId,
        profile,
        c.id,
        "customer",
        `customer:${namespace}:${content.participant || data.external_id}`,
        data.text,
        JSON.stringify(attachments),
        data.message_id,
        now(),
        JSON.stringify(content),
      ],
    ],
    ...entryEvents.map(e => eventStatement(profile, e.kind, e.id, e.payload)),
  ]);
  // Os eventos existem no mesmo commit; assinaturas só recebem publicação
  // depois que identidade, sessão, inbox e mensagem foram confirmadas.
  for (let i = 0; i < entryEvents.length; i++)
    await fanOut(env, profile, entryEvents[i].kind, (committed[committed.length - entryEvents.length + i].results[0] as { id: number }).id);
  for (const ticketId of resumed)
    await ticketResumedEvent(env, profile, ticketId, msgId);
  if (connectionId)
    await applyChannelEvents(env, connectionId, data.message_id);
  return { conversation_id: c.id, message_id: msgId };
}
export async function createRun(
  env: Env,
  actor: Actor,
  profile: string,
  data: any,
  extra: any = {},
) {
  if (extra.conversation_id) {
    // O motor processa a caixa de entrada da própria área: toda conversa
    // dela, inclusive as abertas por aplicação (namespace app:), que a
    // visibilidade de aplicação esconderia.
    const c = await conversation(
      env,
      extra.conversation_id,
      profile,
      isEngineActor(actor) ? undefined : actor,
    );
    if (!(await getNumberPolicy(env, c.connection_id)).bots)
      throw numberPolicyError("bots");
    requireValue(
      // A paused connection fails the run itself, which hands off to the team.
      await botAllowsLine(env, data.bot_id, profile, c.connection_id, false),
      "Este bot não atende esta linha.",
    );
  }
  if (extra.source_key) {
    const old = await one(
      env,
      "SELECT id,status FROM bot_runs WHERE source_key=?",
      extra.source_key,
    );
    if (old) return old;
  }
  access(actor, profile, "bots:invoke");
  const bot = await one(
    env,
    "SELECT * FROM bots WHERE id=? AND profile_id=? AND enabled=1",
    data.bot_id,
    profile,
  );
  if (!bot || (actor.kind === "app" && !actor.bots.includes(bot.id)))
    throw new ApiError(403, "bot_not_allowed", "Bot não autorizado.");
  const input = text(data.input, 60000);
  const count = await one(
    env,
    "SELECT count(*) n FROM bot_runs WHERE actor=? AND status IN ('queued','starting','running','cancelling','unknown')",
    actor.id,
  );
  if (count.n >= actor.runLimit)
    throw new ApiError(
      429,
      "run_limit",
      "Limite de execuções simultâneas atingido.",
    );
  const id = uid();
  const inserted = await one(
    env,
    "INSERT INTO bot_runs(id,profile_id,bot_id,actor,conversation_id,epoch,input,phase,context,created,updated,source_key) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM bot_runs WHERE actor=? AND status IN ('queued','starting','running','cancelling','unknown'))<? RETURNING id",
    id,
    profile,
    bot.id,
    actor.id,
    extra.conversation_id || null,
    extra.epoch ?? null,
    input,
    extra.phase || "direct",
    JSON.stringify(extra.context || {}),
    now(),
    now(),
    extra.source_key || null,
    actor.id,
    actor.runLimit,
  );
  if (!inserted)
    throw new ApiError(
      429,
      "run_limit",
      "Limite de execuções simultâneas atingido.",
    );
  return { id, status: "queued" };
}

/** Plano interno: a confirmação roda somente no Coordinator serializado da área. */
export interface SettingsPlan {
  profile: string;
  actor_id: string;
  base_revision: string;
  modules_revision: string;
  settings_revision: string;
  settings: Record<string, any>;
  view: Record<string, any>;
  modules: Record<string, boolean>;
  module_changes: Array<{ id: string; enabled: boolean }>;
  removed_departments: string[];
  keep_department_conversations: boolean;
  queue_changed: boolean;
}
export interface SettingsPlanOptions {
  modules?: Record<string, boolean>;
  expected_revision?: string;
}
/** Revisão da configuração inteira salva, incluindo menus de módulos desligados. */
export async function settingsRevision(env: Env, profile: string): Promise<string> {
  const { row } = await profileWithModules(env, profile);
  return sha(canonical(json(row.settings)));
}
/** Valida sem gravar: PUT /settings e prévia/aplicação de modelos usam este caminho. */
export async function planSettings(
  env: Env, actor: Actor, profile: string, data: Record<string, any>, options: SettingsPlanOptions = {},
): Promise<SettingsPlan> {
  admin(actor);
  const { row, states } = await profileWithModules(env, profile);
  const baseRevision = await sha(canonical(json(row.settings)));
  const expected = options.expected_revision ?? data.settings_revision;
  if (data.os_work_types !== undefined || data.os_vocabulary !== undefined)
    requireValue(typeof expected === "string", "Informe settings_revision para alterar os tipos ou vocabulário.");
  if (expected !== undefined) {
    requireValue(typeof expected === "string" && /^[a-f0-9]{64}$/i.test(expected), "Revisão de configuração inválida.");
    if (expected.toLowerCase() !== baseRevision)
      throw new ApiError(409, "settings_conflict", "A configuração mudou. Atualize antes de salvar.");
  }
  const configuredModules = configuredModuleStates(json(row.module_states));
  const finalModules = options.modules ? planModuleStates(configuredModules, options.modules) : states;
  const previous = { ...defaults, ...json(row.settings) };
  const old = structuredClone(previous);
  const stored = { menus: (json(row.settings).menus || []) as any[], hidden: hiddenMenuTypes(finalModules) };
  if (Array.isArray(old.menus)) old.menus = old.menus.filter((item: any) => !stored.hidden.has(item?.type));
  const { menus_revision, settings_revision, keep_department_conversations, ...changes } = data;
  if (menus_revision !== undefined) {
    requireValue(
      typeof menus_revision === "string" &&
        /^[a-f0-9]{64}$/i.test(menus_revision) &&
        data.menus !== undefined,
      "A revisão dos menus deve acompanhar uma árvore de menus válida.",
    );
    if (
      menus_revision.toLowerCase() !==
      (await sha(JSON.stringify(old.menus || [])))
    )
      throw new ApiError(
        409,
        "menus_changed",
        "Os menus foram alterados por outra pessoa. Atualize a árvore antes de salvar novamente.",
      );
  }
  const next = { ...old, ...changes };
  delete next.menus_revision;
  delete next.settings_revision;
  requireValue(
    typeof next.jev_enabled === "boolean" &&
      typeof next.surveys_enabled === "boolean",
    "JEV e avaliações devem estar ligados ou desligados.",
  );
  validateJevSettings(next);
  requireValue(
    next.absence_return_to_bot === undefined ||
      typeof next.absence_return_to_bot === "boolean",
    "Informe se a conversa volta ao bot com a equipe ausente.",
  );
  requireValue(
    next.absence_survey === undefined ||
      typeof next.absence_survey === "boolean",
    "Informe se a avaliação é pedida depois do protocolo de ausência.",
  );
  if (data.notifications !== undefined) {
    const n = data.notifications;
    requireValue(
      n &&
        typeof n === "object" &&
        typeof n.enabled === "boolean" &&
        typeof (n.template_name ?? "") === "string" &&
        String(n.template_name ?? "").length <= 512 &&
        typeof (n.language ?? "pt_BR") === "string" &&
        /^[a-z]{2,3}(_[A-Z]{2})?$/.test(n.language ?? "pt_BR"),
      "Notificações de protocolo: informe se estão ligadas, o nome do modelo e o idioma (ex.: pt_BR).",
    );
    requireValue(
      !n.enabled || String(n.template_name || "").trim(),
      "Para ligar as notificações de protocolo, informe o nome do modelo aprovado no WhatsApp.",
    );
    next.notifications = {
      enabled: n.enabled,
      template_name: String(n.template_name || "").trim(),
      language: n.language || "pt_BR",
    };
  }
  if (next.departments === undefined) next.departments = [];
  if (data.departments !== undefined)
    await validateDepartments(env, profile, next.departments);
  // Setores excluídos: recusa enquanto um item de menu os usa; as conversas
  // abertas deles voltam para a fila geral depois de salvar.
  const removedDepartments = (old.departments || [])
    .map((d: any) => d.id)
    .filter((id: string) => !next.departments.some((d: any) => d.id === id));
  if (removedDepartments.length) {
    const users = (Array.isArray(next.menus) ? next.menus : []).filter(
      (item: any) =>
        item?.type === "human" &&
        removedDepartments.includes(item.department_id),
    );
    if (users.length)
      throw new ApiError(
        409,
        "department_in_use",
        `Antes de excluir o setor, troque-o ${users.length > 1 ? "nos itens" : "no item"} de menu ${users.map((item: any) => `"${item.label}"`).join(", ")}.`,
      );
  }
  // Service-center fields. A partial business_hours keeps the saved parts.
  next.ticket_categories = validateTicketCategories(
    next.ticket_categories ?? [],
  );
  requireValue(
    responseUnits.includes(next.protocol_response_unit),
    "Unidade do prazo inválida: use hours ou business_days.",
  );
  requireValue(
    validResponseDays(next.protocol_response_days),
    "Informe o prazo em dias úteis, de 1 a 60.",
  );
  if (data.business_hours !== undefined) {
    requireValue(
      data.business_hours &&
        typeof data.business_hours === "object" &&
        !Array.isArray(data.business_hours),
      "Horário de atendimento inválido.",
    );
    next.business_hours = validateBusinessHours({
      ...businessHours(old.business_hours),
      ...data.business_hours,
    });
  } else next.business_hours = businessHours(old.business_hours);
  requireValue(
    typeof next.protocol_confirmation === "string" &&
      next.protocol_confirmation.length <= 1500,
    "A confirmação do protocolo deve ter até 1500 caracteres.",
  );
  if (!next.protocol_confirmation.trim())
    next.protocol_confirmation = defaultProtocolConfirmation;
  // Fits the 1024-character body of a WhatsApp interactive message together
  // with the "Escolha uma opção abaixo." line added on send.
  next.menu_greeting = next.menu_greeting ?? "";
  requireValue(
    typeof next.menu_greeting === "string" &&
      Array.from(next.menu_greeting).length <= 900,
    "A saudação do menu deve ter até 900 caracteres.",
  );
  next.menu_greeting = next.menu_greeting.trim();
  if (data.queue !== undefined)
    next.queue = validateQueueSettings(
      {
        ...(old.queue || {}),
        ...data.queue,
      },
      old.queue,
    );
  if (data.establishment !== undefined)
    next.establishment = validateEstablishment(data.establishment);
  // Chaves declaradas pelos módulos (src/modules, onSettingsSave). Objeto
  // parcial mescla com o que está salvo, como queue e business_hours: os
  // campos que não vieram ficam como estavam. Listas e valores simples
  // substituem.
  const plain = (v: unknown) =>
    !!v && typeof v === "object" && !Array.isArray(v);
  for (const key of Object.keys(data)) {
    const validate = settingsValidator(key);
    if (validate)
      next[key] = validate(
        plain(data[key]) && plain(old[key])
          ? { ...old[key], ...data[key] }
          : data[key],
      );
  }
  requireValue(
    JSON.stringify(next).length <= 150000,
    "Configuração muito grande.",
  );
  for (const [key, max] of [
    ["menus", 200],
    ["apps", 100],
    ["capabilities", 50],
  ] as const) {
    requireValue(
      Array.isArray(next[key]) && next[key].length <= max,
      `Lista ${key} inválida ou acima do limite.`,
    );
    const ids = next[key].map((item: any) => item?.id);
    requireValue(
      ids.every(
        (id: any) =>
          typeof id === "string" && id.length > 0 && id.length <= 100,
      ) && new Set(ids).size === ids.length,
      `Identificadores de ${key} inválidos ou repetidos.`,
    );
  }
  for (const item of next.apps) {
    text(item.name, 100);
    item.url = publicUrl(item.url);
    if (item.review_url) item.review_url = publicUrl(item.review_url);
  }
  if (data.menus !== undefined)
    next.menus = next.menus.map((item: any) => {
      requireValue(
        item.parent_id === undefined ||
          item.parent_id === null ||
          (typeof item.parent_id === "string" &&
            item.parent_id.length <= 100),
        "Menu pai inválido.",
      );
      return {
        ...item,
        label: text(item.label, 100),
        parent_id: item.parent_id || null,
      };
    });
  for (const item of next.menus) {
    text(item.label, 100);
    if (item.enabled !== undefined)
      requireValue(
        typeof item.enabled === "boolean",
        "Ativação de menu inválida.",
      );
    if (item.line_ids !== undefined)
      await validateLineIds(env, profile, item.line_ids);
    if (item.trigger !== undefined)
      requireValue(
        ["automatic", "manual"].includes(item.trigger),
        "Modo de menu inválido.",
      );
    requireValue(
      [
        "human",
        "app",
        "submenu",
        "bot",
        "link",
        "content",
        "protocols",
        "survey",
        "ticket",
        ...moduleMenuTypes(),
      ].includes(item.type),
      "Destino de menu inválido.",
    );
    // Itens de módulos desligados só existem guardados (veja abaixo).
    if (stored.hidden.has(item.type))
      throw new ApiError(
        409,
        "module_disabled",
        `O destino "${item.label}" pertence ao módulo ${moduleForMenuType(item.type)?.name}, que está desligado. Ligue-o em Gestão → Módulos.`,
      );
    // Item de módulo que aponta para um registro da configuração
    // (form_id → forms): o registro precisa existir.
    const reference = moduleForMenuType(item.type)?.menu_item_types.find(
      (t) => t.type === item.type,
    )?.reference;
    if (reference) {
      const id = item[reference.field] === undefined ? reference.default_id : item[reference.field];
      const builtin = reference.builtins?.some((entry) => entry.id === id);
      const entry = Array.isArray(next[reference.setting])
        ? next[reference.setting].find((entry: any) => entry?.id === id) : null;
      requireValue(builtin || entry,
        `${reference.label} do menu "${item.label}" não encontrado. Escolha outro ou cadastre-o antes.`);
      requireValue(!(item.type === "os_open" && item.enabled !== false && entry?.archived),
        "Tipo de trabalho arquivado não aceita menu ativo de abertura.");
    }
    if (item.type === "queue" && item.queue_id)
      requireValue(
        await one(
          env,
          "SELECT id FROM queues WHERE id=? AND profile_id=?",
          item.queue_id,
          profile,
        ),
        "Fila do menu não encontrada.",
      );
    if (item.type === "ticket") {
      if (item.category_id)
        requireValue(
          next.ticket_categories.some((c: any) => c.id === item.category_id),
          "Categoria do menu não encontrada.",
        );
      if (item.content) text(item.content, 3500);
    }
    if (item.type === "human" && item.department_id)
      requireValue(
        next.departments.some((d: any) => d.id === item.department_id),
        "Setor do menu não encontrado.",
      );
    if (item.type === "link") {
      item.url = publicUrl(item.url);
      if (item.content) text(item.content, 3000);
    }
    if (item.type === "content") text(item.content, 3500);
    if (item.type === "survey" && item.question) text(item.question, 300);
    if (item.type === "app")
      requireValue(
        next.apps.some((a: any) => a.id === item.app_id),
        "Aplicativo do menu não encontrado.",
      );
    if (item.type === "bot")
      await requireToolBot(env, profile, item.bot_id, "menu");
    const visited = new Set([item.id]);
    let parent = item.parent_id;
    while (parent) {
      requireValue(!visited.has(parent), "O menu contém um ciclo.");
      visited.add(parent);
      const ancestor = next.menus.find((m: any) => m.id === parent);
      requireValue(
        ancestor?.type === "submenu",
        "Menu pai precisa ser um submenu.",
      );
      parent = ancestor.parent_id;
    }
  }
  // Telegram was removed: its settings are dropped whenever settings are saved.
  delete next.reply_mode;
  delete next.telegram_connection;
  delete next.telegram_group;
  requireValue(
    next.protocol_response_hours === null ||
      (Number.isFinite(Number(next.protocol_response_hours)) &&
        Number(next.protocol_response_hours) > 0 &&
        Number(next.protocol_response_hours) <= 8760),
    "Prazo inválido.",
  );
  if (next.attendant_bot)
    requireValue(
      await one(
        env,
        "SELECT id FROM bots WHERE id=? AND profile_id=?",
        next.attendant_bot,
        profile,
      ),
      "Atendente não pertence à área de atendimento.",
    );
  for (const action of next.capabilities || []) {
    // A 0092 guardou ações antigas desligadas para escolher um substituto.
    // Só essa referência já guardada pode permanecer; novos destinos são IA.
    const keptDisabled = action.enabled === false && old.capabilities?.some(
      (previous: any) => previous.id === action.id &&
        previous.bot_id === action.bot_id && previous.enabled === false,
    );
    if (!keptDisabled) await requireToolBot(env, profile, action.bot_id, "specialist");
  }
  // Itens de módulos desligados não aparecem em `old` nem no editor: ficam
  // guardados como estavam e voltam quando o módulo é religado. Um item cujo
  // submenu foi excluído enquanto isso sobe para o menu principal.
  const kept = stored.menus
    .filter(
      (item) =>
        stored.hidden.has(item?.type) &&
        !next.menus.some((m: any) => m.id === item.id),
    )
    .map((item) => ({
      ...item,
      parent_id: next.menus.some(
        (m: any) => m.id === item.parent_id && m.type === "submenu",
      )
        ? item.parent_id
        : null,
    }));

  const saved = kept.length ? { ...next, menus: [...next.menus, ...kept] } : next;
  // Inclui os itens preservados no limite agregado e na comparação de revisões.
  requireValue(JSON.stringify(saved).length <= 150000, "Configuração muito grande.");
  validateSettingsChange(structuredClone(previous), structuredClone(saved), {
    changed_keys: Object.keys(changes), modules: finalModules,
  });
  return {
    profile, actor_id: actor.id, base_revision: baseRevision,
    modules_revision: await sha(canonical(json(row.module_states))),
    settings_revision: await sha(canonical(saved)), settings: saved, view: next,
    modules: finalModules,
    module_changes: Object.keys(options.modules || {}).filter((id) => finalModules[id] !== configuredModules[id])
      .map((id) => ({ id, enabled: finalModules[id] })),
    removed_departments: removedDepartments,
    keep_department_conversations: keep_department_conversations === true,
    queue_changed: data.queue !== undefined || data.establishment !== undefined,
  };
}
/**
 * Confirma configuração, módulos e SQL de procedência de A no MESMO lote D1.
 * Só chamar dentro de um comando do Coordinator, após recalcular o preview_hash.
 * Não reutilizar planos de outra invocação. Eventos/cache vêm após o lote.
 */
export async function commitSettingsPlan(
  env: Env, actor: Actor, plan: SettingsPlan, provenance: [string, any[]][] = [],
  recovery?: { id: string; result: unknown },
): Promise<Record<string, any>> {
  admin(actor);
  requireValue(actor.id === plan.actor_id, "Plano de outro ator.");
  // Leitura sem cache: detecta plano antigo mesmo dentro de um env cacheado.
  const row = await one(env, PROFILE_SETTINGS_SQL, plan.profile);
  if (!row || await sha(canonical(json(row.settings))) !== plan.base_revision ||
      await sha(canonical(json(row.module_states))) !== plan.modules_revision)
    throw new ApiError(409, "settings_conflict", "A configuração ou os módulos mudaram. Refaça o plano.");
  const statements: [string, any[]][] = [[
    "UPDATE profiles SET settings=? WHERE id=?", [JSON.stringify(plan.settings), plan.profile],
  ]];
  if (plan.module_changes.length) statements.push([
    "INSERT OR IGNORE INTO profile_erp_parts_managed(profile_id) VALUES(?)", [plan.profile],
  ]);
  for (const change of plan.module_changes) statements.push([
    "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,?,?,?) ON CONFLICT(profile_id,module_id) DO UPDATE SET enabled=excluded.enabled,updated=excluded.updated,updated_by=excluded.updated_by",
    [plan.profile, change.id, change.enabled ? 1 : 0, now(), actor.id],
  ]);
  if (plan.removed_departments.length && !plan.keep_department_conversations) statements.push([
    `UPDATE conversations SET department_id=NULL,updated=? WHERE profile_id=? AND state!='closed' AND department_id IN (${plan.removed_departments.map(() => "?").join(",")})`,
    [now(), plan.profile, ...plan.removed_departments],
  ]);
  const publications = plan.module_changes.map(change => ({ kind: "module.changed", id: change.id, payload: {
    module_id: change.id, enabled: change.enabled, version: moduleById(change.id)!.version, actor: actor.id,
  } as Record<string, unknown> }));
  if (plan.queue_changed) publications.push({ kind: "queue.changed", id: plan.profile, payload: { settings: true } });
  if (recovery) statements.push([
    "INSERT INTO os_area_template_receipts(profile_id,operation_id,actor,result_json,events_json) VALUES(?,?,?,?,?)",
    [plan.profile, recovery.id, actor.id, JSON.stringify(recovery.result), JSON.stringify(publications)],
  ]);
  await batch(env, [...statements, ...provenance]);
  if (recovery) await recoverSettingsApplication(env, actor, plan.profile, recovery.id);
  else for (const publication of publications) await event(env, plan.profile, publication.kind, publication.id, publication.payload);
  return { ...plan.view, settings_revision: plan.settings_revision, erp_sync: await (async () => {
    // Mudanças de chaves ERP geram revisão pelos gatilhos D1. Configurações
    // comuns só precisam de entrega quando uma revisão anterior ficou pendente.
    const revision = await one(env, "SELECT CAST(revision AS TEXT) revision, CAST(delivered_revision AS TEXT) delivered_revision FROM profile_erp_revision WHERE profile_id=?", plan.profile);
    return revision && revision.revision !== revision.delivered_revision
      ? await syncErpParts(env, plan.profile)
      : { revision: revision?.revision ?? "0", delivered_revision: revision?.delivered_revision ?? "0", status: "applied" as const };
  })() };
}

/** Recupera antes de conferir a prévia, que já mudou pela própria aplicação. */
export async function recoverSettingsApplication(env: Env, actor: Actor, profile: string, operationId: string) {
  admin(actor);
  const receipt = await one(env, "SELECT * FROM os_area_template_receipts WHERE profile_id=? AND operation_id=? AND actor=?", profile, operationId, actor.id);
  if (!receipt) return null;
  if (!receipt.published) {
    const publications = json(receipt.events_json, []);
    for (const [i, publication] of publications.entries())
      await event(env, profile, publication.kind, publication.id, publication.payload, `area-template:${profile}:${operationId}:${i}`);
    await exec(env, "UPDATE os_area_template_receipts SET published=1 WHERE profile_id=? AND operation_id=?", profile, operationId);
  }
  return json(receipt.result_json);
}

export async function perform(
  env: Env,
  actor: Actor,
  profile: string,
  op: string,
  data: any,
  requestId: string,
): Promise<any> {
  refuseEngineActor(actor);
  env = withReadCache(env);
  // Operações de um módulo desligado na área: 409 module_disabled.
  await requireOperation(env, profile, op);
  // Acesso por pessoa (src/access.ts): atendente sem o item, 403.
  requireOperationAccess(actor, op);
  // Cobrança feita por pessoa: com a política do segundo fator (src/mfa.ts).
  if (op.startsWith("payment.")) requireFinancialAal(actor);
  if (op.startsWith("contact.") && op !== "contact.maintain")
    return contactCommand(env, actor, profile, op, data, requestId);
  // Comandos registrados pelos módulos (src/modules/api.ts, onCommand).
  const fromModule = moduleCommandHandler(op);
  if (fromModule) return fromModule(env, actor, profile, data, requestId);
  if (op === "line.save") return saveLine(env, actor, profile, data);
  if (op === "service-template.apply")
    return applyServiceTemplate(env, actor, profile, data, requestId);
  if (op.startsWith("internal."))
    return internalCommand(env, actor, profile, op, data, requestId);
  if (op === "zernio-account.resolve")
    return resolveZernioProfile(env, actor, profile, data);
  if (op.startsWith("zernio-account.") || op.startsWith("zernio-number."))
    return zernioAccountCommand(env, actor, profile, op, data);
  if (op.startsWith("meta-account.") || op.startsWith("meta-number."))
    throw new ApiError(
      410,
      "meta_removed",
      "A integração direta Meta foi substituída pela Zernio.",
    );
  if (op === "connection.delete")
    return removeConnection(env, actor, profile, data.id);
  if (op === "integration.delete")
    return removeIntegration(env, actor, profile, data.id);
  if (op.startsWith("router."))
    return routerCommand(env, actor, profile, op, data, requestId);
  if (op.startsWith("upload."))
    return uploadCommand(env, actor, profile, op, data);
  if (op.startsWith("call."))
    return callCommand(env, actor, profile, op, data, requestId);
  if (op.startsWith("group."))
    return groupCommand(env, actor, profile, op, data, requestId);
  if (op === "message.action")
    return messageAction(env, actor, profile, data, requestId);
  if (op.startsWith("queue.") || op.startsWith("counter."))
    return queueCommand(env, actor, profile, op, data, requestId);
  if (op.startsWith("module."))
    return moduleCommand(env, actor, profile, op, data);
  if (op === "web_step.cancel")
    return cancelWebStep(env, actor, profile, data.id);
  if (op.startsWith("system.")) {
    admin(actor);
    const maintenance = await import("./maintenance");
    return maintenance.maintenanceCommand(env, actor, op, data);
  }
  if (
    op.startsWith("connection.") &&
    [
      "connection.test",
      "connection.connector-token",
    ].includes(op)
  ) {
    admin(actor);
    if (op === "connection.test")
      return probe(env, data.id, profile, data.origin);
    const conn = await one(
      env,
      "SELECT id FROM connections WHERE id=? AND profile_id=? AND kind='qr'",
      data.id,
      profile,
    );
    requireValue(conn, "Conector não encontrado.");
    const token = random();
    await setSecret(env, `connection:${conn.id}`, {
      ...(await secret(env, `connection:${conn.id}`)),
      connector_hash: await sha(token),
    });
    return { token, connection_id: conn.id };
  }
  if (op === "jev") {
    admin(actor);
    requireValue(
      typeof data.key === "string" && data.key,
      "Informe a chave JEV.",
    );
    await setSecret(env, `jev:${profile}`, { key: data.key });
    return { saved: true };
  }
  if (op === "media.register") {
    access(actor, profile, "media:write");
    const id = data.id;
    requireValue(
      id && data.object_key.startsWith(profile + "/"),
      "Arquivo inválido.",
    );
    await exec(
      env,
      "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
      id,
      profile,
      data.name,
      data.type,
      data.size,
      data.object_key,
      actor.id,
      now(),
    );
    return { id, name: data.name, size: data.size };
  }
  if (op === "profile.create") {
    admin(actor);
    const id = uid();
    await exec(
      env,
      "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
      id,
      text(data.name, 100),
      JSON.stringify(defaults),
      now(),
    );
    return { id };
  }
  if (op === "user.create" || op === "user.invite") {
    admin(actor);
    requireValue(["admin", "operator"].includes(data.role), "Papel inválido.");
    requireValue(
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email || ""),
      "E-mail inválido.",
    );
    const id = uid();
    const userAccess =
      data.access === undefined ? null : validateAccess(data.access);
    const schedule =
      data.schedule === undefined ? null : validateSchedule(data.schedule);
    const email = text(data.email, 200).toLowerCase();
    requireValue(
      !(await one(env, "SELECT id FROM users WHERE email=?", email)),
      "Já existe uma pessoa com este e-mail.",
    );
    // Convite: a pessoa entra sem senha (nenhuma senha confere) e cria a
    // dela pelo link de 72 h (src/auth-tokens.ts).
    const invite = op === "user.invite";
    await exec(
      env,
      "INSERT INTO users(id,email,name,password,role,profiles,access,schedule,created) VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      email,
      text(data.name, 100),
      invite ? "" : passwordHash(data.password),
      data.role,
      JSON.stringify(data.profiles || []),
      userAccess && JSON.stringify(userAccess),
      schedule && JSON.stringify(schedule),
      now(),
    );
    if (!invite) return { id };
    const link = await issueAccountLink(env, {
      userId: id,
      purpose: "invite",
      createdBy: actor.id,
    });
    // Com `send_email`, o convite vai também por e-mail (src/email.ts); a
    // falha não desfaz o convite, e o link segue na resposta.
    return {
      id,
      ...link,
      ...(data.send_email === true
        ? await mailAccountLink(
            env,
            { id, name: text(data.name, 100), email },
            "invite",
            link,
          )
        : {}),
    };
  }
  if (op === "user.update") {
    admin(actor);
    const u = await one(env, "SELECT * FROM users WHERE id=?", data.id);
    requireValue(u, "Usuário não encontrado.");
    requireValue(
      data.id !== actor.id || !data.disabled,
      "Você não pode desativar sua própria conta.",
    );
    // access: lista (src/access.ts) ou null (atendente completo); ausente,
    // fica como estava.
    const userAccess =
      data.access === undefined
        ? (u.access ?? null)
        : (() => {
            const list = validateAccess(data.access);
            return list && JSON.stringify(list);
          })();
    // schedule: horário de acesso (src/mfa.ts) ou null (sem horário).
    const schedule =
      data.schedule === undefined
        ? (u.schedule ?? null)
        : (() => {
            const value = validateSchedule(data.schedule);
            return value && JSON.stringify(value);
          })();
    await exec(
      env,
      "UPDATE users SET name=?,profiles=?,disabled=?,access=?,schedule=? WHERE id=?",
      data.name ? text(data.name, 100) : u.name,
      JSON.stringify(data.profiles ?? json(u.profiles, [])),
      data.disabled === undefined ? u.disabled : Number(!!data.disabled),
      userAccess,
      schedule,
      data.id,
    );
    if (data.password)
      await exec(
        env,
        "UPDATE users SET password=? WHERE id=?",
        passwordHash(data.password),
        data.id,
      );
    await exec(env, "DELETE FROM sessions WHERE user_id=?", data.id);
    // Senha trocada pelo administrador: a pessoa recebe o alerta.
    if (data.password) await alertAccount(env, data.id, "password_changed");
    return { id: data.id };
  }
  if (op === "application.create") {
    admin(actor);
    rejectInternalScopes(data.scopes);
    requireValue(
      Array.isArray(data.scopes) &&
        data.scopes.every((s: string) => scopes.includes(s)),
      "Permissões inválidas.",
    );
    requireValue(
      Array.isArray(data.profiles) && data.profiles.length > 0,
      "Informe a área de atendimento.",
    );
    const erpRole = appErpRoleInput(data.erp_role);
    const id = uid();
    await exec(
      env,
      "INSERT INTO applications(id,name,profiles,scopes,bots,rate,run_limit,erp_role,created) VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      text(data.name, 100),
      JSON.stringify(data.profiles),
      JSON.stringify(data.scopes),
      JSON.stringify(data.bots || []),
      Math.min(600, Math.max(1, Number(data.rate) || 60)),
      Math.min(10, Math.max(1, Number(data.run_limit) || 3)),
      erpRole ?? null,
      now(),
    );
    if (erpRole)
      await audit(
        env,
        actor,
        profile,
        `application.erp_role:${erpRole}`,
        id,
        requestId,
      );
    return { id };
  }
  if (op === "application.update") {
    admin(actor);
    rejectInternalScopes(data.scopes);
    const old = await one(
      env,
      "SELECT * FROM applications WHERE id=?",
      data.id,
    );
    requireValue(old, "Aplicação não encontrada.");
    requireValue(
      !data.scopes ||
        (Array.isArray(data.scopes) &&
          data.scopes.every((s: string) => scopes.includes(s))),
      "Permissões inválidas.",
    );
    if (
      Array.isArray(data.scopes) &&
      data.scopes.includes("billing:write") &&
      (await one(
        env,
        "SELECT 1 FROM pairing_requests WHERE app_id=? AND client IN ('vinki','fagoo') LIMIT 1",
        data.id,
      ))
    )
      throw new ApiError(
        409,
        "scope_not_allowed",
        "billing:write não pode ser concedida a aparelhos pareados do Vinki.",
      );
    // Papel do ERP: só muda se veio no pedido (null tira o papel).
    const erpRole =
      data.erp_role === undefined
        ? (old.erp_role ?? null)
        : (appErpRoleInput(data.erp_role) ?? null);
    await exec(
      env,
      "UPDATE applications SET disabled=?,profiles=?,scopes=?,bots=?,erp_role=? WHERE id=?",
      data.disabled === undefined ? old.disabled : Number(!!data.disabled),
      JSON.stringify(data.profiles ?? json(old.profiles, [])),
      JSON.stringify(data.scopes ?? json(old.scopes, []).filter((s: string) => !["conversations:bound", "conversations:all"].includes(s))),
      JSON.stringify(data.bots ?? json(old.bots, [])),
      erpRole,
      data.id,
    );
    // Troca de papel do ERP na auditoria do núcleo, com o papel novo.
    if (erpRole !== (old.erp_role ?? null))
      await audit(
        env,
        actor,
        profile,
        `application.erp_role:${erpRole ?? "nenhum"}`,
        data.id,
        requestId,
      );
    return { id: data.id };
  }
  if (op === "key.create") {
    admin(actor);
    rejectInternalScopes(data.scopes);
    requireValue(
      await one(env, "SELECT id FROM applications WHERE id=?", data.app_id),
      "Aplicação não encontrada.",
    );
    const token = `wab_${random()}`,
      id = uid(),
      expires =
        now() + Math.min(365, Math.max(1, Number(data.days) || 90)) * 86400000;
    await exec(
      env,
      "INSERT INTO api_keys(id,app_id,hash,prefix,expires,created) VALUES(?,?,?,?,?,?)",
      id,
      data.app_id,
      await sha(token),
      token.slice(0, 12),
      expires,
      now(),
    );
    return { id, token, expires };
  }
  if (op === "key.revoke") {
    admin(actor);
    await exec(env, "UPDATE api_keys SET revoked=1 WHERE id=?", data.id);
    return { revoked: true };
  }
  if (op === "settings") {
    const plan = await planSettings(env, actor, profile, data);
    return commitSettingsPlan(env, actor, plan);
  }
  if (op === "activate" || op === "pause") {
    admin(actor);
    if (op === "activate") {
      const cfg = await settings(env, profile);
      const configuredLine = await one(
        env,
        "SELECT id FROM connections WHERE profile_id=? AND kind IN ('zernio','qr') AND json_extract(config,'$.service.mode') IN ('human','bot') LIMIT 1",
        profile,
      );
      // A menu-only area is valid: without a bot the main menu answers the
      // first message (see the front door in the engine).
      const automaticMenu = (cfg.menus || []).some(
        (item: any) =>
          !item.parent_id &&
          item.enabled !== false &&
          item.trigger !== "manual",
      );
      requireValue(
        cfg.attendant_bot || configuredLine || automaticMenu,
        "Selecione o Bot Atendente da área de atendimento, configure o atendimento por linha ou cadastre um menu automático.",
      );
    }
    await exec(
      env,
      "UPDATE profiles SET enabled=? WHERE id=?",
      op === "activate" ? 1 : 0,
      profile,
    );
    if (op === "pause")
      await exec(
        env,
        "UPDATE conversations SET epoch=epoch+1 WHERE profile_id=? AND state='ai'",
        profile,
      );
    return { enabled: op === "activate" };
  }
  if (op === "connection.save") {
    admin(actor);
    if (data.kind === "telegram") throw telegramRemoved();
    const existing = data.id ? await one(env, "SELECT * FROM connections WHERE id=? AND profile_id=?", data.id, profile) : null;
    await requireCurrentConnection(env, existing || { kind: data.kind });
    requireValue(
      ["zernio", "qr", "ai"].includes(data.kind),
      "Conector inválido.",
    );
    const id = data.id || uid();
    const old = await one(env, "SELECT * FROM connections WHERE id=?", id);
    requireValue(
      !old || old.profile_id === profile,
      "Conexão de outra área de atendimento.",
    );
    if (old) {
      requireValue(
        old.kind === data.kind,
        "Exclua a conexão anterior e cadastre uma nova para trocar o provedor.",
      );
      const pending = await one(
        env,
        "SELECT id FROM outbox WHERE connection_id=? AND status IN ('pending','sending','unknown') LIMIT 1",
        id,
      );
      requireValue(
        old.status === "paused" && !pending,
        "Pause e reconcilie as entregas antes de alterar a conexão.",
      );
    }
    let cfg = data.config || {};
    requireValue(
      cfg.remove_pending === undefined,
      "A marca de remoção da conexão é interna e não pode ser definida pela API.",
    );
    if (data.kind === "ai") {
      // Provedor de IA direto: só provedor, modelo, endereço e opções; a chave
      // vai para o cofre. Editar exige testar de novo.
      cfg = aiConfig(cfg);
      const previous = await secret(env, `connection:${id}`);
      const key = data.secrets?.api_key || previous.api_key;
      aiKey(key);
      const extra = Object.keys(data.secrets || {}).filter(
        (k) => k !== "api_key",
      );
      requireValue(!extra.length, "A conexão de IA guarda só a chave de API.");
    }
    if (old) {
      const previous = json(old.config);
      // Credential editors omit line assignments. Those are edited through line.save.
      cfg.service = previous.service;
      cfg.number_policy = previous.number_policy;
      cfg.bot_options = previous.bot_options;
    }
    const managed =
      old &&
      (await one(
        env,
        "SELECT connection_id FROM meta_numbers WHERE connection_id=?",
        id,
      ));
    if (managed) {
      const previous = json(old.config);
      requireValue(
        data.kind === "zernio" &&
          cfg.account_id === previous.account_id &&
          cfg.number === previous.number,
        "O número do roteador não pode mudar de identidade ou de modo.",
      );
      cfg.zernio_workspace_id = previous.zernio_workspace_id;
      cfg.zernio_profile_id = previous.zernio_profile_id;
      // Editing connection credentials must not reset per-number restrictions.
      cfg.number_policy = previous.number_policy;
      requireValue(
        !data.secrets?.api_key && !data.secrets?.webhook_secret,
        "Edite as credenciais na integração Zernio do roteador.",
      );
    }
    if (cfg.url) cfg.url = publicUrl(cfg.url);
    if (cfg.api_url) cfg.api_url = publicUrl(cfg.api_url);
    if (["qr", "zernio"].includes(data.kind))
      requireValue(
        /^\d{8,16}$/.test(cfg.number || ""),
        "Informe o número completo com DDI, somente dígitos.",
      );
    if (data.kind === "zernio") {
      requireValue(
        /^[a-f0-9]{24}$/i.test(cfg.account_id || "") &&
          /^[a-f0-9]{24}$/i.test(cfg.zernio_profile_id || ""),
        "Informe o ID do telefone e o ID da integração na Zernio (24 caracteres).",
      );
      requireValue(
        !cfg.zernio_workspace_id || managed,
        "Cadastre números gerenciados pelo roteador.",
      );
      if (old)
        requireValue(
          cfg.account_id === json(old.config).account_id &&
            cfg.zernio_profile_id === json(old.config).zernio_profile_id &&
            cfg.number === json(old.config).number,
          "Exclua e cadastre novamente para trocar a identidade do telefone.",
        );
      const duplicate = await one(
        env,
        "SELECT id FROM connections WHERE kind='zernio' AND json_extract(config,'$.account_id')=? AND id!=?",
        cfg.account_id,
        id,
      );
      requireValue(!duplicate, "Este número já está cadastrado.");
      if (!managed) {
        const previous = await secret(env, `connection:${id}`);
        for (const key of ["api_key", "webhook_secret"]) {
          const value = data.secrets?.[key] || previous[key];
          requireValue(
            typeof value === "string" &&
              value.length > 0 &&
              value.length <= 4096 &&
              !/[\r\n]/.test(value),
            "Preencha a chave API e o segredo do webhook Zernio.",
          );
        }
      }
      delete cfg.verified_at;
    }
    await exec(
      env,
      "INSERT INTO connections(id,profile_id,name,kind,mode,config,created) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,config=excluded.config,kind=excluded.kind,mode=excluded.mode",
      id,
      profile,
      text(data.name, 100),
      data.kind,
      data.mode || "direct",
      JSON.stringify(cfg),
      now(),
    );
    if (data.secrets) {
      const previous = await secret(env, `connection:${id}`);
      const supplied = { ...data.secrets };
      if (data.kind === "ai") {
        if (supplied.api_key) supplied.api_key = aiKey(supplied.api_key);
        else delete supplied.api_key;
      }
      if (data.kind === "zernio") {
        for (const key of ["api_key", "webhook_secret"])
          if (!supplied[key]) delete supplied[key];
      }
      await setSecret(env, `connection:${id}`, {
        ...previous,
        ...supplied,
      });
    }
    return { id, status: "paused" };
  }
  if (op === "connection.state") {
    admin(actor);
    const row = await one(
      env,
      "SELECT * FROM connections WHERE id=? AND profile_id=?",
      data.id,
      profile,
    );
    requireValue(row, "Conexão não encontrada.");
    requireValue(
      ["active", "paused"].includes(data.status),
      "Estado inválido.",
    );
    if (data.status === "active") {
      await requireCurrentConnection(env, row);
      if (row.kind === "meta")
        throw new ApiError(
          410,
          "meta_removed",
          "Conecte este telefone pela Zernio. A integração direta Meta foi removida.",
        );
      requireValue(
        json(row.config).verified_at,
        "Teste a conexão antes de ativar.",
      );
      const number = json(row.config).number;
      if (number) {
        const other = await one(
          env,
          "SELECT id FROM connections WHERE id!=? AND json_extract(config,'$.number')=? AND (status='active' OR EXISTS(SELECT 1 FROM outbox o WHERE o.connection_id=connections.id AND o.status IN ('pending','sending','unknown')))",
          row.id,
          number,
        );
        requireValue(
          !other,
          "Pause o outro modo deste número e reconcilie todas as entregas antes de ativar.",
        );
      }
    }
    await exec(
      env,
      "UPDATE connections SET status=? WHERE id=?",
      data.status,
      row.id,
    );
    return { id: row.id, status: data.status };
  }
  if (op === "bot.update") {
    admin(actor);
    const bot = await one(
      env,
      "SELECT * FROM bots WHERE id=? AND profile_id=?",
      data.id,
      profile,
    );
    requireValue(bot, "Bot não encontrado.");
    if (data.mask_personal !== undefined)
      requireValue(typeof data.mask_personal === "boolean", "Máscara de dados pessoais inválida.");
    for (const option of ["pdf_raw_fallback", "image_to_team"])
      if (data[option] !== undefined)
        requireValue(typeof data[option] === "boolean", `Opção ${option} inválida: informe um booleano.`);
    if (data.line_ids !== undefined)
      await validateLineIds(env, profile, data.line_ids, true);
    if (data.name !== undefined) {
      requireValue(
        typeof data.name === "string" &&
          data.name.trim().length > 0 &&
          data.name.trim().length <= 80,
        "Informe o nome do bot, com até 80 caracteres.",
      );
      data.name = data.name.trim();
    }
    const enabled = data.enabled === undefined ? !!bot.enabled : !!data.enabled;
    if (enabled) {
      const keys = await secret(env, `connection:${bot.connection_id}`),
        conn = await one(
          env,
          "SELECT kind,config FROM connections WHERE id=?",
          bot.connection_id,
        );
      if (conn) await requireCurrentConnection(env, { ...conn, id: bot.connection_id });
      if (!bot.enabled && conn?.kind === "ai")
        requireValue(
          keys.api_key && json(conn.config).verified_at,
          "Teste a conexão com o provedor de IA antes de habilitar o bot.",
        );
    }
    const statements: [string, any[]][] = [
      [
        "UPDATE bots SET enabled=?,name=coalesce(?,name),line_ids=? WHERE id=?",
        [
          enabled ? 1 : 0,
          data.name || null,
          data.line_ids === undefined
            ? bot.line_ids
            : data.line_ids === null
              ? null
              : JSON.stringify(data.line_ids),
          data.id,
        ],
      ],
    ];
    // O nome local também fica na configuração, junto dos demais dados do bot.
    // O lote mantém as duas cópias em sincronia e preserva os outros nomes.
    if (data.name !== undefined)
      statements.push([
        "UPDATE connections SET config=json_set(config,'$.bot_names',json_patch(coalesce(json_extract(config,'$.bot_names'),'{}'),json(?))) WHERE id=?",
        [JSON.stringify({ [bot.remote_profile]: data.name }), bot.connection_id],
      ]);
    const personalOptions = Object.fromEntries(
      ["mask_personal", "pdf_raw_fallback", "image_to_team"]
        .filter((key) => data[key] !== undefined)
        .map((key) => [key, data[key]]),
    );
    if (Object.keys(personalOptions).length)
      statements.push([
        "UPDATE connections SET config=json_set(config,'$.bot_options',json_patch(coalesce(json_extract(config,'$.bot_options'),'{}'),json(?))) WHERE id=?",
        [JSON.stringify({ [bot.remote_profile]: personalOptions }), bot.connection_id],
      ]);
    await batch(env, statements);
    return { id: data.id };
  }
  if (op === "inbound") {
    access(actor, profile, "conversations:write");
    return inbound(env, profile, data, `app:${actor.id}`, null);
  }
  if (op === "conversation.create") {
    access(actor, profile, "conversations:write");
    return inbound(
      env,
      profile,
      {
        ...data,
        text: data.text || "",
        message_id: data.message_id || requestId,
      },
      `app:${actor.id}`,
      null,
    );
  }
  if (op === "conversation.action") {
    access(actor, profile, "conversations:write");
    let c = await conversation(env, data.id, profile, actor);
    const action = data.action;
    // Ações registradas pelos módulos (src/modules/api.ts).
    const moduleAction =
      typeof action === "string" ? conversationAction(action) : undefined;
    if (moduleAction) return moduleAction(env, actor, c, data, requestId);
    if (
      [
        "claim",
        "reply",
        "transfer",
        "resume",
        "resolve",
        "protocols",
        "survey",
      ].includes(action)
    )
      await assertDepartmentAccess(env, actor, c);
    let eventExtra: Record<string, any> = {};
    const policy = await getNumberPolicy(env, c.connection_id);
    if (action === "protocols" || action === "survey") {
      requireValue(
        c.owner === actor.id ||
          actor.role === "admin" ||
          (actor.id.startsWith("bot:") && c.state === "ai"),
        "Assuma a conversa antes desta ação.",
      );
      if (action === "protocols") {
        access(actor, profile, "tickets:read");
        return sendProtocolLookup(
          env,
          c,
          data.number || undefined,
          `protocols:${actor.id}:${requestId}`,
          actor.id,
        );
      }
      return requestSurvey(env, c, `survey:${actor.id}:${requestId}`, actor.id);
    }
    if (["claim", "reply"].includes(action)) {
      const capability = actor.kind === "app" ? "api" : "human";
      if (!policy[capability]) throw numberPolicyError(capability);
    }
    if (
      action === "transfer" &&
      !(String(data.target).startsWith("bot:") ? policy.bots : policy.human)
    )
      throw numberPolicyError(
        String(data.target).startsWith("bot:") ? "bots" : "human",
      );
    if (action === "resume" && !policy.bots) throw numberPolicyError("bots");
    if (action === "menu") {
      const botActor = actor.id.startsWith("bot:");
      requireValue(
        c.owner === actor.id ||
          actor.role === "admin" ||
          (botActor && c.state === "ai"),
        "Assuma a conversa antes de enviar um menu.",
      );
      return sendMenu(
        env,
        actor,
        c,
        data.menu_id || null,
        `manual-menu:${actor.id}:${requestId}`,
      );
    }
    if (action === "claim") {
      if (c.owner === actor.id && c.state === "human") return c;
      if (c.owner && c.owner !== actor.id)
        throw new ApiError(
          409,
          "already_claimed",
          "Outro atendente assumiu a conversa.",
        );
      await exec(
        env,
        "UPDATE conversations SET state='human',owner=?,assigned_bot_id=NULL,menu_active=0,epoch=epoch+1,updated=? WHERE id=?",
        actor.id,
        now(),
        c.id,
      );
      await exec(
        env,
        `UPDATE tickets SET owner=? WHERE conversation_id=? AND owner IS NULL AND ${activeTicketSql()}`,
        actor.id,
        c.id,
      );
      // A person took over: the automatic "describe your request" step ends.
      await clearTicketPrompt(env, c.id);
    } else if (action === "note") {
      await message(env, c, "note", actor.id, text(data.text));
    } else if (action === "tags") {
      requireValue(
        Array.isArray(data.tags) && data.tags.length <= 20,
        "Etiquetas inválidas.",
      );
      await exec(
        env,
        "UPDATE conversations SET tags=?,updated=? WHERE id=?",
        JSON.stringify(data.tags.map((s: any) => text(s, 40))),
        now(),
        c.id,
      );
    } else {
      if (
        c.owner !== actor.id &&
        !(actor.role === "admin" && action === "transfer")
      )
        throw new ApiError(
          403,
          "not_owner",
          "Assuma a conversa antes desta ação.",
        );
      if (action === "reply") {
        requireValue(
          c.state === "human",
          "A conversa não está em atendimento humano.",
        );
        const content = await outgoingContent(env, actor, c, data);
        const value = String(data.text || "").trim(),
          attachments = await mediaIds(env, profile, data.attachments || []);
        if (c.chat_type === "group") {
          const group = await one(
            env,
            "SELECT * FROM whatsapp_groups WHERE conversation_id=?",
            c.id,
          );
          requireValue(
            !group?.announcement || group.own_admin,
            "Somente administradores podem enviar mensagens neste grupo.",
          );
        }
        const delivery = await enqueue(
          env,
          c,
          actor.id,
          "text",
          { text: value, attachments, content },
          `reply:${actor.id}:${requestId}`,
        );

        await exec(
          env,
          `UPDATE tickets SET first_response_at=coalesce(first_response_at,?),updated=? WHERE conversation_id=? AND ${activeTicketSql()}`,
          now(),
          now(),
          c.id,
        );
        return { delivery_id: delivery, status: "pending" };
      } else if (action === "transfer") {
        if (data.department_id) {
          requireValue(
            !data.target,
            "Escolha uma pessoa, bot ou setor por transferência.",
          );
          await handoff(
            env,
            c,
            "Encaminhado pela equipe.",
            data.department_id,
            undefined,
            true,
            { source: "staff" },
          );
          return conversation(env, c.id, profile, actor);
        }
        const botId = String(data.target || "").startsWith("bot:")
          ? String(data.target).slice(4)
          : null;
        if (botId) {
          requireValue(
            await botAllowsLine(env, botId, profile, c.connection_id),
            "Bot não autorizado para esta linha.",
          );
          if (now() - c.last_customer < 86400000) {
            const history = await all(
              env,
              "SELECT direction,text FROM messages WHERE conversation_id=? AND direction!='note' ORDER BY created DESC,rowid DESC LIMIT 20",
              c.id,
            );
            const request =
              history.find((m) => m.direction === "customer")?.text ||
              "Atendimento encaminhado para você. Leia o histórico e pergunte como pode ajudar.";
            const words = Array.from(
              new Set(
                String(request)
                  .toLowerCase()
                  .match(/[\p{L}\p{N}]{3,}/gu) || [],
              ),
            ).slice(0, 24);
            const sources = await searchKnowledge(env, profile, words);
            const cfg = await settings(env, profile);
            const menus = (
              await availableMenus(env, profile, c.connection_id, null, true)
            ).map((m: any) => ({ id: m.id, label: m.label, type: m.type }));
            await createRun(
              env,
              actor,
              profile,
              {
                bot_id: botId,
                input: JSON.stringify({
                  request,
                  history: history.reverse(),
                  sources,
                  menus,
                  actions: (cfg.capabilities || []).filter(
                    (a: any) => a.enabled !== false,
                  ),
                  categories: (cfg.ticket_categories || [])
                    .filter((item: any) => item.enabled !== false)
                    .map((item: any) => ({ id: item.id, name: item.name })),
                }),
              },
              {
                conversation_id: c.id,
                epoch: c.epoch + 1,
                phase: "attendant",
                context: { request, sources, session: c.session },
                source_key: `transfer:${actor.id}:${requestId}`,
              },
            );
          }
          await exec(
            env,
            "UPDATE conversations SET owner=NULL,state='ai',assigned_bot_id=?,menu_active=0,epoch=epoch+1,updated=? WHERE id=?",
            botId,
            now(),
            c.id,
          );
          eventExtra = { assigned_bot_id: botId, actor: actor.id };
        } else {
          const target = await one(
            env,
            "SELECT * FROM users WHERE id=? AND disabled=0",
            data.target,
          );
          requireValue(
            target &&
              (target.role === "admin" ||
                json(target.profiles, []).includes(profile)),
            "Atendente não autorizado.",
          );
          await assertDepartmentAccess(
            env,
            { ...actor, id: target.id, kind: "user", role: target.role },
            c,
          );
          await exec(
            env,
            "UPDATE conversations SET owner=?,state='human',assigned_bot_id=NULL,menu_active=0,epoch=epoch+1,updated=? WHERE id=?",
            target.id,
            now(),
            c.id,
          );
          eventExtra = { owner: target.id, actor: actor.id };
        }
      } else if (action === "resolve" || action === "resume") {
        await exec(
          env,
          "UPDATE conversations SET state=?,owner=NULL,assigned_bot_id=NULL,menu_active=0,epoch=epoch+1,handoff=NULL,updated=? WHERE id=?",
          action === "resolve" ? "closed" : "ai",
          now(),
          c.id,
        );
        if (
          c.chat_type !== "group" &&
          action === "resolve" &&
          policy.service &&
          (policy.menu || policy.bots) &&
          (await settings(env, profile)).surveys_enabled
        ) {
          const id = uid();
          await exec(
            env,
            "INSERT INTO surveys(id,profile_id,conversation_id,created) VALUES(?,?,?,?)",
            id,
            profile,
            c.id,
            now(),
          );
          c = await conversation(env, c.id, profile);
          await enqueue(
            env,
            c,
            "system",
            "text",
            {
              text: "Como foi seu atendimento? Responda com uma nota de 1 a 5 e, se quiser, um comentário.",
            },
            `survey:${id}`,
          );
        }
      } else throw new ApiError(400, "unknown_action", "Ação inválida.");
    }
    await event(env, profile, "conversation.updated", c.id, {
      action,
      ...eventExtra,
    });
    return await conversation(env, c.id, profile);
  }
  if (op === "presence") {
    access(actor, profile, "presence:write");
    requireValue(
      actor.kind === "user",
      "A presença humana exige uma conta de atendente.",
    );
    requireValue(typeof data.present === "boolean", "Presença inválida.");
    await exec(
      env,
      "INSERT INTO presence(profile_id,actor,present,updated) VALUES(?,?,?,?) ON CONFLICT(profile_id,actor) DO UPDATE SET present=excluded.present,updated=excluded.updated",
      profile,
      actor.id,
      data.present ? 1 : 0,
      now(),
    );
    return { actor: actor.id, present: data.present };
  }
  if (op === "ticket.create") {
    access(actor, profile, "tickets:write");
    const c = await conversation(env, data.conversation_id, profile, actor);
    requireValue(
      c.owner === actor.id || actor.role === "admin",
      "Assuma a conversa antes de abrir o protocolo.",
    );
    // Opened by the team: no automatic confirmation is sent to the customer.
    let category: string | null = null;
    if (data.category !== undefined && data.category !== null) {
      category = enabledCategory(await settings(env, profile), data.category);
      requireValue(category, "Categoria de protocolo desconhecida.");
    }
    return openTicket(env, c, actor.id, text(data.title, 300), false, {
      category,
    });
  }
  if (op === "ticket.update") {
    access(actor, profile, "tickets:write");
    const ticket = await one(
      env,
      "SELECT * FROM tickets WHERE id=? AND profile_id=?",
      data.id,
      profile,
    );
    requireValue(ticket, "Protocolo não encontrado.");
    const ticketConversation = await conversation(
      env,
      ticket.conversation_id,
      profile,
      actor,
    );
    await assertDepartmentAccess(env, actor, ticketConversation);
    requireValue(
      actor.role === "admin" || ticket.owner === actor.id,
      "Somente o responsável pode alterar o protocolo.",
    );
    const status = data.status || ticket.status;
    requireValue(ticketStatuses.includes(status), "Estado inválido.");
    if (data.response_due_at !== undefined)
      requireValue(
        !ticket.first_response_at &&
          isActiveTicket(ticket.status) &&
          (data.response_due_at === null ||
            Number.isFinite(data.response_due_at)),
        "Não é possível alterar este prazo.",
      );
    // Resending the stored value is accepted even after the category was
    // removed from the settings; any other value must be an enabled category.
    const category =
      data.category === undefined ? ticket.category : data.category;
    if (data.category !== undefined && category !== ticket.category)
      requireValue(
        category === null ||
          enabledCategory(await settings(env, profile), category),
        "Categoria de protocolo desconhecida.",
      );
    if (data.owner)
      requireValue(
        await one(
          env,
          "SELECT id FROM users WHERE id=? AND disabled=0 AND (role='admin' OR EXISTS(SELECT 1 FROM json_each(users.profiles) WHERE value=?))",
          data.owner,
          profile,
        ),
        "Responsável inválido.",
      );
    if (data.owner) {
      const owner = await one(
        env,
        "SELECT role FROM users WHERE id=?",
        data.owner,
      );
      await assertDepartmentAccess(
        env,
        { ...actor, id: data.owner, kind: "user", role: owner!.role },
        ticketConversation,
      );
    }
    const publicText = data.text ? text(data.text) : "";
    await exec(
      env,
      "UPDATE tickets SET status=?,owner=?,response_due_at=?,first_response_at=coalesce(first_response_at,?),category=?,updated=? WHERE id=?",
      status,
      data.owner ?? ticket.owner,
      data.response_due_at !== undefined
        ? data.response_due_at
        : ticket.response_due_at,
      publicText ? now() : null,
      category ?? null,
      now(),
      ticket.id,
    );
    if (publicText) {
      await exec(
        env,
        "INSERT INTO ticket_updates(id,ticket_id,actor,text,created) VALUES(?,?,?,?,?)",
        uid(),
        ticket.id,
        actor.id,
        publicText,
        now(),
      );
      const c = await conversation(env, ticket.conversation_id, profile);
      await enqueue(
        env,
        c,
        actor.id,
        "notification",
        {
          text: `Protocolo ${ticket.number}: ${publicText}`,
          ticket_id: ticket.id,
        },
        `ticket:${requestId}`,
      );
    }
    await event(env, profile, "ticket.updated", ticket.id, {
      status,
      previous_status: ticket.status,
      owner: data.owner ?? ticket.owner,
      previous_owner: ticket.owner,
      text_added: !!publicText,
      actor: actor.id,
      number: ticket.number,
      ...(data.category !== undefined
        ? { category: category ?? null, previous_category: ticket.category }
        : {}),
    });
    return await one(env, "SELECT * FROM tickets WHERE id=?", ticket.id);
  }
  if (op === "consent.request") {
    access(actor, profile, "conversations:write");
    const c = await conversation(env, data.conversation_id, profile);
    requireValue(
      c.chat_type !== "group",
      "Consentimento individual não pode ser solicitado em grupo.",
    );
    requireValue(c.owner === actor.id, "Assuma a conversa.");
    const id = uid();
    await exec(
      env,
      "INSERT INTO consents(id,profile_id,conversation_id,status,evidence,created) VALUES(?,?,?,?,?,?)",
      id,
      profile,
      c.id,
      "pending",
      JSON.stringify({ actor: actor.id }),
      now(),
    );
    await enqueue(
      env,
      c,
      actor.id,
      "text",
      {
        text: "Você autoriza notificações sobre seu protocolo pelo WhatsApp? Responda AUTORIZO ou NÃO AUTORIZO. Para revogar depois, envie REVOGAR.",
      },
      `consent:${id}`,
    );
    return { id };
  }
  if (op === "run.create")
    return (
      (await askBotInChat(env, actor, profile, data, requestId)) ||
      createRun(env, actor, profile, data)
    );
  if (op === "run.cancel") {
    access(actor, profile, "bots:invoke");
    const run = await one(
      env,
      "SELECT * FROM bot_runs WHERE id=? AND profile_id=?",
      data.id,
      profile,
    );
    requireValue(
      run &&
        ((actor.kind !== "app" && !json(run.context).internal_chat_id) ||
          run.actor === actor.id),
      "Execução não encontrada.",
    );
    await exec(
      env,
      "UPDATE bot_runs SET status=CASE WHEN remote_id IS NULL THEN 'cancelled' ELSE 'cancelling' END,updated=? WHERE id=? AND status IN ('queued','running','starting')",
      now(),
      data.id,
    );
    return { id: data.id, status: "cancelling" };
  }
  if (op === "knowledge.create") {
    access(actor, profile, "knowledge:write");
    const id = uid();
    requireValue(
      ["text", "url", "file", "youtube"].includes(data.kind),
      "Tipo de fonte inválido.",
    );
    if (data.url) data.url = publicUrl(data.url);
    if (data.media_id)
      await authorizedMedia(env, actor, profile, data.media_id);
    await exec(
      env,
      "INSERT INTO documents(id,profile_id,title,kind,url,media_id,created) VALUES(?,?,?,?,?,?,?)",
      id,
      profile,
      text(data.title, 200),
      data.kind,
      data.url || null,
      data.media_id || null,
      now(),
    );
    if (data.usage !== undefined && data.usage !== null && data.usage !== "")
      await exec(
        env,
        "UPDATE documents SET usage=? WHERE id=?",
        text(data.usage, 2000),
        id,
      );
    if (data.kind === "text") {
      await batch(env, chunkWrites(profile, id, text(data.text, 500000)));
      await exec(env, "UPDATE documents SET status='ready' WHERE id=?", id);
    }
    return { id };
  }
  if (op === "knowledge.update") {
    access(actor, profile, "knowledge:write");
    const doc = await one(
      env,
      "SELECT * FROM documents WHERE id=? AND profile_id=?",
      data.id,
      profile,
    );
    requireValue(doc, "Fonte não encontrada.");
    const usage =
      data.usage === undefined
        ? doc.usage
        : String(data.usage ?? "").trim()
          ? text(data.usage, 2000)
          : null;
    const writes: [string, any[]][] = [
      [
        "UPDATE documents SET title=?,usage=? WHERE id=?",
        [
          data.title === undefined ? doc.title : text(data.title, 200),
          usage,
          doc.id,
        ],
      ],
    ];
    if (doc.kind === "text" && data.text !== undefined)
      // New content replaces every passage of the source at once.
      writes.push(
        [
          "DELETE FROM chunks WHERE document_id=? AND profile_id=?",
          [doc.id, profile],
        ],
        ...chunkWrites(profile, doc.id, text(data.text, 500000)),
        ["UPDATE documents SET status='ready',error=NULL WHERE id=?", [doc.id]],
      );
    else if (
      ["url", "youtube"].includes(doc.kind) &&
      data.url !== undefined &&
      publicUrl(data.url) !== doc.url
    )
      // A new address is imported again by the scheduled import.
      writes.push(
        [
          "DELETE FROM chunks WHERE document_id=? AND profile_id=?",
          [doc.id, profile],
        ],
        [
          "UPDATE documents SET url=?,status='pending',error=NULL WHERE id=?",
          [publicUrl(data.url), doc.id],
        ],
      );
    await batch(env, writes);
    return { id: doc.id };
  }
  if (op === "knowledge.delete") {
    access(actor, profile, "knowledge:write");
    await batch(env, [
      [
        "DELETE FROM chunks WHERE document_id=? AND profile_id=?",
        [data.id, profile],
      ],
      ["DELETE FROM documents WHERE id=? AND profile_id=?", [data.id, profile]],
    ]);
    return { deleted: true };
  }
  if (op === "webhook.create") {
    access(actor, profile, "webhooks:manage");
    requireValue(actor.kind === "app" || data.app_id, "Selecione a aplicação.");
    const appId = actor.kind === "app" ? actor.id.slice(4) : data.app_id;
    const app = await one(
      env,
      "SELECT * FROM applications WHERE id=? AND disabled=0",
      appId,
    );
    requireValue(
      app && json(app.profiles, []).includes(profile),
      "Aplicação não autorizada nesta área de atendimento.",
    );
    requireValue(
      Array.isArray(data.events) &&
        data.events.length > 0 &&
        data.events.every((e: string) => eventTypes.includes(e)),
      "Eventos inválidos.",
    );
    const id = uid(),
      signingSecret = random();
    await exec(
      env,
      "INSERT INTO webhook_subscriptions(id,app_id,profile_id,url,events,created) VALUES(?,?,?,?,?,?)",
      id,
      appId,
      profile,
      publicUrl(data.url),
      JSON.stringify(data.events),
      now(),
    );
    await setSecret(env, `webhook:${id}`, { secret: signingSecret });
    return { id, signing_secret: signingSecret };
  }
  if (op === "webhook.disable") {
    access(actor, profile, "webhooks:manage");
    await exec(
      env,
      "UPDATE webhook_subscriptions SET enabled=0 WHERE id=? AND profile_id=? AND (?=1 OR app_id=?)",
      data.id,
      profile,
      actor.role === "admin" ? 1 : 0,
      actor.id.slice(4),
    );
    return { disabled: true };
  }
  if (op === "webhook.retry") {
    access(actor, profile, "webhooks:manage");
    const delivery = await one(
      env,
      "SELECT d.id FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE d.id=? AND s.profile_id=? AND (?=1 OR s.app_id=?)",
      data.id,
      profile,
      actor.role === "admin" ? 1 : 0,
      actor.id.slice(4),
    );
    requireValue(delivery, "Entrega não encontrada.");
    await exec(
      env,
      "UPDATE webhook_deliveries SET status='pending',attempts=0,next_at=? WHERE id=?",
      now(),
      data.id,
    );
    return { queued: true };
  }
  if (op === "delivery.reconcile") {
    admin(actor);
    requireValue(
      ["sent", "pending", "cancelled"].includes(data.status),
      "Resultado inválido.",
    );
    if (data.status === "pending") {
      const old = await one(
        env,
        "SELECT * FROM outbox WHERE id=? AND profile_id=? AND status IN ('unknown','failed')",
        data.id,
        profile,
      );
      requireValue(old, "Entrega não encontrada ou já reconciliada.");
      requireValue(
        !json(old.payload).template_message || data.allow_paid === true,
        "Reenviar um modelo exige nova autorização explícita de cobrança (allow_paid: true).",
      );
      const c = await conversation(env, old.conversation_id, profile);
      const id = await enqueue(
        env,
        c,
        old.actor,
        old.kind,
        {
          ...json(old.payload),
          ...(json(old.payload).template_message
            ? { retry_authorization: { actor: actor.id, authorized_at: now() } }
            : {}),
        },
        "manual-retry:" + requestId,
      );
      await exec(
        env,
        "UPDATE outbox SET status='cancelled',updated=? WHERE id=?",
        now(),
        old.id,
      );
      return { id, status: "pending" };
    }
    await exec(
      env,
      "UPDATE outbox SET status=?,updated=? WHERE id=? AND profile_id=? AND status='unknown'",
      data.status,
      now(),
      data.id,
      profile,
    );
    return { status: data.status };
  }
  throw new ApiError(404, "not_found", "Operação não encontrada.");
}
