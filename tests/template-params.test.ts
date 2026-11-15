import { describe, expect, it } from "vitest";
import { templateParam } from "../src/template-params";

describe("parâmetro de modelo do WhatsApp", () => {
  it("tira quebras de linha e tabulações (a Meta recusa)", () => {
    // Texto de uma cobrança do núcleo fora da janela.
    const text =
      "Mensalidade de novembro\nValor: R$ 99,00\n\nPague com Pix:\nhttps://mpago.la/abc\n\nPix copia e cola:\n00020126PIX123";
    const param = templateParam(text);
    expect(param).toBe(
      "Mensalidade de novembro · Valor: R$ 99,00 · Pague com Pix: · https://mpago.la/abc · Pix copia e cola: · 00020126PIX123",
    );
    expect(param).not.toMatch(/[\r\n\t]/);
    expect(templateParam("a\r\n\tb")).toBe("a · b");
  });

  it("limita espaços seguidos, apara as pontas e nunca fica vazio", () => {
    expect(templateParam("a        b")).toBe("a   b");
    expect(templateParam("\n\nolá\n")).toBe("olá");
    expect(templateParam("   ")).toBe("-");
    expect(templateParam(undefined)).toBe("-");
  });

  it("corta pelo limite contando caracteres, não unidades UTF-16", () => {
    expect(templateParam("😀".repeat(5), 3)).toBe("😀😀😀");
    expect(Array.from(templateParam("x".repeat(2000))).length).toBe(1000);
  });
});
