import React, { useRef, useState } from "react";
import type { ChannelUiData, ContactSlotProps } from "../channel-extension-contracts";
import { normalizeChannelEmail } from "./EmailConnectionFields";
import { telegramMetadata } from "./TelegramConnectionFields";

const object = (value: unknown): ChannelUiData => value && typeof value === "object" && !Array.isArray(value) ? value as ChannelUiData : {};
const text = (value: unknown) => typeof value === "string" ? value : "";

export function readyEmailConnections(status: ChannelUiData = {}): readonly ChannelUiData[] {
  return Array.isArray(status.connections) ? status.connections.map(object).filter(connection => connection.channel === "email"
    && connection.status === "active" && (connection.send_ready === true || connection.can_send === true || status.email_send_ready === true)) : [];
}

export function prepareNewEmail(contactId: string, connectionId: string, address: string, confirmed: boolean) {
  if (!contactId || !connectionId || !confirmed) throw new Error("Confirme o endereço e a conexão antes de abrir o e-mail.");
  return { contactId, connectionId, address: normalizeChannelEmail(address), confirmed: true };
}

export function ContactChannelActions(props: ContactSlotProps) {
  return <ContactActions key={props.contactId} {...props} />;
}

function ContactActions(props: ContactSlotProps) {
  const { contact, conversation, extensionKeys = [], status: loadedStatus = {}, api, root, refresh } = props;
  // A ficha da demonstração não possui sessão de perfil; usa somente a fixture carregada.
  const status = props.demo === true && !loadedStatus.connections
    ? { ...object(contact.channel_status), ...loadedStatus } : loadedStatus;
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [address, setAddress] = useState(text(contact.email)), [connectionId, setConnectionId] = useState("");
  const [confirmed, setConfirmed] = useState(false), [conversationId, setConversationId] = useState("");
  const [unknown, setUnknown] = useState(false);
  const pending = useRef<{ key: string; body: ReturnType<typeof prepareNewEmail> } | null>(null);
  const enabled = extensionKeys.includes("email/direct") || (Array.isArray(status.channel_extensions) && status.channel_extensions.includes("email/direct"))
    || conversation?.channel === "email" || props.channels.some(channel => channel.channel === "email");
  const telegram = conversation?.channel === "telegram" ? telegramMetadata(conversation) : {};
  const suggestion = object(telegram.phoneSuggestion), hasSuggestion = text(suggestion.masked) && suggestion.confirmedByHuman === false;
  if (!enabled && !hasSuggestion) return null;
  const connections = readyEmailConnections(status);
  const allowed = contact.readable !== false && contact.can_reply !== false && status.can_reply !== false
    && (status.can_reply === true || contact.can_reply === true);
  const selected = connectionId || text(connections[0]?.id);
  async function create() {
    if (busy || unknown || !allowed || !connections.some(connection => connection.id === selected)) return;
    try {
      pending.current ??= { key: crypto.randomUUID(), body: prepareNewEmail(props.contactId, selected, address, confirmed) };
    } catch { setNotice("Confira e confirme um único endereço de e-mail antes de continuar."); return; }
    setBusy(true); setNotice("");
    try {
      const result = object(await api(`${root}/c2/conversations/email`, "POST", pending.current.body, undefined, pending.current.key));
      setConversationId(text(result.conversation_id ?? result.id));
      setUnknown(result.status === "unknown");
      setNotice(result.status === "unknown" ? "Resultado indeterminado. Confira o atendimento antes de repetir a operação." : "Conversa de e-mail preparada. Abra o atendimento para escrever a mensagem.");
      pending.current = null; setOpen(false);
    } catch { setNotice("Não foi possível confirmar a abertura. Tentar novamente conserva o endereço e a mesma solicitação."); }
    finally { setBusy(false); }
    if (!pending.current) { try { await refresh(); } catch { /* A abertura confirmada não deve virar outra mutação. */ } }
  }
  return <section className="c2-panel c2-contact-actions" aria-label="Ações dos canais">
    {hasSuggestion && <p>Telefone próprio sugerido: {text(suggestion.masked)}. Revise em “Juntar com outro contato” nesta ficha. O compartilhamento não comprova telefone e não faz junção automática.</p>}
    {enabled && <>
      <button type="button" disabled={!allowed || !connections.length || busy || unknown} onClick={() => setOpen(true)}>Novo e-mail</button>
      {!allowed && <p>É necessária permissão de responder para abrir um novo e-mail.</p>}
      {!connections.length && <p>O envio aguarda uma conexão de e-mail pronta e a confirmação da configuração de envio.</p>}
      {open && <div className="c2-fields">
        <label>Conexão de envio<select value={selected} disabled={busy || !!pending.current} onChange={event => { setConnectionId(event.target.value); setConfirmed(false); }}>
          {connections.map(connection => <option key={text(connection.id)} value={text(connection.id)}>{text(connection.name) || "E-mail"}</option>)}
        </select></label>
        <label>Endereço destinatário<input type="email" value={address} disabled={busy || !!pending.current}
          onChange={event => { setAddress(event.target.value); setConfirmed(false); }} /></label>
        <label><input type="checkbox" checked={confirmed} disabled={busy || !!pending.current} onChange={event => setConfirmed(event.target.checked)} /> Confirmo o endereço {address}</label>
        <p>O endereço não comprova identidade nem junta contatos automaticamente. Nenhuma transcrição é anexada.</p>
        <button type="button" disabled={busy || !confirmed} onClick={() => void create()}>{pending.current ? "Tentar confirmar novamente" : "Abrir conversa de e-mail"}</button>
        {!pending.current && <button type="button" disabled={busy} onClick={() => setOpen(false)}>Cancelar</button>}
      </div>}
    </>}
    {notice && <p role="status">{notice}</p>}
    {conversationId && <a href={`/app/conversas/${encodeURIComponent(conversationId)}`}>Abrir conversa de e-mail</a>}
  </section>;
}
