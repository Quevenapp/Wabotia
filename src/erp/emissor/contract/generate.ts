// Contrato do cofre NFapi (OpenAPI 3.1): gerador de tipos, lista de operações
// e comparação entre duas versões do contrato. Funções puras, sem rede nem
// disco, usadas em três lugares:
// - contract/sync.mjs (node): copia um openapi.json novo e regera
//   types.generated.ts;
// - tests/erp/emissor/contract.test.ts: falha quando a cópia versionada muda
//   sem os tipos e o cliente acompanharem;
// - config.ts ("Testar conexão"): compara o contrato servido pelo cofre
//   (GET /v1/openapi.json) com a cópia versionada.
//
// Só o subconjunto de JSON Schema que o contrato usa: $ref, allOf, anyOf,
// oneOf, const, enum, type (também em lista, com "null"), properties,
// required e items. Restrições (pattern, minLength...) viram comentário: o
// cofre é quem valida.

export interface OpenApi {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, Schema>; securitySchemes?: unknown };
}
export type Schema = Record<string, any>;

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

export interface Operation {
  /** "POST /v1/nfe/{id}/cancelar" */
  key: string;
  method: string;
  path: string;
  /** Códigos de resposta declarados, em ordem. */
  responses: string[];
  /** Schema do corpo do pedido (ref), quando há. */
  request: string | null;
  /** Schema da resposta de sucesso (ref ou "inline"/"text"). */
  success: Record<string, string>;
  /** Parâmetros de consulta. */
  query: string[];
}

const refName = (ref: string) => ref.replace(/^#\/components\/schemas\//, "");

function schemaLabel(schema: Schema | undefined, contentType: string) {
  if (!schema) return contentType || "none";
  if (schema.$ref) return refName(schema.$ref);
  if (schema.type === "string") return "text";
  return "inline:" + JSON.stringify(schema);
}

/** Operações do contrato, em ordem de caminho e método. */
export function operationsOf(spec: OpenApi): Operation[] {
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op || typeof op !== "object") continue;
      const body = op.requestBody?.content?.["application/json"]?.schema;
      const success: Record<string, string> = {};
      for (const [code, response] of Object.entries<any>(op.responses || {})) {
        if (!/^2/.test(code)) continue;
        const [type, media] = Object.entries<any>(response.content || {})[0] || ["", null];
        success[code] = schemaLabel(media?.schema, type);
      }
      out.push({
        key: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        responses: Object.keys(op.responses || {}),
        request: body?.$ref ? refName(body.$ref) : body ? "inline" : null,
        success,
        query: [...(item.parameters || []), ...(op.parameters || [])]
          .filter((p: any) => p.in === "query")
          .map((p: any) => p.name),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tipos

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const literal = (value: unknown) => JSON.stringify(value);
const propName = (name: string) => (IDENT.test(name) ? name : literal(name));

function constraints(schema: Schema) {
  const keys = [
    "format",
    "pattern",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minItems",
    "maxItems",
    "default",
  ];
  return keys
    .filter((k) => schema[k] !== undefined)
    .map((k) => `${k}: ${typeof schema[k] === "string" ? schema[k] : JSON.stringify(schema[k])}`);
}

function doc(schema: Schema, indent: string) {
  const lines: string[] = [];
  if (typeof schema.description === "string") lines.push(...schema.description.split("\n"));
  const rules = constraints(schema);
  if (rules.length) lines.push(rules.join("; "));
  if (!lines.length) return "";
  const safe = lines.map((line) => line.replace(/\*\//g, "*\\/"));
  if (safe.length === 1) return `${indent}/** ${safe[0]} */\n`;
  return `${indent}/**\n${safe.map((l) => `${indent} * ${l}`.trimEnd()).join("\n")}\n${indent} */\n`;
}

function primitive(type: string, schema: Schema, indent: string): string {
  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `${wrap(typeOf(schema.items || {}, indent))}[]`;
    case "object":
      return objectType(schema, indent);
    default:
      return "unknown";
  }
}

const wrap = (t: string) => (/[|&]/.test(t) && !/^\{[\s\S]*\}$/.test(t) ? `(${t})` : t);

function objectType(schema: Schema, indent: string): string {
  const props = schema.properties as Record<string, Schema> | undefined;
  if (!props) return "Record<string, unknown>";
  const required = new Set<string>(schema.required || []);
  const inner = indent + "  ";
  const fields = Object.entries(props).map(
    ([name, child]) =>
      `${doc(child, inner)}${inner}${propName(name)}${required.has(name) ? "" : "?"}: ${typeOf(child, inner)};`,
  );
  return `{\n${fields.join("\n")}\n${indent}}`;
}

/** Tipo TypeScript de um schema. */
export function typeOf(schema: Schema, indent = ""): string {
  if (schema.$ref) return refName(schema.$ref);
  if (schema.const !== undefined) return literal(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(" | ");
  if (Array.isArray(schema.allOf)) return schema.allOf.map((s: Schema) => wrap(typeOf(s, indent))).join(" & ");
  const union = schema.oneOf || schema.anyOf;
  if (Array.isArray(union)) return union.map((s: Schema) => wrap(typeOf(s, indent))).join(" | ");
  if (Array.isArray(schema.type))
    return schema.type.map((t: string) => primitive(t, schema, indent)).join(" | ");
  if (typeof schema.type === "string") return primitive(schema.type, schema, indent);
  if (schema.properties) return objectType(schema, indent);
  return "unknown";
}

/** Fonte de types.generated.ts. Determinística: mesmo contrato, mesmo texto. */
export function generateTypes(spec: OpenApi): string {
  const out: string[] = [
    "// GERADO por src/erp/emissor/contract/sync.mjs a partir de contract/openapi.json.",
    "// Não edite à mão: copie o contrato novo e rode o sync (README.md desta pasta).",
    `// ${spec.info.title} ${spec.info.version} (OpenAPI ${spec.openapi}).`,
    "/* eslint-disable */",
    "",
    `export const CONTRACT_VERSION = ${literal(spec.info.version)};`,
    "",
  ];
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    out.push(`${doc(schema, "")}export type ${name} = ${typeOf(schema)};`, "");
  }
  out.push("/** Operações do contrato (método e caminho). */");
  out.push("export const CONTRACT_OPERATIONS = [");
  for (const op of operationsOf(spec)) out.push(`  ${literal(op.key)},`);
  out.push("] as const;");
  out.push("export type ContractOperation = (typeof CONTRACT_OPERATIONS)[number];", "");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Comparação

/** Forma do contrato que importa para o cliente, sem textos nem exemplos. */
export function contractShape(spec: OpenApi) {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (["description", "example", "examples", "summary", "title"].includes(key)) continue;
      out[key] = strip((value as Record<string, unknown>)[key]);
    }
    return out;
  };
  const operations: Record<string, unknown> = {};
  for (const op of operationsOf(spec))
    operations[op.key] = { responses: op.responses, request: op.request, success: op.success, query: op.query };
  return {
    operations,
    schemas: strip(spec.components.schemas) as Record<string, unknown>,
  };
}

/**
 * Diferenças entre o contrato versionado e outro (o servido pelo cofre ou uma
 * cópia nova). Lista legível, vazia quando são equivalentes para o cliente.
 */
export function contractDiff(pinned: OpenApi, other: OpenApi): string[] {
  const a = contractShape(pinned),
    b = contractShape(other);
  const out: string[] = [];
  const compare = (
    [removed, changed, added]: [string, string, string],
    left: Record<string, unknown>,
    right: Record<string, unknown>,
  ) => {
    for (const key of Object.keys(left))
      if (!(key in right)) out.push(`${removed}: ${key}`);
      else if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) out.push(`${changed}: ${key}`);
    for (const key of Object.keys(right)) if (!(key in left)) out.push(`${added}: ${key}`);
  };
  compare(["operação removida", "operação alterada", "operação nova"], a.operations, b.operations);
  compare(["schema removido", "schema alterado", "schema novo"], a.schemas, b.schemas);
  return out;
}

/** "0.3.0" e "0.3.7" são compatíveis; "0.4.0" não (antes da 1.0, a minor quebra). */
export function compatibleVersion(pinned: string, other: string) {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? null;
  const p = parse(pinned),
    o = parse(other);
  if (!p || !o) return false;
  if (p[0] === 0) return o[0] === 0 && o[1] === p[1];
  return o[0] === p[0] && o[1] >= p[1];
}
