// Gerado por scripts/erp/gen-ownership.mjs. Não edite: porte a função no public.ts do domínio.
import { notPorted } from "../../engine/errors.ts";

/** erp_home.biz_cost_visible(p_role text) → boolean */
export const bizCostVisible = (..._args: unknown[]): never => notPorted("erp_home.biz_cost_visible");
/** erp_home.biz_freight(p_body jsonb) → numeric */
export const bizFreight = (..._args: unknown[]): never => notPorted("erp_home.biz_freight");
/** erp_home.biz_role(p_user uuid) → text */
export const bizRole = (..._args: unknown[]): never => notPorted("erp_home.biz_role");
/** erp_home.biz_unit_cost(p_product uuid) → numeric */
export const bizUnitCost = (..._args: unknown[]): never => notPorted("erp_home.biz_unit_cost");
/** erp_preferences.label_defaults() → jsonb */
export const labelDefaults = (..._args: unknown[]): never => notPorted("erp_preferences.label_defaults");
/** erp_preferences.report_clean(p text, p_max integer) → text */
export const reportClean = (..._args: unknown[]): never => notPorted("erp_preferences.report_clean");
/** erp_preferences.situation_bases(p_kind text) → TABLE(status text, label text, color text, ordinal integer) */
export const situationBases = (..._args: unknown[]): never => notPorted("erp_preferences.situation_bases");
/** erp_preferences.situation_list(p_kind text) → TABLE(key text, base_status text, name text, color text, is_default boolean, active boolean, version integer, ordinal integer, created_at timestamp with time zone) */
export const situationList = (..._args: unknown[]): never => notPorted("erp_preferences.situation_list");
/** erp_preferences.situation_of(p_kind text, p_key text) → jsonb */
export const situationOf = (..._args: unknown[]): never => notPorted("erp_preferences.situation_of");
/** erp_preferences.transition_allowed(p_kind text, p_from_base text, p_to_base text) → boolean */
export const transitionAllowed = (..._args: unknown[]): never => notPorted("erp_preferences.transition_allowed");
/** erp_preferences.transition_list(p_kind text) → TABLE(from_key text, to_key text, is_default boolean, active boolean, actions text[], version integer, from_ord text, to_ord text) */
export const transitionList = (..._args: unknown[]): never => notPorted("erp_preferences.transition_list");
/** erp_preferences.transition_rule(p_kind text, p_from text, p_to text) → jsonb */
export const transitionRule = (..._args: unknown[]): never => notPorted("erp_preferences.transition_rule");
