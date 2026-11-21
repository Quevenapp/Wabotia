import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { EmissionView } from "../../src/erp/commercial-nfe/contracts";
import { CORRECTION_LEGAL_NOTICE, CORRECTION_LIMIT, CORRECTION_TEXT_MAX, CORRECTION_TEXT_MIN, type NfeEventsView, type ReturnFinanceOption, type ReturnView } from "../../src/erp/commercial-nfe/events-contracts";
import { canCommercialNfe, CommercialNfeError, type CommercialNfePort } from "./commercial-nfe";

const correctionStates: Record<string, string> = { enviando: "Enviando ao cofre", incerto: "Sem resposta: consulte antes de enviar outra", recusado: "Recusada", registrado: "Registrada na SEFAZ" };
const returnStates: Record<string, string> = { preparada: "Preparada", enviando: "Enviando ao cofre", processando: "Em processamento na SEFAZ", incerta: "Sem resposta: consulte a mesma devolução",
  rejeitada: "Recusada pela SEFAZ", denegada: "Denegada", autorizada: "Autorizada", cancelada: "Cancelada" };
const effectStates: Record<string, string> = { pendente: "Pendente", aplicado: "Lançado", pulado: "Nada a lançar" };
const effectReasons: Record<string, string> = {
  part_disabled: "A parte está desligada. Peça ao administrador para ligá-la em Gestão → Módulos e use \"Consultar e lançar pendências\".",
  local_role_required: "Seu papel não lança este efeito no estoque ou nas contas. Peça ao administrador do ERP para abrir esta nota e usar \"Consultar e lançar pendências\".",
  sale_without_stock_posting: "A venda não baixou o estoque pelo ERP, então não há o que devolver ao estoque. Se a mercadoria voltou, lance a entrada pela tela de estoque.",
  sale_without_receivables: "A venda não gerou contas a receber pelo ERP; nada foi abatido. Se o cliente pagou por fora, combine o acerto no Financeiro.",
  nfe_return_finance_account_missing: "Não há conta financeira ativa para registrar o abatimento. Cadastre uma conta em Financeiro e use \"Consultar e lançar pendências\".",
  nfe_return_stock_position_missing: "Não achei o depósito de onde o produto saiu na venda. Confira o lançamento de estoque do pedido.",
};
const money = (cents: string | null) => {
  if (cents === null || !/^\d+$/.test(cents)) return "—";
  const digits = cents.padStart(3, "0");
  return `R$ ${digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${digits.slice(-2)}`;
};
const when = (micros: string | null) => {
  if (!micros || !/^\d+$/.test(micros)) return "—";
  return new Date(Number(BigInt(micros) / 1000n)).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
};
const scaled = (value: string) => { const text = value.replace(",", ".").trim(); if (!/^\d{1,11}(\.\d{1,4})?$/.test(text)) return null; const [whole, fraction = ""] = text.split("."); return BigInt(whole!) * 10000n + BigInt((fraction + "0000").slice(0, 4)); };
const unscaled = (value: bigint) => { const fraction = String(value % 10000n).padStart(4, "0").replace(/0+$/, ""); return `${value / 10000n}${fraction ? `.${fraction}` : ""}`; };
const shown = (value: string) => value.replace(".", ",");
const errorText = (error: unknown) => error instanceof Error ? error.message : "A operação não terminou. Atualize a nota e confira antes de tentar de novo.";
const save = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
};

/** Carta de correção e devolução de uma NF-e de venda autorizada (ou o motivo, em palavras, de não poder). */
export function NfeEventsPanel({ port, emission }: { port: CommercialNfePort; emission: EmissionView }) {
  const [view, setView] = useState<NfeEventsView | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState("");
  const [text, setText] = useState(""), [noticeRead, setNoticeRead] = useState(false);
  const [mode, setMode] = useState<"total" | "partial">("total"), [quantities, setQuantities] = useState<Record<number, string>>({});
  const [financeOption, setFinanceOption] = useState<ReturnFinanceOption | "">(""), [returnConfirmed, setReturnConfirmed] = useState(false), [problem, setProblem] = useState("");
  const intents = useRef(new Map<string, string>());
  const life = useRef(new AbortController());
  useEffect(() => { const controller = new AbortController(); life.current = controller; return () => controller.abort(); }, [port, emission.id]);
  const allowed = canCommercialNfe(port.access(), "event");
  const load = useMemo(() => async () => {
    if (!port.events) return;
    try { const next = await port.events(emission.id, life.current.signal); if (!life.current.signal.aborted) setView(next); }
    catch (failure) { if (!life.current.signal.aborted) setError(errorText(failure)); }
  }, [port, emission.id]);
  useEffect(() => { void load(); }, [load, emission.status, emission.version]);
  if (!port.events) return null;
  /** Mesmo comando até haver resposta conclusiva: repetir nunca gera outra carta ou outra nota. */
  const commandFor = (key: string) => { let id = intents.current.get(key); if (!id) { id = crypto.randomUUID(); intents.current.set(key, id); } return id; };
  const perform = async (label: string, key: string | null, action: (signal: AbortSignal) => Promise<void>) => {
    if (busy) return;
    setBusy(label); setError("");
    try { await action(life.current.signal); if (key) intents.current.delete(key); }
    catch (failure) {
      if (life.current.signal.aborted) return;
      setError(errorText(failure));
      if (key && failure instanceof CommercialNfeError && !failure.uncertain) intents.current.delete(key);
    } finally { if (!life.current.signal.aborted) setBusy(""); }
  };
  if (!view) return <section className="commercial-nfe-card" aria-busy="true"><h2>Carta de correção e devolução</h2>{error ? <p className="real-alert" role="alert">{error}</p> : <p role="status">Conferindo cartas e devoluções…</p>}</section>;

  const correctionKey = `correction:${text.replace(/\s+/g, " ").trim()}`;
  const length = [...text.replace(/\s+/g, " ").trim()].length;
  const sendCorrection = () => {
    if (!port.correct || !noticeRead || length < CORRECTION_TEXT_MIN || length > CORRECTION_TEXT_MAX) return;
    void perform("Enviando a carta ao cofre", correctionKey, async signal => {
      const next = await port.correct!({ emission_id: emission.id, command_id: commandFor(correctionKey), text: text.replace(/\s+/g, " ").trim() }, signal);
      setView(next);
      const last = next.corrections.at(-1);
      if (last?.state === "registrado") { setText(""); setNoticeRead(false); }
    });
  };
  const consultCorrection = (id: string) => port.correctionConsult && void perform("Consultando a carta no cofre", null, async signal => {
    setView(await port.correctionConsult!({ emission_id: emission.id, command_id: crypto.randomUUID(), correction_id: id }, signal));
  });
  const downloadCorrection = (sequence: number, kind: "pdf" | "xml") => port.correctionFile && void perform("Obtendo a carta", null, async signal => {
    save(await port.correctionFile!(emission.id, sequence, kind, signal), `carta-correcao-${view.emission.number ?? "nfe"}-${sequence}.${kind}`);
  });

  const lines = view.lines;
  const chosen = () => lines.map(line => {
    const value = mode === "total" ? line.remaining : quantities[line.item] ?? "0";
    return { line, amount: scaled(value) };
  });
  const sendReturn = () => {
    if (!port.createReturn || !financeOption || !returnConfirmed) return;
    const picks = chosen();
    for (const { line, amount } of picks) {
      if (amount === null) { setProblem(`Confira a quantidade do item ${line.item + 1} (até 4 casas decimais).`); return; }
      if (amount > (scaled(line.remaining) ?? 0n)) { setProblem(`O item ${line.item + 1} tem ${shown(line.remaining)} para devolver.`); return; }
      if (amount > 0n && !line.return_cfop) { setProblem(`O item ${line.item + 1} saiu com o CFOP ${line.cfop}, sem devolução conhecida por aqui. Faça a devolução desse item com o contador.`); return; }
    }
    const items = picks.filter(p => (p.amount ?? 0n) > 0n).map(p => ({ item: p.line.item, quantity: unscaled(p.amount!) }));
    if (!items.length) { setProblem("Informe a quantidade de pelo menos um item."); return; }
    setProblem("");
    const key = `return:${JSON.stringify(items)}:${financeOption}`;
    void perform("Emitindo a NF-e de devolução no cofre", key, async signal => {
      await port.createReturn!({ emission_id: emission.id, command_id: commandFor(key), items, finance_option: financeOption }, signal);
      setQuantities({}); setReturnConfirmed(false);
      await load();
    });
  };
  const resumeReturn = (item: ReturnView) => port.resumeReturn && void perform("Consultando a devolução no cofre", null, async signal => {
    await port.resumeReturn!({ return_id: item.id, command_id: crypto.randomUUID() }, signal);
    await load();
  });
  const downloadReturn = (item: ReturnView, kind: "danfe" | "xml") => port.returnFile && void perform("Obtendo o arquivo do cofre", null, async signal => {
    save(await port.returnFile!(item.id, kind, signal), `devolucao-${item.number ?? item.id}.${kind === "danfe" ? "pdf" : "xml"}`);
  });
  const rules = view.rules;
  const registered = view.corrections.filter(c => c.state === "registrado").length;

  return <>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {busy && <p role="status">{busy}…</p>}
    <section className="commercial-nfe-card" aria-labelledby="nfe-correction-title">
      <h2 id="nfe-correction-title">Carta de correção (CC-e)</h2>
      <p>Cartas registradas nesta nota: {registered} de {CORRECTION_LIMIT}.</p>
      {!rules.correction.allowed && <p className="commercial-nfe-warning" role="status">{rules.correction.reason}</p>}
      {rules.correction.allowed && allowed && <>
        <p className="commercial-nfe-warning">{CORRECTION_LEGAL_NOTICE}</p>
        <label htmlFor="nfe-correction-text">O que corrigir ({CORRECTION_TEXT_MIN} a {CORRECTION_TEXT_MAX} caracteres)</label>
        <textarea id="nfe-correction-text" value={text} maxLength={CORRECTION_TEXT_MAX + 200} disabled={Boolean(busy)} onChange={event => setText(event.target.value)}
          placeholder="Ex.: Endereço de entrega: Rua das Acácias, 45, sala 2. Volumes: 3 caixas." />
        <p>{length} de {CORRECTION_TEXT_MAX} caracteres{length > 0 && length < CORRECTION_TEXT_MIN ? ` · faltam ${CORRECTION_TEXT_MIN - length}` : ""}.</p>
        <label><input id="nfe-correction-notice" type="checkbox" checked={noticeRead} disabled={Boolean(busy)} onChange={event => setNoticeRead(event.target.checked)} /> Li o aviso: a carta não corrige valores, impostos, destinatário nem data, e substitui as cartas anteriores.</label>
        <div className="commercial-nfe-actions"><button type="button" disabled={Boolean(busy) || !noticeRead || length < CORRECTION_TEXT_MIN || length > CORRECTION_TEXT_MAX} onClick={sendCorrection}>Enviar carta de correção</button></div>
      </>}
      {rules.correction.allowed && !allowed && <p>Só quem tem o papel fiscal (ou o administrador) envia carta de correção.</p>}
      {view.corrections.length > 0 && <ol>{view.corrections.map(item => <li key={item.id}>
        <p><strong>{item.sequence ? `Carta ${item.sequence}` : `Carta ${item.expected_sequence} (pedida)`}</strong> · {correctionStates[item.state]} · {when(item.event_at ?? item.created_at)}{item.protocol ? ` · protocolo ${item.protocol}` : ""}</p>
        <p>{item.text}</p>
        {item.messages.map((message, index) => <p key={index} role="status">{message.description}</p>)}
        <div className="commercial-nfe-actions">
          {item.state === "registrado" && item.sequence && <><button type="button" disabled={Boolean(busy)} onClick={() => downloadCorrection(item.sequence!, "pdf")}>Baixar PDF da carta</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => downloadCorrection(item.sequence!, "xml")}>Baixar XML da carta</button></>}
          {(item.state === "enviando" || item.state === "incerto" || (item.state === "registrado" && !item.xml_available)) && allowed &&
            <button type="button" disabled={Boolean(busy)} onClick={() => consultCorrection(item.id)}>Consultar carta</button>}
        </div>
      </li>)}</ol>}
    </section>

    <section className="commercial-nfe-card" aria-labelledby="nfe-return-title">
      <h2 id="nfe-return-title">Devolução de venda</h2>
      <p>Gera a NF-e de devolução (finalidade devolução, com esta nota referenciada e o CFOP de devolução de cada item), emite pelo cofre e, autorizada, dá entrada no estoque e acerta as contas: a conta a receber em aberto desta venda é abatida primeiro; o que o cliente já pagou vira crédito do cliente ou conta a pagar, conforme a escolha abaixo.</p>
      {!rules.return.allowed && <p className="commercial-nfe-warning" role="status">{rules.return.reason}</p>}
      {rules.return.allowed && allowed && port.createReturn && <>
        <fieldset disabled={Boolean(busy)}><legend>Devolução</legend>
          <label><input type="radio" name="nfe-return-mode" checked={mode === "total"} onChange={() => setMode("total")} /> Tudo o que falta devolver</label>
          <label><input type="radio" name="nfe-return-mode" checked={mode === "partial"} onChange={() => setMode("partial")} /> Escolher itens e quantidades</label>
        </fieldset>
        <div className="table-scroll" tabIndex={0}><table className="data-table"><thead><tr><th>#</th><th>Produto</th><th>CFOP da venda → devolução</th><th className="numeric">Vendido</th><th className="numeric">Já devolvido</th><th className="numeric">Devolver</th></tr></thead>
          <tbody>{lines.map(line => <tr key={line.item}><td>{line.item + 1}</td><td>{line.description}{line.code ? ` · ${line.code}` : ""}</td>
            <td>{line.cfop} → {line.return_cfop ?? "sem devolução conhecida"}</td><td className="numeric">{shown(line.quantity)} {line.unit}</td><td className="numeric">{shown(line.returned)}</td>
            <td className="numeric"><input aria-label={`Devolver do item ${line.item + 1}`} inputMode="decimal" disabled={Boolean(busy) || mode === "total" || (scaled(line.remaining) ?? 0n) === 0n}
              value={mode === "total" ? shown(line.remaining) : quantities[line.item] ?? ""} placeholder="0" onChange={event => { const value = event.target.value; setQuantities(q => ({ ...q, [line.item]: value })); setProblem(""); }} /></td></tr>)}</tbody></table></div>
        <fieldset disabled={Boolean(busy)}><legend>Se o cliente já pagou esta venda</legend>
          <label><input type="radio" name="nfe-return-finance" checked={financeOption === "credito"} onChange={() => setFinanceOption("credito")} /> Crédito do cliente (fica uma conta a pagar marcada como crédito, para usar numa próxima compra)</label>
          <label><input type="radio" name="nfe-return-finance" checked={financeOption === "pagar"} onChange={() => setFinanceOption("pagar")} /> Devolver o dinheiro (cria uma conta a pagar de devolução)</label>
        </fieldset>
        <label><input id="nfe-return-confirmed" type="checkbox" checked={returnConfirmed} disabled={Boolean(busy)} onChange={event => setReturnConfirmed(event.target.checked)} /> Conferi os itens e as quantidades. A mercadoria voltou (ou vai voltar) e autorizo emitir a NF-e de devolução {emission.environment === "producao" ? "em produção, com valor fiscal" : "em homologação, sem valor fiscal"}.</label>
        {problem && <p className="real-alert" role="alert">{problem}</p>}
        <div className="commercial-nfe-actions"><button type="button" disabled={Boolean(busy) || !financeOption || !returnConfirmed} onClick={sendReturn}>Emitir NF-e de devolução</button></div>
      </>}
      {rules.return.allowed && !allowed && <p>Só quem tem o papel fiscal (ou o administrador) emite a devolução.</p>}
      {view.returns.length > 0 && <ol>{view.returns.map(item => {
        const pending = item.status !== "autorizada" && !["denegada", "cancelada"].includes(item.status) || item.status === "autorizada" && (item.stock.state === "pendente" || item.finance.state === "pendente");
        return <li key={item.id}>
          <p><strong>{item.number ? `NF-e de devolução ${item.number}/${item.series}` : "NF-e de devolução"}</strong> · {returnStates[item.status]} · {money(item.total)} · {item.finance_option === "credito" ? "valor pago vira crédito do cliente" : "valor pago vira conta a pagar"}</p>
          <p>{item.items.map(i => `${shown(i.quantity)} ${i.unit} de ${i.description} (CFOP ${i.cfop})`).join("; ")}</p>
          {item.messages.map((message, index) => <p key={index} role="status">{message.code}: {message.description}</p>)}
          {item.status === "rejeitada" && <p className="commercial-nfe-warning">A SEFAZ recusou a devolução. Corrija o que a mensagem pede (cadastro do cliente, produto ou natureza) e use "Consultar e lançar pendências" para enviar de novo, ou fale com o contador.</p>}
          {item.status === "autorizada" && <ul>
            <li>Estoque: {effectStates[item.stock.state]}{typeof item.stock.result?.reason === "string" && effectReasons[item.stock.result.reason] ? ` · ${effectReasons[item.stock.result.reason]}` : typeof item.stock.result?.reason === "string" && item.stock.state === "pendente" ? ` · ${item.stock.result.reason}` : ""}</li>
            <li>Financeiro: {effectStates[item.finance.state]}{typeof item.finance.result?.reason === "string" && effectReasons[item.finance.result.reason] ? ` · ${effectReasons[item.finance.result.reason]}` : typeof item.finance.result?.reason === "string" && item.finance.state === "pendente" ? ` · ${item.finance.result.reason}` : ""}</li>
          </ul>}
          <div className="commercial-nfe-actions">
            {["autorizada", "cancelada"].includes(item.status) && <><button type="button" disabled={Boolean(busy)} onClick={() => downloadReturn(item, "danfe")}>Baixar DANFE da devolução</button>
              <button type="button" disabled={Boolean(busy)} onClick={() => downloadReturn(item, "xml")}>Baixar XML da devolução</button></>}
            {pending && allowed && port.resumeReturn && <button type="button" disabled={Boolean(busy)} onClick={() => resumeReturn(item)}>Consultar e lançar pendências</button>}
            {item.status === "autorizada" && <Link to="/financeiro-empresa?area=receivable">Abrir contas</Link>}
          </div>
        </li>;
      })}</ol>}
    </section>
  </>;
}
