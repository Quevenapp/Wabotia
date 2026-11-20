// API interna do motor: autorização, snapshots e persistência dos filhos.
// Filhos importam este arquivo, nunca store.ts/model.ts para autorizar ordens.
import { one } from "../../db";
import { ApiError, type Actor, type Conversation } from "../../types";
import { resolveCustomer } from "../../customer/ports";
import { routineCustomerScope } from "../agenda/customer-provider";
import { normalizeCustomerPhone } from "../../customer/phone";
import { verifiedPhone } from "../../protocol-lookup";
import { isBound } from "../../visibility";
import type { ModuleContext } from "../api";
import type { ChildKind, MutationRef, WorkTypeSnapshot, WorkTypeView } from "./contracts";
import { loadOrder } from "./store";
import { builtinWorkType, makeSnapshot, snapshotType } from "./work-types";
import { validateWorkType } from "./validation";
import { commitChildMutation } from "./mutations";

export interface WorkOrderRow {
  id: string;
  profile_id: string;
  number: number;
  status: import("./contracts").BaseStatus;
  conversation_id: string | null;
  contact_id?: string | null;
  phone: string;
  type_id?: string;
  type_snapshot_json?: string | null;
  stage?: string | null;
  type_number?: number | null;
  row_version?: number;
  extra_json?: string;
  object_id?: string | null;
  object_snapshot_json?: string | null;
  stage_required_json?: string;
  // Colunas legadas e futuras: somente uso interno, nunca serializar a linha.
  [column: string]: unknown;
}
/** Linha de persistência interna; projetar explicitamente antes de devolver. */
export interface ServiceObjectRow {
  id: string;
  profile_id: string;
  contact_id: string;
  type_id: string;
  type_revision: number;
  type_snapshot_json: string;
  values_json: string;
  archived: 0 | 1;
  row_version: number;
  created_by: string;
  updated_by: string;
  created: number;
  updated: number;
}
export interface AuthorizedOrder {
  row: WorkOrderRow;
  type: WorkTypeView;
}
export interface OrderAccess {
  write?: boolean;
  /** Obrigatório para contexto cliente; validado por ctx.conversation. */
  conversation_id?: string;
  /** Documentos mantêm a conferência telefônica do destinatário. */
  recipient?: boolean;
}

/** O vínculo amplia o cadastro; a credencial telefônica vem somente do canal. */
export async function workCustomerScope(ctx: ModuleContext, c: Conversation) {
  if (c.profile_id !== ctx.profile || c.chat_type === "group")
    return { sql: "0", params: [] as unknown[], contactId: null, verified: false };
  const scope = await routineCustomerScope({ ...ctx, verifiedPhone: ctx.verifiedPhone ?? verifiedPhone, customer: ctx.customer ?? (c => resolveCustomer(ctx.env, c)) }, c, "phone", "os");
  if (["blocked", "excluded", "ambiguous"].includes(scope.ref.state))
    return { sql: "0", params: [] as unknown[], contactId: null, verified: false };
  return { ...scope, contactId: scope.ref.state === "ready" ? scope.ref.contactId : null,
    verified: scope.ref.namespace === "team" && !!(ctx.verifiedPhone ? ctx.verifiedPhone(c) : verifiedPhone(c)) };
}

/** Toda ação e repetição revalida o proprietário, inclusive em outra linha. */
export async function workCustomerAllows(
  ctx: ModuleContext, c: Conversation, row: WorkOrderRow, recipient: boolean | "notice" = false,
) {
  if (row.profile_id !== ctx.profile) return false;
  const scope = await workCustomerScope(ctx, c);
  if (scope.sql === "0") return false;
  const phone = ctx.verifiedPhone ? ctx.verifiedPhone(c) : verifiedPhone(c);
  // Antes do cadastro único, documentos de uma OS sem titular persistido
  // acompanhavam o telefone corrigido pela equipe. Preserve essa autorização
  // estreita, sem substituir um proprietário já gravado pela fase 1.
  const legacyDocument = recipient === true && phone && scope.verified;
  const saved = await one<WorkOrderRow>(ctx.env,
    `SELECT contact_id,conversation_id,phone FROM os_orders WHERE profile_id=? AND id=? AND (${scope.sql}
      ${legacyDocument ? `OR (contact_id IS NULL AND phone=? AND NOT EXISTS(SELECT 1 FROM customer_records r
        WHERE r.profile_id=os_orders.profile_id AND r.module_id='os' AND r.record_id=os_orders.id))` : ""})`,
    ctx.profile, row.id, ...scope.params, ...(legacyDocument ? [phone] : []));
  if (!saved) return false;
  if (!recipient) return true;
  if (!phone || !scope.verified) return false;
  // O telefone informado na ordem é um snapshot administrativo. A conversa
  // persistida continua destinatária quando seu titular comprovado é o dono
  // da ordem, mesmo que esse snapshot tenha outro telefone.
  if (recipient === "notice" && scope.contactId && saved.contact_id === scope.contactId && saved.conversation_id === c.id) return true;
  const snapshot = normalizeCustomerPhone(saved.phone, "international");
  if (snapshot === phone) return true;
  if (recipient === true) return false;
  // Outro número só é destinatário se os dois vínculos persistidos concordam.
  return !!scope.contactId && !!await one(ctx.env,
    `SELECT 1 FROM customer_phones WHERE profile_id=? AND namespace='team'
      AND phone=? AND state='ready' AND contact_id=?`, ctx.profile, snapshot, scope.contactId);
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

/** Resolve configuração atual ou a definição fixada na abertura. */
export async function resolveWorkType(
  ctx: ModuleContext,
  typeId = "service_order",
  snapshot?: WorkTypeSnapshot | null,
): Promise<WorkTypeView> {
  if (snapshot) {
    const fixed = makeSnapshot(snapshot.type);
    if (snapshot.schema_version !== 1 || fixed.type.id !== typeId)
      throw new ApiError(409, "invalid_snapshot", "Definição da ordem inválida.");
    return fixed.type;
  }
  const settings = await ctx.settings();
  if (typeId === "service_order") return builtinWorkType(settings);
  const type = settings.os_work_types?.find((t: WorkTypeView) => t.id === typeId);
  if (!type) throw new ApiError(404, "type_not_found", "Tipo de trabalho não encontrado.");
  return validateWorkType(type);
}

/** Autoriza área, módulo e titular antes de resolver a definição da ordem. */
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
    if (!(await workCustomerAllows(ctx, c, row, access.recipient)))
      throw new ApiError(404, "not_found", "Ordem de serviço não encontrada.");
  }
  const type = snapshotType(row);
  return { row, type: type ?? await resolveWorkType(ctx, row.type_id) };
}

/** Confirma filho, histórico e atividade; retoma publicações em repetições. */
export async function commitChild(
  ctx: ModuleContext,
  actor: Actor,
  order: AuthorizedOrder,
  mutation: ChildMutation,
): Promise<MutationRef> {
  return commitChildMutation(ctx, actor, order, mutation);
}
