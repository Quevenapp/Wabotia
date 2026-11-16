// Diferencial aleatório dos anexos do Financeiro (erp_finance_file_*):
// reservar, tomar a posse, concluir (com o objeto presente ou não no
// armazenamento), parar ou abortar, excluir, listar e ler o objeto, em contas
// e lançamentos de caixa, com repetições e chamadas estragadas (um campo por
// chamada). Cada chamada portada roda nos dois motores; resposta ou erro e
// tabelas têm de bater.
//   node --test tests/erp/finance-file-diff.test.mjs (ERP_DIFF_N=600 para mais)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { isPorted } from "../../src/erp/engine/registry.ts";
import "../../src/erp/domains/index.ts";

let f;
const ready = isPorted("erp_finance_file_reserve");
before(async () => {
  if (ready) f = await dualFixture();
});
after(async () => f?.close());

test("erp_finance_file_*: mesmas respostas, erros e estado em sequência aleatória", { timeout: 900_000, skip: ready ? false : "não registrado" }, async () => {
  let seed = Number(process.env.ERP_DIFF_SEED || 20261211) >>> 0;
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
  const contact = (await f.catalog("contacts", { roles: ["customer", "supplier"], name: "Alfa Anexos" })).id;
  const title = (await f.rpc("erp_finance_title_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "title_create", p_data: { kind: "payable", contact_id: contact, description: "Conta com anexos", issued_on: "2026-03-01", competence_on: "2026-03-01", total_cents: "5000", installments: [{ amount_cents: "5000", due_on: "2026-03-10" }] } })).items[0];
  const caixa = (await f.rpc("erp_finance_account_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa anexos", start_on: "2020-01-01", opening_cents: "0" } })).record;
  const entry = (await f.rpc("erp_finance_cash_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "entry_save", p_data: { account_id: caixa.id, kind: "out", amount_cents: "1200", posted_on: "2026-03-02", competence_on: "2026-03-02", note: "Lançamento", expected_version: 0 } })).record;
  const owners = [["title", title.id], ["cash_entry", entry.id]];
  const kinds = [["application/pdf", "pdf"], ["text/plain", "txt"], ["image/png", "png"]];
  const files = async () => (await f.db.query("select id,owner_kind,owner_id,sha256,size_bytes,mime_type,status,lease_token,command_id from erp_finance.file order by created_at,id")).rows;
  const leases = new Map();
  const stored = new Set();
  const reserves = [];
  const outcomes = {};
  let accepted = 0,
    refused = 0;
  const N = Number(process.env.ERP_DIFF_N || 200);
  const call = async (name, args) => {
    try {
      const r = await f.rpc(name, args);
      accepted++;
      outcomes[name] = (outcomes[name] || 0) + 1;
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
    const list = await files();
    const user = rand(8) ? u.financeiro : pick([u.consulta, u.admin, u.vendas]);
    const roll = rand(10);
    if (roll < 3 || !list.length) {
      if (rand(6) === 0 && reserves.length) {
        await call("erp_finance_file_reserve", structuredClone(pick(reserves)));
        continue;
      }
      const [kind, owner] = pick(owners);
      const [mime, ext] = pick(kinds);
      const body = `conteúdo ${i}`;
      const args = {
        p_user_id: user, p_owner_kind: kind, p_owner_id: owner, p_command_id: randomUUID(), p_filename: `anexo-arquivo-${i}.${ext}`, p_mime_type: mime,
        p_size_bytes: body.length, p_sha256: createHash("sha256").update(body).digest("hex"),
      };
      if (rand(6) === 0) {
        const [k, v] = pick([["p_mime_type", "image/gif"], ["p_filename", "arquivo.pdf"], ["p_size_bytes", 0], ["p_sha256", "x"], ["p_owner_kind", "conta"], ["p_owner_id", randomUUID()]]);
        args[k] = v;
      }
      const r = await call("erp_finance_file_reserve", args);
      if (r) reserves.push(args);
      continue;
    }
    const file = pick(list);
    const base = { p_user_id: user, p_owner_kind: file.owner_kind, p_owner_id: file.owner_id, p_id: file.id };
    if (rand(10) === 0) base.p_owner_id = pick(owners)[1];
    if (roll < 5) {
      const lease = rand(5) ? (leases.get(file.id) ?? randomUUID()) : randomUUID();
      const r = await call("erp_finance_file_claim", { ...base, p_lease: rand(10) ? lease : null });
      if (r) leases.set(file.id, lease);
    } else if (roll < 7) {
      const key = `finance/${file.owner_id}/${file.id}/${file.sha256}`;
      if (rand(4) && !stored.has(key)) {
        stored.add(key);
        await f.putObject("erp-attachments", key, Number(file.size_bytes), rand(6) ? file.mime_type : "text/html");
      }
      await call("erp_finance_file_finish", { ...base, p_lease: leases.get(file.id) ?? randomUUID(), p_sha256: rand(8) ? file.sha256 : "0".repeat(64), p_size_bytes: Number(file.size_bytes) });
    } else if (roll === 7) {
      await call("erp_finance_file_stop", { ...base, p_abort: pick([true, false, null]), p_lease: leases.get(file.id) ?? null });
    } else if (roll === 8) {
      await call("erp_finance_file_delete", { ...base, p_command_id: rand(5) ? randomUUID() : file.command_id });
    } else {
      if (rand(2)) await call("erp_finance_file_list", { p_user_id: user, p_owner_kind: file.owner_kind, p_owner_id: file.owner_id });
      else await call("erp_finance_file_object", { ...base, p_write: pick([true, false]) });
    }
  }
  console.log(`erp_finance_file diferencial: ${N} passos, ${accepted} aceitos, ${refused} recusados; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  assert.ok(accepted > N / 4, "poucas chamadas aceitas");
  assert.ok(refused > N / 10, "poucas recusas exercitadas");
});
