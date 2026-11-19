import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ContactPage, ContactProfileView, Json, SectionView } from "../../src/customer/profile-contracts";
import type { HistoryPage } from "../../src/customer/contracts";
import type { ContactMergeResult } from "../../src/channel-contracts";
import type { Api, Row } from "../lib/api";
import { onApiState } from "../lib/api";
import { navigationGuarded } from "../lib/routes";
import { Dialog, SimpleContactBody } from "../ContactsPanel";
import { bindErpContact, cancelContactJob, contactMergeWriter, jobBlocksEditing, jobMessage, mountProfileHost, profileMessage, profileMode, ProfileRequests, readContactJob, replaceSectionRole, sectionWriter, synchronizationJob, watchContactJob, writeFeedback, type ProfileJob, type ProfileVocabulary } from "./model";
import { cellText, privateTarget, registeredComponent, targetHref } from "./registry";
import { ChannelsSection } from "./ChannelsSection";
import { MergeContactsDialog } from "./MergeContactsDialog";
import "./profile.css";

type Contribution = ContactProfileView["contributions"][number];
export type ContactProfileProps = {
  api: Api;
  root: string;
  contactId: string;
  /** Muda com pessoa, sessão, acesso e módulos; as entradas da casca o fornecem. */
  scopeKey: string;
  demo?: boolean;
  initialContact?: Row;
  conversation?: Row;
  vocabulary?: ProfileVocabulary;
  onClose(): void;
  onSaved?(message?: string): void;
  openConversation?(row: Row): void;
};

type Resource<T> = { value: T | null; error: string; loading: boolean };
function useResource<T>(api: Api, path: string | null, revision = 0) {
  const [state, setState] = useState<Resource<T>>({ value: null, error: "", loading: true });
  useEffect(() => {
    const requests = new ProfileRequests(), request = requests.begin("read");
    setState({ value: null, error: "", loading: !!path });
    if (path) void api(path, "GET", undefined, request.signal).then(value => {
      if (request.current()) setState({ value, error: "", loading: false });
    }).catch(error => {
      if (request.current()) setState({ value: null, error: profileMessage(error), loading: false });
    });
    return () => requests.dispose();
  }, [api, path, revision]);
  return state;
}

function Failure({ error, retry }: { error: string; retry(): void }) {
  return <p className="notice error" role="alert">{error} <button type="button" onClick={retry}>Tentar novamente</button></p>;
}

export function ContactProfile(props: ContactProfileProps) {
  const [invalidated, setInvalidated] = useState(false);
  const transport = useRef({ api: props.api, epoch: 0 });
  if (transport.current.api !== props.api) transport.current = { api: props.api, epoch: transport.current.epoch + 1 };
  useEffect(() => onApiState(state => { if (state.unauthorized) setInvalidated(true); }), []);
  const content = invalidated
    ? <Dialog title="Ficha indisponível" close={props.onClose} busy={false}><p role="alert">Sua sessão mudou. Entre novamente para abrir a ficha.</p></Dialog>
    : <ProfileSession key={JSON.stringify([props.root, props.contactId, props.scopeKey, transport.current.epoch])} {...props} />;
  // A ficha e a raiz exclusiva do hospedeiro não herdam o formulário/CSS da lista ERP.
  return typeof document === "undefined" ? content : createPortal(content, document.body);
}

function ProfileSession(props: ContactProfileProps) {
  const { api, root, contactId, demo, onClose } = props;
  const [revision, setRevision] = useState(0), [contactRevision, setContactRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const mergeNotice = useRef<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false), [editRevision, setEditRevision] = useState(0);
  const finishedJobs = useRef(new Set<string>());
  const requestedBase = root + "/contacts/" + encodeURIComponent(contactId);
  const profile = useResource<ContactProfileView>(api, demo ? null : requestedBase + "/profile", revision);
  const canonicalId = profile.value?.contactId ?? contactId;
  const base = root + "/contacts/" + encodeURIComponent(canonicalId);
  const detail = useResource<{ contact: Row; conversations?: Row[]; synchronization?: Partial<ProfileJob> & { jobId?: string } }>(api,
    demo || profile.loading || !profile.value || profile.value.readable === false ? null : base, contactRevision);
  useEffect(() => {
    const id = synchronizationJob(detail.value);
    if (id && !finishedJobs.current.has(id)) { setJobId(id); setBlocked(jobBlocksEditing(detail.value?.synchronization ?? null)); }
  }, [detail.value]);
  const view: ContactProfileView | null = demo ? {
    profileId: decodeURIComponent(root.split("/").at(-1)!), contactId, erpContactId: null, depth: "simple",
    vocabulary: props.vocabulary ?? { singular: "Cliente", plural: "Clientes" }, writable: false, contributions: [],
  } : profile.value;
  const row = demo ? props.initialContact : detail.value?.contact;
  const valid = !!view && (view.contactId === contactId || view.merge?.merged_into === view.contactId)
    && view.profileId === decodeURIComponent(root.split("/").at(-1)!);
  const saved = (message = "Cadastro salvo.", result?: Row) => {
    const feedback = writeFeedback(result, message);
    setNotice(feedback.message); setContactRevision(value => value + 1); props.onSaved?.(feedback.message);
    if (feedback.jobId) { setJobId(feedback.jobId); setBlocked(!feedback.completed); }
    if (feedback.completed) setRevision(value => value + 1);
  };
  const closeDialog = () => {
    if (navigationGuarded()) { setNotice("Há alterações não salvas. Salve ou use Cancelar no cadastro completo antes de fechar."); return; }
    if (mergeNotice.current) props.onSaved?.(mergeNotice.current);
    onClose();
  };
  return <Dialog title={valid ? `${view.vocabulary.singular} · ${row?.name || row?.phone || "Ficha"}` : "Ficha do contato"} close={closeDialog} busy={false} wide>
    <div className="customer-profile">
      {notice && <p role="status" className="notice">{notice}</p>}
      {jobId && <ContactJob key={jobId} api={api} root={root} id={jobId} expectedVersion={row?.version}
        writable={view?.readable !== false && (view?.localWritable ?? view?.writable) === true}
        changed={job => { setBlocked(jobBlocksEditing(job)); if (job.state === "cancelled") {
          finishedJobs.current.add(job.id); setEditRevision(n => n + 1); setContactRevision(n => n + 1);
          setNotice(jobMessage(job)); props.onSaved?.(jobMessage(job));
        } }}
        done={() => { finishedJobs.current.add(jobId); setJobId(null); setBlocked(false); setNotice("Atualização concluída.");
          setContactRevision(n => n + 1); setRevision(n => n + 1); props.onSaved?.("Atualização concluída."); }} />}
      {!demo && profile.loading && <p role="status">Carregando ficha…</p>}
      {profile.error && <Failure error={profile.error} retry={() => setRevision(n => n + 1)} />}
      {view && !valid && <p role="alert">Esta ficha não pertence ao contato e à área selecionados.</p>}
      {valid && <>
        {(view.readable !== false || profileMode(view) === "full") && <section className="customer-profile-card" aria-label="Cadastro">
          {profileMode(view) === "full" ? <>
            <FullBody view={view} saved={() => saved()} close={closeDialog} />
            {detail.error && <Failure error={detail.error} retry={() => setContactRevision(n => n + 1)} />}
            {row?.id === canonicalId && <div className="customer-profile-local"><h3>Dados do atendimento</h3>
              <SimpleContactBody key={`${row.id}:${row.version}:${editRevision}`} api={api} root={root} demo={!!demo} contact={row} conversation={props.conversation}
                embedded localOnly vocabulary={view.vocabulary} blocked={blocked} writable={view.localWritable ?? view.writable} close={closeDialog} saved={saved} /></div>}
          </> : <>
            <p className="muted">Cadastro simples{view.erpContactId ? " · Últimos dados sincronizados" : ""}</p>
            {view.erpContactId && <p>O cadastro completo está indisponível neste acesso. Alterações locais aguardam reconciliação.</p>}
            {props.conversation?.customer_link_state && props.conversation.customer_link_state !== "ready" &&
              <p role="status">{linkStateText(props.conversation.customer_link_state)}</p>}
            {!demo && detail.loading && <p role="status">Carregando cadastro…</p>}
            {detail.error && <Failure error={detail.error} retry={() => setContactRevision(n => n + 1)} />}
            {row && row.id === canonicalId && <SimpleContactBody key={`${row.id}:${row.version}:${editRevision}`} api={api} root={root} demo={!!demo}
              contact={row} conversation={props.conversation} conversations={detail.value?.conversations}
              embedded vocabulary={view.vocabulary} blocked={blocked} writable={view.localWritable ?? view.writable} close={closeDialog} saved={saved} openConversation={props.openConversation} />}
          </>}
        </section>}
        {!demo && <>
          {view.readable !== false && <>
            <ChannelsSection channels={view.channels} conversations={view.other_conversations} />
            {view.merge && <MergeControls api={api} root={root} requestedId={contactId} view={view}
              changed={message => { mergeNotice.current = message; setNotice(message); setContactRevision(n => n + 1); setRevision(n => n + 1); }} />}
          </>}
          {view.readable !== false && !view.namespace?.startsWith("app:") && <History api={api} base={base} />}
          {view.contributions.map(item => <ContributionCard key={`${item.moduleId}:${item.id}`} item={item} api={api} base={base} />)}
        </>}
      </>}
    </div>
  </Dialog>;
}

function MergeControls({ api, root, requestedId, view, changed }: {
  api: Api; root: string; requestedId: string; view: ContactProfileView; changed(message: string): void;
}) {
  const [open, setOpen] = useState(false), [confirmUndo, setConfirmUndo] = useState(false);
  const [lastMerge, setLastMerge] = useState<ContactMergeResult | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const requests = useRef(new ProfileRequests());
  const writer = useRef(contactMergeWriter(api, root + "/contacts/" + encodeURIComponent(requestedId)));
  useEffect(() => { const scope = new ProfileRequests(); requests.current = scope; return () => scope.dispose(); }, []);
  const mergeId = lastMerge?.state === "applied" ? lastMerge.id : view.merge?.merge_id;
  const canUndo = !!mergeId && (lastMerge?.state === "applied" || view.merge?.can_undo);
  const undo = async () => {
    if (!mergeId || !canUndo || !confirmUndo || busy) return;
    const request = requests.current.begin("undo"); setBusy(true); setError("");
    try {
      const result = await writer.current.undo({ mergeId }, request.signal);
      if (!request.current()) return;
      setLastMerge(result); setConfirmUndo(false); changed("Junção desfeita. As fichas e seus vínculos foram restaurados.");
    } catch (failure) { if (request.current()) setError(profileMessage(failure)); }
    finally { if (request.current()) setBusy(false); }
  };
  if (!view.merge?.available && !canUndo && !view.merge?.merge_id) return null;
  return <section className="customer-profile-card" aria-label="Junção de contatos">
    {view.merge?.available && <button type="button" disabled={busy} onClick={() => setOpen(true)}>Juntar com outro contato</button>}
    {view.merge?.reason && <p role="status">{view.merge.reason}</p>}
    {canUndo && <>
      <p>O desfazer será conferido pelo servidor. Alterações nas fichas, vínculos ou mensagens podem impedir a restauração.</p>
      <label><input type="checkbox" checked={confirmUndo} disabled={busy} onChange={event => setConfirmUndo(event.target.checked)} /> Confirmo que quero desfazer esta junção.</label>
      <button type="button" disabled={busy || !confirmUndo} onClick={() => void undo()}>Desfazer junção</button>
    </>}
    {error && <p role="alert" className="notice error">{error}</p>}
    {open && <MergeContactsDialog api={api} root={root} contactId={view.contactId} namespace={view.namespace}
      onClose={() => setOpen(false)} onMerged={result => { setOpen(false); setLastMerge(result); setError(""); changed("Contatos juntados. As provas de identidade permanecem separadas por canal."); }} />}
  </section>;
}

function linkStateText(state: string) {
  return ({ pending: "O vínculo com a conversa aguarda confirmação.", ambiguous: "Há mais de um contato possível. Resolva o vínculo da conversa.",
    blocked: "O vínculo desta conversa foi desfeito.", excluded: "Esta conversa não libera acesso ao cadastro." } as Record<string, string>)[state] ?? "";
}

export function ContactJob({ api, root, id, done, changed, writable = false, expectedVersion }: {
  api: Api; root: string; id: string; done?(): void; changed?(job: ProfileJob): void; writable?: boolean; expectedVersion?: number;
}) {
  const callback = useRef({ done, changed }); callback.current = { done, changed };
  const [job, setJob] = useState<ProfileJob | null>(null), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const [reason, setReason] = useState(""), [busy, setBusy] = useState(false);
  const stopReading = useRef<() => void>(() => {});
  const writes = useRef(new ProfileRequests()), command = useRef<{ body: string; id: string } | null>(null);
  useEffect(() => { const scope = new ProfileRequests(); writes.current = scope; return () => scope.dispose(); }, []);
  useEffect(() => {
    const request = new AbortController();
    const stop = watchContactJob(api, root, id, request.signal, result => {
      setJob(result); setError(""); callback.current.changed?.(result);
      if (result.state === "done") callback.current.done?.();
    }, failure => setError(profileMessage(failure)));
    stopReading.current = stop;
    return () => { request.abort(); stop(); };
  }, [api, root, id, revision]);
  const cancel = async () => {
    if (!job || busy || !writable) return;
    stopReading.current();
    const request = writes.current.begin("cancel"); setBusy(true); setError("");
    try {
      const version = expectedVersion ?? (job.contactId ? (await api(root + "/contacts/" + encodeURIComponent(job.contactId), "GET", undefined, request.signal)).contact?.version : undefined);
      if (!request.current()) return;
      const signature = JSON.stringify([job.id, job.updated, version, reason.trim()]);
      if (command.current?.body !== signature) command.current = { body: signature, id: crypto.randomUUID() };
      const result = await cancelContactJob(api, root, job, version, reason, request.signal, command.current.id);
      if (!request.current()) return;
      setJob(result); callback.current.changed?.(result);
      if (result.state === "done") callback.current.done?.();
      if (result.state !== "cancelled") setError("O cancelamento ainda não foi confirmado. Confira o resultado antes de editar.");
    } catch (failure) { if (request.current()) setError(profileMessage(failure)); }
    finally { if (request.current()) setBusy(false); }
  };
  return <div className="customer-profile-job">
    <p role="status">{job ? jobMessage(job) : "Conferindo atualização…"}</p>
    {error && <Failure error={error} retry={() => setRevision(n => n + 1)} />}
    {job && !["done", "cancelled"].includes(job.state) && <button type="button" disabled={busy} onClick={() => setRevision(n => n + 1)}>Conferir novamente</button>}
    {job && writable && ["paused", "conflict", "failed"].includes(job.state) && <>
      <p>Para corrigir os dados, cancele esta intenção e inicie uma nova edição. Um envio de resultado desconhecido precisa ser conferido pelo servidor antes do cancelamento.</p>
      <label>Motivo do cancelamento<input value={reason} maxLength={500} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
      <button type="button" disabled={busy || !reason.trim() || !Number.isSafeInteger(job.updated)} onClick={() => void cancel()}>Cancelar solicitação</button>
      {!Number.isSafeInteger(job.updated) && <p role="status">A versão para cancelamento ainda não está disponível. Recarregue a solicitação.</p>}
    </>}
  </div>;
}

function FullBody({ view, saved, close }: { view: ContactProfileView; saved(): void; close(): void }) {
  const element = useRef<HTMLDivElement>(null), callbacks = useRef({ saved, close });
  callbacks.current = { saved, close };
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let mounted: { dispose(): void } | undefined;
    setError(""); setLoading(true);
    void mountProfileHost(element.current!, view, {
      profileId: view.profileId, contactId: view.contactId, erpContactId: view.erpContactId!,
      vocabulary: view.vocabulary,
      onSaved: () => callbacks.current.saved(), onClose: () => callbacks.current.close(),
    }, controller.signal).then(result => { mounted = result; if (!controller.signal.aborted) setLoading(false); })
      .catch(failure => { if (!controller.signal.aborted) { setError(profileMessage(failure)); setLoading(false); } });
    return () => { controller.abort(); mounted?.dispose(); };
  }, [view, revision]);
  return <>
    {loading && <p role="status">Carregando cadastro completo…</p>}
    {error && <Failure error={error} retry={() => setRevision(n => n + 1)} />}
    <div className="customer-profile-host" ref={element} />
  </>;
}

function ContributionCard({ item, api, base }: { item: Contribution; api: Api; base: string }) {
  const renderer = registeredComponent(item);
  return <section className="customer-profile-card" aria-label={item.title}>
    <h3>{item.title}</h3>
    {!renderer ? <p role="alert">Esta seção ainda não está disponível nesta versão do painel.</p>
      : item.kind === "collection" ? <Collection item={item} api={api} base={base} /> : <Section item={item} api={api} base={base} />}
  </section>;
}

function Collection({ item, api, base }: { item: Contribution; api: Api; base: string }) {
  const [cursor, setCursor] = useState<string | null>(null), [revision, setRevision] = useState(0);
  const path = `${base}/modules/${encodeURIComponent(item.moduleId)}/collections/${encodeURIComponent(item.id)}?limit=25${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`;
  const state = useResource<ContactPage>(api, path, revision);
  const columns = item.columns ?? [];
  return <>
    {state.loading && <p role="status">Carregando lista…</p>}
    {state.error && <Failure error={state.error} retry={() => setRevision(n => n + 1)} />}
    {state.value && <>
      {state.value.items.length ? <div className="customer-profile-table"><table><thead><tr>{columns.map(column => <th key={column.key}>{column.label}</th>)}<th>Acesso</th></tr></thead>
        <tbody>{state.value.items.map(row => <tr key={row.id}>{columns.map(column => <td key={column.key}>{cellText(row.cells[column.key], column.format)}</td>)}
          <td>{targetHref(row.target) && <a href={targetHref(row.target)!}>Abrir no módulo</a>}</td></tr>)}</tbody></table></div> : <p>Nenhum registro disponível.</p>}
      {state.value.incomplete && <p role="status">A lista está incompleta. Alguns vínculos ainda estão sendo preparados.</p>}
      <div className="customer-profile-actions">
        {cursor && <button type="button" onClick={() => setCursor(null)}>Primeira página</button>}
        {state.value.nextCursor && <button type="button" onClick={() => setCursor(state.value!.nextCursor)}>Próxima página</button>}
      </div>
    </>}
  </>;
}

function Section({ item, api, base }: { item: Contribution; api: Api; base: string }) {
  const [revision, setRevision] = useState(0);
  const path = `${base}/modules/${encodeURIComponent(item.moduleId)}/sections/${encodeURIComponent(item.id)}`;
  const state = useResource<SectionView>(api, path, revision);
  const component = registeredComponent(item);
  return <>
    {state.loading && <p role="status">Carregando seção…</p>}
    {state.error && <Failure error={state.error} retry={() => setRevision(n => n + 1)} />}
    {state.value && (component && "schema" in component && state.value.schema === component.schema
      ? <SectionBody key={revision} item={item} initial={state.value} api={api} path={path} reload={() => setRevision(n => n + 1)} />
      : <p role="alert">O formato desta seção não é compatível com esta versão do painel.</p>)}
  </>;
}

function SectionBody({ item, initial, api, path, reload }: { item: Contribution; initial: SectionView; api: Api; path: string; reload(): void }) {
  const [section, setSection] = useState(initial), [draft, setDraft] = useState(initial.data);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const writer = useRef(sectionWriter(api, path));
  const requests = useRef(new ProfileRequests());
  useEffect(() => { const scope = new ProfileRequests(); requests.current = scope; return () => scope.dispose(); }, []);
  const writable = item.writable && section.writable;
  if (section.schema === "private.navigation.v1") {
    const target = privateTarget(section.data);
    return <p>{target ? <a href={targetHref(target)!}>Abrir módulo especializado</a> : "Nenhum acesso disponível ao módulo especializado."}</p>;
  }
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || !writable) return;
    const request = requests.current.begin("save");
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await writer.current(section, draft, request.signal);
      if (!request.current()) return;
      setSection(result); setDraft(result.data); setNotice("Seção salva.");
    } catch (failure) { if (request.current()) setError(profileMessage(failure)); }
    finally { if (request.current()) setBusy(false); }
  };
  // Formulário irmão do cadastro: versão, comando e salvamento exclusivos da seção.
  return <form onSubmit={save} aria-label={item.title}>
    <fieldset disabled={busy || !writable}><PublicFields data={draft} change={setDraft} writable={writable} /></fieldset>
    {error && <p role="alert" className="notice error">{error} <button type="button" onClick={reload}>Recarregar seção</button></p>}
    {notice && <p role="status">{notice}</p>}
    {writable && <button type="submit" disabled={busy || JSON.stringify(draft) === JSON.stringify(section.data)}>{busy ? "Salvando…" : "Salvar seção"}</button>}
  </form>;
}

// A extensão entrega somente campos administrativos públicos. IDs e campos
// desconhecidos são preservados no corpo, mas nunca viram inputs livres.
const publicLabels: Record<string, string> = { units: "Unidades", memberships: "Vínculos", functions: "Funções", links: "Vínculos", subscriptions: "Mensalidades", notices: "Receber avisos", linked: "Vinculada",
  unit: "Unidade", unitLabel: "Unidade", number: "Número", block: "Bloco", role: "Vínculo ou função", label: "Descrição",
  startsAt: "Início", endsAt: "Fim", starts_at: "Início", ends_at: "Fim" };
const roleLabels: Record<string, string> = { morador: "Morador", proprietario: "Proprietário", inquilino: "Inquilino", sindico: "Síndico", zelador: "Zelador",
  porteiro: "Porteiro", prestador: "Prestador", funcionario: "Empregado da unidade", empregado_unidade: "Empregado da unidade", visitante_recorrente: "Visitante recorrente" };
function PublicFields({ data, change, writable = false }: { data: Json; change(value: Json): void; writable?: boolean }) {
  if (data && typeof data === "object" && !Array.isArray(data) && Array.isArray(data.memberships)) return <div className="customer-profile-fields">
    {(["memberships", "functions", "subscriptions"] as const).map(kind => Array.isArray(data[kind]) && <section key={kind}><h4>{publicLabels[kind]}</h4>
      {(data[kind] as Json[]).length ? (data[kind] as Json[]).map((value, index) => {
        const row = value as Record<string, Json>;
        return <div key={String(row.id ?? `${row.unitId}:${row.subscriptionId}`)} className="customer-profile-relation">
          <PublicFields data={value} writable={writable} change={next => change({ ...data, [kind]: (data[kind] as Json[]).map((entry, i) => i === index ? next : entry) })} />
          {writable && kind !== "subscriptions" && row.endsAt == null && <RoleChange kind={kind} row={row} change={(role, at) => change(replaceSectionRole(data, kind, String(row.id), role, at, crypto.randomUUID()))} />}
        </div>;
      }) : <p>Nenhum vínculo disponível.</p>}
    </section>)}
  </div>;
  if (Array.isArray(data)) return <div className="customer-profile-fields">{data.length ? data.map((value, index) => <PublicFields key={index} data={value}
    writable={writable} change={next => change(data.map((entry, i) => i === index ? next : entry))} />) : <p>Nenhum vínculo disponível.</p>}</div>;
  if (!data || typeof data !== "object") return null;
  const entries = Object.entries(data).filter(([key]) => Object.hasOwn(publicLabels, key));
  return <div className="customer-profile-fields">{entries.length ? entries.map(([key, value]) => <div key={key}>
    {value && typeof value === "object" ? <><h4>{publicLabels[key]}</h4><PublicFields data={value} writable={writable} change={next => change({ ...data, [key]: next })} /></>
      : key === "notices" || key === "linked" ? <label><input type="checkbox" checked={value === true} onChange={event => change({ ...data, [key]: event.target.checked })} />{publicLabels[key]}</label>
      : key === "endsAt" ? <label>{publicLabels[key]}<input type="datetime-local" value={typeof value === "number" ? new Date(value - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ""}
        onChange={event => change({ ...data, [key]: event.target.value ? new Date(event.target.value).getTime() : null })} /></label>
      : <p><strong>{publicLabels[key]}: </strong>{value == null ? "—" : key === "role" ? roleLabels[String(value)] ?? String(value) : String(value)}</p>}
  </div>) : <p>Os vínculos são administrados no módulo Condomínio.</p>}</div>;
}

function RoleChange({ kind, row, change }: { kind: "memberships" | "functions"; row: Record<string, Json>; change(role: string, at: number): void }) {
  const [role, setRole] = useState(""), [at, setAt] = useState("");
  const roles = kind === "memberships" ? ["proprietario", "inquilino", "empregado_unidade"] : ["sindico", "zelador", "porteiro", "prestador", "visitante_recorrente"];
  const timestamp = new Date(at).getTime();
  return <div className="customer-profile-role-change">
    <p>Para mudar o papel, encerre este vínculo e crie outro. A pessoa e a unidade serão preservadas.</p>
    <label>Novo papel<select value={role} onChange={event => setRole(event.target.value)}><option value="">Escolha</option>
      {roles.filter(value => value !== row.role).map(value => <option key={value} value={value}>{roleLabels[value]}</option>)}
    </select></label>
    <label>Data da troca<input type="datetime-local" value={at} onChange={event => setAt(event.target.value)} /></label>
    <button type="button" disabled={!role || !Number.isFinite(timestamp) || timestamp < Number(row.startsAt)} onClick={() => change(role, timestamp)}>Encerrar e criar vínculo</button>
  </div>;
}

function History({ api, base }: { api: Api; base: string }) {
  const [cursor, setCursor] = useState<string | null>(null), [revision, setRevision] = useState(0);
  const state = useResource<HistoryPage>(api, base + "/history?limit=20" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""), revision);
  const names = { conversation: "Atendimento", ticket: "Protocolo", queue: "Fila", form: "Formulário concluído", checkin: "Check-in" };
  return <section className="customer-profile-card" aria-label="Histórico de atendimento"><h3>Histórico de atendimento</h3>
    {state.loading && <p role="status">Carregando histórico…</p>}
    {state.error && <Failure error={state.error} retry={() => setRevision(n => n + 1)} />}
    {state.value && <>{state.value.items.length ? <ul>{state.value.items.map(item => <li key={item.sourceKey}>
      {names[item.kind]} · {cellText(item.occurredAt, "datetime")} · {cellText(item.status, "status")}{item.target && targetHref(item.target) && <> · <a href={targetHref(item.target)!}>Abrir</a></>}
    </li>)}</ul> : <p>Nenhuma interação disponível.</p>}
      {state.value.incomplete && <p role="status">Parte do histórico ainda está sendo preparada.</p>}
      {cursor && <button type="button" onClick={() => setCursor(null)}>Mais recentes</button>}
      {state.value.nextCursor && <button type="button" onClick={() => setCursor(state.value!.nextCursor)}>Interações anteriores</button>}
    </>}
  </section>;
}

/** Entrada ERP: a associação retorna o ID D1; abrir jamais chama promote. */
export function ErpProfileEntry(props: { api: Api; root: string; erpContactId: string; scopeKey: string; onClose(): void; onSaved?(): void; openContactProfile?(contactId: string): void }) {
  return <ErpBindingSession key={JSON.stringify([props.root, props.erpContactId, props.scopeKey])} {...props} />;
}
function ErpBindingSession(props: React.ComponentProps<typeof ErpProfileEntry>) {
  const [contactId, setContactId] = useState<string | null>(null), [error, setError] = useState(""), [pending, setPending] = useState(false), [revision, setRevision] = useState(0);
  const command = useRef(crypto.randomUUID());
  const callbacks = useRef(props); callbacks.current = props;
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    setError(""); setPending(false);
    const open = (id: string) => { if (controller.signal.aborted) return; if (callbacks.current.openContactProfile) callbacks.current.openContactProfile(id); else setContactId(id); };
    const poll = async (jobId: string) => {
      try {
        const job = await readContactJob(props.api, props.root, jobId, controller.signal);
        if (controller.signal.aborted) return;
        if (job.state === "done" && job.contactId) { open(job.contactId); return; }
        if (!["pending", "running"].includes(job.state)) {
          setError(jobMessage(job)); return;
        }
        timer = setTimeout(() => void poll(jobId), 1500);
      } catch (failure) { if (!controller.signal.aborted) setError(profileMessage(failure)); }
    };
    void bindErpContact(props.api, props.root, props.erpContactId, controller.signal, command.current).then(result => {
      if (controller.signal.aborted) return;
      if (result.contactId && (!result.jobId || result.state === "done")) open(result.contactId);
      else if (result.jobId) { setPending(true); void poll(result.jobId); }
    }).catch(failure => { if (!controller.signal.aborted) setError(profileMessage(failure)); });
    return () => { controller.abort(); clearTimeout(timer); };
  }, [props.api, props.root, props.erpContactId, revision]);
  if (contactId) return <ContactProfile api={props.api} root={props.root} contactId={contactId} scopeKey={props.scopeKey} onClose={props.onClose} onSaved={props.onSaved} />;
  return <section className="customer-profile-card"><h2>Ficha do contato</h2>
    {error ? <Failure error={error} retry={() => setRevision(n => n + 1)} /> : <p role="status">{pending ? "Aguardando associação com a ficha…" : "Abrindo ficha…"}</p>}
    <button type="button" onClick={props.onClose}>Voltar à listagem</button>
  </section>;
}
