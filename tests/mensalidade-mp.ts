// Mercado Pago simulado e webhook assinado para os testes da Mensalidade (e
// dos módulos que dependem dela). Nenhuma chamada sai para a rede.
import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, vi } from "vitest";
import { exec, one } from "../src/db";
import { perform } from "../src/service";
import { now, uid } from "../src/types";
import { hmac } from "../src/security";
import { mpManifest } from "../src/payments-mercadopago";
import { quietCoordinator, type Fixture } from "./service-center-fixture";

export const MP_SECRET = "segredo-do-webhook-de-teste";
export const MP_TOKEN = "APP_USR-token-de-teste";

export type RemotePayment = { status: string; amount: number; ref: string };
export const mp = {
  remote: new Map<string, RemotePayment>(),
  nextId: 0,
  created: 0,
};
const accountProfiles = new Map<string, string>();

/** Liga o simulador em beforeEach/afterEach do arquivo de teste. */
export function useMercadoPago() {
  beforeEach(() => {
    accountProfiles.clear();
    mp.remote = new Map();
    mp.nextId = 600000 + Math.floor(Math.random() * 90000);
    mp.created = 0;
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      const reply = (data: any, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      if (url.origin !== "https://api.mercadopago.com") return reply({}, 404);
      const method = init.method || "GET";
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (method === "POST" && url.pathname === "/v1/payments") {
        const id = String(mp.nextId++);
        mp.created++;
        mp.remote.set(id, {
          status: "pending",
          amount: body.transaction_amount,
          ref: body.external_reference,
        });
        return reply(
          {
            id: Number(id),
            status: "pending",
            point_of_interaction: {
              transaction_data: {
                qr_code: `00020126PIX${id}`,
                ticket_url: `https://www.mercadopago.com.br/payments/${id}/ticket`,
              },
            },
          },
          201,
        );
      }
      if (method === "POST" && url.pathname === "/checkout/preferences") {
        mp.created++;
        return reply(
          {
            id: "pref-" + body.external_reference,
            init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-${body.external_reference}`,
          },
          201,
        );
      }
      const match = /^\/v1\/payments\/(\d+)$/.exec(url.pathname);
      if (match && method === "GET") {
        const r = mp.remote.get(match[1]);
        if (!r) return reply({ message: "not found" }, 404);
        return reply({
          id: Number(match[1]),
          status: r.status,
          transaction_amount: r.amount,
          currency_id: "BRL",
          external_reference: r.ref,
          date_approved:
            r.status === "approved" ? "2026-11-15T12:00:00.000-03:00" : null,
        });
      }
      if (method === "PUT") return reply({});
      return reply({ message: "unexpected" }, 400);
    });
  });
  afterEach(async () => {
    // O webhook agenda o alarme real. Estes testes conduzem o motor pelo
    // drain; encerre o trabalho pendente antes de retirar o mock de rede.
    try {
      for (const profile of new Set(accountProfiles.values()))
        await quietCoordinator(profile);
    } finally {
      vi.unstubAllGlobals();
    }
  });
}

/** Origem pública e conta do Mercado Pago na área. Devolve a conta. */
export async function configurePayments(f: Fixture) {
  await exec(
    env,
    "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin','https://atendimento.example.com',?)",
    now(),
  );
  const account = await perform(
    env,
    f.admin,
    f.profile,
    "payment.account.save",
    {
      provider: "mercadopago",
      access_token: MP_TOKEN,
      webhook_secret: MP_SECRET,
      payer_email: "financeiro@example.com",
    },
    uid(),
  );
  accountProfiles.set(account.id, f.profile);
  return account;
}

export async function webhook(
  accountId: string,
  dataId: string,
  requestId = uid(),
) {
  const profile = accountProfiles.get(accountId);
  if (profile) await quietCoordinator(profile);
  const ts = String(Date.now());
  const v1 = await hmac(MP_SECRET, mpManifest(dataId, requestId, ts));
  try {
    return await SELF.fetch(
      `https://test/webhooks/payments/mercadopago/${accountId}?data.id=${dataId}&type=payment`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-signature": `ts=${ts},v1=${v1}`,
          "x-request-id": requestId,
        },
        body: JSON.stringify({ type: "payment", data: { id: dataId } }),
      },
    );
  } finally {
    // A chamada HTTP, a assinatura, a consulta ao provedor e os ganchos são
    // exercitados. A fixture conduz as etapas sem um alarme concorrente.
    if (profile) await quietCoordinator(profile);
  }
}

/**
 * Aprova no provedor a cobrança do Vinki e manda o webhook. `repeat`
 * reenvia o mesmo aviso (o Mercado Pago repete até receber 200).
 */
export async function approve(
  accountId: string,
  paymentId: string,
  repeat = 1,
) {
  const row = await one(
    env,
    "SELECT provider_ref FROM payments WHERE id=?",
    paymentId,
  );
  mp.remote.get(row.provider_ref)!.status = "approved";
  for (let i = 0; i < repeat; i++) await webhook(accountId, row.provider_ref);
}

/** Muda o estado remoto (cancelled, refunded…) e manda o webhook. */
export async function remoteStatus(
  accountId: string,
  paymentId: string,
  status: string,
) {
  const row = await one(
    env,
    "SELECT provider_ref FROM payments WHERE id=?",
    paymentId,
  );
  mp.remote.get(row.provider_ref)!.status = status;
  await webhook(accountId, row.provider_ref);
}
