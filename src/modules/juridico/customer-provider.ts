import { z } from "zod";
import { one } from "../../db";
import { ApiError, type Actor } from "../../types";
import type { CustomerModuleProvider } from "../../customer/profile-contracts";
import type { ModuleContext } from "../api";
import { parent, staff } from "./access";
import { idSchema, parse } from "./model";

export const juridicoCustomerErasure = {
  state: "retained", reason: "private_retention_review",
} as const;

async function contact(ctx: ModuleContext, contactId: string) {
  if (!await one(ctx.env,
    "SELECT id FROM contacts WHERE profile_id=? AND namespace='team' AND id=? AND identity_state='active'",
    ctx.profile, contactId)) throw new ApiError(404, "not_found", "Contato não encontrado.");
}

export const juridicoCustomerProvider: CustomerModuleProvider = {
  async section(ctx, actor, contactId, sectionId) {
    await staff(ctx, actor);
    if (sectionId !== "private") throw new ApiError(404, "not_found", "Seção não encontrada.");
    await contact(ctx, parse(idSchema, contactId));
    return { version: 1, writable: false, schema: "private.navigation.v1", data: {
      target: { module: "juridico", resource: "home", id: "juridico" },
      erasure: juridicoCustomerErasure,
    } };
  },
  async saveSection(ctx, actor) {
    await staff(ctx, actor, true);
    throw new ApiError(403, "forbidden", "Dados processuais não podem completar o cadastro.");
  },
};

/** O vínculo é o cliente já escolhido no trabalho; não há uma segunda relação. */
export async function linkJuridicoCustomer(ctx: ModuleContext, actor: Actor, raw: unknown) {
  await staff(ctx, actor, true);
  const d = parse(z.object({ order_id: idSchema, contact_id: idSchema }).strict(), raw);
  await contact(ctx, d.contact_id);
  const work = await parent(ctx, actor, d.order_id, true);
  if (work.row.contact_id !== d.contact_id)
    throw new ApiError(409, "contact_conflict", "Vincule este contato como cliente no trabalho antes de continuar.");
  // Repetir é leitura, e cada tentativa revalida os dois lados e a permissão.
  // Pessoas e partes contrárias permanecem exclusivamente no trabalho.
  return { contactId: d.contact_id };
}
