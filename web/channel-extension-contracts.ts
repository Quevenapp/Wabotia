import type React from "react";
import type { ChannelId, CustomerChannelView, SocialSendAttachment } from "../src/channel-contracts";
import type { ChannelAction, ExtensionKey } from "../src/channel-c2-contracts";

export type ChannelUiData = Readonly<Record<string, unknown>>;
export type ChannelUiApi = (path: string, method?: string, body?: unknown, signal?: AbortSignal, idempotencyKey?: string) => Promise<unknown>;

export interface ConversationSlotProps {
  conversation: ChannelUiData;
  detail: ChannelUiData;
  api: ChannelUiApi;
  root: string;
  now: number;
  refresh(): Promise<unknown>;
}
export interface ChannelDraft {
  conversation: ChannelUiData;
  text: string;
  attachments: readonly string[];
  /** Metadados dos arquivos enviados; o servidor reconfere tipo, tamanho e área. */
  attachmentDetails: readonly SocialSendAttachment[];
  content: ChannelUiData;
  /** Assunto, alvo e modo são preparados antes de congelar o pedido idempotente. */
  fields: ChannelUiData;
}
export interface ComposerSlotProps extends ConversationSlotProps {
  draft: ChannelDraft;
  disabled: boolean;
  change(fields: ChannelUiData): void;
}
export interface MessageSlotProps {
  conversation: ChannelUiData;
  message: ChannelUiData;
  previousMessage: ChannelUiData | null;
  content: ChannelUiData;
  api: ChannelUiApi;
  root: string;
  now: number;
}
export interface ConnectionFieldsProps {
  form: ChannelUiData;
  change(key: string): (value: unknown) => void;
  api: ChannelUiApi;
  root: string;
  refresh(): Promise<unknown>;
  disabled: boolean;
}
export interface ContactSlotProps {
  contactId: string;
  contact: ChannelUiData;
  conversation?: ChannelUiData;
  channels: readonly CustomerChannelView[];
  /** Projeção opcional do servidor, inclusive conexão pronta sem vínculo na ficha. */
  extensionKeys?: readonly ExtensionKey[];
  api: ChannelUiApi;
  root: string;
  refresh(): Promise<unknown>;
}
export interface ReviewsPageProps {
  api: ChannelUiApi;
  root: string;
  status: ChannelUiData;
  now: number;
  /** A mesma área preserva as avaliações de Atendimento. */
  mode: "reviews" | "report";
}
export interface ChannelUiExtension {
  key: ExtensionKey;
  connectionFields?: React.ComponentType<ConnectionFieldsProps>;
  conversationHeader?: React.ComponentType<ConversationSlotProps>;
  composerFields?: React.ComponentType<ComposerSlotProps>;
  messageMetadata?: React.ComponentType<MessageSlotProps>;
  conversationInfo?: React.ComponentType<ConversationSlotProps>;
  /** Sem extensionKeys, consultar apenas o contexto já carregado do painel.
   * Retornar null sem requisições quando a área não usa o canal. */
  contactActions?: React.ComponentType<ContactSlotProps>;
  prepareAction?: (draft: ChannelDraft) => ChannelAction;
  /** Retorna somente os campos de configuração e os segredos escritos nesta submissão. */
  prepareConnection?: (form: ChannelUiData) => { config: ChannelUiData; secrets: ChannelUiData };
  /** Criação por conexão própria; Zernio continua pela importação existente. */
  connection?: { channel: ChannelId; kind: "telegram_bot" | "email"; label: string };
}
export type ChannelDemoReply = { handled: false } | { handled: true; data: unknown };
export interface ChannelDemoRequest {
  path: string;
  method: string;
  body: unknown;
  key: string | undefined;
  query: URLSearchParams;
  legacy(path: string, query: URLSearchParams): unknown;
}
export type ChannelDemoHandler = (request: ChannelDemoRequest) => ChannelDemoReply;
