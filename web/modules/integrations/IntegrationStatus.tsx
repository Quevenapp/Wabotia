import React, { lazy, Suspense, useEffect, useState } from "react";
import { Button, Field } from "../../ui";
import { integrationError, useIntegrationApi } from "./api";
import { integrationAccess, operationalHref, sourceHref, useIntegrationHost } from "./visibility";
import { MODULE_LABELS, type IntegrationModule, type IntegrationState, type SourceState, type ModuleStatus, type SourceView } from "./contracts";
import { CommercialPolicyPanel } from "./CommercialPolicyPanel";
import { DeliveryCommercialForm, ReceiptForm, ReceiptReverseForm } from "./ReceiptForm";

export const STATE_LABELS: Record<IntegrationState | SourceState, string> = { none: "Sem lançamento no ERP", skipped: "Lançamento pulado", uncertain: "Confirmação ERP incerta", off: "Operação local", pending: "Pendente no ERP", sending: "Aguardando confirmação ERP", waiting_manual: "Aguardando lançamento manual", blocked: "Pendente de correção", failed: "Falhou", done: "Confirmado no ERP" };
export function integrationReason(reason: string | null | undefined) {
  const reasons: Record<string, string> = {
    part_disabled: "A parte necessária estava desligada. O administrador pode revisar as partes habilitadas; religar não lança dívidas antigas automaticamente.",
    automation_off: "A automação estava desligada. O administrador pode revisar a política e os destinos disponíveis para lançamento manual.",
    awaiting_fiscal_authorization: "O pedido foi registrado sem lançar estoque ou contas: a política exige autorização fiscal. A emissão de NF-e para pedidos de módulos ainda não está disponível; o administrador deve revisar a política antes de um lançamento manual.",
    fiscal_order_transition_locked: "Há uma emissão fiscal enviada para este pedido. Confira a emissão antes de cancelar a origem.",
    fiscal_order_compensation_required: "O cancelamento fiscal exige conferência dos efeitos antes de cancelar a origem.",
    historical_origin_unlinked: "A obrigação não tem vínculo no ERP. A equipe financeira deve conferir a origem, sem criar dívida retroativa.",
    obligation_reactivation_required: "Recebimento depois do cancelamento: recompor a obrigação. A equipe financeira deve conferir a obrigação e conciliar o recebimento; a operação local foi concluída.",
    payment_evidence_required: "A operação local foi concluída. Consulte novamente a confirmação do provedor para conciliar o recebimento no ERP.",
    module_cancellation_pending: "Cancelamento pendente: a equipe autorizada deve estornar os efeitos restantes pela origem.",
    refund_required: "Devolva o valor recebido e confirme o estorno pela origem para concluir o cancelamento.",
    consumption_requires_classification: "Classifique o material consumido como perda ou devolução ao estoque para concluir o cancelamento.",
    refund_confirmed_review_stock: "O valor foi devolvido. Classifique o material como perda ou devolução ao estoque para concluir o cancelamento.",
    commercial_correction_required: "Confira e corrija a obrigação no ERP antes de emitir a cobrança com desconto.",
    waiting_manual: "Aguardando uma pessoa autorizada lançar os destinos disponíveis.",
  };
  return reason ? reasons[reason] ?? integrationError({ code: reason }) : "A equipe autorizada deve conferir a pendência na origem.";
}
export const confirmationTime = (value: number | null) => value == null ? "Ainda não confirmada" : new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
export function actionableEvent(view: SourceView) { return view.deliveries.find(d => d.state !== "done") ?? view.deliveries.at(-1); }

export function IntegrationStatus({ module, sourceId, compact = false }: { module: IntegrationModule; sourceId?: string; compact?: boolean }) {
  const host = useIntegrationHost(), api = useIntegrationApi();
  const allowed = !!host && integrationAccess(host.context).module(module);
  const [data, setData] = useState<{ api: typeof api; key: string; view?: SourceView; status?: ModuleStatus } | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [reload, setReload] = useState(0), [review, setReview] = useState(false);
  const [reason, setReason] = useState("commercial_correction");
  const key = `${module}:${sourceId ?? ""}`;
  useEffect(() => {
    setError(""); setReview(false);
    if (!api || !allowed) return;
    const request = new AbortController();
    const load = sourceId ? api.source(module, sourceId, request.signal).then(view => ({ view })) : api.status(module, request.signal).then(status => ({ status }));
    void load.then(value => { if (!request.signal.aborted) setData({ api, key, ...value }); }).catch(e => { if (!request.signal.aborted) setError(integrationError(e)); });
    return () => request.abort();
  }, [api, allowed, key, reload]);
  if (!host || !allowed || !api) return sourceId ? <p>Operação local. A integração ERP está indisponível neste contexto.</p> : null;
  const access = integrationAccess(host.context), view = data?.api === api && data.key === key ? data.view : undefined, status = data?.api === api && data.key === key ? data.status : undefined;
  const pending = sourceId ? api.pending(key) : null;
  const canResume = pending?.path.endsWith("/post")
    ? ((pending.body as { destinations?: string[] }).destinations ?? []).every(d => d === "finance" ? access.finance : access.postStock)
    : access.write(module) && (access.documents || access.stock || access.finance);
  const event = view && actionableEvent(view);
  const run = async (operation: () => Promise<unknown>, correction = false, refresh = true) => {
    setBusy(true); setError("");
    try { await operation(); setReview(false); if (refresh) setReload(n => n + 1); }
    catch (e) { setError(integrationError(e)); if (correction) setReview(true); }
    finally { setBusy(false); }
  };
  return <section className="card" aria-label={`Integração · ${MODULE_LABELS[module]}`}>
    <h3>{view ? STATE_LABELS[view.state] : `Integração · ${MODULE_LABELS[module]}`}</h3>
    <p>A situação operacional e a confirmação ERP são independentes.</p>
    {error && <p role="alert">{error}</p>}
    {!view && !status && !error && <p role="status">Consultando confirmação…</p>}
    {view && <>
      {view.state === "skipped" && <p role="status">{integrationReason(view.skipped_reason ?? view.reason_code)}</p>}
      {view.state === "blocked" && <p role="alert">{integrationReason(view.reason_code ?? view.blocked_reason ?? view.error_code ?? event?.error_code)}</p>}
      {view.state === "uncertain" && <p role="status">O envio foi feito, mas a resposta se perdeu. Aguarde a conferência do mesmo comando antes de corrigir.</p>}
      {!!view.applied?.length && <p>Destinos aplicados: {(view.applied ?? []).map(d => d === "finance" ? "Financeiro" : d === "stock" ? "Estoque" : "Documento").join(", ") || "consulte os vínculos abaixo"}.</p>}
      <p>Última confirmação: {confirmationTime(view.confirmed_ms)} (horário de São Paulo).</p>
      {!access.finance && view.pending && <p>Existe uma pendência. Detalhes financeiros são restritos à equipe autorizada.</p>}
      {access.finance && view.state !== "blocked" && event?.error_code && <p role="alert">Falhou: {integrationError({ code: event.error_code })}</p>}
      {view.links.filter(l => l.kind === "document").map(link => <p key={link.id}><a href={`/app/erp/documentos-empresa?${new URLSearchParams({ tipo: module === "os" ? "service_orders" : "sales_orders", documento: link.id })}`}>Abrir documento ERP · somente leitura</a></p>)}
      {access.finance && view.links.filter(l => l.kind === "title").map(link => <p key={link.id}>Título confirmado: {link.id}</p>)}
      {pending ? <><p role="status">A confirmação da ação anterior não foi recebida. A retomada desta tela não enviou nenhum comando.</p>{canResume && <Button disabled={busy} onClick={() => void run(() => api.resumeSource(module, sourceId!))}>Repetir a mesma ação</Button>}</> : <>
        {event && typeof event.seq === "number" && view.pending && (access.documents || access.stock || access.finance) && access.write(module) && <Button disabled={busy} onClick={() => void run(() => api.sourceAction(module, sourceId!, "retry", { event_id: event.id }))}>Tentar novamente</Button>}
        {event && view.manual_destinations.map(destination => <Button key={destination} disabled={busy} onClick={() => void run(() => api.sourceAction(module, sourceId!, "post", { event_id: event.id, version: view.revision, destinations: [destination] }))}>{`Lançar ${destination === "stock" ? "estoque" : "financeiro"} manualmente`}</Button>)}
        {event && typeof event.seq === "number" && view.pending && (access.documents || access.stock || access.finance) && access.write(module) && <Button secondary disabled={busy} onClick={() => setReview(true)}>Corrigir pendência</Button>}
      </>}
      {review && !pending && <div role="group" aria-label="Confirmar correção">
        <p>O servidor validará a correção, reservará a mesma solicitação e consultará o recibo antes de fechar o comando anterior. Se ele já foi aplicado, a correção será interrompida para revisão.</p>
        <Field label="Motivo comercial" value={reason} onChange={setReason} emptyOption={null} options={[{ id: "commercial_correction", name: "Corrigir dados comerciais" }, { id: "default_correction", name: "Corrigir padrão ausente" }, { id: "catalog_correction", name: "Corrigir vínculo de catálogo" }]} />
        <Button disabled={busy} onClick={() => void run(() => api.sourceAction(module, sourceId!, "replace", { event_id: event!.id, reason_code: reason }), true)}>Confirmar fechamento e correção</Button>
        <Button secondary disabled={busy} onClick={() => setReview(false)}>Voltar</Button>
      </div>}
    </>}
    {status && <><ul>{status.counters.map(c => <li key={c.state}>{STATE_LABELS[c.state]}: {c.count}</li>)}</ul>{!compact && <ul>{Object.values(status.activations).map(a => <li key={a.module_id}>{a.module_id} · época {a.epoch} · corte: {confirmationTime(a.enabled_since_ms)}</li>)}</ul>}</>}
    {status?.scope === "page" && <p>Contadores das origens desta página.</p>}
    {status?.next_cursor && <Button secondary disabled={busy} onClick={() => void run(async () => {
      const next = await api.status(module, undefined, status.next_cursor!); setData({ api, key, status: next });
    }, false, false)}>Próximas origens</Button>}
    <Button secondary disabled={busy} onClick={() => setReload(n => n + 1)}>Atualizar confirmação</Button>
    {compact && <a href={sourceHref({ profile: "", module, source_id: sourceId ?? "", component: "main" })}>Abrir integrações</a>}
  </section>;
}

export function IntegrationsPage({ search = "" }: { search?: string }) {
  const host = useIntegrationHost();
  const query = new URLSearchParams(search), requested = query.get("module");
  const available = host ? (Object.keys(MODULE_LABELS) as IntegrationModule[]).filter(m => integrationAccess(host.context).module(m)) : [];
  const [selected, setSelected] = useState<IntegrationModule | "">(requested && Object.hasOwn(MODULE_LABELS, requested) ? requested as IntegrationModule : "");
  const [id, setId] = useState(query.get("source") ?? ""), [opened, setOpened] = useState(query.get("source") ?? "");
  const module = selected || available[0];
  return <div className="management-page"><h2>Integrações</h2>
    <CommercialPolicyPanel />
    {module && available.includes(module) && <>
      <Field label="Módulo" value={module} onChange={value => { setSelected(value as IntegrationModule); setOpened(""); setId(""); }} emptyOption={null} options={available.map(id => ({ id, name: MODULE_LABELS[id] }))} />
      <IntegrationStatus key={module} module={module} />
      <form onSubmit={e => { e.preventDefault(); setOpened(id.trim()); }}><Field label="Identificador da origem" value={id} onChange={setId} required /><Button type="submit">Consultar origem</Button></form>
      {opened && <><IntegrationStatus key={module + opened} module={module} sourceId={opened} /><OriginOperationLink module={module} id={opened} /></>}
      {opened && (module === "agenda" || module === "reserva") && <ReceiptForm key={module + opened} module={module} sourceId={opened} />}
      {opened && module === "entrega" && <DeliveryCommercialForm key={opened} id={opened} />}
    </>}
    {requested && !available.includes(requested as IntegrationModule) && <p>Este módulo está desligado ou seu perfil não permite consultá-lo.</p>}
    <ReceiptReverseForm />
  </div>;
}
const OriginOrderDetail = lazy(() => import("../pedido/OrdersPage").then(value => ({ default: value.OrderDetail })));
function OriginOperationLink({ module, id }: { module: IntegrationModule; id: string }) {
  const host = useIntegrationHost();
  const [orderOpen, setOrderOpen] = useState(false);
  const [workType, setWorkType] = useState<string | null>(null);
  useEffect(() => {
    if (!host || module !== "os" || !integrationAccess(host.context).module(module)) return;
    const request = new AbortController();
    void host.api(`${host.root}/service-orders/${encodeURIComponent(id)}?history=none`, "GET", undefined, request.signal).then(row => { if (!request.signal.aborted) setWorkType(row.type_id); }).catch(() => {});
    return () => request.abort();
  }, [host, module, id]);
  if (!host) return null;
  if (module === "pedido") return <><Button secondary onClick={() => setOrderOpen(true)}>Abrir pedido</Button>{orderOpen && <Suspense fallback={<p>Abrindo pedido…</p>}><OriginOrderDetail id={id} onClose={() => setOrderOpen(false)} onChanged={() => {}} /></Suspense>}</>;
  if (module === "entrega") return null;
  if (module === "os") return workType ? <a href={`/app/erp/modulos/trabalhos/${encodeURIComponent(workType)}/${encodeURIComponent(id)}`}>Abrir trabalho</a> : null;
  return <a href={operationalHref({ profile: "", module, source_id: id, component: "main" })}>Abrir {MODULE_LABELS[module].toLowerCase()}</a>;
}
