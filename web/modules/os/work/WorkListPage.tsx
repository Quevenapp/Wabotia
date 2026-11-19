import React, { useState } from "react";
import { useApp } from "../../../app/AppContext";
import { Pager } from "../../../admin/shared";
import { Button, Field, Empty } from "../../../ui";
import { linkProps, navigate, useRoute } from "../../../lib/routes";
import {
  ResourceState,
  useWorkApi,
  useWorkResource,
  instantLabel,
} from "../work-hooks";
import type { WorkTypeCatalog, WorkTypeView } from "../work-contracts";
import { money } from "../shared";
import { StagePill } from "../components/StagePill";
import { ServiceOrdersPage } from "../ServiceOrdersPage";
import { WorkFormDialog } from "./WorkFormDialog";
import { WorkDetailPage } from "./WorkDetailPage";
import { workCollectionLabel, hasCustomTypes } from "../work-vocabulary";
import "../work.css";
import { LegacyServiceOrders } from "../../integrations/LegacyServiceOrders";

function dateFilterValue(value?: string) {
  if (!value) return "";
  const date = new Date(Number(value) - 3 * 3600000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function WorkList({
  type,
  catalog,
}: {
  type: WorkTypeView;
  catalog: WorkTypeCatalog;
}) {
  const app = useApp(),
    api = useWorkApi(),
    route = useRoute();
  const [cursor, setCursor] = useState(""),
    [opening, setOpening] = useState<WorkTypeView | null>(null);
  const filters = route.filters || {};
  const [search, setSearch] = useState(filters.q || "");
  const resource = useWorkResource(
    app.root + "/list/" + type.id + JSON.stringify(filters) + cursor,
    () =>
      api.orders({
        type_id: type.id,
        stage: filters.stage,
        q: filters.q,
        assignee: filters.assignee, due_from: filters.due_from, due_to: filters.due_to,
        open: filters.stage
          ? undefined
          : filters.open === "0"
            ? undefined
            : "1",
        facets: "1",
        cursor,
        limit: "50",
      }),
  );
  const filter = (next: Record<string, string>) => {
    setCursor("");
    navigate({
      area: "admin",
      page: "work",
      typeId: type.id,
      filters: { ...filters, ...next },
    });
  };
  return (
    <div className="os-work">
      <div className="os-work-toolbar">
        <LegacyServiceOrders />
        <h2>{type.labels.plural}</h2>
        {catalog.data.length > 1 && (
          <Field
            label="Tipo de trabalho"
            value={type.id}
            emptyOption={null}
            options={catalog.data.map((t) => ({
              id: t.id,
              name: t.labels.plural + (t.archived ? " (arquivado)" : ""),
            }))}
            onChange={(typeId) =>
              navigate({ area: "admin", page: "work", typeId })
            }
          />
        )}
        <Button disabled={type.archived} onClick={() => setOpening(type)}>
          Criar: {type.labels.singular}
        </Button>
        {type.features.tasks && (
          <a {...linkProps({ area: "admin", page: "my-deadlines" })}>
            Meus prazos
          </a>
        )}
      </div>
      <form
        className="os-work-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          filter({ q: search });
        }}
      >
        <Field
          label={`Buscar por número, ${type.labels.customer_singular.toLowerCase()} ou ${type.labels.item.toLowerCase()}`}
          value={search}
          onChange={setSearch}
        />
        <Button type="submit" secondary>
          Buscar
        </Button>
        <Field
          label="Etapa"
          value={filters.stage ? `stage:${filters.stage}` : (filters.open === "0" ? "filter:all" : "filter:open")}
          emptyOption={null}
          options={[
            { id: "filter:open", name: "Abertas" },
            { id: "filter:all", name: "Todas" },
            ...type.stages.map((stage) => ({
              id: `stage:${stage.id}`,
              name: `${stage.label}${resource.data?.facets?.stages?.[stage.id] === undefined ? "" : ` (${resource.data.facets.stages[stage.id]})`}`,
            })),
          ]}
          onChange={(value) =>
            filter({
              stage: value.startsWith("stage:") ? value.slice(6) : "",
              open: value === "filter:open" ? "1" : "0",
            })
          }
        />
        <Field label="Responsável" value={filters.assignee || ""} options={[{ id: "me", name: "Eu" }, { id: "unassigned", name: "Sem responsável" }, ...Object.entries(app.names).map(([id, name]) => ({ id, name: String(name) }))]} onChange={assignee => filter({ assignee })} />
        <Field label="Prazo de (data)" type="date" value={dateFilterValue(filters.due_from)} onChange={value => filter({ due_from: value ? String(Date.parse(value + "T00:00:00-03:00")) : "" })} />
        <Field label="Prazo até (data)" type="date" value={dateFilterValue(filters.due_to)} onChange={value => filter({ due_to: value ? String(Date.parse(value + "T23:59:59.999-03:00")) : "" })} />
        <Button
          secondary
          onClick={() => {
            setSearch("");
            filter({ q: "", stage: "", open: "1", assignee: "", due_from: "", due_to: "" });
          }}
        >
          Limpar filtros
        </Button>
      </form>
      <ResourceState resource={resource} />
      {resource.data && (
        <>
          <ul className="os-work-records">
            {resource.data.data.map((order) => (
              <li className="os-work-record" key={order.id}>
                <a
                  {...linkProps({
                    area: "admin",
                    page: "work",
                    typeId: order.type_id,
                    id: order.id,
                    filters,
                  })}
                >
                  <strong>
                    {order.display_number} · {order.item}
                  </strong>
                </a>
                <StagePill status={order.status} label={order.stage_label} />
                <span>
                  {type.labels.customer_singular}: {order.customer.name}
                </span>
                {type.features.quote && (
                  <span>Orçamento: {money(order.quote?.total_cents)}</span>
                )}
                <span>
                  Responsável:{" "}
                  {order.assignee
                    ? app.names[order.assignee] || order.assignee
                    : "Sem responsável"}
                </span>
                <span>
                  {order.next_task && <span>Próxima tarefa: {order.next_task.title} · {instantLabel(order.next_task.due_at)}</span>}
                  Prazo geral: {instantLabel(order.due_at)}{" "}
                  {order.due_at &&
                  order.due_at < app.now &&
                  !["delivered", "cancelled"].includes(order.status)
                    ? "· Atrasado"
                    : ""}
                </span>
              </li>
            ))}
          </ul>
          {!resource.data.data.length && (
            <Empty
              title={`Nenhum registro em ${type.labels.plural}`}
              description="Revise os filtros ou crie um trabalho."
            />
          )}
          <Pager
            cursor={cursor}
            nextCursor={resource.data.next_cursor}
            setCursor={setCursor}
          />
        </>
      )}
      {opening && (
        <WorkFormDialog
          type={opening}
          onClose={() => setOpening(null)}
          onSaved={(order) => {
            setOpening(null);
            navigate({
              area: "admin",
              page: "work",
              typeId: order.type_id,
              id: order.id,
              filters,
            });
          }}
        />
      )}
    </div>
  );
}
export function WorkPage() {
  const app = useApp(),
    route = useRoute(),
    api = useWorkApi();
  const catalog = useWorkResource(
    app.root + "/work-catalog/",
    () => api.types(true),
    app.status.settings_revision || "",
  );
  // A entrada antiga continua imediata e idêntica nas instalações sem tipos novos.
  // Na casa de gestão o endereço antigo (/ordens-de-servico) cai em "work" sem
  // tipo nem registro: vale a mesma regra, senão quem só usa a Ordem de
  // Serviço perde a tela que tinha.
  const configured = (app.settings.os_work_types || []).length > 0;
  // Resposta sem lista (a vitrine não atende este caminho) conta como vazia.
  const types = Array.isArray(catalog.data?.data) ? catalog.data.data : [];
  const classicEntry =
    route.page === "service-orders" ||
    (route.page === "work" && !route.typeId && !route.id);
  if (classicEntry && !configured && (!catalog.data || !hasCustomTypes(types)))
    return <><LegacyServiceOrders /><ServiceOrdersPage /></>;
  if (!catalog.data) return <ResourceState resource={catalog} />;
  if (route.id)
    return <WorkDetailPage key={app.profile + route.id} workId={route.id} />;
  const type =
    types.find((type) => type.id === route.typeId) ||
    (!route.typeId
      ? types.find((type) => !type.archived && type.kind === "custom") ||
        types[0]
      : undefined);
  if (!type)
    return (
      <Empty
        title="Tipo não disponível"
        description="Este tipo não está disponível para seu acesso."
      />
    );
  if (type.kind === "builtin")
    return (
      <div className="os-work">
        {hasCustomTypes(catalog.data.data) && (
          <Field
            label={workCollectionLabel(
              catalog.data.data,
              app.settings.os_vocabulary,
            )}
            value={type.id}
            options={catalog.data.data.map((t) => ({
              id: t.id,
              name: t.labels.plural,
            }))}
            emptyOption={null}
            onChange={(typeId) =>
              navigate({ area: "admin", page: "work", typeId })
            }
          />
        )}
        <LegacyServiceOrders /><ServiceOrdersPage typeId="service_order" />
      </div>
    );
  return (
    <WorkList
      key={app.root + type.id + JSON.stringify(route.filters)}
      type={type}
      catalog={catalog.data}
    />
  );
}
