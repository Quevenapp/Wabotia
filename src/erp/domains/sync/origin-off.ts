// erp_sync.* que os domínios alcançam, com o Origin fora da instalação
// principal (docs/ERP-FASE0.md, "Origin fora"; desvio origin-fora:
// erp_sync.settings.enabled = false). Um lugar só decide o que "Origin
// desligado" devolve, para cada domínio não decidir por conta.
// - capture_*: gatilhos da fila de saída do espelho; sem efeito com a
//   sincronização desligada.
// - origin_locked / origin_effects: documento espelho travado por efeitos no
//   Bling; sem documento vindo do Origin, nunca travado.
// - stock_import_allowed: só durante a aplicação do espelho (applying); fora
//   dela, falso.
// - guard_zero_title: título zerado só vem do espelho; fora da aplicação,
//   recusa (como o Postgres).
// - origin_number: porte inteiro (função pura).
// O que só existe com o Origin ligado (aplicação do espelho, vínculo com o
// Bling) sai como 0A000 não portado, nunca com um valor inventado.
// tests/erp/sync/origin-off.test.mjs confere contra o oráculo com o desvio.
//
// Regra (orquestração, 17/11/2026; ERP-PORTE.md, "Origin fora"):
// - "Origin fora" vale só para o que precisa do Origin vivo: sincronização,
//   papel do Postgres, chamada à API do Bling;
// - leitura de linha espelhada ou de tabela do Origin (origin_sync.*,
//   erp_catalog.origin*, authority='origin') se porta como leitura: sem dado,
//   dá o mesmo que a constante daria; com dado, é comparada no diferencial;
// - guarda sobre registro espelhado (authority='origin') se porta como guarda;
// - 0A000 visível pode ficar; "sem efeito" silencioso, não.
import { decText } from "../../engine/dec.ts";
import { one } from "../../engine/driver.ts";
import { notPorted, raise } from "../../engine/errors.ts";
import type { RpcContext } from "../../engine/registry.ts";
import { applying, enabled } from "./public.ts";

/** erp_sync.capture_catalog/document/finance/stock: fila de saída do espelho. */
function capture(ctx: RpcContext, name: string) {
  if (!enabled(ctx) || applying(ctx)) return;
  notPorted(`erp_sync.${name}`);
}
export const captureCatalog = (ctx: RpcContext) => capture(ctx, "capture_catalog");
export const captureDocument = (ctx: RpcContext) => capture(ctx, "capture_document");
export const captureFinance = (ctx: RpcContext) => capture(ctx, "capture_finance");
export const captureStock = (ctx: RpcContext) => capture(ctx, "capture_stock");

/** erp_sync.origin_effects(p_id): efeitos do Bling (nota, financeiro) de um documento vindo do Origin. */
export function originEffects(ctx: RpcContext, id: string): { finance: boolean; invoice: boolean } {
  const d = one(ctx.db, 'SELECT origin, kind FROM "erp_documents__document" WHERE id=?', id);
  if (!d || d.origin !== "origin" || !["sales_orders", "service_orders", "purchase_orders"].includes(String(d.kind)))
    return { finance: false, invoice: false };
  const link = one(ctx.db, 'SELECT origin_id FROM "erp_sync__link" WHERE entity=? AND record_id=?', d.kind, id);
  if (!link) return { finance: false, invoice: false };
  return notPorted("erp_sync.origin_effects");
}

/** erp_sync.origin_locked(p_id): documento convertido no Bling com nota ou financeiro. */
export function originLocked(ctx: RpcContext, id: string): boolean {
  if (applying(ctx)) return false;
  if (!one(ctx.db, `SELECT 1 x FROM "erp_documents__document" WHERE id=? AND origin='origin' AND authority='brufap'`, id)) return false;
  const e = originEffects(ctx, id);
  return e.finance || e.invoice;
}

/** erp_sync.guard_origin_effects_document (BEFORE UPDATE/DELETE de document): sem documento travado, nada. */
export function guardOriginEffectsDocument(ctx: RpcContext, id: string) {
  if (originLocked(ctx, id)) notPorted("erp_sync.guard_origin_effects_document");
}
/** erp_sync.guard_origin_effects_item (BEFORE … de item): sem documento travado, nada. */
export function guardOriginEffectsItem(ctx: RpcContext, documentId: string) {
  if (originLocked(ctx, documentId)) notPorted("erp_sync.guard_origin_effects_item");
}

/** erp_sync.origin_number(p_value jsonb): número do Bling em texto (numeric::text), ou null. */
export function originNumber(value: unknown): string | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!/^-?[0-9]{1,15}(\.[0-9]+)?$/.test(text)) return null;
  return decText(text, 0, false);
}

/**
 * erp_sync.guard_zero_title (BEFORE INSERT/UPDATE de erp_finance.title):
 * devolve o origin_zero_source_id que fica na linha. Fora da aplicação do
 * espelho, título com origem zerada é recusado (ZERO_TITLE_SOURCE_REQUIRED).
 */
export function guardZeroTitle(
  ctx: RpcContext,
  op: "INSERT" | "UPDATE",
  old: { origin_zero_source_id: string | null } | null,
  next: { origin_zero_source_id: string | null; amount_cents: bigint | number },
): string | null {
  let source = next.origin_zero_source_id;
  if (op === "UPDATE" && old?.origin_zero_source_id != null && BigInt(next.amount_cents) > 0n && source === old.origin_zero_source_id) source = null;
  if (source !== null) {
    if (!applying(ctx)) raise("22023", "ZERO_TITLE_SOURCE_REQUIRED");
    notPorted("erp_sync.guard_zero_title");
  }
  return source;
}

/** erp_sync.stock_import_allowed(...): só durante a aplicação do espelho. */
export function stockImportAllowed(ctx: RpcContext): boolean {
  if (!applying(ctx)) return false;
  return notPorted("erp_sync.stock_import_allowed");
}
