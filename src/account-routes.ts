// Rotas da conta: segundo fator, links de uso único e recuperação do
// administrador (docs/API.md, "Login e segundo fator"). Montadas depois do
// middleware de /api/v1 (autenticação e portão do segundo fator).
import type { Hono } from "hono";
import { exec, one } from "./db";
import {
  ApiError,
  type Actor,
  type Bindings,
  type Env,
  now,
  requireValue,
  uid,
} from "./types";
import {
  admin,
  equal,
  passwordHash,
  passwordMatches,
  rate,
  sha,
} from "./security";
import {
  finishEnrollment,
  mfaPolicy,
  mfaStatus,
  newRecoveryCodes,
  otpauthUrl,
  raiseSession,
  removeFactors,
  requireAal2,
  requireStepUp,
  setMfaPolicy,
  startEnrollment,
  verifySecondFactor,
} from "./mfa";
import {
  consumeAccountLink,
  FORGOT_TTL_MS,
  issueAccountLink,
  peekAccountLink,
} from "./auth-tokens";
import {
  accountEmail,
  alertAccount,
  emailConfig,
  emailLog,
  emailReady,
  mailAccountLink,
  publicEmailConfig,
  sendEmail,
  validEmail,
} from "./email";
import { publicOrigin } from "./web-steps";

/** Alerta por e-mail depois da resposta (src/email.ts, alertAccount). */
function alert(c: any, userId: string, kind: "password_changed" | "mfa_reset") {
  c.executionCtx.waitUntil(alertAccount(c.env, userId, kind));
}

/** Esqueci a senha: link de 1 hora, só para conta ativa. */
async function forgotPassword(env: Env, email: string, requestOrigin: string) {
  try {
    const user = await one(
      env,
      "SELECT id,name,email FROM users WHERE email=? AND disabled=0",
      email,
    );
    if (!user) return;
    const link = await issueAccountLink(env, {
      userId: user.id,
      purpose: "reset",
      createdBy: "forgot",
      origin: (await publicOrigin(env)) || requestOrigin,
      ttlMs: FORGOT_TTL_MS,
    });
    await sendEmail(
      env,
      {
        to: user.email,
        ...accountEmail("reset", {
          name: user.name,
          url: link.url,
          expiresAt: link.expires_at,
        }),
      },
      { purpose: "account.forgot", userId: user.id },
    );
  } catch {
    // Falha fica em email_log; a resposta é a mesma de qualquer jeito.
  }
}

export const FORGOT_MESSAGE =
  "Se houver uma conta ativa com este e-mail, enviamos um link para criar uma senha nova. Ele vale por 1 hora.";

/** Só a pessoa numa sessão (não aplicação, bot ou ator interno). */
function person(actor: Actor) {
  if (actor.kind !== "user" || !actor.sessionId)
    throw new ApiError(
      403,
      "people_only",
      "Disponível só para a pessoa na própria sessão.",
    );
  return actor as Actor & { sessionId: string };
}

async function record(env: Env, actor: Actor | string, op: string, id: string) {
  await exec(
    env,
    "INSERT INTO audit(profile_id,actor,operation,resource_id,request_id,created) VALUES(NULL,?,?,?,?,?)",
    typeof actor === "string" ? actor : actor.id,
    op,
    id,
    uid(),
    now(),
  );
}

/** Derruba as sessões da pessoa (todas, ou todas menos a atual). */
async function dropSessions(env: Env, userId: string, keep?: string) {
  await exec(
    env,
    keep
      ? "DELETE FROM sessions WHERE user_id=? AND (id IS NULL OR id<>?)"
      : "DELETE FROM sessions WHERE user_id=?",
    userId,
    ...(keep ? [keep] : []),
  );
}

const ip = (c: any) => c.req.header("CF-Connecting-IP") || "local";
const origin = (c: any) => new URL(c.req.url).origin;

export function mountAccount(app: Hono<Bindings>) {
  // ---- Conta da pessoa --------------------------------------------------
  app.get("/api/v1/account", async (c) => {
    const actor = person(c.get("actor"));
    const user = await one(
      c.env,
      "SELECT id,name,email,role,schedule FROM users WHERE id=?",
      actor.id,
    );
    return c.json({
      ...user,
      schedule: user?.schedule ? JSON.parse(user.schedule) : null,
      session: { id: actor.sessionId, aal: actor.aal ?? 1 },
      mfa: await mfaStatus(c.env, actor),
    });
  });
  app.get("/api/v1/account/mfa", async (c) =>
    c.json(await mfaStatus(c.env, person(c.get("actor")))),
  );
  // Cadastro do aplicativo autenticador: pede a senha de novo; trocar um
  // fator ativo exige a sessão já confirmada.
  app.post("/api/v1/account/mfa/enroll", async (c) => {
    const actor = person(c.get("actor"));
    await rate(c.env, `mfa-enroll:${actor.id}`, 10, 600000);
    const body = await c.req.json<any>().catch(() => ({}));
    const user = await one(c.env, "SELECT * FROM users WHERE id=?", actor.id);
    if (!passwordMatches(String(body?.password || ""), user?.password))
      throw new ApiError(401, "invalid_credentials", "Senha incorreta.");
    if (actor.mfa?.factor) requireAal2(actor);
    const factor = await startEnrollment(c.env, actor.id);
    return c.json({
      factor_id: factor.id,
      secret: factor.secret,
      otpauth_url: otpauthUrl(factor.secret, user.email, "Wabotia"),
    });
  });
  // Primeiro código: ativa o fator, devolve os 10 códigos de recuperação
  // (uma vez só), sobe esta sessão para aal2 e derruba as outras.
  app.post("/api/v1/account/mfa/verify", async (c) => {
    const actor = person(c.get("actor"));
    const body = await c.req.json<any>().catch(() => ({}));
    const codes = await finishEnrollment(
      c.env,
      actor.id,
      body?.factor_id,
      body?.code,
    );
    await raiseSession(c.env, actor.sessionId);
    await dropSessions(c.env, actor.id, actor.sessionId);
    await record(c.env, actor, "account.mfa.enroll", actor.id);
    return c.json({ aal: 2, recovery_codes: codes });
  });
  // Sessão só com senha de quem tem fator: confirma com o código.
  app.post("/api/v1/account/mfa/challenge", async (c) => {
    const actor = person(c.get("actor"));
    const body = await c.req.json<any>().catch(() => ({}));
    await verifySecondFactor(c.env, actor.id, {
      code: body?.code ?? body?.totp,
      recovery_code: body?.recovery_code,
    });
    await raiseSession(c.env, actor.sessionId);
    return c.json({ aal: 2 });
  });
  app.post("/api/v1/account/mfa/recovery-codes", async (c) => {
    const actor = person(c.get("actor"));
    requireAal2(actor);
    const codes = await newRecoveryCodes(c.env, actor.id);
    await record(c.env, actor, "account.mfa.recovery_codes", actor.id);
    return c.json({ recovery_codes: codes });
  });
  app.delete("/api/v1/account/mfa/factors/:id", async (c) => {
    const actor = person(c.get("actor"));
    requireAal2(actor);
    if ((await mfaPolicy(c.env)) === "all")
      throw new ApiError(
        409,
        "mfa_policy_all",
        "O segundo fator é exigido para todos nesta instalação. Para trocar de aparelho, cadastre o novo antes.",
      );
    const removed = await exec(
      c.env,
      "DELETE FROM user_factors WHERE id=? AND user_id=?",
      c.req.param("id"),
      actor.id,
    );
    if (!removed.meta?.changes)
      throw new ApiError(404, "factor_not_found", "Fator não encontrado.");
    await exec(
      c.env,
      "DELETE FROM user_recovery_codes WHERE user_id=?",
      actor.id,
    );
    await record(c.env, actor, "account.mfa.remove", actor.id);
    alert(c, actor.id, "mfa_reset");
    return c.json({ ok: true });
  });

  // ---- Administrador sobre outra pessoa ---------------------------------
  app.post("/api/v1/people/:id/mfa/reset", async (c) => {
    const actor = c.get("actor");
    admin(actor);
    requireStepUp(actor);
    const id = c.req.param("id");
    const target = await one(c.env, "SELECT id FROM users WHERE id=?", id);
    if (!target) throw new ApiError(404, "not_found", "Pessoa não encontrada.");
    await removeFactors(c.env, id);
    await dropSessions(c.env, id);
    await record(c.env, actor, "people.mfa.reset", id);
    alert(c, id, "mfa_reset");
    return c.json({ ok: true });
  });
  app.post("/api/v1/people/:id/password-link", async (c) => {
    const actor = c.get("actor");
    admin(actor);
    requireStepUp(actor);
    const id = c.req.param("id");
    const target = await one(
      c.env,
      "SELECT id,name,email,disabled FROM users WHERE id=?",
      id,
    );
    if (!target || target.disabled)
      throw new ApiError(
        404,
        "not_found",
        "Pessoa não encontrada ou desativada.",
      );
    const body = await c.req.json<any>().catch(() => ({}));
    const link = await issueAccountLink(c.env, {
      userId: id,
      purpose: "reset",
      createdBy: actor.id,
      origin: origin(c),
    });
    await record(c.env, actor, "people.password_link", id);
    // Com `send_email`, o link vai também para o e-mail da pessoa.
    return c.json({
      ...link,
      ...(body?.send_email === true
        ? await mailAccountLink(c.env, target, "reset", link)
        : {}),
    });
  });
  // ---- E-mail (Gestão → Sistema; gravar em system/email/configure) -------
  app.get("/api/v1/system/email", async (c) => {
    admin(c.get("actor"));
    return c.json({
      ...publicEmailConfig(await emailConfig(c.env)),
      log: await emailLog(c.env, 30),
    });
  });
  // Teste para o e-mail de quem pede: confere token, domínio e remetente.
  app.post("/api/v1/system/email/test", async (c) => {
    const actor = c.get("actor");
    admin(actor);
    await rate(c.env, `email-test:${actor.id}`, 5);
    const user = await one(
      c.env,
      "SELECT id,name,email FROM users WHERE id=?",
      actor.id,
    );
    const sent = await sendEmail(
      c.env,
      { to: user.email, ...accountEmail("test", { name: user.name }) },
      { purpose: "test", userId: actor.id },
    );
    return c.json({ status: sent.status, to: user.email });
  });
  app.put("/api/v1/system/mfa-policy", async (c) => {
    const actor = c.get("actor");
    admin(actor);
    requireStepUp(actor);
    const body = await c.req.json<any>().catch(() => ({}));
    // Exigir para todos sem ter o próprio fator trancaria o administrador.
    if (body?.policy === "all" && !actor.mfa?.factor)
      throw new ApiError(
        409,
        "mfa_enroll_first",
        "Cadastre o seu segundo fator antes de exigir para todos.",
      );
    await setMfaPolicy(c.env, body?.policy);
    await record(c.env, actor, "system.mfa_policy", String(body?.policy));
    return c.json({ policy: body.policy });
  });
}

/** Rotas públicas (sem sessão), em /api/auth/ (Origin conferido). */
export function mountAccountPublic(app: Hono<Bindings>) {
  app.post("/api/auth/link-info", async (c) => {
    await rate(c.env, `account-link:${await sha(ip(c))}`, 30, 600000);
    const body = await c.req.json<any>().catch(() => ({}));
    const row = await peekAccountLink(c.env, body?.token);
    return c.json({
      purpose: row.purpose,
      name: row.name,
      email: row.email,
      expires_at: row.expires,
    });
  });
  // Redefinir a senha (link do administrador) ou criar a do convite.
  for (const [path, purpose] of [
    ["/api/auth/reset", "reset"],
    ["/api/auth/invite/accept", "invite"],
  ] as const)
    app.post(path, async (c) => {
      await rate(c.env, `account-link:${await sha(ip(c))}`, 10, 600000);
      const body = await c.req.json<any>().catch(() => ({}));
      const peek = await peekAccountLink(c.env, body?.token);
      if (peek.purpose !== purpose)
        throw new ApiError(410, "link_invalid", "Este link é de outro tipo.");
      const hash = passwordHash(body?.password);
      const row = await consumeAccountLink(c.env, body?.token);
      await exec(
        c.env,
        "UPDATE users SET password=? WHERE id=?",
        hash,
        row.user_id,
      );
      await dropSessions(c.env, row.user_id);
      await record(
        c.env,
        `link:${row.user_id}`,
        `auth.${purpose}`,
        row.user_id,
      );
      // Convite é a primeira senha: alerta só na troca.
      if (purpose === "reset") alert(c, row.user_id, "password_changed");
      return c.json({ ok: true, email: row.email });
    });
  // Esqueci a senha (só com e-mail configurado): a resposta é a mesma, exista
  // ou não a conta, e o envio sai depois da resposta. Limite por endereço de
  // rede (429) e por conta (silencioso, para não revelar a conta).
  app.post("/api/auth/forgot", async (c) => {
    await rate(c.env, `forgot-ip:${await sha(ip(c))}`, 5, 600000);
    if (!(await emailReady(c.env)))
      throw new ApiError(
        409,
        "email_unavailable",
        "Esta instalação não envia e-mail. Peça ao administrador um link para redefinir a senha.",
      );
    const body = await c.req.json<any>().catch(() => ({}));
    const email = String(body?.email || "")
      .trim()
      .toLowerCase();
    if (!validEmail(email))
      throw new ApiError(400, "invalid_request", "Informe um e-mail válido.");
    let allowed = true;
    try {
      await rate(c.env, `forgot-account:${await sha(email)}`, 3, 3600000);
    } catch {
      allowed = false;
    }
    if (allowed)
      c.executionCtx.waitUntil(forgotPassword(c.env, email, origin(c)));
    return c.json({ ok: true, message: FORGOT_MESSAGE });
  });
  // Administrador único que perdeu a senha ou o segundo fator: o SETUP_TOKEN
  // da instalação (guardado no arquivo de chaves) troca a senha e tira o
  // fator. Com mais de um administrador ativo, outro administrador resolve.
  app.post("/api/auth/recover-admin", async (c) => {
    await rate(c.env, `recover-admin:${await sha(ip(c))}`, 5, 600000);
    requireValue(
      c.env.SETUP_TOKEN && c.env.MASTER_KEY,
      "Configure SETUP_TOKEN e MASTER_KEY antes de continuar.",
    );
    const body = await c.req.json<any>().catch(() => ({}));
    if (!equal(String(body?.setup_token || ""), c.env.SETUP_TOKEN))
      throw new ApiError(
        403,
        "invalid_setup_token",
        "Código de instalação inválido.",
      );
    const admins = await one(
      c.env,
      "SELECT count(*) n,min(id) id,min(email) email FROM users WHERE role='admin' AND disabled=0",
    );
    if (admins.n !== 1)
      throw new ApiError(
        409,
        "not_single_admin",
        admins.n
          ? "Há mais de um administrador: peça a outro um link para redefinir a senha."
          : "Nenhum administrador ativo.",
      );
    const hash = passwordHash(body?.password);
    await exec(
      c.env,
      "UPDATE users SET password=? WHERE id=?",
      hash,
      admins.id,
    );
    await removeFactors(c.env, admins.id);
    await dropSessions(c.env, admins.id);
    await record(c.env, "setup_token", "auth.recover_admin", admins.id);
    alert(c, admins.id, "password_changed");
    return c.json({ ok: true, email: admins.email });
  });
}
