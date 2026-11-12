import { all, batch, one } from "./db";
import { access, admin } from "./security";
import {
  ApiError,
  type Actor,
  type Env,
  json,
  now,
  requireValue,
} from "./types";

/** Remove a local phone connection without deleting its provider account or history.
 * Commands run inside the profile coordinator, serialized with sends and webhooks.
 */
export async function removeConnection(
  env: Env,
  actor: Actor,
  profile: string,
  id: string,
) {
  access(actor, profile, "conversations:write");
  admin(actor);
  const connection = await one(
    env,
    "SELECT * FROM connections WHERE id=? AND profile_id=?",
    id,
    profile,
  );
  if (!connection)
    throw new ApiError(
      404,
      "not_found",
      "Telefone não encontrado neste perfil.",
    );
  requireValue(
    ["meta", "zernio", "qr", "hermes-whatsapp"].includes(connection.kind),
    "A exclusão está disponível somente para conexões de telefone WhatsApp.",
  );
  if (
    await one(
      env,
      "SELECT id FROM outbox WHERE connection_id=? AND status IN ('sending','unknown') LIMIT 1",
      id,
    )
  )
    throw new ApiError(
      409,
      "connection_busy",
      "Aguarde os envios em andamento ou reconcilie as mensagens sem confirmação antes de excluir o telefone.",
    );
  if (
    await one(
      env,
      "SELECT id FROM calls WHERE connection_id=? AND status NOT IN ('completed','failed','rejected','missed') LIMIT 1",
      id,
    )
  )
    throw new ApiError(
      409,
      "connection_busy",
      "Encerre ou reconcilie as ligações antes de excluir o telefone.",
    );
  if (
    await one(
      env,
      "SELECT id FROM group_operations WHERE connection_id=? AND status IN ('sending','unknown') LIMIT 1",
      id,
    )
  )
    throw new ApiError(
      409,
      "connection_busy",
      "Aguarde as operações de grupos em andamento ou reconcilie as que estão sem confirmação antes de excluir o telefone.",
    );
  requireValue(
    !(await one(env, "SELECT id FROM bots WHERE connection_id=? LIMIT 1", id)),
    "Esta conexão possui bots vinculados e não pode ser excluída como telefone.",
  );

  const time = now();
  const conversations = await one(
    env,
    "SELECT count(*) AS n FROM conversations WHERE connection_id=?",
    id,
  );
  const statements: [string, any[]][] = [];
  // An empty bot line list means no lines; NULL means every line. Keep that distinction.
  for (const bot of await all(
    env,
    "SELECT id,line_ids FROM bots WHERE profile_id=? AND line_ids IS NOT NULL",
    profile,
  )) {
    const lines = json(bot.line_ids, []);
    if (Array.isArray(lines) && lines.includes(id))
      statements.push([
        "UPDATE bots SET line_ids=? WHERE id=?",
        [JSON.stringify(lines.filter((line) => line !== id)), bot.id],
      ]);
  }
  const row = await one(
    env,
    "SELECT settings FROM profiles WHERE id=?",
    profile,
  );
  const settings = json(row?.settings);
  let changed = false;
  for (const menu of settings.menus || []) {
    if (!Array.isArray(menu.line_ids) || !menu.line_ids.includes(id)) continue;
    menu.line_ids = menu.line_ids.filter((line: string) => line !== id);
    // Empty menu line lists mean all lines, so do not silently broaden a removed line's menu.
    if (menu.line_ids.length === 0) menu.enabled = false;
    changed = true;
  }
  if (changed)
    statements.push([
      "UPDATE profiles SET settings=? WHERE id=?",
      [JSON.stringify(settings), profile],
    ]);
  statements.push(
    [
      "UPDATE outbox SET status='cancelled',error='Telefone excluído antes do envio.',updated=? WHERE connection_id=? AND status='pending'",
      [time, id],
    ],
    [
      "UPDATE group_operations SET status='cancelled',error='Telefone excluído antes da execução.',updated=? WHERE connection_id=? AND status='pending'",
      [time, id],
    ],
    [
      "UPDATE inbox SET status='done' WHERE status='pending' AND conversation_id IN (SELECT id FROM conversations WHERE connection_id=?)",
      [id],
    ],
    [
      "UPDATE bot_runs SET status='cancelled',error='Telefone excluído.',updated=? WHERE status='queued' AND conversation_id IN (SELECT id FROM conversations WHERE connection_id=?)",
      [time, id],
    ],
    [
      "UPDATE number_pools SET enabled=0,public_token=NULL WHERE profile_id=? AND id IN (SELECT pool_id FROM number_pool_members WHERE connection_id=?) AND NOT EXISTS(SELECT 1 FROM number_pool_members m WHERE m.pool_id=number_pools.id AND m.connection_id!=?)",
      [profile, id, id],
    ],
    ["DELETE FROM number_pool_members WHERE connection_id=?", [id]],
    [
      "DELETE FROM number_router_grants WHERE profile_id=? AND source_type='number' AND source_id=?",
      [profile, id],
    ],
    ["DELETE FROM router_affinities WHERE connection_id=?", [id]],
    ["DELETE FROM meta_numbers WHERE connection_id=?", [id]],
    ["DELETE FROM call_permissions WHERE connection_id=?", [id]],
    ["DELETE FROM team_connection_presence WHERE connection_id=?", [id]],
    ["DELETE FROM secrets WHERE id=?", [`connection:${id}`]],
    [
      "UPDATE conversations SET connection_id=NULL,state='closed',owner=NULL,assigned_bot_id=NULL,epoch=epoch+1,menu_active=0,menu_manual=0,menu_token=NULL,menu_expires_at=NULL,menu_items='[]',updated=? WHERE connection_id=?",
      [time, id],
    ],
    ["DELETE FROM connections WHERE id=? AND profile_id=?", [id, profile]],
  );
  await batch(env, statements);
  return { id, deleted: true, conversations_preserved: conversations.n };
}
