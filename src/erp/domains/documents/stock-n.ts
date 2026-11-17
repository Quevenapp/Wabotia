// Escrito pela N para os recebimentos de compra do Estoque; dono: Documentos
// (sessão O), avisada. Portado de erp_documents.stock_launch_date (inteiro).
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import { todaySaoPaulo, validDate } from "../../engine/time.ts";
import { preference } from "./internal.ts";

/** (texto)::date, com o erro do Postgres. */
function dateCast(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (!validDate(s)) raise("22007", `invalid input syntax for type date: "${s}"`);
  return s;
}

/**
 * erp_documents.stock_launch_date(p_id): a data do lançamento de estoque do
 * documento. Com "estoque.data_lancamento" = data_documento, a data de
 * entrega (venda, OS) ou a prevista (compra), senão a do documento; nunca
 * depois de hoje (São Paulo). Sem a opção, hoje.
 */
export function stockLaunchDate(db: SqlDriver, id: string): string | null {
  const d = one(db, 'SELECT kind, body FROM "erp_documents__document" WHERE id=?', id);
  if (!d) return null;
  const today = todaySaoPaulo();
  if (preference(db, "estoque.data_lancamento") !== "data_documento") return today;
  const body = (typeof d.body === "string" ? JSON.parse(d.body) : d.body) as Record<string, unknown> | null;
  const own = ["sales_orders", "service_orders"].includes(String(d.kind)) ? dateCast(body?.ship_date) : dateCast(body?.expected_date);
  const day = own ?? dateCast(body?.date);
  return day === null || day > today ? today : day;
}
