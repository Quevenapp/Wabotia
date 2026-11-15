// Lanchonete de exemplo para os testes do módulo Pedido.
import { env, SELF } from "cloudflare:test";
import { exec } from "../src/db";
import { conversation, perform } from "../src/service";
import { now, uid, type Actor } from "../src/types";
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
