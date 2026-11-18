// Cobrança do contato: public.erp_contact_billing_get e erp_contact_billing_save
// (e-mail de cobrança e "igual ao geral"), com erp_catalog.contact_billing_view,
// contact_billing_address e contact_email_verified. Recibo próprio
// (contact_billing_command) e trilha (contact_billing_audit).
import { createHash } from "node:crypto";
import { one, type SqlDriver } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { jsonbText, jsonType } from "../../../engine/json.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { pgBtrim, pgHasCntrl, pgLength, pgLower } from "../../../engine/text.ts";
import { requireAccess } from "../access.ts";
import { jsonArg } from "../args.ts";
import { contactScope, contactVisibleTo } from "../contact.ts";
import { contactEmailList } from "../fields.ts";

/** erp_catalog.contact_email_verified(p_contact, p_emails, p_purpose) */
function emailVerified(db: SqlDriver, contact: string, emails: string | null, purpose: string): boolean {
  if (emails === null || pgBtrim(emails) === "") return false;
  return emails
    .split(/[;,]/)
    .filter((x) => pgBtrim(x) !== "")
    .every(
      (x) =>
        !!one(
          db,
          'SELECT 1 x FROM "erp_catalog__contact_email_verification" WHERE contact_id=? AND purpose=? AND email=?',
          contact, purpose, pgLower(pgBtrim(x)),
        ),
    );
}

/** erp_catalog.contact_billing_view(p_contact) */
function billingView(db: SqlDriver, contact: string) {
  const r = one(
    db,
    `SELECT c.record_id, c.email, c.postal_code, c.state, c.city, c.district, c.street, c.number, c.complement,
     b.same_as_general, b.billing_email, b.version, p.billing_postal_code, p.billing_state, p.billing_city, p.billing_district,
     p.billing_street, p.billing_number, p.billing_complement, p.billing_foreign_state
     FROM "erp_catalog__contact" c LEFT JOIN "erp_catalog__contact_profile" p ON p.record_id=c.record_id
     LEFT JOIN "erp_catalog__contact_billing" b ON b.contact_id=c.record_id WHERE c.record_id=?`,
    contact,
  );
  if (!r) return null;
  const v = (k: string) => (r[k] ?? null) as string | null;
  const same = r.same_as_general !== null && r.same_as_general !== undefined && !!Number(r.same_as_general);
  // concat() ignora nulos; btrim só espaços.
  const own = pgBtrim([v("billing_street"), v("billing_postal_code"), v("billing_city")].map((x) => x ?? "").join(""));
  const address =
    same || own === ""
      ? { source: "geral", postal_code: v("postal_code"), state: v("state"), city: v("city"), district: v("district"), street: v("street"), number: v("number"), complement: v("complement"), foreign_state: null }
      : {
          source: "cobranca", postal_code: v("billing_postal_code"), state: v("billing_state"), city: v("billing_city"), district: v("billing_district"),
          street: v("billing_street"), number: v("billing_number"), complement: v("billing_complement"), foreign_state: v("billing_foreign_state"),
        };
  return {
    contact_id: r.record_id,
    same_as_general: same,
    billing_email: v("billing_email"),
    email_verified: emailVerified(db, contact, v("email"), "geral"),
    billing_email_verified: emailVerified(db, contact, v("billing_email"), "cobranca"),
    verification_available: false,
    address,
    version: r.version === null || r.version === undefined ? 0 : Number(r.version),
  };
}

const reachable = (db: SqlDriver, user: string | null, contact: string | null) =>
  contact !== null &&
  !!one(db, 'SELECT 1 x FROM "erp_catalog__contact" WHERE record_id=?', contact) &&
  contactVisibleTo(db, contactScope(db, user), contact);

export function erpContactBillingGet(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const contact = (a.p_contact_id ?? null) as string | null;
  requireAccess(ctx.db, user, "contacts", false);
  if (!reachable(ctx.db, user, contact)) raise("P0002", "erp_catalog_not_found");
  return { entity: "contact_billing", data_mode: "erp_native", operational_effects: false, item: billingView(ctx.db, contact!) };
}

export function erpContactBillingSave(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const contact = (a.p_contact_id ?? null) as string | null;
  const expected = (a.p_expected_version ?? null) as number | null;
  const command = (a.p_command_id ?? null) as string | null;
  const data = jsonArg(a, "p_data") as Record<string, unknown> | null;
  const db = ctx.db;
  requireAccess(db, user, "contacts", true);
  if (
    contact === null || command === null || expected === null || expected < 0 || expected > 2147483646 || jsonType(data) !== "object" ||
    Object.keys(data!).some((k) => !["same_as_general", "billing_email"].includes(k)) ||
    !("same_as_general" in data!) || !("billing_email" in data!) ||
    jsonType(data!.same_as_general) !== "boolean" || !["string", "null"].includes(jsonType(data!.billing_email)!)
  )
    raise("22023", "erp_catalog_invalid_command");
  const same = data!.same_as_general as boolean;
  const raw = data!.billing_email as string | null;
  const email = raw === null || pgBtrim(raw) === "" ? null : pgBtrim(raw);
  if (email !== null && (pgLength(email) > 254 || pgHasCntrl.test(email) || !contactEmailList(email, 254)))
    raise("22023", "erp_catalog_contact_invalid:billing_email");
  const hash = createHash("sha256")
    .update(jsonbText({ profile: "erp-contact-billing-v1", actor: user, contact, version: expected, data }), "utf8")
    .digest("hex");
  const stored = one(db, 'SELECT actor, request_hash, result FROM "erp_catalog__contact_billing_command" WHERE command_id=?', command);
  if (stored) {
    if (stored.actor !== user || stored.request_hash !== hash) raise("40001", "erp_catalog_command_conflict");
    return { ...JSON.parse(String(stored.result)), replayed: true };
  }
  if (!reachable(db, user, contact)) raise("P0002", "erp_catalog_not_found");
  const row = one(db, 'SELECT version FROM "erp_catalog__contact_billing" WHERE contact_id=?', contact);
  if ((row ? Number(row.version) : 0) !== expected) raise("40001", "erp_catalog_version_conflict");
  const before = row ? billingView(db, contact!) : null;
  if (row)
    db.exec(
      'UPDATE "erp_catalog__contact_billing" SET same_as_general=?, billing_email=?, version=version+1, updated_by=?, updated_at=? WHERE contact_id=?',
      same ? 1 : 0, email, user, ctx.clock.next().toString(), contact,
    );
  else
    db.exec(
      'INSERT INTO "erp_catalog__contact_billing"(contact_id, same_as_general, billing_email, version, updated_by, updated_at) VALUES(?,?,?,1,?,?)',
      contact, same ? 1 : 0, email, user, ctx.clock.next().toString(),
    );
  const result = { entity: "contact_billing", data_mode: "erp_native", operational_effects: false, replayed: false, item: billingView(db, contact!) };
  db.exec(
    'INSERT INTO "erp_catalog__contact_billing_audit"(contact_id, actor, command_id, before_data, after_data, created_at) VALUES(?,?,?,?,?,?)',
    contact, user, command, before === null ? null : jsonbText(before), jsonbText(result.item), ctx.clock.next().toString(),
  );
  db.exec(
    'INSERT INTO "erp_catalog__contact_billing_command"(command_id, actor, request_hash, result, created_at) VALUES(?,?,?,?,?)',
    command, user, hash, jsonbText(result), ctx.clock.next().toString(),
  );
  return result;
}

registerRpc("erp_contact_billing_get", erpContactBillingGet);
registerRpc("erp_contact_billing_save", erpContactBillingSave);
