import { useEffect, useMemo, useRef, useState } from "react";
import { VOID_JUSTIFICATION_MAX, VOID_JUSTIFICATION_MIN, VOID_RANGE_MAX } from "../../src/erp/commercial-nfe/events-contracts";
import { canCommercialNfe, CommercialNfeError, type CommercialNfePort, type VoidRangesView } from "./commercial-nfe";

const states: Record<string, string> = { enviando: "Enviando ao cofre", incerto: "Sem resposta: repita o mesmo pedido para conferir", recusado: "Recusada", registrado: "Homologada pela SEFAZ" };
const errorText = (error: unknown) => error instanceof Error ? error.message : "A inutilização não terminou. Atualize a lista e confira antes de tentar de novo.";

/** Inutilização de numeração de NF-e e NFC-e (Configuração do emissor): só quando o cofre oferece; senão, o motivo em palavras. */
export function NfeVoidRanges({ port }: { port?: CommercialNfePort }) {
  const [data, setData] = useState<VoidRangesView | null>(null);
  const [environment, setEnvironment] = useState<"homologacao" | "producao">("homologacao");
  const [model, setModel] = useState<"nfe" | "nfce">("nfe");
  const [series, setSeries] = useState(""), [first, setFirst] = useState(""), [last, setLast] = useState(""), [justification, setJustification] = useState("");
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const intent = useRef<{ key: string; id: string } | null>(null);
  const life = useRef(new AbortController());
  useEffect(() => { const controller = new AbortController(); life.current = controller; return () => controller.abort(); }, [port]);
  const load = useMemo(() => async () => {
    if (!port?.voids) return;
    try { const next = await port.voids({ environment }, life.current.signal); if (!life.current.signal.aborted) setData(next); }
    catch (failure) { if (!life.current.signal.aborted) setError(errorText(failure)); }
  }, [port, environment]);
  useEffect(() => { void load(); }, [load]);
  if (!port?.voids || !canCommercialNfe(port.access(), "read")) return null;
  const capability = data?.capability[model] ?? null;
  const allowed = canCommercialNfe(port.access(), "event");
  const numbers = [series, first, last].map(value => /^\d{1,9}$/.test(value.trim()) ? Number(value.trim()) : null);
  const text = justification.replace(/\s+/g, " ").trim(), length = [...text].length;
  const rangeProblem = numbers.some(n => n === null) ? "Informe série, número inicial e número final." : numbers[0]! > 889 ? "A série vai de 0 a 889."
    : numbers[1]! < 1 || numbers[2]! < numbers[1]! ? "O número final precisa ser igual ou maior que o inicial (a partir de 1)."
    : numbers[2]! - numbers[1]! + 1 > VOID_RANGE_MAX ? `A faixa passa de ${VOID_RANGE_MAX.toLocaleString("pt-BR")} números. Divida em pedidos menores.` : null;
  const submit = async () => {
    if (!port.voidRange || busy || rangeProblem || length < VOID_JUSTIFICATION_MIN || length > VOID_JUSTIFICATION_MAX || !confirmed) return;
    const input = { model, environment, series: numbers[0]!, first: numbers[1]!, last: numbers[2]!, justification: text };
    const key = JSON.stringify(input);
    // Mesmo pedido até resposta conclusiva: repetir nunca pede outra inutilização.
    if (!intent.current || intent.current.key !== key) intent.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await port.voidRange({ ...input, command_id: intent.current.id }, life.current.signal);
      if (result.void.state === "registrado") {
        setNotice(result.void.repeated ? "Esta faixa já estava inutilizada; nada novo foi enviado à SEFAZ." : "Faixa inutilizada e homologada pela SEFAZ.");
        intent.current = null; setFirst(""); setLast(""); setJustification(""); setConfirmed(false);
      } else if (result.void.state === "recusado") { intent.current = null; setError(result.void.messages[0]?.description ?? "A SEFAZ recusou a inutilização."); }
      else setError("O cofre não confirmou a inutilização. Use \"Inutilizar faixa\" de novo com os mesmos dados: o pedido é conferido, não repetido.");
      await load();
    } catch (failure) {
      if (life.current.signal.aborted) return;
      setError(errorText(failure));
      if (failure instanceof CommercialNfeError && !failure.uncertain) intent.current = null;
    } finally { if (!life.current.signal.aborted) setBusy(false); }
  };
  return <section className="real-records" aria-labelledby="nfe-void-title">
    <h2 id="nfe-void-title">Inutilização de numeração</h2>
    <p className="real-help">Para números de NF-e ou NFC-e que foram pulados e nunca vão ser usados. Só número sem nota emitida pode ser inutilizado; o pedido vai à SEFAZ pelo cofre e não pode ser desfeito. Em SP, AC e BA a inutilização foi extinta.</p>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {notice && <p className="real-notice" role="status">{notice}</p>}
    <div className="real-form emissor-form">
      <label>Documento<select value={model} disabled={busy} onChange={event => setModel(event.target.value as "nfe" | "nfce")}><option value="nfe">NF-e (modelo 55)</option><option value="nfce">NFC-e (cupom, modelo 65)</option></select></label>
      <label>Ambiente<select value={environment} disabled={busy} onChange={event => setEnvironment(event.target.value as "homologacao" | "producao")}><option value="homologacao">Homologação</option><option value="producao">Produção</option></select></label>
    </div>
    {capability && !capability.offered && <p className="real-alert" role="status">{capability.reason}</p>}
    {capability?.offered && allowed && <form className="real-form emissor-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={busy}>
        <legend>Faixa a inutilizar</legend>
        <label>Série<input inputMode="numeric" value={series} onChange={event => setSeries(event.target.value)} /></label>
        <label>Número inicial<input inputMode="numeric" value={first} onChange={event => setFirst(event.target.value)} /></label>
        <label>Número final<input inputMode="numeric" value={last} onChange={event => setLast(event.target.value)} /></label>
        <label>Motivo ({VOID_JUSTIFICATION_MIN} a {VOID_JUSTIFICATION_MAX} caracteres)<textarea value={justification} maxLength={VOID_JUSTIFICATION_MAX + 50} onChange={event => setJustification(event.target.value)} placeholder="Ex.: Números pulados por falha no sistema anterior" /></label>
        <p className="real-help">{length} de {VOID_JUSTIFICATION_MAX} caracteres.{rangeProblem && (series || first || last) ? ` ${rangeProblem}` : ""}</p>
        <label style={{ display: "block" }}><input style={{ width: "auto" }} type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> Confirmo que nenhum número desta faixa foi ou será usado {environment === "producao" ? "em produção" : "em homologação"}.</label>
        <div className="real-actions"><button type="submit" className="primary-button" disabled={Boolean(rangeProblem) || length < VOID_JUSTIFICATION_MIN || length > VOID_JUSTIFICATION_MAX || !confirmed}>{busy ? "Inutilizando…" : "Inutilizar faixa"}</button></div>
      </fieldset>
    </form>}
    {capability?.offered && !allowed && <p className="real-help">Só quem tem o papel fiscal (ou o administrador) inutiliza numeração.</p>}
    <h3>Registro</h3>
    {!data ? <p role="status">Carregando inutilizações…</p> : data.items.length === 0 ? <p>Nenhuma inutilização registrada {environment === "producao" ? "em produção" : "em homologação"}.</p>
      : <div className="table-scroll" tabIndex={0}><table className="data-table"><thead><tr><th>Documento</th><th>Série</th><th>Faixa</th><th>Motivo</th><th>Situação</th><th>Protocolo</th></tr></thead>
        <tbody>{data.items.map(item => <tr key={item.id}><td>{item.model === "nfce" ? "NFC-e" : "NF-e"}</td><td>{item.series}</td><td>{item.first === item.last ? item.first : `${item.first} a ${item.last}`}</td>
          <td>{item.justification}</td><td>{states[item.state]}{item.messages[0] && item.state !== "registrado" ? ` · ${item.messages[0].description}` : ""}</td><td>{item.protocol ?? "—"}</td></tr>)}</tbody></table></div>}
  </section>;
}
