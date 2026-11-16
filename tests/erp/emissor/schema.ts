// Validador mínimo de JSON Schema para o contrato do cofre NFapi: o
// subconjunto que o contrato usa. `strict` recusa propriedade fora do schema,
// para o cofre simulado não inventar campos.
import contract from "../../../src/erp/emissor/contract/openapi.json";

type Schema = Record<string, any>;
const spec = contract as any;

export function resolve(schema: Schema): Schema {
  let s = schema;
  while (s?.$ref) s = spec.components.schemas[s.$ref.replace("#/components/schemas/", "")];
  return s;
}

const typeOk = (type: string, v: unknown) =>
  type === "null"
    ? v === null
    : type === "integer"
      ? Number.isInteger(v)
      : type === "number"
        ? typeof v === "number" && Number.isFinite(v)
        : type === "array"
          ? Array.isArray(v)
          : type === "object"
            ? !!v && typeof v === "object" && !Array.isArray(v)
            : typeof v === type;

/** Propriedades conhecidas de um schema (inclui allOf). */
function knownProps(schema: Schema): Set<string> | null {
  const s = resolve(schema);
  if (s.allOf) {
    const all = new Set<string>();
    for (const part of s.allOf) {
      const p = knownProps(part);
      if (!p) return null;
      p.forEach((k) => all.add(k));
    }
    return all;
  }
  return s.properties ? new Set(Object.keys(s.properties)) : null;
}

export function validate(schema: Schema, value: unknown, path = "$", strict = false): string[] {
  const s = resolve(schema);
  const errors: string[] = [];
  if (!s) return [`${path}: schema ausente`];
  if (s.allOf) {
    for (const part of s.allOf) errors.push(...validate(part, value, path, false));
    if (strict && value && typeof value === "object" && !Array.isArray(value)) {
      const known = knownProps(s);
      if (known) for (const k of Object.keys(value)) if (!known.has(k)) errors.push(`${path}.${k}: fora do contrato`);
    }
    return errors;
  }
  const union = s.oneOf || s.anyOf;
  if (union) {
    const ok = union.filter((part: Schema) => validate(part, value, path, strict).length === 0).length;
    if (s.oneOf ? ok !== 1 : ok < 1) errors.push(`${path}: não casa com ${s.oneOf ? "oneOf" : "anyOf"}`);
    return errors;
  }
  if (s.const !== undefined && value !== s.const) errors.push(`${path}: esperado ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} fora do enum`);
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t: string) => typeOk(t, value))) {
      errors.push(`${path}: tipo ${JSON.stringify(s.type)} esperado, veio ${JSON.stringify(value)?.slice(0, 40)}`);
      return errors;
    }
  }
  if (typeof value === "string") {
    if (s.pattern && !new RegExp(s.pattern, "u").test(value)) errors.push(`${path}: não casa com ${s.pattern}`);
    if (s.minLength !== undefined && [...value].length < s.minLength) errors.push(`${path}: curto`);
    if (s.maxLength !== undefined && [...value].length > s.maxLength) errors.push(`${path}: longo`);
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) errors.push(`${path}: < ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) errors.push(`${path}: > ${s.maximum}`);
    if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) errors.push(`${path}: <= ${s.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${path}: poucos itens`);
    if (s.maxItems !== undefined && value.length > s.maxItems) errors.push(`${path}: itens demais`);
    if (s.items) value.forEach((item, i) => errors.push(...validate(s.items, item, `${path}[${i}]`, strict)));
  }
  if (value && typeof value === "object" && !Array.isArray(value) && s.properties) {
    const obj = value as Record<string, unknown>;
    for (const name of s.required || []) if (!(name in obj)) errors.push(`${path}.${name}: obrigatório`);
    for (const [name, child] of Object.entries<Schema>(s.properties))
      if (name in obj && obj[name] !== undefined) errors.push(...validate(child, obj[name], `${path}.${name}`, strict));
    if (strict) for (const k of Object.keys(obj)) if (!(k in s.properties)) errors.push(`${path}.${k}: fora do contrato`);
  }
  return errors;
}

/** Operação do contrato (método, caminho do contrato). */
export function operation(method: string, path: string) {
  return spec.paths[path]?.[method.toLowerCase()];
}

export function requestSchema(method: string, path: string): Schema | null {
  return operation(method, path)?.requestBody?.content?.["application/json"]?.schema ?? null;
}

export function requestExample(method: string, path: string): any {
  return structuredClone(operation(method, path)?.requestBody?.content?.["application/json"]?.example);
}

/** Schema da resposta `status` (JSON) ou null quando não é JSON. */
export function responseSchema(method: string, path: string, status: number): Schema | null | undefined {
  const r = operation(method, path)?.responses?.[String(status)];
  if (!r) return undefined;
  return r.content?.["application/json"]?.schema ?? null;
}
