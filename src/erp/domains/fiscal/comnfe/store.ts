/** Persistência restrita da fatia. Nenhuma função faz I/O externo ou posta efeitos.
 * Os métodos compostos abrem savepoint síncrono; podem rodar dentro de callRpc.
 * Autorização humana fica em access/registry; record exige capacidade durável,
 * não a identidade/partes atuais. Isso preserva resposta externa tardia.
 */
import { createHash, randomUUID } from "node:crypto";
import { one, type Row } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import type { RpcContext } from "../../../engine/registry.ts";
import { com1Authority } from "./access.ts";
import { COM1_MODEL_CODE, com1Model, com1Tables, type Com1Tables } from "./model.ts";
import type {
  ClaimInput, ClaimResult, CommandAction, CommandReceipt, CommandState, CommercialSnapshot,
  EffectAxis, EffectView, EmissionView, EvidenceCapability, FiscalBlocker, FiscalEnvironment,
  ImmutableRevision, JsonObject, ListInput, PedidoNfe, RecordInput, StoredEmission,
  CancelClaimInput, CancelClaimResult, CancelRecordInput, CancellationXmlInput, CancellationView,
} from "../../../commercial-nfe/contracts.ts";

/** Tabelas do modelo em curso (model.ts): as da NF-e fora de um escopo NFC-e. */
export const COM1_TABLES: Com1Tables = Object.freeze({
  get settings() { return com1Tables().settings; }, get emission() { return com1Tables().emission; },
  get revision() { return com1Tables().revision; }, get command() { return com1Tables().command; },
  get cancel() { return com1Tables().cancel; }, get effect() { return com1Tables().effect; }, get audit() { return com1Tables().audit; },
});
const T = COM1_TABLES;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function com1Uuid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !uuidPattern.test(value)) raise("22023", "com1_invalid_uuid");
}
export const com1Sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
/** JSON determinístico para hashes; body_text persistido é o que deve ser enviado. */
export function com1Json(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize((v as Row)[k])]));
    }
    return raise("22023", "com1_invalid_json");
  };
  return JSON.stringify(normalize(value));
}
export const com1Hash = (value: unknown): string => com1Sha256(com1Json(value));
export function com1Reference(documentId: string, fiscalVersion: number): string {
  com1Uuid(documentId);
  if (!Number.isInteger(fiscalVersion) || fiscalVersion < 1 || fiscalVersion > 9999) raise("22023", "com1_invalid_fiscal_version");
  return `wb.${documentId}.v${fiscalVersion}`;
}
const parse = <T>(value: unknown): T => value === null ? null as T : JSON.parse(String(value)) as T;
const instantColumns = (columns: string[]): string => columns.map(c => `CAST(${c} AS TEXT) AS ${c}`).join(",");
const emissionSelect = () => `SELECT *,${instantColumns(["issued_at", "authorized_at", "total", "created_at", "updated_at"])} FROM ${T.emission}`;
const commandSelect = () => `SELECT *,${instantColumns(["lease_until", "created_at", "updated_at"])} FROM ${T.command}`;
const emissionRow = (row: Row): StoredEmission => ({ ...row, environment_confirmed: row.environment_confirmed === 1, messages: parse(row.messages),
  ...(com1Model() === "nfce" ? { model: "nfce" } : {}) }) as StoredEmission;
const commandRow = (row: Row): CommandReceipt => ({ ...row, request: parse(row.request), result: parse(row.result), error: parse(row.error) }) as CommandReceipt;
export function getStoredEmission(ctx: RpcContext, id: string): StoredEmission {
  const row = one(ctx.db, `${emissionSelect()} WHERE id=?`, id);
  if (!row) raise("P0002", "com1_emission_not_found");
  return emissionRow(row);
}
export function findOrderEmission(ctx: RpcContext, documentId: string): StoredEmission | null {
  const row = one(ctx.db, `${emissionSelect()} WHERE document_id=? ORDER BY fiscal_version DESC LIMIT 1`, documentId);
  return row ? emissionRow(row) : null;
}
export function getStoredRevision(ctx: RpcContext, id: string, revision?: number): ImmutableRevision {
  const row = one(ctx.db, `SELECT *,CAST(prepared_at AS TEXT) AS prepared_at FROM ${T.revision} WHERE emission_id=? AND body_revision=?`,
    id, revision ?? getStoredEmission(ctx, id).current_body_revision);
  if (!row) raise("P0002", "com1_revision_not_found");
  return { ...row, snapshot: parse(row.snapshot), tax_sources: parse(row.tax_sources), body: parse(row.body), calculation: parse(row.calculation), blockers: parse(row.blockers) } as ImmutableRevision;
}
export function getCommand(ctx: RpcContext, id: string): CommandReceipt | null {
  const row = one(ctx.db, `${commandSelect()} WHERE id=?`, id);
  return row ? commandRow(row) : null;
}
/** A coluna conserva o CHECK da versão 10; a transferência para outra emissão
 * fica em compensation_result.state e aparece na visão como "transferido". */
const transferred = (result: JsonObject | null): boolean => result?.state === "transferido";
export function getEffects(ctx: RpcContext, id: string): EffectView[] {
  return ctx.db.exec(`SELECT *,CAST(updated_at AS TEXT) AS updated_at FROM ${T.effect} WHERE emission_id=? ORDER BY axis`, id).rows.map(row => {
    const compensation = parse<JsonObject | null>(row.compensation_result);
    return { ...row, ids: parse(row.ids), result: parse(row.result), compensation_result: compensation,
      compensation_state: transferred(compensation) ? "transferido" : row.compensation_state } as EffectView;
  });
}

/** A emissão nova reconheceu o mesmo lançamento: ela passa a responder por
 * ele. A antiga fecha a compensação como transferida (de qual, para qual,
 * quando e por qual comando) e perde o poder de estorná-lo. Mesma transação
 * do reconhecimento; o comando é o da emissão nova. */
export function transferEffect(ctx: RpcContext, from: EffectView, to: { emission_id: string; command_id: string }): EffectView {
  const fromEmission = getStoredEmission(ctx, from.emission_id), toEmission = getStoredEmission(ctx, to.emission_id);
  const command = getCommand(ctx, to.command_id);
  if (!command || command.emission_id !== toEmission.id || fromEmission.document_id !== toEmission.document_id || fromEmission.id === toEmission.id ||
      fromEmission.status !== "cancelada" || !from.fingerprint || !["aplicado", "reconhecido"].includes(from.state) ||
      ["revertido", "transferido"].includes(String(from.compensation_state))) raise("40001", "com1_effect_transfer_invalid");
  const at = String(ctx.clock.next());
  const result: JsonObject = { state: "transferido", axis: from.axis, from_emission_id: fromEmission.id, from_fiscal_version: fromEmission.fiscal_version,
    to_emission_id: toEmission.id, to_fiscal_version: toEmission.fiscal_version, command_id: command.id, person_id: command.person_id,
    transferred_at: at, ids: from.ids, fingerprint: from.fingerprint,
    previous_compensation: { state: from.compensation_state, command_id: from.compensation_command_id, result: from.compensation_result } };
  ctx.db.exec(`UPDATE ${T.effect} SET compensation_state=NULL,compensation_command_id=?,compensation_result=?,updated_at=? WHERE emission_id=? AND axis=?`,
    command.id, com1Json(result), at, fromEmission.id, from.axis);
  appendCom1Audit(ctx, { command, emission: fromEmission, action: "effect_transfer", before: { axis: from.axis, state: from.compensation_state ?? from.state },
    after: { axis: from.axis, state: "transferido", command_id: command.id } });
  return getEffects(ctx, fromEmission.id).find(e => e.axis === from.axis)!;
}
export function getEmissionView(ctx: RpcContext, id: string): EmissionView {
  const emission = getStoredEmission(ctx, id);
  // XML e corpo do evento são restritos, não fazem parte desta projeção.
  const cancel = one(ctx.db, `SELECT emission_id,justification,command_id,state,messages,protocol,CAST(event_at AS TEXT) AS event_at,repeated,xml_status,xml_hash FROM ${T.cancel} WHERE emission_id=?`, id);
  return { ...emission, revision: getStoredRevision(ctx, id), effects: getEffects(ctx, id), cancellation: cancel ? {
    ...cancel, messages: parse(cancel.messages), repeated: cancel.repeated === 1,
  } as EmissionView["cancellation"] : null };
}
/** Camada restrita, sem política de visibilidade: reads.ts aplica acesso/privacidade. */
export function listStoredEmissions(ctx: RpcContext, input: ListInput) {
  if (!["homologacao", "producao"].includes(input.environment)) raise("22023", "com1_environment_required");
  const page = input.page ?? 1, per = input.per_page ?? 50;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(per) || per < 1 || per > 100) raise("22023", "com1_invalid_page");
  const clauses = ["environment=?"], values: unknown[] = [input.environment];
  if (input.document_id) { clauses.push("document_id=?"); values.push(input.document_id); }
  if (input.status) { clauses.push("status=?"); values.push(input.status); }
  const where = clauses.join(" AND ");
  const rows = ctx.db.exec(`${emissionSelect()} WHERE ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`, ...values, per, (page - 1) * per).rows;
  return { items: rows.map(emissionRow), total: Number(one(ctx.db, `SELECT count(*) AS n FROM ${T.emission} WHERE ${where}`, ...values)!.n), page, per_page: per };
}

export interface CommandStart {
  command_id: string; action: CommandAction; args: unknown;
  emission_id?: string | null; body_revision?: number | null;
  request?: JsonObject | null; claim?: { token: string; lease_until: string };
}
/** Antes de qualquer versão esperada: repetir a mesma intenção devolve o recibo. */
export function replayCommand(ctx: RpcContext, input: Pick<CommandStart, "command_id" | "action" | "args">): CommandReceipt | null {
  com1Uuid(input.command_id);
  const old = getCommand(ctx, input.command_id);
  if (!old) return null;
  if (old.person_id !== ctx.identity.actor?.user_id || old.action !== input.action || old.args_hash !== com1Hash(input.args)) raise("40001", "fiscal_command_conflict");
  return old;
}
export function startCommand(ctx: RpcContext, input: CommandStart): CommandReceipt {
  const replay = replayCommand(ctx, input);
  if (replay) return replay;
  const actor = ctx.identity.actor;
  if (!actor) raise("42501", "fiscal_forbidden");
  const at = String(ctx.clock.next()), authority = com1Authority(ctx);
  ctx.db.exec(`INSERT INTO ${T.command} (id,action,person_id,session_id,args_hash,emission_id,body_revision,state,token,lease_until,request,proposed_by,confirmed_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.command_id, input.action, actor.user_id, actor.session_id, com1Hash(input.args), input.emission_id ?? null, input.body_revision ?? null,
    input.claim ? "claimed" : "pending", input.claim?.token ?? null, input.claim?.lease_until ?? null,
    input.request ? com1Json(input.request) : null, authority.proposed_by ?? null, authority.confirmed_by ?? null, at, at);
  return getCommand(ctx, input.command_id)!;
}
export function finishCommand(ctx: RpcContext, id: string, state: Exclude<CommandState, "claimed">, result: JsonObject | null, error: JsonObject | null = null): CommandReceipt {
  if (!getCommand(ctx, id)) raise("P0002", "com1_command_not_found");
  ctx.db.exec(`UPDATE ${T.command} SET state=?,result=?,error=?,updated_at=? WHERE id=?`, state, result ? com1Json(result) : null, error ? com1Json(error) : null, String(ctx.clock.next()), id);
  return getCommand(ctx, id)!;
}
/** O token não expira para gravação; expirar a reivindicação permite só retomada. */
export function requireClaimedCommand(ctx: RpcContext, input: EvidenceCapability, actions: readonly CommandAction[] = ["emit", "resume", "cancel", "cancel_xml"]): CommandReceipt {
  const cmd = getCommand(ctx, input.command_id);
  if (!cmd || !cmd.token || cmd.token !== input.claim_token || cmd.emission_id !== input.emission_id || !actions.includes(cmd.action)) raise("42501", "com1_claim_required");
  return cmd;
}

/** Resumo deliberadamente fechado: sem corpo, XML, nome/documento cadastral ou segredo. */
export interface AuditSummary {
  status?: string; version?: number; body_revision?: number; axis?: EffectAxis; state?: string;
  reason?: string; environment?: FiscalEnvironment; stock_timing?: string; finance_timing?: string;
  command_id?: string; source_changed?: boolean; evidence_hash?: string;
}
export function appendCom1Audit(ctx: RpcContext, input: {
  command?: CommandReceipt; emission?: StoredEmission; action: string;
  before?: AuditSummary; after?: AuditSummary;
}): void {
  const command = input.command, actor = ctx.identity.actor;
  const authority = com1Authority(ctx);
  const allowed = new Set(["status", "version", "body_revision", "axis", "state", "reason", "environment", "stock_timing", "finance_timing", "command_id", "source_changed", "evidence_hash"]);
  for (const summary of [input.before, input.after]) if (summary && Object.entries(summary).some(([key, value]) => !allowed.has(key) || (typeof value === "string" && value.length > 160))) raise("22023", "com1_invalid_audit_summary");
  const person = command?.person_id ?? actor?.user_id;
  if (!person) raise("42501", "fiscal_forbidden");
  ctx.db.exec(`INSERT INTO ${T.audit} (id,person_id,session_id,proposed_by,confirmed_by,command_id,emission_id,environment,action,before_summary,after_summary,"references",created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(), person, command?.session_id ?? actor?.session_id ?? null, command?.proposed_by ?? authority.proposed_by ?? null,
    command?.confirmed_by ?? authority.confirmed_by ?? null, command?.id ?? null, input.emission?.id ?? null, input.emission?.environment ?? null,
    input.action, input.before ? com1Json(input.before) : null, input.after ? com1Json(input.after) : null,
    com1Json(input.emission ? { document_id: input.emission.document_id, reference: input.emission.reference } : {}), String(ctx.clock.next()));
}

export interface PreparationWrite {
  command_id: string;
  /** Os argumentos humanos originais; não recalcular no replay. */
  args: unknown;
  document_id: string;
  expected_document_version: number;
  expected_emission_version?: number;
  new_fiscal_version?: boolean;
  environment: FiscalEnvironment;
  connection_fingerprint: string | null;
  snapshot: CommercialSnapshot;
  tax_sources: JsonObject;
  commercial_hash: string;
  source_fingerprint: string;
  body: PedidoNfe | null;
  calculation: JsonObject;
  blockers: FiscalBlocker[];
}
/** Preparo recebe somente resultado calculado no servidor. Não é RPC público. */
export function savePreparation(ctx: RpcContext, input: PreparationWrite): { emission: EmissionView; replayed: boolean } {
  return ctx.db.transaction(() => {
    const replay = replayCommand(ctx, { ...input, action: "prepare" });
    if (replay?.emission_id) return { emission: getEmissionView(ctx, replay.emission_id), replayed: true };
    const document = one(ctx.db, "SELECT version,kind FROM erp_documents__document WHERE id=?", input.document_id);
    if (!document || document.kind !== "sales_orders") raise("55000", "fiscal_order_unavailable");
    if (document.version !== input.expected_document_version) raise("40001", "fiscal_source_changed");
    let emission = findOrderEmission(ctx, input.document_id);
    if (emission && emission.environment !== input.environment) raise("40001", "fiscal_environment_conflict");
    let fiscalVersion = emission?.fiscal_version ?? 1;
    if (input.new_fiscal_version) {
      if (!emission || !["cancelada", "denegada"].includes(emission.status) || input.expected_emission_version !== emission.version) raise("40001", "fiscal_emission_open");
      fiscalVersion++;
      emission = null;
    }
    if (emission && !["bloqueada", "preparada", "rejeitada"].includes(emission.status)) raise("40001", "fiscal_emission_open");
    if (emission && input.expected_emission_version !== emission.version) raise("40001", "com1_version_conflict");
    if (emission?.status === "rejeitada" && emission.connection_fingerprint !== input.connection_fingerprint) raise("40001", "fiscal_connection_changed");
    const id = emission?.id ?? randomUUID(), revision = (emission?.current_body_revision ?? 0) + 1;
    const reference = com1Reference(input.document_id, fiscalVersion);
    const blockers = [...input.blockers].sort((a, b) => a.field.localeCompare(b.field) || a.code.localeCompare(b.code) || (a.item_id ?? "").localeCompare(b.item_id ?? ""));
    if (!blockers.length && (!input.body || !input.connection_fingerprint)) raise("22023", "com1_preparation_incomplete");
    if (input.body && (input.body.referencia !== reference || input.body.ambiente !== input.environment)) raise("22023", "com1_body_identity_mismatch");
    const status = blockers.length ? "bloqueada" : "preparada", at = String(ctx.clock.next());
    if (emission) {
      ctx.db.exec(`UPDATE ${T.emission} SET current_body_revision=?,status=?,version=version+1,connection_fingerprint=?,updated_at=? WHERE id=?`, revision, status, input.connection_fingerprint, at, id);
    } else {
      ctx.db.exec(`INSERT INTO ${T.emission} (id,document_id,fiscal_version,environment,connection_fingerprint,reference,current_body_revision,status,version,created_at,created_by,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?,?)`,
        id, input.document_id, fiscalVersion, input.environment, input.connection_fingerprint, reference, revision, status, at, ctx.identity.actor?.user_id ?? raise("42501", "fiscal_forbidden"), at);
    }
    const body = input.body ? com1Json(input.body) : null;
    ctx.db.exec(`INSERT INTO ${T.revision} (emission_id,body_revision,source_document_version,snapshot,tax_sources,commercial_hash,source_fingerprint,body,body_hash,calculation,blockers,prepared_by,prepared_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, revision, input.expected_document_version, com1Json(input.snapshot), com1Json(input.tax_sources), input.commercial_hash, input.source_fingerprint, body, body ? com1Sha256(body) : null,
      com1Json(input.calculation), com1Json(blockers), ctx.identity.actor!.user_id, at);
    const command = startCommand(ctx, { command_id: input.command_id, action: "prepare", args: input.args, emission_id: id, body_revision: revision });
    finishCommand(ctx, command.id, "completed", { emission_id: id, body_revision: revision });
    const current = getStoredEmission(ctx, id);
    appendCom1Audit(ctx, { command, emission: current, action: "prepare", after: { status, body_revision: revision } });
    return { emission: getEmissionView(ctx, id), replayed: false };
  });
}

/** claim() fixa bytes/hash/referência antes de sair da transação. leaseMicros é
 * injetável para testes. Revalidação de fontes/partes/usuário ocorre no slot.
 * Mesmo duas abas com UUIDs distintos não ganham dois envios. */
export function claimStoredOperation(ctx: RpcContext, input: ClaimInput, leaseMicros = 60_000_000n): ClaimResult {
  return ctx.db.transaction(() => {
    if (leaseMicros <= 0n) raise("22023", "com1_lease_invalid");
    const replay = replayCommand(ctx, { ...input, args: input });
    const emission = getStoredEmission(ctx, input.emission_id);
    const revision = getStoredRevision(ctx, emission.id);
    if (replay) return { emission, revision, command: replay, disposition: "replay" };
    if (emission.version !== input.expected_version || emission.current_body_revision !== input.body_revision || revision.body_hash !== input.body_hash) raise("40001", "com1_version_conflict");
    if (emission.connection_fingerprint !== input.connection_fingerprint) raise("40001", "fiscal_connection_changed");
    if (!revision.body || revision.blockers.length) raise("55000", "com1_preparation_blocked");
    if (input.action === "emit" && emission.status !== "preparada") raise("40001", "com1_resume_required");
    if (input.action === "resume" && !["enviando", "processando", "incerta"].includes(emission.status)) raise("40001", "com1_resume_unavailable");
    if (input.action === "emit" && revision.source_fingerprint !== input.source_fingerprint) raise("40001", "fiscal_source_changed");
    const at = ctx.clock.next();
    const active = one(ctx.db, `${commandSelect()} WHERE emission_id=? AND action IN ('emit','resume') AND state IN ('claimed','pending') AND lease_until>? ORDER BY created_at DESC LIMIT 1`, emission.id, String(at));
    if (active) return { emission, revision, command: commandRow(active), disposition: "busy" };
    // A revisão é imutável; ler o texto persistido evita reserializar a recuperação.
    const bodyText = String(one(ctx.db, `SELECT body FROM ${T.revision} WHERE emission_id=? AND body_revision=?`, emission.id, revision.body_revision)!.body);
    const request: JsonObject = { kind: com1Model(), environment: emission.environment, reference: emission.reference, connection_fingerprint: emission.connection_fingerprint,
      body_text: bodyText, body_hash: revision.body_hash, provider_id: emission.provider_id, fiscal_version: emission.fiscal_version, document_id: emission.document_id };
    const command = startCommand(ctx, { command_id: input.command_id, action: input.action, args: input, emission_id: emission.id, body_revision: revision.body_revision, request,
      claim: { token: randomUUID(), lease_until: String(at + leaseMicros) } });
    ctx.db.exec(`UPDATE ${T.emission} SET status=?,version=version+1,updated_at=? WHERE id=?`, input.action === "emit" ? "enviando" : "incerta", String(at), emission.id);
    const current = getStoredEmission(ctx, emission.id);
    appendCom1Audit(ctx, { command, emission: current, action: input.action, before: { status: emission.status }, after: { status: current.status } });
    return { emission: current, revision, command, disposition: input.action === "emit" ? "send" : "resume" };
  });
}

const micros = (value: string | null): string | null => value && Number.isFinite(Date.parse(value)) ? String(BigInt(Date.parse(value)) * 1000n) : null;
/** Grava evidência inclusive em erro/incompleta. Não executa efeitos e não usa
 * permissões atuais: a capacidade prova uma operação anteriormente autorizada. */
export function recordExternalEvidence(ctx: RpcContext, input: RecordInput): EmissionView {
  return ctx.db.transaction(() => {
    const command = requireClaimedCommand(ctx, input, ["emit", "resume"]);
    const emission = getStoredEmission(ctx, input.emission_id), result = input.result;
    const evidence = { result, evidence: input.evidence ?? null, error: input.error ?? null };
    const evidenceHash = com1Hash(evidence);
    // Acumula evidência de todas as tentativas; não sobrescreve respostas antigas.
    const previous = Array.isArray(command.result?.evidence) ? command.result!.evidence : [];
    const entries = previous.some(v => v && typeof v === "object" && !Array.isArray(v) && v.hash === evidenceHash)
      ? previous : [...previous, { hash: evidenceHash, ...evidence }];
    const identityMatches = !!result && input.connection_fingerprint === emission.connection_fingerprint && result.kind === com1Model() && result.environment === emission.environment && result.reference === emission.reference &&
      (!emission.provider_id || emission.provider_id === result.provider_ref) && (!emission.access_key || !result.access_key || emission.access_key === result.access_key);
    let next = emission.status, reason: string | null = null;
    const series = result && /^\d{1,3}$/.test(result.series) ? Number(result.series) : null;
    const complete = !!result && !!result.provider_ref.trim() && !!result.access_key && /^[0-9A-Z]{44}$/.test(result.access_key) && !!result.protocol?.trim() && series !== null && Number.isInteger(result.number) && result.number > 0 && result.number <= 999999999 && !!micros(result.authorized_at) &&
      result.access_key.slice(20, 22) === COM1_MODEL_CODE[com1Model()] && Number(result.access_key.slice(22, 25)) === series && Number(result.access_key.slice(25, 34)) === result.number;
    if (!["autorizada", "cancelada", "denegada"].includes(emission.status)) {
      if (!identityMatches) { next = "incerta"; reason = result ? "com1_evidence_identity_mismatch" : input.error?.code ?? "fiscal_no_conclusive_answer"; }
      else if (command.body_revision !== emission.current_body_revision) { next = "incerta"; reason = "com1_late_revision_evidence"; }
      else if (result!.status === "authorized") { next = complete ? "autorizada" : "incerta"; if (!complete) reason = "com1_authorization_incomplete"; }
      else if (result!.status === "rejected") next = "rejeitada";
      else if (result!.status === "denied") next = "denegada";
      else if (result!.status === "processing") next = "processando";
      // NFC-e em contingência offline: vale para o consumidor e o cofre a
      // transmite sozinho; fica em processamento até a SEFAZ autorizar.
      else if (result!.status === "contingency" && com1Model() === "nfce") { next = "processando"; reason = "fiscal_contingency_pending"; }
      // Cancelada diretamente no cofre antes da retomada: o resultado é
      // conclusivo. Registra a autorização e o cancelamento, sem novo pedido.
      else if (result!.status === "cancelled") { next = complete ? "cancelada" : "incerta"; if (!complete) reason = "com1_authorization_incomplete"; }
      else { next = "incerta"; reason = "fiscal_no_conclusive_answer"; }
    } else if (!identityMatches || (result?.status !== "authorized" && result?.status !== "cancelled")) reason = "com1_late_conflicting_evidence";
    const receiptResult = JSON.parse(com1Json({ evidence: entries, status: next })) as JsonObject;
    finishCommand(ctx, command.id, ["autorizada", "rejeitada", "denegada", "cancelada"].includes(next) ? "completed" : "pending", receiptResult, reason ? { code: reason } : null);
    // Nunca substituir a identificação já autorizada, nem por resposta tardia.
    if (!["autorizada", "cancelada", "denegada"].includes(emission.status)) {
      const usable = identityMatches ? result : null;
      ctx.db.exec(`UPDATE ${T.emission} SET status=?,version=version+1,environment_confirmed=?,provider_id=?,provider_status=?,messages=?,series=?,number=?,access_key=?,protocol=?,issued_at=?,authorized_at=?,total=?,updated_at=? WHERE id=?`,
        next, usable ? 1 : Number(emission.environment_confirmed), usable?.provider_ref || emission.provider_id, usable?.status ?? emission.provider_status,
        com1Json(usable?.messages ?? emission.messages), usable && complete ? series : emission.series, usable && complete ? usable.number : emission.number,
        usable && complete ? usable.access_key : emission.access_key, usable && complete ? usable.protocol : emission.protocol,
        usable ? micros(usable.issued_at) : emission.issued_at, usable && complete ? micros(usable.authorized_at) : emission.authorized_at,
        usable?.total != null && Number.isFinite(usable.total) && usable.total >= 0 ? String(Math.round(usable.total * 100)) : emission.total, String(ctx.clock.next()), emission.id);
      if (next === "cancelada") recordExternalCancellation(ctx, command, getStoredEmission(ctx, emission.id), result!.messages);
    }
    appendCom1Audit(ctx, { command, emission, action: "record", before: { status: emission.status }, after: { status: next, evidence_hash: evidenceHash, ...(reason ? { reason } : {}) } });
    return getEmissionView(ctx, emission.id);
  });
}

/** Justificativa local do evento feito fora do ERP: a original fica no cofre. */
export const COM1_EXTERNAL_CANCELLATION_JUSTIFICATION = "Cancelamento feito diretamente no cofre; evento recuperado pela retomada.";
/** A nota foi cancelada no cofre antes de o ERP registrar a autorização. O
 * evento fica "incerto" (sem protocolo/data do evento) e a retomada do
 * cancelamento consulta o cofre pelo mesmo corpo, sem pedir outro cancelamento. */
function recordExternalCancellation(ctx: RpcContext, command: CommandReceipt, emission: StoredEmission, messages: unknown): void {
  if (cancellationRow(ctx, emission.id)) return;
  const body = com1Json({ justificativa: COM1_EXTERNAL_CANCELLATION_JUSTIFICATION }), at = String(ctx.clock.next());
  ctx.db.exec(`INSERT INTO ${T.cancel} (emission_id,justification,body,body_hash,command_id,state,messages,created_at,updated_at) VALUES (?,?,?,?,?,'incerto',?,?,?)`,
    emission.id, COM1_EXTERNAL_CANCELLATION_JUSTIFICATION, body, com1Sha256(body), command.id, com1Json(Array.isArray(messages) ? messages : []), at, at);
  appendCom1Audit(ctx, { command, emission, action: "cancel_external", after: { state: "incerto", status: "cancelada", reason: "com1_cancelled_in_vault" } });
}

/** Único registro por eixo. A implementação de efeitos chama isto na MESMA
 * transação local do posting existente. Não transforma um skip em aplicação
 * implícita e não apaga IDs de efeito concluído. */
export function saveEffect(ctx: RpcContext, effect: EffectView, options: { apply_skipped?: boolean } = {}): EffectView {
  return ctx.db.transaction(() => {
    const emission = getStoredEmission(ctx, effect.emission_id);
    if (!["autorizada", "cancelada"].includes(emission.status)) raise("55000", "com1_effect_requires_authorization");
    const old = getEffects(ctx, effect.emission_id).find(e => e.axis === effect.axis);
    if (old?.compensation_state === "transferido" || effect.compensation_state === "transferido") raise("55000", "com1_effect_transferred");
    if (!["aplicado", "reconhecido", "pendente", "pulado"].includes(effect.state)) raise("22023", "com1_effect_state_invalid");
    const alreadyApplied = !!old && ["aplicado", "reconhecido"].includes(old.state);
    if (old?.state === "pulado" && effect.state !== "pulado" && !options.apply_skipped) raise("40001", "com1_effect_explicit_retry_required");
    if (alreadyApplied && (!["aplicado", "reconhecido"].includes(effect.state) || com1Hash(old!.ids) !== com1Hash(effect.ids) || old!.fingerprint !== effect.fingerprint)) raise("40001", "com1_effect_reconciliation_required");
    if (old?.compensation_state === "revertido" && (effect.compensation_state !== "revertido" || com1Hash(old.compensation_result) !== com1Hash(effect.compensation_result)))
      raise("40001", "com1_effect_compensation_immutable");
    if (["aplicado", "reconhecido"].includes(effect.state) && (!effect.fingerprint || !Object.keys(effect.ids).length)) raise("22023", "com1_effect_ids_required");
    if (!ctx.parts[effect.axis] && !alreadyApplied && (effect.state !== "pulado" || effect.reason !== "part_disabled")) raise("55000", "com1_effect_part_disabled");
    const commandId = effect.compensation_command_id ?? effect.command_id;
    const command = commandId ? getCommand(ctx, commandId) : null;
    if (command && command.emission_id !== effect.emission_id) raise("40001", "fiscal_command_conflict");
    ctx.db.exec(`INSERT INTO ${T.effect} (emission_id,axis,state,origin,ids,fingerprint,reason,responsible_role,person_id,command_id,result,compensation_state,compensation_command_id,compensation_result,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(emission_id,axis) DO UPDATE SET state=excluded.state,origin=excluded.origin,ids=excluded.ids,fingerprint=excluded.fingerprint,reason=excluded.reason,responsible_role=excluded.responsible_role,person_id=excluded.person_id,command_id=excluded.command_id,result=excluded.result,compensation_state=excluded.compensation_state,compensation_command_id=excluded.compensation_command_id,compensation_result=excluded.compensation_result,updated_at=excluded.updated_at`,
      effect.emission_id, effect.axis, effect.state, effect.origin, com1Json(effect.ids), effect.fingerprint, effect.reason, effect.responsible_role, effect.person_id, effect.command_id,
      effect.result ? com1Json(effect.result) : null, effect.compensation_state, effect.compensation_command_id, effect.compensation_result ? com1Json(effect.compensation_result) : null, String(ctx.clock.next()));
    appendCom1Audit(ctx, { command: command ?? undefined, emission, action: effect.compensation_state ? "effect_reverse" : "effect_apply", after: { axis: effect.axis, state: effect.compensation_state ?? effect.state, ...(effect.reason ? { reason: effect.reason } : {}) } });
    return getEffects(ctx, effect.emission_id).find(e => e.axis === effect.axis)!;
  });
}

const cancellationSelect = () => `SELECT *,${instantColumns(["event_at", "created_at", "updated_at"])} FROM ${T.cancel}`;
function cancellationRow(ctx: RpcContext, emissionId: string): Row | null {
  return one(ctx.db, `${cancellationSelect()} WHERE emission_id=?`, emissionId);
}
function cancellationView(row: Row): CancellationView {
  return {
    emission_id: String(row.emission_id), justification: String(row.justification), command_id: String(row.command_id),
    state: row.state as CancellationView["state"], messages: parse(row.messages), protocol: row.protocol as string | null,
    event_at: row.event_at as string | null, repeated: row.repeated === 1,
    xml_status: row.xml_status as CancellationView["xml_status"], xml_hash: row.xml_hash as string | null,
  };
}

/** Reivindica um único evento lógico; timeout conserva justificativa e bytes.
 * A rejeição conclusiva libera outra tentativa auditada no mesmo registro.
 * O slot revalida papel/configuração antes de chamar; aqui não há I/O externo.
 */
export function claimStoredCancellation(ctx: RpcContext, input: CancelClaimInput, leaseMicros = 60_000_000n): CancelClaimResult {
  return ctx.db.transaction(() => {
    const replay = replayCommand(ctx, { command_id: input.command_id, action: "cancel", args: input });
    const emission = getStoredEmission(ctx, input.emission_id);
    let stored = cancellationRow(ctx, emission.id);
    if (replay) {
      if (!stored) raise("55000", "com1_cancellation_missing");
      return { emission, cancellation: cancellationView(stored), command: replay, disposition: "replay" };
    }
    if (typeof input.justification !== "string" || input.justification !== input.justification.trim() ||
        Array.from(input.justification).length < 15 || Array.from(input.justification).length > 255)
      raise("22023", "com1_cancellation_justification_invalid");
    if (emission.version !== input.expected_version) raise("40001", "com1_version_conflict");
    if (emission.connection_fingerprint !== input.connection_fingerprint) raise("40001", "fiscal_connection_changed");
    if (stored?.state === "registrado" && emission.status === "cancelada") {
      const receipt = startCommand(ctx, { command_id: input.command_id, action: "cancel", args: input, emission_id: emission.id,
        body_revision: emission.current_body_revision });
      const command = finishCommand(ctx, receipt.id, "completed", { emission_id: emission.id, state: "registrado", replayed: true });
      appendCom1Audit(ctx, { command, emission, action: "cancel_replay", after: { state: "registrado" } });
      return { emission, cancellation: cancellationView(stored), command, disposition: "replay" };
    }
    // Uma resposta de cancelamento já pode ter encerrado a nota enquanto
    // protocolo/data do evento ainda precisam ser recuperados no cofre.
    if (emission.status !== "autorizada" && !(emission.status === "cancelada" && stored?.state === "incerto"))
      raise("55000", "com1_cancellation_requires_authorization");
    if (leaseMicros <= 0n) raise("22023", "com1_lease_invalid");
    const resuming = !!stored && ["enviando", "incerto"].includes(String(stored.state));
    if (resuming && stored!.justification !== input.justification) raise("40001", "com1_cancellation_resume_required");
    const at = ctx.clock.next();
    const active = one(ctx.db, `${commandSelect()} WHERE emission_id=? AND action='cancel' AND state IN ('claimed','pending') AND token IS NOT NULL AND lease_until>? ORDER BY created_at DESC LIMIT 1`, emission.id, String(at));
    if (active) {
      if (!stored) raise("55000", "com1_cancellation_missing");
      return { emission, cancellation: cancellationView(stored), command: commandRow(active), disposition: "busy" };
    }
    const body = resuming ? String(stored!.body) : com1Json({ justificativa: input.justification });
    const bodyHash = com1Sha256(body);
    const request: JsonObject = { kind: com1Model(), environment: emission.environment, reference: emission.reference,
      connection_fingerprint: emission.connection_fingerprint, provider_id: emission.provider_id, access_key: emission.access_key,
      body_text: body, body_hash: bodyHash };
    const command = startCommand(ctx, { command_id: input.command_id, action: "cancel", args: input, emission_id: emission.id,
      body_revision: emission.current_body_revision, request, claim: { token: randomUUID(), lease_until: String(at + leaseMicros) } });
    const before = stored ? { state: String(stored.state) } : undefined;
    if (stored) {
      ctx.db.exec(`UPDATE ${T.cancel} SET justification=?,body=?,body_hash=?,command_id=?,state='enviando',messages='[]',updated_at=? WHERE emission_id=?`,
        input.justification, body, bodyHash, command.id, String(at), emission.id);
    } else {
      ctx.db.exec(`INSERT INTO ${T.cancel} (emission_id,justification,body,body_hash,command_id,state,created_at,updated_at) VALUES (?,?,?,?,?,'enviando',?,?)`,
        emission.id, input.justification, body, bodyHash, command.id, String(at), String(at));
    }
    ctx.db.exec(`UPDATE ${T.emission} SET version=version+1,updated_at=? WHERE id=?`, String(at), emission.id);
    const current = getStoredEmission(ctx, emission.id);
    appendCom1Audit(ctx, { command, emission: current, action: resuming ? "cancel_resume" : "cancel_claim", before, after: { state: "enviando" } });
    stored = cancellationRow(ctx, emission.id)!;
    return { emission: current, cancellation: cancellationView(stored), command, disposition: resuming ? "resume" : "send" };
  });
}

/** Arquiva apenas XML de evento registrado, conferindo bytes/hash e capacidade.
 * Repetição idêntica não muda o arquivo; XML diferente exige reconciliação.
 */
export function saveCancellationXml(ctx: RpcContext, input: CancellationXmlInput): CancellationView {
  return ctx.db.transaction(() => {
    const command = requireClaimedCommand(ctx, input, ["cancel"]);
    const stored = cancellationRow(ctx, input.emission_id);
    if (!stored || stored.state !== "registrado" || stored.command_id !== command.id) raise("55000", "com1_cancellation_xml_unavailable");
    if (typeof input.xml !== "string" || !input.xml.length || new TextEncoder().encode(input.xml).byteLength > 10 * 1024 * 1024 ||
        com1Sha256(input.xml) !== input.xml_hash) raise("22023", "com1_cancellation_xml_invalid");
    if (stored.xml_status === "disponivel") {
      if (stored.xml !== input.xml || stored.xml_hash !== input.xml_hash) raise("40001", "com1_cancellation_xml_conflict");
      return cancellationView(stored);
    }
    ctx.db.exec(`UPDATE ${T.cancel} SET xml_status='disponivel',xml=?,xml_hash=?,updated_at=? WHERE emission_id=?`,
      input.xml, input.xml_hash, String(ctx.clock.next()), input.emission_id);
    appendCom1Audit(ctx, { command, emission: getStoredEmission(ctx, input.emission_id), action: "cancel_xml_record", after: { evidence_hash: input.xml_hash } });
    return cancellationView(cancellationRow(ctx, input.emission_id)!);
  });
}

/** Persiste o resultado fiscal antes de qualquer compensação. Um cancelamento
 * confirmado sobrevive mesmo quando faltam protocolo/data específicos do
 * evento: nota cancelada, evento incerto e evidência conservada para retomada.
 */
export function recordCancellationEvidence(ctx: RpcContext, input: CancelRecordInput): EmissionView {
  return ctx.db.transaction(() => {
    const command = requireClaimedCommand(ctx, input, ["cancel"]);
    const emission = getStoredEmission(ctx, input.emission_id);
    const stored = cancellationRow(ctx, emission.id);
    if (!stored) raise("55000", "com1_cancellation_missing");
    const result = input.result;
    const evidence = { result, requested_state: input.state, event_protocol: input.event_protocol ?? null,
      event_at: input.event_at ?? null, evidence: input.evidence ?? null, error: input.error ?? null };
    const evidenceHash = com1Hash(evidence);
    const previous = Array.isArray(command.result?.evidence) ? command.result!.evidence : [];
    const entries = previous.some(v => v && typeof v === "object" && !Array.isArray(v) && v.hash === evidenceHash)
      ? previous : [...previous, { hash: evidenceHash, ...evidence }];
    const identityMatches = !!result && input.connection_fingerprint === emission.connection_fingerprint &&
      result.kind === com1Model() && result.environment === emission.environment && result.reference === emission.reference &&
      result.provider_ref === emission.provider_id && result.access_key === emission.access_key;
    const cancelled = identityMatches && result!.status === "cancelled";
    const sameBody = command.request?.body_hash === stored.body_hash;
    const currentCommand = stored.command_id === command.id;
    const validProtocol = typeof input.event_protocol === "string" && input.event_protocol.length > 0 &&
      input.event_protocol.length <= 100 && input.event_protocol.trim() === input.event_protocol && !/[\u0000-\u001f\u007f]/.test(input.event_protocol);
    const validInstant = typeof input.event_at === "string" && /^[1-9][0-9]{0,18}$/.test(input.event_at) && BigInt(input.event_at) <= 9223372036854775807n;
    let state = stored.state as CancellationView["state"], reason: string | null = null;
    if (stored.state === "registrado") {
      if (!cancelled || (input.event_protocol !== undefined && input.event_protocol !== stored.protocol) ||
          (input.event_at !== undefined && input.event_at !== stored.event_at)) reason = "com1_late_conflicting_evidence";
    } else if (cancelled) {
      state = sameBody && validProtocol && validInstant ? "registrado" : "incerto";
      if (!sameBody) reason = "com1_cancellation_body_mismatch";
      else if (state === "incerto") reason = "com1_cancellation_event_incomplete";
    } else if (!currentCommand) {
      reason = "com1_late_cancellation_evidence";
    } else if (input.state === "recusado" && sameBody && input.connection_fingerprint === emission.connection_fingerprint &&
        ((identityMatches && result!.status === "authorized") || (!result && ["fiscal_rejected", "fiscal_invalid_request", "fiscal_cancellation_rejected", "fiscal_event_rejected"].includes(input.error?.code ?? "")))) {
      state = "recusado";
    } else {
      state = "incerto";
      reason = result && !identityMatches ? "com1_evidence_identity_mismatch" : input.error?.code ?? "fiscal_no_conclusive_answer";
    }
    const receipt = JSON.parse(com1Json({ evidence: entries, state, emission_status: cancelled ? "cancelada" : emission.status })) as JsonObject;
    finishCommand(ctx, command.id, ["registrado", "recusado"].includes(state) ? "completed" : "pending", receipt,
      reason ? { code: reason } : null);
    if (stored.state !== "registrado" && (currentCommand || cancelled)) {
      ctx.db.exec(`UPDATE ${T.cancel} SET state=?,messages=?,protocol=?,event_at=?,repeated=?,command_id=?,updated_at=? WHERE emission_id=?`,
        state, com1Json(identityMatches ? result!.messages : parse(stored.messages)),
        state === "registrado" ? input.event_protocol! : stored.protocol,
        state === "registrado" ? input.event_at! : stored.event_at,
        cancelled && result!.event_repeated === true ? 1 : Number(stored.repeated),
        state === "registrado" ? command.id : stored.command_id, String(ctx.clock.next()), emission.id);
      ctx.db.exec(`UPDATE ${T.emission} SET status=?,provider_status=?,version=version+1,updated_at=? WHERE id=?`,
        cancelled ? "cancelada" : emission.status, cancelled ? "cancelled" : emission.provider_status, String(ctx.clock.next()), emission.id);
    }
    appendCom1Audit(ctx, { command, emission, action: "cancel_record", before: { state: String(stored.state), status: emission.status },
      after: { state, status: cancelled ? "cancelada" : emission.status, evidence_hash: evidenceHash, ...(reason ? { reason } : {}) } });
    return getEmissionView(ctx, emission.id);
  });
}
