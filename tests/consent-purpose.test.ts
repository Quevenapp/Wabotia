import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, one } from "../src/db";
import { conversation } from "../src/service";
import { json } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { zernioTemplatePayload } from "../src/zernio";
import { consentFor } from "../src/consents";
import {
  configure,
  drain,
  fixture,
  receive,
  type Fixture,
} from "./service-center-fixture";

async function setup() {
  const f: Fixture = await fixture();
  await configure(f, {
    notifications: { enabled: true, template_name: "aviso", language: "pt_BR" },
  });
  const r = await receive(f, f.line, "oi", "5511990005555");
  await drain(f);
  const c = await conversation(env, r.id, f.profile);
  const conn = await one(env, "SELECT * FROM connections WHERE id=?", f.line);
  const cfg = { notifications: { enabled: true, template_name: "aviso" } };
  // Fora da janela: a notificação só segue com o consentimento certo. Sem
  // ele, notification_waiting antes de qualquer chamada à Zernio.
  const gate = async (payload: any) => {
    try {
      await zernioTemplatePayload(env, conn, c, payload, cfg);
      return "sent";
    } catch (error: any) {
      return error.code === "notification_waiting" ? "waiting" : "sent";
    }
  };
  return { f, c, ctx: modulesApi(env, f.profile, "forms"), gate };
}

describe("consentimento por finalidade", () => {
  it("o módulo registra o aceite; a notificação da finalidade passa a sair", async () => {
    const { f, c, ctx, gate } = await setup();
    const billing = {
      text: "Sua mensalidade vence amanhã.",
      consent_purpose: "billing",
    };
    expect(await gate(billing)).toBe("waiting");
    const row = await ctx.recordConsent(c, {
      purpose: "billing",
      source: "whatsapp",
      evidence: { plan: "Mensal", message_id: "wamid.1" },
      key: "assinatura-7",
    });
    expect(row).toMatchObject({
      purpose: "billing",
      status: "granted",
      source: "whatsapp",
      module_id: "forms",
    });
    expect(json(row.evidence)).toEqual({
      plan: "Mensal",
      message_id: "wamid.1",
    });
    // Mesma chave: não registra de novo.
    await ctx.recordConsent(c, {
      purpose: "billing",
      source: "whatsapp",
      key: "assinatura-7",
    });
    expect(
      await all(env, "SELECT id FROM consents WHERE conversation_id=?", c.id),
    ).toHaveLength(1);
    expect(await gate(billing)).toBe("sent");
    // Outra finalidade e o protocolo continuam esperando.
    expect(
      await gate({ text: "Lembrete", consent_purpose: "scheduling" }),
    ).toBe("waiting");
    expect(await gate({ text: "Protocolo atualizado" })).toBe("waiting");
    expect((await ctx.consent(c, "billing")).status).toBe("granted");
    const events = await all(
      env,
      "SELECT payload FROM events WHERE profile_id=? AND kind='consent.updated'",
      f.profile,
    );
    expect(json(events[0].payload)).toMatchObject({
      purpose: "billing",
      status: "granted",
      module_id: "forms",
    });
  });

  it("consentimento de protocolo não vale para módulo; REVOGAR revoga todos", async () => {
    const { f, c, ctx, gate } = await setup();
    // O cliente autoriza o protocolo (fluxo do núcleo).
    await env.DB.prepare(
      "INSERT INTO consents(id,profile_id,conversation_id,status,evidence,created) VALUES('p1',?,?,'granted','{}',?)",
    )
      .bind(f.profile, c.id, Date.now() - 1000)
      .run();
    expect(await gate({ text: "Protocolo atualizado" })).toBe("sent");
    expect(await gate({ text: "Cobrança", consent_purpose: "billing" })).toBe(
      "waiting",
    );
    await ctx.recordConsent(c, { purpose: "booking", source: "panel" });
    expect(await gate({ text: "Reserva", consent_purpose: "booking" })).toBe(
      "sent",
    );
    // A pergunta de protocolo não é repetida por causa do consentimento do módulo,
    // e vice-versa: o protocolo continua sendo o do protocolo.
    expect((await consentFor(env, c.id, "protocol")).id).toBe("p1");

    // REVOGAR pelo WhatsApp.
    await receive(f, f.line, "REVOGAR", "5511990005555");
    await drain(f);
    expect(await gate({ text: "Protocolo atualizado" })).toBe("waiting");
    expect(await gate({ text: "Reserva", consent_purpose: "booking" })).toBe(
      "waiting",
    );
    // Nova contratação depois do REVOGAR vale de novo para a finalidade.
    await ctx.recordConsent(c, { purpose: "booking", source: "whatsapp" });
    expect(await gate({ text: "Reserva", consent_purpose: "booking" })).toBe(
      "sent",
    );
  });

  it("valida finalidade, origem e o purpose do envio", async () => {
    const { c, ctx } = await setup();
    await expect(
      ctx.recordConsent(c, { purpose: "marketing" as any, source: "whatsapp" }),
    ).rejects.toThrow(/Finalidade inválida/);
    await expect(
      ctx.recordConsent(c, { purpose: "order", source: "" }),
    ).rejects.toThrow(/origem/);
    await expect(
      ctx.sendMessage(c, { text: "oi" }, { key: "x", purpose: "spam" as any }),
    ).rejects.toThrow(/Finalidade inválida/);
    await ctx.sendMessage(
      c,
      { text: "Seu pedido saiu para entrega." },
      { key: "pedido-1", notification: true, purpose: "order" },
    );
    const sent = await one(
      env,
      "SELECT payload FROM outbox WHERE dedupe=?",
      `module:forms:${c.id}:pedido-1`,
    );
    expect(json(sent.payload).consent_purpose).toBe("order");
  });
});
