// public.erp_catalog_invoice_tags_save: troca (replace, com versão) ou acrescenta
// (add) etiquetas de uma nota nativa, até 50 por nota. Versão e auditoria só
// quando o conjunto muda.
// Porte da sessão B (auxiliares do Catálogo); dona do domínio: sessão P.
//
// Origin: a nota espelhada é só leitura; a guarda erp_fiscal_mirror_readonly
// (42501) vem portada como guarda, antes de qualquer validação, como no Fagoo.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { nativeVisible, requireWrite } from "../../fiscal/public.ts";
import { jsonArg } from "../args.ts";
import { replayCommand, requestHash, storeCommand } from "../command.ts";
import {
  invoiceTagBump,
  invoiceTagIds,
  invoiceTagKeyValid,
  invoiceTagTarget,
  invoiceTagsData,
  requireInvoiceTags,
} from "../invoice-tags.ts";

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function erpCatalogInvoiceTagsSave(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const origin = (a.p_origin ?? null) as string | null;
  const model = (a.p_model ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  const expected = (a.p_expected_version ?? null) as number | null;
  const command = (a.p_command_id ?? null) as string | null;
  // jsonb: texto JSON vira valor (texto inválido → 22P02, como o cast do Postgres).
  const tagIds = jsonArg(a, "p_tag_ids");
  const mode = (a.p_mode ?? null) as string | null;
  const db = ctx.db;
  requireInvoiceTags(db, user, origin, true);
  requireWrite(db, user);
  if (origin === "origin") raise("42501", "erp_fiscal_mirror_readonly");
  const list = Array.isArray(tagIds) ? (tagIds as unknown[]) : null;
  if (
    command === null ||
    mode === null ||
    !["replace", "add"].includes(mode) ||
    !invoiceTagKeyValid(origin, model, id) ||
    (mode === "replace" && (expected === null || expected < 0 || expected > 2147483646)) ||
    (mode === "add" && expected !== null) ||
    list === null ||
    list.length > 50 ||
    (mode === "add" && list.length === 0) ||
    list.some((t) => typeof t !== "string" || !LOWER_UUID.test(t))
  )
    raise("22023", "erp_catalog_invalid_command");
  // A chave válida aqui é a da nota nativa (uuid minúsculo).
  if (!nativeVisible(db, user, id)) raise("P0002", "erp_catalog_not_found");
  const tags = [...new Set(list as string[])];
  if (tags.length !== list!.length) raise("22023", "erp_catalog_invalid_command");
  const hash = requestHash({ actor: user, action: "invoice_tags", origin, model, id, version: expected, mode, tags: tagIds });
  const replayed = replayCommand(ctx, command!, user!, hash);
  if (replayed) return replayed;
  const valid = tags.filter((t) =>
    one(db, `SELECT 1 x FROM "erp_catalog__taxonomy" WHERE id=? AND kind='tags' AND tag_type='invoices'`, t),
  ).length;
  if (valid !== tags.length) raise("22023", "erp_catalog_invalid_reference");
  if (!invoiceTagTarget(db, origin!, model!, id!)) raise("P0002", "erp_catalog_not_found");
  const state = one(
    db,
    'SELECT CAST(version AS TEXT) version FROM "erp_catalog__invoice_tag_state" WHERE origin=? AND model=? AND invoice_id=?',
    origin, model, id,
  );
  const current = state ? Number(state.version) : 0;
  if (mode === "replace" && current !== expected) raise("40001", "erp_catalog_version_conflict");
  const before = invoiceTagIds(db, origin!, model!, id!);
  if (mode === "replace")
    for (const old of before)
      if (!tags.includes(old))
        db.exec('DELETE FROM "erp_catalog__invoice_tag" WHERE origin=? AND model=? AND invoice_id=? AND tag_id=?', origin, model, id, old);
  for (const t of tags)
    db.exec('INSERT INTO "erp_catalog__invoice_tag"(origin, model, invoice_id, tag_id) VALUES (?,?,?,?) ON CONFLICT DO NOTHING', origin, model, id, t);
  const total = Number(
    one(db, 'SELECT CAST(count(*) AS TEXT) n FROM "erp_catalog__invoice_tag" WHERE origin=? AND model=? AND invoice_id=?', origin, model, id)!.n,
  );
  if (total > 50) raise("22023", "erp_catalog_invalid_list");
  const after = invoiceTagIds(db, origin!, model!, id!);
  const changed = jsonbText(after) !== jsonbText(before);
  if (changed) {
    invoiceTagBump(ctx, user!, origin!, model!, id!);
    db.exec(
      `INSERT INTO "erp_catalog__invoice_tag_audit"(actor, command_id, origin, model, invoice_id, action, before_data, after_data, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      user,
      command,
      origin,
      model,
      id,
      mode === "add" ? "tags_added" : "tags_update",
      jsonbText({ tag_ids: before }),
      jsonbText({ tag_ids: after }),
      ctx.clock.next().toString(),
    );
  }
  const result = {
    scope: "invoice_tags",
    origin,
    model,
    invoice: invoiceTagsData(db, origin!, model!, id!),
    changed,
    replayed: false,
    data_mode: "erp_native",
  };
  storeCommand(ctx, command!, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_invoice_tags_save", erpCatalogInvoiceTagsSave);
