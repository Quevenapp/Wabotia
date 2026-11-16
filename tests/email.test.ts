import { env, SELF } from "cloudflare:test";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { exec, one } from "../src/db";
import { conversation } from "../src/service";
import { now, uid } from "../src/types";
import { passwordHash, sha } from "../src/security";
import { modulesApi } from "../src/modules/api";
import {
  assertSafeSubject,
  configureEmail,
  EMAIL_AREA_DAILY,
} from "../src/email";
import { FORGOT_TTL_MS } from "../src/auth-tokens";
import { api, bearer, drain, fixture, receive } from "./service-center-fixture";

const PASSWORD = "senha-de-teste-12345";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "token-de-teste-com-permissao-12345";
let ipCounter = 0;

/** Pedidos à API de envio da Cloudflare e a resposta simulada. */
let sent: { url: string; auth: string | null; body: any }[] = [];
let reply: () => Response = () => ok();
const ok = (bounce = false) =>
  Response.json({
    success: true,
    errors: [],
    messages: [],
    result: bounce
      ? { delivered: [], permanent_bounces: [lastTo()], queued: [] }
      : { delivered: [lastTo()], permanent_bounces: [], queued: [] },
  });
const lastTo = () => sent.at(-1)?.body?.to;
const failure = (code: number, status = 403) =>
  Response.json(
    { success: false, errors: [{ code, message: "simulado" }], messages: [] },
    { status },
  );
const original = globalThis.fetch;

beforeEach(() => {
  sent = [];
  reply = () => ok();
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname !== "api.cloudflare.com")
      return original(input, init);
    sent.push({
      url: request.url,
      auth: request.headers.get("Authorization"),
      body: await request.json(),
    });
    return reply();
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  // D1 compartilhado entre arquivos: sem e-mail para os próximos testes.
  await exec(env, "DELETE FROM secrets WHERE id='email:config'");
  await exec(env, "DELETE FROM email_log");
});

async function setupEmail(f: { admin: any }) {
  await configureEmail(env, f.admin, {
    account_id: ACCOUNT,
    token: TOKEN,
    from_address: "nao-responda@exemplo.com.br",
    from_name: "Atendimento Exemplo",
  });
}
async function person(profiles: string[], role = "operator") {
  const id = uid(),
    email = `${id}@example.test`;
  await exec(
    env,
    "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,?,?,?,?,?)",
    id,
    email,
    "Pessoa",
    passwordHash(PASSWORD),
    role,
    JSON.stringify(profiles),
    now(),
  );
  return { id, email };
}
const post = (path: string, body: any, ip = "10.8.0." + (++ipCounter % 250)) =>
  SELF.fetch("https://test" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
/** O envio sai depois da resposta (waitUntil): espera o registro. */
const logged = (userId: string, purpose: string, count = 1) =>
  vi.waitFor(
    async () => {
      const row = await one(
        env,
        "SELECT count(*) n FROM email_log WHERE user_id=? AND purpose=? AND status<>'sending'",
        userId,
        purpose,
      );
      if (row.n < count) throw new Error("ainda não enviou");
    },
    { timeout: 5000, interval: 50 },
  );
const tokenOf = (text: string, kind = "reset") =>
  text.match(new RegExp(`#${kind}=([a-f0-9]{64})`))?.[1] as string;

describe("e-mail pelo Cloudflare Email Sending", () => {
  it("configuração: token guardado cifrado, teste pela API REST com o remetente", async () => {
    const f = await fixture();
    const admin = await bearer(f.admin);
    const bad = await api(admin, "/system/email/configure", "POST", {
      account_id: "curto",
      token: TOKEN,
      from_address: "a@b.com",
    });
    expect(bad.status).toBe(400);
    const saved = await api(admin, "/system/email/configure", "POST", {
      account_id: ACCOUNT,
      token: TOKEN,
      from_address: "Nao-Responda@Exemplo.com.br",
      from_name: "Atendimento Exemplo",
    });
    expect(saved.status).toBe(200);
    const config = await (await api(admin, "/system/email")).json<any>();
    expect(config).toMatchObject({
      configured: true,
      account_id: ACCOUNT,
      token_configured: true,
      from_address: "nao-responda@exemplo.com.br",
    });
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    const stored = await one(
      env,
      "SELECT value FROM secrets WHERE id='email:config'",
    );
    expect(stored.value).not.toContain(TOKEN);
    // Token vazio mantém o atual (mesma conta).
    expect(
      (
        await api(admin, "/system/email/configure", "POST", {
          account_id: ACCOUNT,
          from_address: "nao-responda@exemplo.com.br",
          from_name: "Outro nome",
        })
      ).status,
    ).toBe(200);
    const test = await api(admin, "/system/email/test", "POST", {});
    expect(test.status).toBe(200);
    expect((await test.json<any>()).status).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/email/sending/send`,
    );
    expect(sent[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(sent[0].body.from).toEqual({
      address: "nao-responda@exemplo.com.br",
      name: "Outro nome",
    });
    expect(sent[0].body.to).toBe(`${f.admin.id}@example.test`);
    expect(sent[0].body.text).toBeTruthy();
    expect(sent[0].body.html).toBeTruthy();
    // Registro sem corpo e com o endereço mascarado.
    const log = await one(
      env,
      "SELECT * FROM email_log WHERE user_id=? AND purpose='test'",
      f.admin.id,
    );
    expect(log.status).toBe("sent");
    expect(log.to_masked).not.toContain(f.admin.id);
    expect(log.to_hash).toBe(await sha(`${f.admin.id}@example.test`));
  });

  it("erros 10105 e 10203 da Cloudflare viram mensagens claras e ficam no registro", async () => {
    const f = await fixture();
    await setupEmail(f);
    const admin = await bearer(f.admin);
    reply = () => failure(10105);
    const entitled = await api(admin, "/system/email/test", "POST", {});
    expect(entitled.status).toBe(409);
    const e1 = (await entitled.json<any>()).error;
    expect(e1.code).toBe("email_not_entitled");
    expect(e1.message).toContain("Workers Paid");
    reply = () => failure(10203);
    const disabled = await api(admin, "/system/email/test", "POST", {});
    expect(disabled.status).toBe(409);
    expect((await disabled.json<any>()).error.code).toBe(
      "email_sending_disabled",
    );
    reply = () => failure(10101, 401);
    const auth = await api(admin, "/system/email/test", "POST", {});
    expect((await auth.json<any>()).error.code).toBe("email_unauthorized");
    const codes = (
      await env.DB.prepare(
        "SELECT error_code FROM email_log WHERE user_id=? AND purpose='test' ORDER BY created,rowid",
      )
        .bind(f.admin.id)
        .all<any>()
    ).results.map((r) => r.error_code);
    expect(codes).toEqual(["10105", "10203", "10101"]);
    // Devolução permanente: registrada como bounced.
    reply = () => ok(true);
    const bounced = await api(admin, "/system/email/test", "POST", {});
    expect((await bounced.json<any>()).status).toBe("bounced");
  });

  it("esqueci a senha: resposta idêntica exista ou não a conta; link de 1 h, uma vez só", async () => {
    const f = await fixture();
    await setupEmail(f);
    const u = await person([f.profile]);
    const status = await (
      await SELF.fetch("https://test/api/auth/status")
    ).json<any>();
    expect(status.email).toBe(true);
    const known = await post("/api/auth/forgot", { email: u.email });
    const unknown = await post("/api/auth/forgot", {
      email: `ninguem-${uid()}@example.test`,
    });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(known.status);
    expect(await unknown.text()).toBe(await known.text());
    await logged(u.id, "account.forgot");
    // Só a conta existente recebeu.
    expect(sent.map((s) => s.body.to)).toEqual([u.email]);
    const mail = sent[0].body;
    const token = tokenOf(mail.text);
    expect(token).toBeTruthy();
    expect(mail.html).toContain(`#reset=${token}`);
    // Nenhum segredo no assunto.
    expect(mail.subject).not.toContain(token);
    expect(mail.subject).not.toMatch(/https?:|#reset/);
    const row = await one(
      env,
      "SELECT expires FROM auth_tokens WHERE hash=?",
      await sha(token),
    );
    expect(row.expires - now()).toBeLessThanOrEqual(FORGOT_TTL_MS);
    expect(row.expires - now()).toBeGreaterThan(FORGOT_TTL_MS - 60000);
    // Usa o link: troca a senha; de novo, 410.
    const reset = await post("/api/auth/reset", {
      token,
      password: "senha-nova-de-teste-123",
    });
    expect(reset.status).toBe(200);
    const again = await post("/api/auth/reset", {
      token,
      password: "outra-senha-de-teste-123",
    });
    expect(again.status).toBe(410);
    // A troca gera o alerta, sem o link.
    await logged(u.id, "account.password_changed");
    const alert = sent.find((s) => s.body.subject.includes("trocada"))!.body;
    expect(alert.to).toBe(u.email);
    expect(alert.text).not.toMatch(/#reset=/);
  });

  it("link do esqueci a senha vencido não vale", async () => {
    const f = await fixture();
    await setupEmail(f);
    const u = await person([f.profile]);
    await post("/api/auth/forgot", { email: u.email });
    await logged(u.id, "account.forgot");
    const token = tokenOf(sent[0].body.text);
    await exec(
      env,
      "UPDATE auth_tokens SET expires=? WHERE hash=?",
      now() - 1,
      await sha(token),
    );
    const expired = await post("/api/auth/reset", {
      token,
      password: "senha-nova-de-teste-123",
    });
    expect(expired.status).toBe(410);
  });

  it("limites: por endereço de rede (429) e por conta (silencioso, mesma resposta)", async () => {
    const f = await fixture();
    await setupEmail(f);
    const u = await person([f.profile]);
    const ip = "10.77.0." + (++ipCounter % 250);
    for (let i = 0; i < 5; i++)
      expect(
        (await post("/api/auth/forgot", { email: `x${i}-${uid()}@e.test` }, ip))
          .status,
      ).toBe(200);
    expect(
      (await post("/api/auth/forgot", { email: u.email }, ip)).status,
    ).toBe(429);
    // Por conta: 3 por hora; o 4.º recebe a mesma resposta e não envia.
    const bodies: string[] = [];
    for (let i = 0; i < 4; i++)
      bodies.push(
        await (await post("/api/auth/forgot", { email: u.email })).text(),
      );
    expect(new Set(bodies).size).toBe(1);
    await logged(u.id, "account.forgot", 3);
    await new Promise((r) => setTimeout(r, 300));
    expect(
      (
        await one(
          env,
          "SELECT count(*) n FROM email_log WHERE user_id=? AND purpose='account.forgot'",
          u.id,
        )
      ).n,
    ).toBe(3);
  });

  it("sem e-mail configurado: esqueci a senha indisponível, convite segue com o link", async () => {
    const f = await fixture();
    await exec(env, "DELETE FROM secrets WHERE id='email:config'");
    const status = await (
      await SELF.fetch("https://test/api/auth/status")
    ).json<any>();
    expect(status.email).toBe(false);
    const forgot = await post("/api/auth/forgot", { email: "a@b.test" });
    expect(forgot.status).toBe(409);
    expect((await forgot.json<any>()).error.code).toBe("email_unavailable");
    const admin = await bearer(f.admin);
    const invite = await (
      await api(admin, "/users/invite", "POST", {
        email: `sem-email-${uid()}@example.test`,
        name: "Convidada",
        role: "operator",
        profiles: [f.profile],
        send_email: true,
      })
    ).json<any>();
    expect(invite.url).toContain("#invite=");
    expect(invite.email_status).toBe("failed");
    expect(invite.email_error.code).toBe("email_unavailable");
    expect(sent).toHaveLength(0);
  });

  it("convite e link de senha por e-mail; alerta ao zerar o segundo fator", async () => {
    const f = await fixture();
    await setupEmail(f);
    const admin = await bearer(f.admin);
    const email = `convite-${uid()}@example.test`;
    const invite = await (
      await api(admin, "/users/invite", "POST", {
        email,
        name: "Convidada",
        role: "operator",
        profiles: [f.profile],
        send_email: true,
      })
    ).json<any>();
    expect(invite.email_status).toBe("sent");
    const mail = sent.at(-1)!.body;
    expect(mail.to).toBe(email);
    expect(mail.subject).toBe("Convite para o Wabotia");
    expect(mail.text).toContain(invite.url);
    // Link de nova senha pedido pelo administrador, com envio.
    const u = await person([f.profile]);
    const link = await (
      await api(admin, `/people/${u.id}/password-link`, "POST", {
        send_email: true,
      })
    ).json<any>();
    expect(link.email_status).toBe("sent");
    expect(sent.at(-1)!.body.text).toContain(link.url);
    expect(sent.at(-1)!.body.subject).not.toContain(tokenOf(link.url));
    // Zerar o segundo fator avisa a pessoa.
    expect(
      (await api(admin, `/people/${u.id}/mfa/reset`, "POST", {})).status,
    ).toBe(200);
    await logged(u.id, "account.mfa_reset");
    expect(sent.at(-1)!.body.to).toBe(u.email);
    // Senha trocada pelo administrador também.
    expect(
      (
        await api(admin, `/users/${u.id}`, "PATCH", {
          password: "senha-trocada-pelo-admin",
        })
      ).status,
    ).toBe(200);
    await logged(u.id, "account.password_changed");
  });

  it("assunto sem segredo", () => {
    expect(() =>
      assertSafeSubject("Sua senha do Wabotia foi trocada"),
    ).not.toThrow();
    for (const bad of [
      "Link: https://exemplo.com/app",
      "Código #reset=abc",
      "Token " + "a".repeat(40),
      "Linha\nquebrada",
      "",
    ])
      expect(() => assertSafeSubject(bad)).toThrow();
  });

  it("ctx.sendEmail: consentimento da finalidade, chave idempotente e limite da área", async () => {
    const f = await fixture();
    await setupEmail(f);
    const r = await receive(f, f.line, "oi", "5511990007777");
    await drain(f);
    const c = await conversation(env, r.id, f.profile);
    const ctx = modulesApi(env, f.profile, "forms");
    const email = {
      to: "cliente@example.test",
      subject: "Sua reserva está confirmada",
      text: "Reserva para sábado, 20h.",
    };
    await expect(
      ctx.sendEmail(c, email, { purpose: "booking", key: "r1" }),
    ).rejects.toMatchObject({ code: "consent_required" });
    expect(sent).toHaveLength(0);
    await ctx.recordConsent(c, { purpose: "booking", source: "panel" });
    const first = await ctx.sendEmail(c, email, {
      purpose: "booking",
      key: "r1",
    });
    expect(first.status).toBe("sent");
    const repeated = await ctx.sendEmail(c, email, {
      purpose: "booking",
      key: "r1",
    });
    expect(repeated).toMatchObject({ id: first.id, repeated: true });
    expect(sent).toHaveLength(1);
    await expect(
      ctx.sendEmail(
        c,
        { ...email, subject: "Pague em https://exemplo.com" },
        { purpose: "booking", key: "r2" },
      ),
    ).rejects.toMatchObject({ code: "invalid_subject" });
    // Limite diário da área.
    const stmt = env.DB.prepare(
      "INSERT INTO email_log(id,profile_id,purpose,to_masked,to_hash,status,created) VALUES(?,?,?,?,?,?,?)",
    );
    await env.DB.batch(
      Array.from({ length: EMAIL_AREA_DAILY }, () =>
        stmt.bind(uid(), f.profile, "booking", "x***@e", "h", "sent", now()),
      ),
    );
    await expect(
      ctx.sendEmail(c, email, { purpose: "booking", key: "r3" }),
    ).rejects.toMatchObject({ code: "email_limit" });
    // A chave já usada continua devolvendo o envio anterior.
    expect(
      (await ctx.sendEmail(c, email, { purpose: "booking", key: "r1" })).id,
    ).toBe(first.id);
  });
});
