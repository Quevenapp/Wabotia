import { scryptSync, timingSafeEqual } from "node:crypto";
import {
  batch,
  exec,
  hasReadCache,
  MODULE_STATES_SQL,
  one,
  seedAll,
} from "./db";
import { ApiError, type Env, type Actor, uid, now, json } from "./types";
import {
  MFA_POLICY_COLUMN,
  mfaPolicy,
  mfaPolicyOf,
  requireSchedule,
  sessionAal,
} from "./mfa";
import { CREDENTIAL_PREFIX, credentialActor } from "./module-credentials";
const enc = new TextEncoder();
export const hex = (b: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(b))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
export const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export async function sha(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}
export function passwordHash(password: string, salt = random()) {
  if (typeof password !== "string")
    throw new ApiError(400, "weak_password", "Informe uma senha.");
  if (password.length < 12 || password.length > 256)
    throw new ApiError(
      400,
      "weak_password",
      "Use uma senha entre 12 e 256 caracteres.",
    );
  return `${salt}:${scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex")}`;
}
export function passwordVerify(password: string, stored: string) {
  try {
    const [salt, hash] = stored.split(":");
    if (password.length > 256) return false;
    const actual = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
    return timingSafeEqual(actual, Buffer.from(hash, "hex"));
  } catch {
    return false;
  }
}
// Fixed scrypt hash of an unknown password: logins for e-mails that do not
// exist run the same key derivation as real accounts, so response time does
// not reveal which e-mails are registered.
const DUMMY_PASSWORD_HASH =
  "67c91b3aa4dd3fe9c74836224e16f8a143c88887bc0525bb173392966dc94ec4:c035d6c1ac69cfec4881e94f578eeb46a439fc47cf16df672dbd1347d22e192e";
export function passwordMatches(
  password: string,
  stored: string | null | undefined,
) {
  const verified = passwordVerify(password, stored || DUMMY_PASSWORD_HASH);
  return !!stored && verified;
}
async function key(env: Env) {
  if (!env.MASTER_KEY || env.MASTER_KEY.length < 32)
    throw new ApiError(
      503,
      "setup_required",
      "Configure MASTER_KEY nos secrets do Worker.",
    );
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", enc.encode(env.MASTER_KEY)),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(env: Env, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(env),
    enc.encode(JSON.stringify(value)),
  );
  return JSON.stringify({
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(data)),
  });
}
export async function unseal(env: Env, value: string) {
  const row = JSON.parse(value);
  return JSON.parse(
    new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(row.iv) },
        await key(env),
        new Uint8Array(row.data),
      ),
    ),
  );
}
export async function setSecret(env: Env, id: string, value: unknown) {
  await exec(
    env,
    "INSERT INTO secrets(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
    id,
    await seal(env, value),
  );
}
export async function secret(env: Env, id: string) {
  const row = await one(env, "SELECT value FROM secrets WHERE id=?", id);
  return row ? unseal(env, row.value) : {};
}
export async function hmac(secret: string, body: string) {
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(body)));
}
export function equal(a: string, b: string) {
  const aa = enc.encode(a),
    bb = enc.encode(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export async function rate(
  env: Env,
  key: string,
  limit: number,
  period = 60000,
) {
  const bucket = Math.floor(now() / period);
  const result = await one(
    env,
    "INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
    `${key}:${bucket}`,
    now() + period,
  );
  if (result.count > limit)
    throw new ApiError(
      429,
      "rate_limited",
      "Limite de requisições atingido. Aguarde antes de repetir.",
    );
}
export function canProfile(actor: Actor, id: string) {
  return actor.role === "admin" || actor.profiles.includes(id);
}
export function access(actor: Actor, profile: string, scope: string) {
  if (!canProfile(actor, profile))
    throw new ApiError(404, "not_found", "Área de atendimento não encontrada.");
  if (actor.kind === "app" && !actor.scopes.includes(scope))
    throw new ApiError(403, "missing_scope", `Permissão necessária: ${scope}`);
}
/**
 * Ator do motor de atendimento (src/engine.ts): o que cria a execução do bot
 * para uma mensagem de cliente e manda o menu. Sem privilégio: aplicação da
 * própria área, só `bots:invoke`, só o bot daquela execução. Até a 0.21.0 era
 * `kind:"user"` com `role:"admin"`; nenhum caminho levava esse ator a uma
 * operação (revisão A do PLANO-BOTS), mas a primeira chamada nova que o
 * passasse a `perform`, a um módulo ou ao ERP herdaria administrador pleno.
 * `refuseEngineActor` fecha essas portas de vez.
 */
export const ENGINE_ACTOR_ID = "bot:attendant";
export function engineActor(profile: string, botId: string): Actor {
  return {
    id: ENGINE_ACTOR_ID,
    kind: "app",
    name: "Atendente",
    role: "service",
    profiles: [profile],
    scopes: ["bots:invoke"],
    bots: [botId],
    rate: 100,
    runLimit: 100,
  };
}
export const isEngineActor = (actor: Actor) => actor.id === ENGINE_ACTOR_ID;
/**
 * O ator do motor só cria execução e manda menu. Em operação, módulo, rota
 * interna ou ERP é erro de programação: falha alto em vez de agir.
 */
export function refuseEngineActor(actor: Actor) {
  if (isEngineActor(actor))
    throw new Error(
      "O ator do motor de atendimento (bot:attendant) não executa operações, módulos nem o ERP.",
    );
}
export function admin(actor: Actor) {
  if (actor.kind !== "user" || actor.role !== "admin")
    throw new ApiError(403, "admin_required", "Somente administradores.");
}
/** users.access: lista JSON de acessos ou null (tudo); src/access.ts. */
export function storedAccess(value: unknown): string[] | null {
  const list = typeof value === "string" ? json(value, null) : null;
  return Array.isArray(list)
    ? list.filter((item): item is string => typeof item === "string")
    : null;
}
function userActor(row: any): Actor {
  return {
    id: row.id,
    ...(row.session_expires ? { expiresAt: row.session_expires } : {}),
    kind: "user",
    name: row.name,
    role: row.role,
    profiles: json(row.profiles, []),
    scopes: [],
    bots: [],
    rate: 300,
    runLimit: 10,
    access: storedAccess(row.access),
  };
}
/**
 * A pessoa como ator, relida do banco (bot agindo em nome dela, src/bot-actions):
 * desabilitada ou inexistente, null. Sem sessão: nível 1 e a política do
 * segundo fator, para os guardas falharem fechados (src/mfa.ts). Quem
 * confirma uma proposta passa a sessão dele (bot-actions/actions.ts).
 */
export async function actorForUser(
  env: Env,
  id: string,
): Promise<Actor | null> {
  const row = await one(
    env,
    `SELECT u.*,EXISTS(SELECT 1 FROM user_factors f WHERE f.user_id=u.id AND f.status='active') has_factor FROM users u WHERE u.id=? AND u.disabled=0`,
    id,
  );
  if (!row) return null;
  return {
    ...userActor(row),
    aal: 1,
    mfa: { factor: !!row.has_factor, policy: await mfaPolicy(env) },
  };
}
/**
 * Colunas da sessão, do segundo fator e da política da instalação, lidas
 * numa consulta só com a pessoa (cada ida ao D1 custa uma viagem de ida e
 * volta da borda ao banco; docs/LIMITES.md).
 */
const SESSION_COLUMNS = `s.id session_id,s.aal session_aal,s.mfa_at session_mfa_at,s.kind session_kind,EXISTS(SELECT 1 FROM user_factors f WHERE f.user_id=u.id AND f.status='active') has_factor,${MFA_POLICY_COLUMN}`;
/**
 * Ator de uma sessão de pessoa: horário de acesso (403 outside_schedule),
 * nível da sessão e política do segundo fator (src/mfa.ts). Sessão antiga
 * sem id público ganha um aqui (uma vez só, numa instrução).
 */
async function sessionActor(env: Env, row: any, hash: string) {
  requireSchedule(row);
  let sessionId = row.session_id as string | null;
  if (!sessionId)
    // Duas requisições ao mesmo tempo ficam com o mesmo id (coalesce).
    sessionId =
      (
        await one(
          env,
          "UPDATE sessions SET id=coalesce(id,?) WHERE hash=? RETURNING id",
          uid(),
          hash,
        )
      )?.id || uid();
  return {
    ...userActor(row),
    // Confirmação do segundo fator vale por um prazo (src/mfa.ts).
    aal: sessionAal(row.session_kind, row.session_aal, row.session_mfa_at),
    sessionId: sessionId!,
    mfa: { factor: !!row.has_factor, policy: mfaPolicyOf(row.mfa_policy) },
  } as Actor;
}

/**
 * Leituras antes da rota numa ida só ao D1 (db.batch): a consulta da
 * credencial e, numa rota de área, o estado dos módulos da área, que fica
 * no cache de leituras da invocação (`withReadCache`) para o requireModule.
 * Sessão e permissão nunca ficam em cache entre requisições.
 */
async function firstRows(
  env: Env,
  main: [string, any[]],
  profile: string | null | undefined,
  extra: [string, any[]][] = [],
  prefetch: [string, any[]][] = [],
) {
  const items: [string, any[]][] = [main, ...extra];
  // Leituras adiantadas para o cache da requisição: o estado dos módulos da
  // área e o que a rota pedir (as pessoas do ERP, src/modules/erp/identity.ts).
  const reads: [string, any[]][] = hasReadCache(env)
    ? [
        ...(profile ? [[MODULE_STATES_SQL, [profile]] as [string, any[]]] : []),
        ...prefetch,
      ]
    : [];
  items.push(...reads);
  // Repetível mesmo com o +1 do contador por minuto da chave (extra): contar
  // a mesma requisição duas vezes num erro transitório não faz mal, e a
  // leitura da credencial não perde a nova tentativa que tinha sozinha.
  const results = await batch(env, items, { retry: true });
  reads.forEach(([sql, args], i) =>
    seedAll(env, sql, args, results[items.length - reads.length + i].results),
  );
  return results.map((r) => r.results as any[]);
}
export const MOBILE_TOKEN_PREFIX = "wabu_";
/**
 * Ator da requisição. `profile` (a área de uma rota /profiles/:profile/…)
 * só adianta a leitura do estado dos módulos na mesma ida ao D1; `prefetch`
 * são leituras da rota que vão no mesmo lote para uma sessão de pessoa (as
 * pessoas do ERP), lidas depois do cache da requisição.
 */
export async function authenticate(
  env: Env,
  request: Request,
  profile?: string | null,
  prefetch: [string, any[]][] = [],
): Promise<Actor> {
  const bearer = request.headers
    .get("Authorization")
    ?.match(/^Bearer (.+)$/)?.[1];
  if (bearer && bearer.startsWith(MOBILE_TOKEN_PREFIX)) {
    // Mobile user session: identifies a person, no Origin check (native app).
    const hash = await sha(bearer);
    const [[row]] = await firstRows(
      env,
      [
        `SELECT u.*,s.last_used session_last_used,s.expires session_expires,${SESSION_COLUMNS} FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.kind='bearer' AND s.expires>? AND u.disabled=0`,
        [hash, now()],
      ],
      profile,
      [],
      prefetch,
    );
    if (!row)
      throw new ApiError(
        401,
        "invalid_token",
        "Sessão inválida ou expirada. Entre novamente.",
      );
    if (!row.session_last_used || row.session_last_used < now() - 3600000)
      await exec(
        env,
        "UPDATE sessions SET last_used=? WHERE hash=?",
        now(),
        hash,
      );
    return sessionActor(env, row, hash);
  }
  if (bearer && bearer.startsWith(CREDENTIAL_PREFIX)) {
    // Credencial de módulo trocada por QR (src/module-credentials.ts).
    const actor = await credentialActor(env, bearer);
    if (!actor)
      throw new ApiError(
        401,
        "invalid_token",
        "Acesso encerrado. Escaneie um QR novo.",
      );
    return actor;
  }
  if (bearer) {
    const hash = await sha(bearer),
      at = now(),
      bucket = Math.floor(at / 60000);
    // Chave, limite por minuto da aplicação (o mesmo contador de rate()) e o
    // estado dos módulos numa ida só. A contagem só sobe para chave válida.
    const [[row], [counter]] = await firstRows(
      env,
      [
        "SELECT k.id key_id,k.expires key_expires,a.* FROM api_keys k JOIN applications a ON a.id=k.app_id WHERE k.hash=? AND k.revoked=0 AND k.expires>? AND a.disabled=0",
        [hash, at],
      ],
      profile,
      [
        [
          "INSERT INTO rate_limits(key,count,expires) SELECT 'app:'||a.id||':'||?,1,? FROM api_keys k JOIN applications a ON a.id=k.app_id WHERE k.hash=? AND k.revoked=0 AND k.expires>? AND a.disabled=0 ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
          [bucket, at + 60000, hash, at],
        ],
      ],
      // Aplicação no ERP: os membros do ERP da área no mesmo lote.
      prefetch,
    );
    if (!row)
      throw new ApiError(401, "invalid_token", "Chave inválida ou expirada.");
    if ((counter?.count ?? 0) > row.rate)
      throw new ApiError(
        429,
        "rate_limited",
        "Limite de requisições atingido. Aguarde antes de repetir.",
      );
    return {
      id: `app:${row.id}`,
      kind: "app",
      name: row.name,
      role: "service",
      profiles: json(row.profiles, []),
      scopes: json(row.scopes, []),
      bots: json(row.bots, []),
      keyId: row.key_id,
      expiresAt: row.key_expires,
      rate: row.rate,
      runLimit: row.run_limit,
    };
  }
  const token = request.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)wabotia=([^;]+)/)?.[1];
  const cookieHash = token ? await sha(token) : "";
  const row = token
    ? (
        await firstRows(
          env,
          [
            `SELECT u.*,s.expires session_expires,${SESSION_COLUMNS} FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.kind='cookie' AND s.expires>? AND u.disabled=0`,
            [cookieHash, now()],
          ],
          profile,
          [],
          prefetch,
        )
      )[0][0]
    : null;
  if (!row) throw new ApiError(401, "unauthenticated", "Entre na sua conta.");
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("Origin");
    if (origin !== new URL(request.url).origin)
      throw new ApiError(
        403,
        "invalid_origin",
        "Origem da requisição inválida.",
      );
  }
  return sessionActor(env, row, cookieHash);
}
export function publicUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, "invalid_url", "Informe uma URL HTTPS válida.");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && !["443"].includes(url.port)) ||
    !host.includes(".") ||
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^[\d.]+$/.test(host) ||
    host.includes(":")
  )
    throw new ApiError(
      400,
      "invalid_url",
      "Use um domínio HTTPS público, sem credenciais ou endereço IP.",
    );
  return url.toString().replace(/\/$/, "");
}
export async function safeFetch(url: string, options: RequestInit = {}) {
  const response = await fetch(publicUrl(url), {
    ...options,
    redirect: "manual",
    signal: options.signal ?? AbortSignal.timeout(15000),
  });
  if (response.status >= 300 && response.status < 400)
    throw new ApiError(
      502,
      "redirect_refused",
      "O serviço redirecionou a requisição. Configure a URL final.",
    );
  return response;
}

export function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
