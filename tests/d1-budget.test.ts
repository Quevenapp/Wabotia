// Consultas ao D1 por invocação nos fluxos principais, com todos os módulos
// ligados (docs/LIMITES.md). O plano gratuito do Cloudflare aceita 50
// consultas por invocação; o pago, 1000. Os tetos abaixo travam regressões:
// se um fluxo passar a consultar mais, o teste mostra a lista de instruções.
import {
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "../src/index";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedAll, cachedOne, exec, one, withReadCache } from "../src/db";
import { inbound, perform } from "../src/service";
import { processInbox } from "../src/engine";
import { now, uid } from "../src/types";
import { completeWebStep } from "../src/web-steps";
import { refreshFromProvider, verifyPaymentWebhook } from "../src/payments";
import { runModuleSchedules } from "../src/modules/schedule";
import { moduleStates } from "../src/modules/registry";
import { modulesApi } from "../src/modules/api";
import { overview as mesasOverview } from "../src/modules/mesas/tabs";
import { hmac, sha } from "../src/security";
import { mpManifest } from "../src/payments-mercadopago";
import {
  application,
  bearer,
  configure,
  fixture,
  type Fixture,
} from "./service-center-fixture";
import {
  MP_SECRET,
  paymentAccount,
  pedidoSetup,
  say,
  seedMenu,
  stubMercadoPago,
} from "./pedido-fixture";
import { countingEnv, measure, type D1Count } from "./d1-counter";

afterEach(() => vi.unstubAllGlobals());

const FREE_PLAN = 50;
const MODULES = [
  "queue",
  "forms",
  "payments",
  "agenda",
  "os",
  "reserva",
  "pedido",
  "mensalidade",
  "suporte",
  "mesas",
];
const MENUS = [
  { id: "cardapio", label: "Cardápio", type: "pedido_cardapio" },
  { id: "agendar", label: "Agendar", type: "agenda" },
  { id: "reservar", label: "Reservar", type: "reserva" },
  { id: "ordem", label: "Minha ordem", type: "os_track" },
  { id: "segunda", label: "Segunda via", type: "mensalidade_copy" },
  { id: "humano", label: "Atendente", type: "human" },
];

async function allOn() {
  const { f } = await pedidoSetup();
  for (const id of MODULES)
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id, enabled: true },
      uid(),
    );
  await configure(f, {
    menus: MENUS,
    pedido: { payments: { pix: true, cash: true, card: false } },
  });
  return f;
}

/** Instruções medidas e o teto de cada fluxo (veja docs/LIMITES.md). */
const CEILINGS: Record<string, number> = {
  "primeira mensagem: inbound": 20,
  "primeira mensagem: motor": 30,
  "escolha no menu (Cardápio): motor": 43,
  "palavra-chave atendente (Suporte segura): motor": 37,
  // Passa de 50: cria o pedido, o consentimento, três mensagens e a cobrança
  // Pix no Mercado Pago na mesma invocação (docs/LIMITES.md).
  "conclusão do carrinho (Pix)": 59,
  "webhook do Mercado Pago: Worker": 2,
  // 28: inclui a fila durável do gancho do módulo (revisão A3).
  "webhook do Mercado Pago: Coordinator": 30,
  "rodada periódica dos módulos": 24,
  // 17: o QR do cupom lê a configuração da área (QR ligado) e o endereço
  // público (link da imagem no texto).
  "fila: emitir senha (comando no Coordinator)": 17,
  "fila: chamar a próxima (comando no Coordinator)": 18,
  // Passa de 50: manutenção, rodada dos módulos e motor na mesma invocação;
  // aqui as duas entregas são canceladas (época antiga), o caminho barato.
  // 71: mais uma consulta por rodada para vencer pedidos de aprovação
  // (src/approvals.ts, feat/bot-acoes).
  "alarme com uma mensagem e entregas pendentes": 71,
  // 25: conta, cardápio, pedido no Pedido (contador, pedido, histórico,
  // evento), histórico da conta, evento e a conta relida com os totais.
  "mesas: lançar pedido (comando no Coordinator)": 27,
  // 7: mesas, contas abertas, totais do Pedido, pagamentos e os garçons.
  "mesas: mapa das mesas (leitura)": 8,
  "mesas: fechar a conta (comando no Coordinator)": 21,
};

describe("consultas ao D1 por invocação, com todos os módulos ligados", () => {
  it("fluxos principais dentro dos tetos medidos", async () => {
    const report: Record<string, D1Count> = {};
    const mp = stubMercadoPago();
    const f: Fixture = await allOn();
    const account = await paymentAccount(f);
    const menu = await seedMenu(f);
    const phone = "5511979990001";
    const msg = (text: string) => ({
      external_id: phone,
      phone,
      message_id: uid(),
      text,
    });
    const send = (text: string) =>
      measure(env, (e) =>
        inbound(e, f.profile, msg(text), `channel:${f.line}`, f.line),
      );
    const engine = async () =>
      (await measure(env, (e) => processInbox(e, f.profile))).count;

    // 1. Mensagem recebida: o webhook grava (inbound, no Coordinator) e o
    // motor responde no alarme (processInbox, uma mensagem por chamada).
    report["primeira mensagem: inbound"] = (await send("oi")).count;
    report["primeira mensagem: motor"] = await engine();
    await send("1");
    report["escolha no menu (Cardápio): motor"] = await engine();
    await send("quero falar com um atendente");
    report["palavra-chave atendente (Suporte segura): motor"] = await engine();

    // 2. Conclusão do carrinho (Coordinator /web-step).
    const customer = "5511979990002";
    const c2 = await say(f, "oi", customer);
    await say(f, "1", customer);
    const step = await one(
      env,
      "SELECT id FROM web_steps WHERE conversation_id=? AND status='sent' ORDER BY created DESC LIMIT 1",
      c2.id,
    );
    report["conclusão do carrinho (Pix)"] = (
      await measure(env, (e) =>
        completeWebStep(e, step.id, {
          [`q_${menu.suco.id}`]: ["3"],
          fulfillment: ["pickup"],
          name: ["Lia"],
          payment: ["pix"],
          confirm: ["1"],
        }),
      )
    ).count;

    // 3. Webhook do Mercado Pago: o Worker confere a assinatura e o
    // Coordinator consulta o provedor, muda o estado e avisa o Pedido.
    const order = await one(
      env,
      "SELECT p.provider_ref FROM pedido_orders o JOIN payments p ON p.id=o.payment_id WHERE o.conversation_id=?",
      c2.id,
    );
    mp.remote.get(order.provider_ref)!.status = "approved";
    const ts = String(Date.now()),
      requestId = uid();
    const v1 = await hmac(
      MP_SECRET,
      mpManifest(order.provider_ref, requestId, ts),
    );
    report["webhook do Mercado Pago: Worker"] = (
      await measure(env, (e) =>
        verifyPaymentWebhook(e, "mercadopago", account.id, {
          headers: new Headers({
            "x-signature": `ts=${ts},v1=${v1}`,
            "x-request-id": requestId,
          }),
          query: new URLSearchParams({
            "data.id": order.provider_ref,
            type: "payment",
          }),
          body: { type: "payment", data: { id: order.provider_ref } },
        }),
      )
    ).count;
    report["webhook do Mercado Pago: Coordinator"] = (
      await measure(env, (e) =>
        refreshFromProvider(e, account.id, order.provider_ref),
      )
    ).count;

    // 4. Rodada periódica dos módulos (no alarme, no máximo uma por minuto).
    report["rodada periódica dos módulos"] = (
      await measure(env, (e) => runModuleSchedules(e, f.profile, now()))
    ).count;

    // 5. Fila: emitir e chamar senha pelo Coordinator (/command), com o
    // recibo de idempotência e a auditoria.
    const run = (op: string, data: any, actor = f.admin) =>
      perform(env, actor, f.profile, op, data, uid());
    const queue = await run("queue.save", {
      name: "Geral",
      service_minutes: 10,
    });
    const counter = await run("counter.save", {
      name: "Guichê 1",
      queue_ids: [queue.id],
    });
    await run("counter.state", { id: counter.id, status: "open" }, f.member);
    const stub = env.COORDINATOR.get(env.COORDINATOR.idFromName(f.profile));
    const command = (operation: string, data: any, actor = f.admin) =>
      runInDurableObject(stub, async (instance: any) => {
        const original = instance.env;
        const { env: counted, count } = countingEnv(original);
        instance.env = counted;
        try {
          const response: Response = await instance.fetch(
            new Request("https://coordinator/command", {
              method: "POST",
              body: JSON.stringify({
                profile: f.profile,
                actor,
                operation,
                data,
                key: uid(),
                requestId: uid(),
              }),
            }),
          );
          expect(response.status).toBe(200);
        } finally {
          instance.env = original;
        }
        return count;
      });
    report["fila: emitir senha (comando no Coordinator)"] = await command(
      "queue.issue",
      { queue_id: queue.id, preferential: false },
    );
    report["fila: chamar a próxima (comando no Coordinator)"] = await command(
      "queue.call_next",
      { id: counter.id },
      f.member,
    );

    // 6. Mesas: lançar itens na conta (vira pedido do Pedido), o mapa das
    // mesas e o fechamento com o pagamento.
    // Garçom: papel mesas:waiter no acesso da pessoa (src/access.ts).
    await exec(
      env,
      "UPDATE users SET access=? WHERE id=?",
      JSON.stringify(["*", "mesas:waiter"]),
      f.member.id,
    );
    (f.member as any).access = ["*", "mesas:waiter"];
    const [mesa] = (await run("mesas.table.create", { name: "Mesa 1" })).data;
    const tab = await run("mesas.tab.open", { table_id: mesa.id }, f.member);
    report["mesas: lançar pedido (comando no Coordinator)"] = await command(
      "mesas.order.send",
      { id: tab.id, items: [{ item_id: menu.suco.id, quantity: 2 }] },
      f.member,
    );
    report["mesas: mapa das mesas (leitura)"] = (
      await measure(env, (e) =>
        mesasOverview(modulesApi(e, f.profile, "mesas"), now()),
      )
    ).count;
    report["mesas: fechar a conta (comando no Coordinator)"] = await command(
      "mesas.tab.close",
      { id: tab.id, payments: [{ method: "card", amount_cents: 1760 }] },
      f.member,
    );

    // Alarme inteiro: manutenção, rodada dos módulos, uma mensagem no motor,
    // entregas pendentes (até 10), webhooks e push, na mesma invocação.
    await send("2");
    report["alarme com uma mensagem e entregas pendentes"] =
      await runInDurableObject(stub, async (instance: any) => {
        const original = instance.env;
        const { env: counted, count } = countingEnv(original);
        instance.env = counted;
        try {
          await instance.alarm();
        } finally {
          instance.env = original;
        }
        return count;
      });

    console.info("FASE1-CUSTO-D1-fluxos", JSON.stringify(Object.fromEntries(
      Object.entries(report).map(([name, c]) => [name, { statements: c.statements, calls: c.calls }]),
    )));
    const over = Object.entries(report)
      .filter(([name, c]) => c.statements > (CEILINGS[name] ?? FREE_PLAN))
      .map(
        ([name, c]) =>
          `${name}: ${c.statements} instruções (teto ${CEILINGS[name]})\n  ${c.sql.join("\n  ")}`,
      );
    expect(over).toEqual([]);
    // Só o carrinho e o alarme cheio passam de 50 (docs/LIMITES.md).
    expect(
      Object.entries(report)
        .filter(([, c]) => c.statements > FREE_PLAN)
        .map(([name]) => name),
    ).toEqual([
      "conclusão do carrinho (Pix)",
      "alarme com uma mensagem e entregas pendentes",
    ]);
    // Antes do cache por invocação (src/db.ts) o motor fazia 51 a 63
    // consultas por mensagem e o carrinho, 94.
    expect(report["escolha no menu (Cardápio): motor"].statements).toBeLessThan(
      FREE_PLAN,
    );
  });
});

/**
 * Idas ao D1 antes da rota, por requisição autenticada (calls: um lote conta
 * uma). Cada ida é uma viagem da borda ao banco (150 a 470 ms medidos do
 * Brasil); antes eram 2 a 4 em série. Detalhes em tests/d1-request.test.ts.
 */
const REQUEST_CEILINGS: Record<string, number> = {
  "wabu_: GET /me": 1,
  "cookie: GET /me": 1,
  "chave de aplicação: GET /me": 1,
};

describe("idas ao D1 antes da rota (requisição autenticada)", () => {
  it("credencial, política e estado dos módulos numa ida só", async () => {
    const f = await fixture();
    const wabu = await bearer(f.member);
    await exec(
      env,
      "UPDATE sessions SET id=? WHERE hash=?",
      uid(),
      await sha(wabu),
    );
    const cookieToken = uid() + uid();
    await exec(
      env,
      "INSERT INTO sessions(hash,user_id,expires,kind,created,label,last_used,id) VALUES(?,?,?,'cookie',?,?,?,?)",
      await sha(cookieToken),
      f.member.id,
      now() + 3600000,
      now(),
      "teste",
      now(),
      uid(),
    );
    const app = await application(f, ["conversations:read"]);
    const call = async (headers: Record<string, string>) => {
      const { env: counted, count } = countingEnv(env);
      const ctx = createExecutionContext();
      await worker.fetch(
        new Request("https://test/api/v1/me", { headers }),
        counted as any,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return count;
    };
    // A primeira de pessoa no isolado grava o endereço público (uma vez).
    await call({ Authorization: "Bearer " + wabu });
    const report: Record<string, D1Count> = {
      "wabu_: GET /me": await call({ Authorization: "Bearer " + wabu }),
      "cookie: GET /me": await call({ Cookie: "wabotia=" + cookieToken }),
      "chave de aplicação: GET /me": await call({
        Authorization: "Bearer " + app.token,
      }),
    };
    const over = Object.entries(report)
      .filter(([name, c]) => c.calls > REQUEST_CEILINGS[name])
      .map(
        ([name, c]) =>
          `${name}: ${c.calls} idas (teto ${REQUEST_CEILINGS[name]})\n  ${c.sql.join("\n  ")}`,
      );
    expect(over).toEqual([]);
  });
});

describe("cache de leituras por invocação (src/db.ts)", () => {
  it("lembra no escopo, esvazia na escrita da tabela e não vaza entre escopos", async () => {
    const f = await fixture();
    const scoped = withReadCache(env);
    expect(withReadCache(scoped)).toBe(scoped);
    const { env: counted, count } = countingEnv(scoped);
    await moduleStates(counted, f.profile);
    await moduleStates(counted, f.profile);
    expect(count.statements).toBe(1);

    // Escrita na tabela lembrada, no mesmo escopo: a leitura seguinte vê.
    expect((await moduleStates(counted, f.profile)).agenda).toBe(false);
    await exec(
      counted,
      "INSERT INTO profile_modules(profile_id,module_id,enabled,updated,updated_by) VALUES(?,?,1,?,?)",
      f.profile,
      "agenda",
      now(),
      f.admin.id,
    );
    expect((await moduleStates(counted, f.profile)).agenda).toBe(true);
    expect(count.statements).toBe(3);

    // Escrita em outra tabela não esvazia.
    await exec(
      counted,
      "UPDATE conversations SET menu_active=0 WHERE profile_id=?",
      f.profile,
    );
    await moduleStates(counted, f.profile);
    expect(count.statements).toBe(4);

    // Sem escopo, ou em outro escopo, a leitura vai ao banco.
    const plain = countingEnv(env);
    await moduleStates(plain.env, f.profile);
    await moduleStates(plain.env, f.profile);
    expect(plain.count.statements).toBe(2);
    const other = countingEnv(withReadCache(env));
    await moduleStates(other.env, f.profile);
    expect(other.count.statements).toBe(1);
  });

  it("devolve cópias: quem altera a linha não altera o que está lembrado", async () => {
    const f = await fixture();
    const scoped = withReadCache(env);
    const sql = "SELECT id,name FROM profiles WHERE id=?";
    const row = await cachedOne(scoped, sql, f.profile);
    row.name = "alterado";
    expect((await cachedOne(scoped, sql, f.profile)).name).not.toBe("alterado");
    const rows = await cachedAll(scoped, sql, f.profile);
    rows[0].name = "alterado";
    expect((await cachedAll(scoped, sql, f.profile))[0].name).not.toBe(
      "alterado",
    );
  });
});

// Fase 1: evidência imprimível para o script de verificação. Não alterar o
// teto histórico sem guardar a execução antes/depois em FASE1-CUSTO-D1.md.
describe("custo da identidade no caminho de mensagens", () => {
  it("mede primeira entrada, canal adicional, repetição, pendência e manutenção", async () => {
    const { identityPort } = await import("../src/customer/ports");
    const { conversation } = await import("../src/service");
    const f = await fixture();
    const phone = "5511979990101";
    const payload = { external_id: phone, phone, text: "oi", message_id: uid() };
    const report: Record<string, D1Count> = {};
    const first = await measure(env, (e) => inbound(e, f.profile, payload, `channel:${f.line}`, f.line));
    report["identidade: primeiro número, legado incompleto"] = first.count;
    expect(first.count.statements).toBeLessThanOrEqual(CEILINGS["primeira mensagem: inbound"]);
    const original = identityPort.prepareInbound.bind(identityPort);
    let prepared: { statements: number; calls: number; writes: number } | undefined;
    const spy = vi.spyOn(identityPort, "prepareInbound").mockImplementation(async (e, c, evidence) => {
      const measured = await measure(e, (me) => original(me, c, evidence));
      prepared = { statements: measured.count.statements, calls: measured.count.calls, writes: measured.result.statements.length };
      return measured.result;
    });
    try {
      report["identidade: conversa resolvida, nova mensagem"] = (await measure(env, (e) => inbound(e, f.profile, { ...payload, message_id: uid() }, `channel:${f.line}`, f.line))).count;
      expect(prepared).toEqual({ statements: 0, calls: 0, writes: 0 });
    } finally { spy.mockRestore(); }
    report["identidade: webhook repetido"] = (await measure(env, (e) => inbound(e, f.profile, payload, `channel:${f.line}`, f.line))).count;
    expect(report["identidade: webhook repetido"]).toMatchObject({ statements: 1, calls: 1 });
    report["identidade: segundo canal"] = (await measure(env, (e) => inbound(e, f.profile, { ...payload, message_id: uid() }, `channel:${f.second}`, f.second))).count;
    report["identidade: LID pendente"] = (await measure(env, (e) => inbound(e, f.profile, { ...payload, external_id: "123456789012345@lid", phone: null, message_id: uid() }, `channel:${f.qr}`, f.qr))).count;
    report["identidade: aplicação excluída"] = (await measure(env, (e) => inbound(e, f.profile, { ...payload, message_id: uid() }, "app:cost", null))).count;
    const tick = await measure(env, (e) => identityPort.maintain(e, f.profile, { remainingStatements: 40, remainingItems: 20 }));
    report["identidade: manutenção dedicada"] = tick.count;
    expect(tick.result.statements).toBe(tick.count.statements);
    expect(tick.count.statements).toBeLessThanOrEqual(40);
    expect(tick.result.items).toBeLessThanOrEqual(20);
    for (let attempt = 0; attempt < 6; attempt++) {
      const progress = await one(env, "SELECT complete FROM customer_progress WHERE profile_id=? AND namespace='team' AND task='identity.contacts.v1'", f.profile);
      if (progress?.complete) break;
      await identityPort.maintain(env, f.profile, { remainingStatements: 40, remainingItems: 20 });
    }
    expect((await one(env, "SELECT complete FROM customer_progress WHERE profile_id=? AND namespace='team' AND task='identity.contacts.v1'", f.profile)).complete).toBe(1);
    report["identidade: primeiro número, preenchimento completo"] = (await measure(env, (e) => inbound(e, f.profile, { ...payload, external_id: "5511979990103", phone: "5511979990103", message_id: uid() }, `channel:${f.line}`, f.line))).count;
    expect(report["identidade: primeiro número, preenchimento completo"].statements).toBeLessThanOrEqual(CEILINGS["primeira mensagem: inbound"]);
    const duplicatePhone = "5511979990104";
    for (let i = 0; i < 2; i++) {
      const id = uid();
      await exec(env, `INSERT INTO contacts(id,profile_id,namespace,name,phone,search_text,source,created_by,updated_by,created,updated)
        VALUES(?,?,'team','',?,?,'manual','test','test',?,?)`, id, f.profile, duplicatePhone, duplicatePhone, now(), now());
      const index = await identityPort.indexContact(env, { profileId: f.profile, namespace: "team", contactId: id, phones: [duplicatePhone], origin: "local" });
      await env.DB.batch(index.map(([sql, args]) => env.DB.prepare(sql).bind(...args)));
    }
    const ambiguous = await measure(env, (e) => inbound(e, f.profile, { ...payload, external_id: duplicatePhone, phone: duplicatePhone, message_id: uid() }, `channel:${f.line}`, f.line));
    report["identidade: número ambíguo"] = ambiguous.count;
    expect((await conversation(env, ambiguous.result.conversation_id, f.profile)).customer_link_state).toBe("ambiguous");
    expect((await conversation(env, first.result.conversation_id, f.profile)).verified_phone).toBe(phone);
    // A linha da conexão é lida em todo inbound, inclusive sem cadastro.
    // A referência abaixo mede o mesmo fluxo com a porta simulada, sem SQL
    // de identidade. É comparação controlada, não execução da revisão antiga.
    const reference = vi.spyOn(identityPort, "prepareInbound").mockResolvedValue({ statements: [], state: "pending", verifiedPhone: null });
    try {
      report["referência controlada: porta simulada"] = (await measure(env, (e) => inbound(e, f.profile, { ...payload, external_id: "5511979990102", phone: "5511979990102", message_id: uid() }, `channel:${f.line}`, f.line))).count;
    } finally { reference.mockRestore(); }
    console.info("FASE1-CUSTO-D1", JSON.stringify(Object.fromEntries(Object.entries(report).map(([name, count]) => [name, { statements: count.statements, calls: count.calls, sql: count.sql }]))));
    for (const count of Object.values(report)) expect(count.statements).toBeLessThanOrEqual(FREE_PLAN);
  });
});
