import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { exec, one } from "../src/db";
import { perform } from "../src/service";
import { type Actor, defaults, json, now, uid } from "../src/types";

const admin: Actor = {
  id: "department-admin",
  kind: "user",
  role: "admin",
  name: "Admin",
  profiles: [],
  scopes: [],
  bots: [],
  rate: 300,
  runLimit: 3,
};

async function fixture() {
  const profile = uid(),
    line = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    profile,
    "Setores",
    JSON.stringify({
      ...defaults,
      departments: [
        { id: "fin", name: "Financeiro", members: [], enabled: true },
        { id: "com", name: "Comercial", members: [], enabled: true },
      ],
      menus: [
        {
          id: "m1",
          label: "Falar com o financeiro",
          type: "human",
          department_id: "fin",
        },
      ],
    }),
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'zernio','direct','active',?,?)",
    line,
    profile,
    "Linha",
    JSON.stringify({ number: "5511999990000" }),
    now(),
  );
  return { profile, line };
}

async function conversation(
  f: { profile: string; line: string },
  state: string,
  department: string,
) {
  const id = uid();
  await exec(
    env,
    "INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,state,session,last_customer,created,updated,epoch,department_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?)",
    id,
    f.profile,
    f.line,
    `channel:${f.line}`,
    id,
    "5511888880000",
    state,
    uid(),
    now(),
    now(),
    now(),
    department,
  );
  return id;
}

const departments = async (profile: string) =>
  json(
    (await one(env, "SELECT settings FROM profiles WHERE id=?", profile))
      .settings,
  ).departments.map((d: any) => d.id);

it("recusa excluir setor usado por item de menu", async () => {
  const f = await fixture();
  const error: any = await perform(
    env,
    admin,
    f.profile,
    "settings",
    {
      departments: [
        { id: "com", name: "Comercial", members: [], enabled: true },
      ],
    },
    uid(),
  ).catch((e) => e);
  expect(error).toMatchObject({ status: 409, code: "department_in_use" });
  expect(error.message).toContain('"Falar com o financeiro"');
  expect(await departments(f.profile)).toEqual(["fin", "com"]);
});

it("exclui o setor e devolve as conversas abertas à fila geral", async () => {
  const f = await fixture();
  const waiting = await conversation(f, "waiting", "com");
  const closed = await conversation(f, "closed", "com");
  const other = await conversation(f, "waiting", "fin");
  await perform(
    env,
    admin,
    f.profile,
    "settings",
    {
      departments: [
        { id: "fin", name: "Financeiro", members: [], enabled: true },
      ],
    },
    uid(),
  );
  expect(await departments(f.profile)).toEqual(["fin"]);
  const dept = async (id: string) =>
    (await one(env, "SELECT department_id FROM conversations WHERE id=?", id))
      .department_id;
  expect(await dept(waiting)).toBeNull();
  expect(await dept(closed)).toBe("com");
  expect(await dept(other)).toBe("fin");
});
