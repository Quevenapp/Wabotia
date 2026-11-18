// F0: API interna congelada. M completa snapshots, campos e commitChild.
// Filhos importam este arquivo, nunca store.ts/model.ts para autorizar ordens.
import { ApiError, type Actor } from "../../types";
import { isBound } from "../../visibility";
import type { ModuleContext } from "../api";
import {
  BUILTIN_WORK_TYPE,
  type ChildKind,
  type MutationRef,
  type WorkTypeSnapshot,
  type WorkTypeView,
} from "./contracts";
import {
  MANUAL_TRANSITIONS,
  OS_STATUSES,
  QUOTABLE,
  STATUS_LABELS,
  osSettings,
  phoneDigits,
} from "./model";
import { loadOrder } from "./store";

export interface WorkOrderRow {
  id: string;
  profile_id: string;
  number: number;
  status: import("./contracts").BaseStatus;
  conversation_id: string | null;
  phone: string;
  type_id?: string;
  type_snapshot_json?: string | null;
  stage?: string | null;
  type_number?: number | null;
  row_version?: number;
  extra_json?: string;
  // Colunas legadas e futuras: somente uso interno, nunca serializar a linha.
  [column: string]: unknown;
}
export interface AuthorizedOrder {
  row: WorkOrderRow;
  type: WorkTypeView;
}
export interface OrderAccess {
  write?: boolean;
  /** Obrigatório para contexto cliente; validado por ctx.conversation. */
  conversation_id?: string;
}
export type ChildStatement = [sql: string, bindings: unknown[]];
export interface ChildMutation {
  entity_kind: ChildKind;
  id: string;
  /** null cria; número altera por CAS. Versão do pai não é exigida. */
  expected_version: number | null;
  /** Estável entre repetições, derivada de requestId + entidade + operação. */
  mutation_key: string;
  changed_fields: string[];
  /** SQL do filho; incluir profile_id, order_id e versão nas condições. */
  statements: ChildStatement[];
  /** Só código: o núcleo publica IDs/versão, nunca o conteúdo do filho. */
  event: string;
}

/** M: resolver tipos personalizados validados e snapshots imutáveis. */
export async function resolveWorkType(
  ctx: ModuleContext,
  typeId = "service_order",
  snapshot?: WorkTypeSnapshot | null,
): Promise<WorkTypeView> {
  if (typeId !== "service_order" || snapshot)
    throw new ApiError(
      501,
      "not_implemented",
      "Tarefa M: resolução de tipos personalizados e snapshots.",
    );
  const cfg = osSettings(await ctx.settings());
  return {
    ...BUILTIN_WORK_TYPE,
    archived: false,
    labels: {
      singular: "Ordem de serviço",
      plural: "Ordens de serviço",
      item: "Item",
      problem: "Problema",
      customer_singular: "Cliente",
      customer_plural: "Clientes",
    },
    number_prefix: "",
    terms: cfg.terms,
    fields: [],
    retired_field_ids: [],
    retired_stage_ids: [],
    initial_stage: "received",
    stages: OS_STATUSES.map((status) => ({
      id: status,
      label: STATUS_LABELS[status],
      base_status: status,
      message:
        status === "received"
          ? cfg.texts.opened
          : (cfg.texts[status as keyof typeof cfg.texts] ?? ""),
    })),
    transitions: OS_STATUSES.flatMap((from) =>
      MANUAL_TRANSITIONS[from].map((to) => ({
        id: `${from}_${to}`,
        from,
        to,
        label: STATUS_LABELS[to],
        kind: "manual" as const,
      })),
    ),
    features: {
      customer_open: true,
      tasks: false,
      people: false,
      documents: false,
      entries: false,
      quote: {
        default_valid_days: cfg.quote_valid_days,
        source_stages: [...QUOTABLE],
        sent_stage: "quoted",
        approved_stage: "approved",
        declined_stage: "declined",
        edited_stage: "analyzing",
      },
      warranty_days: cfg.warranty_days,
      pickup_reminder_days: cfg.pickup_reminder_days,
      stale_days: cfg.stale_days,
    },
    pickup_reminder_text: cfg.texts.pickup_reminder,
  };
}

/** M: ler e validar snapshot da linha personalizada; autorização já é efetiva. */
export async function authorizedOrder(
  ctx: ModuleContext,
  actor: Actor,
  id: string,
  access: OrderAccess = {},
): Promise<AuthorizedOrder> {
  ctx.access(
    actor,
    access.write ? "conversations:write" : "conversations:read",
  );
  await ctx.requireEnabled();
  if (actor.credential || (isBound(actor) && !access.conversation_id))
    throw new ApiError(404, "not_found", "Ordem de serviço não encontrada.");
  const row = (await loadOrder(ctx, id)) as WorkOrderRow;
  if (access.conversation_id) {
    const c = await ctx.conversation(access.conversation_id, actor);
    const phone = phoneDigits(ctx.verifiedPhone(c) || "");
    if (
      c.profile_id !== ctx.profile ||
      (row.conversation_id !== c.id && (!phone || row.phone !== phone))
    )
      throw new ApiError(404, "not_found", "Ordem de serviço não encontrada.");
  }
  if (row.type_snapshot_json)
    throw new ApiError(
      501,
      "not_implemented",
      "Tarefa M: leitura do snapshot da ordem.",
    );
  return { row, type: await resolveWorkType(ctx, row.type_id) };
}

/** M: CAS do filho + histórico + atividade do pai em lote, replay e publicação recuperável. */
export async function commitChild(
  _ctx: ModuleContext,
  _actor: Actor,
  _order: AuthorizedOrder,
  _mutation: ChildMutation,
): Promise<MutationRef> {
  // Não executar SQL parcialmente antes de 0100 e da implementação de M.
  throw new ApiError(
    501,
    "not_implemented",
    "Tarefa M: commitChild (versão, histórico, atividade e publicação idempotente).",
  );
}
