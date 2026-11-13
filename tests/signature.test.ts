import { env, SELF } from "cloudflare:test";
import { it, expect, describe } from "vitest";
import { exec, one, all } from "../src/db";
import { json, now, uid } from "../src/types";
import { enqueue, perform, settings } from "../src/service";
import { deliver } from "../src/engine";
import { transport } from "../src/transport";
import { signedPayload } from "../src/signature";
import {
  fixture,
  receive,
  configure,
  bot,
  claim,
} from "./service-center-fixture";

describe("assinatura de quem escreve", () => {
  it("identifica pessoa e bot, e deixa mensagens automáticas como estão", async () => {
    const f = await fixture();
    const botId = await bot(f, true, "Bia");
    await exec(env, "UPDATE users SET name='Bruno' WHERE id=?", f.member.id);
    const cfg = await settings(env, f.profile);
    const sign = (actor: string, payload: any, kind = "text") =>
      signedPayload(env, cfg, { kind, actor }, payload);
    expect((await sign(f.member.id, { text: "Olá" })).text).toBe(
      "*Bruno - Humano*\nOlá",
    );
    expect((await sign("bot:" + botId, { text: "Olá" })).text).toBe(
      "*Bia - IA*\nOlá",
    );
    // Legenda de mídia também é assinada.
    expect(
      (await sign(f.member.id, { text: "veja", content: { type: "image" } }))
        .text,
    ).toBe("*Bruno - Humano*\nveja");
    for (const actor of ["system", "bot:attendant", "app:" + uid(), uid()])
      expect((await sign(actor, { text: "Olá" })).text).toBe("Olá");
    for (const payload of [
      { text: "" },
      { text: "Menu", content: { type: "interactive", interactive: {} } },
      { text: "x", content: { type: "reaction" } },
      { text: "x", template_message: {} },
    ])
      expect(await sign(f.member.id, payload)).toBe(payload);
    expect(await sign(f.member.id, { text: "aviso" }, "notification")).toEqual({
      text: "aviso",
    });
    // Formatação no nome não quebra o negrito da assinatura.
    await exec(
      env,
      "UPDATE users SET name=? WHERE id=?",
      "Ana *Lu*\n",
      f.other.id,
    );
    expect((await sign(f.other.id, { text: "Oi" })).text).toBe(
      "*Ana  Lu - Humano*\nOi",
    );
    await configure(f, { sender_signature: false });
    expect(
      (
        await signedPayload(
          env,
          await settings(env, f.profile),
          { kind: "text", actor: f.member.id },
          { text: "Olá" },
        )
      ).text,
    ).toBe("Olá");
  });
  it("assina só o que sai para o canal; o histórico guarda o texto original", async () => {
    const f = await fixture();
    await exec(env, "UPDATE users SET name='Bruno' WHERE id=?", f.member.id);
    const c = await receive(f, f.qr, "preciso de ajuda");
    await claim(f, f.member, c.id);
    await perform(
      env,
      f.member,
      f.profile,
      "conversation.action",
      { id: c.id, action: "reply", text: "Posso ajudar sim." },
      uid(),
    );
    const sent: any = await transport(env, f.qr, "commands", {});
    expect(sent.commands[0].payload.text).toBe(
      "*Bruno - Humano*\nPosso ajudar sim.",
    );
    const row = await one(
      env,
      "SELECT payload FROM outbox WHERE id=?",
      sent.commands[0].id,
    );
    expect(json(row.payload).text).toBe("Posso ajudar sim.");
  });
});

describe("Telegram removido", () => {
  const admin = (f: any) => f.admin;
  it("recusa novas conexões e o webhook, e deixa excluir a conexão antiga", async () => {
    const f = await fixture();
    await expect(
      perform(
        env,
        admin(f),
        f.profile,
        "connection.save",
        { name: "Equipe", kind: "telegram", config: { group: "-1001" } },
        uid(),
      ),
    ).rejects.toMatchObject({ status: 410, code: "telegram_removed" });
    const old = uid();
    await exec(
      env,
      "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'telegram','direct','active','{}',?)",
      old,
      f.profile,
      "Equipe",
      now(),
    );
    const hook = await SELF.fetch("https://test/webhooks/telegram/" + old, {
      method: "POST",
      body: "{}",
    });
    expect(hook.status).toBe(410);
    await expect(
      perform(env, admin(f), f.profile, "connection.test", { id: old }, uid()),
    ).rejects.toMatchObject({ code: "telegram_removed" });
    expect(
      await perform(
        env,
        admin(f),
        f.profile,
        "connection.delete",
        { id: old },
        uid(),
      ),
    ).toMatchObject({ id: old, deleted: true });
    expect(
      await one(env, "SELECT id FROM connections WHERE id=?", old),
    ).toBeNull();
  });
  it("descarta a configuração antiga e cancela espelhos que ficaram na fila", async () => {
    const f = await fixture();
    await exec(
      env,
      "UPDATE profiles SET settings=json_set(settings,'$.telegram_connection','x','$.telegram_group','-1001','$.reply_mode','direct') WHERE id=?",
      f.profile,
    );
    const saved: any = await configure(f, { instructions: "Seja breve." });
    expect(saved.telegram_connection).toBeUndefined();
    expect(saved.telegram_group).toBeUndefined();
    expect(saved.reply_mode).toBeUndefined();
    const c = await receive(f, f.line, "oi");
    await enqueue(
      env,
      c,
      "system",
      "team",
      { text: "Cliente: oi" },
      "mirror:x",
    );
    const row = await one(env, "SELECT * FROM outbox WHERE dedupe='mirror:x'");
    await deliver(env, row);
    expect(
      await all(env, "SELECT status,error FROM outbox WHERE id=?", row.id),
    ).toEqual([
      { status: "cancelled", error: "O espelho para o Telegram foi removido." },
    ]);
  });
});
