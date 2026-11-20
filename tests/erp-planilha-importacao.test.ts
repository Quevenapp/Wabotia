import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exec } from "../src/db";
import { erpStub } from "../src/erp/hub";
import { storageDriver } from "../src/erp/engine/driver";
import { callRpc } from "../src/erp/engine/registry";
import "../src/erp/domains/index";
import { internalCall } from "../src/internal-api";
import { actorForUser } from "../src/security";
import { bearer, fixture } from "./service-center-fixture";
import { enableErpParts, setModule } from "./erp-module-helper";
import { SCREEN_TEMPLATES, autoMapping, readSpreadsheet, spreadsheetImportPlan, batchPath, parseImportBatchResult, parseJob, parseJobs, type ImportKind, type ImportItem } from "../web/erp/app/lib/spreadsheet-import";

async function setup() {
  const f = await fixture();
  await enableErpParts(f.profile, f.admin.id);
  const token = await bearer(f.admin), base = `https://test/api/v1/profiles/${f.profile}/erp`;
  const send = async (path: string, body?: unknown, chosen = token) => {
    const response = await SELF.fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${chosen}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json<any>();
    return { response, data };
  };
  expect((await send("/v1/me")).response.status).toBe(200);
  return { f, base, send, token };
}

async function seed(f: Awaited<ReturnType<typeof fixture>>) {
  await runInDurableObject(erpStub(env, f.profile), (_instance: unknown, state: DurableObjectState) => {
    const db = storageDriver(state.storage);
    const invoke = (name: string, args: Record<string, unknown>) => callRpc(db, name, { p_user_id: f.admin.id, p_command_id: crypto.randomUUID(), ...args });
    for (const [code, lot_control] of [["ITEM", false], ["KIT", false], ["LOTE", true]] as const)
      invoke("erp_catalog_product_save", { p_id: null, p_expected_version: 0, p_data: { code, name: `Produto ${code}`, kind: "P", format: "S", unit: "UN", price: "10", lot_control }, p_acknowledged: null });
    invoke("erp_catalog_save", { p_entity: "contacts", p_id: null, p_expected_version: 0, p_data: { name: "Fornecedor Planilha", roles: ["supplier", "customer"] } });
    invoke("erp_catalog_save", { p_entity: "warehouses", p_id: null, p_expected_version: 0, p_data: { name: "Depósito Planilha" } });
    invoke("erp_catalog_custom_field_save", { p_id: null, p_expected_version: 0, p_data: { name: "Campo planilha", field_type: "text" } });
  });
}

async function sheet(kind: ImportKind, values: Record<string, string>[]) {
  const template = SCREEN_TEMPLATES[kind];
  const model = await readSpreadsheet("modelo.csv", new TextEncoder().encode(template.model("csv") as string));
  const cells = [model[0], ...values.map(value => model[0].map(label => value[template.columns.find(column => column.label === label)?.key ?? ""] ?? ""))];
  const parsed = template.parse(cells, autoMapping(template, cells[0]), { types: [] });
  expect(parsed.missing, kind).toEqual([]);
  expect(parsed.items.flatMap(item => item.problems), kind).toEqual([]);
  return parsed.items;
}

const entries: [ImportKind, Record<string, string>][] = [
  ["products", { code: "NOVO", name: "Produto da planilha", price: "3,50" }],
  ["contacts", { name: "Contato da planilha" }],
  ["product_suppliers", { code: "ITEM", supplier_name: "Fornecedor Planilha", purchase_price: "2,50" }],
  ["compositions", { code: "KIT", stock_type: "Virtual", item_code: "ITEM", item_quantity: "2" }],
  ["custom_fields", { code: "ITEM", item_field: "Campo planilha", item_value: "Preenchido" }],
  ["lots", { code: "LOTE", lot: "LOTE-1", manufactured_on: "01/01/2026", expires_on: "01/01/2027" }],
  ["purchase_orders", { number: "C-1", date: "10/10/2026", contact_name: "Fornecedor Planilha", item_code: "ITEM", item_quantity: "2" }],
  ["sales_orders", { number: "V-1", date: "10/10/2026", contact_name: "Fornecedor Planilha", item_code: "ITEM", item_quantity: "2" }],
  ["stock_movements", { code: "ITEM", warehouse: "Depósito Planilha", movement: "Entrada", quantity: "5", date: "10/10/2026" }],
  ["receivables", { contact_name: "Fornecedor Planilha", description: "Conta a receber", issued_on: "10/10/2026", due_on: "10/11/2026", amount: "25,50" }],
  ["payables", { contact_name: "Fornecedor Planilha", description: "Conta a pagar", issued_on: "10/10/2026", due_on: "10/11/2026", amount: "25,50" }],
];

describe("planilhas pela rota real do Worker", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-19T12:00:00Z")); });
  afterEach(() => vi.useRealTimers());
  it("cada família: modelo, prévia, confirmação, resultado e reenvio do mesmo arquivo", { timeout: 240_000 }, async () => {
    const { f, send, base } = await setup(); await seed(f);
    const counts = () => runInDurableObject(erpStub(env, f.profile), (_i: unknown, state: DurableObjectState) => Object.fromEntries(
      ["erp_catalog__record", "erp_stock__movement", "erp_finance__title", "erp_finance__settlement", "erp_documents__document"].map(table => [table, Number(state.storage.sql.exec(`SELECT count(*) n FROM ${table}`).one().n)]),
    ));
    for (const [kind, values] of entries) {
      const items = await sheet(kind, [values]), file_name = `${kind}.csv`;
      const payload = (rows: ImportItem[]) => rows.map(({ row, lines, data }) => ({ row, lines, data }));
      const before = await counts();
      const previewInput = { command_id: null, job_id: null, file_name, total_rows: items.length, dry_run: true, items: payload(items) };
      const preview = await send(batchPath(kind), previewInput);
      expect(preview.response.status, `${kind}: ${JSON.stringify(preview.data)}`).toBe(200);
      expect(parseImportBatchResult(preview.data, { ...previewInput, kind }).items[0].status).toBe("valid");
      expect(await counts(), `${kind}: a prévia não escreve`).toEqual(before);
      expect(preview.response.headers.get("Server-Timing")).toContain('hops=1');
      const plan = await spreadsheetImportPlan(base, f.admin.id, kind, file_name, items, items);
      const input = { ...previewInput, command_id: plan.batches[0].id, job_id: plan.id, dry_run: false };
      const confirmed = await send(batchPath(kind), input);
      expect(confirmed.response.status, `${kind}: ${JSON.stringify(confirmed.data)}`).toBe(200);
      const result = parseImportBatchResult(confirmed.data, { ...input, kind });
      expect(result.items[0].status, kind).toBe(kind === "custom_fields" ? "updated" : "created");
      expect(result.job?.status).toBe("concluida");
      const after = await counts();
      expect(after.erp_stock__movement - before.erp_stock__movement, kind).toBe(kind === "stock_movements" ? 1 : 0);
      expect(after.erp_finance__title - before.erp_finance__title, kind).toBe(["receivables", "payables"].includes(kind) ? 1 : 0);
      expect(after.erp_finance__settlement, kind).toBe(before.erp_finance__settlement);
      const again = await spreadsheetImportPlan(base, f.admin.id, kind, file_name, items, items);
      const replay = await send(batchPath(kind), { ...input, command_id: again.batches[0].id, job_id: again.id });
      expect(replay.response.status, `${kind}: ${JSON.stringify(replay.data)}`).toBe(200);
      expect(replay.data).toEqual({ ...confirmed.data, replayed: true });
      expect(await counts(), kind).toEqual(after);
      const detail = await send(`/v1/importacoes/${plan.id}?limit=100&offset=0`);
      expect(detail.response.status).toBe(200);
      expect(parseJob(detail.data, { id: plan.id, errors: false, limit: 100, offset: 0 }).items).toEqual(result.items);
    }
    const jobs = await send("/v1/importacoes?limit=25&offset=0");
    expect(parseJobs(jobs.data, { status: null, limit: 25, offset: 0 }).total).toBe(entries.length);
  });

  it("linha inválida no meio preserva resultado por linha e permite consultar só erros", { timeout: 120_000 }, async () => {
    const { send } = await setup();
    const input = { command_id: crypto.randomUUID(), job_id: crypto.randomUUID(), file_name: "misto.csv", total_rows: 3, dry_run: false,
      items: [{ row: 2, lines: [2], data: { name: "Primeiro" } }, { row: 3, lines: [3], data: { code: "SEM-NOME" } }, { row: 4, lines: [4], data: { name: "Último" } }] };
    const confirmed = await send(batchPath("products"), input);
    expect(confirmed.response.status, JSON.stringify(confirmed.data)).toBe(200);
    expect(confirmed.data.items.map((item: any) => item.status)).toEqual(["created", "invalid", "created"]);
    expect(confirmed.data.items[1]).toMatchObject({ row: 3, reason: "erp_catalog_name_required" });
    const errors = await send(`/v1/importacoes/${input.job_id}?erros=1&limit=100&offset=0`);
    expect(parseJob(errors.data, { id: input.job_id, errors: true, limit: 100, offset: 0 }).items).toEqual([confirmed.data.items[1]]);
  });

  it("papel insuficiente e parte desligada são recusados antes de importar", { timeout: 180_000 }, async () => {
    const { f, send } = await setup();
    await exec(env, "UPDATE users SET access=? WHERE id=?", JSON.stringify(["erp:consulta"]), f.member.id);
    const input = { command_id: null, job_id: null, file_name: "produtos.csv", total_rows: 1, dry_run: true, items: [{ row: 2, lines: [2], data: { name: "Produto" } }] };
    const denied = await send(batchPath("products"), input, await bearer(f.member));
    expect(denied.response.status).toBe(403);
    expect(denied.data.error.code).toBe("ERP_ACCESS_DENIED");
    for (const [kind, module] of [["products", "erp-produtos"], ["product_suppliers", "erp-produtos"], ["custom_fields", "erp-produtos"], ["compositions", "erp-estoque"], ["lots", "erp-produtos"], ["lots", "erp-estoque"], ["purchase_orders", "erp-compras"], ["sales_orders", "erp-vendas"], ["stock_movements", "erp-estoque"], ["receivables", "erp-financeiro"], ["payables", "erp-financeiro"]] as const) {
      await setModule(f.profile, module, false, f.admin.id);
      const result = await send(batchPath(kind), input);
      expect(result.response.status, `${kind}/${module}: ${JSON.stringify(result.data)}`).toBe(409);
      expect(result.data.error.code).toBe("module_disabled");
      await setModule(f.profile, module, true, f.admin.id);
    }
    await exec(env, "UPDATE users SET access='[]' WHERE id=?", f.member.id);
    expect((await send(batchPath("products"), input, await bearer(f.member))).response.status).toBe(403);
  });

  it("origem externa não alcança importação; marca de bot sem concessão não eleva a pessoa", { timeout: 120_000 }, async () => {
    const { f } = await setup();
    const call = { method: "POST", path: `/profiles/${f.profile}/erp/v1/importacoes/produtos/lote`, body: { command_id: null, job_id: null, file_name: "p.csv", total_rows: 1, dry_run: true, items: [{ row: 2, lines: [2], data: { name: "Produto" } }] } };
    const person = (await actorForUser(env, f.admin.id))!;
    const bot = await internalCall(env, { ...person, via: { kind: "bot", bot_id: "sem-concessao", run_id: "execucao", masked: true } }, call);
    expect(bot.status).toBe(403);
    await expect(internalCall(env, { ...person, id: "bot:attendant", kind: "bot" } as never, call)).rejects.toThrow(/motor de atendimento/);
  });
});
