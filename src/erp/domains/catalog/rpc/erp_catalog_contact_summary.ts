// public.erp_catalog_contact_summary: resumo do contato (situação, notas,
// pessoas de contato). Com o escopo do vendedor, pessoa fora da carteira sai
// sem e-mail e telefones (visible: false).
import { one } from "../../../engine/driver.ts";
import { raise } from "../../../engine/errors.ts";
import { registerRpc, type RpcArgs, type RpcContext } from "../../../engine/registry.ts";
import { requireAccess } from "../access.ts";
import { contactRequireVisible, contactScope, contactSituationOf } from "../contact.ts";

export function erpCatalogContactSummary(ctx: RpcContext, a: RpcArgs) {
  const user = (a.p_user_id ?? null) as string | null;
  const id = (a.p_id ?? null) as string | null;
  const db = ctx.db;
  requireAccess(db, user, "contacts", false);
  if (id === null || !one(db, `SELECT 1 x FROM "erp_catalog__record" WHERE id=? AND entity='contacts'`, id)) raise("P0002", "erp_catalog_not_found");
  contactRequireVisible(db, user, id);
  const scope = contactScope(db, user);
  const r = one(
    db,
    `SELECT r.id, r.name, r.code, cp.notes, cp.contact_info FROM "erp_catalog__record" r
     LEFT JOIN "erp_catalog__contact_profile" cp ON cp.record_id=r.id WHERE r.id=?`,
    id,
  )!;
  const persons = db
    .exec(
      `SELECT pr.id, pr.name, pr.code, pc.email, pc.phone, pc.mobile, pp.seller_id FROM "erp_catalog__contact_person" p
       JOIN "erp_catalog__record" pr ON pr.id=p.person_id JOIN "erp_catalog__contact" pc ON pc.record_id=pr.id
       LEFT JOIN "erp_catalog__contact_profile" pp ON pp.record_id=pr.id WHERE p.contact_id=? ORDER BY p.position`,
      id,
    )
    .rows.map((x) => {
      const visible = scope === null || x.seller_id === scope;
      return {
        id: x.id,
        name: x.name,
        code: x.code ?? null,
        situation: contactSituationOf(db, String(x.id)),
        visible,
        email: visible ? (x.email ?? null) : null,
        phone: visible ? (x.phone ?? null) : null,
        mobile: visible ? (x.mobile ?? null) : null,
      };
    });
  return {
    scope: "contact_summary",
    data_mode: "erp_native",
    id: r.id,
    name: r.name,
    code: r.code ?? null,
    situation: contactSituationOf(db, id),
    notes: r.notes ?? null,
    contact_info: r.contact_info ?? null,
    persons,
  };
}

registerRpc("erp_catalog_contact_summary", erpCatalogContactSummary);
