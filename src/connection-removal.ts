import { all, batch, one } from "./db";
import { access, admin } from "./security";
import { refreshChannelSummaryStatements } from "./channel-accounts";
import { channelConnectionDriver } from "./channel-extension-registry";
import { channelNotReady } from "./channel-extension-stubs";
import {
  ApiError,
  type Actor,
  type Env,
  json,
  now,
  requireValue,
} from "./types";

/** Remove a local connection without deleting its provider account or history.
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
    "SELECT *,kind IN ('hermes','hermes-whatsapp') AS retired_kind FROM connections WHERE id=? AND profile_id=?",
    id,
    profile,
  );
  if (!connection)
    throw new ApiError(
      404,
      "not_found",
      "Telefone não encontrado nesta área de atendimento.",
    );
  return finishConnectionRemoval(env, actor, profile, id, connection);
}

/** A retomada usa somente a intenção de remoção já persistida por administrador. */
async function finishConnectionRemoval(env: Env, actor: Actor, profile: string, id: string, connection: any) {
  if (connection.kind === "ai" || (connection.retired_kind && !connection.kind.endsWith("-whatsapp")))
    return removeBotConnection(env, profile, connection);
  if (connection.kind === "telegram") {
    // Leftover of the removed Telegram channel: nothing depends on it anymore.
    await batch(env, [
      ["DELETE FROM secrets WHERE id=?", [`connection:${id}`]],
      ["DELETE FROM connections WHERE id=? AND profile_id=?", [id, profile]],
    ]);
    return { id, deleted: true, conversations_preserved: 0 };
  }
  const ownChannel = connection.kind === "telegram_bot" || connection.kind === "email";
  if (ownChannel) {
    const driver = channelConnectionDriver(connection.channel);
    if (!driver) channelNotReady();
    // Pausa persiste antes da limpeza remota. Falha conserva credencial no cofre para retomar.
    await batch(env, [["UPDATE connections SET status='paused',config=json_set(config,'$.remove_pending',1) WHERE id=? AND profile_id=?", [id, profile]]]);
    try {
      const result = await driver.remove({ env, actor, profileId: profile, connection: { ...connection, status: "paused" }, input: {}, commandId: `remove:${id}`, now: now() });
      if (result.status !== "paused" || result.configured) return { id, deleted: false, pending: true };
    } catch {
      // Falha remota conserva a intenção e o segredo, sem propagar corpo/URL do fornecedor.
      return { id, deleted: false, pending: true };
    }
  }
  requireValue(
    ["meta", "zernio", "qr"].includes(connection.kind) || connection.retired_kind || ownChannel,
    "A exclusão está disponível somente para conexões de telefone WhatsApp.",
  );
  const social = connection.channel && connection.channel !== "whatsapp";
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
      social
        ? "Aguarde os envios em andamento ou reconcilie as mensagens sem confirmação antes de excluir a conexão."
        : "Aguarde os envios em andamento ou reconcilie as mensagens sem confirmação antes de excluir o telefone.",
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
  // Guardar a origem antes de neutralizar a FK: até conversas anteriores à
  // gravação explícita de canais continuam identificáveis no histórico.
  statements.push([
    `UPDATE conversations SET channel=COALESCE(channel,?),
      account_label=CASE WHEN account_label='' THEN ? ELSE account_label END,
      channel_account_id=COALESCE(channel_account_id,?) WHERE connection_id=?
      AND external_namespace='channel:'||connection_id AND chat_type NOT IN ('team','internal')`,
    [connection.channel || "whatsapp", connection.account_label || "", json(connection.config).account_id || null, id],
  ]);
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
      "UPDATE outbox SET status='cancelled',error=?,updated=? WHERE connection_id=? AND status='pending'",
      [social ? "Conexão excluída antes do envio." : "Telefone excluído antes do envio.", time, id],
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
      "UPDATE bot_runs SET status='cancelled',error=?,updated=? WHERE status='queued' AND conversation_id IN (SELECT id FROM conversations WHERE connection_id=?)",
      [social ? "Conexão excluída." : "Telefone excluído.", time, id],
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
    ["DELETE FROM zernio_channel_accounts WHERE connection_id=? AND profile_id=?", [id, profile]],
    [
      "UPDATE customer_channel_ids SET connection_id=NULL WHERE connection_id=? AND profile_id=?",
      [id, profile],
    ],
    ["DELETE FROM call_permissions WHERE connection_id=?", [id]],
    ["DELETE FROM team_connection_presence WHERE connection_id=?", [id]],
    ...(ownChannel ? [
      ["DELETE FROM email_channel_addresses WHERE connection_id=? AND profile_id=?", [id, profile]],
      ["DELETE FROM email_channel_probes WHERE connection_id=? AND profile_id=?", [id, profile]],
      ["DELETE FROM telegram_callbacks WHERE connection_id=? AND profile_id=?", [id, profile]],
    ] as [string, unknown[]][] : []),
    ["DELETE FROM secrets WHERE id=?", [`connection:${id}`]],
    [
      "UPDATE conversations SET connection_id=NULL,state='closed',owner=NULL,assigned_bot_id=NULL,epoch=epoch+1,menu_active=0,menu_manual=0,menu_token=NULL,menu_expires_at=NULL,menu_items='[]',updated=? WHERE connection_id=?",
      [time, id],
    ],
    ["DELETE FROM connections WHERE id=? AND profile_id=?", [id, profile]],
    ...refreshChannelSummaryStatements(profile),
  );
  await batch(env, statements);
  return { id, deleted: true, conversations_preserved: conversations.n };
}

/**
 * Exclui uma conexão de bots e os bots dela. Recusa
 * enquanto algum desses bots ainda atende: a pessoa escolhe o substituto antes,
 * em vez de o atendimento mudar sem aviso. Conversas, mensagens e execuções
 * anteriores ficam no histórico.
 */
async function removeBotConnection(env: Env, profile: string, connection: any) {
  const id = connection.id;
  requireValue(
    connection.status === "paused",
    "Pause a conexão antes de excluir.",
  );
  const bots = await all(
    env,
    "SELECT id,name FROM bots WHERE connection_id=?",
    id,
  );
  const ids = bots.map((bot) => bot.id as string);
  const name = (botId: string) =>
    bots.find((bot) => bot.id === botId)?.name || botId;
  const row = await one(
    env,
    "SELECT settings FROM profiles WHERE id=?",
    profile,
  );
  const settings = json(row?.settings);
  const uses: string[] = [];
  if (ids.includes(settings.attendant_bot))
    uses.push(`${name(settings.attendant_bot)} é o Bot Atendente`);
  for (const action of settings.capabilities || [])
    if (ids.includes(action.bot_id))
      uses.push(
        `${name(action.bot_id)} é o especialista da ação "${action.name}"`,
      );
  for (const menu of settings.menus || [])
    if (menu.type === "bot" && ids.includes(menu.bot_id))
      uses.push(`${name(menu.bot_id)} está no item de menu "${menu.label}"`);
  for (const line of await all(
    env,
    "SELECT name,config FROM connections WHERE profile_id=? AND id!=?",
    profile,
    id,
  )) {
    const service = json(line.config).service;
    if (service?.mode === "bot" && ids.includes(service.bot_id))
      uses.push(`${name(service.bot_id)} atende a linha ${line.name}`);
  }
  if (uses.length)
    throw new ApiError(
      409,
      "connection_in_use",
      `Antes de excluir, troque ou remova: ${uses.join("; ")}.`,
    );
  if (ids.length) {
    const list = JSON.stringify(ids);
    if (
      await one(
        env,
        "SELECT id FROM conversations WHERE state='ai' AND assigned_bot_id IN (SELECT value FROM json_each(?)) LIMIT 1",
        list,
      )
    )
      throw new ApiError(
        409,
        "connection_in_use",
        "Há conversas sendo atendidas por um bot desta conexão. Transfira-as ou encerre-as antes de excluir.",
      );
    if (
      await one(
        env,
        "SELECT id FROM bot_runs WHERE status IN ('starting','running','cancelling') AND bot_id IN (SELECT value FROM json_each(?)) LIMIT 1",
        list,
      )
    )
      throw new ApiError(
        409,
        "connection_busy",
        "Aguarde as execuções de bots em andamento antes de excluir.",
      );
  }
  const time = now();
  const list = JSON.stringify(ids);
  const statements: [string, any[]][] = [
    [
      "UPDATE bot_runs SET status='cancelled',error='Conexão excluída.',updated=? WHERE status='queued' AND bot_id IN (SELECT value FROM json_each(?))",
      [time, list],
    ],
    [
      "UPDATE conversations SET assigned_bot_id=NULL WHERE assigned_bot_id IN (SELECT value FROM json_each(?))",
      [list],
    ],
  ];
  // Sistemas pareados guardam a lista de bots que podem consultar.
  for (const app of await all(env, "SELECT id,bots FROM applications")) {
    const allowed = json(app.bots, []);
    if (Array.isArray(allowed) && allowed.some((bot) => ids.includes(bot)))
      statements.push([
        "UPDATE applications SET bots=? WHERE id=?",
        [
          JSON.stringify(allowed.filter((bot) => !ids.includes(bot))),
          app.id,
        ],
      ]);
  }
  statements.push(
    ["DELETE FROM team_connection_presence WHERE connection_id=?", [id]],
    ["DELETE FROM artifact_imports WHERE connection_id=?", [id]],
    ["DELETE FROM bots WHERE connection_id=?", [id]],
    ["DELETE FROM secrets WHERE id=?", [`connection:${id}`]],
    ["DELETE FROM connections WHERE id=? AND profile_id=?", [id, profile]],
  );
  await batch(env, statements);
  return { id, deleted: true, bots_removed: ids.length };
}

/** Limpeza interna do cron: só conexões pausadas e marcadas pela migração.
 * Não recebe ator nem dados da API. Cada falha fica para a próxima rodada.
 */
export async function removePendingConnections(env: Env, profileId?: string) {
  for (const connection of await all(
    env,
    "SELECT * FROM connections WHERE status='paused' AND json_extract(config,'$.remove_pending')=1" +
      (profileId === undefined ? "" : " AND profile_id=?"),
    ...(profileId === undefined ? [] : [profileId]),
  )) {
    try {
      const profile = connection.profile_id;
      if (connection.kind === "telegram_bot" || connection.kind === "email") {
        const actor: Actor = { id: "channel:maintenance", kind: "connector", role: "service",
          name: "Manutenção de canal", profiles: [profile], scopes: [], bots: [], rate: 0, runLimit: 0 };
        await finishConnectionRemoval(env, actor, profile, connection.id, connection);
        continue;
      }
      const bots = await all(
        env,
        "SELECT id FROM bots WHERE connection_id=?",
        connection.id,
      );
      const ids = bots.map((bot) => bot.id);
      const list = JSON.stringify(ids);
      const row = await one(
        env,
        "SELECT settings FROM profiles WHERE id=?",
        profile,
      );
      const settings = json(row?.settings);
      if (ids.includes(settings.attendant_bot)) delete settings.attendant_bot;
      settings.capabilities = (settings.capabilities || []).filter(
        (item: any) => !ids.includes(item.bot_id),
      );
      settings.menus = (settings.menus || []).filter(
        (item: any) => item.type !== "bot" || !ids.includes(item.bot_id),
      );
      // O lote preserva o histórico e desliga referências que já não podem executar.
      await batch(env, [
        [
          "UPDATE profiles SET settings=? WHERE id=?",
          [JSON.stringify(settings), profile],
        ],
        [
          "UPDATE connections SET config=json_set(config,'$.service.mode','inherit','$.service.bot_id',NULL) WHERE profile_id=? AND json_extract(config,'$.service.bot_id') IN (SELECT value FROM json_each(?))",
          [profile, list],
        ],
        ["UPDATE bots SET enabled=0 WHERE connection_id=?", [connection.id]],
        [
          "UPDATE bot_runs SET status='cancelled',error='Conexão retirada.',updated=? WHERE bot_id IN (SELECT value FROM json_each(?)) AND status IN ('queued','starting','running','cancelling','unknown')",
          [now(), list],
        ],
        [
          "UPDATE conversations SET assigned_bot_id=NULL,epoch=epoch+1 WHERE assigned_bot_id IN (SELECT value FROM json_each(?))",
          [list],
        ],
      ]);
      await removeBotConnection(env, profile, connection);
    } catch {
      console.error(
        JSON.stringify({
          component: "connection_removal",
          connection: connection.id,
          error: "remove_pending",
        }),
      );
    }
  }
}
