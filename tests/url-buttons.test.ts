import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all } from "../src/db";
import {
  configure,
  drain,
  fixture,
  latest,
  receive,
} from "./service-center-fixture";

const menus = [
  {
    id: "site",
    label: "Site",
    type: "link",
    url: "https://example.com/ajuda",
    content: "Veja as perguntas frequentes.",
  },
  {
    id: "longo",
    label: "Perguntas frequentes do atendimento",
    type: "link",
    url: "https://example.com/faq",
  },
  { id: "app", label: "Aplicativo", type: "app", app_id: "app1" },
];
const apps = [
  {
    id: "app1",
    name: "App da Clínica",
    url: "https://example.com/app",
    review_url: "https://example.com/avaliar",
  },
];

describe("botão com URL em vez de link solto", () => {
  it("linha oficial: item de link e aplicativo do menu viram botão", async () => {
    const f = await fixture();
    await configure(f, { menus, apps });
    const phone = "5511930000001";
    const c = await receive(f, f.line, "Olá", phone);
    await drain(f);
    await receive(f, f.line, "1", phone);
    await drain(f);
    let sent = await latest(c.id);
    expect(sent.content.interactive).toMatchObject({
      type: "cta_url",
      body: { text: "Veja as perguntas frequentes." },
      action: {
        name: "cta_url",
        parameters: { display_text: "Site", url: "https://example.com/ajuda" },
      },
    });

    // Rótulo acima de 20 caracteres: botão "Abrir link".
    await receive(f, f.line, "menu", phone);
    await drain(f);
    await receive(f, f.line, "2", phone);
    await drain(f);
    sent = await latest(c.id);
    expect(sent.content.interactive.action.parameters).toEqual({
      display_text: "Abrir link",
      url: "https://example.com/faq",
    });

    await receive(f, f.line, "menu", phone);
    await drain(f);
    await receive(f, f.line, "3", phone);
    await drain(f);
    const rows = await all(
      env,
      "SELECT json_extract(payload,'$.content.interactive.action.parameters') p FROM outbox WHERE conversation_id=? ORDER BY created,rowid",
      c.id,
    );
    const buttons = rows.map((r) => r.p && JSON.parse(r.p)).filter(Boolean);
    expect(buttons).toContainEqual({
      display_text: "Abrir aplicativo",
      url: "https://example.com/app",
    });
    expect(buttons).toContainEqual({
      display_text: "Avaliar",
      url: "https://example.com/avaliar",
    });
  });

  it("linha QR: o mesmo item sai como texto com o link", async () => {
    const f = await fixture();
    await configure(f, { menus, apps });
    const c = await receive(f, f.qr, "Olá", "5511930000002");
    await drain(f);
    await receive(f, f.qr, "1", "5511930000002");
    await drain(f);
    const sent = await latest(c.id);
    expect(sent.content).toBeUndefined();
    expect(sent.text).toContain("Veja as perguntas frequentes.");
    expect(sent.text).toContain("https://example.com/ajuda");
  });
});
