// Projeções por audiência, com classificação independente do modo do bot.
// Nunca enviar WorkOrderRow ao cliente, à IA, ao histórico ou a um evento.
import { ApiError, json, type Actor } from "../../types";
import { rolesOf } from "../../access";
import { canProfile } from "../../security";
import type { ModuleContext } from "../api";
import type { ChildRecord, Order, PrivateFields, ServiceObjectSnapshotView } from "./contracts";
import type { AuthorizedOrder } from "./public";
import { orderView, visibleOrder } from "./store";
import { workOrderAdditions } from "./work-types";
import { projectObjectSnapshot } from "./os2-ports";

/** Projeção baseada no snapshot e nos campos extras autorizados. */
export function projectOrderForStaff(
  ctx: ModuleContext,
  actor: Actor,
  order: AuthorizedOrder,
): Order {
  const view = visibleOrder(ctx, actor, {
    ...orderView(order.row), ...workOrderAdditions(order.row, order.type),
  });
  if (ctx.mayRead(actor, "contacts")) {
    const object = projectObjectSnapshot(order.row, { kind: "staff" });
    if (object) view.object = object;
  }
  return actor.via || actor.id.startsWith("bot:") || actor.module
    ? customerProjection(view) : view;
}

/** O chamador autoriza a conversa antes de projetar os campos públicos. */
export function projectOrderForCustomer(
  ctx: ModuleContext,
  actor: Actor,
  order: AuthorizedOrder,
): Order {
  return customerProjection(projectOrderForStaff(ctx, actor, order));
}

/** Extras e filhos públicos. Nunca depender de via.masked para sigilo. */
export function projectOrderForBot(
  ctx: ModuleContext,
  actor: Actor,
  order: AuthorizedOrder,
): Order {
  return projectOrderForCustomer(ctx, actor, order);
}

/** Barreira compartilhada pelas leituras e escritas privadas. */
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

/** Valores sensíveis autorizados, exclusivamente fora da resposta comum. */
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
  const values = json(order.row.extra_json, {});
  return { id: order.row.id, version: order.row.row_version ?? 1,
    fields: order.type.fields.filter(f => f.sensitive),
    extra: Object.fromEntries(order.type.fields.filter(f => f.sensitive && Object.hasOwn(values, f.id)).map(f => [f.id, values[f.id]])) };
}

/** Cada filho monta primeiro seu DTO sem colunas internas. */
export async function projectChildForStaff<T extends ChildRecord>(
  ctx: ModuleContext,
  actor: Actor,
  child: T,
): Promise<T | null> {
  if (actor.via || actor.id.startsWith("bot:") || actor.module) return projectChildForBot(child);
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

/** Classificação independente dos nomes dos campos e do modo do bot. */
export function projectChildForCustomer<T extends ChildRecord>(
  child: T,
): T | null {
  if (child.sensitive || !child.client_visible) return null;
  const out = { ...child };
  delete out.created_by;
  return out;
}

/** Projeção de filhos para bot, inclusive atuação via pessoa. */
export function projectChildForBot<T extends ChildRecord>(child: T): T | null {
  const out = projectChildForCustomer(child);
  if (out)
    for (const key of ["phone", "email", "contact_id", "note"])
      delete (out as Record<string, unknown>)[key];
  return out;
}

/** Também usada pelas rotas legadas ampliadas e pelas ferramentas de conversa. */
export function customerProjection<T extends Order>(input: T): T {
  const view = { ...input, customer: { name: input.customer.name } };
  delete view.notes;
  delete view.created_by;
  delete view.assignee;
  delete view.history;
  delete view.features;
  delete view.next_task;
  view.fields = input.fields.filter(f => f.client_visible && !f.sensitive);
  view.extra = Object.fromEntries(view.fields.filter(f => Object.hasOwn(input.extra, f.id)).map(f => [f.id, input.extra[f.id]]));
  if (input.object) view.object = projectObjectViewForCustomer(input.object);
  view.next_stages = [];
  view.next_statuses = [];
  if (view.decision) view.decision = { ...view.decision, by: "customer" };
  if (view.stage_approval) view.stage_approval = { ...view.stage_approval, decided_by: view.stage_approval.decided_by ? "customer" : null };
  return view;
}

/** Reprojeta somente um DTO autorizado; não acessa o cadastro atual do objeto. */
export function projectObjectViewForCustomer(input: ServiceObjectSnapshotView): ServiceObjectSnapshotView {
  const fields = input.type.fields.filter(field => field.client_visible && !field.sensitive);
  const identifierField = fields.find(field => field.id === input.type.identifier_field_id);
  return {
    schema_version: 1,
    object_id: input.object_id,
    object_version: input.object_version,
    captured_at: input.captured_at,
    origin: input.origin,
    type: {
      schema_version: 1, id: input.type.id, revision: input.type.revision,
      labels: { singular: input.type.labels.singular, plural: input.type.labels.plural },
      fields: structuredClone(fields),
      ...(identifierField ? { identifier_field_id: identifierField.id } : {}),
    },
    values: Object.fromEntries(fields.filter(field => Object.hasOwn(input.values, field.id)).map(field => [field.id, input.values[field.id]])),
    identifier: identifierField ? input.identifier : `${input.type.labels.singular} · ${input.object_id.slice(-6).toUpperCase()}`,
  };
}
