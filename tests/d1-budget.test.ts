// Consultas ao D1 por invocação nos fluxos principais, com todos os módulos
// ligados (docs/LIMITES.md). O plano gratuito do Cloudflare aceita 50
// consultas por invocação; o pago, 1000. Os tetos abaixo travam regressões:
// se um fluxo passar a consultar mais, o teste mostra a lista de instruções.
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedAll, cachedOne, exec, one, withReadCache } from "../src/db";
import { inbound, perform } from "../src/service";
import { processInbox } from "../src/engine";
import { now, uid } from "../src/types";
import { completeWebStep } from "../src/web-steps";
import { refreshFromProvider, verifyPaymentWebhook } from "../src/payments";
import { runModuleSchedules } from "../src/modules/schedule";
import { moduleStates } from "../src/modules/registry";
import { hmac } from "../src/security";
import { mpManifest } from "../src/payments-mercadopago";
import { configure, fixture, type Fixture } from "./service-center-fixture";
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
