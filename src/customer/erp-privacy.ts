import { ApiError, type Env } from "../types";
import { CUSTOMER_BRIDGE_SCAN, containsRestrictedContact, customerPrivacyUnsupported } from "../erp/engine/identity.ts";

export interface ErpPrivacy {
  restricted_contact_ids: string[];
}

/** Sem cache/prefetch: vale para cada tentativa e para o retorno em andamento. */
export async function erpPrivacy(env: Env, profile: string): Promise<ErpPrivacy> {
  const row = await env.DB.prepare(`SELECT
    coalesce((SELECT enabled FROM profile_modules WHERE profile_id=? AND module_id='erp'),0) enabled,
    (SELECT json_group_array(erp_contact_id) FROM (
      SELECT erp_contact_id FROM contacts WHERE profile_id=? AND erp_contact_id IS NOT NULL
      AND (identity_state<>'active' OR namespace<>'team') ORDER BY erp_contact_id LIMIT 2001
    )) restricted`).bind(profile, profile).first<{ enabled: number; restricted: string }>();
  if (!row?.enabled) throw new ApiError(409, "module_disabled", "O módulo ERP está desligado nesta área de atendimento.");
  const ids: string[] = JSON.parse(row.restricted);
  // Não truncar a política para caber no envelope interno.
  if (ids.length > 2000 || ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))
    throw new ApiError(403, "erp_customer_restricted", "Esta operação não admite uma projeção segura dos contatos restritos.");
  return { restricted_contact_ids: ids.map((id) => id.toLowerCase()) };
}

export function erpPrivacyDenies(policy: ErpPrivacy, rpc: string, args: unknown, result?: unknown): boolean {
  const ids = new Set(policy.restricted_contact_ids);
  const references = rpc === CUSTOMER_BRIDGE_SCAN ? { ...(args as object), p_after: null } : args;
  return containsRestrictedContact(references, ids) || containsRestrictedContact(result, ids) ||
    (ids.size > 0 && customerPrivacyUnsupported(rpc, (args ?? {}) as Record<string, unknown>));
}

export const erpPrivacyChanged = (before: ErpPrivacy, after: ErpPrivacy) =>
  after.restricted_contact_ids.some((id) => !before.restricted_contact_ids.includes(id));

export const erpPrivacyDenied = () => Response.json(
  { code: "42501", message: "erp_customer_restricted", details: null, hint: null }, { status: 403 },
);
