// Revisão de segurança B2: o id do pagamento do corpo ficava fora do
// manifesto assinado e o ts assinado não tinha janela de tempo.
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { one } from "../src/db";
import { uid } from "../src/types";
import { hmac } from "../src/security";
import { mpManifest } from "../src/payments-mercadopago";
import { outbox } from "./service-center-fixture";
import {
  MENUS,
  MP_SECRET,
  codeIn,
  paymentAccount,
  pedidoSetup,
  say,
  seedMenu,
  stubMercadoPago,
  submitCart,
} from "./pedido-fixture";

afterEach(() => vi.unstubAllGlobals());

async function approvedPix() {
  const mp = stubMercadoPago();
  const { f } = await pedidoSetup({
    menus: MENUS,
    config: { payments: { pix: true, cash: false, card: false } },
  });
  const account = await paymentAccount(f);
  const menu = await seedMenu(f);
  await say(f, "oi", "5511973200001");
  const c = await say(f, "1", "5511973200001");
  const link = (await outbox(c.id)).find((m) => codeIn(String(m.text)))!;
  await submitCart(codeIn(link.text), {
    [`q_${menu.suco.id}`]: "1",
    fulfillment: "pickup",
    name: "Lia",
    confirm: "1",
  });
  const order = await one(
    env,
    "SELECT payment_id FROM pedido_orders WHERE conversation_id=?",
    c.id,
  );
  const payment = await one(
    env,
    "SELECT * FROM payments WHERE id=?",
    order.payment_id,
  );
  mp.remote.get(payment.provider_ref)!.status = "approved";
  return { account, payment };
}

async function send(
  accountId: string,
  opts: { query: string | null; body: string | null; ts: number },
) {
  const requestId = uid();
  const ts = String(opts.ts);
  const v1 = await hmac(MP_SECRET, mpManifest(opts.query, requestId, ts));
  const qs = opts.query
    ? `?data.id=${opts.query}&type=payment`
    : "?type=payment";
  return SELF.fetch(
    `https://test/webhooks/payments/mercadopago/${accountId}${qs}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": `ts=${ts},v1=${v1}`,
        "x-request-id": requestId,
      },
      body: JSON.stringify({
        type: "payment",
        ...(opts.body ? { data: { id: opts.body } } : {}),
      }),
    },
  );
}
const status = async (id: string) =>
  (await one(env, "SELECT status FROM payments WHERE id=?", id)).status;

describe("webhook do Mercado Pago endurecido (revisão B2)", () => {
  it("ts assinado fora da janela é recusado", async () => {
    const { account, payment } = await approvedPix();
    const old = await send(account.id, {
      query: payment.provider_ref,
      body: payment.provider_ref,
      ts: Date.now() - 60 * 60_000,
    });
    expect(old.status).toBe(401);
    expect(await status(payment.id)).toBe("created");
  });

  it("data.id do corpo diferente do assinado é recusado", async () => {
    const { account, payment } = await approvedPix();
    const forged = await send(account.id, {
      query: "123",
      body: payment.provider_ref,
      ts: Date.now(),
    });
    expect(forged.status).toBe(401);
    expect(await status(payment.id)).toBe("created");
  });

  it("sem data.id na consulta (fora do manifesto), o aviso é ignorado", async () => {
    const { account, payment } = await approvedPix();
    const unsigned = await send(account.id, {
      query: null,
      body: payment.provider_ref,
      ts: Date.now(),
    });
    expect(unsigned.status).toBe(200);
    expect(await unsigned.json()).toMatchObject({ ignored: true });
    expect(await status(payment.id)).toBe("created");
    // O aviso certo continua valendo.
    const ok = await send(account.id, {
      query: payment.provider_ref,
      body: payment.provider_ref,
      ts: Date.now(),
    });
    expect(ok.status).toBe(200);
    expect(await status(payment.id)).toBe("paid");
  });
});
