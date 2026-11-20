import React from "react";
import type { ChannelAction } from "../../src/channel-c2-contracts";
import type { ChannelDraft, ChannelUiExtension, ConnectionFieldsProps, ConversationSlotProps } from "../channel-extension-contracts";
import { registerChannelDemo, registerChannelUi, registerReviewsPage } from "../channel-extensions";
import { CommentsPanel, CommentComposerFields, CommentConnectionFields, prepareCommentAction, prepareCommentConnection } from "./CommentsPanel";
import { TelegramConnectionFields, TelegramConversationInfo, TelegramComposerFields, prepareTelegramConnection } from "./TelegramConnectionFields";
import { EmailConnectionFields, prepareEmailConnection } from "./EmailConnectionFields";
import { EmailConversationFields, EmailComposerFields, prepareEmailAction } from "./EmailConversationFields";
import { ContactChannelActions } from "./ContactChannelActions";
import { GoogleReviewsPage } from "./GoogleReviewsPage";
import { ChannelMessageMeta } from "./ChannelMessageMeta";
import { ChannelDeliveryNotice, channelMetadata, uiRecord } from "./ChannelMarks";
import { TikTokQuota, TikTokComposerFields, prepareTikTokAction } from "./TikTokQuota";
import { c2DemoHandler } from "./demo";
import "./styles.css";

export function prepareTelegramAction(draft: ChannelDraft): ChannelAction {
  if (draft.conversation.channel !== "telegram") throw new Error("Canal incompatível.");
  if (uiRecord(channelMetadata(draft.conversation).telegram).blocked === true) throw new Error("O cliente bloqueou o bot. O envio está indisponível.");
  if (["location", "contacts"].includes(String(draft.content.type))) throw new Error("Este conteúdo exige uma ação específica do canal.");
  if (!draft.text.trim() && !draft.attachmentDetails.length) throw new Error("Escreva uma mensagem ou selecione um anexo.");
  if (draft.attachments.length !== draft.attachmentDetails.length) throw new Error("Aguarde a preparação dos anexos.");
  return { type: "message.send", text: draft.text, attachments: draft.attachmentDetails.map(file => ({ ...file })) };
}

function ImportedConnectionFields({ form }: ConnectionFieldsProps) {
  if (form.channel !== "googlebusiness" && form.channel !== "tiktok") return null;
  const google = form.channel === "googlebusiness";
  return React.createElement("section", { className: "c2-connection-fields" },
    React.createElement("p", null, google ? "Google · avaliações" : "TikTok · mensagens diretas"),
    React.createElement("p", null, "Importe a conta em Integração Zernio → Buscar contas na Zernio. Requisitos de conta e formato: a conferir com a conta real."),
    React.createElement("p", null, google ? "As avaliações ficam em Avaliações → Google. Não criam linha de atendimento, conversa ou contato." : "O cliente inicia a conversa. Janela de 48 horas e até dez envios ou tentativas nos últimos 48 horários corridos."));
}

function EmailHeader(props: ConversationSlotProps) {
  if (props.conversation.channel !== "email") return null;
  const metadata = channelMetadata(props.conversation, props.detail);
  return React.createElement(React.Fragment, null,
    React.createElement(EmailConversationFields, props),
    React.createElement(ChannelDeliveryNotice, { state: metadata.state, code: metadata.state }));
}

function TelegramHeader(props: ConversationSlotProps) {
  if (props.conversation.channel !== "telegram") return null;
  const metadata = channelMetadata(props.conversation, props.detail);
  return React.createElement(React.Fragment, null,
    React.createElement(TelegramConversationInfo, props),
    React.createElement(ChannelDeliveryNotice, { state: metadata.state, code: metadata.state }));
}

/** Objetos estáveis: repetir a instalação é seguro e não substitui descritores. */
export const C2_UI_EXTENSIONS: readonly ChannelUiExtension[] = [
  ...(["instagram/comment", "facebook/comment"] as const).map(key => ({
    key, connectionFields: CommentConnectionFields, prepareConnection: prepareCommentConnection,
    conversationHeader: CommentsPanel, composerFields: CommentComposerFields,
    messageMetadata: ChannelMessageMeta, prepareAction: prepareCommentAction,
  })),
  { key: "telegram/direct", connection: { channel: "telegram", kind: "telegram_bot", label: "Telegram · bot próprio" },
    connectionFields: TelegramConnectionFields, prepareConnection: prepareTelegramConnection,
    conversationHeader: TelegramHeader, composerFields: TelegramComposerFields, messageMetadata: ChannelMessageMeta,
    contactActions: ContactChannelActions, prepareAction: prepareTelegramAction },
  { key: "email/direct", connection: { channel: "email", kind: "email", label: "E-mail · endereço próprio" },
    connectionFields: EmailConnectionFields, prepareConnection: prepareEmailConnection,
    conversationHeader: EmailHeader, composerFields: EmailComposerFields,
    messageMetadata: ChannelMessageMeta, contactActions: ContactChannelActions, prepareAction: prepareEmailAction },
  { key: "tiktok/direct", connectionFields: ImportedConnectionFields, conversationHeader: TikTokQuota,
    composerFields: TikTokComposerFields, messageMetadata: ChannelMessageMeta, prepareAction: prepareTikTokAction },
  { key: "googlebusiness/review", connectionFields: ImportedConnectionFields },
];

/** Chamado sob demanda antes de expor o status da área; importar não instala. */
export function installC2Web(): void {
  for (const extension of C2_UI_EXTENSIONS) registerChannelUi(extension);
  registerReviewsPage(GoogleReviewsPage);
  registerChannelDemo(c2DemoHandler);
}

export const registerC2Web = installC2Web;
