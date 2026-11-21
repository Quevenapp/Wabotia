// Expedição › frete: no pedido, cotar nos provedores ligados, escolher o
// serviço (o valor e o prazo vão para o pedido), contratar o envio com a
// etiqueta oficial, baixar o PDF, cancelar e a linha do tempo do rastreio; na
// aba Frete e transportadoras, ligar e configurar os Correios e o Melhor
// Envio (credenciais vão para o cofre e nunca voltam para a tela) e os
// ajustes da área. O servidor confere e grava (src/erp/frete/).
import { useEffect, useState } from "react";
import { saveFile } from "./app/lib/fiscal-invoice-xml";
import type { FreightOrder, FreightProviders, FreightProviderView, FreightQuote, FretePort } from "./frete-api";

const errorText = (error: unknown) => (error instanceof Error ? error.message : "Algo deu errado. Atualize a tela e tente de novo.");
const aborted = (error: unknown) => error instanceof Error && error.name === "AbortError";
const money = (cents: number | null | undefined) => (cents === null || cents === undefined ? "—" : (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const days = (n: number | null | undefined) => (n === null || n === undefined ? "prazo não informado" : `${n} ${n === 1 ? "dia útil" : "dias úteis"}`);
const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "—");
const cep = (v: string) => (v.length === 8 ? `${v.slice(0, 5)}-${v.slice(5)}` : v);

function Message({ error, notice }: { error?: string; notice?: string }) {
  return <>{error && <p className="expedicao-error" role="alert">{error}</p>}{notice && <p className="expedicao-notice" role="status">{notice}</p>}</>;
}

// ---------------------------------------------------------------------------
// No pedido

export function FreteDoPedido({ port, order, role, onChanged }: { port: FretePort; order: string; role: string | null; onChanged?: () => void }) {
  const [data, setData] = useState<FreightOrder | null>(null);
  const [quote, setQuote] = useState<FreightQuote | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    const signal = new AbortController();
    port.order(order, signal.signal).then(setData, (e) => { if (!aborted(e)) setError(errorText(e)); });
    return () => signal.abort();
  }, [port, order]);
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  if (!data) return <section className="expedicao-card"><h2>Frete e etiqueta oficial</h2><Message error={error} />{!error && <p role="status">Carregando o frete…</p>}</section>;
  const writer = data.can_write && role !== "consulta";
  const s = data.shipment;
  const live = s && ["contracting", "uncertain", "contracted", "cancelling"].includes(s.status);
  const doQuote = () => run(async () => {
    const q = await port.quote(order);
    setQuote(q);
    if (!q.options.length) setNotice("Nenhum serviço devolvido para este pedido.");
  });
  const choose = (option: string) => run(async () => {
    if (!quote) return;
    const r = await port.choose(order, { cotacao: quote.id, servico: option });
    setData(r); setQuote(null); onChanged?.();
    setNotice(r.applied ? "Serviço escolhido. O valor do frete e o prazo foram para o pedido." : `Serviço escolhido e guardado na expedição. ${r.message ?? ""}`.trim());
  });
  const contract = () => run(async () => {
    const c = data.choice;
    if (!c) return;
    if (!window.confirm(`Contratar o envio ${c.service_name} (${money(c.price_cents)}) e gerar a etiqueta oficial?${c.sandbox ? " (ambiente de teste do provedor)" : " O provedor pode cobrar do seu contrato ou da sua carteira."}`)) return;
    const r = await port.contract(order);
    setData(r); onChanged?.();
    setNotice([r.repeated ? "Este pedido já tinha o envio contratado." : `Envio contratado${r.shipment?.tracking_code ? `. Rastreio ${r.shipment.tracking_code}` : ""}.`, ...(r.notes ?? [])].join(" "));
  });
  const download = () => run(async () => {
    const pdf = await port.label(order);
    saveFile(`etiqueta-pedido-${data.order.number}.pdf`, pdf as Uint8Array<ArrayBuffer>, "application/pdf");
  });
  const cancel = () => run(async () => {
    if (!window.confirm("Cancelar este envio no provedor? O código de rastreio sai do pedido.")) return;
    const r = await port.cancel(order);
    setData(r); onChanged?.();
    setNotice(["Envio cancelado no provedor.", ...(r.notes ?? [])].join(" "));
  });
  const track = () => run(async () => {
    const r = await port.track(order);
    setData(r);
    setNotice(r.added ? `${r.added} evento${r.added > 1 ? "s" : ""} novo${r.added > 1 ? "s" : ""} no rastreio.` : "Nada novo no rastreio.");
  });
  return <section className="expedicao-card" aria-label="Frete e etiqueta oficial">
    <h2>Frete e etiqueta oficial</h2>
    <Message error={error} notice={notice} />
    {!data.providers.length && <p className="expedicao-hint">Nenhum provedor de frete está ligado. O administrador liga os Correios ou o Melhor Envio em Expedição › Frete e transportadoras.</p>}
    {data.choice && <p>Serviço escolhido: <strong>{data.choice.company && data.choice.company !== data.choice.service_name ? `${data.choice.company} · ` : ""}{data.choice.service_name}</strong> — {money(data.choice.price_cents)}, {days(data.choice.delivery_days)}{data.choice.sandbox ? " (teste)" : ""}.
      {!data.choice.applied && data.choice.apply_message && <><br /><span className="expedicao-warning">{data.choice.apply_message}</span></>}</p>}
    {writer && data.providers.length > 0 && !live && <div className="expedicao-actions">
      <button type="button" disabled={busy} onClick={() => void doQuote()}>Cotar frete</button>
      {data.choice && ["packed", "shipped"].includes(data.order.ship_status) && <button type="button" className="expedicao-primary" disabled={busy} onClick={() => void contract()}>Contratar envio e gerar etiqueta</button>}
    </div>}
    {writer && !live && data.choice && !["packed", "shipped"].includes(data.order.ship_status) && <p className="expedicao-hint">Para contratar o envio, monte os volumes do pedido primeiro.</p>}
    {quote && <div>
      <p className="expedicao-hint">De {cep(quote.from_postal_code)} para {cep(quote.to_postal_code)} · {quote.volumes} volume{quote.volumes > 1 ? "s" : ""}, {(quote.weight_g / 1000).toLocaleString("pt-BR")} kg · valor declarado {money(quote.declared_cents)}.</p>
      {quote.errors.map((e) => <p key={e.provider} className="expedicao-warning">{e.message}</p>)}
      {!quote.freight_editable && <p className="expedicao-warning">O valor escolhido fica guardado na expedição, mas não entra no pedido (pedido fechado, sem frete ou com parcelas).</p>}
      {quote.options.length > 0 && <table className="expedicao-table"><thead><tr><th>Serviço</th><th>Preço</th><th>Prazo</th><th></th></tr></thead>
        <tbody>{quote.options.map((o) => <tr key={o.option}>
          <td>{o.provider_name}{o.company && o.company !== o.provider_name ? ` · ${o.company}` : ""} · {o.service_name}{o.sandbox ? <small>teste</small> : null}</td>
          <td>{money(o.price_cents)}</td><td>{days(o.delivery_days)}</td>
          <td><button type="button" disabled={busy} onClick={() => void choose(o.option)}>Usar este serviço</button></td>
        </tr>)}</tbody></table>}
    </div>}
    {s && <div>
      <p>Envio {s.provider_name} · {s.service_name}{s.sandbox ? " (teste)" : ""}: <strong>{s.status_label}</strong>{s.tracking_code ? ` · Rastreio ${s.tracking_code}` : ""}{s.price_cents !== null ? ` · ${money(s.price_cents)}` : ""}
        {s.tracking_label ? ` · ${s.tracking_label}` : ""}</p>
      {s.error && s.status !== "contracted" && <p className="expedicao-warning">{s.error}</p>}
      {s.status === "uncertain" && <p className="expedicao-warning">A resposta do provedor não chegou. Toque em Confirmar com o provedor: o Vinki consulta antes de contratar de novo.</p>}
      {writer && <div className="expedicao-actions">
        {(s.status === "uncertain" || s.status === "contracting") && <button type="button" className="expedicao-primary" disabled={busy} onClick={() => void run(async () => { const r = await port.contract(order); setData(r); onChanged?.(); setNotice([...(r.notes ?? [])].join(" ") || "Envio confirmado."); })}>Confirmar com o provedor</button>}
        {s.label_ready && <button type="button" disabled={busy} onClick={() => void download()}>Baixar etiqueta oficial (PDF)</button>}
        {s.status === "contracted" && s.tracking_code && <button type="button" disabled={busy} onClick={() => void track()}>Atualizar rastreio</button>}
        {(s.status === "contracted" || s.status === "cancelling") && <button type="button" disabled={busy} onClick={() => void cancel()}>Cancelar envio</button>}
      </div>}
      {!writer && s.label_ready && <div className="expedicao-actions"><button type="button" disabled={busy} onClick={() => void download()}>Baixar etiqueta oficial (PDF)</button></div>}
    </div>}
    {data.events.length > 0 && <>
      <h3>Rastreio</h3>
      <ol className="expedicao-timeline">{data.events.map((e) => <li key={e.id}><strong>{when(e.at)}</strong> · {e.status_label}: {e.description}{e.location ? ` (${e.location})` : ""}{e.notified ? <small> · cliente avisado</small> : null}</li>)}</ol>
    </>}
    {s?.status === "contracted" && !data.events.length && <p className="expedicao-hint">{s.shipped_at ? "O rastreio é consultado sozinho de tempos em tempos." : "O rastreio começa a ser consultado sozinho quando o pedido for marcado como expedido."}{data.notify_whatsapp ? " O cliente recebe um aviso pelo WhatsApp a cada mudança." : ""}</p>}
  </section>;
}

// ---------------------------------------------------------------------------
// Aba Frete e transportadoras

export function FreteProvedores({ port, role }: { port: FretePort; role: string | null }) {
  const [data, setData] = useState<FreightProviders | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    if (role !== "admin") return;
    const signal = new AbortController();
    port.providers(signal.signal).then((d) => { setData(d); setOrigin(d.settings.origin_postal_code ?? ""); }, (e) => { if (!aborted(e)) setError(errorText(e)); });
    return () => signal.abort();
  }, [port, role]);
  if (role !== "admin")
    return <p className="expedicao-hint">Só o administrador do ERP liga e configura os provedores de frete (Correios e Melhor Envio). Peça a ele.</p>;
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await work(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  if (!data) return <><Message error={error} />{!error && <p role="status">Carregando os provedores…</p>}</>;
  const saveSettings = (input: { avisar_whatsapp?: boolean; cep_origem?: string | null }) => run(async () => {
    const r = await port.saveSettings(input);
    setData({ ...data, settings: r.settings }); setOrigin(r.settings.origin_postal_code ?? ""); setNotice("Ajustes gravados.");
  });
  return <>
    <p className="expedicao-hint">Ligue um provedor para cotar o frete, gerar a etiqueta oficial e acompanhar o rastreio dos pedidos. Cada provedor começa desligado e em modo de teste. As credenciais ficam guardadas no cofre e não aparecem de novo nesta tela.</p>
    <Message error={error} notice={notice} />
    {data.providers.map((p) => <ProviderCard key={p.id} provider={p} busy={busy} onSave={(input) => run(async () => { setData(await port.saveProvider(p.id, input)); setNotice(`${p.name}: gravado.`); })}
      onTest={() => run(async () => { const r = await port.testProvider(p.id); setData(r); if (r.ok) setNotice(r.message ?? "Conexão conferida."); else setError(r.message ?? "A conexão falhou."); })} />)}
    <section className="expedicao-card"><h2>Ajustes do frete</h2>
      <label><input type="checkbox" checked={data.settings.notify_whatsapp} disabled={busy} onChange={(e) => void saveSettings({ avisar_whatsapp: e.target.checked })} /> Avisar o cliente pelo WhatsApp a cada mudança no rastreio</label>
      <p className="expedicao-hint">O aviso sai pela linha de WhatsApp da área, para o celular do cadastro do cliente, seguindo a regra das 24 horas (fora dela, pelo modelo de aviso).</p>
      <div className="expedicao-toolbar">
        <label>CEP de origem<input value={origin} inputMode="numeric" placeholder="o da empresa" onChange={(e) => setOrigin(e.target.value)} /></label>
        <button type="button" disabled={busy} onClick={() => void saveSettings({ cep_origem: origin.trim() || null })}>Gravar CEP</button>
      </div>
      <p className="expedicao-hint">Vazio: a cotação usa o CEP do cadastro da empresa.</p>
    </section>
  </>;
}

function ProviderCard({ provider: p, busy, onSave, onTest }: { provider: FreightProviderView; busy: boolean;
  onSave: (input: { ligado?: boolean; sandbox?: boolean; credenciais?: Record<string, string | null>; opcoes?: Record<string, string | null> }) => void; onTest: () => void }) {
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [opts, setOpts] = useState<Record<string, string>>(p.options);
  useEffect(() => { setOpts(p.options); setSecrets({}); }, [p]);
  const typed = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim()));
  return <section className="expedicao-card" aria-label={p.name}>
    <h2>{p.name} {p.enabled ? <small>ligado{p.sandbox ? ", em teste" : ", em produção"}</small> : <small>desligado</small>}</h2>
    <div className="expedicao-toolbar">
      <label><input type="checkbox" checked={p.enabled} disabled={busy} onChange={(e) => onSave({ ligado: e.target.checked })} /> Ligado</label>
      {p.sandbox_available && <label><input type="checkbox" checked={p.sandbox} disabled={busy} onChange={(e) => onSave({ sandbox: e.target.checked })} /> Modo de teste (sandbox)</label>}
    </div>
    <div className="expedicao-toolbar">
      {p.secret_fields.map((f) => <label key={f.key} title={f.hint}>{f.label}<input type="password" autoComplete="off" value={secrets[f.key] ?? ""} placeholder={f.saved ? "guardado no cofre" : "não preenchido"}
        onChange={(e) => setSecrets({ ...secrets, [f.key]: e.target.value })} /></label>)}
      {p.option_fields.map((f) => <label key={f.key} title={f.hint}>{f.label}{f.required ? " *" : ""}<input value={opts[f.key] ?? ""} onChange={(e) => setOpts({ ...opts, [f.key]: e.target.value })} /></label>)}
    </div>
    <p className="expedicao-hint">{[...p.secret_fields, ...p.option_fields].map((f) => `${f.label}: ${f.hint}`).join(" ")}</p>
    <div className="expedicao-actions">
      <button type="button" className="expedicao-primary" disabled={busy} onClick={() => onSave({ credenciais: typed, opcoes: Object.fromEntries(p.option_fields.map((f) => [f.key, opts[f.key]?.trim() || null])) })}>Gravar</button>
      <button type="button" disabled={busy || !p.ready} onClick={onTest}>Testar conexão</button>
    </div>
    {p.check && <p className={p.check.ok ? "expedicao-notice" : "expedicao-warning"}>Último teste ({when(p.check.at)}): {p.check.message}</p>}
  </section>;
}
