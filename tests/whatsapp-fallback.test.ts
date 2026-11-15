import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  interactiveChoice,
  interactiveLine,
  sendInteractive,
} from "../src/line-service";
import {
  type InteractiveSpec,
  interactiveFallbackText,
} from "../src/whatsapp-interactive";
import { fixture, outbox, receive } from "./service-center-fixture";

const list: InteractiveSpec = {
  type: "list",
  header: "Agenda",
  body: "Escolha o horário",
  button: "Ver horários",
  footer: "Barbearia",
  sections: [
    {
      title: "Manhã",
      rows: [{ id: "h9", title: "09:00", description: "Com Ana" }],
    },
    { title: "Tarde", rows: [{ id: "h14", title: "14:00" }] },
  ],
};

describe("queda para linhas sem interativo", () => {
  it("QR recebe a lista como texto numerado e a resposta por número ou título escolhe a opção", async () => {
    const f = await fixture();
    const c = await receive(f, f.qr, "oi", "5511930000001");
    expect(await interactiveLine(env, c)).toBe(false);
    await sendInteractive(env, "system", c, list, `agenda:${c.id}`, "agenda");
    const [sent] = await outbox(c.id);
    expect(sent.content).toBeUndefined();
    expect(sent.automation).toBe("agenda");
    expect(sent.text).toBe(
      "Agenda\nEscolha o horário\n\nManhã:\n1. 09:00 - Com Ana\nTarde:\n2. 14:00\n\nResponda com o número da opção.\n\nBarbearia",
    );
    expect(interactiveChoice(list, "2")).toBe("h14");
    expect(interactiveChoice(list, " 09:00 ")).toBe("h9");
    expect(interactiveChoice(list, "3")).toBeNull();
    // On official lines the tapped row id is checked against the spec.
    expect(interactiveChoice(list, "", "h9")).toBe("h9");
    expect(interactiveChoice(list, "", "outro")).toBeNull();
  });

  it("linha oficial recebe o elemento nativo e guarda o texto numerado como histórico", async () => {
    const f = await fixture();
    const c = await receive(f, f.line, "oi", "5511930000002");
    expect(await interactiveLine(env, c)).toBe(true);
    await sendInteractive(env, "system", c, list, `agenda:${c.id}`);
    const [sent] = await outbox(c.id);
    expect(sent.content.type).toBe("interactive");
    expect(sent.content.interactive.type).toBe("list");
    expect(sent.content.interactive.action.sections[1].rows[0].id).toBe("h14");
    expect(sent.text).toBe(interactiveFallbackText(list));
  });

  it("a mesma chave não repete o envio", async () => {
    const f = await fixture();
    const c = await receive(f, f.qr, "oi", "5511930000003");
    const first = await sendInteractive(env, "system", c, list, `same:${c.id}`);
    const again = await sendInteractive(env, "system", c, list, `same:${c.id}`);
    expect(again).toBe(first);
    expect(await outbox(c.id)).toHaveLength(1);
  });

  it("grupo em linha oficial também recebe texto", async () => {
    const f = await fixture();
    const c = await receive(f, f.line, "oi", "120363000000000001");
    expect(await interactiveLine(env, { ...c, chat_type: "group" })).toBe(
      false,
    );
  });

  it("links, carrossel, localização, produto e Flow viram texto com link no corpo", () => {
    expect(
      interactiveFallbackText({
        type: "cta_url",
        body: "Acompanhe o seu pedido.",
        display_text: "Abrir pedido",
        url: "https://loja.example/p/42",
      }),
    ).toBe(
      "Acompanhe o seu pedido.\n\nAbrir pedido: https://loja.example/p/42",
    );
    expect(
      interactiveFallbackText({
        type: "media_carousel",
        body: "Nossos serviços",
        cards: [
          {
            media: "image",
            link: "https://example.com/a.jpg",
            body: "Corte",
            display_text: "Agendar",
            url: "https://example.com/a",
          },
          {
            media: "image",
            link: "https://example.com/b.jpg",
            display_text: "Ver",
            url: "https://example.com/b",
          },
        ],
      }),
    ).toBe(
      "Nossos serviços\n\n1. Corte - Agendar: https://example.com/a\n2. Ver: https://example.com/b",
    );
    expect(
      interactiveFallbackText({
        type: "location_request",
        body: "Envie o endereço de entrega.",
      }),
    ).toContain("escolha Localização");
    expect(
      interactiveFallbackText({
        type: "product_list",
        catalog_id: "c",
        header: "Cardápio",
        body: "Toque para ver",
        sections: [{ title: "Lanches", product_retailer_ids: ["x1"] }],
        fallback: {
          text: "X-burger R$ 25,00",
          url: "https://loja.example/cardapio",
        },
      }),
    ).toBe(
      "Cardápio\nToque para ver\n\nX-burger R$ 25,00\nAcesse: https://loja.example/cardapio",
    );
    expect(
      interactiveFallbackText({
        type: "product",
        catalog_id: "c",
        product_retailer_id: "sku",
      }),
    ).toBe("Separamos um produto do nosso catálogo para você.");
    expect(
      interactiveFallbackText({
        type: "flow",
        flow_id: "1",
        flow_cta: "Agendar",
        body: "Escolha data e serviço",
        flow_token: "1:ref",
        fallback: { url: "https://app.example/w/abc" },
      }),
    ).toBe("Escolha data e serviço\n\nAcesse: https://app.example/w/abc");
  });

  it("texto longo no QR é dividido como no menu", async () => {
    const f = await fixture();
    const c = await receive(f, f.qr, "oi", "5511930000004");
    await sendInteractive(
      env,
      "system",
      c,
      { ...list, body: "x".repeat(4000) },
      `longo:${c.id}`,
    );
    const sent = await outbox(c.id);
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toHaveLength(3800);
    expect(sent[1].text.endsWith("Barbearia")).toBe(true);
  });

  it("valida os limites também no QR", async () => {
    const f = await fixture();
    const c = await receive(f, f.qr, "oi", "5511930000005");
    await expect(
      sendInteractive(
        env,
        "system",
        c,
        { ...list, button: "Um botão com texto longo demais" },
        `invalido:${c.id}`,
      ),
    ).rejects.toMatchObject({ code: "invalid_interactive" });
    expect(await outbox(c.id)).toHaveLength(0);
  });
});
