import { createIntents, type Api, type ApiFailure } from "../../lib/api";
import type * as C from "./work-contracts";
import { createMaintenanceApi } from "./maintenance/types";

export function queryString(query: object = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== null && value !== "")
      params.set(
        key,
        typeof value === "boolean" ? (value ? "1" : "0") : String(value),
      );
  return params.size ? "?" + params.toString() : "";
}
export const pendingImplementation = (error: unknown) => {
  const e = error as Partial<ApiFailure> | null;
  return e?.status === 404 || e?.code === "not_implemented";
};
export async function findWorkChild<T extends { id: string }>(
  load: (cursor?: string) => Promise<C.Page<T>>,
  id: string,
): Promise<T | undefined> {
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    const record = page.data.find((record) => record.id === id);
    if (record) return record;
    cursor = page.next_cursor || undefined;
  } while (cursor);
}

export async function reloadWorkEntry(
  load: (cursor?: string) => Promise<C.Page<C.Entry>>,
  id: string,
) {
  const records: C.Entry[] = [];
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    records.push(...page.data);
    cursor = page.next_cursor || undefined;
  } while (cursor);
  const record = records.find((entry) => entry.id === id);
  let successor = records.find((entry) => entry.replaces_id === id);
  const seen = new Set([id]);
  while (successor && !seen.has(successor.id)) {
    seen.add(successor.id);
    const next = records.find((entry) => entry.replaces_id === successor!.id);
    if (!next) break;
    successor = next;
  }
  return { record, successor };
}
export function workError(error: unknown) {
  const e = error as Partial<ApiFailure> | null;
  if (pendingImplementation(e))
    return "Em implantação. Este recurso ainda não está disponível nesta instalação.";
  if (e?.code === "version_conflict" || e?.code === "settings_conflict")
    return "Outra pessoa alterou este registro. Seu rascunho foi preservado. Recarregue os dados antes de salvar novamente.";
  if (e?.code === "preview_stale")
    return "A configuração mudou. Gere uma nova prévia antes de aplicar.";
  return e?.message || "Não foi possível concluir. Tente novamente.";
}

export function createWorkApi(api: Api, root: string) {
  const write = createIntents(api);
  const base = root + "/service-orders";
  const order = (id: string) => base + "/" + encodeURIComponent(id);
  const serviceObject = (id: string) => base + "/objects/" + encodeURIComponent(id);
  const child = (id: string, collection: string, childId?: string) =>
    order(id) +
    "/" +
    collection +
    (childId ? "/" + encodeURIComponent(childId) : "");
  const get = <T>(url: string, query?: object): Promise<T> =>
    api(url + queryString(query));
  const send = <T>(url: string, method: string, body: object): Promise<T> =>
    write(url, method, body).catch((error) => {
      throw Object.assign(new Error(workError(error)), {
        status: error?.status,
        code: error?.code,
      });
    });
  return {
    // OS4: contrato de manutenção e execução agendada.
    ...createMaintenanceApi(get, send, base),
    commercial: (id: string) => get<import("../integrations/contracts").WorkCommercialView>(order(id) + "/commercial"),
    saveCommercial: (id: string, body: object) => send<import("../integrations/contracts").WorkCommercialView>(order(id) + "/commercial", "PATCH", body),
    types: (archived = false) =>
      get<C.WorkTypeCatalog>(base + "/types", {
        include_archived: archived ? "1" : undefined,
      }),
    type: (id: string) =>
      get<C.WorkTypeView>(base + "/types/" + encodeURIComponent(id)),
    orders: (query: C.OrderQuery) => get<C.OrderList>(base, query),
    filteredOrders: (query: Omit<C.OrderQuery, "field_filter"> & { field_filter: C.OrderFieldFilter }) =>
      get<C.FieldFilteredOrderList>(base, { ...query, field_filter: JSON.stringify(query.field_filter) }),
    objectTypes: (archived = false) => get<C.ObjectTypeCatalog>(base + "/object-types", {
      include_archived: archived ? "1" : undefined,
    }),
    objects: (query: C.ObjectQuery) => get<C.Page<C.ServiceObjectView>>(base + "/objects", query),
    object: (id: string) => get<C.ServiceObjectView>(serviceObject(id)),
    createObject: (body: C.CreateServiceObjectRequest) => send<C.ServiceObjectView>(base + "/objects", "POST", body),
    updateObject: (id: string, body: C.UpdateServiceObjectRequest) => send<C.ServiceObjectView>(serviceObject(id), "PATCH", body),
    archiveObject: (id: string, body: C.ArchiveServiceObjectRequest) => send<C.ServiceObjectView>(serviceObject(id) + "/archive", "POST", body),
    objectPrivateFields: (id: string) => get<C.ObjectPrivateFields>(serviceObject(id) + "/private-fields"),
    updateObjectPrivateFields: (id: string, body: C.ObjectPrivateFieldsRequest) =>
      send<C.PrivateFieldsResult>(serviceObject(id) + "/private-fields", "PATCH", body),
    objectOrders: (id: string, query: C.PageQuery = {}) => get<C.Page<C.Order>>(serviceObject(id) + "/orders", query),
    linkObject: (id: string, body: C.LegacyObjectLinkRequest) => send<C.Order>(order(id) + "/object-link", "POST", body),
    requirements: (id: string, transition_id?: string) => get<C.OrderRequirements>(order(id) + "/requirements", { transition_id }),
    fieldIndex: (typeId: string) => get<C.FieldIndexState>(base + "/types/" + encodeURIComponent(typeId) + "/field-index"),
    rebuildFieldIndex: (typeId: string, body: C.FieldIndexRebuildRequest) =>
      send<C.FieldIndexState>(base + "/types/" + encodeURIComponent(typeId) + "/field-index/rebuild", "POST", body),
    conversationObjects: (conversationId: string, query: C.PageQuery = {}) =>
      get<C.Page<C.ServiceObjectView>>(base + "/conversation/" + encodeURIComponent(conversationId) + "/objects", query),
    conversationObject: (conversationId: string, objectId: string, query: C.PageQuery = {}) =>
      get<C.ServiceObjectView & { orders: C.Page<C.Order> }>(base + "/conversation/" + encodeURIComponent(conversationId) + "/objects/" + encodeURIComponent(objectId), query),
    order: (id: string) => get<C.Order>(order(id), { history: "none" }),
    create: (body: C.CreateOrderRequest) => send<C.Order>(base, "POST", body),
    update: (id: string, body: C.UpdateOrderRequest) =>
      send<C.Order>(order(id), "PATCH", body),
    stage: (id: string, body: C.StageRequest, approval = false) =>
      send<C.Order>(
        order(id) + (approval ? "/stage-approval" : "/stage"),
        "POST",
        body,
      ),
    stageDecision: (id: string, body: C.StageApprovalDecisionRequest) =>
      send<C.Order>(order(id) + "/stage-approval/decision", "POST", body),
    quote: (id: string, body: C.QuoteRequest & { version?: number }) =>
      send<C.Order>(order(id) + "/quote", "PUT", body),
    sendQuote: (id: string, body: C.QuoteSendRequest = {}) =>
      send<C.Order>(order(id) + "/quote/send", "POST", body),
    decision: (id: string, body: C.DecisionRequest) =>
      send<C.Order>(order(id) + "/decision", "POST", body),
    // OS3: comercial da ordem.
    reopenQuote: (id: string, body: C.QuoteReopenRequest) =>
      send<C.Order>(order(id) + "/quote/reopen", "POST", body),
    // OS6: o que reabrir vai desfazer no ERP, estorno, checklist e ordens antigas do ERP.
    reopenPreview: (id: string) => get<C.QuoteReopenPreview>(order(id) + "/quote/reopen"),
    payments: (id: string) => get<C.OrderPayments>(order(id) + "/payments"),
    receipt: (id: string, body: C.ReceiptRequest) =>
      send<C.OrderPayments>(order(id) + "/receipts", "POST", body),
    reverseReceipt: (id: string, body: C.ReceiptReverseRequest) =>
      send<C.OrderPayments>(order(id) + "/receipts/reverse", "POST", body),
    markChecklist: (id: string, body: C.ChecklistMarkRequest) =>
      send<C.Order>(order(id) + "/checklist", "POST", body),
    erpLegacy: (documentId: string) => get<C.ErpLegacyPreview>(base + "/erp-legacy/" + encodeURIComponent(documentId)),
    importErpLegacy: (documentId: string, body: C.ErpLegacyImportRequest) =>
      send<C.Order>(base + "/erp-legacy/" + encodeURIComponent(documentId) + "/import", "POST", body),    charge: (id: string, body: C.ChargeRequestInput) =>
      send<{ charge: C.OrderCharge; payments: C.OrderPayments }>(order(id) + "/charges", "POST", body),
    /** Vínculo de catálogo da linha, pela rota da fase 3 (mesmo lote da ordem). */
    linkCatalog: (id: string, line: string, value: { erp_item_id: string | null; version: number }) =>
      send<{ erp_item_id: string | null; version: number }>(
        `${root}/integrations/os/catalog/quote_item/${encodeURIComponent(id)}/${encodeURIComponent(line)}`,
        value.erp_item_id ? "PUT" : "DELETE",
        { version: value.version, ...(value.erp_item_id ? { erp_item_id: value.erp_item_id } : {}) },
      ),
    establishment: () => get<{ name?: string; document?: string; address?: string; phone?: string; footer?: string }>(root + "/establishment"),
    contacts: (q: string) => get<{ data: { id: string; name?: string; phone?: string; namespace?: string; identity_state?: string; merged_into?: string | null }[] }>(
      root + "/contacts", { q, identity: "all", namespace: "team", limit: 20 }),
    paymentMethods: () => get<{ items: { id: string; name?: string; description?: string; active?: boolean }[] }>(
      root + "/erp/v1/financeiro/formas-pagamento", { kind: "receivable" }),
    privateFields: (id: string) =>
      get<C.PrivateFields>(order(id) + "/private-fields"),
    updatePrivateFields: (id: string, body: C.PrivateFieldsRequest) =>
      send<C.PrivateFieldsResult>(order(id) + "/private-fields", "PATCH", body),
    tasks: (id: string, query: C.TaskQuery) =>
      get<C.Page<C.Task>>(child(id, "tasks"), query),
    createTask: (id: string, body: C.CreateTaskRequest) =>
      send<C.MutationRef>(child(id, body.sensitive ? "private-tasks" : "tasks"), "POST", body),
    updateTask: (id: string, taskId: string, body: C.UpdateTaskRequest, sensitive = body.sensitive === true) =>
      send<C.MutationRef>(child(id, sensitive || body.sensitive ? "private-tasks" : "tasks", taskId), "PATCH", body),
    people: (id: string, query: C.PageQuery) =>
      get<C.Page<C.LinkedPerson>>(child(id, "people"), query),
    createPerson: (id: string, body: C.CreatePersonRequest) =>
      send<C.MutationRef>(child(id, "people"), "POST", body),
    updatePerson: (id: string, personId: string, body: C.UpdatePersonRequest) =>
      send<C.MutationRef>(child(id, "people", personId), "PATCH", body),
    documents: (id: string, query: C.PageQuery, sensitive = false) =>
      get<C.Page<C.DocumentMetadata>>(child(id, sensitive ? "private-documents" : "documents"), query),
    reserveDocument: (id: string, body: C.CreateDocumentRequest) =>
      send<C.DocumentReservation>(child(id, body.sensitive ? "private-documents" : "documents"), "POST", body),
    completeDocument: (
      id: string,
      documentId: string,
      body: C.CompleteDocumentRequest,
      sensitive = false,
    ) =>
      send<C.MutationRef>(
        child(id, sensitive ? "private-documents" : "documents", documentId) + "/complete",
        "POST",
        body,
      ),
    sendDocument: (id: string, documentId: string, version: number) =>
      send<C.SendDocumentResult>(
        child(id, "documents", documentId) + "/send",
        "POST",
        { version },
      ),
    documentUrl: (id: string, documentId: string, sensitive = false) =>
      "/api/" + child(id, sensitive ? "private-documents" : "documents", documentId) + "/content",
    entries: (id: string, query: C.EntryQuery) =>
      get<C.Page<C.Entry>>(child(id, "entries"), query),
    createEntry: (id: string, body: C.CreateEntryRequest) =>
      send<C.MutationRef>(child(id, "entries"), "POST", body),
    reviseEntry: (id: string, entryId: string, body: C.ReviseEntryRequest) =>
      send<C.MutationRef>(
        child(id, "entries", entryId) + "/revisions",
        "POST",
        body,
      ),
    archive: (
      id: string,
      collection: "tasks" | "people" | "documents" | "entries",
      childId: string,
      version: number,
      sensitive = false,
    ) =>
      send<C.MutationRef>(child(id, sensitive && ["tasks", "documents"].includes(collection) ? "private-" + collection : collection, childId) + "/archive", "POST", {
        version,
      }),
    history: (id: string, query: C.PageQuery) =>
      get<C.Page<C.OrderHistory>>(order(id) + "/history", query),
    deadlines: (query: C.DeadlineQuery) =>
      get<C.Page<C.Deadline>>(root + "/service-orders/my-tasks", query),
    saveTypes: (types: C.CustomWorkType[], settings_revision: string, objectTypes?: C.ServiceObjectType[]) =>
      send<{ settings_revision: string }>(root + "/settings", "PUT", {
        os_work_types: types,
        ...(objectTypes === undefined ? {} : { os_object_types: objectTypes }),
        settings_revision,
      }),
    saveObjectTypes: (types: C.ServiceObjectType[], settings_revision: string, workTypes?: C.CustomWorkType[]) =>
      send<{ settings_revision: string }>(root + "/settings", "PUT", {
        os_object_types: types,
        ...(workTypes === undefined ? {} : { os_work_types: workTypes }),
        settings_revision,
      }),
    templates: () => get<C.AreaTemplateCatalog>(root + "/area-templates"),
    template: (id: string) =>
      get<C.AreaTemplate>(root + "/area-templates/" + encodeURIComponent(id)),
    preview: (body: C.AreaTemplatePreviewRequest) =>
      send<C.AreaTemplatePreview>(
        root + "/area-templates/preview",
        "POST",
        body,
      ),
    apply: (body: C.AreaTemplateApplyRequest) =>
      send<C.AreaTemplateApplyResult>(
        root + "/area-templates/apply",
        "POST",
        body,
      ),
    export: (body: C.AreaTemplateExportRequest) =>
      send<C.AreaTemplate>(root + "/area-templates/export", "POST", body),
  };
}
export type WorkApi = ReturnType<typeof createWorkApi>;

/** Transporte privado: nunca encaminha upload_url para outro domínio. */
export async function uploadDocument(
  url: string,
  file: File,
  version: number,
  key: string,
): Promise<C.DocumentUploadResult> {
  const response = await fetch(url, {
    method: "PUT",
    credentials: "same-origin",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "Idempotency-Key": key,
      "Upload-Version": String(version),
    },
    body: file,
  });
  const data = (await response.json()) as C.DocumentUploadResult & {
    error?: { message?: string; code?: string };
  };
  if (!response.ok)
    throw Object.assign(
      new Error(data?.error?.message || "Falha no envio do documento."),
      { status: response.status, code: data?.error?.code },
    );
  return data;
}
