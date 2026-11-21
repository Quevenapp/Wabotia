// OS, parte 5: bloco "Notas fiscais" no detalhe da ordem. Mostra o que pode
// ser emitido agora e por que não, as notas emitidas (situação, número, PDF e
// XML), Consultar/retomar e Cancelar com justificativa. Com a parte Fiscal
// desligada (ou sem papel no ERP que veja notas), o bloco não aparece: a
// ordem funciona como antes, sem menção a nota. A ordem nunca espera a nota.
import React, { useEffect, useMemo, useState } from "react";
import { useApp } from "../../../app/AppContext";
import { FormDialog } from "../../../admin/shared";
import { Button, Field, Notice } from "../../../ui";
import { useIntegrationHost } from "../../integrations/visibility";
import { money } from "../shared";
import "../work.css";
import { createOsNotesApi, OsNotesError, type NfseCancelReason, type OsNoteKind, type OsNoteSection, type OsNotesOverview } from "./notes-api";

const READ_ROLES = ["admin", "fiscal", "consulta"], WRITE_ROLES = ["admin", "fiscal"];
const REASONS: { id: NfseCancelReason; name: string }[] = [
  { id: "erro_emissao", name: "Erro na emissão" }, { id: "servico_nao_prestado", name: "Serviço não prestado" }, { id: "outros", name: "Outro motivo" },
];

/** Quem vê o bloco: ERP e Fiscal ligados e papel que lê notas. */
export function invoicesVisible(context: { statusLoaded?: boolean; modules: Record<string, boolean | undefined>; erpRole?: string | null } | null | undefined): boolean {
  return !!context?.statusLoaded && context.modules.erp === true && context.modules["erp-fiscal"] === true && READ_ROLES.includes(context.erpRole ?? "");
}

const environmentLabel = (value: string) => value === "producao" ? "Produção" : "Homologação (teste, sem valor fiscal)";

function CancelDialog({ section, onClose, onSubmit }: { section: OsNoteSection; onClose: () => void; onSubmit: (justification: string, reason: NfseCancelReason) => Promise<unknown> }) {
  const [text, setText] = useState(""), [reason, setReason] = useState<NfseCancelReason>("erro_emissao");
  const service = section.kind === "nfse";
  return <FormDialog title={`Cancelar ${service ? "a nota de serviço" : "a nota de peças"}`} submitLabel="Pedir cancelamento" danger onClose={onClose} onSubmit={async () => {
    const value = text.trim();
    if ([...value].length < 15 || [...value].length > 255) throw new Error("Escreva a justificativa com 15 a 255 caracteres. Ela vai para a " + (service ? "prefeitura." : "SEFAZ."));
    await onSubmit(value, reason);
  }}>
    <p>{service ? "A prefeitura decide se aceita o cancelamento (há prazo e regras do município)." : "A SEFAZ decide se aceita o cancelamento (em geral, até 24 horas da autorização)."}</p>
    <p>Cancelar a nota não desfaz a ordem: o estoque e o financeiro lançados pela ordem continuam lançados.</p>
    {service && <Field label="Motivo" value={reason} emptyOption={null} options={REASONS} onChange={value => setReason(value as NfseCancelReason)} />}
    <Field label="Justificativa" type="textarea" required maxLength={255} value={text} onChange={setText}
      help="De 15 a 255 caracteres. Fica registrada no evento de cancelamento." />
  </FormDialog>;
}

function Section({ section, write, busy, onAction }: { section: OsNoteSection; write: boolean; busy: boolean;
  onAction: (action: "emit" | "consult" | "cancel" | "xml" | "pdf" | "xml_cancelamento") => void }) {
  const e = section.emission, service = section.kind === "nfse";
  return <article className="work-invoice">
    <h4>{section.label}</h4>
    <p>{section.situation}</p>
    {section.lines.length > 0 && <p className="muted">{section.lines.length} {section.lines.length === 1 ? "item" : "itens"} · {money(Number(section.total_cents))}: {section.lines.map(line => line.description).join(", ")}</p>}
    {e && <dl className="work-invoice-data">
      {e.status === "autorizada" || e.status === "cancelada" ? <>
        {service ? <><dt>Número da NFS-e</dt><dd>{e.protocol ?? "—"}</dd><dt>DPS</dt><dd>{e.number ?? "—"} (série {e.series ?? "—"})</dd></>
          : <><dt>Número</dt><dd>{e.number ?? "—"} (série {e.series ?? "—"})</dd><dt>Protocolo</dt><dd>{e.protocol ?? "—"}</dd></>}
        {e.access_key && <><dt>Chave de acesso</dt><dd className="mono">{e.access_key}</dd></>}
      </> : null}
      <dt>Ambiente</dt><dd>{environmentLabel(e.environment)}</dd>
    </dl>}
    {section.reason && <p className="muted">Ainda não dá para emitir: {section.reason}</p>}
    {section.effects_note && e?.status === "cancelada" && <Notice>{section.effects_note}</Notice>}
    <div className="card-actions">
      {write && section.actions.includes("emitir") && <Button disabled={busy} onClick={() => onAction("emit")}>{service ? "Emitir nota de serviço" : "Emitir nota de peças"}</Button>}
      {write && section.actions.includes("emitir_de_novo") && <Button secondary disabled={busy} onClick={() => onAction("emit")}>Emitir de novo</Button>}
      {write && section.actions.includes("consultar") && <Button secondary disabled={busy} onClick={() => onAction("consult")}>Consultar e retomar</Button>}
      {section.actions.includes("pdf") && <Button secondary disabled={busy} onClick={() => onAction("pdf")}>Baixar PDF</Button>}
      {section.actions.includes("xml") && <Button secondary disabled={busy} onClick={() => onAction("xml")}>Baixar XML</Button>}
      {section.actions.includes("xml_cancelamento") && <Button secondary disabled={busy} onClick={() => onAction("xml_cancelamento")}>XML do cancelamento</Button>}
      {write && section.actions.includes("cancelar") && <Button variant="danger" disabled={busy} onClick={() => onAction("cancel")}>Cancelar nota</Button>}
    </div>
    {service && e?.status === "autorizada" && <p className="muted">O cofre não gera o PDF da nota de serviço: baixe o XML ou consulte a nota no Portal Nacional da NFS-e pela chave.</p>}
  </article>;
}

export function WorkInvoicesPanel({ workId }: { workId: string }) {
  const host = useIntegrationHost(), { profile } = useApp();
  const visible = invoicesVisible(host?.context);
  const write = visible && WRITE_ROLES.includes(host?.context.erpRole ?? "");
  const notes = useMemo(() => createOsNotesApi(profile), [profile]);
  const [data, setData] = useState<{ id: string; value: OsNotesOverview } | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [reload, setReload] = useState(0), [cancelling, setCancelling] = useState<OsNoteSection | null>(null);
  useEffect(() => {
    if (!visible) return;
    const request = new AbortController(); setError("");
    void notes.overview(workId, request.signal).then(value => { if (!request.signal.aborted) setData({ id: workId, value }); })
      .catch(e => { if (!request.signal.aborted && !(e instanceof Error && e.name === "AbortError")) setError(e instanceof Error ? e.message : String(e)); });
    return () => request.abort();
  }, [notes, visible, workId, reload]);
  if (!visible) return null;
  const value = data?.id === workId ? data.value : null;
  const run = (work: () => Promise<OsNotesOverview | void>) => {
    setBusy(true); setError("");
    void work().then(next => { if (next) setData({ id: workId, value: next }); else setReload(n => n + 1); })
      .catch(e => { setError(e instanceof OsNotesError || e instanceof Error ? e.message : String(e)); setReload(n => n + 1); })
      .finally(() => setBusy(false));
  };
  const act = (section: OsNoteSection) => (action: "emit" | "consult" | "cancel" | "xml" | "pdf" | "xml_cancelamento") => {
    const kind: OsNoteKind = section.kind;
    if (action === "cancel") return setCancelling(section);
    if (action === "emit") return run(() => notes.emit(workId, kind));
    if (action === "consult") return run(() => notes.consult(workId, kind));
    run(() => notes.download(workId, kind, action === "pdf" ? "pdf" : action === "xml" ? "xml" : "cancelamento-xml"));
  };
  return <section className="work-invoices">
    <h3>Notas fiscais</h3>
    {error && <p role="alert">{error}</p>}
    {!value && !error && <p className="muted">Carregando as notas da ordem…</p>}
    {value && <>
      {value.environment !== "producao" && <p className="muted">Ambiente de homologação: as notas são de teste e não têm valor fiscal. Produção se habilita em Preferências do Fiscal.</p>}
      {value.order.require_invoice_to_deliver && !value.authorized && <Notice>Este modelo exige nota autorizada para entregar a ordem.</Notice>}
      {!value.notes.length && <p className="muted">Esta ordem não tem serviços nem peças no orçamento para nota.</p>}
      {value.notes.map(section => <Section key={section.kind} section={section} write={write} busy={busy} onAction={act(section)} />)}
      <p className="muted">A ordem não espera a nota para mudar de etapa. Estoque e financeiro são lançados pela ordem; a nota não lança de novo.</p>
    </>}
    {cancelling && <CancelDialog section={cancelling} onClose={() => setCancelling(null)} onSubmit={async (justification, reason) => {
      const next = await notes.cancel(workId, cancelling.kind, justification, reason);
      setData({ id: workId, value: next }); setCancelling(null);
    }} />}
  </section>;
}
