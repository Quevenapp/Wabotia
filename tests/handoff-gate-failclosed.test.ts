// Revisão de segurança B1 (núcleo): o portão recebe o rowId da mensagem e o
// módulo pode declarar que erro no gancho segura a passagem (fail-closed).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all } from "../src/db";
import { conversation, perform } from "../src/service";
import { uid } from "../src/types";
import { onHandoffRequest, type HandoffGateRequest } from "../src/modules/api";
import { drain, fixture, receive } from "./service-center-fixture";

// Os ganchos são globais no carregamento; cada teste filtra pela própria área.
const seen: HandoffGateRequest[] = [];
const mode = new Map<string, "throw" | "allow">();
onHandoffRequest(
  "forms",
  async (ctx, _c, request) => {
    seen.push(request);
    if (mode.get(ctx.profile) === "throw") throw new Error("falha do módulo");
    return "allow";
  },
  { failClosed: true },
);

async function setup(behavior: "throw" | "allow") {
  const f = await fixture();
  await perform(
    env,
    f.admin,
    f.profile,
    "module.set",
    { id: "forms", enabled: true },
    uid(),
  );
  mode.set(f.profile, behavior);
  return f;
}

describe("portão de passagem: rowId e fail-closed (revisão B1)", () => {
  it("o pedido traz o id da mensagem que pediu a passagem", async () => {
    const f = await setup("allow");
    const c = await receive(
      f,
      f.line,
      "quero falar com um atendente",
      "5511972220001",
    );
    await drain(f);
    const request = seen.at(-1)!;
    expect(request.source).toBe("keyword");
    const [row] = await all(
      env,
      "SELECT id FROM inbox WHERE conversation_id=? ORDER BY created DESC LIMIT 1",
      c.id,
    );
    expect(request.row_id).toBe(row.id);
    expect((await conversation(env, c.id, f.profile)).state).toBe("waiting");
  });

  it("fail-closed: erro no gancho segura a conversa e deixa nota para a equipe", async () => {
    const f = await setup("throw");
    const c = await receive(
      f,
      f.line,
      "quero falar com um atendente",
      "5511972220002",
    );
    await drain(f);
    expect((await conversation(env, c.id, f.profile)).state).not.toBe(
      "waiting",
    );
    const notes = await all(
      env,
      "SELECT text FROM messages WHERE conversation_id=? AND direction='note'",
      c.id,
    );
    expect(notes.map((n) => n.text).join("\n")).toContain(
      "Passagem para a equipe segurada",
    );
  });
});
