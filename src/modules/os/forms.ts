import { exec, one } from "../../db";
import { ApiError, type Conversation, json, now, requireValue, uid } from "../../types";
import type { ModuleContext, WebStep } from "../api";
import type { WebField } from "../../web-steps";
import type { CustomWorkType, WorkTypeSnapshot } from "./contracts";
import { makeSnapshot } from "./work-types";
import { resolveWorkType } from "./public";
import { validateExtra } from "./validation";

const fieldId = (id: string) => `extra_${id}`;
export async function customOpenForm(ctx: ModuleContext, c: Conversation, type: CustomWorkType, options: { trigger: "menu" | "agent" | "bot"; actor: string; sourceKey: string }) {
  requireValue(c.chat_type !== "group", "Abertura disponível somente em conversa individual.");
  if (type.archived) throw new ApiError(409, "type_archived", "Tipo arquivado.");
  if (!type.features.customer_open) throw new ApiError(409, "feature_disabled", "Abertura pelo cliente desativada.");
  const fields: WebField[] = [
    { id: "item", type: "text", label: type.labels.item, required: true },
    { id: "problem", type: "text", label: type.labels.problem, required: true, multiline: true },
  ];
  for (const f of type.fields.filter(f => f.client_visible && !f.sensitive)) {
    const base = { id: fieldId(f.id), label: f.label, help: f.help, required: f.required };
    if (f.kind === "boolean") fields.push({ ...base, type: "choice", options: ["Sim", "Não"] });
    else if (f.kind === "choice" && f.options.length >= 2 && f.options.length <= 20)
      // O índice desambigua rótulos iguais sem alterar o ID persistido.
      fields.push({ ...base, type: "choice", options: f.options.map((o, i) => `${i + 1}. ${o.label}`) });
    else if (f.kind === "choice") fields.push({ ...base, type: "text", help: Array.from(`Informe o ID da opção. ${f.help}`).slice(0, 300).join("") });
    else fields.push({ ...base, type: f.kind === "date" ? "date" : "text", ...(f.kind === "text" ? { multiline: f.multiline } : {}) });
  }
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
  if (!ref?.definition_id) throw new ApiError(400, "invalid_request", "Referência da abertura inválida.");
  const fixed = await one(ctx.env, "SELECT * FROM os_open_definitions WHERE profile_id=? AND id=? AND type_id=? AND type_revision=?", ctx.profile, ref.definition_id, ref.type_id, ref.revision);
  if (!fixed) throw new ApiError(400, "invalid_request", "Definição da abertura indisponível.");
  const snapshot: WorkTypeSnapshot = json(fixed.snapshot_json);
  const current = await resolveWorkType(ctx, snapshot.type.id);
  if (current.archived) throw new ApiError(409, "type_archived", "Este tipo não recebe novas aberturas.");
  const type = snapshot.type;
  const extra: Record<string, unknown> = {};
  for (const f of type.fields.filter(f => f.client_visible && !f.sensitive)) {
    const raw = answers[fieldId(f.id)];
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
    } else if (f.kind === "choice" && f.options.length >= 2 && f.options.length <= 20) extra[f.id] = f.options.find((o, i) => `${i + 1}. ${o.label}` === raw)?.id;
    else extra[f.id] = raw;
  }
  for (const [key, max] of [["item", 200], ["problem", 2000]] as const) requireValue(typeof answers[key] === "string" && answers[key].trim() && Array.from(answers[key].trim()).length <= max, `Campo ${key} inválido.`);
  requireValue(!type.terms || answers.terms === true, "Aceite os termos para continuar.");
  return { type_id: type.id, snapshot, extra: validateExtra(type.fields, extra, { mode: "customer" }), item: answers.item.trim(), problem: answers.problem.trim(), terms: type.terms };
}
