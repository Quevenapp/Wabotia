import React, { useState } from "react";
import { useApp } from "../../../app/AppContext";
import { useAction } from "../../../app/hooks";
import { Button, Notice } from "../../../ui";
import { linkProps, navigate, useRoute } from "../../../lib/routes";
import type { Order } from "../work-contracts";
import {
  ResourceState,
  instantLabel,
  useWorkApi,
  useWorkResource,
} from "../work-hooks";
import { StagePill } from "../components/StagePill";
import { ExtraFields } from "../components/ExtraFields";
import { WorkTasksTab } from "../tasks/WorkTasksTab";
import { WorkPeopleTab } from "../people/WorkPeopleTab";
import { WorkDocumentsTab } from "../documents/WorkDocumentsTab";
import { WorkEntriesTab } from "../entries/WorkEntriesTab";
import { WorkHistoryTab } from "../history/WorkHistoryTab";
import { WorkFormDialog } from "./WorkFormDialog";
import { QuoteEditor } from "./QuoteEditor";
import { PrivateFieldsDialog } from "./PrivateFieldsDialog";
import { money } from "../shared";
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
function Detail({ order, reload }: { order: Order; reload: () => void }) {
  const app = useApp(),
    api = useWorkApi(),
    route = useRoute(),
    action = useAction();
  const definition = useWorkResource(`${app.root}/type/${order.type_id}`, () =>
    api.type(order.type_id),
  );
  const [editing, setEditing] = useState(false),
    [quote, setQuote] = useState(false),
    [privateOpen, setPrivateOpen] = useState(false);
  // Uma definição atual diferente nunca reinterpreta campos/etapas de uma ordem antiga.
  const type =
    definition.data?.revision === order.type_revision
      ? definition.data
      : undefined;
  const tabs = workTabs.filter(
    (tab) => !("feature" in tab) || !type || type.features[tab.feature],
  );
  const tab = tabs.find((tab) => tab.id === route.tab)?.id || "resumo";
  const changed = () => {
    setEditing(false);
    setQuote(false);
    setPrivateOpen(false);
    reload();
  };
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
            onClick={() =>
              void action.run(async () => {
                await api.stage(
                  order.id,
                  stageIntent(order, transition),
                  transition.kind === "customer_approval",
                );
                changed();
              })
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
                  void action.run(async () => {
                    await api.stageDecision(order.id, {
                      decision,
                      version: order.version,
                      approval_version: order.stage_approval!.version,
                    });
                    changed();
                  })
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
            {order.fields.some((field) => field.sensitive) && (
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
            {(order.quote || type?.features.quote) && (
              <section>
                <h3>Orçamento</h3>
                <p>{money(order.quote?.total_cents)}</p>
                <div className="card-actions">
                  {type?.features.quote?.source_stages.includes(
                    order.stage,
                  ) && (
                    <Button secondary onClick={() => setQuote(true)}>
                      Editar orçamento
                    </Button>
                  )}
                  {order.quote && order.next_statuses.includes("quoted") && (
                    <Button
                      secondary
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          await api.sendQuote(order.id);
                          changed();
                        })
                      }
                    >
                      Enviar orçamento
                    </Button>
                  )}
                  {order.status === "quoted" &&
                    order.next_statuses.includes("approved") && (
                      <Button
                        secondary
                        disabled={action.busy}
                        onClick={() =>
                          void action.run(async () => {
                            await api.decision(order.id, {
                              decision: "approve",
                            });
                            changed();
                          })
                        }
                      >
                        Registrar aprovação do orçamento
                      </Button>
                    )}
                  {order.status === "quoted" &&
                    order.next_statuses.includes("declined") && (
                      <Button
                        secondary
                        disabled={action.busy}
                        onClick={() =>
                          void action.run(async () => {
                            await api.decision(order.id, {
                              decision: "decline",
                            });
                            changed();
                          })
                        }
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
      {privateOpen && (
        <PrivateFieldsDialog
          order={order}
          onClose={() => setPrivateOpen(false)}
          onSaved={changed}
        />
      )}
      {quote && (
        <QuoteEditor
          order={order}
          onClose={() => setQuote(false)}
          onSaved={changed}
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
  return resource.data ? (
    <Detail order={resource.data} reload={resource.reload} />
  ) : (
    <ResourceState resource={resource} />
  );
}
