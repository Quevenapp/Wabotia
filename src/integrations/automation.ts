import { one } from "../db";
import type { Env } from "../types";
import type { IntegrationEvent } from "./contracts";

/** O corte é por destino e é capturado no mesmo lote do fato. Uma mudança
 * posterior de política nunca autoriza automaticamente o período anterior. */
export async function eventAutomation(env: Env, event: IntegrationEvent) {
  const row = await one(env, `SELECT a.authorization_json,p.stock_epoch,p.finance_epoch,p.config_json
    FROM module_erp_events e JOIN module_erp_policy p ON p.profile_id=e.profile_id
    LEFT JOIN module_erp_event_automation a ON a.event_id=e.id WHERE e.id=?`, event.id);
  const born = JSON.parse(row?.authorization_json ?? "{}"), current = JSON.parse(row?.config_json ?? "{}");
  return {
    stock: born.stock === 1 && born.stock_epoch === row?.stock_epoch && current.auto_post?.stock === true,
    finance: born.finance === 1 && born.finance_epoch === row?.finance_epoch && current.auto_post?.finance === true,
  };
}
