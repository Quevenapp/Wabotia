// Cofre simulado para as provas Node do preparo: confere o PedidoNfe montado
// contra o schema do contrato versionado (POST /v1/nfe), do mesmo jeito que
// tests/erp/emissor/fake-vault.ts confere os pedidos no Vitest. Estrito:
// propriedade fora do schema é erro, para nenhum grupo inventado passar.
import contract from "../../../src/erp/emissor/contract/openapi.json" with { type: "json" };

const resolve = schema => {
  let s = schema;
  while (s?.$ref) s = contract.components.schemas[s.$ref.replace("#/components/schemas/", "")];
  return s;
};
const known = schema => {
  const s = resolve(schema);
  if (s.allOf) { const all = new Set(); for (const part of s.allOf) { const k = known(part); if (!k) return null; k.forEach(v => all.add(v)); } return all; }
  return s.properties ? new Set(Object.keys(s.properties)) : null;
};
const typeOk = (type, v) => type === "integer" ? Number.isInteger(v) : type === "number" ? typeof v === "number" && Number.isFinite(v)
  : type === "array" ? Array.isArray(v) : type === "object" ? !!v && typeof v === "object" && !Array.isArray(v) : type === "null" ? v === null : typeof v === type;

export function validateAgainst(schema, value, path = "$") {
  const s = resolve(schema), errors = [];
  if (s.allOf) {
    for (const part of s.allOf) errors.push(...validateAgainst({ ...resolve(part), additionalPropertiesCheck: false }, value, path));
    const k = known(s);
    if (k && value && typeof value === "object" && !Array.isArray(value)) for (const key of Object.keys(value)) if (!k.has(key)) errors.push(`${path}.${key}: fora do contrato`);
    return errors;
  }
  const union = s.oneOf ?? s.anyOf;
  if (union) {
    const ok = union.filter(part => validateAgainst(part, value, path).length === 0).length;
    if (s.oneOf ? ok !== 1 : ok < 1) errors.push(`${path}: não casa com ${s.oneOf ? "oneOf" : "anyOf"}`);
    return errors;
  }
  if (s.const !== undefined && value !== s.const) errors.push(`${path}: esperado ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(value)) errors.push(`${path}: fora de ${JSON.stringify(s.enum)}`);
  const types = s.type ? [].concat(s.type) : null;
  if (types && !types.some(t => typeOk(t, value))) return [...errors, `${path}: tipo ${JSON.stringify(s.type)}`];
  if (typeof value === "string") {
    if (s.pattern && !new RegExp(s.pattern).test(value)) errors.push(`${path}: padrão ${s.pattern}`);
    if (s.minLength !== undefined && [...value].length < s.minLength) errors.push(`${path}: curto`);
    if (s.maxLength !== undefined && [...value].length > s.maxLength) errors.push(`${path}: longo`);
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) errors.push(`${path}: abaixo de ${s.minimum}`);
    if (s.maximum !== undefined && value > s.maximum) errors.push(`${path}: acima de ${s.maximum}`);
    if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) errors.push(`${path}: não maior que ${s.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${path}: poucos itens`);
    if (s.maxItems !== undefined && value.length > s.maxItems) errors.push(`${path}: itens demais`);
    if (s.items) value.forEach((item, i) => errors.push(...validateAgainst(s.items, item, `${path}[${i}]`)));
  } else if (value && typeof value === "object") {
    for (const key of s.required ?? []) if (!(key in value)) errors.push(`${path}.${key}: obrigatório`);
    if (s.properties) for (const [key, v] of Object.entries(value)) {
      if (s.properties[key]) errors.push(...validateAgainst(s.properties[key], v, `${path}.${key}`));
      else if (s.additionalPropertiesCheck !== false) errors.push(`${path}.${key}: fora do contrato`);
    }
  }
  return errors;
}

/** Erros do corpo contra o pedido de NF-e do cofre (vazio: o cofre simulado aceita). */
export const pedidoNfeErrors = body => validateAgainst(contract.paths["/v1/nfe"].post.requestBody.content["application/json"].schema, body);
/** O pedido de NF-e do contrato tem esta propriedade em algum nível? */
export function contractHasProperty(name) {
  const seen = new Set();
  const walk = schema => {
    const s = resolve(schema);
    if (!s || typeof s !== "object" || seen.has(s)) return false;
    seen.add(s);
    if (s.properties && Object.hasOwn(s.properties, name)) return true;
    return [...(s.allOf ?? []), ...(s.oneOf ?? []), ...(s.anyOf ?? []), ...(s.items ? [s.items] : []), ...Object.values(s.properties ?? {})].some(walk);
  };
  return walk(contract.components.schemas.PedidoNfe);
}
export const CONTRACT_VERSION = contract.info.version;
