import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { all, one } from "../src/db";
import { now } from "../src/types";
import { modulesApi } from "../src/modules/api";
import {
  openSession,
  SESSION_MINUTES,
  updateSession,
} from "../src/modules/suporte/store";
import { measure } from "./d1-counter";
import { fixture, receive } from "./service-center-fixture";

describe("sessões de Suporte: gravação e retorno numa ida ao D1", () => {
  it("troca a sessão ativa em lote e devolve os valores gravados", async () => {
    const f = await fixture();
    const c = await receive(f, f.line, "oi", "5511971000091");
    const ctx = modulesApi(env, f.profile, "suporte");
    const at = now();
    const old = await openSession(ctx, c, "start", at);
    const { result, count } = await measure(env, (e) =>
      openSession(
        modulesApi(e, f.profile, "suporte"),
        c,
        "ask_document",
        at + 1,
      ),
    );
    expect(count.calls).toBe(1);
    expect(result).toMatchObject({
      profile_id: f.profile,
      conversation_id: c.id,
      phone: "5511971000091",
      status: "active",
      step: "ask_document",
      expires_at: at + 1 + SESSION_MINUTES * 60_000,
    });
    expect(result).toEqual(
      await one(env, "SELECT * FROM suporte_sessions WHERE id=?", result.id),
    );
    expect(
      await one(env, "SELECT status FROM suporte_sessions WHERE id=?", old.id),
    ).toEqual({ status: "closed" });
    const updated = await measure(env, (e) =>
      updateSession(modulesApi(e, f.profile, "suporte"), result, {
        step: "awaiting_payment",
        method: "pix",
      }),
    );
    expect(updated.count.calls).toBe(1);
    expect(updated.result).toMatchObject({
      id: result.id,
      step: "awaiting_payment",
      method: "pix",
    });
    expect(updated.result.expires_at).toBeGreaterThanOrEqual(result.expires_at);
    expect(updated.result).toEqual(
      await one(env, "SELECT * FROM suporte_sessions WHERE id=?", result.id),
    );
  });

  it("falha ao abrir a nova sessão mantém a anterior ativa", async () => {
    const f = await fixture();
    const c = await receive(f, f.line, "oi", "5511971000092");
    const ctx = modulesApi(env, f.profile, "suporte");
    const original = await openSession(ctx, c, "start", now());
    // Colisão de chave no INSERT, depois do UPDATE: o lote deve reverter os dois.
    const uuid = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(original.id as ReturnType<typeof crypto.randomUUID>);
    try {
      await expect(
        openSession(ctx, c, "ask_document", now() + 1),
      ).rejects.toThrow();
    } finally {
      uuid.mockRestore();
    }
    expect(
      await all(
        env,
        "SELECT * FROM suporte_sessions WHERE conversation_id=?",
        c.id,
      ),
    ).toEqual([original]);
  });

  it("atualizar pela área errada não altera nem devolve a sessão", async () => {
    const f = await fixture();
    const other = await fixture();
    const c = await receive(f, f.line, "oi", "5511971000093");
    const original = await openSession(
      modulesApi(env, f.profile, "suporte"),
      c,
      "start",
      now(),
    );
    expect(
      await updateSession(modulesApi(env, other.profile, "suporte"), original, {
        step: "awaiting_payment",
      }),
    ).toBeNull();
    expect(
      await one(env, "SELECT * FROM suporte_sessions WHERE id=?", original.id),
    ).toEqual(original);
  });
});
