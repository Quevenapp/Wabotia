import { batch } from "./db";
import { admin } from "./security";
import { defaults, now, uid, type Actor, type Env } from "./types";

// Keep this statement inside the first administrator's transaction so a failed
// setup cannot leave an area behind. The predicate also serializes concurrent
// bootstrap requests without replacing or selecting any legacy area.
export function installationAreaInsert(
  id = uid(),
  created = now(),
): [string, any[]] {
  return [
    "INSERT INTO profiles(id,name,settings,enabled,created) SELECT ?,?,?,0,? WHERE NOT EXISTS(SELECT 1 FROM profiles)",
    [id, "Área de atendimento", JSON.stringify(defaults), created],
  ];
}

export async function ensureInstallationArea(
  env: Env,
  actor: Actor,
  requestId = "",
): Promise<{ created: boolean; profile_id: string | null }> {
  admin(actor);
  const id = uid(),
    created = now();
  const results = await batch(env, [
    installationAreaInsert(id, created),
    [
      "INSERT INTO audit(profile_id,actor,operation,resource_id,request_id,created) SELECT id,?,'installation.area.bootstrap',id,?,? FROM profiles WHERE id=?",
      [actor.id, requestId, created, id],
    ],
  ]);
  const inserted = (results[0].meta.changes || 0) > 0;
  // The caller reloads its authorized profile list. Existing areas and grants
  // remain untouched, including installations with multiple legacy areas.
  return { created: inserted, profile_id: inserted ? id : null };
}
