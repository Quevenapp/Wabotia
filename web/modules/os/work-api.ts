import { createIntents, type Api, type ApiFailure } from "../../lib/api";
import type * as C from "./work-contracts";

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
    types: (archived = false) =>
      get<C.WorkTypeCatalog>(base + "/types", {
        include_archived: archived ? "1" : undefined,
      }),
    type: (id: string) =>
      get<C.WorkTypeView>(base + "/types/" + encodeURIComponent(id)),
    orders: (query: C.OrderQuery) => get<C.OrderList>(base, query),
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
    quote: (id: string, body: C.QuoteRequest) =>
      send<C.Order>(order(id) + "/quote", "PUT", body),
    sendQuote: (id: string) =>
      send<C.Order>(order(id) + "/quote/send", "POST", {}),
    decision: (id: string, body: C.DecisionRequest) =>
      send<C.Order>(order(id) + "/decision", "POST", body),
    privateFields: (id: string) =>
      get<C.PrivateFields>(order(id) + "/private-fields"),
    updatePrivateFields: (id: string, body: C.PrivateFieldsRequest) =>
      send<C.PrivateFieldsResult>(order(id) + "/private-fields", "PATCH", body),
    tasks: (id: string, query: C.TaskQuery) =>
      get<C.Page<C.Task>>(child(id, "tasks"), query),
    createTask: (id: string, body: C.CreateTaskRequest) =>
      send<C.MutationRef>(child(id, "tasks"), "POST", body),
    updateTask: (id: string, taskId: string, body: C.UpdateTaskRequest) =>
      send<C.MutationRef>(child(id, "tasks", taskId), "PATCH", body),
    people: (id: string, query: C.PageQuery) =>
      get<C.Page<C.LinkedPerson>>(child(id, "people"), query),
    createPerson: (id: string, body: C.CreatePersonRequest) =>
      send<C.MutationRef>(child(id, "people"), "POST", body),
    updatePerson: (id: string, personId: string, body: C.UpdatePersonRequest) =>
      send<C.MutationRef>(child(id, "people", personId), "PATCH", body),
    documents: (id: string, query: C.PageQuery) =>
      get<C.Page<C.DocumentMetadata>>(child(id, "documents"), query),
    reserveDocument: (id: string, body: C.CreateDocumentRequest) =>
      send<C.DocumentReservation>(child(id, "documents"), "POST", body),
    completeDocument: (
      id: string,
      documentId: string,
      body: C.CompleteDocumentRequest,
    ) =>
      send<C.MutationRef>(
        child(id, "documents", documentId) + "/complete",
        "POST",
        body,
      ),
    sendDocument: (id: string, documentId: string, version: number) =>
      send<C.SendDocumentResult>(
        child(id, "documents", documentId) + "/send",
        "POST",
        { version },
      ),
    documentUrl: (id: string, documentId: string) =>
      "/api/" + child(id, "documents", documentId) + "/content",
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
    ) =>
      send<C.MutationRef>(child(id, collection, childId) + "/archive", "POST", {
        version,
      }),
    history: (id: string, query: C.PageQuery) =>
      get<C.Page<C.OrderHistory>>(order(id) + "/history", query),
    deadlines: (query: C.DeadlineQuery) =>
      get<C.Page<C.Deadline>>(root + "/work-tasks", query),
    saveTypes: (types: C.CustomWorkType[], settings_revision: string) =>
      send<{ settings_revision: string }>(root + "/settings", "PUT", {
        os_work_types: types,
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
