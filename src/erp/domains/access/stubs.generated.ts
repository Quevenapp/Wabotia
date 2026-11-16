// Gerado por scripts/erp/gen-ownership.mjs. Não edite: porte a função no public.ts do domínio.
import { notPorted } from "../../engine/errors.ts";

/** erp_access.gate_required(p_user uuid) → boolean */
export const gateRequired = (..._args: unknown[]): never => notPorted("erp_access.gate_required");
/** erp_access.mfa_policy_on() → boolean */
export const mfaPolicyOn = (..._args: unknown[]): never => notPorted("erp_access.mfa_policy_on");
/** erp_access.permission_keys() → text[] */
export const permissionKeys = (..._args: unknown[]): never => notPorted("erp_access.permission_keys");
/** erp_access.read_admin(p_actor uuid) → void */
export const readAdmin = (..._args: unknown[]): never => notPorted("erp_access.read_admin");
/** erp_access.record_summary(p_entity text, p_id text, p_payload jsonb, p_contact jsonb, p_seen_at timestamp with time zone) → jsonb */
export const recordSummary = (..._args: unknown[]): never => notPorted("erp_access.record_summary");
/** erp_access.require_admin(p_actor uuid, p_lock boolean) → void */
export const accessRequireAdmin = (..._args: unknown[]): never => notPorted("erp_access.require_admin");
/** erp_access.require_history_role(p_user_id uuid) → text */
export const requireHistoryRole = (..._args: unknown[]): never => notPorted("erp_access.require_history_role");
/** erp_access.require_permission(p_user uuid, p_key text) → void */
export const requirePermission = (..._args: unknown[]): never => notPorted("erp_access.require_permission");
/** erp_access.resources_for_role(p_role text) → text[] */
export const resourcesForRole = (..._args: unknown[]): never => notPorted("erp_access.resources_for_role");
/** erp_access.scalar_text(p_value jsonb, p_max integer) → text */
export const scalarText = (..._args: unknown[]): never => notPorted("erp_access.scalar_text");
/** erp_activity.actor_label(p_actor uuid) → text */
export const actorLabel = (..._args: unknown[]): never => notPorted("erp_activity.actor_label");
/** erp_activity.clean(p_text text, p_max integer) → text */
export const clean = (..._args: unknown[]): never => notPorted("erp_activity.clean");
/** erp_activity.period(p_from date, p_to date) → tstzrange */
export const period = (..._args: unknown[]): never => notPorted("erp_activity.period");
/** erp_activity.require_admin(p_actor uuid) → void */
export const activityRequireAdmin = (..._args: unknown[]): never => notPorted("erp_activity.require_admin");
