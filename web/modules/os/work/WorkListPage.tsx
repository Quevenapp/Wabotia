import React, { useState } from "react";
import { useApp } from "../../../app/AppContext";
import { Pager } from "../../../admin/shared";
import { Button, Dialog, Field, Empty, Notice } from "../../../ui";
import { linkProps, navigate, useRoute } from "../../../lib/routes";
import { date } from "../../../lib/format";
import { ResourceState, useWorkApi, useWorkResource, instantLabel } from "../work-hooks";
import type { Order, WorkTypeCatalog, WorkTypeView } from "../work-contracts";
import { money } from "../shared";
import { StagePill } from "../components/StagePill";
import { OrderDetail, OrderForm } from "../ServiceOrdersPage";
import { WorkFormDialog } from "./WorkFormDialog";
import { WorkDetailPage } from "./WorkDetailPage";
import { workCollectionLabel } from "../work-vocabulary";
import "../work.css";

function dateFilterValue(value?: string) {
  if (!value) return "";
  const valueDate = new Date(Number(value) - 3 * 3600000);
  return Number.isFinite(valueDate.getTime()) ? valueDate.toISOString().slice(0, 10) : "";
}

/** A descrição usa apenas a definição pública do modelo, nunca valores de ordens. */
function modelDescription(type: WorkTypeView) {
  return `${type.labels.item} · ${type.labels.problem}${type.fields.length ? ` · ${type.fields.length} campos extras` : ""}`;
}

function WorkList({ catalog }: { catalog: WorkTypeCatalog }) {
  const app = useApp(), api = useWorkApi(), route = useRoute();
  const types = catalog.data;
  const active = types.filter(type => !type.archived);
  const filters = route.filters || {};
  const selected = route.typeId || filters.type_id || "";
  const type = types.find(candidate => candidate.id === selected);
  const [cursor, setCursor] = useState("");
  const [opening, setOpening] = useState<WorkTypeView | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [classicId, setClassicId] = useState<string | null>(null);
  const [search, setSearch] = useState(filters.q || "");
  const resource = useWorkResource(
    app.root + "/list/" + selected + JSON.stringify(filters) + cursor + active.map(t => t.id).join(","),
    () => api.orders({
      type_id: selected || undefined,
      type_ids: selected ? undefined : active.map(t => t.id).join(","),
      stage: selected ? filters.stage : undefined,
      q: filters.q,
      assignee: filters.assignee,
      due_from: filters.due_from,
      due_to: filters.due_to,
      status: filters.status,
      open: filters.stage || filters.status || filters.open === "0" ? undefined : "1",
      cursor,
      limit: "50",
    }),
  );
  const filter = (next: Record<string, string>) => {
    setCursor("");
    navigate({ area: "admin", page: "work", typeId: selected || undefined, filters: { ...filters, ...next } });
  };
  const create = () => {
    if (active.length === 1) setOpening(active[0]);
    else setChoosing(true);
  };
  const openOrder = (order: Pick<Order, "id" | "type_id">) => {
    if (order.type_id === "service_order") setClassicId(order.id);
    else navigate({ area: "admin", page: "work", typeId: order.type_id, id: order.id, filters });
  };
  const hasCustom = types.some(candidate => candidate.kind === "custom");
  const showModel = active.length > 1 || !!type?.archived;
  const itemLabel = type?.labels.item || "Item";
  const customerLabel = type?.labels.customer_singular || "Cliente";
  const routedClassicId = route.typeId === "service_order" ? route.id : undefined;
  const headers = ["Número", ...(showModel ? ["Modelo"] : []), customerLabel, itemLabel, "Etapa", "Responsável", "Prazo", "Orçamento", "Atualizada"];

  if (selected && !type) return <Empty title="Modelo não disponível" description="Este modelo não está disponível para seu acesso." />;
  return (
    <div className="os-work">
      <div className="os-work-toolbar">
        <h2>{workCollectionLabel(types, app.settings.os_vocabulary)}</h2>
        <Button disabled={!active.length} onClick={create}>Nova ordem</Button>
        <a className="button secondary" {...linkProps({ area: "admin", page: "my-deadlines" })}>Meus prazos</a>
      </div>
      <form className="os-work-toolbar" onSubmit={event => { event.preventDefault(); filter({ q: search }); }}>
        <Field label="Modelo" value={selected} emptyOption="Todos os modelos"
          options={[...active, ...(type?.archived ? [type] : [])].map(candidate => ({ id: candidate.id, name: candidate.labels.plural + (candidate.archived ? " (arquivado)" : "") }))}
          onChange={typeId => navigate({ area: "admin", page: "work", typeId: typeId || undefined, filters: { ...filters, type_id: "", stage: "" } })} />
        <Field label={`Buscar por número, ${customerLabel.toLowerCase()} ou ${itemLabel.toLowerCase()}`} value={search} onChange={setSearch} />
        <Button type="submit" secondary>Buscar</Button>
        <Field label="Situação" value={filters.status || (filters.open === "0" || filters.stage ? "all" : "open")} emptyOption={null}
          options={[{ id: "open", name: "Abertas" }, { id: "delivered", name: "Concluídas" }, { id: "cancelled", name: "Canceladas" }, { id: "all", name: "Todas" }]}
          onChange={value => filter({ stage: "", status: ["delivered", "cancelled"].includes(value) ? value : "", open: value === "open" ? "1" : "0" })} />
        {type && <Field label="Etapa" value={filters.stage || ""} emptyOption="Todas as etapas" options={type.stages.map(stage => ({ id: stage.id, name: stage.label }))}
          onChange={stage => filter({ stage, status: "", open: stage ? "0" : filters.open || "1" })} />}
        <Field label="Responsável" value={filters.assignee || ""} options={[{ id: "me", name: "Eu" }, { id: "unassigned", name: "Sem responsável" }, ...Object.entries(app.names).map(([id, name]) => ({ id, name: String(name) }))]} onChange={assignee => filter({ assignee })} />
        <Field label="Prazo de (data)" type="date" value={dateFilterValue(filters.due_from)} onChange={value => filter({ due_from: value ? String(Date.parse(value + "T00:00:00-03:00")) : "" })} />
        <Field label="Prazo até (data)" type="date" value={dateFilterValue(filters.due_to)} onChange={value => filter({ due_to: value ? String(Date.parse(value + "T23:59:59.999-03:00")) : "" })} />
        <Button secondary onClick={() => { setSearch(""); filter({ q: "", stage: "", status: "", open: "1", assignee: "", due_from: "", due_to: "" }); }}>Limpar filtros</Button>
      </form>
      {!hasCustom && app.isAdmin && <Notice>Seu serviço tem informações próprias? <a {...linkProps({ area: "admin", page: "work-types", filters: { tab: "modelos" } })}>Crie um modelo</a>.</Notice>}
      <ResourceState resource={resource} />
      {resource.data && <>
        {resource.data.data.length ? <div className="table-stack"><div className="table-scroll"><table>
          <thead><tr>{headers.map(header => <th key={header} scope="col">{header}</th>)}</tr></thead>
          <tbody>{resource.data.data.map(order => <tr key={order.id} onClick={event => { if (!(event.target as Element).closest("a,button")) openOrder(order); }}>
            <td data-label="Número"><a {...linkProps({ area: "admin", page: "work", typeId: order.type_id, id: order.id, filters })}
              onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); openOrder(order); } }}>{order.display_number}</a></td>
            {showModel && <td data-label="Modelo">{order.type_plural_label}</td>}
            <td data-label={customerLabel}>{order.customer.name || "Sem nome"}</td>
            <td data-label={itemLabel}>{order.item}</td>
            <td data-label="Etapa"><StagePill status={order.status} label={order.stage_label} /></td>
            <td data-label="Responsável">{order.assignee ? app.names[order.assignee] || order.assignee : "Sem responsável"}</td>
            <td data-label="Prazo">{instantLabel(order.due_at)}{order.due_at && order.due_at < app.now && !["delivered", "cancelled"].includes(order.status) ? " · Atrasado" : ""}</td>
            <td data-label="Orçamento">{order.quote ? money(order.quote.total_cents) : "—"}</td>
            <td data-label="Atualizada">{date(order.updated)}</td>
          </tr>)}</tbody>
        </table></div></div> : <>
          <Empty title="Nenhuma ordem ainda" description="Revise os filtros ou crie uma ordem para começar." />
          <Button disabled={!active.length} onClick={create}>Nova ordem</Button>
        </>}
        <Pager cursor={cursor} nextCursor={resource.data.next_cursor} setCursor={setCursor} />
      </>}
      {choosing && <Dialog title="Escolha o modelo da nova ordem" onClose={() => setChoosing(false)}>
        <ul className="os-work-records">{active.map(candidate => <li className="os-work-record" key={candidate.id}>
          <Button secondary onClick={() => { setChoosing(false); setOpening(candidate); }}>{candidate.labels.plural}</Button>
          <p>{modelDescription(candidate)}</p>
        </li>)}</ul>
      </Dialog>}
      {opening?.kind === "builtin" && <OrderForm initial={null} onClose={() => setOpening(null)} onSaved={order => { setOpening(null); resource.reload(); setClassicId(order.id); }} />}
      {opening?.kind === "custom" && <WorkFormDialog type={opening} onClose={() => setOpening(null)} onSaved={order => { setOpening(null); resource.reload(); openOrder(order); }} />}
      {(classicId || routedClassicId) && <OrderDetail id={(classicId || routedClassicId)!} onChanged={resource.reload} onClose={() => {
        setClassicId(null);
        if (routedClassicId) navigate({ area: "admin", page: "work", typeId: selected, filters });
      }} />}
    </div>
  );
}

export function WorkPage() {
  const app = useApp(), route = useRoute(), api = useWorkApi();
  const catalog = useWorkResource(app.root + "/work-catalog/", () => api.types(true), app.status.settings_revision || "");
  if (route.id && route.typeId !== "service_order") return <WorkDetailPage key={app.profile + route.id} workId={route.id} />;
  if (!catalog.data) return <ResourceState resource={catalog} />;
  if (!Array.isArray(catalog.data.data)) return <Notice>Catálogo de modelos indisponível. <Button secondary onClick={catalog.reload}>Tentar novamente</Button></Notice>;
  return <WorkList key={app.root + (route.typeId || "") + JSON.stringify(route.filters)} catalog={catalog.data} />;
}
