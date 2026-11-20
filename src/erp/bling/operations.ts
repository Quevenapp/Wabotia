/** Operações públicas da coleta. A montagem injeta as portas; importar não faz I/O. */
import {
  BlingError, type BlingCommand, type BlingContext, type BlingOperationMap,
  type BlingOperationName, type BlingPublicConfiguration, type BlingReceipt,
  type BlingRecordMetadata, type JsonObject, type ResourceDescriptor,
} from "./contracts.ts";
import type { BlingApiPort, BlingDependencies } from "./ports.ts";
import { createBlingControl, isStaleRevisionRefusal } from "./control.ts";
import { authorizeOperation, protectOperationOutput, sanitizeBlingError } from "./permissions.ts";
import { BLING_OPERATIONS, getBlingOperation, parseBlingOperationInput, resourceDescriptorSchema } from "./schema.ts";
import { readErpPartsSnapshot } from "../parts.ts";
import type { IdentityPort } from "../engine/identity.ts";

export interface BlingApiOptions {
  /** Área da instância Coordinator, nunca extraída dos argumentos públicos. */
  profile: string;
  /** Tabela declarativa de org-coleta, injetada por org-fecha. */
  resources: readonly ResourceDescriptor[];
  resource_version: string;
  callback_url?: string;
  session?: (ctx: BlingContext) => Promise<IdentityPort>;
  beforeApplicationSave?: (ctx: BlingContext, input: BlingOperationMap["erp_bling_app_save"]["input"]) => Promise<void>;
}

export function createBlingApi(deps: BlingDependencies, options: BlingApiOptions): BlingApiPort {
  const control = createBlingControl({ db: deps.db, databaseSize: deps.databaseSize, randomId: deps.randomId, profile: options.profile, resources: options.resources });
  const resources = options.resources.map(resource => resourceDescriptorSchema.parse(resource));
  if (new Set(resources.map(resource => resource.key)).size !== resources.length) throw new BlingError("BLING_RESPONSE_INVALID");
  const resourceMap = new Map(resources.map(resource => [resource.key, resource]));
  function callbackUrl(value: unknown): string {
    if (typeof value !== "string") throw new BlingError("BLING_RESPONSE_INVALID");
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== `/api/public/erp-bling/${encodeURIComponent(options.profile)}/callback`) throw new BlingError("BLING_RESPONSE_INVALID");
    return value;
  }

  async function parts(ctx: BlingContext) {
    if (options.session) {
      const fresh = await options.session(ctx), prior = ctx.identity.actor;
      if (!prior || !fresh.actor || fresh.actor.user_id !== prior.user_id || fresh.actor.session_id !== prior.session_id || fresh.actor.is_agent !== prior.is_agent)
        throw new BlingError("BLING_ADMIN_REQUIRED");
      ctx.identity = fresh;
    }
    if (ctx.profile !== options.profile || ctx.identity.partsControl?.profile !== options.profile) throw new BlingError("BLING_SCOPE_REQUIRED");
    const snapshot = readErpPartsSnapshot(await deps.readParts(), options.profile, ctx.clock.now());
    if (!snapshot?.parts.customers) throw new BlingError("BLING_DISABLED");
    if (snapshot.revision !== ctx.identity.partsControl.revision) throw new BlingError("BLING_REVISION_CONFLICT");
  }
  function output<K extends BlingOperationName>(ctx: BlingContext, name: K, value: unknown): BlingOperationMap[K]["output"] {
    const validated = BLING_OPERATIONS[name].output.safeParse(value);
    if (!validated.success) throw new BlingError("BLING_RESPONSE_INVALID");
    return protectOperationOutput(ctx, name, validated.data as BlingOperationMap[K]["output"], control.read(ctx).configuration);
  }
  function checkIdentity(ctx: BlingContext, config: BlingPublicConfiguration, value: BlingRecordMetadata["identity"], entity?: string, id?: string) {
    if (value.profile !== ctx.profile || value.account_id !== config.account?.id) throw new BlingError("BLING_ACCOUNT_MISMATCH");
    if (entity !== undefined && value.entity !== entity || id !== undefined && value.source_id !== id) throw new BlingError("BLING_RESPONSE_INVALID");
  }
  function selected(config: BlingPublicConfiguration, keys: string[]) {
    if (new Set(keys).size !== keys.length) throw new BlingError("BLING_RESPONSE_INVALID");
    for (const key of keys) {
      const resource = resourceMap.get(key);
      if (!resource || resource.confirmation !== "oficial_confirmado" || !resource.officialEvidence) throw new BlingError("BLING_RESOURCE_UNCONFIRMED");
      if (!config.selections.some(selection => selection.key === key && selection.selected)) throw new BlingError("BLING_SCOPE_REQUIRED");
      if (resource.scopeRequirements.some(scope => !config.credential.scopes.includes(scope))) throw new BlingError("BLING_SCOPE_REQUIRED");
    }
  }
  function receiptMatches(receipt: BlingReceipt, name: BlingOperationName, command: BlingCommand, hash: string, generation: string) {
    if (receipt.command_id !== command.command_id || receipt.request_hash !== hash || receipt.operation !== name) throw new BlingError("BLING_COMMAND_CONFLICT");
    if (receipt.generation !== generation || receipt.state === "superseded") throw new BlingError("BLING_GENERATION_RETIRED");
    if (receipt.state === "rejected") throw new BlingError(receipt.error?.code ?? "BLING_RESPONSE_INVALID", { retry_at: receipt.error?.retry_at });
  }
  function replayCollection(ctx: BlingContext, receipt: BlingReceipt) {
    const rate = control.nextAllowed(ctx);
    const scheduled = receipt.references.next_wake;
    if (scheduled !== null && scheduled !== undefined && (typeof scheduled !== "number" || !Number.isSafeInteger(scheduled))) throw new BlingError("BLING_RESPONSE_INVALID");
    return { run_id: receipt.references.run_id, next_wake: Math.max(scheduled ?? ctx.clock.now(), rate == null ? 0 : Number(rate)), receipt };
  }

  async function execute<K extends BlingOperationName>(original: BlingContext, name: K, raw: BlingOperationMap[K]["input"]): Promise<BlingOperationMap[K]["output"]> {
    let authorized: BlingContext | undefined;
    let auditedCommand: string | undefined;
    let refusedCommand: { command: BlingCommand; hash: string } | null = null;
    try {
      if (!getBlingOperation(name) || name === "erp_bling_oauth_callback") throw new BlingError("BLING_SCOPE_REQUIRED");
      if (original.profile !== options.profile) throw new BlingError("BLING_SCOPE_REQUIRED");
      const input = parseBlingOperationInput(name, raw);
      if ("from" in input && "to" in input && typeof input.from === "string" && typeof input.to === "string" && input.from > input.to) throw new BlingError("BLING_RESPONSE_INVALID");
      // Mesmo envelope usado pela costura da base: a confirmação cobre todos os
      // argumentos, inclusive revisão. Não aceitar um hash apresentado no corpo.
      const hash = await deps.hash(new TextEncoder().encode(JSON.stringify(raw)));
      if (original.authorization?.request_hash && original.authorization.request_hash !== hash) throw new BlingError("BLING_COMMAND_CONFLICT");
      await parts(original);
      const status = control.read(original);
      const ctx = authorizeOperation(original, name, input, status.configuration, hash);
      authorized = ctx;
      const before = status.configuration;
      if (ctx.identity.actor?.is_agent) {
        // As entradas administrativas usam chaves de recurso, enquanto a
        // concessão do bot usa entidades canônicas. Resolver pela tabela fixa.
        const keys = name === "erp_bling_collect_request" ? (input as BlingOperationMap["erp_bling_collect_request"]["input"]).resource_keys
          : name === "erp_bling_configure" ? (input as BlingOperationMap["erp_bling_configure"]["input"]).selections.filter(item => item.selected).map(item => item.key)
          : name === "erp_bling_enable" ? before.selections.filter(item => item.selected).map(item => item.key) : [];
        if (keys.some(key => !ctx.authorization!.bot!.allowed_entities.includes(resourceMap.get(key)?.entity!))) throw new BlingError("BLING_SCOPE_REQUIRED");
      }
      const command = "command_id" in input ? input as BlingCommand : null;
      auditedCommand = command?.command_id;
      if (command) refusedCommand = { command, hash };
      let replay: BlingReceipt | null = null;
      if (command) replay = control.checkCommand(ctx, name, command, hash);
      const audit = (references: JsonObject = {}) => control.audit(ctx, name, { command_id: command?.command_id, before_revision: before.revision, references });
      let result: unknown;
      switch (name) {
        case "erp_bling_status": {
          const admin = ctx.identity.actor?.erp_role === "admin";
          result = { ...status, ...(options.callback_url ? { callback_url: callbackUrl(options.callback_url) } : {}), capabilities: { ...status.capabilities, collect: admin && status.capabilities.collect, purge: admin && status.capabilities.purge } };
          break;
        }
        case "erp_bling_resources":
          result = { version: options.resource_version, resources, selections: before.selections,
            limitations: ["A confirmação local não certifica a API oficial atual.", "URLs de imagens e anexos são referências; seus bytes não estão arquivados.", "Uma passagem concluída não comprova cobertura integral da conta."] };
          break;
        case "erp_bling_configure": result = control.configure(ctx, input as BlingOperationMap["erp_bling_configure"]["input"], hash, resources); break;
        case "erp_bling_enable": result = control.enable(ctx, input as BlingOperationMap["erp_bling_enable"]["input"], hash, resources); break;
        case "erp_bling_disable": result = control.disable(ctx, input as BlingCommand, hash); break;
        case "erp_bling_app_save": {
          if (replay) {
            result = { configured: true, revision: String(replay.references.revision), callback_url: callbackUrl(replay.references.callback_url), receipt: replay }; break;
          }
          if (status.state === "purging") throw new BlingError("BLING_GENERATION_RETIRED");
          audit();
          await options.beforeApplicationSave?.(ctx, input as BlingOperationMap["erp_bling_app_save"]["input"]);
          const saved = output(ctx, name, await deps.authorization.saveApplication(ctx, input as BlingOperationMap["erp_bling_app_save"]["input"])) as BlingOperationMap["erp_bling_app_save"]["output"];
          callbackUrl(saved.callback_url);
          receiptMatches(saved.receipt, name, command!, hash, before.generation);
          await parts(ctx);
          const after = control.read(ctx).configuration;
          ctx.authorization = authorizeOperation(ctx, name, input, after, hash).authorization;
          if (after.generation !== before.generation) throw new BlingError("BLING_GENERATION_RETIRED");
          const receipt = control.finish(ctx, name, command!, hash, { references: { callback_url: saved.callback_url, revision: saved.revision } });
          receiptMatches(receipt, name, command!, hash, before.generation);
          result = { ...saved, receipt }; break;
        }
        case "erp_bling_oauth_start": {
          if (status.state === "purging") throw new BlingError("BLING_GENERATION_RETIRED");
          if (!before.collect_enabled) throw new BlingError("BLING_DISABLED", { status: 409 });
          if (!before.credential.configured) throw new BlingError("BLING_AUTH_REQUIRED");
          audit();
          result = await deps.authorization.authorize(ctx, input as BlingCommand);
          await parts(ctx);
          const after = control.read(ctx).configuration;
          ctx.authorization = authorizeOperation(ctx, name, input, after, hash).authorization;
          if (after.generation !== before.generation || after.authorization_revision !== before.authorization_revision || !after.collect_enabled) throw new BlingError("BLING_GENERATION_RETIRED");
          break;
        }
        case "erp_bling_disconnect": {
          const pending = control.beginDisconnect(ctx, input as BlingCommand, hash);
          if (pending.receipt) {
            result = { configuration: control.read(ctx).configuration, receipt: pending.receipt, revocation_guidance: "Revogue o acesso também no aplicativo autorizado do Bling." }; break;
          }
          const credential = await deps.authorization.disconnect(ctx, pending.expected!);
          await parts(ctx);
          ctx.authorization = authorizeOperation(ctx, name, input, control.read(ctx).configuration, hash).authorization;
          result = { ...control.finishDisconnect(ctx, input as BlingCommand, hash, credential), revocation_guidance: "Revogue o acesso também no aplicativo autorizado do Bling." }; break;
        }
        case "erp_bling_collect_request": {
          if (replay) { result = replayCollection(ctx, replay); break; }
          if (!before.collect_enabled) throw new BlingError("BLING_DISABLED", { status: 409 });
          if (!before.account?.confirmed_at || !before.credential.authorized || before.credential.uncertain) throw new BlingError("BLING_AUTH_REQUIRED");
          if (status.state === "blocked_capacity" || status.occupancy.database_bytes >= 8_000_000_000) throw new BlingError("BLING_CAPACITY_STOP");
          const request = input as BlingOperationMap["erp_bling_collect_request"]["input"];
          selected(before, request.resource_keys);
          result = deps.db.transaction(() => {
            audit({ resources: request.resource_keys });
            const scheduled = output(ctx, name, deps.collection.requestCollection(ctx, request)) as BlingOperationMap["erp_bling_collect_request"]["output"];
            receiptMatches(scheduled.receipt, name, request, hash, before.generation);
            // O coletor mantém o limitador; a API tampouco anuncia horário anterior.
            const nextWake = Math.max(control.nextAllowed(ctx) ?? ctx.clock.now(), status.next_wake ?? ctx.clock.now(), scheduled.next_wake ?? ctx.clock.now());
            const receipt = control.finish(ctx, name, request, hash, { references: { run_id: scheduled.run_id, next_wake: nextWake }, counts: scheduled.receipt.counts });
            if (receipt.references.run_id !== scheduled.run_id) throw new BlingError("BLING_RESPONSE_INVALID");
            return { ...scheduled, next_wake: nextWake, receipt };
          });
          break;
        }
        case "erp_bling_records_list": {
          const request = input as BlingOperationMap["erp_bling_records_list"]["input"];
          result = output(ctx, name, deps.archive.listRecords(ctx, request));
          for (const item of (result as BlingOperationMap["erp_bling_records_list"]["output"]).items) checkIdentity(ctx, before, item.identity, request.entity);
          break;
        }
        case "erp_bling_versions_list": {
          const request = input as BlingOperationMap["erp_bling_versions_list"]["input"];
          result = output(ctx, name, deps.archive.listVersions(ctx, request));
          for (const item of (result as BlingOperationMap["erp_bling_versions_list"]["output"]).items) checkIdentity(ctx, before, item.identity, request.entity, request.id);
          break;
        }
        case "erp_bling_record_get": {
          const request = input as BlingOperationMap["erp_bling_record_get"]["input"];
          if (!before.account) throw new BlingError("BLING_AUTH_REQUIRED");
          result = deps.db.transaction(() => {
            const identity = { profile: ctx.profile, account_id: before.account!.id, entity: request.entity, source_id: request.id };
            const rawRecord = deps.archive.readVersion(ctx, identity, request.version);
            if (!rawRecord) throw new BlingError("BLING_RESPONSE_INVALID");
            checkIdentity(ctx, before, rawRecord.identity, request.entity, request.id);
            if (request.version && rawRecord.version !== request.version) throw new BlingError("BLING_RESPONSE_INVALID");
            const projected = deps.archive.project(ctx, rawRecord);
            checkIdentity(ctx, before, projected.metadata.identity, request.entity, request.id);
            if (projected.metadata.version !== rawRecord.version || projected.metadata.semantic_hash !== rawRecord.semantic_hash) throw new BlingError("BLING_RESPONSE_INVALID");
            const existing = deps.db.exec("SELECT record_id, entity, origin_id, deleted FROM erp_sync__link WHERE entity = ? AND origin_id = ? LIMIT 2", request.entity, request.id).rows;
            const links = existing.map(row => ({ record_id: String(row.record_id), entity: String(row.entity), source_id: String(row.origin_id), deleted: Number(row.deleted) !== 0 }));
            return { raw: rawRecord, metadata: projected.metadata, historical: projected.historical, existing_links: links };
          });
          break;
        }
        case "erp_bling_xml_list": {
          const request = input as BlingOperationMap["erp_bling_xml_list"]["input"];
          result = output(ctx, name, deps.archive.listXml(ctx, request));
          if (request.entity && (result as BlingOperationMap["erp_bling_xml_list"]["output"]).items.some(item => item.entity !== request.entity)) throw new BlingError("BLING_RESPONSE_INVALID");
          break;
        }
        case "erp_bling_xml_get": {
          result = await deps.archive.readXml(ctx, (input as BlingOperationMap["erp_bling_xml_get"]["input"]).object_id);
          await parts(ctx);
          const after = control.read(ctx).configuration;
          // parts atualizou a sessão em ctx; a fotografia inicial não concede
          // acesso depois de um rebaixamento enquanto os bytes eram lidos.
          ctx.authorization = authorizeOperation(ctx, name, input, after, hash).authorization;
          if (after.generation !== before.generation || after.authorization_revision !== before.authorization_revision) throw new BlingError("BLING_GENERATION_RETIRED");
          break;
        }
        case "erp_bling_purge_preview": {
          const request = input as BlingOperationMap["erp_bling_purge_preview"]["input"];
          if (request.generation !== before.generation) throw new BlingError("BLING_GENERATION_RETIRED");
          audit();
          result = output(ctx, name, deps.archive.purgePreview(ctx, request));
          if ((result as BlingOperationMap["erp_bling_purge_preview"]["output"]).generation !== request.generation) throw new BlingError("BLING_GENERATION_RETIRED");
          break;
        }
        case "erp_bling_purge_apply": {
          const request = input as BlingOperationMap["erp_bling_purge_apply"]["input"];
          if (replay) { result = { work_id: replay.references.work_id, receipt: replay }; break; }
          const pending = deps.db.exec("SELECT id,generation FROM wb_bling_unit WHERE command_id=? AND kind='purge'", request.command_id).rows[0];
          // checkCommand já provou hash/operação e a geração sucessora. Uma
          // resposta perdida da reserva retorna o trabalho, sem nova prévia.
          if (pending && String(pending.generation) === request.generation) {
            result = { work_id: String(pending.id), receipt: null }; break;
          }
          if (request.generation !== before.generation) throw new BlingError("BLING_GENERATION_RETIRED");
          const preview = output(ctx, "erp_bling_purge_preview", deps.archive.purgePreview(ctx, { scope: request.scope, generation: request.generation }));
          if (preview.generation !== request.generation || preview.preview_hash !== request.preview_hash) throw new BlingError("BLING_REVISION_CONFLICT");
          if (preview.blocked_references) throw new BlingError("BLING_ARCHIVE_REFERENCED");
          audit({ preview_hash: request.preview_hash });
          // A porta de acervo aposenta geração/posses e reserva trabalho antes
          // de qualquer await; os lotes SQL/R2 são responsabilidade dela.
          const purged = output(ctx, name, await deps.archive.purge(ctx, request)) as BlingOperationMap["erp_bling_purge_apply"]["output"];
          if (purged.receipt) receiptMatches(purged.receipt, name, request, hash, request.generation);
          result = purged;
          await parts(ctx);
          ctx.authorization = authorizeOperation(ctx, name, input, control.read(ctx).configuration, hash).authorization;
          break;
        }
        case "erp_bling_command_get": result = control.commandGet(ctx, (input as BlingOperationMap["erp_bling_command_get"]["input"]).id); break;
        default: throw new BlingError("BLING_SCOPE_REQUIRED");
      }
      return output(ctx, name, result);
    } catch (error) {
      const failure = sanitizeBlingError(error);
      if (authorized) {
        // A tentativa recusada é auditável sem copiar exceção, entrada ou dado.
        try { control.audit(authorized, name, { command_id: auditedCommand, code: failure.code }); } catch { /* Falha original prevalece. */ }
        // Revisão antiga recusada antes de reserva: recibo terminal consultável.
        if (refusedCommand && isStaleRevisionRefusal(error)) {
          try { control.rejectStale(authorized, name, refusedCommand.command, refusedCommand.hash); } catch { /* Falha original prevalece. */ }
        }
      }
      throw failure;
    }
  }
  return {
    execute,
    async callback(original, raw) {
      try {
        const input = parseBlingOperationInput("erp_bling_oauth_callback", raw);
        await parts(original);
        const hash = await deps.hash(new TextEncoder().encode(JSON.stringify(raw)));
        const before = control.read(original);
        const ctx = authorizeOperation(original, "erp_bling_oauth_callback", input, before.configuration, hash);
        if (before.state === "purging" || !before.configuration.collect_enabled) throw new BlingError("BLING_DISABLED", { status: 409 });
        control.audit(ctx, "erp_bling_oauth_callback", {});
        const result = await deps.authorization.callback(ctx, input);
        await parts(ctx);
        const after = control.read(ctx).configuration;
        ctx.authorization = authorizeOperation(ctx, "erp_bling_oauth_callback", input, after, hash).authorization;
        if (after.generation !== before.configuration.generation || !after.collect_enabled) throw new BlingError("BLING_GENERATION_RETIRED");
        // A porta OAuth usa a origem canônica para seu retorno. A fronteira
        // HTTP só admite o destino fixo local e nunca propaga origem/query.
        const target = new URL(result.redirect, "https://callback.invalid");
        if (target.pathname !== "/receber-bling" || target.search || target.hash) throw new BlingError("BLING_RESPONSE_INVALID");
        return output(ctx, "erp_bling_oauth_callback", { ...result, redirect: "/receber-bling" });
      } catch (error) { throw sanitizeBlingError(error); }
    },
  };
}
