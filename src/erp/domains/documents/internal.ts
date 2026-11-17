// Documentos (erp_documents): funções internas. Portado de
// erp_documents.auto_products, a parte de erp_document_save que chama o
// catálogo (outro domínio) com o comando do documento.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { intIn } from "../../engine/args.ts";
import { pgBtrim, pgHasCntrl, pgLength } from "../../engine/text.ts";
import { validDate } from "../../engine/time.ts";
import { raise } from "../../engine/errors.ts";
import { arrow, jsonType } from "../../engine/json.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { autoProductKey, documentProduct } from "../catalog/public.ts";
import * as preferences from "../preferences/public.ts";

/** erp_documents.auto_products(p_user_id, p_kind, p_command, p_items) */
export function autoProducts(ctx: RpcContext, user: string, kind: string | null, command: string | null, items: unknown) {
  const list = () => {
    if (jsonType(items) !== "array")
      raise("22023", `cannot extract elements from ${jsonType(items) === "object" ? "an object" : "a scalar"}`);
    return items as unknown[];
  };
  if (
    preferences.get(ctx.db, autoProductKey(kind)) !== true ||
    !list().some((i) => arrow(i, "product_id") === null) ||
    (kind === "sales_orders" &&
      one(ctx.db, 'SELECT 1 x FROM "erp_catalog__seller" WHERE user_id=? AND allow_unregistered_products=0', user))
  )
    return items;
  return list().map((raw) => {
    if (arrow(raw, "product_id") !== null) return raw;
    const item = raw as Record<string, unknown>;
    const id = documentProduct(
      ctx,
      user,
      kind,
      command,
      kind === "service_orders" && arrow(item, "group") === "service" ? { ...item, kind: "S" } : item,
    );
    return id === null ? raw : { ...item, product_id: id };
  });
}

// ---------------------------------------------------------------------------
// Ajudantes do Documentos (sessão O, dona do domínio): leitura de valores do
// corpo, preferências, decimais e aprovação de desconto. Usados pelas
// leituras (sessão L, documents/rpc/reads-*.ts) e pelos escritores: ninguém
// escreve segunda versão; mudança aqui passa pela O.

/** erp_documents.preference(chave): erp_preferences.get */
export const preference = (db: SqlDriver, key: string) => preferences.get(db, key);

/** erp_documents.text_value(valor, máx, obrigatório=false, várias_linhas=false) */
export function textValue(value: unknown, max: number, required = false, multiline = false): string | null {
  let v: string | null;
  if (value === undefined || value === null) v = null;
  else if (jsonType(value) !== "string") raise("22023", "erp_document_text_invalid");
  else v = pgBtrim(value as string) || null;
  if (
    (required && v! === null) ||
    (v! !== null && (pgLength(v!) > max || pgHasCntrl.test(multiline ? v!.replace(/[\n\r\t]/g, "") : v!)))
  )
    raise("22023", "erp_document_text_invalid");
  return v!;
}

/** erp_documents.decimal_value(valor, casas, dígitos): o texto validado (numeric exato). */
export function decimalValue(value: unknown, precision: number, digits: number): string {
  if (value === undefined || value === null || jsonType(value) !== "string") raise("22023", "erp_document_decimal_invalid");
  const v = value as string;
  if (!new RegExp(`^(0|[1-9][0-9]{0,${digits - 1}})(\\.[0-9]{1,${precision}})?$`).test(v)) raise("22023", "erp_document_decimal_invalid");
  return v;
}

/** erp_documents.date_value(valor, obrigatório=false) */
export function dateValue(value: unknown, required = false): string | null {
  const v = textValue(value, 10, required);
  if (v === null) return null;
  if (!/^(19|20)[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(v) || !validDate(v)) raise("22023", "erp_document_date_invalid");
  return v;
}

/** erp_documents.uuid_value(valor, obrigatório=false) */
export function uuidValue(value: unknown, required = false): string | null {
  const v = textValue(value, 36, required);
  if (v !== null && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v)) raise("22023", "erp_document_id_invalid");
  return v === null ? null : v.toLowerCase();
}

/** erp_documents.price_decimals(preço): casas depois de tirar os zeros à direita. */
export const priceDecimals = (price: string | null) => (price === null ? 0 : (price.split(".")[1] ?? "").replace(/0+$/, "").length);

/** erp_documents.quantity_decimals(): empresa.decimais_quantidade entre 0 e 6 (padrão 6). */
export function quantityDecimals(db: SqlDriver): number {
  const p = preference(db, "empresa.decimais_quantidade");
  const n = typeof p === "number" ? Number(intIn(String(p), "integer")) : 6;
  return Math.min(Math.max(n, 0), 6);
}

/** erp_documents.discount_approver(usuário, tipo): admin, ou o cartão do documento com limite_desconto. */
export function discountApprover(db: SqlDriver, user: string | null, kind: string | null): boolean {
  if (user === null) return false;
  if (one(db, `SELECT 1 x FROM "erp_access__membership" WHERE user_id=? AND active=1 AND role='admin'`, user)) return true;
  const module = kind === "sales_orders" ? "vendas.pedidos_venda" : kind === "sales_proposals" ? "vendas.propostas" : null;
  if (module === null) return false;
  const c = one(db, 'SELECT permissions FROM "erp_access__user_control" WHERE user_id=?', user);
  if (!c || c.permissions === null) return false;
  const list = JSON.parse(String(c.permissions)) as (string | null)[];
  return list.includes(module) && list.includes(`${module}.limite_desconto`);
}

/** erp_documents.approval_situations(): as situações de aprovação (pedidos de venda em rascunho), na ordem gravada. */
export function approvalSituations(db: SqlDriver): string[] {
  const a = one(db, 'SELECT situation_ids FROM "erp_documents__discount_approval" WHERE singleton=1');
  if (!a) return [];
  return (JSON.parse(String(a.situation_ids)) as string[]).filter(
    (id) => !!one(db, `SELECT 1 x FROM "erp_preferences__situation" WHERE id=? AND kind='sales_orders' AND base_status='draft'`, id),
  );
}