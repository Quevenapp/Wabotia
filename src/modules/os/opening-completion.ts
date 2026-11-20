// O passo só é consumido depois do lote da ordem. As respostas aceitas ficam
// no mesmo lote, para uma edição posterior da ordem não alterar a recuperação.
import { one } from "../../db";
import { hash } from "../../integrations/keys";
import { ApiError, json, now } from "../../types";
import type { Answers, WebField } from "../../web-steps";
import type { ModuleContext, WebStep } from "../api";
import { isObjectOpeningWebStep } from "../hooks";
import { requireObjectCustomer } from "./customer-objects";
import { loadObjectOpeningDefinition, objectOpeningAnswers } from "./forms";
import type { Os2Adapters } from "./os2-ports";
import type { ChildStatement, WorkOrderRow } from "./public";
import { createOrder, notify, type CreateInput } from "./store";

interface AcceptedOpening {
  schema_version: 1;
  step_id: string;
  definition_id: string;
  conversation_id: string;
  contact_id: string;
  order_id: string;
  answers: Answers;
}
type PendingOpening = Omit<AcceptedOpening, "order_id">;
const pending = new WeakMap<CreateInput, PendingOpening>();
const receiptWrappers = new WeakSet<Os2Adapters["prepareObjectOpening"]>();
const requestKey = (stepId: string) => `web_step:${stepId}`;
const receiptScope = (profile: string, contact: string) => `os-web-step:${profile}:customer:${contact}:os.create`;
const unavailable = () => new ApiError(409, "object_definition_conflict", "Não foi possível recuperar a abertura confirmada. Peça ajuda à equipe.");
const notFound = () => new ApiError(404, "not_found", "Abertura não encontrada ou não acessível.");

/** Compor com o planejador de objetos na instalação dos adaptadores. Não
 * executa escrita separada: recibo e respostas entram no lote da ordem.
 * Chamadas que não vêm de os/open v2 preservam o plano recebido. */
export function withObjectWebStepReceiptPlan(prepare: Os2Adapters["prepareObjectOpening"]): Os2Adapters["prepareObjectOpening"] {
  if (receiptWrappers.has(prepare)) return prepare;
  const wrapped: Os2Adapters["prepareObjectOpening"] = async (ctx, opening) => {
    const plan = await prepare(ctx, opening);
    const accepted = pending.get(opening.input);
    if (!accepted) return plan;
    if (plan.contact_id !== accepted.contact_id || opening.input.sourceKey !== requestKey(accepted.step_id)) throw notFound();
    const response: AcceptedOpening = { ...accepted, order_id: opening.order_id };
    const key = `stage:${opening.order_id}:1:opened`;
    const notices: ChildStatement[] = opening.type.stages.find(stage => stage.id === opening.type.initial_stage)?.message ? [[
      `INSERT INTO customer_progress(profile_id,namespace,task,cursor_json,complete,updated)
        SELECT ?,'team',?,?,0,? WHERE EXISTS(SELECT 1 FROM os_orders WHERE profile_id=? AND id=? AND row_version=1)
        ON CONFLICT(profile_id,namespace,task) DO NOTHING`,
      [ctx.profile, `os:notice:${JSON.stringify([opening.order_id, key])}`,
        JSON.stringify({ orderId: opening.order_id, version: 1, textKey: "opened", key }), opening.at, ctx.profile, opening.order_id],
    ]] : [];
    return {
      ...plan,
      after: [...plan.after, ...notices, [
        `INSERT INTO receipts(scope,key,fingerprint,response,status,created)
          SELECT ?,?,?,?,200,? WHERE EXISTS(SELECT 1 FROM os_orders WHERE profile_id=? AND id=? AND contact_id=? AND object_id=?)`,
        [receiptScope(ctx.profile, accepted.contact_id), requestKey(accepted.step_id), hash(response), JSON.stringify(response), opening.at,
          ctx.profile, opening.order_id, accepted.contact_id, plan.object_id],
      ]],
    };
  };
  receiptWrappers.add(wrapped);
  return wrapped;
}

async function context(ctx: ModuleContext, step: WebStep, provided?: unknown) {
  if (!isObjectOpeningWebStep(step)) return null;
  await ctx.requireEnabled();
  const definition = await loadObjectOpeningDefinition(ctx, step, provided);
  const conversation = await ctx.conversation(step.conversation_id);
  const { contactId } = await requireObjectCustomer(ctx, conversation);
  if (contactId !== definition.contact_id || (step.contact_id && step.contact_id !== contactId)) throw notFound();
  const ref = json(step.ref_id, null);
  if (!ref || typeof ref.definition_id !== "string") throw unavailable();
  return { definition, conversation, contactId, definitionId: ref.definition_id as string };
}

async function recover(ctx: ModuleContext, step: WebStep, access: NonNullable<Awaited<ReturnType<typeof context>>>) {
  const saved = await one<{ response: string | null; fingerprint: string }>(ctx.env,
    "SELECT response,fingerprint FROM receipts WHERE scope=? AND key=? AND status=200",
    receiptScope(ctx.profile, access.contactId), requestKey(step.id));
  if (!saved) return null;
  const accepted = json(saved.response, null) as AcceptedOpening | null;
  if (!accepted || accepted.schema_version !== 1 || accepted.step_id !== step.id ||
      accepted.definition_id !== access.definitionId || accepted.conversation_id !== step.conversation_id ||
      accepted.contact_id !== access.contactId || typeof accepted.order_id !== "string" ||
      !accepted.answers || typeof accepted.answers !== "object" || Array.isArray(accepted.answers) || hash(accepted) !== saved.fingerprint)
    throw unavailable();
  const row = await one<WorkOrderRow>(ctx.env,
    "SELECT * FROM os_orders WHERE profile_id=? AND id=? AND source_key=? AND contact_id=? AND conversation_id=?",
    ctx.profile, accepted.order_id, `motor:${ctx.profile}:${requestKey(step.id)}`, access.contactId, step.conversation_id);
  if (!row || !row.object_id || row.type_id !== access.definition.snapshot.type.id) throw notFound();
  // O recibo identifica um comando aceito. A autorização vem do titular atual;
  // arquivamento/revisão do objeto ou do modelo não reaplicam a abertura.
  return { row, answers: structuredClone(accepted.answers) };
}

function publishAccepted(ctx: ModuleContext, row: WorkOrderRow) {
  return ctx.publish("os.opened", row.id, {
    order_id: row.id, id: row.id, version: 1, type_id: row.type_id,
  }, { key: `opened:${row.id}` });
}

/** Porta anterior ao consumo do link. Caminho legado retorna sem leituras. */
export const prepareObjectWebStepCompletion: Os2Adapters["prepareObjectWebStepCompletion"] = async (ctx, step, answers, options) => {
  const access = await context(ctx, step, options?.definition);
  if (!access) return null;
  const accepted = await recover(ctx, step, access);
  if (accepted) {
    await publishAccepted(ctx, accepted.row);
    return { replayed: true, answers: accepted.answers };
  }
  // O primeiro gancho ainda recebe o corpo antes de validateAnswers descartar
  // chaves desconhecidas. Recusa campos privados/forjados sem expor seus nomes.
  if (["sent", "opened"].includes(step.status) && step.expires_at > now()) {
    const known = new Set(step.fields.map((field: Pick<WebField, "id">) => field.id));
    if (!answers || typeof answers !== "object" || Array.isArray(answers) || Object.keys(answers).some(key => !known.has(key)))
      throw new ApiError(400, "invalid_fields", "Preencha somente os campos disponíveis neste formulário.");
  }
  if (options?.resumeOnly) return null;
  if (!["sent", "opened"].includes(step.status) || step.expires_at <= now())
    throw new ApiError(409, "expired", "Este link expirou. Solicite um novo formulário.");
  const parsed = await objectOpeningAnswers(ctx, step, answers, access.definition);
  const input: CreateInput = {
    ...parsed,
    conversation: access.conversation,
    contact_id: access.contactId,
    source: "customer", sourceKey: requestKey(step.id), actor: "customer", notify: false,
  };
  const publicAnswers = Object.fromEntries(step.fields.filter((field: Pick<WebField, "id">) => Object.hasOwn(answers, field.id)).map((field: Pick<WebField, "id">) => [field.id,
    typeof answers[field.id] === "string" ? answers[field.id].trim() : answers[field.id]]));
  const acceptedInput: PendingOpening = {
    schema_version: 1, step_id: step.id, definition_id: access.definitionId,
    conversation_id: step.conversation_id, contact_id: access.contactId,
    answers: publicAnswers,
  };
  pending.set(input, acceptedInput);
  try {
    const result = await createOrder(ctx, input);
    const durable = await recover(ctx, step, access);
    if (!durable || durable.row.id !== result.order.id) throw unavailable();
    return { replayed: !result.created, answers: durable.answers };
  } finally { pending.delete(input); }
};

/** O callback posterior nunca cria uma ordem. Retoma apenas o resultado e o
 * aviso com as mesmas chaves já usadas pelo motor. */
export const resumeObjectWebStepCompletion: Os2Adapters["resumeObjectWebStepCompletion"] = async (ctx, step) => {
  const access = await context(ctx, step);
  if (!access) return;
  const accepted = await recover(ctx, step, access);
  if (!accepted) throw unavailable();
  await publishAccepted(ctx, accepted.row);
  if (accepted.row.row_version === 1)
    await notify(ctx, accepted.row, "opened", `stage:${accepted.row.id}:1:opened`);
  return false;
};
