import { all, one, exec, batch, cachedOne } from "./db";
import {
  type Actor,
  type Env,
  type Conversation,
  ApiError,
  json,
  now,
  requireValue,
} from "./types";
import { access, admin } from "./security";
import { numberPolicy, numberPolicyFlags } from "./number-policy";
import { getNumberPolicy, numberPolicyError } from "./number-permissions";
import { settings, enqueue } from "./service";
import { sha } from "./security";
import { departmentFor } from "./departments";
import { allowsModules, assertChannelSend, channelRules, channelWindow } from "./channels";
import type { ChannelId } from "./channel-contracts";
import { channelExtension, extensionKey, registeredChannelExtensions } from "./channel-extension-registry";
import { loadChannelOperationContext, prepareChannelAction } from "./channel-extension-kernel";

function extensionLinesSql() {
  const channels = [...new Set(registeredChannelExtensions().filter(extension => extension.spec.serviceLine).map(extension => extension.spec.id))]
    .filter(channel => !["instagram", "facebook", "googlebusiness"].includes(channel));
  return channels.length ? ` AND channel IN ('whatsapp','instagram','facebook',${channels.map(channel => `'${channel}'`).join(",")})` : "";
}
import {
  type InteractiveSpec,
  buildInteractive,
  interactiveFallbackText,
  numberedOptions,
  numberedReply,
} from "./whatsapp-interactive";

export function lineService(config: any) {
  const value = config?.service || {};
  return {
    mode: ["inherit", "human", "bot"].includes(value.mode)
      ? value.mode
      : "inherit",
    bot_id:
      typeof value.bot_id === "string" && value.bot_id ? value.bot_id : null,
    menu_mode: ["automatic", "manual", "off"].includes(value.menu_mode)
      ? value.menu_mode
      : "automatic",
  };
}
export async function serviceForLine(env: Env, connection: string | null) {
  const row = connection
    ? await cachedOne(
        env,
        "SELECT config FROM connections WHERE id=?",
        connection,
      )
    : null;
  return lineService(json(row?.config));
}
export async function botAllowsLine(
  env: Env,
  botId: string,
  profile: string,
  connection: string | null,
  activeOnly = true,
) {
  // A bot whose connection is paused cannot answer: treating it as available
  // would send the customer to a run that fails and to an error protocol.
  // Configuration (activeOnly=false) may still point a line at it.
  const bot = await one(
    env,
    "SELECT b.* FROM bots b JOIN connections c ON c.id=b.connection_id WHERE b.id=? AND b.profile_id=? AND c.kind='ai' AND b.enabled=1 AND (? OR c.status='active')",
    botId,
    profile,
    activeOnly ? 0 : 1,
  );
  return (
    !!bot &&
    (!connection ||
      bot.line_ids === null ||
      json(bot.line_ids, []).includes(connection))
  );
}
export async function validateLineIds(
  env: Env,
  profile: string,
  ids: any,
  nullable = false,
) {
  if (nullable && ids === null) return;
  requireValue(
    Array.isArray(ids) &&
      ids.length <= 200 &&
      ids.every((id: any) => typeof id === "string") &&
      new Set(ids).size === ids.length,
    "Selecione linhas válidas, sem repetição.",
  );
  for (const id of ids)
    requireValue(
      await one(
        env,
        extensionLinesSql() ? "SELECT id FROM connections WHERE id=? AND profile_id=? AND kind IN ('zernio','qr','telegram_bot','email')" + extensionLinesSql() : "SELECT id FROM connections WHERE id=? AND profile_id=? AND kind IN ('zernio','qr') AND channel<>'googlebusiness'",
        id,
        profile,
      ),
      "A linha não pertence a esta área de atendimento.",
    );
}
export async function listLines(env: Env, actor: Actor, profile: string) {
  access(actor, profile, "conversations:read");
  requireValue(
    actor.kind === "user",
    "O painel de linhas exige uma conta de pessoa.",
  );
  const rows = await all(
    env,
    extensionLinesSql() ? "SELECT id,name,kind,channel,account_label,mode,status,config,last_seen FROM connections WHERE profile_id=? AND kind IN ('zernio','qr','telegram_bot','email')" + extensionLinesSql() + " ORDER BY name,id" : "SELECT id,name,kind,channel,account_label,mode,status,config,last_seen FROM connections WHERE profile_id=? AND kind IN ('zernio','qr') AND channel IN ('whatsapp','instagram','facebook') ORDER BY name,id",
    profile,
  );
  return {
    data: rows.map(({ config, ...row }) => ({
      ...row,
      number: row.channel === "whatsapp" ? json(config).number || json(config).phone || "" : "",
      number_policy: numberPolicy(json(config)),
      service: lineService(json(config)),
    })),
  };
}
export async function saveLine(
  env: Env,
  actor: Actor,
  profile: string,
  data: any,
) {
  admin(actor);
  access(actor, profile, "conversations:write");
  const row = await one(
    env,
    extensionLinesSql() ? "SELECT * FROM connections WHERE id=? AND profile_id=? AND kind IN ('zernio','qr','telegram_bot','email')" + extensionLinesSql() : "SELECT * FROM connections WHERE id=? AND profile_id=? AND kind IN ('zernio','qr') AND channel<>'googlebusiness'",
    data.id,
    profile,
  );
  requireValue(row, "Linha não encontrada.");
  const config = json(row.config),
    current = lineService(config),
    service = { ...current, ...data.service };
  requireValue(
    ["inherit", "human", "bot"].includes(service.mode) &&
      ["automatic", "manual", "off"].includes(service.menu_mode),
    "Modo de atendimento inválido.",
  );
  service.bot_id = service.bot_id || null;
  if (service.mode === "bot")
    requireValue(
      service.bot_id &&
        (await botAllowsLine(env, service.bot_id, profile, row.id, false)),
      "Selecione um bot habilitado e autorizado para esta linha.",
    );
  if (data.number_policy !== undefined) {
    requireValue(
      data.number_policy && typeof data.number_policy === "object",
      "Permissões inválidas.",
    );
    for (const key of numberPolicyFlags)
      if (data.number_policy[key] !== undefined)
        requireValue(
          typeof data.number_policy[key] === "boolean",
          "Permissão de linha inválida.",
        );
    config.number_policy = numberPolicy({
      number_policy: { ...numberPolicy(config), ...data.number_policy },
    });
  }
  config.service = service;
  const policy = numberPolicy(config);
  requireValue(
    service.mode !== "human" || (policy.human && policy.service),
    "Atendimento por pessoa exige mensagens de serviço e envio humano em Função e permissões.",
  );
  requireValue(
    service.mode !== "bot" || (policy.bots && policy.service),
    "Atendimento por bot exige mensagens de serviço e bots em Função e permissões.",
  );
  const updates: [string, any[]][] = [
    [
      "UPDATE connections SET config=? WHERE id=?",
      [JSON.stringify(config), row.id],
    ],
  ];
  if (current.mode !== service.mode || current.bot_id !== service.bot_id)
    updates.push([
      "UPDATE conversations SET state=CASE WHEN ?='human' THEN 'waiting' ELSE state END,epoch=epoch+1,menu_active=0,updated=? WHERE connection_id=? AND state='ai' AND assigned_bot_id IS NULL",
      [service.mode, now(), row.id],
    ]);
  await batch(env, updates);
  return (await listLines(env, actor, profile)).data.find(
    (line) => line.id === row.id,
  );
}

// Child menus inherit all ancestor line restrictions. A manually exposed menu
// stays selectable until a terminal choice; an unrelated human reply is not a menu.
export function menuAllowed(
  item: any,
  items: any[],
  connection: string | null,
  includeManual = false,
) {
  let current = item;
  const visited = new Set<string>();
  while (current) {
    if (
      visited.has(current.id) ||
      current.enabled === false ||
      (!includeManual && current.trigger === "manual")
    )
      return false;
    visited.add(current.id);
    if (
      Array.isArray(current.line_ids) &&
      current.line_ids.length &&
      !current.line_ids.includes(connection)
    )
      return false;
    if (!current.parent_id) return true;
    current = items.find((m) => m.id === current.parent_id);
    if (!current || current.type !== "submenu") return false;
  }
  return false;
}
async function availableMenuTree(
  env: Env,
  profile: string,
  connection: string | null,
  includeManual = false,
  chatType = "direct",
  cfg?: any,
  channel?: ChannelId | null,
) {
  cfg ||= await settings(env, profile);
  const policy = await getNumberPolicy(env, connection),
    service = await serviceForLine(env, connection);
  if (!policy.menu || !policy.service || service.menu_mode === "off") return [];
  const result = [];
  for (const item of cfg.menus || []) {
    if (!menuAllowed(item, cfg.menus, connection, includeManual)) continue;
    if (!allowsModules(channel === undefined && connection ? "whatsapp" : channel ?? null) &&
        !["human", "bot", "submenu", "protocols", "survey", "ticket", "link", "content", "app"].includes(item.type))
      continue;
    if (item.type === "human" && !policy.human) continue;
    if (
      item.type === "human" &&
      item.department_id &&
      !(await departmentFor(env, profile, item.department_id))
    )
      continue;
    if (
      ["protocols", "survey", "ticket", "queue"].includes(item.type) &&
      !policy.service
    )
      continue;
    if (
      chatType === "group" &&
      ["protocols", "survey", "ticket", "queue"].includes(item.type)
    )
      continue;
    // "Entrar na fila" only while a queue takes tickets by WhatsApp.
    if (
      item.type === "queue" &&
      !(
        await all(
          env,
          "SELECT id,channels FROM queues WHERE profile_id=? AND enabled=1 AND (?='' OR id=?)",
          profile,
          item.queue_id || "",
          item.queue_id || "",
        )
      ).some((q) => json(q.channels, []).includes("whatsapp"))
    )
      continue;
    if (
      item.type === "bot" &&
      (!policy.bots ||
        !(await botAllowsLine(env, item.bot_id, profile, connection)))
    )
      continue;
    result.push(item);
  }
  const children = new Map<string, any[]>();
  for (const item of result) {
    const siblings = children.get(item.parent_id) || [];
    siblings.push(item);
    children.set(item.parent_id, siblings);
  }
  const visible = new Map<string, boolean>();
  function hasDestination(item: any): boolean {
    if (visible.has(item.id)) return visible.get(item.id)!;
    // A container is usable only when its current line/mode has a terminal
    // destination. Guard old malformed cycles as well as newly validated trees.
    visible.set(item.id, false);
    const allowed =
      item.type !== "submenu" ||
      (children.get(item.id) || []).some(hasDestination);
    visible.set(item.id, allowed);
    return allowed;
  }
  return result.filter(hasDestination);
}
export async function availableMenus(
  env: Env,
  profile: string,
  connection: string | null,
  parent: string | null = null,
  includeManual = false,
  chatType = "direct",
  channel?: ChannelId | null,
) {
  return (
    await availableMenuTree(env, profile, connection, includeManual, chatType, undefined, channel)
  ).filter((item: any) => (item.parent_id || null) === parent);
}
export function menuPayload(
  items: any[],
  title: string,
  token: string,
  interactive: boolean,
  submenu = false,
  channel?: ChannelId | null,
) {
  const navigation = submenu
    ? "\nEnvie VOLTAR para subir um nível ou MENU para voltar ao menu principal."
    : "";
  const text = `${title}\n${items.map((item, index) => `${index + 1}. ${item.label}`).join("\n")}${navigation}`;
  if (extensionKey(channel)) return { text, automation: "menu" };
  if (channel === "instagram" || channel === "facebook") {
    const options = items.map((item) => ({ id: `wmenu:${token}:${item.id}`, title: item.label }));
    // Limites locais conservadores; formato de opção a conferir com a conta real.
    const compatible = options.length > 0 && options.length <= 13 &&
      options.every((option) => typeof option.title === "string" && option.title.trim() &&
        Array.from(option.title).length <= 20 && !/[\u0000-\u001f\u007f]/.test(option.title) &&
        new TextEncoder().encode(option.id).length <= 256);
    if (!interactive || !compatible) return { text, automation: "menu" };
    return {
      text: title + (navigation || "\nEscolha uma opção abaixo."), automation: "menu",
      content: { type: options.length <= 3 ? "buttons" : "quick_replies", options },
    };
  }
  if (!interactive || items.length > 10 || !items.length)
    return { text, automation: "menu" };
  const buttons =
    items.length <= 3 &&
    items.every((item) => Array.from(item.label).length <= 20);
  const body = {
    text: title + (navigation || "\nEscolha uma opção abaixo."),
  };
  return {
    text,
    automation: "menu",
    content: {
      type: "interactive",
      interactive: buttons
        ? {
            type: "button",
            body,
            action: {
              buttons: items.map((item) => ({
                type: "reply",
                reply: { id: `wmenu:${token}:${item.id}`, title: item.label },
              })),
            },
          }
        : {
            type: "list",
            body,
            action: {
              button: "Escolher opção",
              sections: [
                {
                  title: "Atendimento",
                  rows: items.map((item, index) => ({
                    id: `wmenu:${token}:${item.id}`,
                    title: Array.from(`${index + 1}. ${item.label}`)
                      .slice(0, 24)
                      .join(""),
                    description: Array.from(item.label).slice(0, 72).join(""),
                  })),
                },
              ],
            },
          },
    },
  };
}

/**
 * Lines that render WhatsApp interactive messages: official numbers, direct
 * chats. QR and group chats receive the numbered text with links instead.
 */
export async function interactiveLine(env: Env, c: Conversation) {
  if (c.channel != null && c.channel !== "whatsapp") return false;
  if (!c.connection_id || c.chat_type === "group") return false;
  const line = await cachedOne(
    env,
    "SELECT kind FROM connections WHERE id=?",
    c.connection_id,
  );
  return ["meta", "zernio"].includes(line?.kind);
}

/**
 * Outbox payload for an interactive message, in the shape menus and the queue
 * already use: `text` is always the numbered fallback (sent as is by QR and
 * kept as history); `content` carries the native element on official lines.
 * The spec is validated on every line, so a message that works on QR does not
 * fail later on an official number.
 */
export function interactivePayload(
  spec: InteractiveSpec,
  native: boolean,
  extra: Record<string, unknown> = {},
) {
  const interactive = buildInteractive(spec),
    text = interactiveFallbackText(spec);
  return native
    ? { ...extra, text, content: { type: "interactive", interactive } }
    : { ...extra, text };
}

/**
 * Queues an interactive message for the conversation (see interactivePayload).
 * `key` makes the send idempotent; `automation` labels it like menus do
 * ("menu", "queue"…). Returns the first delivery id. Long fallbacks on QR are
 * split like menus, at 3,800 characters.
 */
export async function sendInteractive(
  env: Env,
  actor: string,
  c: Conversation,
  spec: InteractiveSpec,
  key: string,
  automation?: string,
) {
  if (c.channel != null && c.channel !== "whatsapp") {
    // Interativos próprios do WhatsApp viram texto, nunca um menu nativo social.
    const payload = interactivePayload(spec, false, { automation: automation || "interactive" });
    const context = c.chat_type === "comment" || json(c.channel_context).context === "comment" ? "comment"
      : c.chat_type === "review" || json(c.channel_context).context === "review" ? "review" : "direct";
    if (extensionKey(c.channel, context)) return enqueue(env, c, actor, "text", payload, key);
    const { enqueueSocialDeliveries } = await import("./engine");
    return enqueueSocialDeliveries(env, c, actor, "text", payload, key);
  }
  const payload = interactivePayload(
    spec,
    await interactiveLine(env, c),
    automation ? { automation } : {},
  );
  const parts =
    "content" in payload
      ? [payload.text]
      : payload.text.match(/[\s\S]{1,3800}/g) || [payload.text];
  const deliveries: string[] = [];
  for (const [index, part] of parts.entries())
    deliveries.push(
      await enqueue(
        env,
        c,
        actor,
        "text",
        { ...payload, text: part },
        index === 0 ? key : `${key}:${index}`,
      ),
    );
  return deliveries[0];
}

/**
 * The list row chosen by a reply: the tapped row on official lines
 * (`interactive_reply_id`), or the number/title typed on QR.
 */
export function interactiveChoice(
  spec: InteractiveSpec,
  text: string,
  replyId?: string,
) {
  if (replyId)
    return numberedOptions(spec).some((row) => row.id === replyId)
      ? replyId
      : null;
  return numberedReply(spec, text);
}

export function selectedMenu(
  c: Conversation,
  items: any[],
  text: string,
  replyId?: string,
) {
  const snapshot = json(c.menu_items, []) as string[];
  const active =
    !!c.menu_active &&
    !!c.menu_token?.startsWith(c.session + ".") &&
    (c.menu_expires_at || 0) > now();
  if (replyId) {
    if (!active) return null;
    const prefix = `wmenu:${c.menu_token}:`;
    if (!replyId.startsWith(prefix)) return null;
    const id = replyId.slice(prefix.length);
    return snapshot.includes(id)
      ? items.find((item) => item.id === id) || null
      : null;
  }
  const normalized = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
  if (c.menu_token && !active) return null;
  if (/^\d+$/.test(normalized) && c.menu_token) {
    return (
      items.find((item) => item.id === snapshot[Number(normalized) - 1]) || null
    );
  }
  return (
    items.find(
      (item, index) =>
        (!c.menu_token && String(index + 1) === normalized) ||
        ((!c.menu_token || snapshot.includes(item.id)) &&
          item.label
            .toLowerCase()
            .normalize("NFD")
            .replace(/\p{Diacritic}/gu, "")
            .trim() === normalized),
    ) || null
  );
}
export async function listMenus(
  env: Env,
  actor: Actor,
  profile: string,
  connection?: string,
) {
  access(actor, profile, "conversations:read");
  const cfg = await settings(env, profile);
  let line: any = null;
  if (connection) {
    line = await one(env, "SELECT id,channel FROM connections WHERE id=? AND profile_id=?", connection, profile);
    requireValue(
      line,
      "Linha não encontrada.",
    );
  }
  return {
    data: connection
      ? await availableMenuTree(env, profile, connection, true, "direct", cfg, line.channel)
      : cfg.menus || [],
    revision: await sha(JSON.stringify(cfg.menus || [])),
  };
}
export async function sendMenu(
  env: Env,
  actor: Actor,
  c: Conversation,
  menuId: string | null,
  key: string,
  manual = true,
) {
  const social = c.channel != null && c.channel !== "whatsapp";
  requireValue(c.chat_type !== "comment" && json(c.channel_context).context !== "comment" && c.channel !== "googlebusiness", "Este contexto não permite menus.");
  if (social) {
    const connection = c.connection_id
      ? await cachedOne(env, "SELECT * FROM connections WHERE id=?", c.connection_id) : null;
    const rules = channelRules(connection, c.chat_type === "group" ? "group" : "direct");
    if (!rules || rules.id !== c.channel || connection?.profile_id !== c.profile_id)
      throw new ApiError(503, "channel_not_ready", "Canal indisponível para este menu.");
    assertChannelSend({ rules, window: channelWindow(rules, c.last_customer, now()),
      origin: "automation", contentType: "text", hasAttachments: false });
  }
  const policy = await getNumberPolicy(env, c.connection_id);
  if (!policy.menu) throw numberPolicyError("menu");
  if (!policy.service) throw numberPolicyError("service");
  const service = await serviceForLine(env, c.connection_id);
  requireValue(service.menu_mode !== "off", "Menus desativados nesta linha.");
  if (c.connection_id && !social) {
    const line = await cachedOne(
      env,
      "SELECT kind FROM connections WHERE id=?",
      c.connection_id,
    );
    requireValue(
      !["meta", "zernio"].includes(line?.kind) ||
        now() - c.last_customer < 86400000,
      "O cliente precisa enviar mensagem para este mesmo número nas últimas 24 horas.",
    );
  }
  const cfg = await settings(env, c.profile_id);
  const parent = menuId
    ? (cfg.menus || []).find((m: any) => m.id === menuId)
    : null;
  requireValue(
    !menuId ||
      (parent?.type === "submenu" &&
        menuAllowed(parent, cfg.menus, c.connection_id, manual)),
    "Menu indisponível para esta linha.",
  );
  const items = await availableMenus(
    env,
    c.profile_id,
    c.connection_id,
    menuId,
    manual,
    c.chat_type,
    c.channel ?? undefined,
  );
  requireValue(
    items.length,
    "Nenhuma opção de menu disponível para esta linha.",
  );
  const token =
    c.session + "." + (await sha(`${c.id}:${c.session}:${key}`)).slice(0, 24);
  const connection = c.connection_id && !social
    ? await cachedOne(
        env,
        "SELECT kind FROM connections WHERE id=?",
        c.connection_id,
      )
    : null;
  const payload = menuPayload(
    items,
    parent?.label ||
      String(cfg.menu_greeting || "").trim() ||
      "Como podemos ajudar?",
    token,
    (social || ["meta", "zernio"].includes(connection?.kind)) && c.chat_type !== "group",
    !!menuId,
    c.channel,
  );
  // Use the person's own authorization for a manual send. Bot menus retain the
  // automation capability check; no ownership or channel authorization is bypassed.
  const parts = payload.content
    ? [payload.text]
    : payload.text.match(/[\s\S]{1,3800}/g) || [payload.text];
  const deliveries = [];
  const extension = extensionKey(c.channel);
  if (extension) {
    const ctx = await loadChannelOperationContext(env, actor, c.profile_id, { kind: "conversation", id: c.id }, key, manual ? "human" : "bot");
    const descriptor = channelExtension(extension);
    const { enqueueChannelPlan } = await import("./engine");
    if (descriptor.prepareMenu) {
      const plan = await descriptor.prepareMenu(ctx, { token, title: payload.text, items: items.map(item => ({ id: item.id, title: item.label })), expiresAt: now() + 15 * 60_000 });
      deliveries.push(await enqueueChannelPlan(ctx, plan, { type: "message.send", text: payload.text }));
    } else {
      const action = { type: "message.send" as const, text: payload.text };
      deliveries.push(await enqueueChannelPlan(ctx, await prepareChannelAction(ctx, action), action));
    }
  } else if (social) {
    const { enqueueSocialDeliveries } = await import("./engine");
    deliveries.push(await enqueueSocialDeliveries(env, c, actor.id, "text", payload, key));
  } else for (const [index, part] of parts.entries())
    deliveries.push(
      await enqueue(
        env,
        c,
        actor.id,
        "text",
        { ...payload, text: part },
        index === 0 ? key : `${key}:${index}`,
      ),
    );
  await batch(env, [
    [
      "UPDATE surveys SET status='cancelled' WHERE conversation_id=? AND status='pending'",
      [c.id],
    ],
    [
      "UPDATE conversations SET menu_parent=?,menu_active=1,menu_manual=?,menu_token=?,menu_expires_at=?,menu_items=? WHERE id=?",
      [
        menuId,
        manual ? 1 : 0,
        token,
        now() + 86400000,
        JSON.stringify(items.map((item: any) => item.id)),
        c.id,
      ],
    ],
  ]);
  return { delivery_id: deliveries[0], status: "pending", menu_id: menuId };
}
