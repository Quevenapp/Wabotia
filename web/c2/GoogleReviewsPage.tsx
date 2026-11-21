import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ChannelAction } from "../../src/channel-c2-contracts";
import type { ChannelUiApi, ChannelUiData, ReviewsPageProps } from "../channel-extension-contracts";

const object = (value: unknown): ChannelUiData => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ChannelUiData : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const date = (value: unknown): string => typeof value === "number" && Number.isFinite(value)
  ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "Data não informada";

/** Flags são projeções da autorização do servidor; ausência nunca concede publicação. */
export function reviewAccess(value: unknown) {
  const row = object(value), permissions = object(row.permissions ?? row);
  const admin = permissions.is_admin === true;
  return { read: admin || permissions.can_read === true, publish: admin || (permissions.can_read === true && permissions.can_reply === true), admin };
}

export function uniqueReviews(value: unknown): ChannelUiData[] {
  const result = new Map<string, ChannelUiData>();
  for (const item of Array.isArray(value) ? value : []) {
    const row = object(item), id = text(row.id);
    if (!id || !Number.isSafeInteger(row.version) || Number(row.version) <= 0) continue;
    if (Number(result.get(id)?.version ?? 0) <= Number(row.version)) result.set(id, row);
  }
  return [...result.values()];
}

export function prepareReviewReply(review: ChannelUiData, value: string, permission: unknown, operation: "reply" | "delete" | "suggest" = "reply"): ChannelAction {
  if (!reviewAccess(permission).publish) throw new Error("Sem permissão para publicar resposta no Google.");
  if (review.state !== "active" || !Number.isSafeInteger(review.version) || Number(review.version) < 1) throw new Error("Atualize a avaliação antes de responder.");
  if (["pending", "reserved", "sending", "retry", "unknown", "indeterminate"].includes(text(review.reply_state))) throw new Error("Aguarde ou reconcilie a publicação anterior.");
  const version = Number(review.version);
  if (operation === "suggest") return { type: "google.suggest", version };
  if (operation === "delete") return { type: "google.reply.delete", version };
  if (!value.trim() || value.length > 4_000) throw new Error("A resposta deve ter de 1 a 4.000 caracteres, limite do Vinki.");
  return { type: "google.reply", version, text: value };
}

export function reviewReplyState(value: unknown): string | null {
  return ({ pending: "Publicação pendente de confirmação.", reserved: "Publicação pendente de confirmação.", sending: "Publicação em andamento; aguarde confirmação.",
    sent: "Resposta publicada.", failed: "Publicação falhou; confira o estado antes de uma nova ação.",
    retry: "Aguardando o intervalo permitido para publicar.", unknown: "Publicação indeterminada. Não repetir automaticamente; reconciliação necessária.",
    indeterminate: "Publicação indeterminada. Não repetir automaticamente; reconciliação necessária." } as Record<string, string>)[text(value)] ?? null;
}

type ReviewCardProps = { row: ChannelUiData; permissions: ChannelUiData; api: ChannelUiApi; root: string; report: boolean; refresh(): Promise<void> };

function ReviewCard({ row, permissions, api, root, report, refresh }: ReviewCardProps) {
  const [reply, setReply] = useState(text(row.reply_text)), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [suggestion, setSuggestion] = useState("");
  const [submitted, setSubmitted] = useState<{ version: number; state: string } | null>(null);
  const pending = useRef<{ key: string; action: ChannelAction } | null>(null);
  const localState = submitted && Number(row.version) <= submitted.version ? submitted.state : "";
  const replyState = localState || text(row.reply_state);
  const access = reviewAccess(permissions), blocked = ["pending", "reserved", "sending", "retry", "unknown", "indeterminate"].includes(replyState);
  const canPublish = access.publish && row.state === "active" && !blocked;
  const locked = busy || !!pending.current;
  async function perform(operation: "reply" | "delete" | "suggest") {
    if (busy || !canPublish || (operation !== "suggest" && !confirmed)) return;
    setBusy(true); setNotice("");
    try {
      if (!pending.current) pending.current = { key: crypto.randomUUID(), action: prepareReviewReply(row, reply, permissions, operation) };
      const action = pending.current.action, path = `${root}/c2/reviews/${encodeURIComponent(text(row.id))}`;
      const isSuggestion = action.type === "google.suggest";
      const body = "version" in action ? { version: action.version, ...("text" in action ? { text: action.text } : {}) } : {};
      const response = object(await api(`${path}/${isSuggestion ? "suggestion" : "reply"}`, isSuggestion ? "POST" : action.type === "google.reply.delete" ? "DELETE" : "PUT", body, undefined, pending.current.key));
      pending.current = null;
      if (isSuggestion) {
        setSuggestion(text(response.suggestion));
        setNotice("Sugestão pronta. Revise antes de usar na resposta pública.");
      } else {
        if ("version" in action) setSubmitted({ version: action.version, state: text(response.status) || "pending" });
        setConfirmed(false);
        setNotice(reviewReplyState(response.status) ?? "Publicação solicitada; aguarde confirmação.");
      }
      await refresh();
    } catch {
      setNotice(pending.current ? "Não foi possível confirmar a ação. O mesmo pedido será usado na próxima tentativa." : "Revise a permissão, a versão e o tamanho da resposta antes de publicar.");
    } finally { setBusy(false); }
  }
  return <article className="c2-review">
    <h3>{text(row.account_label) || text(row.account_id) || "Conta Google"} · {Number(row.rating) >= 1 && Number(row.rating) <= 5 ? Number(row.rating) : "—"} estrelas</h3>
    <p>{text(row.author_name) || "Autor não informado"} · {date(row.published_at)} (Brasília)</p>
    <p className="c2-text">{text(row.text) || "Avaliação sem texto."}</p>
    <p>{row.state === "deleted" ? "Avaliação excluída no Google." : row.restored === true ? "Avaliação restaurada no Google." : "Avaliação ativa."}</p>
    {row.reply_text ? <div><strong>Resposta atual</strong><p className="c2-text">{text(row.reply_text)}</p><p>{date(row.reply_at)}</p></div> : <p>Sem resposta publicada.</p>}
    {reviewReplyState(replyState) && <p role="status">{reviewReplyState(replyState)}</p>}
    {!report && !access.publish && <p>Você pode consultar esta avaliação, mas não tem permissão para publicar.</p>}
    {!report && access.publish && <div className="c2-review-editor">
      <label>Resposta pública<textarea value={reply} maxLength={4_000} disabled={!canPublish || locked} onChange={event => { setReply(event.target.value); setConfirmed(false); }} /></label>
      <p>{reply.length} de 4.000 caracteres · limite do Vinki</p>
      <label><input type="checkbox" checked={confirmed} disabled={!canPublish || locked} onChange={event => setConfirmed(event.target.checked)} /> Revisei o texto e confirmo a ação pública no Google.</label>
      <div className="c2-actions">
        <button type="button" disabled={!canPublish || locked || !confirmed || !reply.trim()} onClick={() => void perform("reply")}>{row.reply_text ? "Substituir resposta" : "Publicar resposta"}</button>
        <button type="button" disabled={!canPublish || locked || !confirmed || !row.reply_text} onClick={() => void perform("delete")}>Apagar resposta</button>
        <button type="button" disabled={!canPublish || locked} onClick={() => void perform("suggest")}>Sugerir texto com IA</button>
        {pending.current && <button type="button" disabled={busy || !canPublish} onClick={() => void perform(pending.current?.action.type === "google.suggest" ? "suggest" : pending.current?.action.type === "google.reply.delete" ? "delete" : "reply")}>Tentar confirmar novamente</button>}
      </div>
      {suggestion && <div><p className="c2-text">{suggestion}</p><button type="button" disabled={locked || !canPublish} onClick={() => { setReply(suggestion.slice(0, 4_000)); setConfirmed(false); }}>Usar sugestão e revisar</button></div>}
    </div>}
    {notice && <p role="status">{notice}</p>}
  </article>;
}

function GoogleAdministration({ api, root, refresh, publishers }: { api: ChannelUiApi; root: string; refresh(): Promise<void>; publishers: unknown }) {
  const [userId, setUserId] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const pending = useRef<{ key: string; path: string; method: string } | null>(null);
  async function perform(path: string, method: string) {
    if (busy) return;
    if (!pending.current) pending.current = { key: crypto.randomUUID(), path, method };
    setBusy(true); setNotice("");
    try {
      await api(pending.current.path, pending.current.method, {}, undefined, pending.current.key);
      pending.current = null;
      setNotice("Solicitação confirmada. As permissões são reconferidas pelo servidor antes de publicar.");
      await refresh();
    } catch { setNotice("Não foi possível confirmar a solicitação. Tente novamente com o mesmo pedido."); }
    finally { setBusy(false); }
  }
  const locked = busy || !!pending.current;
  return <section className="c2-panel" aria-label="Administração de publicação Google">
    <h3>Quem pode responder no Google</h3>
    <p>A concessão google.reply permite publicar a pessoas que também têm acesso a Avaliações nesta área.</p>
    <label>Identificador da pessoa<input value={userId} disabled={locked} onChange={event => setUserId(event.target.value)} /></label>
    <div className="c2-actions"><button type="button" disabled={locked || !userId.trim()} onClick={() => void perform(`${root}/c2/review-publishers/${encodeURIComponent(userId.trim())}`, "PUT")}>Conceder publicação</button>
      <button type="button" disabled={locked || !userId.trim()} onClick={() => void perform(`${root}/c2/review-publishers/${encodeURIComponent(userId.trim())}`, "DELETE")}>Remover concessão</button>
      <button type="button" disabled={locked} onClick={() => void perform(`${root}/c2/reviews/sync`, "POST")}>Reconciliar avaliações</button>
      {pending.current && <button type="button" disabled={busy} onClick={() => pending.current && void perform(pending.current.path, pending.current.method)}>Tentar confirmar novamente</button>}
    </div>
    {Array.isArray(publishers) && <ul>{publishers.map(object).filter(row => text(row.user_id)).map(row => <li key={text(row.user_id)}>{text(row.name) || text(row.user_id)}</li>)}</ul>}
    <p>A reconciliação considera a ativação e não importa histórico anterior.</p>
    {notice && <p role="status">{notice}</p>}
  </section>;
}

/** A navegação Atendimento/Google pertence ao slot da base; sem Google não há DOM nem requisição. */
export function GoogleReviewsPage(props: ReviewsPageProps) {
  const active = Array.isArray(props.status.connected_channels) && props.status.connected_channels.includes("googlebusiness");
  const [snapshot, setSnapshot] = useState<ChannelUiData>(() => object(props.status.google_reviews));
  const [snapshotRoot, setSnapshotRoot] = useState(props.root);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const generation = useRef(0);
  const load = useCallback(async (cursor = "", signal?: AbortSignal) => {
    if (!active) return;
    const request = ++generation.current;
    setBusy(true); setError("");
    try {
      const response = object(await props.api(`${props.root}/c2/reviews${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, "GET", undefined, signal));
      if (signal?.aborted || request !== generation.current) return;
      setSnapshotRoot(props.root);
      setSnapshot(previous => ({ ...response, data: uniqueReviews(cursor ? [...uniqueReviews(previous.data), ...uniqueReviews(response.data)] : response.data) }));
    } catch {
      if (!signal?.aborted && request === generation.current) setError("Não foi possível carregar as avaliações. Atualize para reconfirmar seu acesso.");
    } finally { if (!signal?.aborted && request === generation.current) setBusy(false); }
  }, [active, props.api, props.root]);
  useEffect(() => {
    setSnapshotRoot(props.root);
    setSnapshot(object(props.status.google_reviews));
    if (!active) return;
    const controller = new AbortController();
    void load("", controller.signal);
    return () => { controller.abort(); ++generation.current; };
  }, [load, active, props.root, props.status.google_reviews]);
  if (!active) return null;
  const current = snapshotRoot === props.root ? snapshot : {};
  const access = reviewAccess(current), rows = uniqueReviews(current.data), cursor = text(current.next_cursor);
  const refresh = () => load();
  return <section className="c2-reviews" aria-label={props.mode === "report" ? "Relatório de avaliações Google" : "Avaliações Google"}>
    <h2>{props.mode === "report" ? "Relatório · Google" : "Avaliações · Google"}</h2>
    <p>Avaliações não criam contato nem conversa. Publicações dependem de autorização específica.</p>
    {busy && <p role="status">Carregando avaliações…</p>}
    {error && <p role="alert">{error}</p>}
    {!access.read && !busy && <p>O acesso a Avaliações ainda não foi confirmado pelo servidor.</p>}
    {access.read && <>
      {current.partial === true && <p role="status">Página parcial: avaliações ausentes não são consideradas excluídas. A reconciliação continua pendente.</p>}
      {!rows.length && !busy && <p>Nenhuma avaliação Google disponível.</p>}
      {rows.map(row => <ReviewCard key={`${props.root}:${text(row.id)}`} row={row} permissions={error ? {} : current} api={props.api} root={props.root} report={props.mode === "report"} refresh={refresh} />)}
      {cursor && <button type="button" disabled={busy} onClick={() => void load(cursor)}>Carregar mais avaliações</button>}
      {access.admin && !error && props.mode === "reviews" && <GoogleAdministration key={props.root} api={props.api} root={props.root} refresh={refresh} publishers={current.publishers} />}
    </>}
    <button type="button" disabled={busy} onClick={() => void load()}>Atualizar avaliações</button>
  </section>;
}
