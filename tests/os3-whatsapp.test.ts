// OS3: link do orçamento no WhatsApp (passo web): mostra itens, descontos,
// total e condições; o cliente aprova ou recusa com motivo. Linha simulada.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { perform } from "../src/service";
import { json, now, uid } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { createOrder, loadOrder, saveQuote, sendQuote, QUOTE_LINK_APPROVE, QUOTE_LINK_DECLINE } from "../src/modules/os/store";
import { configure, drain, fixture, outbox, receive, type Fixture } from "./service-center-fixture";
import { conversation } from "../src/service";

const ORIGIN = "https://atendimento.example.com";
async function setup() {
  const f = await fixture();
  await perform(env, f.admin, f.profile, "module.set", { id: "os", enabled: true }, uid());
  await exec(env, "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin',?,?)", ORIGIN, now());
  await exec(env, "UPDATE connections SET config=? WHERE id IN (?,?)", JSON.stringify({ number: "5511900001111" }), f.line, f.qr);
  await configure(f, { menus: [{ id: "humano", label: "Falar com atendente", type: "human" }] });
  return { f, ctx: modulesApi(env, f.profile, "os") };
}
async function quoted(f: Fixture, ctx: ReturnType<typeof modulesApi>, phone: string) {
  const received = await receive(f, f.line, "bom dia", phone);
  await drain(f);
  const c = await conversation(env, received.id, f.profile);
  const { order } = await createOrder(ctx, { conversation: c, item: "Bicicleta aro 29", problem: "Freio", source: "agent", sourceKey: uid(), actor: f.member.id });
  await saveQuote(ctx, order, {
    items: [{ description: "Cabo de freio", quantity: 2, unit_cents: 2500, discount_cents: 500 }, { description: "Regulagem", unit_cents: 4000 }],
    discount_cents: 500, terms: { method: "pix" },
  }, f.member.id);
  const sent = await sendQuote(ctx, await loadOrder(ctx, order.id), f.member.id);
  return { c, order: sent };
}
const code = (text: string) => /\/api\/w\/([A-Za-z0-9]{16})/.exec(text)?.[1] as string;
const submit = (value: string, body: Record<string, string>) => SELF.fetch(`https://test/api/w/${value}`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://test" }, body: new URLSearchParams(body).toString(),
});

describe("OS3 orçamento pelo link do WhatsApp", () => {
  it("link antes da lista; página com itens, descontos, total e condições; recusa com motivo", async () => {
    const { f, ctx } = await setup();
    const { c, order } = await quoted(f, ctx, "5511961000301");
    const steps = await all(env, "SELECT id,kind,ref_id FROM web_steps WHERE profile_id=? AND module_id='os'", f.profile);
    expect(steps).toEqual([expect.objectContaining({ kind: "quote", ref_id: `${order.id}:${order.quote_version}` })]);
    const messages = await outbox(c.id);
    const link = messages.findIndex(m => String(m.text).includes("/api/w/")), list = messages.findIndex(m => String(m.text).includes("Orçamento da ordem de serviço nº"));
    expect(link).toBeGreaterThanOrEqual(0);
    expect(link).toBeLessThan(list);
    const page = await (await SELF.fetch(`https://test/api/w/${code(messages[link].text)}`)).text();
    for (const text of ["Cabo de freio", "Descontos: R$ 10,00", "Total: R$ 80,00", "Pagamento: Pix", QUOTE_LINK_APPROVE, QUOTE_LINK_DECLINE])
      expect(page, text).toContain(text);
    const done = await submit(code(messages[link].text), { f_decision: QUOTE_LINK_DECLINE, f_reason: "Achei caro", f_name: "Carlos" });
    expect(done.status).toBe(200);
    const row = await one(env, "SELECT status,decided_via,decision_detail_json FROM os_orders WHERE id=?", order.id);
    expect(row).toMatchObject({ status: "declined", decided_via: "whatsapp" });
    expect(json(row.decision_detail_json)).toMatchObject({ by_name: "Carlos", channel: "whatsapp", reason: "Achei caro" });
  });

  it("aprovação pelo link vale só para a versão enviada", async () => {
    const { f, ctx } = await setup();
    const { c, order } = await quoted(f, ctx, "5511961000302");
    const first = code((await outbox(c.id)).find(m => String(m.text).includes("/api/w/"))!.text);
    // Orçamento alterado depois do envio: o link anterior deixa de valer.
    await saveQuote(ctx, await loadOrder(ctx, order.id), { items: [{ description: "Regulagem", unit_cents: 5000 }] }, f.member.id);
    const stale = await submit(first, { f_decision: QUOTE_LINK_APPROVE });
    expect(stale.status).not.toBe(200);
    expect((await loadOrder(ctx, order.id)).status).toBe("analyzing");
    const resent = await sendQuote(ctx, await loadOrder(ctx, order.id), f.member.id);
    const second = code((await outbox(c.id)).filter(m => String(m.text).includes("/api/w/")).at(-1)!.text);
    expect((await submit(second, { f_decision: QUOTE_LINK_APPROVE, f_name: "Ana" })).status).toBe(200);
    expect(await loadOrder(ctx, resent.id)).toMatchObject({ status: "approved", decided_via: "whatsapp" });
  });
});
