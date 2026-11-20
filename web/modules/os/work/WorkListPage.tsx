import React, { useState } from "react";
import { useApp } from "../../../app/AppContext";
import { Pager } from "../../../admin/shared";
import { Button, Dialog, Field, Empty, Notice } from "../../../ui";
import { linkProps, navigate, useRoute } from "../../../lib/routes";
import { date } from "../../../lib/format";
import { ResourceState, useWorkApi, useWorkResource, instantLabel } from "../work-hooks";
import type { FieldRef, Order, OrderFieldFilter, OrderList, OrderQuery, FieldFilteredOrderList, ServiceObjectType, WorkField, WorkTypeCatalog, WorkTypeView } from "../work-contracts";
import { compatibleWorkField, displayFieldValue, parseExtra } from "../components/ExtraFields";
import { money } from "../shared";
import { StagePill } from "../components/StagePill";
import { OrderDetail, OrderForm } from "../ServiceOrdersPage";
import { WorkFormDialog } from "./WorkFormDialog";
import { WorkDetailPage } from "./WorkDetailPage";
import { workCollectionLabel } from "../work-vocabulary";
import "../work.css";
import { LegacyServiceOrders } from "../../integrations/LegacyServiceOrders";

function dateFilterValue(value?: string) {
  if (!value) return "";
  const valueDate = new Date(Number(value) - 3 * 3600000);
  return Number.isFinite(valueDate.getTime()) ? valueDate.toISOString().slice(0, 10) : "";
}

/** A descrição usa apenas a definição pública do modelo, nunca valores de ordens. */
function modelDescription(type: WorkTypeView) {
  return `${type.labels.item} · ${type.labels.problem}${type.fields.length ? ` · ${type.fields.length} campos extras` : ""}`;
}

export function workListFields(type?: WorkTypeView, objectTypes: ServiceObjectType[] = []) {
  return (type?.list_fields || []).flatMap(rule => {
    const fields = rule.ref.scope === "order" ? type!.fields : objectTypes.find(object => object.id === type?.object_type_id)?.fields || [];
    const field = fields.find(field => field.id === rule.ref.field_id && !field.sensitive);
    return field ? [{ ...rule, field, ...(rule.ref.scope === "object" ? { objectTypeId: type!.object_type_id } : {}) }] : [];
  });
}
export function workColumnValue(order: Order, column: { ref: FieldRef; field: WorkField; objectTypeId?: string }) {
  if (column.ref.scope === "object" && column.objectTypeId && order.object?.type.id !== column.objectTypeId) return "—";
  const fields = column.ref.scope === "object" ? order.object?.type.fields : order.fields;
  const field = fields?.find(field => field.id === column.ref.field_id);
  if (!field || !compatibleWorkField(column.field, field)) return "—";
  const values = column.ref.scope === "object" ? order.object?.values : order.extra;
  return displayFieldValue(field, values?.[field.id]);
}
export function makeWorkFieldFilter(ref: FieldRef, field: WorkField, operator: string, value: string, to = ""): OrderFieldFilter {
  if (field.sensitive || (field.kind === "text" && (field.multiline || field.max_length > 240))) throw new Error("Este campo não pode ser filtrado.");
  const parse = (input: string) => {
    const raw = field.kind === "boolean" ? input === "true" ? true : input === "false" ? false : null : input;
    const parsed = parseExtra([{ ...field, required: true }], { [field.id]: raw })[field.id];
    if (parsed == null) throw new Error("Informe o valor do filtro.");
    return parsed;
  };
  const first = parse(value);
  if (operator === "eq") return { ref, operator: "eq", value: first };
  if (operator !== "range" || !["integer", "decimal", "date"].includes(field.kind)) throw new Error("Use igualdade para este campo.");
  const last = parse(to);
  if (typeof first === "boolean" || typeof last === "boolean" || first > last) throw new Error("Informe um intervalo fechado em ordem crescente.");
  return { ref, operator: "range", from: first, to: last };
}
export const workListCountLabel = (list: OrderList | FieldFilteredOrderList) => list.counts === null
  ? "Resultados paginados · total não calculado"
  : `${Object.values(list.counts).reduce((sum, value) => sum + (value || 0), 0)} ordens`;

function WorkFieldFilter({ fields, value, onApply }: {
  fields: ReturnType<typeof workListFields>; value?: OrderFieldFilter; onApply: (filter?: OrderFieldFilter) => void;
}) {
  const [key, setKey] = useState(value ? `${value.ref.scope}:${value.ref.field_id}` : "");
  const [operator, setOperator] = useState<string>(value?.operator || "eq");
  const [input, setInput] = useState(value ? String(value.operator === "eq" ? value.value : value.from) : "");
  const [end, setEnd] = useState(value?.operator === "range" ? String(value.to) : "");
  const [error, setError] = useState("");
  const selected = fields.find(entry => `${entry.ref.scope}:${entry.ref.field_id}` === key), field = selected?.field;
  const range = field && ["integer", "decimal", "date"].includes(field.kind);
  return <form className="os-work-toolbar os-work-field-filter" onSubmit={event => {
    event.preventDefault(); setError("");
    try { onApply(selected ? makeWorkFieldFilter(selected.ref, selected.field, operator, input, end) : undefined); }
    catch (error) { setError((error as Error).message); }
  }}>
    <Field label="Filtro próprio" value={key} emptyOption="Sem filtro próprio" options={fields.map(entry => ({ id: `${entry.ref.scope}:${entry.ref.field_id}`, name: `${entry.field.label} · ${entry.ref.scope === "object" ? "Do objeto" : "Desta ordem"}` }))}
      onChange={value => { setKey(value); setInput(""); setEnd(""); setOperator("eq"); }} />
    {field && <>
      {range && <Field label="Comparação" value={operator} emptyOption={null} options={[{ id: "eq", name: "Igual a" }, { id: "range", name: "Intervalo fechado" }]} onChange={setOperator} />}
      <Field label={operator === "range" ? "De (inclusive)" : "Valor exato"} required value={input} onChange={setInput} type={field.kind === "date" ? "date" : "text"}
        maxLength={field.kind === "text" ? field.max_length : undefined}
        options={field.kind === "boolean" ? [{ id: "true", name: "Sim" }, { id: "false", name: "Não" }] : field.kind === "choice" ? field.options.map(option => ({ id: option.id, name: option.label })) : undefined} />
      {operator === "range" && <Field label="Até (inclusive)" required value={end} onChange={setEnd} type={field.kind === "date" ? "date" : "text"} />}
    </>}
    <Button secondary type="submit">Aplicar filtro próprio</Button>
    {value && <Button secondary onClick={() => onApply(undefined)}>Remover filtro próprio</Button>}
    {error && <Notice tone="error">{error}</Notice>}
  </form>;
}

function WorkList({ catalog }: { catalog: WorkTypeCatalog }) {
  const app = useApp(), api = useWorkApi(), route = useRoute();
  const types = catalog.data;
  const active = types.filter(type => !type.archived);
  const filters = route.filters || {};
  const selected = route.typeId || filters.type_id || "";
  const type = types.find(candidate => candidate.id === selected);
  const ownFields = workListFields(type, app.settings.os_object_types || []);
  const columns = ownFields.filter(entry => entry.column).slice(0, 4);
  const filterFields = ownFields.filter(entry => entry.filter).slice(0, 4);
  let fieldFilter: OrderFieldFilter | undefined, filterError = "";
  if (type && filters.field_filter) {
    try {
      const parsed = JSON.parse(filters.field_filter) as OrderFieldFilter;
      const configured = filterFields.find(entry => entry.ref.scope === parsed.ref.scope && entry.ref.field_id === parsed.ref.field_id);
      if (!configured) throw new Error();
      fieldFilter = makeWorkFieldFilter(configured.ref, configured.field, parsed.operator, String(parsed.operator === "eq" ? parsed.value : parsed.from), parsed.operator === "range" ? String(parsed.to) : "");
    } catch { filterError = "O filtro próprio não está disponível neste modelo. Remova o filtro para continuar."; }
  }
  const [cursor, setCursor] = useState("");
  const [opening, setOpening] = useState<WorkTypeView | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [classicId, setClassicId] = useState<string | null>(null);
  const [search, setSearch] = useState(filters.q || "");
  const resource = useWorkResource<OrderList | FieldFilteredOrderList>(
    filterError ? null : app.root + "/list/" + selected + JSON.stringify(filters) + cursor + active.map(t => t.id).join(","),
    () => {
      const query: OrderQuery = {
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
      };
      return fieldFilter ? api.filteredOrders({ ...query, field_filter: fieldFilter }) : api.orders(query);
    },
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
  const headers = ["Número", ...(showModel ? ["Modelo"] : []), customerLabel, itemLabel, ...columns.map(column => column.field.label), "Etapa", "Responsável", "Prazo", "Orçamento", "Atualizada"];

  if (selected && !type) return <Empty title="Modelo não disponível" description="Este modelo não está disponível para seu acesso." />;
  return (
    <div className="os-work">
      <div className="os-work-toolbar">
        <LegacyServiceOrders />
        <h2>{workCollectionLabel(types, app.settings.os_vocabulary)}</h2>
        <Button disabled={!active.length} onClick={create}>Nova ordem</Button>
        <a className="button secondary" {...linkProps({ area: "admin", page: "my-deadlines" })}>Meus prazos</a>
      </div>
      <form className="os-work-toolbar" onSubmit={event => { event.preventDefault(); filter({ q: search }); }}>
        <Field label="Modelo" value={selected} emptyOption="Todos os modelos"
          options={[...active, ...(type?.archived ? [type] : [])].map(candidate => ({ id: candidate.id, name: candidate.labels.plural + (candidate.archived ? " (arquivado)" : "") }))}
          onChange={typeId => navigate({ area: "admin", page: "work", typeId: typeId || undefined, filters: { ...filters, type_id: "", stage: "", field_filter: "" } })} />
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
        <Button secondary onClick={() => { setSearch(""); filter({ q: "", stage: "", status: "", open: "1", assignee: "", due_from: "", due_to: "", field_filter: "" }); }}>Limpar filtros</Button>
      </form>
      {!!filterFields.length && <WorkFieldFilter fields={filterFields} value={fieldFilter} onApply={value => filter({ field_filter: value ? JSON.stringify(value) : "" })} />}
      {!hasCustom && app.isAdmin && <Notice>Seu serviço tem informações próprias? <a {...linkProps({ area: "admin", page: "work-types", filters: { tab: "modelos" } })}>Crie um modelo</a>.</Notice>}
      {filterError ? <Notice tone="error">{filterError} <Button secondary onClick={() => filter({ field_filter: "" })}>Remover filtro próprio</Button></Notice> : <ResourceState resource={resource} />}
      {(resource.error as { code?: string } | undefined)?.code === "field_index_building" && <Notice>O índice deste campo está em construção. Você pode continuar com a lista comum. <Button secondary onClick={() => filter({ field_filter: "" })}>Ver lista sem filtro próprio</Button></Notice>}
      {resource.data && <>
        {resource.data.counts === null && <p role="status">{workListCountLabel(resource.data)}. Ordenação: {resource.data.order_by === "field_value_asc" ? "valor do campo crescente; empates por número decrescente" : "número decrescente"}.</p>}
        {resource.data.data.length ? <div className="table-stack"><div className="table-scroll"><table>
          <thead><tr>{headers.map(header => <th key={header} scope="col">{header}</th>)}</tr></thead>
          <tbody>{resource.data.data.map(order => <tr key={order.id} onClick={event => { if (!(event.target as Element).closest("a,button")) openOrder(order); }}>
            <td data-label="Número"><a {...linkProps({ area: "admin", page: "work", typeId: order.type_id, id: order.id, filters })}
              onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); openOrder(order); } }}>{order.display_number}</a></td>
            {showModel && <td data-label="Modelo">{order.type_plural_label}</td>}
            <td data-label={customerLabel}>{order.customer.name || "Sem nome"}</td>
            <td data-label={itemLabel}>{order.item}</td>
            {columns.map(column => <td key={`${column.ref.scope}:${column.ref.field_id}`} data-label={column.field.label}>{workColumnValue(order, column)}</td>)}
            <td data-label="Etapa"><StagePill status={order.status} label={order.stage_label} /></td>
            <td data-label="Responsável">{order.assignee ? app.names[order.assignee] || order.assignee : "Sem responsável"}</td>
            <td data-label="Prazo">{instantLabel(order.due_at)}{order.due_at && order.due_at < app.now && !["delivered", "cancelled"].includes(order.status) ? " · Atrasado" : ""}</td>
            <td data-label="Orçamento">{order.quote ? money(order.quote.total_cents) : "—"}</td>
            <td data-label="Atualizada">{date(order.updated)}</td>
          </tr>)}</tbody>
        </table></div></div> : <>
          <Empty title={fieldFilter ? resource.data.next_cursor ? "Nenhuma ordem nesta página" : "Nenhuma ordem encontrada" : "Nenhuma ordem ainda"} description={fieldFilter && resource.data.next_cursor ? "Continue para a próxima página de resultados." : "Revise os filtros ou crie uma ordem para começar."} />
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
  // OS3: o documento do ERP leva à ordem nova correspondente (?origem=<id da ordem>).
  const origin = !route.id ? new URLSearchParams(route.search || "").get("origem") : null;
  if (origin) return <WorkDetailPage key={app.profile + origin} workId={origin} />;
  if (!catalog.data) return <ResourceState resource={catalog} />;
  if (!Array.isArray(catalog.data.data)) return <Notice>Catálogo de modelos indisponível. <Button secondary onClick={catalog.reload}>Tentar novamente</Button></Notice>;
  return <WorkList key={app.root + (route.typeId || "") + JSON.stringify(route.filters)} catalog={catalog.data} />;
}
