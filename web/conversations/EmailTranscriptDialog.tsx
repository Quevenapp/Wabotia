import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  TranscriptDestination, TranscriptOptions, TranscriptPreview,
  TranscriptPreviewRequest, TranscriptRange, TranscriptSendRequest, TranscriptSendResult,
} from "../../src/channel-contracts";
import { useApp } from "../app/AppContext";
import type { Api } from "../lib/api";
import { date } from "../lib/format";
import { Button, Dialog, Notice } from "../ui";

/** A disponibilidade vem do servidor. A ausência conserva servidores antigos. */
export function transcriptAction(options?: TranscriptOptions | null) {
  const denied = /^(access_denied|forbidden|permission_denied|unauthorized|not_authorized)$/.test(options?.reason || "")
    || /sem permiss[aã]o|n[aã]o autorizad/i.test(options?.reason || "");
  const reason = !options || denied ? null : options.available ? null
    : /config|email_disabled/i.test(options.reason || "")
      ? "Configure o envio em Gestão → Sistema → E-mail."
      : options.reason === "channel_not_ready"
        ? "O envio de transcrições ainda não está disponível neste servidor."
      : options.reason || "Envio de transcrição indisponível nesta conversa.";
  return {
    visible: !!options && !denied,
    enabled: !!options?.available && !denied && !!options.destinations?.length && !!options.ranges?.length,
    reason,
  };
}

export type TranscriptFormValues = {
  destination: TranscriptDestination["kind"];
  address: string;
  range: TranscriptRange["kind"];
  from: string;
  to: string;
};

export function transcriptPreviewRequest(values: TranscriptFormValues, options: TranscriptOptions): TranscriptPreviewRequest {
  if (!transcriptAction(options).enabled) throw new Error(transcriptAction(options).reason || "Envio não autorizado.");
  if (!options.destinations.includes(values.destination)) throw new Error("Destino não autorizado.");
  if (!options.ranges.includes(values.range)) throw new Error("Selecione um intervalo permitido.");
  const address = values.address.trim();
  if (values.destination === "custom" && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(address))
    throw new Error("Informe um único endereço de e-mail válido.");
  const from = Date.parse(values.from), to = Date.parse(values.to);
  if (values.range === "dates" && (!Number.isFinite(from) || !Number.isFinite(to) || from > to))
    throw new Error("Informe o início e o fim de um intervalo válido.");
  return {
    destination: values.destination === "custom" ? { kind: "custom", address } : { kind: values.destination },
    range: values.range === "dates" ? { kind: "dates", from, to } : { kind: "session" },
  };
}

/** O cliente só confirma o destino; a seleção e a autorização são refeitas no servidor. */
export function transcriptSendRequest(
  preview: TranscriptPreview, confirmedRecipient: string, customerRequested: boolean, now: number,
  destination?: TranscriptDestination["kind"],
): TranscriptSendRequest {
  if (!preview.previewToken || !Number.isFinite(preview.expiresAt) || now >= preview.expiresAt)
    throw new Error("A prévia expirou. Gere uma nova prévia antes de enviar.");
  const confirm = preview.requiresConfirmation || destination === "contact" || destination === "custom";
  const requested = preview.requiresCustomerRequest || destination === "contact";
  if (confirm && confirmedRecipient.trim() !== preview.recipient)
    throw new Error("Digite o endereço completo exibido para confirmar o destinatário.");
  if (requested && !customerRequested) throw new Error("Confirme que o cliente solicitou a conversa por e-mail.");
  return {
    previewToken: preview.previewToken,
    ...(confirm ? { confirmedRecipient: preview.recipient } : {}),
    ...(requested ? { customerRequested: true } : {}),
  };
}

/** Uma intenção conserva chave, promessa e recibo, inclusive em cliques repetidos. */
export function createTranscriptSender(api: Api, path: string, makeKey: () => string = () => crypto.randomUUID()) {
  const intents = new Map<string, { key: string; pending?: Promise<TranscriptSendResult>; result?: TranscriptSendResult }>();
  return (body: TranscriptSendRequest): Promise<TranscriptSendResult> => {
    const hash = JSON.stringify(body);
    let intent = intents.get(hash);
    if (!intent) { intent = { key: makeKey() }; intents.set(hash, intent); }
    if (intent.result) return Promise.resolve(intent.result);
    if (intent.pending) return intent.pending;
    const current = intent;
    current.pending = api(path, "POST", body, undefined, current.key).then((result: TranscriptSendResult) => {
      current.result = result;
      return result;
    }).finally(() => { current.pending = undefined; });
    return current.pending;
  };
}

export function transcriptResultText(result: TranscriptSendResult) {
  const labels: Record<TranscriptSendResult["status"], string> = {
    reserved: "Envio reservado. Aguarde a confirmação do servidor.",
    sending: "Envio em andamento. Aguarde a confirmação do servidor.",
    queued: "Envio na fila. Aguarde a confirmação do servidor.",
    sent: "Conversa enviada por e-mail.",
    failed: "O envio falhou. Confira o registro antes de solicitar outro envio.",
    unknown: "Resultado indeterminado. Confira o registro com a equipe antes de solicitar outro envio. Não haverá reenvio automático.",
  };
  return labels[result.status] + (result.duplicate ? " Este pedido já havia sido registrado." : "");
}

export function EmailTranscriptDialog({ conversationId, options, onClose }: {
  conversationId: string;
  options: TranscriptOptions;
  onClose: () => void;
}) {
  const app = useApp();
  const availability = transcriptAction(options);
  if (!availability.enabled) return <Dialog title="Enviar conversa por e-mail" onClose={onClose} size="sm">
    <Notice tone="warn">{availability.reason || "Envio não autorizado."}</Notice>
  </Dialog>;
  return <TranscriptDialogForm key={`${app.identityKey}:${app.contextGeneration}:${conversationId}`}
    conversationId={conversationId} options={options} onClose={onClose} />;
}

function TranscriptDialogForm({ conversationId, options, onClose }: {
  conversationId: string;
  options: TranscriptOptions;
  onClose: () => void;
}) {
  const app = useApp();
  const availability = transcriptAction(options);
  const [values, setValues] = useState<TranscriptFormValues>({
    destination: options.destinations[0] || "self", address: "",
    range: options.ranges.includes("session") ? "session" : "dates", from: "", to: "",
  });
  const [preview, setPreview] = useState<TranscriptPreview | null>(null);
  const [recipient, setRecipient] = useState("");
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<TranscriptSendResult | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [denied, setDenied] = useState(false);
  const [clock, setClock] = useState(app.now);
  const alive = useRef(true);
  const locked = useRef(false);
  const generation = useRef(0);
  const path = `${app.root}/conversations/${encodeURIComponent(conversationId)}/email`;
  const send = useMemo(() => createTranscriptSender(app.api, path), [app.api, path]);
  const offset = app.now - Date.now();
  const optionsKey = JSON.stringify(options);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; };
  }, []);
  useEffect(() => {
    setClock(app.now);
    const timer = setInterval(() => setClock(Date.now() + offset), 1000);
    return () => clearInterval(timer);
  }, [app.now]);
  useEffect(() => {
    generation.current++;
    setPreview(null); setRecipient(""); setRequested(false);
  }, [optionsKey]);
  const change = (next: Partial<TranscriptFormValues>) => {
    generation.current++;
    setValues((current) => ({ ...current, ...next }));
    setPreview(null); setRecipient(""); setRequested(false); setError("");
  };
  async function prepare() {
    if (locked.current || result || uncertain || denied) return;
    setError("");
    let body: TranscriptPreviewRequest;
    try { body = transcriptPreviewRequest(values, options); }
    catch (cause: any) { setError(cause.message); return; }
    locked.current = true; setBusy(true);
    const current = ++generation.current;
    try {
      const next: TranscriptPreview = await app.api(path + "/preview", "POST", body);
      if (!alive.current || current !== generation.current) return;
      setPreview(next); setRecipient(""); setRequested(false);
    } catch (cause: any) {
      if (alive.current && current === generation.current) {
        if (cause.status === 403) setDenied(true);
        setError(cause.message);
      }
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function submit() {
    if (locked.current || !preview || !availability.enabled || result || uncertain || denied) return;
    setError("");
    let body: TranscriptSendRequest;
    try {
      transcriptPreviewRequest(values, options);
      body = transcriptSendRequest(preview, recipient, requested, Math.max(clock, Date.now() + offset), values.destination);
    }
    catch (cause: any) { setError(cause.message); return; }
    locked.current = true; setBusy(true);
    try {
      const next = await send(body);
      if (alive.current) setResult(next);
    } catch (cause: any) {
      if (!alive.current) return;
      if (!cause.status || cause.status >= 500 || cause.code === "operation_unknown") setUncertain(true);
      else if (cause.status === 403) setDenied(true);
      else { setPreview(null); setRecipient(""); setRequested(false); }
      setError(cause.message);
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const expired = !!preview && clock >= preview.expiresAt;
  const confirmationRequired = !!preview && (preview.requiresConfirmation || values.destination !== "self");
  const requestRequired = !!preview && (preview.requiresCustomerRequest || values.destination === "contact");
  const confirmed = !confirmationRequired || recipient.trim() === preview?.recipient;
  const selectionAllowed = options.destinations.includes(values.destination) && options.ranges.includes(values.range);
  const done = !!result || uncertain || denied;
  return <Dialog title="Enviar conversa por e-mail" size="md" onClose={() => { if (!locked.current) onClose(); }}
    subtitle="Revise o destino e o período antes de confirmar."
    footer={<>
      <Button variant="secondary" disabled={busy} onClick={onClose}>{done ? "Fechar" : "Cancelar"}</Button>
      {!done && (!preview || expired
        ? <Button onClick={prepare} busy={busy} disabled={!availability.enabled}>{expired ? "Atualizar prévia" : "Gerar prévia"}</Button>
        : <Button onClick={submit} busy={busy} disabled={!availability.enabled || !selectionAllowed || !confirmed || (requestRequired && !requested)}>Confirmar envio</Button>)}
    </>}>
    {!availability.enabled && <Notice tone="warn">{availability.reason || "Envio não autorizado."}</Notice>}
    {!done && <>
      <label className="field">Destino
        <select value={values.destination} disabled={busy || !availability.enabled} onChange={(event) => change({ destination: event.target.value as TranscriptDestination["kind"] })}>
          {options.destinations.map((item) => <option key={item} value={item}>{item === "self" ? "Meu e-mail" : item === "contact" ? "E-mail do contato" : "Outro e-mail"}</option>)}
        </select>
      </label>
      {values.destination === "custom" && <label className="field">Endereço de e-mail
        <input type="email" autoComplete="off" value={values.address} disabled={busy} onChange={(event) => change({ address: event.target.value })} />
      </label>}
      <label className="field">Período
        <select value={values.range} disabled={busy || !availability.enabled} onChange={(event) => change({ range: event.target.value as TranscriptRange["kind"] })}>
          {options.ranges.includes("session") && <option value="session">Este atendimento</option>}
          {options.ranges.includes("dates") && <option value="dates">Intervalo de datas</option>}
        </select>
      </label>
      {!options.ranges.includes("session") && <p className="muted">Não foi possível delimitar este atendimento. Escolha as datas da conversa.</p>}
      {values.range === "dates" && <div className="form-grid">
        <label className="field">De<input type="datetime-local" value={values.from} disabled={busy} onChange={(event) => change({ from: event.target.value })} /></label>
        <label className="field">Até<input type="datetime-local" value={values.to} disabled={busy} onChange={(event) => change({ to: event.target.value })} /></label>
        <small className="muted">Datas e horários no fuso deste dispositivo.</small>
      </div>}
      <p className="muted">Somente mensagens públicas. Notas internas não são incluídas. Anexos aparecem como descrição, sem arquivos ou links privados.</p>
      {options.limits && <p className="muted">Até {options.limits.maxMessages.toLocaleString("pt-BR")} mensagens por envio. Se exceder o limite, escolha um período menor.</p>}
      {preview && <section className="info-section" aria-label="Prévia do envio">
        <h4>Prévia do envio</h4>
        <p>Destinatário: <strong>{preview.recipient}</strong></p>
        <p>{date(preview.period.from)} a {date(preview.period.to)}</p>
        <p>{preview.messageCount} mensagens · {preview.size.textChars.toLocaleString("pt-BR")} caracteres de texto · {preview.size.htmlChars.toLocaleString("pt-BR")} caracteres de HTML</p>
        {preview.warnings.map((warning, index) => <Notice key={index} tone="warn">{warning}</Notice>)}
        <p className="muted">Prévia válida até {date(preview.expiresAt)}.</p>
        {expired && <Notice tone="warn">A prévia expirou. Atualize antes de enviar.</Notice>}
        {confirmationRequired && <label className="field">Digite o destinatário completo para confirmar
          <input type="email" autoComplete="off" value={recipient} disabled={busy || expired} onChange={(event) => setRecipient(event.target.value)} />
        </label>}
        {requestRequired && <label className="info-policy">
          <input type="checkbox" checked={requested} disabled={busy || expired} onChange={(event) => setRequested(event.target.checked)} />
          <span>O cliente solicitou o envio desta conversa por e-mail.</span>
        </label>}
      </section>}
    </>}
    {result && <Notice tone={result.status === "sent" ? "ok" : result.status === "failed" ? "error" : "warn"}>
      {transcriptResultText(result)} Destino: {result.to_masked}. Registro: {result.id}.
    </Notice>}
    {uncertain && <Notice tone="warn">Resultado indeterminado. Confira o registro com a equipe antes de solicitar outro envio. Não haverá reenvio automático.</Notice>}
    {error && <Notice tone="error">{error}</Notice>}
  </Dialog>;
}
