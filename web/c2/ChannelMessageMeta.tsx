import React from "react";
import type { MessageSlotProps } from "../channel-extension-contracts";
import { channelUiKey } from "../channel-extensions";
import { ChannelDeliveryNotice, uiRecord, uiText } from "./ChannelMarks";

const warningLabels: Readonly<Record<string, string>> = {
  attachment_too_large: "Anexo acima do limite: o texto foi preservado.",
  attachment_rejected: "Anexo recusado pela política de arquivos.",
  callback_expired: "Este botão venceu. Solicite um novo menu.",
  contact_not_self: "Telefone de terceiro: não serve como prova nem sugestão de junção.",
  blocked: "O cliente bloqueou o bot. O envio está indisponível.",
  rate_limited: "O Telegram pediu uma pausa antes do próximo envio.",
};

export function messageWarnings(content: MessageSlotProps["content"]): string[] {
  const email = uiRecord(content.email), telegram = uiRecord(content.telegram);
  const warnings = [
    ...(Array.isArray(email.attachmentWarnings) ? email.attachmentWarnings : []),
    ...(Array.isArray(content.warnings) ? content.warnings : []),
    telegram.warning,
    telegram.callbackState === "expired" ? "callback_expired" : undefined,
    telegram.contactState === "not_self" ? "contact_not_self" : undefined,
  ];
  return [...new Set(warnings.flatMap(value => {
    const code = typeof value === "string" ? value : uiRecord(value).code;
    const label = typeof code === "string" ? warningLabels[code] ?? uiText(code, 500) : "";
    return label ? [label] : [];
  }))];
}

export function emailMessageSubject(props: MessageSlotProps): string | null {
  if (props.conversation.channel !== "email") return null;
  const subject = uiText(uiRecord(props.content.email).subject ?? props.content.subject, 200);
  const previousContent = uiRecord(props.previousMessage?.content);
  const previous = uiText(uiRecord(previousContent.email).subject ?? previousContent.subject, 200);
  return subject && (!props.previousMessage || previous !== subject) ? subject : null;
}

/** Metadados são nós de texto; nunca HTML, imagens remotas ou links de cabeçalhos. */
export function ChannelMessageMeta(props: MessageSlotProps) {
  const key = channelUiKey(props.conversation);
  if (!key || (props.previousMessage?.id && props.previousMessage.id === props.message.id)) return null;
  const email = uiRecord(props.content.email), comment = uiRecord(props.content.comment);
  const subject = emailMessageSubject(props);
  const warnings = messageWarnings(props.content);
  const auth = Array.isArray(email.authentication) ? email.authentication.slice(0, 12) : [];
  const authentication = [...new Set(auth.flatMap(value => {
    const row = uiRecord(value), method = uiText(row.method, 50), result = uiText(row.result, 150);
    return method && result ? [`${method}: ${result}`] : [];
  }))];
  const attachments = key === "email/direct" && Array.isArray(props.content.safeAttachments)
    ? [...new Set(props.content.safeAttachments.slice(0, 32).flatMap(value => {
      const row = uiRecord(value), name = uiText(row.name, 200);
      return name && ["accepted", "rejected"].includes(String(row.state))
        ? [`${row.state === "accepted" ? "Anexo aceito" : "Anexo recusado"}: ${name}`] : [];
    }))] : [];
  const state = props.message.delivery_state ?? props.content.deliveryState;
  const hasEmail = key === "email/direct" && !!(subject || authentication.length || email.from || email.replyTo || email.sender);
  const hasComment = key.endsWith("/comment") && !!comment.id;
  if (!hasEmail && !hasComment && !warnings.length && !attachments.length && !["unknown", "pending", "failed", "retry", "sending"].includes(String(state))) return null;
  return <aside className="c2-message-meta" aria-label="Metadados do canal">
    {subject && <p className="c2-subject"><strong>Assunto:</strong> {subject}</p>}
    {hasEmail && <>
      {email.sender ? <p>Remetente do envelope: {uiText(email.sender, 320)}</p> : null}
      {email.from && email.from !== email.sender ? <p>From recebido: {uiText(email.from, 320)}</p> : null}
      {email.replyTo && email.replyTo !== email.sender ? <p>Reply-To recebido: {uiText(email.replyTo, 320)}. O destino não muda automaticamente.</p> : null}
      {!!authentication.length && <p>Autenticação recebida, não confiada: {authentication.join("; ")}. Não confirma a identidade da pessoa.</p>}
    </>}
    {hasComment && <p>Comentário {uiText(comment.id, 200)} · {comment.hidden === true ? "Oculto" : "Visível"}{comment.privateState === "unknown" ? " · Tentativa privada consumida; resultado indeterminado" : ""}</p>}
    {warnings.map(warning => <p className="c2-notice" key={warning}>{warning}</p>)}
    {attachments.map(attachment => <p key={attachment}>{attachment}</p>)}
    <ChannelDeliveryNotice state={state} code={props.content.errorCode} />
  </aside>;
}
