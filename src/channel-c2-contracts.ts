/** Contratos da segunda leva. Implementações são instaladas explicitamente, sem I/O. */
import type { Actor, Conversation, Env } from "./types";
import type { Statement } from "./customer/contracts";
import type { ChannelConfigurationResult, ChannelConnection, ChannelContext, ChannelId, ChannelSpec, ChannelSubjectNamespace, SocialSendAttachment } from "./channel-contracts";

export type ExtensionKey = "instagram/comment" | "facebook/comment" | "telegram/direct" | "googlebusiness/review" | "email/direct" | "tiktok/direct";
export type Resource = { kind: "conversation"; id: string } | { kind: "review"; id: string };
export type IdentityTrust = "channel" | "unverified_sender" | "none";
/** Somente o kernel autentica este valor; objetos recebidos por HTTP não são prova. */
export interface VerifiedIngress {
  profileId: string; connectionId: string; channel: ChannelId; context: ChannelContext;
  accountId: string; source: "zernio_hmac" | "telegram_secret" | "worker_email";
}
export interface NormalizedChannelEvent {
  key: string; kind: string; occurredAt: number | null; subjectId?: string;
  subjectNamespace?: ChannelSubjectNamespace; remoteId: string;
  context: Record<string, unknown>; content: Record<string, unknown>;
}
export interface ChannelWritePlan {
  statements: Statement[]; conversationId?: string; resource?: Resource; wake: boolean;
}
export interface ChannelDeliveryPlan {
  resource: Resource; operation: string; orderKey: string;
  deliveries: readonly { key: string; payload: Record<string, unknown> }[];
  /** Reservas de tentativa/quota pertencem ao mesmo lote que a outbox. */
  statements?: Statement[];
  /** Recebe IDs da outbox para reservas com FK, no mesmo lote depois de criá-la. */
  reservations?(deliveries: readonly { id: string; key: string }[]): Statement[];
  /** Texto para revisão humana; sugestão exige deliveries vazio. */
  suggestion?: string;
}
export type ChannelDeliveryResult =
  | { kind: "sent"; externalId?: string; context?: Record<string, unknown> }
  | { kind: "retry"; notBefore: number; code: string }
  | { kind: "failed"; code: string }
  | { kind: "unknown"; code: string };
export type ChannelAction =
  | { type: "comment.reply" | "comment.private" | "comment.suggest"; commentId: string; text: string }
  | { type: "comment.visibility"; commentId: string; hidden: boolean }
  | { type: "telegram.request-contact" }
  | { type: "email.send"; text: string; subject: string; attachments?: readonly SocialSendAttachment[] }
  | { type: "message.send"; text: string; attachments?: readonly SocialSendAttachment[] }
  | { type: "google.reply"; version: number; text: string }
  | { type: "google.reply.delete" | "google.suggest"; version: number };
/** Não integra o DTO público nem pode ser solicitado por message-actions. */
export type ChannelInternalAction = { type: "email.auto-reply" | "email.acknowledgement"; text: string; subject: string };
export type ServerChannelAction = ChannelAction | ChannelInternalAction;
export interface ChannelReview {
  id: string; profile_id: string; connection_id: string; account_id: string; remote_id: string;
  rating: number; text: string; author_name: string; author_picture: string; permalink: string;
  state: "active" | "deleted"; version: number; reply_text: string; reply_at: number | null;
  published_at: number | null; provider_updated_at: number | null; created: number; updated: number;
}
export type LoadedChannelResource =
  | { kind: "conversation"; id: string; conversation: Conversation }
  | { kind: "review"; id: string; review: ChannelReview };
export interface ExtensionConnection extends ChannelConnection {
  status: string; name: string; mode: string; created: number;
}
export interface ChannelAuthorization {
  actor: Actor; profileId: string; origin: "human" | "bot" | "ingress" | "maintenance";
  permissions: readonly string[];
}
export interface ChannelOperationContext {
  env: Env; connection: ExtensionConnection; resource: LoadedChannelResource | null;
  authorization: ChannelAuthorization; now: number; commandId: string; ingress?: VerifiedIngress;
}
export interface ChannelOutboxRow {
  id: string; profile_id: string; conversation_id: string | null; connection_id: string | null;
  epoch: number | null; kind: string; actor: string; payload: string; status: string;
  external_id: string | null; error: string | null; dedupe: string; created: number; updated: number;
  completion_handled?: number;
}
export interface ChannelDeliveryState {
  outbox_id: string; profile_id: string; connection_id: string; resource_key: string;
  operation: string; request_hash: string; attempted_at: number | null; not_before: number;
  result_context: string; created: number; updated: number;
}
export interface ChannelDeliveryContext {
  env: Env; outbox: ChannelOutboxRow; sidecar: ChannelDeliveryState;
  resource: LoadedChannelResource; connection: ExtensionConnection;
  configuration: Readonly<Record<string, unknown>>; now: number;
  /** Chamar imediatamente antes de cada chamada remota: reautoriza, reconfere época/vínculo. */
  beforeFetch(): Promise<void>;
}
export interface ChannelCompletionContext extends ChannelDeliveryContext { result: ChannelDeliveryResult }
export interface ChannelReadContext extends ChannelOperationContext {}
export interface ChannelExtensionView {
  capabilities: Partial<ChannelSpec>;
  metadata: { subject?: string; identityTrust?: IdentityTrust; remainingMessages?: number;
    closesAt?: number | null; state?: string; configured?: boolean; accountLabel?: string;
    commentId?: string; postId?: string; permalink?: string; version?: number;
    comment?: { id: string; postId: string; parentId?: string; text?: string; postText?: string; permalink?: string;
      hidden: boolean; version: number; privateState: "available" | "reserved" | "sent" | "failed" | "unknown";
      privateExpiresAt: number | null; privateConversationId?: string | null; privateLinkPending?: boolean };
    email?: { subject: string; sender: string; from?: string; replyTo?: string; identityTrust: "unverified_sender";
      authentication?: readonly { method: string; result: string }[]; attachmentWarnings?: readonly string[] };
    telegram?: { username?: string; botUrl?: string; blocked: boolean; webhookConfigured: boolean;
      phoneSuggestion?: { masked: string; confirmedByHuman: false } };
    tiktok?: { remainingMessages: number; closesAt: number | null; conservativeQuota: true };
    review?: { id: string; version: number; rating: number; state: "active" | "deleted"; replyState?: string };
  };
}
export type ChannelRouteAuthorization = "admin" | "conversation.reply" | "reviews.read" | "google.reply" | "contact.reply";
export interface ChannelRouteContext {
  env: Env; actor: Actor; profileId: string; params: Readonly<Record<string, string>>;
  input: unknown; commandId: string; now: number;
}
export interface ChannelRoute {
  method: "GET" | "POST" | "PUT" | "DELETE"; path: string;
  authorization: ChannelRouteAuthorization;
  handler(ctx: ChannelRouteContext): Promise<unknown>;
}
export interface ChannelConnectionContext {
  env: Env; actor: Actor; profileId: string; connection: ExtensionConnection;
  input: unknown; commandId: string; now: number;
}
export interface ChannelConnectionResult {
  status: "active" | "pending" | "paused" | "removal_pending";
  configured: boolean; code?: string; configuration?: Readonly<Record<string, unknown>>;
}
export interface ChannelConnectionDriver {
  channel: ChannelId;
  validate(input: unknown): ChannelConfigurationResult;
  configure(ctx: ChannelConnectionContext): Promise<ChannelConnectionResult>;
  probe(ctx: ChannelConnectionContext): Promise<ChannelConnectionResult>;
  remove(ctx: ChannelConnectionContext): Promise<ChannelConnectionResult>;
}
export interface ChannelMaintenanceContext { env: Env; profileId: string; now: number }
export interface ChannelMaintenance {
  key: string;
  run(ctx: ChannelMaintenanceContext): Promise<{ nextAt: number | null; pending: boolean }>;
  /** Apenas cron; nunca no caminho de mensagem antiga. */
  recover?(ctx: ChannelMaintenanceContext): Promise<{ nextAt: number | null; pending: boolean }>;
}
export interface ChannelExtension {
  key: ExtensionKey; spec: ChannelSpec;
  normalize(input: unknown, scope: VerifiedIngress): Promise<NormalizedChannelEvent | null>;
  /** Ack de protocolo (por exemplo callback Telegram), inclusive no replay. Não cria atendimento. */
  acknowledge?(ctx: ChannelOperationContext, event: NormalizedChannelEvent, duplicate: boolean): Promise<void>;
  prepareInbound(ctx: ChannelOperationContext, event: NormalizedChannelEvent): Promise<ChannelWritePlan>;
  prepareSend(ctx: ChannelOperationContext, input: ServerChannelAction): Promise<ChannelDeliveryPlan>;
  deliver(ctx: ChannelDeliveryContext): Promise<ChannelDeliveryResult>;
  complete(ctx: ChannelCompletionContext): Promise<ChannelWritePlan>;
  view?(ctx: ChannelReadContext): Promise<ChannelExtensionView>;
  routes: readonly ChannelRoute[];
  connectionDriver?: ChannelConnectionDriver;
  maintenance?: readonly ChannelMaintenance[];
  ingress?: {
    zernio?: { matches(input: unknown): boolean };
    email?(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void>;
  };
  /** Opt-in da conexão; ausência mantém contextos novos desligados. */
  enabled?(connection: ChannelConnection): boolean;
  /** Quota/bloqueio específico: só consultado para um canal novo antes do bot ou aviso de transferência. */
  automationBlock?(ctx: ChannelOperationContext): Promise<{ code: string; reason: string } | null>;
  /** Contrato de descoberta fica no descritor; não cria meta_numbers. */
  account?: { importable: boolean; serviceLine: boolean };
  prepareMenu?(ctx: ChannelOperationContext, input: {
    token: string; title: string; items: readonly { id: string; title: string }[]; expiresAt: number;
  }): Promise<ChannelDeliveryPlan>;
  report?(ctx: { env: Env; actor: Actor; profileId: string; query: URLSearchParams }): Promise<Response>;
  push?(ctx: { env: Env; profileId: string; event: {
    id: string; kind: string; resourceId: string | null; payload: Readonly<Record<string, unknown>>; created: number;
  }; now: number }): Promise<{ reviewId: string; rating: number } | null>;
  /** E-mail recebe somente a entrada corrente; nunca o motor de histórico privado. */
  prepareBotReply?(ctx: ChannelOperationContext, input: {
    messageId: string; text: string; attachments: readonly string[]; occurredAt: number | null;
  }): Promise<{ action: ChannelInternalAction; plan: ChannelDeliveryPlan } | null>;
  /** Confirmação fixa, elegibilidade e limite próprios; independe da ativação do bot. */
  prepareAcknowledgement?(ctx: ChannelOperationContext, input: {
    messageId: string; text: string; attachments: readonly string[]; occurredAt: number | null;
  }): Promise<{ action: ChannelInternalAction; plan: ChannelDeliveryPlan } | null>;
}
