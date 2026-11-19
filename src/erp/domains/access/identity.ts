// Acesso: o que no Fagoo vinha de auth.* passa pela porta de identidade
// (engine/identity.ts). Diferença estrutural registrada em
// src/erp/schema/structural.ts.
//
// Projeção (antes de todo RPC, quando o envelope traz as pessoas):
// erp_access.membership e profile seguem o Wabotia. Papel = erp:<papel> da
// pessoa; quem não tem papel fica inativo (a linha fica, com o último papel);
// nome do perfil = nome da pessoa. Nenhum RPC grava papel. Só escreve o que
// mudou, e pula tudo quando o diretório é o mesmo da última vez.
import { createHash } from "node:crypto";
import { one, type SqlDriver } from "../../engine/driver.ts";
import { CUSTOMER_BRIDGE_USER_ID, type ErpPerson } from "../../engine/identity.ts";
import { registerBeforeRpc, type RpcContext } from "../../engine/registry.ts";
import { pgBtrim, pgHasCntrl, pgLeft } from "../../engine/text.ts";

const hashOf = (people: ErpPerson[]) =>
  createHash("sha256")
    .update(JSON.stringify([...people].sort((a, b) => (a.user_id < b.user_id ? -1 : 1)).map((p) => [p.user_id, p.erp_role, p.name, p.is_technical === true])))
    .digest("hex");

/** Nome aceito pelo CHECK de erp_access.profile (1–120, sem espaço nas pontas, sem controle), ou null. */
function profileName(name: string | null): string | null {
  if (name === null) return null;
  const n = pgLeft(pgBtrim(name), 120);
  return n === "" || pgHasCntrl.test(n) ? null : n;
}

export function projectPeople(ctx: RpcContext) {
  // Metadado já existente; conserva a natureza técnica mesmo quando a
  // identidade deixa de integrar o diretório ativo. O ID da ponte é registrado.
  const technical = [...(ctx.identity.people ?? []), ...(ctx.identity.actor ? [ctx.identity.actor] : [])]
    .filter((p) => p.is_technical === true);
  if (technical.length) ctx.db.exec("CREATE TABLE IF NOT EXISTS erp_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
  for (const p of technical)
    ctx.db.exec("INSERT OR IGNORE INTO erp_meta(key,value) VALUES(?,'1')", `technical_user:${p.user_id}`);
  const people = ctx.identity.people;
  if (!people) return;
  const db = ctx.db;
  db.exec("CREATE TABLE IF NOT EXISTS erp_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
  const hash = hashOf(people);
  if (one(db, "SELECT value FROM erp_meta WHERE key='identity_hash'")?.value === hash) return;
  const now = () => ctx.clock.next().toString();
  const byId = new Map(people.map((p) => [p.user_id, p]));
  for (const p of people) {
    const m = one(db, 'SELECT role, active FROM "erp_access__membership" WHERE user_id=?', p.user_id);
    if (p.erp_role) {
      if (!m) db.exec('INSERT INTO "erp_access__membership"(user_id, role, active, created_at, updated_at) VALUES(?,?,1,?,?)', p.user_id, p.erp_role, now(), now());
      else if (m.role !== p.erp_role || !m.active)
        db.exec('UPDATE "erp_access__membership" SET role=?, active=1, updated_at=? WHERE user_id=?', p.erp_role, now(), p.user_id);
    } else if (m?.active) db.exec('UPDATE "erp_access__membership" SET active=0, updated_at=? WHERE user_id=?', now(), p.user_id);
    const name = profileName(p.name);
    if (name !== null) {
      const pr = one(db, 'SELECT name FROM "erp_access__profile" WHERE user_id=?', p.user_id);
      if (!pr) db.exec('INSERT INTO "erp_access__profile"(user_id, name, version, updated_at, updated_by) VALUES(?,?,1,?,?)', p.user_id, name, now(), p.user_id);
      else if (pr.name !== name)
        db.exec('UPDATE "erp_access__profile" SET name=?, version=version+1, updated_at=?, updated_by=? WHERE user_id=?', name, now(), p.user_id, p.user_id);
    }
  }
  for (const m of db.exec('SELECT user_id FROM "erp_access__membership" WHERE active=1').rows)
    if (!byId.has(String(m.user_id))) db.exec('UPDATE "erp_access__membership" SET active=0, updated_at=? WHERE user_id=?', now(), m.user_id);
  db.exec("INSERT INTO erp_meta(key, value) VALUES('identity_hash', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", hash);
}

registerBeforeRpc(projectPeople);

export function isTechnicalUser(db: SqlDriver, id: string | null): boolean {
  return id !== null && (id === CUSTOMER_BRIDGE_USER_ID ||
    (!!one(db, "SELECT 1 x FROM sqlite_master WHERE type='table' AND name='erp_meta'") &&
      !!one(db, "SELECT 1 x FROM erp_meta WHERE key=?", `technical_user:${id}`)));
}

/** A pessoa existe? (auth.users no Fagoo). Sem diretório no envelope: quem já está em membership ou profile. */
export function personExists(ctx: RpcContext, id: string | null): boolean {
  if (!id) return false;
  const people = ctx.identity.people;
  if (people) return people.some((p) => p.user_id === id);
  if (ctx.identity.actor?.user_id === id) return true;
  return !!one(ctx.db, 'SELECT 1 x FROM "erp_access__membership" WHERE user_id=? UNION SELECT 1 FROM "erp_access__profile" WHERE user_id=?', id, id);
}

/** E-mail da pessoa (auth.users.email), em minúsculas pelo lower do Postgres no chamador. */
export function personEmail(ctx: RpcContext, id: string): string | null {
  const p = ctx.identity.people?.find((x) => x.user_id === id) ?? (ctx.identity.actor?.user_id === id ? ctx.identity.actor : null);
  return p?.email ?? null;
}

/** erp_access.has_verified_factor: fator TOTP verificado (núcleo). */
export function hasVerifiedFactor(ctx: RpcContext, id: string | null): boolean {
  if (!id) return false;
  const p = ctx.identity.people?.find((x) => x.user_id === id) ?? (ctx.identity.actor?.user_id === id ? ctx.identity.actor : null);
  return p?.verified_factor === true;
}

/** erp_access.session_aal2(p_user, p_session): a sessão de quem chama alcançou aal2. */
export function sessionAal2(ctx: RpcContext, user: string | null, session: string | null): boolean {
  const a = ctx.identity.actor;
  return !!user && !!session && !!a && a.user_id === user && a.session_id === session && a.aal === "aal2";
}

export type { SqlDriver };
