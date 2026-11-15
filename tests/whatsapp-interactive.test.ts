import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exec, one } from "../src/db";
import { setSecret } from "../src/security";
import { defaults, now, uid } from "../src/types";
import {
  type InteractiveSpec,
  buildInteractive,
} from "../src/whatsapp-interactive";
import {
  zernioRememberConversation,
  zernioSendInteractive,
} from "../src/zernio";

afterEach(() => vi.restoreAllMocks());

async function seed() {
  const profile = uid(),
    id = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,created) VALUES(?,?,?,?)",
    profile,
    "Interativos",
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
  const conn = await one(env, "SELECT * FROM connections WHERE id=?", id);
  await zernioRememberConversation(env, conn, "5511999990000", "thread-1");
  return conn;
}

/** Simulated Zernio inbox reply; captures the JSON body it received. */
function mockZernio(messageId = "wamid.sent") {
  const bodies: any[] = [];
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe("POST");
      expect(request.url).toBe(
        "https://zernio.com/api/v1/inbox/conversations/thread-1/messages",
      );
      bodies.push(await request.json());
      return Response.json({
        success: true,
        data: { messageId, conversationId: "thread-1" },
      });
    });
  return { fetch, bodies };
}

const cards = [
  {
    media: "image" as const,
    link: "https://example.com/a.jpg",
    body: "Corte",
    display_text: "Agendar",
    url: "https://example.com/a",
  },
  {
    media: "image" as const,
    link: "https://example.com/b.jpg",
    display_text: "Agendar",
    url: "https://example.com/b",
  },
];

// One case per documented send, with the exact body Zernio must receive.
const sends: [string, InteractiveSpec, any][] = [
  [
    "CTA URL button",
    {
      type: "cta_url",
      header: "Pedido 42",
      body: "Acompanhe o seu pedido.",
      footer: "Loja",
      display_text: "Abrir pedido",
      url: "https://loja.example/p/42",
    },
    {
      type: "cta_url",
      header: { type: "text", text: "Pedido 42" },
      body: { text: "Acompanhe o seu pedido." },
      footer: { text: "Loja" },
      action: {
        name: "cta_url",
        parameters: {
          display_text: "Abrir pedido",
          url: "https://loja.example/p/42",
        },
      },
    },
  ],
  [
    "list",
    {
      type: "list",
      body: "Escolha o horário",
      button: "Ver horários",
      sections: [
        {
          title: "Manhã",
          rows: [{ id: "h9", title: "09:00", description: "Com Ana" }],
        },
        { title: "Tarde", rows: [{ id: "h14", title: "14:00" }] },
      ],
    },
    {
      type: "list",
      body: { text: "Escolha o horário" },
      action: {
        button: "Ver horários",
        sections: [
          {
            title: "Manhã",
            rows: [{ id: "h9", title: "09:00", description: "Com Ana" }],
          },
          { title: "Tarde", rows: [{ id: "h14", title: "14:00" }] },
        ],
      },
    },
  ],
  [
    "media carousel",
    { type: "media_carousel", body: "Nossos serviços", cards },
    {
      type: "carousel",
      body: { text: "Nossos serviços" },
      action: {
        cards: [
          {
            card_index: 0,
            type: "cta_url",
            header: {
              type: "image",
              image: { link: "https://example.com/a.jpg" },
            },
            body: { text: "Corte" },
            action: {
              name: "cta_url",
              parameters: {
                display_text: "Agendar",
                url: "https://example.com/a",
              },
            },
          },
          {
            card_index: 1,
            type: "cta_url",
            header: {
              type: "image",
              image: { link: "https://example.com/b.jpg" },
            },
            action: {
              name: "cta_url",
              parameters: {
                display_text: "Agendar",
                url: "https://example.com/b",
              },
            },
          },
        ],
      },
    },
  ],
  [
    "location request",
    { type: "location_request", body: "Envie o endereço de entrega." },
    {
      type: "location_request_message",
      body: { text: "Envie o endereço de entrega." },
      action: { name: "send_location" },
    },
  ],
  [
    "single product",
    {
      type: "product",
      catalog_id: "194836987003835",
      product_retailer_id: "sku-1",
      body: "Voltou ao estoque",
    },
    {
      type: "product",
      body: { text: "Voltou ao estoque" },
      action: { catalog_id: "194836987003835", product_retailer_id: "sku-1" },
    },
  ],
  [
    "product list",
    {
      type: "product_list",
      catalog_id: "194836987003835",
      header: "Cardápio",
      body: "Toque para ver",
      sections: [{ title: "Lanches", product_retailer_ids: ["x1", "x2"] }],
    },
    {
      type: "product_list",
      header: { type: "text", text: "Cardápio" },
      body: { text: "Toque para ver" },
      action: {
        catalog_id: "194836987003835",
        sections: [
          {
            title: "Lanches",
            product_items: [
              { product_retailer_id: "x1" },
              { product_retailer_id: "x2" },
            ],
          },
        ],
      },
    },
  ],
  [
    "catalog",
    {
      type: "catalog",
      body: "Veja o catálogo completo",
      thumbnail_product_retailer_id: "sku-1",
    },
    {
      type: "catalog_message",
      body: { text: "Veja o catálogo completo" },
      action: {
        name: "catalog_message",
        parameters: { thumbnail_product_retailer_id: "sku-1" },
      },
    },
  ],
  [
    "Flow inside the conversation",
    {
      type: "flow",
      flow_id: "1178094743614213",
      flow_cta: "Agendar",
      body: "Escolha data e serviço",
      flow_token: "1178094743614213:ref-1",
      flow_action_payload: { screen: "AGENDA" },
    },
    {
      type: "flow",
      body: { text: "Escolha data e serviço" },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: "1178094743614213:ref-1",
          flow_id: "1178094743614213",
          flow_cta: "Agendar",
          flow_action: "navigate",
          flow_action_payload: { screen: "AGENDA" },
        },
      },
    },
  ],
];

describe("zernioSendInteractive", () => {
  for (const [name, spec, interactive] of sends)
    it(`sends a ${name} through the inbox with the documented shape`, async () => {
      const conn = await seed();
      const { fetch, bodies } = mockZernio();
      await expect(
        zernioSendInteractive(env, conn, "5511999990000", spec, "delivery-1"),
      ).resolves.toBe("wamid.sent");
      expect(fetch).toHaveBeenCalledTimes(1);
      // No loose `message`: the text lives inside the interactive object.
      expect(bodies[0]).toEqual({ accountId: "remote-account", interactive });
      expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
        "Idempotency-Key": "delivery-1",
      });
    });

  it("checks the limits before calling Zernio", async () => {
    const conn = await seed();
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      zernioSendInteractive(env, conn, "5511999990000", {
        type: "cta_url",
        body: "Oi",
        display_text: "Um texto longo demais para o botão",
        url: "https://example.com",
      }),
    ).rejects.toMatchObject({ status: 422, code: "invalid_interactive" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the reply-button and raw interactive paths unchanged", async () => {
    const conn = await seed();
    const { zernioSend } = await import("../src/zernio");
    const { bodies } = mockZernio();
    await zernioSend(env, conn, "5511999990000", {
      text: "Escolha\n1. Ajuda",
      content: {
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: "Escolha" },
          action: { buttons: [{ reply: { id: "help", title: "Ajuda" } }] },
        },
      },
    });
    expect(bodies[0]).toEqual({
      accountId: "remote-account",
      message: "Escolha",
      buttons: [{ type: "postback", title: "Ajuda", payload: "help" }],
    });
  });
});

describe("buildInteractive limits", () => {
  const bad: [string, any, string][] = [
    [
      "CTA without http(s) link",
      { type: "cta_url", body: "x", display_text: "Abrir", url: "ftp://a" },
      "link do botão",
    ],
    [
      "list with 11 rows",
      {
        type: "list",
        body: "x",
        button: "Ver",
        sections: [
          {
            rows: Array.from({ length: 11 }, (_, i) => ({
              id: `r${i}`,
              title: `Opção ${i}`,
            })),
          },
        ],
      },
      "10 opções",
    ],
    [
      "list row title over 24 characters",
      {
        type: "list",
        body: "x",
        button: "Ver",
        sections: [{ rows: [{ id: "a", title: "x".repeat(25) }] }],
      },
      "24 caracteres",
    ],
    [
      "list with repeated ids",
      {
        type: "list",
        body: "x",
        button: "Ver",
        sections: [
          {
            rows: [
              { id: "a", title: "A" },
              { id: "a", title: "B" },
            ],
          },
        ],
      },
      "repetir",
    ],
    [
      "several list sections without title",
      {
        type: "list",
        body: "x",
        button: "Ver",
        sections: [
          { rows: [{ id: "a", title: "A" }] },
          { rows: [{ id: "b", title: "B" }] },
        ],
      },
      "título da seção",
    ],
    [
      "carousel with one card",
      { type: "media_carousel", body: "x", cards: [cards[0]] },
      "2 a 10",
    ],
    [
      "carousel mixing image and video",
      {
        type: "media_carousel",
        body: "x",
        cards: [cards[0], { ...cards[1], media: "video" }],
      },
      "mesmo tipo",
    ],
    [
      "carousel card text over 160 characters",
      {
        type: "media_carousel",
        body: "x",
        cards: [{ ...cards[0], body: "x".repeat(161) }, cards[1]],
      },
      "160",
    ],
    [
      "product list over 30 items",
      {
        type: "product_list",
        catalog_id: "c",
        header: "H",
        body: "x",
        sections: [
          {
            title: "S",
            product_retailer_ids: Array.from({ length: 31 }, (_, i) => `p${i}`),
          },
        ],
      },
      "30 itens",
    ],
    [
      "product list without header",
      {
        type: "product_list",
        catalog_id: "c",
        body: "x",
        sections: [{ title: "S", product_retailer_ids: ["p"] }],
      },
      "cabeçalho",
    ],
    [
      "product without catalog",
      { type: "product", product_retailer_id: "p" },
      "catálogo",
    ],
    [
      "header over 60 characters",
      {
        type: "cta_url",
        header: "x".repeat(61),
        body: "x",
        display_text: "Abrir",
        url: "https://a.example",
      },
      "60",
    ],
    ["unknown type", { type: "order_details" }, "não suportado"],
  ];
  for (const [name, spec, message] of bad)
    it(`rejects ${name}`, () => {
      expect(() => buildInteractive(spec)).toThrowError(message);
    });

  it("counts emoji as one character", () => {
    expect(() =>
      buildInteractive({
        type: "cta_url",
        body: "x",
        display_text: "😀".repeat(20),
        url: "https://a.example",
      }),
    ).not.toThrow();
  });
});
