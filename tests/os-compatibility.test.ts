import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { all, exec, one } from "../src/db";
import { json, now, uid } from "../src/types";
import { OS_STATUSES, STATUS_LABELS, MANUAL_TRANSITIONS, nextStatuses, orderValues, osSettings } from "../src/modules/os/model";
import { changeStatus, createOrder, decide, listOrders, loadOrder, moveOrder, orderHistory, orderView, publicOrderValues, quoteSpec, saveQuote, sendQuote, updateOrder } from "../src/modules/os/store";
import { resolveWorkType } from "../src/modules/os/public";
import { api, configure } from "./service-center-fixture";
import { motorFixture } from "./os-motor-fixture";

const input = () => ({ phone: "5511960010400", item: "Celular", problem: "Tela", source: "panel" as const, actor: "teste", sourceKey: uid(), notify: false });

describe("M: compatibilidade do tipo embutido", () => {
  it("linhas antigas nos nove estados conservam número, etapa efetiva e projeção antiga", async () => {
    const f = await motorFixture();
    for (const [i, status] of OS_STATUSES.entries()) {
      const id = uid();
      // Forma anterior a 0100: nenhum campo novo é enviado nem convertido.
      await exec(env, "INSERT INTO os_orders(id,profile_id,number,status,item,problem,source,created_by,created,updated) VALUES(?,?,?,?,?,?,'panel','teste',?,?)", id, f.profile, i + 1, status, "Item", "Problema", now(), now());
      const row = await loadOrder(f.ctx, id), view = orderView(row);
      expect(row).toMatchObject({ type_id: "service_order", stage: null, type_number: null, row_version: 1, type_snapshot_json: null, extra_json: "{}" });
      expect(view).toMatchObject({ number: i + 1, type_number: i + 1, display_number: String(i + 1), status, status_label: STATUS_LABELS[status], stage: status, stage_label: STATUS_LABELS[status], fields: [], extra: {}, next_statuses: [...MANUAL_TRANSITIONS[status], ...(status === "quoted" ? ["approved", "declined"] : [])] });
      expect(publicOrderValues(row)).toEqual(orderValues(row));
    }
    const page = await listOrders(f.ctx, { limit: "2" });
    expect(page.next_cursor).toBe("8");
    expect(page.counts).toEqual(Object.fromEntries(OS_STATUSES.map(s => [s, 1])));
    expect((await all(env, "SELECT stage,type_number FROM os_orders WHERE profile_id=?", f.profile)).every(r => r.stage === null && r.type_number === null)).toBe(true);
  });
  it("configuração parcial continua parcial e a definição virtual usa os valores atuais", async () => {
    const f = await motorFixture();
    const defaults = await resolveWorkType(f.ctx);
    expect(defaults.features.warranty_days).toBe(osSettings({}).warranty_days);
    await configure(f, { service_orders: { warranty_days: 12, texts: { ready: "" } } });
    expect(json((await one(env, "SELECT settings FROM profiles WHERE id=?", f.profile))!.settings).service_orders).toEqual({ warranty_days: 12, texts: { ready: "" } });
    const type = await resolveWorkType(f.ctx);
    expect(type.kind).toBe("builtin"); expect(type.features.warranty_days).toBe(12);
    expect(type.stages.find(s => s.id === "ready")!.message).toBe("");
    expect(type.transitions.filter(t => t.from === "received").map(t => t.to)).toEqual(MANUAL_TRANSITIONS.received);
  });
  it("preserva orçamento, botões, estados especiais, histórico e edição encerrada", async () => {
    const f = await motorFixture();
    const { order: opened } = await createOrder(f.ctx, input());
    expect(orderView(opened).next_statuses).toEqual(nextStatuses("received", false));
    const saved = await saveQuote(f.ctx, opened, { items: [{ description: "Tela", quantity: 1, unit_cents: 12345 }] }, f.member.id);
    const sent = await sendQuote(f.ctx, saved, f.member.id, { notify: false });
    expect(orderView(sent)).toMatchObject({ status: "quoted", quote: { version: 1, total_cents: 12345 }, next_statuses: nextStatuses("quoted", true) });
    const spec = quoteSpec(sent);
    expect(JSON.stringify(spec)).toContain(`os:${opened.id}:1:approve`);
    expect(JSON.stringify(spec)).not.toContain("os:stage:");
    const edited = await saveQuote(f.ctx, sent, { items: [{ description: "Tela nova", unit_cents: 23456 }] }, f.member.id);
    expect(edited.status).toBe("analyzing");
    const resent = await sendQuote(f.ctx, edited, f.member.id, { notify: false });
    const approved = await decide(f.ctx, resent, "approve", f.member.id, "panel");
    expect(orderView(approved).decision!.decision).toBe("approved");
    const working = await changeStatus(f.ctx, approved, "in_progress", f.member.id, "");
    const ready = await changeStatus(f.ctx, working, "ready", f.member.id, "");
    const delivered = await changeStatus(f.ctx, ready, "delivered", f.member.id, "");
    expect(delivered.warranty_until).toBeGreaterThan(delivered.delivered_at);
    expect((await orderHistory(f.ctx, opened.id)).map(h => h.kind)).toEqual(["opened", "quote", "quote", "quote", "quote", "status", "status", "status", "status"]);
    await expect(updateOrder(f.ctx, delivered, { item: "Mudou" }, f.member.id)).rejects.toMatchObject({ status: 400 });
    expect((await updateOrder(f.ctx, delivered, { notes: "Retirado" }, f.member.id)).notes).toBe("Retirado");
    const events = (await all(env, "SELECT kind,payload FROM events WHERE profile_id=? AND kind LIKE 'os.%'", f.profile)).map(e => ({ kind: e.kind, ...json(e.payload) }));
    expect(events.find(e => e.kind === "os.opened")).toMatchObject({ order_id: opened.id, number: 1, item: "Celular", phone: "5511960010400", source: "panel" });
    expect(events.some(e => e.kind === "os.stage_changed")).toBe(false);
  });
  it("contagem permanece esparsa e global com busca/paginação; detalhe legado conserva histórico", async () => {
    const f = await motorFixture();
    const a = await createOrder(f.ctx, input());
    const b = await createOrder(f.ctx, { ...input(), item: "Bicicleta" });
    await moveOrder(f.ctx, a.order, "cancelled", f.member.id);
    const list = await listOrders(f.ctx, { q: "Bicicleta", status: "received" });
    expect(list.counts).toEqual({ received: 1, cancelled: 1 });
    expect(list.data.map(o => o.id)).toEqual([b.order.id]);
    expect(list.next_cursor).toBeNull();
    const detail = await (await api(f.token, `/profiles/${f.profile}/service-orders/${b.order.id}`)).json<any>();
    expect(detail.history).toEqual([expect.objectContaining({ kind: "opened", to_status: "received" })]);
    expect(typeof detail.number).toBe("number");
    expect(typeof detail.item).toBe("string"); expect(typeof detail.problem).toBe("string");
  });
});
