// Identidade para o diferencial do Acesso: o envelope (engine/identity.ts)
// montado a partir do auth.* do oráculo, para os dois motores verem as mesmas
// pessoas, sessões e fatores. Fica fora de tests/erp/harness/ (em revisão pela
// sessão L); quando o harness ganhar a porta, isto passa para lá.
import { callRpc } from "../../../src/erp/engine/registry.ts";

/** Envelope a partir do Postgres: pessoas da área e a sessão de quem chama. */
export async function pgIdentity(pg, user, session = null) {
  const people = (
    await pg.query(
      `select u.id::text user_id, lower(u.email) email, p.name, case when m.active then m.role end erp_role,
        exists(select 1 from auth.mfa_factors f where f.user_id=u.id and f.status='verified' and f.factor_type='totp') verified_factor
       from auth.users u left join erp_access.membership m on m.user_id=u.id left join erp_access.profile p on p.user_id=u.id`,
    )
  ).rows;
  const me = people.find((p) => p.user_id === user) ?? null;
  const aal = session
    ? (await pg.query("select aal from auth.sessions where id=$1 and user_id=$2 and (not_after is null or not_after>clock_timestamp())", [session, user])).rows[0]?.aal ?? null
    : null;
  return {
    actor: me ? { ...me, session_id: aal ? session : null, aal: aal === "aal2" ? "aal2" : "aal1", is_agent: false } : null,
    people,
  };
}

/** Objetos do armazenamento do oráculo na forma da listagem do R2. */
export async function pgListing(pg) {
  return (await pg.query("select bucket_id bucket, name, (metadata->>'size')::bigint size from storage.objects")).rows.map((r) => ({ ...r, size: Number(r.size) }));
}

/** RPC nos dois motores, com o envelope de identidade e a listagem tirados do oráculo. */
export async function rpcAs(f, name, args, { session = null } = {}) {
  const identity = await pgIdentity(f.db, args.p_user_id ?? null, session ?? args.p_session_id ?? null);
  const listing = await pgListing(f.db);
  const entries = Object.entries(args);
  return f.dual(
    name,
    async () => {
      await f.db.exec("set role service_role");
      try {
        return (
          await f.db.query(
            `select public.${name}(${entries.map(([k], i) => `${k}=>$${i + 1}`).join(",")}) v`,
            entries.map(([, v]) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v)),
          )
        ).rows[0]?.v;
      } finally {
        await f.db.exec("reset role");
      }
    },
    () => callRpc(f.driver, name, structuredClone(args), f.clock, { objects: f.objectLookup, listing, identity }),
  );
}
