// Interface interna para os módulos (contrato em docs/MODULOS.md). Uma vertical
// fala com o núcleo só por aqui: contato, enviar mensagem, abrir passo web,
// publicar evento e os ganchos de menu, ação de conversa, configuração e
// conclusão de passo web. Mudanças aqui exigem atualizar docs/MODULOS.md.
import { localModuleWake } from "./local-wake";
import {
  registerApprovalHook,
  moduleRoutes,
  registerCommand,
  registerConversationAction,
  registerCredentialHook,
  registerHandoffGate,
  registerInboundHandler,
  registerMenuHandler,
  registerPaymentHook,
  registerReadRoute,
  registerMcpTool,
  registerSchedule,
  registerTelemetryRoute,
  credentialGate,
  type CredentialRouteOptions,
  registerTurnHandler,
  type ModuleMcpTool,
  registerSettingsValidator,
  registerWebStepHook,
  registerWebStepPage,
  registerWebStepValidator,
  registerWriteRoute,
  type ModuleWriteRoute,
  registerBinaryRoute,
  registerSettingsChangeValidator,
  type SettingsChangeValidator,
  type BinaryRouteRequest,
} from "./hooks";
import { binaryCommand, binaryResponse, readBinaryContent, type BinaryCommand, type BinaryContent } from "./binary";
import type { TrackView } from "../web-track";
import { all, exec, one } from "../db";
import {
  ApiError,
  type Actor,
  type Conversation,
  type Env,
  now,
  requireValue,
} from "../types";
import { isBound } from "../visibility";
import { access, admin, canProfile, refuseEngineActor, sha } from "../security";
import { grantId } from "../module-grants";
import { rolesOf } from "../access";
import {
  credentialsFor,
  issueClaim,
  revokeCredentials as revokeModuleCredentials,
  type CredentialView,
} from "../module-credentials";
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
  perform,
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
  requestApproval,
  type ApprovalDecision,
  type ApprovalRequest,
} from "../approvals";
export type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalField,
} from "../approvals";
import {
  CONSENT_PURPOSES,
  consentFor,
  purposeLabels,
  recordConsent,
  type ConsentPurpose,
  type ConsentRecord,
} from "../consents";
import {
  areaEmailCount,
  EMAIL_AREA_DAILY,
  sendEmail,
  type EmailMessage,
} from "../email";
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
  moduleForOperation,
  moduleForRoute,
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

export interface InboundAttachment {
  id: string;
  name: string;
  mime_type: string;
  byte_length: number;
  /** Abre só o objeto já vinculado à mensagem/conversa conferidas. */
  open(): Promise<R2ObjectBody>;
}
export interface OutgoingAttachment {
  name: string;
  mime_type: string;
  byte_length: number;
  body: ReadableStream<Uint8Array>;
  /** Derivar de documento + versão; não aceitar chave ou URL arbitrária do cliente. */
  key: string;
  client_visible: boolean;
  sensitive: boolean;
}
export type WebStep = NonNullable<ReturnType<typeof webStepView>>;
export type { InteractiveSpec } from "../whatsapp-interactive";
export type { Establishment } from "../establishment";
export type { ConsentPurpose, ConsentRecord } from "../consents";
export type WebStepRequest = Omit<OpenWebStepInput, "conversation" | "module">;

export type SensitiveKind = "contacts" | "notes";
/** Campos fora das leituras do bot pela conversa (ctx.botView). */
export const BOT_HIDDEN = new Set([
  "document",
  "document_display",
  "payer_document",
  "email",
  "phones",
  "phone",
  "customer_phone",
  "checkin_answers",
  "checkin_step_id",
  "address",
  "address_text",
  "notes",
  "created_by",
]);
/**
 * Pessoas da equipe sempre; aplicação só com `<kind>:read`. Leitura que o
 * bot da conversa interna faz pela pessoa (actor.via) e que vai ao modelo de
 * IA: mascarada, a menos que o administrador libere na instalação.
 */
export const mayRead = (actor: Actor, kind: SensitiveKind) =>
  actor.via?.masked
    ? false
    : actor.kind !== "app" || actor.scopes.includes(`${kind}:read`);

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
   * Leitura pela conversa para bot ou integração (ferramentas MCP,
   * conferência N-8): sem documento, e-mail, telefones, endereço, respostas
   * do check-in, notas e quem cadastrou, seja qual for o escopo. Pessoas da
   * equipe recebem o valor inteiro.
   */
  botView<T>(actor: Actor, value: T): T;
  /**
   * Quem pode falar com o cliente da conversa em nome da equipe: o dono da
   * conversa, um administrador ou o bot que está atendendo (estado `ai`).
   * Quem não pode cria o registro sem avisar nem cobrar (conferência B9).
   */
  mayMessage(actor: Actor, c: Conversation): boolean;
  /**
   * Se uma operação pela API (remarcar, cancelar, mudar estado, enviar
   * orçamento) pode avisar o cliente da conversa: pessoas da equipe sim;
   * aplicação só quando `mayMessage` (segunda conferência, B9). Sem conversa,
   * true (não há a quem avisar).
   */
  mayNotify(actor: Actor, conversationId: string | null): Promise<boolean>;
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
  /** Anexos da mensagem recebida autenticada; nunca consulta media_id alegado. */
  inboundAttachments(c: Conversation, messageId: string): Promise<InboundAttachment[]>;
  /** Copia documento compartilhável para mídia comum, só no Coordinator. */
  outgoingAttachment(actor: Actor, c: Conversation, input: OutgoingAttachment): Promise<string>;
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
   * E-mail ao cliente da conversa (src/email.ts, docs/EMAIL.md):
   * - exige o consentimento da finalidade na conversa (recordConsent), senão
   *   409 consent_required;
   * - `key` torna o envio idempotente na área (devolve o anterior, `repeated`);
   * - até EMAIL_AREA_DAILY envios por área em 24 h, senão 429 email_limit;
   * - sem e-mail configurado na instalação, 409 email_unavailable (use o
   *   WhatsApp);
   * - o assunto não leva link nem código (400 invalid_subject): links vão no
   *   corpo.
   * Cada envio fica em email_log, sem o corpo e com o endereço mascarado.
   */
  sendEmail(
    c: Conversation,
    email: EmailMessage,
    options: { purpose: ConsentPurpose; key: string },
  ): Promise<{ id: string; status: string; repeated?: true }>;
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
  /**
   * Lê uma rota GET da API v1 de outro módulo em nome do ator, como se ele
   * chamasse `GET /profiles/:profile/<path>` (mesma permissão, mesmo 409
   * module_disabled, mesmos campos ocultos). Para usar a API pública de um
   * módulo sem `requires` nem `public.ts` (a Entrega lê os pedidos do
   * Pedido assim). Rota inexistente: 404.
   */
  read(
    actor: Actor,
    path: string,
    query?: Record<string, string>,
  ): Promise<any>;
  /**
   * Executa um comando público de outro módulo (o `op` de uma rota de
   * escrita, como `pedido.status`) em nome do ator, dentro do comando ou da
   * rodada em andamento no Coordinator: sem recibo próprio (o do comando que
   * chamou vale), com a permissão e o 409 module_disabled do dono. Só de
   * dentro do Coordinator (onCommand, onSchedule, ganchos que rodam nele).
   */
  run(actor: Actor, op: string, data: any, requestId: string): Promise<any>;
  /**
   * Ator de módulo para `read`/`run` em outro módulo em nome de quem não tem
   * acesso a ele (o entregador do QR, a pessoa só com o papel entregador).
   * Aparece nos históricos como `module:<id>` (com `label` no nome), nunca
   * tem papel (`granted`), não entra no MCP nem nas rotas HTTP, e só alcança
   * os módulos de `reach`; o módulo dono confere o que esse ator pode
   * (o Pedido só aceita dele os estados de entrega). A credencial por QR
   * nunca chega a `read`/`run`.
   */
  moduleActor(options: { reach: string[]; label?: string }): Actor;
  /**
   * Acorda o Coordinator da área: o alarme roda em seguida (a rodada dos
   * módulos no máximo uma vez por minuto, e as entregas da fila). Para rotas
   * fora do Coordinator (onTelemetry) que gravaram algo a avisar.
   * `modules` conserva uma continuação até a próxima rodada permitida.
   */
  wake(options?: { modules?: boolean }): Promise<void>;
  /**
   * A pessoa tem o papel `role` deste módulo (declarado em `grants` da
   * definição e marcado pelo administrador no acesso da pessoa, em Pessoas e
   * acessos; vale nas áreas que ela alcança). O "*" do atendente completo e
   * o papel de administrador não dão papel; aplicações e aparelhos pareados
   * nunca têm (use escopos). Papel não declarado lança erro.
   */
  granted(actor: Actor, role: string): Promise<boolean>;
  /** Pessoas ativas da área com o papel, em ordem de nome. */
  grantees(role: string): Promise<{ id: string; name: string }[]>;
  /**
   * Pedido de aprovação à equipe a partir da conversa do cliente (desconto,
   * isenção): o cartão (`fields`) é montado aqui, com dados lidos por código,
   * nunca com números do modelo. Quem pode decidir: `approvers`. A decisão
   * chega em onApproval. Repetir `key` devolve o mesmo pedido. Veja
   * docs/MODULOS.md "Pedido de aprovação".
   */
  requestApproval(c: Conversation, request: ApprovalRequest): Promise<any>;
  /**
   * QR de acesso sem login a um registro do módulo (`subject`): devolve
   * `{id, url, claim_expires_at}`; o QR leva `url`. O app troca uma vez só
   * por uma credencial que alcança só as rotas deste módulo, com
   * `actor.credential.subject`. Um QR novo revoga o anterior e a credencial
   * ativa do mesmo registro (docs/MODULOS.md, "Credencial por QR").
   */
  issueCredential(
    subject: string,
    options: { actor: string; claimMinutes: number; ttlMinutes: number },
  ): Promise<{ id: string; url: string; claim_expires_at: number }>;
  /** Revoga o QR e a credencial do registro: o app recebe 401. */
  revokeCredentials(subject: string, reason: string): Promise<number>;
  /** QRs e credenciais do registro (quem leu, quando), sem segredo. */
  credentials(subject: string): Promise<CredentialView[]>;
}

/** Caminho de rota de módulo ("pedido/orders/:id") contra um caminho real. */
function matchRoute(pattern: string, path: string) {
  const want = pattern.split("/"),
    got = path.split("/");
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i].startsWith(":")) {
      if (!got[i]) return null;
      params[want[i].slice(1)] = got[i];
    } else if (want[i] !== got[i]) return null;
  }
  return params;
}

/** Id completo do papel; papel que o módulo não declarou é erro de código. */
function declaredRole(moduleId: string, role: string) {
  if (!moduleById(moduleId)?.grants?.some((g) => g.id === role))
    throw new Error(
      `Papel ${role} não declarado em grants do módulo ${moduleId}.`,
    );
  return grantId(moduleId, role);
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

/** A chave presa à conversa não alcança outro módulo por dentro (revisão A). */
function refuseBound(actor: Actor) {
  if (isBound(actor))
    throw new ApiError(
      403,
      "bound_key",
      "Esta chave atende só a conversa em que o bot está; listas e cadastros da área não estão disponíveis.",
    );
}

/**
 * `read`/`run` em outro módulo (revisão A, credencial por QR): a credencial
 * nunca passa (ela só vale nas rotas que a declaram); o ator de módulo, só
 * nos módulos do alcance dele.
 */
function refuseCrossing(actor: Actor, target: string | undefined) {
  refuseEngineActor(actor);
  if (actor.credential)
    throw new ApiError(
      403,
      "credential_scope",
      "Este acesso vale só para o registro do QR.",
    );
  if (actor.module && (!target || !actor.module.reach.includes(target)))
    throw new ApiError(
      403,
      "module_scope",
      `O módulo ${actor.module.id} não age neste módulo.`,
    );
}

export interface ModuleContextOptions {
  /**
   * Contexto criado no Worker, fora da fila serializada da área
   * (onTelemetry, onWebStepPage): `run` é recusado.
   */
  worker?: boolean;
}

export function modulesApi(
  env: Env,
  profile: string,
  moduleId: string,
  options: ModuleContextOptions = {},
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
    access: (actor, scope) => {
      refuseEngineActor(actor);
      access(actor, profile, scope);
    },
    mayRead: (actor, kind) => mayRead(actor, kind),
    botView(actor, value) {
      if (actor.kind !== "app" && !actor.via?.masked) return value;
      const walk = (v: any): any => {
        if (Array.isArray(v)) return v.map(walk);
        if (!v || typeof v !== "object") return v;
        return Object.fromEntries(
          Object.entries(v)
            .filter(([k]) => !BOT_HIDDEN.has(k))
            .map(([k, x]) => [k, walk(x)]),
        );
      };
      return walk(value);
    },
    mayMessage: (actor, c) =>
      c.owner === actor.id ||
      (actor.kind === "user" && actor.role === "admin") ||
      (actor.id.startsWith("bot:") && c.state === "ai"),
    async mayNotify(actor, conversationId) {
      if (actor.kind !== "app" || !conversationId) return true;
      const c = await one(
        env,
        "SELECT * FROM conversations WHERE id=? AND profile_id=?",
        conversationId,
        profile,
      );
      return !!c && ctx.mayMessage(actor, c as Conversation);
    },
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
    async inboundAttachments(c, messageId) {
      requireValue(c.profile_id === profile, "Conversa de outra área.");
      await ctx.requireEnabled();
      const attachments = await all(env,
        "SELECT a.* FROM media a JOIN messages m ON m.profile_id=a.profile_id AND EXISTS(SELECT 1 FROM json_each(m.attachments) WHERE value=a.id) WHERE m.id=? AND m.profile_id=? AND m.conversation_id=? AND m.direction='customer'",
        messageId, profile, c.id,
      );
      return attachments.map((row) => ({
        id: row.id, name: row.name, mime_type: row.type, byte_length: row.size,
        async open() {
          const object = await env.MEDIA.get(row.object_key);
          if (!object) throw new ApiError(404, "not_found", "Anexo não encontrado.");
          return object;
        },
      }));
    },
    async outgoingAttachment(actor, c, input) {
      if (options.worker) throw new Error("outgoingAttachment exige comando do Coordinator.");
      ctx.access(actor, "conversations:write");
      await ctx.requireEnabled();
      requireValue(c.profile_id === profile, "Conversa de outra área.");
      if (!input.client_visible || input.sensitive)
        throw new ApiError(403, "document_not_shareable", "Documento não compartilhável.");
      if (!ctx.mayMessage(actor, c)) throw new ApiError(403, "forbidden", "Ator não pode enviar nesta conversa.");
      requireValue(input.key && input.name && input.mime_type && Number.isSafeInteger(input.byte_length) &&
        input.byte_length > 0 && input.byte_length <= 10 * 1024 * 1024, "Anexo de saída inválido.");
      const id = (await sha(`module:${moduleId}:${profile}:${input.key}`)).slice(0, 32);
      const previous = await one(env, "SELECT id,name,type,size FROM media WHERE id=? AND profile_id=?", id, profile);
      if (previous) {
        if (previous.name !== input.name || previous.type !== input.mime_type || previous.size !== input.byte_length)
          throw new ApiError(409, "idempotency_conflict", "Anexo de saída já criado com outros metadados.");
        return previous.id;
      }
      // Este adaptador roda dentro de blockConcurrencyWhile. O pipeTo de
      // putStream/FixedLengthStream depende do input gate e trava a cópia no
      // R2 sob esse bloqueio. Documentos têm limite de 10 MiB: conferir os
      // bytes antes de gravá-los diretamente, mantendo a serialização.
      const content = await readBinaryContent(new Response(input.body));
      if (content.byte_length !== input.byte_length)
        throw new ApiError(409, "content_mismatch", "Tamanho do anexo divergente.");
      const objectKey = `${profile}/${id}`;
      await env.MEDIA.put(objectKey, content.bytes, {
        httpMetadata: { contentType: input.mime_type },
      });
      await exec(env,
        "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
        id, profile, input.name, input.mime_type, content.byte_length, objectKey, actor.id, now(),
      );
      return id;
    },
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
    async granted(actor, role) {
      const id = declaredRole(moduleId, role);
      if (actor.kind !== "user" || !canProfile(actor, profile)) return false;
      return rolesOf(actor).includes(id);
    },
    grantees(role) {
      const id = declaredRole(moduleId, role);
      return all<{ id: string; name: string }>(
        env,
        "SELECT id,name FROM users WHERE disabled=0 AND json_valid(access) AND EXISTS(SELECT 1 FROM json_each(users.access) WHERE value=?) AND (role='admin' OR EXISTS(SELECT 1 FROM json_each(users.profiles) WHERE value=?)) ORDER BY name COLLATE NOCASE,id",
        id,
        profile,
      );
    },
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
    async sendEmail(c, email, options) {
      requireValue(c.profile_id === profile, "Conversa de outra área.");
      requireValue(
        CONSENT_PURPOSES.includes(options?.purpose),
        "Finalidade do e-mail inválida.",
      );
      requireValue(
        typeof options.key === "string" &&
          options.key.length > 0 &&
          options.key.length <= 200,
        "Informe a chave do envio (key).",
      );
      const key = `module:${moduleId}:${c.id}:${options.key}`;
      const previous = await one(
        env,
        "SELECT id,status FROM email_log WHERE profile_id=? AND key=?",
        profile,
        key,
      );
      if (previous)
        return { id: previous.id, status: previous.status, repeated: true };
      if (!(await consentFor(env, c.id, options.purpose)))
        throw new ApiError(
          409,
          "consent_required",
          `O cliente não autorizou avisos de ${purposeLabels[options.purpose]} nesta conversa.`,
        );
      if ((await areaEmailCount(env, profile)) >= EMAIL_AREA_DAILY)
        throw new ApiError(
          429,
          "email_limit",
          "Limite diário de e-mails desta área atingido. Tente amanhã.",
        );
      return sendEmail(env, email, {
        purpose: options.purpose,
        profileId: profile,
        moduleId,
        key,
      });
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
    requestApproval: (c, request) => {
      requireValue(c.profile_id === profile, "Conversa de outra área.");
      return requestApproval(env, moduleId, c, request);
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
    async read(actor, path, query = {}) {
      refuseBound(actor);
      refuseCrossing(actor, moduleForRoute(path.split("/")[0])?.id);
      for (const route of moduleRoutes().read) {
        const params = matchRoute(route.path, path);
        if (params) {
          access(actor, profile, "conversations:read");
          return route.handler(env, actor, profile, { params, query });
        }
      }
      throw new ApiError(404, "not_found", "Rota não encontrada.");
    },
    async run(actor, op, data, requestId) {
      // Fora do Coordinator, o comando rodaria sem a serialização da área.
      if (options.worker)
        throw new Error(
          `run: ${op} chamado fora do Coordinator (onTelemetry/onWebStepPage).`,
        );
      refuseBound(actor);
      // Só comandos de módulo (rotas públicas deles), nunca os do núcleo.
      if (!moduleForOperation(op) || moduleForOperation(op)!.id === moduleId)
        throw new Error(`run: ${op} não é comando de outro módulo.`);
      refuseCrossing(actor, moduleForOperation(op)!.id);
      return perform(env, actor, profile, op, data, requestId);
    },
    moduleActor(o) {
      const reach = [...new Set(o.reach)];
      if (
        !reach.length ||
        reach.some((id) => id === moduleId || !moduleById(id))
      )
        throw new Error(
          `moduleActor: alcance inválido (${reach.join(", ")}) no módulo ${moduleId}.`,
        );
      const name = moduleById(moduleId)?.name || moduleId;
      return {
        id: `module:${moduleId}`,
        // Aplicação para as regras de acesso por pessoa (que não se aplicam a
        // ela) e para `granted` (nunca tem papel); os escopos são os de ler e
        // mudar registros pela API pública do outro módulo.
        kind: "app",
        name: o.label ? `${name} (${String(o.label).slice(0, 60)})` : name,
        role: "service",
        profiles: [profile],
        scopes: ["conversations:read", "conversations:write", "contacts:read"],
        bots: [],
        rate: 0,
        runLimit: 0,
        module: { id: moduleId, reach },
      };
    },
    issueCredential: (subject, o) =>
      issueClaim(env, {
        profile,
        module: moduleId,
        subject,
        actor: o.actor,
        claimMinutes: o.claimMinutes,
        ttlMinutes: o.ttlMinutes,
      }),
    revokeCredentials: (subject, reason) =>
      revokeModuleCredentials(env, profile, moduleId, subject, reason),
    credentials: (subject) => credentialsFor(env, profile, moduleId, subject),
    async wake(options) {
      const local = localModuleWake(env, profile);
      if (local) return local(options);
      const response = await env.COORDINATOR.get(
        env.COORDINATOR.idFromName(profile),
      ).fetch("https://coordinator/wake", {
        method: "POST",
        body: JSON.stringify({
          profile,
          ...(options?.modules ? { modules: true } : {}),
        }),
      });
      await response.body?.cancel();
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
    // Ação do bot ou da integração na conversa: a resposta sai sem documento,
    // telefones, check-in nem quem cadastrou, seja qual for o escopo
    // (segunda conferência, N-8). Pessoas da equipe recebem tudo.
    return ctx.botView(
      actor,
      await handler(ctx, actor, c, data, { requestId }),
    );
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
  registerCommand(op, (env, actor, profile, data, requestId) => {
    // Segunda conferência da credencial por QR (a primeira é na rota): só
    // comandos de rota que a aceita, do registro dela.
    if (actor?.credential) {
      const routes = moduleRoutes().write.filter((r) => r.op === op);
      if (!routes.length) credentialGate(actor, { path: "" }, {});
      for (const route of routes)
        credentialGate(actor, route, {
          [route.credentialParam || "id"]: String(
            data?.[route.credentialParam || "id"] ?? "",
          ),
        });
    }
    return handler(modulesApi(env, profile, moduleId), actor, data, {
      requestId,
    });
  });
}

const ownsPath = (definition: ModuleDefinition | null, path: string) =>
  !!definition && definition.routes.includes(path.split("/")[0]);

/**
 * Rota de escrita /api/v1/profiles/:profile/<path> → comando `op`. O corpo
 * JSON e todos os parâmetros do caminho viram `data` (exceto profile).
 * O caminho prevalece sobre o corpo; exige Idempotency-Key.
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
  /** `{credential: true}`: aceita a credencial por QR do registro `:id`. */
  options: CredentialRouteOptions = {},
) {
  if (!ownsPath(moduleById(moduleId), path))
    throw new Error(`Rota ${path} fora de routes do módulo ${moduleId}.`);
  registerReadRoute({
    path,
    ...options,
    handler: async (env, actor, profile, request) => {
      const ctx = modulesApi(env, profile, moduleId);
      await ctx.requireEnabled();
      return handler(ctx, actor, request);
    },
  });
}

/**
 * Telemetria: POST /api/v1/profiles/:profile/<path> fora do Coordinator, sem
 * Idempotency-Key, recibo nem auditoria, corpo até 64 KB. Só para dados
 * idempotentes por natureza, como posições com horário (o módulo ignora o
 * que já tem): custa a autenticação e o que o módulo gravar, sem as 4
 * instruções do recibo por chamada (docs/LIMITES.md). O núcleo já autenticou
 * e conferiu a área e o módulo ligado; a permissão fica com o módulo. Para
 * mensagens ao cliente, acorde o Coordinator (a rodada do módulo envia).
 */
export function onTelemetry(
  moduleId: string,
  path: string,
  handler: (
    ctx: ModuleContext,
    actor: Actor,
    request: { params: Record<string, string>; body: any },
  ) => Promise<any>,
  /** `{credential: true}`: aceita a credencial por QR do registro `:id`. */
  options: CredentialRouteOptions = {},
) {
  if (!ownsPath(moduleById(moduleId), path))
    throw new Error(`Rota ${path} fora de routes do módulo ${moduleId}.`);
  registerTelemetryRoute({
    path,
    ...options,
    handler: async (env, actor, profile, request) => {
      const ctx = modulesApi(env, profile, moduleId, { worker: true });
      await ctx.requireEnabled();
      return handler(ctx, actor, request);
    },
  });
}

/**
 * Página de acompanhamento (passo web com `spec.page: "track"`): cada vez que
 * o cliente abre ou a página recarrega, o núcleo pede ao módulo o que mostrar
 * (TrackView, src/web-track.ts) e monta a página sem script, com o mapa do
 * OpenStreetMap. Devolva null para "Link indisponível". O passo nunca conclui;
 * vence pelo prazo ou pelo ctx.cancelWebStep.
 */
export function onWebStepPage(
  moduleId: string,
  handler: (ctx: ModuleContext, step: WebStep) => Promise<TrackView | null>,
) {
  if (!moduleById(moduleId))
    throw new Error(`Módulo não registrado: ${moduleId}`);
  registerWebStepPage(moduleId, (env, profile, step) =>
    handler(modulesApi(env, profile, moduleId, { worker: true }), step),
  );
}
export type { TrackView } from "../web-track";

/**
 * O app leu o QR do módulo (ctx.issueCredential). Roda no Coordinator da
 * área, depois de gravar a leitura: confira se o registro ainda aceita
 * (lance ApiError para recusar; a leitura é desfeita e o QR segue valendo) e
 * devolva o que o app precisa. `credential`: `{id, subject, label (nome
 * digitado no app), device, claimed_at, expires}`; o ator dele nas rotas é
 * `cred:<id>`.
 */
export function onCredentialClaim(
  moduleId: string,
  handler: (ctx: ModuleContext, credential: any) => Promise<any>,
) {
  if (!moduleById(moduleId))
    throw new Error(`Módulo não registrado: ${moduleId}`);
  registerCredentialHook(moduleId, async (env, profile, credential) => {
    const ctx = modulesApi(env, profile, moduleId);
    await ctx.requireEnabled();
    return handler(ctx, credential);
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
    onRead: (
      ...[moduleId, path, handler, options]: Parameters<typeof onRead>
    ) =>
      onRead(
        moduleId,
        path,
        async (ctx, actor, request) =>
          filter(ctx, actor, await handler(ctx, actor, request)),
        options,
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
 * "order" (carrinho do catálogo, content.order), "flow_reply" (resposta de
 * Flow que não é de um passo web, content.flow_reply) ou "location"
 * (localização enviada pelo cliente, content.location {latitude, longitude,
 * name, address}; sem módulo que trate, segue o caminho de sempre: menu, bot
 * ou equipe). Devolva true quando tratou; o núcleo para ali. Só roda com o
 * módulo ligado.
 */
export function onInboundContent(
  moduleId: string,
  type: "order" | "flow_reply" | "location",
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
 * Ferramenta de módulo para bots internos, traduzida em processo para uma
 * chamada à API v1 desta instalação com o ator interno: permissões,
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

/**
 * Decisão de um pedido de aprovação do módulo (ctx.requestApproval).
 * `validate` (só ao aprovar): confira o ajuste e o limite de quem decide
 * (`decision.actor`), lance ApiError para recusar; o pedido volta a pendente.
 * `decided`: aplique o efeito; roda também no vencimento (status
 * "expired", actor null): sem `decided`, o núcleo avisa o cliente e passa
 * a conversa para a equipe. Erro em `decided` devolve o pedido a pendente.
 */
export function onApproval(
  moduleId: string,
  kind: string,
  hook: {
    validate?: (
      ctx: ModuleContext,
      approval: any,
      decision: ApprovalDecision,
    ) => Promise<void>;
    decided?: (
      ctx: ModuleContext,
      approval: any,
      decision: ApprovalDecision,
    ) => Promise<void>;
  },
) {
  if (!moduleById(moduleId))
    throw new Error(`Módulo não registrado: ${moduleId}`);
  registerApprovalHook(moduleId, kind, {
    ...(hook.validate
      ? {
          validate: (env, profile, approval, decision) =>
            hook.validate!(
              modulesApi(env, profile, moduleId),
              approval,
              decision,
            ),
        }
      : {}),
    ...(hook.decided
      ? {
          decided: (env, profile, approval, decision) =>
            hook.decided!(
              modulesApi(env, profile, moduleId),
              approval,
              decision,
            ),
        }
      : {}),
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

/** M: revisão, IDs aposentados e classificações; função pura, sem persistência. */
export function onSettingsChange(moduleId: string, validate: SettingsChangeValidator) {
  if (!moduleById(moduleId)) throw new Error(`Módulo não registrado: ${moduleId}`);
  return registerSettingsChangeValidator(moduleId, validate);
}

export interface BinaryDownload {
  body: BodyInit | null;
  headers?: HeadersInit;
}
export type BinaryReadHandler = (
  ctx: ModuleContext, actor: Actor, request: BinaryRouteRequest,
) => Promise<BinaryDownload>;
/** D deve autorizar área/ordem/documento/classificação antes de abrir o R2. */
export function onBinaryRead(moduleId: string, path: string, handler: BinaryReadHandler) {
  if (!ownsPath(moduleById(moduleId), path)) throw new Error(`Rota binária fora do módulo: ${path}`);
  registerBinaryRoute({
    method: "GET", path,
    async handler(env, actor, profile, request) {
      credentialGate(actor, { path }, request.params);
      const ctx = modulesApi(env, profile, moduleId, { worker: true });
      ctx.access(actor, "conversations:read");
      await ctx.requireEnabled();
      const result = await handler(ctx, actor, request);
      return binaryResponse(result.body, result.headers);
    },
  });
}
export interface BinaryUploadRequest extends BinaryRouteRequest {
  key: string;
  version: number;
  command: BinaryCommand;
  /** Leitura limitada e hash no servidor; só depois de authorize. */
  content(): Promise<BinaryContent>;
}
export interface BinaryUploadHandler {
  /** Reserva/tentativa e confirmação de transporte, implementadas por onCommand. */
  operations: readonly string[];
  authorize(ctx: ModuleContext, actor: Actor, request: BinaryRouteRequest): Promise<void>;
  upload(ctx: ModuleContext, actor: Actor, request: BinaryUploadRequest): Promise<unknown>;
}
/** Worker transporta bytes; o callback command é a única via para alterar metadados. */
export function onBinaryUpload(moduleId: string, path: string, handler: BinaryUploadHandler) {
  const definition = moduleById(moduleId);
  if (!ownsPath(definition, path) || !handler.operations.length ||
      handler.operations.some((op) => !definition!.operations.some((prefix) => op.startsWith(prefix))))
    throw new Error(`Upload fora do módulo: ${path}`);
  registerBinaryRoute({
    method: "PUT", path,
    async handler(env, actor, profile, request) {
      credentialGate(actor, { path }, request.params);
      const ctx = modulesApi(env, profile, moduleId, { worker: true });
      ctx.access(actor, "conversations:write");
      await ctx.requireEnabled();
      const key = request.request.headers.get("Idempotency-Key") || "";
      requireValue(key.length <= 200 && /^[\x21-\x7e]+$/.test(key), "Envie Idempotency-Key (até 200 caracteres ASCII).");
      const rawVersion = request.request.headers.get("Upload-Version") || "";
      const version = Number(rawVersion);
      requireValue(/^[1-9][0-9]*$/.test(rawVersion) && Number.isSafeInteger(version), "Envie Upload-Version inteiro positivo.");
      await handler.authorize(ctx, actor, request);
      let content: Promise<BinaryContent> | undefined;
      const result = await handler.upload(ctx, actor, {
        ...request, key, version,
        command: binaryCommand(env, actor, profile, request.params, handler.operations, key),
        content: () => content ??= readBinaryContent(request.request),
      });
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    },
  });
}

// Rotas de modelos são administrativas: não passam pelo gate de os ligado.
// A/I registra descritores pelo bloco reservado de runtime.ts.
export interface AdminExtension {
  id: "area-templates";
  reads: Array<{
    path: string;
    handler: (env: Env, actor: Actor, profile: string, request: {
      params: Record<string, string>; query: Record<string, string>;
    }) => Promise<unknown>;
  }>;
  writes: ModuleWriteRoute[];
  commands: Array<{
    op: string;
    handler: (env: Env, actor: Actor, profile: string, data: any, requestId: string) => Promise<unknown>;
  }>;
}
export function registerAdminExtension(extension: AdminExtension) {
  const authorize = (actor: Actor, profile: string) => {
    admin(actor);
    if (!canProfile(actor, profile)) throw new ApiError(404, "not_found", "Área não encontrada.");
  };
  for (const route of [...extension.reads, ...extension.writes])
    if (route.path.split("/")[0] !== extension.id) throw new Error(`Rota administrativa inválida: ${route.path}`);
  for (const command of extension.commands) {
    if (!command.op.startsWith("area-template.")) throw new Error(`Operação administrativa inválida: ${command.op}`);
    registerCommand(command.op, async (env, actor, profile, data, requestId) => {
      authorize(actor, profile);
      return command.handler(env, actor, profile, data, requestId);
    });
  }
  for (const route of extension.writes) {
    if (!extension.commands.some((command) => command.op === route.op)) throw new Error(`Comando ausente: ${route.op}`);
    registerWriteRoute(route);
  }
  for (const route of extension.reads) registerReadRoute({
    path: route.path,
    async handler(env, actor, profile, request) {
      authorize(actor, profile);
      return route.handler(env, actor, profile, request);
    },
  });
}

/** Erro padrão de regra de módulo (texto mostrado ao cliente ou à equipe). */
export const moduleError = (status: number, code: string, message: string) =>
  new ApiError(status, code, message);
