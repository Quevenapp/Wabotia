// Estoque › Ordens de produção (parte Produção): a lista com filtros, a ordem
// com os insumos (da composição, editáveis: troca de insumo e perda prevista)
// e os apontamentos, a conclusão total ou parcial com a prévia do que falta e
// do custo, o estorno com motivo, a impressão da ordem para o chão de fábrica
// e o planejamento pelos pedidos de venda em aberto, com a lista de compras.
// O servidor confere e lança (src/erp/production/); a tela só manda as escolhas.
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { erpPorts } from "./ports";
import {
  PRODUCT_PROBLEMS, STATUS_ACTIONS, moneyText, quantityText,
  type CompositionView, type Options, type Order, type OrderFields, type OrderInputChoice, type OrdersPage, type Plan, type Preview, type ProducaoPort, type ProductHit,
} from "./producao";
import "./producao.css";

const ROUTE = "/producao";
const day = (value: string | null | undefined) => (value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10).split("-").reverse().join("/") : "—");
const when = (value: string | null | undefined) => (value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—");
const errorText = (error: unknown) => (error instanceof Error ? error.message : "Algo deu errado. Atualize a tela e tente de novo.");
const aborted = (error: unknown) => error instanceof Error && error.name === "AbortError";
/** "12.500000" → "12,5" para o campo; a pessoa digita com vírgula ou ponto. */
const field = (value: string | null | undefined) => (value ? quantityText(value).replace(/\./g, "") : "");
/** "1.234,5" ou "1234.5" → "1234.5" (com vírgula, o ponto é de milhar). */
const normalize = (value: string) => (value.includes(",") ? value.trim().replace(/\./g, "").replace(",", ".") : value.trim());
const quantityInput = normalize;
const positive = (value: string) => /^\d{1,12}(\.\d{1,6})?$/.test(normalize(value)) && Number(normalize(value)) > 0;

export default function OrdensProducao({ port: injected }: { port?: ProducaoPort }) {
  const port = injected ?? erpPorts()?.producao;
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const order = query.get("ordem");
  if (!port) return <section className="real-state-panel"><h1>Ordens de produção</h1><p>As ordens de produção ainda não estão disponíveis nesta área.</p></section>;
  const access = port.access();
  if (!access.parts.production)
    return <section className="real-state-panel"><h1>Ordens de produção</h1><p>As ordens de produção são do módulo Produção, que está desligado nesta área. Produção depende de Estoque e de Produtos e serviços: peça ao administrador para ligar os três em Gestão → Módulos.</p></section>;
  if (order === "nova") return <OrderForm port={port} />;
  if (order && query.get("imprimir") === "1") return <PrintSheet key={order} port={port} id={order} />;
  if (order) return <OrderDetail key={order} port={port} id={order} />;
  return <Home port={port} tab={query.get("aba") === "planejamento" ? "plan" : "list"} />;
}

function useOptions(port: ProducaoPort) {
  const [options, setOptions] = useState<Options | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const signal = new AbortController();
    port.options(signal.signal).then(setOptions, (e) => { if (!aborted(e)) setError(errorText(e)); });
    return () => signal.abort();
  }, [port]);
  return { options, error };
}

function Home({ port, tab }: { port: ProducaoPort; tab: "list" | "plan" }) {
  return (
    <section className="producao">
      <header>
        <h1>Ordens de produção</h1>
        <p>Transforme insumos em produto acabado: a ordem traz os insumos da composição do produto, e cada apontamento dá baixa nos insumos e entrada no produto pronto, com o custo.</p>
      </header>
      <nav className="producao-tabs" aria-label="Produção">
        <Link to={ROUTE} aria-current={tab === "list" ? "page" : undefined}>Ordens</Link>
        <Link to={`${ROUTE}?aba=planejamento`} aria-current={tab === "plan" ? "page" : undefined}>Planejamento</Link>
      </nav>
      {tab === "plan" ? <PlanView port={port} /> : <OrderList port={port} />}
    </section>
  );
}

const FILTERS: { id: string; label: string }[] = [
  { id: "abertas", label: "Abertas" }, { id: "todas", label: "Todas" }, { id: "rascunho", label: "Rascunho" }, { id: "liberada", label: "Liberadas" },
  { id: "em_producao", label: "Em produção" }, { id: "concluida", label: "Concluídas" }, { id: "cancelada", label: "Canceladas" },
];

function OrderList({ port }: { port: ProducaoPort }) {
  const { options } = useOptions(port);
  const [status, setStatus] = useState("abertas");
  const [search, setSearch] = useState("");
  const [typed, setTyped] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<OrdersPage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const signal = new AbortController();
    setError("");
    port.list({ situacao: status, busca: search, de: from, ate: to, pagina: page }, signal.signal).then(setData, (e) => { if (!aborted(e)) setError(errorText(e)); });
    return () => signal.abort();
  }, [port, status, search, from, to, page]);
  return (
    <>
      <div className="producao-toolbar">
        <label>Situação
          <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
        <form onSubmit={(e) => { e.preventDefault(); setSearch(typed.trim()); setPage(1); }} className="producao-inline">
          <label>Buscar<input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Produto, número ou responsável" /></label>
          <button type="submit">Buscar</button>
        </form>
        <label>Previsão de<input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} /></label>
        <label>até<input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} /></label>
        {options?.can_write && <Link className="producao-primary" to={`${ROUTE}?ordem=nova`}>Nova ordem de produção</Link>}
      </div>
      {error && <p className="real-alert" role="alert">{error}</p>}
      {!data && !error && <p role="status">Carregando…</p>}
      {data && (data.items.length === 0
        ? <p className="producao-empty">Nenhuma ordem por aqui. {options?.can_write ? "Crie uma ordem ou veja as sugestões no Planejamento." : ""}</p>
        : <table className="producao-table">
            <thead><tr><th>Ordem</th><th>Produto</th><th>Quantidade</th><th>Produzido</th><th>Previsão</th><th>Responsável</th><th>Situação</th></tr></thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.id}>
                  <td><Link to={`${ROUTE}?ordem=${o.id}`}>{o.label}</Link>{o.origin === "plan" && <small>Do planejamento</small>}</td>
                  <td>{o.product.name}{o.product.code && <small>{o.product.code}</small>}</td>
                  <td>{quantityText(o.quantity)} {o.unit ?? ""}</td>
                  <td>{quantityText(o.produced)}</td>
                  <td>{day(o.planned_on)}</td>
                  <td>{o.responsible ?? "—"}</td>
                  <td><span className={`producao-status producao-status-${o.status}`}>{o.status_label}</span></td>
                </tr>
              ))}
            </tbody>
          </table>)}
      {data && data.total > data.per_page && (
        <div className="producao-actions">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>Anteriores</button>
          <span>Página {page} de {Math.ceil(data.total / data.per_page)}</span>
          <button type="button" disabled={page * data.per_page >= data.total} onClick={() => setPage(page + 1)}>Próximas</button>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Procurar produto (acabado ou insumo)

function ProductPicker({ port, purpose, label, onPick }: { port: ProducaoPort; purpose: "acabado" | "insumo"; label: string; onPick: (p: ProductHit) => void }) {
  const [text, setText] = useState("");
  const [hits, setHits] = useState<ProductHit[] | null>(null);
  const [error, setError] = useState("");
  async function search() {
    if (!text.trim()) return;
    setError("");
    try { setHits((await port.products(text.trim(), purpose)).items); } catch (e) { setError(errorText(e)); }
  }
  return (
    <div className="producao-picker">
      <div className="producao-inline">
        <label>{label}<input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void search(); } }} placeholder="Nome, código ou código de barras" /></label>
        <button type="button" onClick={search}>Procurar</button>
      </div>
      {error && <p className="real-alert" role="alert">{error}</p>}
      {hits && (hits.length === 0 ? <p className="producao-hint">Nenhum produto encontrado.</p> : (
        <ul className="producao-hits">
          {hits.map((h) => (
            <li key={h.id}>
              <button type="button" disabled={purpose === "acabado" && !!h.problem} onClick={() => { onPick(h); setHits(null); setText(""); }}>
                {h.name}{h.code ? ` (${h.code})` : ""} · estoque {quantityText(h.stock)} {h.unit ?? ""}
              </button>
              {purpose === "acabado" && h.problem && <small>{PRODUCT_PROBLEMS[h.problem] ?? "Não pode ser fabricado."}</small>}
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Criar e editar a ordem

interface InputRow { product_id: string; name: string | null; code: string | null; unit: string | null; per_unit: string; loss: string; from_composition: boolean }
const rowsOf = (inputs: { product_id: string; name: string | null; code: string | null; unit: string | null; per_unit: string; loss_percent: string; from_composition: boolean }[]): InputRow[] =>
  inputs.map((i) => ({ product_id: i.product_id, name: i.name, code: i.code, unit: i.unit, per_unit: field(i.per_unit), loss: field(i.loss_percent) === "0" ? "" : field(i.loss_percent), from_composition: i.from_composition }));

function OrderForm({ port, order, onSaved }: { port: ProducaoPort; order?: Order; onSaved?: (order: Order) => void }) {
  const navigate = useNavigate();
  const { options, error: optionsError } = useOptions(port);
  const [product, setProduct] = useState<{ id: string; name: string | null; unit: string | null; lot_control: boolean } | null>(order?.product ? { id: order.product.id, name: order.product.name, unit: order.product.unit ?? null, lot_control: order.product.lot_control } : null);
  const [quantity, setQuantity] = useState(order ? field(order.quantity) : "");
  const [source, setSource] = useState(order?.source_warehouse.id ?? "");
  const [target, setTarget] = useState(order?.target_warehouse.id ?? "");
  const [planned, setPlanned] = useState(order?.planned_on ?? "");
  const [responsible, setResponsible] = useState(order?.responsible ?? "");
  const [notes, setNotes] = useState(order?.notes ?? "");
  const [rows, setRows] = useState<InputRow[]>(order ? rowsOf(order.inputs) : []);
  const [composition, setComposition] = useState<CompositionView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [command] = useState(() => port.command());
  useEffect(() => {
    if (options && !order) { setSource((s) => s || options.default_warehouse_id || ""); setTarget((t) => t || options.default_warehouse_id || ""); }
  }, [options, order]);
  async function pick(p: ProductHit) {
    setProduct({ id: p.id, name: p.name, unit: p.unit ?? null, lot_control: p.lot_control }); setError("");
    try {
      const view = await port.composition(p.id, positive(quantity) ? quantityInput(quantity) : "1", source || null);
      setComposition(view); setRows(rowsOf(view.inputs));
    } catch (e) { setError(errorText(e)); }
  }
  const update = (index: number, patch: Partial<InputRow>) => setRows((list) => list.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const invalid = !product ? "Escolha o produto que vai ser fabricado." : !positive(quantity) ? "Informe a quantidade a produzir (maior que zero)." : !source || !target ? "Escolha os depósitos."
    : rows.some((r) => !positive(r.per_unit)) ? "Cada insumo precisa da quantidade por unidade (maior que zero)." : rows.some((r) => r.loss.trim() && !/^\d{1,4}(\.\d{1,6})?$/.test(normalize(r.loss))) ? "A perda é um percentual, como 5 ou 2,5." : "";
  async function save(situacao?: "rascunho" | "liberada") {
    if (invalid) { setError(invalid); return; }
    setBusy(true); setError("");
    const insumos: OrderInputChoice[] = rows.map((r) => ({ produto: r.product_id, por_unidade: normalize(r.per_unit), ...(r.loss.trim() ? { perda: normalize(r.loss) } : {}) }));
    const fields: OrderFields = { produto: product!.id, quantidade: normalize(quantity), deposito_insumos: source, deposito_acabado: target, data_prevista: planned || null,
      responsavel: responsible.trim() || null, observacoes: notes.trim() || null, insumos };
    try {
      if (order) { const saved = await port.update(order.id, { ...fields, versao: order.version, comando: command }); onSaved?.(saved.order); }
      else { const saved = await port.create({ ...fields, situacao, comando: command }); navigate(`${ROUTE}?ordem=${saved.order.id}`); }
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  const warehouses = options?.warehouses.filter((w) => w.active || w.id === source || w.id === target) ?? [];
  const locked = !!order && order.completions.some((c) => c.state === "active");
  return (
    <section className={order ? "producao-card" : "producao"}>
      {!order && <header><p><Link to={ROUTE}>← Ordens de produção</Link></p><h1>Nova ordem de produção</h1></header>}
      {order && <h2>Editar a ordem</h2>}
      {optionsError && <p className="real-alert" role="alert">{optionsError}</p>}
      {!order || !order.completions.length
        ? <ProductPicker port={port} purpose="acabado" label="Produto acabado" onPick={pick} />
        : null}
      {product && <p>Produto: <strong>{product.name}</strong>{product.lot_control && " · controla lote (o lote é informado no apontamento)"}</p>}
      {composition?.problem && <p className="producao-blockers">{PRODUCT_PROBLEMS[composition.problem]}</p>}
      <div className="producao-grid">
        <label>Quantidade a produzir {product?.unit ? `(${product.unit})` : ""}<input inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
        <label>Depósito dos insumos
          <select value={source} disabled={locked} onChange={(e) => setSource(e.target.value)}><option value="">Escolha…</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
        </label>
        <label>Depósito do acabado
          <select value={target} disabled={locked} onChange={(e) => setTarget(e.target.value)}><option value="">Escolha…</option>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
        </label>
        <label>Data prevista<input type="date" value={planned} onChange={(e) => setPlanned(e.target.value)} /></label>
        <label>Responsável<input value={responsible} maxLength={120} onChange={(e) => setResponsible(e.target.value)} /></label>
      </div>
      {locked && <p className="producao-hint">A ordem tem apontamento ativo: os depósitos não mudam.</p>}
      <label>Observações<textarea value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} /></label>
      <h3>Insumos</h3>
      <p className="producao-hint">Vêm da composição do produto (quantidade por unidade produzida). Troque, tire ou acrescente insumos e informe a perda prevista, se houver.</p>
      {rows.length === 0 ? <p className="producao-hint">Nenhum insumo. {product ? "Acrescente os insumos abaixo." : ""}</p> : (
        <table className="producao-table">
          <thead><tr><th>Insumo</th><th>Por unidade</th><th>Perda (%)</th><th>Previsto para a ordem</th><th></th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.product_id}>
                <td>{r.name}{r.code && <small>{r.code}</small>}{!r.from_composition && <small>Fora da composição</small>}</td>
                <td><span className="producao-inline"><input aria-label={`Quantidade de ${r.name} por unidade`} inputMode="decimal" value={r.per_unit} onChange={(e) => update(i, { per_unit: e.target.value, from_composition: false })} /> {r.unit ?? ""}</span></td>
                <td><input aria-label={`Perda prevista de ${r.name}`} inputMode="decimal" value={r.loss} onChange={(e) => update(i, { loss: e.target.value })} placeholder="0" /></td>
                <td>{positive(quantity) && positive(r.per_unit) ? `${quantityText(String(Math.round(Number(quantityInput(quantity)) * Number(quantityInput(r.per_unit)) * (1 + Number(quantityInput(r.loss || "0")) / 100) * 1e6) / 1e6))} ${r.unit ?? ""}` : "—"}</td>
                <td><button type="button" onClick={() => setRows((list) => list.filter((_, k) => k !== i))}>Tirar</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ProductPicker port={port} purpose="insumo" label="Acrescentar ou trocar por outro insumo" onPick={(p) => {
        if (p.id === product?.id) { setError("O produto acabado não pode ser insumo dele mesmo."); return; }
        if (rows.some((r) => r.product_id === p.id)) { setError("Esse insumo já está na lista."); return; }
        setRows((list) => [...list, { product_id: p.id, name: p.name, code: p.code ?? null, unit: p.unit ?? null, per_unit: "", loss: "", from_composition: false }]);
      }} />
      {error && <p className="real-alert" role="alert">{error}</p>}
      <div className="producao-actions">
        {order
          ? <button type="button" className="producao-primary" disabled={busy} onClick={() => save()}>{busy ? "Salvando…" : "Salvar alterações"}</button>
          : <>
              <button type="button" disabled={busy || !!composition?.problem} onClick={() => save("rascunho")}>{busy ? "Salvando…" : "Salvar como rascunho"}</button>
              <button type="button" className="producao-primary" disabled={busy || !!composition?.problem} onClick={() => save("liberada")}>Salvar e liberar para produção</button>
            </>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// A ordem: dados, insumos, apontamentos, conclusão e estorno

function OrderDetail({ port, id }: { port: ProducaoPort; id: string }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const signal = new AbortController();
    port.get(id, signal.signal).then((r) => setOrder(r.order), (e) => { if (!aborted(e)) setError(errorText(e)); });
    return () => signal.abort();
  }, [port, id, reload]);
  if (!order) return <section className="producao">{error ? <p className="real-alert" role="alert">{error}</p> : <p role="status">Carregando…</p>}</section>;
  async function changeStatus(acao: string, label: string) {
    let motivo: string | undefined;
    if (acao === "cancelar") {
      motivo = window.prompt("Por que a ordem está sendo cancelada?") ?? undefined;
      if (!motivo || motivo.trim().length < 3) { setError("Para cancelar, escreva o motivo (pelo menos 3 letras)."); return; }
    }
    setBusy(acao); setError(""); setNotice("");
    try { setOrder((await port.status(order!.id, { versao: order!.version, acao, ...(motivo ? { motivo: motivo.trim() } : {}), comando: port.command() })).order); setNotice(`${label}: feito.`); }
    catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }
  async function reverse(completion: string) {
    const motivo = window.prompt("Motivo do estorno (aparece no extrato do estoque):");
    if (!motivo || motivo.trim().length < 3) { setError("Para estornar, escreva o motivo (pelo menos 3 letras)."); return; }
    setBusy(completion); setError(""); setNotice("");
    try { setOrder((await port.reverse(completion, { versao: order!.version, motivo: motivo.trim(), comando: port.command() })).order); setNotice("Apontamento estornado: os insumos voltaram e o acabado saiu do estoque."); }
    catch (e) { setError(errorText(e)); setReload((n) => n + 1); } finally { setBusy(""); }
  }
  const editable = order.can_write && ["draft", "released", "in_progress"].includes(order.status);
  return (
    <section className="producao">
      <header>
        <p><Link to={ROUTE}>← Ordens de produção</Link></p>
        <h1>{order.label} · {order.product?.name ?? "Produto"}</h1>
        <p><span className={`producao-status producao-status-${order.status}`}>{order.status_label}</span>{order.cancel_reason && ` · Motivo: ${order.cancel_reason}`}</p>
      </header>
      <div className="producao-actions">
        <Link to={`${ROUTE}?ordem=${order.id}&imprimir=1`}>Imprimir a ordem</Link>
        {editable && <button type="button" onClick={() => setEditing(!editing)}>{editing ? "Fechar a edição" : "Editar a ordem"}</button>}
        {order.can_write && STATUS_ACTIONS[order.status].map((a) => (
          <button key={a.acao} type="button" disabled={!!busy || (a.acao === "cancelar" && order.completions.some((c) => c.state === "active"))}
            title={a.acao === "cancelar" && order.completions.some((c) => c.state === "active") ? "Estorne os apontamentos antes de cancelar" : undefined}
            onClick={() => changeStatus(a.acao, a.label)}>{busy === a.acao ? "Aguarde…" : a.label}</button>
        ))}
      </div>
      {notice && <p className="producao-notice" role="status">{notice}</p>}
      {error && <p className="real-alert" role="alert">{error}</p>}
      {editing && <OrderForm port={port} order={order} onSaved={(o) => { setOrder(o); setEditing(false); setNotice("Ordem salva."); }} />}
      <dl className="producao-facts">
        <div><dt>Quantidade</dt><dd>{quantityText(order.quantity)} {order.unit ?? ""}</dd></div>
        <div><dt>Produzido</dt><dd>{quantityText(order.produced)} · falta {quantityText(order.remaining)}</dd></div>
        <div><dt>Insumos saem de</dt><dd>{order.source_warehouse.name ?? "—"}</dd></div>
        <div><dt>Acabado entra em</dt><dd>{order.target_warehouse.name ?? "—"}</dd></div>
        <div><dt>Data prevista</dt><dd>{day(order.planned_on)}</dd></div>
        <div><dt>Responsável</dt><dd>{order.responsible ?? "—"}</dd></div>
      </dl>
      {order.notes && <p className="producao-notes">{order.notes}</p>}
      {order.sales_orders.length > 0 && <p className="producao-hint">Para os pedidos de venda: {order.sales_orders.map((s) => s.number ? `nº ${s.number}` : "excluído").join(", ")}.</p>}
      {order.product?.problem && <p className="producao-blockers">{PRODUCT_PROBLEMS[order.product.problem] ?? "Este produto não pode ser fabricado agora."}</p>}
      <h2>Insumos</h2>
      <table className="producao-table">
        <thead><tr><th>Insumo</th><th>Por unidade</th><th>Perda</th><th>Previsto na ordem</th><th>Falta consumir</th><th>Saldo em {order.source_warehouse.name}</th></tr></thead>
        <tbody>
          {order.inputs.map((i) => (
            <tr key={i.product_id} className={Number(i.missing) > 0 ? "producao-short" : undefined}>
              <td>{i.name}{i.code && <small>{i.code}</small>}{i.problem && <small>Insumo indisponível no cadastro</small>}</td>
              <td>{quantityText(i.per_unit)} {i.unit ?? ""}</td>
              <td>{Number(i.loss_percent) ? `${quantityText(i.loss_percent)}%` : "—"}</td>
              <td>{quantityText(i.planned)}</td>
              <td>{quantityText(i.pending ?? "0")}</td>
              <td>{quantityText(i.available)}{Number(i.missing) > 0 && <small>Falta {quantityText(i.missing)}</small>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {order.can_write && ["draft", "released", "in_progress"].includes(order.status) && !order.product?.problem && (
        <CompletePanel key={`${order.id}-${order.version}`} port={port} order={order} onDone={(o, message) => { setOrder(o); setNotice(message); setError(""); }} />
      )}
      <h2>Apontamentos</h2>
      {order.completions.length === 0 ? <p className="producao-hint">Nenhum apontamento ainda.</p> : (
        <table className="producao-table">
          <thead><tr><th>Quando</th><th>Quantidade</th><th>Lote</th>{order.costs_visible && <th>Custo unitário</th>}<th>Insumos consumidos</th><th>Situação</th><th></th></tr></thead>
          <tbody>
            {order.completions.map((c) => (
              <tr key={c.id} className={c.state === "reversed" ? "producao-reversed" : undefined}>
                <td>{when(c.created_at)}{c.note && <small>{c.note}</small>}</td>
                <td>{quantityText(c.quantity)} {order.unit ?? ""}</td>
                <td>{c.lot ? `${c.lot.code}${c.lot.expires_on ? ` · validade ${day(c.lot.expires_on)}` : ""}` : "—"}</td>
                {order.costs_visible && <td>{moneyText(c.unit_cost)}<small>Insumos {moneyText(c.inputs_cost)} + adicional {moneyText(c.extra_cost)}</small></td>}
                <td>{c.inputs.length ? c.inputs.map((i) => `${i.name}: ${quantityText(i.quantity)} ${i.unit ?? ""}`).join("; ") : "—"}</td>
                <td>{c.state === "active" ? "Lançado" : <>Estornado<small>{when(c.reversed_at)} · {c.reverse_reason}</small></>}</td>
                <td>{order.can_write && c.state === "active" && <button type="button" disabled={!!busy} onClick={() => reverse(c.id)}>{busy === c.id ? "Estornando…" : "Estornar"}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function CompletePanel({ port, order, onDone }: { port: ProducaoPort; order: Order; onDone: (order: Order, message: string) => void }) {
  const remaining = Number(order.remaining) > 0 ? field(order.remaining) : "";
  const [quantity, setQuantity] = useState(remaining);
  const [extra, setExtra] = useState("");
  const [lot, setLot] = useState({ codigo: "", fabricacao: "", validade: "" });
  const [note, setNote] = useState("");
  const [finish, setFinish] = useState(false);
  const [consumption, setConsumption] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState(() => port.command());
  const lotControl = !!order.product?.lot_control && order.product.format === "S";
  const consumo = useMemo(() => Object.entries(consumption).filter(([, v]) => v.trim() !== "").map(([produto, v]) => ({ produto, quantidade: normalize(v) })), [consumption]);
  const extraOk = extra.trim() === "" || /^\d{1,13}(\.\d{1,10})?$/.test(normalize(extra));
  useEffect(() => {
    setPreview(null); setError("");
    if (!positive(quantity) || !extraOk) return;
    const signal = new AbortController();
    const timer = setTimeout(() => {
      port.preview(order.id, { quantidade: quantityInput(quantity), ...(extra.trim() ? { custo_adicional: normalize(extra) } : {}), consumo }, signal.signal)
        .then(setPreview, (e) => { if (!aborted(e)) setError(errorText(e)); });
    }, 300);
    return () => { clearTimeout(timer); signal.abort(); };
  }, [port, order.id, quantity, extra, consumo, extraOk]);
  async function complete() {
    if (!positive(quantity)) { setError("Informe a quantidade produzida."); return; }
    if (lotControl && !lot.codigo.trim()) { setError("Este produto controla lote: informe o lote."); return; }
    if (lotControl && order.lot_rules.require_expiry && !lot.validade) { setError("Informe a validade do lote (as Preferências de lotes pedem)."); return; }
    setBusy(true); setError("");
    try {
      const saved = await port.complete(order.id, {
        versao: order.version, quantidade: quantityInput(quantity), comando: command,
        ...(extra.trim() ? { custo_adicional: normalize(extra) } : {}), ...(consumo.length ? { consumo } : {}),
        ...(lotControl ? { lote: { codigo: lot.codigo.trim(), ...(lot.fabricacao ? { fabricacao: lot.fabricacao } : {}), ...(lot.validade ? { validade: lot.validade } : {}) } } : {}),
        ...(note.trim() ? { observacao: note.trim() } : {}), ...(finish ? { encerrar: true } : {}),
      });
      setCommand(port.command());
      onDone(saved.order, `Produção de ${quantityText(quantityInput(quantity))} ${order.unit ?? ""} apontada: os insumos saíram de ${order.source_warehouse.name} e o acabado entrou em ${order.target_warehouse.name}.`);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  const short = preview?.inputs.filter((i) => Number(i.missing) > 0) ?? [];
  return (
    <div className="producao-card">
      <h2>Apontar produção</h2>
      <p className="producao-hint">Informe quanto foi produzido agora (o total que falta ou uma parte). Os insumos saem do estoque e o acabado entra, numa só operação.</p>
      <div className="producao-grid">
        <label>Quantidade produzida {order.unit ? `(${order.unit})` : ""}<input inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
        {order.costs_visible && <label>Custo adicional (mão de obra, energia) em R$<input inputMode="decimal" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="0,00" /></label>}
        {lotControl && <>
          <label>Lote *<input value={lot.codigo} maxLength={60} onChange={(e) => setLot({ ...lot, codigo: e.target.value })} /></label>
          <label>Fabricação{order.lot_rules.require_manufacture ? " *" : ""}<input type="date" value={lot.fabricacao} onChange={(e) => setLot({ ...lot, fabricacao: e.target.value })} /></label>
          <label>Validade{order.lot_rules.require_expiry ? " *" : ""}<input type="date" value={lot.validade} onChange={(e) => setLot({ ...lot, validade: e.target.value })} /></label>
        </>}
      </div>
      {!extraOk && <p className="real-alert" role="alert">Informe o custo adicional em reais, como 35,50.</p>}
      <label>Observação do apontamento<input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></label>
      {Number(order.produced) + Number(quantityInput(quantity || "0")) < Number(order.quantity) && order.status === "in_progress" && (
        <label className="producao-check"><input type="checkbox" checked={finish} onChange={(e) => setFinish(e.target.checked)} /> Encerrar a ordem depois deste apontamento (não vai produzir o restante)</label>
      )}
      {preview && (
        <>
          <table className="producao-table">
            <thead><tr><th>Insumo</th><th>Vai consumir</th><th>Saldo disponível</th><th>Falta</th>{preview.costs_visible && <th>Custo</th>}</tr></thead>
            <tbody>
              {preview.inputs.map((i) => (
                <tr key={i.product_id} className={Number(i.missing) > 0 ? "producao-short" : undefined}>
                  <td>{i.name}{i.no_cost && preview.costs_visible && <small>Sem custo no estoque: entra como zero</small>}</td>
                  <td><span className="producao-inline"><input aria-label={`Consumo de ${i.name}`} inputMode="decimal" value={consumption[i.product_id] ?? field(i.quantity)}
                    onChange={(e) => setConsumption({ ...consumption, [i.product_id]: e.target.value })} /> {i.unit ?? ""}</span></td>
                  <td>{quantityText(i.available)}</td>
                  <td>{Number(i.missing) > 0 ? quantityText(i.missing) : "—"}</td>
                  {preview.costs_visible && <td>{moneyText(i.total_cost)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {preview.costs_visible && <p>Custo dos insumos {moneyText(preview.inputs_cost)} + adicional {moneyText(preview.extra_cost)} = custo unitário do acabado <strong>{moneyText(preview.unit_cost)}</strong>{!preview.cost_known && " (nenhum insumo tem custo: o custo médio do acabado não muda)"}.</p>}
          {short.length > 0 && (preview.can_complete
            ? <p className="producao-warning">Falta saldo de {short.map((i) => i.name).join(", ")} no depósito dos insumos. As Preferências do estoque permitem saldo negativo: se concluir, o saldo desses insumos fica negativo.</p>
            : <p className="producao-blockers">Falta saldo de {short.map((i) => `${i.name} (${quantityText(i.missing)} ${i.unit ?? ""})`).join(", ")} no depósito dos insumos, e o Estoque não permite saldo negativo. Lance a entrada dos insumos (ou ligue o saldo negativo nas Preferências do estoque) e confira de novo.</p>)}
        </>
      )}
      {error && <p className="real-alert" role="alert">{error}</p>}
      <div className="producao-actions">
        <button type="button" className="producao-primary" disabled={busy || !preview || !preview.can_complete} onClick={complete}>{busy ? "Lançando…" : "Concluir e lançar no estoque"}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Impressão para o chão de fábrica

function PrintSheet({ port, id }: { port: ProducaoPort; id: string }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const signal = new AbortController();
    port.get(id, signal.signal).then((r) => setOrder(r.order), (e) => { if (!aborted(e)) setError(errorText(e)); });
    return () => signal.abort();
  }, [port, id]);
  if (!order) return <section className="producao">{error ? <p className="real-alert" role="alert">{error}</p> : <p role="status">Carregando…</p>}</section>;
  return (
    <section className="producao">
      <div className="producao-actions producao-no-print">
        <Link to={`${ROUTE}?ordem=${order.id}`}>← Voltar para a ordem</Link>
        <button type="button" className="producao-primary" onClick={() => window.print()}>Imprimir</button>
      </div>
      <article className="producao-print">
        <h1>Ordem de produção {order.label}</h1>
        <p><strong>{order.product?.name}</strong>{order.product?.code ? ` (${order.product.code})` : ""} · {quantityText(order.quantity)} {order.unit ?? ""} · {order.status_label}</p>
        <table className="producao-table">
          <tbody>
            <tr><th>Data prevista</th><td>{day(order.planned_on)}</td><th>Responsável</th><td>{order.responsible ?? "________________"}</td></tr>
            <tr><th>Insumos saem de</th><td>{order.source_warehouse.name}</td><th>Acabado entra em</th><td>{order.target_warehouse.name}</td></tr>
            <tr><th>Já produzido</th><td>{quantityText(order.produced)}</td><th>Falta produzir</th><td>{quantityText(order.remaining)}</td></tr>
          </tbody>
        </table>
        <h2>Insumos</h2>
        <table className="producao-table">
          <thead><tr><th>Insumo</th><th>Código</th><th>Por unidade</th><th>Perda</th><th>Separar</th><th>Usado (anotar)</th></tr></thead>
          <tbody>
            {order.inputs.map((i) => (
              <tr key={i.product_id}><td>{i.name}</td><td>{i.code ?? ""}</td><td>{quantityText(i.per_unit)} {i.unit ?? ""}</td><td>{Number(i.loss_percent) ? `${quantityText(i.loss_percent)}%` : "—"}</td>
                <td>{quantityText(i.pending ?? i.planned)} {i.unit ?? ""}</td><td className="producao-blank"></td></tr>
            ))}
          </tbody>
        </table>
        {order.notes && <><h2>Observações</h2><p>{order.notes}</p></>}
        <h2>Apontamento (anotar)</h2>
        <table className="producao-table">
          <tbody>
            <tr><th>Quantidade produzida</th><td className="producao-blank"></td><th>Lote / validade</th><td className="producao-blank"></td></tr>
            <tr><th>Início</th><td className="producao-blank"></td><th>Fim</th><td className="producao-blank"></td></tr>
            <tr><th>Assinatura</th><td colSpan={3} className="producao-blank"></td></tr>
          </tbody>
        </table>
        <p className="producao-hint">Impresso em {new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.</p>
      </article>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Planejamento

function PlanView({ port }: { port: ProducaoPort }) {
  const navigate = useNavigate();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [buy, setBuy] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const signal = new AbortController();
    port.plan(signal.signal).then((p) => {
      setPlan(p);
      setChosen(Object.fromEntries(p.suggestions.map((s) => [s.product.id, field(s.quantity)])));
      setBuy(Object.fromEntries(p.shopping.filter((i) => i.supplier).map((i) => [i.product_id, true])));
    }, (e) => { if (!aborted(e)) setError(errorText(e)); });
    return () => signal.abort();
  }, [port, reload]);
  if (!plan) return error ? <p className="real-alert" role="alert">{error}</p> : <p role="status">Carregando…</p>;
  const selected = plan.suggestions.filter((s) => chosen[s.product.id] !== undefined && chosen[s.product.id] !== "");
  async function generate() {
    if (selected.some((s) => !positive(chosen[s.product.id]))) { setError("Confira as quantidades: cada uma maior que zero."); return; }
    setBusy("gerar"); setError(""); setNotice("");
    try {
      const result = await port.generate({ comando: port.command(), itens: selected.map((s) => ({ produto: s.product.id, quantidade: normalize(chosen[s.product.id]), pedidos: s.sales_orders.map((o) => o.id) })) });
      setNotice(`${result.orders.length === 1 ? "Ordem criada" : "Ordens criadas"} como rascunho: ${result.orders.map((o) => o.label).join(", ")}.`);
      if (result.orders.length === 1) navigate(`${ROUTE}?ordem=${result.orders[0].id}`); else setReload((n) => n + 1);
    } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }
  async function purchase() {
    const items = plan!.shopping.filter((i) => buy[i.product_id] && i.supplier);
    if (!items.length) { setError("Marque os insumos que vão para o pedido de compra."); return; }
    setBusy("comprar"); setError(""); setNotice("");
    try {
      const result = await port.purchase({ comando: port.command(), itens: items.map((i) => ({ produto: i.product_id, quantidade: i.missing, fornecedor: i.supplier!.id })) });
      setNotice(`${result.documents.length === 1 ? "Pedido de compra criado" : `${result.documents.length} pedidos de compra criados`} (um por fornecedor): ${result.documents.map((d) => d.number ? `nº ${d.number}` : "novo").join(", ")}. Confira em Compras › Pedidos de compra.`);
    } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }
  return (
    <>
      <p>Pelos pedidos de venda em aberto: os produtos com composição cujo estoque (mais o que já está em ordens abertas) não cobre os pedidos. Confira as quantidades e gere as ordens.</p>
      {!plan.sales_on && <p className="producao-warning">Vendas está desligado nesta área, então não há pedidos de venda para planejar. Para sugerir pelas vendas, peça ao administrador para ligar Vendas em Gestão → Módulos.</p>}
      {notice && <p className="producao-notice" role="status">{notice}</p>}
      {error && <p className="real-alert" role="alert">{error}</p>}
      {plan.suggestions.length === 0 ? <p className="producao-empty">{plan.sales_on ? "Nada a produzir agora: o estoque e as ordens abertas cobrem os pedidos em aberto." : ""}</p> : (
        <>
          <table className="producao-table">
            <thead><tr><th>Produzir</th><th>Produto</th><th>Pedidos em aberto</th><th>Estoque</th><th>Em ordens abertas</th><th>Quantidade</th><th>Insumos (falta)</th></tr></thead>
            <tbody>
              {plan.suggestions.map((s) => (
                <tr key={s.product.id}>
                  <td><input type="checkbox" aria-label={`Produzir ${s.product.name}`} checked={chosen[s.product.id] !== undefined && chosen[s.product.id] !== ""}
                    onChange={(e) => setChosen({ ...chosen, [s.product.id]: e.target.checked ? field(s.quantity) : "" })} /></td>
                  <td>{s.product.name}<small>Pedidos {s.sales_orders.map((o) => o.number ? `nº ${o.number}` : "").filter(Boolean).join(", ")}</small></td>
                  <td>{quantityText(s.demand)}</td>
                  <td>{quantityText(s.stock)}</td>
                  <td>{quantityText(s.planned)}</td>
                  <td><input aria-label={`Quantidade de ${s.product.name}`} inputMode="decimal" value={chosen[s.product.id] ?? ""} onChange={(e) => setChosen({ ...chosen, [s.product.id]: e.target.value })} /></td>
                  <td>{s.inputs.map((i) => <small key={i.product_id}>{i.name}: precisa {quantityText(i.needed)} {i.unit ?? ""}{Number(i.missing) > 0 ? ` · falta ${quantityText(i.missing)}` : ""}</small>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.can_write && <div className="producao-actions"><button type="button" className="producao-primary" disabled={!!busy || selected.length === 0} onClick={generate}>{busy === "gerar" ? "Gerando…" : `Gerar ${selected.length === 1 ? "a ordem" : `${selected.length} ordens`} como rascunho`}</button></div>}
        </>
      )}
      <h2>Lista de compras</h2>
      {plan.shopping.length === 0 ? <p className="producao-hint">Nenhum insumo faltando para as sugestões acima.</p> : (
        <>
          <table className="producao-table">
            <thead><tr>{plan.can_purchase && <th>Comprar</th>}<th>Insumo</th><th>Precisa</th><th>Falta</th><th>Fornecedor padrão</th></tr></thead>
            <tbody>
              {plan.shopping.map((i) => (
                <tr key={i.product_id}>
                  {plan.can_purchase && <td><input type="checkbox" aria-label={`Comprar ${i.name}`} disabled={!i.supplier} checked={!!buy[i.product_id]} onChange={(e) => setBuy({ ...buy, [i.product_id]: e.target.checked })} /></td>}
                  <td>{i.name}{i.code && <small>{i.code}</small>}</td>
                  <td>{quantityText(i.needed)} {i.unit ?? ""}</td>
                  <td><strong>{quantityText(i.missing)} {i.unit ?? ""}</strong></td>
                  <td>{i.supplier?.name ?? <small>Sem fornecedor padrão: informe em Produtos (aba Fornecedores) para comprar por aqui.</small>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.can_purchase
            ? <div className="producao-actions"><button type="button" disabled={!!busy} onClick={purchase}>{busy === "comprar" ? "Criando…" : "Criar pedido de compra (um por fornecedor)"}</button></div>
            : <p className="producao-hint">{plan.purchases_on ? "Seu papel no ERP não cria pedido de compra." : "Para virar pedido de compra, ligue Compras em Gestão → Módulos."}</p>}
        </>
      )}
    </>
  );
}
