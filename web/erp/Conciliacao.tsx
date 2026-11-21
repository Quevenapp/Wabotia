// Financeiro › Conciliação bancária e Conciliação de cartões (parte Financeiro).
// Bancária: importar o extrato (OFX ou planilha com o modelo de colunas do
// banco), ver as sugestões com o grau de confiança e conciliar com um clique,
// baixar a conta sugerida, lançar pela regra, ignorar com motivo, desfazer, e
// o saldo do banco x saldo do sistema por dia. Cartões: importar vendas e
// recebíveis da adquirente, conferir a venda casada, a taxa cobrada x a
// contratada, o que ainda vai cair e receber na conta. O servidor confere e
// grava (src/erp/conciliacao/); a tela só lê o arquivo e manda as escolhas.
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { erpPorts } from "./ports";
import {
  readFileText, type BankLine, type BankPage, type Candidates, type CardLine, type CardPage, type ConciliacaoPort, type Overview, type Preview, type Suggestion,
} from "./conciliacao-api";
import "./conciliacao.css";

const errorText = (error: unknown) => (error instanceof Error ? error.message : "Algo deu errado. Atualize a tela e tente de novo.");
const aborted = (error: unknown) => error instanceof Error && error.name === "AbortError";
const day = (v: string | null | undefined) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10).split("-").reverse().join("/") : "—");
/** Centavos (texto) → "R$ 1.234,56". */
export function money(cents: string | number | null | undefined): string {
  if (cents === null || cents === undefined || cents === "") return "—";
  const v = BigInt(cents);
  const abs = v < 0n ? -v : v;
  return `${v < 0n ? "-" : ""}R$ ${(abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${(abs % 100n).toString().padStart(2, "0")}`;
}
const pct = (bp: number | null | undefined) => (bp === null || bp === undefined ? "—" : `${(bp / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`);
const write = (role: string | null) => role === "admin" || role === "financeiro";

/** Campos do modelo de colunas: nome na API (pt) → nome no motor → rótulo. */
export const BANK_FIELDS: readonly [string, string, string][] = [
  ["data", "date", "Data"], ["descricao", "description", "Descrição"], ["valor", "amount", "Valor (com sinal)"], ["credito", "credit", "Crédito / entrada"],
  ["debito", "debit", "Débito / saída"], ["saldo", "balance", "Saldo"], ["documento", "id", "Documento / identificador"], ["tipo", "type", "Tipo (C/D)"],
];
export const CARD_FIELDS: readonly [string, string, string][] = [
  ["data_venda", "sold_on", "Data da venda"], ["data_pagamento", "expected_on", "Data de pagamento"], ["bandeira", "brand", "Bandeira"], ["modalidade", "product", "Modalidade (débito/crédito)"],
  ["parcela", "installment", "Parcela"], ["parcelas", "installments", "Quantidade de parcelas"], ["bruto", "gross", "Valor bruto"], ["taxa", "fee", "Valor da taxa"],
  ["liquido", "net", "Valor líquido"], ["percentual", "rate", "Taxa em %"], ["nsu", "nsu", "NSU"], ["autorizacao", "authorization", "Autorização"],
];

export default function Conciliacao({ screen, port: injected }: { screen: "bank" | "card"; port?: ConciliacaoPort }) {
  const port = injected ?? erpPorts()?.conciliacao;
  const title = screen === "bank" ? "Conciliação bancária" : "Conciliação de cartões";
  if (!port) return <section className="real-state-panel"><h1>{title}</h1><p>A conciliação ainda não está disponível nesta área.</p></section>;
  const access = port.access();
  if (!access.parts.finance)
    return <section className="real-state-panel"><h1>{title}</h1><p>A conciliação faz parte do Financeiro, que está desligado. Peça ao administrador para ligar Financeiro em Gestão → Módulos.</p></section>;
  if (access.role && !["admin", "financeiro", "consulta"].includes(access.role))
    return <section className="real-state-panel"><h1>{title}</h1><p>Seu papel no ERP não vê o Financeiro. A conciliação é de quem tem o papel Administrador, Financeiro ou Consulta; peça ao administrador em Gestão › Pessoas e acessos.</p></section>;
  return <div className="conciliacao">{screen === "bank" ? <BankScreen port={port} /> : <CardScreen port={port} />}</div>;
}

function Message({ error, notice }: { error?: string; notice?: string }) {
  return <>{error && <p className="conciliacao-error" role="alert">{error}</p>}{notice && <p className="conciliacao-notice" role="status">{notice}</p>}</>;
}
const Confidence = ({ value, level }: { value: number | null; level: string | null }) =>
  value === null ? null : <span className={`conciliacao-confidence ${level === "alta" ? "high" : level === "média" ? "medium" : "low"}`} title="Grau de confiança da sugestão">{level} · {value}%</span>;

function useRunner() {
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<string | void>) => {
    setBusy(true); setError(""); setNotice("");
    try { const message = await work(); if (message) setNotice(message); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return { error, notice, busy, run, setError };
}

// ---------------------------------------------------------------------------
// Importar arquivo (banco ou adquirente) com prévia e modelo de colunas

function ImportPanel({ port, target, overview, account, onDone }: { port: ConciliacaoPort; target: "bank" | "card"; overview: Overview; account?: string; onDone: (message: string) => void }) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [kind, setKind] = useState<"vendas" | "recebiveis">("vendas");
  const [acquirer, setAcquirer] = useState("cielo");
  const [layout, setLayout] = useState("");
  const [columns, setColumns] = useState<Record<string, string>>({});
  const [decimal, setDecimal] = useState("auto"), [dateFormat, setDateFormat] = useState("dd/mm/aaaa");
  const [saveAs, setSaveAs] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const { error, notice, busy, run } = useRunner();
  const fields = target === "bank" ? BANK_FIELDS : CARD_FIELDS;
  const layouts = overview.layouts.filter((l) => l.kind === target && (target === "bank" || l.acquirer === acquirer));
  const isOfx = target === "bank" && !!file && (/\.ofx$/i.test(file.name) || /<OFX>/i.test(file.text.slice(0, 4000)));
  const mapping = () => {
    const chosen = Object.fromEntries(Object.entries(columns).filter(([, v]) => v));
    return Object.keys(chosen).length || decimal !== "auto" || dateFormat !== "dd/mm/aaaa" ? { colunas: chosen, decimal, formato_data: dateFormat } : undefined;
  };
  const choose = async (input: HTMLInputElement) => {
    const f = input.files?.[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) return run(async () => { throw new Error("O arquivo passa de 2 MB. Exporte um período menor e escolha de novo."); });
    setFile({ name: f.name, text: await readFileText(f) }); setPreview(null);
  };
  const check = () => run(async () => {
    if (!file) throw new Error("Escolha o arquivo primeiro.");
    const result = await port.preview({ alvo: target === "bank" ? "banco" : "cartao", ...(target === "card" ? { tipo: kind } : { formato: isOfx ? "ofx" : "csv" }),
      conteudo: file.text, ...(layout ? { modelo: layout } : {}), ...(mapping() ? { colunas: mapping() } : {}) });
    setPreview(result);
    // As colunas achadas viram o ponto de partida do modelo.
    if (result.header && result.mapped) setColumns((old) => {
      const next = { ...old };
      for (const [pt, engine] of fields.map(([p, e]) => [p, e] as const)) if (!next[pt] && result.mapped![engine] !== undefined) next[pt] = result.header![result.mapped![engine]] ?? "";
      return next;
    });
  });
  const submit = () => run(async () => {
    if (!file) throw new Error("Escolha o arquivo primeiro.");
    const common = { arquivo: file.name, conteudo: file.text, ...(layout ? { modelo: layout } : {}), ...(mapping() ? { colunas: mapping() } : {}), ...(saveAs.trim() ? { salvar_modelo: { nome: saveAs.trim() } } : {}) };
    if (target === "bank") {
      if (!account) throw new Error("Escolha a conta do extrato.");
      const r = await port.bankImport(account, { formato: isOfx ? "ofx" : "csv", ...common }, port.command());
      setFile(null); setPreview(null);
      onDone(r.duplicate_file ? "Este arquivo já foi importado nesta conta: nada mudou." : `${r.new_lines} lançamento${r.new_lines === 1 ? "" : "s"} novo${r.new_lines === 1 ? "" : "s"} para conciliar${r.skipped ? ` (${r.skipped} já estava${r.skipped === 1 ? "" : "m"} importado${r.skipped === 1 ? "" : "s"})` : ""}.`);
    } else {
      const r = await port.cardImport({ adquirente: acquirer, tipo: kind, ...common }, port.command());
      setFile(null); setPreview(null);
      onDone(r.duplicate_file ? "Este arquivo já foi importado: nada mudou." : `${r.new_lines} linha${r.new_lines === 1 ? "" : "s"} nova${r.new_lines === 1 ? "" : "s"}; ${r.suggested} com venda sugerida${r.skipped ? `; ${r.skipped} já existia${r.skipped === 1 ? "" : "m"}` : ""}.`);
    }
  });
  return <section className="conciliacao-card" aria-labelledby={`import-${target}`}>
    <h2 id={`import-${target}`}>{target === "bank" ? "Importar extrato do banco" : "Importar extrato da adquirente"}</h2>
    <p className="conciliacao-hint">{target === "bank"
      ? "Exporte no banco o extrato em OFX (melhor) ou em planilha CSV. Importar o mesmo arquivo de novo não duplica nada."
      : "Exporte no portal da maquininha a planilha (CSV) de vendas ou de recebíveis (pagamentos). Importar o mesmo arquivo de novo não duplica nada."}</p>
    <div className="conciliacao-toolbar">
      {target === "card" && <>
        <label>Adquirente<select value={acquirer} onChange={(e) => { setAcquirer(e.target.value); setLayout(""); }}>{overview.acquirers.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label>Arquivo de<select value={kind} onChange={(e) => setKind(e.target.value as "vendas" | "recebiveis")}><option value="vendas">Vendas</option><option value="recebiveis">Recebíveis / pagamentos</option></select></label>
      </>}
      <label>Arquivo<input type="file" accept={target === "bank" ? ".ofx,.csv,.txt" : ".csv,.txt"} onChange={(e) => void choose(e.currentTarget)} /></label>
      {!isOfx && <label>Modelo salvo<select value={layout} onChange={(e) => { setLayout(e.target.value); setColumns({}); }}>
        <option value="">Achar as colunas sozinho</option>{layouts.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select></label>}
    </div>
    {file && !isOfx && <details className="conciliacao-mapping" open={!!preview && !preview.total}>
      <summary>Dizer qual coluna é cada informação</summary>
      <p className="conciliacao-hint">Escreva o nome do cabeçalho como está na planilha (ou #3 para a 3ª coluna). Em branco: a tela procura sozinha.</p>
      <div className="conciliacao-grid">
        {fields.map(([pt, , label]) => <label key={pt}>{label}{preview?.header
          ? <select value={columns[pt] ?? ""} onChange={(e) => setColumns({ ...columns, [pt]: e.target.value })}><option value="">—</option>{preview.header.map((h, i) => <option key={`${h}-${i}`} value={h || `#${i + 1}`}>{h || `Coluna ${i + 1}`}</option>)}</select>
          : <input value={columns[pt] ?? ""} onChange={(e) => setColumns({ ...columns, [pt]: e.target.value })} />}</label>)}
        <label>Decimal<select value={decimal} onChange={(e) => setDecimal(e.target.value)}><option value="auto">Descobrir</option><option value=",">Vírgula (1.234,56)</option><option value=".">Ponto (1,234.56)</option></select></label>
        <label>Datas<select value={dateFormat} onChange={(e) => setDateFormat(e.target.value)}><option>dd/mm/aaaa</option><option>aaaa-mm-dd</option><option>mm/dd/aaaa</option></select></label>
      </div>
      {write(port.access().role) && <label>Salvar como modelo (nome do {target === "bank" ? "banco" : "relatório"})<input value={saveAs} maxLength={80} placeholder={target === "bank" ? "Ex.: Banco do Brasil" : "Ex.: Cielo vendas"} onChange={(e) => setSaveAs(e.target.value)} /></label>}
    </details>}
    <Message error={error} notice={notice} />
    <div className="conciliacao-actions">
      <button type="button" disabled={busy || !file} onClick={() => void check()}>Conferir o arquivo</button>
      {write(port.access().role) && <button type="button" className="conciliacao-primary" disabled={busy || !file || (target === "bank" && !account)} onClick={() => void submit()}>Importar</button>}
    </div>
    {preview && <div className="conciliacao-preview" role="status">
      <p>{preview.total} linha{preview.total === 1 ? "" : "s"}{preview.period_from ? ` de ${day(preview.period_from)} a ${day(preview.period_to)}` : ""}
        {preview.credits_cents ? ` · entradas ${money(preview.credits_cents)} · saídas ${money(preview.debits_cents)}` : ""}{preview.gross_cents ? ` · bruto ${money(preview.gross_cents)}` : ""}
        {preview.skipped ? ` · ${preview.skipped} linha(s) sem data ou valor ficam de fora` : ""}.</p>
      <table className="conciliacao-table"><tbody>{preview.lines.slice(0, 8).map((l, i) => <tr key={i}>
        <td>{day(String(l.posted_on ?? l.sold_on ?? l.expected_on ?? ""))}</td><td>{String(l.memo ?? l.brand ?? "")}</td>
        <td className="num">{money(String(l.amount_cents ?? l.gross_cents ?? ""))}</td></tr>)}</tbody></table>
    </div>}
  </section>;
}

// ---------------------------------------------------------------------------
// Conciliação bancária

function BankScreen({ port }: { port: ConciliacaoPort }) {
  const location = useLocation(), navigate = useNavigate();
  const q = new URLSearchParams(location.search);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [page, setPage] = useState<BankPage | null>(null);
  const [state, setState] = useState("pendentes"), [search, setSearch] = useState(""), [reload, setReload] = useState(0);
  const runner = useRunner();
  const account = q.get("conta") ?? overview?.accounts.find((a) => a.kind === "bank")?.id ?? overview?.accounts[0]?.id ?? "";
  useEffect(() => {
    const signal = new AbortController();
    port.overview(signal.signal).then(setOverview, (e) => { if (!aborted(e)) runner.setError(errorText(e)); });
    return () => signal.abort();
  }, [port, reload]);
  useEffect(() => {
    if (!account) return;
    const signal = new AbortController();
    port.bankLines(account, { situacao: state, busca: search.trim() || undefined }, signal.signal).then(setPage, (e) => { if (!aborted(e)) runner.setError(errorText(e)); });
    return () => signal.abort();
  }, [port, account, state, search, reload]);
  const refresh = (message?: string) => { setReload((n) => n + 1); if (message) void runner.run(async () => message); };
  if (!overview) return <><h1>Conciliação bancária</h1><Message error={runner.error} />{!runner.error && <p role="status">Carregando…</p>}</>;
  const canWrite = overview.can_write;
  const differences = page?.balances.filter((b) => b.difference_cents !== null && b.difference_cents !== "0") ?? [];
  return <>
    <h1>Conciliação bancária</h1>
    <p className="conciliacao-hint">Importe o extrato do banco e confira cada lançamento com o que está no sistema. As sugestões vêm com o grau de confiança: confira e concilie com um clique.</p>
    <div className="conciliacao-toolbar">
      <label>Conta<select value={account} onChange={(e) => navigate(`/conciliacao-bancaria?conta=${e.target.value}`)}>
        {overview.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}{a.pending ? ` (${a.pending} pendente${a.pending > 1 ? "s" : ""})` : ""}</option>)}
      </select></label>
      <label>Buscar<input type="search" value={search} placeholder="Descrição ou valor" onChange={(e) => setSearch(e.target.value)} /></label>
    </div>
    {!overview.accounts.length && <p className="conciliacao-warning">Nenhuma conta financeira ativa. Cadastre a conta do banco em Financeiro › Contas financeiras.</p>}
    {canWrite && account && <ImportPanel port={port} target="bank" overview={overview} account={account} onDone={(m) => refresh(m)} />}
    <Message error={runner.error} notice={runner.notice} />
    {page && <>
      <nav className="conciliacao-tabs" aria-label="Situação das linhas">
        {([["pendentes", "A conciliar", page.counts.pending], ["conciliadas", "Conciliadas", page.counts.reconciled], ["ignoradas", "Ignoradas", page.counts.ignored]] as const)
          .map(([id, label, n]) => <button key={id} type="button" aria-pressed={state === id} onClick={() => setState(id)}>{label} ({n})</button>)}
      </nav>
      {!page.lines.length ? <p className="conciliacao-hint">{state === "pendentes" ? "Nada a conciliar nesta conta. Importe um extrato novo quando quiser." : "Nenhuma linha nesta situação."}</p>
        : <table className="conciliacao-table conciliacao-lines">
          <thead><tr><th>Data</th><th>Descrição no banco</th><th className="num">Valor</th><th>{state === "pendentes" ? "Sugestão" : state === "conciliadas" ? "Conciliada com" : "Motivo"}</th><th><span className="sr-only">Ações</span></th></tr></thead>
          <tbody>{page.lines.map((l) => <BankRow key={l.id} port={port} line={l} overview={overview} canWrite={canWrite} onChange={refresh} />)}</tbody>
        </table>}
      {page.truncated && <p className="conciliacao-warning">Há mais linhas do que cabem na tela. Concilie estas ou use a busca.</p>}
      <BalanceTable page={page} differences={differences.length} />
    </>}
    <RulesPanel port={port} overview={overview} account={account} canWrite={canWrite} onChange={() => setReload((n) => n + 1)} />
  </>;
}

function BalanceTable({ page, differences }: { page: BankPage; differences: number }) {
  if (!page.balances.length) return null;
  return <section className="conciliacao-card" aria-labelledby="saldos">
    <h2 id="saldos">Saldo do banco x saldo do sistema</h2>
    <p className="conciliacao-hint">{differences
      ? `${differences} dia${differences > 1 ? "s" : ""} com diferença: há lançamento no banco que não está no sistema (ou o contrário). Concilie as linhas desses dias.`
      : "O saldo do banco bate com o do sistema nos dias com saldo no extrato."} O saldo do banco vem do extrato importado (OFX com saldo final, ou a coluna de saldo da planilha).</p>
    <table className="conciliacao-table"><thead><tr><th>Dia</th><th className="num">Banco</th><th className="num">Sistema</th><th className="num">Diferença</th></tr></thead>
      <tbody>{page.balances.slice(-31).map((b) => <tr key={b.day} className={b.difference_cents && b.difference_cents !== "0" ? "conciliacao-diff" : undefined}>
        <td>{day(b.day)}</td><td className="num">{money(b.bank_cents)}</td><td className="num">{money(b.system_cents)}</td>
        <td className="num">{b.difference_cents === null ? "sem saldo do banco" : b.difference_cents === "0" ? "ok" : <strong>{money(b.difference_cents)}</strong>}</td>
      </tr>)}</tbody></table>
  </section>;
}

function suggestionAction(s: Suggestion): Record<string, unknown> {
  if (s.type === "title") return { acao: "baixar", contas: (s.titles ?? []).map((t) => ({ id: t.id, versao: t.version })) };
  if (s.type === "rule") return { acao: "lancar_regra", regra: s.rule_id };
  return { acao: "confirmar", vinculos: (s.links ?? []).map((k) => ({ tipo: k.kind === "entry" ? "lancamento" : "movimento", id: k.id })) };
}
const suggestionVerb = (s: Suggestion) => (s.type === "title" ? "Baixar e conciliar" : s.type === "rule" ? "Lançar e conciliar" : "Conciliar");

function BankRow({ port, line, overview, canWrite, onChange }: { port: ConciliacaoPort; line: BankLine; overview: Overview; canWrite: boolean; onChange: (message?: string) => void }) {
  const [open, setOpen] = useState(false), [manual, setManual] = useState<Candidates | null>(null), [category, setCategory] = useState("");
  const { error, busy, run } = useRunner();
  const amount = BigInt(line.amount_cents);
  const best = line.suggestions[0];
  const act = (input: Record<string, unknown>, message: string) => run(async () => { await port.bankAction(line.id, { versao: line.version, ...input }, port.command()); onChange(message); });
  const ignore = () => { const reason = window.prompt("Por que esta linha fica de fora da conciliação?"); if (reason && reason.trim().length >= 3) void act({ acao: "ignorar", motivo: reason.trim() }, "Linha ignorada."); };
  const undo = () => {
    const reverse = window.confirm("Desfazer a conciliação desta linha.\n\nOK: desfaz e também estorna a baixa ou o lançamento criado por ela.\nCancelar: só desfaz o vínculo (a baixa ou o lançamento continuam).");
    void act({ acao: "desfazer", estornar: reverse }, reverse ? "Conciliação desfeita e baixa estornada." : "Conciliação desfeita; a linha voltou para a fila.");
  };
  const search = () => run(async () => { setManual(await port.bankCandidates(line.id, undefined)); setOpen(true); });
  const categories = overview.categories.filter((c) => c.kind === (amount > 0n ? "receivable" : "payable"));
  return <>
    <tr className={line.state}>
      <td>{day(line.posted_on)}</td>
      <td>{line.memo ?? "—"}{line.source === "csv" && <small>planilha</small>}</td>
      <td className={`num ${amount < 0n ? "out" : "in"}`}>{money(line.amount_cents)}</td>
      <td>
        {line.state === "pending" && (best ? <><Confidence value={best.confidence} level={best.level} /> {best.label}{best.detail && <small>{best.detail}</small>}</> : <span className="conciliacao-muted">Sem sugestão</span>)}
        {line.state === "reconciled" && line.links.map((k) => <span key={k.link_id} className="conciliacao-link">{k.note ?? k.line_kind} · {money(k.amount_cents)}{k.category_name ? ` · ${k.category_name}` : ""}{k.contact_name ? ` · ${k.contact_name}` : ""}</span>)}
        {line.state === "ignored" && (line.ignored_reason ?? "Ocultada sem motivo")}
        {error && <p className="conciliacao-error" role="alert">{error}</p>}
      </td>
      <td className="conciliacao-row-actions">{canWrite && <>
        {line.state === "pending" && best && <button type="button" className="conciliacao-primary" disabled={busy} onClick={() => void act(suggestionAction(best), "Linha conciliada.")}>{suggestionVerb(best)}</button>}
        {line.state === "pending" && <button type="button" disabled={busy} onClick={() => (open ? setOpen(false) : manual ? setOpen(true) : void search())}>{open ? "Fechar" : "Outras opções"}</button>}
        {line.state === "pending" && <button type="button" disabled={busy} onClick={ignore}>Ignorar</button>}
        {line.state === "reconciled" && <button type="button" disabled={busy} onClick={undo}>Desfazer</button>}
        {line.state === "ignored" && <button type="button" disabled={busy} onClick={() => void act({ acao: "voltar" }, "A linha voltou para a fila.")}>Voltar para a fila</button>}
      </>}</td>
    </tr>
    {open && line.state === "pending" && <tr className="conciliacao-more"><td colSpan={5}>
      {line.suggestions.length > 1 && <><h3>Outras sugestões</h3><ul>{line.suggestions.slice(1).map((s, i) => <li key={i}><Confidence value={s.confidence} level={s.level} /> {s.label}
        <button type="button" disabled={busy} onClick={() => void act(suggestionAction(s), "Linha conciliada.")}>{suggestionVerb(s)}</button></li>)}</ul></>}
      {manual && <><h3>Lançamentos e contas perto desta data</h3>
        {!manual.movements.length && !manual.titles.length && <p className="conciliacao-hint">Nada parecido no sistema num mês em volta. Lance abaixo.</p>}
        <ul>{manual.movements.filter((m) => BigInt(m.amount_cents) === amount).map((m) => <li key={m.id}>{day(m.posted_on)} · {m.note ?? m.line_kind} · {money(m.amount_cents)}{m.contact_name ? ` · ${m.contact_name}` : ""}
          <button type="button" disabled={busy} onClick={() => void act({ acao: "confirmar", vinculos: [{ tipo: m.kind === "entry" ? "lancamento" : "movimento", id: m.id }] }, "Linha conciliada.")}>Conciliar</button></li>)}
        {manual.titles.filter((t) => (t.kind === "receivable") === amount > 0n).slice(0, 15).map((t) => <li key={t.id}>{t.kind === "receivable" ? "Receber" : "Pagar"} {t.contact_name} · {t.description} · vence {day(t.due_on)} · saldo {money(t.balance_cents)}
          <button type="button" disabled={busy} onClick={() => void act({ acao: "baixar", contas: [{ id: t.id, versao: t.version, valor: (amount < 0n ? -amount : amount) < BigInt(t.balance_cents) ? String(amount < 0n ? -amount : amount) : t.balance_cents }] }, "Conta baixada e linha conciliada.")}>Baixar com esta linha</button></li>)}</ul></>}
      <div className="conciliacao-toolbar"><label>Lançar na categoria<select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Escolha…</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <button type="button" disabled={busy || !category} onClick={() => void act({ acao: "lancar", categoria: category }, "Lançamento criado e conciliado.")}>Lançar e conciliar</button></div>
    </td></tr>}
  </>;
}

function RulesPanel({ port, overview, account, canWrite, onChange }: { port: ConciliacaoPort; overview: Overview; account: string; canWrite: boolean; onChange: () => void }) {
  const [pattern, setPattern] = useState(""), [direction, setDirection] = useState("saidas"), [category, setCategory] = useState(""), [onlyHere, setOnlyHere] = useState(false);
  const { error, notice, busy, run } = useRunner();
  const kind = direction === "entradas" ? "receivable" : direction === "saidas" ? "payable" : null;
  const save = () => run(async () => {
    await port.saveRule({ nome: pattern.trim().slice(0, 80), texto: pattern.trim(), direcao: direction, categoria: category, ...(onlyHere && account ? { conta: account } : {}) }, port.command());
    setPattern(""); onChange(); return "Regra salva: as próximas linhas com esse texto já vêm com a sugestão.";
  });
  const toggle = (id: string, version: number, active: boolean, rule: Overview["rules"][number]) => run(async () => {
    await port.saveRule({ id, versao: version, nome: rule.name, texto: rule.pattern, direcao: rule.direction === "in" ? "entradas" : rule.direction === "out" ? "saidas" : "todas", categoria: rule.category_id,
      ...(rule.account_id ? { conta: rule.account_id } : {}), ativa: active }, port.command());
    onChange();
  });
  return <section className="conciliacao-card" aria-labelledby="regras">
    <h2 id="regras">Regras</h2>
    <p className="conciliacao-hint">Ensine o que fazer com lançamentos que se repetem: por exemplo, "tarifa" nas saídas vai para Despesas bancárias.</p>
    {overview.rules.length > 0 && <table className="conciliacao-table"><thead><tr><th>Quando a descrição tem</th><th>Em</th><th>Lançar em</th><th><span className="sr-only">Ações</span></th></tr></thead>
      <tbody>{overview.rules.map((r) => <tr key={r.id} className={r.active ? undefined : "conciliacao-muted"}><td>{r.pattern}</td><td>{r.direction === "in" ? "Entradas" : r.direction === "out" ? "Saídas" : "Entradas e saídas"}</td>
        <td>{r.category_name}</td><td>{canWrite && <button type="button" disabled={busy} onClick={() => void toggle(r.id, r.version, !r.active, r)}>{r.active ? "Desligar" : "Ligar"}</button>}</td></tr>)}</tbody></table>}
    {canWrite && <div className="conciliacao-toolbar">
      <label>Quando a descrição tiver<input value={pattern} maxLength={120} placeholder="Ex.: tarifa" onChange={(e) => setPattern(e.target.value)} /></label>
      <label>Em<select value={direction} onChange={(e) => { setDirection(e.target.value); setCategory(""); }}><option value="saidas">Saídas</option><option value="entradas">Entradas</option></select></label>
      <label>Lançar em<select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Escolha a categoria…</option>
        {overview.categories.filter((c) => !kind || c.kind === kind).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="conciliacao-check"><input type="checkbox" checked={onlyHere} onChange={(e) => setOnlyHere(e.target.checked)} /> Só nesta conta</label>
      <button type="button" disabled={busy || pattern.trim().length < 2 || !category} onClick={() => void save()}>Salvar regra</button>
    </div>}
    <Message error={error} notice={notice} />
  </section>;
}

// ---------------------------------------------------------------------------
// Conciliação de cartões

function CardScreen({ port }: { port: ConciliacaoPort }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [page, setPage] = useState<CardPage | null>(null);
  const [kind, setKind] = useState("recebivel"), [state, setState] = useState("abertas"), [acquirer, setAcquirer] = useState(""), [divergent, setDivergent] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const runner = useRunner();
  useEffect(() => {
    const signal = new AbortController();
    port.overview(signal.signal).then(setOverview, (e) => { if (!aborted(e)) runner.setError(errorText(e)); });
    return () => signal.abort();
  }, [port, reload]);
  useEffect(() => {
    const signal = new AbortController();
    port.cardLines({ tipo: kind, situacao: state, adquirente: acquirer || undefined, divergentes: divergent ? "true" : undefined }, signal.signal)
      .then((p) => { setPage(p); setSelected(new Set()); }, (e) => { if (!aborted(e)) runner.setError(errorText(e)); });
    return () => signal.abort();
  }, [port, kind, state, acquirer, divergent, reload]);
  const refresh = (message?: string) => { setReload((n) => n + 1); if (message) void runner.run(async () => message); };
  if (!overview) return <><h1>Conciliação de cartões</h1><Message error={runner.error} />{!runner.error && <p role="status">Carregando…</p>}</>;
  const canWrite = overview.can_write;
  const lines = page?.lines ?? [];
  const receivable = lines.filter((l) => selected.has(l.id));
  const batch = (input: Record<string, unknown>, message: (r: { confirmed?: number; suggested?: number }) => string) =>
    runner.run(async () => { const r = await port.cardBatch(input, port.command()); setReload((n) => n + 1); return message(r); });
  return <>
    <h1>Conciliação de cartões</h1>
    <p className="conciliacao-hint">Importe as vendas e os recebíveis da maquininha, confira se cada venda casou com a venda do PDV ou do pedido, se a taxa cobrada é a contratada e o que ainda vai cair. Quando o dinheiro cair, receba na conta.</p>
    {canWrite && <ImportPanel port={port} target="card" overview={overview} onDone={(m) => refresh(m)} />}
    <Message error={runner.error} notice={runner.notice} />
    {page && <CardSummary page={page} />}
    <div className="conciliacao-toolbar">
      <label>Mostrar<select value={kind} onChange={(e) => setKind(e.target.value)}><option value="recebivel">Recebíveis</option><option value="venda">Vendas</option><option value="todos">Tudo</option></select></label>
      <label>Situação<select value={state} onChange={(e) => setState(e.target.value)}><option value="abertas">A receber</option><option value="pendentes">Sem venda confirmada</option>
        <option value="casadas">Venda confirmada</option><option value="recebidas">Recebidas</option><option value="ignoradas">Ignoradas</option><option value="todas">Todas</option></select></label>
      <label>Adquirente<select value={acquirer} onChange={(e) => setAcquirer(e.target.value)}><option value="">Todas</option>{overview.acquirers.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label className="conciliacao-check"><input type="checkbox" checked={divergent} onChange={(e) => setDivergent(e.target.checked)} /> Só taxa acima do contrato ou paga fora do prazo</label>
    </div>
    {canWrite && <div className="conciliacao-actions">
      <button type="button" disabled={runner.busy} onClick={() => void batch({ acao: "confirmar_sugestoes", confianca_minima: 90 }, (r) => `${r.confirmed ?? 0} venda(s) confirmada(s).`)}>Confirmar as sugestões de confiança alta</button>
      <button type="button" disabled={runner.busy} onClick={() => void batch({ acao: "procurar_de_novo" }, (r) => `${r.suggested ?? 0} linha(s) com venda sugerida.`)}>Procurar as vendas de novo</button>
    </div>}
    {!page ? <p role="status">Carregando…</p> : !lines.length ? <p className="conciliacao-hint">Nenhuma linha com estes filtros. Importe o extrato da adquirente acima.</p> :
      <table className="conciliacao-table conciliacao-lines">
        <thead><tr><th><span className="sr-only">Escolher</span></th><th>Venda / pagamento</th><th>Cartão</th><th className="num">Bruto</th><th className="num">Taxa cobrada</th><th className="num">Contratada</th><th className="num">Líquido</th><th>Venda no sistema</th><th><span className="sr-only">Ações</span></th></tr></thead>
        <tbody>{lines.map((l) => <CardRow key={l.id} port={port} line={l} canWrite={canWrite} checked={selected.has(l.id)}
          onCheck={() => setSelected((old) => { const next = new Set(old); if (next.has(l.id)) next.delete(l.id); else next.add(l.id); return next; })} onChange={refresh} />)}</tbody>
      </table>}
    {page?.truncated && <p className="conciliacao-warning">Há mais linhas do que cabem na tela. Filtre pela adquirente ou pela situação.</p>}
    {canWrite && page && <ReceiveBar port={port} page={page} lines={receivable} onDone={(m) => refresh(m)} />}
    <RatesPanel port={port} overview={overview} canWrite={canWrite} onChange={() => setReload((n) => n + 1)} />
  </>;
}

function CardSummary({ page }: { page: CardPage }) {
  const s = page.summary;
  const extra = BigInt(s.fee_cents) - BigInt(s.expected_fee_cents);
  return <section className="conciliacao-card conciliacao-summary" aria-label="Resumo">
    <div><span>Bruto das linhas</span><strong>{money(s.gross_cents)}</strong></div>
    <div><span>Taxa cobrada</span><strong>{money(s.fee_cents)}</strong></div>
    <div><span>Taxa contratada</span><strong>{money(s.expected_fee_cents)}</strong></div>
    <div className={extra > 0n ? "conciliacao-diff" : undefined}><span>Cobrado a mais</span><strong>{extra > 0n ? money(extra.toString()) : "nada"}</strong>{s.above_contract > 0 && <small>{s.above_contract} linha(s) acima do contrato</small>}</div>
    <div className={s.late.count ? "conciliacao-diff" : undefined}><span>Atrasado (já devia ter caído)</span><strong>{money(s.late.net_cents)}</strong><small>{s.late.count} recebível(is)</small></div>
    {s.coming.length > 0 && <details className="conciliacao-coming"><summary>O que ainda vai cair: {money(s.coming.reduce((t, c) => t + BigInt(c.net_cents), 0n).toString())}</summary>
      <table className="conciliacao-table"><thead><tr><th>Dia</th><th className="num">Recebíveis</th><th className="num">Líquido</th></tr></thead>
        <tbody>{s.coming.map((c) => <tr key={c.day}><td>{day(c.day)}</td><td className="num">{c.count}</td><td className="num">{money(c.net_cents)}</td></tr>)}</tbody></table></details>}
    {s.open_titles.length > 0 && <details className="conciliacao-coming"><summary>Contas de cartão em aberto no sistema: {money(s.open_titles.reduce((t, c) => t + BigInt(c.balance_cents), 0n).toString())}</summary>
      <table className="conciliacao-table"><thead><tr><th>Vencimento</th><th className="num">Contas</th><th className="num">Saldo</th></tr></thead>
        <tbody>{s.open_titles.map((c) => <tr key={c.day}><td>{day(c.day)}</td><td className="num">{c.count}</td><td className="num">{money(c.balance_cents)}</td></tr>)}</tbody></table></details>}
  </section>;
}

function CardRow({ port, line, canWrite, checked, onCheck, onChange }: { port: ConciliacaoPort; line: CardLine; canWrite: boolean; checked: boolean; onCheck: () => void; onChange: (m?: string) => void }) {
  const [choices, setChoices] = useState<Awaited<ReturnType<ConciliacaoPort["cardCandidates"]>>["candidates"] | null>(null);
  const { error, busy, run } = useRunner();
  const act = (input: Record<string, unknown>, message: string) => run(async () => { await port.cardAction(line.id, { versao: line.version, ...input }, port.command()); onChange(message); });
  const sale = line.title ? `${line.title.origin ?? line.title.description ?? "Conta a receber"} · ${line.title.contact_name ?? ""} · ${money(line.title.amount_cents)}${line.title.installments > 1 ? ` (${line.title.installment}/${line.title.installments})` : ""}`
    : line.group ? `${line.group.description ?? "Venda"} · ${line.group.contact_name ?? ""} · ${money(line.group.amount_cents)} em ${line.group.installments}x` : null;
  const receivable = (line.kind === "receivable" || line.installments === 1) && !!line.title && (line.state === "matched" || line.state === "pending");
  return <>
    <tr className={line.state}>
      <td>{canWrite && receivable && <input type="checkbox" aria-label="Escolher para receber" checked={checked} onChange={onCheck} />}</td>
      <td>{day(line.sold_on)}{line.expected_on && <small>{line.kind === "receivable" ? "paga" : "prevista"} {day(line.expected_on)}{line.fee.late && <strong> · fora do prazo ({day(line.fee.contracted_day)})</strong>}</small>}</td>
      <td>{line.acquirer_name} · {line.brand_label}<small>{line.product === "debit" ? "Débito" : "Crédito"} {line.kind === "receivable" ? `parcela ${line.installment}/${line.installments}` : `${line.installments}x`}{line.nsu ? ` · NSU ${line.nsu}` : ""}</small></td>
      <td className="num">{money(line.gross_cents)}</td>
      <td className={`num ${line.fee.above_contract ? "conciliacao-diff" : ""}`}>{money(line.fee_cents)}<small>{pct(line.fee.charged_rate_bp)}</small></td>
      <td className="num">{line.fee.expected_cents === null ? <small>sem taxa cadastrada</small> : <>{money(line.fee.expected_cents)}<small>{pct(line.fee.contracted_rate_bp)}</small></>}</td>
      <td className="num">{money(line.net_cents)}</td>
      <td>{sale ? <>{line.state === "pending" && <Confidence value={line.confidence} level={line.level} />} {sale}</> : <span className="conciliacao-muted">Venda não encontrada</span>}
        {line.state === "received" && <small>Recebida em {day(line.received?.received_on)}</small>}
        {line.state === "ignored" && <small>Ignorada: {line.ignored_reason}</small>}
        {error && <p className="conciliacao-error" role="alert">{error}</p>}</td>
      <td className="conciliacao-row-actions">{canWrite && <>
        {line.state === "pending" && sale && <button type="button" className="conciliacao-primary" disabled={busy} onClick={() => void act({ acao: "confirmar" }, "Venda confirmada.")}>Confirmar</button>}
        {(line.state === "pending" || line.state === "matched") && <button type="button" disabled={busy} onClick={() => void run(async () => setChoices((await port.cardCandidates(line.id)).candidates))}>Escolher a venda</button>}
        {line.state === "matched" && <button type="button" disabled={busy} onClick={() => void act({ acao: "desfazer_casamento" }, "Casamento desfeito.")}>Desfazer</button>}
        {line.state !== "received" && line.state !== "ignored" && <button type="button" disabled={busy} onClick={() => { const r = window.prompt("Por que esta linha fica de fora?"); if (r && r.trim().length >= 3) void act({ acao: "ignorar", motivo: r.trim() }, "Linha ignorada."); }}>Ignorar</button>}
        {line.state === "ignored" && <button type="button" disabled={busy} onClick={() => void act({ acao: "voltar" }, "A linha voltou para a fila.")}>Voltar</button>}
        {line.state === "received" && <button type="button" disabled={busy} onClick={() => { if (window.confirm("Desfazer o recebimento? A baixa da conta é estornada.")) void act({ acao: "desfazer_recebimento" }, "Recebimento desfeito."); }}>Desfazer recebimento</button>}
      </>}</td>
    </tr>
    {choices && <tr className="conciliacao-more"><td colSpan={9}>
      {!choices.length ? <p className="conciliacao-hint">Nenhuma venda no cartão parecida (mesmo dia, cinco dias para cada lado). Confira se a venda foi lançada com forma de pagamento de cartão.</p>
        : <ul>{choices.map((c, i) => { const t = c.title, g = c.group; return <li key={i}><Confidence value={c.confidence} level={c.level} /> {t ? `${t.origin ?? t.description} · ${t.contact_name ?? ""} · ${money(t.amount_cents)} · ${day(t.issued_on)}` : g ? `${g.description} · ${g.contact_name ?? ""} · ${money(g.amount_cents)} em ${g.installments}x · ${day(g.issued_on)}` : ""}
          <button type="button" disabled={busy} onClick={() => void act({ acao: "casar", ...(t ? { conta_receber: t.id } : { grupo: g!.id }) }, "Venda casada.")}>Casar</button></li>; })}</ul>}
      <button type="button" onClick={() => setChoices(null)}>Fechar</button>
    </td></tr>}
  </>;
}

function ReceiveBar({ port, page, lines, onDone }: { port: ConciliacaoPort; page: CardPage; lines: CardLine[]; onDone: (m: string) => void }) {
  const [account, setAccount] = useState(page.accounts[0]?.id ?? ""), [date, setDate] = useState(""), [bankLine, setBankLine] = useState("");
  const [bank, setBank] = useState<BankLine[]>([]);
  const { error, busy, run } = useRunner();
  const net = useMemo(() => lines.reduce((s, l) => s + BigInt(l.net_cents), 0n), [lines]);
  useEffect(() => {
    if (!account || !lines.length) { setBank([]); return; }
    const signal = new AbortController();
    port.bankLines(account, { situacao: "pendentes" }, signal.signal).then((p) => setBank(p.lines.filter((l) => BigInt(l.amount_cents) === net)), () => setBank([]));
    return () => signal.abort();
  }, [port, account, net, lines.length]);
  if (!lines.length) return <p className="conciliacao-hint">Marque os recebíveis que caíram na conta para receber de uma vez (a taxa da adquirente entra como tarifa da baixa).</p>;
  const receive = () => run(async () => {
    const line = bank.find((b) => b.id === bankLine);
    const r = await port.cardReceive({ linhas: lines.map((l) => l.id), conta: account, ...(date ? { data: date } : {}), ...(line ? { linha_banco: line.id, versao_linha_banco: line.version } : {}) }, port.command());
    onDone(`${r.received} venda(s) recebida(s): ${money(r.net_cents)} na conta${line ? ", já conciliado com o extrato" : ""}.`);
  });
  return <section className="conciliacao-card conciliacao-receive" aria-labelledby="receber">
    <h2 id="receber">Receber {lines.length} venda{lines.length > 1 ? "s" : ""}: {money(net.toString())} líquido</h2>
    <div className="conciliacao-toolbar">
      <label>Na conta<select value={account} onChange={(e) => setAccount(e.target.value)}>{page.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label>Data em que caiu<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <label>Linha do extrato (opcional)<select value={bankLine} onChange={(e) => setBankLine(e.target.value)}><option value="">Conciliar depois</option>
        {bank.map((b) => <option key={b.id} value={b.id}>{day(b.posted_on)} · {b.memo} · {money(b.amount_cents)}</option>)}</select></label>
      <button type="button" className="conciliacao-primary" disabled={busy || !account} onClick={() => void receive()}>Receber na conta</button>
    </div>
    <p className="conciliacao-hint">Sem data, vale a data de pagamento de cada linha. A conta a receber é baixada pelo valor bruto, com a taxa da adquirente; entra na conta o líquido.</p>
    {error && <p className="conciliacao-error" role="alert">{error}</p>}
  </section>;
}

function RatesPanel({ port, overview, canWrite, onChange }: { port: ConciliacaoPort; overview: Overview; canWrite: boolean; onChange: () => void }) {
  const [form, setForm] = useState({ adquirente: "cielo", bandeira: "visa", modalidade: "credito", parcelas_de: "1", parcelas_ate: "1", taxa: "", prazo: "30" });
  const { error, notice, busy, run } = useRunner();
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v, ...(k === "modalidade" && v === "debito" ? { parcelas_de: "1", parcelas_ate: "1", prazo: "1" } : {}) }));
  const save = () => run(async () => {
    await port.saveRate({ ...form, parcelas_de: Number(form.parcelas_de), parcelas_ate: Number(form.parcelas_ate), prazo: Number(form.prazo) }, port.command());
    setForm((f) => ({ ...f, taxa: "" })); onChange(); return "Taxa salva.";
  });
  const toggle = (r: Overview["rates"][number]) => run(async () => {
    await port.saveRate({ id: r.id, versao: r.version, adquirente: r.acquirer, bandeira: r.brand, modalidade: r.product === "debit" ? "debito" : "credito", parcelas_de: r.installments_from,
      parcelas_ate: r.installments_to, taxa: (r.rate_bp / 100).toFixed(2), tarifa_fixa: r.fixed_cents, prazo: r.settle_days, ativa: !r.active }, port.command());
    onChange();
  });
  return <section className="conciliacao-card" aria-labelledby="taxas">
    <h2 id="taxas">Taxas contratadas</h2>
    <p className="conciliacao-hint">Cadastre a taxa de cada bandeira e prazo como está no contrato da maquininha: a tela mostra quando a cobrada passa da contratada.</p>
    {overview.rates.length > 0 && <table className="conciliacao-table"><thead><tr><th>Adquirente</th><th>Bandeira</th><th>Modalidade</th><th>Parcelas</th><th className="num">Taxa</th><th className="num">Prazo</th><th><span className="sr-only">Ações</span></th></tr></thead>
      <tbody>{overview.rates.map((r) => <tr key={r.id} className={r.active ? undefined : "conciliacao-muted"}><td>{r.acquirer_name}</td><td>{r.brand_label}</td><td>{r.product === "debit" ? "Débito" : "Crédito"}</td>
        <td>{r.installments_from === r.installments_to ? r.installments_from : `${r.installments_from} a ${r.installments_to}`}</td><td className="num">{pct(r.rate_bp)}{r.fixed_cents !== "0" ? ` + ${money(r.fixed_cents)}` : ""}</td>
        <td className="num">{r.settle_days} dia{r.settle_days === 1 ? "" : "s"}</td><td>{canWrite && <button type="button" disabled={busy} onClick={() => void toggle(r)}>{r.active ? "Desligar" : "Ligar"}</button>}</td></tr>)}</tbody></table>}
    {canWrite && <div className="conciliacao-toolbar">
      <label>Adquirente<select value={form.adquirente} onChange={(e) => set("adquirente", e.target.value)}>{overview.acquirers.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label>Bandeira<select value={form.bandeira} onChange={(e) => set("bandeira", e.target.value)}>{overview.brands.map((b) => <option key={b.id} value={b.id}>{b.id === "outros" ? "Todas as outras" : b.label}</option>)}</select></label>
      <label>Modalidade<select value={form.modalidade} onChange={(e) => set("modalidade", e.target.value)}><option value="credito">Crédito</option><option value="debito">Débito</option></select></label>
      <label>Parcelas de<input type="number" min={1} max={99} value={form.parcelas_de} disabled={form.modalidade === "debito"} onChange={(e) => set("parcelas_de", e.target.value)} /></label>
      <label>até<input type="number" min={1} max={99} value={form.parcelas_ate} disabled={form.modalidade === "debito"} onChange={(e) => set("parcelas_ate", e.target.value)} /></label>
      <label>Taxa (%)<input inputMode="decimal" value={form.taxa} placeholder="1,99" onChange={(e) => set("taxa", e.target.value)} /></label>
      <label>Prazo (dias)<input type="number" min={0} max={400} value={form.prazo} onChange={(e) => set("prazo", e.target.value)} /></label>
      <button type="button" disabled={busy || !form.taxa.trim()} onClick={() => void save()}>Salvar taxa</button>
    </div>}
    <Message error={error} notice={notice} />
  </section>;
}
