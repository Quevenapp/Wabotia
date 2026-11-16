// Empresa: acesso, identidade e confirmação fiscal.
// public.erp_company_access, erp_company_get, erp_company_save_identity,
// erp_company_confirm_fiscal.
import { one } from "../../../engine/driver.ts";
import { ErpError, raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { permitted } from "../../access/public.ts";
import {
  CNTRL,
  audit,
  btrim,
  chars,
  command,
  document,
  fiscalDto,
  identityDto,
  normalizeIdentity,
  personType,
  requireAccess,
  saveCommand,
  sha256,
} from "../internal.ts";

const MAX_VERSION = 2147483647;
const s = (v: unknown) => (v === undefined ? null : (v as string | null));
const n = (v: unknown) => (v === undefined || v === null ? null : Number(v));

registerRpc("erp_company_access", (ctx: RpcContext, a: RpcArgs) => {
  const user = s(a.p_user_id)!;
  const role = requireAccess(ctx.db, user, "read");
  if (!permitted(ctx.db, user, "outros.dados_empresa")) raise("42501", "erp_company_forbidden");
  return {
    read_identity: true,
    write_identity: role === "admin",
    read_fiscal: ["admin", "fiscal"].includes(role),
    write_fiscal: ["admin", "fiscal"].includes(role),
    data_mode: "erp_native",
    emission_enabled: false,
  };
});

registerRpc("erp_company_get", (ctx: RpcContext, a: RpcArgs) => {
  const section = s(a.p_section);
  if (section === null || !["identity", "fiscal"].includes(section)) raise("22023", "erp_company_section_invalid");
  requireAccess(ctx.db, s(a.p_user_id)!, section === "fiscal" ? "fiscal" : "read");
  return {
    section,
    record: section === "identity" ? identityDto(ctx.db) : fiscalDto(ctx.db),
    data_mode: "erp_native",
    emission_enabled: false,
  };
});

registerRpc("erp_company_save_identity", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = s(a.p_user_id)!;
  const version = n(a.p_expected_version);
  const cmd = s(a.p_command_id);
  const reasonRaw = s(a.p_reason);
  const data = a.p_data ?? null;
  requireAccess(db, user, "identity");
  if (version === null || version < 0 || cmd === null) raise("22023", "erp_company_command_invalid");
  if (reasonRaw !== null && (chars(btrim(reasonRaw)) < 3 || chars(btrim(reasonRaw)) > 1000 || CNTRL.test(reasonRaw)))
    raise("22023", "erp_company_reason_invalid");
  let reason = reasonRaw === null ? null : btrim(reasonRaw) || null;
  if (data === null || jsonType(data) !== "object" || new TextEncoder().encode(jsonbText(data)).length > 16384)
    raise("22023", "erp_company_data_invalid");
  const hash = sha256(
    jsonbText({ op: "identity", actor: user, version, data, ...(reason === null ? {} : { reason }) }),
  );
  const stored = command(db, cmd);
  if (stored) {
    if (stored.actor !== user || stored.hash !== hash) raise("40001", "erp_company_command_conflict");
    return { ...stored.result, replayed: true };
  }
  const row = one(db, 'SELECT version, data FROM "erp_company__identity" WHERE singleton=1');
  const current = row ? JSON.parse(String(row.data)) : null;
  // 302: CPF com Pessoa Física, CNPJ senão; documento igual ao gravado fica como está.
  let kind = personType(db) === "fisica" ? "cpf" : "cnpj";
  const given = (data as Record<string, unknown>).cnpj;
  if (row && jsonType(given) === "string" && chars(given as string) <= 18) {
    try {
      if (document(given as string, "any") === current?.cnpj) kind = "any";
    } catch (e) {
      if (!(e instanceof ErpError) || e.code !== "22023") throw e;
    }
  }
  const v = normalizeIdentity(data, kind);
  const rowVersion = row ? (row.version as number) : null;
  if ((rowVersion ?? 0) !== version || rowVersion === MAX_VERSION) raise("40001", "erp_company_version_conflict");
  const locked =
    row !== null &&
    (current?.legal_name !== v.legal_name || current?.trade_name !== v.trade_name || current?.cnpj !== v.cnpj);
  if (locked && reason === null) raise("22023", "erp_company_reason_required");
  if (!locked) reason = null;
  const before = identityDto(db);
  if (!row) {
    const at = ctx.clock.next().toString();
    db.exec(
      'INSERT INTO "erp_company__identity"(singleton, version, data, created_at, updated_at, updated_by) VALUES(1,1,?,?,?,?)',
      JSON.stringify(v),
      at,
      ctx.clock.next().toString(),
      user,
    );
    db.exec('INSERT INTO "erp_company__fiscal"(singleton, version, updated_at) VALUES(1,1,?)', ctx.clock.next().toString());
  } else if (jsonbText(current) !== jsonbText(v)) {
    const fiscal = fiscalDto(db);
    db.exec(
      'UPDATE "erp_company__identity" SET data=?, version=version+1, updated_at=?, updated_by=? WHERE singleton=1',
      JSON.stringify(v),
      ctx.clock.next().toString(),
      user,
    );
    if (current?.cnpj !== v.cnpj) {
      if (fiscal?.version === MAX_VERSION) raise("40001", "erp_company_version_conflict");
      db.exec(
        'UPDATE "erp_company__fiscal" SET crt=NULL, confirmed_at=NULL, confirmed_by=NULL, reason=NULL, version=version+1, updated_at=? WHERE singleton=1',
        ctx.clock.next().toString(),
      );
      audit(ctx, user, cmd, "fiscal_reset_identity_changed", fiscal, fiscalDto(db));
    }
  }
  const record = identityDto(db);
  const result = { section: "identity", record, replayed: false, data_mode: "erp_native", emission_enabled: false };
  if (jsonbText(before) !== jsonbText(record))
    audit(ctx, user, cmd, "save_identity", before, { ...record, ...(reason === null ? {} : { motivo: reason }) });
  saveCommand(ctx, cmd, user, hash, result);
  return result;
});

registerRpc("erp_company_confirm_fiscal", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = s(a.p_user_id)!;
  const version = n(a.p_expected_version);
  const identityVersion = n(a.p_expected_identity_version);
  const cmd = s(a.p_command_id);
  const crt = s(a.p_crt);
  const confirmed = a.p_confirmed === undefined ? null : (a.p_confirmed as boolean | null);
  const reasonRaw = s(a.p_reason);
  const reason = reasonRaw === null ? null : btrim(reasonRaw) || null;
  requireAccess(db, user, "fiscal");
  if (
    cmd === null ||
    version === null ||
    version < 1 ||
    identityVersion === null ||
    identityVersion < 1 ||
    confirmed === null ||
    (crt === null && confirmed) ||
    (crt !== null && (!confirmed || !["1", "2", "3", "4"].includes(crt))) ||
    reason === null ||
    chars(reason) < 3 ||
    chars(reasonRaw!) > 1000 ||
    CNTRL.test(reasonRaw!)
  )
    raise("22023", "erp_company_confirmation_invalid");
  const hash = sha256(
    jsonbText({ op: "fiscal", actor: user, version, identity_version: identityVersion, crt, confirmed, reason: reasonRaw }),
  );
  const stored = command(db, cmd);
  if (stored) {
    if (stored.actor !== user || stored.hash !== hash) raise("40001", "erp_company_command_conflict");
    return { ...stored.result, replayed: true };
  }
  const identity = one(db, 'SELECT version FROM "erp_company__identity" WHERE singleton=1');
  const fiscal = one(db, 'SELECT version FROM "erp_company__fiscal" WHERE singleton=1');
  if ((identity?.version ?? null) !== identityVersion || (fiscal?.version ?? null) !== version || fiscal?.version === MAX_VERSION)
    raise("40001", "erp_company_version_conflict");
  const before = fiscalDto(db);
  db.exec(
    'UPDATE "erp_company__fiscal" SET crt=?, confirmed_at=?, confirmed_by=?, reason=?, version=version+1, updated_at=? WHERE singleton=1',
    crt,
    confirmed ? ctx.clock.next().toString() : null,
    confirmed ? user : null,
    reason,
    ctx.clock.next().toString(),
  );
  const result = { section: "fiscal", record: fiscalDto(db), replayed: false, data_mode: "erp_native", emission_enabled: false };
  audit(ctx, user, cmd, crt === null ? "clear_fiscal_confirmation" : "confirm_fiscal", before, result.record);
  saveCommand(ctx, cmd, user, hash, result);
  return result;
});
