import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec } from "../src/db";
import { perform } from "../src/service";
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
/** Grava o acesso da pessoa e devolve o ator como o login montaria. */
async function withAccess(f: F, person: Actor, access: string[] | null) {
  await run(f, f.admin, "user.update", { id: person.id, access });
  return { ...person, access };
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

describe("papéis dos módulos no acesso da pessoa", () => {
  it("o módulo confere o papel e lista quem tem", async () => {
    const f = await setup();
    const tech = await withAccess(f, f.member, ["*", "os:technician"]);
    const ctx = modulesApi(env, f.profile, "os");
    expect(await ctx.granted(tech, "technician")).toBe(true);
    // O "*" do atendente completo e o administrador não dão papel.
    expect(await ctx.granted({ ...f.other, access: ["*"] }, "technician")).toBe(
      false,
    );
    expect(await ctx.granted(f.admin, "technician")).toBe(false);
    expect(await ctx.granted(app(f), "technician")).toBe(false);
    expect(await ctx.grantees("technician")).toEqual([
      { id: f.member.id, name: f.member.name },
    ]);
    await expect(ctx.granted(tech, "courier")).rejects.toThrow("não declarado");
  });

  it("recusa acesso desconhecido e atendente gravando", async () => {
    const f = await setup();
    await expect(
      run(f, f.admin, "user.update", {
        id: f.member.id,
        access: ["entrega:dispatcher"],
      }),
    ).rejects.toThrow("Acesso desconhecido");
    await expect(
      run(f, f.admin, "user.update", { id: f.member.id, access: "tudo" }),
    ).rejects.toThrow("lista");
    await expect(
      run(f, f.member, "user.update", { id: f.member.id, access: ["*"] }),
    ).rejects.toThrow();
  });

  it("capabilities, /people e /grants trazem os papéis; módulo desligado some", async () => {
    const f = await setup();
    const tech = await withAccess(f, f.member, ["os:technician"]);
    const mine = await capabilities(env, tech, f.profile);
    expect(mine.features).toEqual(
      expect.arrayContaining(["module_grants", "person_access"]),
    );
    expect(mine.profiles[0].grants).toEqual(["os:technician"]);
    // Só o papel: o módulo vem junto, o atendimento não.
    expect(mine.profiles[0].access).toEqual(["os", "os:technician"]);
    expect(
      (await capabilities(env, f.other, f.profile)).profiles[0].grants,
    ).toEqual([]);
    expect(
      (await capabilities(env, app(f), f.profile)).profiles[0].access,
    ).toBe(null);

    const people = await areaPeople(env, app(f), f.profile, "os:technician");
    expect(people.data.map((p) => p.id)).toEqual([f.member.id]);
    expect((await areaGrants(env, f.admin, f.profile)).data).toEqual([
      expect.objectContaining({
        id: "os:technician",
        label: "Técnico",
        people: [{ id: f.member.id, name: f.member.name }],
      }),
    ]);

    await run(f, f.admin, "module.set", { id: "os", enabled: false });
    expect(
      (await capabilities(env, tech, f.profile)).profiles[0].grants,
    ).toEqual([]);
    await expect(
      areaPeople(env, f.admin, f.profile, "os:technician"),
    ).rejects.toThrow("Papel desconhecido");
    // A marca fica guardada e volta ao religar.
    await run(f, f.admin, "module.set", { id: "os", enabled: true });
    expect(
      (await capabilities(env, tech, f.profile)).profiles[0].grants,
    ).toEqual(["os:technician"]);
  });

  it("pessoa sem acesso à área não aparece em grantees", async () => {
    const f = await setup();
    const outsider = uid();
    await exec(
      env,
      "INSERT INTO users(id,email,name,password,role,profiles,access,created) VALUES(?,?,?,?,?,?,?,?)",
      outsider,
      `${outsider}@example.test`,
      "Fora",
      "test",
      "operator",
      JSON.stringify([uid()]),
      JSON.stringify(["os:technician"]),
      Date.now(),
    );
    expect(
      await modulesApi(env, f.profile, "os").grantees("technician"),
    ).toEqual([]);
  });
});
