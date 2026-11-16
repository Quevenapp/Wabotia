import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec } from "../src/db";
import { perform, settings } from "../src/service";
import { uid, type Actor } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { capabilities } from "../src/modules/capabilities";
import { areaGrants, areaPeople } from "../src/team";
import { fixture } from "./service-center-fixture";

type F = Awaited<ReturnType<typeof fixture>>;
const run = (f: F, actor: Actor, op: string, data: any = {}) =>
  perform(env, actor, f.profile, op, data, uid());

async function setup() {
  const f = await fixture();
  await run(f, f.admin, "module.set", { id: "os", enabled: true });
  return f;
}
const app = (f: F): Actor => ({
  id: "app-" + uid(),
  name: "App",
  kind: "app",
  role: "operator",
  profiles: [f.profile],
  scopes: ["conversations:read", "queue:read"],
  bots: [],
  rate: 100,
  runLimit: 10,
});

describe("papéis por pessoa nos módulos", () => {
  it("o administrador concede; o módulo confere e lista quem tem o papel", async () => {
    const f = await setup();
    await run(f, f.admin, "settings", {
      module_grants: { "os:technician": [f.member.id] },
    });
    const ctx = modulesApi(env, f.profile, "os");
    expect(await ctx.granted(f.member, "technician")).toBe(true);
    expect(await ctx.granted(f.other, "technician")).toBe(false);
    // O administrador não ganha o papel sozinho; aplicação nunca tem papel.
    expect(await ctx.granted(f.admin, "technician")).toBe(false);
    expect(await ctx.granted(app(f), "technician")).toBe(false);
    expect(await ctx.grantees("technician")).toEqual([
      { id: f.member.id, name: f.member.name },
    ]);
    await expect(ctx.granted(f.member, "courier")).rejects.toThrow(
      "não declarado",
    );
  });

  it("cada papel enviado substitui a lista dele; lista vazia retira", async () => {
    const f = await setup();
    await run(f, f.admin, "settings", {
      module_grants: { "os:technician": [f.member.id, f.other.id] },
    });
    // Salvar outra configuração não mexe nos papéis.
    await run(f, f.admin, "settings", { menu_greeting: "Olá!" });
    expect((await settings(env, f.profile)).module_grants).toEqual({
      "os:technician": [f.member.id, f.other.id],
    });
    await run(f, f.admin, "settings", {
      module_grants: { "os:technician": [] },
    });
    expect((await settings(env, f.profile)).module_grants).toEqual({});
  });

  it("recusa papel desconhecido, pessoa fora da área e atendente gravando", async () => {
    const f = await setup();
    await expect(
      run(f, f.admin, "settings", {
        module_grants: { "entrega:courier": [f.member.id] },
      }),
    ).rejects.toThrow("Papel desconhecido");
    const outsider = uid();
    await exec(
      env,
      "INSERT INTO users(id,email,name,password,role,profiles,created) VALUES(?,?,?,?,?,?,?)",
      outsider,
      `${outsider}@example.test`,
      "Fora",
      "test",
      "operator",
      JSON.stringify([uid()]),
      Date.now(),
    );
    await expect(
      run(f, f.admin, "settings", {
        module_grants: { "os:technician": [outsider] },
      }),
    ).rejects.toThrow("acesso a esta área");
    await expect(
      run(f, f.member, "settings", {
        module_grants: { "os:technician": [f.member.id] },
      }),
    ).rejects.toThrow();
  });

  it("os apps leem os papéis da pessoa em capabilities; módulo desligado some", async () => {
    const f = await setup();
    await run(f, f.admin, "settings", {
      module_grants: { "os:technician": [f.member.id] },
    });
    const mine = await capabilities(env, f.member, f.profile);
    expect(mine.features).toContain("module_grants");
    expect(mine.profiles[0].grants).toEqual(["os:technician"]);
    expect(
      (await capabilities(env, f.other, f.profile)).profiles[0].grants,
    ).toEqual([]);
    expect(
      (await capabilities(env, app(f), f.profile)).profiles[0].grants,
    ).toEqual([]);

    const people = await areaPeople(env, app(f), f.profile, "os:technician");
    expect(people.data.map((p) => p.id)).toEqual([f.member.id]);
    expect(people.data[0].grants).toEqual(["os:technician"]);
    const grants = await areaGrants(env, f.admin, f.profile);
    expect(grants.data).toEqual([
      expect.objectContaining({
        id: "os:technician",
        module_id: "os",
        role: "technician",
        label: "Técnico",
        people: [{ id: f.member.id, name: f.member.name }],
      }),
    ]);

    await run(f, f.admin, "module.set", { id: "os", enabled: false });
    expect(
      (await capabilities(env, f.member, f.profile)).profiles[0].grants,
    ).toEqual([]);
    expect((await areaGrants(env, f.admin, f.profile)).data).toEqual([]);
    await expect(
      areaPeople(env, f.admin, f.profile, "os:technician"),
    ).rejects.toThrow("Papel desconhecido");
  });
});
