// Credenciais de módulo trocadas por QR (docs/MODULOS.md, "Credencial por
// QR"; migração 0076). O mínimo para quem não tem login (o entregador avulso
// da Entrega):
//
//   1. A equipe gera um QR para um registro do módulo (`subject`, a entrega):
//      issueClaim devolve o endereço `<origem>/c/<código>`; só o hash fica.
//   2. O app lê o QR e troca o código, uma vez só, em POST /api/credentials/claim
//      (fora de /api/v1, sem login, limite por IP). O Coordinator da área grava
//      a leitura e chama o gancho do módulo (onCredentialClaim), que pode recusar.
//   3. O app usa `Authorization: Bearer wabx_…`. O ator só alcança as rotas
//      do módulo (/api/v1/profiles/<área>/<rota do módulo>/…), sem escopos;
//      o módulo confere `actor.credential.subject` em cada rota.
//   4. Prazo curto (ttl_minutes depois da leitura) e revogada pelo módulo
//      quando o registro termina; o app recebe 401 e volta à primeira tela.
//
// Um QR novo para o mesmo registro revoga o anterior e a credencial ativa.
import { all, exec, one } from "./db";
import { ApiError, type Actor, type Env, now, requireValue, uid } from "./types";
import { sha } from "./security";
import { newWebStepCode, publicOrigin } from "./web-steps";

export const CREDENTIAL_PREFIX = "wabx_";
export const CLAIM_PATH = "/c/";
/** Código do QR: dois códigos do passo web (~186 bits). */
export const claimCode = /^[2-9A-HJ-NP-Za-km-np-z]{32}$/;

export interface CredentialView {
  id: string;
  module_id: string;
  subject: string;
  status: "issued" | "active" | "revoked" | "expired";
  label: string;
  device: string;
  claim_expires_at: number;
  expires_at: number | null;
  claimed_at: number | null;
  revoked_at: number | null;
  revoked_reason: string | null;
  created_by: string;
  created: number;
}

export function credentialView(row: any): CredentialView {
  const at = now();
  const status =
    row.status === "issued" && row.claim_expires <= at
      ? "expired"
      : row.status === "active" && row.expires && row.expires <= at
        ? "expired"
        : row.status;
  return {
    id: row.id,
    module_id: row.module_id,
    subject: row.subject,
    status,
    label: row.label,
    device: row.device,
    claim_expires_at: row.claim_expires,
    expires_at: row.expires,
    claimed_at: row.claimed_at,
    revoked_at: row.revoked_at,
    revoked_reason: row.revoked_reason,
    created_by: row.created_by,
    created: row.created,
  };
}

export async function revokeCredentials(
  env: Env,
  profile: string,
  module: string,
  subject: string,
  reason: string,
) {
  const result = await exec(
    env,
    "UPDATE module_credentials SET status='revoked',revoked_at=?,revoked_reason=? WHERE profile_id=? AND module_id=? AND subject=? AND status IN ('issued','active')",
    now(),
    reason.slice(0, 200),
    profile,
    module,
    subject,
  );
  return result.meta?.changes || 0;
}

/** Gera o QR de um registro; revoga o QR e a credencial anteriores. */
export async function issueClaim(
  env: Env,
  input: {
    profile: string;
    module: string;
    subject: string;
    actor: string;
    claimMinutes: number;
    ttlMinutes: number;
  },
) {
  const origin = await publicOrigin(env);
  if (!origin)
    throw new ApiError(
      409,
      "origin_unknown",
      "O endereço público desta instalação ainda não é conhecido. Abra o painel pelo endereço usado pelos clientes e tente de novo.",
    );
  requireValue(
    input.claimMinutes >= 5 && input.claimMinutes <= 1440,
    "Validade do QR: de 5 a 1440 minutos.",
  );
  requireValue(
    input.ttlMinutes >= 15 && input.ttlMinutes <= 720,
    "Validade da credencial: de 15 a 720 minutos.",
  );
  await revokeCredentials(
    env,
    input.profile,
    input.module,
    input.subject,
    "Substituída por um QR novo.",
  );
  const id = uid(),
    code = newWebStepCode() + newWebStepCode(),
    at = now();
  await exec(
    env,
    "INSERT INTO module_credentials(id,profile_id,module_id,subject,status,claim_hash,claim_expires,ttl_minutes,created_by,created) VALUES(?,?,?,?,'issued',?,?,?,?,?)",
    id,
    input.profile,
    input.module,
    input.subject,
    await sha(code),
    at + input.claimMinutes * 60000,
    input.ttlMinutes,
    input.actor,
    at,
  );
  return {
    id,
    url: origin + CLAIM_PATH + code,
    claim_expires_at: at + input.claimMinutes * 60000,
  };
}

export async function credentialsFor(
  env: Env,
  profile: string,
  module: string,
  subject: string,
) {
  return (
    await all(
      env,
      "SELECT * FROM module_credentials WHERE profile_id=? AND module_id=? AND subject=? ORDER BY created DESC LIMIT 20",
      profile,
      module,
      subject,
    )
  ).map(credentialView);
}

/** Área do código, para levar a leitura ao Coordinator certo. */
export async function claimOwner(env: Env, code: unknown) {
  if (typeof code !== "string" || !claimCode.test(code)) return null;
  return one(
    env,
    "SELECT * FROM module_credentials WHERE claim_hash=?",
    await sha(code),
  );
}

const clean = (value: unknown, max: number) =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max)
    : "";

/**
 * Lê o QR (uso único): grava quem leu e gera o token. Roda no Coordinator da
 * área; o chamador passa o gancho do módulo, que valida e devolve os dados
 * da resposta. Erro no gancho desfaz a leitura (o QR continua valendo).
 */
export async function claim(
  env: Env,
  input: { code: string; name: unknown; device: unknown; ip: string },
  hook: (row: any) => Promise<any>,
) {
  const row = await claimOwner(env, input.code);
  if (!row) throw new ApiError(404, "claim_not_found", "QR inválido.");
  const name = clean(input.name, 60);
  requireValue(name.length >= 2, "Informe o seu nome (name).");
  const at = now();
  if (row.status !== "issued")
    throw new ApiError(
      410,
      "claim_used",
      row.status === "active"
        ? "Este QR já foi lido em outro aparelho. Peça à loja um QR novo."
        : "Este QR não vale mais. Peça à loja um QR novo.",
    );
  if (row.claim_expires <= at)
    throw new ApiError(410, "claim_expired", "Este QR venceu. Peça à loja um QR novo.");
  const token =
    CREDENTIAL_PREFIX +
    [...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  const expires = at + row.ttl_minutes * 60000;
  const done = await exec(
    env,
    "UPDATE module_credentials SET status='active',token_hash=?,expires=?,label=?,device=?,claimed_ip_hash=?,claimed_at=? WHERE id=? AND status='issued'",
    await sha(token),
    expires,
    name,
    clean(input.device, 80),
    await sha(input.ip || "local"),
    at,
    row.id,
  );
  if (!done.meta?.changes)
    throw new ApiError(410, "claim_used", "Este QR já foi lido em outro aparelho.");
  const fresh = await one(env, "SELECT * FROM module_credentials WHERE id=?", row.id);
  try {
    const data = await hook(fresh);
    return {
      token,
      expires_at: expires,
      profile: row.profile_id,
      module: row.module_id,
      subject: row.subject,
      credential_id: row.id,
      data,
    };
  } catch (error) {
    await exec(
      env,
      "UPDATE module_credentials SET status='issued',token_hash=NULL,expires=NULL,label='',device='',claimed_ip_hash=NULL,claimed_at=NULL WHERE id=?",
      row.id,
    );
    throw error;
  }
}

/** Ator da credencial (Authorization: Bearer wabx_…), ou null. */
export async function credentialActor(
  env: Env,
  token: string,
): Promise<Actor | null> {
  const row = await one(
    env,
    "SELECT * FROM module_credentials WHERE token_hash=? AND status='active' AND expires>?",
    await sha(token),
    now(),
  );
  if (!row) return null;
  return {
    id: `cred:${row.id}`,
    kind: "app",
    name: row.label,
    role: "service",
    profiles: [row.profile_id],
    scopes: [],
    bots: [],
    expiresAt: row.expires,
    rate: 120,
    runLimit: 0,
    credential: { id: row.id, module: row.module_id, subject: row.subject },
  };
}
