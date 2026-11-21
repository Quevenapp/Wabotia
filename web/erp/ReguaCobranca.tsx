// Financeiro › Régua de cobrança (parte Financeiro): se a régua está ligada,
// os dias dos avisos (as preferências de Contas a receber), o horário e os
// canais; o que vai sair hoje, o que saiu e o que não saiu, com o motivo. Só o
// administrador liga, desliga e muda (com o aviso confirmado ao ligar). O
// servidor planeja e envia (src/erp/regua/); a tela só mostra e manda as
// escolhas da pessoa.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { erpPorts } from "./ports";
import {
  PAYMENT_LABELS, reguaDay, reguaMoney, reguaWhen, rulesText,
  type ReguaOverview, type ReguaPayment, type ReguaPort, type ReguaSettingsInput, type ReguaStep,
} from "./regua-api";

const errorText = (error: unknown) => (error instanceof Error ? error.message : "Algo deu errado. Atualize a tela e tente de novo.");
const aborted = (error: unknown) => error instanceof Error && error.name === "AbortError";
type Tab = "hoje" | "enviadas" | "nao-sairam" | "configurar";
const HOURS = Array.from({ length: 25 }, (_v, h) => h);
const PREFERENCES = "/preferencias/financas/contas-receber";

export default function ReguaCobranca({ port: injected }: { port?: ReguaPort }) {
  const port = injected ?? erpPorts()?.regua;
  const [data, setData] = useState<ReguaOverview | null>(null), [error, setError] = useState(""), [version, setVersion] = useState(0);
  const [tab, setTab] = useState<Tab>("hoje"), [notice, setNotice] = useState("");
  const access = port?.access();
  useEffect(() => {
    if (!port || !access?.parts.finance) return;
    const request = new AbortController();
    setError("");
    port.overview(request.signal).then(setData, (failure) => { if (!aborted(failure)) setError(errorText(failure)); });
    return () => request.abort();
  }, [port, version, access?.parts.finance]);
  if (!port || !access) return <section className="real-state-panel"><h1>Régua de cobrança</h1><p>A régua de cobrança ainda não está disponível nesta área.</p></section>;
  if (!access.parts.finance)
    return <section className="real-state-panel"><h1>Régua de cobrança</h1><p>A régua de cobrança faz parte do Financeiro, que está desligado nesta área. Peça ao administrador para ligar o Financeiro em Gestão → Módulos.</p></section>;
  const regua = data?.regua;
  return <section className="regua-cobranca">
    <header className="real-heading"><h1>Régua de cobrança</h1>{data && !data.pode_mudar && <span className="real-mode">Só o administrador muda</span>}</header>
    <p className="real-notice">A régua manda a conta a receber ao cliente pelo WhatsApp (com Pix, link ou boleto) alguns dias antes do vencimento, no dia e alguns dias depois. Cada aviso sai uma vez só por conta, no horário comercial, e nunca de conta já paga ou cancelada.</p>
    {notice && <p className="real-success" role="status">{notice}</p>}
    {error && <p className="real-alert" role="alert">{error} <button type="button" className="text-button" onClick={() => setVersion((v) => v + 1)}>Tentar de novo</button></p>}
    {!data && !error && <p role="status">Carregando a régua…</p>}
    {data && regua && <>
      <dl className="regua-summary">
        <div><dt>Situação</dt><dd><strong>{regua.ligada ? "Ligada" : "Desligada"}</strong>{regua.ligada && regua.ligada_por ? ` · ligada por ${regua.ligada_por} em ${reguaWhen(regua.ligada_em)}` : ""}</dd></div>
        <div><dt>Avisos</dt><dd>{rulesText(data.rules)}{data.rules.source !== "regua" ? " (os dias de Preferências › Contas a receber)" : ""}</dd></div>
        <div><dt>Horário</dt><dd>Das {regua.hora_inicio}h às {regua.hora_fim}h{regua.so_dias_uteis ? ", só em dia útil" : ", todos os dias"}{data.in_hours ? " · agora está no horário" : ` · fora do horário agora; volta ${reguaWhen(data.next_opening)}`}</dd></div>
        <div><dt>Canais</dt><dd>{[regua.whatsapp ? "WhatsApp" : null, regua.email && data.email_disponivel ? "e-mail" : null].filter(Boolean).join(" e ") || "Nenhum"} · pagamento: {PAYMENT_LABELS[regua.pagamento]}</dd></div>
      </dl>
      {regua.ligada && regua.remetente_ativo === false && <p className="real-alert" role="alert">Quem ligou a régua não é mais administrador ativo desta área, e as mensagens saem em nome dessa pessoa: nada está saindo. Um administrador precisa desligar e ligar a régua de novo.</p>}
      {regua.ligada && regua.remetente_ativo !== false && regua.ultimo_erro && <p className="real-alert" role="alert">{regua.ultimo_erro} (rodada de {reguaWhen(regua.ultima_rodada)}; o sistema tenta de novo sozinho)</p>}
      {regua.ligada && !data.rules.before && !data.rules.on_due && !data.rules.after && <p className="real-alert" role="alert">A régua está ligada, mas nenhum aviso está marcado. {data.pode_mudar ? "Marque os dias em “Ligar e ajustar”." : "Peça ao administrador para marcar os dias."}</p>}
      <nav className="finance-tabs" aria-label="Partes da régua">
        {([["hoje", `Hoje (${data.today_items.length})`], ["enviadas", `Enviadas (${data.counts.sent})`], ["nao-sairam", `Não saíram (${data.counts.failed + data.counts.skipped + data.counts.cancelled})`], ["configurar", data.pode_mudar ? "Ligar e ajustar" : "Configuração"]] as [Tab, string][])
          .map(([id, label]) => <button key={id} type="button" aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>{label}</button>)}
      </nav>
      {tab === "hoje" && <Steps items={data.today_items} empty={regua.ligada ? "Nada para sair hoje." : "A régua está desligada: nada sai. As contas novas das recorrências com envio também esperam a régua ligada."} />}
      {tab === "enviadas" && <Steps items={data.sent} empty="Nenhum aviso enviado nos últimos 30 dias." />}
      {tab === "nao-sairam" && <Steps items={data.not_sent} empty="Nenhum aviso deixou de sair nos últimos 30 dias." />}
      {tab === "configurar" && <Settings key={`${version}:${data.now}`} data={data} port={port} demo={access.demo} onSaved={(next, text) => { setData(next); setNotice(text); }} />}
    </>}
  </section>;
}

function Steps({ items, empty }: { items: ReguaStep[]; empty: string }) {
  if (!items.length) return <div className="empty-state"><p>{empty}</p></div>;
  return <div className="table-scroll" tabIndex={0} role="region" aria-label="Avisos da régua">
    <table className="data-table finance-table"><thead><tr><th>Cliente</th><th>Conta</th><th>Vencimento</th><th>Valor</th><th>Aviso</th><th>Canal</th><th>Situação</th></tr></thead>
      <tbody>{items.map((s) => <tr key={s.id ?? `${s.title_id}:${s.stage}:${s.channel}`}>
        <td>{s.contact?.name ?? "—"}</td>
        <td><Link to={`/financeiro-empresa?area=receivable&titulo=${s.title_id}`}>{s.description ?? "Abrir a conta"}</Link></td>
        <td>{reguaDay(s.due_on)}</td>
        <td>{reguaMoney(s.amount_cents)}</td>
        <td>{s.stage_label}</td>
        <td>{s.channel_label}</td>
        <td>{s.status_label}{s.sent_at ? ` em ${reguaWhen(s.sent_at)}` : ""}{s.reason && <small className="real-help"> {s.reason}</small>}</td>
      </tr>)}</tbody></table>
  </div>;
}

function Settings({ data, port, demo, onSaved }: { data: ReguaOverview; port: ReguaPort; demo: boolean; onSaved: (next: ReguaOverview, text: string) => void }) {
  const r = data.regua;
  const [form, setForm] = useState({ ligada: r.ligada, whatsapp: r.whatsapp, email: r.email, pagamento: r.pagamento, hora_inicio: r.hora_inicio, hora_fim: r.hora_fim, so_dias_uteis: r.so_dias_uteis,
    dias_antes: r.dias_antes === null ? "" : String(r.dias_antes), no_vencimento: r.no_vencimento, dias_depois: r.dias_depois === null ? "" : String(r.dias_depois) });
  const pref = data.preference_rules;
  const dayValue = (value: string) => (value.trim() === "" ? null : /^\d{1,3}$/.test(value.trim()) && Number(value) <= 365 ? Number(value) : NaN);
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const readOnly = !data.pode_mudar || demo;
  const turningOn = form.ligada && !r.ligada;
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const save = async () => {
    const before = dayValue(form.dias_antes), after = dayValue(form.dias_depois);
    if (Number.isNaN(before) || Number.isNaN(after)) { setError("Informe os dias de 0 a 365, ou deixe em branco para usar a preferência."); return; }
    setBusy(true); setError("");
    const input: ReguaSettingsInput = { ...form, dias_antes: before, dias_depois: after, ...(turningOn ? { confirmo: confirm } : {}) };
    try {
      const next = await port.configure(input);
      onSaved(next, turningOn ? "Régua ligada. Os avisos começam a sair no próximo horário comercial." : r.ligada && !form.ligada ? "Régua desligada. Nenhum aviso novo sai." : "Régua ajustada.");
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  };
  return <form className="regua-settings" onSubmit={(event) => { event.preventDefault(); if (!readOnly) void save(); }}>
    {readOnly && <p className="real-help">{demo ? "A demonstração não grava a régua." : "Só o administrador da área liga, desliga ou muda a régua. Você pode ver a configuração."}</p>}
    <fieldset disabled={readOnly || busy}>
      <legend>Régua de cobrança</legend>
      <label><input id="regua-ligada" type="checkbox" checked={form.ligada} onChange={(e) => set("ligada", e.target.checked)} /> Ligada</label>
      {turningOn && <div className="real-alert" role="alert"><p>{data.aviso}</p>
        <label><input id="regua-confirmo" type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> Entendi e quero que as mensagens saiam em meu nome</label></div>}
      <div className="form-field"><label htmlFor="regua-antes">Dias antes do vencimento</label>
        <input id="regua-antes" inputMode="numeric" maxLength={3} placeholder={`Preferência: ${pref.before || "sem aviso"}`} value={form.dias_antes} onChange={(e) => set("dias_antes", e.target.value)} /></div>
      <div className="form-field"><label htmlFor="regua-dia">No dia do vencimento</label>
        <select id="regua-dia" value={form.no_vencimento === null ? "" : form.no_vencimento ? "sim" : "nao"} onChange={(e) => set("no_vencimento", e.target.value === "" ? null : e.target.value === "sim")}>
          <option value="">Como na preferência ({pref.on_due ? "sim" : "não"})</option><option value="sim">Sim</option><option value="nao">Não</option>
        </select></div>
      <div className="form-field"><label htmlFor="regua-depois">Dias depois do vencimento</label>
        <input id="regua-depois" inputMode="numeric" maxLength={3} placeholder={`Preferência: ${pref.after || "sem aviso"}`} value={form.dias_depois} onChange={(e) => set("dias_depois", e.target.value)} /></div>
      <p className="real-help">Em branco, vale o dia de Preferências › Contas a receber (Envio automático de boletos). 0 é sem aviso. Um aviso que não pôde sair no dia ainda sai nos {data.rules.grace_days} dias seguintes, mas nunca depois do começo do aviso seguinte.</p>
      <label><input id="regua-whatsapp" type="checkbox" checked={form.whatsapp} onChange={(e) => set("whatsapp", e.target.checked)} /> Pelo WhatsApp (a conta, com a forma de pagamento abaixo)</label>
      <label><input id="regua-email" type="checkbox" checked={form.email && data.email_disponivel} disabled={!data.email_disponivel} onChange={(e) => set("email", e.target.checked)} /> Por e-mail</label>
      {!data.email_disponivel && <p className="real-help">O envio por e-mail ainda não está disponível nesta instalação. Quando estiver, ele aparece aqui.</p>}
      <div className="form-field"><label htmlFor="regua-pagamento">Como o cliente paga</label>
        <select id="regua-pagamento" value={form.pagamento} onChange={(e) => set("pagamento", e.target.value as ReguaPayment)}>
          {(Object.keys(PAYMENT_LABELS) as ReguaPayment[]).map((p) => <option key={p} value={p}>{PAYMENT_LABELS[p]}</option>)}
        </select></div>
      <div className="form-field"><label htmlFor="regua-inicio">Começa às</label>
        <select id="regua-inicio" value={form.hora_inicio} onChange={(e) => set("hora_inicio", Number(e.target.value))}>{HOURS.slice(0, 24).map((h) => <option key={h} value={h}>{h}h</option>)}</select></div>
      <div className="form-field"><label htmlFor="regua-fim">Para às</label>
        <select id="regua-fim" value={form.hora_fim} onChange={(e) => set("hora_fim", Number(e.target.value))}>{HOURS.slice(1).map((h) => <option key={h} value={h}>{h}h</option>)}</select></div>
      <label><input id="regua-uteis" type="checkbox" checked={form.so_dias_uteis} onChange={(e) => set("so_dias_uteis", e.target.checked)} /> Só em dia útil (sem sábado, domingo e feriado nacional)</label>
      <p className="real-help">Os dias de <Link to={PREFERENCES}>Preferências › Contas a receber</Link> também valem para o envio de boletos por e-mail da Cobrança bancária. Quem não pode receber pelo WhatsApp (sem conversa nas últimas 24 horas e sem autorização de avisos de cobrança) fica em “Não saíram”, com o motivo.</p>
    </fieldset>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {!readOnly && <button type="submit" className="primary-button" disabled={busy || (turningOn && !confirm)}>{busy ? "Salvando…" : turningOn ? "Ligar a régua" : "Salvar"}</button>}
  </form>;
}
