import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { perform } from "../src/service";
import { json, now, uid } from "../src/types";
import {
  modulesApi,
  onCommand,
  onRead,
  onRoute,
  onSettingsSave,
} from "../src/modules/api";
import {
  api,
  bearer,
  configure,
  drain,
  fixture,
  receive,
  type Fixture,
} from "./service-center-fixture";

const form = {
  id: "ficha",
  name: "Ficha",
  fields: [{ id: "nome", type: "text", label: "Nome" }],
};
async function setup() {
  const f = await fixture();
  await exec(
    env,
    "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://example.com',?)",
    now(),
  );
  await configure(f, { forms: [form] });
  const c = await receive(f, f.line, "bom dia", "5511950000001");
  await drain(f);
  return { f, c };
}
const off = (f: Fixture, id: string) =>
  perform(env, f.admin, f.profile, "module.set", { id, enabled: false }, uid());

describe("interface interna dos módulos (ModuleContext)", () => {
  it("contato vinculado, mensagem idempotente e notificação", async () => {
    const { f, c } = await setup();
    const ctx = modulesApi(env, f.profile, "forms");
    expect(await ctx.contact(c)).toBeNull();
    const contact = uid();
    await exec(
      env,
      "INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated) VALUES(?,?,'panel','Ana','5511950000001','ana','panel','t','t',?,?)",
      contact,
      f.profile,
      now(),
      now(),
    );
    await exec(
      env,
      "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,?,?)",
      c.id,
      f.profile,
      contact,
      "t",
      now(),
    );
    expect(await ctx.contact(c.id)).toMatchObject({
      id: contact,
      name: "Ana",
      phone: "5511950000001",
    });

    const first = await ctx.sendMessage(
      c,
      { text: "Olá do módulo" },
      { key: "k1" },
    );
    const again = await ctx.sendMessage(
      c,
      { text: "Olá do módulo" },
      { key: "k1" },
    );
    expect(again).toBe(first);
    const row = await one(env, "SELECT * FROM outbox WHERE id=?", first);
    expect(row).toMatchObject({ kind: "text", actor: "system" });
    expect(json(row.payload).automation).toBe("forms");
    const note = await ctx.sendMessage(
      c,
      { text: "Lembrete" },
      { key: "k2", notification: true },
    );
    expect(
      (await one(env, "SELECT kind FROM outbox WHERE id=?", note)).kind,
    ).toBe("notification");
    await expect(
      ctx.sendMessage(c, { text: "" }, { key: "k3" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("publica só eventos declarados, com module_id", async () => {
    const { f } = await setup();
    const ctx = modulesApi(env, f.profile, "forms");
    await ctx.publish("form.submitted", "x1", { form_id: "ficha" });
    const [row] = await all(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='form.submitted'",
      f.profile,
    );
    expect(json(row.payload)).toEqual({ form_id: "ficha", module_id: "forms" });
    await expect(ctx.publish("agenda.booked", "x", {})).rejects.toThrow(
      /não declarado/,
    );
  });

  it("estado do módulo e passo web em nome do módulo", async () => {
    const { f, c } = await setup();
    const ctx = modulesApi(env, f.profile, "forms");
    expect(await ctx.enabled()).toBe(true);
    const opened = await ctx.openWebStep(c, {
      kind: "form",
      ref: "ficha",
      trigger: "module",
      actor: "system",
      sourceKey: "teste-1",
      spec: { title: "Ficha", fields: form.fields as any },
    });
    expect(opened.created).toBe(true);
    expect(opened.url).toMatch(/^https:\/\/example\.com\/api\/w\//);
    expect(opened.step).toMatchObject({
      module_id: "forms",
      trigger: "module",
    });
    // Mesma chave: o mesmo passo, sem novo link.
    const repeat = await ctx.openWebStep(c, {
      kind: "form",
      trigger: "module",
      actor: "system",
      sourceKey: "teste-1",
      spec: { title: "Ficha", fields: form.fields as any },
    });
    expect(repeat).toMatchObject({ created: false, url: null });
    expect(repeat.step.id).toBe(opened.step.id);
    await off(f, "forms");
    expect(await ctx.enabled()).toBe(false);
    await expect(ctx.requireEnabled()).rejects.toMatchObject({
      code: "module_disabled",
    });
  });

  it("registro de ganchos recusa o que o módulo não declarou", () => {
    expect(() => onCommand("forms", "agenda.book", async () => null)).toThrow(
      /operations/,
    );
    expect(() =>
      onRoute("forms", { method: "POST", path: "agenda/x", op: "form.x" }),
    ).toThrow(/routes/);
    expect(() => onRead("forms", "queue", async () => null)).toThrow(/routes/);
    expect(() => onSettingsSave("forms", "menus", (v) => v)).toThrow(
      /não declarada/,
    );
    expect(() => modulesApi(env, "x", "nada")).toThrow(/não registrado/);
  });
});

describe("rotas e comandos de módulo (onRoute, onCommand, onRead)", () => {
  it("POST /forms/:id/send passa pelo Coordinator com idempotência", async () => {
    const { f, c } = await setup();
    const token = await bearer(f.member);
    await api(
      token,
      `/profiles/${f.profile}/conversations/${c.id}/actions`,
      "POST",
      {
        action: "claim",
      },
    );
    const key = "envio-" + uid();
    const send = () =>
      api(
        token,
        `/profiles/${f.profile}/forms/ficha/send`,
        "POST",
        { conversation_id: c.id },
        key,
      );
    const first = await send();
    expect(first.status).toBe(200);
    const step = await first.json<any>();
    expect(step).toMatchObject({ ref_id: "ficha", trigger: "agent" });
    const replay = await send();
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await replay.json<any>()).id).toBe(step.id);
    expect(
      await all(env, "SELECT id FROM web_steps WHERE conversation_id=?", c.id),
    ).toHaveLength(1);
    // Auditoria do comando.
    expect(
      await one(
        env,
        "SELECT operation FROM audit WHERE profile_id=? AND operation='form.send'",
        f.profile,
      ),
    ).toBeTruthy();

    // Leitura do módulo e módulo desligado.
    const list = await (
      await api(token, `/profiles/${f.profile}/forms`)
    ).json<any>();
    expect(list.data.map((x: any) => x.id)).toEqual(["ficha"]);
    await off(f, "forms");
    const blocked = await api(
      token,
      `/profiles/${f.profile}/forms/ficha/send`,
      "POST",
      { conversation_id: c.id },
    );
    expect(blocked.status).toBe(409);
    expect((await blocked.json<any>()).error.code).toBe("module_disabled");
  });

  it("comando confere permissão, conversa e responsabilidade", async () => {
    const { f, c } = await setup();
    const token = await bearer(f.member);
    const send = (body: any) =>
      api(token, `/profiles/${f.profile}/forms/ficha/send`, "POST", body);
    expect((await send({ conversation_id: c.id })).status).toBe(400);
    expect((await send({ conversation_id: "nada" })).status).toBe(404);
    const outsider = await fixture();
    const stranger = await bearer(outsider.member);
    expect(
      (
        await api(stranger, `/profiles/${f.profile}/forms/ficha/send`, "POST", {
          conversation_id: c.id,
        })
      ).status,
    ).toBe(404);
  });
});
