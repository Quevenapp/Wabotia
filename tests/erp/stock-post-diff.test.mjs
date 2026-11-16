// Diferencial aleatório do erp_stock_post: chamadas válidas (três de cada
// quatro) e chamadas com um campo estragado (tipo, sinal, versão, duplicata,
// data, textos, campo a mais, usuário sem acesso, repetição do comando),
// mais a política de saldo negativo trocando no meio. Cada chamada roda nos
// dois motores; a resposta ou o erro e o estado das tabelas têm de bater.
//   node --test tests/erp/stock-post-diff.test.mjs   (ERP_DIFF_N=600 para mais)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "./harness/dual-fixture.mjs";

let f;
before(async () => {
  f = await dualFixture();
});
after(async () => f?.close());

test("erp_stock_post: mesmas respostas, erros e estado em sequência aleatória", { timeout: 900_000 }, async () => {
  // mulberry32: determinístico, sem a periodicidade dos bits baixos do LCG.
  let seed = Number(process.env.ERP_DIFF_SEED || 20261116) >>> 0;
  const next = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rand = (n) => Math.floor(next() * n);
  const pick = (a) => a[rand(a.length)];
  const products = [];
  for (const name of ["Parafuso", "Porca"]) products.push((await f.catalog("products", { name: `${name} diferencial`, unit: "UN", kind: "P" })).id);
  const service = (await f.catalog("products", { name: "Serviço diferencial", unit: "UN", kind: "S" })).id;
  const warehouses = [];
  for (const name of ["A", "B", "C"]) warehouses.push((await f.catalog("warehouses", { name: `Depósito ${name} diferencial` })).id);
  const version = async (p, w) =>
    Number(await f.scalar("select coalesce((select version from erp_stock.balance where product_id=$1 and warehouse_id=$2),0) value", [p, w]));
  const commands = [];
  const outcomes = {};
  let accepted = 0,
    refused = 0;
  const N = Number(process.env.ERP_DIFF_N || 200);
  for (let i = 0; i < N; i++) {
    if (rand(30) === 0) {
      const policy = await f.rpc("erp_stock_policy_get", { p_user_id: f.users.admin });
      const current = policy.policy ?? policy;
      await f.rpc("erp_stock_policy_set", {
        p_user_id: f.users.admin,
        p_command_id: randomUUID(),
        p_expected_version: current.version,
        p_allow_negative: !current.allow_negative,
        p_reason: "Troca de política no diferencial",
        p_confirmed: true,
      });
    }
    // Chamada válida.
    const kind = pick(["receipt", "issue", "adjustment", "transfer"]);
    const p = pick(products);
    let items;
    if (kind === "transfer") {
      const [a, b] = rand(2) ? [warehouses[0], warehouses[1]] : [warehouses[2], warehouses[0]];
      const q = pick(["1", "2", "0.5", "0.000001"]);
      items = [
        { product_id: p, warehouse_id: a, quantity: "-" + q, expected_version: await version(p, a) },
        { product_id: p, warehouse_id: b, quantity: q, expected_version: await version(p, b) },
      ];
    } else {
      items = [];
      for (const w of warehouses.slice(0, 1 + rand(3))) {
        let q = pick(["1", "2.5", "0.000001", "10", "3"]);
        if (kind === "issue" || (kind === "adjustment" && rand(2))) q = "-" + q;
        items.push({ product_id: p, warehouse_id: w, quantity: q, expected_version: await version(p, w) });
      }
    }
    const args = {
      p_user_id: f.users.estoque,
      p_command_id: randomUUID(),
      p_kind: kind,
      p_occurred_on: "2026-10-15",
      p_reason: "Lançamento diferencial",
      p_items: items,
      p_reference: rand(2) ? null : "NF 123",
    };
    // Um campo estragado em uma de cada quatro.
    let mutation = "nenhuma";
    if (rand(4) === 0) {
      mutation = pick([
        "tipo", "estorno", "sinal", "versao", "duplicata", "data_futura", "data_invalida", "motivo_curto",
        "motivo_controle", "referencia_longa", "campo_a_mais", "sem_itens", "servico", "produto_inexistente",
        "usuario_consulta", "usuario_inativo", "repetir_comando", "repetir_outro_ator", "quantidade_zero",
        "quantidade_formato", "versao_texto", "maiusculas",
      ]);
      const line = args.p_items[0];
      switch (mutation) {
        case "tipo": args.p_kind = "bogus"; break;
        case "estorno": args.p_kind = "reversal"; break;
        case "sinal": line.quantity = line.quantity.startsWith("-") ? line.quantity.slice(1) : "-" + line.quantity; break;
        case "versao": line.expected_version += 1; break;
        case "duplicata": args.p_items.push({ ...line }); break;
        case "data_futura": args.p_occurred_on = "2099-01-01"; break;
        case "data_invalida": args.p_occurred_on = "2026-02-30"; break;
        case "motivo_curto": args.p_reason = "  ab  "; break;
        case "motivo_controle": args.p_reason = "Com\ncontrole"; break;
        case "referencia_longa": args.p_reference = "r".repeat(101); break;
        case "campo_a_mais": line.extra = true; break;
        case "sem_itens": args.p_items = []; break;
        case "servico": line.product_id = service; break;
        case "produto_inexistente": line.product_id = randomUUID(); break;
        case "usuario_consulta": args.p_user_id = f.users.consulta; break;
        case "usuario_inativo": args.p_user_id = f.users.inactive; break;
        case "repetir_comando": if (commands.length) Object.assign(args, pick(commands)); break;
        case "repetir_outro_ator": if (commands.length) Object.assign(args, { ...pick(commands), p_user_id: f.users.admin }); break;
        case "quantidade_zero": line.quantity = "0"; break;
        case "quantidade_formato": line.quantity = pick(["1.0000001", "01", "1e3", "abc"]); break;
        case "versao_texto": line.expected_version = "0"; break;
        case "maiusculas": line.product_id = line.product_id.toUpperCase(); break;
      }
    }
    try {
      const r = await f.rpc("erp_stock_post", args);
      accepted++;
      if (!r.replayed) commands.push(structuredClone(args));
      outcomes[r.replayed ? "repetição" : "aceito"] = (outcomes[r.replayed ? "repetição" : "aceito"] || 0) + 1;
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      refused++;
      outcomes[e.message] = (outcomes[e.message] || 0) + 1;
    }
  }
  console.log(`erp_stock_post diferencial: ${N} chamadas, ${accepted} aceitas, ${refused} recusadas; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  assert.ok(accepted > N / 3, "poucos lançamentos aceitos");
  assert.ok(refused > N / 10, "poucas recusas exercitadas");
});
