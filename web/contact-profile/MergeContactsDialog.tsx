import React, { useEffect, useRef, useState } from "react";
import type { ContactMergePreview, ContactMergeResult, MergeField, MergeFieldChoices } from "../../src/channel-contracts";
import type { Api, Row } from "../lib/api";
import { Dialog } from "../ContactsPanel";
import { contactMergeWriter, contactsQuery, profileMessage, ProfileRequests, validMergePreview } from "./model";

const fieldLabels: Record<MergeField, string> = {
  name: "Nome", phone: "Telefone", email: "E-mail", document: "CPF/CNPJ", personType: "Tipo de pessoa", address: "Endereço",
};
const valueText = (value: ContactMergePreview["differences"][number]["source"]) =>
  value == null || value === "" ? "Não informado" : typeof value === "string" ? value : Object.values(value).filter(Boolean).join(", ");

export function MergePreviewDetails({ preview, choices, disabled = false, onChoice }: {
  preview: ContactMergePreview; choices: MergeFieldChoices; disabled?: boolean; onChoice(field: MergeField, value: "source" | "target"): void;
}) {
  return <>
    <div className="customer-merge-pair">
      {([preview.source, preview.target]).map(contact => <section key={contact.id} aria-label={contact.id === preview.source.id ? "Ficha de origem" : "Outra ficha"}>
        <h3>{contact.name || "Contato sem nome"}</h3>
        {contact.id === preview.survivorId && <p><strong>Ficha que será mantida</strong>{contact.erpId ? " · Vinculada ao ERP" : ""}</p>}
        <dl><dt>Telefone</dt><dd>{contact.phone || "Não informado"}</dd>
          <dt>E-mail</dt><dd>{contact.email || "Não informado"}</dd>
          <dt>CPF/CNPJ</dt><dd>{contact.document || "Não informado"}</dd></dl>
      </section>)}
    </div>
    {preview.differences.length > 0 && <fieldset disabled={disabled}><legend>Dados que serão mantidos</legend>
      <p>Campos preenchidos da ficha mantida são preservados. Escolha explicitamente qualquer substituição.</p>
      {preview.differences.map(difference => <label key={difference.field}>
        {fieldLabels[difference.field]}{difference.requiresConfirmation ? " · Valores diferentes" : ""}
        <select value={choices[difference.field] ?? difference.defaultChoice}
          onChange={event => onChoice(difference.field, event.target.value as "source" | "target")}>
          <option value="source">Origem: {valueText(difference.source)}</option>
          <option value="target">Outra ficha: {valueText(difference.target)}</option>
        </select>
      </label>)}
    </fieldset>}
    <p>Relações a conferir: {Object.values(preview.relationCounts).reduce((sum, count) => sum + count, 0)}.</p>
    <details><summary>Relações por origem</summary><ul>{Object.entries(preview.relationCounts).map(([name, count]) =>
      <li key={name}>{relationLabel(name)}: {count}</li>)}</ul></details>
    {preview.blockers.map((blocker, index) => <p role="alert" key={blocker.code + index}>{blocker.message || profileMessage({ code: blocker.code })}</p>)}
  </>;
}

function relationLabel(value: string) {
  const labels: Record<string, string> = {
    conversation_contacts: "Conversas", web_steps: "Etapas de atendimento", agenda_appointments: "Agendamentos",
    os_orders: "Ordens de serviço", pedido_orders: "Pedidos", reserva_bookings: "Reservas", mensalidade_subscriptions: "Mensalidades",
    os_people: "Pessoas de ordens de serviço", mensalidade_payers: "Pagadores", cond_people: "Pessoas do condomínio",
    ensino_guardians: "Responsáveis escolares", ensino_enrollments: "Matrículas", saude_contact_links: "Vínculos de saúde",
    customer_records: "Registros cadastrais", customer_sections: "Seções cadastrais", customer_phones: "Identidades de telefone",
    customer_phone_candidates: "Candidatos de telefone", customer_phone_proofs: "Provas de telefone",
    conversations: "Marcadores das conversas", customer_channel_ids: "Identidades de canal",
  };
  return labels[value.split(".")[0]] ?? "Vínculos cadastrais";
}

export function MergeContactsDialog({ api, root, contactId, namespace = "team", onClose, onMerged }: {
  api: Api; root: string; contactId: string; namespace?: string; onClose(): void; onMerged(result: ContactMergeResult): void;
}) {
  const [query, setQuery] = useState(""), [candidates, setCandidates] = useState<Row[]>([]), [searched, setSearched] = useState(false);
  const [targetId, setTargetId] = useState(""), [preview, setPreview] = useState<ContactMergePreview | null>(null);
  const [choices, setChoices] = useState<MergeFieldChoices>({}), [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const requests = useRef(new ProfileRequests()), writer = useRef(contactMergeWriter(api, root + "/contacts/" + encodeURIComponent(contactId)));
  useEffect(() => { const scope = new ProfileRequests(); requests.current = scope; return () => scope.dispose(); }, []);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, preview.expiresAt - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [preview]);
  const search = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || !query.trim()) return;
    const request = requests.current.begin("search");
    setBusy(true); setError(""); setPreview(null); setConfirmed(false); setTargetId(""); setSearched(false); setCandidates([]);
    try {
      const result = await api(root + "/contacts?" + contactsQuery({ search: query.trim(), identity: "all" }) + "&limit=25&namespace=" + encodeURIComponent(namespace), "GET", undefined, request.signal);
      if (!request.current()) return;
      setCandidates((Array.isArray(result.data) ? result.data as Row[] : []).filter(row => row.id !== contactId && !row.merged_into
        && (row.namespace ?? "team") === namespace && row.identity_state !== "restricted"));
      setSearched(true);
    } catch (failure) { if (request.current()) setError(profileMessage(failure)); }
    finally { if (request.current()) setBusy(false); }
  };
  const readPreview = async () => {
    if (busy || !targetId) return;
    const request = requests.current.begin("preview"); setBusy(true); setError(""); setPreview(null); setConfirmed(false); setChoices({});
    try {
      const value: ContactMergePreview = await api(root + "/contacts/" + encodeURIComponent(contactId) + "/merge-preview", "POST", { targetId }, request.signal);
      if (!request.current()) return;
      if (!validMergePreview(value, contactId, targetId)) throw new Error("A prévia não corresponde às fichas escolhidas. Recarregue para continuar.");
      setPreview(value); setNow(Date.now());
    } catch (failure) { if (request.current()) setError(profileMessage(failure)); }
    finally { if (request.current()) setBusy(false); }
  };
  const merge = async () => {
    if (busy || !preview || preview.blockers.length || !confirmed || Date.now() >= preview.expiresAt) return;
    const request = requests.current.begin("merge"); setBusy(true); setError("");
    try {
      const result = await writer.current.merge({ targetId, sourceVersion: preview.source.version, targetVersion: preview.target.version,
        previewToken: preview.previewToken, fieldChoices: choices, ...(reason.trim() ? { reason: reason.trim() } : {}) }, request.signal);
      if (request.current()) onMerged(result);
    } catch (failure) { if (request.current()) setError(profileMessage(failure)); }
    finally { if (request.current()) setBusy(false); }
  };
  return <Dialog title="Juntar com outro contato" close={onClose} busy={busy} wide>
    <div className="customer-profile customer-merge">
      <p>Confira se as duas fichas representam a mesma pessoa. A junção mantém separadas as provas e as conversas de cada canal.</p>
      <form onSubmit={event => void search(event)}><label>Buscar outro contato<input value={query} disabled={busy} onChange={event => setQuery(event.target.value)} placeholder="Nome, telefone ou e-mail" /></label>
        <button type="submit" disabled={busy || !query.trim()}>Buscar</button></form>
      {searched && !candidates.length && <p>Nenhum outro contato disponível para esta busca.</p>}
      {candidates.length > 0 && <label>Outra ficha<select value={targetId} disabled={busy} onChange={event => { setTargetId(event.target.value); setPreview(null); setConfirmed(false); }}>
        <option value="">Selecione um contato</option>{candidates.map(row => <option key={row.id} value={row.id}>{row.name || "Contato sem nome"}{row.phone ? " · " + row.phone : row.email ? " · " + row.email : ""}</option>)}
      </select></label>}
      {targetId && <button type="button" disabled={busy} onClick={() => void readPreview()}>{preview ? "Atualizar prévia" : "Conferir prévia"}</button>}
      {preview && <>
        <MergePreviewDetails preview={preview} choices={choices} disabled={busy} onChoice={(field, choice) => { setChoices(value => ({ ...value, [field]: choice })); setConfirmed(false); }} />
        <label>Motivo da junção (opcional)<textarea value={reason} maxLength={500} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
        <p>Desfazer depende de fichas, relações e conversas permanecerem intactas. Uma nova mensagem pode impedir o desfazer.</p>
        <label><input type="checkbox" checked={confirmed} disabled={busy || !!preview.blockers.length} onChange={event => setConfirmed(event.target.checked)} /> Conferi as fichas e os dados que serão mantidos.</label>
        {now >= preview.expiresAt && <p role="status">A prévia expirou. Atualize para continuar.</p>}
        <button type="button" disabled={busy || !confirmed || !!preview.blockers.length || now >= preview.expiresAt} onClick={() => void merge()}>Confirmar junção</button>
      </>}
      {busy && <p role="status">Conferindo solicitação…</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={onClose}>Cancelar</button>
    </div>
  </Dialog>;
}
