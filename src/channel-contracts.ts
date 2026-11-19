/** Contratos serializáveis compartilhados com web e aplicativos, sem runtime Cloudflare. */
export type ChannelId =
  | "whatsapp" | "instagram" | "facebook" | "tiktok"
  | "googlebusiness" | "telegram" | "email";
export type SocialChannelId = Exclude<ChannelId, "whatsapp">;
export type DirectSocialChannelId = "instagram" | "facebook";
export type ChannelContext = "direct" | "group" | "comment" | "review";
/** Atribuído pelo servidor após autenticação; nunca aceitar origin do corpo do cliente. */
export type SendOrigin = "manual_text" | "human_media" | "bot" | "automation";
export type MediaKind = "image" | "video" | "audio" | "document" | "sticker";
export type ChannelErrorCode =
  | "window_closed" | "human_only" | "cannot_initiate" | "unsupported_content"
  | "inbox_required" | "channel_not_ready" | "provider_unknown"
  | "private_reply_used" | "private_reply_expired" | "quota_exhausted" | "rate_limited"
  | "sender_unverified" | "subject_invalid" | "attachment_too_large" | "provider_contract_unverified";

export interface ChannelSpec {
  id: ChannelId;
  label: string;
  enabled: boolean;
  transport: "zernio" | "telegram_bot" | "email";
  serviceLine: boolean;
  /** Contexto selecionado por channelRules; ausência conserva o contrato mínimo. */
  context?: ChannelContext;
  contexts: Partial<Record<ChannelContext, {
    enabled: boolean;
    bot: boolean;
    publicReply: boolean;
  }>>;
  text: { enabled: boolean; maxChars: number | null };
  /** Limites sociais são locais do Wabotia; MIME e formatos: a conferir com a conta real. */
  media: Partial<Record<MediaKind, {
    receive: boolean;
    send: boolean;
    maxSendBytes: number | null;
    mimeTypes: readonly string[];
  }>>;
  /** Voz WhatsApp é distinta de áudio, inclusive nos recursos anunciados do QR v1. */
  voice?: {
    receive: boolean;
    send: boolean;
    maxSendBytes: number;
    mimeTypes: readonly string[];
  };
  /** Projeção granular do transporte WhatsApp; não autoriza recursos em outros canais. */
  legacyCapabilities?: LegacyChannelCapabilities;
  menu: {
    buttons: number;
    quickReplies: number;
    listItems: number;
    fallback: "numbered_text";
  };
  window:
    | { kind: "none" }
    | {
        kind: "customer";
        hours: number;
        humanTextHours?: number;
        maxMessages?: number;
        after: "template" | "human_text" | "blocked";
      };
  initiation: "template" | "customer_first" | "business";
  templates: boolean;
  subject: boolean;
  replyTo: boolean;
  bold: "whatsapp" | "telegram" | "html" | "none";
}

/** Valores em milissegundos desde epoch. Estado calculado pelo servidor, não pelo cliente. */
export interface WindowState {
  kind: "none" | "customer";
  state: "open" | "human_text_only" | "closed";
  serverNow: number;
  closesAt: number | null;
  humanTextClosesAt: number | null;
  remainingMessages: number | null;
  canHumanText: boolean;
  canAutomation: boolean;
  reason: string | null;
}

export interface ChannelConnection {
  id: string;
  profile_id: string;
  /** Transporte: zernio e qr não são canais; ai não é um canal de atendimento. */
  kind: string;
  channel?: ChannelId | null;
  account_label?: string;
  config: string;
}

/** Acréscimo ao contrato legado de capacidades; não substitui suas chaves. */
export interface ChannelView {
  channel: ChannelId | null;
  account_label: string;
  /** Resumo mantido pelo servidor em alterações de conexão, sem contagem por mensagem. */
  multichannel: boolean;
  window: WindowState | null;
  templates: boolean;
  menu: ChannelSpec["menu"] | null;
  subject: boolean;
  public_reply: boolean;
  modules: boolean;
  can_initiate: boolean;
}

export interface LegacyChannelCapabilities {
  text: boolean;
  document: boolean;
  image: boolean;
  video: boolean;
  audio: boolean;
  voice: boolean;
  sticker: boolean;
  reply: boolean;
  reaction: boolean;
  location: boolean;
  contacts: boolean;
  edit: boolean;
  delete: boolean;
  read: boolean;
  mentions: boolean;
  groups: boolean;
  group_manage: boolean;
  calls: boolean;
  video_calls: boolean;
  upgrade_required: boolean;
}
/** DTO antigo continua construível; novas respostas podem exigir ChannelCapabilities. */
export type CompatibleChannelCapabilities = LegacyChannelCapabilities & Partial<ChannelView>;
export type ChannelCapabilities = LegacyChannelCapabilities & ChannelView;

/** Apenas metadados normalizados. Nunca guardar credencial ou cópia bruta de webhook. */
export interface ChannelContextData {
  version: 1;
  context: ChannelContext;
  /** Controlado pelo servidor; não editável por connection.save. */
  multichannel?: boolean;
  story?: { id: string; title?: string };
  /** Reservado/desligado; autor de comentário não equivale a sujeito de DM. */
  comment?: { postId: string; commentId: string; parentId?: string };
  /** Reservado/desligado; avaliação não abre conversa de atendimento. */
  review?: { reviewId: string; rating?: number };
  /** Reservado para assunto/encadeamento futuro. */
  thread?: { id: string; subject?: string };
}
/** O objeto vazio é o valor das conversas anteriores à base de canais. */
export type StoredChannelContext = ChannelContextData | Record<string, never>;
export type ChannelSubjectNamespace = "dm" | "comment-author" | "telegram-user" | "email-address";

export interface OtherChannelConversation {
  id: string;
  channel: ChannelId | null;
  account_label: string;
  title: string;
  state: string;
  updated: number;
}
export interface ConversationChannelDetail extends ChannelView {
  /** Já filtradas pela autorização do ator; junção não amplia o escopo do cliente/bot. */
  other_conversations: readonly OtherChannelConversation[];
  email_transcript: TranscriptOptions;
}
export interface ChannelStatusView {
  connected_channels: readonly ChannelId[];
  conversation_channels: readonly ChannelId[];
  multichannel: boolean;
  email_transcript: TranscriptAvailability;
}

export interface ChannelAccountView {
  integrationId: string;
  channel: SocialChannelId;
  accountId: string;
  providerProfileId: string | null;
  accountLabel: string;
  connectionId: string | null;
  importable: boolean;
  reason: string | null;
}
export interface ChannelAccountDiscovery {
  accounts: readonly ChannelAccountView[];
  warnings: readonly string[];
}
export interface ChannelAccountImport {
  commandId: string;
  integrationId: string;
  accountId: string;
  channel: DirectSocialChannelId | "tiktok" | "googlebusiness";
}
export interface ChannelAccountImportResult {
  connection: ChannelConnection;
  account: ChannelAccountView;
  duplicate: boolean;
}
export interface ChannelConfigurationInput {
  channel: ChannelId;
  kind: string;
  /** Configuração submetida pelo usuário; remover/rejeitar metadados internos. */
  config: Readonly<Record<string, unknown>>;
  existingConnectionId?: string;
}
export interface ChannelConfigurationResult {
  channel: ChannelId;
  config: Readonly<Record<string, unknown>>;
}
export interface ChannelAccountRemoval {
  commandId: string;
  connectionId: string;
}
export interface ChannelAccountRemovalResult {
  connectionId: string;
  removed: boolean;
  duplicate: boolean;
}

export type CustomerChannelState = "ready" | "pending" | "ambiguous" | "blocked" | "erased";
export interface CustomerChannelView {
  /** ID local, não identificador bruto do perfil social. */
  id: string;
  channel: ChannelId;
  account_label: string;
  display_name: string;
  username: string;
  state: CustomerChannelState;
  connection_id: string | null;
  /** Sujeitos opacos são dados pessoais; só apresentação mascarada na ficha. */
  subject_masked?: string;
}
export interface CustomerChannelsView {
  channels: readonly CustomerChannelView[];
  other_conversations: readonly OtherChannelConversation[];
}
export type MergeErrorCode =
  | "merge_erp_conflict" | "merge_changed" | "idempotency_conflict"
  | "merge_restricted" | "merge_jobs_pending" | "merge_relation_conflict";
export interface ContactMergeAvailability {
  available: boolean;
  reason: string | null;
  merged_into: string | null;
  merge_id: string | null;
  can_undo: boolean;
}
export interface MergeContactSnapshot {
  id: string;
  version: number;
  name: string;
  phone: string | null;
  email: string;
  document: string | null;
  erpId: string | null;
}
export type MergeField = "name" | "phone" | "email" | "document" | "personType" | "address";
export type MergeFieldChoices = Partial<Record<MergeField, "source" | "target">>;
export interface MergeFieldDifference {
  field: MergeField;
  source: string | Readonly<Record<string, string>> | null;
  target: string | Readonly<Record<string, string>> | null;
  defaultChoice: "source" | "target";
  requiresConfirmation: boolean;
}
export interface ContactMergePreviewRequest { targetId: string }
export interface ContactMergePreview {
  source: MergeContactSnapshot;
  target: MergeContactSnapshot;
  survivorId: string;
  differences: readonly MergeFieldDifference[];
  relationCounts: Readonly<Record<string, number>>;
  blockers: readonly { code: MergeErrorCode; message: string }[];
  /** Assinado pelo servidor; vincula versões, escolhas permitidas e manifesto de relações. */
  previewToken: string;
  expiresAt: number;
}
export interface ContactMergeRequest {
  targetId: string;
  sourceVersion: number;
  targetVersion: number;
  previewToken: string;
  /** Ausência preserva destino e só preenche campos vazios. */
  fieldChoices: MergeFieldChoices;
  reason?: string;
}
export interface ContactMergeResult {
  id: string;
  sourceId: string;
  targetId: string;
  sourceVersion: number;
  targetVersion: number;
  state: "applied" | "undone";
  duplicate: boolean;
}
export interface ContactMergeUndoRequest {
  mergeId: string;
  /** Se informadas, são reconferidas; o manifesto pós-junção sempre é obrigatório no servidor. */
  sourceVersion?: number;
  targetVersion?: number;
}

export type TranscriptDestination =
  | { kind: "self" }
  | { kind: "contact" }
  | { kind: "custom"; address: string };
export type TranscriptRange =
  | { kind: "session" }
  | { kind: "dates"; from: number; to: number };
export interface TranscriptPreviewRequest {
  destination: TranscriptDestination;
  range: TranscriptRange;
}
export interface TranscriptSendRequest {
  previewToken: string;
  confirmedRecipient?: string;
  customerRequested?: boolean;
}
export interface TranscriptAvailability {
  available: boolean;
  reason: string | null;
}
export interface TranscriptLimits {
  maxMessages: number;
  maxTextChars: number;
  maxHtmlChars: number;
  actorPer24Hours: number;
  profilePer24Hours: number;
  previewTtlMs: number;
}
export interface TranscriptOptions extends TranscriptAvailability {
  /** Pessoa: self/contact/custom autorizados. Aplicação nunca recebe self. */
  destinations: readonly TranscriptDestination["kind"][];
  ranges: readonly TranscriptRange["kind"][];
  limits: TranscriptLimits;
}
export interface TranscriptPreview {
  recipient: string;
  period: { from: number; to: number };
  messageCount: number;
  size: { textChars: number; htmlChars: number };
  warnings: readonly string[];
  requiresConfirmation: boolean;
  requiresCustomerRequest: boolean;
  /** Token assinado sem transcrição, vinculado ao ator, seleção e destinatário por 10 minutos. */
  previewToken: string;
  expiresAt: number;
}
export interface TranscriptSendResult {
  id: string;
  /** unknown exige conferência humana; nunca reenviar automaticamente. */
  status: "reserved" | "sending" | "queued" | "sent" | "failed" | "unknown";
  to_masked: string;
  duplicate: boolean;
}
export interface TranscriptEmailSettings {
  /** Padrão false; somente administrador altera. */
  transcript_custom_enabled: boolean;
  /** Domínios normalizados exatos; vazio não acrescenta restrição. */
  transcript_allowed_domains: readonly string[];
}

/** Escopo resolvido pelo servidor depois da assinatura; nunca confiar no webhook isolado. */
export interface SocialEventScope {
  profileId: string;
  integrationId: string;
  connectionId: string;
  channel: DirectSocialChannelId;
  accountId: string;
  providerProfileId: string | null;
}
export interface SocialEventSubject {
  namespace: "dm";
  id: string;
  displayName?: string;
  username?: string;
}
export interface SocialInboundMedia {
  kind: MediaKind;
  mimeType: string | null;
  name: string | null;
  /** Temporária: só o copiador autorizado a usa; não persistir como anexo. */
  sourceUrl: string | null;
  providerMediaId: string | null;
}
interface SocialEventBase {
  scope: SocialEventScope;
  eventId: string;
  messageId: string;
  threadId: string;
  subject: SocialEventSubject;
  /** Timestamp validado do fornecedor, nunca o instante do retry. null não renova janela. */
  occurredAt: number | null;
}
export type NormalizedSocialEvent =
  | (SocialEventBase & {
      type: "message.received" | "message.sent" | "message.edited";
      text: string;
      media: readonly SocialInboundMedia[];
      context: ChannelContextData;
      /** Eco local só quando comprovado pela associação; não inferir por texto/nome. */
      localDeliveryId?: string;
    })
  | (SocialEventBase & { type: "message.deleted" | "message.read" | "message.delivered" })
  | (SocialEventBase & { type: "message.reaction"; reaction: string | null });
export type SocialEventResult =
  | { status: "accepted"; event: NormalizedSocialEvent }
  | { status: "ignored"; reason: "channel_not_ready" | "scope_mismatch" | "unsupported_event" | "invalid_event" };
export interface SocialSendAttachment {
  mediaId: string;
  kind: MediaKind;
  mimeType: string;
  bytes: number;
  name?: string;
}
export interface SocialSendInput {
  scope: SocialEventScope;
  conversationId: string;
  threadId: string | null;
  commandId: string;
  /** Valores obtidos de estado autenticado do servidor, nunca de parâmetros arbitrários. */
  origin: SendOrigin;
  lastCustomer: number;
  serverNow: number;
  text: string;
  attachments: readonly SocialSendAttachment[];
  menu?: readonly { id: string; title: string }[];
}
export interface SocialDelivery {
  id: string;
  idempotencyKey: string;
  sequence: number;
  /** Uma entrega corresponde a uma chamada; texto+imagem pode gerar duas entregas. */
  content:
    | { type: "text"; text: string }
    | { type: "media"; attachment: SocialSendAttachment }
    | { type: "buttons" | "quick_replies"; text: string; options: readonly { id: string; title: string }[] };
  /** Só o servidor atribui após verificar texto humano autenticado e janela. */
  messageTag?: "HUMAN_AGENT";
}
export interface SocialSendPlan {
  conversationId: string;
  threadId: string;
  window: WindowState;
  deliveries: readonly SocialDelivery[];
}
