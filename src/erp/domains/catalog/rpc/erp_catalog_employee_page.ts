// public.erp_catalog_employee_page: lista de funcionários (só administrador).
// O filtro (matches sobre fold de nome, código, cargo e CPF) e a ordem
// (fold(name), id em collation C) ficam em TS: a tabela é pequena e o
// fold não tem coluna no SQLite.
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { intArg, textArg, uuidArg } from "../args.ts";
import { employeeAdmin } from "../employee.ts";
import { CNTRL, chars, compareText, matches, searchTerms } from "../fields.ts";
import { fold } from "../internal.ts";

const SITUATIONS: Record<string, string | null> = { todas: null, ativos: "ativo", desligados: "desligado" };

export function erpCatalogEmployeePage(ctx: RpcContext, a: RpcArgs) {
  const user = uuidArg(a, "p_user_id");
  const page = intArg(a, "p_page", 1);
  const size = intArg(a, "p_size", 100);
  const query = textArg(a, "p_query");
  const situation = textArg(a, "p_situation", "ativos");
  employeeAdmin(ctx.db, user);
  if (
    page === null ||
    page < 1 ||
    page > 100000 ||
    size === null ||
    size < 1 ||
    size > 100 ||
    (query !== null && (chars(query) > 120 || CNTRL.test(query))) ||
    situation === null ||
    !(situation in SITUATIONS)
  )
    raise("22023", "erp_catalog_invalid_query");
  const terms = searchTerms(query);
  const wanted = SITUATIONS[situation];
  const rows = ctx.db
    .exec(
      `SELECT id, CAST(version AS TEXT) version, name, cpf, job_title, admission_date, situation, code
       FROM "erp_catalog__employee" WHERE (? IS NULL OR situation=?)`,
      wanted,
      wanted,
    )
    .rows.filter(
      (e) =>
        terms === null ||
        matches(
          terms,
          fold([e.name, e.code, e.job_title, e.cpf].filter((x) => x !== null).join(" ")),
          e.cpf as string,
          e.cpf as string,
        ),
    )
    .map((e) => ({ e, key: fold(e.name as string)! }))
    .sort((x, y) => compareText(x.key, y.key) || compareText(String(x.e.id), String(y.e.id)))
    .map((x) => x.e);
  return {
    entity: "employees",
    page,
    size,
    total: rows.length,
    situation,
    data_mode: "erp_native",
    items: rows.slice((page - 1) * size, (page - 1) * size + size).map((e) => ({
      id: e.id,
      version: Number(e.version),
      name: e.name,
      cpf: e.cpf,
      job_title: e.job_title,
      admission_date: e.admission_date,
      situation: e.situation,
    })),
  };
}

registerRpc("erp_catalog_employee_page", erpCatalogEmployeePage);
