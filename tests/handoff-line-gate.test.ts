// Revisão de segurança M2: a linha em "atendimento por pessoa" punha todo
// cliente novo na fila da equipe sem passar pelo Suporte pago.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { exec, one } from "../src/db";
import { fixture, receive, drain } from "./service-center-fixture";
import { useMercadoPago } from "./mensalidade-mp";
import { releases, setupSuporte, talk } from "./suporte-fixture";
import { conversation } from "../src/service";

useMercadoPago();

const humanLine = (line: string) =>
  exec(
    env,
    "UPDATE connections SET config=? WHERE id=?",
    JSON.stringify({ service: { mode: "human" } }),
    line,
  );

describe("linha em atendimento por pessoa passa pelo portão (revisão M2)", () => {
  it("A: com o Suporte pago ligado, cliente novo não cai na fila sem pagar", async () => {
    const s = await setupSuporte();
    const { f } = s;
    await humanLine(f.line);
    const c = await talk(f, "oi, quero falar com alguém", "5511973000001");
    expect(c.state).not.toBe("waiting");
    expect(await releases(c.id)).toHaveLength(0);
    // O Suporte segurou e conduz a conversa (sessão aberta).
    expect(
      await one(
        env,
        "SELECT id FROM suporte_sessions WHERE conversation_id=? AND status='active'",
        c.id,
      ),
    ).toBeTruthy();
    // A próxima mensagem chega ao fluxo do Suporte, sem nova passagem.
    const again = await talk(f, "1", "5511973000001");
    expect(again.state).not.toBe("waiting");
  });

  it("sem módulo de gancho ligado, a linha põe na fila como antes", async () => {
    const f = await fixture();
    await humanLine(f.line);
    const c = await receive(f, f.line, "oi", "5511973000002");
    await drain(f);
    expect((await conversation(env, c.id, f.profile)).state).toBe("waiting");
  });
});
