// Fiscal › SPED e SINTEGRA: a conferência do que falta (com o atalho para
// corrigir), a geração do SPED Fiscal, da EFD-Contribuições e do SINTEGRA do
// mês (montada aos poucos no servidor), o download, o envio ao contador pelo
// pacote do contador e a configuração dos arquivos. O servidor confere e faz
// tudo (src/erp/sped/); a tela só manda as escolhas e mostra o andamento.
// Nada é transmitido ao governo: o arquivo é para o contador ou o validador oficial (PVA).
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  checkFile, COUNT_LABELS, downloadUrl, generateFile, KINDS, listFiles, loadSettings, money, monthPeriod, PHASES, previousMonth, saveSettings, sendFile, size,
  SPED_UNAVAILABLE, spedBase, SUMMARY_LABELS, when,
  type Channel, type Check, type Environment, type FileView, type Kind, type PendingView, type Problem, type Settings, type SettingsPage,
} from "./sped-api";
import "./app/components/real-finance.css";
import "./app/components/report-chart.css";

const ROUTE = "/sped-fiscal";
const TABS = [{ id: "gerar", label: "Gerar arquivo" }, { id: "configuracao", label: "Configuração" }] as const;
type Tab = typeof TABS[number]["id"];
const aborted = (error: unknown) => error instanceof Error && error.name === "AbortError";
const errorText = (error: unknown) => (error instanceof Error ? error.message : "Algo deu errado. Atualize a tela e tente de novo.");
const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
const STATE_LABEL: Record<FileView["state"], string> = { running: "Gerando", done: "Pronto", blocked: "Com pendências", failed: "Não saiu" };

function ProblemList({ problems }: { problems: Problem[] }) {
  if (!problems.length) return null;
  const blocking = problems.filter((p) => p.blocking), other = problems.filter((p) => !p.blocking);
  const item = (p: Problem, i: number) => <li key={i}>{p.message}{p.link && <> <Link to={p.link}>Corrigir</Link></>}</li>;
  return <>
    {blocking.length > 0 && <div className="real-alert" role="alert"><strong>Falta corrigir antes de gerar ({blocking.length}):</strong><ul>{blocking.map(item)}</ul></div>}
    {other.length > 0 && <div className="real-help" role="note"><strong>Atenção ({other.length}):</strong><ul>{other.map(item)}</ul></div>}
  </>;
}

function Summary({ file }: { file: FileView }) {
  if (!file.summary) return null;
  const entries = Object.entries(file.summary).filter(([k, v]) => typeof v === "number" && (v !== 0 || ["icms_a_recolher", "pis_a_recolher", "cofins_a_recolher"].includes(k)));
  return <small>{entries.map(([k, v]) => `${SUMMARY_LABELS[k] ?? COUNT_LABELS[k] ?? k}: ${SUMMARY_LABELS[k] ? money(Number(v)) : v}`).join(" · ")}</small>;
}

function counts(f: FileView) {
  const c = f.counts, parts = [`${c.issued} NF-e emitida(s)`, `${c.received} recebida(s)`];
  if (c.nfce) parts.push(`${c.nfce} NFC-e`);
  if (c.nfse) parts.push(`${c.nfse} NFS-e`);
  if (c.cancelled) parts.push(`${c.cancelled} cancelada(s)`);
  if (c.voided) parts.push(`${c.voided} número(s) inutilizado(s)`);
  if (c.inventory_items) parts.push(`${c.inventory_items} item(ns) no inventário`);
  if (c.without_xml) parts.push(`${c.without_xml} sem XML (de fora)`);
  return parts.join(", ");
}

function GenerateTab({ writable }: { writable: boolean }) {
  const [kind, setKind] = useState<Kind>("efd_icms_ipi");
  const [month, setMonth] = useState(previousMonth()), [partial, setPartial] = useState<{ from: string; to: string } | null>(null);
  const [environment, setEnvironment] = useState<Environment>("producao");
  // Padrão do dia do inventário: 31 de dezembro do ano anterior ao do mês escolhido.
  const [withInventory, setWithInventory] = useState(false), [inventory, setInventory] = useState(() => `${Number(previousMonth().slice(0, 4)) - 1}-12-31`);
  const [credit, setCredit] = useState("");
  const [check, setCheck] = useState<Check | null>(null), [checking, setChecking] = useState(false);
  const [files, setFiles] = useState<FileView[]>([]), [pending, setPending] = useState<PendingView[]>([]);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(""), [tick, setTick] = useState(0);
  const [sendFor, setSendFor] = useState<FileView | null>(null), [open, setOpen] = useState<string | null>(null);
  const whole = monthPeriod(month)!;
  const period = kind === "sintegra" && partial ? partial : whole;
  const query = { tipo: kind, de: period.from, ate: period.to, ambiente: environment, ...(withInventory && kind !== "efd_contribuicoes" ? { inventario: inventory } : {}) };
  useEffect(() => {
    const request = new AbortController();
    void listFiles(request.signal).then((v) => { if (!request.signal.aborted) { setFiles(v.arquivos); setPending(v.envios); } })
      .catch((e) => { if (!aborted(e)) setError(errorText(e)); });
    return () => request.abort();
  }, [tick]);
  const running = files.some((f) => f.state === "running");
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { if (visible()) setTick((n) => n + 1); }, 3000);
    return () => clearInterval(timer);
  }, [running]);
  // A conferência refaz quando muda a escolha.
  useEffect(() => {
    const request = new AbortController(); setChecking(true); setCheck(null);
    void checkFile(query, request.signal).then((c) => { if (!request.signal.aborted) setCheck(c); })
      .catch((e) => { if (!aborted(e)) setError(errorText(e)); }).finally(() => { if (!request.signal.aborted) setChecking(false); });
    return () => request.abort();
  }, [kind, period.from, period.to, environment, withInventory, inventory]);
  const generate = async (redo = false, target?: FileView) => {
    setBusy(target ? `refazer:${target.id}` : "gerar"); setError(""); setNotice("");
    try {
      const input = target
        ? { tipo: target.kind, de: target.from, ate: target.to, ambiente: target.environment, ...(target.inventory_on ? { inventario: target.inventory_on } : {}) }
        : { ...query, ...(kind === "efd_icms_ipi" && credit ? { saldo_credor_anterior: Number(credit.replace(/\./g, "").replace(",", ".")) } : {}) };
      const r = await generateFile({ ...input, ...(redo ? { refazer: true } : {}) });
      setNotice(r.reaproveitado ? `O ${r.arquivo.kind_label} de ${r.arquivo.label} já existe (${STATE_LABEL[r.arquivo.state].toLowerCase()}). Para incluir notas novas, use Gerar de novo.`
        : r.arquivo.state === "blocked" ? `O ${r.arquivo.kind_label} de ${r.arquivo.label} não saiu: veja na lista o que corrigir.`
          : `${r.arquivo.kind_label} de ${r.arquivo.label} sendo gerado. Continua sozinho, mesmo com a tela fechada.`);
      setOpen(r.arquivo.id);
      setTick((n) => n + 1);
    } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  };
  const help = KINDS.find((k) => k.id === kind)!.help;
  return <>
    <p className="real-help">O arquivo sai das notas emitidas pelo emissor (NF-e, NFC-e e, na EFD-Contribuições, NFS-e), das notas recebidas com entrada no ERP, dos cadastros e, se você pedir, do estoque. Nada é enviado ao governo: o arquivo é para o contador ou para o validador oficial (PVA).</p>
    <div className="report-filters">
      <label className="form-field">Arquivo<select value={kind} onChange={(e) => { setKind(e.target.value as Kind); setPartial(null); }}>
        {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}</select></label>
      <label className="form-field">Mês<input type="month" min="2020-01" max="2099-12" value={month} onChange={(e) => { if (monthPeriod(e.target.value)) { setMonth(e.target.value); setPartial(null); } }} /></label>
      {kind === "sintegra" && <>
        <label className="form-field">De<input type="date" min={whole.from} max={whole.to} value={period.from} onChange={(e) => e.target.value && setPartial({ from: e.target.value, to: period.to })} /></label>
        <label className="form-field">Até<input type="date" min={whole.from} max={whole.to} value={period.to} onChange={(e) => e.target.value && setPartial({ from: period.from, to: e.target.value })} /></label></>}
      <label className="form-field">Ambiente<select value={environment} onChange={(e) => setEnvironment(e.target.value as Environment)}>
        <option value="producao">Produção (notas com valor fiscal)</option><option value="homologacao">Homologação (testes)</option></select></label>
    </div>
    <p className="real-help">{help}</p>
    {kind !== "efd_contribuicoes" && <div className="report-filters">
      <label className="preference-check"><input type="checkbox" checked={withInventory} onChange={(e) => setWithInventory(e.target.checked)} /><span>Incluir o inventário do estoque</span></label>
      {withInventory && <label className="form-field">Dia do inventário<input type="date" max={period.to} value={inventory} onChange={(e) => setInventory(e.target.value)} />
        <small className="real-help">Normalmente 31 de dezembro, no arquivo de fevereiro. O valor usa o custo médio do Estoque.</small></label>}
      {kind === "efd_icms_ipi" && <label className="form-field">Saldo credor de ICMS do mês anterior (R$)<input inputMode="decimal" value={credit} placeholder="0,00" onChange={(e) => setCredit(e.target.value)} />
        <small className="real-help">O contador informa; sem ele, conta zero.</small></label>}
    </div>}
    <section aria-label="Conferência antes de gerar">
      <h2>Conferência</h2>
      {checking && <p role="status">Conferindo os cadastros…</p>}
      {check && <>
        {check.aviso_regime && <p className="real-alert report-warning" role="note">{check.aviso_regime}</p>}
        {!check.pendencias.length && <p className="real-help" role="status">Nada falta nos cadastros para este arquivo. As notas são conferidas de novo na geração.</p>}
        <ProblemList problems={check.pendencias} />
      </>}
      {writable && <button type="button" className="primary-button" disabled={!!busy || checking || !check?.pode_gerar} onClick={() => void generate()}>
        {busy === "gerar" ? "Pedindo…" : "Gerar arquivo"}</button>}
      {writable && check && !check.pode_gerar && <p className="real-help">Corrija o que está na lista para gerar.</p>}
    </section>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {notice && <p className="real-help" role="status">{notice}</p>}
    <h2>Arquivos</h2>
    {!files.length ? <p className="real-help">Nenhum arquivo ainda.{writable ? " Escolha o arquivo e o mês e clique em Gerar arquivo." : ""}</p>
      : <div className="table-scroll" tabIndex={0} role="region" aria-label="Arquivos de SPED e SINTEGRA"><table className="data-table">
        <thead><tr><th>Arquivo</th><th>Período</th><th>Situação</th><th>O que entrou</th><th>Ações</th></tr></thead>
        <tbody>{files.map((f) => {
          const waiting = pending.find((p) => p.arquivo === f.id && p.situacao === "esperando");
          const sent = pending.find((p) => p.arquivo === f.id && p.situacao === "enviado");
          return <tr key={f.id}>
            <td>{f.kind_label}{f.environment === "homologacao" ? " (homologação)" : ""}{f.inventory_on ? <><br /><small>com inventário de {f.inventory_on.split("-").reverse().join("/")}</small></> : null}</td>
            <td>{f.label}</td>
            <td>{f.state === "running" ? <span role="status">Gerando: {PHASES[f.phase] ?? f.phase}…</span>
              : f.state === "done" ? <>Pronto ({f.lines} linhas, {size(f.bytes)}){f.finished_at ? `, ${when(f.finished_at)}` : ""}</>
                : <span className="real-alert">{STATE_LABEL[f.state]}: {f.error}</span>}
              {waiting && <><br /><small>Envio ao contador esperando o pacote ficar pronto.</small></>}
              {sent && <><br /><small>Enviado ao contador.</small></>}</td>
            <td><small>{counts(f)}</small>{f.state === "done" && <><br /><Summary file={f} /></>}</td>
            <td><div className="report-actions">
              {f.state === "done" && <a className="secondary-button" href={downloadUrl(f.id)} download>Baixar</a>}
              {f.state === "done" && writable && <button type="button" className="secondary-button" onClick={() => setSendFor(f)}>Enviar ao contador</button>}
              {(f.problems.length > 0 || f.warnings.length > 0) && <button type="button" className="text-button" aria-expanded={open === f.id} onClick={() => setOpen(open === f.id ? null : f.id)}>
                {open === f.id ? "Esconder detalhes" : "Ver pendências e avisos"}</button>}
              {writable && f.state !== "running" && <button type="button" className="text-button" disabled={!!busy} onClick={() => void generate(true, f)}>{busy === `refazer:${f.id}` ? "Pedindo…" : "Gerar de novo"}</button>}
            </div></td>
          </tr>;
        })}</tbody></table></div>}
    {open && (() => {
      const f = files.find((x) => x.id === open);
      if (!f || (!f.problems.length && !f.warnings.length)) return null;
      return <section aria-label={`Detalhes do ${f.kind_label} de ${f.label}`}><h3>{f.kind_label} de {f.label}</h3>
        <ProblemList problems={f.problems} />
        {f.warnings.length > 0 && <ul className="real-help">{f.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}</section>;
    })()}
    {sendFor && <SendDialog file={sendFor} onClose={(done) => { setSendFor(null); if (done) { setNotice(done); setTick((n) => n + 1); } }} />}
  </>;
}

function SendDialog({ file, onClose }: { file: FileView; onClose: (done?: string) => void }) {
  const [channel, setChannel] = useState<Channel | "">(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const go = async () => {
    setBusy(true); setError("");
    try {
      const r = await sendFile({ arquivo: file.id, ...(channel ? { canal: channel } : {}) });
      onClose(r.aguardando ? r.mensagem ?? "O envio sai assim que o pacote do contador ficar pronto." : `Link do pacote de ${r.envio?.periodo} (com o ${file.kind_label}) enviado para ${r.envio?.destino}. Vale por 7 dias.`);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return <section className="real-notice" aria-label="Enviar ao contador">
    <header className="real-heading"><div><h2>Enviar ao contador</h2>
      <p>O {file.kind_label} de {file.label} vai dentro do pacote do contador do mesmo período (pasta obrigacoes), pelo link seguro de 7 dias, para o contador cadastrado em <Link to="/contador-fiscal?aba=contador">Para o contador</Link>.</p></div></header>
    <label className="form-field">Enviar por<select value={channel} onChange={(e) => setChannel(e.target.value as Channel | "")}>
      <option value="">O canal do cadastro do contador</option><option value="whatsapp">WhatsApp da área</option><option value="email">E-mail</option></select></label>
    {error && <p className="real-alert" role="alert">{error}</p>}
    <div className="report-actions">
      <button type="button" className="primary-button" disabled={busy} onClick={() => void go()}>{busy ? "Enviando…" : "Enviar"}</button>
      <button type="button" className="secondary-button" disabled={busy} onClick={() => onClose()}>Cancelar</button></div>
  </section>;
}

function SettingsTab() {
  const [page, setPage] = useState<SettingsPage | null>(null), [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  useEffect(() => {
    const request = new AbortController();
    void loadSettings(request.signal).then((p) => {
      if (request.signal.aborted) return;
      setPage(p);
      // Contador ainda sem nome, e-mail ou telefone aqui: começa com os do cadastro de Para o contador.
      const c = p.configuracao.contador, k = p.contador_cadastro;
      setForm({ ...p.configuracao, contador: { ...c, nome: c.nome ?? k?.nome ?? null, email: c.email ?? k?.email ?? null, telefone: c.telefone ?? k?.telefone ?? null } });
    }).catch((e) => { if (!aborted(e)) setError(errorText(e)); });
    return () => request.abort();
  }, []);
  if (!form || !page) return error ? <p className="real-alert" role="alert">{error}</p> : <p role="status">Carregando a configuração…</p>;
  const set = (patch: Partial<Settings>) => setForm({ ...form, ...patch });
  const setC = (patch: Partial<Settings["contador"]>) => setForm({ ...form, contador: { ...form.contador, ...patch } });
  const field = (label: string, input: ReactNode, help?: string) => <label className="form-field">{label}{input}{help && <small className="real-help">{help}</small>}</label>;
  const text = (value: string | null, onChange: (v: string) => void, max: number, extra: Record<string, unknown> = {}) =>
    <input value={value ?? ""} maxLength={max} onChange={(e) => onChange(e.target.value)} {...extra} />;
  const save = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const empty = (v: string | null) => (v && v.trim() ? v.trim() : null);
      const c = form.contador;
      const r = await saveSettings({ perfil: form.perfil, atividade: form.atividade, codigo_receita_icms: empty(form.codigo_receita_icms), dia_vencimento_icms: Number(form.dia_vencimento_icms),
        no_pacote: form.no_pacote, pis_cofins: form.pis_cofins, sintegra: { ...form.sintegra, contato: empty(form.sintegra.contato) },
        contador: Object.fromEntries(Object.entries(c).map(([k, v]) => [k, empty(v)])) as Settings["contador"] });
      setForm({ ...form, ...r.configuracao }); setNotice("Configuração salva.");
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const p = form.pis_cofins;
  return <form onSubmit={(e) => { e.preventDefault(); if (page.pode_editar) void save(); }}>
    <p className="real-help">Pergunte ao contador o que escolher. Os dados da empresa (razão social, CNPJ, IE e endereço) vêm de <Link to="/empresa-configuracoes">Empresa</Link>.</p>
    <fieldset disabled={!page.pode_editar || busy}><legend>SPED Fiscal</legend>
      {field("Perfil", <select value={form.perfil} onChange={(e) => set({ perfil: e.target.value as Settings["perfil"] })}>
        <option value="A">Perfil A</option><option value="B">Perfil B</option><option value="C">Perfil C</option></select>, "O fisco do seu estado define o perfil; o mais comum é o A.")}
      {field("Atividade", <select value={form.atividade} onChange={(e) => set({ atividade: e.target.value as Settings["atividade"] })}>
        <option value="1">Outras (comércio, serviços)</option><option value="0">Industrial ou equiparado (apura IPI)</option></select>)}
      {field("Código de receita do ICMS", text(form.codigo_receita_icms, (v) => set({ codigo_receita_icms: v }), 20), "Vai no registro de obrigações a recolher (E116) quando há ICMS a pagar. O contador sabe o código da sua UF.")}
      {field("Dia do vencimento do ICMS", <input type="number" min={1} max={31} value={form.dia_vencimento_icms} onChange={(e) => set({ dia_vencimento_icms: Number(e.target.value) })} />, "No mês seguinte ao do arquivo.")}
    </fieldset>
    <fieldset disabled={!page.pode_editar || busy}><legend>Contador (registro 0100)</legend>
      {field("Nome", text(form.contador.nome, (v) => setC({ nome: v }), 100))}
      {field("CPF", text(form.contador.cpf, (v) => setC({ cpf: v }), 14, { inputMode: "numeric" }))}
      {field("CRC", text(form.contador.crc, (v) => setC({ crc: v }), 15), "Com a UF, como no registro (ex.: SP123456O1).")}
      {field("CNPJ do escritório", text(form.contador.cnpj, (v) => setC({ cnpj: v }), 18, { inputMode: "numeric" }), "Se o contador trabalha por escritório.")}
      {field("E-mail", text(form.contador.email, (v) => setC({ email: v }), 120, { type: "email" }))}
      {field("Telefone", text(form.contador.telefone, (v) => setC({ telefone: v }), 20, { type: "tel" }))}
      {field("CEP", text(form.contador.cep, (v) => setC({ cep: v }), 9, { inputMode: "numeric" }))}
      {field("Endereço", text(form.contador.endereco, (v) => setC({ endereco: v }), 60))}
      {field("Número", text(form.contador.numero, (v) => setC({ numero: v }), 10))}
      {field("Complemento", text(form.contador.complemento, (v) => setC({ complemento: v }), 60))}
      {field("Bairro", text(form.contador.bairro, (v) => setC({ bairro: v }), 60))}
      {field("Código do município (IBGE)", text(form.contador.municipio, (v) => setC({ municipio: v }), 7, { inputMode: "numeric" }))}
    </fieldset>
    <fieldset disabled={!page.pode_editar || busy}><legend>EFD-Contribuições (PIS/COFINS)</legend>
      {field("Regime", <select value={p.incidencia} onChange={(e) => set({ pis_cofins: { ...p, incidencia: e.target.value as typeof p.incidencia } })}>
        <option value="1">Não cumulativo (lucro real)</option><option value="2">Cumulativo (lucro presumido)</option><option value="3">Os dois</option></select>)}
      {p.incidencia === "2" ? field("Escrituração no cumulativo", <select value={p.regime_cumulativo} onChange={(e) => set({ pis_cofins: { ...p, regime_cumulativo: e.target.value as typeof p.regime_cumulativo } })}>
        <option value="9">Detalhada (documento a documento)</option><option value="2">Consolidada por competência</option><option value="1">Regime de caixa</option></select>)
        : field("Apropriação do crédito", <select value={p.apropriacao} onChange={(e) => set({ pis_cofins: { ...p, apropriacao: e.target.value as typeof p.apropriacao } })}>
          <option value="1">Direta</option><option value="2">Rateio proporcional</option></select>)}
      {field("Atividade preponderante", <select value={p.atividade} onChange={(e) => set({ pis_cofins: { ...p, atividade: e.target.value } })}>
        <option value="2">Comércio</option><option value="1">Prestação de serviços</option><option value="0">Industrial</option><option value="4">Imobiliária</option><option value="3">Financeira</option><option value="9">Outras</option></select>)}
    </fieldset>
    <fieldset disabled={!page.pode_editar || busy}><legend>SINTEGRA</legend>
      {field("Operações informadas", <select value={form.sintegra.natureza} onChange={(e) => set({ sintegra: { ...form.sintegra, natureza: e.target.value as Settings["sintegra"]["natureza"] } })}>
        <option value="3">Todas as operações</option><option value="2">Só as interestaduais</option><option value="1">Só as interestaduais com substituição tributária</option></select>)}
      {field("Finalidade", <select value={form.sintegra.finalidade} onChange={(e) => set({ sintegra: { ...form.sintegra, finalidade: e.target.value as Settings["sintegra"]["finalidade"] } })}>
        <option value="1">Normal</option><option value="2">Retificação total</option><option value="3">Retificação aditiva</option><option value="5">Desfazimento</option></select>)}
      {field("Pessoa de contato", text(form.sintegra.contato, (v) => set({ sintegra: { ...form.sintegra, contato: v } }), 28))}
    </fieldset>
    <fieldset disabled={!page.pode_editar || busy}><legend>Pacote do contador</legend>
      <label className="preference-check"><input type="checkbox" checked={form.no_pacote} onChange={(e) => set({ no_pacote: e.target.checked })} />
        <span>Colocar os arquivos prontos no pacote do contador do mesmo período (pasta obrigacoes)</span></label>
    </fieldset>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {notice && <p className="real-help" role="status">{notice}</p>}
    {page.pode_editar ? <button type="submit" className="primary-button" disabled={busy}>{busy ? "Salvando…" : "Salvar"}</button>
      : <p className="real-help">Só o papel fiscal ou o administrador altera a configuração.</p>}
  </form>;
}

export default function Sped({ role }: { role: string }) {
  const location = useLocation(), navigate = useNavigate();
  const asked = new URLSearchParams(location.search).get("aba");
  const tab: Tab = TABS.some((t) => t.id === asked) ? asked as Tab : "gerar";
  const writable = role === "admin" || role === "fiscal";
  if (!spedBase()) return <section className="real-state-panel"><h1>SPED e SINTEGRA</h1><p>{SPED_UNAVAILABLE}</p></section>;
  if (!["admin", "fiscal", "consulta"].includes(role))
    return <section className="real-state-panel"><h1>SPED e SINTEGRA não liberados</h1><p>Seu papel no ERP não alcança os arquivos fiscais. Peça ao administrador o papel fiscal ou de consulta em Pessoas e acessos.</p></section>;
  return <section className="report-screen">
    <header className="real-heading"><div><h1>SPED e SINTEGRA</h1><p>SPED Fiscal, EFD-Contribuições e SINTEGRA do mês, para o contador ou para o validador oficial. Nada é enviado ao governo.</p></div></header>
    <nav className="cnab-tabs report-tabs" aria-label="SPED e SINTEGRA">{TABS.map((t) =>
      <button key={t.id} type="button" aria-current={tab === t.id ? "page" : undefined} onClick={() => navigate(`${ROUTE}?aba=${t.id}`)}>{t.label}</button>)}</nav>
    {tab === "gerar" && <GenerateTab writable={writable} />}
    {tab === "configuracao" && <SettingsTab />}
  </section>;
}
