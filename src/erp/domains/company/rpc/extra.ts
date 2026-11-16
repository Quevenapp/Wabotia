// Empresa: dados complementares e sócios.
// public.erp_company_extra_get, erp_company_extra_save,
// erp_company_partners_get, erp_company_partners_save.
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { jsonTimestamp } from "../../../engine/time.ts";
import { permitted } from "../../access/public.ts";
import { companyExtraCnae } from "../../reference/public.ts";
import { audit, command, extraDto, extraNormalize, partnersDto, partnersNormalize, requireAccess, saveCommand, sha256 } from "../internal.ts";

const s = (v: unknown) => (v === undefined ? null : (v as string | null));
const n = (v: unknown) => (v === undefined || v === null ? null : Number(v));

registerRpc("erp_company_extra_get", (ctx: RpcContext, a: RpcArgs) => {
  const user = s(a.p_user_id)!;
  const role = requireAccess(ctx.db, user, "read");
  if (!permitted(ctx.db, user, "outros.dados_empresa")) raise("42501", "erp_company_forbidden");
  return { scope: "company_extra", data_mode: "erp_native", can_manage: role === "admin", record: extraDto(ctx.db) };
});

registerRpc("erp_company_partners_get", (ctx: RpcContext, a: RpcArgs) => {
  requireAccess(ctx.db, s(a.p_user_id)!, "identity");
  return { scope: "company_partners", data_mode: "erp_native", record: partnersDto(ctx.db) };
});

/** Grava a linha única (extra ou partners) e devolve o instante. */
function saveSingleton(
  ctx: RpcContext,
  table: "erp_company__extra" | "erp_company__partners",
  user: string,
  cmd: string,
  version: number,
  exists: boolean,
  data: unknown,
) {
  const at = ctx.clock.next();
  if (!exists)
    ctx.db.exec(
      `INSERT INTO "${table}"(singleton, version, data, updated_at, updated_by, command_id) VALUES(1,1,?,?,?,?)`,
      JSON.stringify(data),
      at.toString(),
      user,
      cmd,
    );
  else
    ctx.db.exec(
      `UPDATE "${table}" SET data=?, version=version+1, updated_at=?, updated_by=?, command_id=? WHERE singleton=1 AND version=?`,
      JSON.stringify(data),
      at.toString(),
      user,
      cmd,
      version,
    );
  return at;
}

const receipt = (scope: string, cmd: string, version: number, at: bigint) => ({
  scope,
  data_mode: "erp_native",
  receipt: { command_id: cmd, from_version: version, to_version: version + 1, changed_at: jsonTimestamp(at) },
});

registerRpc("erp_company_extra_save", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = s(a.p_user_id)!;
  const cmd = s(a.p_command_id);
  const version = n(a.p_expected_version);
  const data = a.p_data === undefined ? null : a.p_data;
  requireAccess(db, user, "identity");
  if (cmd === null || version === null || version < 0 || version > 2147483646) raise("22023", "erp_company_command_invalid");
  const v = extraNormalize(data);
  const hash = sha256(jsonbText({ op: "extra", actor: user, version, data }));
  const stored = command(db, cmd);
  if (stored) {
    if (stored.actor !== user || stored.hash !== hash) raise("40001", "erp_company_command_conflict");
    requireAccess(db, user, "identity");
    return { ...stored.result, record: extraDto(db), replayed: true };
  }
  const row = one(db, 'SELECT version, data FROM "erp_company__extra" WHERE singleton=1');
  if (((row?.version as number) ?? 0) !== version) raise("40001", "erp_company_version_conflict");
  const previous = row ? JSON.parse(String(row.data)) : null;
  if (row && jsonbText(previous) === jsonbText(v)) raise("22023", "erp_company_extra_unchanged");
  const before = extraDto(db);
  // Gatilho extra_cnae_official (BEFORE INSERT OR UPDATE): CNAE da tabela oficial.
  companyExtraCnae(db, v, previous, !row);
  const at = saveSingleton(ctx, "erp_company__extra", user, cmd, version, !!row, v);
  const result = receipt("company_extra_command", cmd, version, at);
  audit(ctx, user, cmd, "save_extra", before, extraDto(db));
  saveCommand(ctx, cmd, user, hash, result, at);
  requireAccess(db, user, "identity");
  return { ...result, record: extraDto(db), replayed: false };
});

registerRpc("erp_company_partners_save", (ctx: RpcContext, a: RpcArgs) => {
  const db = ctx.db;
  const user = s(a.p_user_id)!;
  const cmd = s(a.p_command_id);
  const version = n(a.p_expected_version);
  const partners = a.p_partners === undefined ? null : a.p_partners;
  requireAccess(db, user, "identity");
  if (cmd === null || version === null || version < 0 || version > 2147483646) raise("22023", "erp_company_command_invalid");
  const hash = sha256(jsonbText({ op: "partners", actor: user, version, partners }));
  const stored = command(db, cmd);
  if (stored) {
    if (stored.actor !== user || stored.hash !== hash) raise("40001", "erp_company_command_conflict");
    return { ...stored.result, record: partnersDto(db), replayed: true };
  }
  const v = partnersNormalize(partners);
  const row = one(db, 'SELECT version, data FROM "erp_company__partners" WHERE singleton=1');
  if (((row?.version as number) ?? 0) !== version) raise("40001", "erp_company_version_conflict");
  if ((row && jsonbText(JSON.parse(String(row.data))) === jsonbText(v)) || (!row && v.length === 0))
    raise("22023", "erp_company_partners_unchanged");
  const before = partnersDto(db);
  const at = saveSingleton(ctx, "erp_company__partners", user, cmd, version, !!row, v);
  const result = receipt("company_partners_command", cmd, version, at);
  audit(ctx, user, cmd, "save_partners", before, partnersDto(db));
  saveCommand(ctx, cmd, user, hash, result, at);
  return { ...result, record: partnersDto(db), replayed: false };
});
