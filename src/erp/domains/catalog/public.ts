// Catálogo (erp_catalog): o que outros domínios chamam. Portado de
// erp_catalog.document_product (cadastro automático de produto a partir do
// item de um documento).
//
// Chamada entre domínios com o mesmo command_id: o documento passa o SEU
// comando, e o catálogo grava o recibo em erp_catalog.command, a mesma tabela
// do erp_catalog_save. Por isso o recibo leva escopo: o id gravado é
// md5('document-auto-product:' || comando || ':' || posição), um por item.
// Sem o escopo, o mesmo id do documento já usado num erp_catalog_save (ou o
// segundo item do mesmo documento) acharia o recibo do outro e daria
// 40001 (hash diferente) ou devolveria o produto errado.
import { createHash } from "node:crypto";
import { one } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { arrow, jsonbText, jsonType } from "../../engine/json.ts";
import { pgLower } from "../../engine/text.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { activeRole } from "../access/public.ts";
import { allowed as documentsAllowed } from "../documents/public.ts";
import * as preferences from "../preferences/public.ts";
import {
  dto,
  insertProduct,
  insertRecord,
  nextProductCode,
  productFull,
  validateData,
  validateProductIdentifiers,
} from "./internal.ts";

export * from "./stubs.generated.ts";
export {
  data,
  dto,
  fold,
  gtinCheckDigit,
  nextProductCode,
  productDetailData,
  productFull,
  unitPrice,
  unitPriceNumeric,
  validateData,
  validateProductIdentifiers,
} from "./internal.ts";
export { allowed, detailUuid, requireAccess } from "./access.ts";
export { employeeAdmin } from "./employee.ts";
export {
  contactDate,
  contactEmailList,
  contactText,
  contactUf,
  matches,
  searchTerms,
  validCnpj,
  validCpf,
} from "./fields.ts";
export { paymentConditionValid } from "./payment-method.ts";
export { sellerAccessAllowed } from "./seller.ts";
// Listas de preço (sessão G): erp_pricing.list_price, require, rule_text, valid_now.
export { listPrice, requirePricing as require, ruleText, validNow } from "./pricing/pricing.ts";
export { erpPricingProductLists } from "./pricing/rpc/erp_pricing_product_lists.ts";

const KINDS = ["sales_proposals", "sales_orders", "purchase_orders", "service_orders"];
const btrim = (s: string) => s.replace(/^ +| +$/g, "");

/** md5(texto)::uuid */
export function md5Uuid(text: string) {
  const h = createHash("md5").update(text, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Recibo com escopo de um comando de outro domínio. */
export const scopedCommand = (scope: string, command: string, part: string) => md5Uuid(`${scope}:${command}:${part}`);

/** Chave da preferência de cadastro automático por tipo de documento. */
export const autoProductKey = (kind: string | null) =>
  kind === "purchase_orders"
    ? "produtos.cadastro_auto_compras"
    : kind === "service_orders"
      ? "produtos.cadastro_auto_os"
      : "produtos.cadastro_auto_vendas";

/** erp_catalog.document_product(p_user_id, p_kind, p_command_id, p_item) → id do produto ou null. */
export function documentProduct(
  ctx: RpcContext,
  user: string,
  kind: string | null,
  command: string | null,
  item: unknown,
): string | null {
  const db = ctx.db;
  const role = activeRole(db, user);
  if (role === null || kind === null || !KINDS.includes(kind) || !documentsAllowed(role, kind, true))
    raise("42501", "erp_catalog_access_denied");
  const it = item as Record<string, unknown>;
  if (
    command === null ||
    item === null ||
    item === undefined ||
    jsonType(item) !== "object" ||
    arrow(it, "product_id") !== null ||
    ("kind" in it && !["P", "S"].includes(arrow(it, "kind") ?? ""))
  )
    raise("22023", "erp_catalog_invalid_command");
  if (preferences.get(db, autoProductKey(kind)) !== true) return null;
  const rawCode = btrim(arrow(it, "code") ?? "");
  const code = rawCode === "" ? null : rawCode;
  if (code !== null) {
    // lower(code)=lower(v_code): o lower do SQLite é só ASCII; compara em TS
    // com o lower do Postgres.
    const target = pgLower(code);
    const hit = db
      .exec(
        `SELECT r.id, r.code FROM "erp_catalog__record" r JOIN "erp_catalog__product" p ON p.record_id=r.id
         WHERE r.entity='products' AND r.active=1 AND r.code IS NOT NULL
         AND NOT EXISTS(SELECT 1 FROM "erp_catalog__product_detail" d WHERE d.record_id=r.id AND d.deleted_at IS NOT NULL)
         ORDER BY r.created_at, r.id`,
      )
      .rows.find((r) => pgLower(String(r.code)) === target);
    if (hit) return String(hit.id);
  }
  const scoped = scopedCommand("document-auto-product", command, arrow(it, "position") ?? "");
  const { position: _position, ...withoutPosition } = it;
  const hash = createHash("sha256")
    .update(jsonbText({ actor: user, action: "document_product", kind, item: withoutPosition }), "utf8")
    .digest("hex");
  const stored = one(db, 'SELECT actor, request_hash, result FROM "erp_catalog__command" WHERE command_id=?', scoped);
  if (stored) {
    if (stored.actor !== user || stored.request_hash !== hash) raise("40001", "erp_catalog_command_conflict");
    const id = (JSON.parse(String(stored.result)) as { record?: { id?: unknown } }).record?.id;
    return id === undefined || id === null ? null : typeof id === "string" ? id : jsonbText(id);
  }
  const origin = preferences.get(db, "produtos.origem_padrao");
  let input: Record<string, unknown> = {
    name: arrow(it, "description"),
    code: code ?? nextProductCode(db, false),
    unit: arrow(it, "unit"),
    kind: arrow(it, "kind") ?? "P",
    format: "S",
    price: kind === "purchase_orders" ? null : arrow(it, "unit_price"),
    origin: typeof origin === "string" && /^[0-8]$/.test(origin) ? origin : null,
  };
  input = validateData("products", input, true);
  validateProductIdentifiers(input, null);
  const id = insertRecord(ctx, {
    entity: "products",
    name: input.name as string,
    code: (input.code as string | null) ?? null,
    active: true,
    actor: user,
    humanEdited: true,
  });
  insertProduct(ctx, id, input);
  const result = { entity: "products", record: dto(db, id), document_kind: kind, replayed: false, data_mode: "erp_native" };
  db.exec(
    'INSERT INTO "erp_catalog__audit"(actor, command_id, entity, record_id, action, before_data, after_data, created_at) VALUES(?,?,?,?,?,NULL,?,?)',
    user,
    scoped,
    "products",
    id,
    "create",
    JSON.stringify({ ...productFull(db, id), created_from: kind }),
    ctx.clock.next().toString(),
  );
  db.exec(
    'INSERT INTO "erp_catalog__command"(command_id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)',
    scoped,
    user,
    hash,
    JSON.stringify(result),
    ctx.clock.next().toString(),
  );
  return id;
}
