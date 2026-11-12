import { batch, one } from "./db";
import { access, admin } from "./security";
import { ApiError, type Actor, type Env } from "./types";

const phoneDependencies = `
  EXISTS(SELECT 1 FROM meta_numbers WHERE account_id=?)
  OR EXISTS(
    SELECT 1 FROM connections
    WHERE json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END,'$.zernio_workspace_id')=?
  )`;

const poolDependencies = `
  EXISTS(
    SELECT 1 FROM number_pools p WHERE p.account_id=? AND (
      p.profile_id!=? OR p.enabled!=0 OR coalesce(p.public_token,'')!=''
      OR EXISTS(SELECT 1 FROM number_pool_members WHERE pool_id=p.id)
      OR EXISTS(SELECT 1 FROM number_router_grants WHERE source_type='pool' AND source_id=p.id)
      OR EXISTS(SELECT 1 FROM router_affinities WHERE source_type='pool' AND source_id=p.id)
      OR EXISTS(
        SELECT 1 FROM outbox
        WHERE json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.router_source.type')='pool'
          AND json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.router_source.id')=p.id
      )
      OR EXISTS(
        SELECT 1 FROM pairing_requests r,json_each(CASE WHEN json_valid(r.grants) THEN r.grants ELSE '{}' END,'$.pool_ids') ids
        WHERE ids.value=p.id
      )
    )
  )`;

const inUse = () =>
  new ApiError(
    409,
    "integration_in_use",
    "A integração ainda possui telefones ou grupos com vínculos. Remova os telefones e revise os grupos; grupos com histórico ou permissões não são excluídos automaticamente.",
  );

/** Remove only an unused local integration and its credentials.
 * Run through the area's Coordinator, serialized with imports and pool edits.
 * No provider API is called, and historical conversations/deliveries are kept.
 */
export async function removeIntegration(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  access(actor, profile, "routing:read");
  admin(actor);
  const account = await one(
    env,
    "SELECT id FROM meta_accounts WHERE id=? AND profile_id=?",
    id,
    profile,
  );
  if (!account)
    throw new ApiError(
      404,
      "not_found",
      "Integração não encontrada nesta área de atendimento.",
    );
  if (
    (
      await one(
        env,
        `SELECT ((${phoneDependencies}) OR (${poolDependencies})) AS in_use`,
        id,
        id,
        id,
        profile,
      )
    ).in_use
  )
    throw inUse();

  const results = await batch(env, [
    [
      // Only truly unused, disabled pools are housekeeping. Guard the whole
      // integration so a new phone or one protected pool prevents partial work.
      `DELETE FROM number_pools WHERE account_id=? AND profile_id=?
        AND EXISTS(SELECT 1 FROM meta_accounts WHERE id=? AND profile_id=?)
        AND NOT (${phoneDependencies}) AND NOT (${poolDependencies})`,
      [id, profile, id, profile, id, id, id, profile],
    ],
    [
      `DELETE FROM meta_accounts WHERE id=? AND profile_id=?
        AND NOT (${phoneDependencies})
        AND NOT EXISTS(SELECT 1 FROM number_pools WHERE account_id=?)`,
      [id, profile, id, id, id],
    ],
    [
      // changes() ties credential deletion to the preceding account deletion.
      // A concurrently added dependency must preserve both the row and keys.
      "DELETE FROM secrets WHERE id IN (?,?) AND changes()>0",
      [`meta-account:${id}`, `zernio-account:${id}`],
    ],
  ]);
  if (!(results[1].meta.changes > 0)) throw inUse();
  return { id, deleted: true };
}
