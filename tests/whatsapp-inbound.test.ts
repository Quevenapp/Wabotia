import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, exec, one } from "../src/db";
import { setSecret } from "../src/security";
import { defaults, now, uid } from "../src/types";
import { zernioInbound } from "../src/zernio";
import { inbound } from "../src/service";
import { drain, fixture } from "./service-center-fixture";

afterEach(() => vi.restoreAllMocks());

async function seed() {
  const profile = uid(),
    id = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    profile,
    "Recebimento",
    JSON.stringify(defaults),
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'zernio','direct','active',?,?)",
    id,
    profile,
    "WhatsApp",
    JSON.stringify({ account_id: "remote-account" }),
    now(),
  );
  await setSecret(env, `connection:${id}`, {
    api_key: "zernio-test-key",
    webhook_secret: "webhook-test-key",
  });
  return one(env, "SELECT * FROM connections WHERE id=?", id);
}

/** Simulated message.received webhook from Zernio. */
function received(text: string | null, metadata?: any) {
  return {
    id: `event-${uid()}`,
    event: "message.received",
    account: { accountId: "remote-account", platform: "whatsapp" },
    conversation: { id: "remote-thread", participantId: "5511999991111" },
    message: {
      id: uid(),
      conversationId: "remote-thread",
      platform: "whatsapp",
      platformMessageId: `wamid.${uid()}`,
      direction: "incoming",
      text,
      sender: {
        id: "5511999991111",
        phoneNumber: "+5511999991111",
        name: "Cliente",
      },
      attachments: [],
      sentAt: "2026-11-15T15:00:00.000Z",
      isRead: false,
    },
    ...(metadata === undefined ? {} : { metadata }),
    timestamp: "2026-11-15T15:00:01.000Z",
  };
}

async function deliver(body: any) {
  const conn = await seed();
  const fetch = vi.spyOn(globalThis, "fetch");
  const dispatch = vi.fn(async (_data: any) => Response.json({ ok: true }));
  await zernioInbound(env, conn, body, dispatch);
  expect(fetch).not.toHaveBeenCalled();
  expect(dispatch).toHaveBeenCalledOnce();
  return dispatch.mock.calls[0][0];
}

describe("recebimento normalizado", () => {
  it("resposta de Flow vira flow_reply com token, Flow e campos", async () => {
    const data = await deliver(
      received("Sent", {
        interactiveType: "nfm_reply",
        flowResponseJson:
          '{"flow_token":"1178094743614213:pedido-7","nome":"Ana","servico":"corte"}',
        flowResponseData: {
          flow_token: "1178094743614213:pedido-7",
          nome: "Ana",
          servico: "corte",
        },
      }),
    );
    expect(data.content).toMatchObject({
      type: "flow_reply",
      interactive_type: "nfm_reply",
      flow_reply: {
        name: "flow",
        flow_token: "1178094743614213:pedido-7",
        flow_id: "1178094743614213",
        data: { nome: "Ana", servico: "corte" },
      },
    });
    expect(data.content.interactive_reply_id).toBeUndefined();
    expect(data.text).toBe("Formulário enviado.\nnome: Ana\nservico: corte");
  });

  it("lê o JSON da resposta quando flowResponseData não vem", async () => {
    const data = await deliver(
      received("", {
        interactiveType: "nfm_reply",
        nfmReplyName: "address_message",
        flowResponseJson:
          '{"name":"Ana","address":"Rua A, 10","city":"São Paulo"}',
      }),
    );
    expect(data.content.flow_reply).toEqual({
      name: "address_message",
      flow_token: null,
      flow_id: null,
      data: { name: "Ana", address: "Rua A, 10", city: "São Paulo" },
    });
    expect(data.text.startsWith("Endereço enviado.\n")).toBe(true);
  });

  it("carrinho do catálogo vira order com itens e total", async () => {
    const data = await deliver(
      received(null, {
        order: {
          catalog_id: "194836987003835",
          text: "Sem cebola",
          product_items: [
            {
              product_retailer_id: "x-burger",
              quantity: 2,
              item_price: 25.5,
              currency: "BRL",
            },
            {
              product_retailer_id: "refri",
              quantity: "1",
              item_price: "6.9",
              currency: "brl",
            },
          ],
        },
      }),
    );
    expect(data.content).toMatchObject({
      type: "order",
      order: {
        catalog_id: "194836987003835",
        note: "Sem cebola",
        items: [
          {
            product_retailer_id: "x-burger",
            quantity: 2,
            item_price: 25.5,
            currency: "BRL",
          },
          {
            product_retailer_id: "refri",
            quantity: 1,
            item_price: 6.9,
            currency: "BRL",
          },
        ],
        total: { value: 57.9, currency: "BRL" },
      },
    });
    expect(data.text).toContain("Pedido pelo catálogo:\n2 x x-burger (R$");
    expect(data.text).toContain("Total: R$");
    expect(data.text.endsWith("Observação: Sem cebola")).toBe(true);
  });

  it("pedido com moedas diferentes fica sem total", async () => {
    const data = await deliver(
      received("", {
        order: {
          catalog_id: "c",
          product_items: [
            {
              product_retailer_id: "a",
              quantity: 1,
              item_price: 1,
              currency: "BRL",
            },
            {
              product_retailer_id: "b",
              quantity: 1,
              item_price: 1,
              currency: "USD",
            },
          ],
        },
      }),
    );
    expect(data.content.order.total).toBeNull();
  });

  it("localização enviada pelo cliente tem coordenadas numéricas", async () => {
    const data = await deliver(
      received("", {
        location: {
          latitude: "-23.5505",
          longitude: -46.6333,
          name: "Loja",
          address: "Praça da Sé",
        },
      }),
    );
    expect(data.content).toMatchObject({
      type: "location",
      location: {
        latitude: -23.5505,
        longitude: -46.6333,
        name: "Loja",
        address: "Praça da Sé",
      },
    });
    expect(data.text).toBe("");
  });

  it("pergunta sobre produto e origem do contato ficam no conteúdo", async () => {
    const data = await deliver(
      received("Tem no tamanho M?", {
        referredProduct: {
          catalog_id: "194836987003835",
          product_retailer_id: "camiseta",
        },
      }),
    );
    expect(data.content.referred_product).toEqual({
      catalog_id: "194836987003835",
      product_retailer_id: "camiseta",
    });
    expect(data.text).toBe("Tem no tamanho M?");
    const shared = await deliver(
      received("", {
        contactsOrigin: "contact_request",
        contacts: [
          {
            name: { formatted_name: "Ana" },
            phones: [{ phone: "+5511999991111" }],
          },
        ],
      }),
    );
    expect(shared.content).toMatchObject({
      type: "contacts",
      contacts_origin: "contact_request",
      contacts: [{ name: "Ana", phone: "+5511999991111" }],
    });
  });

  it("toques de botão e lista e mensagens antigas continuam iguais", async () => {
    const button = await deliver(
      received("Ajuda", {
        interactiveType: "button_reply",
        interactiveId: "wmenu:token:help",
      }),
    );
    expect(button.content).toMatchObject({
      type: "text",
      interactive_reply_id: "wmenu:token:help",
      interactive_type: "button_reply",
    });
    expect(button.text).toBe("Ajuda");
    const list = await deliver(
      received("14:00", {
        interactiveType: "list_reply",
        interactiveId: "h14",
      }),
    );
    expect(list.content.interactive_reply_id).toBe("h14");
    expect(list.text).toBe("14:00");
    const plain = await deliver(received("Olá"));
    expect(plain.text).toBe("Olá");
    expect(plain.content).toEqual({
      type: "text",
      participant: "5511999991111",
      participant_name: "Cliente",
      zernio_conversation_id: "remote-thread",
    });
  });

  it("o motor aceita e guarda resposta de Flow e pedido", async () => {
    const f = await fixture();
    const conn = await one(env, "SELECT * FROM connections WHERE id=?", f.line);
    conn.config = JSON.stringify({ account_id: "remote-account" });
    await setSecret(env, `connection:${f.line}`, {
      api_key: "zernio-test-key",
      webhook_secret: "webhook-test-key",
    });
    const dispatch = (data: any) =>
      inbound(env, f.profile, data, `channel:${f.line}`, f.line).then((r) =>
        Response.json(r),
      );
    await zernioInbound(
      env,
      conn,
      received("Sent", {
        interactiveType: "nfm_reply",
        flowResponseData: { flow_token: "1:ref", nome: "Ana" },
      }),
      dispatch,
    );
    await zernioInbound(
      env,
      conn,
      received("", {
        order: {
          catalog_id: "c",
          product_items: [
            {
              product_retailer_id: "a",
              quantity: 1,
              item_price: 2,
              currency: "BRL",
            },
          ],
        },
      }),
      dispatch,
    );
    await drain(f);
    const rows = await all(
      env,
      "SELECT text,content FROM messages WHERE profile_id=? AND direction='customer' ORDER BY created,rowid",
      f.profile,
    );
    expect(rows.map((row) => JSON.parse(row.content).type)).toEqual([
      "flow_reply",
      "order",
    ]);
    expect(rows[0].text).toBe("Formulário enviado.\nnome: Ana");
    expect(JSON.parse(rows[1].content).order.total).toEqual({
      value: 2,
      currency: "BRL",
    });
  });
});
