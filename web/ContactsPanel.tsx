import React, { useEffect, useRef, useState } from "react";
import { useApp } from "./app/AppContext";
import { ContactJob, ContactProfile } from "./contact-profile/ContactProfile";
import { contactNamespace, contactVocabulary, contactWriter, contactsQuery, profileMessage, profileScopeKey, readContactConflicts, resolveContactIdentity, writeFeedback, type ConflictPage, type IdentityConflict, type IdentityFilter, type ProfileVocabulary } from "./contact-profile/model";
import {
  BookUser,
  Download,
  Loader2,
  Plus,
  Search,
  Upload,
  X,
} from "lucide-react";

type Row = Record<string, any>;
type Api = (
  path: string,
  method?: string,
  body?: any,
  signal?: AbortSignal,
  key?: string,
) => Promise<any>;
const blank = { name: "", phone: "", email: "", company: "", notes: "" };
export const demoContacts = [
  {
    ...blank,
    id: "contact-demo-1",
    name: "Marina Oliveira",
    phone: "5511999990000",
    email: "marina@example.com",
    company: "Empresa de exemplo",
    notes: "Dados fictícios para conhecer a agenda.",
    source: "conversation",
    namespace: "team",
    version: 1,
    conversation_count: 1,
  },
  {
    ...blank,
    id: "contact-demo-2",
    name: "Pedro Santos",
    phone: "5511988880000",
    email: "pedro@example.com",
    company: "Loja de exemplo",
    source: "csv",
    namespace: "team",
    version: 1,
    conversation_count: 0,
  },
];
const sourceName = (source: string, phone?: string | null) => source === "automatic" && !phone ? "Perfil salvo automaticamente" :
  ({ csv: "CSV", conversation: "Conversa", manual: "Cadastro manual", automatic: "Telefone salvo automaticamente" })[
    source
  ] || source;

export function Dialog({
  title,
  close,
  busy,
  children,
  wide = false,
}: {
  title: string;
  close: () => void;
  busy: boolean;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div className="modal-backdrop" onClick={() => !busy && close()}>
      <section
        className={
          "modal contacts-dialog" + (wide ? " contacts-dialog-wide" : "")
        }
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) close();
          if (e.key !== "Tab") return;
          const elements = Array.from(
            ref.current!.querySelectorAll<HTMLElement>(
              "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled])",
            ),
          );
          const first = elements[0],
            last = elements.at(-1);
          if (!first) {
            e.preventDefault();
            return;
          }
          if (
            e.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === ref.current)
          ) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        <header>
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Fechar"
            disabled={busy}
            onClick={close}
          >
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

// Retrying an identical action after a lost response must use the same receipt.
function useWrite(api: Api) {
  const write = useRef({ api, send: contactWriter(api) });
  if (write.current.api !== api) write.current = { api, send: contactWriter(api) };
  return write.current.send;
}

/** Mantém a entrada usada pela conversa e pela lista, sempre pelo ID D1. */
export function ContactEditor(props: React.ComponentProps<typeof SimpleContactBody>) {
  const app = useApp(), changed = useRef("");
  const scopeKey = profileScopeKey(props.root, app.me, app.modules);
  useEffect(() => { changed.current = ""; }, [props.contact?.id, scopeKey]);
  if (!props.contact?.id) return <SimpleContactBody key={JSON.stringify([scopeKey, props.conversation?.id])} {...props} />;
  return <ContactProfile api={props.api} root={props.root} contactId={props.contact.id} scopeKey={scopeKey}
    demo={props.demo} initialContact={props.contact} conversation={props.conversation} vocabulary={props.vocabulary}
    onSaved={message => { changed.current = message ?? "Cadastro atualizado."; }} onClose={() => changed.current ? props.saved(changed.current) : props.close()}
    openConversation={props.openConversation} />;
}

export function SimpleContactBody({
  api,
  root,
  contact,
  conversation,
  conversations = [],
  demo,
  close,
  saved,
  openConversation,
  embedded = false,
  writable = true,
  localOnly = false,
  blocked = false,
  vocabulary,
}: {
  api: Api;
  root: string;
  contact?: Row | null;
  conversation?: Row;
  conversations?: Row[];
  demo: boolean;
  close: () => void;
  saved: (message: string, result?: Row) => void;
  openConversation?: (row: Row) => void;
  embedded?: boolean;
  writable?: boolean;
  localOnly?: boolean;
  blocked?: boolean;
  vocabulary?: ProfileVocabulary;
}) {
  const words = contactVocabulary(vocabulary);
  const [form, setForm] = useState<Row>(() => ({
    ...blank,
    ...contact,
    phone:
      contact?.phone ||
      (/^[+\d\s().-]+$/.test(conversation?.phone || "")
        ? conversation?.phone
        : "") ||
      "",
  }));
  const ambiguous = !contact && conversation?.customer_link_state === "ambiguous";
  const [mode, setMode] = useState(ambiguous ? "existing" : "new"),
    [q, setQ] = useState(""),
    [matches, setMatches] = useState<Row[]>([]),
    [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false),
    [searching, setSearching] = useState(false),
    [error, setError] = useState("");
  const write = useWrite(api);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => controller.abort();
  }, [api, root, contact?.id, conversation?.id]);
  const namespace = contactNamespace(contact, conversation);
  useEffect(() => {
    if (mode !== "existing") return;
    if (demo) {
      setMatches(
        demoContacts.filter((c) =>
          c.name.toLowerCase().includes(q.toLowerCase()),
        ),
      );
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      api(
        root +
          "/contacts?limit=50&namespace=" +
          encodeURIComponent(namespace) +
          "&q=" +
          encodeURIComponent(q),
        "GET",
        undefined,
        controller.signal,
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          setMatches(result.data);
          setError("");
        })
        .catch((e) => {
          if (!controller.signal.aborted && e.name !== "AbortError") setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, mode, root, namespace, demo]);
  const act = async (unlink = false) => {
    if (busy || demo || !writable || blocked || ambiguous) return;
    const current = lifetime.current;
    setBusy(true);
    setError("");
    try {
      let result: any;
      if (unlink)
        result = await write(
          root + `/conversations/${encodeURIComponent(conversation!.id)}/contact`,
          "DELETE",
          { expected_contact_id: contact!.id },
          current?.signal,
        );
      else if (contact)
        result = await write(root + "/contacts/" + encodeURIComponent(contact.id), "PATCH", {
          ...Object.fromEntries((localOnly ? ["company", "notes"] : Object.keys(blank)).map((k) => [k, form[k]])),
          expected_version: contact.version,
        }, current?.signal);
      else if (conversation)
        result = await write(
          root + `/conversations/${encodeURIComponent(conversation.id)}/contact`,
          "PUT",
          mode === "existing" ? { contact_id: chosen } : form,
          current?.signal,
        );
      else result = await write(root + "/contacts", "POST", form, current?.signal);
      if (current?.signal.aborted) return;
      const feedback = writeFeedback(result, unlink ? "Contato desvinculado. O cadastro permanece na agenda." : "Cadastro salvo na agenda.");
      saved(feedback.message, result);
      if (unlink && feedback.completed) close();
    } catch (e: any) {
      if (!current?.signal.aborted) setError(e.message);
    } finally {
      if (!current?.signal.aborted) setBusy(false);
    }
  };
  const content = <>
      {!writable && <p className="muted">Somente consulta.</p>}
      {blocked && <p role="status">Há uma solicitação em andamento. Confira o resultado ou cancele a intenção bloqueadora antes de iniciar uma nova edição.</p>}
      {ambiguous && <p className="notice" role="status">Este número tem mais de um contato possível. Resolva a identidade em revisão antes de criar ou vincular um cadastro.</p>}
      {ambiguous && writable && !demo && <ContactConflictReview api={api} root={root} namespace={namespace} />}
      {demo && (
        <p className="notice">Dados fictícios. Entre na sua instalação para salvar contatos.</p>
      )}
      {conversation && !contact && writable && (
        <div className="contact-mode" role="group" aria-label="Como salvar o contato">
          <button type="button" className={mode === "new" ? "button" : "button secondary"} disabled={busy || !writable || ambiguous}
            onClick={() => { setMode("new"); setError(""); }}>Criar novo contato</button>
          <button type="button" className={mode === "existing" ? "button" : "button secondary"} disabled={busy || !writable}
            onClick={() => { setMode("existing"); setError(""); }}>Vincular contato existente</button>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          act();
        }}
      >
        <fieldset disabled={busy || !writable || blocked || ambiguous} className="contact-fields">
          {mode === "existing" && !contact ? (
            <>
              <label className="field">
                <span>Buscar na agenda</span>
                <input
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setChosen("");
                  }}
                  placeholder="Nome, telefone, e-mail ou empresa"
                />
              </label>
              <p>
                Escolha o contato desta conversa. Se houver muitos resultados,
                digite o nome completo.
              </p>
              {searching ? (
                <p role="status">Buscando contatos…</p>
              ) : (
                <div className="contact-matches">
                  {matches.map((row) => (
                    <label key={row.id} className="contact-match">
                      <input
                        type="radio"
                        name="contact"
                        value={row.id}
                        checked={chosen === row.id}
                        onChange={() => setChosen(row.id)}
                        required
                      />
                      <span>
                        <strong>{row.name || row.phone}</strong>
                        <small>
                          {[row.phone, row.email, row.company]
                            .filter(Boolean)
                            .join(" · ") || "Sem dados adicionais"}
                        </small>
                      </span>
                    </label>
                  ))}
                  {!matches.length && (
                    <p>Nenhum contato encontrado. Você pode criar um novo.</p>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              {(
                [
                  ["name", "Nome", "text", 120],
                  ["phone", "Telefone com DDI e DDD", "tel", 40],
                  ["email", "E-mail", "email", 254],
                  ["company", "Empresa", "text", 160],
                ] as const
              ).filter(([key]) => !localOnly || key === "company").map(([key, label, type, max]) => (
                <label className="field" key={key}>
                  <span>
                    {label}
                    {(key !== "name" || !!contact) && <small> (opcional)</small>}
                  </span>
                  <input
                    type={type}
                    required={key === "name" && !contact}
                    maxLength={max}
                    value={form[key]}
                    onChange={(e) =>
                      setForm({ ...form, [key]: e.target.value })
                    }
                    placeholder={
                      key === "phone" ? "Ex.: +55 11 99999-0000" : undefined
                    }
                  />
                </label>
              ))}
              <label className="field">
                <span>
                  Observações <small>(opcional)</small>
                </span>
                <textarea
                  maxLength={2000}
                  rows={3}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
              </label>
            </>
          )}
        </fieldset>
        {contact && (
          <p className="muted">
            As alterações valem para todas as conversas vinculadas a este
            contato.
          </p>
        )}
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={close}
          >
            Cancelar
          </button>
          {writable && <button
            className="button"
            type="submit"
            disabled={busy || demo || blocked || ambiguous || (mode === "existing" && !chosen)}
          >
            {busy ? (
              <>
                <Loader2 className="spin" size={16} /> Salvando…
              </>
            ) : mode === "existing" ? (
              "Vincular contato"
            ) : (
              localOnly ? "Salvar dados do atendimento" : `Salvar ${words.singular.toLocaleLowerCase("pt-BR")}`
            )}
          </button>}
        </div>
      </form>
      {contact && conversation && writable && (
        <div className="contact-unlink">
          <p>
            Se este for o contato errado, desvincule e escolha outro. O cadastro
            e o histórico permanecem salvos.
          </p>
          <button
            className="button secondary"
            type="button"
            disabled={busy || demo || blocked}
            onClick={() => act(true)}
          >
            Desvincular desta conversa
          </button>
        </div>
      )}
      {!embedded && contact && !conversation && openConversation && (
        <div className="contact-history">
          <h3>Conversas vinculadas</h3>
          {conversations.length ? (
            conversations.map((row) => (
              <button
                key={row.id}
                className="contact-history-link"
                disabled={busy}
                onClick={() => openConversation(row)}
              >
                <span>{row.phone || row.external_id}</span>
                <small>
                  {new Date(row.updated).toLocaleDateString("pt-BR", {
                    timeZone: "America/Sao_Paulo",
                  })}
                </small>
              </button>
            ))
          ) : (
            <p>
              Nenhuma conversa vinculada ainda. Abra uma conversa e use “Salvar
              contato”.
            </p>
          )}
          {conversations.length === 50 && (
            <p>Mostrando as 50 conversas mais recentes.</p>
          )}
        </div>
      )}
    </>;
  return embedded ? content : <Dialog title={`${contact ? "Editar" : "Cadastrar"} ${words.singular.toLocaleLowerCase("pt-BR")}${conversation ? " da conversa" : ""}`}
    close={close} busy={busy}>{content}</Dialog>;
}

export function ContactConflictReview({ api, root, namespace, openContact }: {
  api: Api; root: string; namespace?: string; openContact?(id: string): void;
}) {
  const [page, setPage] = useState<ConflictPage | null>(null), [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setPage(null); setError("");
    void readContactConflicts(api, root, cursor, controller.signal).then(result => {
      if (!controller.signal.aborted) setPage(result);
    }).catch(failure => { if (!controller.signal.aborted) setError(profileMessage(failure)); });
    return () => controller.abort();
  }, [api, root, cursor, revision]);
  const items = page?.items.filter(item => !namespace || item.kind === "identity" && item.namespace === namespace) ?? [];
  return <section className="customer-profile-card" aria-label="Revisão de vínculos e solicitações"><h3>Revisão de vínculos e solicitações</h3>
    <p>A escolha administrativa não transfere histórico nem comprova a titularidade do telefone. Sem prova do canal, o vínculo continua pendente.</p>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setRevision(n => n + 1)}>Tentar novamente</button></p>}
    {!page && !error && <p role="status">Carregando revisão…</p>}
    {page && !items.length && <p>Nenhuma pendência deste contexto nesta página.</p>}
    {items.map(item => item.kind === "identity" ? <IdentityReview key={`${item.namespace}:${item.phone}:${item.version}`} api={api} root={root} conflict={item}
      resolved={message => { setNotice(message); setRevision(n => n + 1); }} /> : <div key={item.id}>
        <ContactJob api={api} root={root} id={item.id} writable />
        {openContact && <button type="button" onClick={() => openContact(item.contactId)}>Abrir ficha para revisar os dados</button>}
      </div>)}
    {page?.incomplete && <p role="status">A revisão ainda está incompleta.</p>}
    <div className="customer-profile-actions">
      {cursor && <button type="button" onClick={() => setCursor(null)}>Primeira página</button>}
      {page?.nextCursor && <button type="button" onClick={() => setCursor(page.nextCursor)}>Próxima página de revisão</button>}
    </div>
  </section>;
}

function IdentityReview({ api, root, conflict, resolved }: { api: Api; root: string; conflict: IdentityConflict; resolved(message: string): void }) {
  const [chosen, setChosen] = useState(""), [reason, setReason] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const lifetime = useRef<AbortController | null>(null), command = useRef<{ signature: string; id: string } | null>(null);
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, [api, root, conflict]);
  const resolve = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || !lifetime.current) return;
    const current = lifetime.current; setBusy(true); setError("");
    try {
      const signature = JSON.stringify([conflict.namespace, conflict.phone, conflict.version, chosen, reason.trim()]);
      if (command.current?.signature !== signature) command.current = { signature, id: crypto.randomUUID() };
      const result = await resolveContactIdentity(api, root, conflict, chosen, reason, current.signal, command.current.id);
      if (!current.signal.aborted) resolved(result.state === "pending" || result.reason === "awaiting_proof"
        ? "Escolha registrada. Falta comprovação do vínculo pelo canal; o histórico anterior permanece protegido."
        : "Escolha registrada para revisão. Esta escolha não concede acesso ao histórico anterior.");
    } catch (failure) { if (!current.signal.aborted) setError(profileMessage(failure)); }
    finally { if (!current.signal.aborted) setBusy(false); }
  };
  return <form onSubmit={event => void resolve(event)} aria-label={`Revisar telefone ${conflict.phone}`}>
    <fieldset disabled={busy}><legend>{conflict.phone} · {conflict.namespace === "team" ? "Atendimento" : "Integração externa"}</legend>
      <label>Cadastro escolhido<select required value={chosen} onChange={event => setChosen(event.target.value)}><option value="">Escolha um candidato</option>
        {conflict.candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name || candidate.phone}</option>)}
      </select></label>
      <label>Motivo da revisão<textarea required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <button type="submit" disabled={!chosen || !reason.trim()}>Registrar escolha para revisão</button>
    </fieldset>
    {error && <p role="alert">{error}</p>}
  </form>;
}

function CsvImport({
  api,
  root,
  demo,
  close,
  saved,
}: {
  api: Api;
  root: string;
  demo: boolean;
  close: () => void;
  saved: (message: string) => void;
}) {
  const [csv, setCsv] = useState(""),
    [filename, setFilename] = useState(""),
    [preview, setPreview] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false),
    [stage, setStage] = useState(""),
    [error, setError] = useState("");
  const write = useWrite(api);
  async function choose(file?: File) {
    setPreview(null);
    setCsv("");
    setError("");
    setFilename(file?.name || "");
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setError("Escolha um CSV de até 1 MB.");
      return;
    }
    setBusy(true);
    setStage("Conferindo o arquivo…");
    try {
      const content = await file.text();
      const data = await api(root + "/contacts/import/preview", "POST", {
        csv: content,
      });
      setCsv(content);
      setPreview(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (demo || busy || !preview || preview.errors.length || !preview.new_count)
      return;
    setBusy(true);
    setStage("Importando contatos…");
    setError("");
    try {
      const result = await write(root + "/contacts/import", "POST", { csv });
      saved(
        `${result.imported} contato(s) importado(s). ${result.skipped} linha(s) idêntica(s) ignorada(s).`,
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Importar contatos por CSV" close={close} busy={busy} wide>
      <p>
        Baixe o modelo, substitua o exemplo e salve como{" "}
        <strong>CSV UTF-8</strong>. Aceitamos vírgula ou ponto e vírgula, até{" "}
        <strong>500 contatos e 1 MB</strong> por arquivo.
      </p>
      <a className="text-link" href="/modelo-contatos.csv" download>
        <Download size={16} /> Baixar modelo de CSV
      </a>
      <p>
        Nome é obrigatório. Telefone, e-mail, empresa e observações são
        opcionais. No telefone, inclua DDI e DDD (ex.: 5511999990000).
      </p>
      {demo && (
        <p className="notice">
          A importação fica disponível na sua instalação. Esta é uma tela de
          referência.
        </p>
      )}
      <label className="field">
        <span>Arquivo CSV</span>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={busy || demo}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            choose(file);
          }}
        />
      </label>
      {busy && (
        <p role="status" className="contact-progress">
          <Loader2 size={17} className="spin" />
          {stage}
        </p>
      )}
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {preview && (
        <>
          <div className="contact-import-summary" role="status">
            <strong>{preview.new_count} novos</strong>
            <span>{preview.skipped_count} idênticos ignorados</span>
            <span>{preview.errors.length} com erro</span>
          </div>
          <p className="muted">
            Arquivo: {filename}. Linhas idênticas já importadas são ignoradas.
            Cadastros com dados diferentes são mantidos separados, mesmo com o
            mesmo telefone.
          </p>
          {preview.ignored_columns.length > 0 && (
            <p className="notice">
              Colunas ignoradas: {preview.ignored_columns.join(", ")}. Use nome,
              telefone, email, empresa e observacoes.
            </p>
          )}
          {preview.errors.length > 0 && (
            <div className="notice error">
              <div>
                <strong>
                  Nenhum contato foi salvo. Corrija o arquivo e selecione-o
                  novamente.
                </strong>
                <ul>
                  {preview.errors.slice(0, 20).map((e: Row) => (
                    <li key={e.line}>
                      Linha {e.line}: {e.message}
                    </li>
                  ))}
                </ul>
                {preview.errors.length > 20 && (
                  <p>
                    Mostrando os primeiros 20 erros de {preview.errors.length}.
                  </p>
                )}
              </div>
            </div>
          )}
          <div className="contact-table-wrap">
            <table className="contact-table">
              <caption>Prévia dos contatos — até 100 linhas</caption>
              <thead>
                <tr>
                  <th>Linha</th>
                  <th>Nome</th>
                  <th>Telefone / e-mail</th>
                  <th>Resultado</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 100).map((row: Row) => (
                  <tr key={row.line}>
                    <td>{row.line}</td>
                    <td>{row.values.name}</td>
                    <td>
                      {row.values.phone || "—"}
                      <small>{row.values.email}</small>
                    </td>
                    <td>
                      {row.duplicate ? "Ignorado: idêntico" : "Novo contato"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Importar apenas cadastra os contatos. Não envia mensagens nem
            concede consentimento.
          </p>
          {!preview.new_count && !preview.errors.length && (
            <p className="notice">
              Todos os contatos deste arquivo já foram importados.
            </p>
          )}
        </>
      )}
      <div className="modal-actions">
        <button className="button secondary" disabled={busy} onClick={close}>
          Fechar
        </button>
        <button
          className="button"
          disabled={
            busy || demo || !preview?.new_count || preview.errors.length > 0
          }
          onClick={save}
        >
          <Upload size={16} />
          {busy
            ? stage
            : `Importar${preview?.new_count ? " " + preview.new_count + " contato(s)" : " contatos"}`}
        </button>
      </div>
    </Dialog>
  );
}

export function ContactsPanel({
  api,
  root,
  demo,
  openConversation,
  vocabulary,
}: {
  api: Api;
  root: string;
  demo: boolean;
  openConversation: (row: Row) => void;
  vocabulary?: ProfileVocabulary;
}) {
  const app = useApp();
  const multichannel = app.status?.multichannel === true || (Array.isArray(app.status?.connected_channels)
    && app.status.connected_channels.some((channel: string) => channel !== "whatsapp"));
  const words = contactVocabulary(vocabulary ?? { singular: app.settings?.os_vocabulary?.customer_singular, plural: app.settings?.os_vocabulary?.customer_plural });
  const scopeKey = profileScopeKey(root, app.me, app.modules);
  const [identity, setIdentity] = useState<IdentityFilter>("identified"), [review, setReview] = useState(false);
  const [incomplete, setIncomplete] = useState(false);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]),
    [q, setQ] = useState(""),
    [search, setSearch] = useState("");
  const [cursor, setCursor] = useState(""),
    [next, setNext] = useState<string | null>(null),
    [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<Row | null>(null),
    [importing, setImporting] = useState(false);
  useEffect(() => { setIdentity(value => multichannel && value === "phone_only" ? "no_personal_data"
    : !multichannel && value === "no_personal_data" ? "phone_only" : value); setCursor(""); }, [multichannel]);
  useEffect(() => { setEditor(null); setImporting(false); setCursor(""); }, [scopeKey]);
  useEffect(() => {
    if (demo) {
      setRows(
        demoContacts.filter((c) => !review && (!["phone_only", "no_personal_data"].includes(identity) || !c.name) &&
          (c.name + c.phone + c.email + c.company)
            .toLowerCase()
            .includes(search.toLowerCase()),
        ),
      );
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api(
      root + "/contacts?" + contactsQuery({ search, cursor, identity, review }),
      "GET",
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setRows(result.data);
        setNext(result.next_cursor);
        setIncomplete(!!result.incomplete);
      })
      .catch((e) => {
        if (!controller.signal.aborted && e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [search, cursor, revision, root, demo, identity, review, scopeKey]);
  async function edit(row: Row) {
    if (demo) {
      setEditor({
        contact: row,
        conversations: row.conversation_count
          ? [
              {
                id: "demo-1",
                external_id: row.name,
                phone: row.phone,
                contact_name: row.name,
                contact_id: row.id,
                state: "waiting",
                updated: Date.now(),
                external_namespace: "meta:demo",
              },
            ]
          : [],
      });
      return;
    }
    setEditor({ contact: row });
  }
  function saved(message: string) {
    setEditor(null);
    setImporting(false);
    setNotice(message);
    setCursor("");
    setRevision((v) => v + 1);
  }
  return (
    <div className="contacts-panel">
      <div className="contacts-toolbar">
        <form
          className="contacts-search"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(q);
            setCursor("");
          }}
        >
          <label className="search-box">
            <Search size={18} />
            <input
              aria-label={`Buscar ${words.plural.toLocaleLowerCase("pt-BR")}`}
              placeholder="Nome, telefone, e-mail ou empresa"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <button className="button secondary" type="submit">
            Buscar
          </button>
        </form>
        <div className="contact-actions">
          <a className="button secondary" href="/modelo-contatos.csv" download>
            <Download size={16} /> Modelo CSV
          </a>
          <button
            className="button secondary"
            onClick={() => setImporting(true)}
          >
            <Upload size={16} /> Importar CSV
          </button>
          <button className="button" onClick={() => setEditor({})}>
            <Plus size={16} /> Cadastrar {words.singular.toLocaleLowerCase("pt-BR")}
          </button>
        </div>
      </div>
      {!demo && <button type="button" aria-expanded={conflictsOpen} onClick={() => setConflictsOpen(value => !value)}>Revisar vínculos e solicitações</button>}
      {conflictsOpen && !demo && <ContactConflictReview key={scopeKey} api={api} root={root} openContact={id => setEditor({ contact: { id } })} />}
      <div className="customer-profile-filter">
        <label>Mostrar <select aria-label="Tipo de contato" value={identity} disabled={review} onChange={event => { setIdentity(event.target.value as IdentityFilter); setCursor(""); }}>
          <option value="identified">Identificados</option>{multichannel
            ? <option value="no_personal_data">Sem dados pessoais</option>
            : <option value="phone_only">Somente telefone</option>}<option value="all">Todos</option>
        </select></label>
        <label><input type="checkbox" checked={review} onChange={event => { setReview(event.target.checked); setCursor(""); }} /> Revisar telefones sem interação há 180 dias</label>
      </div>
      {incomplete && <p role="status" className="notice">A lista está incompleta enquanto os vínculos antigos são preparados.</p>}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
          <button onClick={() => setRevision((v) => v + 1)}>
            Tentar novamente
          </button>
        </div>
      )}
      <section className="card contacts-list" aria-busy={loading}>
        <div className="section-heading">
          <div>
            <h2>{words.plural}</h2>
            <p>Cadastros da área de atendimento da empresa.</p>
          </div>
          <BookUser size={24} />
        </div>
        {loading ? (
          <p className="contact-progress" role="status">
            <Loader2 className="spin" size={18} /> Carregando agenda…
          </p>
        ) : rows.length ? (
          <>
            <div className="contact-table-wrap">
              <table className="contact-table">
                <thead>
                  <tr>
                    <th>{words.singular}</th>
                    <th>Telefone / e-mail</th>
                    <th>Empresa</th>
                    <th>Origem</th>
                    <th>Conversas</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <button
                          className="contact-name"
                          onClick={() => edit(row)}
                        >
                          {row.name || row.phone || `${words.singular} sem identificação`}
                        </button>
                        {row.namespace !== "team" && (
                          <small>Integração externa</small>
                        )}
                      </td>
                      <td>
                        {row.phone || "—"}
                        <small>{row.email}</small>
                      </td>
                      <td>{row.company || "—"}</td>
                      <td>{sourceName(row.source, row.phone)}</td>
                      <td>{row.conversation_count || 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="contacts-pagination">
              <span>{rows.length} {rows.length === 1 ? words.singular.toLocaleLowerCase("pt-BR") : words.plural.toLocaleLowerCase("pt-BR")} nesta página</span>
              <div>
                {cursor && (
                  <button
                    className="button secondary"
                    onClick={() => setCursor("")}
                  >
                    Primeira página
                  </button>
                )}
                {next && (
                  <button
                    className="button secondary"
                    onClick={() => setCursor(next)}
                  >
                    Próxima página
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="empty">
            <BookUser size={32} />
            <h3>
              {search ? `Nenhum resultado em ${words.plural.toLocaleLowerCase("pt-BR")}` : "Sua agenda começa aqui"}
            </h3>
            <p>
              {search
                ? "Tente buscar por outro nome, telefone, e-mail ou empresa."
                : `Cadastre ${words.plural.toLocaleLowerCase("pt-BR")} ou importe uma planilha CSV. Quem envia uma mensagem já entra nos contatos automaticamente.`}
            </p>
          </div>
        )}
      </section>
      <div className="contacts-help">
        <div>
          <h3>Contatos das conversas</h3>
          <p>
            Todo número que envia uma mensagem vira contato automaticamente.
            O nome e os demais dados podem ser completados depois na ficha.
          </p>
        </div>
        <div>
          <h3>Trazer sua planilha</h3>
          <p>
            Use o modelo CSV com nome, telefone, email, empresa e observacoes.
            Você confere os dados antes de importar. Até 500 contatos por
            arquivo.
          </p>
        </div>
      </div>
      {editor && (
        <ContactEditor
          api={api}
          root={root}
          demo={demo}
          {...editor}
          vocabulary={words}
          close={() => setEditor(null)}
          saved={saved}
          openConversation={(row) => {
            setEditor(null);
            openConversation(row);
          }}
        />
      )}
      {importing && (
        <CsvImport
          api={api}
          root={root}
          demo={demo}
          close={() => setImporting(false)}
          saved={saved}
        />
      )}
    </div>
  );
}
