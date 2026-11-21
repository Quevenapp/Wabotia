// Financeiro › Contratos (parte Contratos): a lista de contratos de serviço,
// as faturas geradas (com o envio da cobrança pelo WhatsApp que já existe),
// os avisos de renovação e de reajuste, a tabela de índices que a empresa
// mantém, a adoção dos contratos do Bling, a ficha do contrato (situação,
// cobrança recorrente, itens, reajuste, aditivo, renovação, anexos em PDF e
// histórico) e o cadastro. O servidor confere e gera as contas
// (src/erp/contratos/); a tela só manda as escolhas da pessoa.
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { erpPorts } from "./ports";
import { WhatsappSendDialog } from "./app/components/WhatsappSend";
import {
  INDEX_FIELD, MONTHS, PERIODICITY_FIELD, STATUS_ACTIONS, centsText, dayText, moneyInput, percentText, quantityInput, quantityText,
  type AdjustmentPreview, type BlingPreview, type Contract, type ContractFields, type ContractsPage, type ContratosPort, type Hit, type Invoice, type Line,
  type Notice, type Options, type Rate,
} from "./contratos-api";
import "./contratos.css";

const ROUTE = "/contratos";
const errorText = (error: unknown) => (error instanceof Error ? error.message : "Algo deu errado. Atualize a tela e tente de novo.");
const aborted = (error: unknown) => error instanceof Error && error.name === "AbortError";
const when = (value: string | null | undefined) => (value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—");
type Tab = "contratos" | "faturas" | "avisos" | "indices" | "bling";
const TABS: { id: Tab; label: string }[] = [
  { id: "contratos", label: "Contratos" }, { id: "faturas", label: "Faturas" }, { id: "avisos", label: "Avisos" }, { id: "indices", label: "Tabela de índices" }, { id: "bling", label: "Trazer do Bling" },
];

export default function Contratos({ port: injected }: { port?: ContratosPort }) {
  const port = injected ?? erpPorts()?.contratos;
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  if (!port) return <section className="real-state-panel"><h1>Contratos</h1><p>Os contratos de serviço ainda não estão disponíveis nesta área.</p></section>;
  const access = port.access();
  if (!access.parts.contracts || !access.parts.finance)
    return <section className="real-state-panel"><h1>Contratos</h1><p>Os contratos de serviço são do módulo Contratos{access.parts.contracts ? ", que precisa do Financeiro ligado" : ", que está desligado nesta área"}. Contratos depende do Financeiro: peça ao administrador para ligar os dois em Gestão → Módulos.</p></section>;
  const contract = query.get("contrato"), edit = query.get("editar");
  if (contract === "novo") return <ContractForm port={port} />;
  if (edit) return <ContractForm key={edit} port={port} id={edit} />;
  if (contract) return <ContractDetail key={contract} port={port} id={contract} />;
  const tab = (TABS.find((t) => t.id === query.get("aba"))?.id ?? "contratos") as Tab;
  return (
    <section className="contratos">
      <header>
        <h1>Contratos</h1>
        <p>Contratos de serviço com seus clientes: o sistema gera a conta a receber de cada período (quando você liga a cobrança no contrato), avisa a renovação e o mês de reajuste e guarda o histórico de aditivos.</p>
      </header>
      <nav className="contratos-tabs" aria-label="Partes da tela de contratos">
        {TABS.map((t) => <Link key={t.id} to={`${ROUTE}?aba=${t.id}`} aria-current={tab === t.id ? "page" : undefined}>{t.label}</Link>)}
      </nav>
      {tab === "contratos" ? <ContractList port={port} /> : tab === "faturas" ? <Invoices port={port} /> : tab === "avisos" ? <Notices port={port} />
        : tab === "indices" ? <Rates port={port} /> : <Bling port={port} />}
    </section>
  );
}

function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [value, setValue] = useState<T | null>(null), [error, setError] = useState(""), [version, setVersion] = useState(0);
  useEffect(() => {
    const signal = new AbortController();
    setError("");
    load(signal.signal).then(setValue, (e) => { if (!aborted(e)) setError(errorText(e)); });
    return () => signal.abort();
  }, [...deps, version]); // eslint-disable-line react-hooks/exhaustive-deps
  return { value, setValue, error, reload: () => setVersion((n) => n + 1) };
}

function Message({ error, notice }: { error?: string; notice?: string }) {
  return <>{error ? <p className="contratos-error" role="alert">{error}</p> : null}{notice ? <p className="contratos-notice" role="status">{notice}</p> : null}</>;
}

// ---------------------------------------------------------------------------
// Lista

function ContractList({ port }: { port: ContratosPort }) {
  const [status, setStatus] = useState("abertos"), [search, setSearch] = useState(""), [typed, setTyped] = useState(""), [page, setPage] = useState(1);
  const { value, error } = useLoad<ContractsPage>((signal) => port.list({ situacao: status, busca: search || undefined, pagina: page }, signal), [port, status, search, page]);
  return (
    <>
      <div className="contratos-toolbar">
        <label>Situação
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="abertos">Em andamento (rascunho, ativo e suspenso)</option><option value="ativo">Ativos</option><option value="rascunho">Rascunhos</option>
            <option value="suspenso">Suspensos</option><option value="encerrado">Encerrados</option><option value="todos">Todos</option>
          </select>
        </label>
        <form className="contratos-inline" onSubmit={(e) => { e.preventDefault(); setSearch(typed.trim()); setPage(1); }}>
          <label>Buscar por cliente, número ou objeto<input value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
          <button type="submit">Buscar</button>
        </form>
        {value?.can_write ? <Link className="contratos-primary" to={`${ROUTE}?contrato=novo`}>Novo contrato</Link> : null}
      </div>
      <Message error={error} />
      {value && (value.notices > 0 || value.pending_charges > 0) ? (
        <p className="contratos-notice" role="status">
          {value.notices > 0 ? <><Link to={`${ROUTE}?aba=avisos`}>{value.notices} aviso{value.notices > 1 ? "s" : ""} para ver</Link>{value.pending_charges > 0 ? " · " : ""}</> : null}
          {value.pending_charges > 0 ? <Link to={`${ROUTE}?aba=faturas&situacao=cobranca_a_enviar`}>{value.pending_charges} cobrança{value.pending_charges > 1 ? "s" : ""} para enviar pelo WhatsApp</Link> : null}
        </p>
      ) : null}
      {!value ? (!error && <p>Carregando contratos…</p>) : value.items.length === 0 ? <p>Nenhum contrato {status === "todos" ? "cadastrado" : "nesta situação"}.{value.can_write ? " Cadastre o primeiro em Novo contrato, ou traga os do Bling." : ""}</p> : (
        <table className="contratos-table">
          <thead><tr><th>Contrato</th><th>Cliente</th><th>Objeto</th><th>Vigência</th><th>Período</th><th>Valor</th><th>Situação</th><th>Cobrança</th></tr></thead>
          <tbody>{value.items.map((c) => (
            <tr key={c.id}>
              <td><Link to={`${ROUTE}?contrato=${c.id}`}>{c.label}</Link></td><td>{c.contact.name}</td><td>{c.object}</td>
              <td>{dayText(c.starts_on)} a {c.ends_on ? dayText(c.ends_on) : "prazo indeterminado"}</td>
              <td>{c.periodicity_label}, vence dia {c.due_day}</td><td>{centsText(c.amount_cents)}</td><td>{c.status_label}</td>
              <td>{c.billing_enabled ? `Ligada${c.next_period_on ? `, próximo período ${dayText(c.next_period_on)}` : ""}` : "Desligada"}</td>
            </tr>))}
          </tbody>
        </table>
      )}
      {value && value.total > value.per_page ? (
        <div className="contratos-actions">
          <button type="button" disabled={page === 1} onClick={() => setPage((n) => n - 1)}>Página anterior</button><span>Página {page}</span>
          <button type="button" disabled={page * value.per_page >= value.total} onClick={() => setPage((n) => n + 1)}>Próxima página</button>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Faturas

function InvoiceTable({ port, items, onChanged, showContract }: { port: ContratosPort; items: Invoice[]; onChanged: () => void; showContract: boolean }) {
  const [sending, setSending] = useState<Invoice | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const mark = async (invoice: Invoice, acao: "cobranca_enviada" | "dispensar_cobranca" | "nfse_emitida") => {
    setError(""); setNotice("");
    try { await port.markInvoice(invoice.id, acao, port.command()); setNotice(acao === "nfse_emitida" ? "NFS-e marcada como emitida." : acao === "dispensar_cobranca" ? "Envio dispensado." : "Cobrança marcada como enviada."); onChanged(); }
    catch (e) { setError(errorText(e)); }
  };
  if (!items.length) return <p>Nenhuma fatura ainda.</p>;
  return (
    <>
      <Message error={error} notice={notice} />
      <table className="contratos-table">
        <thead><tr>{showContract ? <th>Contrato</th> : null}<th>Período</th><th>Vencimento</th><th>Valor</th><th>No Financeiro</th><th>Cobrança</th><th>Nota de serviço</th></tr></thead>
        <tbody>{items.map((i) => (
          <tr key={i.id}>
            {showContract ? <td>{i.contract_label ? <Link to={`${ROUTE}?contrato=${i.contract_id}`}>{i.contract_label}</Link> : "—"}{i.contact ? ` · ${i.contact.name}` : ""}</td> : null}
            <td>{i.period_label} ({dayText(i.period_start)} a {dayText(i.period_end)})</td><td>{dayText(i.due_on)}</td><td>{centsText(i.amount_cents)}</td>
            <td>{i.status_label}</td>
            <td>{i.charge_label}{i.charge_status !== "sent" && ["open", "overdue"].includes(i.status) ? <> <button type="button" onClick={() => setSending(i)}>Enviar pelo WhatsApp</button></> : null}
              {i.charge_status === "pending" ? <> <button type="button" onClick={() => void mark(i, "cobranca_enviada")}>Já enviei</button> <button type="button" onClick={() => void mark(i, "dispensar_cobranca")}>Dispensar</button></> : null}</td>
            <td>{i.nfse_label}{i.nfse_status === "pending" || i.nfse_status === "not_configured" ? <> <button type="button" onClick={() => void mark(i, "nfse_emitida")}>Marcar como emitida</button></> : null}</td>
          </tr>))}
        </tbody>
      </table>
      {sending ? <WhatsappSendDialog type="conta" id={sending.title_id} onClose={() => setSending(null)}
        onSent={() => { void port.markInvoice(sending.id, "cobranca_enviada", port.command()).then(onChanged, (e) => setError(errorText(e))); }} /> : null}
    </>
  );
}

function Invoices({ port }: { port: ContratosPort }) {
  const location = useLocation();
  const [status, setStatus] = useState(new URLSearchParams(location.search).get("situacao") ?? "todas"), [page, setPage] = useState(1);
  const { value, error, reload } = useLoad((signal) => port.invoices({ situacao: status, pagina: page }, signal), [port, status, page]);
  return (
    <>
      <p>Cada fatura é uma conta a receber no Financeiro. A cobrança pelo WhatsApp usa o envio do ERP (Pix, link ou boleto, conforme a Cobrança da área).</p>
      <div className="contratos-toolbar">
        <label>Mostrar
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="todas">Todas</option><option value="em_aberto">Em aberto</option><option value="vencidas">Vencidas</option><option value="pagas">Pagas</option>
            <option value="canceladas">Canceladas</option><option value="cobranca_a_enviar">Cobrança a enviar</option><option value="nfse_a_emitir">NFS-e a emitir</option>
          </select>
        </label>
      </div>
      <Message error={error} />
      {!value ? (!error && <p>Carregando faturas…</p>) : <InvoiceTable port={port} items={value.items} onChanged={reload} showContract />}
      {value && value.total > value.per_page ? (
        <div className="contratos-actions">
          <button type="button" disabled={page === 1} onClick={() => setPage((n) => n - 1)}>Página anterior</button><span>Página {page}</span>
          <button type="button" disabled={page * value.per_page >= value.total} onClick={() => setPage((n) => n + 1)}>Próxima página</button>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Avisos

function NoticeList({ port, items, onChanged }: { port: ContratosPort; items: Notice[]; onChanged: () => void }) {
  const [error, setError] = useState(""), [copied, setCopied] = useState("");
  const close = async (n: Notice, acao: "feito" | "dispensar") => {
    setError("");
    try { await port.closeNotice(n.id, acao, port.command()); onChanged(); } catch (e) { setError(errorText(e)); }
  };
  if (!items.length) return <p>Nenhum aviso pendente.</p>;
  return (
    <>
      <Message error={error} notice={copied ? "Mensagem copiada. Cole na conversa com o cliente." : ""} />
      <ul className="contratos-notices">{items.map((n) => (
        <li key={n.id}>
          <strong>{n.kind_label}{n.contract_label ? <> · <Link to={`${ROUTE}?contrato=${n.contract_id}`}>{n.contract_label}</Link></> : null}</strong>
          <p>{n.message}</p>
          <div className="contratos-actions">
            {n.kind === "customer_adjustment" ? <button type="button" onClick={() => { void navigator.clipboard?.writeText(n.message).then(() => setCopied(n.id)); }}>Copiar mensagem para o cliente</button> : null}
            <button type="button" onClick={() => void close(n, "feito")}>{n.kind === "customer_adjustment" ? "Já avisei" : "Feito"}</button>
            <button type="button" onClick={() => void close(n, "dispensar")}>Dispensar</button>
          </div>
        </li>))}
      </ul>
    </>
  );
}
function Notices({ port }: { port: ContratosPort }) {
  const { value, error, reload } = useLoad((signal) => port.notices(false, signal), [port]);
  return <><p>Avisos da rotina diária: contratos perto do fim, meses de reajuste chegando e a mensagem do reajuste para o cliente.</p><Message error={error} />
    {!value ? (!error && <p>Carregando avisos…</p>) : <NoticeList port={port} items={value.items} onChanged={reload} />}</>;
}

// ---------------------------------------------------------------------------
// Tabela de índices

function Rates({ port }: { port: ContratosPort }) {
  const { value, error, reload } = useLoad<{ items: Rate[]; indices: { id: string; label: string }[]; can_write: boolean }>((signal) => port.rates(signal), [port]);
  const [index, setIndex] = useState("ipca"), [month, setMonth] = useState(""), [percent, setPercent] = useState(""), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ error: "", notice: "" });
  const save = async (remove = false) => {
    setMessage({ error: "", notice: "" });
    if (!/^\d{4}-\d{2}$/.test(month)) return setMessage({ error: "Escolha o mês do índice.", notice: "" });
    const value = percent.trim().replace(",", ".");
    if (!remove && !/^-?\d{1,3}(\.\d{1,4})?$/.test(value)) return setMessage({ error: "Informe o percentual acumulado, como 4,56.", notice: "" });
    setBusy(true);
    try { await port.saveRate({ indice: index, mes: month, percentual: remove ? null : value, comando: port.command() }); setMessage({ error: "", notice: remove ? "Índice apagado." : "Índice gravado." }); setPercent(""); reload(); }
    catch (e) { setMessage({ error: errorText(e), notice: "" }); } finally { setBusy(false); }
  };
  return (
    <>
      <p>O sistema não busca índice na internet. Informe aqui o percentual acumulado em 12 meses de cada índice no mês de aniversário dos seus contratos (o IBGE publica o IPCA e o INPC; a FGV, o IGP-M). O reajuste usa o percentual do mês de referência.</p>
      <Message error={error || message.error} notice={message.notice} />
      {value?.can_write ? (
        <form className="contratos-toolbar" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <label>Índice<select value={index} onChange={(e) => setIndex(e.target.value)}>{(value.indices ?? []).map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}</select></label>
          <label>Mês<input type="month" value={month} onChange={(e) => setMonth(e.target.value)} required /></label>
          <label>Percentual (%)<input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="4,56" /></label>
          <button type="submit" disabled={busy}>Gravar</button>
          <button type="button" disabled={busy} onClick={() => void save(true)}>Apagar este mês</button>
        </form>
      ) : null}
      {!value ? (!error && <p>Carregando…</p>) : value.items.length === 0 ? <p>Nenhum índice informado ainda.</p> : (
        <table className="contratos-table"><thead><tr><th>Índice</th><th>Mês</th><th>Percentual</th><th>Atualizado</th></tr></thead>
          <tbody>{value.items.map((r) => <tr key={`${r.index}:${r.month}`}><td>{r.index_label}</td><td>{MONTHS[Number(r.month.slice(5)) - 1]}/{r.month.slice(0, 4)}</td><td>{percentText(r.percent)}</td><td>{when(r.updated_at)}</td></tr>)}</tbody>
        </table>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Bling

function Bling({ port }: { port: ContratosPort }) {
  const navigate = useNavigate();
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const { value, error, reload } = useLoad((signal) => port.bling(cursor, signal), [port, cursor]);
  const { value: options } = useLoad<Options>((signal) => port.options(signal), [port]);
  const [choice, setChoice] = useState<Record<string, { periodicidade?: string; categoria?: string; forma_pagamento?: string }>>({});
  const [busy, setBusy] = useState(""), [message, setMessage] = useState("");
  const adopt = async (item: BlingPreview) => {
    setBusy(item.source_id); setMessage("");
    const c = choice[item.source_id] ?? {};
    try {
      const { contract } = await port.adoptBling(item.source_id, { versao_bling: item.version, ...(c.periodicidade ? { periodicidade: c.periodicidade } : {}),
        ...(c.categoria ? { categoria: c.categoria } : {}), ...(c.forma_pagamento ? { forma_pagamento: c.forma_pagamento } : {}), comando: port.command() });
      navigate(`${ROUTE}?contrato=${contract.id}`);
    } catch (e) { setMessage(errorText(e)); reload(); } finally { setBusy(""); }
  };
  return (
    <>
      <p>Contratos coletados do Bling podem virar contrato de serviço aqui. O contrato nasce em rascunho e com a cobrança desligada: confira, ative e ligue a cobrança quando quiser. Contrato que já virou contrato de manutenção da Ordem de Serviço não vira contrato de serviço (para não cobrar duas vezes).</p>
      <Message error={error || message} />
      {!value ? (!error && <p>Carregando a prévia…</p>) : !value.available ? <p>O acervo do Bling não está disponível nesta área. Conecte e colete em <Link to="/receber-bling">Receber dados do Bling</Link> (com a seleção de Contratos ligada).</p>
        : value.items.length === 0 ? <p>Nenhum contrato coletado do Bling.</p> : (
          <ul className="contratos-bling">{value.items.map((item) => (
            <li key={item.source_id}>
              <strong>Contrato {item.number ?? item.source_id} do Bling</strong> · {item.customer.name ?? "cliente sem nome"}{item.situation ? ` · ${item.situation}` : ""}
              <p>{item.description ?? "Sem descrição."} Vigência {dayText(item.starts_on)} a {item.ends_on ? dayText(item.ends_on) : "prazo indeterminado"}; {item.periodicity_text ?? "periodicidade não informada"}; {centsText(item.amount_cents)} por período.</p>
              {item.items.length ? <ul>{item.items.map((it, n) => <li key={n}>{it.description}: {quantityText(it.quantity)} × {centsText(it.unit_cents)}</li>)}</ul> : null}
              {item.linked ? <p>Já virou o <Link to={`${ROUTE}?contrato=${item.linked.contract_id}`}>{item.linked.label}</Link>.</p> : null}
              {item.problems.length ? <ul className="contratos-problems">{item.problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
              {!item.linked && !item.maintenance && item.contact_id && item.starts_on && item.items.length && options?.can_write ? (
                <div className="contratos-toolbar">
                  {!item.periodicity ? <label>Periodicidade<select value={choice[item.source_id]?.periodicidade ?? ""} onChange={(e) => setChoice({ ...choice, [item.source_id]: { ...choice[item.source_id], periodicidade: e.target.value } })}>
                    <option value="">Escolha</option>{options.periodicities.map((p) => <option key={p.id} value={PERIODICITY_FIELD[p.id]}>{p.label}</option>)}</select></label> : null}
                  <label>Categoria<select value={choice[item.source_id]?.categoria ?? ""} onChange={(e) => setChoice({ ...choice, [item.source_id]: { ...choice[item.source_id], categoria: e.target.value } })}>
                    <option value="">Sem categoria</option>{options.categories.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
                  <label>Forma de pagamento<select value={choice[item.source_id]?.forma_pagamento ?? ""} onChange={(e) => setChoice({ ...choice, [item.source_id]: { ...choice[item.source_id], forma_pagamento: e.target.value } })}>
                    <option value="">Sem forma</option>{options.payment_methods.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
                  <button type="button" disabled={busy === item.source_id || (!item.periodicity && !choice[item.source_id]?.periodicidade)} onClick={() => void adopt(item)}>Criar contrato de serviço</button>
                </div>
              ) : null}
            </li>))}
          </ul>
        )}
      {value?.next_cursor ? <button type="button" onClick={() => setCursor(value.next_cursor ?? undefined)}>Ver mais contratos do Bling</button> : null}
      {cursor ? <button type="button" onClick={() => setCursor(undefined)}>Voltar ao começo</button> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Ficha do contrato

function LineTable({ lines, caption }: { lines: Line[]; caption?: string }) {
  if (!lines.length) return null;
  return (
    <table className="contratos-table">
      {caption ? <caption>{caption}</caption> : null}
      <thead><tr><th>Item</th><th>Quantidade</th><th>Valor unitário</th><th>Total</th><th>Vale de</th><th>Até</th></tr></thead>
      <tbody>{lines.map((l) => <tr key={l.id || `${l.position}:${l.valid_from}`}><td>{l.description}</td><td>{quantityText(l.quantity)}</td><td>{centsText(l.unit_cents)}</td><td>{centsText(l.total_cents)}</td>
        <td>{dayText(l.valid_from)}</td><td>{l.valid_until ? dayText(l.valid_until) : "—"}</td></tr>)}</tbody>
    </table>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="contratos-section"><h2>{title}</h2>{children}</section>;
}

function ContractDetail({ port, id }: { port: ContratosPort; id: string }) {
  const { value, error, setValue, reload } = useLoad((signal) => port.get(id, signal), [port, id]);
  const { value: options } = useLoad<Options>((signal) => port.options(signal), [port]);
  const [message, setMessage] = useState({ error: "", notice: "" }), [busy, setBusy] = useState(false);
  const contract = value?.contract;
  const run = async (task: () => Promise<{ contract: Contract } | unknown>, notice: string) => {
    setBusy(true); setMessage({ error: "", notice: "" });
    try {
      const result = await task();
      if (result && typeof result === "object" && "contract" in result) setValue({ contract: (result as { contract: Contract }).contract }); else reload();
      setMessage({ error: "", notice });
    } catch (e) { setMessage({ error: errorText(e), notice: "" }); if ((e as { code?: string }).code === "conflict") reload(); }
    finally { setBusy(false); }
  };
  if (error) return <section className="contratos"><p><Link to={ROUTE}>Voltar aos contratos</Link></p><Message error={error} /></section>;
  if (!contract) return <section className="contratos"><p>Carregando contrato…</p></section>;
  const c = contract, write = c.can_write;
  return (
    <section className="contratos">
      <p><Link to={ROUTE}>Voltar aos contratos</Link></p>
      <header>
        <h1>{c.label} · {c.contact?.name ?? "Cliente"}</h1>
        <p><span className={`contratos-status contratos-status-${c.status}`}>{c.status_label}</span> {c.origin === "bling" ? "· Trazido do Bling" : ""}</p>
      </header>
      <Message error={message.error} notice={message.notice} />
      <dl className="contratos-facts">
        <dt>Objeto</dt><dd>{c.object}</dd>
        <dt>Vigência</dt><dd>{dayText(c.starts_on)} a {c.ends_on ? dayText(c.ends_on) : "prazo indeterminado"}{c.term_months ? ` (renova por ${c.term_months} meses)` : ""}</dd>
        <dt>Faturamento</dt><dd>{c.periodicity_label}, vence todo dia {c.due_day} · {centsText(c.amount_cents)} por período</dd>
        <dt>Forma de pagamento</dt><dd>{c.payment_method?.name ?? "—"}</dd><dt>Categoria</dt><dd>{c.category?.name ?? "—"}</dd><dt>Vendedor</dt><dd>{c.seller?.name ?? "—"}</dd>
        {c.notes ? <><dt>Observações</dt><dd>{c.notes}</dd></> : null}
        {c.end_reason ? <><dt>Encerramento</dt><dd>{dayText(c.ended_on)}: {c.end_reason}</dd></> : null}
      </dl>
      {write && c.status !== "ended" ? (
        <div className="contratos-actions">
          <Link to={`${ROUTE}?editar=${c.id}`}>Editar dados</Link>
          <StatusActions port={port} contract={c} busy={busy} run={run} />
        </div>
      ) : null}
      {c.notices.length ? <Section title="Avisos"><NoticeList port={port} items={c.notices} onChanged={reload} /></Section> : null}
      <Section title="Cobrança recorrente"><Billing port={port} contract={c} options={options} busy={busy} run={run} /></Section>
      <Section title="Itens">
        <LineTable lines={c.items} />
        <LineTable lines={c.scheduled_items} caption="Agendados (aditivo ou reajuste a partir da data)" />
        {c.history_items.length ? <details><summary>Itens de antes</summary><LineTable lines={c.history_items} /></details> : null}
      </Section>
      <Section title="Faturas"><InvoiceTable port={port} items={c.invoices} onChanged={reload} showContract={false} /></Section>
      {c.status === "active" || c.status === "suspended" ? (
        <>
          <Section title="Reajuste"><Adjustment port={port} contract={c} busy={busy} run={run} /></Section>
          {write ? <Section title="Aditivo"><Amendment port={port} contract={c} busy={busy} run={run} /></Section> : null}
          {write && c.ends_on ? <Section title="Renovação"><Renewal port={port} contract={c} busy={busy} run={run} /></Section> : null}
        </>
      ) : null}
      <Section title="Anexos"><Attachments port={port} contract={c} busy={busy} run={run} /></Section>
      <Section title="Histórico">
        <ul className="contratos-history">{c.events.map((e) => <li key={e.id}><time>{when(e.created_at)}</time> {e.summary}{e.by_alarm ? " (rotina automática)" : ""}</li>)}</ul>
      </Section>
    </section>
  );
}
type Run = (task: () => Promise<unknown>, notice: string) => Promise<void>;

function StatusActions({ port, contract: c, busy, run }: { port: ContratosPort; contract: Contract; busy: boolean; run: Run }) {
  const [asking, setAsking] = useState<null | (typeof STATUS_ACTIONS)["active"][number]>(null), [reason, setReason] = useState("");
  return (
    <>
      {STATUS_ACTIONS[c.status].map((a) => <button key={a.acao} type="button" disabled={busy} onClick={() => {
        if (!a.reason) void run(() => port.status(c.id, a.acao, { versao: c.version, comando: port.command() }), a.acao === "ativar" ? "Contrato ativado. A cobrança continua como está: ligue em Cobrança recorrente quando quiser cobrar." : "Contrato reativado.");
        else { setAsking(a); setReason(""); }
      }}>{a.label}</button>)}
      {asking ? (
        <form className="contratos-inline" onSubmit={(e) => {
          e.preventDefault();
          if (asking.reason === "required" && reason.trim().length < 3) return;
          void run(() => port.status(c.id, asking.acao, { versao: c.version, ...(reason.trim() ? { motivo: reason.trim() } : {}), comando: port.command() }),
            asking.acao === "encerrar" ? "Contrato encerrado. As contas já geradas continuam no Financeiro." : "Contrato suspenso: nenhuma conta é gerada enquanto estiver suspenso.").then(() => setAsking(null));
        }}>
          <label>Motivo {asking.reason === "required" ? "(obrigatório)" : "(opcional)"}<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={400} required={asking.reason === "required"} minLength={asking.reason === "required" ? 3 : undefined} /></label>
          <button type="submit" disabled={busy}>Confirmar: {asking.label.toLowerCase()}</button><button type="button" onClick={() => setAsking(null)}>Cancelar</button>
        </form>
      ) : null}
    </>
  );
}

function Billing({ port, contract: c, options, busy, run }: { port: ContratosPort; contract: Contract; options: Options | null; busy: boolean; run: Run }) {
  const [send, setSend] = useState(c.billing.send_whatsapp), [nfse, setNfse] = useState(c.billing.emit_nfse), [from, setFrom] = useState("");
  const [period, setPeriod] = useState(c.billing.next_period_on ?? "");
  const b = c.billing;
  return (
    <>
      <p>{b.enabled ? `Ligada. A rotina diária gera a conta a receber no começo de cada período${b.next_period_on ? `; o próximo é ${dayText(b.next_period_on)}, com vencimento em ${dayText(b.next_due_on)} (${centsText(b.next_amount_cents)})` : ""}.` : "Desligada: nenhuma conta é gerada. A cobrança nasce desligada em todo contrato; ligue quando quiser começar a cobrar."}
        {b.after_end ? " A vigência terminou: renove para continuar cobrando." : ""}{c.status !== "active" ? " Só contrato ativo gera conta." : ""}</p>
      {c.can_write && c.status !== "ended" ? (
        <form onSubmit={(e) => { e.preventDefault(); void run(() => port.billing(c.id, { versao: c.version, ligada: !b.enabled || false, enviar_whatsapp: send, emitir_nfse: nfse, ...(!b.enabled && from ? { a_partir_de: from } : {}), comando: port.command() }),
          b.enabled ? "Cobrança desligada." : "Cobrança ligada. A conta do período que já começou foi gerada agora; as próximas saem sozinhas."); }}>
          <label><input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} disabled={b.enabled} /> Deixar a cobrança de cada fatura pronta para enviar pelo WhatsApp</label>
          <label><input type="checkbox" checked={nfse} onChange={(e) => setNfse(e.target.checked)} disabled={b.enabled} /> Marcar a nota de serviço (NFS-e) para emitir em cada fatura</label>
          {nfse && !b.nfse_configured ? <p className="contratos-hint">A nota de serviço não está configurada (Fiscal ligado e serviço da NFS-e preenchido). Sem isso, a fatura sai só com a conta a receber.</p> : null}
          {!b.enabled ? <label>Começar a cobrar no período que começa em (opcional; vazio: o período de hoje)<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} min={c.starts_on} /></label> : null}
          <button type="submit" disabled={busy} className={b.enabled ? undefined : "contratos-primary"}>{b.enabled ? "Desligar a cobrança" : "Ligar a cobrança"}</button>
          {b.enabled ? <p className="contratos-hint">Para mudar o WhatsApp ou a NFS-e, desligue e ligue de novo com as opções novas.</p> : null}
        </form>
      ) : null}
      {c.status === "active" && options?.can_bill ? (
        <form className="contratos-inline" onSubmit={(e) => { e.preventDefault(); if (period) void run(() => port.billNow(c.id, { versao: c.version, periodo: period, comando: port.command() }), "Conta do período gerada agora."); }}>
          <label>Gerar agora a conta do período que começa em<input type="date" value={period} onChange={(e) => setPeriod(e.target.value)} min={c.starts_on} max={c.ends_on ?? undefined} /></label>
          <button type="submit" disabled={busy || !period}>Gerar conta</button>
        </form>
      ) : null}
    </>
  );
}

function Adjustment({ port, contract: c, busy, run }: { port: ContratosPort; contract: Contract; busy: boolean; run: Run }) {
  const [preview, setPreview] = useState<AdjustmentPreview | null>(null), [error, setError] = useState("");
  if (!c.adjustment) return <p>Sem reajuste configurado. {c.can_write ? <Link to={`${ROUTE}?editar=${c.id}`}>Escolha o índice e o mês de aniversário no cadastro.</Link> : null}</p>;
  const a = c.adjustment;
  const load = async () => { setError(""); try { setPreview(await port.adjustmentPreview(c.id)); } catch (e) { setError(errorText(e)); } };
  return (
    <>
      <p>{a.index_label}{a.index === "fixed" ? ` de ${percentText(a.percent)}` : ""}, todo ano em {MONTHS[a.month - 1]}. {a.last_month ? `Último reajuste: ${a.last_month.slice(5)}/${a.last_month.slice(0, 4)}. ` : ""}Próximo: {a.next_month.slice(5)}/{a.next_month.slice(0, 4)}.{a.notify ? " O cliente é avisado com uma mensagem pronta." : ""}</p>
      <Message error={error} />
      <button type="button" onClick={() => void load()}>Conferir o próximo reajuste</button>
      {preview ? (
        <div className="contratos-preview">
          {preview.missing_rate ? <p>O {preview.index_label} de {preview.month_label} ainda não está na <Link to={`${ROUTE}?aba=indices`}>tabela de índices</Link>. Informe o percentual e confira de novo.</p> : (
            <>
              <p>Reajuste de {preview.month_label}: {percentText(preview.percent)} a partir de {dayText(preview.effective_on)}, de {centsText(preview.before_cents)} para {centsText(preview.after_cents)} por período.
                {preview.invoices_after ? ` ${preview.invoices_after} fatura(s) já gerada(s) a partir dessa data não muda(m).` : ""}</p>
              <LineTable lines={preview.after} caption="Itens depois do reajuste" />
              {preview.too_early ? <p>Ainda não chegou o mês de aniversário: o reajuste poderá ser aplicado a partir de {dayText(`${preview.month}-01`)}.</p>
                : preview.future_change ? <p>Há um aditivo agendado depois dessa data: aplique o reajuste depois dele.</p>
                  : c.can_write ? <button type="button" className="contratos-primary" disabled={busy} onClick={() => void run(() => port.adjust(c.id, { versao: c.version, mes: preview.month, percentual: preview.percent!, comando: port.command() }).then((r) => { setPreview(null); return r; }), "Reajuste aplicado.")}>Aplicar o reajuste</button> : null}
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

function ItemsEditor({ port, items, setItems }: { port: ContratosPort; items: ItemDraft[]; setItems: (items: ItemDraft[]) => void }) {
  const update = (n: number, patch: Partial<ItemDraft>) => setItems(items.map((it, i) => (i === n ? { ...it, ...patch } : it)));
  return (
    <fieldset className="contratos-items">
      <legend>Itens</legend>
      {items.map((it, n) => (
        <div key={n} className="contratos-item">
          <Picker port={port} kind="servicos" label="Serviço do catálogo (opcional)" value={it.service} onPick={(hit) => update(n, { service: hit, description: it.description || (hit?.name ?? ""), price: it.price || (hit?.price ? hit.price.replace(".", ",") : "") })} />
          <label>Descrição<input value={it.description} onChange={(e) => update(n, { description: e.target.value })} maxLength={400} /></label>
          <label>Quantidade<input inputMode="decimal" value={it.quantity} onChange={(e) => update(n, { quantity: e.target.value })} /></label>
          <label>Valor unitário (R$)<input inputMode="decimal" value={it.price} onChange={(e) => update(n, { price: e.target.value })} placeholder="350,00" /></label>
          {items.length > 1 ? <button type="button" onClick={() => setItems(items.filter((_, i) => i !== n))}>Tirar item</button> : null}
        </div>
      ))}
      <button type="button" onClick={() => setItems([...items, { service: null, description: "", quantity: "1", price: "" }])}>Mais um item</button>
    </fieldset>
  );
}
interface ItemDraft { service: Hit | null; description: string; quantity: string; price: string }
const draftOf = (l: Line): ItemDraft => ({ service: l.product_id ? { id: l.product_id, name: l.description } : null, description: l.description, quantity: quantityText(l.quantity), price: (l.unit_cents / 100).toFixed(2).replace(".", ",") });
/** Itens do rascunho na forma da rota; o primeiro problema em palavras. */
function itemsOut(items: ItemDraft[]): { itens?: ContractFields["itens"]; problem?: string } {
  const out: NonNullable<ContractFields["itens"]> = [];
  for (const [n, it] of items.entries()) {
    const price = moneyInput(it.price), quantity = quantityInput(it.quantity || "1");
    if (!it.service && !it.description.trim()) return { problem: `Item ${n + 1}: escolha o serviço ou escreva a descrição.` };
    if (price === null) return { problem: `Item ${n + 1}: informe o valor em reais, como 350,00.` };
    if (quantity === null) return { problem: `Item ${n + 1}: a quantidade precisa ser maior que zero.` };
    out.push({ ...(it.service ? { servico: it.service.id } : {}), ...(it.description.trim() ? { descricao: it.description.trim() } : {}), quantidade: quantity, valor: price });
  }
  return { itens: out };
}

function Amendment({ port, contract: c, busy, run }: { port: ContratosPort; contract: Contract; busy: boolean; run: Run }) {
  const [open, setOpen] = useState(false), [from, setFrom] = useState(""), [items, setItems] = useState<ItemDraft[]>(() => c.items.map(draftOf));
  const [changeItems, setChangeItems] = useState(true), [changeEnd, setChangeEnd] = useState(false), [end, setEnd] = useState(c.ends_on ?? ""), [reason, setReason] = useState(""), [problem, setProblem] = useState("");
  if (!open) return <><p>O aditivo muda os itens ou o valor a partir de uma data, ou o fim da vigência. As faturas já geradas não mudam.</p><button type="button" onClick={() => setOpen(true)}>Registrar aditivo</button></>;
  return (
    <form onSubmit={(e) => {
      e.preventDefault(); setProblem("");
      const out = changeItems ? itemsOut(items) : {};
      if (out.problem) return setProblem(out.problem);
      if (!from) return setProblem("Informe a partir de quando o aditivo vale.");
      if (reason.trim().length < 3) return setProblem("Escreva o motivo do aditivo.");
      if (!changeItems && !changeEnd) return setProblem("Marque o que o aditivo muda: os itens, o fim da vigência ou os dois.");
      void run(() => port.amend(c.id, { versao: c.version, a_partir_de: from, ...(changeItems ? { itens: out.itens } : {}), ...(changeEnd ? { fim: end || null } : {}), motivo: reason.trim(), comando: port.command() }).then((r) => { setOpen(false); return r; }), "Aditivo registrado.");
    }}>
      <Message error={problem} />
      <label>Vale a partir de<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} min={c.starts_on} required /></label>
      <label><input type="checkbox" checked={changeItems} onChange={(e) => setChangeItems(e.target.checked)} /> Muda os itens ou o valor</label>
      {changeItems ? <ItemsEditor port={port} items={items} setItems={setItems} /> : null}
      <label><input type="checkbox" checked={changeEnd} onChange={(e) => setChangeEnd(e.target.checked)} /> Muda o fim da vigência</label>
      {changeEnd ? <label>Novo fim (vazio: prazo indeterminado)<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} min={c.starts_on} /></label> : null}
      <label>Motivo<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={400} required minLength={3} /></label>
      <div className="contratos-actions"><button type="submit" className="contratos-primary" disabled={busy}>Registrar aditivo</button><button type="button" onClick={() => setOpen(false)}>Cancelar</button></div>
    </form>
  );
}

function Renewal({ port, contract: c, busy, run }: { port: ContratosPort; contract: Contract; busy: boolean; run: Run }) {
  const [end, setEnd] = useState("");
  return (
    <form className="contratos-inline" onSubmit={(e) => { e.preventDefault(); void run(() => port.renew(c.id, { versao: c.version, ...(end ? { fim: end } : {}), comando: port.command() }), "Contrato renovado."); }}>
      <p>A vigência vai até {dayText(c.ends_on)}. O aviso sai {c.renewal_notice_days} dias antes do fim. Renovar estende a vigência {c.term_months ? `por ${c.term_months} meses` : "pela mesma duração"}, ou até a data que você escolher.</p>
      <label>Novo fim (opcional)<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} min={c.ends_on ?? undefined} /></label>
      <button type="submit" disabled={busy}>Renovar</button>
    </form>
  );
}

function Attachments({ port, contract: c, busy, run }: { port: ContratosPort; contract: Contract; busy: boolean; run: Run }) {
  const [file, setFile] = useState<File | null>(null), [problem, setProblem] = useState("");
  return (
    <>
      {c.attachments.length ? <ul>{c.attachments.map((a) => <li key={a.id}><a href={port.attachmentUrl(a.id)} download>{a.filename}</a> ({Math.ceil(a.size_bytes / 1024)} KB, {when(a.created_at)})
        {c.can_write ? <> <button type="button" disabled={busy} onClick={() => void run(() => port.removeAttachment(a.id, port.command()), "Anexo retirado.")}>Retirar</button></> : null}</li>)}</ul> : <p>Nenhum anexo. Guarde aqui o contrato assinado em PDF.</p>}
      {c.can_write ? (
        <form className="contratos-inline" onSubmit={(e) => {
          e.preventDefault(); setProblem("");
          if (!file) return setProblem("Escolha o arquivo PDF.");
          if (file.size > 10 * 1024 * 1024) return setProblem("O PDF passa de 10 MB. Reduza o arquivo e tente de novo.");
          void run(() => port.upload(c.id, file).then((r) => { setFile(null); return r; }), "Anexo guardado.");
        }}>
          <Message error={problem} />
          <label>Contrato assinado (PDF, até 10 MB)<input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          <button type="submit" disabled={busy || !file}>Anexar</button>
        </form>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Cadastro

function Picker({ port, kind, label, value, onPick }: { port: ContratosPort; kind: "clientes" | "servicos"; label: string; value: Hit | null; onPick: (hit: Hit | null) => void }) {
  const [typed, setTyped] = useState(""), [hits, setHits] = useState<Hit[]>([]), [error, setError] = useState("");
  const search = async () => {
    setError("");
    if (typed.trim().length < 2) return setError("Digite pelo menos 2 letras.");
    try { setHits((await port.search(kind, typed.trim())).items); } catch (e) { setError(errorText(e)); }
  };
  if (value) return <p className="contratos-picked">{label}: <strong>{value.name}</strong> <button type="button" onClick={() => onPick(null)}>Trocar</button></p>;
  return (
    <div className="contratos-picker">
      <label>{label}<input value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void search(); } }} /></label>
      <button type="button" onClick={() => void search()}>Procurar</button>
      {error ? <span className="contratos-error" role="alert">{error}</span> : null}
      {hits.length ? <ul>{hits.map((h) => <li key={h.id}><button type="button" onClick={() => { onPick(h); setHits([]); }}>{h.name}{h.document ? ` · ${h.document}` : ""}{h.code ? ` · ${h.code}` : ""}{kind === "servicos" && h.service === false ? " (produto)" : ""}</button></li>)}</ul> : null}
    </div>
  );
}

function ContractForm({ port, id }: { port: ContratosPort; id?: string }) {
  const navigate = useNavigate();
  const { value: options, error: optionsError } = useLoad<Options>((signal) => port.options(signal), [port]);
  const { value: loaded, error: loadError } = useLoad((signal) => (id ? port.get(id, signal) : Promise.resolve(null)), [port, id]);
  const existing = loaded?.contract ?? null;
  const [contact, setContact] = useState<Hit | null>(null), [object, setObject] = useState(""), [start, setStart] = useState(""), [end, setEnd] = useState(""), [term, setTerm] = useState("");
  const [periodicity, setPeriodicity] = useState("mensal"), [dueDay, setDueDay] = useState("10"), [payment, setPayment] = useState(""), [category, setCategory] = useState(""), [seller, setSeller] = useState("");
  const [items, setItems] = useState<ItemDraft[]>([{ service: null, description: "", quantity: "1", price: "" }]);
  const [index, setIndex] = useState(""), [fixed, setFixed] = useState(""), [month, setMonth] = useState("1"), [notify, setNotify] = useState(false), [noticeDays, setNoticeDays] = useState("30"), [notes, setNotes] = useState("");
  const [problem, setProblem] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!existing) return;
    const c = existing;
    setContact(c.contact ? { id: c.contact.id, name: c.contact.name } : null); setObject(c.object); setStart(c.starts_on); setEnd(c.ends_on ?? ""); setTerm(c.term_months ? String(c.term_months) : "");
    setPeriodicity(PERIODICITY_FIELD[c.periodicity]); setDueDay(String(c.due_day)); setPayment(c.payment_method?.id ?? ""); setCategory(c.category?.id ?? ""); setSeller(c.seller?.id ?? "");
    setItems(c.items.map(draftOf)); setIndex(c.adjustment ? INDEX_FIELD[c.adjustment.index] : ""); setFixed(c.adjustment?.percent ? c.adjustment.percent.replace(/\.?0+$/, "").replace(".", ",") : "");
    setMonth(String(c.adjustment?.month ?? 1)); setNotify(c.adjustment?.notify ?? false); setNoticeDays(String(c.renewal_notice_days)); setNotes(c.notes ?? "");
  }, [existing]);
  const locked = !!existing && existing.status !== "draft";
  const submit = async () => {
    setProblem("");
    if (!contact) return setProblem("Escolha o cliente.");
    if (!object.trim()) return setProblem("Escreva o objeto do contrato (o que é prestado).");
    if (!start) return setProblem("Informe o início da vigência.");
    if (end && end < start) return setProblem("O fim da vigência precisa vir depois do início.");
    const out = locked ? {} : itemsOut(items);
    if (out.problem) return setProblem(out.problem);
    const due = Number(dueDay);
    if (!Number.isInteger(due) || due < 1 || due > 31) return setProblem("O dia de vencimento vai de 1 a 31.");
    if (index === "fixo" && !/^\d{1,3}([.,]\d{1,4})?$/.test(fixed.trim())) return setProblem("Informe o percentual fixo do reajuste, como 5 ou 4,5.");
    const fields: ContractFields = {
      objeto: object.trim(), prazo_meses: term ? Number(term) : null, dia_vencimento: due,
      forma_pagamento: payment || null, categoria: category || null, vendedor: seller || null, aviso_renovacao_dias: Number(noticeDays) || 0, observacoes: notes.trim() || null,
      reajuste: index ? { indice: index, mes: Number(month), ...(index === "fixo" ? { percentual: fixed.trim().replace(",", ".") } : {}), avisar_cliente: notify } : null,
      ...(locked ? {} : { cliente: contact.id, inicio: start, fim: end || null, periodicidade: periodicity, itens: out.itens }),
    };
    setBusy(true);
    try {
      const { contract } = existing ? await port.update(existing.id, { ...fields, versao: existing.version, comando: port.command() }) : await port.create({ ...fields, comando: port.command() });
      navigate(`${ROUTE}?contrato=${contract.id}`);
    } catch (e) { setProblem(errorText(e)); } finally { setBusy(false); }
  };
  if (id && !existing) return <section className="contratos"><Message error={loadError} />{!loadError ? <p>Carregando contrato…</p> : null}</section>;
  return (
    <section className="contratos">
      <p><Link to={existing ? `${ROUTE}?contrato=${existing.id}` : ROUTE}>Voltar</Link></p>
      <h1>{existing ? `Editar ${existing.label}` : "Novo contrato"}</h1>
      {!existing ? <p>O contrato nasce em rascunho e com a cobrança desligada. Confira, ative e ligue a cobrança na ficha do contrato.</p> : null}
      {locked ? <p className="contratos-hint">Contrato {existing!.status_label.toLowerCase()}: cliente, início, fim, periodicidade e itens só mudam por aditivo ou renovação, na ficha do contrato.</p> : null}
      <Message error={optionsError || problem} />
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {locked ? <p>Cliente: <strong>{contact?.name}</strong></p> : <Picker port={port} kind="clientes" label="Cliente" value={contact} onPick={setContact} />}
        <label>Objeto do contrato (o que é prestado)<textarea value={object} onChange={(e) => setObject(e.target.value)} maxLength={4000} required /></label>
        <div className="contratos-toolbar">
          <label>Início da vigência<input type="date" value={start} onChange={(e) => setStart(e.target.value)} disabled={locked} required /></label>
          <label>Fim (vazio: prazo indeterminado)<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} disabled={locked} min={start || undefined} /></label>
          <label>Prazo da renovação em meses (opcional)<input type="number" min={1} max={600} value={term} onChange={(e) => setTerm(e.target.value)} /></label>
        </div>
        <div className="contratos-toolbar">
          <label>Periodicidade do faturamento<select value={periodicity} onChange={(e) => setPeriodicity(e.target.value)} disabled={locked}>
            {(options?.periodicities ?? []).map((p) => <option key={p.id} value={PERIODICITY_FIELD[p.id]}>{p.label}</option>)}</select></label>
          <label>Dia de vencimento<input type="number" min={1} max={31} value={dueDay} onChange={(e) => setDueDay(e.target.value)} required /></label>
          <label>Forma de pagamento<select value={payment} onChange={(e) => setPayment(e.target.value)}><option value="">Sem forma</option>{(options?.payment_methods ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
          <label>Categoria<select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Sem categoria</option>{(options?.categories ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
          <label>Vendedor<select value={seller} onChange={(e) => setSeller(e.target.value)}><option value="">Sem vendedor</option>{(options?.sellers ?? []).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
        </div>
        {locked ? <LineTable lines={existing!.items} /> : <ItemsEditor port={port} items={items} setItems={setItems} />}
        <fieldset>
          <legend>Reajuste</legend>
          <div className="contratos-toolbar">
            <label>Índice<select value={index} onChange={(e) => setIndex(e.target.value)}><option value="">Sem reajuste</option><option value="ipca">IPCA</option><option value="igpm">IGP-M</option><option value="inpc">INPC</option><option value="fixo">Percentual fixo</option></select></label>
            {index ? <label>Mês de aniversário<select value={month} onChange={(e) => setMonth(e.target.value)}>{MONTHS.map((m, n) => <option key={m} value={n + 1}>{m}</option>)}</select></label> : null}
            {index === "fixo" ? <label>Percentual (%)<input inputMode="decimal" value={fixed} onChange={(e) => setFixed(e.target.value)} placeholder="5" /></label> : null}
          </div>
          {index ? <label><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Preparar a mensagem de aviso ao cliente quando o reajuste for aplicado</label> : null}
          {index && index !== "fixo" ? <p className="contratos-hint">O percentual do índice é o que você informa na Tabela de índices, no mês de aniversário.</p> : null}
        </fieldset>
        <label>Avisar a renovação quantos dias antes do fim<input type="number" min={0} max={365} value={noticeDays} onChange={(e) => setNoticeDays(e.target.value)} /></label>
        <label>Observações<textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} /></label>
        <div className="contratos-actions"><button type="submit" className="contratos-primary" disabled={busy}>{existing ? "Salvar" : "Criar contrato em rascunho"}</button></div>
      </form>
    </section>
  );
}
