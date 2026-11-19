// Contatos: escopo do vendedor e situação (erp_catalog.contact_scope,
// contact_situation, contact_source_situation, contact_situation_of).
// contact_source_situation lê a situação do contato espelhado do Origin
// (erp_catalog.origin + source_snapshot.payload->>'situacao'): regra "Origin
// fora", leitura de linha espelhada se porta como leitura.
import { one, type SqlDriver } from "../../engine/driver.ts";
import { raise } from "../../engine/errors.ts";
import * as preferences from "../preferences/public.ts";
import { activeRole } from "../access/public.ts";
import { isTechnicalUser } from "../access/identity.ts";
import { registerBeforeRpc } from "../../engine/registry.ts";

// Contexto síncrono por RPC, reiniciado inclusive quando o envelope não traz
// restrições. Não persiste política D1 no SQLite nem mistura requisições.
const restrictedContacts = new WeakMap<SqlDriver, ReadonlySet<string>>();
registerBeforeRpc((ctx) => restrictedContacts.set(ctx.db, new Set(ctx.identity.customer_privacy?.restricted_contact_ids ?? [])));
export const contactRestrictedIds = (db: SqlDriver): ReadonlySet<string> => restrictedContacts.get(db) ?? new Set();
export const contactPrivacyVisible = (db: SqlDriver, id: string | null): boolean => id === null || !contactRestrictedIds(db).has(id);
export function contactRequirePrivacy(db: SqlDriver, id: string | null) {
  if (!contactPrivacyVisible(db, id)) raise("42501", "erp_customer_restricted");
}

/**
 * erp_catalog.contact_scope(p_user_id): o vendedor ao qual o usuário está
 * preso quando "Contato acessível somente ao vendedor vinculado" está ligado;
 * null sem a preferência, para administrador, sem vínculo ativo ou sem vendedor.
 */
export function contactScope(db: SqlDriver, user: string | null): string | null {
  if (isTechnicalUser(db, user)) return null;
  if (preferences.get(db, "contatos.acesso_vendedor") !== true) return null;
  const role = user === null ? null : activeRole(db, user);
  if (role === null || role === "admin") return null;
  const s = one(db, 'SELECT id FROM "erp_catalog__seller" WHERE user_id=?', user);
  return s ? String(s.id) : null;
}

/** erp_catalog.contact_visible_to(p_scope, p_id): sem escopo vê tudo; com escopo, só a carteira do vendedor. */
export function contactVisibleTo(db: SqlDriver, scope: string | null, id: string | null): boolean {
  if (!contactPrivacyVisible(db, id)) return false;
  if (scope === null) return true;
  return !!one(db, 'SELECT 1 x FROM "erp_catalog__contact_profile" WHERE record_id=? AND seller_id=?', id, scope);
}

/** erp_catalog.contact_require_visible(p_user_id, p_id): 42501 fora da carteira do vendedor. */
export function contactRequireVisible(db: SqlDriver, user: string | null, id: string | null) {
  contactRequirePrivacy(db, id);
  const scope = contactScope(db, user);
  if (scope !== null && !one(db, 'SELECT 1 x FROM "erp_catalog__contact_profile" WHERE record_id=? AND seller_id=?', id, scope))
    raise("42501", "erp_catalog_contact_not_visible");
}

/** erp_catalog.contact_situation(p_active, p_detail): A, S, I ou E. */
export function contactSituation(active: boolean | null, detail: string | null): string {
  if (active) return detail === "S" ? "S" : "A";
  return detail === "E" ? "E" : "I";
}

/** SQL de erp_catalog.contact_source_situation para a expressão de id `record` (a situação no payload do snapshot aplicado). */
export const SOURCE_SITUATION_SQL = (record: string) =>
  `(SELECT json_extract(s.payload,'$.situacao') FROM "erp_catalog__origin" o JOIN "erp_catalog__source_snapshot" s
    ON s.entity=o.entity AND s.source_id=o.source_id AND s.source_hash=o.applied_hash
    WHERE o.record_id=${record} AND o.entity='contacts')`;

/** erp_catalog.contact_source_situation(p_id): a situação do contato espelhado (payload->>'situacao'), ou null. */
export function contactSourceSituation(db: SqlDriver, id: string | null): string | null {
  if (id === null) return null;
  const r = one(db, `SELECT ${SOURCE_SITUATION_SQL("?")} v`, id);
  const v = r?.v;
  return v === null || v === undefined ? null : typeof v === "string" ? v : JSON.stringify(v);
}

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
