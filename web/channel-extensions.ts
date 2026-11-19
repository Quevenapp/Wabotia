import React from "react";
import type { ExtensionKey } from "../src/channel-c2-contracts";
import type {
  ChannelDemoHandler, ChannelDemoRequest, ChannelDraft, ChannelUiData, ChannelUiExtension,
  ComposerSlotProps, ConnectionFieldsProps, ContactSlotProps, ConversationSlotProps,
  MessageSlotProps, ReviewsPageProps,
} from "./channel-extension-contracts";

const keys: readonly ExtensionKey[] = ["instagram/comment", "facebook/comment", "telegram/direct", "googlebusiness/review", "email/direct", "tiktok/direct"];
const registry = new Map<ExtensionKey, ChannelUiExtension>();
const demos = new Set<ChannelDemoHandler>();
let reviews: React.ComponentType<ReviewsPageProps> | undefined;
let catalogRequested = false;

/** Instalação explícita, sem requisição, leitura de credenciais ou efeito no DOM. */
export function registerChannelUi(extension: ChannelUiExtension): void {
  if (!keys.includes(extension.key)) throw new Error("Extensão de canal desconhecida.");
  const existing = registry.get(extension.key);
  if (existing && existing !== extension) throw new Error("Já existe uma extensão de interface para este canal e contexto.");
  registry.set(extension.key, extension);
  // A navegação da casca não conserva parâmetros de catálogo. Capturar o
  // opt-in no bootstrap permite abrir Conexões depois, sem gravar preferência.
  channelCatalogVisible({});
}
export function registerReviewsPage(component: React.ComponentType<ReviewsPageProps>): void {
  if (reviews && reviews !== component) throw new Error("A página de avaliações já foi registrada.");
  reviews = component;
}
export function registerChannelDemo(handler: ChannelDemoHandler): void { demos.add(handler); }
export function getChannelUi(key: ExtensionKey): ChannelUiExtension | undefined { return registry.get(key); }

function object(value: unknown): ChannelUiData {
  if (typeof value === "string") {
    try { return object(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as ChannelUiData : {};
}
export function channelUiKey(row: ChannelUiData): ExtensionKey | null {
  const context = object(row.channel_context).context ?? row.context ??
    (row.chat_type === "comment" || row.chat_type === "review" ? row.chat_type : row.channel === "googlebusiness" ? "review" : "direct");
  const key = `${row.channel}/${context}`;
  return keys.includes(key as ExtensionKey) ? key as ExtensionKey : null;
}
export function channelUiFor(row: ChannelUiData): ChannelUiExtension | undefined {
  const key = channelUiKey(row);
  return key ? registry.get(key) : undefined;
}
/** Somente a entrada explícita ou uma projeção de recurso ativo abre o catálogo. */
export function channelCatalogVisible(status: ChannelUiData = {}, search?: string): boolean {
  if (search === undefined) {
    search = typeof location === "undefined" ? "" : location.search;
    if (new URLSearchParams(search).get("canais") === "2") catalogRequested = true;
    if (catalogRequested) return true;
  }
  if (new URLSearchParams(search).get("canais") === "2") return true;
  if (status.c2_active === true || (Array.isArray(status.channel_extensions) && status.channel_extensions.some(key => keys.includes(key as ExtensionKey)))) return true;
  if (Array.isArray(status.connected_channels) && status.connected_channels.some(channel => ["telegram", "email", "tiktok", "googlebusiness"].includes(String(channel)))) return true;
  return Array.isArray(status.connections) && status.connections.some(value => {
    const row = object(value), config = object(row.config);
    return ["telegram", "email", "tiktok", "googlebusiness"].includes(String(row.channel)) || config.comments_enabled === true;
  });
}
export function channelConnectionChoices(status: ChannelUiData): NonNullable<ChannelUiExtension["connection"]>[] {
  if (!channelCatalogVisible(status)) return [];
  return [...registry.values()].flatMap(extension => extension.connection && extension.connectionFields ? [extension.connection] : []);
}
export function channelConnectionUi(row: ChannelUiData, catalog = false): ChannelUiExtension | undefined {
  const direct = channelUiFor(row);
  if (direct?.connectionFields) return direct;
  const config = object(row.config);
  if ((catalog || config.comments_enabled === true || row.comments_enabled === true) && ["instagram", "facebook"].includes(String(row.channel)))
    return registry.get(`${row.channel}/comment` as ExtensionKey);
  return undefined;
}
export function prepareChannelUiAction(draft: ChannelDraft) {
  const key = channelUiKey(draft.conversation);
  if (!key) return null;
  const extension = registry.get(key);
  // Um comentário nunca cai em resposta genérica pública por falta de adaptador.
  if (!extension?.prepareAction) throw new Error("Este canal ainda não está disponível para envio.");
  // A extensão pode devolver referências ao rascunho; o retry conserva uma
  // cópia independente mesmo se o formulário receber novas projeções.
  return structuredClone(extension.prepareAction(draft));
}
/** Códigos locais compartilhados; corpos e mensagens do fornecedor não chegam à UI. */
export function channelExtensionReason(code: unknown): string | null {
  if (typeof code !== "string") return null;
  return ({
    private_reply_used: "A tentativa de resposta privada deste comentário já foi usada.",
    private_reply_expired: "O prazo para responder este comentário em privado terminou.",
    quota_exhausted: "O limite de envios deste canal foi atingido. Aguarde a liberação de uma vaga.",
    rate_limited: "O canal está aguardando o intervalo permitido para o próximo envio.",
    sender_unverified: "O remetente não está confirmado e não pode consultar dados de cliente.",
    subject_invalid: "Revise o assunto do e-mail.",
    attachment_too_large: "Um anexo excede o tamanho permitido pelo canal.",
    provider_contract_unverified: "Este recurso depende de confirmação do formato usado pelo provedor.",
  } as Record<string, string>)[code] ?? null;
}
export function ChannelConversationHeader(props: ConversationSlotProps) {
  const Component = channelUiFor(props.conversation)?.conversationHeader;
  return Component ? React.createElement(Component, props) : null;
}
export function ChannelConversationInfo(props: ConversationSlotProps) {
  const Component = channelUiFor(props.conversation)?.conversationInfo;
  return Component ? React.createElement(Component, props) : null;
}
export function ChannelComposerFields(props: ComposerSlotProps) {
  const Component = channelUiFor(props.conversation)?.composerFields;
  return Component ? React.createElement(Component, props) : null;
}
export function ChannelMessageMetadata(props: MessageSlotProps) {
  const Component = channelUiFor(props.conversation)?.messageMetadata;
  return Component ? React.createElement(Component, props) : null;
}
export function ChannelConnectionFields(props: ConnectionFieldsProps & { catalog?: boolean }) {
  const Component = channelConnectionUi(props.form, props.catalog)?.connectionFields;
  return Component ? React.createElement(Component, props) : null;
}
export function ChannelContactActions(props: ContactSlotProps) {
  const enabled = new Set(props.extensionKeys ?? []);
  const demoCatalog = props.demo === true && channelCatalogVisible(props.status ?? {});
  const key = props.conversation && channelUiKey(props.conversation);
  if (key) enabled.add(key);
  for (const channel of props.channels) {
    const candidate = channelUiKey({ channel: channel.channel });
    if (candidate) enabled.add(candidate);
  }
  const seen = new Set<React.ComponentType<ContactSlotProps>>();
  const components = [...registry.values()].filter(extension => {
    if (!extension.contactActions || seen.has(extension.contactActions) ||
        (!demoCatalog && !enabled.has(extension.key))) return false;
    seen.add(extension.contactActions);
    return true;
  });
  return components.length ? React.createElement(React.Fragment, null, ...components.map(extension =>
    React.createElement(extension.contactActions!, { ...props, key: extension.key }))) : null;
}
export function channelReviewsAvailable(status: ChannelUiData): boolean {
  return !!reviews && Array.isArray(status.connected_channels) && status.connected_channels.includes("googlebusiness");
}
export function ChannelReviewsPage(props: ReviewsPageProps) {
  return reviews && channelReviewsAvailable(props.status) ? React.createElement(reviews, props) : null;
}
export function dispatchChannelDemo(request: ChannelDemoRequest) {
  // O bootstrap instala todos os descritores, mas a demonstração antiga só
  // muda após a mesma entrada explícita do catálogo da segunda leva.
  if (request.query.get("canais") !== "2" && !catalogRequested) return { handled: false } as const;
  for (const handler of demos) {
    const result = handler(request);
    if (result.handled) return result;
  }
  return { handled: false } as const;
}
