// Lanchonete de exemplo para os testes do módulo Pedido.
import { env, SELF } from "cloudflare:test";
import { vi } from "vitest";
import { exec } from "../src/db";
import { conversation, perform } from "../src/service";
import { now, uid, type Actor } from "../src/types";
import { hmac } from "../src/security";
import { mpManifest } from "../src/payments-mercadopago";
import { modulesApi } from "../src/modules/api";
import {
  configure,
  drain,
  fixture,
  receive,
  type Fixture,
} from "./service-center-fixture";

export const ORIGIN = "https://lanchonete.example.com";

export const run = (f: Fixture, actor: Actor, op: string, data: any) =>
  perform(env, actor, f.profile, op, data, uid());

export async function pedidoSetup(
  options: { enabled?: boolean; menus?: any[]; config?: any } = {},
) {
  const f = await fixture();
  if (options.enabled !== false)
    await perform(
      env,
      f.admin,
      f.profile,
      "module.set",
      { id: "pedido", enabled: true },
      uid(),
    );
  await exec(
    env,
    "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin',?,?)",
    ORIGIN,
    now(),
  );
  await exec(
    env,
    "UPDATE connections SET config=? WHERE id IN (?,?)",
    JSON.stringify({ number: "5511900002222" }),
    f.line,
    f.qr,
  );
  if (options.menus || options.config)
    await configure(f, {
      ...(options.menus ? { menus: options.menus } : {}),
      ...(options.config ? { pedido: options.config } : {}),
    });
  return { f, ctx: modulesApi(env, f.profile, "pedido") };
}

/** Mídia da área como se tivesse vindo de POST /media (sem o R2). */
export async function media(
  f: Fixture,
  type = "image/jpeg",
  name = "foto.jpg",
) {
  const id = uid();
  await exec(
    env,
    "INSERT INTO media(id,profile_id,name,type,size,object_key,actor,created) VALUES(?,?,?,?,?,?,?,?)",
    id,
    f.profile,
    name,
    type,
    1234,
    `${f.profile}/${id}/x`,
    f.admin.id,
    now(),
  );
  return id;
}

/**
 * Cardápio: Lanches (X-Burger com ponto obrigatório e até 2 adicionais,
 * Misto quente esgotado) e Bebidas (Suco, até 5 por pedido, retailer_id).
 */
export async function seedMenu(f: Fixture) {
  const lanches = await run(f, f.admin, "pedido.category.save", {
    name: "Lanches",
  });
  const bebidas = await run(f, f.admin, "pedido.category.save", {
    name: "Bebidas",
  });
  const ponto = await run(f, f.admin, "pedido.group.save", {
    name: "Ponto da carne",
    min: 1,
    max: 1,
    options: [
      { id: "mal", name: "Mal passada" },
      { id: "bem", name: "Bem passada" },
    ],
  });
  const adicionais = await run(f, f.admin, "pedido.group.save", {
    name: "Adicionais",
    min: 0,
    max: 2,
    options: [
      { id: "bacon", name: "Bacon", price_cents: 500 },
      { id: "ovo", name: "Ovo", price_cents: 300 },
      { id: "cheddar", name: "Cheddar", price_cents: 400, available: false },
    ],
  });
  const xburger = await run(f, f.admin, "pedido.item.save", {
    category_id: lanches.id,
    name: "X-Burger",
    description: "Pão, carne 150 g e queijo",
    price_cents: 2500,
    image_url: "https://img.example.com/x.jpg",
    group_ids: [ponto.id, adicionais.id],
    retailer_id: "XB-01",
  });
  const misto = await run(f, f.admin, "pedido.item.save", {
    category_id: lanches.id,
    name: "Misto quente",
    price_cents: 1200,
    available: false,
  });
  const suco = await run(f, f.admin, "pedido.item.save", {
    category_id: bebidas.id,
    name: "Suco de laranja",
    price_cents: 800,
    max_quantity: 5,
    retailer_id: "SUCO-500",
  });
  return { lanches, bebidas, ponto, adicionais, xburger, misto, suco };
}
export type SeededMenu = Awaited<ReturnType<typeof seedMenu>>;

export async function say(
  f: Fixture,
  text: string,
  phone: string,
  line = f.line,
  content: any = {},
  extra: any = {},
) {
  const c = await receive(f, line, text, phone, content, extra);
  await drain(f);
  return conversation(env, c.id, f.profile);
}

export const codeIn = (text: string) =>
  /\/api\/w\/([A-Za-z0-9]{16})/.exec(text)?.[1] as string;

export const MENUS = [
  { id: "cardapio", label: "Cardápio", type: "pedido_cardapio" },
  { id: "acompanhar", label: "Acompanhar pedido", type: "pedido_acompanhar" },
  { id: "humano", label: "Falar com atendente", type: "human" },
];

// ---------------------------------------------------------------------------
// Mercado Pago simulado (como em tests/payments.test.ts): nada sai para a rede.

export const MP_TOKEN = "APP_USR-token-de-teste";
export const MP_SECRET = "segredo-do-webhook-de-teste";
export type Remote = { status: string; amount: number; ref: string };

export function stubMercadoPago() {
  const remote = new Map<string, Remote>();
  const calls: { method: string; path: string; body: any }[] = [];
  let nextId = 700000 + Math.floor(Math.random() * 90000);
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.origin !== "https://api.mercadopago.com")
      return new Response("{}", { status: 404 });
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    const reply = (data: any, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (method === "POST" && url.pathname === "/v1/payments") {
      const id = String(nextId++);
      remote.set(id, {
        status: "pending",
        amount: body.transaction_amount,
        ref: body.external_reference,
      });
      return reply(
        {
          id: Number(id),
          status: "pending",
          status_detail: "pending_waiting_transfer",
          point_of_interaction: {
            transaction_data: {
              qr_code: `00020126PIX${id}`,
              qr_code_base64: "iVBORw0KGgo=",
              ticket_url: `https://www.mercadopago.com.br/payments/${id}/ticket`,
            },
          },
        },
        201,
      );
    }
    if (method === "POST" && url.pathname === "/checkout/preferences")
      return reply(
        {
          id: "pref-" + body.external_reference,
          init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=pref-${body.external_reference}`,
        },
        201,
      );
    const match = /^\/v1\/payments\/(\d+)$/.exec(url.pathname);
    if (match && method === "GET") {
      const r = remote.get(match[1]);
      if (!r) return reply({ message: "not found" }, 404);
      return reply({
        id: Number(match[1]),
        status: r.status,
        status_detail: "",
        transaction_amount: r.amount,
        currency_id: "BRL",
        external_reference: r.ref,
        date_approved:
          r.status === "approved" ? "2026-11-15T19:00:00.000-03:00" : null,
      });
    }
    if (method === "PUT") return reply({});
    return reply({ message: "unexpected" }, 400);
  });
  return { remote, calls };
}

/** Conta do Mercado Pago na área (Cobrança ligada por padrão). */
export const paymentAccount = (f: Fixture) =>
  run(f, f.admin, "payment.account.save", {
    provider: "mercadopago",
    access_token: MP_TOKEN,
    webhook_secret: MP_SECRET,
    payer_email: "pagamentos@lanchonete.example.com",
  });

/** Webhook assinado do Mercado Pago para o pagamento `dataId`. */
export async function webhook(accountId: string, dataId: string) {
  const ts = String(Date.now());
  const requestId = uid();
  const v1 = await hmac(MP_SECRET, mpManifest(dataId, requestId, ts));
  return SELF.fetch(
    `https://test/webhooks/payments/mercadopago/${accountId}?data.id=${dataId}&type=payment`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": `ts=${ts},v1=${v1}`,
        "x-request-id": requestId,
      },
      body: JSON.stringify({
        action: "payment.updated",
        type: "payment",
        data: { id: dataId },
      }),
    },
  );
}

/** Envia o formulário da página do carrinho (campos repetidos em listas). */
export const submitCart = (
  code: string,
  fields: Record<string, string | string[]>,
) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields))
    for (const value of Array.isArray(v) ? v : [v]) body.append(k, value);
  return SELF.fetch(`https://test/api/w/${code}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://test",
    },
    body: body.toString(),
  });
};
