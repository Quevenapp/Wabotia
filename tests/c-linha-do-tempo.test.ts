import { env as testEnv } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exec, withReadCache } from "../src/db";
import { ApiError, uid, type Actor, type Env } from "../src/types";
import { customerProvider, registerCustomerProvider } from "../src/customer/ports";
import type { ContactPage, CustomerModuleProvider, TimelinePage } from "../src/customer/profile-contracts";
import { customerRead } from "../src/customer/http";
import { timelinePath, timelineText } from "../web/contact-profile/model";

// Mesmo isolamento da suíte da ficha: portas reais, sem transporte ERP real.
vi.hoisted(() => vi.resetModules());
vi.mock("../src/modules/runtime", () => ({}));
vi.mock("../src/erp/api/local-fetch", () => ({ localFetch: vi.fn(() => {
  throw new Error("A linha do tempo não pode abrir o transporte ERP no teste.");
}) }));
vi.mock("../src/service", () => ({ conversation: vi.fn(), conversationByPhone: vi.fn(), enqueue: vi.fn(), handoff: vi.fn(),
  handoffToPerson: vi.fn(), message: vi.fn(), perform: vi.fn(), settings: vi.fn() }));

const env = testEnv as unknown as Env;
const erpList = vi.fn<NonNullable<CustomerModuleProvider["list"]>>();
const day = (iso: string) => Date.parse(iso);
const T = {
  sale: day("2026-01-05T12:00:00Z"),       // venda ERP com data "2026-01-05" (meio-dia UTC)
  opened: day("2026-01-10T10:00:00Z"),
  conversation: day("2026-01-11T10:00:00Z"),
  stage: day("2026-01-12T10:00:00Z"),
  appointment: day("2026-01-13T10:00:00Z"),
  delivered: day("2026-01-14T10:00:00Z"),
  order: day("2026-01-15T10:00:00Z"),       // empate proposital com a assinatura
  subscription: day("2026-01-15T10:00:00Z"),
  installmentPaid: day("2026-01-16T10:00:00Z"),
  charge: day("2026-01-17T10:00:00Z"),
  paid: day("2026-01-18T10:00:00Z"),
};
const sales: ContactPage = { incomplete: true, nextCursor: null, items: [
  { id: "sale-1", cells: { id: "77", status: "confirmed", total: "1234.50", occurredAt: "2026-01-05" }, target: { module: "erp", resource: "sales_orders", id: "sale-1" } },
] };

beforeAll(() => {
  expect(customerProvider("erp")).toBeNull();
  registerCustomerProvider("erp", { list: erpList });
});
beforeEach(() => { erpList.mockReset().mockResolvedValue(sales); });

const everything = ["contacts", "conversations", "os", "agenda", "pedido", "mensalidade", "payments", "erp:vendas"];
async function fixture(options: { enabled?: string[]; disabled?: string[]; access?: string[] } = {}) {
  const enabled = options.enabled ?? ["os", "agenda", "pedido", "mensalidade", "erp"];
  const profile = uid(), contactId = uid(), other = uid(), conversation = uid(), session = uid();
  const actor: Actor = { id: uid(), name: "Pessoa", kind: "user", role: "operator", profiles: [profile],
    scopes: [], bots: [], access: options.access ?? everything, sessionId: "session", rate: 100, runLimit: 1 };
  await exec(env, "INSERT INTO profiles(id,name,created) VALUES(?,'Linha do tempo',1)", profile);
  for (const id of [contactId, other]) await exec(env, `INSERT INTO contacts(id,profile_id,namespace,name,search_text,source,erp_contact_id,created_by,updated_by,created,updated)
    VALUES(?,?,'team','Ana','ana','manual',?,?,?,1,1)`, id, profile, id === contactId ? "erp-contact" : null, actor.id, actor.id);
  for (const module of enabled) await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,1,1,?)", profile, module, actor.id);
  for (const module of options.disabled ?? []) await exec(env, "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,0,1,?)", profile, module, actor.id);
  // Conversa vinculada: sessão do histórico e cobrança pertencem a ela.
  await exec(env, `INSERT INTO conversations(id,profile_id,connection_id,external_namespace,external_id,phone,session,last_customer,created,updated)
    VALUES(?,?,NULL,'channel:linha',?,'5511999990000',?,?,?,?)`, conversation, profile, uid(), session, T.conversation, T.conversation, T.conversation);
  await exec(env, "INSERT INTO conversation_contacts(conversation_id,profile_id,contact_id,linked_by,created) VALUES(?,?,?,'teste',?)", conversation, profile, contactId, T.conversation);
  await exec(env, `INSERT INTO customer_records(profile_id,module_id,kind,record_id,contact_id,conversation_id,linked_by,occurred_at)
    VALUES(?,'conversations','session',?,?,?,'teste',?)`, profile, `${conversation}:${session}`, contactId, conversation, T.conversation);
  // Ordem de serviço: abertura, mudança de etapa, uma edição sem mudança e a entrega.
  const order = uid();
  await exec(env, `INSERT INTO os_orders(id,profile_id,number,status,contact_id,item,problem,notes,source,created_by,created,updated)
    VALUES(?,?,12,'delivered',?,'Notebook','Relato privado','Nota interna','panel','a',?,?)`, order, profile, contactId, T.opened, T.delivered);
  await exec(env, "INSERT INTO os_history(id,profile_id,order_id,kind,from_status,to_status,actor,created) VALUES(?,?,?,'opened',NULL,'received','a',?)", uid(), profile, order, T.opened);
  await exec(env, "INSERT INTO os_history(id,profile_id,order_id,kind,from_status,to_status,actor,created) VALUES(?,?,?,'status','received','in_progress','a',?)", uid(), profile, order, T.stage);
  await exec(env, "INSERT INTO os_history(id,profile_id,order_id,kind,from_status,to_status,actor,created) VALUES(?,?,?,'edit','in_progress','in_progress','a',?)", uid(), profile, order, T.stage + 1);
  await exec(env, "INSERT INTO os_history(id,profile_id,order_id,kind,from_status,to_status,actor,created) VALUES(?,?,?,'status','in_progress','delivered','a',?)", uid(), profile, order, T.delivered);
  // Registros de outro contato nunca entram.
  await exec(env, `INSERT INTO os_orders(id,profile_id,number,status,contact_id,item,problem,source,created_by,created,updated)
    VALUES(?,?,13,'received',?,'Outro','Outro','panel','a',?,?)`, uid(), profile, other, T.opened + 5, T.opened + 5);
  await exec(env, `INSERT INTO agenda_appointments(id,profile_id,service_id,professional_id,starts,ends,status,contact_id,source,service_name,booked_at,created_by,created,updated)
    VALUES(?,?,'s','p',?,?,'confirmed',?,'panel','Corte',?,'a',?,?)`, uid(), profile, T.appointment + 86400000, T.appointment + 90000000, contactId, T.appointment, T.appointment, T.appointment);
  await exec(env, `INSERT INTO pedido_orders(id,profile_id,number,status,status_at,contact_id,source,lines,item_count,subtotal_cents,total_cents,fulfillment,payment_status,created_by,created,updated)
    VALUES(?,?,5,'delivered',?,?,'panel','[]',1,4590,4590,'pickup','paid','a',?,?)`, uid(), profile, T.order, contactId, T.order, T.order);
  const subscription = uid();
  await exec(env, `INSERT INTO mensalidade_subscriptions(id,profile_id,plan_id,contact_id,period,amount_cents,due_day,start_date,bill_from,created_by,created,updated)
    VALUES(?,?,'plan',?,'monthly',9900,10,'2026-01-15','2026-01','a',?,?)`, subscription, profile, contactId, T.subscription, T.subscription);
  await exec(env, `INSERT INTO mensalidade_installments(id,profile_id,subscription_id,period_key,due_date,amount_cents,status,paid_at,created,updated)
    VALUES(?,?,?,'2026-01','2026-01-10',9900,'paid',?,?,?)`, uid(), profile, subscription, T.installmentPaid, T.subscription, T.installmentPaid);
  await exec(env, `INSERT INTO mensalidade_installments(id,profile_id,subscription_id,period_key,due_date,amount_cents,status,created,updated)
    VALUES(?,?,?,'2026-02','2026-02-10',9900,'open',?,?)`, uid(), profile, subscription, T.subscription, T.subscription);
  await exec(env, `INSERT INTO payments(id,profile_id,conversation_id,account_id,provider,method,module_id,description,amount_cents,status,trigger,actor,expires_at,paid_at,created,updated)
    VALUES(?,?,?,'acc','mercadopago','pix','pedido','Descrição que não sai',4590,'paid','panel','a',?,?,?,?)`, uid(), profile, conversation, T.charge + 3600000, T.paid, T.charge, T.paid);
  return { env: withReadCache(env), profile, contactId, actor };
}
type F = Awaited<ReturnType<typeof fixture>>;
const read = (f: F, query: Record<string, string> = {}, actor = f.actor) =>
  customerRead(f.env, actor, f.profile, f.contactId, "timeline", query) as Promise<TimelinePage>;
const sources = (page: TimelinePage) => page.items.map(item => `${item.source}:${item.event}`);

describe("linha do tempo única da ficha", () => {
  it("junta as fontes em ordem de data, com rótulos de tela e sem dados internos", async () => {
    const f = await fixture();
    const page = await read(f);
    expect(sources(page)).toEqual([
      "payment:paid", "payment:charge", "mensalidade:installment_paid",
      // Empate de data: desempate estável pela chave (pedido > mensalidade).
      "pedido:order", "mensalidade:subscription",
      "os:delivered", "agenda:appointment", "os:stage", "conversation:conversation", "os:opened", "erp:sale",
    ]);
    expect(page.items.map(item => item.occurredAt)).toEqual([...page.items.map(item => item.occurredAt)].sort((a, b) => b - a));
    expect(page.unavailable).toEqual([]);
    expect(page.nextCursor).toBeNull();
    const titles = Object.fromEntries(page.items.map(item => [`${item.source}:${item.event}`, item]));
    expect(titles["os:opened"]).toMatchObject({ title: "Ordem de serviço 12 aberta", target: { module: "os", resource: "service-orders" } });
    expect(titles["os:stage"]).toMatchObject({ title: "Ordem de serviço 12: etapa Em execução", status: "in_progress" });
    expect(titles["os:delivered"]).toMatchObject({ title: "Ordem de serviço 12 entregue" });
    expect(titles["pedido:order"]).toMatchObject({ title: "Pedido nº 5", amount: "45.90", statusLabel: "Entregue" });
    expect(titles["mensalidade:installment_paid"]).toMatchObject({ title: "Mensalidade de 01/2026 paga", amount: "99.00" });
    expect(titles["erp:sale"]).toMatchObject({ title: "Venda nº 77", amount: "1234.50", dateOnly: true, occurredAt: T.sale });
    expect(titles["agenda:appointment"].scheduledAt).toBe(T.appointment + 86400000);
    expect(JSON.stringify(page)).not.toMatch(/Relato privado|Nota interna|Notebook|Descrição que não sai|Corte/);
    expect(erpList).toHaveBeenCalledTimes(1);
    expect(erpList).toHaveBeenCalledWith(expect.objectContaining({ profile: f.profile }), f.actor, f.contactId, "sales", { limit: 100 });
    // Texto da tela: data, o que houve, situação e valor.
    expect(timelineText(titles["pedido:order"])).toMatch(/Pedido nº 5 · Entregue · R\$\s?45,90$/);
    expect(timelineText(titles["erp:sale"])).toBe("05/01/2026 · Venda nº 77 · Confirmada · R$ 1.234,50");
  });

  it("fonte com módulo desligado não aparece e não é consultada", async () => {
    const f = await fixture({ enabled: ["os", "pedido"], disabled: ["payments"] });
    const page = await read(f);
    expect(new Set(page.items.map(item => item.source))).toEqual(new Set(["os", "pedido", "conversation"]));
    expect(erpList).not.toHaveBeenCalled();
    expect(page.unavailable).toEqual([]);
  });

  it("sem permissão a fonte não aparece, mesmo com o módulo ligado", async () => {
    const f = await fixture();
    const page = await read(f, {}, { ...f.actor, access: ["contacts", "conversations", "agenda"] });
    expect(new Set(page.items.map(item => item.source))).toEqual(new Set(["agenda", "conversation"]));
    expect(erpList).not.toHaveBeenCalled();
    // Papel ERP sem pedidos de venda (financeiro) não lê vendas pela linha do tempo.
    const finance = await read(f, {}, { ...f.actor, access: ["contacts", "erp:financeiro"] });
    expect(finance.items.some(item => item.source === "erp")).toBe(false);
    expect(erpList).not.toHaveBeenCalled();
    // Sem cadastro não há linha do tempo; bots e credenciais também não.
    await expect(read(f, {}, { ...f.actor, access: ["agenda"] })).rejects.toMatchObject({ status: 403 });
    await expect(read(f, {}, { ...f.actor, credential: "x" } as Actor)).rejects.toMatchObject({ status: 403 });
  });

  it("pagina por data e chave sem repetir nem pular itens, inclusive nos empates", async () => {
    const f = await fixture();
    const all = (await read(f, { limit: "50" })).items.map(item => item.key);
    const seen: string[] = [];
    let query: Record<string, string> = { limit: "3" }, pages = 0;
    for (;;) {
      const page = await read(f, query);
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map(item => item.key));
      pages++;
      if (!page.nextCursor) break;
      expect(timelinePath("/base", page.nextCursor, 3)).toBe(`/base/timeline?limit=3&before=${page.nextCursor.before}&key=${encodeURIComponent(page.nextCursor.key)}`);
      query = { limit: "3", before: String(page.nextCursor.before), key: page.nextCursor.key };
    }
    expect(pages).toBe(4);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(all);
    // Só a data: tudo antes daquele instante.
    const older = await read(f, { before: String(T.order) });
    expect(older.items.every(item => item.occurredAt < T.order)).toBe(true);
    expect(sources(older)[0]).toBe("os:delivered");
    for (const bad of [{ limit: "0" }, { limit: "51" }, { before: "abc" }, { before: String(Date.now() + 86400000) }, { key: "sem prefixo" }])
      await expect(read(f, bad)).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  });

  it("falha do ERP vira aviso discreto e não derruba as outras fontes", async () => {
    const f = await fixture();
    erpList.mockRejectedValueOnce(new ApiError(503, "dependency_unavailable", "ERP temporariamente indisponível."));
    const page = await read(f);
    expect(page.items.some(item => item.source === "erp")).toBe(false);
    expect(page.items.length).toBe(10);
    expect(page.unavailable).toEqual([{ source: "erp", message: "Vendas e notas do ERP não puderam ser carregadas agora. Tente de novo em instantes." }]);
    erpList.mockRejectedValueOnce(new Error("timeout"));
    expect((await read(f)).unavailable.map(item => item.source)).toEqual(["erp"]);
    // Recusa do próprio ERP (carteira de outro vendedor) só esconde a fonte.
    erpList.mockRejectedValueOnce(new ApiError(403, "forbidden", "Seu acesso não permite esta operação no ERP."));
    const hidden = await read(f);
    expect(hidden.unavailable).toEqual([]);
    expect(hidden.items.length).toBe(10);
  });
});
