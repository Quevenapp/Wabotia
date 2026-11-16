import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec } from "../src/db";
import { perform } from "../src/service";
import { uid, type Actor } from "../src/types";
import { accessCatalog, allows, effectiveAccess } from "../src/access";
import { event } from "../src/events";
import { api, bearer, fixture } from "./service-center-fixture";

type F = Awaited<ReturnType<typeof fixture>>;
const run = (f: F, actor: Actor, op: string, data: any = {}) =>
  perform(env, actor, f.profile, op, data, uid());

async function setup() {
  const f = await fixture();
  await run(f, f.admin, "module.set", { id: "os", enabled: true });
  return f;
}
async function restrict(f: F, person: Actor, access: string[] | null) {
  await run(f, f.admin, "user.update", { id: person.id, access });
  return { ...person, access };
}
const status = async (token: string, path: string) =>
  (await api(token, path)).status;

describe("acesso por pessoa", () => {
  it("atendente antigo (sem lista) continua com tudo o que tinha", async () => {
    const f = await setup();
    const row = (
      await all(env, "SELECT access FROM users WHERE id=?", f.member.id)
    )[0];
    expect(row.access).toBe(null);
    const token = await bearer(f.member);
    for (const path of [
      `/profiles/${f.profile}/conversations`,
      `/profiles/${f.profile}/tickets`,
      `/profiles/${f.profile}/contacts`,
      `/profiles/${f.profile}/service-orders`,
    ])
      expect(await status(token, path)).toBe(200);
  });

  it("só técnico: alcança a OS e recebe 403 no resto, nas rotas e nos comandos", async () => {
    const f = await setup();
    const tech = await restrict(f, f.member, ["os:technician"]);
    const token = await bearer(f.member);
    expect(await status(token, `/profiles/${f.profile}/service-orders`)).toBe(
      200,
    );
    expect(await status(token, `/profiles/${f.profile}/establishment`)).toBe(
      200,
    );
    for (const path of [
      `/profiles/${f.profile}/conversations`,
      `/profiles/${f.profile}/tickets`,
      `/profiles/${f.profile}/contacts`,
      `/profiles/${f.profile}/calls`,
      `/profiles/${f.profile}/reports`,
      `/profiles/${f.profile}/internal-chats`,
    ]) {
      const response = await api(token, path);
      expect(response.status, path).toBe(403);
      expect((await response.json<any>()).error.code).toBe("access_denied");
    }
    // Comando direto (sem passar pela rota) também é barrado.
    await expect(
      run(f, tech, "ticket.create", { title: "x" }),
    ).rejects.toMatchObject({ code: "access_denied" });
    await expect(
      run(f, tech, "contact.create", { name: "x", phone: "5511999990000" }),
    ).rejects.toMatchObject({ code: "access_denied" });
  });

  it("rota fora do catálogo: atendente completo passa, restrito não", async () => {
    const f = await setup();
    const full = await bearer(f.member);
    const path = `/profiles/${f.profile}/webhook-subscriptions`;
    expect(await status(full, path)).toBe(200);
    await restrict(f, f.other, ["os"]);
    const limited = await bearer(f.other);
    expect(await status(limited, path)).toBe(403);
  });

  it("o administrador e as aplicações ignoram a lista", async () => {
    const f = await setup();
    await exec(
      env,
      "UPDATE users SET access=? WHERE id=?",
      JSON.stringify(["os"]),
      f.admin.id,
    );
    const token = await bearer(f.admin);
    expect(await status(token, `/profiles/${f.profile}/tickets`)).toBe(200);
  });

  it("some dos eventos o que a pessoa não acessa; o /status perde os contadores", async () => {
    const f = await setup();
    await restrict(f, f.member, ["os"]);
    await event(env, f.profile, "ticket.created", uid(), { id: "t" });
    await event(env, f.profile, "os.opened", uid(), { id: "o" });
    const token = await bearer(f.member);
    const events = await (
      await api(token, `/profiles/${f.profile}/events?after=0`)
    ).json<any>();
    const kinds = events.data.map((e: any) => e.kind);
    expect(kinds).toContain("os.opened");
    expect(kinds).not.toContain("ticket.created");
    const body = await (
      await api(token, `/profiles/${f.profile}/status`)
    ).json<any>();
    expect(body.conversations).toEqual([]);
  });

  it("catálogo, atalhos e a lista expandida", async () => {
    const f = await setup();
    const token = await bearer(f.admin);
    const catalog = await (
      await api(token, `/profiles/${f.profile}/access`)
    ).json<any>();
    const ids = catalog.data.map((i: any) => i.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "conversations",
        "tickets",
        "os",
        "os:technician",
      ]),
    );
    // Só os atalhos cujos itens existem nesta versão (sem caixa, garçom…).
    expect(catalog.presets.map((p: any) => p.id)).toEqual([
      "full",
      "technician",
    ]);

    const items = accessCatalog({ os: true });
    const actor = (access: string[] | null) =>
      ({ kind: "user", role: "operator", access }) as Actor;
    expect(effectiveAccess(actor(null), items)).not.toContain("os:technician");
    expect(effectiveAccess(actor(["*"]), items)).toContain("os");
    expect(allows(actor(["os:technician"]), "os")).toBe(true);
    expect(allows(actor(["os:technician"]), "tickets")).toBe(false);
    expect(allows(actor(["*"]), "os:technician")).toBe(false);
  });
});
