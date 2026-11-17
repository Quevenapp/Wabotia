import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { perform } from "../src/service";
import { now, uid, type Actor } from "../src/types";
import { passwordHash, sha } from "../src/security";
import { BRASILIA_OFFSET_MS } from "../src/business-time";
import {
  base32Decode,
  currentStep,
  matchingStep,
  requireAal2,
  sessionAal,
  TOTP_STEP_S,
  TOTP_WINDOW,
  totpAt,
  withinSchedule,
} from "../src/mfa";
import { api, bearer, fixture } from "./service-center-fixture";

const PASSWORD = "senha-de-teste-12345";
let ipCounter = 0;
const enc = new TextEncoder();

async function person(
  role: "admin" | "operator",
  profiles: string[],
  extra: any = {},
) {
  const id = uid(),
    email = `${id}@example.test`;
  await exec(
    env,
    "INSERT INTO users(id,email,name,password,role,profiles,schedule,created) VALUES(?,?,?,?,?,?,?,?)",
    id,
    email,
    "Pessoa " + id.slice(0, 4),
    passwordHash(PASSWORD),
    role,
    JSON.stringify(profiles),
    extra.schedule ? JSON.stringify(extra.schedule) : null,
    now(),
  );
  return { id, email };
}
const post = (path: string, body: any) =>
  SELF.fetch("https://test" + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "10.9.0." + (++ipCounter % 250),
    },
    body: JSON.stringify(body),
  });
const mobileLogin = (email: string, extra: any = {}) =>
  post("/api/auth/mobile/login", {
    email,
    password: PASSWORD,
    device: { platform: "android", name: "Teste" },
    ...extra,
  });
async function policy(value: string) {
  await exec(
    env,
    "INSERT INTO instance_settings(key,value,updated) VALUES('mfa_policy',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    value,
    now(),
  );
}
afterEach(async () => {
  vi.restoreAllMocks();
  await policy("off");
});

const STEP_MS = TOTP_STEP_S * 1000;
/**
 * Relógio injetado: o teste escolhe o instante e o Date.now fica parado nele
 * até a próxima troca (o do teste e o do servidor: SELF roda no mesmo
 * isolate). Com o relógio de verdade, a virada do passo de 30 s entre o
 * código calculado pelo teste e a conferência do servidor (azar que a carga
 * da suíte torna comum) mudava a distância medida: o "+2" virava +1 e
 * entrava, o cadastro com "-1" virava -2 e era recusado.
 */
const clock = (ms: number) => {
  vi.spyOn(Date, "now").mockReturnValue(ms);
  return ms;
};
/** Um passo pouco à frente da hora real; o teste escolhe o instante nele. */
const aheadStep = () => currentStep(Date.now()) + 2;

/** Cadastra o fator pela API e devolve o segredo e o token aal2. */
async function enroll(email: string, offset = 0) {
  const login = await (await mobileLogin(email)).json<any>();
  const started = await (
    await api(login.token, "/account/mfa/enroll", "POST", {
      password: PASSWORD,
    })
  ).json<any>();
  const secret = base32Decode(started.secret);
  const verified = await api(login.token, "/account/mfa/verify", "POST", {
    factor_id: started.factor_id,
    code: await totpAt(secret, currentStep() + offset),
  });
  return { token: login.token, secret, verified: await verified.json<any>() };
}

describe("segundo fator (TOTP)", () => {
  // Cada teste começa no meio de um passo, com o relógio parado: o código
  // calculado aqui e a conferência no servidor caem no mesmo passo, e o
  // limite de erros (balde de 15 min) não vira no meio.
  beforeEach(() => {
    clock(aheadStep() * STEP_MS + STEP_MS / 2);
  });

  it("vetor da RFC 6238 (SHA-1, T=59 s)", async () => {
    const secret = enc.encode("12345678901234567890");
    // 94287082 com 8 dígitos; os 6 finais.
    expect(await totpAt(secret, 1)).toBe("287082");
  });

  it("cadastro, login com código e o mesmo código não vale duas vezes", async () => {
    const f = await fixture();
    const u = await person("operator", [f.profile]);
    const { secret, verified } = await enroll(u.email);
    expect(verified.aal).toBe(2);
    expect(verified.recovery_codes).toHaveLength(10);
    // Sem código: 401 mfa_required e nenhuma sessão.
    const before = (
      await one(env, "SELECT count(*) n FROM sessions WHERE user_id=?", u.id)
    ).n;
    const missing = await mobileLogin(u.email);
    expect(missing.status).toBe(401);
    expect((await missing.json<any>()).error.code).toBe("mfa_required");
    expect(
      (await one(env, "SELECT count(*) n FROM sessions WHERE user_id=?", u.id))
        .n,
    ).toBe(before);
    // O código do passo seguinte (relógio +1) entra; repetir o mesmo, não.
    const next = await totpAt(secret, currentStep() + 1);
    const ok = await mobileLogin(u.email, { totp: next });
    expect(ok.status).toBe(200);
    expect((await ok.json<any>()).aal).toBe(2);
    const replay = await mobileLogin(u.email, { totp: next });
    expect(replay.status).toBe(401);
    expect((await replay.json<any>()).error.code).toBe("invalid_code");
  });

  it("relógio: a janela é um passo de cada lado, inclusive a um segundo da virada", async () => {
    // A regra de produção: o passo do servidor e um de cada lado (±30 s).
    expect(TOTP_WINDOW).toBe(1);
    const secret = enc.encode("12345678901234567890");
    // Instante fixo, um segundo antes da virada do passo s para s+1.
    const s = currentStep(Date.parse("2026-11-17T12:00:00-03:00"));
    const edge = (s + 1) * STEP_MS - 1000;
    expect(currentStep(edge)).toBe(s);
    expect(currentStep(edge + 1000)).toBe(s + 1);
    const at = async (step: number, instant: number) =>
      matchingStep(secret, await totpAt(secret, step), instant);
    expect(await at(s - 2, edge)).toBeNull();
    expect(await at(s - 1, edge)).toBe(s - 1);
    expect(await at(s, edge)).toBe(s);
    expect(await at(s + 1, edge)).toBe(s + 1);
    expect(await at(s + 2, edge)).toBeNull();
    // Um segundo depois, virou: s-1 sai da janela, s+2 entra.
    expect(await at(s - 1, edge + 1000)).toBeNull();
    expect(await at(s, edge + 1000)).toBe(s);
    expect(await at(s + 2, edge + 1000)).toBe(s + 2);
    expect(await at(s + 3, edge + 1000)).toBeNull();
  });

  it("relógio pelo login, a um segundo da virada: celular atrasado entra; +2 e código já usado, não", async () => {
    const s = aheadStep();
    clock((s + 1) * STEP_MS - 1000);
    const f = await fixture();
    const u = await person("operator", [f.profile]);
    // Cadastro com o código do passo anterior (relógio do celular atrasado).
    const { secret, verified } = await enroll(u.email, -1);
    expect(verified.aal).toBe(2);
    const login = async (step: number) =>
      mobileLogin(u.email, { totp: await totpAt(secret, step) });
    const refused = async (step: number) => {
      const r = await login(step);
      expect(r.status).toBe(401);
      expect((await r.json<any>()).error.code).toBe("invalid_code");
    };
    await refused(s + 2);
    // O código do cadastro (s-1) ainda está na janela, mas já foi usado.
    await refused(s - 1);
    expect((await login(s)).status).toBe(200);
    // Vira o passo: s continua na janela (um atrás), mas já foi usado; s+2,
    // recusado um segundo antes, agora entra.
    clock((s + 1) * STEP_MS);
    await refused(s);
    expect((await login(s + 2)).status).toBe(200);
  });

  it("seis erros: o sexto pedido é recusado mesmo com o código certo", async () => {
    const f = await fixture();
    const u = await person("operator", [f.profile]);
    const { secret } = await enroll(u.email);
    for (let i = 0; i < 5; i++) {
      const wrong = await mobileLogin(u.email, { totp: "000000" });
      expect(wrong.status).toBe(401);
    }
    const locked = await mobileLogin(u.email, {
      totp: await totpAt(secret, currentStep() + 1),
    });
    expect(locked.status).toBe(429);
    expect((await locked.json<any>()).error.code).toBe("mfa_locked");
  });

  it("código de recuperação vale uma vez", async () => {
    const f = await fixture();
    const u = await person("operator", [f.profile]);
    const { verified } = await enroll(u.email);
    const code = verified.recovery_codes[0];
    expect((await mobileLogin(u.email, { recovery_code: code })).status).toBe(
      200,
    );
    expect((await mobileLogin(u.email, { recovery_code: code })).status).toBe(
      401,
    );
  });

  it("elevação sob demanda: sessão aal1 de quem tem fator segue; a ação que exige pede o código", async () => {
    const f = await fixture();
    const u = await person("operator", [f.profile]);
    const { secret } = await enroll(u.email);
    // Sessão antiga em aal1 (criada antes do fator): continua trabalhando.
    const old = await bearer({ id: u.id } as Actor);
    expect(
      (await api(old, `/profiles/${f.profile}/conversations`)).status,
    ).toBe(200);
    const blocked = await api(old, "/account/mfa/recovery-codes", "POST", {});
    expect(blocked.status).toBe(403);
    expect((await blocked.json<any>()).error.code).toBe("mfa_required");
    const challenge = await api(old, "/account/mfa/challenge", "POST", {
      code: await totpAt(secret, currentStep() + 1),
    });
    expect(challenge.status).toBe(200);
    expect(
      (await api(old, "/account/mfa/recovery-codes", "POST", {})).status,
    ).toBe(200);
  });

  it("política all: sessão aal1 de quem tem fator só confirma o código", async () => {
    const f = await fixture();
    const u = await person("operator", [f.profile]);
    const { secret } = await enroll(u.email);
    await policy("all");
    const old = await bearer({ id: u.id } as Actor);
    const blocked = await api(old, `/profiles/${f.profile}/conversations`);
    expect(blocked.status).toBe(403);
    expect((await blocked.json<any>()).error.code).toBe("mfa_required");
    expect((await api(old, "/me")).status).toBe(200);
    await api(old, "/account/mfa/challenge", "POST", {
      code: await totpAt(secret, currentStep() + 1),
    });
    expect(
      (await api(old, `/profiles/${f.profile}/conversations`)).status,
    ).toBe(200);
  });

  it("a confirmação vale 12 h no cookie e 7 dias no app; a renovação não reinicia o prazo", async () => {
    expect(sessionAal("cookie", 2, now() - 11 * 3600000)).toBe(2);
    expect(sessionAal("cookie", 2, now() - 13 * 3600000)).toBe(1);
    expect(sessionAal("bearer", 2, now() - 6 * 86400000)).toBe(2);
    expect(sessionAal("bearer", 2, now() - 8 * 86400000)).toBe(1);
    expect(sessionAal("bearer", 1, now())).toBe(1);
    const f = await fixture();
    const u = await person("operator", [f.profile]);
    const { secret } = await enroll(u.email);
    const login = await (
      await mobileLogin(u.email, {
        totp: await totpAt(secret, currentStep() + 1),
      })
    ).json<any>();
    expect(login.aal).toBe(2);
    // Código de 3 dias atrás: ainda aal2; a renovação guarda o mesmo horário.
    const earlier = now() - 3 * 86400000;
    await exec(
      env,
      "UPDATE sessions SET mfa_at=? WHERE user_id=? AND kind='bearer' AND aal=2",
      earlier,
      u.id,
    );
    expect((await (await api(login.token, "/me")).json<any>()).aal).toBe(2);
    const renewed = await (
      await api(login.token, "/auth/mobile/refresh", "POST", {})
    ).json<any>();
    expect(renewed.aal).toBe(2);
    const row = await one(
      env,
      "SELECT mfa_at FROM sessions WHERE hash=?",
      await sha(renewed.token),
    );
    expect(row.mfa_at).toBe(earlier);
    // Passados 7 dias do código, a sessão renovada volta a aal1.
    await exec(
      env,
      "UPDATE sessions SET mfa_at=? WHERE hash=?",
      now() - 8 * 86400000,
      await sha(renewed.token),
    );
    expect((await (await api(renewed.token, "/me")).json<any>()).aal).toBe(1);
  });

  it("rota que exige aal2 recusa sessão sem segundo fator e chave de aplicação", async () => {
    const f = await fixture();
    const u = await person("operator", [f.profile]);
    const token = (await (await mobileLogin(u.email)).json<any>()).token;
    const r = await api(token, "/account/mfa/recovery-codes", "POST", {});
    expect(r.status).toBe(403);
    expect((await r.json<any>()).error.code).toBe("mfa_required");
    const app = { kind: "app", id: "app:x", aal: 2 } as unknown as Actor;
    expect(() => requireAal2(app)).toThrow();
  });

  it("política financial: operação financeira de pessoa exige aal2", async () => {
    const f = await fixture();
    await policy("financial");
    const actor = {
      ...f.admin,
      sessionId: uid(),
      aal: 1,
      mfa: { factor: false, policy: "financial" },
    } as Actor;
    await expect(
      perform(env, actor, f.profile, "payment.account.save", {}, uid()),
    ).rejects.toMatchObject({ code: "mfa_required" });
    // Sem a política, a mesma pessoa passa do portão (e cai na validação).
    await expect(
      perform(
        env,
        { ...actor, mfa: { factor: false, policy: "off" } } as Actor,
        f.profile,
        "payment.account.save",
        {},
        uid(),
      ),
    ).rejects.not.toMatchObject({ code: "mfa_required" });
  });

  it("política all: sem fator, a sessão só cadastra o fator", async () => {
    const f = await fixture();
    const u = await person("operator", [f.profile]);
    await policy("all");
    const login = await (await mobileLogin(u.email)).json<any>();
    expect(login.aal).toBe(1);
    expect(login.mfa.next).toBe("enroll");
    expect(
      (await api(login.token, `/profiles/${f.profile}/conversations`)).status,
    ).toBe(403);
    const enrolled = await api(login.token, "/account/mfa/enroll", "POST", {
      password: PASSWORD,
    });
    expect(enrolled.status).toBe(200);
  });
});

describe("links de uso único, convite e recuperação", () => {
  it("o administrador gera o link de redefinir senha; vale uma vez", async () => {
    const f = await fixture();
    const u = await person("operator", [f.profile]);
    const adminToken = await bearer(f.admin);
    const r = await api(
      adminToken,
      `/people/${u.id}/password-link`,
      "POST",
      {},
    );
    expect(r.status).toBe(200);
    const { url } = await r.json<any>();
    const token = /#reset=([a-f0-9]{64})$/.exec(url)![1];
    const info = await (
      await post("/api/auth/link-info", { token })
    ).json<any>();
    expect(info).toMatchObject({ purpose: "reset", email: u.email });
    const userToken = (await (await mobileLogin(u.email)).json<any>()).token;
    const newPassword = "outra-senha-forte-987";
    expect(
      (await post("/api/auth/reset", { token, password: newPassword })).status,
    ).toBe(200);
    // Sessões derrubadas; a senha nova vale; o link não vale de novo.
    expect((await api(userToken, "/me")).status).toBe(401);
    const login = await post("/api/auth/mobile/login", {
      email: u.email,
      password: newPassword,
      device: { platform: "android" },
    });
    expect(login.status).toBe(200);
    expect(
      (await post("/api/auth/reset", { token, password: newPassword })).status,
    ).toBe(410);
    // Link de redefinição não serve para aceitar convite.
    const again = await api(
      adminToken,
      `/people/${u.id}/password-link`,
      "POST",
      {},
    );
    const token2 = /#reset=([a-f0-9]{64})$/.exec(
      (await again.json<any>()).url,
    )![1];
    expect(
      (
        await post("/api/auth/invite/accept", {
          token: token2,
          password: newPassword,
        })
      ).status,
    ).toBe(410);
  });

  it("convite: a pessoa nasce sem senha e cria a dela em 72 h", async () => {
    const start = clock(aheadStep() * STEP_MS);
    const f = await fixture();
    const adminToken = await bearer(f.admin);
    const email = `convite-${uid()}@example.test`;
    const r = await api(adminToken, "/users/invite", "POST", {
      email,
      name: "Convidada",
      role: "operator",
      profiles: [f.profile],
      access: ["os"],
    });
    expect(r.status).toBe(200);
    const body = await r.json<any>();
    expect(body.expires_at).toBe(start + 72 * 3600000);
    const token = /#invite=([a-f0-9]{64})$/.exec(body.url)![1];
    // Antes de aceitar, nenhuma senha entra.
    expect((await mobileLogin(email)).status).toBe(401);
    expect(
      (await post("/api/auth/invite/accept", { token, password: PASSWORD }))
        .status,
    ).toBe(200);
    expect((await mobileLogin(email)).status).toBe(200);
    expect(
      (await post("/api/auth/invite/accept", { token, password: PASSWORD }))
        .status,
    ).toBe(410);
  });

  it("recuperar o administrador único com o SETUP_TOKEN", async () => {
    expect(
      (
        await post("/api/auth/recover-admin", {
          setup_token: "errado",
          password: PASSWORD,
        })
      ).status,
    ).toBe(403);
    const boss = await person("admin", []);
    await enroll(boss.email);
    // Com mais de um administrador ativo, quem resolve é outro administrador.
    const others = (
      await all(
        env,
        "SELECT id FROM users WHERE role='admin' AND disabled=0 AND id<>?",
        boss.id,
      )
    ).map((r) => r.id);
    if (others.length)
      expect(
        (
          await post("/api/auth/recover-admin", {
            setup_token: "test-setup-token",
            password: PASSWORD,
          })
        ).status,
      ).toBe(409);
    await exec(
      env,
      "UPDATE users SET disabled=1 WHERE id IN (SELECT value FROM json_each(?))",
      JSON.stringify(others),
    );
    try {
      const newPassword = "senha-recuperada-4567";
      const r = await post("/api/auth/recover-admin", {
        setup_token: "test-setup-token",
        password: newPassword,
      });
      expect(r.status).toBe(200);
      // Fator removido: entra só com a senha nova.
      const login = await post("/api/auth/mobile/login", {
        email: boss.email,
        password: newPassword,
        device: { platform: "ios" },
      });
      expect(login.status).toBe(200);
      expect(
        (
          await one(
            env,
            "SELECT count(*) n FROM user_factors WHERE user_id=?",
            boss.id,
          )
        ).n,
      ).toBe(0);
    } finally {
      await exec(
        env,
        "UPDATE users SET disabled=0 WHERE id IN (SELECT value FROM json_each(?))",
        JSON.stringify(others),
      );
      await exec(env, "UPDATE users SET disabled=1 WHERE id=?", boss.id);
    }
  });
});

describe("horário de acesso", () => {
  it("fora do horário não entra; o administrador é isento", async () => {
    // Relógio parado ao meio-dia de Brasília: com o relógio de verdade, a
    // meia-noite entre "hoje" e o login trocava o dia no meio do teste.
    const local = new Date(Date.now() - BRASILIA_OFFSET_MS);
    clock(
      Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate(),
        12,
      ) + BRASILIA_OFFSET_MS,
    );
    const f = await fixture();
    const today = local.getUTCDay();
    const others = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== today);
    const closed = {
      enabled: true,
      windows: [{ start: "00:00", end: "23:59", days: others }],
    };
    const open = {
      enabled: true,
      windows: [{ start: "00:00", end: "23:59", days: [today] }],
    };
    expect(withinSchedule(closed)).toBe(false);
    const late = await person("operator", [f.profile], { schedule: closed });
    const r = await mobileLogin(late.email);
    expect(r.status).toBe(403);
    expect((await r.json<any>()).error.code).toBe("outside_schedule");
    const ok = await person("operator", [f.profile], { schedule: open });
    expect((await mobileLogin(ok.email)).status).toBe(200);
    const boss = await person("admin", [], { schedule: closed });
    expect((await mobileLogin(boss.email)).status).toBe(200);
    // Sessão aberta e horário fechado depois: a próxima chamada recusa.
    const token = (await (await mobileLogin(ok.email)).json<any>()).token;
    await exec(
      env,
      "UPDATE users SET schedule=? WHERE id=?",
      JSON.stringify(closed),
      ok.id,
    );
    expect((await api(token, "/me")).status).toBe(403);
  });

  it("valida o formato do Fagoo ao gravar", async () => {
    const f = await fixture();
    const u = await person("operator", [f.profile]);
    const run = (schedule: any) =>
      perform(
        env,
        f.admin,
        f.profile,
        "user.update",
        { id: u.id, schedule },
        uid(),
      );
    await expect(run({ enabled: true, windows: [] })).rejects.toThrow(
      "Horário de acesso",
    );
    await expect(
      run({
        enabled: true,
        windows: [{ start: "18:00", end: "08:00", days: [1] }],
      }),
    ).rejects.toThrow("Horário de acesso");
    await expect(
      run({
        enabled: true,
        windows: [{ start: "08:00", end: "18:00", days: [3, 1] }],
      }),
    ).rejects.toThrow("Horário de acesso");
    await run({
      enabled: true,
      windows: [{ start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] }],
    });
    await run(null);
  });
});
