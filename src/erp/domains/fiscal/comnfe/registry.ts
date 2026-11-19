/** RPCs da base: identidade e formato antes dos encaixes síncronos.
 * A costura HTTP escolhe os nomes internos; o navegador não escolhe RPC,
 * token, corpo fiscal nem resultado de autorização. Instalação dos encaixes
 * está documentada em commercial-nfe/contracts.ts e slots.ts.
 */
import { registerRpc, type RpcArgs } from "../../../engine/registry.ts";
import { ErpError } from "../../../engine/errors.ts";
import { commercialNfeSlots } from "../../../commercial-nfe/slots.ts";
import type {
  ConfigSaveInput, PrepareInput, ReadInput, ListInput, ClaimInput, RecordInput,
  CancelClaimInput, CancelRecordInput, CancellationXmlInput, EffectInput,
} from "../../../commercial-nfe/contracts.ts";
import { requireCom1Access } from "./access.ts";
import { getCommercialSettings, saveCommercialSettings } from "./settings.ts";
import { requireClaimedCommand } from "./store.ts";

const invalid = (): never => { throw new ErpError("22023", "com1_input_invalid"); };
function input<T>(args: RpcArgs, allowed: readonly string[], required: readonly string[] = allowed): T {
  const value = args.p_input;
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(data, key))) return invalid();
  return value as T;
}
const expectedPerson = (args: RpcArgs): string => typeof args.p_user_id === "string" ? args.p_user_id : invalid();
const evidenceFields = ["emission_id", "command_id", "claim_token"] as const;
const effectFields = ["emission_id", "command_id", "expected_version", "axis", "intent", "physical_return_confirmed"] as const;

registerRpc("erp_com1_config_get", (ctx, a) => {
  requireCom1Access(ctx, "read", expectedPerson(a));
  return getCommercialSettings(ctx);
});
registerRpc("erp_com1_config_save", (ctx, a) => {
  requireCom1Access(ctx, "configure", expectedPerson(a));
  const value = input<ConfigSaveInput>(a,
    ["command_id", "expected_version", "environment", "stock_timing", "finance_timing", "series_homologacao", "series_producao", "acknowledge_tax_limits", "enable_production"],
    ["command_id", "expected_version", "environment", "stock_timing", "finance_timing"]);
  return saveCommercialSettings(ctx, value);
});
registerRpc("erp_com1_prepare", (ctx, a) => {
  requireCom1Access(ctx, "prepare", expectedPerson(a));
  const value = input<PrepareInput>(a,
    ["document_id", "expected_document_version", "command_id", "choices", "new_fiscal_version", "expected_emission_version"],
    ["document_id", "expected_document_version", "command_id", "choices"]);
  const choices = value.choices;
  if (!choices || typeof choices !== "object" || Array.isArray(choices) ||
      Object.keys(choices).some(key => !["nature_id", "presence", "final_consumer", "series"].includes(key))) return invalid();
  return commercialNfeSlots().prepare(ctx, value);
});
registerRpc("erp_com1_get", (ctx, a) => {
  requireCom1Access(ctx, "read", expectedPerson(a));
  return commercialNfeSlots().read(ctx, input<ReadInput>(a, ["emission_id"]));
});
registerRpc("erp_com1_list", (ctx, a) => {
  requireCom1Access(ctx, "read", expectedPerson(a));
  const value = input<ListInput>(a, ["environment", "document_id", "status", "page", "per_page"], ["environment"]);
  if (value.environment !== "homologacao" && value.environment !== "producao") return invalid();
  return commercialNfeSlots().list(ctx, value);
});
registerRpc("erp_com1_claim", (ctx, a) => {
  const value = input<ClaimInput>(a,
    ["emission_id", "command_id", "action", "expected_version", "body_revision", "body_hash", "connection_fingerprint", "source_fingerprint"],
    ["emission_id", "command_id", "action", "expected_version", "body_revision", "body_hash", "connection_fingerprint"]);
  if (value.action !== "emit" && value.action !== "resume") return invalid();
  requireCom1Access(ctx, value.action, expectedPerson(a));
  return commercialNfeSlots().claim(ctx, value);
});
registerRpc("erp_com1_record", (ctx, a) => {
  const value = input<RecordInput>(a, [...evidenceFields, "connection_fingerprint", "result", "evidence", "error"],
    [...evidenceFields, "connection_fingerprint", "result"]);
  requireClaimedCommand(ctx, value, ["emit", "resume"]);
  return commercialNfeSlots().record(ctx, value);
});
registerRpc("erp_com1_cancel_claim", (ctx, a) => {
  requireCom1Access(ctx, "cancel", expectedPerson(a));
  return commercialNfeSlots().cancelClaim(ctx, input<CancelClaimInput>(a,
    ["emission_id", "command_id", "expected_version", "justification", "connection_fingerprint"]));
});
registerRpc("erp_com1_cancel_record", (ctx, a) => {
  const value = input<CancelRecordInput>(a, [...evidenceFields, "connection_fingerprint", "state", "result", "event_protocol", "event_at", "evidence", "error"],
    [...evidenceFields, "connection_fingerprint", "state", "result"]);
  requireClaimedCommand(ctx, value, ["cancel"]);
  return commercialNfeSlots().cancelRecord(ctx, value);
});
registerRpc("erp_com1_cancel_xml_record", (ctx, a) => {
  const value = input<CancellationXmlInput>(a, [...evidenceFields, "xml", "xml_hash"]);
  requireClaimedCommand(ctx, value, ["cancel"]);
  return commercialNfeSlots().recordCancellationXml(ctx, value);
});
registerRpc("erp_com1_effect_apply", (ctx, a) => {
  const value = input<EffectInput>(a, effectFields, effectFields.slice(0, 5));
  if (!["stock", "finance"].includes(value.axis) || !["reconcile", "apply", "apply_skipped"].includes(value.intent)) return invalid();
  requireCom1Access(ctx, value.axis === "stock" ? "effect_stock" : "effect_finance", expectedPerson(a));
  return commercialNfeSlots().applyEffects(ctx, value);
});
registerRpc("erp_com1_effect_reverse", (ctx, a) => {
  const value = input<EffectInput>(a, effectFields, effectFields.slice(0, 5));
  if (!["stock", "finance"].includes(value.axis) || value.intent !== "reverse") return invalid();
  requireCom1Access(ctx, value.axis === "stock" ? "effect_stock" : "effect_finance", expectedPerson(a));
  return commercialNfeSlots().reverseEffects(ctx, value);
});
