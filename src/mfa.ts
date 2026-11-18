// Segundo fator (TOTP, RFC 6238), nível da sessão e horário de acesso
// (docs/API.md, "Login e segundo fator").
//
// - Sessão de pessoa tem `aal` 1 (só senha) ou 2 (senha + código). Quem tem
//   fator ativo só entra com o código (login já em aal2); sessão antiga em
//   aal1 de quem tem fator passa por /account/mfa/challenge.
// - Política da instância (instance_settings "mfa_policy"):
//     off        quem quiser usa; nada exige
//     financial  operações financeiras de pessoas exigem aal2
//     all        toda pessoa precisa de fator; sessão aal1 só alcança o
//                cadastro do fator, o desafio, /me e a saída
// - Chave de aplicação nunca chega a aal2: rotas que exigem aal2 recusam
//   aplicações (as operações financeiras de aplicações seguem por
//   billing:write).
// - Horário de acesso por pessoa (users.schedule, formato do Fagoo), em
//   America/Sao_Paulo (UTC-3 fixo); o administrador é isento.
import { all, exec, one, cachedOne } from "./db";
import { ApiError, type Actor, type Env, json, now, uid } from "./types";
import { hmac, seal, unseal } from "./security";
import { BRASILIA_OFFSET_MS } from "./business-time";

export const TOTP_STEP_S = 30;
export const TOTP_DIGITS = 6;
/** Passos aceitos antes e depois do atual (relógio do celular adiantado). */
export const TOTP_WINDOW = 1;
/** Erros de código aceitos por pessoa a cada 15 min; o 6º é 429. */
export const MFA_MAX_FAILURES = 5;
const FAILURE_PERIOD_MS = 15 * 60000;
export const RECOVERY_CODES = 10;
export const MFA_POLICIES = ["off", "financial", "all"] as const;
export type MfaPolicy = (typeof MFA_POLICIES)[number];

// ---------------------------------------------------------------------------
// TOTP

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array) {
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string) {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0,
    value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = B32.indexOf(ch);
    if (index < 0)
      throw new ApiError(400, "invalid_secret", "Segredo inválido.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Código TOTP (HMAC-SHA1, 30 s, 6 dígitos) do passo `step`. */
export async function totpAt(secret: Uint8Array, step: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = new Uint8Array(8);
  let rest = step;
  for (let i = 7; i >= 0; i--) {
    counter[i] = rest & 255;
    rest = Math.floor(rest / 256);
  }
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = mac[mac.length - 1] & 15;
  const code =
    (((mac[offset] & 127) << 24) |
      (mac[offset + 1] << 16) |
      (mac[offset + 2] << 8) |
      mac[offset + 3]) %
    10 ** TOTP_DIGITS;
  return String(code).padStart(TOTP_DIGITS, "0");
}

export const currentStep = (at = now()) => Math.floor(at / 1000 / TOTP_STEP_S);

/** Passo em que o código bate (dentro da janela), ou null. */
export async function matchingStep(
  secret: Uint8Array,
  code: string,
  at = now(),
) {
  if (!/^\d{6}$/.test(code)) return null;
  const step = currentStep(at);
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const candidate = step + delta;
    if ((await totpAt(secret, candidate)) === code) return candidate;
  }
  return null;
}

export function otpauthUrl(secretB32: string, email: string, issuer: string) {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_S}`;
}

// ---------------------------------------------------------------------------
// Política e nível

/** Valor guardado → política (desconhecido ou ausente: "off"). */
export const mfaPolicyOf = (value: unknown): MfaPolicy =>
  MFA_POLICIES.includes(value as MfaPolicy) ? (value as MfaPolicy) : "off";

/** Lida junto com a sessão (src/security.ts, SESSION_COLUMNS). */
export const MFA_POLICY_COLUMN =
  "(SELECT value FROM instance_settings WHERE key='mfa_policy') mfa_policy";

export async function mfaPolicy(env: Env): Promise<MfaPolicy> {
  const row = await cachedOne(
    env,
    "SELECT value FROM instance_settings WHERE key='mfa_policy'",
  );
  return mfaPolicyOf(row?.value);
}

export async function setMfaPolicy(env: Env, policy: unknown) {
  if (!MFA_POLICIES.includes(policy as MfaPolicy))
    throw new ApiError(
      400,
      "invalid_request",
      "Política do segundo fator: use off, financial ou all.",
    );
  await exec(
    env,
    "INSERT INTO instance_settings(key,value,updated) VALUES('mfa_policy',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated",
    policy,
    now(),
  );
}

const person = (actor: Actor) =>
  actor.kind === "user" && !actor.id.startsWith("bot:") && !!actor.sessionId;

/**
 * Exige sessão com segundo fator (aal2). Aplicação nunca chega a aal2;
 * ator interno (sistema, bot) sem sessão também não passa.
 */
export function requireAal2(actor: Actor) {
  if (actor.kind === "user" && (actor.aal ?? 1) >= 2) return;
  throw new ApiError(
    403,
    "mfa_required",
    actor.kind === "user"
      ? "Confirme com o código do aplicativo autenticador para continuar."
      : "Esta operação exige uma pessoa com segundo fator; chaves de aplicação não servem.",
  );
}

/**
 * Pede o segundo fator quando a pessoa tem um ou a política não é "off"
 * (gerenciar fatores, zerar o de outra pessoa, mudar a política).
 */
export function requireStepUp(actor: Actor) {
  if (actor.mfa?.factor || (actor.mfa?.policy ?? "off") !== "off")
    requireAal2(actor);
}

/**
 * Operação financeira feita por pessoa: com a política "financial" ou "all",
 * exige aal2. Aplicações seguem por billing:write; sistema e bots não têm
 * sessão e passam. A pessoa agindo pelo bot (`via`, src/bot-actions) conta
 * como pessoa mesmo sem sessão: vale o `aal` da sessão que confirmou, e sem a
 * política no ator o guarda falha fechado.
 */
export function requireFinancialAal(actor: Actor) {
  const viaBot =
    actor.kind === "user" && !!actor.via && !actor.id.startsWith("bot:");
  if (!person(actor) && !viaBot) return;
  const policy = actor.mfa?.policy ?? (viaBot ? "financial" : "off");
  if (policy === "financial" || policy === "all") requireAal2(actor);
}

/** Rotas que a sessão aal1 ainda alcança quando o fator é exigido. */
const AAL1_PATHS = [
  /^\/api\/v1\/me$/,
  /^\/api\/v1\/logout$/,
  /^\/api\/v1\/account\/mfa(\/.*)?$/,
  /^\/api\/v1\/account$/,
  /^\/api\/v1\/auth\/mobile\/refresh$/,
];

/**
 * Login (painel e app): horário de acesso e, com fator ativo, o código no
 * mesmo pedido (`totp` ou `code`, ou `recovery_code`). Sem o código, 401
 * mfa_required e nenhuma sessão é criada: o cliente pede o código e manda de
 * novo. Devolve o nível da sessão a criar.
 */
export async function loginSecondFactor(
  env: Env,
  user: any,
  data: any,
): Promise<1 | 2> {
  requireSchedule(user);
  const factor = await activeFactor(env, user.id);
  if (!factor) return 1;
  const code = data?.totp ?? data?.code;
  if (!code && !data?.recovery_code)
    throw new ApiError(
      401,
      "mfa_required",
      "Informe o código de 6 dígitos do aplicativo autenticador.",
    );
  await verifySecondFactor(env, user.id, {
    code,
    recovery_code: data?.recovery_code,
  });
  return 2;
}

/** O que falta depois do login: cadastrar o fator (política "all"). */
export async function loginMfaNext(env: Env, user: any, aal: 1 | 2) {
  const policy = await mfaPolicy(env);
  const factor = aal === 2 || !!(await activeFactor(env, user.id));
  return {
    policy,
    factor,
    next: !factor && policy === "all" ? "enroll" : null,
  };
}

/**
 * Quanto tempo a confirmação do segundo fator vale numa sessão: o cookie do
 * painel dura 12 h; a sessão do app (30 dias), até 7 dias depois do código
 * (a renovação mantém o horário). Passado o prazo, a sessão volta a aal1 e a
 * ação que exige o fator pede o código de novo (elevação sob demanda).
 */
export const AAL2_WINDOW_MS = {
  cookie: 12 * 3600000,
  bearer: 7 * 86400000,
} as const;

export function sessionAal(
  kind: string,
  aal: unknown,
  mfaAt: unknown,
  at = now(),
): 1 | 2 {
  const window =
    AAL2_WINDOW_MS[kind as keyof typeof AAL2_WINDOW_MS] ??
    AAL2_WINDOW_MS.cookie;
  return aal === 2 && typeof mfaAt === "number" && mfaAt > at - window ? 2 : 1;
}

/**
 * Portão do middleware, só com a política "all": sem fator, a sessão só
 * cadastra; com fator e sessão em aal1, só confirma o código. Nas outras
 * políticas a sessão segue; as ações que exigem o fator pedem na hora
 * (requireAal2, requireFinancialAal).
 */
export function mfaGate(actor: Actor, path: string) {
  if (!person(actor) || (actor.aal ?? 1) >= 2) return;
  if (actor.mfa?.policy !== "all") return;
  const need = actor.mfa?.factor ? "challenge" : "enroll";
  if (AAL1_PATHS.some((p) => p.test(path))) return;
  throw new ApiError(
    403,
    "mfa_required",
    need === "challenge"
      ? "Confirme com o código do aplicativo autenticador para continuar."
      : "Cadastre o segundo fator (aplicativo autenticador) para continuar.",
  );
}

// ---------------------------------------------------------------------------
// Fatores

export async function activeFactor(env: Env, userId: string) {
  return one(
    env,
    "SELECT * FROM user_factors WHERE user_id=? AND status='active' ORDER BY created DESC LIMIT 1",
    userId,
  );
}

async function factorSecret(env: Env, row: any) {
  return base32Decode((await unseal(env, row.secret)).secret);
}

/** Conta um erro de código; acima do limite, 429. */
async function failure(env: Env, userId: string) {
  const bucket = Math.floor(now() / FAILURE_PERIOD_MS);
  await one(
    env,
    "INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count",
    `mfa-fail:${userId}:${bucket}`,
    now() + FAILURE_PERIOD_MS,
  );
}
async function tooManyFailures(env: Env, userId: string) {
  const bucket = Math.floor(now() / FAILURE_PERIOD_MS);
  const row = await one(
    env,
    "SELECT count FROM rate_limits WHERE key=?",
    `mfa-fail:${userId}:${bucket}`,
  );
  if ((row?.count || 0) >= MFA_MAX_FAILURES)
    throw new ApiError(
      429,
      "mfa_locked",
      "Muitos códigos errados. Aguarde 15 minutos ou use um código de recuperação com o administrador.",
    );
}

/**
 * Confere um código (TOTP do fator ativo ou código de recuperação). O mesmo
 * passo não vale duas vezes (last_step), e cada erro conta para o limite.
 */
export async function verifySecondFactor(
  env: Env,
  userId: string,
  input: { code?: unknown; recovery_code?: unknown },
  factorRow?: any,
) {
  await tooManyFailures(env, userId);
  const factor = factorRow || (await activeFactor(env, userId));
  if (!factor)
    throw new ApiError(
      400,
      "mfa_not_enrolled",
      "Nenhum segundo fator cadastrado.",
    );
  if (typeof input.recovery_code === "string" && input.recovery_code.trim()) {
    const hash = await recoveryHash(env, input.recovery_code);
    const used = await exec(
      env,
      "UPDATE user_recovery_codes SET used_at=? WHERE user_id=? AND hash=? AND used_at IS NULL",
      now(),
      userId,
      hash,
    );
    if (used.meta?.changes) return { method: "recovery" as const };
    await failure(env, userId);
    throw new ApiError(401, "invalid_code", "Código de recuperação inválido.");
  }
  const code = String(input.code ?? "").replace(/\s/g, "");
  const step = await matchingStep(await factorSecret(env, factor), code);
  // O passo precisa ser posterior ao último aceito: sem repetição.
  const accepted =
    step !== null &&
    (
      await exec(
        env,
        "UPDATE user_factors SET last_step=? WHERE id=? AND last_step<?",
        step,
        factor.id,
        step,
      )
    ).meta?.changes;
  if (!accepted) {
    await failure(env, userId);
    throw new ApiError(401, "invalid_code", "Código inválido ou já usado.");
  }
  return { method: "totp" as const };
}

export async function startEnrollment(env: Env, userId: string) {
  // Um pendente por vez: o anterior, se houver, sai.
  await exec(
    env,
    "DELETE FROM user_factors WHERE user_id=? AND status='pending'",
    userId,
  );
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const secret = base32Encode(bytes);
  const id = uid();
  await exec(
    env,
    "INSERT INTO user_factors(id,user_id,kind,secret,status,last_step,created) VALUES(?,?,'totp',?,'pending',0,?)",
    id,
    userId,
    await seal(env, { secret }),
    now(),
  );
  return { id, secret };
}

/** Ativa o fator pendente com o primeiro código e gera os de recuperação. */
export async function finishEnrollment(
  env: Env,
  userId: string,
  factorId: unknown,
  code: unknown,
) {
  const factor = await one(
    env,
    "SELECT * FROM user_factors WHERE id=? AND user_id=? AND status='pending'",
    String(factorId ?? ""),
    userId,
  );
  if (!factor)
    throw new ApiError(
      404,
      "factor_not_found",
      "Cadastro do fator não encontrado.",
    );
  await verifySecondFactor(env, userId, { code }, factor);
  await exec(
    env,
    "DELETE FROM user_factors WHERE user_id=? AND status='active'",
    userId,
  );
  await exec(
    env,
    "UPDATE user_factors SET status='active',activated_at=? WHERE id=?",
    now(),
    factor.id,
  );
  return newRecoveryCodes(env, userId);
}

async function recoveryHash(env: Env, code: string) {
  return hmac(
    `recovery:${env.MASTER_KEY}`,
    code.toUpperCase().replace(/[^A-Z0-9]/g, ""),
  );
}

/** 10 códigos novos (os antigos deixam de valer); devolvidos uma vez só. */
export async function newRecoveryCodes(env: Env, userId: string) {
  await exec(env, "DELETE FROM user_recovery_codes WHERE user_id=?", userId);
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODES; i++) {
    const raw = base32Encode(crypto.getRandomValues(new Uint8Array(7))).slice(
      0,
      10,
    );
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    codes.push(code);
    await exec(
      env,
      "INSERT INTO user_recovery_codes(user_id,hash,created) VALUES(?,?,?)",
      userId,
      await recoveryHash(env, code),
      now(),
    );
  }
  return codes;
}

export async function removeFactors(env: Env, userId: string) {
  await exec(env, "DELETE FROM user_factors WHERE user_id=?", userId);
  await exec(env, "DELETE FROM user_recovery_codes WHERE user_id=?", userId);
}

export async function mfaStatus(env: Env, actor: Actor) {
  const factors = await all(
    env,
    "SELECT id,kind,status,created,activated_at FROM user_factors WHERE user_id=? ORDER BY created",
    actor.id,
  );
  const codes = await one(
    env,
    "SELECT count(*) n FROM user_recovery_codes WHERE user_id=? AND used_at IS NULL",
    actor.id,
  );
  return {
    policy: await mfaPolicy(env),
    aal: actor.aal ?? 1,
    factors,
    recovery_codes_left: codes?.n || 0,
  };
}

/** Sobe a sessão atual para aal2. */
export async function raiseSession(env: Env, sessionId: string) {
  await exec(
    env,
    "UPDATE sessions SET aal=2,mfa_at=? WHERE id=?",
    now(),
    sessionId,
  );
}

// ---------------------------------------------------------------------------
// Horário de acesso (formato do Fagoo, user-permissions.mjs: windowValid)

export const SCHEDULE_WINDOW_LIMIT = 10;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

export interface AccessSchedule {
  enabled: boolean;
  windows: { start: string; end: string; days: number[] }[];
}

export function validateSchedule(value: unknown): AccessSchedule | null {
  if (value === null) return null;
  const bad = () =>
    new ApiError(
      400,
      "invalid_request",
      `Horário de acesso: {enabled, windows: [{start: "08:00", end: "18:00", days: [1,2,3,4,5]}]}, até ${SCHEDULE_WINDOW_LIMIT} janelas, início antes do fim, dias de 0 (domingo) a 6 em ordem.`,
    );
  const v = value as any;
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).sort().join() !== "enabled,windows" ||
    typeof v.enabled !== "boolean" ||
    !Array.isArray(v.windows) ||
    v.windows.length > SCHEDULE_WINDOW_LIMIT ||
    (v.enabled && !v.windows.length)
  )
    throw bad();
  for (const w of v.windows)
    if (
      !w ||
      typeof w !== "object" ||
      Object.keys(w).sort().join() !== "days,end,start" ||
      !TIME.test(w.start) ||
      !TIME.test(w.end) ||
      !(w.start < w.end) ||
      !Array.isArray(w.days) ||
      !w.days.length ||
      w.days.length > 7 ||
      !w.days.every(
        (d: unknown, i: number) =>
          Number.isInteger(d) &&
          (d as number) >= 0 &&
          (d as number) <= 6 &&
          (i === 0 || (d as number) > w.days[i - 1]),
      )
    )
      throw bad();
  return {
    enabled: v.enabled,
    windows: v.windows.map((w: any) => ({
      start: w.start,
      end: w.end,
      days: [...w.days],
    })),
  };
}

/** Dentro do horário agora (Brasília)? Sem horário ou desligado: sempre. */
export function withinSchedule(stored: unknown, at = now()) {
  const schedule = typeof stored === "string" ? json(stored, null) : stored;
  if (!schedule?.enabled) return true;
  const local = new Date(at - BRASILIA_OFFSET_MS);
  const day = local.getUTCDay();
  const hhmm = local.toISOString().slice(11, 16);
  return (schedule.windows || []).some(
    // Fim inclusivo: "até 18:00" vale durante o minuto das 18:00, e
    // "00:00–23:59" é o dia inteiro (igual ao window_open do ERP).
    (w: any) => w.days.includes(day) && hhmm >= w.start && hhmm <= w.end,
  );
}

export function requireSchedule(user: { role: string; schedule?: unknown }) {
  if (user.role === "admin" || withinSchedule(user.schedule)) return;
  throw new ApiError(
    403,
    "outside_schedule",
    "Fora do seu horário de acesso. Fale com o administrador.",
  );
}
