import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { AccessController, AccessState } from "./app/lib/real-access";
import type { DocumentRecord } from "./app/lib/real-documents-model";
import type { EffectAxis, EffectView, PublicEmissionPage, EmissionView, FiscalBlocker, FiscalChoices, FiscalEnvironment } from "../../src/erp/commercial-nfe/contracts";
import { canCommercialNfe, createCommandIntent, correctionTarget, emissionCanEmit, type CommercialNfePort, type CommercialNfeConfig, CommercialNfeError } from "./commercial-nfe";
import { CommercialNfeChecklist } from "./EmissorSettings";
import { erpPorts } from "./ports";
import { WhatsappSendButton, WhatsappSendDialog } from "./app/components/WhatsappSend";
import { useWhatsappLines, whatsappButtonState } from "./app/lib/whatsapp-send";
import { NfceFiscalPanel } from "./NfceBalcao";
import { NfeEventsPanel } from "./NfeEvents";
import { nfeEventRules } from "../../src/erp/commercial-nfe/events-contracts";
import "./commercial-nfe.css";

const stateLabels: Record<string, string> = { bloqueada: "Preparação bloqueada", preparada: "Preparada para revisão", enviando: "Enviando ao cofre", processando: "Em processamento", incerta: "Resultado incerto", rejeitada: "Rejeitada", autorizada: "Autorizada", denegada: "Denegada", cancelada: "Cancelada", arquivada: "Preparação arquivada" };
const effectLabels: Record<string, string> = { aplicado: "Aplicado", reconhecido: "Efeito anterior reconhecido", pendente: "Pendente", pulado: "Pulado", revertido: "Revertido", compensacao_pendente: "Compensação pendente", transferido: "Transferida para a nova emissão" };
const environmentLabel = (value: FiscalEnvironment) => value === "producao" ? "Produção · valor fiscal real" : "Homologação · sem valor fiscal";
const orderLink = (id: string) => `/documentos-empresa?tipo=sales_orders&documento=${encodeURIComponent(id)}`;
const canUpdate = (view: EmissionView | null) => !view || ["bloqueada", "preparada", "rejeitada"].includes(view.status);
const pending = (view: EmissionView) => ["enviando", "processando", "incerta"].includes(view.status);
const errorText = (error: unknown) => error instanceof Error ? error.message : "Não foi possível concluir a operação.";
const isAborted = (error: unknown) => error instanceof Error && error.name === "AbortError";
const cents = (value: string | null) => {
  if (value === null || !/^\d+$/.test(value)) return "Não informado";
  const digits = value.padStart(3, "0");
  return `R$ ${digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${digits.slice(-2)}`;
};
const fiscalDate = (value: string | null) => {
  if (!value || !/^\d+$/.test(value)) return "Pendente";
  const date = new Date(Number(BigInt(value) / 1000n));
  return Number.isFinite(date.valueOf()) ? date.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "Data não informada";
};

/** Exibe o cálculo recebido; não importa o motor nem constrói o pedido do cofre. */
const fieldLabels: Record<string, string> = {
  name: "Nome", nome: "Nome", description: "Descrição", descricao: "Descrição", document: "Pedido", items: "Itens", itens: "Itens", products: "Produtos", totals: "Totais", total: "Total", total_cents: "Total em centavos", total_amount: "Valor total", total_value: "Valor total", amount: "Valor", value: "Valor", valor: "Valor", valorTotal: "Valor total", valorUnitario: "Valor unitário", unit_price: "Preço unitário", unit: "Unidade", unidade: "Unidade", quantity: "Quantidade", quantidade: "Quantidade", code: "Código", codigo: "Código", position: "Posição", ncm: "NCM", cfop: "CFOP", cst: "CST", csosn: "CSOSN", cest: "CEST", origem: "Origem", origin: "Origem", icms: "ICMS", ipi: "IPI", pis: "PIS", cofins: "COFINS", st: "Substituição tributária", fcp: "FCP", difal: "DIFAL", taxes: "Tributos", tax: "Tributo", base: "Base de cálculo", baseCalculo: "Base de cálculo", rate: "Alíquota (%)", aliquota: "Alíquota (%)", base_rate: "Percentual da base (%)", reduction: "Redução (%)", reducaoBc: "Redução da base (%)", rule: "Regra aplicada", rules: "Regras aplicadas", nature: "Natureza de operação", nature_description: "Natureza de operação", nature_id: "Natureza", tax_sources: "Fontes tributárias", payments: "Pagamentos", pagamentos: "Pagamentos", forma: "Forma fiscal", method: "Forma de pagamento", indicador: "Indicador de pagamento", installments: "Parcelas", due_date: "Vencimento", due_on: "Vencimento", transport: "Transporte", modalidade: "Modalidade de frete", freight: "Frete", frete: "Frete", insurance: "Seguro", seguro: "Seguro", discount: "Desconto", desconto: "Desconto", other_expenses: "Outras despesas", outrasDespesas: "Outras despesas", cnpj: "CNPJ", cpf: "CPF", tax_id: "CPF/CNPJ", state_registration: "Inscrição estadual", inscricaoEstadual: "Inscrição estadual", indicadorIe: "Condição de IE", regime: "Regime tributário", crt: "CRT", address: "Endereço", endereco: "Endereço", street: "Logradouro", logradouro: "Logradouro", number: "Número", numero: "Número", neighborhood: "Bairro", bairro: "Bairro", city: "Município", municipio: "Município", state: "UF", uf: "UF", codigoMunicipio: "Código IBGE", municipality_code: "Código IBGE", postal_code: "CEP", cep: "CEP", email: "E-mail", phone: "Telefone", complemento: "Complemento", series: "Série", version: "Versão", source: "Fonte", sources: "Fontes", id: "Identificador", product_id: "Produto", item_id: "Item", warnings: "Observações", messages: "Mensagens", message: "Mensagem", reason: "Motivo", settled_cents: "Valor recebido em centavos", balance_cents: "Saldo em centavos", title_ids: "Títulos", posting_id: "Lançamento", movement_id: "Movimento", title_received: "Título recebido", part_disabled: "Parte desligada",
};
function ReadOnlyData({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span>Não informado</span>;
  if (typeof value === "boolean") return <span>{value ? "Sim" : "Não"}</span>;
  if (typeof value !== "object") return <span>{String(value)}</span>;
  if (Array.isArray(value)) return value.length ? <ol className="commercial-nfe-values">{value.map((item, i) => <li key={i}><ReadOnlyData value={item} /></li>)}</ol> : <span>Nenhum registro informado</span>;
  return <dl className="commercial-nfe-values">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{fieldLabels[key] ?? key.replace(/_/g, " ")}</dt><dd><ReadOnlyData value={item} /></dd></div>)}</dl>;
}

function Blockers({ blockers, documentId }: { blockers: FiscalBlocker[]; documentId?: string | null }) {
  const target = (blocker: FiscalBlocker) => {
    const destination = correctionTarget(blocker, documentId ?? undefined);
    return documentId && destination.startsWith("/documentos-empresa?") && !destination.includes("documento=") ? `${destination}&documento=${encodeURIComponent(documentId)}` : destination;
  };
  return blockers.length ? <section className="commercial-nfe-blockers" role="alert"><h2>Corrija antes de emitir</h2><ol>{blockers.map((blocker, index) => <li key={`${blocker.code}:${blocker.field}:${index}`}><strong>{blocker.message}</strong><p>Campo: {blocker.field}{blocker.item_id ? ` · Item: ${blocker.item_id}` : ""}</p><Link to={target(blocker)}>Abrir correção</Link></li>)}</ol></section> : null;
}

/**
 * Reforma tributária na NF-e: o cálculo de IBS, CBS e IS guardado na revisão
 * (calculation.reform, src/erp/domains/fiscal/comnfe/taxes.ts), em bloco
 * próprio e informativo. Diz se o grupo vai na nota ou por que não vai (cofre
 * que ainda não recebe a reforma, Simples Nacional, teste de conexão antigo).
 */
function ReformNfeBlock({ calculation }: { calculation: unknown }) {
  const reform = (calculation && typeof calculation === "object" ? (calculation as Record<string, unknown>).reform : null) as ReformNfeView | null | undefined;
  if (!reform || typeof reform !== "object" || !reform.totals) return null;
  const brl = (value: string) => Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  return <section className="commercial-nfe-card" aria-label="Reforma tributária: IBS, CBS e IS">
    <h2>Reforma tributária: IBS, CBS e IS ({reform.year})</h2>
    <p role="status">{reform.sent ? "O grupo IBS/CBS vai na nota." : "A nota sai sem o grupo IBS/CBS."} {reform.message ?? ""}</p>
    <dl><dt>Base</dt><dd>{brl(reform.totals.base)}</dd><dt>CBS</dt><dd>{brl(reform.totals.cbs)}</dd>
      <dt>IBS estadual</dt><dd>{brl(reform.totals.ibs_uf)}</dd><dt>IBS municipal</dt><dd>{brl(reform.totals.ibs_mun)}</dd>
      {reform.rates?.selective && <><dt>Imposto Seletivo</dt><dd>{brl(reform.totals.selective)}</dd></>}</dl>
    <ol>{reform.items.map((item, index) => <li key={index}>{item.description ?? `Item ${index + 1}`}: {item.cst ? `CST ${item.cst}, classificação ${item.cclasstrib}` : "sem classificação"}
      {item.cbs ? ` · CBS ${brl(item.cbs.value)} · IBS ${brl(item.ibs ?? "0")}` : item.message ? ` · ${item.message}` : ""}</li>)}</ol>
    {(reform.notices ?? []).map(notice => <p key={notice.code} className="commercial-nfe-warning">{notice.message}</p>)}
    <p>{reform.informative ? "Em 2026 IBS e CBS são informativos: não mudam o total a pagar da nota." : "O total da nota não soma IBS, CBS e IS nesta versão: confira com o contador."}</p>
  </section>;
}
/**
 * Dados do cadastro que o cofre ainda não recebe e cuja falta não deixa a nota
 * errada (calculation.special_notices, src/erp/domains/fiscal/comnfe/special-groups.ts):
 * pessoas autorizadas a baixar o XML e inscrição Suframa do cliente.
 */
function SpecialNoticesBlock({ calculation }: { calculation: unknown }) {
  const raw = calculation && typeof calculation === "object" ? (calculation as Record<string, unknown>).special_notices : null;
  const notices = Array.isArray(raw) ? raw.filter((notice): notice is { code: string; message: string } => Boolean(notice) && typeof notice === "object" && typeof (notice as { message?: unknown }).message === "string") : [];
  if (!notices.length) return null;
  return <section className="commercial-nfe-card" aria-label="Dados que não vão nesta nota">
    <h2>Dados que não vão nesta nota</h2>
    {notices.map(notice => <p key={notice.code} className="commercial-nfe-warning">{notice.message}</p>)}
  </section>;
}
type ReformNfeView = {
  year: number; sent: boolean; message: string | null; informative: boolean; rates?: { selective?: boolean };
  totals: { base: string; cbs: string; ibs_uf: string; ibs_mun: string; ibs: string; selective: string };
  items: { description: string | null; cst: string | null; cclasstrib: string | null; message: string | null; cbs: { value: string } | null; ibs: string | null }[];
  notices?: { code: string; message: string }[];
};

export default function CommercialNfe({ controller, port: injected }: { controller: AccessController; access?: AccessState; port?: CommercialNfePort }) {
  const location = useLocation();
  const port = injected ?? erpPorts()?.commercialNfe;
  const params = new URLSearchParams(location.search), documentId = params.get("pedido"), emissionId = params.get("emissao");
  if (!port) return <section className="real-state-panel"><h1>NF-e de venda</h1><p>O acompanhamento fiscal ainda não está disponível nesta área. Nenhuma nota foi emitida.</p><Link to="/documentos-empresa?tipo=sales_orders">Abrir pedidos de venda</Link></section>;
  if (!canCommercialNfe(port.access(), "read")) return <section className="real-state-panel"><h1>NF-e de venda indisponível</h1><p>Confira se a parte Fiscal está ligada e se seu perfil tem acesso fiscal. A venda pode continuar sem nota quando Fiscal estiver desligada.</p><Link to="/documentos-empresa?tipo=sales_orders">Voltar aos pedidos</Link></section>;
  return <CommercialWorkspace key={`${port.scopeKey}:${documentId ?? ""}:${emissionId ?? ""}`} port={port} controller={controller} documentId={documentId} emissionId={emissionId} />;
}

function CommercialWorkspace({ port, controller, documentId, emissionId }: { port: CommercialNfePort; controller: AccessController; documentId: string | null; emissionId: string | null }) {
  const [config, setConfig] = useState<CommercialNfeConfig | null>(null);
  const [view, setView] = useState<EmissionView | null>(null);
  const [history, setHistory] = useState<PublicEmissionPage | null>(null);
  const [environment, setEnvironment] = useState<FiscalEnvironment>("homologacao");
  const [page, setPage] = useState(1);
  // ERP pela conversa: a nota autorizada (DANFE e, se pedido, o XML) pela linha de WhatsApp da área.
  const whatsappLines = useWhatsappLines(), whatsappState = whatsappButtonState("nota", whatsappLines);
  const [whatsappSend, setWhatsappSend] = useState<string | null>(null);
  const [order, setOrder] = useState<DocumentRecord | null>(null);
  const [natures, setNatures] = useState<{ id: string; description: string }[]>([]);
  const [choices, setChoices] = useState<FiscalChoices>({ nature_id: "", presence: "", final_consumer: false });
  const [consumer, setConsumer] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [blockers, setBlockers] = useState<FiscalBlocker[]>([]);
  const [uncertain, setUncertain] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [justification, setJustification] = useState("");
  const [cancelConfirmed, setCancelConfirmed] = useState(false);
  const [physicalReturn, setPhysicalReturn] = useState(false);
  const [effectPreview, setEffectPreview] = useState<EffectView[]>([]);
  const [newFiscalVersion, setNewFiscalVersion] = useState(false);
  const [localReadPending, setLocalReadPending] = useState(false);
  const [reload, setReload] = useState(0);
  const lifetime = useRef(new AbortController());
  const active = useRef(false);
  const intents = useRef(new Map<string, { command: ReturnType<typeof createCommandIntent>; args: object }>());
  useEffect(() => { const life = new AbortController(); lifetime.current = life; return () => life.abort(); }, [port]);
  const command = async <T extends object, R,>(key: string, args: T, send: (input: T & { command_id: string }) => Promise<R>, terminal: (result: R) => boolean = () => true) => {
    let saved = intents.current.get(key);
    if (!saved) { saved = { command: createCommandIntent(), args: structuredClone(args) }; intents.current.set(key, saved); }
    try {
      const result = await saved.command.run(saved.args as T, send);
      if (terminal(result)) intents.current.delete(key);
      return result;
    } catch (failure) {
      // Recusa conclusiva permite corrigir a intenção. Resposta perdida conserva
      // os argumentos originais, inclusive versão e justificativa do cancelamento.
      if (failure instanceof CommercialNfeError && !failure.uncertain) intents.current.delete(key);
      throw failure;
    }
  };
  const accept = (next: EmissionView) => { setView(next); setBlockers(next.revision.blockers); setEffectPreview([]); setReviewed(false); setUncertain(false); setLocalReadPending(false); setNewFiscalVersion(false); setJustification(next.cancellation?.justification ?? ""); };

  useEffect(() => {
    const request = new AbortController(), signal = AbortSignal.any([request.signal, lifetime.current.signal]);
    setBusy("Carregando"); setError("");
    void (async () => {
      const settings = await port.config(signal);
      if (signal.aborted) return;
      setConfig(settings); setEnvironment(settings.environment);
      if (emissionId) { const found = await port.read(emissionId, signal); if (!signal.aborted) accept(found); }
      else if (documentId) {
        // Um pedido já usado em outro ambiente abre seu acompanhamento; nunca é reciclado.
        const pages = await Promise.all((["homologacao", "producao"] as const).map(environment => port.list({ environment, document_id: documentId, per_page: 100 }, signal)));
        if (signal.aborted) return;
        const matches = pages.flatMap(p => p.items).sort((a, b) => b.fiscal_version - a.fiscal_version);
        if (matches[0]) { const found = await port.read(matches[0].id, signal); if (!signal.aborted) accept(found); }
      }
    })().catch(failure => { if (!signal.aborted) setError(errorText(failure)); }).finally(() => { if (!signal.aborted) setBusy(""); });
    return () => request.abort();
  }, [port, documentId, emissionId, reload]);

  useEffect(() => {
    if (!config || documentId || emissionId) return;
    const request = new AbortController();
    setHistory(null); setError("");
    void port.list({ environment, page, per_page: 25 }, request.signal).then(next => { if (!request.signal.aborted) setHistory(next); }, failure => { if (!request.signal.aborted) setError(errorText(failure)); });
    return () => request.abort();
  }, [port, config, environment, page, documentId, emissionId]);

  const selectedOrder = view?.document_id ?? documentId;
  const preparationAllowed = canCommercialNfe(port.access(), "prepare") && (canUpdate(view) || newFiscalVersion) && !uncertain && !intents.current.has("prepare");
  useEffect(() => {
    if (!selectedOrder || !preparationAllowed) return;
    const request = new AbortController();
    void Promise.all([
      controller.documents(`/v1/documentos/sales_orders/${encodeURIComponent(selectedOrder)}`, { signal: request.signal }),
      controller.fiscalInvoices("/v1/notas-fiscais/naturezas?active=true&limit=100", { signal: request.signal }),
    ]).then(([rawOrder, rawNatures]) => {
      if (request.signal.aborted) return;
      const record = (rawOrder as { document: DocumentRecord }).document;
      if (!record || record.id !== selectedOrder || record.kind !== "sales_orders" || !Number.isSafeInteger(record.version)) throw new Error("Não foi possível conferir o pedido salvo.");
      setOrder(record);
      setNatures(((rawNatures as { items?: { id: string; description: string }[] }).items ?? []).filter(n => typeof n.id === "string" && typeof n.description === "string"));
    }).catch(failure => { if (!request.signal.aborted) setError(errorText(failure)); });
    return () => request.abort();
  }, [controller, selectedOrder, preparationAllowed, reload]);

  const perform = async (label: string, action: (signal: AbortSignal) => Promise<void>, mayBeUncertain = true) => {
    if (active.current || lifetime.current.signal.aborted) return;
    active.current = true; setBusy(label); setError("");
    const signal = lifetime.current.signal;
    try { await action(signal); }
    catch (failure) {
      if (signal.aborted || isAborted(failure)) return;
      setError(errorText(failure));
      if (failure instanceof CommercialNfeError && failure.blockers.length) { setBlockers(failure.blockers); setReviewed(false); }
      if (mayBeUncertain && (!(failure instanceof CommercialNfeError) || failure.uncertain)) setUncertain(true);
    } finally { active.current = false; if (!signal.aborted) setBusy(""); }
  };
  const prepare = (retry = false) => {
    if (!order || !canCommercialNfe(port.access(), "prepare") || (!retry && (!preparationAllowed || !choices.nature_id || !choices.presence || !consumer)) || (retry && !intents.current.has("prepare"))) return;
    void perform("Preparando", async signal => {
      const result = await command("prepare", { document_id: order.id, expected_document_version: order.version, choices: { ...choices, final_consumer: consumer === "yes" }, ...(view ? { expected_emission_version: view.version } : {}), ...(newFiscalVersion ? { new_fiscal_version: true } : {}) }, input => port.prepare(input, signal));
      if (signal.aborted) return;
      accept(result.emission); setBlockers(result.blockers); setEffectPreview(result.effects_preview);
    });
  };
  const emit = () => {
    if (!view || uncertain || !reviewed || blockers.length || !emissionCanEmit(view, port.access())) return;
    void perform("Enviando", async signal => {
      const next = await command(`emit:${view.id}`, { emission_id: view.id, expected_version: view.version, body_revision: view.current_body_revision, body_hash: view.revision.body_hash! }, input => port.emit(input, signal));
      if (!signal.aborted) accept(next);
    });
  };
  const resume = () => {
    if (!view || !canCommercialNfe(port.access(), "resume")) return;
    void perform("Consultando a mesma emissão", async signal => {
      const next = await command(`resume:${view.id}`, { emission_id: view.id, expected_version: view.version, body_revision: view.current_body_revision }, input => port.resume(input, signal));
      if (!signal.aborted) { accept(next); if (!pending(next)) intents.current.delete(`emit:${view.id}`); }
    });
  };
  const cancel = () => {
    if (!view || !canCommercialNfe(port.access(), "cancel") || !cancelConfirmed || [...justification.trim()].length < 15 || [...justification.trim()].length > 255) return;
    void perform("Cancelando no cofre", async signal => {
      const next = await command(`cancel:${view.id}`, { emission_id: view.id, expected_version: view.version, justification: justification.trim() }, input => port.cancel(input, signal), result => ["registrado", "recusado"].includes(result.cancellation?.state ?? ""));
      if (!signal.aborted) { accept(next); if (next.cancellation?.state === "registrado" || next.cancellation?.state === "recusado") setCancelOpen(false); }
    });
  };
  const effect = (axis: EffectAxis, action: "reconcile" | "apply" | "apply_skipped" | "reverse") => {
    if (!view || localReadPending || !canCommercialNfe(port.access(), axis === "stock" ? "effect_stock" : "effect_finance") || (axis === "stock" && action === "reverse" && !physicalReturn)) return;
    void perform("Conferindo efeito local", async signal => {
      setLocalReadPending(true);
      const result = await command(`effect:${view.id}:${axis}:${action}`, { emission_id: view.id, expected_version: view.version, axis, intent: action, ...(axis === "stock" && action === "reverse" ? { physical_return_confirmed: true } : {}) }, input => port.effects(input, signal));
      if (signal.aborted) return;
      setView(previous => previous && ({ ...previous, effects: [...previous.effects.filter(e => e.axis !== axis), result] }));
      // O efeito pode incrementar a versão técnica; sempre reler antes do próximo comando.
      const next = await port.read(view.id, signal); if (!signal.aborted) accept(next);
    }, false);
  };
  const download = (kind: "danfe" | "xml" | "cancellation_xml") => {
    if (!view) return;
    void perform("Obtendo arquivo do cofre", async signal => {
      const file = await port.artifact(view.id, kind, signal); if (signal.aborted) return;
      const url = URL.createObjectURL(file), link = document.createElement("a");
      link.href = url; link.download = `${kind}-${view.id}.${kind === "danfe" ? "pdf" : "xml"}`;
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    }, false);
  };

  const fiscalEnvironment = view?.environment ?? (selectedOrder ? config?.environment ?? environment : environment);
  const effects = view?.effects.length ? view.effects : effectPreview;
  const cancellationPending = view?.cancellation && ["pedido", "enviando", "incerto"].includes(view.cancellation.state);
  // Prazo de cancelamento em palavras: fora dele, a tela diz por que e o que fazer (devolução ou carta).
  const cancelRule = view && view.status === "autorizada" && !cancellationPending ? nfeEventRules({ model: "nfe", status: view.status, authorized_at: view.authorized_at,
    cancellation_state: view.cancellation?.state ?? null, corrections_registered: 0, corrections_in_flight: false, returnable: true, now: BigInt(Date.now()) * 1000n }).cancel : null;
  const cancelBlocked = cancelRule && !cancelRule.allowed ? cancelRule : null;
  return <section className="commercial-nfe" aria-busy={Boolean(busy)}>
    <header><h1>NF-e de venda</h1><p>Preparação integral de um pedido · modelo 55</p><nav><Link to="/historico-fiscal?modelo=55">Histórico comercial</Link><Link to="/historico-fiscal?modelo=55&acervo=legado">Acervo legado · consulta</Link><Link to="/certificado-a1">Configuração do emissor</Link></nav></header>
    <p className={`commercial-nfe-environment ${fiscalEnvironment === "producao" ? "production" : ""}`}>{environmentLabel(fiscalEnvironment)}</p>
    {fiscalEnvironment === "homologacao" && <p className="commercial-nfe-warning">Homologação pode movimentar estoque, títulos e recebimentos comerciais reais nesta área, conforme as políticas. Use uma área dedicada e dados de teste. O DANFE não tem valor fiscal de produção.</p>}
    {config && !config.connection_fingerprint && !view && <p className="commercial-nfe-warning">Configure o endereço e a chave do cofre para emitir esta nota. Confira e salve a conexão em <Link to="/certificado-a1">Configuração do emissor</Link>.</p>}
    {error && <p className="real-alert" role="alert">{error}</p>}
    {busy && <p role="status">{busy}…</p>}
    {uncertain && <section className="commercial-nfe-warning" role="status"><h2>Resultado incerto</h2><p>A resposta não foi confirmada. A operação pode ter sido recebida. Consulte a mesma emissão; não crie outra nota.</p>{!view && <button type="button" disabled={Boolean(busy)} onClick={() => setReload(n => n + 1)}>Localizar preparação do pedido</button>}{intents.current.has("prepare") && <button type="button" disabled={Boolean(busy)} onClick={() => prepare(true)}>Repetir a mesma preparação</button>}</section>}
    {localReadPending && <p className="commercial-nfe-warning" role="status">O resultado do efeito local precisa ser conferido. Atualize o acompanhamento antes de aplicar outro efeito. <button type="button" disabled={Boolean(busy)} onClick={() => setReload(n => n + 1)}>Conferir efeitos registrados</button></p>}
    {!uncertain && intents.current.has("prepare") && <p className="commercial-nfe-warning">Confira o resultado da preparação pendente antes de alterar as escolhas. <button type="button" disabled={Boolean(busy)} onClick={() => prepare(true)}>Repetir a mesma preparação</button></p>}
    <Blockers blockers={blockers} documentId={selectedOrder} />
    {view && <ReformNfeBlock calculation={view.revision.calculation} />}
    {view && <SpecialNoticesBlock calculation={view.revision.calculation} />}
    {view ? <>
      <section className="commercial-nfe-card" aria-label="Situação fiscal"><h2>{stateLabels[view.status]}</h2><p><Link to={orderLink(view.document_id)}>Abrir pedido de venda</Link> · Versão fiscal {view.fiscal_version} · Revisão {view.current_body_revision}</p><p>Referência: <span className="commercial-nfe-code">{view.reference}</span></p>
        {view.environment !== config?.environment && <p>Esta emissão permanece em {environmentLabel(view.environment)}. A configuração atual da área não altera sua origem.</p>}
        {view.messages.map((message, index) => <p key={index} role="status">{message.code}: {message.description}</p>)}
        {["autorizada", "cancelada"].includes(view.status) && <><dl><dt>Número / série do cofre</dt><dd>{view.number} / {view.series}</dd><dt>Chave</dt><dd className="commercial-nfe-code">{view.access_key}</dd><dt>Protocolo de autorização</dt><dd>{view.protocol}</dd><dt>Autorizada em</dt><dd>{fiscalDate(view.authorized_at)}</dd><dt>Total fiscal</dt><dd>{cents(view.total)}</dd></dl><div className="commercial-nfe-actions"><button type="button" disabled={Boolean(busy)} onClick={() => download("danfe")}>Baixar DANFE do cofre</button><button type="button" disabled={Boolean(busy)} onClick={() => download("xml")}>Baixar XML da NF-e</button></div>
          {view.status === "autorizada" && <WhatsappSendButton type="nota" id={view.id} />}</>}
        {(pending(view) || uncertain) && <p>Consulte ou retome a mesma referência. Não altere o pedido, o ambiente ou o cofre enquanto o resultado estiver inconclusivo.</p>}
        {canCommercialNfe(port.access(), "resume") && <button type="button" disabled={Boolean(busy)} onClick={resume}>Consultar / retomar</button>}
      </section>
      <section className="commercial-nfe-review"><h2>Revisão produzida pelo servidor</h2><p>Preparada por {view.revision.prepared_by} em {fiscalDate(view.revision.prepared_at)}.</p><p>Dados somente para leitura. Cadastro e cálculo estão congelados nesta revisão. Correções exigem salvar na tela indicada e atualizar a preparação antes de emitir.</p>
        {([ ["Emitente", view.revision.snapshot.company], ["Cliente", view.revision.snapshot.recipient], ["Itens do pedido", view.revision.snapshot.items], ["Natureza e regras", view.revision.snapshot.nature], ["Cálculo: bases, alíquotas, tributos e totais", view.revision.calculation], ["Pagamentos e parcelas", view.revision.snapshot.payments], ["Transporte", view.revision.snapshot.transport], ["Fontes e versões dos dados", view.revision.snapshot.sources], ["Fontes tributárias", view.revision.tax_sources] ] as [string, unknown][]).map(([title, value]) => <details key={title} open={title.startsWith("Cálculo")}><summary>{title}</summary><ReadOnlyData value={value} /></details>)}
      </section>
      {emissionCanEmit(view, port.access()) && !uncertain && <section className="commercial-nfe-card"><h2>Confirmar emissão</h2><p>{environmentLabel(view.environment)} · {cents(view.total)} · Revisão {view.current_body_revision}</p><label><input id="commercial-reviewed" type="checkbox" checked={reviewed} disabled={Boolean(busy)} onChange={event => setReviewed(event.target.checked)} /> Conferi o resumo, o cálculo, os bloqueios e o ambiente. Autorizo enviar esta revisão ao cofre e compreendo os efeitos comerciais.</label><button type="button" disabled={Boolean(busy) || !reviewed || blockers.length > 0} onClick={emit}>Emitir NF-e</button></section>}
      <section><h2>Efeitos comerciais locais</h2><p>{view.status === "cancelada" ? "O cancelamento fiscal foi registrado; confira separadamente as compensações locais." : view.status === "autorizada" ? "A autorização fiscal permanece válida mesmo quando há pendências locais." : "Estes resultados locais não comprovam autorização fiscal."} Gerar títulos não registra recebimento.</p><div className="commercial-nfe-grid">{(["stock", "finance"] as const).map(axis => {
        const item = effects.find(e => e.axis === axis), allowed = canCommercialNfe(port.access(), axis === "stock" ? "effect_stock" : "effect_finance");
        return <article className="commercial-nfe-card" key={axis}><h3>{axis === "stock" ? "Estoque" : "Financeiro"}</h3><p>{item ? effectLabels[item.state] : "Sem resultado local registrado"}</p><p>Responsável: {item?.responsible_role === "admin" ? "Administrador" : axis === "stock" ? "Estoque ou administrador" : "Financeiro ou administrador"}{item?.person_id ? ` · ${item.person_id}` : ""}</p>
          {item?.reason && <p>{item.reason === "part_disabled" ? "Parte desligada. Religar não aplica o efeito automaticamente." : item.reason}</p>}{item && <ReadOnlyData value={item.ids} />}{item?.result && <ReadOnlyData value={item.result} />}
          {item?.compensation_state && <><h4>Compensação: {effectLabels[item.compensation_state]}</h4><ReadOnlyData value={item.compensation_result} /></>}
          <Link to={axis === "stock" ? orderLink(view.document_id) : "/financeiro-empresa?area=receivable"}>{axis === "stock" ? "Conferir depósito, saldo e reserva no pedido" : "Abrir contas a receber e recebimentos"}</Link>
          {allowed && view.status === "autorizada" && <div className="commercial-nfe-actions"><button type="button" disabled={Boolean(busy) || localReadPending} onClick={() => effect(axis, "reconcile")}>Conciliar {axis === "stock" ? "estoque" : "financeiro"}</button>{(!item || ["pendente", "pulado"].includes(item.state)) && <button type="button" disabled={Boolean(busy) || localReadPending} onClick={() => effect(axis, item?.state === "pulado" ? "apply_skipped" : "apply")}>{item?.state === "pulado" ? "Aplicar efeito pulado" : "Aplicar efeito pendente"}</button>}</div>}
          {item?.compensation_state === "transferido" && <p>A nova emissão deste pedido reconheceu o lançamento e responde por ele; esta nota cancelada não o estorna.</p>}
          {allowed && view.status === "cancelada" && !["revertido", "transferido"].includes(item?.compensation_state ?? "") && <>{axis === "stock" && <label><input id="commercial-physical-return" type="checkbox" checked={physicalReturn} onChange={event => setPhysicalReturn(event.target.checked)} /> Confirmei o retorno físico e que o estoque pode ser revertido.</label>}<button type="button" disabled={Boolean(busy) || localReadPending || (axis === "stock" && !physicalReturn)} onClick={() => effect(axis, "reverse")}>Conferir compensação de {axis === "stock" ? "estoque" : "financeiro"}</button></>}
        </article>;
      })}</div></section>
      {view.cancellation && <section className="commercial-nfe-card"><h2>Cancelamento fiscal</h2><p>Situação do evento: {({ pedido: "Solicitado", enviando: "Enviando", incerto: "Resultado incerto", recusado: "Recusado", registrado: "Registrado" })[view.cancellation.state]}</p><p>Justificativa: {view.cancellation.justification}</p><p>Protocolo do evento: {view.cancellation.protocol ?? "Pendente"}</p><p>Data do evento: {fiscalDate(view.cancellation.event_at)}</p>{view.cancellation.messages.map((message, index) => <p key={index}>{message.description}</p>)}{view.cancellation.xml_status === "disponivel" ? <button type="button" disabled={Boolean(busy)} onClick={() => download("cancellation_xml")}>Baixar XML do cancelamento</button> : <p>{view.status === "cancelada" ? "Nota cancelada; XML do evento pendente de arquivamento" : "XML do cancelamento ainda não disponível"}</p>}</section>}
      {cancelBlocked && <section className="commercial-nfe-card"><h2>Cancelamento fora do prazo</h2><p className="commercial-nfe-warning" role="status">{cancelBlocked.reason}</p></section>}
      {["autorizada", "cancelada"].includes(view.status) && <NfeEventsPanel port={port} emission={view} />}
      {!cancelBlocked && canCommercialNfe(port.access(), "cancel") && (view.status === "autorizada" || cancellationPending) && <section className="commercial-nfe-card"><button type="button" disabled={Boolean(busy)} onClick={() => { setCancelOpen(true); setJustification(view.cancellation?.justification ?? (intents.current.get(`cancel:${view.id}`)?.args as { justification?: string } | undefined)?.justification ?? ""); }}>{cancellationPending ? "Retomar cancelamento" : "Cancelar NF-e"}</button>{cancelOpen && <><p className="commercial-nfe-warning">O cancelamento fiscal não garante reversão de estoque, títulos ou cobrança. Títulos recebidos, cobrança vinculada e faturamento agrupado exigem tratamento separado. Pagamentos não serão estornados automaticamente. O estoque exige confirmação do retorno físico.</p><label htmlFor="commercial-justification">Justificativa (15 a 255 caracteres)</label><textarea id="commercial-justification" value={justification} disabled={Boolean(busy) || Boolean(cancellationPending) || intents.current.has(`cancel:${view.id}`)} maxLength={255} onChange={event => setJustification(event.target.value)} /><label><input id="commercial-cancel-confirmed" type="checkbox" checked={cancelConfirmed} disabled={Boolean(busy)} onChange={event => setCancelConfirmed(event.target.checked)} /> Compreendo as compensações pendentes e confirmo o cancelamento fiscal.</label><button type="button" disabled={Boolean(busy) || !cancelConfirmed || [...justification.trim()].length < 15 || [...justification.trim()].length > 255} onClick={cancel}>Confirmar cancelamento no cofre</button></>}</section>}
    </> : selectedOrder ? <p>Pedido selecionado: <Link to={orderLink(selectedOrder)}>{order?.number ?? selectedOrder}</Link></p> : <section><h2>Histórico por ambiente</h2><label htmlFor="commercial-environment">Ambiente do histórico</label><select id="commercial-environment" value={environment} onChange={event => { setEnvironment(event.target.value as FiscalEnvironment); setPage(1); }}><option value="homologacao">Homologação</option><option value="producao">Produção</option></select><p>O acervo legado fica separado. Valores de homologação não compõem o total fiscal de produção.</p>{history ? <><ul>{history.items.map(item => <li key={item.id}><Link to={`/historico-fiscal?modelo=55&emissao=${encodeURIComponent(item.id)}`}>{item.number ? `NF-e ${item.number}/${item.series}` : `Pedido ${item.document_id}`} · {stateLabels[item.status]} · {cents(item.total)}</Link>{item.status === "autorizada" && whatsappState && <> <button type="button" className="text-button" disabled={whatsappState.disabled} title={whatsappState.title} onClick={() => setWhatsappSend(item.id)}>Enviar pelo WhatsApp</button></>}</li>)}</ul>{whatsappSend && <WhatsappSendDialog type="nota" id={whatsappSend} onClose={() => setWhatsappSend(null)} />}{history.items.length === 0 && <p>Nenhuma emissão neste ambiente.</p>}<div className="commercial-nfe-actions"><button type="button" disabled={page === 1} onClick={() => setPage(n => n - 1)}>Página anterior</button><span>Página {page}</span><button type="button" disabled={page * history.per_page >= history.total} onClick={() => setPage(n => n + 1)}>Próxima página</button></div></> : <p>Carregando histórico…</p>}<Link to="/documentos-empresa?tipo=sales_orders">Escolher pedido de venda salvo</Link><NfceFiscalPanel /></section>}
    {view && ["cancelada", "denegada"].includes(view.status) && view.environment === config?.environment && canCommercialNfe(port.access(), "prepare") && !newFiscalVersion && <section className="commercial-nfe-card"><h2>Nova versão fiscal</h2><p>O histórico anterior será preservado. Esta ação inicia uma nova preparação e exige nova revisão antes de enviar outra nota.</p><button type="button" disabled={Boolean(busy)} onClick={() => setNewFiscalVersion(true)}>Preparar nova versão fiscal deste pedido</button></section>}
    {selectedOrder && preparationAllowed && <section className="commercial-nfe-card"><h2>{view ? "Atualizar preparação e revisar" : "Preparar pedido salvo"}</h2><p>Confira as escolhas fiscais. Valores, destinatário e impostos são obtidos no servidor a partir do pedido salvo.</p><fieldset disabled={Boolean(busy) || !order}><legend>Escolhas fiscais permitidas</legend><label htmlFor="commercial-nature">Natureza de operação</label><select id="commercial-nature" value={choices.nature_id} onChange={event => setChoices(previous => ({ ...previous, nature_id: event.target.value }))}><option value="">Selecione</option>{natures.map(nature => <option value={nature.id} key={nature.id}>{nature.description}</option>)}</select><Link to="/naturezas-operacao">Conferir naturezas e regras</Link><label htmlFor="commercial-presence">Presença do comprador</label><select id="commercial-presence" value={choices.presence} onChange={event => setChoices(previous => ({ ...previous, presence: event.target.value }))}><option value="">Selecione explicitamente</option>{[["nao_se_aplica", "Não se aplica"], ["presencial", "Presencial"], ["internet", "Internet"], ["teleatendimento", "Teleatendimento"], ["entrega_domicilio", "Entrega em domicílio"], ["presencial_fora", "Presencial fora do estabelecimento"], ["outros", "Outros"]].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><label htmlFor="commercial-consumer">Consumidor final</label><select id="commercial-consumer" value={consumer} onChange={event => setConsumer(event.target.value)}><option value="">Selecione explicitamente</option><option value="yes">Sim</option><option value="no">Não</option></select><p>A série será resolvida pelo cofre ou pela seleção permitida na configuração. Não há numeração local.</p><button type="button" disabled={!choices.nature_id || !choices.presence || !consumer} onClick={() => prepare()}>{view ? "Atualizar preparação" : "Preparar NF-e"}</button></fieldset></section>}
    {selectedOrder && <CommercialNfeChecklist />}
    {!busy && error && !uncertain && <button type="button" onClick={() => setReload(n => n + 1)}>Atualizar acompanhamento</button>}
    <p className="commercial-nfe-scope">Aqui sai a NF-e (modelo 55) de uma venda integral de mercadorias. A NFC-e sai pela frente de caixa e a nota da ordem de serviço, pela própria ordem; emissão avulsa, parcial e agrupada não são feitas aqui. Certificado, numeração, assinatura, transmissão e DANFE ficam no emissor de notas.</p>
  </section>;
}
