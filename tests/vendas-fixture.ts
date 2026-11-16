// Loja de exemplo para os testes de Vendas e Caixa.
import { env } from "cloudflare:test";
import { exec } from "../src/db";
import { perform } from "../src/service";
import { now, uid, type Actor } from "../src/types";
import { modulesApi } from "../src/modules/api";
import { fixture, type Fixture } from "./service-center-fixture";

export const ORIGIN = "https://loja.example.com";

export const run = (f: Fixture, actor: Actor, op: string, data: any, key = uid()) =>
  perform(env, actor, f.profile, op, data, key);

/** Erro de uma chamada: {status, code, message}. */
export async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error: any) {
    return { status: error.status, code: error.code, message: String(error.message) };
  }
  throw new Error("esperava erro");
}

export async function vendasSetup(
  options: { vendas?: boolean; caixa?: boolean; config?: any } = {},
) {
  const f = await fixture();
  if (options.vendas !== false)
    await run(f, f.admin, "module.set", { id: "vendas", enabled: true });
  if (options.caixa)
    await run(f, f.admin, "module.set", { id: "caixa", enabled: true });
  await exec(
    env,
    "INSERT OR REPLACE INTO instance_settings(key,value,updated) VALUES('public_origin',?,?)",
    ORIGIN,
    now(),
  );
  await exec(
    env,
    "UPDATE connections SET config=? WHERE id IN (?,?)",
    JSON.stringify({ number: "5511900003333" }),
    f.line,
    f.qr,
  );
  if (options.config)
    await run(f, f.admin, "settings", { vendas: options.config });
  return { f, ctx: modulesApi(env, f.profile, "vendas") };
}

/**
 * Catálogo: Bebidas (Refrigerante 350 ml, 10 em estoque, EAN; Água, sem
 * controle de estoque) e Mercearia (Café 500 g, 2 em estoque, mínimo 1;
 * Queijo por kg, fracionado, 3,5 kg).
 */
export async function seedCatalog(f: Fixture) {
  const bebidas = await run(f, f.admin, "vendas.category.save", { name: "Bebidas" });
  const mercearia = await run(f, f.admin, "vendas.category.save", { name: "Mercearia" });
  const refri = await run(f, f.admin, "vendas.product.save", {
    category_id: bebidas.id,
    name: "Refrigerante 350 ml",
    price_cents: 600,
    ean: "7894900011517",
    sku: "REF-350",
    stock: 10,
    fiscal: { ncm: "22021000", cest: "0300700", cfop: "5405", origin: 0, icms_csosn: "500" },
  });
  const agua = await run(f, f.admin, "vendas.product.save", {
    category_id: bebidas.id,
    name: "Água 500 ml",
    price_cents: 300,
    track_stock: false,
  });
  const cafe = await run(f, f.admin, "vendas.product.save", {
    category_id: mercearia.id,
    name: "Café 500 g",
    price_cents: 1890,
    stock: 2,
    min_stock: 1,
    fiscal: { ncm: "09012100" },
  });
  const queijo = await run(f, f.admin, "vendas.product.save", {
    category_id: mercearia.id,
    name: "Queijo minas",
    price_cents: 4500,
    unit: "KG",
    fractional: true,
    stock: 3.5,
    fiscal: { ncm: "04069090" },
  });
  return { bebidas, mercearia, refri, agua, cafe, queijo };
}

export const cash = (amount: number) => [{ method: "cash", amount_cents: amount }];
