// F0: projeções comuns. M completa extras/snapshots, histórico novo e privados.
// Nunca enviar WorkOrderRow ao cliente, à IA, ao histórico ou a um evento.
import { ApiError, type Actor } from "../../types";
import { rolesOf } from "../../access";
import { canProfile } from "../../security";
import type { ModuleContext } from "../api";
import type { ChildRecord, Order, PrivateFields } from "./contracts";
import type { AuthorizedOrder } from "./public";
import { orderView, visibleOrder } from "./store";

/** M: projeção baseada no snapshot e nos campos extras autorizados. */
export function projectOrderForStaff(
  ctx: ModuleContext,
  actor: Actor,
  order: AuthorizedOrder,
): Order {
  if (order.type.kind !== "builtin")
    throw new ApiError(
      501,
      "not_implemented",
      "Tarefa M: projeção de ordem personalizada.",
    );
  const { row, type } = order;
  const legacy = visibleOrder(ctx, actor, orderView(row));
  return {
    ...legacy,
    type_id: type.id,
    type_revision: type.revision,
    type_number: row.type_number ?? row.number,
    type_label: type.labels.singular,
    type_plural_label: type.labels.plural,
    display_number: String(row.number),
    stage: row.status,
    stage_label: legacy.status_label,
    labels: { ...type.labels },
    fields: [],
    extra: {},
    version: row.row_version ?? 1,
    next_stages: type.transitions
      .filter((t) => t.from === row.status)
      .map((t) => ({
        transition_id: t.id,
        stage: t.to,
        stage_label: type.stages.find((s) => s.id === t.to)!.label,
        base_status: type.stages.find((s) => s.id === t.to)!.base_status,
        kind: t.kind,
      })),
    stage_approval: null,
  };
}

/** M: filtrar extras client_visible; caller usa authorizedOrder com conversation_id. */
export function projectOrderForCustomer(
  ctx: ModuleContext,
  actor: Actor,
  order: AuthorizedOrder,
): Order {
  const view = projectOrderForStaff(ctx, actor, order);
  delete view.notes;
  delete view.created_by;
  delete view.assignee;
  delete view.history;
  view.customer = { name: view.customer.name };
  if (view.decision) view.decision = { ...view.decision, by: "customer" };
  return view;
}

/** M: extras e filhos públicos. Nunca depender de via.masked para sigilo. */
export function projectOrderForBot(
  ctx: ModuleContext,
  actor: Actor,
  order: AuthorizedOrder,
): Order {
  return projectOrderForCustomer(ctx, actor, order);
}

/** M: reutilizar esta barreira também nos manipuladores de escrita privados. */
export async function mayReadSensitive(
  ctx: ModuleContext,
  actor: Actor,
): Promise<boolean> {
  return (
    actor.kind === "user" &&
    !actor.id.startsWith("bot:") &&
    !actor.via &&
    !actor.module &&
    !actor.credential &&
    canProfile(actor, ctx.profile) &&
    rolesOf(actor).includes("os:sensitive")
  );
}

/** M: buscar apenas os valores sensíveis autorizados, fora da resposta comum. */
export async function projectPrivateFields(
  ctx: ModuleContext,
  actor: Actor,
  order: AuthorizedOrder,
): Promise<PrivateFields> {
  if (!(await mayReadSensitive(ctx, actor)))
    throw new ApiError(
      403,
      "sensitive_forbidden",
      "Acesso sensível não autorizado.",
    );
  if (order.type.kind !== "builtin")
    throw new ApiError(
      501,
      "not_implemented",
      "Tarefa M: projeção de campos privados.",
    );
  return { id: order.row.id, version: order.row.row_version ?? 1, extra: {} };
}

/** M: manter esta barreira; cada filho monta primeiro seu DTO sem colunas internas. */
export async function projectChildForStaff<T extends ChildRecord>(
  ctx: ModuleContext,
  actor: Actor,
  child: T,
): Promise<T | null> {
  if (child.sensitive && !(await mayReadSensitive(ctx, actor))) return null;
  const out = { ...child };
  // Campos de contatos e notas também respeitam os escopos legados.
  if (!ctx.mayRead(actor, "contacts")) {
    delete (out as Record<string, unknown>).phone;
    delete (out as Record<string, unknown>).email;
    delete (out as Record<string, unknown>).contact_id;
  }
  if (!ctx.mayRead(actor, "notes"))
    delete (out as Record<string, unknown>).note;
  return out;
}

/** M: manter classificação independente dos nomes dos campos e do modo do bot. */
export function projectChildForCustomer<T extends ChildRecord>(
  child: T,
): T | null {
  if (child.sensitive || !child.client_visible) return null;
  const out = { ...child };
  delete out.created_by;
  return out;
}

/** M: completar projeções específicas sem liberar conteúdo sensível para via. */
export function projectChildForBot<T extends ChildRecord>(child: T): T | null {
  const out = projectChildForCustomer(child);
  if (out)
    for (const key of ["phone", "email", "contact_id", "note"])
      delete (out as Record<string, unknown>)[key];
  return out;
}
