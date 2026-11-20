/** Estado durável de OAuth. Este módulo nunca recebe código, token ou ciphertext.
 * Toda transação é síncrona e escreve somente controle, unidade, recibo e auditoria.
 */
import { one, type Row, type SqlDriver } from "../engine/driver.ts";
import {
  BlingError, type BlingContext, type BlingCredentialPublic, type BlingErrorCode,
  type BlingExpectedState, type BlingLease, type BlingPublicAccount, type BlingReceipt,
} from "./contracts.ts";
import type { BlingOAuthReservation } from "./ports.ts";

export interface AuthControl {
  expected: BlingExpectedState;
  credential: BlingCredentialPublic;
  account: BlingPublicAccount | null;
  enabled: boolean;
  approved: boolean;
  disconnected: boolean;
  state: string;
}
export interface AuthAttempt {
  id: string;
  command_id: string;
  request_hash: string;
  operation: string;
  expected: BlingExpectedState;
  lease: BlingLease;
  allowDisabled: boolean;
}
export interface ConsumedOAuth extends BlingOAuthReservation {
  expected: BlingExpectedState;
  callback_url: string;
}
export interface BeginAuthorization {
  command_id: string;
  request_hash: string;
  operation: string;
  kind: "oauth_exchange" | "oauth_refresh";
  expected: BlingExpectedState;
  lease: BlingLease;
  allowDisabled?: boolean;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const hash = /^[a-f0-9]{64}$/;
const revision = /^(0|[1-9]\d*)$/;
const text = (value: unknown) => String(value ?? "");
const integer = (value: unknown): number => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new BlingError("BLING_RESPONSE_INVALID");
  return result;
};
const nextRevision = (value: unknown): string => {
  const current = integer(value);
  if (current >= Number.MAX_SAFE_INTEGER) throw new BlingError("BLING_REVISION_CONFLICT");
  return String(current + 1);
};
function checkIdentifier(value: string): void {
  if (!identifier.test(value)) throw new BlingError("BLING_RESPONSE_INVALID");
}
function expectedOf(row: Row): BlingExpectedState {
  return {
    generation: text(row.generation), authorization_revision: text(row.authorization_revision),
    credential_revision: text(row.credential_revision), configuration_revision: text(row.configuration_revision ?? row.revision),
    account_id: text(row.account_id), parts_revision: text(row.parts_revision),
  };
}
function sameExpected(a: BlingExpectedState, b: BlingExpectedState): boolean {
  return a.generation === b.generation && a.authorization_revision === b.authorization_revision &&
    a.credential_revision === b.credential_revision && a.configuration_revision === b.configuration_revision && a.account_id === b.account_id;
}
function accountOf(row: Row): BlingPublicAccount | null {
  if (!row.account_id) return null;
  const value = JSON.parse(text(row.account_public)) as Partial<BlingPublicAccount>;
  return { id: text(row.account_id), name: value.name ?? null, confirmed_at: value.confirmed_at ?? null };
}

export class BlingAuthStore {
  private readonly db: SqlDriver;
  readonly profile: string;

  constructor(db: SqlDriver, profile: string) {
    checkIdentifier(profile);
    this.db = db;
    this.profile = profile;
  }

  private area(ctx: BlingContext): void {
    if (ctx.profile !== this.profile) throw new BlingError("BLING_ADMIN_REQUIRED");
    integer(ctx.clock.now());
  }

  private parts(ctx: BlingContext): void {
    this.area(ctx);
    const parts = ctx.identity.partsControl;
    // A montagem deve atualizar este snapshot na revalidação assíncrona, também
    // para o alarme. Um envelope antigo não concede autorização indefinidamente.
    if (!ctx.identity.parts?.customers || !parts || parts.profile !== this.profile ||
      parts.expires_at <= ctx.clock.now() || !revision.test(parts.revision)) throw new BlingError("BLING_DISABLED");
  }

  private row(ctx: BlingContext): Row {
    this.area(ctx);
    this.db.exec("INSERT INTO wb_bling_control(id, updated_at) VALUES (1, ?) ON CONFLICT(id) DO NOTHING", ctx.clock.now());
    return one(this.db, "SELECT * FROM wb_bling_control WHERE id = 1")!;
  }

  control(ctx: BlingContext): AuthControl {
    const row = this.row(ctx);
    const expires = row.credential_expires_at === null ? null : integer(row.credential_expires_at);
    return {
      expected: { ...expectedOf(row), parts_revision: ctx.identity.partsControl?.revision ?? "" },
      credential: {
        configured: row.app_configured === 1, authorized: row.credential_status === "ready" && expires !== null && expires > ctx.clock.now(),
        revision: text(row.credential_revision), expires_at: expires,
        scopes: JSON.parse(text(row.credential_scopes)) as string[], uncertain: row.credential_status === "uncertain",
      },
      account: accountOf(row), enabled: row.collect_enabled === 1,
      approved: row.approved_by !== null && row.approved_at !== null && row.approval_hash !== null,
      disconnected: row.credential_status === "disconnected",
      state: text(row.state),
    };
  }

  assert(ctx: BlingContext, expected: BlingExpectedState, options: { enabled?: boolean } = {}): AuthControl {
    this.parts(ctx);
    const current = this.control(ctx);
    if (current.expected.generation !== expected.generation) throw new BlingError("BLING_GENERATION_RETIRED");
    if (!sameExpected(current.expected, expected) || current.expected.parts_revision !== expected.parts_revision) throw new BlingError("BLING_REVISION_CONFLICT");
    if (current.state === "purging") throw new BlingError("BLING_GENERATION_RETIRED");
    if (options.enabled !== false && (!current.enabled || !current.approved)) throw new BlingError("BLING_DISABLED");
    return current;
  }

  reserveOAuth(ctx: BlingContext, input: BlingOAuthReservation, callbackUrl: string): void {
    this.db.transaction(() => {
      const current = this.control(ctx);
      this.assert(ctx, current.expected);
      const actor = ctx.identity.actor;
      if (!actor || actor.erp_role !== "admin" || actor.session_id !== input.session_id || actor.user_id !== input.actor_id) throw new BlingError("BLING_ADMIN_REQUIRED");
      if (input.config_revision !== current.expected.configuration_revision || input.generation !== current.expected.generation) throw new BlingError("BLING_REVISION_CONFLICT");
      checkIdentifier(input.command_id);
      if (!hash.test(input.state_hash) || !hash.test(input.browser_hash) || input.expires_at <= ctx.clock.now() ||
        input.expires_at > ctx.clock.now() + 600_000 || !Number.isSafeInteger(input.expires_at)) throw new BlingError("BLING_RESPONSE_INVALID");
      if (one(this.db, "SELECT id FROM wb_bling_unit WHERE command_id = ?", input.command_id) ||
        one(this.db, "SELECT command_id FROM wb_bling_receipt WHERE command_id = ?", input.command_id)) throw new BlingError("BLING_COMMAND_CONFLICT");
      const now = ctx.clock.now();
      this.db.exec(`INSERT INTO wb_bling_unit
        (id, attempt_id, command_id, request_hash, generation, authorization_revision, credential_revision,
         configuration_revision, account_id, parts_revision, kind, phase, plan, not_before,
         state_hash, browser_hash, profile, session_id, actor_id, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'oauth_state', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(), crypto.randomUUID(), input.command_id, ctx.authorization?.request_hash ?? input.state_hash, input.generation,
      current.expected.authorization_revision, current.expected.credential_revision, input.config_revision,
      current.account?.id ?? null, current.expected.parts_revision, JSON.stringify({ operation: "erp_bling_oauth_start", callback_url: callbackUrl }), now,
      input.state_hash, input.browser_hash, this.profile, input.session_id, input.actor_id, input.expires_at, now, now);
      this.audit(ctx, "erp_bling_oauth_start", input.command_id, current.expected, current.expected.configuration_revision, null);
    });
  }

  consumeOAuth(ctx: BlingContext, input: { state_hash: string; browser_hash: string; session_id: string }, callbackUrl: string): ConsumedOAuth {
    return this.db.transaction(() => {
      this.parts(ctx);
      if (!hash.test(input.state_hash) || !hash.test(input.browser_hash)) throw new BlingError("BLING_AUTH_REQUIRED");
      const row = one(this.db, "SELECT * FROM wb_bling_unit WHERE kind = 'oauth_state' AND state_hash = ?", input.state_hash);
      const actor = ctx.identity.actor;
      if (!row || row.phase !== "queued" || row.consumed_at !== null || integer(row.expires_at) <= ctx.clock.now() ||
        row.browser_hash !== input.browser_hash || row.profile !== this.profile || row.session_id !== input.session_id ||
        !actor || actor.erp_role !== "admin" || actor.session_id !== input.session_id || actor.user_id !== row.actor_id) throw new BlingError("BLING_AUTH_REQUIRED");
      const expected = expectedOf(row);
      this.assert(ctx, expected);
      const plan = JSON.parse(text(row.plan)) as { callback_url: string };
      if (plan.callback_url !== callbackUrl) throw new BlingError("BLING_AUTH_REQUIRED");
      const now = ctx.clock.now();
      this.db.exec("UPDATE wb_bling_unit SET consumed_at = ?, phase = 'committed', finished_at = ?, updated_at = ? WHERE id = ? AND consumed_at IS NULL AND phase = 'queued'", now, now, now, row.id);
      this.audit(ctx, "erp_bling_oauth_callback", text(row.command_id), expected, expected.configuration_revision, null);
      return {
        command_id: text(row.command_id), state_hash: text(row.state_hash), browser_hash: text(row.browser_hash),
        session_id: text(row.session_id), actor_id: text(row.actor_id), config_revision: expected.configuration_revision,
        generation: expected.generation, expires_at: integer(row.expires_at), expected, callback_url: plan.callback_url,
      };
    });
  }

  receipt(ctx: BlingContext, commandId: string, requestHash: string): BlingReceipt | null {
    this.area(ctx);
    const row = one(this.db, "SELECT * FROM wb_bling_receipt WHERE command_id = ?", commandId);
    if (!row) return null;
    if (row.request_hash !== requestHash) throw new BlingError("BLING_COMMAND_CONFLICT");
    return JSON.parse(text(row.result)) as BlingReceipt;
  }

  /** Recuperação nunca repete uma troca possivelmente concluída no provedor. */
  recoverExpired(ctx: BlingContext): void {
    this.db.transaction(() => {
      this.area(ctx);
      const rows = this.db.exec("SELECT * FROM wb_bling_unit WHERE kind IN ('oauth_exchange','oauth_refresh') AND phase IN ('reserved','fetching') AND lease_until <= ?", ctx.clock.now()).rows;
      for (const row of rows) this.fail(ctx, this.attemptOf(row), "BLING_AUTH_REQUIRED", row.phase === "fetching");
    });
  }

  begin(ctx: BlingContext, input: BeginAuthorization): { attempt: AuthAttempt | null; receipt: BlingReceipt | null } {
    // Persiste a recuperação mesmo quando o novo pedido é recusado depois.
    this.recoverExpired(ctx);
    return this.db.transaction(() => {
      this.area(ctx);
      checkIdentifier(input.command_id);
      checkIdentifier(input.operation);
      if (!hash.test(input.request_hash) || !input.lease.owner || !input.lease.fence || input.lease.owner.length > 200 ||
        input.lease.fence.length > 128 || !Number.isSafeInteger(input.lease.expires_at) || input.lease.expires_at <= ctx.clock.now()) throw new BlingError("BLING_RESPONSE_INVALID");
      const replay = this.receipt(ctx, input.command_id, input.request_hash);
      if (replay) {
        if (replay.operation !== input.operation) throw new BlingError("BLING_COMMAND_CONFLICT");
        return { attempt: null, receipt: replay };
      }
      const current = this.assert(ctx, input.expected, { enabled: !input.allowDisabled });
      const previous = one(this.db, "SELECT * FROM wb_bling_unit WHERE command_id = ?", input.command_id);
      if (previous) {
        if (previous.request_hash !== input.request_hash || previous.kind !== input.kind || this.attemptOf(previous).operation !== input.operation) throw new BlingError("BLING_COMMAND_CONFLICT");
        // Uma segunda execução JavaScript não herda a posse só por apresentar
        // o mesmo dono/fence: a primeira pode estar aguardando o cofre. Após
        // expiração, recoverExpired encerra explicitamente exigindo autorização.
        throw new BlingError("BLING_LEASE_LOST");
      }
      const held = one(this.db, "SELECT id FROM wb_bling_unit WHERE kind IN ('oauth_exchange','oauth_refresh') AND phase IN ('reserved','fetching') AND lease_until > ? LIMIT 1", ctx.clock.now());
      if (held) throw new BlingError("BLING_LEASE_LOST");
      if (input.kind === "oauth_refresh" && current.credential.uncertain) throw new BlingError("BLING_AUTH_REQUIRED");
      const attempt: AuthAttempt = { id: crypto.randomUUID(), command_id: input.command_id, request_hash: input.request_hash,
        operation: input.operation, expected: { ...input.expected }, lease: { ...input.lease }, allowDisabled: input.allowDisabled === true };
      const now = ctx.clock.now();
      this.db.exec(`INSERT INTO wb_bling_unit
        (id, attempt_id, command_id, request_hash, generation, authorization_revision, credential_revision,
         configuration_revision, account_id, parts_revision, kind, phase, plan, owner, fence, lease_until,
         not_before, profile, actor_id, session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      attempt.id, crypto.randomUUID(), attempt.command_id, attempt.request_hash, input.expected.generation,
      input.expected.authorization_revision, input.expected.credential_revision, input.expected.configuration_revision,
      input.expected.account_id || null, input.expected.parts_revision, input.kind,
      JSON.stringify({ operation: input.operation, allow_disabled: attempt.allowDisabled }),
      input.lease.owner, input.lease.fence, input.lease.expires_at, now, this.profile, ctx.identity.actor?.user_id ?? null,
      ctx.identity.actor?.session_id ?? null, now, now);
      return { attempt, receipt: null };
    });
  }

  private attemptOf(row: Row): AuthAttempt {
    const plan = JSON.parse(text(row.plan)) as { operation: string; allow_disabled: boolean };
    return { id: text(row.id), command_id: text(row.command_id), request_hash: text(row.request_hash), operation: plan.operation,
      expected: expectedOf(row), lease: { owner: text(row.owner), fence: text(row.fence), expires_at: integer(row.lease_until) }, allowDisabled: plan.allow_disabled === true };
  }

  assertAttempt(ctx: BlingContext, attempt: AuthAttempt, enabled = true): void {
    this.assert(ctx, attempt.expected, { enabled });
    const row = one(this.db, "SELECT * FROM wb_bling_unit WHERE id = ?", attempt.id);
    if (!row || !["reserved", "fetching"].includes(text(row.phase)) || row.owner !== attempt.lease.owner ||
      row.fence !== attempt.lease.fence || integer(row.lease_until) <= ctx.clock.now() || row.command_id !== attempt.command_id ||
      row.request_hash !== attempt.request_hash || !sameExpected(expectedOf(row), attempt.expected)) throw new BlingError("BLING_LEASE_LOST");
  }

  markFetching(ctx: BlingContext, attempt: AuthAttempt): void {
    this.db.transaction(() => {
      this.assertAttempt(ctx, attempt, !attempt.allowDisabled);
      const row = one(this.db, "SELECT phase FROM wb_bling_unit WHERE id = ?", attempt.id)!;
      if (row.phase !== "reserved") throw new BlingError("BLING_AUTH_REQUIRED");
      this.db.exec("UPDATE wb_bling_unit SET phase = 'fetching', updated_at = ? WHERE id = ?", ctx.clock.now(), attempt.id);
      // A incerteza é durável ANTES do POST. Se o processo cair após rotação,
      // até uma supersessão feita por desligar em outra operação conserva esta
      // proibição de reutilizar a credencial. Só finish, após CAS confirmado,
      // publica novamente ready; a posse vigente distingue chamada em curso.
      this.db.exec("UPDATE wb_bling_control SET credential_status = 'uncertain', updated_at = ? WHERE id = 1", ctx.clock.now());
    });
  }

  finish(ctx: BlingContext, attempt: AuthAttempt, input: { credential: BlingCredentialPublic; account: BlingPublicAccount | null; appChanged?: boolean; references?: Record<string, string> }): BlingReceipt {
    return this.db.transaction(() => {
      const replay = this.receipt(ctx, attempt.command_id, attempt.request_hash);
      if (replay) return replay;
      this.assertAttempt(ctx, attempt, !attempt.allowDisabled);
      const current = this.control(ctx);
      const credential = input.credential;
      const unit = one(this.db, "SELECT kind FROM wb_bling_unit WHERE id = ?", attempt.id)!;
      // D1 pode ter confirmado custódia enquanto a confirmação SQLite se perdeu.
      // Uma NOVA autorização comprovada substitui esse resultado incerto e pode
      // avançar mais de uma revisão. Renovação continua exigindo o próximo CAS.
      const validRevision = revision.test(credential.revision) && Number.isSafeInteger(Number(credential.revision)) &&
        (unit.kind === "oauth_refresh" ? credential.revision === nextRevision(current.expected.credential_revision) :
          integer(credential.revision) > integer(current.expected.credential_revision));
      if (!validRevision || credential.uncertain ||
        credential.scopes.some(scope => typeof scope !== "string" || scope.length > 200) || credential.scopes.length > 100 ||
        credential.authorized && (!credential.configured || !credential.expires_at || credential.expires_at <= ctx.clock.now() || !input.account?.confirmed_at)) throw new BlingError("BLING_RESPONSE_INVALID");
      if (input.account && (current.account && current.account.id !== input.account.id)) throw new BlingError("BLING_ACCOUNT_MISMATCH");
      if (input.account) checkIdentifier(input.account.id);
      const account = input.account ? { id: input.account.id, name: input.account.name, confirmed_at: input.account.confirmed_at } : current.account;
      const configRevision = input.appChanged ? nextRevision(current.expected.configuration_revision) : current.expected.configuration_revision;
      const authRevision = input.appChanged ? nextRevision(current.expected.authorization_revision) : current.expected.authorization_revision;
      const now = ctx.clock.now();
      this.db.exec(`UPDATE wb_bling_control SET revision = ?, authorization_revision = ?, credential_revision = ?,
        app_configured = ?, credential_status = ?, credential_expires_at = ?, credential_scopes = ?, account_id = ?, account_public = ?,
        state = CASE WHEN collect_enabled = 0 THEN 'off' WHEN ? = 1 THEN 'ready' ELSE 'needs_authorization' END, updated_at = ? WHERE id = 1`,
      configRevision, authRevision, credential.revision, credential.configured ? 1 : 0, credential.authorized ? "ready" : "missing",
      credential.expires_at, JSON.stringify(credential.scopes), account?.id ?? null, JSON.stringify(account ?? {}), credential.authorized ? 1 : 0, now);
      const receipt = this.writeReceipt(ctx, attempt, "committed", null, { ...input.references, credential_revision: credential.revision, configuration_revision: configRevision,
        ...(input.appChanged ? { revision: configRevision } : {}) });
      this.db.exec("UPDATE wb_bling_unit SET phase = 'committed', finished_at = ?, updated_at = ? WHERE id = ?", now, now, attempt.id);
      this.audit(ctx, attempt.operation, attempt.command_id, attempt.expected, configRevision, null);
      return receipt;
    });
  }

  fail(ctx: BlingContext, attempt: AuthAttempt, code: BlingErrorCode, uncertain: boolean): void {
    this.db.transaction(() => {
      this.area(ctx);
      const row = one(this.db, "SELECT * FROM wb_bling_unit WHERE id = ?", attempt.id);
      if (!row || row.phase === "committed" || row.owner !== attempt.lease.owner || row.fence !== attempt.lease.fence) return;
      const current = this.control(ctx);
      const now = ctx.clock.now();
      // Desligar ou editar configuração invalida o commit, mas o provedor pode
      // já ter rotacionado o refresh token. A mesma credencial deve permanecer
      // incerta mesmo com outra revisão de autorização/configuração; ligar de
      // novo não autoriza repetir esse refresh consumido. Nova credencial,
      // desconexão, conta ou geração diferente nunca recebem o efeito tardio.
      const sameCredential = current.expected.generation === attempt.expected.generation &&
        current.expected.credential_revision === attempt.expected.credential_revision &&
        current.expected.account_id === attempt.expected.account_id;
      if (uncertain && sameCredential && !current.disconnected && current.state !== "purging") {
        this.db.exec("UPDATE wb_bling_control SET credential_status = 'uncertain', state = CASE WHEN collect_enabled = 1 THEN 'needs_authorization' ELSE 'off' END, updated_at = ? WHERE id = 1", now);
      }
      // Desligar pode já ter encerrado a unidade durante o POST. Seu terminal e
      // recibo permanecem imutáveis; a incerteza da credencial acima ainda vale.
      if (row.phase === "superseded") return;
      this.db.exec("UPDATE wb_bling_unit SET phase = 'superseded', error_code = ?, finished_at = ?, updated_at = ? WHERE id = ?", code, now, now, attempt.id);
      this.writeReceipt(ctx, attempt, "rejected", code, {});
      this.audit(ctx, attempt.operation, attempt.command_id, attempt.expected, current.expected.configuration_revision, code);
    });
  }

  invalidate(ctx: BlingContext, expected: BlingExpectedState): AuthControl {
    return this.db.transaction(() => {
      this.assert(ctx, expected, { enabled: false });
      const now = ctx.clock.now();
      this.db.exec(`UPDATE wb_bling_control SET revision = ?, authorization_revision = ?, collect_enabled = 0, state = 'off',
        credential_status = 'disconnected', app_configured = 0, credential_expires_at = NULL, credential_scopes = '[]', updated_at = ? WHERE id = 1`,
      nextRevision(expected.configuration_revision), nextRevision(expected.authorization_revision), now);
      // A intenção de desconexão vence primeiro. Libera imediatamente as posses
      // anteriores sem que uma resposta atrasada possa confirmar ou reativar.
      const pending = this.db.exec("SELECT * FROM wb_bling_unit WHERE kind IN ('oauth_exchange','oauth_refresh') AND phase IN ('reserved','fetching')").rows;
      for (const row of pending) this.fail(ctx, this.attemptOf(row), "BLING_REVISION_CONFLICT", false);
      this.audit(ctx, "erp_bling_disconnect", null, expected, nextRevision(expected.configuration_revision), null);
      return this.control(ctx);
    });
  }

  finalizeDisconnect(ctx: BlingContext, authorizationRevision: string, credentialRevision: string): void {
    this.db.transaction(() => {
      this.area(ctx);
      const current = this.control(ctx);
      if (current.expected.authorization_revision !== authorizationRevision || current.state !== "off" || current.credential.configured ||
        !revision.test(credentialRevision) || integer(credentialRevision) <= integer(current.expected.credential_revision)) throw new BlingError("BLING_REVISION_CONFLICT");
      this.db.exec("UPDATE wb_bling_control SET credential_revision = ?, updated_at = ? WHERE id = 1", credentialRevision, ctx.clock.now());
    });
  }

  /** Apenas a reconfiguração administrativa pode reconciliar um restore.
   * Não preserva aprovação, acesso ou escopos da credencial anterior. */
  reconcileRestoredRevision(ctx: BlingContext, expected: BlingExpectedState, credentialRevision: string): void {
    this.db.transaction(() => {
      const state = this.assert(ctx, expected, { enabled: false });
      if (state.enabled || state.approved || state.credential.configured || integer(credentialRevision) <= integer(expected.credential_revision))
        throw new BlingError("BLING_REVISION_CONFLICT");
      this.db.exec("UPDATE wb_bling_control SET credential_revision=?,credential_status='disconnected',app_configured=0,credential_expires_at=NULL,credential_scopes='[]',updated_at=? WHERE id=1", credentialRevision, ctx.clock.now());
      this.audit(ctx, "erp_bling_restore_credential_reset", null, expected, expected.configuration_revision, null);
    });
  }

  private writeReceipt(ctx: BlingContext, attempt: AuthAttempt, state: BlingReceipt["state"], code: BlingErrorCode | null, references: Record<string, string>): BlingReceipt {
    const receipt: BlingReceipt = { command_id: attempt.command_id, request_hash: attempt.request_hash, generation: attempt.expected.generation,
      operation: attempt.operation, state, committed_at: new Date(ctx.clock.now()).toISOString(), references, counts: {}, error: code ? new BlingError(code).toJSON() : null };
    this.db.exec(`INSERT INTO wb_bling_receipt(command_id, operation, request_hash, generation, unit_id, state, result, references_json, error_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, receipt.command_id, receipt.operation, receipt.request_hash, receipt.generation,
    attempt.id, state, JSON.stringify(receipt), JSON.stringify(references), code, ctx.clock.now());
    return receipt;
  }

  private audit(ctx: BlingContext, operation: string, commandId: string | null, expected: BlingExpectedState, after: string, code: BlingErrorCode | null): void {
    this.db.exec(`INSERT INTO wb_bling_audit(id, actor_id, operation, command_id, generation, revision_before, revision_after, code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, crypto.randomUUID(), ctx.identity.actor?.user_id ?? "system", operation, commandId,
    expected.generation, expected.configuration_revision, after, code, ctx.clock.now());
  }
}
