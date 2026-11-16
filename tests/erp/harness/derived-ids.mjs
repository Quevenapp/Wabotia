// Identificadores derivados de uuid (pedido da P, Catálogo): valores gravados
// a partir de um uuid aleatório, que por isso diferem nos dois motores mesmo
// quando o comportamento é igual. Exemplo: o slug de tipo de contato criado
// pelo usuário, 't' || replace(id::text,'-','').
//
// Cada formato é DECLARADO, com:
//   - id: nome único, "<domínio>.<o quê>";
//   - pattern: regex ancorada; o grupo 1 é o que volta para o uuid;
//   - toUuid(m): o match → uuid canônico (minúsculo, com hífens);
//   - fromUuid(u): o uuid → o valor derivado (ida e volta exata);
//   - columns: onde o formato pode aparecer nas tabelas, "tabela.coluna".
//     Coluna de texto: o valor inteiro. Coluna json ou array: só os textos
//     sob as chaves de `keys` (o elemento de um array conta como da chave do
//     array);
//   - keys: chaves da resposta do RPC (e dos json acima) onde o valor pode
//     aparecer.
// Fora desses lugares o texto é comparado literalmente: um padrão solto
// casaria com texto comum por acidente.
//
// O comparador trata o valor derivado como o uuid de onde veio: dois slugs
// só se correspondem se os uuids de origem se correspondem (o mesmo par que
// liga o id da linha). Slug que aponta para outro registro não liga.
import { ERP_TABLES } from "../../../src/erp/schema/columns.generated.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex32ToUuid = (h) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toLowerCase();

const registry = new Map();

/** Registra um formato derivado (valida a declaração; id repetido é erro). */
export function registerDerivedId(spec) {
  const { id, pattern, toUuid, fromUuid, columns = [], keys = [] } = spec;
  if (!/^[a-z_]+\.[a-z0-9_.]+$/.test(id ?? "")) throw new Error(`Formato derivado: id "${id}" fora do padrão <domínio>.<nome>.`);
  if (registry.has(id)) throw new Error(`Formato derivado ${id} já registrado.`);
  if (!(pattern instanceof RegExp) || !pattern.source.startsWith("^") || !pattern.source.endsWith("$") || pattern.flags.includes("g"))
    throw new Error(`Formato derivado ${id}: a regex precisa ser ancorada (^…$) e sem /g.`);
  if (typeof toUuid !== "function" || typeof fromUuid !== "function") throw new Error(`Formato derivado ${id}: falta toUuid ou fromUuid.`);
  if (!columns.length && !keys.length) throw new Error(`Formato derivado ${id}: diga onde ele aparece (columns ou keys).`);
  for (const c of columns) {
    const [table, column] = c.split(".");
    const col = ERP_TABLES[table]?.columns[column];
    if (!col) throw new Error(`Formato derivado ${id}: coluna ${c} não existe.`);
    if (col.codec === "uuid") throw new Error(`Formato derivado ${id}: ${c} já é uuid.`);
    if ((col.codec === "json" || col.codec.startsWith("array:")) && !keys.length)
      throw new Error(`Formato derivado ${id}: ${c} é json/array; diga as chaves (keys).`);
  }
  // Ida e volta com um uuid de exemplo.
  const sample = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
  const text = fromUuid(sample);
  const m = pattern.exec(text);
  if (!m || toUuid(m) !== sample) throw new Error(`Formato derivado ${id}: ida e volta falhou (${text}).`);
  const frozen = Object.freeze({ id, pattern, toUuid, fromUuid, columns: new Set(columns), keys: new Set(keys) });
  registry.set(id, frozen);
  return frozen;
}

/** Os formatos registrados (todos os domínios). */
export const derivedIds = () => [...registry.values()];

/** Formatos que valem numa coluna de tabela (texto inteiro ou json sob `key`). */
export function derivedFor(specs, table, column, key) {
  const where = `${table}.${column}`;
  return specs.filter((s) => s.columns.has(where) && (key === undefined || s.keys.has(key)));
}

/** uuid de origem do valor, se o texto casa com o formato (senão null). */
export function derivedUuid(spec, text) {
  if (typeof text !== "string") return null;
  const m = spec.pattern.exec(text);
  if (!m) return null;
  const u = spec.toUuid(m);
  return UUID.test(u) ? u : null;
}

// ---------------------------------------------------------------------------
// Arrays ordenados por id gerado na chamada ("order by id" sobre ids novos):
// a ordem vem do uuid aleatório e muda entre os motores. DECLARADO, como os
// formatos acima:
//   - id: "<domínio>.<o quê>";
//   - keys: chaves (resposta e json) cujo valor é o array;
//   - by: campo do elemento com o id (null: o elemento é o próprio id);
//   - dir: "asc" (padrão, a ordem do uuid no Postgres) ou "desc";
//   - columns: colunas json onde o array é gravado ("tabela.coluna").
// Só onde declarado, e só se o array estiver de fato nessa ordem pelos ids
// novos do próprio lado, a comparação ignora a ordem (casa elemento a
// elemento ligando os ids). Declarado e fora da ordem num dos lados é
// divergência. Fora das declarações, ordem é ordem.

const orders = new Map();

export function registerNewIdOrder(spec) {
  const { id, keys = [], by = null, dir = "asc", columns = [] } = spec;
  if (!/^[a-z_]+\.[a-z0-9_.]+$/.test(id ?? "")) throw new Error(`Ordem por id novo: id "${id}" fora do padrão <domínio>.<nome>.`);
  if (orders.has(id)) throw new Error(`Ordem por id novo ${id} já registrada.`);
  if (!keys.length) throw new Error(`Ordem por id novo ${id}: diga as chaves do array (keys).`);
  if (!["asc", "desc"].includes(dir)) throw new Error(`Ordem por id novo ${id}: dir é asc ou desc.`);
  for (const c of columns) {
    const [table, column] = c.split(".");
    const col = ERP_TABLES[table]?.columns[column];
    if (!col) throw new Error(`Ordem por id novo ${id}: coluna ${c} não existe.`);
    if (col.codec !== "json") throw new Error(`Ordem por id novo ${id}: ${c} não é json.`);
  }
  const frozen = Object.freeze({ id, keys: new Set(keys), by, dir, columns: new Set(columns) });
  orders.set(id, frozen);
  return frozen;
}

export const newIdOrders = () => [...orders.values()];

/** A declaração que vale para o array sob `key` (na resposta: where null). */
export function orderFor(key, where = null) {
  for (const o of orders.values()) if (o.keys.has(key) && (where === null || o.columns.has(where))) return o;
  return null;
}

// ---------------------------------------------------------------------------
// Declarações por domínio. Nova entrada: peça à N (pasta congelada), com o
// trecho do Fagoo que grava o valor.

// Catálogo (P): erp_catalog_contact_type_create, migração
// 202610200124_contact_profile.sql: slug = 't' || replace(v_id::text,'-','').
// O slug aparece no próprio tipo, no "item" da auditoria auxiliar e do
// recibo de comando (resposta gravada para repetição) e nos "types" do
// contato (resposta e auditoria do cadastro). contact.roles só guarda os três
// tipos fixos (customer, supplier, carrier): fica de fora.
registerDerivedId({
  id: "catalog.contact_type_slug",
  pattern: /^t([0-9a-f]{32})$/,
  toUuid: (m) => hex32ToUuid(m[1]),
  fromUuid: (u) => "t" + u.replace(/-/g, ""),
  columns: [
    "erp_catalog__contact_type.slug",
    "erp_catalog__command.result",
    "erp_catalog__auxiliary_audit.after_data",
    "erp_catalog__auxiliary_audit.before_data",
    "erp_catalog__audit.after_data",
    "erp_catalog__audit.before_data",
  ],
  keys: ["slug", "types"],
});

// Financeiro (O): erp_finance_bordero_execute settle_batch sem agrupamento,
// migrações 202610200110_finance_bordero.sql e 202610200249_finance_settle_history.sql:
// 'borderos', jsonb_agg(erp_finance.bordero_dto(b,false) order by b) sobre os
// ids dos borderôs novos. A resposta também é gravada na auditoria e no
// recibo de comando.
registerNewIdOrder({
  id: "finance.settle_batch_borderos",
  keys: ["borderos"],
  by: "id",
  dir: "asc",
  columns: ["erp_finance__audit.after_data", "erp_finance__command.result"],
});
