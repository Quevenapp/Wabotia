// public.erp_catalog_employee_save: cria, altera, desliga ou reativa um
// funcionário (só administrador). O recibo do comando guarda só id e versão.
import { toParam, toScaled } from "../../../engine/dec.ts";
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { intArg, jsonArg, textArg, uuidArg } from "../args.ts";
import { auxiliaryAudit, replayCommand, requestHash, storeCommand } from "../command.ts";
import { employeeAdmin, employeeDto, employeeForm, employeeInput, type EmployeeData } from "../employee.ts";
import { fold } from "../internal.ts";

const MAX_VERSION = 2147483647;
const COLUMNS = [
  "name", "cpf", "rg", "birth_date", "job_title", "admission_date", "pis", "ctps", "code", "salary", "phone",
  "mobile", "email", "emergency_phone", "postal_code", "state", "city", "district", "street", "number",
  "complement", "notes",
] as const;
const salaryParam = (v: string | null) => (v === null ? null : toParam(toScaled(v, 2)));
const values = (v: EmployeeData) => COLUMNS.map((c) => (c === "salary" ? salaryParam(v.salary) : v[c]));

export function erpCatalogEmployeeSave(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const id = uuidArg(a, "p_id");
  const expected = intArg(a, "p_expected_version");
  const command = uuidArg(a, "p_command_id");
  const data = jsonArg(a, "p_data");
  const situationArg = textArg(a, "p_situation");
  const db = ctx.db;
  employeeAdmin(db, user);
  if (
    command === null ||
    expected === null ||
    (id === null && expected !== 0) ||
    (id !== null && (expected < 1 || expected > MAX_VERSION)) ||
    (situationArg !== null && !["ativo", "desligado"].includes(situationArg))
  )
    raise("22023", "erp_catalog_invalid_command");
  const hash = requestHash({
    profile: "erp-employee-save-v1",
    actor: user,
    id,
    version: expected,
    data,
    situation: situationArg,
  });
  const replayed = replayCommand(ctx, command, user!, hash);
  if (replayed) return replayed;
  let row: { version: number; situation: string } | null = null;
  if (id !== null) {
    const r = one(db, 'SELECT CAST(version AS TEXT) version, situation FROM "erp_catalog__employee" WHERE id=?', id);
    if (!r) raise("P0002", "erp_catalog_not_found");
    row = { version: Number(r.version), situation: String(r.situation) };
    if (row.version !== expected) raise("40001", "erp_catalog_version_conflict");
    if (row.version === MAX_VERSION) raise("40001", "erp_catalog_version_exhausted");
  }
  // Sem p_data, só a situação muda (Desligar / Reativar).
  const v = data === null && id !== null ? employeeForm(employeeDto(db, id)!) : employeeInput(data);
  const situation = situationArg ?? row?.situation ?? "ativo";
  if (one(db, 'SELECT 1 x FROM "erp_catalog__employee" WHERE cpf=? AND id IS NOT ?', v.cpf, id))
    raise("23505", "erp_catalog_employee_cpf_exists");
  let target: string;
  if (id === null) {
    target = crypto.randomUUID();
    const now = ctx.clock.next().toString();
    db.exec(
      `INSERT INTO "erp_catalog__employee"(id, ${COLUMNS.join(", ")}, situation, version, created_by, updated_by, created_at, updated_at, name__fold)
       VALUES (?, ${COLUMNS.map(() => "?").join(", ")}, ?, 1, ?, ?, ?, ?, ?)`,
      target,
      ...values(v),
      situation,
      user,
      user,
      now,
      now,
      fold(v.name),
    );
    auxiliaryAudit(ctx, { actor: user!, command, subject: "employee", subjectId: target, action: "create", after: { name: v.name } });
  } else {
    target = id;
    const before = employeeForm(employeeDto(db, id)!);
    if (jsonbText(before) !== jsonbText(v) || situation !== row!.situation) {
      db.exec(
        `UPDATE "erp_catalog__employee" SET ${COLUMNS.map((c) => `${c}=?`).join(", ")}, situation=?, version=version+1,
         updated_by=?, updated_at=?, name__fold=? WHERE id=?`,
        ...values(v),
        situation,
        user,
        ctx.clock.next().toString(),
        fold(v.name),
        id,
      );
      // Dados pessoais e salário ficam fora da trilha: só o fato e a situação.
      auxiliaryAudit(ctx, {
        actor: user!,
        command,
        subject: "employee",
        subjectId: id,
        action: situation !== row!.situation ? "transition" : "update",
        before: { situation: row!.situation },
        after: { situation },
      });
    }
  }
  const version = Number(one(db, 'SELECT CAST(version AS TEXT) v FROM "erp_catalog__employee" WHERE id=?', target)!.v);
  const result = { entity: "employees", data_mode: "erp_native", replayed: false, item: { id: target, version } };
  storeCommand(ctx, command!, user!, hash, result);
  return result;
}

registerRpc("erp_catalog_employee_save", erpCatalogEmployeeSave);
