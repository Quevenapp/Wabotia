import { one } from "../../../db";
import { ApiError, type Actor } from "../../../types";
import { isBound } from "../../../visibility";
import type { ModuleContext } from "../../api";
import type { FieldIndexRebuildRequest } from "../contracts";
import type { Os2Adapters, Os2ReadOperation, Os2CommandOperation } from "../os2-ports";
import { authorizedOrder } from "../public";
import { readFieldIndexState, rebuildFieldIndex } from "./index-store";
import { orderRequirements } from "./requirements";

export const fieldRulesReadOperations: readonly Os2ReadOperation[] = ["os.requirements", "os.field_index.get"];
export const fieldRulesCommandOperations: readonly Os2CommandOperation[] = ["os.field_index.rebuild"];
const missing = (): never => { throw new ApiError(404, "not_found", "Registro não encontrado."); };
const unsupported = (): never => { throw new ApiError(501, "not_implemented", "Operação não atendida pelo adaptador de requisitos e filtros."); };

async function indexAdministrator(ctx: ModuleContext, actor: Actor, write = false) {
  ctx.access(actor, write ? "conversations:write" : "conversations:read");
  await ctx.requireEnabled();
  // Usa a mesma autoridade administrativa da configuração de modelos.
  // Via bot é permitido quando o administrador habilitou a IA; não há veto
  // fixo por nome de ator. A conversa de cliente não concede administração.
  if (actor.role !== "admin") throw new ApiError(403, "admin_required", "Somente administradores.");
  if (actor.credential || isBound(actor)) missing();
  if ((actor.via || actor.id.startsWith("bot:") || actor.module) && !(await ctx.settings()).os2_ai_access?.enabled)
    throw new ApiError(403, "forbidden", "O administrador precisa habilitar o acesso da IA a estes dados.");
}

/** Delegação das operações estáveis já registradas e descritas no OpenAPI da base. */
export const fieldRulesRead: Os2Adapters["read"] = async (ctx, actor, operation, input) => {
  if (operation === "os.field_index.get") {
    await indexAdministrator(ctx, actor);
    if (Object.keys(input.query).length) throw new ApiError(400, "invalid_fields", "A consulta de progresso não aceita filtros.");
    return readFieldIndexState(ctx, input.params.type_id);
  }
  if (operation !== "os.requirements") return unsupported();
  if (Object.keys(input.query).some(key => !["transition_id", "conversation_id"].includes(key)))
    throw new ApiError(400, "invalid_fields", "Consulta de requisitos inválida.");
  const order = await authorizedOrder(ctx, actor, input.params.id,
    input.query.conversation_id ? { conversation_id: input.query.conversation_id } : {});
  if (order.row.object_id) {
    if (!ctx.mayRead(actor, "contacts") || !order.row.contact_id) missing();
    const contact = await one(ctx.env, "SELECT 1 FROM contacts WHERE profile_id=? AND id=? AND namespace='team' AND identity_state='active'",
      ctx.profile, order.row.contact_id);
    if (!contact) missing();
  }
  return orderRequirements(ctx, actor, order, input.query.transition_id, { customer: isBound(actor) });
};

export const fieldRulesCommand: Os2Adapters["command"] = async (ctx, actor, operation, data, meta) => {
  if (operation !== "os.field_index.rebuild") return unsupported();
  await indexAdministrator(ctx, actor, true);
  if (!meta.requestId || meta.requestId.length > 200 || typeof data.type_id !== "string" ||
      Object.keys(data).some(key => !["type_id", "generation", "cursor_number"].includes(key)) ||
      (data.generation !== undefined && (typeof data.generation !== "string" || !/^[a-f0-9]{64}$/.test(data.generation))) ||
      (data.cursor_number !== undefined && (!Number.isSafeInteger(data.cursor_number) || Number(data.cursor_number) < 0)))
    throw new ApiError(400, "invalid_fields", "Informe a geração e a posição observadas para retomar a construção.");
  // O Coordinator guarda o recibo do comando (ator/operação/chave/conteúdo).
  // O CAS do cursor torna segura também a retomada após falha de resposta.
  const request: FieldIndexRebuildRequest = {
    ...(data.generation === undefined ? {} : { generation: data.generation as string }),
    ...(data.cursor_number === undefined ? {} : { cursor_number: data.cursor_number as number }),
  };
  return rebuildFieldIndex(ctx, data.type_id, request);
};
