// Diferencial aleatório da Importação de registros financeiros
// (erp_finance_import_execute e erp_finance_import_preview): contas a receber,
// a pagar e registros de caixa, com contato por CPF/CNPJ ou nome, categoria e
// conta pelo nome, linhas repetidas e linhas estragadas (no máximo um campo
// por linha; ERP-PORTE.md, ordem das recusas). Cada chamada portada roda nos
// dois motores; resposta ou erro e tabelas têm de bater.
//   node --test tests/erp/finance-import-diff.test.mjs (ERP_DIFF_N=600 para mais)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "./harness/dual-fixture.mjs";
import { isPorted } from "../../src/erp/engine/registry.ts";
import "../../src/erp/domains/index.ts";

let f;
const ready = isPorted("erp_finance_import_execute");
before(async () => {
  if (ready) f = await dualFixture();
});
after(async () => f?.close());

test("erp_finance_import_execute: mesmas respostas, erros e estado em sequência aleatória", { timeout: 900_000, skip: ready ? false : "não registrado" }, async () => {
  let seed = Number(process.env.ERP_DIFF_SEED || 20261139) >>> 0;
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
  const contact = (data) => f.catalog("contacts", { roles: ["customer", "supplier"], ...data });
  await contact({ name: "Alfa Importação", document: "12.345.678/0001-90" });
  await contact({ name: "Beta Importação" });
  await contact({ name: "beta importação" });
  await contact({ name: "Ícaro Ágil" });
  await f.rpc("erp_finance_account_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "account_create", p_data: { account_type: "cash", name: "Caixa Importação", start_on: "2026-01-01", opening_cents: "0" } });
  for (const [kind, name] of [["receivable", "Mensalidades"], ["payable", "Aluguel"], ["payable", "Mensalidades"]])
    await f.rpc("erp_finance_category_execute", { p_user_id: u.financeiro, p_command_id: randomUUID(), p_action: "category_create", p_data: { kind, name } });
  const commands = [];
  const outcomes = {};
  let accepted = 0,
    refused = 0;
  const N = Number(process.env.ERP_DIFF_N || 200);
  const call = async (name, args) => {
    try {
      const r = await f.rpc(name, args);
      accepted++;
      const k = r?.replayed ? "repetição" : `${name}:${r.created ?? r.rows?.map((x) => x.status).join("/")}`;
      outcomes[k.slice(0, 60)] = (outcomes[k.slice(0, 60)] || 0) + 1;
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
  const row = (kind, line) => {
    const r = { line, issued_on: pick(["2026-07-01", "2026-07-02"]), amount_cents: pick(["5000", "7000", "1"]), description: pick(["Venda importada", "Outra venda", "  Com espaços  "]) };
    if (kind !== "cash") r.due_on = pick(["2026-07-31", "2026-08-15"]);
    else { r.side = pick(["in", "out"]); r.account = pick(["caixa importação", "CAIXA IMPORTAÇÃO"]); }
    const who = rand(4);
    if (who === 0) r.contact_document = pick(["12345678000190", "12.345.678/0001-90"]);
    else if (who === 1) r.contact_name = pick(["alfa importação", "ícaro ágil", "Beta Importação"]);
    if (rand(3) === 0) r.category = pick(["mensalidades", "ALUGUEL"]);
    if (rand(4) === 0) r.competence_on = pick(["2026-07-01", null]);
    if (rand(4) === 0) r.document = pick(["NF 12", " "]);
    if (rand(6) === 0) {
      const [key, value] = pick([
        ["issued_on", "2026-02-30"], ["due_on", "2026-06-30"], ["competence_on", "x"], ["amount_cents", "0"], ["side", "both"], ["description", ""],
        ["description", "x".repeat(241)], ["contact_name", "Ninguém"], ["contact_document", "999"], ["category", "Inexistente"], ["account", "Outra"],
        ["document", "d".repeat(201)], ["line", "1.5"], ["extra", 1],
      ]);
      r[key] = value;
    }
    return r;
  };
  for (let i = 0; i < N; i++) {
    const kind = pick(["receivable", "payable", "cash"]);
    const rows = Array.from({ length: 1 + rand(3) }, (_, k) => row(kind, k + 2));
    if (rand(4) === 0 && rows.length) rows.push(structuredClone(rows[0]));
    const data = { kind, file_name: pick(["contas.csv", "outra.csv"]), rows };
    if (rand(10) === 0) {
      const [key, value] = pick([["kind", "x"], ["file_name", ""], ["rows", []], ["extra", 1]]);
      data[key] = value;
    }
    const name = rand(3) ? "erp_finance_import_execute" : "erp_finance_import_preview";
    const args = name === "erp_finance_import_execute" ? { p_user_id: u.financeiro, p_command_id: randomUUID(), p_data: data } : { p_user_id: u.financeiro, p_data: data };
    if (rand(8) === 0) args.p_user_id = u.consulta;
    if (name === "erp_finance_import_execute" && rand(8) === 0 && commands.length) Object.assign(args, structuredClone(pick(commands)));
    const r = await call(name, args);
    if (r && !r.replayed && name === "erp_finance_import_execute") commands.push(structuredClone(args));
  }
  console.log(`erp_finance_import diferencial: ${N} passos, ${accepted} aceitos, ${refused} recusados; ${JSON.stringify(outcomes)}; ${JSON.stringify(f.stats)}`);
  assert.ok(accepted > N / 4, "poucas chamadas aceitas");
  assert.ok(refused > N / 10, "poucas recusas exercitadas");
});
