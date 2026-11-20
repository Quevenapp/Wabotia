import { exec, one } from "../../db";
import { ApiError, type Conversation, json, now, requireValue, uid } from "../../types";
import type { ModuleContext, WebStep } from "../api";
import { validateFields, type WebField } from "../../web-steps";
import type { CustomWorkType, ServiceObjectType, WorkField, WorkTypeSnapshot, ObjectOpeningRequest } from "./contracts";
import { makeSnapshot, resolveWorkFields } from "./work-types";
import { resolveWorkType } from "./public";
import { validateExtra, validateObjectType } from "./validation";
import { hash } from "../../integrations/keys";
import { objectFormChoices, requireObjectCustomer, revalidateObjectChoice, type ObjectFormChoice } from "./customer-objects";

const fieldId = (id: string) => `extra_${id}`;
const objectFieldId = (id: string) => `object_${id}`;
const publicFields = (fields: WorkField[]) => fields.filter(f => f.client_visible && !f.sensitive);

function formFields(fields: WorkField[], identify = fieldId, optional = false): WebField[] {
  return publicFields(fields).map(f => {
    const base = { id: identify(f.id), label: f.label, help: f.help, required: optional ? false : f.required };
    if (f.kind === "boolean") return { ...base, type: "choice", options: ["Sim", "Não"] };
    // O índice desambigua rótulos iguais sem alterar o ID persistido.
    if (f.kind === "choice") return { ...base, type: "choice", options: f.options.map((o, i) => `${i + 1}. ${o.label}`) };
    return { ...base, type: f.kind === "date" ? "date" : "text", ...(f.kind === "text" ? { multiline: f.multiline, max_length: f.max_length } : {}) };
  });
}

function convertFields(fields: WorkField[], step: WebStep, answers: Record<string, unknown>, identify = fieldId) {
  const extra: Record<string, unknown> = {};
  for (const f of publicFields(fields)) {
    const raw = answers[identify(f.id)];
    if (raw === undefined || raw === "") continue;
    if (f.kind === "integer" || f.kind === "decimal") {
      if (typeof raw !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) throw new ApiError(400, "invalid_fields", `Campo ${f.id}: número inválido.`);
      const value = Number(raw);
      if (f.kind === "decimal") {
        const fraction = raw.split(".")[1]?.replace(/0+$/, "") ?? "";
        if (fraction.length > f.scale || (fraction && Number.isInteger(value))) throw new ApiError(400, "invalid_fields", `Campo ${f.id}: precisão inválida.`);
      }
      extra[f.id] = value;
    } else if (f.kind === "boolean") {
      if (raw !== "Sim" && raw !== "Não") throw new ApiError(400, "invalid_fields", `Campo ${f.id}: escolha Sim ou Não.`);
      extra[f.id] = raw === "Sim";
    } else if (f.kind === "choice") {
      // Links antigos podiam pedir o ID em texto. A forma vem do passo salvo.
      const legacyText = step.fields?.some((field: Pick<WebField, "id" | "type">) => field.id === identify(f.id) && field.type === "text");
      extra[f.id] = legacyText ? raw : f.options.find((o, i) => `${i + 1}. ${o.label}` === raw)?.id;
    } else extra[f.id] = raw;
  }
  return extra;
}
function parseFields(fields: WorkField[], step: WebStep, answers: Record<string, unknown>, identify = fieldId) {
  return validateExtra(fields, convertFields(fields, step, answers, identify), { mode: "customer" });
}

export async function customOpenForm(ctx: ModuleContext, c: Conversation, type: CustomWorkType, options: { trigger: "menu" | "agent" | "bot"; actor: string; sourceKey: string }): ReturnType<ModuleContext["openWebStep"]> {
  if (type.object_type_id) return objectOpenForm(ctx, c, type, options);
  requireValue(c.chat_type !== "group", "Abertura disponível somente em conversa individual.");
  if (type.archived) throw new ApiError(409, "type_archived", "Tipo arquivado.");
  if (!type.features.customer_open) throw new ApiError(409, "feature_disabled", "Abertura pelo cliente desativada.");
  const fields: WebField[] = [
    { id: "item", type: "text", label: type.labels.item, required: true },
    { id: "problem", type: "text", label: type.labels.problem, required: true, multiline: true },
  ];
  fields.push(...formFields(type.fields));
  if (type.terms) fields.push({ id: "terms", type: "accept", label: "Li e aceito os termos", required: true });
  const id = uid();
  await exec(ctx.env, "INSERT INTO os_open_definitions(profile_id,id,type_id,type_revision,snapshot_json,created) VALUES(?,?,?,?,?,?)", ctx.profile, id, type.id, type.revision, JSON.stringify(makeSnapshot(type)), now());
  return ctx.openWebStep(c, {
    kind: "open", ref: JSON.stringify({ type_id: type.id, revision: type.revision, definition_id: id }),
    ...options, ttlMinutes: 24 * 60,
    text: `Para abrir ${type.labels.singular}, preencha este link:`, button: "Abrir trabalho",
    spec: { title: `Abrir ${type.labels.singular}`, intro: type.terms ? `Termos:\n${type.terms}` : "", fields, submit_label: "Abrir trabalho", done_text: "Recebemos! O número do trabalho chega na conversa do WhatsApp.", return_message: "module", ticket: "none" },
  });
}
export async function openingAnswers(ctx: ModuleContext, step: WebStep, answers: Record<string, any>) {
  if (!step.ref_id) return null;
  const ref = json(step.ref_id, null);
  if (ref?.schema_version === 2) return objectOpeningAnswers(ctx, step, answers);
  if (!ref?.definition_id) throw new ApiError(400, "invalid_request", "Referência da abertura inválida.");
  const fixed = await one(ctx.env, "SELECT * FROM os_open_definitions WHERE profile_id=? AND id=? AND type_id=? AND type_revision=?", ctx.profile, ref.definition_id, ref.type_id, ref.revision);
  if (!fixed) throw new ApiError(400, "invalid_request", "Definição da abertura indisponível.");
  const snapshot: WorkTypeSnapshot = json(fixed.snapshot_json);
  const current = await resolveWorkType(ctx, snapshot.type.id);
  if (current.archived) throw new ApiError(409, "type_archived", "Este tipo não recebe novas aberturas.");
  const type = snapshot.type;
  const extra = convertFields(type.fields, step, answers);
  for (const [key, max] of [["item", 200], ["problem", 2000]] as const) requireValue(typeof answers[key] === "string" && answers[key].trim() && Array.from(answers[key].trim()).length <= max, `Campo ${key} inválido.`);
  requireValue(!type.terms || answers.terms === true, "Aceite os termos para continuar.");
  return { type_id: type.id, snapshot, extra: validateExtra(type.fields, extra, { mode: "customer" }), item: answers.item.trim(), problem: answers.problem.trim(), terms: type.terms };
}

/** Dados internos congelados; somente rótulos públicos vão à especificação HTML. */
export interface ObjectOpeningDefinition {
  schema_version: 2;
  snapshot: WorkTypeSnapshot;
  object_type: ServiceObjectType;
  contact_id: string;
  conversation_id: string;
  choices: ObjectFormChoice[];
}
// A forma persistida (JSON) é a referência: propriedades ausentes e indefinidas se equivalem.
const definitionHash = (type: ServiceObjectType) => hash(JSON.parse(JSON.stringify(type)));
const definitionConflict = () => new ApiError(409, "object_definition_conflict", "A definição deste formulário mudou ou está indisponível. Solicite um novo link à equipe.");

export async function loadObjectOpeningDefinition(ctx: ModuleContext, step: WebStep, provided?: unknown): Promise<ObjectOpeningDefinition> {
  const ref = json(step.ref_id, null);
  if (step.module_id !== "os" || step.kind !== "open" || ref?.schema_version !== 2 || !ref.definition_id) throw definitionConflict();
  const fixed = provided === undefined ? await one(ctx.env,
    "SELECT snapshot_json FROM os_open_definitions WHERE profile_id=? AND id=? AND type_id=? AND type_revision=?",
    ctx.profile, ref.definition_id, ref.type_id, ref.revision) : null;
  const raw = provided === undefined ? json(fixed?.snapshot_json, null) : provided;
  try {
    const value = raw as ObjectOpeningDefinition;
    if (!value || value.schema_version !== 2 || value.snapshot?.schema_version !== 1 ||
        typeof value.contact_id !== "string" || !value.contact_id || value.conversation_id !== step.conversation_id ||
        value.snapshot.type.id !== ref.type_id || value.snapshot.type.revision !== ref.revision ||
        !Array.isArray(value.choices) || value.choices.length > 30) throw definitionConflict();
    const snapshot = makeSnapshot(value.snapshot.type), object_type = validateObjectType(value.object_type);
    resolveWorkFields(snapshot.type, object_type);
    const ids = new Set<string>(), labels = new Set<string>();
    for (const choice of value.choices) {
      if (!choice || typeof choice.id !== "string" || !choice.id || ids.has(choice.id) ||
          !Number.isSafeInteger(choice.version) || choice.version < 1 || typeof choice.label !== "string" ||
          !choice.label || choice.label !== choice.label.trim() || Array.from(choice.label).length > 100 ||
          choice.label === "Informar outro" || labels.has(choice.label)) throw definitionConflict();
      ids.add(choice.id); labels.add(choice.label);
    }
    return { schema_version: 2, snapshot, object_type, contact_id: value.contact_id,
      conversation_id: value.conversation_id, choices: value.choices.map(choice => ({ id: choice.id, version: choice.version, label: choice.label })) };
  } catch { throw definitionConflict(); }
}

export async function objectOpenForm(ctx: ModuleContext, c: Conversation, type: CustomWorkType,
  options: { trigger: "menu" | "agent" | "bot"; actor: string; sourceKey: string }): ReturnType<ModuleContext["openWebStep"]> {
  // Esta função também pode ser chamada diretamente; sem objeto conserva a ramificação anterior.
  if (!type.object_type_id) return customOpenForm(ctx, c, type, options);
  requireValue(c.chat_type !== "group", "Abertura disponível somente em conversa individual.");
  await ctx.requireEnabled();
  if (type.archived) throw new ApiError(409, "type_archived", "Modelo arquivado.");
  if (!type.features.customer_open) throw new ApiError(409, "feature_disabled", "Abertura pelo cliente desativada.");
  const settings = await ctx.settings();
  const raw = settings.os_object_types?.find((entry: ServiceObjectType) => entry.id === type.object_type_id);
  if (!raw) throw definitionConflict();
  const objectType = validateObjectType(raw);
  if (objectType.archived) throw definitionConflict();
  const snapshot = makeSnapshot(type), effective = resolveWorkFields(snapshot.type, objectType);
  const { contactId, choices: available } = await objectFormChoices(ctx, c, objectType.id);
  const choices = available.map((choice, index) => ({ ...choice,
    label: Array.from(`${index + 1}. ${choice.label}`).slice(0, 100).join("").trimEnd() }));
  const fields: WebField[] = [
    { id: "item", type: "text", label: type.labels.item, required: true, max_length: 200 },
    { id: "problem", type: "text", label: type.labels.problem, required: true, multiline: true, max_length: 2000 },
    { id: "service_object_choice", type: "choice", label: `Qual ${objectType.labels.singular.toLocaleLowerCase("pt-BR")}?`,
      required: true, options: [...choices.map(choice => choice.label), "Informar outro"],
      help: "Preencha os dados abaixo somente se escolheu Informar outro." },
    ...formFields(effective.object, objectFieldId, true).map(field => ({ ...field,
      help: `Somente para Informar outro.${field.help ? ` ${field.help}` : ""}` })),
    ...formFields(effective.order).map(field => ({ ...field,
      help: `Desta ordem.${field.help ? ` ${field.help}` : ""}` })),
  ];
  if (type.terms) fields.push({ id: "terms", type: "accept", label: "Li e aceito os termos", required: true });
  // Valida os limites antes de persistir a definição ou enviar o link.
  validateFields(fields);
  const definition: ObjectOpeningDefinition = { schema_version: 2, snapshot, object_type: objectType,
    contact_id: contactId, conversation_id: c.id, choices };
  const id = uid();
  await exec(ctx.env, "INSERT INTO os_open_definitions(profile_id,id,type_id,type_revision,snapshot_json,created) VALUES(?,?,?,?,?,?)",
    ctx.profile, id, type.id, type.revision, JSON.stringify(definition), now());
  return ctx.openWebStep(c, {
    kind: "open", ref: JSON.stringify({ schema_version: 2, type_id: type.id, revision: type.revision, definition_id: id }),
    ...options, ttlMinutes: 24 * 60, text: `Para abrir ${type.labels.singular}, preencha este link:`, button: "Abrir trabalho",
    spec: { title: `Abrir ${type.labels.singular}`, intro: type.terms ? `Termos:\n${type.terms}` : "", fields,
      submit_label: "Abrir trabalho", done_text: "Recebemos! O número do trabalho chega na conversa do WhatsApp.", return_message: "module", ticket: "none" },
  });
}

export async function objectOpeningAnswers(ctx: ModuleContext, step: WebStep, answers: Record<string, unknown>, provided?: unknown) {
  const definition = await loadObjectOpeningDefinition(ctx, step, provided);
  const { snapshot, object_type: objectType } = definition, type = snapshot.type;
  const conversation = await ctx.conversation(step.conversation_id);
  const { contactId } = await requireObjectCustomer(ctx, conversation);
  if (contactId !== definition.contact_id) throw new ApiError(404, "not_found", "Abertura não encontrada ou não acessível.");
  const allowed = new Set(["item", "problem", "service_object_choice", ...(type.terms ? ["terms"] : []),
    ...publicFields(type.fields).map(field => fieldId(field.id)), ...publicFields(objectType.fields).map(field => objectFieldId(field.id))]);
  if (!answers || typeof answers !== "object" || Array.isArray(answers) || Object.keys(answers).some(key => !allowed.has(key)))
    throw new ApiError(400, "invalid_fields", "Preencha somente os campos disponíveis neste formulário.");
  const current = await resolveWorkType(ctx, type.id);
  if (current.archived) throw new ApiError(409, "type_archived", "Este modelo não recebe novas aberturas.");
  if (!current.features.customer_open) throw new ApiError(409, "feature_disabled", "Abertura pelo cliente desativada.");
  if (current.object_type_id !== objectType.id) throw definitionConflict();
  for (const [key, max] of [["item", 200], ["problem", 2000]] as const)
    requireValue(typeof answers[key] === "string" && answers[key].trim() && Array.from(answers[key].trim()).length <= max, `Campo ${key} inválido.`);
  requireValue(!type.terms || answers.terms === true, "Aceite os termos para continuar.");
  let object: ObjectOpeningRequest;
  if (answers.service_object_choice === "Informar outro") {
    const settings = await ctx.settings();
    const raw = settings.os_object_types?.find((entry: ServiceObjectType) => entry.id === objectType.id);
    if (!raw || definitionHash(validateObjectType(raw)) !== definitionHash(objectType) || objectType.archived) throw definitionConflict();
    object = { mode: "new", type_id: objectType.id, values: parseFields(objectType.fields, step, answers, objectFieldId) };
  } else {
    const choice = definition.choices.find(entry => entry.label === answers.service_object_choice);
    if (!choice) throw new ApiError(400, "invalid_fields", "Escolha um objeto da lista ou Informar outro.");
    if (publicFields(objectType.fields).some(field => {
      const value = answers[objectFieldId(field.id)];
      return value !== undefined && value !== null && value !== "";
    })) throw new ApiError(400, "invalid_fields", "Ao escolher um objeto cadastrado, deixe os campos de Informar outro vazios.");
    const selected = await revalidateObjectChoice(ctx, conversation, { contactId, typeId: objectType.id, id: choice.id, version: choice.version });
    try { resolveWorkFields(type, validateObjectType(json(selected.type_snapshot_json, null))); }
    catch { throw definitionConflict(); }
    object = { mode: "existing", id: choice.id, version: choice.version };
  }
  return { type_id: type.id, snapshot, extra: parseFields(type.fields, step, answers),
    item: (answers.item as string).trim(), problem: (answers.problem as string).trim(), terms: type.terms, contact_id: contactId, object };
}
