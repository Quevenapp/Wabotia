import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, one } from "../src/db";
import { conversation, phoneVariants } from "../src/service";
import { json } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { drain, fixture, receive } from "./service-center-fixture";

describe("conversa pelo telefone", () => {
  it("variantes do celular brasileiro, com e sem o 9", () => {
    expect(phoneVariants("+55 (11) 99999-0000")).toEqual([
      "5511999990000",
      "551199990000",
    ]);
    expect(phoneVariants("551199990000")).toEqual([
      "551199990000",
      "5511999990000",
    ]);
    expect(phoneVariants("14155550100")).toEqual(["14155550100"]);
    expect(() => phoneVariants("123")).toThrow(/Telefone inválido/);
  });

  it("acha a conversa existente, com ou sem o 9", async () => {
    const f = await fixture();
    const r = await receive(f, f.line, "oi", "5511988880000");
    await drain(f);
    const ctx = modulesApi(env, f.profile, "forms");
    expect((await ctx.conversationByPhone("+55 (11) 98888-0000"))!.id).toBe(
      r.id,
    );
    expect((await ctx.conversationByPhone("551188880000"))!.id).toBe(r.id);
    expect(await ctx.conversationByPhone("5511977770000")).toBeNull();
  });

  it("abre na linha oficial para quem nunca escreveu; a resposta cai na mesma conversa", async () => {
    const f = await fixture();
    const ctx = modulesApi(env, f.profile, "forms");
    const opened = (await ctx.conversationByPhone("5511966660000", {
      open: true,
    }))!;
    expect(opened).toMatchObject({
      connection_id: f.line,
      external_id: "5511966660000",
      phone: "5511966660000",
      last_customer: 0,
      chat_type: "direct",
    });
    // De novo: a mesma.
    expect(
      (await ctx.conversationByPhone("5511966660000", { open: true }))!.id,
    ).toBe(opened.id);
    const created = await all(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='conversation.created' AND resource_id=?",
      f.profile,
      opened.id,
    );
    expect(created.map((e) => json(e.payload).opened_by)).toEqual([
      "module:forms",
    ]);
    // O cliente responde com outro identificador do WhatsApp (sem o 9).
    const reply = await receive(
      f,
      f.line,
      "oi, recebi o aviso",
      "551166660000",
      {},
      {
        external_id: "bsuid-123",
        phone: "551166660000",
      },
    );
    expect(reply.id).toBe(opened.id);
    const after = await conversation(env, opened.id, f.profile);
    expect(after.external_id).toBe("bsuid-123");
    expect(after.last_customer).toBeGreaterThan(0);
    expect(
      await all(
        env,
        "SELECT id FROM conversations WHERE profile_id=?",
        f.profile,
      ),
    ).toHaveLength(1);
  });

  it("só abre em linha oficial", async () => {
    const f = await fixture();
    const ctx = modulesApi(env, f.profile, "forms");
    await expect(
      ctx.conversationByPhone("5511955550000", {
        open: true,
        connection_id: f.qr,
      }),
    ).rejects.toThrow(/linha oficial/);
    expect(
      await one(
        env,
        "SELECT id FROM conversations WHERE profile_id=?",
        f.profile,
      ),
    ).toBeNull();
  });
});
