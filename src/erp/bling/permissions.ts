/** Autorização da operação usa somente identidade comprovada e política da área. */
import { readErpPartsSnapshot } from "../parts.ts";
import {
  BLING_ENTITIES, BLING_ERROR_CODES, BlingError,
  type BlingContext, type BlingOperationMap, type BlingOperationName,
  type BlingPublicConfiguration, type BlingRecordView, type Sha256,
} from "./contracts.ts";
import { accessPolicySchema, authorizeBlingOperation, BLING_OPERATIONS, BlingAuthorizationContextSchema } from "./schema.ts";

/** Reconstrói a falha local; nem message/stack de uma porta são públicos. */
export function sanitizeBlingError(error: unknown): BlingError {
  try {
    if (error instanceof BlingError && BLING_ERROR_CODES.includes(error.code)) {
      return new BlingError(error.code, {
        status: [403, 409, 503].includes(error.status) ? error.status : undefined,
        retry_at: error.retry_at,
      });
    }
  } catch { /* Uma exceção de porta pode inclusive conter getters hostis. */ }
  return new BlingError("BLING_RESPONSE_INVALID", { status: 503 });
}

export function assertBlingIdentity(ctx: BlingContext): void {
  const actor = ctx.identity.actor;
  if (ctx.origin !== "app" || !actor?.erp_role || !actor.session_id ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(ctx.profile) ||
      ctx.identity.partsControl?.profile !== ctx.profile) throw new BlingError("BLING_ADMIN_REQUIRED");
  const snapshot = readErpPartsSnapshot({ ...ctx.identity.partsControl, parts: ctx.identity.parts }, ctx.profile, ctx.clock.now());
  if (!snapshot) throw new BlingError("BLING_DISABLED", { status: 503 });
  if (!snapshot.parts.customers) throw new BlingError("BLING_DISABLED", { status: 409 });
}

/** Retorna a interseção efetiva; passe esse contexto também às portas privadas.
 * read_granted recebido do núcleo não substitui a concessão persistida da área.
 */
export function authorizeOperation<K extends BlingOperationName>(
  ctx: BlingContext, name: K, input: BlingOperationMap[K]["input"],
  configuration: BlingPublicConfiguration, requestHash: Sha256,
): BlingContext {
  assertBlingIdentity(ctx);
  const definition = BLING_OPERATIONS[name];
  if (!definition || !/^[a-f0-9]{64}$/.test(requestHash)) throw new BlingError("BLING_RESPONSE_INVALID");
  const parsed = BlingAuthorizationContextSchema.safeParse(ctx.authorization ?? {});
  const policy = accessPolicySchema.safeParse(configuration.access);
  if (!parsed.success || !policy.success) throw new BlingError("BLING_SCOPE_REQUIRED");
  const actor = ctx.identity.actor!;
  const authorization = parsed.data;
  if (authorization.request_hash && authorization.request_hash !== requestHash) throw new BlingError("BLING_COMMAND_CONFLICT");
  const effective: BlingContext = { ...ctx, authorization: {
    ...authorization, request_hash: requestHash,
    read_granted: actor.erp_role === "admin" || policy.data.reader_user_ids.includes(actor.user_id),
  } };
  if (actor.is_agent) {
    const envelope = authorization.bot;
    const policies = policy.data.bots.filter(bot => bot.bot_id === envelope?.id);
    if (!envelope || policies.length !== 1) throw new BlingError("BLING_SCOPE_REQUIRED");
    const saved = policies[0];
    const bot = {
      id: envelope.id,
      allowed_operations: envelope.allowed_operations.filter(operation => saved.operations.includes(operation)),
      allowed_entities: envelope.allowed_entities.filter(entity => saved.entities.includes(entity)),
      data_scopes: envelope.data_scopes.filter(scope => saved.data_scopes.includes(scope)),
      allow_sensitive: envelope.allow_sensitive && saved.allow_sensitive,
    };
    effective.authorization!.bot = bot;
    if (!bot.allowed_operations.includes(name)) throw new BlingError("BLING_SCOPE_REQUIRED");
    // Documento XML contém dados pessoais e conteúdo sensível sem projeção por
    // campo. A mesma operação fica disponível com liberação explícita de ambos.
    if ((name === "erp_bling_xml_get" || name === "erp_bling_xml_list") &&
        (saved.mask_personal || !bot.data_scopes.includes("personal") || !bot.data_scopes.includes("sensitive"))) {
      throw new BlingError("BLING_SCOPE_REQUIRED");
    }
    if (name === "erp_bling_purge_preview" || name === "erp_bling_purge_apply") {
      const scope = (input as BlingOperationMap["erp_bling_purge_preview"]["input"]).scope;
      if ((scope.all ? BLING_ENTITIES : scope.entities).some(entity => !bot.allowed_entities.includes(entity))) throw new BlingError("BLING_SCOPE_REQUIRED");
    }
  }
  if (name !== "erp_bling_oauth_callback") {
    authorizeBlingOperation(effective, name, input);
  } else {
    // O callback é operação pública separada. Sua prova de estado/navegador,
    // sessão, revisão e uso único é obrigatoriamente revalidada na porta OAuth.
    if (actor.erp_role !== "admin") throw new BlingError("BLING_ADMIN_REQUIRED");
    if (actor.is_agent && !effective.authorization!.bot!.allow_sensitive) {
      const confirmation = authorization.confirmation;
      if (!confirmation || confirmation.operation !== name || confirmation.command_id !== requestHash ||
          confirmation.request_hash !== requestHash || confirmation.confirmed_by !== actor.user_id ||
          confirmation.expires_at <= ctx.clock.now()) throw new BlingError("BLING_SCOPE_REQUIRED");
    }
  }
  return effective;
}

export function authorizeCallbackOperation(
  ctx: BlingContext, input: BlingOperationMap["erp_bling_oauth_callback"]["input"],
  configuration: BlingPublicConfiguration, requestHash: Sha256,
): BlingContext {
  return authorizeOperation(ctx, "erp_bling_oauth_callback", input, configuration, requestHash);
}

/** Sem classificação de campos comprovada, ocultar todo o conteúdo é a única
 * projeção conservadora. A autorização completa entrega o dado integral.
 * Nunca reserializa números do bruto para tentar mascarar campos por heurística.
 */
export function protectOperationOutput<K extends BlingOperationName>(
  ctx: BlingContext, name: K, output: BlingOperationMap[K]["output"], configuration: BlingPublicConfiguration,
): BlingOperationMap[K]["output"] {
  if (!ctx.identity.actor?.is_agent) return output;
  const bot = ctx.authorization?.bot;
  const policy = configuration.access.bots.find(item => item.bot_id === bot?.id);
  const full = !!bot && !!policy && !policy.mask_personal &&
    bot.data_scopes.includes("personal") && bot.data_scopes.includes("sensitive") &&
    policy.data_scopes.includes("personal") && policy.data_scopes.includes("sensitive");
  if (name === "erp_bling_command_get" && (!full || BLING_ENTITIES.some(entity => !bot?.allowed_entities.includes(entity) || !policy?.entities.includes(entity)))) {
    // O recibo pode referenciar várias entidades; A10 não classifica cada
    // campo para comprovar um escopo menor. A fase continua consultável.
    const command = output as BlingOperationMap["erp_bling_command_get"]["output"];
    return { ...command, receipt: command.receipt ? { ...command.receipt, references: {} } : null } as BlingOperationMap[K]["output"];
  }
  if (full) return output;
  if (name === "erp_bling_record_get") {
    const view = output as BlingRecordView;
    return {
      raw: { ...view.raw, payload_text: "{}", document_links: [], deletion_evidence: view.raw.deleted ? "Evidência ocultada pela política de IA." : null, capture: null },
      metadata: view.metadata,
      historical: { ...view.historical, fields: { masked: true, notice: "Conteúdo ocultado pela política de dados pessoais e sensíveis da IA." },
        unresolved_references: [], unmapped_fields: [], coverage: { ...view.historical.coverage,
          limitations: ["Conteúdo ocultado pela política de dados pessoais e sensíveis da IA."] } },
      existing_links: [],
    } as BlingOperationMap[K]["output"];
  }
  if (name === "erp_bling_status") {
    const status = output as BlingOperationMap["erp_bling_status"]["output"];
    return { ...status, configuration: { ...status.configuration,
      account: status.configuration.account ? { ...status.configuration.account, name: null } : null,
      approval: status.configuration.approval ? { ...status.configuration.approval, approved_by: "masked" } : null,
      access: { reader_user_ids: [], bots: [], customer_delivery: { enabled: false, entities: [], require_verified_identity: true } },
    } } as BlingOperationMap[K]["output"];
  }
  return output;
}
