import { describe, expect, it } from "vitest";
import contract from "../docs/areas/CONTRATO-MOTOR.md?raw";
import { openapi } from "../src/openapi";
import { moduleOperations } from "../src/modules/openapi";

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

// A expectativa vem do documento congelado, não do catálogo que produz a API.
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
    expect(routes).toHaveLength(45);
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

  it("conserva os nove estados, contagem esparsa e tipos legados", () => {
    expect(schemas.ServiceOrder.properties.status.enum).toEqual(statuses);
    expect(schemas.ServiceOrder.properties.next_statuses.items.enum).toEqual(
      statuses,
    );
    expect(schemas.BaseStatus.enum).toEqual(statuses);
    expect(schemas.ServiceOrderStatus.properties.status.enum).toEqual([
      "analyzing",
      "in_progress",
      "ready",
      "delivered",
      "cancelled",
    ]);
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
    const download = operation(path).responses["200"];
    expect(download.content["application/json"]).toBeUndefined();
    expect(download.content["application/octet-stream"].schema.format).toBe(
      "binary",
    );
    expect(download.headers["Cache-Control"].schema.enum).toEqual(["no-store"]);
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
    for (const { path, method } of routes) walk(operation(path, method));
  });
});
