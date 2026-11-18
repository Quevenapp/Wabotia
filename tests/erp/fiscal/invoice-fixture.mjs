// Semeadura do F2a: SQL direto no oráculo e f.sync(), como sales-balance.test.mjs.
import { randomUUID } from "node:crypto";
export const key = "35261111222333000181550010000000011000000010";
export async function seed(f, sql, args = []) {
  await f.db.exec("set session_replication_role=replica");
  try {
    await f.db.query(sql, args);
  } finally {
    await f.db.exec("set session_replication_role=origin");
  }
  await f.sync();
}
export async function invoice(f, patch = {}) {
  const id = randomUUID();
  const row = {
    id,
    model: "55",
    direction: "1",
    issue_type: "N",
    environment: "2",
    status: 1,
    series: 1,
    number: 11,
    nature_description: "Venda à vista",
    issue_date: "2026-11-12",
    exit_date: "2026-11-13",
    crt: "1",
    purpose: "1",
    presence: "1",
    final_consumer: false,
    recipient: { name: "Cliente Árvore", person_type: "J", document: "11222333000181", state: "SP", email: "cliente@example.test", phone: "11998765432" },
    doc_references: [],
    transport: { carrier: { name: "Transportadora Ágil" }, tracking_code: "RA123BR" },
    payment: {},
    authorized_xml: [],
    intermediary: {},
    auto_tax: false,
    freight: "1.25",
    insurance: "0",
    other_expenses: "0",
    discount: "0",
    totals: { total: "123.45" },
    version: 1,
    created_by: f.users.admin,
    updated_by: f.users.admin,
    created_at: "2026-11-12T10:00:00Z",
    updated_at: "2026-11-12T10:00:00Z",
    ...patch,
  };
  await seed(
    f,
    `insert into erp_fiscal_invoices.invoice(${Object.keys(row).join(",")}) values(${Object.keys(row)
      .map((_, i) => `$${i + 1}`)
      .join(",")})`,
    Object.values(row).map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v)),
  );
  return id;
}
export async function item(f, id, product, patch = {}) {
  const row = {
    invoice_id: id,
    position: 1,
    product_id: product,
    quantity: "2.5000",
    unit_price: "10.1234567890",
    total: "25.31",
    freight: "0",
    insurance: "0",
    other_expenses: "0",
    discount: "0",
    data: { product_id: product, code: "F2A", description: "Produto fiscal", quantity: "2.5000", unit_price: "10.1234567890" },
    ...patch,
  };
  await seed(
    f,
    `insert into erp_fiscal_invoices.invoice_item(${Object.keys(row).join(",")}) values(${Object.keys(row)
      .map((_, i) => `$${i + 1}`)
      .join(",")})`,
    Object.values(row).map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v)),
  );
}
export async function raw(f, entity, id, payload, hash = "a".repeat(64), at = "2026-11-12T10:00:00Z") {
  await seed(
    f,
    `insert into origin_sync.raw_record(entity,source_id,payload,version_hash,changed_at,last_resource) values($1,$2,$3,$4,$5,'nfe')
    on conflict(entity,source_id) do update set payload=excluded.payload,version_hash=excluded.version_hash,changed_at=excluded.changed_at`,
    [entity, id, JSON.stringify(payload), hash, at],
  );
}
export async function mirror(f, id, listing, patch = {}) {
  const row = {
    entity: "nfe",
    source_id: id,
    version: 1,
    version_hash: "a".repeat(64),
    payload: { tipo: "1", contato: { id: "contact-origin" } },
    document_links: {},
    access_key: null,
    status_raw: "6",
    last_seen_at: "2026-11-12T10:00:00Z",
    source_deleted: false,
    listing,
    ...patch,
  };
  await seed(
    f,
    `insert into erp_fiscal_mirror.current(${Object.keys(row).join(",")}) values(${Object.keys(row)
      .map((_, i) => `$${i + 1}`)
      .join(",")})`,
    Object.values(row).map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v)),
  );
}
export const refused = (code, message) => (e) => e.code === code && (!message || e.message === message);
