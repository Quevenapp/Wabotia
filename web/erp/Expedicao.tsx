// Vendas › Expedição (parte Expedição, com Vendas e Estoque): os pedidos na
// expedição, a lista de separação de vários pedidos (no celular, com leitura
// de código de barras), os volumes do pedido, etiquetas, romaneio, entrega
// local pelo módulo Entrega e a devolução física. O servidor confere e grava
// (src/erp/expedicao/); a tela só manda as escolhas da pessoa. O frete
// (cotação, etiqueta oficial e rastreio) fica em ./Frete.tsx.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { erpPorts } from "./ports";
import BarcodeCamera, { cameraSupported } from "./app/components/BarcodeCamera";
import { saveFile } from "./app/lib/fiscal-invoice-xml";
import { labelsPdf, manifestPdf, pickListPdf } from "./expedicao-pdf";
import { FreteDoPedido, FreteProvedores } from "./Frete";
import { rowForCode } from "../../src/erp/domains/shipping/model.ts";
import {
  ExpedicaoError, STATUS_PARAM, type ExpedicaoPort, type Manifest, type OrderDetail, type OrderSummary, type Overview, type Package, type PickList,
  type ReturnInput, type ShippingStatus, type VolumeInput,
} from "./expedicao-api";
import "./expedicao.css";

const ROUTE = "/expedicao";
const STATUS_LABEL: Record<ShippingStatus, string> = { to_pick: "A separar", picking: "Em separação", picked: "Separado", packed: "Embalado", shipped: "Expedido" };
const errorText = (error: unknown) => (error instanceof Error ? error.message : "Algo deu errado. Atualize a tela e tente de novo.");
const aborted = (error: unknown) => error instanceof Error && error.name === "AbortError";
const day = (v: string | null | undefined) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10).split("-").reverse().join("/") : "—");
/** "2.500000" → "2,5". */
const qty = (v: string | null | undefined) => (v ? v.replace(/\.?0+$/, "").replace(".", ",") : "0");
const toNumber = (v: string) => Number(v.replace(",", "."));
const kg = (g: number | null | undefined) => (g === null || g === undefined ? "—" : `${(g / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg`);
const cm = (mm: number | null | undefined) => (mm === null || mm === undefined ? "" : String(mm / 10).replace(".", ","));
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const daysAgo = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(Date.now() - n * 86400000));
const pdfName = (prefix: string) => `${prefix}-${today()}.pdf`;
const savePdf = (name: string, pdf: Uint8Array) => saveFile(name, pdf as Uint8Array<ArrayBuffer>, "application/pdf");
const TRANSPORT: Record<string, string> = {
  fiscal_off: "Com Fiscal desligado, os volumes ficam só na expedição (a nota não é usada).",
  invoice_exists: "A nota deste pedido já foi enviada: os volumes e o peso não mudam nela.",
  order_cancelled: "O pedido está cancelado: o transporte do pedido não foi alterado.",
  no_freight: "O pedido está \"sem frete\": volumes e peso não vão para a nota.",
};

export default function Expedicao({ port: injected }: { port?: ExpedicaoPort }) {
  const port = injected ?? erpPorts()?.expedicao;
  const location = useLocation();
  if (!port) return <section className="real-state-panel"><h1>Expedição</h1><p>A expedição ainda não está disponível nesta área.</p></section>;
  const access = port.access();
  const missing = [!access.parts.shipping && "Expedição", !access.parts.sales && "Vendas", !access.parts.stock && "Estoque"].filter(Boolean);
  if (missing.length)
    return <section className="real-state-panel"><h1>Expedição</h1><p>A expedição precisa de {missing.join(", ").replace(/, ([^,]*)$/, " e $1")} {missing.length > 1 ? "ligados" : "ligado"}. Peça ao administrador para ligar em Gestão → Módulos (Expedição depende de Vendas e de Estoque).</p></section>;
  const q = new URLSearchParams(location.search);
  const list = q.get("lista"), order = q.get("pedido"), tab = q.get("aba");
  return <div className="expedicao">
    {list ? <PickScreen key={list} port={port} id={list} /> : order ? <OrderScreen key={order} port={port} id={order} />
      : <><h1>Expedição</h1><Tabs tab={tab} freight={!!port.frete} />{tab === "embalagens" ? <Packages port={port} /> : tab === "romaneio" ? <ManifestScreen port={port} />
        : tab === "frete" && port.frete ? <FreteProvedores port={port.frete} role={access.role} /> : <Orders port={port} />}</>}
  </div>;
}

function Tabs({ tab, freight }: { tab: string | null; freight: boolean }) {
  const navigate = useNavigate();
  const items: [string | null, string][] = [[null, "Pedidos"], ["embalagens", "Embalagens"], ["romaneio", "Romaneio"], ...(freight ? [["frete", "Frete e transportadoras"] as [string, string]] : [])];
  return <nav className="expedicao-tabs" aria-label="Partes da expedição">
    {items.map(([id, label]) => <button key={label} type="button" aria-pressed={tab === id} onClick={() => navigate(id ? `${ROUTE}?aba=${id}` : ROUTE)}>{label}</button>)}
  </nav>;
}

function Message({ error, notice }: { error?: string; notice?: string }) {
  return <>{error && <p className="expedicao-error" role="alert">{error}</p>}{notice && <p className="expedicao-notice" role="status">{notice}</p>}</>;
}

async function downloadLabels(port: ExpedicaoPort, orders: string[], format: "10x15" | "a4") {
  const data = await port.labels(orders);
  savePdf(pdfName(format === "a4" ? "etiquetas-a4" : "etiquetas-10x15"), labelsPdf(data.labels, data.sender, format));
}

// ---------------------------------------------------------------------------
// Pedidos

function Orders({ port }: { port: ExpedicaoPort }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<ShippingStatus | "all">("to_pick");
  const [from, setFrom] = useState(daysAgo(30)), [to, setTo] = useState(today());
  const [carrier, setCarrier] = useState(""), [warehouse, setWarehouse] = useState(""), [search, setSearch] = useState("");
  const [data, setData] = useState<Overview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const [carriers, setCarriers] = useState(new Map<string, string>()), [warehouses, setWarehouses] = useState(new Map<string, string>());
  useEffect(() => {
    const signal = new AbortController();
    setError("");
    port.overview({ situacao: STATUS_PARAM[status], de: from, ate: to, transportadora: carrier || undefined, deposito: warehouse || undefined, busca: search.trim() || undefined }, signal.signal)
      .then((value) => {
        setData(value); setSelected(new Set());
        setCarriers((old) => { const next = new Map(old); for (const o of value.items) if (o.carrier) next.set(o.carrier.id, o.carrier.name ?? "Transportadora"); return next; });
        setWarehouses((old) => { const next = new Map(old); for (const o of value.items) if (o.warehouse) next.set(o.warehouse.id, o.warehouse.name ?? "Depósito"); return next; });
      }, (e) => { if (!aborted(e)) setError(errorText(e)); });
    return () => signal.abort();
  }, [port, status, from, to, carrier, warehouse, search, reload]);
  const items = data?.items ?? [];
  const chosen = items.filter((o) => selected.has(o.id));
  const toggle = (id: string) => setSelected((old) => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  const createPick = () => run(async () => {
    const list = await port.createPick({ pedidos: chosen.map((o) => o.id), filtros: { de: from, ate: to, ...(carrier ? { transportadora: carrier } : {}), ...(warehouse ? { deposito: warehouse } : {}) } }, port.command());
    navigate(`${ROUTE}?lista=${list.list.id}`);
  });
  const ship = () => run(async () => {
    if (!window.confirm(`Marcar ${chosen.length} pedido${chosen.length > 1 ? "s" : ""} como expedido${chosen.length > 1 ? "s" : ""}?`)) return;
    const result = await port.ship({ pedidos: chosen.map((o) => o.id) }, port.command());
    setNotice(`Expedidos: pedidos ${result.shipped.join(", ") || "nenhum (já estavam expedidos)"}.`); setReload((n) => n + 1);
  });
  const canWrite = !!data?.can_write;
  return <>
    <p className="expedicao-hint">Escolha os pedidos prontos para separar e gere uma lista com os itens somados por produto e endereço. Depois monte os volumes, imprima as etiquetas e marque como expedido.</p>
    {data && data.lists.length > 0 && <p>Listas abertas: {data.lists.map((l) => <Link key={l.id} to={`${ROUTE}?lista=${l.id}`} style={{ marginRight: ".8rem" }}>Lista {l.number} ({l.orders} pedido{l.orders > 1 ? "s" : ""})</Link>)}</p>}
    <div className="expedicao-toolbar">
      <label>Situação<select value={status} onChange={(e) => setStatus(e.target.value as ShippingStatus | "all")}>
        {(Object.keys(STATUS_LABEL) as ShippingStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}{data ? ` (${data.counts[s]})` : ""}</option>)}
        <option value="all">Todas</option>
      </select></label>
      <label>Pedidos de<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>até<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <label>Transportadora<select value={carrier} onChange={(e) => setCarrier(e.target.value)}>
        <option value="">Todas</option><option value="sem">Sem transportadora</option>
        {[...carriers].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      <label>Depósito<select value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
        <option value="">Todos</option>{[...warehouses].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
      </select></label>
      <label>Buscar<input type="search" value={search} placeholder="Número ou cliente" onChange={(e) => setSearch(e.target.value)} /></label>
    </div>
    <Message error={error} notice={notice} />
    {canWrite && <div className="expedicao-actions">
      <button type="button" className="expedicao-primary" disabled={busy || !chosen.length || chosen.some((o) => o.status !== "to_pick")} onClick={() => void createPick()}>Gerar lista de separação ({chosen.length})</button>
      <button type="button" disabled={busy || !chosen.length || chosen.some((o) => o.status !== "packed")} onClick={() => void ship()}>Marcar como expedido</button>
      <button type="button" disabled={busy || !chosen.length} onClick={() => void run(() => downloadLabels(port, chosen.map((o) => o.id), "10x15"))}>Etiquetas 10×15</button>
      <button type="button" disabled={busy || !chosen.length} onClick={() => void run(() => downloadLabels(port, chosen.map((o) => o.id), "a4"))}>Etiquetas em A4</button>
    </div>}
    {!data ? <p role="status">Carregando os pedidos…</p> : !items.length ? <p className="expedicao-hint">Nenhum pedido nesta situação no período. Mude os filtros acima.</p> :
      <table className="expedicao-table expedicao-orders">
        <thead><tr><th><span className="sr-only">Escolher</span></th><th>Pedido</th><th>Cliente</th><th>Situação</th><th>Data</th><th>Transportadora</th><th>Depósito</th><th>Volumes</th></tr></thead>
        <tbody>{items.map((o) => <tr key={o.id}>
          <td><input type="checkbox" aria-label={`Escolher o pedido ${o.number}`} checked={selected.has(o.id)} onChange={() => toggle(o.id)} /></td>
          <td><Link to={`${ROUTE}?pedido=${o.id}`}>{o.number}</Link>{o.pending > 0 && <small>{o.pending} pendência{o.pending > 1 ? "s" : ""}</small>}</td>
          <td>{o.customer}<small>{[o.city, o.state].filter(Boolean).join(" / ")}</small></td>
          <td><StatusBadge order={o} />{o.pick_list && o.status === "picking" && <small><Link to={`${ROUTE}?lista=${o.pick_list.id}`}>Lista {o.pick_list.number}</Link></small>}</td>
          <td>{day(o.date)}</td>
          <td>{o.carrier?.name ?? (o.own_delivery ? "Entrega própria" : "—")}</td>
          <td>{o.warehouse?.name ?? "—"}</td>
          <td>{o.volumes || "—"}</td>
        </tr>)}</tbody>
      </table>}
    {data?.truncated && <p className="expedicao-warning">Há mais pedidos do que cabem na tela. Diminua o período ou filtre por transportadora.</p>}
  </>;
}

const StatusBadge = ({ order }: { order: Pick<OrderSummary, "status" | "status_label"> }) =>
  <span className={`expedicao-status ${order.status}`}>{order.status_label}</span>;

// ---------------------------------------------------------------------------
// Lista de separação (pensada para o celular)

function PickScreen({ port, id }: { port: ExpedicaoPort; id: string }) {
  const navigate = useNavigate();
  const [view, setView] = useState<PickList | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [code, setCode] = useState(""), [camera, setCamera] = useState(false);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const scan = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const signal = new AbortController();
    port.pickList(id, signal.signal).then(setView, (e) => { if (!aborted(e)) setError(errorText(e)); });
    return () => signal.abort();
  }, [port, id]);
  const open = view?.list.status === "open";
  const mark = async (key: string, picked: number) => {
    if (!view || busy) return;
    setBusy(true); setError("");
    try { setView(await port.mark(view.list.id, { versao: view.list.version, linha: key, separado: String(Math.max(0, picked)) })); }
    catch (e) {
      setError(errorText(e));
      if (e instanceof ExpedicaoError && e.status === 409) port.pickList(id).then(setView, () => {});
    } finally { setBusy(false); }
  };
  const read = (value: string) => {
    if (!view) return;
    const row = rowForCode(view.rows.map((r) => ({ ...r, quantity: BigInt(Math.round(toNumber(r.quantity) * 1e6)), picked: BigInt(Math.round(toNumber(r.picked) * 1e6)) })), value);
    setCode("");
    if (!row) { setError(`O código ${value} não é de nenhum item desta lista.`); return; }
    const current = view.rows.find((r) => r.key === row.key)!;
    if (current.done) { setNotice(`${current.description}: já está todo separado.`); return; }
    setNotice(`Lido: ${current.description}.`);
    void mark(current.key, toNumber(current.picked) + 1);
  };
  const finish = async () => {
    if (!view) return;
    const short = view.rows.filter((r) => !r.done);
    if (short.length && !window.confirm(`${short.length} item${short.length > 1 ? "s ficaram" : " ficou"} com falta. A falta vira pendência no pedido. Concluir assim?`)) return;
    setBusy(true); setError("");
    try {
      const done = await port.finish(view.list.id, view.list.version, port.command());
      setView(done);
      setNotice(done.pending?.length ? `Separação concluída com ${done.pending.length} pendência${done.pending.length > 1 ? "s" : ""}, registradas nos pedidos.` : "Separação concluída. Os pedidos estão separados e prontos para embalar.");
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!view || !window.confirm("Cancelar esta lista? Os pedidos voltam para a separar.")) return;
    setBusy(true);
    try { await port.cancel(view.list.id, view.list.version, port.command()); navigate(ROUTE); } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  const print = () => view && savePdf(pdfName(`lista-separacao-${view.list.number}`), pickListPdf(view.list.number, view.rows.map((r) => ({
    location: r.location, warehouse: r.warehouse?.name ?? null, description: r.description, code: r.code, unit: r.unit, quantity: qty(r.quantity),
    orders: r.orders.map((o) => `${o.number}: ${qty(o.quantity)}`).join(", ") })), new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })));
  if (!view) return <><Link to={ROUTE}>← Expedição</Link><Message error={error} />{!error && <p role="status">Carregando a lista…</p>}</>;
  const total = view.rows.length, done = view.rows.filter((r) => r.done).length;
  return <>
    <p><Link to={ROUTE}>← Expedição</Link></p>
    <h1>Lista de separação {view.list.number}</h1>
    <p>{done} de {total} itens separados · {view.orders.length} pedido{view.orders.length > 1 ? "s" : ""}: {view.orders.map((o) => <Link key={o.id} to={`${ROUTE}?pedido=${o.id}`} style={{ marginRight: ".5rem" }}>{o.number}</Link>)}</p>
    {!open && <p className="expedicao-notice">Esta lista está {view.list.status === "done" ? "concluída" : "cancelada"}.</p>}
    <Message error={error} notice={notice} />
    <div className="expedicao-actions">
      <button type="button" onClick={print}>Imprimir lista (PDF)</button>
      {open && <form onSubmit={(e) => { e.preventDefault(); if (code.trim()) read(code.trim()); }} style={{ display: "flex", gap: ".4rem", alignItems: "flex-end" }}>
        <label>Ler código de barras<input ref={scan} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Leitor ou digite e Enter" autoComplete="off" /></label>
        {cameraSupported() && <button type="button" onClick={() => setCamera(true)}>Câmera</button>}
      </form>}
    </div>
    {camera && <BarcodeCamera onClose={() => { setCamera(false); scan.current?.focus(); }} onCode={read} />}
    <div className="expedicao-pick">
      {view.rows.map((r) => <article key={r.key} className={r.done ? "done" : undefined} aria-label={r.description}>
        <div>
          <div className="where">{r.location ?? "Sem endereço"}</div>
          <div>{r.description}{r.code && <small className="expedicao-hint"> · {r.code}</small>}</div>
          <small className="expedicao-hint">{r.warehouse?.name ? `${r.warehouse.name} · ` : ""}Pedidos {r.orders.map((o) => `${o.number} (${qty(o.quantity)})`).join(", ")}</small>
        </div>
        <div className="qty"><strong>{qty(r.picked)}</strong> de {qty(r.quantity)} {r.unit ?? ""}</div>
        {open && <div className="controls">
          <button type="button" aria-label={`Tirar um de ${r.description}`} disabled={busy || toNumber(r.picked) <= 0} onClick={() => void mark(r.key, toNumber(r.picked) - 1)}>−1</button>
          <button type="button" aria-label={`Mais um de ${r.description}`} disabled={busy || r.done} onClick={() => void mark(r.key, toNumber(r.picked) + 1)}>+1</button>
          <button type="button" disabled={busy || r.done} onClick={() => void mark(r.key, toNumber(r.quantity))}>Tudo</button>
          <input aria-label={`Quantidade separada de ${r.description}`} inputMode="decimal" value={typed[r.key] ?? ""} placeholder={qty(r.picked)} onChange={(e) => setTyped({ ...typed, [r.key]: e.target.value })} />
          <button type="button" disabled={busy || !typed[r.key]} onClick={() => { void mark(r.key, toNumber(typed[r.key])); setTyped({ ...typed, [r.key]: "" }); }}>Gravar</button>
        </div>}
      </article>)}
    </div>
    {open && <div className="expedicao-actions">
      <button type="button" className="expedicao-primary" disabled={busy} onClick={() => void finish()}>Concluir separação</button>
      <button type="button" disabled={busy} onClick={() => void cancel()}>Cancelar lista</button>
    </div>}
  </>;
}

// ---------------------------------------------------------------------------
// Pedido: volumes, expedição, etiquetas, entrega local e devolução

interface VolumeDraft { embalagem: string; comprimento: string; largura: string; altura: string; peso_bruto: string; itens: Record<string, string> }
const draftOf = (detail: OrderDetail): VolumeDraft[] => detail.volumes.length
  ? detail.volumes.map((v) => ({ embalagem: v.package?.id ?? "", comprimento: v.package ? "" : cm(v.length_mm), largura: v.package ? "" : cm(v.width_mm), altura: v.package ? "" : cm(v.height_mm),
    peso_bruto: "", itens: Object.fromEntries(v.items.map((i) => [i.key, qty(i.quantity)])) }))
  : [{ embalagem: detail.packages[0]?.id ?? "", comprimento: "", largura: "", altura: "", peso_bruto: "", itens: Object.fromEntries(detail.lines.map((l) => [l.key, qty(l.quantity)])) }];

function OrderScreen({ port, id }: { port: ExpedicaoPort; id: string }) {
  const navigate = useNavigate();
  const access = port.access();
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [drafts, setDrafts] = useState<VolumeDraft[]>([]);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [tracking, setTracking] = useState("");
  const [returning, setReturning] = useState<Record<string, { quantidade: string; estado: ReturnInput["itens"][number]["estado"] }>>({});
  const [reason, setReason] = useState("");
  const [fiscalShortcut, setFiscalShortcut] = useState<string | null>(null);
  const load = (signal?: AbortSignal) => port.order(id, signal).then((d) => { setDetail(d); setDrafts(draftOf(d)); }, (e) => { if (!aborted(e)) setError(errorText(e)); });
  useEffect(() => { const signal = new AbortController(); void load(signal.signal); return () => signal.abort(); }, [port, id]);
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  if (!detail) return <><p><Link to={ROUTE}>← Expedição</Link></p><Message error={error} />{!error && <p role="status">Carregando o pedido…</p>}</>;
  const o = detail.order;
  const canPack = ["picked", "packed"].includes(o.status);
  const setDraft = (index: number, change: Partial<VolumeDraft>) => setDrafts(drafts.map((d, i) => (i === index ? { ...d, ...change } : d)));
  const pack = () => run(async () => {
    const volumes: VolumeInput[] = drafts.map((d) => ({
      embalagem: d.embalagem || null, ...(d.embalagem ? {} : { comprimento: d.comprimento || undefined, largura: d.largura || undefined, altura: d.altura || undefined }),
      ...(d.peso_bruto ? { peso_bruto: d.peso_bruto } : {}),
      itens: Object.entries(d.itens).filter(([, v]) => v && toNumber(v) > 0).map(([linha, quantidade]) => ({ linha, quantidade: quantidade.replace(",", ".") })),
    }));
    const result = await port.pack(o.id, { versao: o.version, volumes }, port.command());
    setDetail(result); setDrafts(draftOf(result));
    const parts = [`${result.totals.volumes} volume${result.totals.volumes > 1 ? "s" : ""}, peso bruto ${kg(result.totals.gross_weight_g)}, líquido ${kg(result.totals.net_weight_g)}.`];
    parts.push(result.transport.written ? "Volumes e peso bruto foram para o transporte do pedido (a nota usa quando for emitida)." : TRANSPORT[result.transport.reason ?? ""] ?? "");
    if (result.unpacked.length) parts.push(`Ficou fora dos volumes: ${result.unpacked.map((u) => `${qty(u.missing)} de ${u.description}`).join("; ")}.`);
    if (result.items_without_weight) parts.push(`${result.items_without_weight} item sem peso no cadastro do produto: confira o peso bruto.`);
    setNotice(parts.filter(Boolean).join(" "));
  });
  const ship = () => run(async () => {
    if (!window.confirm(`Marcar o pedido ${o.number} como expedido?`)) return;
    await port.ship({ pedidos: [o.id], ...(tracking.trim() ? { rastreio: tracking.trim() } : {}) }, port.command());
    await load(); setNotice("Pedido expedido.");
  });
  const delivery = () => run(async () => {
    const r = await port.localDelivery(o.id, {});
    await load(); setNotice(r.repetida ? "Este pedido já tinha entrega local." : "Entrega local criada. Acompanhe e escolha o entregador em Entregas.");
  });
  const registerReturn = () => run(async () => {
    const itens = Object.entries(returning).filter(([, v]) => v.quantidade && toNumber(v.quantidade) > 0).map(([linha, v]) => ({ linha, quantidade: v.quantidade.replace(",", "."), estado: v.estado }));
    if (!itens.length) throw new Error("Informe a quantidade que voltou de pelo menos um item.");
    const r = await port.registerReturn(o.id, { motivo: reason, itens }, port.command());
    await load(); setReturning({}); setReason("");
    setFiscalShortcut(r.emission?.return_path ?? null);
    setNotice(`Devolução ${r.return.number} registrada.${r.return.movement_id ? " O que volta ao estoque já entrou no depósito." : ""}`);
  });
  const shortcut = fiscalShortcut ?? (detail.fiscal && detail.emission?.return_path ? detail.emission.return_path : null);
  return <>
    <p><Link to={ROUTE}>← Expedição</Link></p>
    <h1>Pedido {o.number} <StatusBadge order={o} /></h1>
    <p>{o.recipient.name}{o.recipient.phone ? ` · ${o.recipient.phone}` : ""}<br /><span className="expedicao-hint">{o.address || "Sem endereço no pedido nem no cadastro do cliente."}</span><br />
      {o.carrier ? `Transportadora: ${o.carrier.name}` : o.own_delivery ? "Entrega própria" : "Sem frete"}{o.tracking_code ? ` · Rastreio ${o.tracking_code}` : ""}{o.shipped_on ? ` · Expedido em ${day(o.shipped_on)}` : ""}</p>
    <Message error={error} notice={notice} />

    {detail.pending.length > 0 && <section className="expedicao-card"><h2>Pendências da separação</h2>
      <table className="expedicao-table"><tbody>{detail.pending.map((p) => <tr key={p.id}>
        <td>{p.description}<small>Lista {p.list_number}: separou {qty(p.picked)} de {qty(p.quantity)}</small></td>
        <td>{p.status === "open" ? "Faltou " + qty(p.missing) : `Resolvida${p.note ? `: ${p.note}` : ""}`}</td>
        <td>{p.status === "open" && access.role !== "consulta" && <button type="button" disabled={busy} onClick={() => void run(async () => {
          const note = window.prompt("Como foi resolvida? (opcional)") ?? ""; await port.resolvePending(p.id, note, port.command()); await load(); })}>Dar por resolvida</button>}</td>
      </tr>)}</tbody></table></section>}

    <section className="expedicao-card"><h2>Volumes</h2>
      {!canPack && o.status !== "shipped" && <p className="expedicao-hint">Os volumes são montados depois da separação ({o.status === "to_pick" ? "gere a lista de separação na tela Pedidos" : "conclua a lista de separação"}).</p>}
      {detail.volumes.length > 0 && <table className="expedicao-table"><thead><tr><th>Volume</th><th>Embalagem</th><th>Medidas (cm)</th><th>Peso bruto</th><th>Itens</th></tr></thead>
        <tbody>{detail.volumes.map((v) => <tr key={v.id}><td>{v.number} de {detail.volumes.length}</td><td>{v.package?.name ?? "—"}</td>
          <td>{[v.length_mm, v.width_mm, v.height_mm].some((x) => x) ? [v.length_mm, v.width_mm, v.height_mm].map(cm).join(" × ") : "—"}</td>
          <td>{kg(v.gross_weight_g)}<small>líquido {kg(v.net_weight_g)}</small></td><td>{v.items.map((i) => `${qty(i.quantity)} ${i.description}`).join("; ")}</td></tr>)}</tbody></table>}
      {canPack && access.role !== "consulta" && <>
        {drafts.map((d, index) => <div className="expedicao-volume" key={index}>
          <strong>Volume {index + 1}</strong>
          <div className="expedicao-toolbar">
            <label>Embalagem<select value={d.embalagem} onChange={(e) => setDraft(index, { embalagem: e.target.value })}>
              <option value="">Sem embalagem cadastrada</option>{detail.packages.map((p: Package) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
            {!d.embalagem && <>{(["comprimento", "largura", "altura"] as const).map((k) => <label key={k}>{k[0].toUpperCase() + k.slice(1)} (cm)<input inputMode="decimal" value={d[k]} onChange={(e) => setDraft(index, { [k]: e.target.value })} /></label>)}</>}
            <label>Peso bruto da balança (kg)<input inputMode="decimal" value={d.peso_bruto} placeholder="calculado" onChange={(e) => setDraft(index, { peso_bruto: e.target.value })} /></label>
            {drafts.length > 1 && <button type="button" onClick={() => setDrafts(drafts.filter((_, i) => i !== index))}>Tirar volume</button>}
          </div>
          <table className="expedicao-table"><tbody>{detail.lines.map((l) => <tr key={l.key}><td>{l.description}<small>Pedido: {qty(l.quantity)} {l.unit ?? ""}</small></td>
            <td><input aria-label={`Quantidade de ${l.description} no volume ${index + 1}`} inputMode="decimal" value={d.itens[l.key] ?? ""} onChange={(e) => setDraft(index, { itens: { ...d.itens, [l.key]: e.target.value } })} /></td></tr>)}</tbody></table>
        </div>)}
        <div className="expedicao-actions">
          <button type="button" onClick={() => setDrafts([...drafts, { embalagem: detail.packages[0]?.id ?? "", comprimento: "", largura: "", altura: "", peso_bruto: "", itens: {} }])}>Adicionar volume</button>
          <button type="button" className="expedicao-primary" disabled={busy} onClick={() => void pack()}>Salvar volumes</button>
        </div>
        {!detail.packages.length && <p className="expedicao-hint">Cadastre suas caixas em Expedição › Embalagens para o peso e as medidas saírem sozinhos.</p>}
      </>}
      <div className="expedicao-actions">
        <button type="button" disabled={busy} onClick={() => void run(() => downloadLabels(port, [o.id], "10x15"))}>Etiquetas 10×15</button>
        <button type="button" disabled={busy} onClick={() => void run(() => downloadLabels(port, [o.id], "a4"))}>Etiquetas em A4</button>
      </div>
    </section>

    {port.frete && <FreteDoPedido port={port.frete} order={o.id} role={access.role} onChanged={() => void load()} />}

    {o.status === "packed" && access.role !== "consulta" && <section className="expedicao-card"><h2>Expedir</h2>
      <div className="expedicao-toolbar"><label>Código de rastreio (opcional)<input value={tracking} onChange={(e) => setTracking(e.target.value)} /></label>
        <button type="button" className="expedicao-primary" disabled={busy} onClick={() => void ship()}>Marcar como expedido</button></div></section>}

    {o.status === "shipped" && o.own_delivery && <section className="expedicao-card"><h2>Entrega local</h2>
      {o.delivery_id ? <p>Este pedido já tem entrega local. Acompanhe em Entregas.</p>
        : !access.parts.delivery ? <p className="expedicao-hint">Para mandar este pedido pelo seu entregador, ligue o módulo Entrega em Gestão → Módulos.</p>
        : access.role === "consulta" ? <p className="expedicao-hint">Seu papel só consulta a expedição.</p>
        : <button type="button" disabled={busy} onClick={() => void delivery()}>Criar entrega local</button>}</section>}

    <section className="expedicao-card"><h2>Devolução física</h2>
      <p className="expedicao-hint">Registre a mercadoria que voltou. O que volta ao estoque entra no depósito do pedido; avariado e descarte ficam só registrados. Nenhuma nota é emitida aqui.</p>
      {shortcut && <p className="expedicao-warning">Este pedido tem NF-e autorizada. Para a devolução fiscal, <Link to={shortcut}>abra a nota e emita a NF-e de devolução</Link>.</p>}
      {detail.returns.map((r) => <p key={r.id}>Devolução {r.number} ({day(r.created_at)}): {r.reason} — {r.items.map((i) => `${qty(i.quantity)} ${i.description} (${i.condition_label})`).join("; ")}</p>)}
      {access.role !== "consulta" && !["draft", "cancelled"].includes(o.order_status) && <>
        <table className="expedicao-table"><thead><tr><th>Item</th><th>Voltou</th><th>Estado</th></tr></thead>
          <tbody>{detail.lines.map((l) => <tr key={l.key}><td>{l.description}<small>Pedido {qty(l.quantity)}{toNumber(l.returned) > 0 ? ` · já voltou ${qty(l.returned)}` : ""}</small></td>
            <td><input aria-label={`Quantidade de ${l.description} que voltou`} inputMode="decimal" value={returning[l.key]?.quantidade ?? ""} onChange={(e) => setReturning({ ...returning, [l.key]: { estado: returning[l.key]?.estado ?? "volta_ao_estoque", quantidade: e.target.value } })} /></td>
            <td><select aria-label={`Estado de ${l.description}`} value={returning[l.key]?.estado ?? "volta_ao_estoque"} onChange={(e) => setReturning({ ...returning, [l.key]: { quantidade: returning[l.key]?.quantidade ?? "", estado: e.target.value as ReturnInput["itens"][number]["estado"] } })}>
              <option value="volta_ao_estoque">Volta ao estoque</option><option value="avariado">Avariado</option><option value="descarte">Descarte</option></select></td></tr>)}</tbody></table>
        <div className="expedicao-toolbar"><label>Motivo<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: cliente recusou na entrega" /></label>
          <button type="button" disabled={busy || reason.trim().length < 3} onClick={() => void registerReturn()}>Registrar devolução</button></div>
      </>}
    </section>
    <p><button type="button" onClick={() => navigate(ROUTE)}>Voltar para a expedição</button></p>
  </>;
}

// ---------------------------------------------------------------------------
// Embalagens

function Packages({ port }: { port: ExpedicaoPort }) {
  const access = port.access();
  const [items, setItems] = useState<Package[] | null>(null);
  const empty = { id: "", versao: 0, nome: "", comprimento: "", largura: "", altura: "", peso_vazio: "", ativa: true };
  const [form, setForm] = useState(empty);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  useEffect(() => { const s = new AbortController(); port.packages(s.signal).then((r) => setItems(r.items), (e) => { if (!aborted(e)) setError(errorText(e)); }); return () => s.abort(); }, [port, reload]);
  const save = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      await port.savePackage({ ...(form.id ? { id: form.id, versao: form.versao } : {}), nome: form.nome, comprimento: form.comprimento || undefined, largura: form.largura || undefined,
        altura: form.altura || undefined, peso_vazio: form.peso_vazio || undefined, ativa: form.ativa }, port.command());
      setForm(empty); setNotice("Embalagem gravada."); setReload((n) => n + 1);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return <>
    <p className="expedicao-hint">Cadastre as caixas e envelopes que você usa. As medidas e o peso vazio entram no cálculo do volume e na etiqueta.</p>
    <Message error={error} notice={notice} />
    {!items ? <p role="status">Carregando…</p> : !items.length ? <p>Nenhuma embalagem cadastrada ainda.</p> :
      <table className="expedicao-table"><thead><tr><th>Nome</th><th>Medidas (cm)</th><th>Peso vazio</th><th>Situação</th><th></th></tr></thead>
        <tbody>{items.map((p) => <tr key={p.id}><td>{p.name}</td><td>{[p.length_mm, p.width_mm, p.height_mm].map(cm).join(" × ")}</td><td>{kg(p.empty_weight_g)}</td><td>{p.active ? "Ativa" : "Inativa"}</td>
          <td>{access.role !== "consulta" && <button type="button" onClick={() => setForm({ id: p.id, versao: p.version, nome: p.name, comprimento: cm(p.length_mm), largura: cm(p.width_mm), altura: cm(p.height_mm),
            peso_vazio: p.empty_weight_g === null ? "" : String(p.empty_weight_g / 1000).replace(".", ","), ativa: p.active })}>Alterar</button>}</td></tr>)}</tbody></table>}
    {access.role !== "consulta" && <section className="expedicao-card"><h2>{form.id ? "Alterar embalagem" : "Nova embalagem"}</h2>
      <div className="expedicao-toolbar">
        <label>Nome<input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="Ex.: Caixa média" /></label>
        {(["comprimento", "largura", "altura"] as const).map((k) => <label key={k}>{k[0].toUpperCase() + k.slice(1)} (cm)<input inputMode="decimal" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></label>)}
        <label>Peso vazio (kg)<input inputMode="decimal" value={form.peso_vazio} onChange={(e) => setForm({ ...form, peso_vazio: e.target.value })} /></label>
        <label><input type="checkbox" checked={form.ativa} onChange={(e) => setForm({ ...form, ativa: e.target.checked })} /> Ativa</label>
        <button type="button" className="expedicao-primary" disabled={busy || !form.nome.trim()} onClick={() => void save()}>Gravar</button>
        {form.id && <button type="button" onClick={() => setForm(empty)}>Nova</button>}
      </div></section>}
  </>;
}

// ---------------------------------------------------------------------------
// Romaneio

function ManifestScreen({ port }: { port: ExpedicaoPort }) {
  const [from, setFrom] = useState(today()), [to, setTo] = useState(today());
  const [data, setData] = useState<Manifest | null>(null), [error, setError] = useState("");
  useEffect(() => {
    const s = new AbortController(); setError("");
    port.manifest({ de: from, ate: to }, s.signal).then(setData, (e) => { if (!aborted(e)) setError(errorText(e)); });
    return () => s.abort();
  }, [port, from, to]);
  const download = (carriers: Manifest["carriers"], name: string) => data && savePdf(pdfName(`romaneio-${name}`), manifestPdf(carriers, data.sender, { from: data.from, to: data.to }));
  const total = useMemo(() => data?.carriers.reduce((s, c) => s + c.orders.length, 0) ?? 0, [data]);
  return <>
    <p className="expedicao-hint">Lista dos pedidos expedidos por transportadora, com volumes, peso e espaço para a assinatura de quem recebeu.</p>
    <div className="expedicao-toolbar">
      <label>Expedidos de<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>até<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <button type="button" disabled={!total} onClick={() => data && download(data.carriers, "todas")}>Baixar romaneio de todas (PDF)</button>
    </div>
    <Message error={error} />
    {!data ? !error && <p role="status">Carregando…</p> : !data.carriers.length ? <p>Nenhum pedido expedido no período.</p> : data.carriers.map((c) => <section className="expedicao-card" key={c.carrier.id ?? "sem"}>
      <h2>{c.carrier.name ?? "Sem transportadora (entrega própria ou retirada)"}</h2>
      <table className="expedicao-table"><thead><tr><th>Pedido</th><th>Cliente</th><th>Cidade</th><th>Volumes</th><th>Peso bruto</th><th>Rastreio</th></tr></thead>
        <tbody>{c.orders.map((o) => <tr key={o.number}><td>{o.number}</td><td>{o.customer}</td><td>{[o.city, o.state].filter(Boolean).join(" / ")}</td><td>{o.volumes}</td><td>{kg(o.gross_weight_g)}</td><td>{o.tracking_code ?? ""}</td></tr>)}</tbody></table>
      <p>{c.orders.length} pedido{c.orders.length > 1 ? "s" : ""} · {c.volumes} volume{c.volumes === 1 ? "" : "s"} · {kg(c.gross_weight_g)}</p>
      <button type="button" onClick={() => download([c], (c.carrier.name ?? "sem-transportadora").toLowerCase().replace(/[^a-z0-9]+/g, "-"))}>Baixar romaneio (PDF)</button>
    </section>)}
  </>;
}
