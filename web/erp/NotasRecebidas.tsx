// Compras › Notas recebidas: as notas que os fornecedores emitiram para a
// empresa (buscadas no cofre por ação da pessoa ou importadas pelo XML), a
// conferência, a entrada (estoque, custo e contas a pagar), o estorno, o
// interruptor do administrador e a manifestação do destinatário. O servidor
// confere e lança (src/erp/recebidas/); a tela só manda as escolhas.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { erpPorts } from "./ports";
import { RecebidasError, type Choices, type Environment, type ItemChoice, type NotesPage, type ReceivedNote, type RecebidasPort, type Review } from "./recebidas";
import "./recebidas.css";

const ROUTE = "/notas-recebidas-compras";
const money = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? "—" : (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const day = (value: string | null | undefined) => (value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10).split("-").reverse().join("/") : "—");
const when = (value: string | null | undefined) => (value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—");
const errorText = (error: unknown) => (error instanceof Error ? error.message : "Algo deu errado. Atualize a tela e tente de novo.");
const aborted = (error: unknown) => error instanceof Error && error.name === "AbortError";

const STATUS: Record<string, string> = {
  done: "Lançado", part_disabled: "Não lançado: a parte está desligada", role_missing: "Não lançado: seu papel não permite",
  not_chosen: "Não lançado: você escolheu não lançar", nothing: "Nada a lançar",
};
const WARNINGS: Record<string, string> = {
  note_cancelled: "O fornecedor cancelou esta nota na SEFAZ. Não dê entrada; se já deu, estorne.",
  note_denied: "Esta nota foi denegada pela SEFAZ.",
  third_party: "A empresa aparece nesta nota só como transportador ou autorizada a ver: não é compra.",
  not_purchase: "Esta nota não é de compra (devolução, bonificação ou remessa). Por padrão ela não gera contas a pagar; escolha abaixo.",
  order_received_before: "O pedido de compra já teve recebimento no estoque. O estoque vem desmarcado para não contar duas vezes.",
  order_has_payables: "O pedido de compra já gerou contas a pagar. As contas vêm desmarcadas para não pagar duas vezes.",
  installments_differ_from_total: "As duplicatas da nota não somam o valor total. As contas a pagar seguem as duplicatas.",
  homologation: "Nota de homologação (ambiente de testes, sem valor fiscal).",
};
const PROBLEMS: Record<string, string> = {
  product_missing: "Escolha o produto do seu cadastro.",
  product_unavailable: "O produto escolhido está inativo ou não é um produto físico.",
  factor_missing: "A unidade da nota é diferente da do produto: informe quantas unidades vêm em cada embalagem.",
  quantity_decimals: "Com essa conversão a quantidade passa de 6 casas decimais. Confira a conversão.",
  lot_missing: "Este produto controla lote: informe o lote (e a validade, se tiver).",
  lot_split: "A nota traz mais de um lote para este item; só o primeiro entra. Confira com o fornecedor.",
};
const MATCHED: Record<string, string> = {
  supplier_code: "pelo código deste fornecedor", gtin: "pelo código de barras (GTIN)", code: "pelo código", choice: "escolhido por você",
};
const MANIFEST: { id: string; label: string }[] = [
  { id: "ciencia", label: "Ciência da operação" },
  { id: "confirmacao", label: "Confirmação da operação" },
  { id: "desconhecimento", label: "Desconhecimento da operação" },
  { id: "nao_realizada", label: "Operação não realizada" },
];

export default function NotasRecebidas({ port: injected }: { port?: RecebidasPort }) {
  const port = injected ?? erpPorts()?.recebidas;
  const location = useLocation();
  const note = new URLSearchParams(location.search).get("nota");
  if (!port) return <section className="real-state-panel"><h1>Notas recebidas</h1><p>As notas recebidas ainda não estão disponíveis nesta área.</p></section>;
  const access = port.access();
  if (!access.parts.purchases)
    return <section className="real-state-panel"><h1>Notas recebidas</h1><p>As notas recebidas são de Compras, que está desligado nesta área. Peça ao administrador para ligar Compras em Gestão → Módulos.</p></section>;
  return note ? <NoteDetail key={note} port={port} id={note} /> : <NoteList port={port} />;
}

function NoteList({ port }: { port: RecebidasPort }) {
  const access = port.access();
  const navigate = useNavigate();
  const [environment, setEnvironment] = useState<Environment>("homologacao");
  const [status, setStatus] = useState("todas");
  const [page, setPage] = useState<NotesPage | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [reload, setReload] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const signal = new AbortController();
    port.list({ ambiente: environment, situacao: status }, signal.signal).then(setPage, (e) => { if (!aborted(e)) setError(errorText(e)); });
    return () => signal.abort();
  }, [port, environment, status, reload]);
  const fetchState = page?.fetches.find((f) => f.environment === environment) ?? null;
  async function search() {
    setBusy("buscar"); setError(""); setNotice("");
    try {
      const result = await port.fetchVault({ ambiente: environment, ...(environment === "producao" ? { autorizacao_producao: authorized } : {}) });
      setNotice(`Busca feita: ${result.created} nota(s) nova(s), ${result.updated} atualizada(s), ${result.with_xml} com o XML completo.${result.xml_pending?.length ? ` ${result.xml_pending.length} ainda sem o XML.` : ""}`);
      setAuthorized(false);
      setReload((n) => n + 1);
    } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }
  async function importFile(input: HTMLInputElement) {
    const chosen = input.files?.[0];
    input.value = "";
    if (!chosen) return;
    if (chosen.size > 1_048_576) { setError("O arquivo passa de 1 MB. Confira se é o XML da nota."); return; }
    setBusy("importar"); setError(""); setNotice("");
    try {
      const note = await port.importXml(await chosen.text());
      navigate(`${ROUTE}?nota=${note.id}`);
    } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }
  return (
    <section className="notas-recebidas">
      <header>
        <h1>Notas recebidas</h1>
        <p>As notas que os fornecedores emitiram para a sua empresa. Confira cada uma e dê entrada: o estoque, o custo e as contas a pagar são lançados de uma vez.</p>
      </header>
      <div className="notas-recebidas-toolbar">
        <label>Ambiente
          <select value={environment} onChange={(e) => { setEnvironment(e.target.value as Environment); setAuthorized(false); }}>
            <option value="homologacao">Homologação (testes)</option>
            <option value="producao">Produção</option>
          </select>
        </label>
        <label>Mostrar
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="todas">Todas</option>
            <option value="pendentes">Para dar entrada</option>
            <option value="lancadas">Com entrada</option>
            <option value="estornadas">Estornadas</option>
          </select>
        </label>
        <button type="button" onClick={() => file.current?.click()} disabled={!!busy || access.demo}>Importar XML do fornecedor</button>
        <input ref={file} type="file" accept=".xml,application/xml,text/xml" hidden onChange={(e) => importFile(e.currentTarget)} />
        {access.parts.fiscal
          ? <button type="button" onClick={search} disabled={!!busy || access.demo || (environment === "producao" && (!access.admin || !authorized))}>{busy === "buscar" ? "Buscando…" : "Buscar no cofre"}</button>
          : <span className="notas-recebidas-hint">Para buscar as notas no cofre, ligue o Fiscal em Gestão → Módulos. Importar o XML funciona sem ele.</span>}
      </div>
      {environment === "producao" && access.parts.fiscal && (
        <p className="notas-recebidas-warning">
          {access.admin
            ? <label><input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} /> Autorizo buscar agora as notas de produção (vale só para esta busca).</label>
            : "Em produção, só o administrador busca as notas, e precisa autorizar a cada busca."}
        </p>
      )}
      {fetchState && <p className="notas-recebidas-hint">Última busca: {when(fetchState.read_at)}. Próxima liberada a partir de {when(fetchState.next_at)}.{fetchState.error ? ` Falhou: ${fetchState.error.message}` : ""}</p>}
      {!page?.company_document && page && <p className="notas-recebidas-warning">Preencha o CNPJ em Dados da empresa: a importação confere se a nota é para a sua empresa.</p>}
      {notice && <p className="notas-recebidas-notice" role="status">{notice}</p>}
      {error && <p className="real-alert" role="alert">{error}</p>}
      {!page && !error && <p role="status">Carregando…</p>}
      {page && (page.items.length === 0
        ? <p className="notas-recebidas-empty">Nenhuma nota por aqui. {access.parts.fiscal ? "Busque no cofre ou importe" : "Importe"} o XML que o fornecedor mandou.</p>
        : <table className="notas-recebidas-table">
            <thead><tr><th>Fornecedor</th><th>Número</th><th>Emissão</th><th>Valor</th><th>Manifestação</th><th>Entrada</th><th>Origem</th></tr></thead>
            <tbody>
              {page.items.map((n) => (
                <tr key={n.id}>
                  <td><Link to={`${ROUTE}?nota=${n.id}`}>{n.supplier?.name ?? n.emitter.name ?? "Fornecedor não identificado"}</Link><small>{n.purpose_label}</small></td>
                  <td>{n.number ?? "—"}{n.series ? `/${n.series}` : ""}</td>
                  <td>{day(n.issued_on)}</td>
                  <td>{money(n.total_cents)}</td>
                  <td>{n.vault?.pending ? "Sem resposta: consulte" : n.vault?.manifestation?.label ?? (n.vault ? "Sem manifestação" : "—")}</td>
                  <td>{n.situation !== "autorizada" ? (n.situation === "cancelada" ? "Nota cancelada" : "Nota denegada") : n.entry ? `Entrada em ${when(n.entry.created_at)}` : n.last_entry ? "Estornada" : n.xml ? "Para dar entrada" : "Só o resumo"}</td>
                  <td>{n.source === "cofre" ? "Cofre" : "XML importado"}</td>
                </tr>
              ))}
            </tbody>
          </table>)}
      {page && page.total > page.per_page && <p className="notas-recebidas-hint">Mostrando {page.items.length} de {page.total}.</p>}
      {access.admin && page && <ManifestSwitch port={port} settings={page.settings} onSaved={() => setReload((n) => n + 1)} />}
    </section>
  );
}

function ManifestSwitch({ port, settings, onSaved }: { port: RecebidasPort; settings: NotesPage["settings"]; onSaved: () => void }) {
  const [aware, setAware] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(on: boolean) {
    setBusy(true); setError("");
    try { await port.saveSettings({ expected_version: settings.version, manifestar: on, ciente_ato_fiscal: aware }); setAware(false); onSaved(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <details className="notas-recebidas-card">
      <summary>Configuração (administrador)</summary>
      <p><strong>Permitir manifestar notas recebidas:</strong> {settings.manifest_enabled ? "ligado" : "desligado"}.</p>
      <p className="notas-recebidas-warning">Manifestar (ciência, confirmação, desconhecimento ou operação não realizada) é ato fiscal perante a SEFAZ, em nome da empresa. Depois de registrado, só se corrige com outra manifestação, dentro dos prazos da SEFAZ.</p>
      {settings.manifest_enabled
        ? <button type="button" disabled={busy} onClick={() => save(false)}>Desligar a manifestação</button>
        : <>
            <label><input type="checkbox" checked={aware} onChange={(e) => setAware(e.target.checked)} /> Sei que manifestar é ato fiscal perante a SEFAZ.</label>
            <button type="button" disabled={busy || !aware} onClick={() => save(true)}>Permitir manifestar</button>
          </>}
      {error && <p className="real-alert" role="alert">{error}</p>}
    </details>
  );
}

function NoteDetail({ port, id }: { port: RecebidasPort; id: string }) {
  const access = port.access();
  const [data, setData] = useState<Review | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [items, setItems] = useState<Record<number, ItemChoice>>({});
  const [choices, setChoices] = useState<Choices>({});
  const [result, setResult] = useState<any>(null);
  const [reason, setReason] = useState("");
  const [settings, setSettings] = useState<{ manifest_enabled: boolean } | null>(null);
  const intents = useRef(new Map<string, { command: string; key: string }>());
  /** O mesmo pedido repetido (clique duplo, resposta perdida) usa o mesmo comando; mudou o pedido, comando novo. */
  const commandFor = (action: string, payload: unknown) => {
    const key = JSON.stringify(payload);
    const current = intents.current.get(action);
    if (current && current.key === key) return current.command;
    const command = port.command();
    intents.current.set(action, { command, key });
    return command;
  };
  const allChoices = useMemo<Choices>(() => ({ ...choices, items: Object.values(items) }), [choices, items]);
  useEffect(() => {
    const signal = new AbortController();
    port.review(id, signal.signal).then(setData, (e) => { if (!aborted(e)) setError(errorText(e)); });
    port.settings(signal.signal).then(setSettings, () => setSettings(null));
    return () => signal.abort();
  }, [port, id]);
  async function refresh(next: Choices = allChoices) {
    setBusy("previa"); setError("");
    try { setData(await port.preview(id, next)); } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }
  const setItem = (position: number, patch: Partial<ItemChoice>) => setItems((all) => ({ ...all, [position]: { ...all[position], position, ...patch } }));
  if (error && !data) return <section className="notas-recebidas"><p className="real-alert" role="alert">{error}</p><Link to={ROUTE}>Voltar às notas recebidas</Link></section>;
  if (!data) return <section className="notas-recebidas"><p role="status">Carregando a nota…</p></section>;
  const n = data.note, r = data.review;
  async function enter() {
    setBusy("entrada"); setError(""); setResult(null);
    try {
      const done = await port.enter(id, commandFor("entrada", allChoices), allChoices);
      setResult(done);
      setData(await port.review(id));
    } catch (e) { setError(errorText(e)); if (e instanceof RecebidasError && e.uncertain) setError(`${errorText(e)} Atualize a nota antes de repetir.`); } finally { setBusy(""); }
  }
  async function reverse() {
    setBusy("estorno"); setError("");
    try { await port.reverse(id, commandFor("estorno", reason), reason); setReason(""); setResult(null); setData(await port.review(id)); }
    catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }
  async function createSupplier() {
    setBusy("fornecedor"); setError("");
    try { await port.createSupplier(id, commandFor("fornecedor", id)); await refresh(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }
  return (
    <section className="notas-recebidas">
      <nav><Link to={ROUTE}>← Notas recebidas</Link>{n.xml && <a href={port.xmlUrl(n.id)}>Baixar o XML</a>}</nav>
      <header>
        <h1>NF-e {n.number ?? "—"}{n.series ? `/${n.series}` : ""} · {n.supplier?.name ?? n.emitter.name ?? "Fornecedor"}</h1>
        <p>Emitida em {day(n.issued_on)} · {money(n.total_cents)} · {n.purpose_label}{n.nature ? ` (${n.nature})` : ""}</p>
        <p className={`notas-recebidas-environment${n.environment === "producao" ? " production" : ""}`}>{n.environment === "producao" ? "Produção · nota com valor fiscal" : "Homologação · nota de testes, sem valor fiscal"}</p>
        <p className="notas-recebidas-key">Chave de acesso: {n.access_key}</p>
      </header>
      {error && <p className="real-alert" role="alert">{error}</p>}
      {n.entry && <EntryCard entry={n.entry} />}
      {result && !result.replayed && <p className="notas-recebidas-notice" role="status">Entrada feita. Estoque: {STATUS[result.entry.stock_status]}. Contas a pagar: {STATUS[result.entry.finance_status]}.</p>}
      {result?.already_entered && <p className="notas-recebidas-notice" role="status">Esta nota já tinha dado entrada; nada foi lançado de novo.</p>}
      {n.entry && (
        <div className="notas-recebidas-card">
          <h2>Estornar a entrada</h2>
          <p>Desfaz o estoque e cancela as contas a pagar desta nota. Conta já paga ou em cobrança no banco não é cancelada: resolva no Financeiro antes.</p>
          <label>Motivo<textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label>
          <button type="button" disabled={!!busy || reason.trim().length < 3 || access.demo} onClick={reverse}>{busy === "estorno" ? "Estornando…" : "Estornar a entrada"}</button>
        </div>
      )}
      {data.missing_xml && <p className="notas-recebidas-warning">O cofre só tem o resumo desta nota. Para conferir os itens, faça a ciência da operação (abaixo) e busque de novo, ou importe o XML que o fornecedor mandou.</p>}
      {r && !n.entry && (
        <>
          {r.warnings.map((w: string) => <p key={w} className="notas-recebidas-warning">{WARNINGS[w] ?? w}</p>)}
          <div className="notas-recebidas-card">
            <h2>Fornecedor</h2>
            {r.supplier
              ? <p>{r.supplier.name}{r.supplier.code ? ` (código ${r.supplier.code})` : ""}, achado pelo CNPJ {n.emitter.document}.</p>
              : <>
                  <p>O CNPJ {r.supplier_proposal.document} ainda não está no seu cadastro. Dados da nota: {r.supplier_proposal.name}{r.supplier_proposal.ie ? `, IE ${r.supplier_proposal.ie}` : ""}{r.supplier_proposal.address?.city ? `, ${r.supplier_proposal.address.city}/${r.supplier_proposal.address.uf ?? ""}` : ""}.</p>
                  <button type="button" disabled={!!busy || access.demo} onClick={createSupplier}>{busy === "fornecedor" ? "Cadastrando…" : "Cadastrar este fornecedor"}</button>
                </>}
          </div>
          <div className="notas-recebidas-card">
            <h2>Itens</h2>
            <table className="notas-recebidas-table">
              <thead><tr><th>Item da nota</th><th>Quantidade</th><th>Produto do seu cadastro</th><th>Conversão</th><th>Entra no estoque</th><th>Custo de entrada</th></tr></thead>
              <tbody>
                {r.lines.map((l: any) => (
                  <tr key={l.position}>
                    <td>{l.description}<small>Código do fornecedor: {l.code}{l.gtin ? ` · GTIN ${l.gtin}` : ""} · CFOP {l.cfop}</small></td>
                    <td>{Number(l.quantity).toLocaleString("pt-BR")} {l.unit}<small>{money(l.total_cents)}</small></td>
                    <td>
                      <select value={items[l.position]?.product_id ?? l.product?.id ?? ""} onChange={(e) => setItem(l.position, { product_id: e.target.value || null })}>
                        <option value="">Escolha o produto…</option>
                        {l.suggestions.length > 0 && <optgroup label="Sugestões pela descrição">{l.suggestions.map((s: any) => <option key={s.id} value={s.id}>{s.name}{s.code ? ` (${s.code})` : ""}</option>)}</optgroup>}
                        <optgroup label="Todos os produtos">{r.products.map((p: any) => <option key={p.id} value={p.id}>{p.name}{p.code ? ` (${p.code})` : ""}{p.unit ? ` · ${p.unit}` : ""}</option>)}</optgroup>
                      </select>
                      {l.product && l.matched_by && <small>Casado {MATCHED[l.matched_by] ?? ""}</small>}
                      {l.product?.lot_control && (
                        <span className="notas-recebidas-lot">
                          <input aria-label="Lote" placeholder="Lote" value={items[l.position]?.lot?.code ?? l.lot?.code ?? ""}
                            onChange={(e) => setItem(l.position, { lot: { ...(items[l.position]?.lot ?? l.lot ?? {}), code: e.target.value } })} />
                          <input aria-label="Validade" type="date" value={items[l.position]?.lot?.expires_on ?? l.lot?.expires_on ?? ""}
                            onChange={(e) => setItem(l.position, { lot: { code: items[l.position]?.lot?.code ?? l.lot?.code ?? "", ...(items[l.position]?.lot ?? l.lot ?? {}), expires_on: e.target.value || null } })} />
                        </span>
                      )}
                    </td>
                    <td>
                      {l.product && l.factor_from !== "same_unit"
                        ? <label className="notas-recebidas-inline">1 {l.unit} =
                            <input inputMode="decimal" value={items[l.position]?.factor ?? l.factor ?? ""} onChange={(e) => setItem(l.position, { factor: e.target.value.replace(",", ".") || null })} />
                            {l.product.unit}</label>
                        : l.product ? "Mesma unidade" : "—"}
                      {l.factor_from === "remembered" && <small>Lembrado da última nota</small>}
                    </td>
                    <td>{l.stock_quantity ? `${Number(l.stock_quantity).toLocaleString("pt-BR")} ${l.product?.unit ?? ""}` : "—"}</td>
                    <td>{l.cost ? `R$ ${Number(l.cost.unit_cost).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 10 })}` : "—"}
                      {l.cost && <small>Frete {money(l.cost.freight_cents)} · impostos {money(l.cost.taxes_cents)}</small>}</td>
                    {l.problems.length > 0 && <td className="notas-recebidas-problems">{l.problems.map((p: string) => <span key={p}>{PROBLEMS[p] ?? p}</span>)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="notas-recebidas-hint">O produto e a conversão que você confirmar ficam lembrados para a próxima nota deste fornecedor.</p>
          </div>
          {r.capability.orders && (
            <div className="notas-recebidas-card">
              <h2>Pedido de compra</h2>
              {r.orders.length === 0 ? <p>Nenhum pedido de compra em andamento deste fornecedor.</p> : (
                <label>Casar com o pedido
                  <select value={choices.order_id === undefined ? r.order_id ?? "" : choices.order_id ?? ""} onChange={(e) => setChoices((c) => ({ ...c, order_id: e.target.value || null }))}>
                    <option value="">Não casar com pedido</option>
                    {r.orders.map((o: any) => <option key={o.id} value={o.id}>Pedido {o.number ?? "sem número"} de {day(o.date)}{o.referenced ? " (citado na nota)" : ""}</option>)}
                  </select>
                </label>
              )}
              {r.order_difference && (
                <table className="notas-recebidas-table">
                  <thead><tr><th>Item</th><th>No pedido (a receber)</th><th>Na nota</th><th>Preço no pedido</th><th>Preço na nota</th><th></th></tr></thead>
                  <tbody>
                    {r.order_difference.lines.map((d: any) => (
                      <tr key={d.position}><td>{r.lines.find((l: any) => l.position === d.position)?.description}</td><td>{d.remaining_quantity ?? "—"}</td><td>{d.note_quantity ?? "—"}</td>
                        <td>{d.order_unit_price ?? "—"}</td><td>{d.note_unit_price ?? "—"}</td><td>{d.status === "same" ? "Confere" : d.status === "not_in_order" ? "Fora do pedido" : "Diferente"}</td></tr>
                    ))}
                    {r.order_difference.missing.map((m: any) => <tr key={m.order_item_id}><td>{m.description}</td><td>{m.quantity}</td><td>—</td><td>{m.unit_price}</td><td>—</td><td>Faltou na nota</td></tr>)}
                  </tbody>
                </table>
              )}
              {r.order_id && <p className="notas-recebidas-hint">Depois de dar entrada pela nota, não receba este pedido de novo no estoque.</p>}
            </div>
          )}
          <div className="notas-recebidas-card">
            <h2>Entrada</h2>
            <label><input type="checkbox" checked={choices.stock ?? r.stock} onChange={(e) => setChoices((c) => ({ ...c, stock: e.target.checked }))} /> Lançar no estoque</label>
            {!r.capability.stock.part && <p className="notas-recebidas-hint">O Estoque está desligado: a nota não mexe no estoque.</p>}
            {r.capability.stock.part && !r.capability.stock.role && <p className="notas-recebidas-hint">Seu papel não lança estoque (administrador ou estoque lançam).</p>}
            {r.capability.stock.part && (
              <label>Depósito
                <select value={choices.warehouse_id ?? r.warehouse_id ?? ""} onChange={(e) => setChoices((c) => ({ ...c, warehouse_id: e.target.value || null }))}>
                  <option value="">Escolha o depósito…</option>
                  {r.warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </label>
            )}
            <label><input type="checkbox" checked={choices.icms_in_cost ?? r.icms_in_cost} onChange={(e) => setChoices((c) => ({ ...c, icms_in_cost: e.target.checked }))} /> Somar o ICMS da nota ao custo (empresa que não aproveita o crédito, como no Simples Nacional)</label>
            <label><input type="checkbox" checked={choices.finance ?? r.finance_selected} onChange={(e) => setChoices((c) => ({ ...c, finance: e.target.checked }))} /> Gerar contas a pagar</label>
            {!r.capability.finance.part && <p className="notas-recebidas-hint">O Financeiro está desligado: a nota não gera contas a pagar.</p>}
            {r.capability.finance.part && !r.capability.finance.role && <p className="notas-recebidas-hint">Seu papel não gera contas a pagar (administrador ou financeiro geram).</p>}
            {r.capability.finance.part && (
              <>
                <ul>{r.finance.installments.map((d: any, i: number) => <li key={i}>{d.number ? `Duplicata ${d.number}: ` : ""}{money(d.amount_cents)} vence em {day(d.due_on)}</li>)}</ul>
                <label>Categoria
                  <select value={choices.category_id ?? r.finance.category_id ?? ""} onChange={(e) => setChoices((c) => ({ ...c, category_id: e.target.value || null }))}>
                    <option value="">Sem categoria</option>
                    {r.finance.categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                <label>Forma de pagamento
                  <select value={choices.payment_method_id ?? r.finance.payment_method_id ?? ""} onChange={(e) => setChoices((c) => ({ ...c, payment_method_id: e.target.value || null }))}>
                    <option value="">Não informar</option>
                    {r.finance.payment_methods.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
              </>
            )}
            {r.blockers.filter((b: string) => b !== "already_entered").length > 0 && (
              <div className="notas-recebidas-blockers" role="alert">
                <strong>Antes de dar entrada:</strong>
                <ul>{r.blockers.map((b: string) => <li key={b}>{BLOCKER_TEXT[b] ?? b}</li>)}</ul>
              </div>
            )}
            <div className="notas-recebidas-actions">
              <button type="button" disabled={!!busy} onClick={() => refresh()}>{busy === "previa" ? "Conferindo…" : "Conferir de novo com as escolhas"}</button>
              <button type="button" disabled={!!busy || access.demo} onClick={enter}>{busy === "entrada" ? "Dando entrada…" : "Dar entrada"}</button>
            </div>
            <p className="notas-recebidas-hint">Dar entrada confere tudo de novo no servidor com as escolhas acima. Dar entrada duas vezes na mesma nota não duplica nada.</p>
          </div>
        </>
      )}
      {n.vault && access.parts.fiscal && <ManifestPanel port={port} note={n} enabled={!!settings?.manifest_enabled} onDone={async () => setData(await port.review(id))} />}
    </section>
  );
}

const BLOCKER_TEXT: Record<string, string> = {
  note_not_authorized: "A nota não está autorizada (cancelada ou denegada).",
  third_party: "A empresa aparece só como terceiro nesta nota.",
  supplier_missing: "Cadastre o fornecedor (botão acima).",
  warehouse_missing: "Escolha o depósito.",
  items_pending: "Resolva os itens marcados: produto, conversão de unidade ou lote. Depois clique em Conferir de novo.",
  installments_missing: "A nota não tem valor para gerar contas a pagar.",
  nothing_chosen: "Marque lançar no estoque, gerar contas a pagar, ou os dois.",
};

function EntryCard({ entry }: { entry: NonNullable<ReceivedNote["entry"]> }) {
  return (
    <div className="notas-recebidas-card">
      <h2>Entrada feita em {when(entry.created_at)}</h2>
      <p>Estoque: {STATUS[entry.stock_status] ?? entry.stock_status}{entry.movement_ids.length ? ` (${entry.movement_ids.length} lançamento(s))` : ""}.</p>
      <p>Contas a pagar: {STATUS[entry.finance_status] ?? entry.finance_status}{entry.title_ids.length ? ` (${entry.title_ids.length} parcela(s))` : ""}.</p>
      <p><Link to="/estoque-empresa">Ver no estoque</Link> · <Link to="/financeiro-empresa?area=payable">Ver as contas a pagar</Link></p>
    </div>
  );
}

function ManifestPanel({ port, note, enabled, onDone }: { port: RecebidasPort; note: ReceivedNote; enabled: boolean; onDone: () => void }) {
  const access = port.access();
  const [type, setType] = useState(note.vault?.pending?.type ?? "ciencia");
  const [justification, setJustification] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [aware, setAware] = useState(false);
  const [uncertain, setUncertain] = useState(!!note.vault?.pending);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const command = useRef<{ key: string; id: string } | null>(null);
  if (!enabled)
    return <div className="notas-recebidas-card"><h2>Manifestação do destinatário</h2><p>A manifestação está desligada. {access.admin ? "Ligue em Notas recebidas → Configuração." : "O administrador liga em Notas recebidas → Configuração."}</p>
      {note.vault?.manifestation && <p>Situação no cofre: {note.vault.manifestation.label} em {when(note.vault.manifestation.at)}.</p>}</div>;
  const production = note.environment === "producao";
  async function send(resend: boolean) {
    setBusy(true); setError(""); setNotice("");
    const payload = { tipo: type, justificativa: type === "nao_realizada" ? justification : undefined, autorizacao_producao: production ? authorized : undefined, reenviar: resend || undefined };
    const key = JSON.stringify(payload);
    if (!command.current || command.current.key !== key) command.current = { key, id: port.command() };
    try {
      const result = await port.manifest(note.id, { command_id: command.current.id, ...payload });
      setNotice(result.consulted ? "Consultamos o cofre: a manifestação já estava registrada." : result.repeated ? "Esta manifestação já estava registrada; nada novo foi à SEFAZ." : "Manifestação registrada na SEFAZ.");
      setUncertain(false); setAware(false); setAuthorized(false); command.current = null;
      onDone();
    } catch (e) {
      setError(errorText(e));
      if (e instanceof RecebidasError && e.uncertain) setUncertain(true);
    } finally { setBusy(false); }
  }
  return (
    <div className="notas-recebidas-card">
      <h2>Manifestação do destinatário</h2>
      {note.vault?.manifestation && <p>Situação no cofre: {note.vault.manifestation.label} em {when(note.vault.manifestation.at)}.</p>}
      <p className="notas-recebidas-warning">Manifestar é ato fiscal perante a SEFAZ, em nome da empresa{production ? ", e esta nota é de produção" : ""}.</p>
      <label>Manifestação
        <select value={type} onChange={(e) => setType(e.target.value)} disabled={uncertain}>{MANIFEST.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
      </label>
      {type === "nao_realizada" && <label>Justificativa (15 a 255 caracteres)<textarea value={justification} maxLength={255} onChange={(e) => setJustification(e.target.value)} /></label>}
      {production && (access.admin
        ? <label><input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} /> Autorizo esta manifestação em produção agora.</label>
        : <p className="notas-recebidas-hint">Em produção, só o administrador manifesta, e autoriza a cada vez.</p>)}
      <label><input type="checkbox" checked={aware} onChange={(e) => setAware(e.target.checked)} /> Confirmo a manifestação desta nota.</label>
      {uncertain
        ? <>
            <p className="notas-recebidas-warning">A última manifestação ficou sem resposta conclusiva. Primeiro consultamos o cofre; só envie de novo se ela não aparecer registrada.</p>
            <button type="button" disabled={busy || !aware} onClick={() => send(false)}>Consultar no cofre</button>
            <button type="button" disabled={busy || !aware || (production && !authorized)} onClick={() => send(true)}>Consultar e, se não estiver registrada, enviar de novo</button>
          </>
        : <button type="button" disabled={busy || !aware || access.demo || (production && !authorized) || (type === "nao_realizada" && justification.trim().length < 15)} onClick={() => send(false)}>{busy ? "Enviando…" : "Manifestar"}</button>}
      {notice && <p className="notas-recebidas-notice" role="status">{notice}</p>}
      {error && <p className="real-alert" role="alert">{error}</p>}
    </div>
  );
}
