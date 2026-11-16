// Diferencial aleatório do bloco 1 do Financeiro (Contas e Categorias):
// erp_finance_category_execute (criar, alterar, ativar, excluir, mover com
// contas a pagar/receber, padrões, importar) e erp_finance_account_execute
// (alterar, ativar, padrões, excluir), mais as leituras (árvore, página,
// detalhe, formas de pagamento), com chamadas estragadas no meio. Cada chamada
// portada roda nos dois motores; resposta ou erro e tabelas têm de bater.
// Fora daqui até o harness ligar ids de linhas novas ausentes da resposta
// (pedido à N, sessao-O-pedido-harness-ids.md): o account_create e o saldo
// inicial no account_update, que gravam um movimento sem id na resposta.
//   node --test tests/erp/finance-accounts-categories-diff.test.mjs (ERP_DIFF_N=600 para mais)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "./harness/dual-fixture.mjs";

let f;
before(async () => {
  f = await dualFixture();
});
after(async () => f?.close());

test("erp_finance contas e categorias: mesmas respostas, erros e estado em sequência aleatória", { timeout: 900_000 }, async () => {
  let seed = Number(process.env.ERP_DIFF_SEED || 20261117) >>> 0;
  const next = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rand = (n) => Math.floor(next() * n);
  const pick = (a) => a[rand(a.length)];
  const u = f.users;
  const legacy = (action, data) => f.rpc("erp_finance_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: action, p_data: data });
  const contact = await f.catalog("contacts", { roles: ["customer", "supplier"], name: "Contato diferencial" });
  // Contas pelo escritor 010 (só no Postgres, espelhadas): sem saldo inicial.
  for (const [name, kind] of [["Banco diferencial", "bank"], ["Caixa diferencial", "cash"], ["Outra diferencial", "other"], ["Ação Ágil", "other"]])
    await legacy("account_save", { expected_version: 0, name, kind });
  const names = ["Vendas", "vendas", "Serviços", "Água e luz", "Ébano", "Zinco", "Ação", "Impostos", "Σίγμα", "Ωmega", "  Espaço  ", "Tab\tcontrole"];
  const dres = { receivable: ["none", "gross_revenue", "financial_revenue", "other_revenue"], payable: ["none", "operating_expenses", "income_taxes", "financial_expenses"] };
  const categories = async (kind) => (await f.db.query("select id,version,parent_id,active from erp_finance.category where kind=$1 and deleted_at is null order by created_at,id", [kind])).rows;
  const accounts = async () => (await f.db.query("select id,version,active,kind,default_movements,default_boleto from erp_finance.account where deleted_at is null order by created_at,id")).rows;
  const defaults = async () => (await f.db.query("select key,version from erp_finance.category_default order by key")).rows;
  const commands = [];
  const outcomes = {};
  let accepted = 0,
    refused = 0;
  const N = Number(process.env.ERP_DIFF_N || 200);
  const call = async (name, args) => {
    try {
      const r = await f.rpc(name, args);
      accepted++;
      const k = r?.replayed ? "repetição" : `${name}:ok`;
      outcomes[k] = (outcomes[k] || 0) + 1;
      return r;
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
      refused++;
      outcomes[e.message] = (outcomes[e.message] || 0) + 1;
      return null;
    }
  };
  for (let i = 0; i < N; i++) {
    const kind = pick(["receivable", "payable"]);
    const cats = await categories(kind);
    const roll = rand(20);
    // Leituras (também comparadas).
    if (roll === 0) {
      await call("erp_finance_category_tree", { p_user_id: pick([u.consulta, u.vendas, u.financeiro]), p_kind: pick([kind, kind, "both", null]) });
      continue;
    }
    if (roll === 1) {
      await call("erp_finance_account_page", {
        p_user_id: pick([u.consulta, u.estoque]), p_page: pick([1, 1, 2, 0]), p_limit: pick([2, 100, 101]),
        p_query: pick([null, "diferencial", "ação", "AÇÃO", "  ", "x".repeat(121)]), p_active: pick([null, true, false]),
        p_types: pick([null, ["checking"], ["other", "cash"], ["bank"], ["cash", "cash"]]),
      });
      continue;
    }
    if (roll === 2) {
      const acc = await accounts();
      await call("erp_finance_account_detail", { p_user_id: u.consulta, p_id: pick([...acc.map((a) => a.id), randomUUID()]) });
      continue;
    }
    if (roll === 3) {
      await call("erp_finance_payment_methods", { p_user_id: pick([u.consulta, u.fiscal]), p_kind: pick([kind, "x"]) });
      continue;
    }
    let action, data;
    if (roll < 8) {
      action = "category_create";
      const parent = cats.length && rand(2) ? pick(cats).id : null;
      data = { kind, name: pick(names) + (rand(3) ? ` ${rand(5)}` : "") };
      if (parent) data.parent_id = parent;
      if (rand(2)) data.dre_group = pick(dres[kind]);
    } else if (roll < 10 && cats.length) {
      const c = pick(cats);
      action = "category_update";
      data = { id: c.id, expected_version: c.version, name: pick(names) };
      if (rand(2)) data.dre_group = pick(dres[kind]);
    } else if (roll < 12 && cats.length) {
      const c = pick(cats);
      action = "category_set_active";
      data = { id: c.id, expected_version: c.version, active: rand(3) ? !c.active : c.active };
    } else if (roll === 12 && cats.length) {
      const c = pick(cats);
      action = "category_delete";
      data = { id: c.id, expected_version: c.version };
    } else if (roll === 13 && cats.length > 1) {
      // Contas a pagar/receber na categoria (escritor só no Postgres) e mover.
      const c = pick(cats);
      if (rand(2))
        await f.rpc("erp_finance_title_execute", {
          p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "title_create",
          p_data: { kind, contact_id: contact.id, description: "Título diferencial", issued_on: "2026-01-02", competence_on: "2026-01-02", total_cents: "1000", category_id: c.id, installments: [{ amount_cents: "1000", due_on: "2026-02-10" }] },
        }).catch(() => null);
      action = "category_move";
      data = { id: c.id, expected_version: c.version, target_id: pick(cats).id, confirmed: rand(6) !== 0 };
    } else if (roll === 14) {
      const d = pick(await defaults());
      const pool = await categories(pick(["receivable", "payable"]));
      action = "category_set_default";
      data = { key: d.key, expected_version: d.version, category_id: pool.length && rand(4) ? pick(pool).id : null };
    } else if (roll === 15) {
      action = "category_import";
      const rows = [{ name: pick(names) }, { name: `Filha ${rand(9)}`, parent: pick(names) }];
      if (rand(2)) rows.push({ name: pick(names), dre_group: pick(dres[kind]) });
      data = { kind, rows };
    } else {
      const acc = await accounts();
      if (!acc.length) {
        await legacy("account_save", { expected_version: 0, name: `Reposta ${i}`, kind: pick(["bank", "cash", "other"]) });
        continue;
      }
      const a = pick(acc);
      const sub = rand(4);
      if (sub === 0) {
        action = "account_set_active";
        data = { id: a.id, expected_version: a.version, active: !a.active };
      } else if (sub === 1) {
        action = "account_set_default";
        data = { id: a.id, expected_version: a.version, target: pick(["movements", "boleto"]), value: rand(3) !== 0 };
      } else if (sub === 2) {
        action = "account_delete";
        data = { id: a.id, expected_version: a.version };
      } else {
        action = "account_update";
        const type = pick(["checking", "savings", "cash", "other", "receiving"]);
        data = { id: a.id, expected_version: a.version, account_type: type, name: pick(["Banco atualizado", "Conta Ágil", "x".repeat(51)]), start_on: pick(["2026-01-01", "2026-03-01"]), default_movements: rand(2) === 0 };
        if (type !== "cash" && type !== "other") Object.assign(data, { institution_code: pick(["341", "34"]), institution_name: "Banco sintético" });
        if (type === "checking" || type === "savings") Object.assign(data, { agency: pick(["1234", "12/3"]), account_number: "56789", account_digit: "0" });
      }
    }
    if (!action) continue;
    const args = { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: action, p_data: data };
    let mutation = "nenhuma";
    if (rand(4) === 0) {
      mutation = pick(["acao", "campo_a_mais", "versao", "id", "usuario_consulta", "usuario_vendas", "repetir", "repetir_outro", "sem_dados", "dados_lista"]);
      switch (mutation) {
        case "acao": args.p_action = "category_bogus"; break;
        case "campo_a_mais": data.extra = 1; break;
        case "versao": if ("expected_version" in data) data.expected_version = pick([data.expected_version + 1, 0, "1", 2147483648]); break;
        case "id": if ("id" in data) data.id = pick([randomUUID(), "x", data.id.toUpperCase()]); break;
        case "usuario_consulta": args.p_user_id = u.consulta; break;
        case "usuario_vendas": args.p_user_id = u.vendas; break;
        case "repetir": if (commands.length) Object.assign(args, pick(commands)); break;
        case "repetir_outro": if (commands.length) Object.assign(args, { ...pick(commands), p_user_id: u.admin }); break;
        case "sem_dados": args.p_data = null; break;
        case "dados_lista": args.p_data = []; break;
      }
    }
    const name = args.p_action.startsWith("account") ? "erp_finance_account_execute" : "erp_finance_category_execute";
    const r = await call(name, args);
    if (r && !r.replayed) commands.push(structuredClone(args));
  }
  console.log(`erp_finance contas e categorias diferencial: ${N} passos, ${accepted} aceitos, ${refused} recusados; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  assert.ok(accepted > N / 3, "poucas chamadas aceitas");
  assert.ok(refused > N / 10, "poucas recusas exercitadas");
});
