// Diferencial aleatório da transferência interna por comando
// (erp_finance_transfer_post, _command, _get e _list): contas com versão como
// CAS, valores, datas, notas e repetições, com um campo estragado por chamada
// (ERP-PORTE.md, ordem das recusas). Cada chamada portada roda nos dois
// motores; resposta ou erro e tabelas têm de bater.
//   node --test tests/erp/finance-transfer-diff.test.mjs (ERP_DIFF_N=600 para mais)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { isPorted } from "../../src/erp/engine/registry.ts";
import "../../src/erp/domains/index.ts";

let f;
const ready = isPorted("erp_finance_transfer_post");
before(async () => {
  if (ready) f = await dualFixture();
});
after(async () => f?.close());

test("erp_finance_transfer_*: mesmas respostas, erros e estado em sequência aleatória", { timeout: 900_000, skip: ready ? false : "não registrado" }, async () => {
  let seed = Number(process.env.ERP_DIFF_SEED || 20261053) >>> 0;
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
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  for (const [name, kind] of [["Caixa A", "cash"], ["Banco B", "bank"], ["Outra C", "other"]])
    await f.rpc("erp_finance_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "account_save", p_data: { expected_version: 0, name, kind } });
  const accounts = async () => (await f.db.query("select id,version,active from erp_finance.account where deleted_at is null order by created_at,id")).rows;
  const transfers = async () => (await f.db.query("select id,command_id,actor from erp_finance.transfer order by created_at,id")).rows;
  const posts = [];
  const outcomes = {};
  let accepted = 0,
    refused = 0;
  const N = Number(process.env.ERP_DIFF_N || 200);
  const call = async (name, args) => {
    try {
      const r = await f.rpc(name, args);
      accepted++;
      const k = r?.replayed ? "repetição" : name;
      outcomes[k] = (outcomes[k] || 0) + 1;
      return r;
    } catch (e) {
      if (e instanceof assert.AssertionError) {
        console.log(`divergência em ${name}: ${JSON.stringify(args)}`);
        throw e;
      }
      refused++;
      outcomes[e.message] = (outcomes[e.message] || 0) + 1;
      return null;
    }
  };
  for (let i = 0; i < N; i++) {
    const roll = rand(10);
    const user = rand(8) ? u.financeiro : pick([u.consulta, u.admin, u.vendas]);
    if (roll < 6) {
      if (rand(6) === 0 && posts.length) {
        const p = structuredClone(pick(posts));
        if (rand(3) === 0) p.p_user_id = u.admin;
        await call("erp_finance_transfer_post", p);
        continue;
      }
      const list = await accounts();
      const [a, b] = [pick(list), pick(list)];
      const data = {
        from_account_id: a.id, to_account_id: b.id, expected_from_version: a.version, expected_to_version: b.version,
        amount_cents: pick(["12345", "1", "999999999999999"]), posted_on: pick([today, today, "2026-01-02"]), note: pick(["Transferência interna", "Ajuste de caixa ✓"]), confirmed: true,
      };
      if (rand(5) === 0) {
        const [k, v] = pick([
          ["amount_cents", "01"], ["amount_cents", 5], ["amount_cents", "1000000000000000"], ["confirmed", false], ["note", "  x "], ["note", "  ​"],
          ["note", "ab"], ["note", "a\u0001b"], ["posted_on", "2099-01-01"], ["expected_from_version", 0], ["expected_to_version", a.version + 1], ["extra", 1],
        ]);
        data[k] = v;
      }
      if (rand(10) === 0) delete data.confirmed;
      const args = { p_user_id: user, p_command_id: randomUUID(), p_data: data };
      const r = await call("erp_finance_transfer_post", args);
      if (r) posts.push(args);
    } else if (roll === 6) {
      const list = await accounts();
      const a = pick(list);
      await call("erp_finance_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "account_save", p_data: { id: a.id, expected_version: a.version, name: `Conta ${i}`, kind: "cash", active: rand(4) !== 0 } });
    } else {
      const ts = await transfers();
      const t = ts.length ? pick(ts) : { id: randomUUID(), command_id: randomUUID(), actor: u.financeiro };
      const r2 = rand(3);
      if (r2 === 0) await call("erp_finance_transfer_get", { p_user_id: pick([u.consulta, u.vendas]), p_id: rand(5) ? t.id : randomUUID() });
      else if (r2 === 1) await call("erp_finance_transfer_command", { p_user_id: rand(4) ? t.actor : u.admin, p_command_id: t.command_id });
      else {
        const list = await accounts();
        await call("erp_finance_transfer_list", { p_user_id: u.consulta, p_account_id: pick([null, pick(list).id, randomUUID()]), p_limit: pick([1, 3, 25, 26]), p_after: null });
      }
    }
  }
  console.log(`erp_finance_transfer diferencial: ${N} passos, ${accepted} aceitos, ${refused} recusados; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  assert.ok(accepted > N / 4, "poucas chamadas aceitas");
  assert.ok(refused > N / 10, "poucas recusas exercitadas");
});
