// Contatos: escopo do vendedor e situação (erp_catalog.contact_scope,
// contact_situation, contact_source_situation, contact_situation_of).
// contact_source_situation lia a situação do contato espelhado do Origin
// (erp_catalog.origin + source_snapshot.payload->>'situacao'). Com o Origin
// desligado (desvio origin-fora) não há contato espelhado: devolve sempre
// null, e a situação vem só do perfil nativo (contact_profile.situation).
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import * as preferences from "../preferences/public.ts";
import { activeRole } from "../access/public.ts";

/**
 * erp_catalog.contact_scope(p_user_id): o vendedor ao qual o usuário está
 * preso quando "Contato acessível somente ao vendedor vinculado" está ligado;
 * null sem a preferência, para administrador, sem vínculo ativo ou sem vendedor.
 */
export function contactScope(db: SqlDriver, user: string | null): string | null {
  if (preferences.get(db, "contatos.acesso_vendedor") !== true) return null;
  const role = user === null ? null : activeRole(db, user);
  if (role === null || role === "admin") return null;
  const s = one(db, 'SELECT id FROM "erp_catalog__seller" WHERE user_id=?', user);
  return s ? String(s.id) : null;
}

/** erp_catalog.contact_visible_to(p_scope, p_id): sem escopo vê tudo; com escopo, só a carteira do vendedor. */
export function contactVisibleTo(db: SqlDriver, scope: string | null, id: string | null): boolean {
  if (scope === null) return true;
  return !!one(db, 'SELECT 1 x FROM "erp_catalog__contact_profile" WHERE record_id=? AND seller_id=?', id, scope);
}

/** erp_catalog.contact_require_visible(p_user_id, p_id): 42501 fora da carteira do vendedor. */
export function contactRequireVisible(db: SqlDriver, user: string | null, id: string | null) {
  const scope = contactScope(db, user);
  if (scope !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__contact_profile" WHERE record_id=? AND seller_id=?', id, scope))
    raise("42501", "erp_catalog_contact_not_visible");
}

/** erp_catalog.contact_situation(p_active, p_detail): A, S, I ou E. */
export function contactSituation(active: boolean | null, detail: string | null): string {
  if (active) return detail === "S" ? "S" : "A";
  return detail === "E" ? "E" : "I";
}

/** erp_catalog.contact_source_situation(p_id): só do Origin; desligado, sempre null. */
export const contactSourceSituation = (_db: SqlDriver, _id: string | null): string | null => null;

/** erp_catalog.contact_situation_of(p_id): situação do contato (null se não é contato). */
export function contactSituationOf(db: SqlDriver, id: string | null): string | null {
  if (id === null) return null;
  const r = one(
    db,
    `SELECT r.active, cp.situation FROM "erp_catalog__record" r
     LEFT JOIN "erp_catalog__contact_profile" cp ON cp.record_id=r.id WHERE r.id=? AND r.entity='contacts'`,
    id,
  );
  if (!r) return null;
  return contactSituation(!!Number(r.active), (r.situation as string | null) ?? contactSourceSituation(db, id));
}
