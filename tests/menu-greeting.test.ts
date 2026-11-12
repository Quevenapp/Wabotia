import { describe, expect, it } from "vitest";
import {
  configure,
  drain,
  fixture,
  latest,
  receive,
} from "./service-center-fixture";

const menus = [
  { id: "info", label: "Horários", type: "content", content: "Seg a sex." },
  { id: "mais", label: "Mais opções", type: "submenu" },
  {
    id: "mais-info",
    label: "Endereço",
    type: "content",
    content: "Rua A.",
    parent_id: "mais",
  },
];
const greeting =
  "Olá! Sou o assistente virtual da central.\n\nComo posso ajudar?";

async function menuFor(f: Awaited<ReturnType<typeof fixture>>, phone: string) {
  const c = await receive(f, f.line, "MENU", phone);
  await drain(f);
  return latest(c.id);
}

describe("saudação do menu principal", () => {
  it("usa menu_greeting no menu principal e o título do submenu nos demais", async () => {
    const f = await fixture();
    await configure(f, { menus });
    let sent = await menuFor(f, "5511900000001");
    expect(sent.text.startsWith("Como podemos ajudar?\n1. Horários")).toBe(
      true,
    );

    const saved = await configure(f, { menu_greeting: `  ${greeting}  ` });
    expect(saved.menu_greeting).toBe(greeting);
    sent = await menuFor(f, "5511900000002");
    expect(sent.text.startsWith(greeting + "\n1. Horários")).toBe(true);
    expect(sent.content.interactive.body.text).toBe(
      greeting + "\nEscolha uma opção abaixo.",
    );

    // Choosing the submenu shows its own title, not the greeting.
    const c = await receive(f, f.line, "2", "5511900000002");
    await drain(f);
    const submenu = await latest(c.id);
    expect(submenu.text.startsWith("Mais opções\n1. Endereço")).toBe(true);
    expect(submenu.text).not.toContain("assistente virtual");

    // Empty restores the default opening.
    await configure(f, { menu_greeting: "" });
    sent = await menuFor(f, "5511900000003");
    expect(sent.text.startsWith("Como podemos ajudar?\n")).toBe(true);
  });

  it("recusa saudação acima de 900 caracteres ou que não seja texto", async () => {
    const f = await fixture();
    await expect(
      configure(f, { menu_greeting: "a".repeat(901) }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(configure(f, { menu_greeting: 5 })).rejects.toMatchObject({
      status: 400,
    });
    expect(
      (await configure(f, { menu_greeting: "a".repeat(900) })).menu_greeting,
    ).toHaveLength(900);
  });
});
