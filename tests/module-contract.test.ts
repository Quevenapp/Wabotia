import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { json, now, uid } from "../src/types";
import {
  buildInteractive,
  interactiveFallbackText,
  numberedReply,
} from "../src/whatsapp-interactive";
import {
  modulesApi,
  onConversationTurn,
  onWebStepCompleted,
} from "../src/modules/api";
import {
  application,
  drain,
  fixture,
  outbox,
  receive,
  type Fixture,
} from "./service-center-fixture";

// Ganchos de teste no módulo "forms" (ligado por padrão).
const turns: any[] = [];
onConversationTurn("forms", async (ctx, c, turn) => {
  turns.push({ conversation: c.id, state: c.state, owner: c.owner, ...turn });
  return turn.text === "eu sou do módulo";
});
onWebStepCompleted("forms", async (_ctx, step) =>
  step.ref_id === "pedido-7" ? "Pedido nº 7 recebido. Obrigado!" : undefined,
);

async function say(f: Fixture, text: string, phone: string) {
  const c = await receive(f, f.line, text, phone);
  await drain(f);
  return conversation(env, c.id, f.profile);
}
const origin = () =>
  exec(
    env,
    "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://x.example.com',?)",
    now(),
  );

describe("botões de resposta no InteractiveSpec", () => {
  const spec = {
    type: "button" as const,
    body: "Confirma o horário?",
    footer: "Envie MENU para sair.",
    buttons: [
      { id: "agenda:r:1:confirm", title: "Confirmar", description: "manter" },
      { id: "agenda:r:1:cancel", title: "Cancelar" },
    ],
  };
  it("monta o interactive de botões e o texto numerado", () => {
    expect(buildInteractive(spec)).toEqual({
      type: "button",
      body: { text: "Confirma o horário?" },
      footer: { text: "Envie MENU para sair." },
      action: {
        buttons: [
          {
            type: "reply",
            reply: { id: "agenda:r:1:confirm", title: "Confirmar" },
          },
          {
            type: "reply",
            reply: { id: "agenda:r:1:cancel", title: "Cancelar" },
          },
        ],
      },
    });
    const text = interactiveFallbackText(spec);
    expect(text).toContain("1. Confirmar - manter\n2. Cancelar");
    expect(text).toContain("Responda com o número da opção.");
    expect(numberedReply(spec, "2")).toBe("agenda:r:1:cancel");
  });
  it("recusa mais de 3 botões, título longo e id repetido", () => {
    const button = (id: string, title = "Ok") => ({ id, title });
    expect(() =>
      buildInteractive({
        ...spec,
        buttons: ["a", "b", "c", "d"].map((x) => button(x)),
      }),
    ).toThrow(/1 a 3/);
    expect(() =>
      buildInteractive({
        ...spec,
        buttons: [button("a", "Um título comprido demais")],
      }),
    ).toThrow(/20 caracteres/);
    expect(() =>
      buildInteractive({ ...spec, buttons: [button("a"), button("a")] }),
    ).toThrow(/repetir/);
  });
});

describe("contrato dos módulos", () => {
  it("ctx.publish com key não duplica o evento", async () => {
    const f = await fixture();
    const ctx = modulesApi(env, f.profile, "forms");
    await ctx.publish("form.submitted", "r1", { a: 1 }, { key: "r1:v1" });
    await ctx.publish("form.submitted", "r1", { a: 1 }, { key: "r1:v1" });
    await ctx.publish("form.submitted", "r1", { a: 2 }, { key: "r1:v2" });
    expect(
      await all(
        env,
        "SELECT id FROM events WHERE profile_id=? AND kind='form.submitted'",
        f.profile,
      ),
    ).toHaveLength(2);
  });

  it("return_message module: o texto do módulo é o único retorno", async () => {
    const f = await fixture();
    await origin();
    const c = await say(f, "oi", "5511990000001");
    const ctx = modulesApi(env, f.profile, "forms");
    const open = (ref: string, return_message?: "module") =>
      ctx.openWebStep(c, {
        kind: "form",
        ref,
        trigger: "module",
        actor: "system",
        sourceKey: ref,
        spec: {
          title: "Pedido",
          fields: [{ id: "nome", type: "text", label: "Nome", required: true }],
          return_text: "Retorno padrão.",
          ...(return_message ? { return_message } : {}),
        },
      });
    const submit = async (url: string) =>
      SELF.fetch(url.replace("https://x.example.com", "https://test"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "f_nome=Ana",
      });
    const custom = await open("pedido-7", "module");
    expect((await submit(custom.url!)).status).toBe(200);
    let texts = (await outbox(c.id)).map((m) => m.text);
    expect(texts).toContain("Pedido nº 7 recebido. Obrigado!");
    expect(texts).not.toContain("Retorno padrão.");
    // Sem return_message: o padrão sai (antes do que o módulo enviar).
    const plain = await open("outro");
    await submit(plain.url!);
    texts = (await outbox(c.id)).map((m) => m.text);
    expect(texts.filter((t) => t === "Retorno padrão.")).toHaveLength(1);
  });

  it("conversa com atendente: a próxima mensagem ainda chega a onConversationTurn", async () => {
    const f = await fixture();
    const phone = "5511990000002";
    let c = await say(f, "bom dia", phone);
    await perform(
      env,
      f.member,
      f.profile,
      "conversation.action",
      { id: c.id, action: "claim" },
      uid(),
    );
    const before = turns.length;
    c = await say(f, "eu sou do módulo", phone);
    const seen = turns.slice(before).find((t) => t.conversation === c.id);
    expect(seen).toMatchObject({
      state: "human",
      owner: f.member.id,
      text: "eu sou do módulo",
    });
    // O módulo tratou: a conversa continua com o atendente, sem menu nem bot.
    expect(c).toMatchObject({ state: "human", owner: f.member.id });
  });

  it("ferramentas MCP declaradas pelos módulos aparecem e respeitam o módulo", async () => {
    const f = await fixture();
    const app = await application(f, ["conversations:read"]);
    const rpc = (method: string, params: any = {}) =>
      SELF.fetch("https://test/api/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + app.token,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }).then((r) => r.json<any>());
    const list = await rpc("tools/list");
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "agenda_servicos",
        "agenda_horarios_livres",
        "agenda_agendar",
        "os_consultar",
        "os_detalhe",
      ]),
    );
    const book = list.result.tools.find(
      (t: any) => t.name === "agenda_agendar",
    );
    expect(Object.keys(book.inputSchema.properties)).toEqual(
      expect.arrayContaining(["profile", "idempotency_key", "starts"]),
    );
    // Ordem de Serviço vem desligada: a chamada recebe o 409 da rota.
    const call = await rpc("tools/call", {
      name: "os_consultar",
      arguments: { open: true },
    });
    expect(call.result.isError).toBe(true);
    expect(JSON.stringify(call.result)).toContain("module_disabled");
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "os", enabled: true },
      uid(),
    );
    const ok = await rpc("tools/call", {
      name: "os_consultar",
      arguments: { open: true },
    });
    expect(ok.result.isError).toBeFalsy();
    expect(ok.result.structuredContent.data).toEqual([]);
  });
});
