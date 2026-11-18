import { describe, expect, it } from "vitest";
// Inicializa o runtime pela mesma entrada dos testes de extensões, antes de
// consultar descritores que importam o motor e seus registros cíclicos.
import "../src/service";
import contract from "../docs/areas/CONTRATO-MOTOR.md?raw";
import { openapi } from "../src/openapi";
import { moduleOperations } from "../src/modules/openapi";
import { tasksExtension } from "../src/modules/os/tasks/extension";
import { documentsExtension } from "../src/modules/os/documents/extension";
import { entriesExtension } from "../src/modules/os/entries/extension";
import { DOCUMENT_MIME_TYPES } from "../src/modules/os/documents/model";
import androidCustom from "../mobile/android/app/src/test/resources/work-orders/motor-custom-order.json";
import iosCustom from "../mobile/ios/WabotiaTests/Fixtures/WorkOrders/motor-custom-order.json";
import { lavanderiaCosturaTemplate } from "../src/area-templates/models/lavanderia-costura";

const mobileFixtures = import.meta.glob("../mobile/**/motor-*.json", { eager: true, import: "default" }) as Record<string, any>;
function fixture(platform: "android" | "ios", name: string): any {
  const entry = Object.entries(mobileFixtures).find(([path]) => path.startsWith(`../mobile/${platform}/`) && path.endsWith(`/${name}.json`));
  expect(entry, `${platform}/${name}`).toBeTruthy();
  return entry![1];
}

const spec = openapi("https://test");
const schemas: Record<string, any> = spec.components.schemas;
const base = "/profiles/{profile}/service-orders";
const order = `${base}/{id}`;
const templates = "/profiles/{profile}/area-templates";
const statuses = [
  "received",
  "analyzing",
  "quoted",
  "approved",
  "declined",
  "in_progress",
  "ready",
  "delivered",
  "cancelled",
];

// A expectativa vem do contrato, incluindo os complementos I2, não do catálogo
// que produz a API.
const sections = [5, 7].map((number) => {
  const start = contract.indexOf(`## ${number}.`);
  const end = contract.indexOf(`## ${number + 1}.`, start);
  return contract.slice(start, end);
});
const routes = sections.flatMap((section) =>
  section.split("\n").flatMap((line) => {
    const match = /^\| `(GET|POST|PATCH|PUT) ([BOP])([^`]*)` \|/.exec(line);
    if (!match) return [];
    const [, method, prefix, suffix] = match;
    const roots: Record<string, string> = {
      P: "/profiles/{profile}",
      B: base,
      O: order,
    };
    return [
      { method: method.toLowerCase(), path: roots[prefix] + suffix, line },
    ];
  }),
);

function resolve(schema: any): any {
  return schema.$ref ? schemas[schema.$ref.split("/").at(-1)] : schema;
}

function operation(path: string, method = "get") {
  return spec.paths[path][method];
}

function responseSchema(path: string, method = "get") {
  return resolve(
    operation(path, method).responses["200"].content["application/json"].schema,
  );
}

// Valida os exemplos contra o subconjunto JSON Schema usado neste contrato.
// Também detecta referências ausentes, required indevido e propriedades extras.
function accepts(schema: any, value: any): boolean {
  schema = resolve(schema);
  if (!schema) return false;
  if (
    schema.oneOf &&
    schema.oneOf.filter((s: any) => accepts(s, value)).length !== 1
  )
    return false;
  if (schema.anyOf && !schema.anyOf.some((s: any) => accepts(s, value)))
    return false;
  if (schema.not && accepts(schema.not, value)) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = types.some((type: string) => {
      if (type === "null") return value === null;
      if (type === "array") return Array.isArray(value);
      if (type === "object")
        return (
          value !== null && typeof value === "object" && !Array.isArray(value)
        );
      if (type === "integer") return Number.isInteger(value);
      return typeof value === type;
    });
    if (!matches) return false;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength)
      return false;
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength)
      return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      return false;
    if (schema.items && !value.every((item) => accepts(schema.items, item)))
      return false;
  } else if (value !== null && typeof value === "object") {
    if (schema.required?.some((key: string) => !(key in value))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) {
        if (!accepts(schema.properties[key], item)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (
        typeof schema.additionalProperties === "object" &&
        !accepts(schema.additionalProperties, item)
      )
        return false;
    }
  }
  return true;
}

describe("OpenAPI do contrato do motor de trabalhos", () => {
  it("documenta todas as rotas das seções 5 e 7, uma única vez", () => {
    // As 45 operações originais mais as três escritas privadas de tarefas.
    expect(routes).toHaveLength(48);
    expect(routes.filter(({ path }) => path.includes("/private-tasks")).map(
      ({ method, path }) => `${method.toUpperCase()} ${path}`,
    )).toEqual([
      `POST ${order}/private-tasks`,
      `PATCH ${order}/private-tasks/{task_id}`,
      `POST ${order}/private-tasks/{task_id}/archive`,
    ]);
    for (const { method, path } of routes) {
      const entry = spec.paths[path]?.[method];
      expect(entry, `${method} ${path}`).toBeTruthy();
      expect(
        moduleOperations.filter(([m, p]) => m === method && p === path),
      ).toHaveLength(1);
      expect(entry.tags).toEqual(["Módulos"]);
      expect(entry.responses["200"]).toBeTruthy();
      for (const [, name] of path.matchAll(/\{(\w+)\}/g)) {
        expect(entry.parameters).toContainEqual(
          expect.objectContaining({
            in: "path",
            name,
            required: true,
          }),
        );
      }
      if (method !== "get") {
        expect(entry.requestBody?.required).toBe(true);
        expect(entry.parameters).toContainEqual(
          expect.objectContaining({
            in: "header",
            name: "Idempotency-Key",
            required: true,
          }),
        );
      }
    }
  });

  it("publica cada erro específico do contrato com envelope e exemplo completos", () => {
    for (const { method, path, line } of routes) {
      const entry = operation(path, method);
      for (const [, status, code] of line.matchAll(/`(\d{3}) ([a-z_]+)`/g)) {
        const error = entry.responses[status];
        expect(error, `${method} ${path}: ${status} ${code}`).toBeTruthy();
        expect(error.description).toContain(code);
        const content = error.content["application/json"];
        expect(content.schema.$ref).toBe("#/components/schemas/Error");
        expect(content.examples[code].value.error).toEqual({
          code,
          message: expect.any(String),
          request_id: expect.any(String),
        });
      }
      for (const status of ["400", "403", "404", "409", "413", "429"]) {
        expect(
          entry.responses[status].content["application/json"].schema.$ref,
        ).toBe("#/components/schemas/Error");
      }
    }
  });

  it("cobre também os descritores entregues, inclusive privados e transporte binário", () => {
    for (const extension of [tasksExtension, documentsExtension, entriesExtension]) {
      const delivered = [
        ...extension.reads.map((route) => ({ ...route, method: "get" })),
        ...extension.writes.map((route) => ({ ...route, method: route.method.toLowerCase() })),
        ...(extension.binaryReads ?? []).map((route) => ({ ...route, method: "get" })),
        ...(extension.binaryUploads ?? []).map((route) => ({ ...route, method: "put" })),
      ];
      for (const route of delivered) {
        const path = `/profiles/{profile}/${route.path.replace(/:(\w+)/g, "{$1}")}`;
        const entry = operation(path, route.method);
        expect(entry, `${route.method} ${path}`).toBeTruthy();
        expect(moduleOperations.filter(([m, p]) => m === route.method && p === path)).toHaveLength(1);
        for (const [, name] of path.matchAll(/\{(\w+)\}/g))
          expect(entry.parameters).toContainEqual(expect.objectContaining({ in: "path", name, required: true }));
        if (route.method !== "get") {
          expect(entry.requestBody.required).toBe(true);
          expect(entry.parameters).toContainEqual(expect.objectContaining({ in: "header", name: "Idempotency-Key", required: true }));
        }
        if (path.includes("/private-")) {
          expect(entry.description).toContain("os:sensitive");
          expect(entry.description).toContain("Fora do catálogo de IA");
          expect(entry.responses["403"].content["application/json"].examples.sensitive_forbidden.value.error.code).toBe("sensitive_forbidden");
        }
      }
    }
    expect(spec.paths[`${order}/private-documents/{document_id}/send`]).toBeUndefined();
    expect(spec.paths[`${order}/private-tasks`].get).toBeUndefined();
  });

  it("conserva os nove estados, contagem esparsa e tipos legados", () => {
    expect(schemas.ServiceOrder.properties.status.enum).toEqual(statuses);
    expect(schemas.ServiceOrder.properties.next_statuses.items.enum).toEqual(
      statuses,
    );
    expect(schemas.BaseStatus.enum).toEqual(statuses);
    expect(schemas.ServiceOrderStatus.properties.status.enum).toEqual([
      "received",
      "analyzing",
      "in_progress",
      "ready",
      "delivered",
      "cancelled",
    ]);
    expect(accepts(schemas.ServiceOrderStatus, { status: "received" })).toBe(true);
    expect(schemas.ServiceOrderStatus.properties.status.description).toContain("Embutido");
    for (const status of ["quoted", "approved", "declined", "ajustes"])
      expect(accepts(schemas.ServiceOrderStatus, { status })).toBe(false);
    const list = responseSchema(base);
    expect(Object.keys(list.properties.counts.properties)).toEqual(statuses);
    expect(list.properties.counts.additionalProperties).toBe(false);
    expect(list.properties.counts.required).toBeUndefined();
    expect(accepts(list.properties.counts, {})).toBe(true);
    expect(accepts(list.properties.counts, { received: 2 })).toBe(true);
    expect(accepts(list.properties.counts, { revisao: 2 })).toBe(false);
    expect(accepts(list.properties.counts, { received: 1.5 })).toBe(false);
    expect(list.properties.next_cursor.type).toEqual(["string", "null"]);
    expect(schemas.ServiceOrder.properties.number).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 2147483647,
    });
    for (const key of ["item", "problem"])
      expect(schemas.ServiceOrder.properties[key].type).toBe("string");
    expect(schemas.ServiceOrderCreate.required).toEqual(["item", "problem"]);
    expect(schemas.ServiceOrderCreate.properties.type_id.default).toBe(
      "service_order",
    );
    expect(schemas.ServiceOrderDecision.properties.decision.enum).toEqual([
      "approve",
      "decline",
    ]);
    expect(
      schemas.ServiceOrder.properties.decision.properties.decision.enum,
    ).toEqual(["approved", "declined"]);
  });

  it("aceita eventos reais no histórico legado do detalhe sem confundi-lo com /history", () => {
    expect(androidCustom).toEqual(iosCustom);
    expect(accepts(schemas.ServiceOrder, androidCustom)).toBe(true);
    const history = schemas.ServiceOrder.properties.history;
    for (const kind of ["opened", "status", "quote", "edit", "os.stage_changed", "os.task.created", "os.document.ready"]) {
      expect(accepts(history, [{ id: "h", kind, from_status: null, to_status: null, actor: "u1", note: "", created: 1 }])).toBe(true);
    }
    expect(androidCustom.history.map((item) => item.kind)).toEqual(["os.stage_changed", "os.task.created"]);
    for (const item of androidCustom.history)
      expect(Object.keys(item).sort()).toEqual(["id", "kind", "from_status", "to_status", "actor", "note", "created"].sort());
    expect(schemas.OrderHistory.properties.changed_fields).toBeTruthy();
    expect(history.items.properties.changed_fields).toBeUndefined();
    const page = fixture("android", "motor-custom-history-page");
    expect(page).toEqual(fixture("ios", "motor-custom-history-page"));
    expect(accepts(schemas.OrderHistoryPage, page)).toBe(true);
    expect(page.data.map(({ from_stage, to_stage, entity_kind }: any) => ({ from_stage, to_stage, entity_kind }))).toEqual([
      { from_stage: "triagem", to_stage: "citacao", entity_kind: null },
      { from_stage: null, to_stage: null, entity_kind: "task" },
    ]);
  });

  it("mantém fixtures móveis de páginas distintas e início de tipo sem orçamento", () => {
    for (const name of ["motor-mixed-page", "motor-next-page", "motor-custom-no-quote"])
      expect(fixture("android", name)).toEqual(fixture("ios", name));
    const first = fixture("android", "motor-mixed-page");
    const next = fixture("android", "motor-next-page");
    for (const page of [first, next]) {
      expect(accepts(schemas.ServiceOrderList, page)).toBe(true);
      expect(page.facets).toBeUndefined();
      expect(page.data.every((row: any) => row.history === undefined)).toBe(true);
    }
    expect(first.data).toHaveLength(2); // Consulta limit=2; há mais um registro na área.
    expect(first.next_cursor).toBe(String(first.data.at(-1).number));
    expect(next.data.every((row: any) => row.number < Number(first.next_cursor))).toBe(true);
    expect(next.next_cursor).toBeNull();
    expect(next.counts).toEqual(first.counts);
    expect(Object.values(first.counts).reduce((sum: number, value) => sum + Number(value), 0)).toBe(first.data.length + next.data.length);
    const initial = fixture("android", "motor-custom-no-quote");
    const type = lavanderiaCosturaTemplate.work_types[0];
    expect(type.features.quote).toBeNull();
    expect(initial.type_id).toBe(`area_lavanderia_costura__${type.id}`);
    expect(initial.stage).toBe(type.initial_stage);
    expect(initial.status).toBe("received");
    expect(initial.fields).toEqual(type.fields);
    expect(initial.display_number).toBe(`${type.number_prefix}-${initial.type_number}`);
    expect(accepts(schemas.ServiceOrder, initial)).toBe(true);
  });

  it("separa corpos comuns e privados de tarefas e documentos", () => {
    const task = { title: "Conferir", audience: "staff", client_visible: false, sensitive: true };
    const document = { name: "Arquivo.pdf", mime_type: "application/pdf", expected_bytes: 100, client_visible: false, sensitive: true };
    expect(accepts(schemas.CreateTaskRequest, task)).toBe(false);
    expect(accepts(schemas.CreatePrivateTaskRequest, task)).toBe(true);
    expect(accepts(schemas.CreatePrivateTaskRequest, { ...task, audience: "customer" })).toBe(false);
    expect(accepts(schemas.CreatePrivateTaskRequest, { ...task, client_visible: true })).toBe(false);
    expect(accepts(schemas.UpdateTaskRequest, { version: 1, sensitive: true })).toBe(false);
    expect(accepts(schemas.UpdatePrivateTaskRequest, { version: 1, sensitive: true })).toBe(true);
    expect(accepts(schemas.CreateDocumentRequest, document)).toBe(false);
    expect(accepts(schemas.CreateDocumentRequest, { ...document, sensitive: false })).toBe(true);
    expect(accepts(schemas.CreatePrivateDocumentRequest, document)).toBe(true);
    expect(accepts(schemas.CreatePrivateDocumentRequest, { ...document, sensitive: false })).toBe(false);
    expect(accepts(schemas.CreatePrivateDocumentRequest, { ...document, client_visible: true })).toBe(false);
    for (const [path, name] of [["private-tasks", "CreatePrivateTaskRequest"], ["private-documents", "CreatePrivateDocumentRequest"]])
      expect(operation(`${order}/${path}`, "post").requestBody.content["application/json"].schema.$ref).toBe(`#/components/schemas/${name}`);
  });

  it("documenta filtros de meus prazos e soma exata por grupo", () => {
    const mine = operation(`${base}/my-tasks`);
    expect(mine.parameters.filter((p: any) => p.in === "query").map((p: any) => p.name)).toEqual([
      "assignee", "state", "period", "type_id", "due_from", "due_to", "cursor", "limit",
    ]);
    expect(mine.description).toContain("pessoa autenticada");
    expect(mine.parameters).toContainEqual(expect.objectContaining({ name: "limit", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } }));
    expect(schemas.MyTask.required).toEqual(expect.arrayContaining(["type_id", "type_label", "display_number", "stage_label"]));
    const summary = operation(`${order}/entries/summary`);
    expect(summary.parameters.filter((p: any) => p.in === "query").map((p: any) => p.name)).toEqual(["kind", "include_archived"]);
    const group = { kind: "horas", unit: "h", count: 10000, quantity_milli: "10000000000000000" };
    expect(accepts(responseSchema(`${order}/entries/summary`), { data: [group] })).toBe(true);
    expect(accepts(schemas.EntrySummary, { data: [{ ...group, quantity_milli: null }] })).toBe(true);
    expect(accepts(schemas.EntrySummary, { data: [{ ...group, quantity_milli: 1500 }] })).toBe(false);
  });

  it("publica exemplos coerentes com criação, lista e projeção de cliente", () => {
    const examples = (path: string, method = "get") => operation(path, method).responses["200"].content["application/json"].examples;
    for (const { value } of Object.values(examples(base, "post")) as any[]) {
      expect(value.version).toBe(1);
      expect(value.status).toBe("received");
      expect(accepts(schemas.ServiceOrder, value)).toBe(true);
    }
    const { value: builtin } = examples(order).builtin;
    expect(builtin.next_stages.map((s: any) => s.transition_id)).toEqual(["received_analyzing", "received_in_progress", "received_cancelled"]);
    const list = schemas.ServiceOrderList.example;
    expect(list.data.map((row: any) => row.number)).toEqual([43, 42]);
    expect(list.next_cursor).toBeNull();
    expect(list.data.every((row: any) => !row.history)).toBe(true);
    for (const { value } of Object.values(examples(`${base}/conversation/{id}/orders/{order_id}`)) as any[]) {
      expect(Object.keys(value.customer)).toEqual(["name"]);
      for (const key of ["notes", "assignee", "created_by", "history"]) expect(value[key]).toBeUndefined();
      expect(value.next_statuses).toEqual([]);
      expect(value.next_stages).toEqual([]);
      expect(value.fields.every((f: any) => f.client_visible && !f.sensitive)).toBe(true);
      expect(Object.keys(value.extra).every((id) => value.fields.some((f: any) => f.id === id))).toBe(true);
      expect(accepts(schemas.ServiceOrder, value)).toBe(true);
    }
    expect(examples(`${order}/status`, "post")).toBeUndefined();
  });

  it("publica os erros alcançáveis de modelo inexistente e documento pendente", () => {
    for (const [path, status, code] of [
      [`${templates}/preview`, "404", "template_not_found"],
      [`${templates}/apply`, "404", "template_not_found"],
      [`${order}/documents/{document_id}/send`, "409", "document_not_ready"],
    ]) {
      const error = operation(path, "post").responses[status];
      expect(error.description).toContain(code);
      expect(error.content["application/json"].examples[code].value.error.code).toBe(code);
    }
  });

  it("oferece exemplos válidos de embutido e personalizado legíveis pelos clientes antigos", () => {
    const examples =
      operation(order).responses["200"].content["application/json"].examples;
    for (const { value } of Object.values(examples) as { value: any }[]) {
      expect(accepts(schemas.ServiceOrder, value)).toBe(true);
      expect(statuses).toContain(value.status);
      expect(Number.isInteger(value.number)).toBe(true);
      expect(typeof value.item).toBe("string");
      expect(typeof value.problem).toBe("string");
      expect(
        value.next_statuses.every((status: string) =>
          statuses.includes(status),
        ),
      ).toBe(true);
    }
    expect(examples.builtin.value).toMatchObject({
      type_id: "service_order",
      extra: {},
      fields: [],
      stage: "received",
    });
    const custom = examples.custom.value;
    expect(
      custom.next_stages.some(
        (stage: any) => stage.base_status === custom.status,
      ),
    ).toBe(true);
    expect(custom.next_statuses).not.toContain(custom.stage);
    expect(custom.number).not.toBe(custom.type_number);
    expect(
      accepts(schemas.ServiceOrderList, schemas.ServiceOrderList.example),
    ).toBe(true);
  });

  it("descreve filtros, versões, filhos e projeções públicas sem armazenamento interno", () => {
    const names = (path: string) =>
      operation(path)
        .parameters.filter((p: any) => p.in === "query")
        .map((p: any) => p.name);
    expect(names(base)).toEqual(
      expect.arrayContaining(["type_id", "stage", "facets", "cursor", "limit"]),
    );
    expect(names(order)).toContain("history");
    expect(names(`${base}/types`)).toContain("include_archived");
    for (const collection of [
      "history",
      "tasks",
      "people",
      "documents",
      "entries",
    ]) {
      const entry = operation(`${order}/${collection}`);
      expect(entry.parameters).toContainEqual(
        expect.objectContaining({
          name: "limit",
          schema: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            ...(collection === "history" ? {} : { default: 50 }),
          },
        }),
      );
      const page = responseSchema(`${order}/${collection}`);
      expect(page.required).toEqual(["data", "next_cursor"]);
      expect(page.properties.next_cursor.type).toEqual(["string", "null"]);
    }
    for (const name of [
      "StageRequest",
      "StageApprovalRequest",
      "StageApprovalDecisionRequest",
      "PrivateFieldsRequest",
      "UpdateTaskRequest",
      "UpdatePersonRequest",
      "ReviseEntryRequest",
      "CompleteDocumentRequest",
      "VersionRequest",
    ]) {
      expect(schemas[name].required).toContain("version");
    }
    expect(schemas.StageApprovalDecisionRequest.required).toContain(
      "approval_version",
    );
    expect(Object.keys(schemas.PrivateFieldsResult.properties)).toEqual([
      "id",
      "version",
      "changed_fields",
    ]);
    expect(schemas.LinkedPerson.required).not.toContain("phone");
    expect(schemas.LinkedPerson.required).not.toContain("note");
    for (const name of ["Task", "LinkedPerson", "DocumentMetadata", "Entry"]) {
      expect(schemas[name].properties.profile_id).toBeUndefined();
      expect(schemas[name].properties.r2_key).toBeUndefined();
    }
    expect(operation(`${order}/private-fields`).description).toContain(
      "os:sensitive",
    );
  });

  it("modela upload binário, confirmação e download sem cache", () => {
    const path = `${order}/documents/{document_id}/content`;
    const upload = operation(path, "put");
    expect(
      upload.requestBody.content["application/octet-stream"].schema.format,
    ).toBe("binary");
    expect(upload.parameters).toContainEqual(
      expect.objectContaining({
        in: "header",
        name: "Upload-Version",
        required: true,
      }),
    );
    expect(responseSchema(path, "put").required).toEqual([
      "id",
      "version",
      "upload_attempt",
      "byte_length",
      "sha256",
    ]);
    for (const collection of ["documents", "private-documents"]) {
      const download = operation(`${order}/${collection}/{document_id}/content`).responses["200"];
      expect(Object.keys(download.content)).toEqual([...DOCUMENT_MIME_TYPES]);
      for (const mime of DOCUMENT_MIME_TYPES)
        expect(download.content[mime].schema.format).toBe("binary");
      expect(download.headers["Cache-Control"].schema.enum).toEqual(["no-store"]);
    }
    expect(schemas.CreateDocumentRequest.properties.mime_type.enum).toEqual([...DOCUMENT_MIME_TYPES]);
    expect(
      schemas.CreateDocumentRequest.properties.expected_bytes.maximum,
    ).toBe(10485760);
    expect(schemas.CompleteDocumentRequest.required).toEqual([
      "version",
      "upload_attempt",
    ]);
  });

  it("define manifestos exclusivos e modelos administrativos independentes de os", () => {
    for (const { path, method } of routes.filter(({ path }) =>
      path.startsWith(templates),
    )) {
      expect(operation(path, method).description).toContain(
        "Exige administrador",
      );
      expect(operation(path, method).description).toContain(
        "Funciona com os desligado",
      );
      expect(
        operation(path, method).responses["409"].description,
      ).not.toContain("module_disabled");
    }
    const selection = {
      work_type_ids: [],
      module_ids: [],
      menus: false,
      departments: false,
      ticket_categories: false,
      vocabulary: false,
      texts: false,
      bot_suggestions: false,
    };
    expect(
      accepts(schemas.AreaTemplatePreviewRequest, {
        template_id: "servicos",
        selection,
      }),
    ).toBe(true);
    expect(
      accepts(schemas.AreaTemplatePreviewRequest, {
        template_id: "servicos",
        manifest: {},
        selection,
      }),
    ).toBe(false);
    expect(accepts(schemas.AreaTemplatePreviewRequest, { selection })).toBe(
      false,
    );
    expect(
      accepts(schemas.AreaTemplateApplyRequest, {
        template_id: "servicos",
        selection,
      }),
    ).toBe(false);
    expect(
      accepts(schemas.AreaTemplateApplyRequest, {
        template_id: "servicos",
        selection,
        preview_hash: "hash",
      }),
    ).toBe(true);
    expect(schemas.AreaTemplateApplyResult.properties.applied.type).toBe(
      "boolean",
    );
    expect(schemas.TemplateMenu.oneOf[2].properties.type.enum).toEqual([
      "message",
    ]);
  });

  it("resolve todas as referências publicadas pelas rotas e esquemas novos", () => {
    const visited = new Set<string>();
    function walk(value: any) {
      if (!value || typeof value !== "object") return;
      if (value.$ref?.startsWith("#/components/schemas/")) {
        const name = value.$ref.split("/").at(-1);
        expect(schemas[name], name).toBeTruthy();
        if (!visited.has(name)) {
          visited.add(name);
          walk(schemas[name]);
        }
      }
      for (const child of Object.values(value)) walk(child);
    }
    for (const [method, path] of moduleOperations.filter(([, path]) => path.startsWith(base) || path.startsWith(templates)))
      walk(operation(path, method));
  });
});
