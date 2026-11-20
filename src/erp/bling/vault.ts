/** Cofre privado da área. Nenhum destes valores é DTO, recibo ou backup do ERP. */
import type { Env } from "../../types.ts";
import { BlingError } from "./contracts.ts";
import type { BlingPrivateCredential } from "./ports.ts";

export interface VaultValue {
  revision: string;
  application: { client_id: string; client_secret: string } | null;
  credential: BlingPrivateCredential | null;
  disconnected: boolean;
}

export interface VaultSnapshot {
  revision: string;
  ciphertext: string | null;
  value: VaultValue;
}

export interface BlingVault {
  read(profile: string): Promise<VaultSnapshot>;
  compareAndSwap(profile: string, previous: VaultSnapshot, next: VaultValue, restoredRevisionFloor?: string): Promise<VaultSnapshot>;
}

/** Injeção para provas sem rede; a montagem usa as primitivas AES-GCM do núcleo. */
export interface VaultCipher {
  seal(value: unknown): Promise<string>;
  unseal(ciphertext: string): Promise<unknown>;
}

type VaultEnvironment = Pick<Env, "DB" | "MASTER_KEY">;
type StoredEnvelope = { format: 1; profile: string; value: VaultValue };

function secretId(profile: string): string {
  if (!profile || profile.length > 256 || profile.trim() !== profile || /[\u0000-\u001f\u007f]/.test(profile))
    throw new BlingError("BLING_RESPONSE_INVALID");
  return `erp-bling:${profile}`;
}

function revision(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 16)
    throw new BlingError("BLING_REVISION_CONFLICT");
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new BlingError("BLING_REVISION_CONFLICT");
  return parsed;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const privateText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 16_384;

/** Reconstrói explicitamente o formato para não custodiar campos extras do provedor. */
function checkedValue(input: unknown): VaultValue {
  if (!isObject(input) || typeof input.disconnected !== "boolean")
    throw new BlingError("BLING_AUTH_REQUIRED");
  revision(input.revision);
  let application: VaultValue["application"] = null;
  if (input.application !== null) {
    if (!isObject(input.application) || !privateText(input.application.client_id) || !privateText(input.application.client_secret))
      throw new BlingError("BLING_AUTH_REQUIRED");
    application = { client_id: input.application.client_id, client_secret: input.application.client_secret };
  }
  let credential: BlingPrivateCredential | null = null;
  if (input.credential !== null) {
    const candidate = input.credential;
    if (!application || !isObject(candidate) || candidate.client_id !== application.client_id || candidate.client_secret !== application.client_secret ||
      !privateText(candidate.access_token) || !privateText(candidate.refresh_token) ||
      typeof candidate.expires_at !== "number" || !Number.isSafeInteger(candidate.expires_at) || candidate.expires_at < 0 ||
      !Array.isArray(candidate.scopes) || candidate.scopes.length > 256 ||
      candidate.scopes.some(scope => typeof scope !== "string" || !scope || scope.length > 256 || /[\u0000-\u001f\u007f]/.test(scope)))
      throw new BlingError("BLING_AUTH_REQUIRED");
    credential = {
      client_id: application.client_id, client_secret: application.client_secret,
      access_token: candidate.access_token, refresh_token: candidate.refresh_token,
      expires_at: candidate.expires_at, scopes: [...new Set(candidate.scopes as string[])],
    };
  }
  if (input.disconnected && (application || credential)) throw new BlingError("BLING_AUTH_REQUIRED");
  return { revision: input.revision as string, application, credential, disconnected: input.disconnected };
}

function empty(): VaultSnapshot {
  return { revision: "0", ciphertext: null, value: { revision: "0", application: null, credential: null, disconnected: false } };
}

/**
 * Não usa setSecret: o upsert incondicional ressuscitaria uma credencial atrasada.
 * O tombstone é uma nova revisão cifrada sem aplicativo/tokens, nunca DELETE.
 * O vínculo à área também fica autenticado dentro do envelope AES-GCM.
 */
export function createBlingVault(env: VaultEnvironment, injectedCipher?: VaultCipher): BlingVault {
  const cipher: VaultCipher = injectedCipher ?? {
    seal: async value => (await import("../../security.ts")).seal(env as Env, value),
    unseal: async ciphertext => (await import("../../security.ts")).unseal(env as Env, ciphertext),
  };

  async function decode(profile: string, ciphertext: string): Promise<VaultValue> {
    try {
      const envelope = await cipher.unseal(ciphertext);
      if (!isObject(envelope) || envelope.format !== 1 || envelope.profile !== profile)
        throw new BlingError("BLING_AUTH_REQUIRED");
      return checkedValue(envelope.value);
    } catch {
      // Exceções de D1/criptografia jamais incorporam ciphertext ou material privado.
      throw new BlingError("BLING_AUTH_REQUIRED");
    }
  }

  return {
    async read(profile) {
      const id = secretId(profile);
      let row: { value: string } | null;
      try { row = await env.DB.prepare("SELECT value FROM secrets WHERE id=?").bind(id).first<{ value: string }>(); }
      catch { throw new BlingError("BLING_AUTH_REQUIRED"); }
      if (!row) return empty();
      const value = await decode(profile, row.value);
      return { revision: value.revision, ciphertext: row.value, value };
    },

    async compareAndSwap(profile, previous, proposed, restoredRevisionFloor) {
      const id = secretId(profile);
      const previousRevision = previous.revision;
      const previousCiphertext = previous.ciphertext;
      const beforeRevision = revision(previousRevision);
      const value = checkedValue(proposed);
      const floor = restoredRevisionFloor === undefined ? beforeRevision : revision(restoredRevisionFloor);
      // Só um tombstone sem material secreto pode reconciliar o contador de
      // um backup restaurado. Credenciais normais sempre incrementam um CAS.
      if (restoredRevisionFloor !== undefined && (!value.disconnected || value.application || value.credential))
        throw new BlingError("BLING_REVISION_CONFLICT");
      if (revision(value.revision) !== (floor > beforeRevision ? floor : beforeRevision) + 1n || previous.value.revision !== previousRevision)
        throw new BlingError("BLING_REVISION_CONFLICT");
      if (previousCiphertext === null) {
        if (beforeRevision !== 0n) throw new BlingError("BLING_REVISION_CONFLICT");
      } else {
        const stored = await decode(profile, previousCiphertext);
        if (stored.revision !== previousRevision) throw new BlingError("BLING_REVISION_CONFLICT");
      }
      let ciphertext: string;
      try { ciphertext = await cipher.seal({ format: 1, profile, value } satisfies StoredEnvelope); }
      catch { throw new BlingError("BLING_AUTH_REQUIRED"); }
      let written: { value: string } | null;
      try {
        written = previousCiphertext === null
          ? await env.DB.prepare("INSERT INTO secrets(id,value) VALUES(?,?) ON CONFLICT(id) DO NOTHING RETURNING value")
            .bind(id, ciphertext).first<{ value: string }>()
          : await env.DB.prepare("UPDATE secrets SET value=? WHERE id=? AND value=? RETURNING value")
            .bind(ciphertext, id, previousCiphertext).first<{ value: string }>();
      } catch {
        // O resultado pode ter sido perdido depois da escrita. O chamador deve
        // reconciliar a revisão; nunca repetir automaticamente o POST OAuth.
        throw new BlingError("BLING_AUTH_REQUIRED");
      }
      if (!written || written.value !== ciphertext) throw new BlingError("BLING_REVISION_CONFLICT");
      return { revision: value.revision, ciphertext, value };
    },
  };
}
