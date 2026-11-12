import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { listMenus } from "../src/line-service";
import { perform, settings } from "../src/service";
import { sha } from "../src/security";
import { defaults, json, now, uid, type Actor } from "../src/types";

async function fixture() {
  const profile = uid(),
    user = uid(),
    token = "wabu_" + uid();
  const menus = [
    {
      id: "support",
      label: "Suporte",
      type: "submenu",
      parent_id: null,
      enabled: true,
    },
  ];
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,'Menus',?,?)",
    profile,
    JSON.stringify({ ...defaults, instructions: "Manter instruções", menus }),
    now(),
  );
  await exec(
    env,
    "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,'Admin','unused','admin',?,?)",
    user,
    `${user}@example.test`,
    JSON.stringify([profile]),
    now(),
  );
  await exec(
    env,
    "INSERT INTO sessions(hash,user_id,expires,kind,created) VALUES(?,?,?,'bearer',?)",
    await sha(token),
    user,
    now() + 600000,
    now(),
  );
  const actor: Actor = {
    id: user,
    kind: "user",
    role: "admin",
    name: "Admin",
    profiles: [profile],
    scopes: [],
    bots: [],
    rate: 300,
    runLimit: 3,
  };
  return { profile, actor, token, menus };
}
const child = (id: string, label = id) => ({
  id,
  label,
  type: "content",
  content: `Conteúdo ${id}`,
  parent_id: "support",
  enabled: true,
});
const read = (f: Awaited<ReturnType<typeof fixture>>, connection?: string) =>
  listMenus(env, f.actor, f.profile, connection);
const write = (f: Awaited<ReturnType<typeof fixture>>, data: any) =>
  perform(env, f.actor, f.profile, "settings", data, uid());
const persisted = async (profile: string) =>
  json(
    (await one(env, "SELECT settings FROM profiles WHERE id=?", profile))
      .settings,
  );
function apiWrite(
  f: Awaited<ReturnType<typeof fixture>>,
  data: any,
  key = uid(),
  token: string | null = f.token,
  profile = f.profile,
) {
  return SELF.fetch(`https://test/api/v1/profiles/${profile}/settings`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(data),
  });
}

it("duas abas com a mesma revisão não perdem o primeiro filho salvo", async () => {
  const f = await fixture(),
    tabA = await read(f),
    tabB = await read(f);
  expect(tabA.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(tabA.revision).toBe(await sha(JSON.stringify(tabA.data)));
  expect(tabB.revision).toBe(tabA.revision);
  await write(f, {
    menus: [...tabA.data, child("printer")],
    menus_revision: tabA.revision,
  });
  await expect(
    write(f, {
      menus: [...tabB.data, child("computer")],
      menus_revision: tabB.revision,
    }),
  ).rejects.toMatchObject({ status: 409, code: "menus_changed" });
  const saved = await read(f);
  expect(saved.data.map((item: any) => item.id)).toEqual([
    "support",
    "printer",
  ]);
  expect(saved.revision).not.toBe(tabA.revision);
  const result = await write(f, {
    menus: [...saved.data, child("computer")],
    menus_revision: saved.revision,
  });
  expect(result.menus.map((item: any) => item.id)).toEqual([
    "support",
    "printer",
    "computer",
  ]);
  expect(result.menus_revision).toBeUndefined();
  expect((await persisted(f.profile)).menus_revision).toBeUndefined();
});

it("edição desatualizada da mesma opção não desfaz alterações feitas por outra aba", async () => {
  const f = await fixture(),
    tabA = await read(f),
    tabB = await read(f);
  await write(f, {
    menus: tabA.data.map((item: any) => ({
      ...item,
      label: "Suporte atualizado",
    })),
    menus_revision: tabA.revision,
  });
  await expect(
    write(f, {
      menus: tabB.data.map((item: any) => ({ ...item, enabled: false })),
      menus_revision: tabB.revision,
    }),
  ).rejects.toMatchObject({ status: 409, code: "menus_changed" });
  expect((await read(f)).data).toEqual([
    { ...f.menus[0], label: "Suporte atualizado" },
  ]);
});

it.each([null, 0, {}, [], "", "outdated", "g".repeat(64)])(
  "revisão presente com formato inválido %j falha antes de persistir",
  async (revision) => {
    const f = await fixture(),
      before = await persisted(f.profile);
    await expect(
      write(f, {
        menus: [...f.menus, child("printer")],
        menus_revision: revision,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await persisted(f.profile)).toEqual(before);
  },
);

it("revisão sem árvore é inválida e não vaza como configuração persistida", async () => {
  const f = await fixture(),
    state = await read(f),
    before = await persisted(f.profile);
  await expect(
    write(f, { menus_revision: state.revision, instructions: "Não aplicar" }),
  ).rejects.toMatchObject({ status: 400 });
  expect(await persisted(f.profile)).toEqual(before);
});

it("patch de outras configurações preserva árvore e revisão, inclusive depois de conflito", async () => {
  const f = await fixture(),
    old = await read(f);
  await write(f, {
    menus: [...old.data, child("printer")],
    menus_revision: old.revision,
  });
  const latest = await read(f);
  await write(f, { instructions: "Nova instrução" });
  expect(await read(f)).toEqual(latest);
  await expect(
    write(f, {
      menus: old.data,
      menus_revision: old.revision,
      instructions: "Não substituir",
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await settings(env, f.profile)).instructions).toBe("Nova instrução");
  expect(await read(f)).toEqual(latest);
});

it("clientes legados sem revisão continuam aceitos e a próxima leitura reflete a nova árvore", async () => {
  const f = await fixture(),
    before = await read(f);
  await write(f, { menus: [...before.data, child("legacy")] });
  const latest = await read(f);
  expect(latest.data.map((item: any) => item.id)).toEqual([
    "support",
    "legacy",
  ]);
  expect(latest.revision).toBe(await sha(JSON.stringify(latest.data)));
  expect(latest.revision).not.toBe(before.revision);
});

it("consulta filtrada usa revisão da árvore completa e não altera o cadastro", async () => {
  const f = await fixture(),
    lineA = uid(),
    lineB = uid();
  for (const line of [lineA, lineB])
    await exec(
      env,
      "INSERT INTO connections(id,profile_id,name,kind,mode,created) VALUES(?,?,'Linha','zernio','direct',1)",
      line,
      f.profile,
    );
  await write(f, {
    menus: [
      { ...f.menus[0], line_ids: [lineA] },
      child("printer"),
      {
        id: "sales",
        label: "Comercial",
        type: "submenu",
        parent_id: null,
        line_ids: [lineB],
        enabled: true,
      },
      { ...child("quote"), parent_id: "sales" },
    ],
  });
  const before = await persisted(f.profile),
    full = await read(f),
    filtered = await read(f, lineA);
  const response = await SELF.fetch(
    `https://test/api/v1/profiles/${f.profile}/menus?connection_id=${lineA}`,
    { headers: { Authorization: `Bearer ${f.token}` } },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(filtered);
  expect(filtered.data.map((item: any) => item.id)).toEqual([
    "support",
    "printer",
  ]);
  expect(filtered.revision).toBe(full.revision);
  expect(filtered.revision).not.toBe(await sha(JSON.stringify(filtered.data)));
  expect(await persisted(f.profile)).toEqual(before);
  await write(f, {
    menus: full.data.map((item: any) =>
      item.id === "quote" ? { ...item, content: "Novo orçamento" } : item,
    ),
    menus_revision: full.revision,
  });
  const changed = await read(f, lineA);
  expect(changed.data).toEqual(filtered.data);
  expect(changed.revision).not.toBe(filtered.revision);
});

it("revisão não substitui autorização nem permite consultar linha de outra área", async () => {
  const f = await fixture(),
    other = await fixture(),
    foreignLine = uid();
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,created) VALUES(?,?,'Linha privada','zernio','direct',1)",
    foreignLine,
    other.profile,
  );
  const operator: Actor = { ...f.actor, role: "operator" },
    revision = (await read(other)).revision,
    before = await persisted(other.profile);
  await expect(listMenus(env, operator, other.profile)).rejects.toMatchObject({
    status: 404,
    code: "not_found",
  });
  await expect(
    listMenus(
      env,
      { ...operator, kind: "app", role: "service", scopes: [] },
      f.profile,
    ),
  ).rejects.toMatchObject({ status: 403, code: "missing_scope" });
  await expect(listMenus(env, f.actor, f.profile, foreignLine)).rejects.toThrow(
    "Linha não encontrada",
  );
  await expect(
    perform(
      env,
      operator,
      other.profile,
      "settings",
      { menus: [], menus_revision: revision },
      uid(),
    ),
  ).rejects.toMatchObject({ status: 403 });
  expect(await persisted(other.profile)).toEqual(before);
  const missingAuth = await SELF.fetch(
    `https://test/api/v1/profiles/${other.profile}/menus`,
  );
  expect(missingAuth.status).toBe(401);
  expect((await missingAuth.json<any>()).revision).toBeUndefined();
});

it("PUTs simultâneos são serializados e somente uma aba aplica a revisão", async () => {
  const f = await fixture(),
    base = await read(f);
  const responses = await Promise.all([
    apiWrite(f, {
      menus: [...base.data, child("printer")],
      menus_revision: base.revision,
    }),
    apiWrite(f, {
      menus: [...base.data, child("computer")],
      menus_revision: base.revision,
    }),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 409,
  ]);
  const accepted = await responses
    .find((response) => response.status === 200)!
    .json<any>();
  const rejected = await responses
    .find((response) => response.status === 409)!
    .json<any>();
  expect(rejected.error.code).toBe("menus_changed");
  expect((await read(f)).data).toEqual(accepted.menus);
  expect(accepted.menus).toHaveLength(2);
});

it("API conserva replay de sucesso e conflito sem reaplicar a árvore de uma aba antiga", async () => {
  const f = await fixture(),
    base = await read(f),
    keyA = uid(),
    keyB = uid();
  const bodyA = {
      menus: [...base.data, child("printer")],
      menus_revision: base.revision,
    },
    bodyB = {
      menus: [...base.data, child("computer")],
      menus_revision: base.revision,
    };
  const first = await apiWrite(f, bodyA, keyA);
  expect(first.status).toBe(200);
  expect((await first.json<any>()).menus_revision).toBeUndefined();
  const stale = await apiWrite(f, bodyB, keyB);
  expect(stale.status).toBe(409);
  const failure = await stale.json<any>();
  expect(failure.error.code).toBe("menus_changed");
  const fresh = await read(f),
    retriedBody = {
      menus: [...fresh.data, child("computer")],
      menus_revision: fresh.revision,
    };
  const changedKeyBody = await apiWrite(f, retriedBody, keyB);
  expect(changedKeyBody.status).toBe(409);
  expect((await changedKeyBody.json<any>()).error.code).toBe(
    "idempotency_conflict",
  );
  expect((await apiWrite(f, retriedBody)).status).toBe(200);
  const finalTree = await read(f);
  expect(finalTree.data.map((item: any) => item.id)).toEqual([
    "support",
    "printer",
    "computer",
  ]);
  const replayFailure = await apiWrite(f, bodyB, keyB);
  expect(replayFailure.status).toBe(409);
  expect(replayFailure.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await replayFailure.json()).toEqual(failure);
  const replaySuccess = await apiWrite(f, bodyA, keyA);
  expect(replaySuccess.status).toBe(200);
  expect(replaySuccess.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await read(f)).toEqual(finalTree);
  expect((await persisted(f.profile)).menus_revision).toBeUndefined();
  expect(
    await all(env, "SELECT id FROM outbox WHERE profile_id=?", f.profile),
  ).toEqual([]);
  expect(
    await all(
      env,
      "SELECT id FROM audit WHERE profile_id=? AND operation='settings'",
      f.profile,
    ),
  ).toHaveLength(2);
});
