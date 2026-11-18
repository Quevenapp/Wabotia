import type { Actor } from "../../../types";
import type { ModuleContext } from "../../api";
import type { LinkedPerson } from "../contracts";
import { projectChildForBot, projectChildForStaff } from "../privacy";
import type { PersonValues } from "./model";

export interface PersonRow extends Omit<PersonValues, "client_visible" | "sensitive"> {
  id: string;
  order_id: string;
  version: number;
  created_by: string;
  created: number;
  updated: number;
  archived_at: number | null;
  client_visible: number;
  sensitive: number;
}

export const personBotContext = (actor: Actor): boolean =>
  !!actor.via || actor.id.startsWith("bot:") || actor.bots.length > 0;

/** Lista explícita: nem linha SQL nem dados completos do contato atravessam a projeção. */
export function personDto(row: PersonRow): LinkedPerson {
  return {
    id: row.id, order_id: row.order_id, version: row.version,
    role: row.role, name: row.name, contact_id: row.contact_id,
    phone: row.phone, email: row.email, note: row.note,
    client_visible: row.client_visible === 1, sensitive: row.sensitive === 1,
    created_by: row.created_by, created: row.created, updated: row.updated,
    archived_at: row.archived_at,
  };
}

export async function projectPerson(ctx: ModuleContext, actor: Actor, row: PersonRow) {
  const dto = await projectChildForStaff(ctx, actor, personDto(row));
  return dto && personBotContext(actor) ? projectChildForBot(dto) : dto;
}
