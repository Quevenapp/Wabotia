import React, { useEffect } from "react";
import type { ChannelAction } from "../../src/channel-c2-contracts";
import type { ChannelDraft, ChannelUiData, ComposerSlotProps, ConversationSlotProps } from "../channel-extension-contracts";

const object = (value: unknown): ChannelUiData => value && typeof value === "object" && !Array.isArray(value) ? value as ChannelUiData : {};
const text = (value: unknown) => typeof value === "string" ? value : "";

export function emailMetadata(conversation: ChannelUiData, detail: ChannelUiData = {}): ChannelUiData {
  const extension = object(detail.channel_extension ?? conversation.channel_extension);
  return object(object(extension.metadata).email);
}

export function validateEmailSubject(subject: string): string {
  if (subject.length > 200 || /[\r\n\u0000]/.test(subject)) throw new Error("O assunto deve ter até 200 caracteres, sem quebras de linha.");
  return subject;
}

/** O assunto corrente é operacional; não transforma a conversa em uma thread única. */
export function emailReplySubject(subject: string): string {
  validateEmailSubject(subject);
  const plain = subject.replace(/^(?:\s*re\s*:\s*)+/i, "").trim();
  // Não corta o assunto. Um prefixo que ultrapasse o limite exige edição humana.
  return plain ? `Re: ${plain}` : "";
}

export function prepareEmailAction(draft: ChannelDraft): ChannelAction {
  const metadata = emailMetadata(draft.conversation);
  const subject = typeof draft.fields.subject === "string" ? draft.fields.subject
    : emailReplySubject(text(metadata.subject) || text(draft.conversation.subject));
  validateEmailSubject(subject);
  if (draft.text.length > 50_000) throw new Error("O e-mail deve ter até 50.000 caracteres de texto.");
  if (!draft.text.trim() && !draft.attachmentDetails.length) throw new Error("Escreva uma mensagem ou escolha um anexo.");
  return { type: "email.send", text: draft.text, subject, attachments: draft.attachmentDetails.map(attachment => ({ ...attachment })) };
}

export function EmailComposerFields(props: ComposerSlotProps) {
  return props.conversation.channel === "email" ? <EmailSubjectFields key={text(props.conversation.id)} {...props} /> : null;
}

function EmailSubjectFields({ conversation, detail, draft, disabled, change }: ComposerSlotProps) {
  const incoming = text(emailMetadata(conversation, detail).subject) || text(conversation.subject);
  let defaultSubject = "";
  try { defaultSubject = emailReplySubject(incoming); } catch { defaultSubject = incoming; }
  const value = typeof draft.fields.subject === "string" ? draft.fields.subject : defaultSubject;
  useEffect(() => {
    if (!disabled && typeof draft.fields.subject !== "string") change({ subject: defaultSubject });
  }, [disabled, draft.fields.subject, defaultSubject, change]);
  return <div className="c2-composer-fields c2-email-composer">
    <label>Assunto<input type="text" value={value} maxLength={200} disabled={disabled}
      onChange={event => change({ subject: event.target.value })} aria-label="Assunto do e-mail" /></label>
    <small>{value.length}/200 · Resposta à última entrada apropriada. Confira o assunto antes de enviar.</small>
    {(value.length > 200 || /[\r\n\u0000]/.test(value)) && <p role="alert">Edite o assunto para usar até 200 caracteres, sem quebras de linha.</p>}
    <small>Um destinatário; sem cópia ou cópia oculta. A aceitação do envio não confirma entrega na caixa postal.</small>
  </div>;
}

export function EmailConversationFields({ conversation, detail }: ConversationSlotProps) {
  if (conversation.channel !== "email") return null;
  const email = emailMetadata(conversation, detail);
  return <section className="c2-panel c2-email-info" aria-label="E-mail">
    <strong>Remetente não confirmado</strong>
    <p>O endereço agrupa o atendimento, mas não comprova identidade. O bot não consulta ficha, histórico privado, protocolos ou módulos por e-mail.</p>
    {text(email.sender) && <p>Remetente do envelope: {text(email.sender)}</p>}
    {text(email.from) && email.from !== email.sender && <p>De informado: {text(email.from)}</p>}
    {text(email.replyTo) && email.replyTo !== email.sender && <p>Responder para informado: {text(email.replyTo)}. O destino não muda automaticamente.</p>}
    {Array.isArray(email.authentication) && email.authentication.length > 0 && <>
      <p>Autenticação recebida, não confiada como prova de pessoa:</p>
      <ul>{email.authentication.slice(0, 12).map((entry, index) => {
        const result = object(entry);
        return <li key={index}>{text(result.method).slice(0, 40)}: {text(result.result).slice(0, 100)}</li>;
      })}</ul>
    </>}
    <small>Conteúdo exibido como texto; recursos remotos não são carregados.</small>
  </section>;
}
