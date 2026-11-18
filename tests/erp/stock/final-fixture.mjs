import { randomUUID } from "node:crypto";
export const DAY = "2026-10-15";
export async function order(f, p, w, kind = "purchase_orders") {
  const contact = await f.catalog("contacts", { name: "Fornecedor final", person_type: "J", roles: ["customer", "supplier"] });
  let d = (
    await f.rpc("erp_document_save", {
      p_user_id: f.users.admin,
      p_kind: kind,
      p_id: null,
      p_expected_version: 0,
      p_command_id: randomUUID(),
      p_body: {
        date: DAY,
        contact_id: contact.id,
        warehouse_id: w.id,
        items: [{ product_id: p.id, description: "Peça final", unit: "UN", quantity: "5", unit_price: "3.15" }],
      },
    })
  ).document;
  if (kind === "purchase_orders")
    d = (
      await f.rpc("erp_document_transition", {
        p_user_id: f.users.admin,
        p_kind: kind,
        p_id: d.id,
        p_expected_version: d.version,
        p_command_id: randomUUID(),
        p_status: "in_progress",
        p_reason: "Preparar recebimento",
      })
    ).document;
  return d;
}
