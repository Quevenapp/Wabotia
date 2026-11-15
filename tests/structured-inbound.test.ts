import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { conversation, perform } from "../src/service";
import { json, now, uid } from "../src/types";
import { onInboundContent } from "../src/modules/api";
import {
  configure,
  drain,
  fixture,
  latest,
  outbox,
  receive,
  type Fixture,
} from "./service-center-fixture";

const FLOW = "1234567890";
const cadastro = {
  id: "cadastro",
  name: "Cadastro",
  fields: [
    { id: "nome", type: "text", label: "Nome completo" },
    {
      id: "plano",
      type: "choice",
      label: "Plano",
      options: ["Mensal", "Anual"],
    },
    { id: "nascimento", type: "date", label: "Nascimento" },
    { id: "termos", type: "accept", label: "Aceito os termos" },
  ],
  flow_id: FLOW,
  flow_cta: "Preencher",
};
const menus = [
  {
    id: "form",
    label: "Preencher cadastro",
    type: "form",
    form_id: "cadastro",
  },
  { id: "atendente", label: "Falar com atendente", type: "human" },
];
const order = {
  type: "order",
  order: {
    catalog_id: "cat-1",
    note: "",
    items: [
      {
        product_retailer_id: "pizza-g",
        quantity: 2,
        item_price: 50,
        currency: "BRL",
      },
    ],
    total: { value: 100, currency: "BRL" },
  },
};

async function setup() {
  const f = await fixture();
  await exec(
    env,
    "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://atendimento.example.com',?)",
    now(),
  );
  await configure(f, { forms: [cadastro], menus });
  return f;
}
async function say(
  f: Fixture,
  text: string,
  phone: string,
  content: any = {},
  line = f.line,
) {
  const c = await receive(f, line, text, phone, content);
  await drain(f);
  return conversation(env, c.id, f.profile);
}
const step = (id: string) =>
  one(
    env,
    "SELECT * FROM web_steps WHERE conversation_id=? ORDER BY created DESC LIMIT 1",
    id,
  );
const menuSent = async (id: string) =>
  (await outbox(id)).filter((m) =>
    String(m.text).includes("Preencher cadastro"),
  ).length;

describe("passo web entregue como Flow nativo", () => {
  it("linha oficial com Flow publicado: envia o Flow com flow_token do passo", async () => {
    const f = await setup();
    await say(f, "oi", "5511960000001");
    const c = await say(f, "1", "5511960000001");
    const sent = await latest(c.id);
    const row = await step(c.id);
    expect(row.flow_token).toBe(`${FLOW}:${row.id}`);
    expect(sent.content.interactive).toMatchObject({
      type: "flow",
      action: {
        name: "flow",
        parameters: {
          flow_id: FLOW,
          flow_token: row.flow_token,
          flow_cta: "Preencher",
        },
      },
    });
    // O texto guardado leva o link da página, para histórico e queda.
    expect(sent.text).toMatch(/\/api\/w\/[A-Za-z0-9]{16}/);
  });

  it("linha QR: o mesmo formulário vai como link no texto", async () => {
    const f = await setup();
    await say(f, "oi", "5511960000002", {}, f.qr);
    const c = await say(f, "1", "5511960000002", {}, f.qr);
    expect((await latest(c.id)).content).toBeUndefined();
    expect((await step(c.id)).flow_token).toBeNull();
  });
});

describe("processInbox: flow_reply e order antes do menu e do bot", () => {
  it("flow_reply casa o flow_token, conclui o passo e não abre o menu", async () => {
    const f = await setup();
    const phone = "5511960000003";
    await say(f, "oi", phone);
    let c = await say(f, "1", phone);
    const row = await step(c.id);
    const menus = await menuSent(c.id);
    c = await say(f, "Formulário enviado.\nnome: Maria", phone, {
      type: "flow_reply",
      flow_reply: {
        name: "flow",
        flow_token: row.flow_token,
        flow_id: FLOW,
        data: {
          nome: "Maria",
          plano: "Anual",
          nascimento: "1990-04-21",
          termos: true,
        },
      },
    });
    const done = await step(c.id);
    expect(done.status).toBe("completed");
    expect(json(done.result)).toEqual({
      nome: "Maria",
      plano: "Anual",
      nascimento: "1990-04-21",
      termos: true,
    });
    expect(
      (
        await all(
          env,
          "SELECT id FROM events WHERE profile_id=? AND kind='web_step.completed'",
          f.profile,
        )
      ).length,
    ).toBe(1);
    expect((await latest(c.id)).text).toContain("Recebemos suas respostas");
    expect(await menuSent(c.id)).toBe(menus);
    expect(
      await all(env, "SELECT id FROM bot_runs WHERE conversation_id=?", c.id),
    ).toHaveLength(0);
  });

  it("flow_reply de passo de módulo desligado não conclui (revisão B3)", async () => {
    const f = await setup();
    const phone = "5511960000009";
    await say(f, "oi", phone);
    let c = await say(f, "1", phone);
    const row = await step(c.id);
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "forms", enabled: false },
      uid(),
    );
    c = await say(f, "Formulário enviado.", phone, {
      type: "flow_reply",
      flow_reply: {
        name: "flow",
        flow_token: row.flow_token,
        flow_id: FLOW,
        data: { nome: "Maria", plano: "Anual", termos: true },
      },
    });
    expect((await step(c.id)).status).not.toBe("completed");
    expect((await latest(c.id)).text).toContain("Este formulário expirou");
  });

  it("flow_reply incompleto pede reenvio; repetido diz que já recebeu", async () => {
    const f = await setup();
    const phone = "5511960000004";
    await say(f, "oi", phone);
    let c = await say(f, "1", phone);
    const token = (await step(c.id)).flow_token;
    const reply = (data: any) => ({
      type: "flow_reply",
      flow_reply: { name: "flow", flow_token: token, flow_id: FLOW, data },
    });
    c = await say(f, "Formulário enviado.", phone, reply({ nome: "Ana" }));
    expect((await latest(c.id)).text).toContain(
      "Algumas respostas obrigatórias não chegaram",
    );
    expect((await step(c.id)).status).toBe("sent");
    const full = {
      nome: "Ana",
      plano: "Mensal",
      nascimento: "2000-01-31",
      termos: "true",
    };
    c = await say(f, "Formulário enviado.", phone, reply(full));
    expect((await step(c.id)).status).toBe("completed");
    c = await say(f, "Formulário enviado.", phone, reply(full));
    expect((await latest(c.id)).text).toContain("Já recebemos as respostas");
  });

  it("order sem módulo dono: vai para a equipe com o resumo, sem menu", async () => {
    const f = await setup();
    const phone = "5511960000005";
    const c = await say(
      f,
      "Pedido pelo catálogo:\n2 x pizza-g (R$ 50,00 cada)\nTotal: R$ 100,00",
      phone,
      order,
    );
    expect(c.state).not.toBe("ai");
    expect(await menuSent(c.id)).toBe(0);
    expect(
      await all(env, "SELECT id FROM bot_runs WHERE conversation_id=?", c.id),
    ).toHaveLength(0);
  });

  it("flow_reply sem passo correspondente (endereço) não abre o menu", async () => {
    const f = await setup();
    const c = await say(
      f,
      "Endereço enviado.\ncity: São Paulo",
      "5511960000006",
      {
        type: "flow_reply",
        flow_reply: {
          name: "address_message",
          flow_token: null,
          flow_id: null,
          data: { city: "São Paulo" },
        },
      },
    );
    expect(await menuSent(c.id)).toBe(0);
    expect(c.state).not.toBe("ai");
  });

  it("order com atendente: fica no histórico, sem transferir", async () => {
    const f = await setup();
    const phone = "5511960000007";
    let c = await say(f, "bom dia", phone);
    await perform(
      env,
      f.member,
      f.profile,
      "conversation.action",
      { id: c.id, action: "claim" },
      uid(),
    );
    c = await say(f, "Pedido pelo catálogo:", phone, order);
    expect(c).toMatchObject({ state: "human", owner: f.member.id });
    expect(
      await one(
        env,
        "SELECT id FROM messages WHERE conversation_id=? AND text LIKE 'Pedido pelo catálogo%'",
        c.id,
      ),
    ).toBeTruthy();
  });

  it("módulo que trata order (onInboundContent) recebe o carrinho", async () => {
    const f = await setup();
    const seen: any[] = [];
    const phone = "5511960000008";
    onInboundContent("forms", "order", async (ctx, c, content) => {
      if (c.phone !== phone) return false;
      seen.push({ module: ctx.module.id, order: content.order });
      await ctx.sendMessage(c, { text: "Pedido recebido!" }, { key: "pedido" });
      return true;
    });
    const c = await say(f, "Pedido pelo catálogo:", phone, order);
    expect(seen).toHaveLength(1);
    expect(seen[0].order.total).toEqual({ value: 100, currency: "BRL" });
    expect((await latest(c.id)).text).toBe("Pedido recebido!");
    expect(c.state).toBe("ai");
  });
});
