import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { one } from "../src/db";
import { now } from "../src/types";
import { expireDue } from "../src/modules/vendas/quotes";
import { drain, outbox, receive } from "./service-center-fixture";
import { cash, failure, run, seedCatalog, vendasSetup } from "./vendas-fixture";

const codeIn = (text: string) =>
  /\/api\/w\/([A-Za-z0-9]{16})/.exec(text)?.[1] as string;

async function chat(f: any, phone: string, line = f.line) {
  const c = await receive(f, line, "oi", phone);
  await drain(f);
  return c;
}

describe("vendas: orçamento", () => {
  it("monta, envia com botões, o cliente aprova e a equipe converte em venda", async () => {
    const { f } = await vendasSetup();
    const p = await seedCatalog(f);
    const c = await chat(f, "5511962000001");
    const quote = await run(f, f.member, "vendas.quote.save", {
      conversation_id: c.id,
      lines: [
        { product_id: p.refri.id, quantity: 4 },
        { name: "Entrega", quantity: 1, unit_cents: 1000 },
      ],
      discount_cents: 300,
      note: "Entrega amanhã de manhã.",
    });
    expect(quote).toMatchObject({
      number: 1,
      status: "draft",
      subtotal_cents: 3400,
      discount_cents: 300,
      total_cents: 3100,
      customer: { phone: "5511962000001" },
    });
    // Rascunho não vira venda pela equipe.
    expect(
      await failure(run(f, f.member, "vendas.quote.convert", { id: quote.id, payments: cash(3100) })),
    ).toMatchObject({ code: "quote_not_approved" });
    const sent = await run(f, f.member, "vendas.quote.send", { id: quote.id });
    expect(sent).toMatchObject({ status: "sent", version: 1, sent_via: "buttons" });
    expect(sent.valid_until).toBeGreaterThan(now() + 6 * 86_400_000);
    const out = await outbox(c.id);
    const text = out.map((m) => m.text).join("\n");
    expect(text).toContain("Orçamento nº 1");
    expect(text).toContain("Refrigerante 350 ml");
    expect(text).toContain("R$ 31,00");
    const buttons = out.find((m) => m.content?.interactive || m.content?.type === "interactive");
    expect(JSON.stringify(buttons)).toContain(`vendas:q:${quote.id}:1:approve`);

    await receive(f, f.line, "Aprovar", "5511962000001", {
      interactive_reply_id: `vendas:q:${quote.id}:1:approve`,
    });
    await drain(f);
    const approved = await one(env, "SELECT * FROM vendas_quotes WHERE id=?", quote.id);
    expect(approved).toMatchObject({
      status: "approved",
      decided_by: `customer:${c.id}`,
      decided_via: "whatsapp",
    });
    expect((await outbox(c.id)).at(-1).text).toContain("aprovado");
    // Toque repetido: avisa, não muda.
    await receive(f, f.line, "Aprovar", "5511962000001", {
      interactive_reply_id: `vendas:q:${quote.id}:1:approve`,
    });
    await drain(f);
    expect((await outbox(c.id)).at(-1).text).toContain("já foi respondido");

    const converted = await run(f, f.member, "vendas.quote.convert", {
      id: quote.id,
      payments: [{ method: "pix_manual", amount_cents: 3100 }],
    });
    expect(converted.quote.status).toBe("converted");
    expect(converted.sale).toMatchObject({
      source: "quote",
      quote_id: quote.id,
      total_cents: 3100,
      status: "completed",
    });
    const again = await run(f, f.member, "vendas.quote.convert", { id: quote.id });
    expect(again.sale.id).toBe(converted.sale.id);
    expect(
      (await one(env, "SELECT stock_milli FROM vendas_products WHERE id=?", p.refri.id))!.stock_milli,
    ).toBe(6000);
  });

  it("QR: 1/2 responde; versão antiga não vale; link do passo web e validade", async () => {
    const { f, ctx } = await vendasSetup();
    const p = await seedCatalog(f);
    const c = await chat(f, "5511962000002", f.qr);
    const quote = await run(f, f.admin, "vendas.quote.save", {
      conversation_id: c.id,
      lines: [{ product_id: p.cafe.id, quantity: 2 }],
      valid_days: 2,
    });
    await run(f, f.admin, "vendas.quote.send", { id: quote.id });
    // Editar volta para rascunho; reenviar sobe a versão.
    await run(f, f.admin, "vendas.quote.save", { id: quote.id, note: "Preço especial" });
    const v2 = await run(f, f.admin, "vendas.quote.send", { id: quote.id });
    expect(v2.version).toBe(2);
    await receive(f, f.qr, "x", "5511962000002", {
      interactive_reply_id: `vendas:q:${quote.id}:1:decline`,
    });
    await drain(f);
    expect((await outbox(c.id)).at(-1).text).toContain("foi atualizado");
    await receive(f, f.qr, "2", "5511962000002");
    await drain(f);
    expect(await one(env, "SELECT status FROM vendas_quotes WHERE id=?", quote.id)).toEqual({
      status: "declined",
    });

    // Link: escolha na página.
    const linked = await run(f, f.admin, "vendas.quote.save", {
      conversation_id: c.id,
      lines: [{ product_id: p.refri.id, quantity: 1 }],
    });
    const sent = await run(f, f.admin, "vendas.quote.send", { id: linked.id, via: "link" });
    expect(sent.web_step).toBeTruthy();
    const code = codeIn((await outbox(c.id)).map((m) => m.text).join("\n"));
    expect(code).toBeTruthy();
    expect(await (await SELF.fetch(`https://test/api/w/${code}`)).text()).toContain(
      "Orçamento nº 2",
    );
    const done = await SELF.fetch(`https://test/api/w/${code}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://test" },
      body: new URLSearchParams({
        f_decision: "Aprovar orçamento",
        f_note: "Pode separar",
      }).toString(),
    });
    expect(done.status).toBe(200);
    expect(await one(env, "SELECT status,decided_via,decision_note FROM vendas_quotes WHERE id=?", linked.id)).toEqual({
      status: "approved",
      decided_via: "link",
      decision_note: "Pode separar",
    });

    // Validade: a rodada periódica marca os vencidos; resposta depois recusa.
    const late = await run(f, f.admin, "vendas.quote.save", {
      conversation_id: c.id,
      lines: [{ product_id: p.refri.id, quantity: 1 }],
      valid_days: 1,
    });
    const lateSent = await run(f, f.admin, "vendas.quote.send", { id: late.id });
    expect(await expireDue(ctx, lateSent.valid_until + 1)).toBe(1);
    expect(
      await failure(run(f, f.admin, "vendas.quote.decide", { id: late.id, decision: "approve" })),
    ).toMatchObject({ code: "quote_not_pending" });
    expect(await one(env, "SELECT status FROM vendas_quotes WHERE id=?", late.id)).toEqual({
      status: "expired",
    });
  });

  it("sem conversa só registra o envio; módulo desligado não responde aos botões", async () => {
    const { f } = await vendasSetup();
    const p = await seedCatalog(f);
    const quote = await run(f, f.admin, "vendas.quote.save", {
      customer_name: "Balcão",
      lines: [{ product_id: p.agua.id, quantity: 3 }],
    });
    expect(
      await failure(run(f, f.admin, "vendas.quote.send", { id: quote.id })),
    ).toMatchObject({ code: "no_conversation" });
    expect(await run(f, f.admin, "vendas.quote.send", { id: quote.id, notify: false })).toMatchObject({
      status: "sent",
      sent_via: "manual",
    });
    const off = await run(f, f.admin, "module.set", { id: "vendas", enabled: false });
    expect(off.enabled).toBe(false);
    const c = await chat(f, "5511962000003");
    await receive(f, f.line, "Aprovar", "5511962000003", {
      interactive_reply_id: `vendas:q:${quote.id}:1:approve`,
    });
    await drain(f);
    expect(await one(env, "SELECT status FROM vendas_quotes WHERE id=?", quote.id)).toEqual({
      status: "sent",
    });
    expect(c).toBeTruthy();
  });
});
