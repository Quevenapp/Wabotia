// Gerador de QR do painel (web/lib/qr-code.ts, cópia exata do Fagoo): o QR
// da via de entrega cabe com folga na versão 15 com correção M.
import { describe, expect, it } from "vitest";
import { qrCapacity, qrEncode, qrPath } from "../web/lib/qr-code";

describe("QR da via de entrega", () => {
  it("o endereço de troca do QR cabe com folga (versão 15, correção M: 412 bytes)", () => {
    expect(qrCapacity(15)).toBe(412);
    const code = "A".repeat(32);
    // Endereço típico e um domínio longo de instalação própria.
    for (const origin of [
      "https://wabotia.queven.app",
      "https://" + "atendimento-da-lanchonete-".repeat(4) + "exemplo.com.br",
    ]) {
      const url = `${origin}/c/${code}`;
      const qr = qrEncode(url);
      // ~61 bytes: versão 4; domínio de ~150 caracteres: versão 9.
      expect(qr.version).toBeLessThanOrEqual(url.length < 80 ? 5 : 10);
      expect(qr.size).toBe(17 + 4 * qr.version);
      expect(qr.modules).toHaveLength(qr.size);
      expect(qrPath(qr)).toMatch(/^M\d+ \d+h1v1h-1z/);
    }
    // Determinístico: o mesmo texto, a mesma matriz.
    const a = qrEncode("https://wabotia.queven.app/c/" + code);
    const b = qrEncode("https://wabotia.queven.app/c/" + code);
    expect(a.modules).toEqual(b.modules);
    // Acima do limite, erro (não um QR errado).
    expect(() => qrEncode("x".repeat(413))).toThrow("QR_TOO_LONG");
  });
});
