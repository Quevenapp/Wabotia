import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { conversation, perform, settings } from "../src/service";
import { json, uid, type Actor } from "../src/types";
import {
  api,
  application,
  bearer,
  configure,
  drain,
  fixture,
  latest,
  receive,
  type Fixture,
} from "./service-center-fixture";

const menus = [
  { id: "fila", label: "Entrar na fila de espera", type: "queue" },
  { id: "atendente", label: "Falar com atendente", type: "human" },
];
const run = (f: Fixture, actor: Actor, op: string, data: any = {}) =>
  perform(env, actor, f.profile, op, data, uid());
const toggle = (f: Fixture, enabled: boolean) =>
  run(f, f.admin, "module.set", { id: "queue", enabled });

async function setup() {
  const f = await fixture();
  const queue = await run(f, f.admin, "queue.save", {
    name: "Geral",
    service_minutes: 10,
  });
  const counter = await run(f, f.admin, "counter.save", {
    name: "Guichê 1",
    queue_ids: [queue.id],
  });
  await run(f, f.member, "counter.state", { id: counter.id, status: "open" });
  await configure(f, { menus });
  return { f, queue, counter };
}
async function say(f: Fixture, text: string, phone: string) {
  const c = await receive(f, f.line, text, phone);
  await drain(f);
  return conversation(env, c.id, f.profile);
}
const storedMenus = async (f: Fixture) =>
  json(
    (await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))
      .settings,
  ).menus as any[];

describe("fila presencial como módulo", () => {
  it("instalação existente continua com a fila ligada depois da migração", async () => {
    const f = await fixture();
    await exec(
      env,
      "DELETE FROM profile_modules WHERE profile_id=?",
      f.profile,
    );
    const migration = (env as any).TEST_MIGRATIONS.find((m: any) =>
      m.name.startsWith("0020_"),
    );
    expect(migration).toBeTruthy();
    for (const query of migration.queries) await env.DB.prepare(query).run();
    expect(
      await one(
        env,
        "SELECT enabled,updated_by FROM profile_modules WHERE profile_id=? AND module_id='queue'",
        f.profile,
      ),
    ).toEqual({ enabled: 1, updated_by: "migration" });
  });

  it("desligada some do menu do WhatsApp e do editor, e volta ao religar", async () => {
    const { f } = await setup();
    let c = await say(f, "oi", "5511930000001");
    expect((await latest(c.id)).text).toContain("1. Entrar na fila de espera");

    await toggle(f, false);
    c = await say(f, "oi", "5511930000002");
    const text = (await latest(c.id)).text;
    expect(text).toContain("1. Falar com atendente");
    expect(text).not.toContain("fila");

    // Editor de menus (GET /menus) e status do painel.
    const token = await bearer(f.admin);
    const listed = await (
      await api(token, `/profiles/${f.profile}/menus`)
    ).json<any>();
    expect(listed.data.map((m: any) => m.id)).toEqual(["atendente"]);
    const status = await (
      await api(token, `/profiles/${f.profile}/status`)
    ).json<any>();
    expect(status.modules.queue).toBe(false);

    // Salvar o menu sem o item escondido não o apaga; a revisão confere com
    // a lista que o editor recebeu.
    const saved = await run(f, f.admin, "settings", {
      menus: [
        ...listed.data,
        { id: "horario", label: "Horário", type: "content", content: "9h" },
      ],
      menus_revision: listed.revision,
    });
    expect(saved.menus.map((m: any) => m.id)).toEqual(["atendente", "horario"]);
    expect((await storedMenus(f)).map((m: any) => m.id)).toEqual([
      "atendente",
      "horario",
      "fila",
    ]);
    // Outra configuração qualquer também preserva o item.
    await configure(f, { menu_greeting: "Olá!" });
    expect((await storedMenus(f)).map((m: any) => m.id)).toContain("fila");

    await toggle(f, true);
    expect(
      (await settings(env, f.profile)).menus.map((m: any) => m.id),
    ).toEqual(["atendente", "horario", "fila"]);
    c = await say(f, "oi", "5511930000003");
    expect((await latest(c.id)).text).toContain("Entrar na fila de espera");
  });

  it("recusa novo item de menu da fila enquanto desligada", async () => {
    const { f } = await setup();
    await toggle(f, false);
    await expect(
      configure(f, {
        menus: [
          { id: "nova", label: "Pegar senha", type: "queue" },
          { id: "atendente", label: "Falar com atendente", type: "human" },
        ],
      }),
    ).rejects.toMatchObject({ code: "module_disabled" });
  });

  it("SENHA e o cupom do totem não respondem com a fila desligada", async () => {
    const { f, queue } = await setup();
    const phone = "5511930000004";
    await run(f, f.admin, "queue.issue", {
      queue_id: queue.id,
      preferential: false,
      source: "staff",
      phone,
    });
    let c = await say(f, "SENHA", phone);
    expect((await latest(c.id)).text).toContain("Sua senha é");
    await toggle(f, false);
    c = await say(f, "SENHA", phone);
    expect(String((await latest(c.id))?.text || "")).not.toContain(
      "Sua senha é",
    );
  });

  it("rotas, operações e painéis públicos respondem 409 module_disabled", async () => {
    const { f, queue } = await setup();
    const display = await run(f, f.admin, "queue.display.create", {
      name: "TV",
      queue_ids: [queue.id],
    });
    await toggle(f, false);

    const token = await bearer(f.member);
    for (const [method, path, body] of [
      ["GET", "/queue", undefined],
      ["GET", "/queue/tickets", undefined],
      ["POST", "/queue/tickets", { queue_id: queue.id, preferential: false }],
    ] as const) {
      const response = await api(
        token,
        `/profiles/${f.profile}${path}`,
        method,
        body,
      );
      expect(response.status).toBe(409);
      const error = (await response.json<any>()).error;
      expect(error.code).toBe("module_disabled");
      expect(error.message).toContain("Fila presencial");
    }
    // Aparelho pareado (Senhapp) recebe o mesmo erro claro.
    const device = await application(f, ["queue:read", "queue:issue"]);
    expect(
      (await api(device.token, `/profiles/${f.profile}/queue`)).status,
    ).toBe(409);
    await expect(
      run(f, f.admin, "queue.issue", {
        queue_id: queue.id,
        preferential: false,
        source: "staff",
      }),
    ).rejects.toMatchObject({ code: "module_disabled" });
    const panel = await SELF.fetch(
      "https://test/api/public/queue-display/state",
      { headers: { Authorization: "Display " + display.token } },
    );
    expect(panel.status).toBe(409);

    // Religada, tudo volta.
    await toggle(f, true);
    expect((await api(token, `/profiles/${f.profile}/queue`)).status).toBe(200);
    expect(
      (
        await SELF.fetch("https://test/api/public/queue-display/state", {
          headers: { Authorization: "Display " + display.token },
        })
      ).status,
    ).toBe(200);
  });
});
