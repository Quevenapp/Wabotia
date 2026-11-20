/** Controle local do recebimento. Todas as mutações são síncronas e atômicas;
 * transporte, cofre e acervo entram apenas pelas portas da API.
 */
import { one, type Row, type SqlDriver } from "../engine/driver.ts";
import { readErpPartsSnapshot } from "../parts.ts";
import {
  BLING_BUDGET, BLING_ERROR_CODES, BlingError, DEFAULT_BLING_ACCESS_POLICY,
  type BlingAdminResult, type BlingCommand, type BlingContext, type BlingCredentialPublic,
  type BlingErrorCode, type BlingExpectedState, type BlingOperationMap,
  type BlingOperationName, type BlingPublicConfiguration, type BlingReceipt,
  type BlingStatus, type BlingCheckpoint, type JsonObject, type ResourceDescriptor, type Sha256,
} from "./contracts.ts";
import { collectionFreshness } from "./planner.ts";
import { resourceVariants } from "./resources.ts";
import {
  credentialPublicSchema, metadataSchema, parseBlingOperationInput,
  publicConfigurationSchema, receiptSchema, resourceDescriptorSchema,
  sha256Schema, statusSchema, unitPhaseSchema,
} from "./schema.ts";

export interface BlingControlDependencies {
  /** Área da instância, escolhida pela montagem, nunca pelo corpo público. */
  profile: string;
  db: SqlDriver;
  databaseSize(): number;
  randomId(): string;
  resources?: readonly ResourceDescriptor[];
}
export interface BlingControlAudit {
  command_id?: string | null;
  before_revision?: string;
  counts?: Record<string, number>;
  references?: JsonObject;
  code?: BlingErrorCode | null;
}
type Details = Pick<BlingControlAudit, "counts" | "references">;
type DisconnectReservation = { expected: BlingExpectedState; receipt: BlingReceipt | null };

const json = (value: unknown): unknown => typeof value === "string" ? JSON.parse(value) : value;
const number = (value: unknown, fallback = 0): number => {
  const n = value === null || value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new BlingError("BLING_RESPONSE_INVALID");
  return n;
};
const revision = (value: unknown): string => String(number(value));
const iso = (value: unknown): string => new Date(number(value)).toISOString();
const bump = (value: unknown): string => {
  const next = number(value) + 1;
  if (!Number.isSafeInteger(next)) throw new BlingError("BLING_CAPACITY_STOP");
  return String(next);
};
const countValues = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(key)) throw new BlingError("BLING_RESPONSE_INVALID");
    result[key] = number(count);
  }
  if (!metadataSchema.safeParse(result).success) throw new BlingError("BLING_RESPONSE_INVALID");
  return result;
};

/** Uma seleção implementada localmente pode ser preparada; só a confirmação
 * oficial completa permite ligar ou pedir chamadas de dados.
 */
export function validateBlingSelections(configuration: Pick<BlingPublicConfiguration, "selections">, resources: readonly ResourceDescriptor[], official = false): ResourceDescriptor[] {
  const table = new Map<string, ResourceDescriptor>();
  for (const candidate of resources) {
    const parsed = resourceDescriptorSchema.safeParse(candidate);
    if (!parsed.success || table.has(candidate.key)) throw new BlingError("BLING_RESPONSE_INVALID");
    table.set(candidate.key, parsed.data);
  }
  const keys = new Set<string>();
  const selected: ResourceDescriptor[] = [];
  for (const selection of configuration.selections) {
    if (keys.has(selection.key)) throw new BlingError("BLING_RESPONSE_INVALID");
    keys.add(selection.key);
    const resource = table.get(selection.key);
    if (!resource) throw new BlingError("BLING_RESOURCE_UNCONFIRMED");
    if (!selection.selected) continue;
    if (resource.confirmation === "nao_confirmado" || !resource.path || !resource.pagination || !resource.dateFilter ||
        !resource.parser || resource.identityRule.kind === "unconfirmed" || official && resource.confirmation !== "oficial_confirmado")
      throw new BlingError("BLING_RESOURCE_UNCONFIRMED");
    selected.push(resource);
  }
  return selected;
}

export function createBlingControl(dependencies: BlingControlDependencies) {
  const { db } = dependencies;

  function context(ctx: BlingContext, administrative = false): void {
    const snapshot = readErpPartsSnapshot({ ...ctx.identity.partsControl, parts: ctx.identity.parts }, ctx.profile, ctx.clock.now());
    if (ctx.profile !== dependencies.profile) throw new BlingError("BLING_SCOPE_REQUIRED");
    if (!snapshot || !snapshot.parts.customers) throw new BlingError("BLING_DISABLED", { status: 409 });
    if (administrative && (ctx.origin !== "app" || ctx.identity.actor?.erp_role !== "admin" || !ctx.identity.actor.session_id && !(ctx.identity.actor.is_agent && ctx.authorization?.delegation && ctx.authorization.bot?.allow_sensitive)))
      throw new BlingError("BLING_ADMIN_REQUIRED");
  }

  function row(ctx: BlingContext): Row {
    context(ctx);
    return one(db, "SELECT * FROM wb_bling_control WHERE id=1") ?? {
      revision: 0, generation: 1, authorization_revision: 0, credential_revision: 0,
      collect_enabled: 0, state: "off", account_id: null, account_public: "{}", selection: "[]",
      permissions: "{}", approved_by: null, approved_at: null, approval_hash: null,
      app_configured: 0, credential_status: "missing", credential_expires_at: null,
      credential_scopes: "[]", daily_call_limit: BLING_BUDGET.daily_calls,
      min_interval_ms: BLING_BUDGET.min_interval_ms, next_allowed_at: null,
      archive_bytes: 0, xml_bytes: 0, observed_count: 0,
    };
  }

  function initialize(ctx: BlingContext): void {
    db.exec("INSERT INTO wb_bling_control(id,updated_at) VALUES(1,?) ON CONFLICT(id) DO NOTHING", ctx.clock.now());
  }

  function configuration(ctx: BlingContext, stored = row(ctx)): BlingPublicConfiguration {
    const permissions = json(stored.permissions);
    const account = json(stored.account_public) as Record<string, unknown>;
    const expires = stored.credential_expires_at === null ? null : number(stored.credential_expires_at);
    const parsed = publicConfigurationSchema.safeParse({
      revision: revision(stored.revision), generation: revision(stored.generation), authorization_revision: revision(stored.authorization_revision),
      collect_enabled: number(stored.collect_enabled) === 1,
      account: stored.account_id === null ? null : { id: stored.account_id, name: account.name ?? null, confirmed_at: account.confirmed_at ?? null },
      selections: json(stored.selection), daily_call_limit: number(stored.daily_call_limit), min_interval_ms: number(stored.min_interval_ms),
      access: permissions && typeof permissions === "object" && Object.keys(permissions).length ? permissions : DEFAULT_BLING_ACCESS_POLICY,
      approval: stored.approved_by === null ? null : { approved_at: iso(stored.approved_at), approved_by: stored.approved_by, checklist_hash: stored.approval_hash },
      credential: { configured: number(stored.app_configured) === 1, authorized: stored.credential_status === "ready" && (expires === null || expires > ctx.clock.now()),
        revision: revision(stored.credential_revision), expires_at: expires, scopes: json(stored.credential_scopes), uncertain: stored.credential_status === "uncertain" },
    });
    if (!parsed.success) throw new BlingError("BLING_RESPONSE_INVALID");
    return parsed.data;
  }

  function read(ctx: BlingContext): BlingStatus {
    return db.transaction(() => {
      const stored = row(ctx), config = configuration(ctx, stored);
      const occupancy = number(dependencies.databaseSize());
      // A consulta é limitada: não contar todo o acervo (nem toda a fila) a
      // cada ficha. Quando atingir o limite, declarar o total como mínimo.
      const pendingRows = db.exec(`SELECT id FROM wb_bling_unit WHERE generation=?
        AND phase IN ('queued','reserved','fetching','waiting','blocked') AND substr(kind,1,6)<>'oauth_'
        ORDER BY not_before,id LIMIT 1000`, config.generation).rows;
      const work = one(db, `SELECT not_before AS next_at FROM wb_bling_unit WHERE generation=?
        AND phase IN ('queued','reserved','fetching','waiting') AND substr(kind,1,6)<>'oauth_'
        ORDER BY not_before,id LIMIT 1`, config.generation);
      const error = one(db, "SELECT code FROM wb_bling_audit WHERE generation=? AND code IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1", config.generation);
      const errorCode = BLING_ERROR_CODES.includes(error?.code as BlingErrorCode) ? error!.code as BlingErrorCode : null;
      const pending = pendingRows.length;
      const lanes: { resource: ResourceDescriptor; checkpoint: BlingCheckpoint }[] = [];
      for (const selected of config.selections.filter(selection => selection.selected)) {
        if (!dependencies.resources?.some(resource => resource.key === selected.key)) continue;
        for (const resource of resourceVariants(selected.key, dependencies.resources)) {
          const saved = one(db, "SELECT checkpoint,checkpoint_version FROM origin_sync__resource_state WHERE resource=?", resource.key);
          const cursor = saved ? json(saved.checkpoint) as JsonObject : {};
          lanes.push({ resource, checkpoint: { revision: saved ? revision(saved.checkpoint_version) : "0", cursor,
            pass_started_at: typeof cursor.pass_started_at === "string" ? cursor.pass_started_at : null,
            pass_completed_at: typeof cursor.pass_completed_at === "string" ? cursor.pass_completed_at : null } });
        }
      }
      const completed = lanes.map(lane => lane.checkpoint.pass_completed_at).filter((value): value is string => value !== null).sort();
      const started = lanes.map(lane => lane.checkpoint.pass_started_at).filter((value): value is string => value !== null).sort();
      const countersKnown = lanes.length > 0 && lanes.every(lane => typeof lane.checkpoint.cursor.changed_count === "number");
      const nextAllowed = stored.next_allowed_at === null ? null : number(stored.next_allowed_at);
      let state = stored.state as BlingStatus["state"];
      if (state !== "purging") {
        if (!config.collect_enabled) state = "off";
        else if (occupancy >= BLING_BUDGET.database_ceiling_bytes * BLING_BUDGET.stop_ratio) state = "blocked_capacity";
        else if (!config.credential.authorized || !config.account?.confirmed_at) state = "needs_authorization";
        else if (nextAllowed !== null && nextAllowed > ctx.clock.now() && !["blocked_scope", "blocked_capacity", "waiting_retry"].includes(state)) state = "waiting_rate";
      }
      const nextWake = config.collect_enabled && work?.next_at !== null && work?.next_at !== undefined
        ? Math.max(number(work.next_at), nextAllowed ?? 0) : null;
      const admin = ctx.identity.actor?.erp_role === "admin";
      const value: BlingStatus = {
        state, configuration: config, next_wake: nextWake,
        progress: { calls_day: typeof stored.calls_day === "string" ? stored.calls_day : null, calls_today: stored.calls_today === undefined ? 0 : number(stored.calls_today),
          lanes: lanes.map(({ resource, checkpoint }) => ({ resource_key: resource.key, entity: resource.entity, checkpoint_revision: checkpoint.revision,
            observed: typeof checkpoint.cursor.observed_count === "number" ? number(checkpoint.cursor.observed_count) : null,
            changed: typeof checkpoint.cursor.changed_count === "number" ? number(checkpoint.cursor.changed_count) : null,
            pass_started_at: checkpoint.pass_started_at, pass_completed_at: checkpoint.pass_completed_at,
            freshness_at: collectionFreshness([{ resource, checkpoint }]), next_attempt_at: typeof checkpoint.cursor.not_before === "number" ? number(checkpoint.cursor.not_before) : null })) },
        capabilities: { configured: config.credential.configured, collect: admin && config.collect_enabled && config.credential.authorized && !!config.account?.confirmed_at && !["purging", "blocked_scope", "blocked_capacity"].includes(state), archive: true, xml: true, purge: admin && state !== "purging" },
        coverage: { complete: false, observed: number(stored.observed_count), changed: lanes.reduce((total, lane) => total + number(lane.checkpoint.cursor.changed_count ?? 0), 0), pending,
          last_pass_started_at: started[0] ?? null, last_pass_completed_at: completed.at(-1) ?? null, freshness_at: collectionFreshness(lanes),
          limitations: ["Uma passagem concluída não certifica a cobertura da conta.", ...(!countersKnown ? ["Pistas sem contadores têm alterações desconhecidas; zero agregado não comprova ausência de mudanças."] : []), "URLs de imagens e anexos são referências; seus bytes não estão arquivados.", "Crescimento diário e projeção de volume permanecem desconhecidos até haver amostras comparáveis suficientes.",
            ...(pending === 1000 ? ["A contagem de pendências informa pelo menos mil unidades; o total depende da reconciliação paginada."] : [])] },
        occupancy: { database_bytes: occupancy, archive_estimated_bytes: number(stored.archive_bytes), xml_bytes: number(stored.xml_bytes),
          ceiling_bytes: 10000000000, warning_ratio: 0.7, stop_ratio: 0.8, projected_bytes: null },
        last_error: errorCode ? new BlingError(errorCode, nextAllowed !== null && ["BLING_RATE_WAIT", "BLING_RETRY_WAIT"].includes(errorCode) ? { retry_at: nextAllowed } : {}).toJSON() : null,
      };
      if (!statusSchema.safeParse(value).success) throw new BlingError("BLING_RESPONSE_INVALID");
      return value;
    });
  }

  function readReceipt(stored: Row): BlingReceipt {
    const result = json(stored.result) as Record<string, unknown>;
    const code = stored.error_code === null ? null : stored.error_code as BlingErrorCode;
    if (code && !BLING_ERROR_CODES.includes(code)) throw new BlingError("BLING_RESPONSE_INVALID");
    const parsed = receiptSchema.safeParse({ command_id: stored.command_id, request_hash: stored.request_hash, generation: revision(stored.generation),
      operation: stored.operation, state: stored.state, committed_at: iso(stored.created_at), references: json(stored.references_json),
      counts: countValues(result.counts ?? {}), error: code ? new BlingError(code).toJSON() : null });
    if (!parsed.success) throw new BlingError("BLING_RESPONSE_INVALID");
    return parsed.data;
  }

  function receipt(ctx: BlingContext, commandId: string): BlingReceipt | null {
    context(ctx);
    const stored = one(db, "SELECT * FROM wb_bling_receipt WHERE command_id=?", commandId);
    return stored ? readReceipt(stored) : null;
  }

  function assertCommitted(prior: BlingReceipt, name: BlingOperationName, requestHash: Sha256, generation: string): BlingReceipt {
    if (prior.operation !== name || prior.request_hash !== requestHash) throw new BlingError("BLING_COMMAND_CONFLICT");
    // O apagamento aposenta a própria geração. Seu recibo terminal continua
    // recuperável pelo mesmo comando/hash; este ramo nunca reexecuta o efeito.
    const completedPurge = name === "erp_bling_purge_apply" && prior.state === "committed" && number(prior.generation) < number(generation);
    if (prior.generation !== generation && !completedPurge || prior.state === "superseded") throw new BlingError("BLING_GENERATION_RETIRED");
    if (prior.state === "rejected") throw new BlingError(prior.error?.code ?? "BLING_RESPONSE_INVALID", { retry_at: prior.error?.retry_at });
    return prior;
  }

  /** Recibo vem antes do CAS: repetir resposta perdida não reaplica efeitos. */
  function checkCommand(ctx: BlingContext, name: BlingOperationName, input: BlingCommand, requestHash: Sha256): BlingReceipt | null {
    context(ctx, true);
    if (!sha256Schema.safeParse(requestHash).success) throw new BlingError("BLING_RESPONSE_INVALID");
    const config = configuration(ctx);
    const prior = receipt(ctx, input.command_id);
    if (prior) return assertCommitted(prior, name, requestHash, config.generation);
    const pending = one(db, "SELECT * FROM wb_bling_unit WHERE command_id=?", input.command_id);
    if (pending) {
      const plan = json(pending.plan) as Record<string, unknown>;
      // Os corpos de autorizar/desligar são iguais: o hash sozinho não
      // identifica a operação. Unidades antigas só admitem estes dois
      // mapeamentos inequívocos; todas as demais exigem nome explícito.
      const pendingOperation = plan.operation ?? (pending.kind === "oauth_state" ? "erp_bling_oauth_start" : pending.kind === "purge" ? "erp_bling_purge_apply" : null);
      if (pending.request_hash !== requestHash || pendingOperation !== name) throw new BlingError("BLING_COMMAND_CONFLICT");
      const activePurge = name === "erp_bling_purge_apply" && pending.kind === "purge" && plan.next_generation === config.generation &&
        number(pending.generation) < number(config.generation);
      if (revision(pending.generation) !== config.generation && !activePurge) throw new BlingError("BLING_GENERATION_RETIRED");
      if (pending.phase === "superseded") throw new BlingError("BLING_LEASE_LOST");
      if (pending.phase === "committed") throw new BlingError("BLING_RESPONSE_INVALID");
      return null; // A reserva durável é revalidada pela porta dona antes do I/O.
    }
    if (input.expected_revision !== config.revision) throw new BlingError("BLING_REVISION_CONFLICT");
    if (row(ctx).state === "purging") throw new BlingError("BLING_GENERATION_RETIRED");
    return null;
  }

  function audit(ctx: BlingContext, operation: BlingOperationName, detail: BlingControlAudit = {}): void {
    context(ctx);
    const config = configuration(ctx), actor = ctx.identity.actor;
    if (!actor) throw new BlingError("BLING_ADMIN_REQUIRED");
    const references = metadataSchema.safeParse(detail.references ?? {});
    if (!references.success || detail.code && !BLING_ERROR_CODES.includes(detail.code)) throw new BlingError("BLING_RESPONSE_INVALID");
    db.exec(`INSERT INTO wb_bling_audit(id,actor_id,operation,command_id,generation,revision_before,revision_after,counts,references_json,code,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, dependencies.randomId(), actor.user_id, operation, detail.command_id ?? null,
      config.generation, detail.before_revision ?? config.revision, config.revision, JSON.stringify(countValues(detail.counts ?? {})), JSON.stringify(references.data), detail.code ?? null, ctx.clock.now());
  }

  /** Só persiste metadados pequenos; jamais o resultado público integral. */
  function finish(ctx: BlingContext, name: BlingOperationName, input: BlingCommand, requestHash: Sha256, detail: Details = {}): BlingReceipt {
    context(ctx, true);
    return db.transaction(() => {
      const prior = receipt(ctx, input.command_id), config = configuration(ctx);
      if (prior) return assertCommitted(prior, name, requestHash, config.generation);
      const references = metadataSchema.safeParse(detail.references ?? {});
      if (!sha256Schema.safeParse(requestHash).success || !references.success) throw new BlingError("BLING_RESPONSE_INVALID");
      const counts = countValues(detail.counts ?? {});
      db.exec(`INSERT INTO wb_bling_receipt(command_id,operation,request_hash,generation,state,result,references_json,error_code,created_at)
        VALUES(?,?,?,?,'committed',?,?,NULL,?)`, input.command_id, name, requestHash, config.generation, JSON.stringify({ counts }), JSON.stringify(references.data), ctx.clock.now());
      return receipt(ctx, input.command_id)!;
    });
  }

  function invalidate(ctx: BlingContext): void {
    // Libera só a posse da unidade aposentada. Uma retomada pode ligar a
    // coleta imediatamente; o recurso não deve conservar um fence sem dono.
    db.exec(`UPDATE origin_sync__resource_state SET lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
      WHERE EXISTS (SELECT 1 FROM wb_bling_unit u WHERE u.resource=origin_sync__resource_state.resource
        AND u.generation=? AND u.phase NOT IN ('committed','superseded') AND u.kind NOT IN ('r2_delete','purge')
        AND u.owner=origin_sync__resource_state.lease_owner AND u.fence=origin_sync__resource_state.lease_token)`, configuration(ctx).generation);
    db.exec(`UPDATE wb_bling_unit SET phase='superseded',owner=NULL,fence=NULL,lease_until=NULL,finished_at=?,updated_at=?
      WHERE generation=? AND phase NOT IN ('committed','superseded') AND kind NOT IN ('r2_delete','purge')`, ctx.clock.now(), ctx.clock.now(), configuration(ctx).generation);
  }

  function change<K extends "erp_bling_configure" | "erp_bling_enable" | "erp_bling_disable">(
    ctx: BlingContext, name: K, input: BlingOperationMap[K]["input"], requestHash: Sha256,
    mutate: (before: BlingPublicConfiguration) => Details,
  ): BlingAdminResult {
    context(ctx, true);
    return db.transaction(() => {
      const prior = checkCommand(ctx, name, input, requestHash);
      if (prior) return { configuration: configuration(ctx), receipt: prior };
      initialize(ctx);
      const before = configuration(ctx), details = mutate(before);
      const saved = finish(ctx, name, input, requestHash, details);
      audit(ctx, name, { ...details, command_id: input.command_id, before_revision: before.revision });
      return { configuration: configuration(ctx), receipt: saved };
    });
  }

  function configure(ctx: BlingContext, raw: BlingOperationMap["erp_bling_configure"]["input"], hash: Sha256, resources: readonly ResourceDescriptor[]): BlingAdminResult {
    const input = parseBlingOperationInput("erp_bling_configure", raw);
    return change(ctx, "erp_bling_configure", input, hash, before => {
      validateBlingSelections({ selections: input.selections }, resources);
      // A7 não recebe prova de nova projeção/limite oficial. Até esse contrato
      // existir, a proteção local pode ser reduzida, mas não ampliada.
      if (input.daily_call_limit > before.daily_call_limit) throw new BlingError("BLING_RESOURCE_UNCONFIRMED");
      if (new Set(input.access.reader_user_ids).size !== input.access.reader_user_ids.length || new Set(input.access.bots.map(bot => bot.bot_id)).size !== input.access.bots.length)
        throw new BlingError("BLING_RESPONSE_INVALID");
      const permissions = JSON.stringify(input.access), selections = JSON.stringify(input.selections);
      if (new TextEncoder().encode(permissions).byteLength > 65536 || new TextEncoder().encode(selections).byteLength > 65536) throw new BlingError("BLING_RESPONSE_INVALID");
      // A aprovação fica ligada à configuração revisada. Mudá-la suspende a
      // coleta até nova aprovação explícita, sem apagar nem desconectar.
      invalidate(ctx);
      db.exec(`UPDATE wb_bling_control SET revision=?,authorization_revision=?,selection=?,permissions=?,daily_call_limit=?,
        collect_enabled=0,state='off',approved_by=NULL,approved_at=NULL,approval_hash=NULL,updated_at=? WHERE id=1 AND revision=?`,
      bump(before.revision), bump(before.authorization_revision), selections, permissions, input.daily_call_limit, ctx.clock.now(), before.revision);
      return { counts: { selected: input.selections.filter(item => item.selected).length, readers: input.access.reader_user_ids.length, bots: input.access.bots.length },
        references: { ai_disclosure_acknowledged: input.ai_disclosure_acknowledged, customer_delivery_enabled: input.access.customer_delivery.enabled } };
    });
  }

  function enable(ctx: BlingContext, raw: BlingOperationMap["erp_bling_enable"]["input"], hash: Sha256, resources: readonly ResourceDescriptor[]): BlingAdminResult {
    const input = parseBlingOperationInput("erp_bling_enable", raw);
    return change(ctx, "erp_bling_enable", input, hash, before => {
      const selected = validateBlingSelections(before, resources, true);
      if (!selected.length) throw new BlingError("BLING_RESOURCE_UNCONFIRMED");
      if (!before.credential.configured) throw new BlingError("BLING_AUTH_REQUIRED");
      if (number(dependencies.databaseSize()) >= BLING_BUDGET.database_ceiling_bytes * BLING_BUDGET.stop_ratio) throw new BlingError("BLING_CAPACITY_STOP");
      if (before.credential.authorized && selected.some(resource => resource.scopeRequirements.some(scope => !before.credential.scopes.includes(scope)))) throw new BlingError("BLING_SCOPE_REQUIRED");
      const ready = before.credential.authorized && !!before.account?.confirmed_at;
      invalidate(ctx);
      db.exec(`UPDATE wb_bling_control SET revision=?,authorization_revision=?,collect_enabled=1,state=?,approved_by=?,approved_at=?,approval_hash=?,updated_at=? WHERE id=1 AND revision=?`,
        bump(before.revision), bump(before.authorization_revision), ready ? "ready" : "needs_authorization", ctx.identity.actor!.user_id, ctx.clock.now(), input.checklist_hash, ctx.clock.now(), before.revision);
      return { counts: { selected: selected.length }, references: { checklist_hash: input.checklist_hash } };
    });
  }

  function disable(ctx: BlingContext, raw: BlingCommand, hash: Sha256): BlingAdminResult {
    const input = parseBlingOperationInput("erp_bling_disable", raw);
    return change(ctx, "erp_bling_disable", input, hash, before => {
      invalidate(ctx);
      db.exec("UPDATE wb_bling_control SET revision=?,authorization_revision=?,collect_enabled=0,state='off',updated_at=? WHERE id=1 AND revision=?",
        bump(before.revision), bump(before.authorization_revision), ctx.clock.now(), before.revision);
      return { references: { authorization_revision: bump(before.authorization_revision), stopped: true } };
    });
  }

  function expected(ctx: BlingContext): BlingExpectedState {
    const config = configuration(ctx);
    if (!config.account) throw new BlingError("BLING_AUTH_REQUIRED");
    return { generation: config.generation, authorization_revision: config.authorization_revision, credential_revision: config.credential.revision,
      configuration_revision: config.revision, account_id: config.account.id, parts_revision: ctx.identity.partsControl!.revision };
  }

  /** Limitador compartilhado por conta, inclusive quando ainda não há unidade. */
  function nextAllowed(ctx: BlingContext): number | null {
    const stored = row(ctx);
    return stored.next_allowed_at === null ? null : number(stored.next_allowed_at);
  }

  /** A reserva de desconexão usa oauth_refresh porque o schema da base não
   * tem tipo administrativo próprio. O integrador deve despachar este plano
   * exclusivamente para desconectar, nunca para renovar credenciais.
   */
  function beginDisconnect(ctx: BlingContext, raw: BlingCommand, hash: Sha256): DisconnectReservation {
    const input = parseBlingOperationInput("erp_bling_disconnect", raw);
    return db.transaction(() => {
      const prior = checkCommand(ctx, "erp_bling_disconnect", input, hash);
      let config = configuration(ctx);
      // Ausência de conta usa a mesma representação privada do AuthStore;
      // nunca fabricar uma identidade para permitir desconectar aplicativo.
      const expectation = (): BlingExpectedState => ({ generation: config.generation, authorization_revision: config.authorization_revision,
        credential_revision: config.credential.revision, configuration_revision: config.revision, account_id: config.account?.id ?? "", parts_revision: ctx.identity.partsControl!.revision });
      if (prior) return { receipt: prior, expected: expectation() };
      const pending = one(db, "SELECT * FROM wb_bling_unit WHERE command_id=?", input.command_id);
      if (pending) {
        if (pending.kind !== "oauth_refresh" || (json(pending.plan) as Record<string, unknown>).operation !== "erp_bling_disconnect") throw new BlingError("BLING_COMMAND_CONFLICT");
        if (revision(pending.authorization_revision) !== config.authorization_revision || revision(pending.configuration_revision) !== config.revision)
          throw new BlingError("BLING_REVISION_CONFLICT");
        // A custódia confirmou a remoção e sua resposta se perdeu: concluir
        // pelo tombstone durável, sem repetir a chamada ao cofre.
        if (number(config.credential.revision) > number(pending.credential_revision) && row(ctx).credential_status === "disconnected" && !config.credential.configured) {
          const done = finishDisconnect(ctx, input, hash, config.credential);
          return { expected: expectation(), receipt: done.receipt };
        }
        if (revision(pending.credential_revision) !== config.credential.revision) throw new BlingError("BLING_REVISION_CONFLICT");
        return { expected: expectation(), receipt: null };
      }
      initialize(ctx);
      const before = config;
      invalidate(ctx);
      db.exec("UPDATE wb_bling_control SET revision=?,authorization_revision=?,collect_enabled=0,state='off',credential_status='disconnected',app_configured=0,credential_expires_at=NULL,credential_scopes='[]',updated_at=? WHERE id=1 AND revision=?",
        bump(before.revision), bump(before.authorization_revision), ctx.clock.now(), before.revision);
      config = configuration(ctx);
      const target = expectation();
      db.exec(`INSERT INTO wb_bling_unit(id,attempt_id,command_id,request_hash,generation,authorization_revision,credential_revision,configuration_revision,
        account_id,parts_revision,kind,phase,plan,not_before,profile,session_id,actor_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,'oauth_refresh','queued',?,?,?,?,?,?,?)`, dependencies.randomId(), dependencies.randomId(), input.command_id, hash,
        target.generation, target.authorization_revision, target.credential_revision, target.configuration_revision, config.account?.id ?? null, target.parts_revision,
        JSON.stringify({ operation: "erp_bling_disconnect" }), ctx.clock.now(), ctx.profile, ctx.identity.actor!.session_id, ctx.identity.actor!.user_id, ctx.clock.now(), ctx.clock.now());
      audit(ctx, "erp_bling_disconnect", { command_id: input.command_id, before_revision: before.revision, references: { phase: "reserved", authorization_revision: config.authorization_revision } });
      return { receipt: null, expected: target };
    });
  }

  function finishDisconnect(ctx: BlingContext, raw: BlingCommand, hash: Sha256, credential: BlingCredentialPublic): BlingAdminResult {
    const input = parseBlingOperationInput("erp_bling_disconnect", raw);
    context(ctx, true);
    return db.transaction(() => {
      const prior = receipt(ctx, input.command_id);
      if (prior) {
        checkCommand(ctx, "erp_bling_disconnect", input, hash);
        return { configuration: configuration(ctx), receipt: prior };
      }
      const pending = one(db, "SELECT * FROM wb_bling_unit WHERE command_id=?", input.command_id), config = configuration(ctx);
      if (!pending || pending.request_hash !== hash || (json(pending.plan) as Record<string, unknown>).operation !== "erp_bling_disconnect") throw new BlingError("BLING_COMMAND_CONFLICT");
      if (revision(pending.generation) !== config.generation) throw new BlingError("BLING_GENERATION_RETIRED");
      if (pending.phase === "superseded" || revision(pending.authorization_revision) !== config.authorization_revision || revision(pending.configuration_revision) !== config.revision) throw new BlingError("BLING_REVISION_CONFLICT");
      const parsed = credentialPublicSchema.safeParse(credential);
      if (!parsed.success || parsed.data.configured || parsed.data.authorized || parsed.data.uncertain || parsed.data.expires_at !== null || parsed.data.scopes.length ||
          number(parsed.data.revision) <= number(pending.credential_revision) || number(config.credential.revision) > number(parsed.data.revision))
        throw new BlingError("BLING_RESPONSE_INVALID");
      db.exec(`UPDATE wb_bling_control SET credential_revision=?,app_configured=0,credential_status='disconnected',credential_expires_at=NULL,
        credential_scopes='[]',collect_enabled=0,state='off',updated_at=? WHERE id=1`, parsed.data.revision, ctx.clock.now());
      db.exec("UPDATE wb_bling_unit SET phase='committed',owner=NULL,fence=NULL,lease_until=NULL,finished_at=?,updated_at=? WHERE command_id=? AND phase NOT IN ('committed','superseded')", ctx.clock.now(), ctx.clock.now(), input.command_id);
      const result = finish(ctx, "erp_bling_disconnect", input, hash, { references: { disconnected: true, credential_revision: parsed.data.revision } });
      audit(ctx, "erp_bling_disconnect", { command_id: input.command_id, references: { phase: "committed", credential_revision: parsed.data.revision } });
      return { configuration: configuration(ctx), receipt: result };
    });
  }

  function commandGet(ctx: BlingContext, commandId: string): BlingOperationMap["erp_bling_command_get"]["output"] {
    context(ctx);
    const prior = receipt(ctx, commandId);
    if (prior) return { phase: prior.state === "committed" ? "committed" : prior.state === "superseded" ? "superseded" : "blocked", receipt: prior };
    const pending = one(db, "SELECT phase FROM wb_bling_unit WHERE command_id=?", commandId);
    if (!pending) return { phase: "absent", receipt: null };
    const phase = unitPhaseSchema.safeParse(pending?.phase);
    if (!phase.success) throw new BlingError("BLING_RESPONSE_INVALID");
    return { phase: phase.data, receipt: null };
  }

  return { read, configuration, receipt, checkCommand, commandGet, configure, enable, disable, expected, nextAllowed, audit, finish, beginDisconnect, finishDisconnect };
}

export type BlingControl = ReturnType<typeof createBlingControl>;
