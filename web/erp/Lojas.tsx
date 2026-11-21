// Cadastros › Lojas e filiais: o cadastro das lojas (dados, depósitos, caixas,
// depósito padrão e série), o limite de lojas de cada pessoa, a comparação das
// lojas no período e as operações de cada loja. Com uma loja só, a tela mostra
// a loja principal e o botão para cadastrar a segunda; nenhuma outra tela
// muda. O servidor confere e grava (src/erp/lojas/); a tela só manda as
// escolhas da pessoa. StoreSwitcher (a loja em uso) só aparece com duas lojas.
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { erpPorts } from "./ports";
import type { Compared, LojasPort, OperationKind, Operations, Overview, Report, Store, StoreInput } from "./lojas-api";
import "./lojas.css";
import CnpjLookupButton from "./app/components/CnpjLookupButton";
import CepLookupButton from "./app/components/CepLookupButton";

const ROUTE = "/lojas";
const errorText = (error: unknown) => (error instanceof Error ? error.message : "Algo deu errado. Atualize a tela e tente de novo.");
const aborted = (error: unknown) => error instanceof Error && error.name === "AbortError";
const day = (v: string | null | undefined) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10).split("-").reverse().join("/") : "—");
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const monthStart = () => `${today().slice(0, 8)}01`;
/** "1234.50" → "R$ 1.234,50"; centavos inteiros também ("123450" com cents=true). */
const money = (v: string | null | undefined, cents = false) => {
  if (v === null || v === undefined || v === "") return "—";
  const n = cents ? Number(v) / 100 : Number(v);
  return Number.isFinite(n) ? n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : v;
};
const qty = (v: string | null | undefined) => (v ? Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 3 }) : "0");
const ROLE: Record<string, string> = { admin: "Administrador", consulta: "Consulta", vendas: "Vendas", financeiro: "Financeiro", estoque: "Estoque", fiscal: "Fiscal" };
const UFS = "AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" ");

function Message({ error, notice }: { error?: string; notice?: string }) {
  return <>{error && <p className="lojas-error" role="alert">{error}</p>}{notice && <p className="lojas-notice" role="status">{notice}</p>}</>;
}

function useOverview(port: LojasPort) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    port.overview(ctrl.signal).then((o) => { setData(o); setError(""); }).catch((e) => { if (!aborted(e)) setError(errorText(e)); });
    return () => ctrl.abort();
  }, [port, tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

export default function Lojas({ port: injected }: { port?: LojasPort }) {
  const port = injected ?? erpPorts()?.lojas;
  if (!port) return <section className="real-state-panel"><h1>Lojas e filiais</h1><p>As lojas ainda não estão disponíveis nesta área.</p></section>;
  return <LojasBody port={port} />;
}

function LojasBody({ port }: { port: LojasPort }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { data, error, reload } = useOverview(port);
  const tab = new URLSearchParams(location.search).get("aba");
  if (error) return <div className="lojas"><h1>Lojas e filiais</h1><Message error={error} /><button type="button" onClick={reload}>Tentar de novo</button></div>;
  if (!data) return <div className="lojas"><h1>Lojas e filiais</h1><p role="status">Carregando as lojas…</p></div>;
  const tabs: [string | null, string][] = [[null, "Lojas"]];
  if (data.multi) tabs.push(["comparar", "Comparar lojas"], ["operacoes", "Operações por loja"]);
  if (data.multi && data.admin) tabs.push(["pessoas", "Pessoas"]);
  const current = tabs.some(([id]) => id === tab) ? tab : null;
  return <div className="lojas">
    <h1>Lojas e filiais</h1>
    {tabs.length > 1 && <nav className="lojas-tabs" aria-label="Partes das lojas">
      {tabs.map(([id, label]) => <button key={label} type="button" aria-pressed={current === id} onClick={() => navigate(id ? `${ROUTE}?aba=${id}` : ROUTE)}>{label}</button>)}
    </nav>}
    {current === "comparar" ? <CompareScreen port={port} overview={data} />
      : current === "operacoes" ? <OperationsScreen port={port} overview={data} />
      : current === "pessoas" ? <PeopleScreen port={port} overview={data} onSaved={reload} />
      : <StoresScreen port={port} overview={data} onSaved={reload} />}
  </div>;
}

// ---------------------------------------------------------------------------
// Cadastro

function StoresScreen({ port, overview, onSaved }: { port: LojasPort; overview: Overview; onSaved: () => void }) {
  const [editing, setEditing] = useState<Store | "new" | null>(null);
  const [notice, setNotice] = useState("");
  if (editing) return <StoreForm port={port} overview={overview} store={editing === "new" ? null : editing}
    onDone={(message) => { setEditing(null); setNotice(message ?? ""); if (message) onSaved(); }} />;
  return <>
    <Message notice={notice} />
    {!overview.multi && <p>Sua empresa tem uma loja só: tudo o que existe é desta loja e nada muda nas outras telas.
      {overview.admin ? " Cadastre a segunda loja (ou um quiosque) para separar estoque, caixa, vendas e relatórios por loja." : ""}</p>}
    {overview.me.limited && <p className="lojas-notice">Você vê só as lojas liberadas para você pelo administrador.</p>}
    <table className="lojas-table">
      <thead><tr><th>Loja</th><th>Endereço</th><th>Depósitos</th><th>Caixas e contas</th>{overview.admin && <th><span className="lojas-sr">Ações</span></th>}</tr></thead>
      <tbody>{overview.stores.map((s) => <tr key={s.id}>
        <td><strong>{s.name}</strong>{s.is_main && <small>Loja principal</small>}{!s.active && <small>Desativada</small>}
          {s.cnpj && <small>CNPJ da filial {s.cnpj}</small>}{s.fiscal_series !== null && s.fiscal_series !== undefined && <small>Série das notas: {s.fiscal_series}</small>}</td>
        <td>{[s.address?.street, s.address?.number, s.address?.district, s.address?.city && `${s.address.city}${s.address.state ? `/${s.address.state}` : ""}`].filter(Boolean).join(", ") || "—"}
          {s.phone && <small>Telefone {s.phone}</small>}</td>
        <td>{s.warehouses?.length ? s.warehouses.map((w) => w.name + (w.id === s.default_warehouse_id ? " (padrão)" : "")).join(", ") : "—"}</td>
        <td>{s.accounts?.length ? s.accounts.map((a) => a.name).join(", ") : "—"}</td>
        {overview.admin && <td><button type="button" onClick={() => setEditing(s)}>Alterar</button></td>}
      </tr>)}</tbody>
    </table>
    {overview.admin && <div className="lojas-actions"><button type="button" className="lojas-primary" onClick={() => setEditing("new")}>{overview.multi ? "Cadastrar loja" : "Cadastrar a segunda loja"}</button></div>}
    {overview.multi && <p className="lojas-help">Para mandar mercadoria de uma loja para outra, use a transferência entre depósitos (Estoque › Transferência): escolha o depósito de saída de uma loja e o de chegada da outra.</p>}
  </>;
}

function StoreForm({ port, overview, store, onDone }: { port: LojasPort; overview: Overview; store: Store | null; onDone: (message?: string) => void }) {
  const [name, setName] = useState(store?.name ?? "");
  const [address, setAddress] = useState({ ...store?.address });
  const [phone, setPhone] = useState(store?.phone ?? "");
  const [cnpj, setCnpj] = useState(store?.cnpj ?? "");
  const [series, setSeries] = useState(store?.fiscal_series === null || store?.fiscal_series === undefined ? "" : String(store.fiscal_series));
  const [active, setActive] = useState(store?.active ?? true);
  const [warehouses, setWarehouses] = useState<string[]>(store?.warehouses?.map((w) => w.id) ?? []);
  const [accounts, setAccounts] = useState<string[]>(store?.accounts?.map((a) => a.id) ?? []);
  const [defaultWarehouse, setDefaultWarehouse] = useState(store?.default_warehouse_id ?? "");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [command] = useState(() => port.command());
  const storeName = (id: string | null) => overview.stores.find((s) => s.id === id)?.name ?? "outra loja";
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const save = async () => {
    setBusy(true); setError("");
    const input: StoreInput = {
      ...(store ? { id: store.id, versao: store.version } : {}), nome: name, endereco: Object.fromEntries(Object.entries(address).filter(([, v]) => v)),
      telefone: phone, cnpj, serie: series === "" ? null : Number(series), ativa: active, depositos: warehouses, contas: accounts,
      deposito_padrao: defaultWarehouse && warehouses.includes(defaultWarehouse) ? defaultWarehouse : null,
    };
    try { await port.save(input, command); onDone(store ? "Loja alterada." : "Loja cadastrada."); }
    catch (e) { setError(errorText(e)); setBusy(false); }
  };
  const field = (key: keyof typeof address, label: string, size = 20) => <label>{label}
    <input value={address[key] ?? ""} size={size} onChange={(e) => setAddress({ ...address, [key]: e.target.value })} /></label>;
  return <section className="lojas-card" aria-labelledby="loja-form">
    <h2 id="loja-form">{store ? `Alterar ${store.name}` : "Nova loja"}</h2>
    <Message error={error} />
    <div className="lojas-grid">
      <label>Nome da loja<input value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} /></label>
      <label>Telefone<input value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value)} /></label>
      <label>CNPJ da filial (em branco: o da empresa)<input value={cnpj} onChange={(e) => setCnpj(e.target.value)} /></label>
      {/* Pedido do dono (21/11): o CNPJ da filial busca o endereço e o telefone na Receita; o CEP busca o endereço. */}
      <CnpjLookupButton id="loja-cnpj-busca" cnpj={cnpj} disabled={busy} onFound={(d) => {
        setAddress((a) => ({ ...a, ...(d.cep ? { postal_code: d.cep } : {}), ...(d.endereco ? { street: d.endereco } : {}), ...(d.numero ? { number: d.numero } : {}),
          ...(d.complemento ? { complement: d.complemento } : {}), ...(d.bairro ? { district: d.bairro } : {}), ...(d.cidade ? { city: d.cidade } : {}), ...(d.uf ? { state: d.uf } : {}) }));
        if (d.telefone && !phone.trim()) setPhone(d.telefone);
        if (!name.trim() && (d.nome_fantasia || d.razao_social)) setName((d.nome_fantasia || d.razao_social)!.slice(0, 80));
      }} />
      <label>Série das notas da loja<input value={series} inputMode="numeric" onChange={(e) => setSeries(e.target.value.replace(/\D/g, "").slice(0, 3))} /></label>
      {field("postal_code", "CEP", 9)}
      <CepLookupButton id="loja-cep-busca" cep={address.postal_code} disabled={busy} onFound={(a) => setAddress((cur) => ({ ...cur, postal_code: a.cep.replace(/^(\d{5})(\d{3})$/, "$1-$2"), city: a.city, state: a.state,
        ...(a.district ? { district: a.district } : {}), ...(a.street ? { street: a.street } : {}), ...(a.complement && !cur.complement ? { complement: a.complement } : {}) }))} />{field("street", "Rua", 30)}{field("number", "Número", 6)}{field("complement", "Complemento")}{field("district", "Bairro")}{field("city", "Cidade")}
      <label>UF<select value={address.state ?? ""} onChange={(e) => setAddress({ ...address, state: e.target.value })}><option value="">—</option>{UFS.map((u) => <option key={u}>{u}</option>)}</select></label>
    </div>
    <p className="lojas-help">As notas continuam saindo pelo mesmo emissor da empresa; a série da loja fica guardada aqui para a emissão da loja.</p>
    <fieldset><legend>Depósitos desta loja</legend>
      {overview.warehouses?.length ? overview.warehouses.map((w) => <label key={w.id} className="lojas-check">
        <input type="checkbox" checked={warehouses.includes(w.id)} disabled={!!store?.is_main && w.store_id === store.id} onChange={() => toggle(warehouses, setWarehouses, w.id)} />
        {w.name}{w.store_id && w.store_id !== store?.id ? <small> (hoje em {storeName(w.store_id)}; passa para esta)</small> : null}{w.active === false && <small> (inativo)</small>}
      </label>) : <p>Nenhum depósito cadastrado. Cadastre em Estoque › Depósitos.</p>}
      {store?.is_main && <p className="lojas-help">Depósito que sai de outra loja volta para a principal; para tirar um depósito da principal, marque-o na outra loja.</p>}
    </fieldset>
    <label>Depósito padrão (pedidos e vendas novos da loja saem dele)
      <select value={defaultWarehouse} onChange={(e) => setDefaultWarehouse(e.target.value)}>
        <option value="">Nenhum (o padrão da empresa)</option>
        {overview.warehouses?.filter((w) => warehouses.includes(w.id)).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
      </select></label>
    <fieldset><legend>Caixas e contas financeiras desta loja</legend>
      {overview.accounts?.length ? overview.accounts.map((a) => <label key={a.id} className="lojas-check">
        <input type="checkbox" checked={accounts.includes(a.id)} disabled={!!store?.is_main && a.store_id === store.id} onChange={() => toggle(accounts, setAccounts, a.id)} />
        {a.name}{a.kind === "cash" && <small> (caixa)</small>}{a.store_id && a.store_id !== store?.id ? <small> (hoje em {storeName(a.store_id)}; passa para esta)</small> : null}
      </label>) : <p>Nenhuma conta cadastrada. Cadastre em Financeiro › Caixas e bancos.</p>}
    </fieldset>
    {!store?.is_main && <label className="lojas-check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Loja ativa</label>}
    <p className="lojas-help">O que já aconteceu num depósito ou caixa que muda de loja continua na loja em que aconteceu.</p>
    <div className="lojas-actions">
      <button type="button" className="lojas-primary" disabled={busy || !name.trim()} onClick={save}>{busy ? "Salvando…" : "Salvar loja"}</button>
      <button type="button" onClick={() => onDone()} disabled={busy}>Voltar</button>
    </div>
  </section>;
}

// ---------------------------------------------------------------------------
// Pessoas

function PeopleScreen({ port, overview, onSaved }: { port: LojasPort; overview: Overview; onSaved: () => void }) {
  const [chosen, setChosen] = useState<Record<string, string[]>>(() => Object.fromEntries((overview.people ?? []).map((p) => [p.user_id, p.store_ids])));
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState<string | null>(null);
  const active = overview.stores.filter((s) => s.active);
  const save = async (user: string) => {
    setBusy(user); setError(""); setNotice("");
    try { await port.setPerson(user, chosen[user] ?? [], port.command()); setNotice("Lojas da pessoa salvas."); onSaved(); }
    catch (e) { setError(errorText(e)); }
    setBusy(null);
  };
  return <>
    <p>Limite uma pessoa a uma ou mais lojas: ela só vê e opera as lojas dela (listas, relatórios e caixa). Sem nenhuma marcada, a pessoa vê todas. O administrador vê todas sempre.</p>
    <Message error={error} notice={notice} />
    <table className="lojas-table">
      <thead><tr><th>Pessoa</th>{active.map((s) => <th key={s.id}>{s.name}</th>)}<th><span className="lojas-sr">Salvar</span></th></tr></thead>
      <tbody>{(overview.people ?? []).map((p) => <tr key={p.user_id}>
        <td>{p.name ?? "Sem nome"}<small>{ROLE[p.role] ?? p.role}</small></td>
        {active.map((s) => <td key={s.id}>{p.role === "admin" ? <small>Todas</small> : <input type="checkbox" aria-label={`${p.name ?? "Pessoa"} em ${s.name}`}
          checked={(chosen[p.user_id] ?? []).includes(s.id)}
          onChange={() => setChosen((c) => { const list = c[p.user_id] ?? []; return { ...c, [p.user_id]: list.includes(s.id) ? list.filter((x) => x !== s.id) : [...list, s.id] }; })} />}</td>)}
        <td>{p.role !== "admin" && <button type="button" disabled={busy === p.user_id} onClick={() => save(p.user_id)}>{busy === p.user_id ? "Salvando…" : "Salvar"}</button>}</td>
      </tr>)}</tbody>
    </table>
  </>;
}

// ---------------------------------------------------------------------------
// Comparação

const DRE_LABEL: Record<string, string> = {
  net_revenue: "Receita líquida", gross_profit: "Lucro bruto", operating_result: "Resultado operacional", financial_result: "Resultado financeiro",
  other_result: "Outras receitas e despesas", before_taxes: "Resultado antes dos impostos", net_result: "Resultado líquido",
};

function CompareScreen({ port, overview }: { port: LojasPort; overview: Overview }) {
  const [from, setFrom] = useState(monthStart()), [to, setTo] = useState(today());
  const [basis, setBasis] = useState<"caixa" | "competencia">("caixa");
  const [picked, setPicked] = useState<string[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const load = () => {
    setLoading(true); setError("");
    port.report({ de: from, ate: to, regime: basis, lojas: picked.length ? picked : undefined })
      .then((r) => setReport(r)).catch((e) => setError(errorText(e))).finally(() => setLoading(false));
  };
  useEffect(load, []); // primeira leitura: o mês corrente
  const rows: [string, Compared | undefined, (v: string) => string][] = useMemo(() => {
    if (!report) return [];
    const out: [string, Compared | undefined, (v: string) => string][] = [];
    if (report.sales) out.push(["Pedidos de venda", report.sales.orders, (v) => v], ["Vendas no período", report.sales.total, (v) => money(v)],
      ["Tíquete médio", report.sales.average_ticket, (v) => money(v)], ["Vendas pelo caixa (PDV)", report.sales.pos_total, (v) => money(v)]);
    if (report.cash) out.push(["Entradas no caixa e bancos", report.cash.inflow, (v) => money(v, true)], ["Saídas", report.cash.outflow, (v) => money(v, true)],
      ["Saldo do período", report.cash.net, (v) => money(v, true)], ["Saldo hoje", report.cash.balance, (v) => money(v, true)],
      ["Sessões de caixa abertas no período", report.cash.sessions, (v) => v], ["Caixas abertos agora", report.cash.open_sessions, (v) => v]);
    if (report.stock) out.push(["Quantidade em estoque", report.stock.quantity, qty],
      ...(report.stock.cost_value ? [["Estoque a custo", report.stock.cost_value, (v: string) => money(v)] as [string, Compared, (v: string) => string],
        ["Estoque a preço de venda", report.stock.sale_value, (v: string) => money(v)] as [string, Compared | undefined, (v: string) => string]] : []));
    if (report.dre) for (const l of report.dre.lines) out.push([`DRE: ${DRE_LABEL[l.key] ?? l.key}`, l, (v) => money(v, true)]);
    return out;
  }, [report]);
  const missing = report?.unavailable.map((u) => ({ sales: "vendas", cash: "caixa", stock: "estoque", dre: "DRE" } as Record<string, string>)[u] ?? u) ?? [];
  return <>
    <div className="lojas-toolbar">
      <label>De<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>Até<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <label>Regime do DRE<select value={basis} onChange={(e) => setBasis(e.target.value as "caixa" | "competencia")}><option value="caixa">Caixa (pagamentos)</option><option value="competencia">Competência</option></select></label>
      <fieldset className="lojas-inline"><legend>Lojas</legend>{overview.stores.filter((s) => s.active).map((s) => <label key={s.id} className="lojas-check">
        <input type="checkbox" checked={picked.includes(s.id)} onChange={() => setPicked((p) => p.includes(s.id) ? p.filter((x) => x !== s.id) : [...p, s.id])} />{s.name}</label>)}</fieldset>
      <button type="button" className="lojas-primary" onClick={load} disabled={loading}>{loading ? "Calculando…" : "Comparar"}</button>
    </div>
    <Message error={error} />
    {report && <>
      <table className="lojas-table lojas-compare">
        <thead><tr><th>No período {day(report.from)} a {day(report.to)}</th>{report.stores.map((s) => <th key={s.id}>{s.name}</th>)}<th>Total</th></tr></thead>
        <tbody>{rows.map(([label, c, f]) => c && <tr key={label}><th scope="row">{label}</th>{report.stores.map((s) => <td key={s.id}>{f(c.by_store[s.id] ?? "0")}</td>)}<td><strong>{f(c.total)}</strong></td></tr>)}</tbody>
      </table>
      {report.stock?.cost_hidden && <p className="lojas-help">O custo do estoque não aparece para o seu papel; só a quantidade.</p>}
      {missing.length > 0 && <p className="lojas-help">Fora desta comparação: {missing.join(", ")} (módulo desligado ou papel que não vê). Os módulos ligam em Gestão → Módulos.</p>}
    </>}
  </>;
}

// ---------------------------------------------------------------------------
// Operações

const KINDS: [OperationKind, string, keyof import("./lojas-api").LojasAccess["parts"]][] = [
  ["pedidos", "Pedidos de venda", "sales"], ["propostas", "Propostas", "sales"], ["compras", "Pedidos de compra", "purchases"],
  ["contas", "Contas a pagar e receber", "finance"], ["estoque", "Movimentações de estoque", "stock"], ["caixa", "Vendas no caixa (PDV)", "pos"],
];
const STATUS: Record<string, string> = { open: "Em aberto", settled: "Paga", cancelled: "Cancelada", finished: "Finalizada", draft: "Rascunho" };

function OperationsScreen({ port, overview }: { port: LojasPort; overview: Overview }) {
  const parts = port.access().parts;
  const kinds = KINDS.filter(([, , part]) => parts[part]);
  const [kind, setKind] = useState<OperationKind>(kinds[0]?.[0] ?? "pedidos");
  const [store, setStore] = useState(overview.me.selected_store_id ?? "");
  const [from, setFrom] = useState(monthStart()), [to, setTo] = useState(today());
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Operations | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!kinds.length) return;
    const ctrl = new AbortController();
    setError("");
    port.operations({ tipo: kind, loja: store || undefined, de: from, ate: to, pagina: page }, ctrl.signal).then(setData).catch((e) => { if (!aborted(e)) setError(errorText(e)); });
    return () => ctrl.abort();
  }, [port, kind, store, from, to, page, tick]);
  if (!kinds.length) return <p>Nenhum módulo de operação está ligado (Vendas, Compras, Estoque, Financeiro ou Caixa / PDV). Ligue em Gestão → Módulos.</p>;
  const canMove = (kind === "pedidos" || kind === "propostas" || kind === "compras" || kind === "contas") && ["admin", "vendas", "financeiro", "estoque"].includes(overview.role);
  const move = async (id: string, target: string) => {
    setError(""); setNotice("");
    try { await port.assign({ registro: kind === "contas" ? "conta" : "documento", id, loja: target }, port.command()); setNotice("Loja alterada."); setTick((t) => t + 1); }
    catch (e) { setError(errorText(e)); }
  };
  const active = overview.stores.filter((s) => s.active);
  return <>
    <div className="lojas-toolbar">
      <label>O que ver<select value={kind} onChange={(e) => { setKind(e.target.value as OperationKind); setPage(1); }}>{kinds.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>Loja<select value={store} onChange={(e) => { setStore(e.target.value); setPage(1); }}><option value="">Todas as minhas lojas</option>{active.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>De<input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} /></label>
      <label>Até<input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} /></label>
    </div>
    <Message error={error} notice={notice} />
    {data && (data.items.length ? <table className="lojas-table">
      <thead><tr><th>Data</th><th>Operação</th><th>Detalhe</th><th>Valor</th><th>Loja</th></tr></thead>
      <tbody>{data.items.map((i) => <tr key={`${i.id}:${i.description ?? ""}`}>
        <td>{day(i.date)}</td>
        <td>{i.label}{i.number ? ` nº ${i.number}` : ""}{i.status && <small>{STATUS[i.status] ?? i.status}</small>}</td>
        <td>{i.contact_name ?? i.description ?? "—"}{i.reason && <small>{i.reason}</small>}</td>
        <td>{i.total ? money(i.total) : i.quantity ? qty(i.quantity) : "—"}</td>
        <td>{canMove && active.length > 1 ? <select aria-label="Mudar a loja" value={i.store_id} onChange={(e) => move(i.id, e.target.value)}>{active.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select> : i.store_name}</td>
      </tr>)}</tbody>
    </table> : <p>Nada neste período{store ? " nesta loja" : ""}.</p>)}
    {data && data.total > data.limit && <div className="lojas-actions">
      <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Anterior</button>
      <span>Página {page} de {Math.ceil(data.total / data.limit)}</span>
      <button type="button" disabled={page * data.limit >= data.total} onClick={() => setPage((p) => p + 1)}>Próxima</button>
    </div>}
  </>;
}

// ---------------------------------------------------------------------------
// Loja em uso (só com duas lojas ou mais)

/** Barra "Loja em uso": estreita listas e relatórios e é a loja do que a pessoa cria. Some com uma loja só. */
export function StoreSwitcher({ port: injected }: { port?: LojasPort }) {
  const port = injected ?? erpPorts()?.lojas;
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!port || !port.access().ready) return;
    const ctrl = new AbortController();
    port.overview(ctrl.signal).then(setData).catch(() => { /* a barra é opcional: sem resposta, não aparece */ });
    return () => ctrl.abort();
  }, [port]);
  if (!port || !data?.multi) return null;
  const options = data.stores.filter((s) => s.active);
  const change = async (value: string) => {
    setError("");
    try {
      await port.select(value || null);
      // As listas abertas releem com a nova loja.
      globalThis.location?.reload();
    } catch (e) { setError(errorText(e)); }
  };
  return <div className="lojas-switcher" role="region" aria-label="Loja em uso">
    <label>Loja em uso
      <select value={data.me.selected_store_id ?? ""} onChange={(e) => void change(e.target.value)}>
        {(!data.me.allowed || data.me.allowed.length > 1) && <option value="">{data.me.allowed ? "Todas as minhas lojas" : "Todas as lojas"}</option>}
        {options.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
    {error && <span className="lojas-error" role="alert">{error}</span>}
  </div>;
}
