import { describe, expect, it } from "vitest";
import seed from "../scripts/seed-local.mjs?raw";
import { aiConfig, aiKey } from "../src/ai-provider";

// scripts/seed-local.mjs quebrava na 0.22.0 ao criar conexões Hermes, que o
// servidor recusa desde a retirada ("Hermes retirado: escolha um bot interno").
describe("carga local: bots internos", () => {
  it("não cria conexões Hermes e cria a IA de demonstração com configuração aceita", () => {
    expect(seed).not.toMatch(/kind:\s*["']hermes/);
    expect(seed).toMatch(/kind:\s*"ai"/);
    const config = aiConfig({
      provider: "compatible",
      model: "demonstracao",
      base_url: "https://ia.demonstracao.invalid/v1",
    });
    expect(seed).toContain(`base_url: "https://ia.demonstracao.invalid/v1"`);
    expect(config.base_url).toContain("ia.demonstracao.invalid");
    expect(aiKey("local-seed-0123abcd")).toBe("local-seed-0123abcd");
  });
});
