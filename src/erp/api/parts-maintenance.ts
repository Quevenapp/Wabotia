import { ERP_MAINTENANCE_ACTIONS, ERP_MAINTENANCE_HEADER, maintenanceReadRpc, readErpMaintenance } from "../parts-requirements.ts";
import type { IdentityPort } from "../engine/identity.ts";
/** Costura finita: só mapeia ações revisáveis para RPCs existentes. */
export async function partsMaintenance(request: Request, identity: IdentityPort, fetchRpc: (input: string, init: RequestInit) => Promise<Response>): Promise<Response> {
  const invalid = () => Response.json({ error: { code: "invalid_request", message: "Informe a origem e uma ação de manutenção válida." } }, { status: 400 });
  if (!["GET", "POST"].includes(request.method)) return new Response(null, { status: 405 });
  const url = new URL(request.url);
  if (request.method === "GET" && [...url.searchParams.keys()].some(key => !["type", "id"].includes(key))) return invalid();
  const body: any = request.method === "GET" ? {
    origin: { type: url.searchParams.get("type"), id: url.searchParams.get("id") }, action: "inspect",
  } : await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !["origin", "action", "args"].includes(k))) return invalid();
  const maintenance = readErpMaintenance({ origin: body.origin, action: body.action });
  if (!maintenance || request.method === "POST" && maintenance.action === "inspect") return invalid();
  let rpc: string, args: Record<string, unknown>;
  if (maintenance.action === "inspect") {
    const read = maintenanceReadRpc(maintenance.origin); if (!read) return invalid();
    ({ rpc, args } = read);
  } else {
    const op = ERP_MAINTENANCE_ACTIONS[maintenance.action]; rpc = op.rpc;
    if (!body.args || typeof body.args !== "object" || Array.isArray(body.args) ||
        Object.keys(body.args).some(k => !k.startsWith("p_") || ["p_user_id", "p_parts", "p_role", "p_bypass", "p_rpc"].includes(k))) return invalid();
    args = { ...body.args, ...("action" in op ? { p_action: op.action } : {}) };
  }
  const response = await fetchRpc(`https://erp.wabotia.invalid/rest/v1/rpc/${rpc}`, {
    method: "POST", headers: { [ERP_MAINTENANCE_HEADER]: JSON.stringify(maintenance) },
    body: JSON.stringify({ ...args, p_user_id: identity.actor?.user_id }),
  });
  if (response.ok) return response;
  const error = await response.json<any>().catch(() => ({}));
  return Response.json({ error: error.error ?? { code: error.code ?? "erp_error", message: error.message ?? "Não foi possível executar a manutenção." } }, { status: response.status });
}
