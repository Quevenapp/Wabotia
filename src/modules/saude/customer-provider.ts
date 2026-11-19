import { z } from "zod";
import { batch, one } from "../../db";
import { sha } from "../../security";
import type { Actor } from "../../types";
import type { CustomerModuleProvider } from "../../customer/profile-contracts";
import type { ModuleContext } from "../api";
import { auditStatement, clinical } from "./access";
import { fail, idSchema, parse } from "./model";

// Declaração conservadora para a solicitação durável; nunca executa descarte.
export const saudeCustomerErasure = {
  state: "retained", reason: "private_retention_review",
} as const;

async function contact(ctx: ModuleContext, contactId: string) {
  if (!await one(ctx.env,
    "SELECT id FROM contacts WHERE profile_id=? AND namespace='team' AND id=? AND identity_state='active'",
    ctx.profile, contactId)) fail(404, "not_found");
}

export const saudeCustomerProvider: CustomerModuleProvider = {
  async section(ctx, actor, contactId, sectionId) {
    await clinical(ctx, actor);
    if (sectionId !== "private") fail(404, "not_found");
    await contact(ctx, parse(idSchema, contactId));
    // O destino é constante: nem a existência de pacientes é revelada na ficha.
    return { version: 1, writable: false, schema: "private.navigation.v1", data: {
      target: { module: "saude", resource: "home", id: "saude" },
      erasure: saudeCustomerErasure,
    } };
  },
  async saveSection(ctx, actor) {
    await clinical(ctx, actor, true);
    // Identidade cifrada e conteúdo clínico não são fontes cadastrais.
    fail(403, "forbidden");
  },
};

const linkSchema = z.object({
  subject_id: idSchema, contact_id: idSchema,
  relation: z.enum(["self", "responsible", "tutor"]),
}).strict();

/** Escolha humana explícita no módulo privado, sem abrir a identidade cifrada. */
export async function linkSaudeCustomer(ctx: ModuleContext, actor: Actor, raw: unknown, commandId: string) {
  await clinical(ctx, actor, true);
  const d = parse(linkSchema, raw);
  await contact(ctx, d.contact_id);
  if (!await one(ctx.env, "SELECT id FROM saude_subjects WHERE profile_id=? AND id=? AND state='active'",
    ctx.profile, d.subject_id)) fail(404, "not_found");
  const key = await sha(JSON.stringify([ctx.profile, actor.id, "customer.link", parse(idSchema, commandId)]));
  const hash = await sha(JSON.stringify(d));
  const previous = await one<{ request_hash: string }>(ctx.env,
    "SELECT request_hash FROM saude_mutations WHERE profile_id=? AND mutation_key=?", ctx.profile, key);
  if (previous && previous.request_hash !== hash) fail(409, "idempotency_conflict");
  const result = { contactId: d.contact_id };
  if (previous) return result;
  const guard = `saude:customer:${key}`;
  try { await batch(ctx.env, [
    [`INSERT INTO saude_contact_links(profile_id,subject_id,contact_id,relation)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM saude_subjects WHERE profile_id=? AND id=? AND state='active')
      AND EXISTS(SELECT 1 FROM contacts WHERE profile_id=? AND namespace='team' AND id=? AND identity_state='active')
      ON CONFLICT DO NOTHING`,
    [ctx.profile, d.subject_id, d.contact_id, d.relation, ctx.profile, d.subject_id, ctx.profile, d.contact_id]],
    [`INSERT INTO customer_assert(id,ok) VALUES(?,CASE WHEN EXISTS(
      SELECT 1 FROM saude_contact_links l JOIN contacts c ON c.profile_id=l.profile_id AND c.id=l.contact_id
      JOIN saude_subjects s ON s.profile_id=l.profile_id AND s.id=l.subject_id
      WHERE l.profile_id=? AND l.subject_id=? AND l.contact_id=? AND l.relation=?
      AND c.namespace='team' AND c.identity_state='active' AND s.state='active') THEN 1 ELSE 0 END)`,
    [guard, ctx.profile, d.subject_id, d.contact_id, d.relation]],
    auditStatement(ctx, actor, "customer.link", d.subject_id, [d.contact_id, d.relation]),
    [`INSERT INTO saude_mutations(profile_id,mutation_key,request_hash,response_json) VALUES(?,?,?,?)`,
    [ctx.profile, key, hash, JSON.stringify(result)]],
    ["DELETE FROM customer_assert WHERE id=?", [guard]],
  ]); } catch (error) {
    if (/CHECK constraint|UNIQUE constraint/.test(String(error))) fail(409, "contact_conflict");
    throw error;
  }
  return result;
}
