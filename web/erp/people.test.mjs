// Pessoas e segundo fator do ERP vindos do núcleo (decisão de 16/11; motor
// 308e227): leitura de GET /api/v1/profiles/<área>/people, a confirmação
// "Confirme que é você", os contratos da API simulada e a tela Permissões no
// ERP (web/erp/ErpPermissions.tsx).
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createPeoplePort, erpPeople } from "./people.ts";
import { ChallengeError, createChallengePort } from "./session-port.ts";
import { mountComponent } from "./test/helpers/component-recovery-harness.mjs";
import { createUsersFixture, USERS_QA_ADMIN } from "./app/qa/users-fixture.ts";
import { parseControls } from "../../packages/erp-domain/src/user-permissions.mjs";
import { parseSecurityPolicy } from "../../packages/erp-domain/src/access-security.mjs";

const id = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const VENDAS = "30000000-0000-4000-8000-000000000001";

test("o papel no ERP vem do acesso por pessoa; o administrador do Wabotia vale erp:admin", () => {
  const people = erpPeople({
    data: [
      {
        id: id(1),
        name: "Zé Vendas",
        role: "operator",
        grants: ["erp:vendas", "os:technician"],
      },
      { id: id(2), name: "Ana Admin", role: "admin", grants: [] },
      {
        id: id(3),
        name: "Sem papel",
        role: "operator",
        grants: ["caixa:cashier"],
      },
      {
        id: id(4),
        name: "Dois papéis",
        role: "operator",
        grants: ["erp:vendas", "erp:fiscal"],
      },
      {
        id: "nao-uuid",
        name: "Inválido",
        role: "operator",
        grants: ["erp:consulta"],
      },
      { id: id(5), name: "", role: "operator", grants: ["erp:fiscal"] },
      {
        id: id(1),
        name: "Repetido",
        role: "operator",
        grants: ["erp:consulta"],
      },
    ],
  });
  assert.deepEqual(people, [
    { user_id: id(2), name: "Ana Admin", role: "admin" },
    { user_id: id(5), name: "Sem nome", role: "fiscal" },
    { user_id: id(1), name: "Zé Vendas", role: "vendas" },
  ]);
  assert.throws(() => erpPeople({}), /ERP_PEOPLE_INVALID/);
});

test("a porta lê as pessoas da área pelo cookie e recusa resposta de erro", async () => {
  const calls = [];
  const port = createPeoplePort("Área 1", async (url, init) => {
    calls.push([url, init.credentials]);
    return new Response(
      JSON.stringify({
        data: [{ id: id(1), name: "Ana", role: "admin", grants: [] }],
      }),
    );
  });
  assert.equal((await port(new AbortController().signal)).length, 1);
  assert.deepEqual(calls, [
    ["/api/v1/profiles/%C3%81rea%201/people", "same-origin"],
  ]);
  const refused = createPeoplePort(
    "a",
    async () => new Response("{}", { status: 403 }),
  );
  await assert.rejects(
    () => refused(new AbortController().signal),
    (e) => e.status === 403,
  );
});

test("Confirme que é você: código ao núcleo; código errado, bloqueio e falta de fator viram motivos", async () => {
  const sent = [];
  const answer = (status, code) => async (url, init) => {
    sent.push([
      url,
      init.method,
      JSON.parse(init.body),
      init.headers["Idempotency-Key"] ? "key" : "none",
    ]);
    return new Response(JSON.stringify(code ? { error: { code } } : {}), {
      status,
    });
  };
  await createChallengePort(answer(200))({ code: "123456" });
  assert.deepEqual(sent[0], [
    "/api/v1/account/mfa/challenge",
    "POST",
    { code: "123456" },
    "key",
  ]);
  for (const [status, code, reason] of [
    [401, "invalid_code", "invalid_code"],
    [429, "mfa_locked", "mfa_locked"],
    [409, "mfa_enroll_first", "no_factor"],
    [500, undefined, "unavailable"],
  ])
    await assert.rejects(
      () => createChallengePort(answer(status, code))({ recovery_code: "abc" }),
      (e) => e instanceof ChallengeError && e.reason === reason,
    );
  await assert.rejects(
    () =>
      createChallengePort(async () => {
        throw new TypeError("rede");
      })({ code: "1" }),
    (e) => e.reason === "unavailable",
  );
});

test("API simulada: rotas de usuários do Fagoo dão 501; controles e política seguem os contratos do ERP", async () => {
  // Os módulos da demonstração importam sem extensão (Vite): o teste os empacota.
  const bundled = await build({
    entryPoints: [
      fileURLToPath(new URL("./demo/simulated-api.ts", import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    logLevel: "silent",
    define: { "import.meta.env.DEV": "false" },
  });
  const { createSimulatedApi, simulatedPeople } = await import(
    "data:text/javascript;base64," +
      Buffer.from(bundled.outputFiles[0].text).toString("base64")
  );
  const actor = "d3e00000-0000-4000-8000-000000000001";
  const api = createSimulatedApi({ actor, readOnly: true });
  for (const path of [
    "/v1/usuarios",
    `/v1/usuarios/${actor}`,
    "/v1/usuarios/convites",
    "/v1/usuarios/comandos/x",
    `/v1/sistema/usuarios/${actor}/seguranca`,
    `/v1/seguranca/usuarios/${actor}/redefinir-mfa`,
  ])
    for (const method of ["GET", "POST"])
      assert.equal(
        (await api(path, { method })).status,
        501,
        `${method} ${path}`,
      );
  const people = simulatedPeople(actor);
  assert.equal(people[0].role, "admin");
  for (const person of people) {
    const response = await api(`/v1/usuarios/${person.user_id}/controles`, {
      method: "GET",
    });
    assert.equal(
      parseControls(await response.json(), person.user_id).role,
      person.role,
    );
  }
  assert.equal(
    (await api(`/v1/usuarios/${id(9)}/controles`, { method: "GET" })).status,
    404,
  );
  const policy = parseSecurityPolicy(
    await (await api("/v1/seguranca/politica", { method: "GET" })).json(),
  );
  assert.deepEqual(policy.policy.members.map((m) => m.role).sort(), [
    "admin",
    "financeiro",
  ]);
  assert.equal(
    (await api(`/v1/usuarios/${actor}/controles`, { method: "POST" })).status,
    403,
  );
});

const mountPermissions = (f, erp) =>
  mountComponent(
    "../../ErpPermissions.tsx",
    { controller: f.controller },
    {
      expandChildren: true,
      location: "/preferencias/sistema/usuarios",
      ports: { erp },
      modules: { "./ports": "export const erpPorts=()=>r.erp;" },
    },
  );

test("Permissões no ERP: pessoas do núcleo, controles do ERP e os atalhos para Pessoas e acessos", async () => {
  const f = createUsersFixture();
  let opened = 0;
  const erp = {
    people: async () => [
      {
        user_id: USERS_QA_ADMIN,
        name: "Administrador Sintético",
        role: "admin",
      },
      { user_id: VENDAS, name: "Vendas Sintético", role: "vendas" },
    ],
    openPeople: () => opened++,
  };
  const v = await mountPermissions(f, erp);
  try {
    assert.match(v.text(), /Permissões no ERP/);
    assert.match(v.text(), /Administrador Sintético \(você\)Administrador/);
    assert.match(v.text(), /Vendas SintéticoVendas/);
    assert.match(v.text(), /2 pessoa\(s\) com papel no ERP/);
    assert.equal(
      f.calls.some((c) => /^\/v1\/usuarios(\?|$)/.test(c.path)),
      false,
      "a lista do Fagoo não é chamada",
    );
    await v.click("Abrir Pessoas e acessos");
    assert.equal(opened, 1);
    await v.change("erp-people-role", "vendas");
    assert.doesNotMatch(v.text(), /Administrador Sintético/);
    await v.change("erp-people-role", "");
    await v.change("erp-people-search", "vendas");
    assert.doesNotMatch(v.text(), /Administrador Sintético/);
    await v.click("Tipo, horários e permissões");
    assert.ok(
      f.calls.some(
        (c) =>
          c.method === "GET" && c.path === `/v1/usuarios/${VENDAS}/controles`,
      ),
    );
    assert.match(v.text(), /Restringir horários de acesso/);
  } finally {
    v.unmount();
  }
  const empty = await mountPermissions(createUsersFixture(), {
    people: async () => [],
  });
  try {
    assert.match(empty.text(), /Ninguém tem papel no ERP/);
    assert.equal(
      empty
        .nodes()
        .some(
          (n) =>
            n.type === "button" &&
            /Abrir Pessoas/.test(JSON.stringify(n.props.children)),
        ),
      false,
    );
  } finally {
    empty.unmount();
  }
  const failing = await mountPermissions(createUsersFixture(), {
    people: async () => {
      throw new Error("rede");
    },
  });
  try {
    assert.match(
      failing.text(),
      /Não foi possível carregar as pessoas da área/,
    );
  } finally {
    failing.unmount();
  }
  const seller = await mountPermissions(
    createUsersFixture({ role: "vendas" }),
    erp,
  );
  try {
    assert.match(
      seller.text(),
      /Somente o administrador do ERP ajusta as permissões/,
    );
  } finally {
    seller.unmount();
  }
});

// ---------------------------------------------------------------- Telas de espera e Segurança

const ACTOR = "10000000-0000-4000-8000-000000000001";
const stubPorts = (challenge) =>
  `export const erpPorts=()=>({auth:{},apiUrl:"https://api.synthetic.test",fetch:globalThis.fetch,demo:false,people:async()=>[],challenge:r.challenge${challenge ? "" : "??(async()=>{})"},openAccount:r.openAccount});`;
async function mountPhase(phase, challenge) {
  const { readFile } = await import("node:fs/promises");
  const names = [
    ...String(
      await readFile(
        new URL("./app/components/native-modules.ts", import.meta.url),
        "utf8",
      ),
    ).matchAll(/export const (\w+) = lazy/g),
  ].map((x) => x[1]);
  const access = await import("./app/lib/real-access.ts");
  let retried = 0;
  const state = {
    phase,
    membership: null,
    permissionMessage: null,
    records: null,
    listPending: false,
    loginPending: false,
    message: null,
    logoutFailed: false,
  };
  const controller = {
    start: () => () => {},
    subscribe: () => () => {},
    getSnapshot: () => state,
    retry() {
      retried++;
    },
    logout() {},
  };
  const view = await mountComponent(
    "RealAccess.tsx",
    {},
    {
      componentName: "ConnectedArea",
      location: "/inicio",
      expandChildren: ["IdentityChallenge"],
      ports: { access, controller, challenge, openAccount: undefined },
      modules: {
        "../lib/real-access":
          "export const createAccessController=()=>r.controller;export const {AccessError,decimalMoney,RESOURCE_LABELS,ROLE_LABELS}=r.access;",
        "../../ports": stubPorts(challenge),
        "./ports": stubPorts(challenge),
        "./CompanyNavigation":
          "export default function CompanyNavigation(){return null;}",
        "./NativeModuleBoundary":
          "export default function NativeModuleBoundary({children}){return children;}",
        "./native-modules": names
          .map((n) => `export function ${n}(){return null;}`)
          .join(""),
      },
    },
  );
  return { view, retried: () => retried };
}

test("sem papel erp:* o ERP pede o papel em Gestão › Pessoas e acessos", async () => {
  const { view } = await mountPhase("pending");
  try {
    assert.match(view.text(), /Acesso aguardando liberação/);
    assert.match(
      view.text(),
      /ainda não tem um papel no ERP desta área\. O administrador dá o papel em Gestão › Pessoas e acessos/,
    );
  } finally {
    view.unmount();
  }
});

test("ERP_MFA_REQUIRED abre o Confirme que é você do Wabotia e recarrega o acesso", async () => {
  const sent = [];
  const challenge = async (input) => {
    sent.push(input);
    if (input.code === "000000") throw new ChallengeError("invalid_code");
  };
  const { view, retried } = await mountPhase("mfa", challenge);
  try {
    assert.match(view.text(), /Confirme que é você/);
    assert.match(view.text(), /Gestão › Pessoas e acessos/);
    await view.change("identity-code", "12");
    await view.submit();
    assert.match(view.text(), /Digite os 6 números/);
    assert.equal(sent.length, 0);
    await view.change("identity-code", "000000");
    await view.submit();
    assert.match(view.text(), /Código errado ou já usado/);
    assert.equal(retried(), 0);
    await view.click("Usar um código de recuperação");
    await view.change("identity-code", "abcd-efgh");
    await view.submit();
    assert.deepEqual(sent, [
      { code: "000000" },
      { recovery_code: "abcd-efgh" },
    ]);
    assert.equal(retried(), 1, "o acesso é conferido de novo");
  } finally {
    view.unmount();
  }
});

test("Minha conta › Segurança: senha e aplicativo no Wabotia; a exigência do ERP pede a confirmação antes", async () => {
  const policy = (aal2) => ({
    scope: "access_security_policy",
    data_mode: "erp_native",
    policy: {
      mfa_required: false,
      version: 0,
      updated_at: null,
      members: [{ user_id: ACTOR, name: "Ana", role: "admin", factor: true }],
    },
    self: { factor: true, aal2 },
  });
  let reads = 0,
    confirmed = false,
    opened = 0;
  const controller = {
    getSnapshot: () => ({ membership: { role: "admin", user_id: ACTOR } }),
    security: async () => (reads++, policy(confirmed)),
  };
  const view = await mountComponent(
    "AccountSecurity.tsx",
    { controller },
    {
      expandChildren: ["IdentityChallenge"],
      ports: {
        challenge: async () => {
          confirmed = true;
        },
        openAccount: () => opened++,
      },
      modules: {
        "../../ports": stubPorts(true),
        "./ports": stubPorts(true),
      },
    },
  );
  try {
    assert.match(
      view.text(),
      /Troque a senha e cadastre ou remova o aplicativo em Minha conta/,
    );
    await view.click("Abrir Minha conta");
    assert.equal(opened, 1);
    assert.equal(
      view
        .nodes()
        .some(
          (n) => n.type === "button" && n.props.children === "Ligar exigência",
        ),
      false,
    );
    await view.change("identity-code", "123456");
    await view.submit();
    assert.equal(reads, 2, "a política é lida de novo depois da confirmação");
    assert.equal(view.button("Ligar exigência").disabled, false);
  } finally {
    view.unmount();
  }
});
