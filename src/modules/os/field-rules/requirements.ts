import { ApiError, type Actor } from "../../../types";
import { isBound } from "../../../visibility";
import type { ModuleContext } from "../../api";
import type { ExtraValues, OrderRequirements, WorkField, WorkTypeView } from "../contracts";
import type { RulesMutationInput, RulesMutationPlan } from "../os2-ports";
import type { AuthorizedOrder } from "../public";
import { isFieldFilled, jsonBytes, validateExtra } from "../validation";
import { effectiveStage, snapshotType } from "../work-types";

const emptyPlan = (): RulesMutationPlan => ({ before: [], after: [] });
const invalid = () => new ApiError(400, "invalid_fields", "Os campos ou as etapas da ordem são incompatíveis. Atualize a ordem e confira sua definição.");
const missingMessage = "A equipe precisa completar os dados desta etapa.";

function persistedRequirements(input: RulesMutationInput, type: WorkTypeView): string[] {
  let raw: unknown;
  try { raw = JSON.parse(input.row.stage_required_json ?? "[]"); }
  catch { throw invalid(); }
  if (!Array.isArray(raw) || raw.some(id => typeof id !== "string" || !type.fields.some(field => field.id === id && !field.sensitive))) throw invalid();
  return [...new Set(raw as string[])].sort();
}

/** O JSON recebido é a imagem resultante da ordem, não um segundo PATCH. */
function resultingValues(input: RulesMutationInput, type: WorkTypeView): ExtraValues {
  const value = Object.hasOwn(input.sets, "extra_json") ? input.sets.extra_json : input.row.extra_json ?? "{}";
  let raw: unknown;
  try { raw = typeof value === "string" ? JSON.parse(value) : null; }
  catch { throw invalid(); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  if (jsonBytes(raw) > 16 * 1024) throw new ApiError(413, "payload_too_large", "Valores extras excedem 16 KiB. Reduza os dados da ordem.");
  const entries = Object.entries(raw);
  if (entries.some(([id]) => !type.fields.some(field => field.id === id))) throw invalid();
  // Os valores privados já foram autorizados pelo caminho que prepara a
  // mutação. Validá-los não os projeta nem autoriza uma nova escrita privada.
  try {
    const common = validateExtra(type.fields.filter(field => !field.sensitive),
      Object.fromEntries(entries.filter(([id]) => !type.fields.find(field => field.id === id)!.sensitive)), { partial: true });
    const privateValues = validateExtra(type.fields.filter(field => field.sensitive),
      Object.fromEntries(entries.filter(([id]) => type.fields.find(field => field.id === id)!.sensitive)), { mode: "private", partial: true });
    return { ...common, ...privateValues };
  } catch (error) {
    // O validador compartilhado pode citar IDs. Não entregar IDs internos ou
    // privados em erros do cliente, mesmo que a entrada persistida esteja ruim.
    if (error instanceof ApiError && error.code === "invalid_fields") throw invalid();
    throw error;
  }
}

export interface InspectedOrderRequirements {
  required: WorkField[];
  missing: WorkField[];
  activated: string[];
  previous: string[];
  cancelled: boolean;
}

/** Apenas snapshot e valores carregados; nunca lê o cadastro atual do objeto. */
export function inspectOrderRequirements(input: RulesMutationInput): InspectedOrderRequirements {
  const type = snapshotType(input.row) ?? input.type;
  const previous = persistedRequirements(input, type);
  const from = effectiveStage(input.row);
  const to = Object.hasOwn(input.sets, "stage") ? input.sets.stage : from;
  const destination = type.stages.find(stage => stage.id === to);
  const status = Object.hasOwn(input.sets, "status") ? input.sets.status : input.row.status;
  if (!type.stages.some(stage => stage.id === from) || !destination || destination.base_status !== status) throw invalid();
  const rules = type.stage_field_rules ?? [];
  for (const rule of rules) {
    if (!type.fields.some(field => field.id === rule.field_id && !field.sensitive)
      || (rule.required_from_stage !== undefined && !type.stages.some(stage => stage.id === rule.required_from_stage))
      || (rule.required_on_exit ?? []).some(id => !type.stages.some(stage => stage.id === id))) throw invalid();
  }
  const cancelled = destination.base_status === "cancelled";
  const activated = new Set(previous);
  if (!cancelled) for (const rule of rules) {
    if ((input.opening || from !== to) && rule.required_from_stage === to) activated.add(rule.field_id);
    if (!input.opening && from !== to && rule.required_on_exit?.includes(from)) activated.add(rule.field_id);
  }
  // Cancelar não cobra pendências antigas. Ainda não permite apagar um valor
  // que já estava protegido, se a própria mutação também editar os campos.
  if (cancelled && !Object.hasOwn(input.sets, "extra_json"))
    return { required: [], missing: [], activated: previous, previous, cancelled };
  const values = resultingValues(input, type);
  let required: WorkField[];
  if (cancelled) {
    const before = resultingValues({ ...input, sets: {} }, type);
    required = type.fields.filter(field => previous.includes(field.id) && isFieldFilled(before, field.id));
  } else {
    required = type.fields.filter(field => !field.sensitive && (field.required || activated.has(field.id)));
  }
  return { required, missing: required.filter(field => !isFieldFilled(values, field.id)),
    activated: [...activated].sort(), previous, cancelled };
}

/** A política administrativa pode ampliar a IA interna; o titular externo
 * permanece restrito aos campos públicos mesmo quando a política muda. */
export async function fieldRulesAudience(ctx: ModuleContext, actor: Actor | undefined, customer = false): Promise<(field: WorkField) => boolean> {
  if (!actor) return () => false;
  if (customer || isBound(actor) || actor.credential) return field => !field.sensitive && field.client_visible;
  const ai = !!actor.via || actor.id.startsWith("bot:") || !!actor.module;
  if (!ai) return field => !field.sensitive;
  const policy = (await ctx.settings()).os2_ai_access;
  const internal = policy?.enabled === true && policy.internal === true;
  return field => !field.sensitive && (internal || field.client_visible);
}

async function refuseMissing(ctx: ModuleContext, input: RulesMutationInput, missing: WorkField[]): Promise<void> {
  if (!missing.length) return;
  const visible = await fieldRulesAudience(ctx, input.authority);
  const labels = missing.filter(visible).map(field => field.label);
  const hidden = missing.some(field => !visible(field));
  throw new ApiError(409, "missing_fields", labels.length
    ? `Preencha os campos: ${labels.join(", ")}.${hidden ? ` ${missingMessage}` : ""}`
    : missingMessage);
}

/** Planejamento sem efeitos: o núcleo grava stage_required no próprio CAS. */
export async function prepareOrderRulesMutation(ctx: ModuleContext, input: RulesMutationInput): Promise<RulesMutationPlan> {
  // O contrato legado não passa a validar, ler settings ou escrever projeções
  // só porque a área configurou objetos em outro modelo.
  const type = snapshotType(input.row) ?? input.type;
  if (!(type.stage_field_rules?.length) && (!input.row.stage_required_json || input.row.stage_required_json === "[]")) return emptyPlan();
  if (input.row.profile_id !== ctx.profile) throw new ApiError(404, "not_found", "Ordem não encontrada.");
  const inspected = inspectOrderRequirements({ ...input, type });
  await refuseMissing(ctx, input, inspected.missing);
  if (input.preview || inspected.cancelled || inspected.activated.join("\u0000") === inspected.previous.join("\u0000")) return emptyPlan();
  return { ...emptyPlan(), stage_required: inspected.activated };
}

/** O chamador entrega uma AuthorizedOrder após autorizar área e titular. */
export async function orderRequirements(ctx: ModuleContext, actor: Actor, order: AuthorizedOrder,
  transitionId?: string, options: { customer?: boolean } = {}): Promise<OrderRequirements> {
  if (order.row.profile_id !== ctx.profile) throw new ApiError(404, "not_found", "Ordem não encontrada.");
  const type = snapshotType(order.row) ?? order.type;
  const transition = transitionId === undefined ? undefined
    : type.transitions.find(candidate => candidate.id === transitionId && candidate.from === effectiveStage(order.row));
  if (transitionId !== undefined && !transition)
    throw new ApiError(409, "invalid_transition", "Ação indisponível nesta etapa. Atualize a ordem.");
  const destination = transition && type.stages.find(stage => stage.id === transition.to);
  if (transition && !destination) throw invalid();
  const inspected = inspectOrderRequirements({ row: order.row, type,
    sets: destination ? { stage: destination.id, status: destination.base_status } : {}, actor: actor.id, preview: true });
  const visible = await fieldRulesAudience(ctx, actor, options.customer);
  const project = (fields: WorkField[]) => fields.filter(visible).map(field => ({ field_id: field.id, label: field.label }));
  return { id: order.row.id, version: order.row.row_version ?? 1,
    ...(transitionId === undefined ? {} : { transition_id: transitionId }),
    required: project(inspected.required), missing: project(inspected.missing),
    internal_missing: inspected.missing.some(field => !visible(field)) };
}
