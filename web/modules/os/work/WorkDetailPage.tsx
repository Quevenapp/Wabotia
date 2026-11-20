import React, { useRef, useState } from "react";
import { useApp } from "../../../app/AppContext";
import { Button, Notice } from "../../../ui";
import { linkProps, navigate, useRoute } from "../../../lib/routes";
import type { Order, OrderRequirements } from "../work-contracts";
import type { WorkApi } from "../work-api";
import {
  ResourceState,
  instantLabel,
  useWorkApi,
  useWorkResource,
  useDraftGuard,
} from "../work-hooks";
import { StagePill } from "../components/StagePill";
import { OrderDetail } from "../ServiceOrdersPage";
import { ExtraFields, commonExtra, parseExtra } from "../components/ExtraFields";
import { ObjectSnapshot } from "../objects/ObjectSnapshot";
import { LegacyObjectLinkDialog } from "../objects/LegacyObjectLinkDialog";
import { WorkTasksTab } from "../tasks/WorkTasksTab";
import { WorkPeopleTab } from "../people/WorkPeopleTab";
import { WorkDocumentsTab } from "../documents/WorkDocumentsTab";
import { WorkEntriesTab } from "../entries/WorkEntriesTab";
import { WorkHistoryTab } from "../history/WorkHistoryTab";
import { WorkFormDialog, useWorkOperationAction, useWorkOperationDialog } from "./WorkFormDialog";
import { PrivateFieldsDialog } from "./PrivateFieldsDialog";
import { money } from "../shared";
import { WorkCommercialPanel } from "./WorkCommercialPanel";
import { DecisionDialog, ReasonDialog, WorkQuoteCommercial, needsReason, reasonTitle } from "./WorkQuoteCommercial";
import { OrderContractPanel, OrderSchedulePanel } from "../maintenance/OrderPanels";
import "../work.css";
export const workTabs = [
  { id: "resumo", label: "Resumo" },
  { id: "tarefas", label: "Tarefas e prazos", feature: "tasks" },
  { id: "pessoas", label: "Pessoas", feature: "people" },
  { id: "documentos", label: "Documentos", feature: "documents" },
  { id: "lancamentos", label: "Lançamentos", feature: "entries" },
  { id: "historico", label: "Histórico" },
] as const;
export const stageIntent = (
  order: Order,
  transition: Order["next_stages"][number],
) => ({ transition_id: transition.transition_id, version: order.version });
type PendingWorkAction = { transitionId?: string; run: (order: Order) => Promise<unknown> };
export async function loadWorkRequirements(api: WorkApi, id: string, transitionId?: string) {
  const requirements = await api.requirements(id, transitionId);
  const order = await api.order(id);
  if (order.version !== requirements.version) throw new Error("A ordem mudou durante a conferência. Consulte os requisitos novamente.");
  return { order, requirements };
}
function RequirementsDialog({ initial, pending, onClose, onSaved }: {
  initial: { order: Order; requirements: OrderRequirements }; pending: PendingWorkAction;
  onClose: () => void; onSaved: () => void;
}) {
  const api = useWorkApi();
  const OperationDialog = useWorkOperationDialog();
  const [base, setBase] = useState(initial), [values, setValues] = useState(commonExtra(initial.order.fields, initial.order.extra));
  const [dirty, setDirty] = useState(false), [error, setError] = useState(""), [conflict, setConflict] = useState(false);
  const busy = useRef(false), close = useDraftGuard(dirty, onClose);
  const save = async (retry: boolean) => {
    if (busy.current) return;
    busy.current = true; setError("");
    try {
      const saved = await api.update(base.order.id, { version: base.requirements.version, extra: parseExtra(base.order.fields, values) });
      setBase({ ...base, order: saved, requirements: { ...base.requirements, version: saved.version } });
      setDirty(false);
      if (retry) await pending.run(saved);
      close.release(); onSaved();
    } catch (failure) {
      const code = (failure as { code?: string }).code;
      if (code === "missing_fields") setBase(await loadWorkRequirements(api, base.order.id, pending.transitionId));
      if (code === "version_conflict") setConflict(true);
      throw failure;
    } finally { busy.current = false; }
  };
  return <OperationDialog title="Complete os dados desta etapa" onClose={close} disabled={conflict} submitLabel="Salvar e tentar novamente" onSubmit={() => save(true)}>
    <Notice>Salvar preenchimento parcial mantém a etapa atual. Para avançar, complete os requisitos abaixo.</Notice>
    {!pending.transitionId && <Notice>A lista de pendências desta ação de orçamento ainda não está disponível. Os requisitos abaixo correspondem à etapa atual. Revise os campos desta ordem antes de tentar novamente.</Notice>}
    {base.requirements.missing.length > 0 && <ul>{base.requirements.missing.map(field => <li key={field.field_id}>{field.label}</li>)}</ul>}
    {base.requirements.internal_missing && <Notice>A equipe precisa completar os dados desta etapa.</Notice>}
    <ExtraFields fields={base.order.fields} values={values} onChange={value => { setDirty(true); setValues(value); }} />
    {error && <Notice tone="error">{error}</Notice>}
    {conflict && <Notice>Rascunho preservado. <Button secondary onClick={async () => {
      try { setBase(await loadWorkRequirements(api, base.order.id, pending.transitionId)); setConflict(false); }
      catch (error) { setError((error as Error).message); }
    }}>Recarregar versão e revisar</Button></Notice>}
    <Button secondary disabled={conflict} onClick={() => { void save(false).catch(error => setError(error.message)); }}>Salvar preenchimento parcial</Button>
  </OperationDialog>;
}
function Detail({ order, reload }: { order: Order; reload: () => void }) {
  const app = useApp(),
    api = useWorkApi(),
    route = useRoute(),
    action = useWorkOperationAction();
  const definition = useWorkResource(`${app.root}/type/${order.type_id}`, () =>
    api.type(order.type_id),
  );
  const [editing, setEditing] = useState(false),
    [privateOpen, setPrivateOpen] = useState(false),
    [legacyLink, setLegacyLink] = useState(false);
  // OS3: cancelar e voltar etapa pedem motivo; resposta registrada com quem e quando.
  const [reasonFor, setReasonFor] = useState<Order["next_stages"][number]>(),
    [decisionFor, setDecisionFor] = useState<"approve" | "decline">();
  const [requirements, setRequirements] = useState<{ order: Order; requirements: OrderRequirements; pending: PendingWorkAction }>();
  // Uma definição atual diferente nunca reinterpreta campos/etapas de uma ordem antiga.
  const features = order.features;
  const tabs = workTabs.filter(
    (tab) => !("feature" in tab) || !features || features[tab.feature],
  );
  const tab = tabs.find((tab) => tab.id === route.tab)?.id || "resumo";
  const changed = () => {
    setEditing(false);
    setPrivateOpen(false);
    setLegacyLink(false);
    setRequirements(undefined);
    setReasonFor(undefined);
    setDecisionFor(undefined);
    reload();
  };
  const execute = (pending: PendingWorkAction) => action.run(async () => {
    try { await pending.run(order); changed(); }
    catch (error) {
      if ((error as { code?: string }).code !== "missing_fields") throw error;
      setRequirements({ ...await loadWorkRequirements(api, order.id, pending.transitionId), pending });
    }
  });
  const move = (value: string) =>
    navigate({
      ...route,
      page: "work",
      typeId: order.type_id,
      id: order.id,
      tab: value,
    });
  return (
    <div className="os-work">
      <a
        {...linkProps({
          area: "admin",
          page: "work",
          typeId: order.type_id,
          filters: route.filters,
        })}
      >
        ← {order.type_plural_label}
      </a>
      <div className="os-work-toolbar">
        <h2>
          {order.type_label} {order.display_number}
        </h2>
        <StagePill status={order.status} label={order.stage_label} />
      </div>
      <p>
        {order.item} ·{" "}
        {order.assignee
          ? app.names[order.assignee] || order.assignee
          : "Sem responsável"}{" "}
        · {instantLabel(order.due_at)}
      </p>
      <div className="card-actions">
        {order.next_stages.map((transition) => (
          <Button
            key={transition.transition_id}
            disabled={action.busy}
            variant={transition.base_status === "cancelled" ? "danger" : undefined}
            onClick={() =>
              transition.kind !== "customer_approval" && needsReason(order.status, transition.base_status)
                ? setReasonFor(transition)
                : void execute({ transitionId: transition.transition_id, run: current => api.stage(current.id, stageIntent(current, transition), transition.kind === "customer_approval") })
            }
          >
            {transition.kind === "customer_approval"
              ? "Solicitar aprovação: "
              : ""}
            {transition.stage_label}
          </Button>
        ))}
        {order.customer.conversation_id && (
          <a
            {...linkProps({
              area: "conversations",
              id: order.customer.conversation_id,
            })}
          >
            Abrir conversa
          </a>
        )}
      </div>
      <WorkCommercialPanel key={order.id} workId={order.id} />
      {order.stage_approval?.state === "pending" && (
        <Notice>
          Aprovação de etapa pendente até{" "}
          {instantLabel(order.stage_approval.expires_at)}.
          <div className="card-actions">
            {(["approve", "decline"] as const).map((decision) => (
              <Button
                key={decision}
                secondary
                disabled={action.busy}
                onClick={() =>
                  void execute({ transitionId: order.stage_approval!.transition_id, run: current => api.stageDecision(current.id, {
                      decision,
                      version: current.version,
                      approval_version: current.stage_approval!.version,
                    }) })
                }
              >
                {decision === "approve"
                  ? "Registrar aprovação"
                  : "Registrar recusa"}
              </Button>
            ))}
          </div>
        </Notice>
      )}
      <div
        className="os-work-tabs"
        role="tablist"
        aria-label="Detalhes do trabalho"
      >
        {tabs.map((entry, index) => (
          <button
            type="button"
            role="tab"
            className="button secondary"
            id={"work-tab-" + entry.id}
            aria-controls={"work-panel-" + entry.id}
            aria-selected={tab === entry.id}
            tabIndex={tab === entry.id ? 0 : -1}
            key={entry.id}
            onClick={() => move(entry.id)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft"
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : -1;
              if (next >= 0) {
                event.preventDefault();
                if (move(tabs[next].id))
                  document.getElementById("work-tab-" + tabs[next].id)?.focus();
              }
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id={"work-panel-" + tab}
        aria-labelledby={"work-tab-" + tab}
      >
        {tab === "resumo" && (
          <>
            {order.object && <ObjectSnapshot snapshot={order.object} />}
            <dl className="os-work-facts">
              <div>
                <dt>{order.labels.customer_singular}</dt>
                <dd>
                  {order.customer.name}
                  {order.customer.phone && (
                    <>
                      <br />
                      {order.customer.phone}
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt>{order.labels.item}</dt>
                <dd>{order.item}</dd>
              </div>
              <div>
                <dt>{order.labels.problem}</dt>
                <dd>{order.problem}</dd>
              </div>
              <ExtraFields
                fields={order.fields}
                values={order.extra}
                readOnly
              />
              {order.notes !== undefined && (
                <div>
                  <dt>Observações internas</dt>
                  <dd>{order.notes || "—"}</dd>
                </div>
              )}
              {order.terms && (
                <div>
                  <dt>
                    Termos aceitos em {instantLabel(order.terms.accepted_at)}
                  </dt>
                  <dd>{order.terms.text}</dd>
                </div>
              )}
              {order.warranty_until && (
                <div>
                  <dt>Garantia até</dt>
                  <dd>{instantLabel(order.warranty_until)}</dd>
                </div>
              )}
            </dl>
            {order.type_id !== "service_order" && Array.isArray(app.me.access) && app.me.access.includes("os:sensitive") && (
              <Button secondary onClick={() => setPrivateOpen(true)}>
                Abrir campos restritos
              </Button>
            )}
            {definition.error && <ResourceState resource={definition} />}
            {definition.data && (
              <Button secondary onClick={() => setEditing(true)}>
                Editar: {order.labels.singular}
              </Button>
            )}
            {!order.object && order.type_id !== "service_order" && definition.data?.object_type_id && (
              <Button secondary onClick={() => setLegacyLink(true)}>Vincular objeto à ordem antiga</Button>
            )}
            {/* OS4: contrato que cobre a ordem e execução agendada. */}
            <OrderContractPanel order={order} onChanged={changed} />
            <OrderSchedulePanel order={order} onChanged={changed} />
            {(order.quote || features?.quote) && (
              <section>
                <h3>Orçamento</h3>
                <p>{money(order.quote?.total_cents)}</p>
                <WorkQuoteCommercial order={order} onChanged={changed}
                  editable={!!features?.quote?.source_stages.includes(order.stage) && order.status !== "approved"} />
                <div className="card-actions">
                  {order.quote && order.next_statuses.includes("quoted") && (
                    <Button
                      secondary
                      disabled={action.busy}
                      onClick={() =>
                        void execute({ transitionId: order.next_stages.find(next => next.stage === features?.quote?.sent_stage)?.transition_id, run: current => api.sendQuote(current.id, { notify: !!current.customer.conversation_id }) })
                      }
                    >
                      {order.customer.conversation_id ? "Enviar orçamento" : "Registrar orçamento sem envio pelo WhatsApp"}
                    </Button>
                  )}
                  {order.status === "quoted" &&
                    order.next_statuses.includes("approved") && (
                      <Button
                        secondary
                        disabled={action.busy}
                        onClick={() => setDecisionFor("approve")}
                      >
                        Registrar aprovação do orçamento
                      </Button>
                    )}
                  {order.status === "quoted" &&
                    order.next_statuses.includes("declined") && (
                      <Button
                        secondary
                        disabled={action.busy}
                        onClick={() => setDecisionFor("decline")}
                      >
                        Registrar recusa do orçamento
                      </Button>
                    )}
                </div>
              </section>
            )}
          </>
        )}
        {tab === "tarefas" && (
          <WorkTasksTab workId={order.id} onChanged={reload} />
        )}
        {tab === "pessoas" && (
          <WorkPeopleTab workId={order.id} onChanged={reload} />
        )}
        {tab === "documentos" && (
          <WorkDocumentsTab order={order} onChanged={reload} />
        )}
        {tab === "lancamentos" && (
          <WorkEntriesTab workId={order.id} onChanged={reload} />
        )}
        {tab === "historico" && <WorkHistoryTab workId={order.id} />}
      </section>
      {editing && definition.data && (
        <WorkFormDialog
          type={definition.data}
          initial={order}
          onClose={() => setEditing(false)}
          onSaved={changed}
        />
      )}
      {legacyLink && definition.data && <LegacyObjectLinkDialog order={order} type={definition.data} onClose={() => setLegacyLink(false)} onSaved={changed} />}
      {requirements && <RequirementsDialog initial={requirements} pending={requirements.pending} onClose={() => setRequirements(undefined)} onSaved={changed} />}
      {privateOpen && (
        <PrivateFieldsDialog
          order={order}
          onClose={() => setPrivateOpen(false)}
          onSaved={changed}
        />
      )}
      {reasonFor && (
        <ReasonDialog
          title={`${reasonTitle(order.status, reasonFor.base_status)}: ${reasonFor.stage_label}`}
          danger={reasonFor.base_status === "cancelled"}
          submitLabel={reasonFor.base_status === "cancelled" ? "Cancelar a ordem" : "Voltar etapa"}
          onClose={() => setReasonFor(undefined)}
          onSubmit={async (note) => {
            const transition = reasonFor;
            setReasonFor(undefined);
            await execute({ transitionId: transition.transition_id, run: current => api.stage(current.id, { ...stageIntent(current, transition), note }) });
          }}
        />
      )}
      {decisionFor && (
        <DecisionDialog
          order={order}
          decision={decisionFor}
          onClose={() => setDecisionFor(undefined)}
          onSubmit={async ({ note, detail }) => {
            const stage = decisionFor === "approve" ? features?.quote?.approved_stage : features?.quote?.declined_stage;
            setDecisionFor(undefined);
            await execute({ transitionId: order.next_stages.find(next => next.stage === stage)?.transition_id, run: current => api.decision(current.id, {
              decision: decisionFor, quote_version: current.quote?.version, ...(note ? { note } : {}), detail,
            }) });
          }}
        />
      )}
    </div>
  );
}
export function WorkDetailPage({ workId }: { workId: string }) {
  const api = useWorkApi(),
    { root } = useApp();
  const resource = useWorkResource(root + "/order/" + workId, () =>
    api.order(workId),
  );
  if (resource.data?.type_id === "service_order") return <OrderDetail id={workId} onChanged={resource.reload}
    onClose={() => { navigate({ area: "admin", page: "work", typeId: "service_order" }); }} />;
  return resource.data ? (
    <Detail order={resource.data} reload={resource.reload} />
  ) : (
    <ResourceState resource={resource} />
  );
}
