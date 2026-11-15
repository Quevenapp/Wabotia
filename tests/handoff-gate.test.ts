import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all } from "../src/db";
import { conversation, perform } from "../src/service";
import { json, uid } from "../src/types";
import { modulesApi, onHandoffRequest } from "../src/modules/api";
import {
  configure,
  drain,
  fixture,
  latest,
  receive,
  type Fixture,
} from "./service-center-fixture";

// Os ganchos valem para o processo todo: cada caso só age nas áreas que marca.
const hold = new Set<string>();
const fail = new Set<string>();
const seen: { module: string; profile: string; request: any }[] = [];
onHandoffRequest("forms", async (ctx, c, request) => {
  seen.push({ module: "forms", profile: c.profile_id, request });
  if (fail.has(c.profile_id)) throw new Error("falha no módulo");
  if (!hold.has(c.profile_id)) return "allow";
  await ctx.sendMessage(
    c,
    { text: "Atendimento humano é pago. Responda PAGAR para receber o Pix." },
    { key: `offer:${request.source}` },
  );
  return "hold";
});
onHandoffRequest("payments", async (_ctx, c, request) => {
  seen.push({ module: "payments", profile: c.profile_id, request });
  return "allow";
});
const calls = (f: Fixture, module?: string) =>
  seen.filter(
    (s) => s.profile === f.profile && (!module || s.module === module),
  );

async function setup() {
  const f = await fixture();
  await configure(f, {
    menus: [
      {
        id: "ia",
        label: "Falar com a IA (grátis)",
        type: "content",
        content: "Oi!",
      },
      { id: "pago", label: "Humano (pago)", type: "human" },
    ],
  });
  return f;
}
async function say(f: Fixture, text: string, phone = "5511990002222") {
  const r = await receive(f, f.line, text, phone);
  await drain(f);
  return conversation(env, r.id, f.profile);
}

describe("onHandoffRequest: módulo condiciona a passagem automática", () => {
  it("item de menu de atendimento humano: o módulo segura, oferece e libera depois", async () => {
    const f = await setup();
    hold.add(f.profile);
    await say(f, "MENU");
    const c = await say(f, "2");
    // Segurou: nada de fila nem aviso do núcleo; a oferta do módulo saiu.
    expect(c.state).not.toBe("waiting");
    expect((await latest(c.id)).text).toMatch(/Atendimento humano é pago/);
    expect(calls(f, "forms").at(-1)!.request).toMatchObject({
      source: "menu",
      menu_item_id: "pago",
      reason: "Menu: Humano (pago)",
      department_id: null,
    });
    // O primeiro "hold" encerra a consulta: payments (depois de forms em
    // modules) não foi chamado.
    expect(calls(f, "payments")).toHaveLength(0);
    const held = await all(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='conversation.updated' AND resource_id=?",
      f.profile,
      c.id,
    );
    expect(held.map((e) => json(e.payload).handoff_held)).toContainEqual({
      module: "forms",
      source: "menu",
      reason: "Menu: Humano (pago)",
    });
    // Pagou: o módulo libera por ctx.handoff, que não passa pelo gancho.
    const before = calls(f).length;
    const released = await modulesApi(env, f.profile, "forms").handoff(c, {
      summary: "Pagou o atendimento avulso.",
    });
    expect(released.state).toBe("waiting");
    expect(calls(f)).toHaveLength(before);
  });

  it("palavra-chave também passa pelo gancho; liberado, segue para a equipe", async () => {
    const f = await setup();
    hold.add(f.profile);
    const c = await say(f, "quero falar com atendente");
    expect(c.state).not.toBe("waiting");
    expect(calls(f, "forms").at(-1)!.request.source).toBe("keyword");
    // Sem segurar: os dois módulos são consultados, na ordem de modules.
    hold.delete(f.profile);
    const next = await say(f, "atendente por favor", "5511990003333");
    expect(next.state).toBe("waiting");
    expect(
      calls(f)
        .slice(-2)
        .map((s) => s.module),
    ).toEqual(["forms", "payments"]);
  });

  it("transferência da equipe não passa pelo gancho; erro no gancho libera", async () => {
    const f = await setup();
    hold.add(f.profile);
    await configure(f, {
      departments: [
        {
          id: "suporte",
          name: "Suporte",
          members: [f.member.id],
          enabled: true,
        },
      ],
    });
    const c = await say(f, "oi");
    const before = calls(f).length;
    await perform(
      env,
      f.admin,
      f.profile,
      "conversation.action",
      { id: c.id, action: "transfer", department_id: "suporte" },
      uid(),
    );
    expect((await conversation(env, c.id, f.profile)).state).toBe("waiting");
    expect(calls(f)).toHaveLength(before);

    // Gancho com erro: o cliente não fica preso.
    hold.delete(f.profile);
    fail.add(f.profile);
    const other = await say(f, "falar com atendente", "5511990004444");
    expect(other.state).toBe("waiting");
  });

  it("módulo desligado não é consultado", async () => {
    const f = await setup();
    hold.add(f.profile);
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "forms", enabled: false },
      uid(),
    );
    const c = await say(f, "quero falar com atendente");
    expect(c.state).toBe("waiting");
    expect(calls(f, "forms")).toHaveLength(0);
    expect(calls(f, "payments")).toHaveLength(1);
  });
});
