// Expedição: contrato das rotas (leitura comum; gerar separação, expedir e
// devolver sensíveis), argumentos em português, esquema da versão 25 (só
// adição, com a subida a partir da 21), destino do painel e os PDFs de
// etiqueta (10 × 15 e A4), lista de separação e romaneio. Sem rede.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ERP_SHIPPING_OPERATIONS, ERP_EXPEDICAO_MODULE_CONTRACT, erpShippingOperationFor, erpShippingParams } from "../../../src/erp/expedicao/contract.ts";
import { ShippingArgsError, shippingRpcArgs } from "../../../src/erp/expedicao/args.ts";
import { ERP_DDL_VERSION } from "../../../src/erp/schema/ddl.ts";
import { ERP_ENGINE_TABLES } from "../../../src/erp/schema/engine-tables.ts";
import { ERP_STRUCTURAL } from "../../../src/erp/schema/structural.ts";
import { migrate } from "../../../src/erp/schema/migrate.ts";
import { erpDestinationRequirement } from "../../../src/erp/parts-requirements.ts";
import { ERP_MANAGEMENT_ITEMS } from "../../../src/modules/erp/panel-menu.ts";
import { labelsPdf, manifestPdf, pickListPdf } from "../../../web/erp/expedicao-pdf.ts";

const UUID = "11111111-2222-4333-8444-555555555555", OTHER = "66666666-7777-4888-9999-000000000000";
const command = async () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const args = (name, params = {}, query = "", body) => shippingRpcArgs(ERP_SHIPPING_OPERATIONS.find((op) => op.name === name), params, new URLSearchParams(query), body, command);

test("contrato: consultar é leitura; gerar separação, expedir e devolver são sensíveis e vão para o bot", () => {
  const byName = Object.fromEntries(ERP_SHIPPING_OPERATIONS.map((op) => [op.name, op]));
  for (const op of ERP_SHIPPING_OPERATIONS) {
    assert.equal(op.sensitive, op.method !== "GET", op.name);
    assert.ok(op.path.startsWith("erp-expedicao/"), op.name);
    assert.ok(op.description.length > 30 && !/Fagoo|Origin/.test(op.description), op.name);
  }
  for (const name of ["erp.expedicao.separacao.gerar", "erp.expedicao.expedir", "erp.expedicao.devolucao"]) assert.notEqual(byName[name].bot, false, name);
  assert.deepEqual(ERP_SHIPPING_OPERATIONS.filter((op) => op.bot !== false && op.method === "GET").map((op) => op.name),
    ["erp.expedicao.pedidos", "erp.expedicao.pedido", "erp.expedicao.separacao", "erp.expedicao.embalagens", "erp.expedicao.romaneio"]);
  assert.deepEqual(ERP_EXPEDICAO_MODULE_CONTRACT.definition.bot.sensitive.includes("erp.expedicao.devolucao"), true);
  assert.equal(erpShippingOperationFor("GET", `erp-expedicao/pedidos/${UUID}`).params.id, UUID);
  assert.equal(erpShippingOperationFor("POST", `erp-expedicao/pedidos/${UUID}/devolucoes`).operation.name, "erp.expedicao.devolucao");
  assert.equal(erpShippingOperationFor("DELETE", "erp-expedicao/pedidos"), null);
  assert.deepEqual(erpShippingParams(byName["erp.expedicao.devolucao"]).required, ["id", "motivo", "itens"]);
});

test("argumentos: português da rota para o motor, com recusa clara", async () => {
  assert.deepEqual(await args("erp.expedicao.pedidos", {}, "situacao=a_separar&de=2026-11-01&transportadora=sem"), { p_args: { status: "to_pick", from: "2026-11-01", to: null, carrier_id: "none", warehouse_id: null, search: null } });
  await assert.rejects(args("erp.expedicao.pedidos", {}, "situacao=pronto"), ShippingArgsError);
  await assert.rejects(args("erp.expedicao.pedidos", {}, "outro=1"), /Parâmetro não aceito/);
  assert.deepEqual(await args("erp.expedicao.separacao.gerar", {}, "", { pedidos: [UUID, OTHER] }), { p_command_id: await command(), p_args: { document_ids: [UUID, OTHER], filters: {} } });
  assert.deepEqual(await args("erp.expedicao.separacao.marcar", { id: UUID }, "", { versao: 3, linha: "x|y|", separado: "2,5" }), { p_args: { list_id: UUID, expected_version: 3, key: "x|y|", picked: "2.5" } });
  assert.deepEqual((await args("erp.expedicao.volumes", { id: UUID }, "", { versao: 1, volumes: [{ embalagem: OTHER, peso_bruto: "1,2", itens: [{ linha: "k", quantidade: "1" }] }] })).p_args.volumes,
    [{ package_id: OTHER, length_cm: null, width_cm: null, height_cm: null, gross_kg: "1.2", items: [{ key: "k", quantity: "1" }] }]);
  assert.deepEqual((await args("erp.expedicao.devolucao", { id: UUID }, "", { motivo: "Recusado", itens: [{ linha: "k", quantidade: "2", estado: "avariado" }] })).p_args,
    { document_id: UUID, reason: "Recusado", warehouse_id: null, items: [{ key: "k", quantity: "2", condition: "damaged" }] });
  await assert.rejects(args("erp.expedicao.devolucao", { id: UUID }, "", { motivo: "Recusado", itens: [{ linha: "k", quantidade: "2", estado: "quebrado" }] }), /estado/);
  assert.deepEqual((await args("erp.expedicao.etiquetas", {}, `pedidos=${UUID},${OTHER}`)).p_args.document_ids, [UUID, OTHER]);
});

test("menu e destino: Expedição em Comercial, destino /expedicao com Vendas e Estoque", () => {
  const item = ERP_MANAGEMENT_ITEMS.find((i) => i.id === "erp.shipping");
  assert.deepEqual([item.module, item.part, item.target.to, item.primary], ["erp-expedicao", "expedicao", "/expedicao", true]);
  const destination = erpDestinationRequirement("/expedicao");
  assert.equal(destination.owner, "erp-expedicao");
  assert.deepEqual([...destination.requirement.all].sort(), ["erp", "erp-estoque", "erp-expedicao", "erp-produtos", "erp-vendas"]);
});

function storage(db) {
  return {
    sql: { exec(sql, ...params) {
      const st = db.prepare(sql); st.setReadBigInts(true);
      if (/^\s*(SELECT|WITH|PRAGMA|VALUES)\b|\bRETURNING\b/i.test(sql)) { const rows = st.all(...params); return { toArray: () => rows, raw: () => rows.map((r) => Object.values(r)), rowsRead: rows.length, rowsWritten: 0 }; }
      const r = st.run(...params); return { toArray: () => [], rowsRead: 0, rowsWritten: Number(r.changes) };
    } },
    transactionSync(fn) { db.exec("BEGIN"); try { const out = fn(); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } },
  };
}

test("esquema 25: oito tabelas só da Expedição, com a decisão em structural.ts e a subida a partir da 21", () => {
  assert.ok(ERP_DDL_VERSION >= 25);
  const mine = ERP_ENGINE_TABLES.filter((t) => t.since === 25);
  assert.deepEqual(mine.map((t) => t.table), ["erp_shipping__package", "erp_shipping__pick_list", "erp_shipping__order", "erp_shipping__pick_line",
    "erp_shipping__pending", "erp_shipping__volume", "erp_shipping__return", "erp_shipping__command"]);
  assert.ok(mine.every((t) => t.structural === "expedicao" && ERP_STRUCTURAL.some((s) => s.id === t.structural)));
  assert.equal(ERP_ENGINE_TABLES.filter((t) => t.since >= 22 && t.since <= 24).length, 0, "22 a 24 ficam para as outras frentes");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  assert.equal(migrate(storage(db)).version, ERP_DDL_VERSION);
  for (const t of [...mine].reverse()) db.exec(`DROP TABLE "${t.table}"`);
  db.exec("UPDATE erp_meta SET value='21' WHERE key='schema_version'");
  const upgraded = migrate(storage(db));
  assert.deepEqual([upgraded.status, upgraded.version], ["applied", ERP_DDL_VERSION]);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'erp_shipping__%'").get().n, 8);
  db.close();
});

test("PDFs: etiqueta 10 × 15 (uma por página), A4 com quatro por folha, lista de separação e romaneio com assinatura", () => {
  const sender = { name: "Loja do Ensaio", street: "Rua A", number: "1", city: "São Paulo", state: "SP", postal_code: "01001000" };
  const label = (volume) => ({ order_number: 12, volume, volumes: 5, barcode: `PV000012-0${volume}`, recipient: { name: "Cliente Ensaio", street: "Rua B", number: "2", district: "Centro", city: "Campinas", state: "SP", postal_code: "13010000" },
    carrier: "Transportes", gross_weight_g: 1500, tracking_code: null });
  const text = (bytes) => Buffer.from(bytes).toString("latin1");
  const small = text(labelsPdf([1, 2, 3, 4, 5].map(label), sender, "10x15"));
  assert.ok(small.startsWith("%PDF-1.4"));
  assert.equal((small.match(/\/Type \/Page /g) ?? []).length, 5);
  assert.match(small, /MediaBox \[0 0 283\.46 425\.2\]/, "100 × 150 mm");
  assert.match(small, /Volume 3 de 5/);
  const a4 = text(labelsPdf([1, 2, 3, 4, 5].map(label), sender, "a4"));
  assert.equal((a4.match(/\/Type \/Page /g) ?? []).length, 2);
  assert.match(a4, /MediaBox \[0 0 595\.28 841\.89\]/);
  const pick = text(pickListPdf(3, [{ location: "A-01", warehouse: "Loja", description: "Parafuso", code: "PAR-1", unit: "UN", quantity: "5", orders: "1: 3, 2: 2" }], "20/11/2026"));
  assert.match(pick, /Lista de separa\\347\\343o 3/);
  const manifest = text(manifestPdf([{ carrier: { id: "x", name: "Transportes" }, orders: [{ number: 12, customer: "Cliente", city: "Campinas", state: "SP", shipped_on: "2026-11-20", volumes: 5, gross_weight_g: 7500, tracking_code: "BR1" }], volumes: 5, gross_weight_g: 7500 }],
    sender, { from: "2026-11-20", to: "2026-11-20" }));
  assert.match(manifest, /Romaneio de expedi\\347\\343o/);
  assert.match(manifest, /Assinatura/);
  assert.match(manifest, /1 pedido · 5 volumes|1 pedido \\267 5 volumes/);
});
