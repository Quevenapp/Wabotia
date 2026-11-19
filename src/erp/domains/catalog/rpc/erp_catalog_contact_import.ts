// public.erp_catalog_contact_import: importação de contatos da planilha, em
// lotes de até 50 linhas. Simulação (dry_run) valida linha a linha; a
// importação é tudo ou nada (uma linha inválida recusa o lote). No Postgres
// cada linha roda num subbloco com exceção; aqui o erro da linha vira o
// resultado dela e, na importação com linha inválida, o lote inteiro sai com
// erro, o que desfaz a transação toda (o mesmo estado final).
import { ErpError, raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import * as preferences from "../../preferences/public.ts";
import { requireAccess } from "../access.ts";
import { jsonArg } from "../args.ts";
import { auxiliaryAudit, replayCommand, requestHash, storeCommand } from "../command.ts";
import { contactCheckFull, contactDto, contactMerge, contactTakeCode, contactWarnings, contactWrite } from "../contact-core.ts";
import { insertRecord } from "../internal.ts";
import { compact } from "../record.ts";

type Row = { row: number; data: Record<string, unknown> };
const str = (v: unknown): string | null => (v === null || v === undefined ? null : typeof v === "string" ? v : jsonbText(v));

function rowsValid(rows: unknown): rows is Row[] {
  if (jsonType(rows) !== "array") return false;
  const a = rows as unknown[];
  if (a.length < 1 || a.length > 50 || Buffer.byteLength(jsonbText(a), "utf8") > 262144) return false;
  for (const x of a) {
    if (jsonType(x) !== "object") return false;
    const o = x as Record<string, unknown>;
    if (Object.keys(o).length !== 2 || jsonType(o.row) !== "number" || !/^[1-9][0-9]{0,4}$/.test(String(o.row)) || jsonType(o.data) !== "object")
      return false;
  }
  return new Set(a.map((x) => String((x as Row).row))).size === a.length;
}

export function erpCatalogContactImport(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const command = (a.p_command_id ?? null) as string | null;
  const rows = jsonArg(a, "p_rows");
  const dry = (a.p_dry_run ?? null) as boolean | null;
  const db = ctx.db;
  requireAccess(db, user, "contacts", true);
  if (dry === null || (!dry && command === null) || rows === null || !rowsValid(rows)) raise("22023", "erp_catalog_invalid_import");
  let hash = "";
  if (!dry) {
    hash = requestHash({ profile: "erp-contact-import-v1", actor: user, rows });
    const replayed = replayCommand(ctx, command!, user!, hash);
    if (replayed) return replayed;
  }
  const allow = (preferences.get(db, "contatos.permite_documento_duplicado") ?? true) === true;
  const seen: string[] = [];
  const results: Record<string, unknown>[] = [];
  let invalid = 0;
  for (const r of [...(rows as Row[])].sort((x, y) => x.row - y.row)) {
    let message: string | null = null;
    let id: string | null = null;
    try {
      if ("situation" in r.data && str(r.data.situation) === "E") raise("22023", "erp_catalog_contact_invalid:situation");
      let full = contactMerge(db, user, null, r.data, {}, ctx.parts);
      if (!dry && (str(full.code) ?? "") === "" && preferences.get(db, "contatos.codigo") === "sequencial")
        full = { ...full, code: contactTakeCode(ctx, user!) };
      contactCheckFull(db, null, full, {}, null, ctx.parts);
      if (contactWarnings(db, null, full, {}).some((w) => w.blocked === true)) raise("23505", "erp_catalog_duplicate_document");
      const doc = compact(str(full.document)) || null;
      if (!allow && doc !== null && [...doc].length >= 5 && seen.includes(doc)) raise("23505", "erp_catalog_duplicate_document");
      if (doc !== null) seen.push(doc);
      if (!dry) {
        id = insertRecord(ctx, {
          entity: "contacts", name: String(full.name), code: str(full.code), active: ["A", "S"].includes(String(full.situation)), actor: user!, humanEdited: true,
        });
        contactWrite(ctx, id, full);
        ctx.db.exec(
          `INSERT INTO "erp_catalog__audit"(actor, command_id, entity, record_id, action, before_data, after_data, created_at)
           VALUES(?,?,'contacts',?,'import_create',NULL,?,?)`,
          user, command, id, jsonbText(contactDto(db, id)), ctx.clock.next().toString(),
        );
      }
    } catch (e) {
      if (!(e instanceof ErpError) || !["22023", "23505", "42501"].includes(e.code)) throw e;
      message = e.message;
      id = null;
      invalid++;
    }
    const field =
      message === null
        ? null
        : message.startsWith("erp_catalog_contact_invalid:")
          ? message.slice(28)
          : message.startsWith("erp_catalog_contact_required:")
            ? message.slice(29)
            : message === "erp_catalog_duplicate_document"
              ? "document"
              : message === "erp_catalog_name_required"
                ? "name"
                : null;
    const code =
      message === null
        ? null
        : message.startsWith("erp_catalog_contact_required:")
          ? "required"
          : message === "erp_catalog_duplicate_document"
            ? "duplicate_document"
            : message === "erp_catalog_contact_not_visible"
              ? "not_visible"
              : "invalid";
    // jsonb_strip_nulls
    const item: Record<string, unknown> = { row: r.row, status: message === null ? (dry ? "valid" : "created") : "invalid" };
    if (code !== null) item.code = code;
    if (field !== null) item.field = field;
    if (id !== null) item.record_id = id;
    results.push(item);
  }
  if (!dry && invalid > 0) raise("22023", "erp_catalog_import_invalid_rows");
  const result = { scope: "contact_import", data_mode: "erp_native", dry_run: dry, replayed: false, items: results };
  if (!dry) {
    auxiliaryAudit(ctx, { actor: user!, command, subject: "contact_import", subjectId: null, action: "apply", after: { rows: (rows as Row[]).length } });
    storeCommand(ctx, command!, user!, hash, result);
  }
  return result;
}

registerRpc("erp_catalog_contact_import", erpCatalogContactImport);
