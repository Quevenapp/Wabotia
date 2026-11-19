import React, { useRef, useState } from "react";
import type { ChannelAction } from "../../src/channel-c2-contracts";
import type { ChannelDraft, ChannelUiData, ComposerSlotProps, ConnectionFieldsProps, ConversationSlotProps } from "../channel-extension-contracts";

const object = (value: unknown): ChannelUiData => {
  if (typeof value === "string") { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ChannelUiData : {};
};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const isComment = (row: ChannelUiData) => ["instagram", "facebook"].includes(text(row.channel)) &&
  (row.chat_type === "comment" || row.context === "comment" || object(row.channel_context).context === "comment" || text(object(row.channel_extension).key).endsWith("/comment"));

export interface CommentTarget {
  id: string; postId: string; text: string; postText: string; permalink: string;
  hidden: boolean; version: number; privateState: string; privateExpiresAt: number | null;
  privateConversationId: string; privateLinkPending: boolean;
}

/** O DTO normalizado é o único ponto de leitura; nunca interpreta o envelope Zernio. */
export function commentTargets(conversation: ChannelUiData, detail: ChannelUiData = {}): CommentTarget[] {
  if (!isComment(conversation)) return [];
  const metadata = object(object(detail.channel_extension ?? conversation.channel_extension).metadata);
  const messages = Array.isArray(detail.messages) ? detail.messages : [];
  const candidates = [...messages.map(value => object(object(value).content).comment),
    ...(Array.isArray(detail.comments) ? detail.comments : []), metadata.comment];
  const result = new Map<string, CommentTarget>();
  for (const value of candidates) {
    const row = object(value), id = text(row.id);
    if (!id) continue;
    const version = Number.isSafeInteger(row.version) && Number(row.version) > 0 ? Number(row.version) : 1;
    if ((result.get(id)?.version ?? 0) > version) continue;
    result.set(id, { id, postId: text(row.postId), text: text(row.text), postText: text(row.postText), permalink: text(row.permalink),
      hidden: row.hidden === true, version, privateState: text(row.privateState) || "unavailable",
      privateExpiresAt: typeof row.privateExpiresAt === "number" && Number.isFinite(row.privateExpiresAt) ? row.privateExpiresAt : null,
      privateConversationId: text(row.privateConversationId), privateLinkPending: row.privateLinkPending === true });
  }
  return [...result.values()];
}

export function privateReplyAvailability(comment: CommentTarget, now: number): { allowed: boolean; reason: string } {
  if (comment.privateState === "sent") return { allowed: false, reason: comment.privateLinkPending
    ? "Privado enviado; vínculo pendente. Aguarde uma associação confirmada."
    : "Resposta privada enviada. Aguarde uma mensagem real do cliente para abrir atendimento por DM." };
  if (comment.privateState === "reserved") return { allowed: false, reason: "Tentativa privada reservada; envio pendente." };
  if (comment.privateState === "unknown") return { allowed: false, reason: "Resultado privado indeterminado; tentativa consumida. Não repetir automaticamente." };
  if (comment.privateState === "failed") return { allowed: false, reason: "Resposta privada falhou; tentativa consumida." };
  if (comment.privateState !== "available") return { allowed: false, reason: "Disponibilidade da resposta privada não confirmada." };
  if (comment.privateExpiresAt === null) return { allowed: false, reason: "Sem data válida para confirmar o prazo da resposta privada." };
  if (comment.privateExpiresAt <= now) return { allowed: false, reason: "Prazo de 168 horas encerrado para responder em privado." };
  return { allowed: true, reason: `Uma tentativa privada disponível até ${new Date(comment.privateExpiresAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} (Brasília).` };
}

function publicationLink(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)(instagram\.com|facebook\.com|fb\.com)$/.test(url.hostname) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function CommentsPanel(props: ConversationSlotProps) {
  const comments = commentTargets(props.conversation, props.detail);
  if (!isComment(props.conversation)) return null;
  const comment = comments[0], link = publicationLink(comment?.permalink ?? "");
  return <section className="c2-panel c2-comments" aria-label="Contexto do comentário">
    <strong>Comentário</strong>
    {comment?.postText && <p className="c2-text">{comment.postText}</p>}
    {link && <a href={link} target="_blank" rel="noopener noreferrer">Abrir publicação</a>}
    <p>Respostas públicas são revisadas e enviadas por uma pessoa. O bot não responde comentários.</p>
    {!comment && <p role="status">Aguardando o contexto confirmado do comentário.</p>}
    {comments.map(item => <div className="c2-comment-state" key={item.id}>
      <p className="c2-text">{item.text}</p>
      <p>{item.hidden ? "Comentário oculto" : "Comentário visível"}</p>
      <p>{privateReplyAvailability(item, props.now).reason}</p>
    </div>)}
  </section>;
}

export function prepareCommentAction(draft: ChannelDraft): ChannelAction {
  if (!isComment(draft.conversation)) throw new Error("Esta conversa não é de comentários.");
  const commentId = text(draft.fields.commentId), mode = draft.fields.mode;
  if (!commentId || !["public", "private"].includes(text(mode))) throw new Error("Escolha o comentário alvo e a resposta pública ou privada.");
  if (!draft.text.trim()) throw new Error("Escreva a resposta ao comentário.");
  if (draft.attachments.length || draft.attachmentDetails.length || draft.pendingAttachments?.length) throw new Error("Comentários aceitam somente texto.");
  const candidates = commentTargets(draft.conversation, { comments: [draft.fields.selectedComment] });
  const target = candidates.find(comment => comment.id === commentId);
  if (candidates.length && !target) throw new Error("Escolha um comentário desta conversa.");
  if (mode === "private") {
    if (!target) throw new Error("Atualize o comentário para confirmar a disponibilidade da resposta privada.");
    const availability = privateReplyAvailability(target, Date.now());
    if (!availability.allowed) throw new Error(availability.reason);
  }
  return { type: mode === "private" ? "comment.private" : "comment.reply", commentId, text: draft.text };
}

export function CommentComposerFields(props: ComposerSlotProps) {
  return isComment(props.conversation) ? <CommentComposer key={`${props.root}:${text(props.conversation.id)}`} {...props} /> : null;
}

function CommentComposer(props: ComposerSlotProps) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [suggestion, setSuggestion] = useState("");
  const pending = useRef<{ key: string; action: ChannelAction } | null>(null);
  const comments = commentTargets(props.conversation, props.detail);
  if (!isComment(props.conversation)) return null;
  const selected = comments.find(item => item.id === props.draft.fields.commentId);
  const availability = selected ? privateReplyAvailability(selected, props.now) : null;
  const locked = props.disabled || busy || pending.current !== null;
  async function perform(action: ChannelAction) {
    if (props.disabled || busy) return;
    if (!pending.current) pending.current = { key: crypto.randomUUID(), action: structuredClone(action) };
    setBusy(true); setNotice("");
    try {
      const result = object(await props.api(`${props.root}/conversations/${encodeURIComponent(text(props.conversation.id))}/message-actions`, "POST",
        { action: "channel", channel_action: pending.current.action }, undefined, pending.current.key));
      const wasSuggestion = pending.current.action.type === "comment.suggest";
      if (wasSuggestion) setSuggestion(text(result.suggestion));
      pending.current = null;
      setNotice(wasSuggestion ? "Sugestão pronta para revisão. Copie o texto revisado para o campo de mensagem." : "Alteração solicitada; aguarde a confirmação do canal.");
    } catch {
      setNotice("Não foi possível confirmar a ação. Tente novamente com o mesmo pedido.");
    } finally { setBusy(false); }
    if (!pending.current) { try { await props.refresh(); } catch { /* A ação confirmada não deve ser enviada novamente. */ } }
  }
  return <section className="c2-panel c2-comment-composer" aria-label="Resposta ao comentário">
    <label>Comentário alvo<select value={text(props.draft.fields.commentId)} disabled={locked}
      onChange={event => props.change({ ...props.draft.fields, commentId: event.target.value,
        selectedComment: comments.find(comment => comment.id === event.target.value) })}>
      <option value="">Escolha um comentário</option>
      {comments.map(item => <option key={item.id} value={item.id}>{item.text.slice(0, 120) || "Comentário sem texto"}</option>)}
    </select></label>
    <label>Destino da resposta<select value={text(props.draft.fields.mode)} disabled={locked}
      onChange={event => props.change({ ...props.draft.fields, mode: event.target.value })}>
      <option value="">Escolha público ou privado</option><option value="public">Resposta pública</option>
      <option value="private" disabled={!availability?.allowed}>Chamada privada</option>
    </select></label>
    {availability && <p role="status">{availability.reason}</p>}
    {props.draft.fields.mode === "public" && <p>A mensagem será publicada no comentário selecionado quando você enviar.</p>}
    <div className="c2-actions">
      <button type="button" disabled={locked || !selected} onClick={() => selected && void perform({ type: "comment.visibility", commentId: selected.id, hidden: !selected.hidden })}>
        {selected?.hidden ? "Mostrar comentário" : "Ocultar comentário"}
      </button>
      <button type="button" disabled={locked || !selected} onClick={() => selected && void perform({ type: "comment.suggest", commentId: selected.id, text: props.draft.text })}>Sugerir texto com IA</button>
      {pending.current && <button type="button" disabled={busy || props.disabled} onClick={() => pending.current && void perform(pending.current.action)}>Tentar confirmar novamente</button>}
    </div>
    {suggestion && <label>Sugestão para revisão<textarea className="c2-text" value={suggestion} readOnly /></label>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}

export function prepareCommentConnection(form: ChannelUiData) {
  const config = object(form.config);
  return { config: { comments_enabled: (form.comments_enabled ?? config.comments_enabled) === true }, secrets: {} };
}

export function CommentConnectionFields({ form, change, disabled }: ConnectionFieldsProps) {
  if (!["instagram", "facebook"].includes(text(form.channel))) return null;
  return <section className="c2-panel"><label><input type="checkbox" disabled={disabled}
    checked={prepareCommentConnection(form).config.comments_enabled}
    onChange={event => change("comments_enabled")(event.target.checked)} /> Receber comentários nesta conexão</label>
    <p>Ativação explícita. Respostas públicas e chamadas privadas exigem ação humana; o bot não responde em público.</p>
    <p>Formato do provedor: a conferir com a conta real.</p>
  </section>;
}
