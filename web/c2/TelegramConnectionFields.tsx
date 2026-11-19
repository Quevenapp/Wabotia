import React, { useRef, useState } from "react";
import type { ChannelUiData, ComposerSlotProps, ConnectionFieldsProps, ConversationSlotProps } from "../channel-extension-contracts";

const object = (value: unknown): ChannelUiData => value && typeof value === "object" && !Array.isArray(value) ? value as ChannelUiData : {};
const text = (value: unknown) => typeof value === "string" ? value : "";

export function prepareTelegramConnection(form: ChannelUiData) {
  // Somente o campo escrito nesta submissão é credencial de entrada.
  const token = text(form.c2_new_bot_token).trim();
  if (token && /[\r\n\u0000]/.test(token)) throw new Error("Revise o token do bot.");
  return { config: { c2_enabled: true }, secrets: token ? { bot_token: token } : {} };
}

export function telegramBotLink(username: unknown): string | null {
  return typeof username === "string" && /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username.replace(/^@/, ""))
    ? `https://t.me/${username.replace(/^@/, "")}` : null;
}

export function TelegramConnectionFields(props: ConnectionFieldsProps) {
  if (props.form.channel !== "telegram" && props.form.kind !== "telegram_bot") return null;
  return <TelegramSetupFields key={text(props.form.id)} {...props} />;
}

function TelegramSetupFields({ form, change, disabled, api, root }: ConnectionFieldsProps) {
  const [token, setToken] = useState("");
  const [setup, setSetup] = useState<ChannelUiData>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const config = object(form.config), state = text(setup.status || form.status);
  const configured = setup.configured === true || form.configured === true || form.credential === "configurado";
  const link = telegramBotLink(form.username ?? config.username ?? config.bot_username);
  async function check() {
    if (!form.id || busy) return;
    setBusy(true); setError("");
    try { setSetup(object(await api(`${root}/c2/connections/${encodeURIComponent(text(form.id))}/setup`))); }
    catch { setError("Não foi possível consultar a configuração. Tente novamente."); }
    finally { setBusy(false); }
  }
  return <section className="c2-connection-fields c2-telegram-setup" aria-label="Conexão Telegram">
    <p>Crie um bot no <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">BotFather</a> e informe o token ao salvar. O cliente inicia uma conversa privada com o bot; grupos não são atendidos.</p>
    <label>{form.id ? "Novo token do bot (opcional)" : "Token do bot"}<input type="password" autoComplete="new-password" value={token}
      disabled={disabled} required={!form.id} onChange={event => { setToken(event.target.value); change("c2_new_bot_token")(event.target.value); }} /></label>
    <p>Token: {configured ? "configurado" : "aguardando configuração"}. Segredo do webhook: {configured ? "configurado" : "aguardando configuração"}.</p>
    {link && <p><a href={link} target="_blank" rel="noopener noreferrer">Abrir bot no Telegram</a></p>}
    <p>{state === "removal_pending" ? "Remoção pendente. Entradas e envios estão pausados até concluir a limpeza do webhook."
      : state === "active" ? "Conexão ativa. Confira o estado do webhook ao testar a conexão."
        : "Conexão pendente ou pausada. Salvar e testar confirma o bot e configura o webhook."}</p>
    <p>Trocar o token deve manter o mesmo bot. Para outro bot, crie outra conexão.</p>
    {!!form.id && <button type="button" disabled={disabled || busy} onClick={() => void check()}>Consultar configuração</button>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function telegramMetadata(conversation: ChannelUiData, detail: ChannelUiData = {}) {
  return object(object(object(detail.channel_extension ?? conversation.channel_extension).metadata).telegram);
}

export function TelegramConversationInfo({ conversation, detail }: ConversationSlotProps) {
  if (conversation.channel !== "telegram") return null;
  const telegram = telegramMetadata(conversation, detail), suggestion = object(telegram.phoneSuggestion);
  const link = telegramBotLink(telegram.username);
  return <section className="c2-panel c2-telegram-info" aria-label="Telegram">
    {link && <a href={link} target="_blank" rel="noopener noreferrer">Abrir bot no Telegram</a>}
    <p>{telegram.blocked === true ? "O cliente bloqueou o bot. Os envios estão impedidos." : "Telegram · conversa privada, sem janela de atendimento."}</p>
    <p>Webhook: {telegram.webhookConfigured === true ? "configurado" : "pendente"}.</p>
    {text(suggestion.masked) && suggestion.confirmedByHuman === false && <p>Telefone próprio sugerido: {text(suggestion.masked)}. Uma pessoa pode revisar em “Juntar com outro contato” na ficha. Não comprova telefone e não junta contatos automaticamente.</p>}
  </section>;
}

export function TelegramComposerFields(props: ComposerSlotProps) {
  return props.conversation.channel === "telegram" ? <TelegramContactRequest key={text(props.conversation.id)} {...props} /> : null;
}

function TelegramContactRequest({ conversation, detail, disabled, api, root, refresh }: ComposerSlotProps) {
  const [busy, setBusy] = useState(false), [state, setState] = useState("");
  const pending = useRef<string | null>(null);
  const blocked = telegramMetadata(conversation, detail).blocked === true;
  async function request() {
    if (busy || disabled || blocked) return;
    pending.current ??= crypto.randomUUID(); setBusy(true);
    try {
      await api(`${root}/conversations/${encodeURIComponent(text(conversation.id))}/message-actions`, "POST",
        { action: "channel", channel_action: { type: "telegram.request-contact" } }, undefined, pending.current);
      setState("Pedido de telefone pendente de envio. O compartilhamento será uma sugestão para revisão humana.");
      pending.current = null;
    } catch { setState("Não foi possível confirmar o pedido. Tentar novamente conserva a mesma solicitação."); }
    finally { setBusy(false); }
    if (!pending.current) { try { await refresh(); } catch { /* Pedido confirmado: falha de atualização não repete envio. */ } }
  }
  return <div className="c2-fields"><button type="button" disabled={disabled || blocked || busy || state.startsWith("Pedido")}
    onClick={() => void request()}>Pedir compartilhamento do telefone</button>{state && <p role="status">{state}</p>}</div>;
}
