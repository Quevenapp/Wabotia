// Validação de entrada do erp_document_save (documents/normalize.ts) contra o oráculo:
// cada função sozinha, com entradas válidas e uma coisa estragada por vez (código e
// mensagem iguais), mais os casos de texto (NBSP, U+3000, U+0085, maiúsculas) e um
// corpo grande de pedido de venda, pedido de compra, OS e proposta.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dualFixture } from "../harness/dual-fixture.mjs";
import { inTransaction } from "../../../src/erp/engine/registry.ts";
import { one } from "../../../src/erp/engine/driver.ts";
import {
  checkCustomFields,
  commercialData,
  commercialReference,
  customFieldValue,
  deliveryAddress,
  extensionData,
  extensionKeys,
  hasCommercialData,
  installmentDetails,
  normalize,
  normalizeCore,
  optionalAmount,
  paymentTypes,
  richText,
} from "../../../src/erp/domains/documents/normalize.ts";

let f;
before(async () => {
  f = await dualFixture();
});
after(() => f?.close());

// undefined = NULL do SQL; o resto vai como jsonb.
const js = (v) => (v === undefined ? undefined : structuredClone(v));
const pj = (v) => (v === undefined ? null : JSON.stringify(v));
const lite = (fn) => {
  try {
    return { ok: inTransaction(f.driver, (ctx) => fn(ctx.db)) ?? null };
  } catch (e) {
    if (!e.code) throw e;
    return { err: `${e.code}:${e.message}` };
  }
};
const pg = async (sql, args) => {
  try {
    return { ok: (await f.db.query(sql, args)).rows[0]?.v ?? null };
  } catch (e) {
    return { err: `${e.code}:${e.message}` };
  }
};
let compared = 0;
async function same(label, fn, sql, args) {
  const want = await pg(sql, args);
  const got = lite(fn);
  compared++;
  assert.deepEqual(got, want, label);
  return want;
}

const DEL = Symbol("apaga");
/** Cópia com um caminho trocado (DEL apaga a chave). */
function put(obj, path, value) {
  const out = structuredClone(obj);
  let cur = out;
  for (const k of path.slice(0, -1)) cur = cur[k];
  const last = path.at(-1);
  if (value === DEL) {
    if (Array.isArray(cur)) cur.splice(last, 1);
    else delete cur[last];
  } else cur[last] = structuredClone(value);
  return out;
}

const U = () => randomUUID();
const TEXTS = [DEL, null, 5, true, [], {}, "", "   ", " a ", " a ", "　a", "a\u0085b", "a\nb", "a\tb", "ação", "x".repeat(201)];
const DECIMALS = [DEL, null, 0, "", "0", "-1", "1", "1.5", "01", "1.", ".5", "1e3", "1.123", "1.1234567", "999999999", "1000000000", "12.345678"];
const UUIDS = [DEL, null, 1, "", "abc", "12345678-1234-1234-1234-123456789ABC", " 12345678-1234-1234-1234-123456789abc ", "{12345678-1234-1234-1234-123456789abc}"];
const DATES = [DEL, null, 20261117, "", "2026-11-17", "2026-02-30", "1899-12-31", "2099-12-31", " 2026-11-17 ", "17/11/2026"];

const rich = (text = "Olá") => ({
  version: 1,
  blocks: [{ align: "left", indent: 0, code: false, runs: [{ text, bold: true, italic: false, underline: false, color: "#ff0000", background: null, size: 12 }] }],
});
const ref = (id = "12", label = "Ref") => ({ system: "origin", source_id: id, label });
const commercial = () => ({
  introduction: "Prezados,\nsegue a proposta",
  attention_to: "João",
  seller_reference: ref("12", "Vendedor"),
  store_reference: null,
  business_unit_reference: ref("3", null),
  transport: {
    freight_mode: "1",
    volume_count: "2",
    gross_weight: "10.5",
    delivery_days: "3",
    carrier_reference: null,
    service_reference: ref("7", "Sedex"),
    tracking_code: "BR123",
  },
});
const address = () => ({ name: "Casa", postal_code: "01310-100", state: "sp", city: "São Paulo", district: "Centro", street: "Av. Paulista", number: "1000", complement: null, country: "Brasil" });
const details = () => ({
  account_id: U(),
  payment_type: "03",
  card_brand: "01",
  integration_type: "1",
  acquirer_cnpj: "12345678000190",
  authorization_code: "ABC-1/2.3",
  received_amount: "50.00",
  fee_amount: "1.5",
  commission_fee_amount: null,
});

test("payment_types, extension_keys e optional_amount", async () => {
  await same("payment_types", () => paymentTypes(), "select erp_documents.payment_types() v", []);
  await same("extension_keys", () => extensionKeys(), "select erp_documents.extension_keys() v", []);
  for (const v of [...DECIMALS, "999999999999.99", "1000000000000", "0.001"])
    await same(`optional_amount ${String(pj(v === DEL ? undefined : v))}`, () => optionalAmount(js(v === DEL ? undefined : v)), "select erp_documents.optional_amount($1::jsonb) v", [pj(v === DEL ? undefined : v)]);
});

test("commercial_reference", async () => {
  const cases = [undefined, null, ref(), ref("1", null), ref("0"), ref("01"), ref("1".repeat(40)), ref("1".repeat(41)), ref("12", " r "), ref("12", "x".repeat(201)), ref("12", 5), "x", [], {}];
  for (const k of ["system", "source_id", "label"]) for (const v of [DEL, null, 1, "ORIGIN", "fagoo", "12", " 12"]) cases.push(put(ref(), [k], v));
  cases.push({ ...ref(), extra: 1 });
  for (const v of cases)
    await same(`commercial_reference ${pj(v)}`, () => commercialReference(js(v)), "select erp_documents.commercial_reference($1::jsonb) v", [pj(v)]);
});

test("commercial_data e has_commercial_data", async () => {
  const cases = [undefined, null, commercial(), put(commercial(), ["transport"], null), "x", [], { ...commercial(), extra: 1 }];
  for (const k of ["introduction", "attention_to", "seller_reference", "store_reference", "business_unit_reference", "transport"])
    for (const v of [DEL, null, 5, "", " a ", "a\nb", ref("0"), {}]) cases.push(put(commercial(), [k], v));
  for (const k of ["freight_mode", "volume_count", "gross_weight", "delivery_days", "carrier_reference", "service_reference", "tracking_code"])
    for (const v of [DEL, null, 1, "", "0", "9", "5", "01", "1000000", "999999", "1.5", "1.1234567", ref(), "a\u0085"]) cases.push(put(commercial(), ["transport", k], v));
  cases.push(put(commercial(), ["transport", "extra"], 1));
  for (const v of cases)
    await same(`commercial_data ${pj(v)}`, () => commercialData(js(v)), "select erp_documents.commercial_data($1::jsonb) v", [pj(v)]);

  const has = [
    undefined, null, {}, [], "x", { commercial: null }, { commercial: {} }, { items: [] }, { items: [{ detailed_description: null }] }, { items: [{ detailed_description: "a" }] },
    { items: [1, "x", null] }, { items: {} }, { items: "x" }, { items: null }, { installments: [{ note: null, payment_reference: null }] }, { installments: [{ note: "n" }] },
    { installments: [{ payment_reference: ref() }] }, { installments: {} }, { commercial: {}, items: "x" }, { items: [{ detailed_description: "a" }], installments: 5 },
  ];
  for (const v of has)
    await same(`has_commercial_data ${pj(v)}`, () => hasCommercialData(js(v)), "select erp_documents.has_commercial_data($1::jsonb) v", [pj(v)]);
});

test("rich_text", async () => {
  const base = rich();
  const cases = [undefined, null, base, "x", [], { ...base, extra: 1 }, put(base, ["version"], 2), put(base, ["version"], "1"), put(base, ["blocks"], {}), put(base, ["blocks"], [])];
  cases.push(put(base, ["blocks"], Array.from({ length: 201 }, () => base.blocks[0])));
  cases.push(put(base, ["blocks"], Array.from({ length: 200 }, () => base.blocks[0])));
  for (const k of ["align", "indent", "code", "runs"])
    for (const v of [DEL, null, "left", "center", "middle", 0, 5, 6, -1, 1.5, "1", true, [], {}]) cases.push(put(base, ["blocks", 0, k], v));
  cases.push(put(base, ["blocks", 0, "extra"], 1), put(base, ["blocks", 0], "x"));
  for (const k of ["text", "bold", "italic", "underline", "color", "background", "size"])
    for (const v of [DEL, null, "", " ", "a\u0001b", "a\u007fb", "a\u0085b", "a\nb", " ", "　", "#ffffff", "#FFFFFF", "#fff", true, 8, 13, 36, "12", 12.5])
      cases.push(put(base, ["blocks", 0, "runs", 0, k], v));
  cases.push(put(base, ["blocks", 0, "runs", 0, "extra"], 1), put(base, ["blocks", 0, "runs", 0], 1));
  const many = (n, text) => ({ version: 1, blocks: [{ align: "left", indent: 0, code: false, runs: Array.from({ length: n }, () => rich(text).blocks[0].runs[0]) }] });
  cases.push(many(1000, "a"), many(1001, "a"), many(20, "x".repeat(1000)), many(21, "x".repeat(1000)), many(10, "\u{1F600}".repeat(2000)), many(11, "\u{1F600}".repeat(2000)));
  for (const v of cases)
    await same(`rich_text ${pj(v)?.slice(0, 200)}`, () => richText(js(v)), "select erp_documents.rich_text($1::jsonb) v", [pj(v)]);
});

test("delivery_address", async () => {
  const cases = [undefined, null, address(), "x", [], { ...address(), extra: 1 }];
  for (const k of ["name", "postal_code", "state", "city", "district", "street", "number", "complement", "country"])
    for (const v of [...TEXTS, "01310100", "01310-10", "1310-100", "01310--100", "SP", "Sp", "sP", "rj", "XX", "ex", "s ", "ſp", "x".repeat(31), "x".repeat(61), "x".repeat(101), "x".repeat(121)])
      cases.push(put(address(), [k], v));
  for (const v of cases)
    await same(`delivery_address ${pj(v)}`, () => deliveryAddress(js(v)), "select erp_documents.delivery_address($1::jsonb) v", [pj(v)]);
});

test("installment_details", async () => {
  const cases = [undefined, null, details(), "x", [], { ...details(), extra: 1 }];
  for (const k of ["account_id", "payment_type", "card_brand", "integration_type", "acquirer_cnpj", "authorization_code", "received_amount", "fee_amount", "commission_fee_amount"])
    for (const v of [DEL, null, 1, "", "00", "01", "03", "06", "10", "23", "99", "1", "2", "3", "12345678000190", "AB345678000190", "ab345678000190", "1234567800019A", "abc def", "a".repeat(128), "a".repeat(129), "100.00", "100.01", "1.234", "0", "-1", " "])
      cases.push(put(details(), [k], v));
  for (const kind of ["sales_orders", "sales_proposals", "service_orders", null])
    for (const amount of ["100.00", "1.50", null])
      for (const v of cases)
        await same(`installment_details ${kind} ${amount} ${pj(v)}`, () => installmentDetails(kind, js(v), amount), "select erp_documents.installment_details($1,$2::jsonb,$3::numeric) v", [kind, pj(v), amount]);
});

const EXTENSION = {
  ship_date: "2026-11-18",
  finish_date: "2026-11-30",
  start_time: "08:30",
  end_time: "23:59",
  customer_po_number: " PO-1 ",
  quote_requested: true,
  quoted: false,
  warranty_days: "90",
  warranty_months: "12",
  warranty_info: "Garantia\nde fábrica",
  reception_notes: "Recebido\tsem caixa",
  template_name: "Modelo",
  delivery_address: address(),
  order_reference: "REF-9",
  seller_id: "12345678-1234-1234-1234-123456789ABC",
  category_id: null,
  carrier_id: U(),
  price_list_id: U(),
  payment_account_id: U(),
  payment_means: "03",
  payment_indicator: "1",
  other_items: { content: rich("Outros"), total: "10.5" },
  commercial_conditions: { mode: "installments", text: rich("Condições") },
};

test("extension_data", async () => {
  const cases = [undefined, null, {}, EXTENSION, { items: [] }, ["ship_date"], "ship_date", ["start_time", "payment_means"], 5];
  const values = [DEL, null, 1, true, "", " ", "2026-11-18", "2026-02-30", "08:30", "24:00", "8:30", "0", "9999", "10000", "999", "1000", "01", "03", "23", "1", "2",
    "x".repeat(61), "x".repeat(121), "a\nb", " ", "　a", "a\u0085", "12345678-1234-1234-1234-123456789abc", {}, [], address(), { content: null, total: "0" },
    { content: rich(), total: "1.234" }, { content: rich(), total: "1", extra: 1 }, { mode: "none", text: null }, { mode: "text", text: rich() }, { mode: "other", text: null }, { mode: 1, text: null }];
  for (const k of Object.keys(EXTENSION)) for (const v of values) cases.push(put(EXTENSION, [k], v));
  for (const v of cases)
    await same(`extension_data ${pj(v)?.slice(0, 300)}`, () => extensionData(js(v)), "select erp_documents.extension_data($1::jsonb) v", [pj(v)]);
});

test("custom_field_value e check_custom_fields", async () => {
  const option = U();
  const fields = {
    integer: { field_type: "integer" },
    decimal: { field_type: "decimal" },
    text: { field_type: "text", min_length: 2, max_length: 10 },
    long_text: { field_type: "long_text" },
    boolean: { field_type: "boolean" },
    date: { field_type: "date" },
    list: { field_type: "list", options: [{ id: option, label: "A" }, { id: U(), label: "B" }] },
    required: { field_type: "text", required: true },
    inactive: { field_type: "text", active: false },
  };
  for (const [name, d] of Object.entries(fields)) {
    d.id = U();
    await f.db.query(
      "insert into erp_documents.custom_field(id,kind,field_type,name,required,min_length,max_length,options,active,created_by,updated_by) values($1,'service_orders',$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$9)",
      [d.id, d.field_type, name, d.required ?? false, d.min_length ?? null, d.max_length ?? null, JSON.stringify(d.options ?? []), d.active ?? true, f.users.admin],
    );
  }
  await f.sync();
  const VALUES = [null, "", " ", "0", "-0", "1", "-1", "01", "123456789012345678", "1234567890123456789", "1.5", "1.50", "1.", "-0.5", "1.000001", "1.0000001", "123456789012345.1",
    "true", "false", "TRUE", "2026-11-17", "2026-02-30", "1899-01-01", "2026-1-1", option, option.toUpperCase(), U(), "ab", "a", "abcdefghijk", " ab", "ab ", "a b", "　ab",
    "a\u0085b", "a\nb", "a\tb", "x".repeat(255), "x".repeat(256), "x".repeat(4000), "x".repeat(4001)];
  for (const [name, d] of Object.entries(fields))
    for (const v of VALUES)
      await same(
        `custom_field_value ${name} ${v?.slice(0, 40)}`,
        (db) => customFieldValue(one(db, 'SELECT * FROM "erp_documents__custom_field" WHERE id=?', d.id), v),
        "select erp_documents.custom_field_value(x,$2) v from erp_documents.custom_field x where x.id=$1",
        [d.id, v],
      );

  const ok = { [fields.required.id]: "valor", [fields.integer.id]: "10", [fields.list.id]: option };
  const valueCases = [undefined, null, {}, ok, [], "x", { ...ok, [fields.required.id]: "" }, { ...ok, [fields.required.id]: null }, { ...ok, [fields.required.id]: 5 }];
  for (const [name, d] of Object.entries(fields)) for (const v of ["1", "x", "", null, 1, true]) valueCases.push({ ...ok, [d.id]: v, _n: name });
  valueCases.push({ ...ok, [U()]: "x" }, { ...ok, abc: "x" }, { ...ok, [fields.integer.id.toUpperCase()]: "1" }, { ...ok, [`{${fields.integer.id}}`]: "1" }, { ...ok, [fields.integer.id.replace(/-/g, "")]: "1" });
  const befores = [undefined, null, {}, { custom_fields: { [fields.inactive.id]: "antigo" } }, { custom_fields: { [fields.inactive.id]: "x" } }, { custom_fields: null }];
  for (const kind of ["service_orders", "sales_orders", null])
    for (const raw of valueCases)
      for (const b of befores) {
        const v = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "_n")) : raw;
        await same(
          `check_custom_fields ${kind} ${pj(v)} ${pj(b)}`,
          (db) => (checkCustomFields(db, kind, js(v), js(b)), true),
          // ::text = '' usa o resultado (void); numa subconsulta sem uso o Postgres nem chamaria a função.
          "select erp_documents.check_custom_fields($1,$2::jsonb,$3::jsonb)::text = '' v",
          [kind, pj(v), pj(b)],
        );
      }
});

// ---------------------------------------------------------------------------
// O corpo

const item = (extra = {}) => ({
  id: U(),
  product_id: U(),
  description: " Produto A ",
  code: "A1",
  unit: "UN",
  quantity: "3",
  unit_price: "10.5",
  discount_percent: "10",
  detailed_description: "linha 1\nlinha 2",
  ...extra,
});
const bodies = () => ({
  sales_orders: {
    date: "2026-11-17",
    contact_id: U(),
    warehouse_id: U(),
    expected_date: "2026-11-20",
    items: [
      item({ list_price: "12", lots: [{ lot_id: U(), quantity: "1" }, { lot_id: U(), quantity: "2" }] }),
      { description: "Serviço", unit: "H", quantity: "1.5", unit_price: "100.12345", list_price: null, lots: [] },
    ],
    discount_mode: "percent",
    discount_value: "5",
    freight: "10",
    other_expenses: "2.50",
    notes: "obs\ncom linha",
    internal_notes: "interna",
    payment_terms: "30 dias",
    delivery_terms: "entrega",
    commercial: commercial(),
    seller_id: U(),
    category_id: U(),
    carrier_id: U(),
    price_list_id: U(),
    payment_account_id: U(),
    payment_means: "03",
    payment_indicator: "1",
    delivery_address: address(),
    customer_po_number: "PO-1",
    order_reference: "REF",
    ship_date: "2026-11-18",
  },
  purchase_orders: {
    date: "2026-11-17",
    contact_id: U(),
    warehouse_id: U(),
    items: [item({ supplier_code: "F-1", ipi_rate: "5" }), item({ id: U(), quantity: "2.5", unit_price: "3.3333", ipi_rate: "12.3456", discount_percent: "0" })],
    discount_mode: "amount",
    discount_value: "1.00",
    freight: "0",
    tax_icms_st: "4.20",
    notes: "compra",
    carrier_id: U(),
    payment_account_id: U(),
    commercial: put(commercial(), ["transport", "freight_mode"], "9"),
  },
  service_orders: {
    date: "2026-11-17",
    contact_id: U(),
    items: [
      item({ group: "part", lots: [{ lot_id: U(), quantity: "3" }] }),
      item({ id: U(), product_id: null, group: "service", quote: true, done: false, warranty_days: "30", quantity: "1", unit_price: "80" }),
    ],
    equipment: "Notebook\nmodelo X",
    serial_number: "SN1",
    technician: "Ana",
    defect: "não liga",
    solution: "troca\nda fonte",
    start_time: "08:00",
    end_time: "17:30",
    finish_date: "2026-11-30",
    quote_requested: true,
    quoted: false,
    warranty_days: "90",
    warranty_months: "3",
    warranty_info: "garantia",
    reception_notes: "sem carregador",
    custom_fields: { [U()]: "valor", [U()]: "", [U()]: null },
  },
  sales_proposals: {
    date: "2026-11-17",
    contact_id: U(),
    valid_until: "2026-12-17",
    next_contact: "2026-11-24",
    template: true,
    template_name: "Modelo de proposta",
    items: [item(), item({ id: U(), discount_percent: "100" })],
    discount_mode: "amount",
    discount_value: "0",
    other_items: { content: rich("Instalação"), total: "150.00" },
    commercial_conditions: { mode: "installments", text: rich("Em 2x") },
    commercial: commercial(),
  },
});

/** Põe parcelas que somam o total que o oráculo calcula (a primeira com o resto). */
async function withInstallments(kind, body, extra = {}, fn = "normalize") {
  const r = await pg(`select erp_documents.${fn}($1,$2::jsonb) v`, [kind, JSON.stringify(body)]);
  assert.ok(r.ok, `${kind} sem parcelas: ${r.err}`);
  const cents = Math.round(Number(r.ok.totals.total) * 100);
  const a = Math.floor(cents / 2),
    b = cents - a;
  const money = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
  return {
    ...body,
    installments: [
      { due_date: "2026-12-17", amount: money(b), method: "Boleto", note: "primeira", payment_reference: ref("5"), ...extra },
      { due_date: "2027-01-17", amount: money(a), method: null },
    ],
  };
}

const coreOf = (body) => {
  const out = Object.fromEntries(Object.entries(body).filter(([k]) => !extensionKeys().includes(k) && !["tax_ipi", "tax_icms_st", "equipment", "custom_fields"].includes(k)));
  out.items = body.items.map((i) => Object.fromEntries(Object.entries(i).filter(([k]) => !["list_price", "supplier_code", "group", "quote", "done", "lots", "warranty_days", "ipi_rate"].includes(k))));
  if (out.installments) out.installments = out.installments.map((p) => Object.fromEntries(Object.entries(p).filter(([k]) => !["payment_method_id", "details"].includes(k))));
  return out;
};

const KINDS = ["sales_orders", "purchase_orders", "service_orders", "sales_proposals"];
const run = (fn, name) => async (kind, body, label) =>
  same(`${name} ${kind} ${label}`, () => fn(kind, js(body)), `select erp_documents.${name}($1,$2::jsonb) v`, [kind, pj(body)]);

test("normalize_core: corpos válidos e um campo estragado por vez", async () => {
  const check = run(normalizeCore, "normalize_core");
  const all = bodies();
  for (const kind of [...KINDS, null, "purchase_receipts", "x"]) {
    const base = await withInstallments(KINDS.includes(kind) ? kind : "sales_orders", coreOf(all[kind] ?? all.sales_orders), {}, "normalize_core");
    const ok = await check(kind, base, "base");
    if (KINDS.includes(kind)) assert.ok(ok.ok, `${kind}: ${ok.err}`);
    if (!KINDS.includes(kind)) continue;
    for (const v of [undefined, null, [], "x", { ...base, items: [] }, { ...base, items: {} }, { ...base, extra: 1 }, { ...base, ship_date: "2026-11-17" }, { ...base, installments: {} }])
      await check(kind, v, pj(v)?.slice(0, 80));
    const top = {
      date: DATES, contact_id: UUIDS, warehouse_id: UUIDS, expected_date: DATES, valid_until: DATES, next_contact: DATES, template: [DEL, null, true, false, "true"],
      discount_mode: [DEL, null, "", "amount", "percent", "PERCENT", " percent ", "x".repeat(11), 1], discount_value: [...DECIMALS, "100", "100.0001", "1000000000000"],
      freight: DECIMALS, other_expenses: DECIMALS, notes: TEXTS, internal_notes: TEXTS, payment_terms: TEXTS, delivery_terms: [...TEXTS, "x".repeat(2001)],
      equipment: TEXTS, serial_number: [...TEXTS, "x".repeat(101)], technician: TEXTS, defect: TEXTS, solution: TEXTS,
      commercial: [DEL, null, {}, "x", commercial(), put(commercial(), ["transport", "freight_mode"], "9"), put(commercial(), ["transport"], null)],
    };
    for (const [k, values] of Object.entries(top)) for (const v of values) await check(kind, put(base, [k], v), `${k}=${pj(v === DEL ? undefined : v)?.slice(0, 40)}`);
    for (const pct of ["0", "33.3333", "100"]) await check(kind, put(put(coreOf(all[kind]), ["discount_mode"], "percent"), ["discount_value"], pct), `percent ${pct}`);
    const itemValues = {
      id: [...UUIDS, base.items[1]?.id ?? U()], product_id: UUIDS, description: [...TEXTS, "x".repeat(200)], code: [...TEXTS, "x".repeat(101)], unit: [...TEXTS, "x".repeat(17), "x".repeat(16)],
      quantity: [...DECIMALS, "0.000001", "999999999.999999"], unit_price: [DEL, null, 1, "", "0", "-1", "1.12345678901", "1.1234567890", "1.10000000000", "9999999999", "10000000000", "01"],
      discount_percent: [...DECIMALS, "100", "100.0001", "99.9999"], detailed_description: TEXTS, extra: ["x"],
    };
    for (const [k, values] of Object.entries(itemValues)) for (const v of values) await check(kind, put(base, ["items", 0, k], v), `items.0.${k}=${pj(v === DEL ? undefined : v)?.slice(0, 40)}`);
    for (const v of [1, "x", null, []]) await check(kind, put(base, ["items", 0], v), `items.0=${pj(v)}`);
    await check(kind, put(base, ["items"], Array.from({ length: 251 }, () => item({ id: U() }))), "251 itens");
    if (base.installments) {
      for (const [k, values] of Object.entries({ due_date: DATES, amount: [...DECIMALS, "0.00"], method: [...TEXTS, "x".repeat(101)], note: [...TEXTS, "x".repeat(2001)], payment_reference: [DEL, null, ref(), ref("0"), {}], details: [details()] }))
        for (const v of values) await check(kind, put(base, ["installments", 0, k], v), `installments.0.${k}=${pj(v === DEL ? undefined : v)?.slice(0, 40)}`);
      await check(kind, put(base, ["installments", 0], 1), "installments.0=1");
      await check(kind, put(base, ["installments"], Array.from({ length: 121 }, () => base.installments[0])), "121 parcelas");
    }
  }
  // Valores grandes: o limite do total e a escala da divisão do numeric.
  const big = { date: "2026-11-17", contact_id: U(), items: [{ description: "x", unit: "UN", quantity: "100", unit_price: "9999999999", discount_percent: "33.3333" }], discount_mode: "percent", discount_value: "33.3333" };
  for (const [q, p] of [["100", "9999999999"], ["99", "9999999999.99"], ["1", "999999999999"], ["999999999", "1000"], ["100", "9999999999.9999999999"]])
    await check("sales_orders", put(put(big, ["items", 0, "quantity"], q), ["items", 0, "unit_price"], p), `grande ${q}×${p}`);
  await check("sales_orders", { ...big, items: Array.from({ length: 101 }, () => ({ ...big.items[0], quantity: "1" })) }, "soma no limite");
  await check("sales_orders", { ...big, discount_mode: "amount", discount_value: "0", freight: "999999999999.99" }, "frete no limite");
  // Empates na terceira casa (metade para longe do zero): base 1,5 × 0,33 = 0,495; desconto 5% de 0,50 e de
  // 10,50; 12,5% do subtotal 10,44 = 1,305.
  const tie = {
    date: "2026-11-17",
    contact_id: U(),
    items: [
      { description: "x", unit: "UN", quantity: "1.5", unit_price: "0.33", discount_percent: "5" },
      { description: "y", unit: "UN", quantity: "1", unit_price: "10.50", discount_percent: "5" },
    ],
    discount_mode: "percent",
  };
  for (const pct of ["5", "12.5"]) {
    const r = await check("sales_orders", { ...tie, discount_value: pct }, `empate ${pct}`);
    assert.ok(r.ok, r.err);
  }
});

test("normalize: corpos grandes válidos e um campo estragado por vez", async () => {
  const check = run(normalize, "normalize");
  const all = bodies();
  for (const kind of KINDS) {
    const extra = kind === "sales_orders" ? { payment_method_id: U(), details: { ...details(), received_amount: "1.00", fee_amount: "0.10" } } : kind === "sales_proposals" ? {} : { payment_method_id: U() };
    const base = await withInstallments(kind, all[kind], extra);
    const ok = await check(kind, base, "base");
    assert.ok(ok.ok, `${kind}: ${ok.err}`);
    for (const v of [undefined, null, [], "x", 5, { ...base, extra: 1 }, { ...base, installments: {} }, { ...base, installments: null }, { ...base, items: "x" }])
      await check(kind, v, pj(v)?.slice(0, 80));
    for (const other of KINDS.filter((k) => k !== kind)) await check(other, base, `corpo de ${kind}`);
    await check(kind, { ...base, notes: "x".repeat(270000) }, "corpo acima de 256 KB");
    const top = {
      equipment: [...TEXTS, "x".repeat(201), "x".repeat(4000), "x".repeat(4001)], tax_ipi: DECIMALS, tax_icms_st: DECIMALS,
      custom_fields: [DEL, null, {}, [], "x", { [U()]: "v" }, { [U().toUpperCase()]: "v" }, { abc: "v" }, { [U()]: 1 }, { [U()]: "a\u0085" }, { [U()]: "a\nb" }, { [U()]: "x".repeat(4001) },
        Object.fromEntries(Array.from({ length: 61 }, () => [U(), "v"])), Object.fromEntries(Array.from({ length: 60 }, () => [U(), "v"]))],
      price_list_id: [DEL, null, U()], payment_account_id: [DEL, null, U()], payment_means: [DEL, null, "03", "23"], payment_indicator: [DEL, null, "0", "2"],
      other_items: [DEL, null, { content: null, total: "0" }, { content: rich(), total: "999999999999.99" }], commercial_conditions: [DEL, null, { mode: "none", text: null }, { mode: "text", text: rich() }, { mode: "installments", text: null }],
      delivery_address: [DEL, null, address(), put(address(), ["state"], " sp")], start_time: ["24:00"], warranty_months: ["1000"], ship_date: ["2026-02-30"],
      commercial: [put(commercial(), ["transport", "freight_mode"], "9"), null], freight: ["0", "1"], discount_value: ["0", "100"],
    };
    for (const [k, values] of Object.entries(top)) for (const v of values) await check(kind, put(base, [k], v), `${k}=${pj(v === DEL ? undefined : v)?.slice(0, 60)}`);
    const itemValues = {
      list_price: [DEL, null, 1, "", "0", "12.5", "1.12345678901", "10000000000"], supplier_code: [...TEXTS, "x".repeat(101)],
      group: [DEL, null, "part", "service", "PART", 1], quote: [DEL, null, true, false, "true"], done: [DEL, null, true, false, 1],
      lots: [DEL, null, [], {}, "x", [{ lot_id: U(), quantity: "3" }], [{ lot_id: U(), quantity: "1" }], [{ lot_id: U(), quantity: "0" }], [{ lot_id: U(), quantity: "3", x: 1 }], [{ lot_id: null, quantity: "3" }],
        [{ lot_id: "abc", quantity: "3" }], [{ quantity: "3" }], [1], (() => { const id = U(); return [{ lot_id: id, quantity: "1" }, { lot_id: id, quantity: "2" }]; })(),
        Array.from({ length: 51 }, () => ({ lot_id: U(), quantity: "0.01" }))],
      warranty_days: [DEL, null, "0", "9999", "10000", "01", 30, ""], ipi_rate: [DEL, null, "0", "100", "100.0001", "5.12345", 5, "-1"], product_id: [null],
    };
    for (const [k, values] of Object.entries(itemValues))
      for (const n of [0, 1])
        for (const v of values) await check(kind, put(base, ["items", n, k], v), `items.${n}.${k}=${pj(v === DEL ? undefined : v)?.slice(0, 60)}`);
    for (const [k, values] of Object.entries({
      due_date: DATES, amount: [...DECIMALS, "0.00"], method: TEXTS, note: TEXTS, payment_reference: [DEL, null, ref(), ref("0")], payment_method_id: UUIDS,
      details: [DEL, null, details(), { ...details(), received_amount: "999999.00" }, put(details(), ["card_brand"], "00"), "x"], extra: [1],
    }))
      for (const v of values) await check(kind, put(base, ["installments", 0, k], v), `installments.0.${k}=${pj(v === DEL ? undefined : v)?.slice(0, 60)}`);
    await check(kind, put(base, ["installments", 0, "amount"], "0.01"), "parcelas não somam");
    await check(kind, put(base, ["installments"], []), "sem parcelas");
  }
  // IPI do item com empate: 10,50 × 5% = 0,525.
  const ipi = { date: "2026-11-17", contact_id: U(), items: [{ description: "x", unit: "UN", quantity: "1", unit_price: "10.50", ipi_rate: "5" }] };
  const r = await check("purchase_orders", ipi, "IPI com empate");
  assert.ok(r.ok, r.err);
  assert.ok(compared > 3000, `comparações: ${compared}`);
});
