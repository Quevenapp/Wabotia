// Cupom fiscal do balcão (NFC-e) no Caixa / PDV e no Fiscal. Só aparece com as
// partes Fiscal e Caixa / PDV ligadas (canNfce); sem elas o caixa fica igual.
// Nada aqui monta o cupom: o DANFCE de 80 mm vem pronto do cofre.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { correctionTarget, createCommandIntent, CommercialNfeError, type CommercialNfePort, type NfceConfigView, type NfceSituation, type NfceSalesQuery } from "./commercial-nfe";
import { canNfce } from "./nfce-access.ts";
import { erpPorts } from "./ports";
import { EmailSendButton } from "./app/components/EmailSend";

/** A porta do cupom quando a área tem Fiscal e Caixa / PDV ligados e o papel lê o cupom. */
export function useNfcePort(): CommercialNfePort | null {
  const port = erpPorts()?.commercialNfe;
  return port?.nfceSale && canNfce(port.access(), "read") ? port : null;
}
export const nfceCanEmit = (port: CommercialNfePort | null) => !!port && canNfce(port.access(), "emit");

const money = (cents: string) => {
  const digits = /^\d+$/.test(cents) ? cents.padStart(3, "0") : "000";
  return `R$ ${digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${digits.slice(-2)}`;
};
const when = (micros: string | null) => {
  if (!micros || !/^\d+$/.test(micros)) return "";
  return new Date(Number(BigInt(micros) / 1000n)).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
};
const failure = (error: unknown) => error instanceof Error && error.message ? error.message : "O cupom fiscal não respondeu. Consulte a venda na lista de cupons pendentes.";
/** CPF com 11 dígitos ou CNPJ com 14 posições; vazio é consumidor não identificado. */
export function nfceDocumentProblem(value: string): string | null {
  const document = value.replace(/[ .\-/]/g, "").toUpperCase();
  if (!document) return null;
  return /^\d{11}$/.test(document) || /^[0-9A-Z]{12}\d{2}$/.test(document) ? null : "Informe o CPF (11 dígitos) ou o CNPJ (14 posições) do consumidor, ou deixe em branco.";
}

/** Abre o DANFCE do cofre para imprimir na bobina (a impressora do caixa decide o corte). */
async function printBlob(blob: Blob) {
  const url = URL.createObjectURL(blob), frame = document.createElement("iframe");
  frame.style.position = "fixed"; frame.style.width = "0"; frame.style.height = "0"; frame.style.border = "0";
  frame.src = url; document.body.appendChild(frame);
  frame.onload = () => { try { frame.contentWindow?.print(); } catch { globalThis.open(url, "_blank", "noopener"); } setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60_000); };
}
/** Mandar ao cliente: o mesmo PDF do cofre, pelo compartilhar do aparelho ou baixado para anexar. */
async function shareBlob(blob: Blob, number: string | null) {
  const file = new File([blob], `cupom-fiscal${number ? `-${number}` : ""}.pdf`, { type: "application/pdf" });
  const nav = globalThis.navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean };
  if (nav?.share && nav.canShare?.({ files: [file] })) { await nav.share({ files: [file], title: "Cupom fiscal" }); return "shared"; }
  const url = URL.createObjectURL(file), link = document.createElement("a");
  link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}

const statusTitle = (row: NfceSituation) => row.situation === "autorizado" ? `Cupom fiscal autorizado${row.coupon?.number ? ` · nº ${row.coupon.number}${row.coupon.series !== null ? ` série ${row.coupon.series}` : ""}` : ""}`
  : row.situation === "cancelado" ? "Cupom fiscal cancelado" : row.situation === "sem_cupom" ? "Venda cancelada sem cupom fiscal"
  : row.coupon?.provider_status === "contingency" && row.coupon.status === "processando" ? "Cupom emitido em contingência" : "Cupom fiscal pendente";

/** Situação e ações do cupom de uma venda. `emitting` mostra o pedido em andamento. */
export function NfceSaleCoupon({ port, saleId, number, initial, emitting = false, consumerDocument = null, compact = false, onChange }: {
  port: CommercialNfePort; saleId: string; number?: string | null; initial?: NfceSituation | null; emitting?: boolean; consumerDocument?: string | null; compact?: boolean;
  onChange?: (row: NfceSituation) => void;
}) {
  const [row, setRow] = useState<NfceSituation | null>(initial ?? null), [busy, setBusy] = useState(emitting ? "Emitindo o cupom fiscal…" : ""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false), [justification, setJustification] = useState(""), [returned, setReturned] = useState(false);
  const intents = useRef(new Map<string, ReturnType<typeof createCommandIntent>>());
  const accept = (next: NfceSituation) => { setRow(next); onChange?.(next); };
  const run = async (key: string, label: string, send: (command: string) => Promise<NfceSituation>) => {
    let intent = intents.current.get(key);
    if (!intent) { intent = createCommandIntent(); intents.current.set(key, intent); }
    setBusy(label); setError(""); setNotice("");
    try { accept(await intent.run({ key }, input => send(input.command_id))); intents.current.delete(key); }
    // Resposta perdida conserva o mesmo comando: repetir é consultar, nunca reenviar outro cupom.
    catch (failed) { if (!(failed instanceof CommercialNfeError && failed.uncertain)) intents.current.delete(key); setError(failure(failed)); }
    finally { setBusy(""); }
  };
  useEffect(() => {
    const request = new AbortController();
    // O pedido do cupom não é cancelado ao sair da tela: o servidor conclui e a lista mostra o resultado.
    if (emitting) void run("emit", "Emitindo o cupom fiscal…", command => port.nfceEmit!({ sale_id: saleId, command_id: command, consumer_document: consumerDocument }));
    else if (!initial) void port.nfceSale!(saleId, request.signal).then(next => { if (!request.signal.aborted) accept(next); }, failed => { if (!request.signal.aborted) setError(failure(failed)); });
    return () => request.abort();
  }, [port, saleId]);
  const file = async (via: "consumidor" | "estabelecimento", share: boolean) => {
    setBusy(share ? "Preparando o cupom para o cliente…" : "Abrindo o cupom para imprimir…"); setError("");
    try { const blob = await port.nfceCoupon!(saleId, via); if (share) setNotice((await shareBlob(blob, row?.coupon?.number?.toString() ?? number ?? null)) === "shared" ? "Cupom enviado pelo compartilhar do aparelho." : "Cupom baixado em PDF para anexar na conversa com o cliente."); else await printBlob(blob); }
    catch (failed) { setError(failure(failed)); } finally { setBusy(""); }
  };
  const emitter = canNfce(port.access(), "emit"), canceller = canNfce(port.access(), "cancel");
  const blocker = row?.coupon?.blockers[0];
  const tooShort = [...justification.trim()].length < 15 || [...justification.trim()].length > 255;
  return <section className={`nfce-coupon${compact ? " is-compact" : ""}`} aria-label="Cupom fiscal" aria-busy={!!busy}>
    {busy ? <p role="status"><strong>{busy}</strong></p> : row ? <p role="status"><strong>{statusTitle(row)}</strong>{row.coupon?.environment === "homologacao" ? " · homologação, sem valor fiscal" : ""}</p> : !error && <p role="status">Consultando o cupom fiscal…</p>}
    {row?.reason && !busy && <p className={row.situation === "pendente" ? "real-alert" : "real-help"}>{row.reason.text}</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}{notice && <p className="real-success" role="status">{notice}</p>}
    {row && !busy && <div className="pdv-detail-actions">
      {row.actions.includes("imprimir") && <button type="button" className="primary-button" onClick={() => void file("consumidor", false)}>Imprimir cupom</button>}
      {row.actions.includes("imprimir") && row.coupon?.provider_status === "contingency" && <button type="button" className="secondary-button" onClick={() => void file("estabelecimento", false)}>Imprimir via do estabelecimento</button>}
      {row.actions.includes("imprimir") && <button type="button" className="secondary-button" onClick={() => void file("consumidor", true)}>Mandar ao cliente</button>}
      {row.situation === "autorizado" && row.coupon?.status === "autorizada" && <EmailSendButton type="nfce" id={saleId} />}
      {emitter && row.actions.includes("tentar_de_novo") && <button type="button" className="secondary-button" onClick={() => void run("emit", "Emitindo o cupom fiscal…", command => port.nfceEmit!({ sale_id: saleId, command_id: command }))}>Tentar de novo</button>}
      {emitter && row.actions.includes("corrigir_e_reenviar") && blocker && <Link className="secondary-button" to={correctionTarget(blocker, row.document_id)}>Corrigir e reenviar</Link>}
      {emitter && row.actions.includes("corrigir_e_reenviar") && !blocker && <Link className="secondary-button" to={`/documentos-empresa?tipo=sales_orders&documento=${encodeURIComponent(row.document_id)}`}>Corrigir e reenviar</Link>}
      {emitter && row.actions.includes("consultar") && <button type="button" className="secondary-button" onClick={() => void run("consult", "Consultando o cupom no cofre…", command => port.nfceConsult!({ sale_id: saleId, command_id: command }))}>Consultar</button>}
      {canceller && row.actions.includes("cancelar") && !cancelOpen && <button type="button" className="secondary-button" onClick={() => setCancelOpen(true)}>Cancelar cupom e venda</button>}
    </div>}
    {row?.actions.includes("devolucao") && !busy && <p className="real-help">O prazo para cancelar este cupom já passou. A venda continua valendo: para desfazer, registre uma devolução (fora desta etapa) e combine com o contador.</p>}
    {cancelOpen && row?.actions.includes("cancelar") && <form className="nfce-cancel" onSubmit={event => { event.preventDefault(); if (tooShort) return;
      void run("cancel", "Cancelando o cupom no cofre…", command => port.nfceCancel!({ sale_id: saleId, command_id: command, justification: justification.trim(), physical_return_confirmed: returned })).then(() => setCancelOpen(false)); }}>
      <p className="real-help">Primeiro o cofre cancela o cupom; só depois a venda, o estoque e as contas são desfeitos.{row.cancel_until ? ` Prazo para cancelar: até ${when(row.cancel_until)}.` : ""}</p>
      <label htmlFor={`nfce-justification-${saleId}`}>Motivo do cancelamento (15 a 255 caracteres)<textarea id={`nfce-justification-${saleId}`} rows={2} maxLength={255} value={justification} onChange={event => setJustification(event.target.value)} /></label>
      <label className="pdv-toggle"><input type="checkbox" checked={returned} onChange={event => setReturned(event.target.checked)} />A mercadoria voltou para a loja</label>
      <div className="pdv-detail-actions"><button type="submit" className="primary-button" disabled={tooShort || !!busy}>Cancelar cupom e venda</button><button type="button" className="secondary-button" onClick={() => setCancelOpen(false)}>Voltar</button></div>
    </form>}
  </section>;
}

/** Cupons pendentes: vendas sem cupom autorizado, com o motivo e as ações. */
export function NfcePendingList({ port, query, title = "Cupons pendentes", reload = 0 }: { port: CommercialNfePort; query: NfceSalesQuery; title?: string; reload?: number }) {
  const [state, setState] = useState<{ key: string; items: NfceSituation[] | null; error: string }>({ key: "", items: null, error: "" });
  const key = `${JSON.stringify(query)}:${reload}`;
  useEffect(() => {
    const request = new AbortController();
    void port.nfceSales!({ ...query, pending_only: true, per_page: 50 }, request.signal)
      .then(page => { if (!request.signal.aborted) setState({ key, items: page.items, error: "" }); }, failed => { if (!request.signal.aborted) setState({ key, items: null, error: failure(failed) }); });
    return () => request.abort();
  }, [port, key]);
  const current = state.key === key ? state : null;
  return <section className="nfce-pending" aria-label={title}><h3>{title}</h3>
    {!current ? <p role="status">Carregando os cupons…</p> : current.error ? <p className="real-alert" role="alert">{current.error}</p>
      : !current.items?.length ? <p className="real-help">Nenhum cupom pendente.</p>
      : <ul>{current.items.map(item => <li key={item.sale_id}><span>Venda nº {item.number ?? "—"} · {money(item.total_cents)}{item.finished_at ? ` · ${when(item.finished_at)}` : ""}</span>
        <NfceSaleCoupon port={port} saleId={item.sale_id} number={item.number} initial={item} compact /></li>)}</ul>}
  </section>;
}

/** Fechamento de caixa: quantas vendas do turno tiveram cupom autorizado, pendente e cancelado. */
export function NfceShiftSummary({ port, cashSessionId }: { port: CommercialNfePort; cashSessionId: string }) {
  const [counts, setCounts] = useState<{ autorizado: number; pendente: number; cancelado: number } | null>(null), [error, setError] = useState("");
  useEffect(() => {
    const request = new AbortController();
    void port.nfceSales!({ cash_session_id: cashSessionId, per_page: 1 }, request.signal).then(page => { if (!request.signal.aborted) setCounts(page.counts); }, failed => { if (!request.signal.aborted) setError(failure(failed)); });
    return () => request.abort();
  }, [port, cashSessionId]);
  return <section className="nfce-shift" aria-label="Cupons fiscais do turno"><h3>Cupons fiscais do turno</h3>
    {error ? <p className="real-alert" role="alert">{error}</p> : !counts ? <p role="status">Contando os cupons…</p>
      : <dl className="pdv-close-head"><div><dt>Autorizados</dt><dd>{counts.autorizado}</dd></div><div><dt>Pendentes</dt><dd>{counts.pendente}</dd></div><div><dt>Cancelados</dt><dd>{counts.cancelado}</dd></div></dl>}
    {counts && counts.pendente > 0 && <p className="real-help">Há vendas do turno sem cupom autorizado: resolva em Cupons pendentes antes ou depois de fechar o caixa.</p>}
  </section>;
}

/** Preferências do Fiscal: o que o cofre informa para a NFC-e, o que falta e a natureza do cupom. */
export function NfceSettings({ port }: { port: CommercialNfePort }) {
  const [view, setView] = useState<NfceConfigView | null>(null), [error, setError] = useState(""), [nature, setNature] = useState(""), [saved, setSaved] = useState(""), [reload, setReload] = useState(0);
  const intent = useRef(createCommandIntent());
  useEffect(() => {
    const request = new AbortController();
    void port.nfceConfig!(request.signal).then(next => { if (request.signal.aborted) return; setView(next); setNature(next.nature.nature_id ?? ""); }, failed => { if (!request.signal.aborted) setError(failure(failed)); });
    return () => request.abort();
  }, [port, reload]);
  const admin = canNfce(port.access(), "configure");
  const save = async () => {
    if (!view) return; setError(""); setSaved("");
    try { await intent.current.run({ nature, version: view.nature.version }, input => port.nfceSaveConfig!({ command_id: input.command_id, expected_version: view.nature.version, nature_id: nature || null }));
      intent.current.reset(); setSaved("Natureza do cupom salva."); setReload(value => value + 1); }
    catch (failed) { if (!(failed instanceof CommercialNfeError && failed.uncertain)) intent.current = createCommandIntent(); setError(failure(failed)); }
  };
  const environment = view?.environment === "producao" ? "produção" : "homologação";
  return <section className="nfce-settings" aria-label="Cupom fiscal do balcão (NFC-e)"><h2>Cupom fiscal do balcão (NFC-e)</h2>
    <p className="real-help">Série, ambiente da NFC-e, CSC (código de segurança do consumidor) e certificado ficam no cofre. O Vinki mostra o que o cofre informou no último Testar conexão.</p>
    {error && <p className="real-alert" role="alert">{error}</p>}
    {!view ? !error && <p role="status">Consultando o cofre…</p> : <>
      <dl className="commercial-nfe-values">
        <div><dt>Ambiente do cupom</dt><dd>{view.environment === "producao" ? "Produção · valor fiscal real" : "Homologação · sem valor fiscal"}{view.environment === "homologacao" ? " (produção só pelo Habilitar produção da NF-e)" : ""}</dd></div>
        <div><dt>Cofre</dt><dd>{view.vault.configured ? `Conexão testada${view.vault.checked_at ? ` em ${new Date(view.vault.checked_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}` : ""}` : "Sem conexão testada"}</dd></div>
        <div><dt>NFC-e liberada nas UFs</dt><dd>{view.vault.ufs === null ? "O cofre não informou" : view.vault.ufs.length ? view.vault.ufs.join(", ") : "Nenhuma"}</dd></div>
        <div><dt>Séries de NFC-e no cofre</dt><dd>{view.vault.series.length ? view.vault.series.map(item => `${item.series} (${item.environment === "producao" ? "produção" : "homologação"}${item.next_number ? `, próximo nº ${item.next_number}` : ""})`).join("; ") : "Nenhuma"}</dd></div>
        <div><dt>CSC</dt><dd>Fica no cofre; o cofre não informa se está cadastrado. Confira no cofre antes do primeiro cupom.</dd></div>
        <div><dt>Contingência</dt><dd>{view.vault.contingency_pending === null ? "O cofre não informou" : view.vault.contingency_pending ? `${view.vault.contingency_pending} cupom(ns) emitido(s) sem a SEFAZ aguardando transmissão pelo cofre` : "Nenhum cupom aguardando transmissão"}. Sem resposta da SEFAZ, o cofre emite em contingência offline e transmite depois.</dd></div>
        {view.vault.certificate_days_left !== null && <div><dt>Certificado</dt><dd>{view.vault.certificate_days_left > 0 ? `Válido por mais ${view.vault.certificate_days_left} dia(s)` : "Vencido: renove no cofre"}</dd></div>}
      </dl>
      {view.missing.length ? <section role="alert"><h3>O que falta para emitir o cupom em {environment}</h3><ul>{view.missing.map(item => <li key={item}>{item}</li>)}</ul></section>
        : <p className="real-success" role="status">Pronto para emitir o cupom fiscal em {environment}.</p>}
      <label htmlFor="nfce-nature">Natureza de operação do cupom<select id="nfce-nature" value={nature} disabled={!admin} onChange={event => setNature(event.target.value)}>
        <option value="">{view.nature.natures.length === 1 ? `Automática (${view.nature.natures[0]!.description})` : "Escolha a natureza"}</option>
        {view.nature.natures.map(item => <option key={item.id} value={item.id}>{item.description}</option>)}</select></label>
      {admin ? <button type="button" className="secondary-button" onClick={() => void save()}>Salvar natureza do cupom</button> : <p className="real-help">Só o administrador escolhe a natureza do cupom.</p>}
      {saved && <p className="real-success" role="status">{saved}</p>}
    </>}
  </section>;
}

/** Fiscal: cupons pendentes dos últimos sete dias (vendas do caixa sem cupom autorizado). */
export function NfceFiscalPanel() {
  const port = useNfcePort();
  if (!port) return null;
  const day = (offset: number) => new Date(Date.now() - 3 * 3_600_000 - offset * 86_400_000).toISOString().slice(0, 10);
  return <NfcePendingList port={port} query={{ from: day(6), to: day(0) }} title="Cupons pendentes do balcão (últimos 7 dias)" />;
}
/** Preferências do Fiscal: só com Fiscal e Caixa / PDV ligados. */
export function NfceSettingsPanel() {
  const port = useNfcePort();
  return port?.nfceConfig ? <NfceSettings port={port} /> : null;
}
